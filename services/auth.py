"""Single-user login. Credentials come from .env (AUTH_EMAIL, AUTH_PASSWORD).

After a successful login the browser gets a signed cookie: "<expiry>.<signature>".
The signature is an HMAC of the expiry with SESSION_SECRET, so it can't be forged or extended.
"""
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

from utils.env import AUTH_EMAIL, AUTH_PASSWORD, SESSION_DAYS, SESSION_SECRET
from utils.logger import get_logger

log = get_logger(__name__)

COOKIE = "mamlesh_session"
_secret = SESSION_SECRET or secrets.token_urlsafe(48)
if not SESSION_SECRET:
    log.warning("SESSION_SECRET not set: using a random one, so logins reset on every restart.")
if not (AUTH_EMAIL and AUTH_PASSWORD):
    log.error("AUTH_EMAIL / AUTH_PASSWORD not set: nobody can log in.")

# Brute-force protection: max 5 failed attempts per IP in 15 minutes.
MAX_FAILS, WINDOW = 5, 15 * 60
_fails: dict[str, deque] = defaultdict(deque)


def _sign(value: str) -> str:
    return hmac.new(_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def create_token() -> str:
    expiry = str(int(time.time()) + SESSION_DAYS * 86400)
    return f"{expiry}.{_sign(expiry)}"


def is_valid(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expiry, sig = token.split(".", 1)
    return hmac.compare_digest(sig, _sign(expiry)) and expiry.isdigit() and int(expiry) > time.time()


def is_locked(ip: str) -> bool:
    attempts = _fails[ip]
    while attempts and attempts[0] < time.time() - WINDOW:
        attempts.popleft()
    return len(attempts) >= MAX_FAILS


def check_login(email: str, password: str, ip: str) -> bool:
    if not (AUTH_EMAIL and AUTH_PASSWORD):
        return False
    ok_email = hmac.compare_digest(email.strip().lower().encode(), AUTH_EMAIL.encode())
    ok_password = hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
    if ok_email and ok_password:
        _fails.pop(ip, None)
        return True
    _fails[ip].append(time.time())
    log.warning("Failed login from %s", ip)
    return False
