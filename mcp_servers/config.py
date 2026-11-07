"""Which MCP servers each domain agent uses.

Two ways to connect:
  stdio            -> the app starts the server as a child process
                      {"transport": "stdio", "command": "...", "args": [...]}
  streamable_http  -> the server is already running somewhere
                      {"transport": "streamable_http", "url": "...", "headers": {...}}

"enabled": False switches a server off (used when its key is missing from .env).
"""
import base64
import shutil
import sys
from pathlib import Path

from utils.env import (
    GITHUB_ACCESS_TOKEN, MCP_API_KEY, MEMORY_DIR, RAZORPAY_API_KEY, RAZORPAY_API_SECRET, ROOT_DIR,
    TAVILY_API_KEY,
)

SERVERS_DIR = Path(__file__).parent / "servers"
PYTHON = sys.executable
NPX = shutil.which("npx") or "npx"  # on Windows this finds npx.cmd

RAZORPAY_TOKEN = base64.b64encode(f"{RAZORPAY_API_KEY}:{RAZORPAY_API_SECRET}".encode()).decode()


def filesystem(folder: Path) -> dict:
    """Official filesystem MCP server, limited to one folder. "blocked" paths can never be touched.
    Uses the globally installed binary if there is one (Docker image), otherwise npx."""
    installed = shutil.which("mcp-server-filesystem")
    command, args = (installed, []) if installed else (NPX, ["-y", "@modelcontextprotocol/server-filesystem"])
    return {
        "transport": "stdio",
        "command": command,
        "args": [*args, str(folder)],
        "blocked": [".env", ".git", ".venv"],
    }


MCP_SERVERS = {
    "coding": {
        "github": {
            "transport": "streamable_http",
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": {"Authorization": f"Bearer {GITHUB_ACCESS_TOKEN}"},
            "enabled": bool(GITHUB_ACCESS_TOKEN),
        },
        "drawio": {"transport": "streamable_http", "url": "https://mcp.draw.io/mcp"},
        "filesystem": filesystem(ROOT_DIR),  # the mamlesh-ai project folder
    },
    "conversation": {
        # "gmail": {...}, "teams": {...}, "slack": {...},
    },
    "personal": {
        "mamlesh_mcp": {
            "transport": "streamable_http",
            "url": "https://mamlesh-mcp.vercel.app/mcp",
            "headers": {"Authorization": f"Bearer {MCP_API_KEY}"},
            "enabled": bool(MCP_API_KEY),
        },
        "razorpay": {
            "transport": "streamable_http",
            "url": "https://mcp.razorpay.com/mcp",
            "headers": {"Authorization": f"Basic {RAZORPAY_TOKEN}"},
            "enabled": bool(RAZORPAY_API_KEY and RAZORPAY_API_SECRET),
        },
        "memory": filesystem(MEMORY_DIR),  # daily notes only
    },
    "general": {
        "utility": {"transport": "stdio", "command": PYTHON, "args": [str(SERVERS_DIR / "utility_server.py")]},
        "tavily": {
            "transport": "streamable_http",
            "url": f"https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}",
            "enabled": bool(TAVILY_API_KEY),
        },
    },
    "healthcare": {
        # "healthcare_system": {...},
    },
    "finance": {
        # Mamlesh's Upstox account (read-only). Login is OAuth in the browser: "oauth": True
        # makes the app handle registration, login, token refresh and the LOG IN button.
        "upstox": {"transport": "streamable_http", "url": "https://mcp.upstox.com/mcp", "oauth": True},
    },
    "brain": {},  # Brain uses the custom FAISS tools in tools/brain_tools.py
}
