"""Conversation management: what earlier turns the Orchestrator sees, chat titles, and facts worth remembering.

- Context: the last KEEP_TURNS turns verbatim + a short rolling summary of everything older (instead of
  resending the last 6 turns in full). The summary is updated in the background when a turn drops out of
  the window, so it never adds to the answer time.
- Titles: after the first answer, a 3-6 word title replaces the first 60 characters of the question.
- Memory: when a message looks like it states a lasting fact about Mamlesh ("my sister's email is...",
  "I moved to Pune"), the facts are offered as "Remember this?" cards. Nothing is saved until Mamlesh clicks
  Save (that click is the approval), and it goes to the Brain knowledge base.

All three run after the answer is shown, with small gpt-4.1-mini calls. Their cost is kept per chat
("background_cost") and shown on the Observability page.
"""
import asyncio
import re
import uuid

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from services import db as database
from services.events import emit
from utils.cost import llm_cost
from utils.env import OPENAI_MODEL
from utils.logger import get_logger

log = get_logger(__name__)

KEEP_TURNS = 3          # turns sent word for word; older ones live in the summary
ANSWER_CHARS = 700      # each earlier answer is cut to this
SUMMARY_WORDS = 120

_llm = None


def _model():
    global _llm
    _llm = _llm or ChatOpenAI(model=OPENAI_MODEL, temperature=0)
    return _llm


async def _ask(messages, schema=None) -> tuple:
    """One small LLM call. Returns (result, cost)."""
    llm = _model().with_structured_output(schema, include_raw=True) if schema else _model()
    out = await llm.ainvoke(messages)
    raw = out["raw"] if schema else out
    u = getattr(raw, "usage_metadata", None) or {}
    cost = llm_cost(OPENAI_MODEL, u.get("input_tokens", 0), (u.get("input_token_details") or {}).get("cache_read", 0) or 0,
                    u.get("output_tokens", 0))
    return (out["parsed"] if schema else raw.content), cost


def _turn(t: dict) -> str:
    answer = t.get("answer") or ""
    if len(answer) > ANSWER_CHARS:
        answer = answer[:ANSWER_CHARS] + " …"
    return f"User: {t['query']}\nAssistant: {answer}"


# ---------------------------------------------------------------- context for the next question

async def history(chat_id: str) -> str:
    """What the Orchestrator sees of this chat: the rolling summary + the last few turns."""
    db = database.db
    if db is None:
        return ""
    chat = await db.chats.find_one({"_id": chat_id}, {"summary": 1}) or {}
    turns = await db.runs.find({"chat_id": chat_id, "status": "done"}, {"query": 1, "answer": 1}) \
        .sort("started_at", -1).limit(KEEP_TURNS).to_list(KEEP_TURNS)
    parts = []
    if chat.get("summary"):
        parts.append(f"Summary of the earlier conversation: {chat['summary']}")
    parts += [_turn(t) for t in reversed(turns)]
    return "\n\n".join(parts)


# ---------------------------------------------------------------- after each answer

class Facts(BaseModel):
    facts: list[str] = Field(default_factory=list, description="Lasting facts about Mamlesh, each one short sentence")


# Cheap filter before any LLM call: only messages that talk about Mamlesh's own life/details.
_FACT_HINT = re.compile(r"(?i)\b(my|i am|i'm|i've|i have|i live|i moved|i work|i joined|i started|i prefer|i like|"
                        r"i don't|i do not|i usually|remember)\b")
_ASKING = re.compile(r"(?i)^\s*(what|how|which|when|where|who|why|show|list|tell me|can you|could you|is|are|do|does)\b")

FACTS_PROMPT = """Extract lasting personal facts that Mamlesh states about themselves or their own life in this message, worth
remembering for future conversations: contact details of people, family, where Mamlesh lives or works, preferences,
routines, goals, important dates. Ignore questions, one-off requests, temporary states ("I'm tired"), health
measurements (logged elsewhere) and anything already obvious from the request itself. Most messages have none:
return an empty list then. Write each fact as one short sentence in the third person ("Mamlesh's sister Priya's email is ...")."""


