"""All HTTP and WebSocket endpoints. The logic lives in services/."""
import html

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from services import auth, events, mailer, run_service, statements, stt

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
    chat_id: str | None = None  # continue this chat; leave empty to start a new one


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
    run_id, chat_id = run_service.start_run(body.query.strip(), body.source, body.chat_id)
    return {"run_id": run_id, "chat_id": chat_id}


@router.get("/api/chats")
async def list_chats():
    """Saved chats, newest first."""
    return await run_service.list_chats()


@router.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str):
    """One chat with all its messages (question, answer, tokens, cost)."""
    return await run_service.get_chat(chat_id)


@router.delete("/api/chats/{chat_id}")
async def delete_chat(chat_id: str):
    """Delete a chat with its messages, traces, approvals and unsent drafts."""
    from services import conversation
    return await conversation.delete_chat(chat_id)


class MemoryDecision(BaseModel):
    save: bool
    text: str | None = None  # the fact as edited in the card


@router.post("/api/memory/{run_id}/{suggestion_id}")
async def decide_memory(run_id: str, suggestion_id: str, body: MemoryDecision):
    """Save (to the Brain) or dismiss a "Remember this?" card."""
    from services import conversation
    try:
        return await conversation.decide_memory(run_id, suggestion_id, body.save, body.text)
    except ValueError as e:
        raise HTTPException(409, str(e))


@router.get("/api/me")
def me():
    """Who is logged in (for the profile menu)."""
    return {"email": auth.AUTH_EMAIL}


@router.get("/api/runs")
async def list_runs():
    return await run_service.list_runs()


@router.get("/api/runs/{run_id}/events")
async def get_run_events(run_id: str):
    return await run_service.run_events(run_id)


@router.get("/api/mcp/{domain}/{server}/calls")
async def get_tool_calls(domain: str, server: str):
    return await events.tool_calls(f"{domain}/{server}")


# ---------- Observability (harness) ----------

@router.get("/api/harness/metrics")
async def harness_metrics(days: int = 7):
    """Latency, cost, tokens, per-agent and per-tool numbers from the stored traces."""
    from harness import metrics
    return await metrics.summary(max(1, min(days, 30)))


@router.get("/api/harness/traces/{run_id}")
async def harness_trace(run_id: str):
    """All spans of one query, for the waterfall view."""
    from harness import tracing
    return await tracing.get_trace(run_id)


@router.delete("/api/harness/traces")
async def harness_delete_traces():
    """Delete all traces and step-by-step events now. Chats and answers are kept."""
    from harness import tracing
    return await tracing.delete_all()


class EvalRequest(BaseModel):
    label: str = ""
    tags: list[str] | None = None  # only cases with one of these tags
    ids: list[str] | None = None   # only these cases
    prompts: dict[str, int] | None = None  # {prompt name: version} to try instead of the active ones


@router.get("/api/harness/evals/cases")
def harness_eval_cases():
    """The test set (harness/evals/cases.yaml)."""
    from harness.evals import runner
    return runner.load_cases()


@router.post("/api/harness/evals")
async def harness_start_eval(body: EvalRequest):
    """Start an eval run in the background (sandbox mode: nothing is written or sent)."""
    from harness.evals import runner
    try:
        return {"eval_id": await runner.start(body.label, body.tags, body.ids, body.prompts)}
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e))


@router.get("/api/harness/evals")
async def harness_list_evals():
    from harness.evals import runner
    return {"running": runner.current["eval_id"], "runs": await runner.list_runs()}


@router.get("/api/harness/evals/{eval_id}")
async def harness_get_eval(eval_id: str):
    from harness.evals import runner
    run = await runner.get_run(eval_id)
    if not run:
        raise HTTPException(404, "Eval run not found")
    return run


# ---------- Personal memory (MemDream) ----------

@router.get("/api/harness/memory")
async def harness_memory(q: str = ""):
    from harness import memory
    return await memory.overview(q)


@router.get("/api/harness/memory/{memory_id}/history")
async def harness_memory_history(memory_id: str):
    from harness import memory
    return await memory.history(memory_id)


@router.post("/api/harness/memory/{memory_id}/forget")
async def harness_memory_forget(memory_id: str):
    """Stop using a memory (reversible: it stays in the history)."""
    from harness import memory
    return await memory.forget(memory_id)


# ---------- Prompt versions ----------

