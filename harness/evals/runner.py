"""Runs the eval test set against the live agents and scores every case.

- Runs in sandbox mode: tools that write/send/pay/delete only report what they would have done.
- Each case is checked on routing (which agents), tools (which tools), text checks, and an LLM judge
  that sees the question, the answer and the tool results.
- Storage follows the 7-day rule: per-case details (answers, tool results) live in "eval_results" and expire
  with the traces; the scorecard in "eval_runs" (pass rates, latency, tokens, cost) is kept for comparisons.
"""
import asyncio
import hashlib
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from harness import prompt_registry, sandbox, tracing
from harness.metrics import pct
from services import db as database
from services.events import emit
from utils.cost import llm_cost
from utils.env import OPENAI_MODEL
from utils.logger import get_logger

log = get_logger(__name__)

CASES_FILE = Path(__file__).parent / "cases.yaml"
CONCURRENCY = 3
CASE_TIMEOUT_S = 150
current = {"eval_id": None}  # only one eval run at a time


def load_cases(tags: list[str] | None = None, ids: list[str] | None = None) -> list[dict]:
    cases = yaml.safe_load(CASES_FILE.read_text(encoding="utf-8")) or []
    if ids:
        cases = [c for c in cases if c["id"] in ids]
    if tags:
        cases = [c for c in cases if set(tags) & set(c.get("tags", []))]
    return cases


def prompts_fingerprint(texts: dict[str, str] | None = None) -> str:
    """Hash of the prompt texts a run uses (live versions, plus any being tried), to tell prompt sets apart."""
    h = hashlib.sha256()
    for name in prompt_registry.names():
        h.update(name.encode() + (texts or {}).get(name, prompt_registry.get(name)).encode())
    return h.hexdigest()[:10]


# ---------- judge ----------

class Verdict(BaseModel):
    passed: bool = Field(description="True if the answer meets the rubric")
    score: int = Field(description="1 (bad) to 5 (excellent)")
    reason: str = Field(description="One or two sentences explaining the score")


JUDGE_PROMPT = """You grade answers from a personal AI assistant.
You get the user's question, the assistant's final answer, the tool results the assistant had, and a rubric.
Pass the answer only if it meets the rubric. Use the tool results as ground truth: numbers or facts in the
answer that contradict the tool results, or that are not supported by them, are failures.
Tools marked [sandbox] did not really run in this test; treat them as having succeeded.
Some tool results are cut (marked "result cut here"). Do not fail an answer for a fact that could be in the
part that was cut; only fail facts that contradict what you can see, or that clearly could not come from the tools."""

_judge_llm = None


async def judge(question: str, answer: str, evidence: str, rubric: str) -> dict:
    global _judge_llm
    _judge_llm = _judge_llm or ChatOpenAI(model=OPENAI_MODEL, temperature=0).with_structured_output(Verdict, include_raw=True)
    out = await _judge_llm.ainvoke([
        ("system", JUDGE_PROMPT),
        ("user", f"Question:\n{question}\n\nAnswer:\n{answer}\n\nTool results:\n{evidence or '(none)'}\n\nRubric:\n{rubric}"),
    ])
    v: Verdict = out["parsed"]
    u = getattr(out["raw"], "usage_metadata", None) or {}
    cost = llm_cost(OPENAI_MODEL, u.get("input_tokens", 0), (u.get("input_token_details") or {}).get("cache_read", 0) or 0,
                    u.get("output_tokens", 0))
    return {"passed": v.passed, "score": max(1, min(5, v.score)), "reason": v.reason, "cost": cost}


# ---------- checks ----------

def run_checks(expect: dict, planned: list[str], tools: list[str], answer: str) -> dict:
    """Deterministic checks. Returns {check_name: {"passed": bool, "detail": str}}."""
    checks, a, called = {}, answer.lower(), set(tools)

    def add(name, ok, detail):
        checks[name] = {"passed": bool(ok), "detail": detail}

    if expect.get("no_domains"):
        add("routing", not planned, f"expected no agents, planner used {planned or 'none'}")
    elif expect.get("domains"):
        want = set(expect["domains"])
        ok = want <= set(planned) and (not expect.get("only_domains") or set(planned) == want)
        add("routing", ok, f"expected {sorted(want)}{' only' if expect.get('only_domains') else ''}, planner used {planned or 'none'}")
    if expect.get("tools_all"):
        missing = [t for t in expect["tools_all"] if t not in called]
        add("tools_all", not missing, f"missing {missing}" if missing else f"called {sorted(called)}")
    if expect.get("tools_any"):
        add("tools_any", called & set(expect["tools_any"]), f"needed one of {expect['tools_any']}, called {sorted(called) or 'none'}")
    if expect.get("tools_none"):
        bad = sorted(called & set(expect["tools_none"]))
        add("tools_none", not bad, f"should not call {bad}" if bad else "ok")
    if expect.get("contains_all"):
        missing = [s for s in expect["contains_all"] if s.lower() not in a]
        add("contains_all", not missing, f"answer lacks {missing}" if missing else "ok")
    if expect.get("contains_any"):
        add("contains_any", any(s.lower() in a for s in expect["contains_any"]), f"answer needs one of {expect['contains_any']}")
    if expect.get("not_contains"):
        found = [s for s in expect["not_contains"] if s.lower() in a]
        add("not_contains", not found, f"answer contains {found}" if found else "ok")
    if expect.get("not_regex"):
        add("not_regex", not re.search(expect["not_regex"], answer), "answer matched a forbidden pattern")
    return checks


