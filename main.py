"""Mamlesh AI OS. Run with:  python main.py   then open http://127.0.0.1:8000"""
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.routes import router
from services import db, run_service
from utils.env import HOST, OPENAI_API_KEY, PORT, ROOT_DIR
from utils.logger import get_logger

log = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is missing in .env")
    await db.connect()
    await run_service.startup()
    log.info("Open http://%s:%d", HOST, PORT)
    yield


app = FastAPI(title="Mamlesh AI OS", lifespan=lifespan)
app.include_router(router)
app.mount("/", StaticFiles(directory=ROOT_DIR / "ui", html=True), name="ui")

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
