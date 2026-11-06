"""Keeps the Brain's knowledge files (kb/*.md, kb/*.txt) in MongoDB, so a server with no kb/ folder
(e.g. Render, since kb/ is not in git) still has them.

  On startup:  files that are missing on disk are downloaded from MongoDB (local files are never overwritten).
  kb_add:      kb/notes.md is uploaded after every new note.

Upload your local kb/ files once (and again after editing them):
    python -m services.kb_store upload
"""
import asyncio
from datetime import datetime, timezone
from pathlib import Path

from services import db as database
from utils.env import KB_DIR
from utils.logger import get_logger

log = get_logger(__name__)


async def pull_missing():
    """Download knowledge files that exist in MongoDB but not on disk."""
    if database.db is None:
        return
    async for doc in database.db.kb_files.find():
        path = KB_DIR / doc["_id"]
        if not path.exists():
            path.write_text(doc["content"], encoding="utf-8")
            log.info("Brain: downloaded %s from MongoDB", doc["_id"])


async def push(path: Path):
    """Upload one knowledge file to MongoDB (replaces the stored copy)."""
    if database.db is None:
        return
    await database.db.kb_files.replace_one(
        {"_id": path.name},
        {"_id": path.name, "content": path.read_text(encoding="utf-8"), "updated_at": datetime.now(timezone.utc)},
        upsert=True,
    )


async def _upload_all():
    await database.connect()
    if database.db is None:
        print("MongoDB is not reachable. Check MONGODB_URL in .env")
        return
    files = sorted([*KB_DIR.glob("*.md"), *KB_DIR.glob("*.txt")])
    for f in files:
        await push(f)
        print(f"uploaded {f.name} ({f.stat().st_size:,} bytes)")
    print(f"done: {len(files)} file(s) in MongoDB collection 'kb_files'")


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["upload"]:
        asyncio.run(_upload_all())
    else:
        print(__doc__)