class PromptSaveRequest(BaseModel):
    text: str
    note: str = ""
    activate: bool = False


class PromptActivateRequest(BaseModel):
    version: int


class PromptImproveRequest(BaseModel):
    instructions: str = ""


@router.get("/api/harness/prompts")
async def harness_list_prompts():
    from harness import prompt_registry
    return await prompt_registry.list_prompts()


@router.get("/api/harness/prompts/{name}")
async def harness_prompt_history(name: str):
    from harness import prompt_registry
    if name not in prompt_registry.names():
        raise HTTPException(404, "Unknown prompt")
    return await prompt_registry.history(name)


@router.post("/api/harness/prompts/{name}")
async def harness_save_prompt(name: str, body: PromptSaveRequest):
    """Save a new version (and optionally make it the one the agents use)."""
    from harness import prompt_registry
    try:
        version = await prompt_registry.save(name, body.text, body.note, body.activate)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if body.activate:
        run_service.rebuild()
    return {"version": version}


@router.post("/api/harness/prompts/{name}/activate")
async def harness_activate_prompt(name: str, body: PromptActivateRequest):
    """Make a version live (also how you roll back)."""
    from harness import prompt_registry
    try:
        await prompt_registry.set_active(name, body.version)
    except ValueError as e:
        raise HTTPException(400, str(e))
    run_service.rebuild()
    return {"active": body.version}


@router.post("/api/harness/prompts/{name}/improve")
async def harness_improve_prompt(name: str, body: PromptImproveRequest):
    """AI suggestion from the latest eval failures. Nothing is saved."""
    from harness import prompt_improver, prompt_registry
    if name not in prompt_registry.names():
        raise HTTPException(404, "Unknown prompt")
    return await prompt_improver.suggest(name, body.instructions)


class ApprovalRequest(BaseModel):
    approved: bool
    note: str = ""


@router.get("/api/approvals/pending")
async def pending_approvals():
    from harness import approvals
    return await approvals.pending()


@router.post("/api/approvals/{approval_id}")
def decide_approval(approval_id: str, body: ApprovalRequest):
    """Mamlesh's answer to an approval card in the chat. The waiting agent continues right away."""
    from harness import approvals
    try:
        return {"status": approvals.decide(approval_id, body.approved, body.note)}
    except ValueError as e:
        raise HTTPException(409, str(e))


class SendDraftRequest(BaseModel):
    to: str
    subject: str
    body: str


@router.post("/api/email/drafts/{draft_id}/send")
async def send_email_draft(draft_id: str, body: SendDraftRequest):
    """Send a draft the agent prepared. Only the person clicking Send in the chat can do this."""
    try:
        d = await mailer.send_draft(draft_id, body.to, body.subject, body.body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    if d["status"] != "sent":
        raise HTTPException(502, f"Gmail did not accept it: {d['error']}")
    return {"status": "sent", "to": d["to"], "sent_at": d["sent_at"]}


@router.post("/api/email/drafts/{draft_id}/discard")
async def discard_email_draft(draft_id: str):
    try:
        await mailer.discard_draft(draft_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"status": "discarded"}


@router.get("/api/healthcare")
async def get_healthcare(days: int = 90):
    """Health goals with progress, weight history and recent entries."""
    from tools.health_tools import overview
    try:
        return await overview(days)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.get("/api/finance/portfolio")
async def get_portfolio():
    """The latest imported consolidated account statement (or null)."""
    s = await statements.get_statement()
    if s:
        s.pop("_id", None)
    return s


@router.post("/api/finance/statement")
async def upload_statement(file: UploadFile = File(...), password: str = Form("")):
    """Upload a CAS PDF: extract the key facts and replace the stored statement."""
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "Please upload a PDF file.")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(400, "The PDF is larger than 15 MB.")
    try:
        doc = await statements.import_statement(data, file.filename or "statement.pdf", password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Could not read the statement: {e}")
    await events.emit("system", "portfolio.updated", total_value=doc["total_value"], as_on=doc["period_to"])
    return {"total_value": doc["total_value"], "as_on": doc["period_to"], "mf_folios": len(doc["mf_folios"]),
            "demat_holdings": len(doc["demat_holdings"]), "warnings": doc["warnings"]}


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
<body style="display:grid;place-items:center;min-height:100vh;height:auto;overflow:auto;padding:16px">
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
