"""Mamlesh AI OS. Run with:  python main.py   then open http://127.0.0.1:8000"""
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from api.routes import router
from services import auth, db, run_service
from utils.env import HOST, OPENAI_API_KEY, PORT, ROOT_DIR
from utils.logger import get_logger

log = get_logger("main")
UI_DIR = ROOT_DIR / "ui"

# Reachable without logging in. Everything else needs the login cookie.
PUBLIC_PATHS = {"/login", "/api/login", "/style.css", "/healthz"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is missing in .env")
    await db.connect()
    await run_service.startup()
    log.info("Open http://%s:%d", HOST, PORT)
    yield
    from mcp_servers import client as mcp_client
    await mcp_client.close_all()  # stop the MCP server processes and sessions


app = FastAPI(title="Mamlesh AI OS", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def require_login(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS or auth.is_valid(request.cookies.get(auth.COOKIE)):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            # UI files: browsers must check for a newer version (cheap 304 if unchanged), so deploys show up at once
            response.headers["Cache-Control"] = "no-cache"
        return response
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "Not logged in"}, status_code=401)
    return RedirectResponse("/login")


@app.get("/login")
def login_page(request: Request):
    if auth.is_valid(request.cookies.get(auth.COOKIE)):
        return RedirectResponse("/")
    return FileResponse(UI_DIR / "login.html")


@app.get("/observability")
def observability_page():
    """Observability, evals and prompt versions on their own page."""
    return FileResponse(UI_DIR / "harness.html")


@app.get("/healthz")
def healthz():
    """Public uptime check for Render (shows nothing private)."""
    return {"ok": True}


app.include_router(router)
app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
