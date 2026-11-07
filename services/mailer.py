"""Sending email through Gmail SMTP with an app password, and the draft -> approve -> send flow.

The agent can only create DRAFTS (tools/email_tools.py). A draft is sent only when Mamlesh clicks Send in the
chat, which calls send_draft() through the API. This protects against prompt injection: text in a web page or
email can make an agent write a draft, but never send one.

MongoDB collections:
  email_drafts  {_id, run_id, to, subject, body, status: pending|sent|failed|discarded, created_at, sent_at, error}
  email_log     {to, subject, sent, error, sent_at, draft_id}   - every send attempt
"""
import asyncio
import html
import re
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from services import db as database
from utils.env import EMAIL_FROM_NAME, EMAIL_SENDS_PER_DAY, GMAIL_ADDRESS, GMAIL_APP_PASSWORD
from utils.logger import get_logger

log = get_logger(__name__)

EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def valid_recipients(to: str) -> list[str]:
    """'a@x.com, b@y.com' -> ['a@x.com', 'b@y.com']; raises ValueError if any address looks wrong."""
    addresses = [a.strip() for a in re.split(r"[,;]", to) if a.strip()]
    if not addresses:
        raise ValueError("No recipient.")
    if len(addresses) > 10:
        raise ValueError("At most 10 recipients per email.")
    bad = [a for a in addresses if not EMAIL_RE.match(a)]
    if bad:
        raise ValueError(f"Not a valid email address: {', '.join(bad)}")
    return addresses


def _html(text: str) -> str:
    paragraphs = [html.escape(p).replace("\n", "<br>") for p in text.strip().split("\n\n")]
    return "".join(f'<p style="margin:0 0 14px;font:15px/1.5 Arial,sans-serif;color:#111">{p}</p>' for p in paragraphs)


def _send_sync(recipients: list[str], subject: str, body: str) -> tuple[bool, str | None]:
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        return False, "Email is not configured (EMAIL / APP_PASSWORD are empty in .env)"
    msg = MIMEMultipart("alternative")  # plain text + HTML: readable everywhere, better deliverability
    msg["From"] = formataddr((EMAIL_FROM_NAME, GMAIL_ADDRESS))
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))
    msg.attach(MIMEText(_html(body), "html", "utf-8"))
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as server:  # smtplib has no default timeout
            server.starttls()
            server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            server.send_message(msg)
        return True, None
    except smtplib.SMTPAuthenticationError:
        return False, "Gmail rejected the login: check EMAIL and APP_PASSWORD (it must be an app password)"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _db():
    if database.db is None:
        raise RuntimeError("MongoDB is not connected, so drafts can't be saved or sent.")
    return database.db


async def create_draft(to: str, subject: str, body: str, run_id: str = "") -> dict:
    valid_recipients(to)  # fail early so the agent can fix the address
    draft = {
        "_id": secrets.token_hex(5), "run_id": run_id, "to": to.strip(), "subject": subject.strip(),
        "body": body.strip(), "status": "pending", "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await _db().email_drafts.insert_one(draft)
    return draft


async def send_draft(draft_id: str, to: str, subject: str, body: str) -> dict:
    """Called only from the API when Mamlesh clicks Send. The edited fields from the chat card win."""
    db = _db()
    draft = await db.email_drafts.find_one({"_id": draft_id})
    if not draft:
        raise ValueError("Draft not found.")
    if draft["status"] == "sent":
        raise ValueError("This draft was already sent.")
    if draft["status"] == "discarded":
        raise ValueError("This draft was discarded.")
    recipients = valid_recipients(to)
    if not subject.strip() or not body.strip():
        raise ValueError("Subject and body can't be empty.")

    since = datetime.now(timezone.utc) - timedelta(days=1)
    if await db.email_log.count_documents({"sent": True, "sent_at": {"$gte": since}}) >= EMAIL_SENDS_PER_DAY:
        raise ValueError(f"Daily limit reached ({EMAIL_SENDS_PER_DAY} emails in 24 hours). Nothing was sent.")

    sent, error = await asyncio.to_thread(_send_sync, recipients, subject.strip(), body.strip())
    now = datetime.now(timezone.utc)
    await db.email_log.insert_one({"to": ", ".join(recipients), "subject": subject.strip(), "sent": sent,
                                   "error": error, "sent_at": now, "draft_id": draft_id})
    update = {"to": ", ".join(recipients), "subject": subject.strip(), "body": body.strip(),
              "status": "sent" if sent else "failed", "error": error, "sent_at": now.isoformat()}
    await db.email_drafts.update_one({"_id": draft_id}, {"$set": update})
    log.info("Email %s to %s: %s", "sent" if sent else "FAILED", update["to"], error or "ok")
    return {**draft, **update}


async def discard_draft(draft_id: str) -> dict:
    db = _db()
    result = await db.email_drafts.find_one_and_update(
        {"_id": draft_id, "status": {"$in": ["pending", "failed"]}}, {"$set": {"status": "discarded"}}, return_document=True)
    if not result:
        raise ValueError("Draft not found or already sent.")
    return result


async def drafts_for_runs(run_ids: list[str]) -> list[dict]:
    if database.db is None or not run_ids:
        return []
    return await database.db.email_drafts.find({"run_id": {"$in": run_ids}}).sort("created_at", 1).to_list(500)


async def sent_log(limit: int = 20) -> list[dict]:
    rows = await _db().email_log.find({}, {"_id": 0}).sort("sent_at", -1).limit(limit).to_list(limit)
    return [{**r, "sent_at": r["sent_at"].isoformat()} for r in rows]
