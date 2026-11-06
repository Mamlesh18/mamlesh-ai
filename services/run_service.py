"""Starts the system (MCP servers + agents) and runs user queries through the Orchestrator."""
import asyncio
import uuid
from datetime import datetime, timezone

from agents.domain_agents import DOMAINS, build_domain_agents
from agents.orchestrator import build_orchestrator
from mcp_servers.client import load_mcp_tools
from services import db as database
from services.events import emit
from utils.logger import get_logger

log = get_logger(__name__)

system = {"mcp": {}, "tool_owner": {}, "graph": None}
_tasks: set[asyncio.Task] = set()  # keeps running queries alive


async def startup():
    from services import events
    from tools import brain_tools

    events.main_loop = asyncio.get_running_loop()
    await asyncio.to_thread(brain_tools.sync)  # build/load the FAISS index from kb/ and memory/
    system["mcp"] = await load_mcp_tools()
    agents, system["tool_owner"] = build_domain_agents(system["mcp"])
    system["graph"] = build_orchestrator(agents, system["tool_owner"])
    log.info("Orchestrator ready with %d domain agents", len(agents))


def graph_info() -> dict:
    """Everything the UI needs to draw the graph: domains -> servers -> tools."""
    from tools import CUSTOM_TOOLS

    domains = []
    for name, desc in DOMAINS.items():
        servers = []
        for server_name, s in system["mcp"].get(name, {}).items():
            servers.append({
                "id": f"{name}/{server_name}", "name": server_name, "status": s["status"],
                "transport": s["transport"], "error": s["error"],
                "tools": [{"name": t.name, "description": t.description} for t in s["tools"]],
            })
        if CUSTOM_TOOLS.get(name):
            servers.append({
                "id": f"{name}/custom", "name": "custom tools", "status": "connected", "transport": "python",
                "error": None,
                "tools": [{"name": t.name, "description": t.description} for t in CUSTOM_TOOLS[name]],
            })
        domains.append({"name": name, "description": desc, "servers": servers})
    return {"domains": domains}


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
    try:
        out = await system["graph"].ainvoke({"query": query}, config={"configurable": {"run_id": run_id}})
        answer, status = out.get("answer", ""), "done"
        await emit(run_id, "run.end", answer=answer)
    except Exception as e:
        log.exception("Run %s failed", run_id)
        answer, status = "", "error"
        await emit(run_id, "run.error", error=str(e))

    if database.db is not None:
        await database.db.runs.insert_one({
            "_id": run_id, "query": query, "source": source, "status": status, "answer": answer,
            "started_at": started, "ended_at": datetime.now(timezone.utc),
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
