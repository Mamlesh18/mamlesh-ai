"""Live events: every step an agent takes is sent to all open browser tabs and saved in MongoDB.

Event types:
  run.start, plan, domain.start, tool.start, tool.end, tool.error, domain.end, token, run.end, run.error
"""
import asyncio
from collections import deque
from datetime import datetime, timezone

from fastapi import WebSocket

from services import db as database
from utils.logger import get_logger

log = get_logger(__name__)

clients: set[WebSocket] = set()
recent_events: deque = deque(maxlen=1000)  # used when MongoDB is not available
main_loop: asyncio.AbstractEventLoop | None = None  # set at startup


async def emit(run_id: str, type: str, **data):
    event = {"run_id": run_id, "type": type, "ts": datetime.now(timezone.utc).isoformat(), **data}

    # Sync tools run in a worker thread with their own event loop. WebSockets and MongoDB only work
    # on the main loop, so hand the event over to it.
    if main_loop is not None and asyncio.get_running_loop() is not main_loop:
        asyncio.run_coroutine_threadsafe(_send(event), main_loop)
        return
    await _send(event)


async def _send(event: dict):
    type = event["type"]
    recent_events.append(event)

    for ws in list(clients):
        try:
            await ws.send_json(event)
        except Exception:
            clients.discard(ws)

    # Tokens are only for the live view, so they are not saved.
    if database.db is not None and type != "token":
        try:
            await database.db.events.insert_one(dict(event))
        except Exception as e:
            log.warning("Could not save event: %s", e)


async def tool_calls(server: str, limit: int = 50) -> list[dict]:
    """Finished tool calls for one MCP server, newest first."""
    types = ["tool.end", "tool.error"]
    if database.db is not None:
        cursor = database.db.events.find({"server": server, "type": {"$in": types}}, {"_id": 0})
        return await cursor.sort("ts", -1).limit(limit).to_list(limit)
    calls = [e for e in recent_events if e.get("server") == server and e["type"] in types]
    return list(reversed(calls))[:limit]
