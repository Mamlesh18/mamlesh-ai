"""Sandbox mode: while evals run, tools that write, send, pay or delete return a fake result instead of running
(the wrapper is harness/guardrails.protect).

Reading tools still run for real (prices, portfolio, web search, GitHub reads...), so evals test real behaviour
without touching real data. Turned on per task with SANDBOX.set(True); it follows the task into the agents.
"""
import contextvars
import re

SANDBOX = contextvars.ContextVar("sandbox", default=False)

# Tools that change something. MCP tools are matched by name; our custom ones are listed.
WRITE_PATTERN = re.compile(
    r"^(add|create|delete|remove|write|edit|move|fork|merge|push|update|set|resend|capture|initiate|submit|revoke|"
    r"notify|request|send|cancel|close|upload|append)_|_write$|^payment_link_(notify|upi_create)$")
CUSTOM_WRITE_TOOLS = {"log_weight", "log_health", "set_health_goal", "delete_health_entry", "kb_add", "draft_email"}


def is_write_tool(name: str) -> bool:
    return name in CUSTOM_WRITE_TOOLS or bool(WRITE_PATTERN.search(name))
