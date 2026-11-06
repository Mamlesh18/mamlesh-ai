"""MongoDB connection. If MongoDB is not reachable, the app still runs without saving history."""
from pymongo import AsyncMongoClient

from utils.env import MONGODB_DB, MONGODB_URL
from utils.logger import get_logger

log = get_logger(__name__)

db = None  # set by connect()


async def connect():
    global db
    if not MONGODB_URL:
        log.warning("MONGODB_URL not set. History will not be saved.")
        return
    try:
        client = AsyncMongoClient(MONGODB_URL, serverSelectionTimeoutMS=5000)
        await client.admin.command("ping")
        db = client[MONGODB_DB]
        await db.events.create_index([("run_id", 1), ("ts", 1)])
        await db.events.create_index([("server", 1), ("type", 1), ("ts", -1)])
        log.info("Connected to MongoDB database '%s'", MONGODB_DB)
    except Exception as e:
        log.warning("Could not connect to MongoDB (%s). History will not be saved.", e)
