"""Observability numbers for the dashboard, computed from the stored spans (only the last few days exist,
because spans expire after TRACE_RETENTION_DAYS)."""
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from services import db as database
from utils.env import TRACE_RETENTION_DAYS, UTC_OFFSET_MINUTES


def pct(values: list, p: float):
    """Percentile (nearest rank). None when there is no data."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    return vals[min(len(vals) - 1, max(0, math.ceil(p / 100 * len(vals)) - 1))]


def _avg(values: list):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals)) if vals else None


def _local_day(dt: datetime) -> str:
    return (dt.replace(tzinfo=timezone.utc) + timedelta(minutes=UTC_OFFSET_MINUTES)).strftime("%Y-%m-%d")


async def summary(days: int = 7) -> dict:
    if database.db is None:
        return {"available": False}
    since = datetime.now(timezone.utc) - timedelta(days=days)
    spans = await database.db.spans.find({"start": {"$gte": since}}, {"trace_id": 1, "kind": 1, "name": 1, "start": 1,
                                         "duration_ms": 1, "status": 1, "attrs": 1}).to_list(200_000)
    by_kind = defaultdict(list)
    for s in spans:
        by_kind[s["kind"]].append(s)
    runs = by_kind["run"]
    n = len(runs)
    dur = [r["duration_ms"] for r in runs]
    cost = sum(r["attrs"].get("cost", 0) for r in runs)
    tokens = [r["attrs"].get("input_tokens", 0) + r["attrs"].get("output_tokens", 0) for r in runs]
    cached = sum(r["attrs"].get("cached_tokens", 0) for r in runs)
    inp = sum(r["attrs"].get("input_tokens", 0) for r in runs)

    # Cost and queries per day (local time), every day in the window even if empty
    per_day = defaultdict(lambda: {"queries": 0, "cost": 0.0})
    for r in runs:
        d = per_day[_local_day(r["start"])]
        d["queries"] += 1
        d["cost"] += r["attrs"].get("cost", 0)
    today = datetime.now(timezone.utc)
    daily = [{"day": _local_day(today - timedelta(days=i)), **per_day[_local_day(today - timedelta(days=i))]}
             for i in range(days - 1, -1, -1)]

    # Where the time goes: per query, total time spent in each step type
    per_trace = defaultdict(lambda: defaultdict(int))
    for kind in ("planner", "agent", "synthesizer", "tool", "llm"):
        for s in by_kind[kind]:
            per_trace[s["trace_id"]][kind] += s["duration_ms"] or 0
    steps = []
    for kind, label in (("planner", "Planner"), ("agent", "Agents (incl. tools)"), ("tool", "Tool calls"),
                        ("synthesizer", "Writing the answer")):
        vals = [t[kind] for t in per_trace.values() if kind in t]
        steps.append({"step": label, "kind": kind, "avg_ms": _avg(vals), "p95_ms": pct(vals, 95), "queries": len(vals)})

    # LLM calls per agent
    agents = defaultdict(lambda: {"calls": 0, "ms": [], "input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "cost": 0.0})
    for s in by_kind["llm"]:
        a = agents[s["attrs"].get("agent", "?")]
        a["calls"] += 1
        a["ms"].append(s["duration_ms"])
        for k in ("input_tokens", "cached_tokens", "output_tokens", "cost"):
            a[k] += s["attrs"].get(k, 0) or 0
    agent_rows = sorted(({"agent": k, "calls": v["calls"], "avg_ms": _avg(v["ms"]), "p95_ms": pct(v["ms"], 95),
                          "avg_input_tokens": round(v["input_tokens"] / v["calls"]) if v["calls"] else 0,
                          "cached_share": round(v["cached_tokens"] / v["input_tokens"] * 100) if v["input_tokens"] else 0,
                          "output_tokens": v["output_tokens"], "cost": round(v["cost"], 5)}
                         for k, v in agents.items()), key=lambda r: -r["cost"])

    # Tool calls
    tools = defaultdict(lambda: {"calls": 0, "errors": 0, "ms": [], "chars": []})
    for s in by_kind["tool"]:
        t = tools[s["name"]]
        t["calls"] += 1
        t["errors"] += s["status"] == "error"
        t["ms"].append(s["duration_ms"])
        t["chars"].append(s["attrs"].get("result_chars"))
    tool_rows = sorted(({"tool": k, "calls": v["calls"], "errors": v["errors"], "avg_ms": _avg(v["ms"]),
                         "p95_ms": pct(v["ms"], 95), "avg_result_chars": _avg(v["chars"])}
                        for k, v in tools.items()), key=lambda r: -(r["p95_ms"] or 0))

    def run_row(r):
        a = r["attrs"]
        return {"run_id": r["trace_id"], "query": a.get("query", ""), "start": r["start"].isoformat(),
                "duration_ms": r["duration_ms"], "cost": a.get("cost", 0), "status": r["status"],
                "tokens": a.get("input_tokens", 0) + a.get("output_tokens", 0), "llm_calls": a.get("calls", 0)}

    ttft = [s["attrs"].get("ttft_ms") for s in by_kind["synthesizer"]]
    oldest = await database.db.spans.find_one({}, sort=[("start", 1)])
    return {
        "available": True,
        "days": days,
        "retention_days": TRACE_RETENTION_DAYS,
        "stored_spans": await database.db.spans.estimated_document_count(),
        "oldest_trace": oldest["start"].isoformat() if oldest else None,
        "kpis": {
            "queries": n,
            "errors": sum(r["status"] != "ok" for r in runs),
            "p50_ms": pct(dur, 50), "p95_ms": pct(dur, 95),
            "ttft_p50_ms": pct(ttft, 50),
            "cost": round(cost, 5),
            "avg_cost": round(cost / n, 5) if n else 0,
            "avg_tokens": round(sum(tokens) / n) if n else 0,
            "avg_llm_calls": round(sum(r["attrs"].get("calls", 0) for r in runs) / n, 1) if n else 0,
            "cached_share": round(cached / inp * 100) if inp else 0,
        },
        "daily": daily,
        "steps": steps,
        "agents": agent_rows,
        "tools": tool_rows,
        "slowest": [run_row(r) for r in sorted(runs, key=lambda r: -(r["duration_ms"] or 0))[:8]],
        "expensive": [run_row(r) for r in sorted(runs, key=lambda r: -r["attrs"].get("cost", 0))[:8]],
        "recent": [run_row(r) for r in sorted(runs, key=lambda r: r["start"], reverse=True)[:15]],
    }
