"""A small demo MCP server for the General agent.

Runs over stdio by default (the app starts it for you).
To run it over HTTP instead:  python mcp_servers/servers/utility_server.py http
"""
import sys
from datetime import datetime

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("utility", port=8101)


@mcp.tool()
def get_current_time() -> str:
    """Get the current local date and time."""
    return datetime.now().strftime("%A, %d %B %Y, %H:%M:%S")


@mcp.tool()
def calculate(expression: str) -> str:
    """Evaluate a basic maths expression, e.g. '12 * (3 + 4) / 2'."""
    allowed = set("0123456789+-*/(). %")
    if not set(expression) <= allowed or "**" in expression:
        return "Only numbers and + - * / ( ) % are allowed."
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))
    except Exception as e:
        return f"Could not calculate: {e}"


if __name__ == "__main__":
    transport = "streamable-http" if len(sys.argv) > 1 and sys.argv[1] == "http" else "stdio"
    mcp.run(transport=transport)
