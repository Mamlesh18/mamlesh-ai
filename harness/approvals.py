"""Approvals: every tool that writes, sends, pays or deletes waits for Mamlesh to click Approve in the chat.

Flow: the agent calls a write tool -> request() saves the request, shows an Approve / Reject card in the chat
(event "approval.request") and waits -> Mamlesh clicks -> decide() wakes it up -> the tool runs, or the agent
is told it was rejected (with Mamlesh's note, if any). No answer within TIMEOUT_S counts as rejected.

The waiting happens in this process, so a server restart drops pending requests (they show as expired).
Requests are trace data: they expire with the traces (TRACE_RETENTION_DAYS).
"""
import asyncio
import contextvars
import uuid
from datetime import datetime, timezone

from services import db as database
from services.events import emit
from utils.logger import get_logger

log = get_logger(__name__)

TIMEOUT_S = 600  # 10 minutes to decide

# Set by the domain node for each agent run: {"run_id", "agent", "user_text"}. Tools read it (it follows the
# task into the agent's tool calls), so they know which chat message to show the card in.
CURRENT = contextvars.ContextVar("run_context", default=None)

_waiting: dict[str, asyncio.Future] = {}


def _out(doc: dict) -> dict:
    doc = {k: v for k, v in doc.items() if k != "expire_at"}
    doc["approval_id"] = doc.pop("_id")
    for k in ("created_at", "decided_at"):
        if isinstance(doc.get(k), datetime):
            doc[k] = doc[k].isoformat()
    return doc


async def request(tool: str, server: str, args: dict) -> dict:
    """Ask Mamlesh and wait. Returns {"approved": bool, "status": approved|rejected|expired, "note": str}."""
    from harness import guardrails
    from harness.tracing import expires_at

    ctx = CURRENT.get() or {}
    run_id = ctx.get("run_id")
    if not run_id:  # not inside a chat question (should not happen): never run a write unasked
        return {"approved": False, "status": "rejected", "note": "No chat to ask for approval in."}
    doc = {"_id": uuid.uuid4().hex[:12], "run_id": run_id, "agent": ctx.get("agent"), "tool": tool, "server": server,
           "query": ctx.get("query", "")[:300],
           "args": guardrails.redact_obj(args)[0], "status": "pending", "created_at": datetime.now(timezone.utc),
           "expire_at": expires_at()}
    db = database.db
    if db is not None:
        await db.approvals.insert_one(doc)
    fut = asyncio.get_running_loop().create_future()
    _waiting[doc["_id"]] = fut
    await emit(run_id, "approval.request", approval=_out(dict(doc)))
    log.info("Approval %s: %s/%s waiting for Mamlesh", doc["_id"], server, tool)
    try:
        decision = await asyncio.wait_for(fut, TIMEOUT_S)
    except asyncio.TimeoutError:
        decision = {"approved": False, "status": "expired", "note": ""}
    finally:
        _waiting.pop(doc["_id"], None)
    decided = datetime.now(timezone.utc)
    wait_ms = int((decided - doc["created_at"]).total_seconds() * 1000)
    if db is not None:
        await db.approvals.update_one({"_id": doc["_id"]}, {"$set": {
            "status": decision["status"], "note": decision["note"], "decided_at": decided, "wait_ms": wait_ms}})
    await emit(run_id, "approval.result", approval_id=doc["_id"], tool=tool, server=server,
               status=decision["status"], note=decision["note"], wait_ms=wait_ms)
    return decision


def decide(approval_id: str, approved: bool, note: str = "") -> str:
    fut = _waiting.get(approval_id)
    if fut is None or fut.done():
        raise ValueError("This request is no longer waiting (it expired, or was already decided).")
    status = "approved" if approved else "rejected"
    fut.set_result({"approved": approved, "status": status, "note": note.strip()[:500]})
    return status


async def pending() -> list[dict]:
    """Requests still waiting right now (e.g. to show them again after the page was reloaded)."""
    if database.db is None or not _waiting:
        return []
    rows = await database.db.approvals.find({"_id": {"$in": list(_waiting)}, "status": "pending"}).to_list(100)
    return [_out(r) for r in rows]


async def for_runs(run_ids: list[str]) -> list[dict]:
    if database.db is None or not run_ids:
        return []
    rows = await database.db.approvals.find({"run_id": {"$in": run_ids}}).sort("created_at", 1).to_list(500)
    return [_out(r) for r in rows]


async def setup():
    """After a restart nothing is waiting any more: mark old pending requests as expired."""
    if database.db is None:
        return
    await database.db.approvals.create_index("expire_at", expireAfterSeconds=0)
    await database.db.approvals.create_index("run_id")
    await database.db.approvals.update_many({"status": "pending"}, {"$set": {"status": "expired"}})
