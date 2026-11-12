"""Tracing: one trace per query, made of spans (run -> planner / agent / synthesizer -> LLM calls / tool calls).

Spans are collected in memory while the query runs and saved to MongoDB in one write at the end
(collection "spans"). Every span and every live event gets an `expire_at` date, and MongoDB's TTL index
deletes them automatically after TRACE_RETENTION_DAYS (default 7). Chats and their answers are kept.

Span: {_id, trace_id (= run id), parent_id, kind, name, start, end, duration_ms, status, error, attrs}
kind: run | planner | agent | synthesizer | llm | tool
"""
import uuid
from datetime import datetime, timedelta, timezone

from services import db as database
from utils.env import TRACE_RETENTION_DAYS
from utils.logger import get_logger

log = get_logger(__name__)


def expires_at() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=TRACE_RETENTION_DAYS)


def start_span(trace: list | None, kind: str, name: str, parent_id: str | None, span_id: str | None = None, **attrs) -> dict:
    """Open a span and add it to the trace (a plain list shared by the whole query)."""
    span = {"_id": span_id or uuid.uuid4().hex[:16], "parent_id": parent_id, "kind": kind, "name": name,
            "start": datetime.now(timezone.utc), "end": None, "duration_ms": None, "status": "running",
            "error": None, "attrs": attrs}
    if trace is not None:
        trace.append(span)
    return span


def end_span(span: dict, status: str = "ok", error: str | None = None, **attrs) -> dict:
    span["end"] = datetime.now(timezone.utc)
    span["duration_ms"] = int((span["end"] - span["start"]).total_seconds() * 1000)
    span["status"] = status
    span["error"] = error[:500] if error else None
    span["attrs"].update(attrs)
    return span


async def save(trace_id: str, trace: list):
    """Write all spans of one query (unfinished spans are closed as 'unfinished')."""
    if database.db is None or not trace:
        return
    from harness.guardrails import redact_obj

    expiry = expires_at()
    for span in trace:
        span["attrs"] = redact_obj(span["attrs"])[0]  # no secrets in saved traces
        if span["end"] is None:
            end_span(span, status="unfinished")
        span["trace_id"] = trace_id
        span["expire_at"] = expiry
    try:
        await database.db.spans.insert_many(trace)
    except Exception as e:
        log.warning("Could not save trace %s: %s", trace_id, e)


async def setup():
    """Indexes, including the TTL indexes that delete old traces and events by themselves."""
    if database.db is None:
        return
    db = database.db
    await db.spans.create_index("expire_at", expireAfterSeconds=0)
    await db.spans.create_index([("trace_id", 1), ("start", 1)])
    await db.spans.create_index([("kind", 1), ("start", -1)])
    await db.events.create_index("expire_at", expireAfterSeconds=0)
    await db.eval_results.create_index("expire_at", expireAfterSeconds=0)  # per-case eval details are trace data too
    await db.eval_results.create_index("eval_id")
    # Events saved before tracing existed have no expiry yet: give them one, so they go too.
    result = await db.events.update_many({"expire_at": {"$exists": False}}, {"$set": {"expire_at": expires_at()}})
    if result.modified_count:
        log.info("Tracing: %d older events will now expire in %d days", result.modified_count, TRACE_RETENTION_DAYS)


async def delete_all() -> dict:
    """Delete every trace, live event and eval case detail now (chats, answers and eval scorecards are kept)."""
    if database.db is None:
        return {"spans": 0, "events": 0, "eval_details": 0}
    spans = await database.db.spans.delete_many({})
    events = await database.db.events.delete_many({})
    details = await database.db.eval_results.delete_many({})
    return {"spans": spans.deleted_count, "events": events.deleted_count, "eval_details": details.deleted_count}


async def get_trace(trace_id: str) -> list[dict]:
    if database.db is None:
        return []
    spans = await database.db.spans.find({"trace_id": trace_id}).sort("start", 1).to_list(2000)
    if not spans:
        return []
    t0 = min(s["start"] for s in spans)
    depth = {}
    for s in spans:  # parents always start before their children
        depth[s["_id"]] = depth.get(s["parent_id"], -1) + 1 if s["parent_id"] in depth else 0
    return [{"id": s["_id"], "parent_id": s["parent_id"], "kind": s["kind"], "name": s["name"],
             "offset_ms": int((s["start"] - t0).total_seconds() * 1000), "duration_ms": s["duration_ms"],
             "status": s["status"], "error": s["error"], "attrs": s["attrs"], "depth": depth[s["_id"]]} for s in spans]
