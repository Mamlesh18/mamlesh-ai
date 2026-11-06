"""Brain knowledge base (RAG with FAISS).

Source of truth = text files:
  kb/*.md, kb/*.txt      - your knowledge files (e.g. kb/memories.md). kb_add appends to kb/notes.md
  /etc/secrets/*.md      - same, on Render (uploaded as Secret Files, since kb/ is not in git)
  memory/*.md            - daily notes written by the Personal agent

Built from those files (rebuilt automatically when any file changes):
  data/kb.faiss          - FAISS vector index
  data/kb.json           - the text chunks + a fingerprint of the source files
"""
import hashlib
import json
import re
from datetime import datetime

import faiss
import numpy as np
from langchain_core.tools import tool
from langchain_openai import OpenAIEmbeddings

from utils.env import DATA_DIR, EMBEDDING_MODEL, KB_DIR, KB_SECRET_DIR, MEMORY_DIR
from utils.logger import get_logger

log = get_logger(__name__)

INDEX_FILE = DATA_DIR / "kb.faiss"
CHUNKS_FILE = DATA_DIR / "kb.json"
NOTES_FILE = KB_DIR / "notes.md"
MAX_CHUNK = 1500  # characters

_embedder = OpenAIEmbeddings(model=EMBEDDING_MODEL)
_index = None
_chunks: list[dict] = []  # [{"source": "kb/memories.md", "text": "..."}]
_fingerprint = None


def _source_files():
    files = []
    for folder in (KB_DIR, KB_SECRET_DIR, MEMORY_DIR):
        if folder.is_dir():
            files += [*folder.glob("*.md"), *folder.glob("*.txt")]
    return sorted(files)


def _files_fingerprint() -> str:
    h = hashlib.sha256()
    for f in _source_files():
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def _split(text: str, source: str) -> list[dict]:
    """Split markdown on headings, keeping the heading path, then cap each chunk's size."""
    chunks, headings, buf = [], {}, []

    def flush():
        body = "\n".join(buf).strip()
        if body:
            title = " > ".join(headings[k] for k in sorted(headings))
            for i in range(0, len(body), MAX_CHUNK):
                chunks.append({"source": source, "text": f"{title}\n{body[i:i + MAX_CHUNK]}".strip()})
        buf.clear()

    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            flush()
            level = len(m.group(1))
            headings = {k: v for k, v in headings.items() if k < level}
            headings[level] = m.group(2).strip()
        else:
            buf.append(line)
    flush()
    return chunks


def _embed(texts: list[str]) -> np.ndarray:
    vectors = np.array(_embedder.embed_documents(texts), dtype="float32")
    faiss.normalize_L2(vectors)  # normalised + inner product = cosine similarity
    return vectors


def sync():
    """Load the index, rebuilding it first if kb/ or memory/ changed."""
    global _index, _chunks, _fingerprint
    current = _files_fingerprint()
    if current == _fingerprint:
        return
    if INDEX_FILE.exists() and CHUNKS_FILE.exists():
        saved = json.loads(CHUNKS_FILE.read_text(encoding="utf-8"))
        if saved.get("fingerprint") == current:
            _index, _chunks, _fingerprint = faiss.read_index(str(INDEX_FILE)), saved["chunks"], current
            log.info("Brain loaded: %d chunks", len(_chunks))
            return

    chunks = []
    if not _source_files():
        log.warning("Brain: no knowledge files found in %s", ", ".join(str(d) for d in (KB_DIR, KB_SECRET_DIR, MEMORY_DIR)))
    for f in _source_files():
        chunks += _split(f.read_text(encoding="utf-8"), f"{f.parent.name}/{f.name}")
    if not chunks:
        _index, _chunks, _fingerprint = None, [], current
        return
    vectors = _embed([c["text"] for c in chunks])
    _index = faiss.IndexFlatIP(vectors.shape[1])
    _index.add(vectors)
    _chunks, _fingerprint = chunks, current
    faiss.write_index(_index, str(INDEX_FILE))
    CHUNKS_FILE.write_text(json.dumps({"fingerprint": current, "chunks": chunks}, indent=1), encoding="utf-8")
    log.info("Brain rebuilt: %d chunks from %d files", len(chunks), len(_source_files()))


def status() -> dict:
    return {
        "chunks": len(_chunks),
        "files": [str(f) for f in _source_files()],
        "folders_checked": {str(d): d.is_dir() for d in (KB_DIR, KB_SECRET_DIR, MEMORY_DIR)},
    }


@tool
def kb_search(query: str, k: int = 5) -> str:
    """Search Mamlesh's knowledge base and daily notes for information relevant to the query."""
    sync()
    if _index is None:
        return "The knowledge base is empty."
    scores, ids = _index.search(_embed([query]), min(k, len(_chunks)))
    hits = [f"[{_chunks[i]['source']} | score {s:.2f}]\n{_chunks[i]['text']}" for s, i in zip(scores[0], ids[0]) if i != -1]
    return "\n\n---\n\n".join(hits) or "No relevant notes found."


@tool
def kb_add(text: str) -> str:
    """Save a new fact or note about Mamlesh into the knowledge base (kb/notes.md)."""
    if not NOTES_FILE.exists():
        NOTES_FILE.write_text("# Notes\n", encoding="utf-8")
    with NOTES_FILE.open("a", encoding="utf-8") as f:
        f.write(f"\n## {datetime.now():%Y-%m-%d %H:%M}\n{text.strip()}\n")
    sync()
    return "Saved to kb/notes.md and re-indexed."
