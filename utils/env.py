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

# Login for the web UI. If AUTH_EMAIL / AUTH_PASSWORD are missing, nobody can log in.
AUTH_EMAIL = os.getenv("AUTH_EMAIL", "").strip().lower()
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "")
SESSION_SECRET = os.getenv("SESSION_SECRET", "")  # signs the login cookie; if missing, a random one is used
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "7"))

# Gmail sending (Conversation agent). App password from myaccount.google.com/apppasswords (needs 2-Step Verification).
# Accept both EMAIL and email: Windows env names are case-insensitive, Linux (Render) is not.
GMAIL_ADDRESS = (os.getenv("EMAIL") or os.getenv("email") or "").strip()
GMAIL_APP_PASSWORD = (os.getenv("APP_PASSWORD") or "").replace(" ", "").strip()  # Google shows it with spaces
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Mamlesh")
EMAIL_SENDS_PER_DAY = int(os.getenv("EMAIL_SENDS_PER_DAY", "30"))

# Agent traces (spans + step-by-step events) are deleted automatically after this many days
TRACE_RETENTION_DAYS = int(os.getenv("TRACE_RETENTION_DAYS", "7"))

# Your time zone as minutes from UTC (India = +330), used for "today" in the health log
UTC_OFFSET_MINUTES = int(os.getenv("UTC_OFFSET_MINUTES", "330"))

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

DATA_DIR = ROOT_DIR / "data"      # FAISS index (built from kb/ and memory/)
KB_DIR = ROOT_DIR / "kb"          # knowledge files for the Brain agent (.md / .txt)
MEMORY_DIR = ROOT_DIR / "memory"  # daily notes, written by the Personal agent
# Extra read-only knowledge folder. On Render, upload kb files as "Secret Files": they appear in /etc/secrets
KB_SECRET_DIR = Path(os.getenv("KB_SECRET_DIR", "/etc/secrets"))
for _d in (DATA_DIR, KB_DIR, MEMORY_DIR):
    _d.mkdir(exist_ok=True)