# ---------- one case ----------

async def run_case(case: dict, graph) -> dict:
    sandbox.SANDBOX.set(True)  # this task only: write tools are faked
    run_id = f"eval-{uuid.uuid4().hex[:10]}"
    trace, usage = [], {}
    root = tracing.start_span(trace, "run", "query", None, span_id=run_id, query=case["query"])
    answer, error = "", None
    try:
        out = await asyncio.wait_for(
            graph.ainvoke({"query": case["query"], "history": case.get("history", "")},
                                    config={"configurable": {"run_id": run_id, "usage": usage, "trace": trace, "root_span": run_id}}),
            timeout=CASE_TIMEOUT_S)
        answer = out.get("answer", "")
    except Exception as e:
        error = f"{type(e).__name__}: {e}"[:500]
    totals = {k: sum(u[k] for u in usage.values()) for k in ("calls", "input_tokens", "cached_tokens", "output_tokens", "cost")}
    tracing.end_span(root, status="error" if error else "ok", error=error, **totals)

    planner = next((s for s in trace if s["kind"] == "planner"), None)
    planned = (planner or {}).get("attrs", {}).get("steps", [])
    tool_spans = [s for s in trace if s["kind"] == "tool"]
    tools = [s["attrs"].get("tool") for s in tool_spans]
    def preview(s):  # say when a result was cut, so the judge doesn't mark facts beyond the cut as invented
        text, size = s["attrs"].get("result_preview", ""), s["attrs"].get("result_chars", 0)
        return text + (f"\n[... result cut here; the full result had {size} characters]" if size > len(text) else "")
    evidence = "\n\n".join(f"[{s['attrs'].get('tool')}] {preview(s)}" for s in tool_spans)[:24000]

    expect = case.get("expect", {})
    checks = run_checks(expect, planned, tools, answer) if not error else {"error": {"passed": False, "detail": error}}
    verdict = None
    if expect.get("judge") and not error:
        try:
            verdict = await judge(case["query"], answer, evidence, expect["judge"])
            checks["judge"] = {"passed": verdict["passed"], "detail": verdict["reason"]}
        except Exception as e:
            checks["judge"] = {"passed": False, "detail": f"judge failed: {e}"}

    return {
        "case_id": case["id"], "tags": case.get("tags", []), "query": case["query"],
        "passed": all(c["passed"] for c in checks.values()),
        "checks": checks, "planned": planned, "tools": tools, "answer": answer, "error": error,
        "judge_score": verdict["score"] if verdict else None, "judge_cost": verdict["cost"] if verdict else 0,
        "latency_ms": root["duration_ms"], "tokens": totals["input_tokens"] + totals["output_tokens"],
        "cached_tokens": totals["cached_tokens"], "cost": totals["cost"], "llm_calls": totals["calls"],
    }


# ---------- a full run ----------

def summarize(results: list[dict]) -> dict:
    n = len(results) or 1

    def rate(check_names):
        rel = [r for r in results if any(c in r["checks"] for c in check_names)]
        ok = [r for r in rel if all(r["checks"][c]["passed"] for c in check_names if c in r["checks"])]
        return {"passed": len(ok), "of": len(rel), "rate": round(len(ok) / len(rel) * 100) if rel else None}

    by_tag = {}
    for r in results:
        for t in r["tags"]:
            by_tag.setdefault(t, [0, 0])
            by_tag[t][0] += r["passed"]
            by_tag[t][1] += 1
    lat = [r["latency_ms"] for r in results]
    scores = [r["judge_score"] for r in results if r["judge_score"]]
    return {
        "cases": len(results),
        "passed": sum(r["passed"] for r in results),
        "pass_rate": round(sum(r["passed"] for r in results) / n * 100),
        "routing": rate(["routing"]),
        "tools": rate(["tools_all", "tools_any", "tools_none"]),
        "text": rate(["contains_all", "contains_any", "not_contains", "not_regex"]),
        "judge": rate(["judge"]),
        "judge_avg_score": round(sum(scores) / len(scores), 2) if scores else None,
        "errors": sum(1 for r in results if r["error"]),
        "p50_ms": pct(lat, 50), "p95_ms": pct(lat, 95),
        "avg_tokens": round(sum(r["tokens"] for r in results) / n),
        "avg_llm_calls": round(sum(r["llm_calls"] for r in results) / n, 2),
        "avg_cost": round(sum(r["cost"] for r in results) / n, 6),
        "total_cost": round(sum(r["cost"] for r in results), 5),
        "judge_cost": round(sum(r["judge_cost"] for r in results), 5),
        "by_tag": {t: {"passed": p, "of": o} for t, (p, o) in sorted(by_tag.items())},
    }


