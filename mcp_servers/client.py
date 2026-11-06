"""Connects to every enabled MCP server in config.py and loads its tools."""
import json

from langchain_mcp_adapters.client import MultiServerMCPClient

from mcp_servers.config import MCP_SERVERS
from utils.logger import get_logger

log = get_logger(__name__)


def _block_paths(tool, blocked: list[str]):
    """Refuse any call whose arguments mention a blocked path (e.g. .env with all the API keys)."""
    original = tool.coroutine

    async def guarded(**kwargs):
        # Only look at path arguments (path, paths, source, destination), not at file contents.
        paths = {k: v for k, v in kwargs.items() if "path" in k or k in ("source", "destination")}
        text = json.dumps(paths, default=str).replace("\\\\", "/").lower()
        if any(b.lower() in text for b in blocked):
            return f"Blocked: {', '.join(blocked)} are private and cannot be accessed.", None
        return await original(**kwargs)

    tool.coroutine = guarded
    return tool


async def load_mcp_tools() -> dict:
    """Returns {domain: {server_name: {"status": ..., "tools": [BaseTool, ...], "error": ...}}}."""
    result = {}
    for domain, servers in MCP_SERVERS.items():
        result[domain] = {}
        for name, cfg in servers.items():
            cfg = dict(cfg)
            enabled = cfg.pop("enabled", True)
            blocked = cfg.pop("blocked", [])
            info = {"status": "disabled", "tools": [], "error": None, "transport": cfg["transport"]}
            result[domain][name] = info
            if not enabled:
                continue
            try:
                client = MultiServerMCPClient({name: cfg})
                tools = await client.get_tools(server_name=name)
                info.update(status="connected", tools=[_block_paths(t, blocked) for t in tools] if blocked else tools)
                log.info("MCP %s/%s connected with %d tools", domain, name, len(tools))
            except Exception as e:
                # Errors from the MCP client often come wrapped in an ExceptionGroup; show the real ones.
                error = "; ".join(str(x) for x in getattr(e, "exceptions", [e]))
                info.update(status="error", error=error)
                log.warning("MCP %s/%s failed: %s", domain, name, error)
    return result
