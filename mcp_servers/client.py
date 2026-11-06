"""Connects to every enabled MCP server in config.py and loads its tools."""
import json
import re

from langchain_mcp_adapters.client import MultiServerMCPClient

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
                tools = [_limit_output(t) for t in tools]
                if blocked:
                    tools = [_block_paths(t, blocked) for t in tools]
                info.update(status="connected", tools=tools)
                log.info("MCP %s/%s connected with %d tools", domain, name, len(tools))
            except Exception as e:
                # Errors from the MCP client often come wrapped in an ExceptionGroup; show the real ones.
                error = "; ".join(str(x) for x in getattr(e, "exceptions", [e]))
                info.update(status="error", error=error)
                log.warning("MCP %s/%s failed: %s", domain, name, error)
    return result
