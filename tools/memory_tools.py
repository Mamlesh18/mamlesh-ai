"""Personal memory tools for the Brain agent (MemDream, see harness/memory.py).

remember_personal is a write: like every write, it waits for Mamlesh's Approve click in the chat.
"""
import json

from langchain_core.tools import tool

from harness import memory


@tool
async def recall_personal(query: str) -> str:
    """Search Mamlesh's personal memory: people and their contact details, where Mamlesh lives and works,
    preferences, goals, important dates and constraints."""
    found = await memory.recall(query, limit=8)
    if not found:
        return "Nothing in personal memory matches this." if memory.state["enabled"] else \
            f"Personal memory is not available ({memory.state['error'] or 'starting'})."
    return json.dumps([{"fact": m["content"], "type": m["type"]} for m in found])


@tool
async def remember_personal(fact: str) -> str:
    """Save one personal fact about Mamlesh (a person and how to reach them, where Mamlesh lives or works,
    a preference, goal, important date or constraint). Write it in the third person, e.g.
    "Mamlesh's sister Priya's email is priya@example.com". Updates replace outdated facts automatically."""
    r = await memory.remember(fact)
    words = {"ADD": "Saved as a new memory", "SUPERSEDE": "Saved; it replaces an outdated memory",
             "MERGE": "Merged into an existing memory", "NOOP": "Already known; nothing changed"}
    return f"{words.get(r['action'], r['action'])}."
