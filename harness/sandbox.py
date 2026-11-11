"""Sandbox mode: while evals run, tools that write, send, pay or delete return a fake result instead of running.

Reading tools still run for real (prices, portfolio, web search, GitHub reads...), so evals test real behaviour
without touching real data. Turned on per task with SANDBOX.set(True); it follows the task into the agents.
"""
import contextvars
import functools
import json
import re

SANDBOX = contextvars.ContextVar("sandbox", default=False)

# Tools that change something. MCP tools are matched by name; our custom ones are listed.
WRITE_PATTERN = re.compile(
    r"^(add|create|delete|remove|write|edit|move|fork|merge|push|update|set|resend|capture|initiate|submit|revoke|"
    r"notify|request|send|cancel|close|upload|append)_|_write$|^payment_link_(notify|upi_create)$")
CUSTOM_WRITE_TOOLS = {"log_weight", "log_health", "set_health_goal", "delete_health_entry", "kb_add", "draft_email"}


def is_write_tool(name: str) -> bool:
    return name in CUSTOM_WRITE_TOOLS or bool(WRITE_PATTERN.search(name))


def guard(tool):
    """Wrap a write tool so that in sandbox mode it only reports what it would have done."""
    if not is_write_tool(tool.name) or tool.coroutine is None or getattr(tool.coroutine, "_sandboxed", False):
        return tool  # read tool, sync tool, or already wrapped (agents are rebuilt after MCP logins)
    original = tool.coroutine
    returns_artifact = getattr(tool, "response_format", "content") == "content_and_artifact"

    @functools.wraps(original)  # keeps the annotations, so LangChain still passes `config` to tools that want it
    async def guarded(*args, **kwargs):
        if SANDBOX.get():
            shown = {k: v for k, v in kwargs.items() if k != "config"}
            msg = f"[sandbox] {tool.name} was NOT run (eval mode). It would have been called with: {json.dumps(shown, default=str)[:500]}. Treat it as done."
            return (msg, None) if returns_artifact else msg
        return await original(*args, **kwargs)

    guarded._sandboxed = True
    tool.coroutine = guarded
    return tool
