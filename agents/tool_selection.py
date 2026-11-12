"""Tool selection: an agent with many tools only shows the model the tools that fit its task.

Every tool's name, description and argument schema is sent on EVERY LLM call. The coding agent has ~65 tools
(~20k tokens) and the personal agent ~83 (~17k tokens), while a task usually needs two or three of them.

How: each tool's "name: description" is embedded once (text-embedding-3-small, kept in memory). For each task,
the task text is embedded and the `keep` closest tools are shown to the model, plus tools whose name appears
in the task and tools already used in this run. All tools stay registered, so nothing breaks if the model
asks for one by name. The eval test set checks that the right tools are still chosen.
"""
import hashlib

import numpy as np
from langchain.agents.middleware import AgentMiddleware
from langchain_openai import OpenAIEmbeddings

from utils.logger import get_logger

log = get_logger(__name__)

EMBED_MODEL = "text-embedding-3-small"
MIN_TOOLS = 16   # agents with fewer tools than this see all of them
KEEP = 12        # tools shown per task

_vectors: dict[str, np.ndarray] = {}  # sha of tool text -> unit vector
_embedder: OpenAIEmbeddings | None = None


def _key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _tool_text(tool) -> str:
    server = (getattr(tool, "metadata", None) or {}).get("server", "")  # e.g. "memory (daily notes)" helps matching
    return f"[{server}] {tool.name}: {tool.description or ''}"[:2000]


async def _embed(texts: list[str]) -> np.ndarray:
    global _embedder
    _embedder = _embedder or OpenAIEmbeddings(model=EMBED_MODEL)
    arr = np.array(await _embedder.aembed_documents(texts), dtype=np.float32)
    return arr / np.linalg.norm(arr, axis=1, keepdims=True)


async def warm(tools: list) -> None:
    """Embed tool descriptions that are not embedded yet (called at startup, so the first question is fast)."""
    texts = list({_tool_text(t) for t in tools})
    missing = [t for t in texts if _key(t) not in _vectors]
    if not missing:
        return
    for i in range(0, len(missing), 256):
        chunk = missing[i:i + 256]
        for text, vec in zip(chunk, await _embed(chunk)):
            _vectors[_key(text)] = vec
    log.info("Tool selection: embedded %d tool descriptions", len(missing))


def _task_text(messages) -> str:
    for m in messages:
        if getattr(m, "type", "") == "human":
            c = m.content
            return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


class ToolSelector(AgentMiddleware):
    """Shows the model only the tools that fit the task."""

    def __init__(self, domain: str, tools: list, keep: int = KEEP, always: set[str] = frozenset()):
        super().__init__()
        self.domain, self.keep = domain, keep
        self.tools = tools
        self.always = set(always)  # core tools of this agent, always shown
        self._chosen: dict[str, set[str]] = {}  # task -> chosen tool names (small cache: one entry per run)

    async def _choose(self, task: str) -> set[str]:
        if task in self._chosen:
            return self._chosen[task]
        await warm(self.tools)
        q = (await _embed([task[:4000]]))[0]
        scored = sorted(self.tools, key=lambda t: -float(_vectors[_key(_tool_text(t))] @ q))
        chosen = {t.name for t in scored[: self.keep]} | self.always
        low = task.lower()
        chosen |= {t.name for t in self.tools if t.name.lower() in low}  # named explicitly in the task
        if len(self._chosen) > 50:
            self._chosen.clear()
        self._chosen[task] = chosen
        return chosen

    async def awrap_model_call(self, request, handler):
        try:
            chosen = set(await self._choose(_task_text(request.messages)))
        except Exception as e:  # never block the agent: fall back to all tools
            log.warning("Tool selection failed for %s, using all tools: %s", self.domain, e)
            return await handler(request)
        for m in request.messages:  # tools already used in this run stay visible
            chosen |= {tc["name"] for tc in (getattr(m, "tool_calls", None) or [])}
        tools = [t for t in request.tools if getattr(t, "name", None) in chosen]
        return await handler(request.override(tools=tools))
