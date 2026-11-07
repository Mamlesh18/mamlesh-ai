"""Starts the system (MCP servers + agents) and runs user queries through the Orchestrator."""
import asyncio
import uuid
from datetime import datetime, timezone

from agents.domain_agents import DOMAINS, build_domain_agents
from agents.orchestrator import build_orchestrator
from mcp_servers import client as mcp_client
from mcp_servers import oauth
from mcp_servers.client import load_mcp_tools
from mcp_servers.config import MCP_SERVERS
from services import db as database
from services.events import emit
from utils.logger import get_logger

log = get_logger(__name__)

system = {"mcp": {}, "tool_owner": {}, "graph": None, "context": {}, "orchestrator_context": {}}
_tasks: set[asyncio.Task] = set()  # keeps running queries alive


async def startup():
    from services import events
    from tools import brain_tools

    from services import kb_store

    events.main_loop = asyncio.get_running_loop()
    await kb_store.pull_missing()  # e.g. on Render, where kb/ is not in git
    await asyncio.to_thread(brain_tools.sync)  # build/load the FAISS index from kb/ and memory/
    mcp_client.on_auth_expired = auth_expired
    system["mcp"] = await load_mcp_tools()
    _build_agents()
    for name, c in system["context"].items():
        log.info("  %-12s %3d tools, %6d tokens sent on every call", name, c["tools"], c["total"])


def _build_agents():
    """(Re)build the domain agents and the Orchestrator from the currently loaded MCP tools."""
    agents, system["tool_owner"], system["context"] = build_domain_agents(system["mcp"])
    system["graph"], system["orchestrator_context"] = build_orchestrator(agents, system["tool_owner"])
    log.info("Orchestrator ready with %d domain agents", len(agents))


async def reconnect(domain: str, name: str):
    """Reconnect one MCP server (e.g. after logging in), rebuild the agents, and tell the UI."""
    system["mcp"][domain][name] = await mcp_client.connect_server(domain, name)
    _build_agents()
    await emit("system", "mcp.status", server=f"{domain}/{name}", status=system["mcp"][domain][name]["status"])


async def auth_expired(domain: str, name: str):
    """A tool call found the login expired: show the LOG IN button and drop that server's tools."""
    info = system["mcp"][domain][name]
    if info["status"] != "auth_required":
        system["mcp"][domain][name] = {**info, "status": "auth_required", "tools": []}
        _build_agents()
        await emit("system", "mcp.status", server=f"{domain}/{name}", status="auth_required")


# ---------- OAuth login for MCP servers ----------

async def auth_start(domain: str, name: str, redirect_uri: str) -> str:
    """Begin the login: returns the provider's login URL to open in the browser."""
    cfg = MCP_SERVERS.get(domain, {}).get(name)
    if not cfg or not cfg.get("oauth"):
        raise ValueError(f"{domain}/{name} does not use OAuth login")
    server = oauth.get_server(f"{domain}/{name}", cfg["url"])
    url, state, pending = await server.start(redirect_uri)
    oauth.PENDING[state] = {**pending, "domain": domain, "name": name}
    return url


async def auth_finish(code: str, state: str) -> str:
    """The provider sent the user back with a one-time code: get the token and reconnect."""
    pending = oauth.PENDING.pop(state, None)
    if not pending:
        raise ValueError("This login link has expired or was already used. Click LOG IN again.")
    domain, name = pending["domain"], pending["name"]
    server = oauth.get_server(f"{domain}/{name}", MCP_SERVERS[domain][name]["url"])
    await server.finish(code, pending)
    await reconnect(domain, name)
    return f"{domain}/{name}"


def graph_info() -> dict:
    """Everything the UI needs to draw the graph: domains -> servers -> tools."""
    from tools import CUSTOM_TOOLS

    domains = []
    for name, desc in DOMAINS.items():
        servers = []
        for server_name, s in system["mcp"].get(name, {}).items():
            servers.append({
                "id": f"{name}/{server_name}", "name": server_name, "status": s["status"],
                "transport": s["transport"], "error": s["error"], "oauth": s.get("oauth", False),
                "tools": [{"name": t.name, "description": t.description} for t in s["tools"]],
            })
        if CUSTOM_TOOLS.get(name):
            servers.append({
                "id": f"{name}/custom", "name": "custom tools", "status": "connected", "transport": "python",
                "error": None,
                "tools": [{"name": t.name, "description": t.description} for t in CUSTOM_TOOLS[name]],
            })
        domains.append({"name": name, "description": desc, "servers": servers, "context": system["context"].get(name)})
    return {"domains": domains, "orchestrator": {"context": system["orchestrator_context"]}}


def health() -> dict:
    """Quick status check: database, Brain knowledge files, and each MCP server."""
    from tools import brain_tools

    return {
        "mongodb": database.db is not None,
        "brain": brain_tools.status(),
        "mcp": {f"{d}/{n}": s["status"] if not s["error"] else f"error: {s['error'][:200]}"
                for d, servers in system["mcp"].items() for n, s in servers.items()},
    }


def start_run(query: str, source: str = "text") -> str:
    """Starts a query in the background and returns its run_id straight away."""
    run_id = uuid.uuid4().hex[:12]
    task = asyncio.create_task(_run(run_id, query, source))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return run_id


async def _run(run_id: str, query: str, source: str):
    started = datetime.now(timezone.utc)
    await emit(run_id, "run.start", query=query, source=source)
    usage = {}  # filled in by every LLM call: {agent: {calls, input_tokens, cached_tokens, output_tokens, cost}}
    try:
        out = await system["graph"].ainvoke({"query": query}, config={"configurable": {"run_id": run_id, "usage": usage}})
        answer, status = out.get("answer", ""), "done"
    except Exception as e:
        log.exception("Run %s failed", run_id)
        answer, status = "", "error"
        await emit(run_id, "run.error", error=str(e))

    ended = datetime.now(timezone.utc)
    totals = {k: sum(a[k] for a in usage.values()) for k in ("calls", "input_tokens", "cached_tokens", "output_tokens", "cost")}
    totals["duration_ms"] = int((ended - started).total_seconds() * 1000)
    if status == "done":
        await emit(run_id, "run.end", answer=answer, usage=usage, totals=totals)
    log.info("Run %s: %d LLM calls, %d in / %d out tokens, $%.5f", run_id, totals["calls"],
             totals["input_tokens"], totals["output_tokens"], totals["cost"])

    if database.db is not None:
        await database.db.runs.insert_one({
            "_id": run_id, "query": query, "source": source, "status": status, "answer": answer,
            "usage": usage, "totals": totals, "started_at": started, "ended_at": ended,
        })


async def list_runs(limit: int = 20) -> list[dict]:
    if database.db is None:
        return []
    runs = await database.db.runs.find().sort("started_at", -1).limit(limit).to_list(limit)
    for r in runs:
        r["run_id"] = r.pop("_id")
        r["started_at"] = r["started_at"].isoformat()
        r["ended_at"] = r["ended_at"].isoformat()
    return runs


async def run_events(run_id: str) -> list[dict]:
    if database.db is None:
        return []
    return await database.db.events.find({"run_id": run_id}, {"_id": 0}).sort("ts", 1).to_list(2000)
