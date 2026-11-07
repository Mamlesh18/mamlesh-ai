"""OAuth login for remote MCP servers that use the standard MCP authorization flow (e.g. Upstox).

How it works:
  1. Discovery: the MCP server says where its OAuth server is (/.well-known/oauth-protected-resource),
     and the OAuth server lists its endpoints (/.well-known/oauth-authorization-server).
  2. Registration: we register this app with the OAuth server (/register) for our callback URL.
     No API key or secret is needed.
  3. Login: the user opens the authorize URL (with PKCE), logs in on the provider's own page,
     and is sent back to /api/oauth/callback with a one-time code.
  4. Tokens: we swap the code for an access token (+ refresh token) and keep them in MongoDB.
     Expired tokens are refreshed automatically. If refreshing fails, the server shows "auth_required"
     in the UI and the user logs in again.
"""
import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode, urlparse

import httpx

from services import db as database
from utils.logger import get_logger

log = get_logger(__name__)

APP_NAME = "Mamlesh AI OS"


class OAuthServer:
    def __init__(self, key: str, mcp_url: str):
        self.key = key            # e.g. "finance/upstox"
        self.mcp_url = mcp_url    # e.g. "https://mcp.upstox.com/mcp"
        self.token: dict = {}     # access_token, refresh_token, expires_at
        self.clients: dict = {}   # redirect_uri -> client_id (from dynamic registration)
        self._meta: dict = {}
        self._loaded = False

    # ---------- storage (MongoDB collection "oauth") ----------

    async def load(self):
        if self._loaded:
            return
        self._loaded = True
        if database.db is not None:
            doc = await database.db.oauth.find_one({"_id": self.key}) or {}
            self.token, self.clients = doc.get("token", {}), doc.get("clients", {})

    async def _save(self):
        if database.db is not None:
            await database.db.oauth.replace_one(
                {"_id": self.key}, {"_id": self.key, "token": self.token, "clients": self.clients}, upsert=True)

    # ---------- discovery + registration ----------

    async def _metadata(self) -> dict:
        if self._meta:
            return self._meta
        u = urlparse(self.mcp_url)
        origin = f"{u.scheme}://{u.netloc}"
        async with httpx.AsyncClient(timeout=20) as client:
            resource = None
            for path in (f"/.well-known/oauth-protected-resource{u.path}", "/.well-known/oauth-protected-resource"):
                r = await client.get(origin + path)
                if r.status_code == 200:
                    resource = r.json()
                    break
            issuer = (resource or {}).get("authorization_servers", [origin])[0].rstrip("/")
            r = await client.get(f"{issuer}/.well-known/oauth-authorization-server")
            r.raise_for_status()
            self._meta = {**r.json(), "resource": (resource or {}).get("resource", self.mcp_url)}
        return self._meta

    async def _client_id(self, redirect_uri: str) -> str:
        if redirect_uri in self.clients:
            return self.clients[redirect_uri]
        meta = await self._metadata()
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(meta["registration_endpoint"], json={
                "client_name": APP_NAME,
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            })
            r.raise_for_status()
        self.clients[redirect_uri] = r.json()["client_id"]
        await self._save()
        log.info("OAuth %s: registered client for %s", self.key, redirect_uri)
        return self.clients[redirect_uri]

    # ---------- login ----------

    async def start(self, redirect_uri: str) -> tuple[str, str, dict]:
        """Returns (authorize_url, state, pending) - pending is kept until the callback arrives."""
        await self.load()
        meta = await self._metadata()
        client_id = await self._client_id(redirect_uri)
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(24)
        url = meta["authorization_endpoint"] + "?" + urlencode({
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            "resource": meta["resource"],
        })
        return url, state, {"verifier": verifier, "redirect_uri": redirect_uri, "client_id": client_id}

    async def finish(self, code: str, pending: dict):
        meta = await self._metadata()
        await self._token_request({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": pending["redirect_uri"],
            "client_id": pending["client_id"],
            "code_verifier": pending["verifier"],
            "resource": meta["resource"],
        })
        self.token["client_id"] = pending["client_id"]
        await self._save()
        log.info("OAuth %s: logged in", self.key)

    # ---------- tokens ----------

    async def _token_request(self, data: dict):
        meta = await self._metadata()
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(meta["token_endpoint"], data=data, headers={"Accept": "application/json"})
            r.raise_for_status()
            t = r.json()
        self.token.update({
            "access_token": t["access_token"],
            "refresh_token": t.get("refresh_token", self.token.get("refresh_token")),
            "expires_at": time.time() + int(t.get("expires_in", 86400)),
        })

    async def refresh(self) -> bool:
        if not self.token.get("refresh_token"):
            return False
        try:
            meta = await self._metadata()
            await self._token_request({
                "grant_type": "refresh_token",
                "refresh_token": self.token["refresh_token"],
                "client_id": self.token.get("client_id", ""),
                "resource": meta["resource"],
            })
            await self._save()
            log.info("OAuth %s: token refreshed", self.key)
            return True
        except Exception as e:
            log.warning("OAuth %s: refresh failed (%s)", self.key, e)
            return False

    async def access_token(self) -> str | None:
        """A valid access token, refreshing it first if it has expired. None means: log in again."""
        await self.load()
        if not self.token.get("access_token"):
            return None
        if self.token.get("expires_at", 0) < time.time() + 60 and not await self.refresh():
            return None
        return self.token["access_token"]

    async def logout(self):
        self.token = {}
        await self._save()


class BearerAuth(httpx.Auth):
    """Adds the current access token to every MCP request; on a 401 it refreshes once and retries."""

    def __init__(self, server: OAuthServer):
        self.server = server

    async def async_auth_flow(self, request):
        token = await self.server.access_token()
        if token:
            request.headers["Authorization"] = f"Bearer {token}"
        response = yield request
        if response.status_code == 401 and await self.server.refresh():
            request.headers["Authorization"] = f"Bearer {self.server.token['access_token']}"
            yield request


# All OAuth servers by key ("domain/server"), and logins waiting for their callback (by state).
SERVERS: dict[str, OAuthServer] = {}
PENDING: dict[str, dict] = {}


def get_server(key: str, mcp_url: str) -> OAuthServer:
    if key not in SERVERS:
        SERVERS[key] = OAuthServer(key, mcp_url)
    return SERVERS[key]