async def after_run(chat_id: str, run_id: str, query: str, planned: list[str]):
    """Titles, rolling summary and memory suggestions. Never raises (it runs in the background)."""
    db = database.db
    if db is None:
        return
    cost = 0.0
    try:
        chat = await db.chats.find_one({"_id": chat_id}) or {}
        done = await db.runs.count_documents({"chat_id": chat_id, "status": "done"})

        if done == 1 and not chat.get("titled"):
            title, c = await _ask([("system", "Write a 3-6 word title for a chat that starts with this message. "
                                              "No quotes, no full stop."), ("user", query[:500])])
            cost += c
            title = title.strip().strip('"').strip(".")[:60] or query[:60]
            await db.chats.update_one({"_id": chat_id}, {"$set": {"title": title, "titled": True}})
            await emit("system", "chat.title", chat_id=chat_id, title=title)

        summarized = chat.get("summarized_turns", 0)
        older = done - KEEP_TURNS  # turns that are no longer sent word for word
        if older > summarized:
            turns = await db.runs.find({"chat_id": chat_id, "status": "done"}, {"query": 1, "answer": 1}) \
                .sort("started_at", 1).skip(summarized).limit(older - summarized).to_list(50)
            prompt = (f"Update the running summary of a conversation between Mamlesh and their AI assistant.\n"
                      f"Keep names, numbers, decisions and open questions that later messages may refer to. "
                      f"At most {SUMMARY_WORDS} words. Return only the summary.\n\n"
                      f"Summary so far: {chat.get('summary') or '(none)'}\n\nNew turns:\n" +
                      "\n\n".join(_turn(t) for t in turns))
            summary, c = await _ask([("user", prompt)])
            cost += c
            await db.chats.update_one({"_id": chat_id}, {"$set": {"summary": summary.strip(), "summarized_turns": older}})

        if "brain" not in planned and _FACT_HINT.search(query) and not _ASKING.search(query):
            found, c = await _ask([("system", FACTS_PROMPT), ("user", query[:2000])], Facts)
            cost += c
            facts = [f.strip() for f in found.facts if f.strip()][:3]
            if facts:
                suggestions = [{"id": uuid.uuid4().hex[:8], "text": f, "status": "pending"} for f in facts]
                await db.runs.update_one({"_id": run_id}, {"$set": {"memory": suggestions}})
                await emit(run_id, "memory.suggest", suggestions=suggestions)
    except Exception as e:
        log.warning("Conversation housekeeping failed for chat %s: %s", chat_id, e)
    if cost:
        await db.chats.update_one({"_id": chat_id}, {"$inc": {"background_cost": cost}})


# ---------------------------------------------------------------- memory cards

async def decide_memory(run_id: str, suggestion_id: str, save: bool, text: str | None = None) -> str:
    """Mamlesh clicked Save or Dismiss on a "Remember this?" card. Save writes it to the Brain."""
    from tools.brain_tools import kb_add

    db = database.db
    run = await db.runs.find_one({"_id": run_id}, {"memory": 1}) or {}
    item = next((m for m in run.get("memory", []) if m["id"] == suggestion_id), None)
    if not item or item["status"] != "pending":
        raise ValueError("This suggestion was already handled.")
    status = "dismissed"
    if save:
        fact = (text or item["text"]).strip()
        # The click is the approval, so call the tool's own function (not the approval wrapper).
        save_fn = getattr(kb_add.coroutine, "__wrapped__", kb_add.coroutine)
        await save_fn(text=fact)
        item["text"], status = fact, "saved"
    await db.runs.update_one({"_id": run_id, "memory.id": suggestion_id},
                             {"$set": {"memory.$.status": status, "memory.$.text": item["text"]}})
    return status


# ---------------------------------------------------------------- chat management

async def delete_chat(chat_id: str) -> dict:
    """Delete a chat with its messages, drafts, approvals and traces."""
    db = database.db
    run_ids = [r["_id"] for r in await db.runs.find({"chat_id": chat_id}, {"_id": 1}).to_list(5000)]
    out = await asyncio.gather(
        db.runs.delete_many({"chat_id": chat_id}),
        db.chats.delete_one({"_id": chat_id}),
        db.spans.delete_many({"trace_id": {"$in": run_ids}}),
        db.events.delete_many({"run_id": {"$in": run_ids}}),
        db.approvals.delete_many({"run_id": {"$in": run_ids}}),
        db.email_drafts.delete_many({"run_id": {"$in": run_ids}, "status": {"$ne": "sent"}}),
    )
    return {"messages": out[0].deleted_count}
