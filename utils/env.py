"""All environment variables in one place. Read from .env at the project root."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")

MONGODB_URL = os.getenv("MONGODB_URL", "")
MONGODB_DB = os.getenv("MONGODB_DB", "mamlesh_ai")

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

# MCP server credentials (a server is switched off if its key is missing)
GITHUB_ACCESS_TOKEN = os.getenv("GITHUB_ACCESS_TOKEN", "")
RAZORPAY_API_KEY = os.getenv("RAZORPAY_API_KEY", "")
RAZORPAY_API_SECRET = os.getenv("RAZORPAY_API_SECRET", "")
MCP_API_KEY = os.getenv("MCP_API_KEY", "")  # Mamlesh's own MCP server
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
CANVA_CLIENT_ID = os.getenv("CANVA_CLIENT_ID", "")
CANVA_CLIENT_SECRET = os.getenv("CANVA_CLIENT_SECRET", "")

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

DATA_DIR = ROOT_DIR / "data"      # FAISS index (built from kb/ and memory/)
KB_DIR = ROOT_DIR / "kb"          # knowledge files for the Brain agent (.md / .txt)
MEMORY_DIR = ROOT_DIR / "memory"  # daily notes, written by the Personal agent
# Extra read-only knowledge folder. On Render, upload kb files as "Secret Files": they appear in /etc/secrets
KB_SECRET_DIR = Path(os.getenv("KB_SECRET_DIR", "/etc/secrets"))
for _d in (DATA_DIR, KB_DIR, MEMORY_DIR):
    _d.mkdir(exist_ok=True)
