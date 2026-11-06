"""All HTTP and WebSocket endpoints. The logic lives in services/."""
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from services import events, run_service, stt

router = APIRouter()


class RunRequest(BaseModel):
    query: str
    source: str = "text"  # "text" or "voice"


@router.get("/api/health")
def get_health():
    """Shows MongoDB, Brain (which knowledge files were found) and MCP server status."""
    return run_service.health()


@router.get("/api/graph")
def get_graph():
    """Domains, their MCP servers and the tools on each server."""
    return run_service.graph_info()


@router.post("/api/runs")
async def create_run(body: RunRequest):
    if not body.query.strip():
        raise HTTPException(400, "Query is empty")
    return {"run_id": run_service.start_run(body.query.strip(), body.source)}


@router.get("/api/runs")
async def list_runs():
    return await run_service.list_runs()


@router.get("/api/runs/{run_id}/events")
async def get_run_events(run_id: str):
    return await run_service.run_events(run_id)


@router.get("/api/mcp/{domain}/{server}/calls")
async def get_tool_calls(domain: str, server: str):
    return await events.tool_calls(f"{domain}/{server}")


@router.websocket("/ws/stt")
async def speech_to_text(ws: WebSocket):
    """Browser mic audio in, Deepgram transcripts out."""
    await stt.proxy_to_deepgram(ws)


@router.websocket("/ws")
async def live_events(ws: WebSocket):
    """The UI connects here once and receives every event from every run."""
    await ws.accept()
    events.clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep the connection open
    except WebSocketDisconnect:
        events.clients.discard(ws)
