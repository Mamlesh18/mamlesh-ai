"""Prompt registry: every prompt has numbered versions in MongoDB, and one version of each is active.

- prompts/*.md are the starting point. On startup, a file whose text is not stored yet becomes a new version
  and is made active, so a prompt edited in git and deployed still wins.
- Versions made in the UI live only in MongoDB ("prompt_versions"); the active choice is in "prompt_active".
- load_prompt() (prompts/__init__.py) reads the active text from the in-memory cache here.
- try_versions() lets an eval run build a test copy of the agents with other versions, without touching
  the live agents.
"""
import contextlib
import contextvars
import hashlib
from datetime import datetime, timezone

from services import db as database
from utils.cost import count_tokens
from utils.env import ROOT_DIR
from utils.logger import get_logger

log = get_logger(__name__)

PROMPTS_DIR = ROOT_DIR / "prompts"
PLACEHOLDERS = {"planner": ["{domains}"], "personal": ["{memory_dir}"], "coding": ["{root_dir}"]}  # must stay in the text

_active: dict[str, dict] = {}  # name -> {"version": n, "text": str}
_trying = contextvars.ContextVar("prompt_trying", default=None)  # {name: text} while a test graph is built


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _file_text(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text(encoding="utf-8").strip()


def names() -> list[str]:
    return sorted(f.stem for f in PROMPTS_DIR.glob("*.md"))


def get(name: str) -> str:
    """The text the agents should use: a version being tried > the active version > the file."""
    trying = _trying.get()
    if trying and name in trying:
        return trying[name]
    if name in _active:
        return _active[name]["text"]
    return _file_text(name)


def active_versions() -> dict[str, int]:
    return {n: v["version"] for n, v in sorted(_active.items())}


@contextlib.contextmanager
def try_versions(texts: dict[str, str]):
    """Inside this block, get() returns these texts instead of the active ones."""
    token = _trying.set(texts)
    try:
        yield
    finally:
        _trying.reset(token)


async def setup():
    """Store any new file text as a version, then load the active versions into memory."""
    db = database.db
    if db is None:
        return
    await db.prompt_versions.create_index([("name", 1), ("version", -1)], unique=True)
    for name in names():
        text = _file_text(name)
        if not await db.prompt_versions.find_one({"name": name, "hash": _hash(text)}, {"_id": 1}):
            v = await _insert(name, text, f"from prompts/{name}.md", "file")
            await db.prompt_active.update_one({"_id": name}, {"$set": {"version": v}}, upsert=True)
            log.info("Prompt %s: file changed, stored and activated as v%d", name, v)
    await _load()


async def _load():
    _active.clear()
    for a in await database.db.prompt_active.find().to_list(100):
        doc = await database.db.prompt_versions.find_one({"name": a["_id"], "version": a["version"]})
        if doc:
            _active[a["_id"]] = {"version": doc["version"], "text": doc["text"]}


async def _insert(name: str, text: str, note: str, source: str) -> int:
    last = await database.db.prompt_versions.find_one({"name": name}, sort=[("version", -1)])
    v = (last["version"] + 1) if last else 1
    await database.db.prompt_versions.insert_one({
        "name": name, "version": v, "text": text, "hash": _hash(text), "note": note[:300], "source": source,
        "tokens": count_tokens(text), "created_at": datetime.now(timezone.utc)})
    return v


def check_text(name: str, text: str):
    text = text.strip()
    if not text:
        raise ValueError("The prompt is empty.")
    missing = [p for p in PLACEHOLDERS.get(name, []) if p not in text]
    if missing:
        raise ValueError(f"The prompt must keep {', '.join(missing)} - the app fills it in.")
    return text


async def save(name: str, text: str, note: str = "", activate: bool = False) -> int:
    """Store a new version (or reuse an identical one). Returns its number."""
    if name not in names():
        raise ValueError(f"Unknown prompt: {name}")
    text = check_text(name, text)
    same = await database.db.prompt_versions.find_one({"name": name, "hash": _hash(text)})
    v = same["version"] if same else await _insert(name, text, note or "edited in the UI", "ui")
    if activate:
        await set_active(name, v)
    return v


async def set_active(name: str, version: int):
    doc = await database.db.prompt_versions.find_one({"name": name, "version": version})
    if not doc:
        raise ValueError(f"{name} has no version {version}")
    await database.db.prompt_active.update_one({"_id": name}, {"$set": {"version": version}}, upsert=True)
    _active[name] = {"version": version, "text": doc["text"]}
    log.info("Prompt %s: v%d is now active", name, version)


async def texts_for(versions: dict[str, int]) -> dict[str, str]:
    """{name: version} -> {name: text}, for trying versions in an eval run."""
    out = {}
    for name, v in versions.items():
        doc = await database.db.prompt_versions.find_one({"name": name, "version": int(v)})
        if not doc:
            raise ValueError(f"{name} has no version {v}")
        out[name] = doc["text"]
    return out


async def list_prompts() -> list[dict]:
    cursor = await database.db.prompt_versions.aggregate([
        {"$group": {"_id": "$name", "versions": {"$sum": 1}, "updated_at": {"$max": "$created_at"}}}])
    counts = {d["_id"]: d for d in await cursor.to_list(100)}
    return [{"name": n, "active": _active.get(n, {}).get("version"), "tokens": count_tokens(get(n)),
             "versions": counts.get(n, {}).get("versions", 0),
             "updated_at": counts[n]["updated_at"].isoformat() if n in counts else None} for n in names()]


async def history(name: str) -> dict:
    docs = await database.db.prompt_versions.find({"name": name}, {"_id": 0, "hash": 0}) \
        .sort("version", -1).to_list(200)
    for d in docs:
        d["created_at"] = d["created_at"].isoformat()
    return {"name": name, "active": _active.get(name, {}).get("version"), "versions": docs,
            "placeholders": PLACEHOLDERS.get(name, [])}
