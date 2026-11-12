"""Personal memory layer, powered by MemDream (github.com/Mamlesh18/MemDream).

Only personal details are kept: who people are and how to reach them, where Mamlesh lives and works,
preferences, goals, important dates and constraints. Health and money stay with their own agents
(and MemDream's own policy refuses anything it flags as sensitive).

- recall(query): before planning, the few memories that fit the question are handed to the planner,
  so "email my sister" knows the address without an extra agent call.
- remember(text): saving goes through MemDream's decision step: a new fact is ADDed, or SUPERSEDEs /
  MERGEs an old one ("moved to Pune" replaces "lives in Bangalore"). Writes only happen on Mamlesh's
  click (a "Remember this?" card, or an approved remember_personal tool call).
- Storage: MemDream's own MongoDB database (MEMDREAM_DB) + a FAISS index on disk. Render's disk is wiped
  on deploy, so the index is rebuilt from MongoDB at startup (MongoDB keeps every embedding).
- Evals use a separate partition (EVAL_USER) filled with made-up fixtures, never the real memories.
"""
import asyncio
import os

from harness.sandbox import SANDBOX
from utils.env import MONGODB_URL, OPENAI_MODEL, ROOT_DIR
from utils.logger import get_logger

log = get_logger(__name__)

USER = "mamlesh"
EVAL_USER = "eval-fixtures"
MEMDREAM_DB = os.getenv("MEMDREAM_DB", "mamlesh_memdream")
PERSONAL_TYPES = ["profile", "relationship", "preference", "goal", "event", "constraint", "fact"]
RECALL_LIMIT = 6
RECALL_MIN_SCORE = 0.35
RECALL_TIMEOUT_S = 3.0

# Made-up facts for the eval partition (the repo is public: nothing real here).
EVAL_FIXTURES = [
    ("Mamlesh's sister is Priya; her email address is priya.test@example.com.", "relationship"),
    ("Mamlesh lives in Pune.", "profile"),
    ("Mamlesh prefers short, direct answers.", "preference"),
]

PROMPTS_DIR = ROOT_DIR / "prompts" / "memdream"  # MemDream's own prompts (starter set; extraction.md narrowed to personal details)

_mem = None          # AsyncMemDream, built in setup()
_ready = asyncio.Event()
state = {"enabled": False, "error": None, "indexed": 0}


def _build():
    from memdream import AsyncMemDream

    return AsyncMemDream(
        user_id=USER,
        database=MONGODB_URL,
        mongodb_database=MEMDREAM_DB,
        llm=f"openai:{OPENAI_MODEL}",
        embeddings="openai:text-embedding-3-small",
        vector=f"faiss:{ROOT_DIR / 'data' / 'memdream_faiss'}",
        prompts=str(PROMPTS_DIR),
        memory={"allowed_memory_types": PERSONAL_TYPES, "allow_sensitive": False},
        log_level="WARNING",
    )


async def setup():
    """Start MemDream, rebuild the vector index from MongoDB, and make sure the eval fixtures exist."""
    global _mem
    if not MONGODB_URL:
        state["error"] = "MONGODB_URL is not set"
        return
    try:
        _mem = _build()
        container = await _mem.start()
        for user in (USER, EVAL_USER):
            scope = await _mem._scope({"user_id": user})
            rows = await container.memories.iter_all(scope)
            await container.retriever.index_memories(scope, [m for m in rows if m.status.value in ("active", "superseded")])
            if user == USER:
                state["indexed"] = len(rows)
        await _seed_eval_fixtures()
        state["enabled"] = True
        log.info("Memory (MemDream) ready: %d memories indexed", state["indexed"])
    except Exception as e:  # the app works without memory
        state["error"] = f"{type(e).__name__}: {e}"[:300]
        log.warning("Memory (MemDream) disabled: %s", state["error"])
    finally:
        _ready.set()


async def _seed_eval_fixtures():
    existing = {m.content for m in await _mem.list(limit=50, user_id=EVAL_USER)}
    for content, kind in EVAL_FIXTURES:
        if content not in existing:
            await _mem.create(content, memory_type=kind, importance=0.8, user_id=EVAL_USER)


async def close():
    if _mem is not None:
        await _mem.close()


def _user() -> str:
    return EVAL_USER if SANDBOX.get() else USER


# ---------------------------------------------------------------- recall (read)

async def recall(query: str, limit: int = RECALL_LIMIT) -> list[dict]:
    """Memories relevant to the question. Returns [] if memory is off, slow or failing (never blocks a question)."""
    if not state["enabled"]:
        return []
    try:
        found = await asyncio.wait_for(
            _mem.search(query[:1000], limit=limit, min_score=RECALL_MIN_SCORE, user_id=_user()), RECALL_TIMEOUT_S)
        return [{"id": m.memory_id, "content": m.content, "type": m.memory_type, "score": round(m.score or 0, 3)}
                for m in found]
    except Exception as e:
        log.warning("Memory recall failed: %s", e)
        return []


def as_context(memories: list[dict]) -> str:
    return "\n".join(f"- {m['content']}" for m in memories)


# ---------------------------------------------------------------- remember / manage (writes: only on Mamlesh's click)

async def remember(text: str) -> dict:
    """Store one fact. MemDream decides ADD / SUPERSEDE / MERGE / NOOP against what is already known."""
    if not state["enabled"]:
        raise RuntimeError(f"Memory is not available: {state['error'] or 'starting'}")
    r = await _mem.add(text, raw=True, user_id=_user())
    return {"action": r.action, "memory_id": r.memory_id, "superseded": r.superseded_memory_ids,
            "merged": r.merged_memory_ids}


def _record(m) -> dict:
    return {"id": m.memory_id, "content": m.content, "type": m.memory_type, "status": m.status,
            "importance": m.importance, "confidence": m.confidence,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "superseded_by": m.superseded_by, "merged_into": m.merged_into}


async def overview(query: str = "", limit: int = 100) -> dict:
    """For the Memory tab: memories (all or matching a search), recent decisions and counts."""
    if not state["enabled"]:
        return {"enabled": False, "error": state["error"]}
    if query:
        rows = list(await _mem.search(query, limit=limit, user_id=USER))
    else:
        rows = await _mem.list(limit=limit, status=["active", "superseded"], user_id=USER)
    audit = await _mem.audit(limit=25, user_id=USER)
    stats = await _mem.stats(user_id=USER)
    return {"enabled": True, "memories": [_record(m) for m in rows], "audit": audit, "stats": stats,
            "types": PERSONAL_TYPES}


async def history(memory_id: str) -> list[dict]:
    return [_record(m) for m in await _mem.history(memory_id, user_id=USER)]


async def forget(memory_id: str) -> dict:
    """Reversible: the memory stops being recalled but stays in the history."""
    return await _mem.forget(memory_id, user_id=USER)
