"""Connects to every enabled MCP server in config.py and loads its tools."""
import json
import re

from langchain_mcp_adapters.client import MultiServerMCPClient

from mcp_servers import oauth
from mcp_servers.config import MCP_SERVERS
from utils.logger import get_logger

log = get_logger(__name__)

MAX_TOOL_OUTPUT_CHARS = 30_000  # ~7.5k tokens. Bigger results are cut so one tool call can't blow up the LLM call.


BASE64_DATA = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{100,}")


def _limit_output(tool, limit: int = MAX_TOOL_OUTPUT_CHARS):
    """Shrink tool results before they reach the LLM:
    1. embedded base64 files (e.g. cover images) are replaced, since an LLM can't use them anyway;
    2. anything still too long is cut, with a note so the agent doesn't guess from partial data."""
    original = tool.coroutine

    async def limited(**kwargs):
        result = await original(**kwargs)
        content, artifact = result if isinstance(result, tuple) else (result, None)
        note = (f"\n\n[TRUNCATED at {limit} characters: this result is incomplete. Do not count or total items from it."
                " Ask for fewer items or a specific item instead.]")
        strip = lambda s: BASE64_DATA.sub("[base64 data omitted]", s)
        if isinstance(content, str):
            content = strip(content)
            if len(content) > limit:
                content = content[:limit] + note
        elif isinstance(content, list):  # MCP content blocks
            used, kept = 0, []
            for block in content:
                text = block.get("text") if isinstance(block, dict) else None
                if text is not None:
                    text = strip(text)
                    block = {**block, "text": text}
                if text is None:
                    kept.append(block)
                    continue
                if used >= limit:
                    break
                if used + len(text) > limit:
                    kept.append({**block, "text": text[: limit - used] + note})
                    used = limit
                    break
                kept.append(block)
                used += len(text)
            content = kept
        return (content, artifact) if isinstance(result, tuple) else content

    tool.coroutine = limited
    return tool


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
        for name in servers:
            result[domain][name] = await connect_server(domain, name)
    return result


def _error_text(e: Exception) -> str:
    # Errors from the MCP client often come wrapped in an ExceptionGroup; show the real ones.
    return "; ".join(_error_text(x) if hasattr(x, "exceptions") else str(x) for x in getattr(e, "exceptions", [e]))


def _is_auth_error(text: str) -> bool:
    return "401" in text or "invalid_token" in text or "Unauthorized" in text


# Set by services/run_service.py: called when an OAuth server's login expires during a tool call.
on_auth_expired = None


def _watch_auth(tool, domain: str, name: str):
    """If a call fails because the login expired, flag the server (the UI shows a LOG IN button)."""
    original = tool.coroutine

    async def watched(**kwargs):
        try:
            return await original(**kwargs)
        except Exception as e:
            if not _is_auth_error(_error_text(e)):
                raise
            if on_auth_expired:
                await on_auth_expired(domain, name)
            return (f"The {name} login has expired. Tell the user to click the LOG IN button on the {name} node "
                    "in the agent map to log in again, then retry.", None)

    tool.coroutine = watched
    return tool


async def connect_server(domain: str, name: str) -> dict:
    """Connect to one MCP server from config.py and load its tools."""
    cfg = dict(MCP_SERVERS[domain][name])
    enabled = cfg.pop("enabled", True)
    blocked = cfg.pop("blocked", [])
    uses_oauth = cfg.pop("oauth", False)
    info = {"status": "disabled", "tools": [], "error": None, "transport": cfg["transport"], "oauth": uses_oauth}
    if not enabled:
        return info

    if uses_oauth:
        server = oauth.get_server(f"{domain}/{name}", cfg["url"])
        if not await server.access_token():
            log.info("MCP %s/%s needs login", domain, name)
            return {**info, "status": "auth_required"}
        cfg["auth"] = oauth.BearerAuth(server)

    try:
        client = MultiServerMCPClient({name: cfg})
        tools = await client.get_tools(server_name=name)
        tools = [_limit_output(t) for t in tools]
        if blocked:
            tools = [_block_paths(t, blocked) for t in tools]
        if uses_oauth:
            tools = [_watch_auth(t, domain, name) for t in tools]
        log.info("MCP %s/%s connected with %d tools", domain, name, len(tools))
        return {**info, "status": "connected", "tools": tools}
    except Exception as e:
        error = _error_text(e)
        status = "auth_required" if uses_oauth and _is_auth_error(error) else "error"
        log.warning("MCP %s/%s %s: %s", domain, name, status, error)
        return {**info, "status": status, "error": error}
