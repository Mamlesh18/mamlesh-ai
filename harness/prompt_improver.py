"""Suggests a better version of a prompt from the eval failures it caused (and/or your own instructions).

Nothing is saved: the UI shows the suggestion as a diff, you save it as a new version, then test it in evals.
"""
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from harness import prompt_registry
from services import db as database
from utils.cost import llm_cost
from utils.env import OPENAI_MODEL

IMPROVER_PROMPT = """You improve system prompts for agents in a personal multi-agent assistant.
You get the current prompt, test cases it failed (question, answer, which checks failed and why, what was expected),
and optionally instructions from the owner.

Rules:
- Make the smallest change that fixes the failures. Keep everything that works. Keep the same style and length
  (do not grow the prompt by more than about 30%, shorter is better: every token is paid on every call).
- Prefer clear, general rules over rules that name a specific test question.
- If a rule already covers the failure but was ignored, rewrite or strengthen THAT rule (make it more direct, move
  it up) instead of adding a second rule that says the same thing.
- Respect what the agent can do: the planner only returns steps (it never writes replies); domain agents answer
  with their tools; the synthesizer writes the final answer from the agents' results.
- Keep every placeholder in curly braces exactly as it is, for example {domains}.
- Do not invent tools or facts. Only refer to tool names that already appear in the prompt or in the failures.
- If the failures are not caused by this prompt, say so in the summary and return the prompt unchanged."""


class Suggestion(BaseModel):
    text: str = Field(description="The full improved prompt")
    summary: str = Field(description="2-4 short bullet points: what changed and which failure each change fixes")


def _related(name: str, d: dict) -> bool:
    """Is this failed case likely caused by prompt `name`?"""
    failed = [n for n, c in d["checks"].items() if not c["passed"]]
    if name == "planner":
        return "routing" in failed
    if name == "synthesizer":
        return "judge" in failed or any(n.startswith(("contains", "not_")) for n in failed)
    return name in d.get("planned", []) or name in d.get("tags", [])


async def failures_for(name: str, limit: int = 8) -> tuple[list[dict], str | None]:
    """Failed cases related to this prompt, from the latest finished eval run that still has details."""
    db = database.db
    for run in await db.eval_runs.find({"status": "done"}, {"_id": 1, "label": 1}).sort("started_at", -1).to_list(5):
        details = await db.eval_results.find({"eval_id": run["_id"], "passed": False}, {"_id": 0}).to_list(200)
        if details:
            return [d for d in details if _related(name, d)][:limit], run["label"]
    return [], None


async def suggest(name: str, instructions: str = "") -> dict:
    from harness.evals.runner import load_cases

    current = prompt_registry.get(name)
    fails, run_label = await failures_for(name)
    if not fails and not instructions.strip():
        return {"text": current, "summary": "No failed eval cases point at this prompt. Describe what you want changed, "
                "or run the evals first.", "cases": [], "run": run_label, "cost": 0}
    expect = {c["id"]: c.get("expect", {}) for c in load_cases()}
    blocks = []
    for d in fails:
        checks = "\n".join(f"  - {n}: {c['detail']}" for n, c in d["checks"].items() if not c["passed"])
        blocks.append(f"Case {d['case_id']}\nQuestion: {d['query']}\nAgents used: {d.get('planned')}  Tools used: {d.get('tools')}\n"
                      f"Answer: {(d.get('answer') or d.get('error') or '')[:1500]}\nFailed checks:\n{checks}\n"
                      f"Expected: {expect.get(d['case_id'], {})}")
    user = (f"Prompt name: {name}\n\nCurrent prompt:\n<<<\n{current}\n>>>\n\n"
            f"Failed test cases:\n\n" + ("\n\n".join(blocks) or "(none)") +
            (f"\n\nOwner's instructions: {instructions.strip()}" if instructions.strip() else ""))
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0).with_structured_output(Suggestion, include_raw=True)
    out = await llm.ainvoke([("system", IMPROVER_PROMPT), ("user", user)])
    s: Suggestion = out["parsed"]
    u = getattr(out["raw"], "usage_metadata", None) or {}
    cost = llm_cost(OPENAI_MODEL, u.get("input_tokens", 0), (u.get("input_token_details") or {}).get("cache_read", 0) or 0,
                    u.get("output_tokens", 0))
    return {"text": s.text.strip(), "summary": s.summary, "cases": [d["case_id"] for d in fails], "run": run_label,
            "cost": cost}