async def start(label: str = "", tags: list[str] | None = None, ids: list[str] | None = None,
                prompts: dict[str, int] | None = None) -> str:
    """prompts: {name: version} to try instead of the active versions (the live agents are not changed)."""
    if database.db is None:
        raise RuntimeError("MongoDB is not connected.")
    if current["eval_id"]:
        raise ValueError("An eval run is already in progress.")
    cases = load_cases(tags, ids)
    if not cases:
        raise ValueError("No cases match.")
    prompts = {n: int(v) for n, v in (prompts or {}).items() if int(v) != prompt_registry.active_versions().get(n)}
    from services import run_service
    texts = await prompt_registry.texts_for(prompts)  # raises ValueError for an unknown version
    graph = run_service.build_test_graph(texts) if texts else run_service.system["graph"]
    eval_id = uuid.uuid4().hex[:10]
    await database.db.eval_runs.insert_one({
        "_id": eval_id, "label": label or datetime.now().strftime("run %d %b %H:%M"), "status": "running",
        "started_at": datetime.now(timezone.utc), "total": len(cases), "done": 0, "filter": {"tags": tags, "ids": ids},
        "prompts": prompts_fingerprint(texts), "prompt_versions": {**prompt_registry.active_versions(), **prompts},
        "trying": prompts, "case_ids": [c["id"] for c in cases], "model": OPENAI_MODEL})
    current["eval_id"] = eval_id
    task = asyncio.create_task(_run(eval_id, cases, graph))
    task.add_done_callback(lambda _: current.update(eval_id=None))
    return eval_id


async def _run(eval_id: str, cases: list[dict], graph):
    sem, results, db = asyncio.Semaphore(CONCURRENCY), [], database.db

    async def one(case):
        async with sem:
            await emit("system", "eval.case", eval_id=eval_id, case_id=case["id"])  # started
            try:
                r = await run_case(case, graph)
            except Exception as e:  # never let one case kill the run
                r = {"case_id": case["id"], "tags": case.get("tags", []), "query": case["query"], "passed": False,
                     "checks": {"error": {"passed": False, "detail": str(e)}}, "planned": [], "tools": [], "answer": "",
                     "error": str(e), "judge_score": None, "judge_cost": 0, "latency_ms": None, "tokens": 0,
                     "cached_tokens": 0, "cost": 0, "llm_calls": 0}
            results.append(r)
            await db.eval_results.insert_one({**r, "eval_id": eval_id, "expire_at": tracing.expires_at()})
            await db.eval_runs.update_one({"_id": eval_id}, {"$inc": {"done": 1}})
            await emit("system", "eval.progress", eval_id=eval_id, done=len(results), total=len(cases),
                       case_id=r["case_id"], passed=r["passed"], failed=[n for n, c in r["checks"].items() if not c["passed"]])

    try:
        await asyncio.gather(*(one(c) for c in cases))
        summary = summarize(results)
        compact = [{k: r[k] for k in ("case_id", "passed", "latency_ms", "tokens", "cost", "judge_score")}
                   | {"failed": [n for n, c in r["checks"].items() if not c["passed"]]} for r in results]
        await db.eval_runs.update_one({"_id": eval_id}, {"$set": {
            "status": "done", "finished_at": datetime.now(timezone.utc), "summary": summary, "cases": compact}})
        log.info("Eval %s done: %d/%d passed", eval_id, summary["passed"], summary["cases"])
    except Exception as e:
        log.exception("Eval %s failed", eval_id)
        await db.eval_runs.update_one({"_id": eval_id}, {"$set": {"status": "error", "error": str(e)}})
    await emit("system", "eval.done", eval_id=eval_id)


# ---------- reading results ----------

def _out(doc: dict) -> dict:
    doc["eval_id"] = doc.pop("_id")
    for k in ("started_at", "finished_at"):
        if doc.get(k):
            doc[k] = doc[k].isoformat()
    return doc


async def list_runs(limit: int = 30) -> list[dict]:
    rows = await database.db.eval_runs.find({}, {"cases": 0}).sort("started_at", -1).limit(limit).to_list(limit)
    return [_out(r) for r in rows]


async def get_run(eval_id: str) -> dict | None:
    run = await database.db.eval_runs.find_one({"_id": eval_id})
    if not run:
        return None
    details = await database.db.eval_results.find({"eval_id": eval_id}, {"_id": 0, "expire_at": 0}).to_list(1000)
    run = _out(run)
    run["details"] = {d["case_id"]: d for d in details}  # empty once the 7-day retention has passed
    return run
