"""All HTTP and WebSocket endpoints. The logic lives in services/."""
import html

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from services import auth, events, run_service, stt

router = APIRouter()


def client_ip(request) -> str:
    # Behind Render's proxy the real IP is the first entry of X-Forwarded-For.
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/api/login")
async def login(body: LoginRequest, request: Request, response: Response):
    ip = client_ip(request)
    if auth.is_locked(ip):
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")
    if not auth.check_login(body.email, body.password, ip):
        raise HTTPException(401, "Wrong email or password.")
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(auth.COOKIE, auth.create_token(), max_age=auth.SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=https)
    return {"ok": True}


@router.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


async def ws_allowed(ws: WebSocket) -> bool:
    """WebSockets don't pass through the HTTP middleware, so check the login cookie here."""
    if auth.is_valid(ws.cookies.get(auth.COOKIE)):
        return True
    await ws.close(code=4401, reason="Not logged in")
    return False


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


@router.post("/api/mcp/{domain}/{server}/auth/start")
async def mcp_auth_start(domain: str, server: str, request: Request):
    """Start the OAuth login for an MCP server (e.g. Upstox). Returns the URL to open."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    redirect_uri = f"{proto}://{request.headers['host']}/api/oauth/callback"
    try:
        return {"url": await run_service.auth_start(domain, server, redirect_uri)}
    except Exception as e:
        raise HTTPException(400, f"Could not start login: {e}")


@router.get("/api/oauth/callback", response_class=HTMLResponse)
async def mcp_auth_callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    """The provider sends the browser back here after login."""
    if error or not code:
        ok, message = False, f"Login was not completed: {error_description or error or 'no code returned'}"
    else:
        try:
            server = await run_service.auth_finish(code, state)
            ok, message = True, f"{server} is connected."
        except Exception as e:
            ok, message = False, f"Login failed: {e}"
    return (OAUTH_DONE_PAGE.replace("{ok_tag}", "MCP login").replace("{title}", "Connected ✓" if ok else "Login failed")
            .replace("{ok}", "true" if ok else "false").replace("{message}", html.escape(message)))


OAUTH_DONE_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Login</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head>
<body style="display:grid;place-items:center;min-height:100vh;height:auto;grid-template-rows:1fr">
<div class="box" style="padding:28px 24px;max-width:440px"><span class="tag">{ok_tag}</span>
<h2 style="margin:8px 0 6px;font:700 24px var(--sans);text-transform:uppercase">{title}</h2><p>{message}</p>
<p class="muted">This window will close by itself.</p></div>
<script>
  const ok = {ok};
  if (window.opener) { window.opener.postMessage({type: "mcp-auth", ok}, location.origin); setTimeout(() => window.close(), ok ? 800 : 4000); }
  else setTimeout(() => location.href = "/", ok ? 800 : 4000);
</script></body></html>"""


@router.websocket("/ws/stt")
async def speech_to_text(ws: WebSocket):
    """Browser mic audio in, Deepgram transcripts out."""
    if await ws_allowed(ws):
        await stt.proxy_to_deepgram(ws)


@router.websocket("/ws")
async def live_events(ws: WebSocket):
    """The UI connects here once and receives every event from every run."""
    if not await ws_allowed(ws):
        return
    await ws.accept()
    events.clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # keep the connection open
    except WebSocketDisconnect:
        events.clients.discard(ws)
