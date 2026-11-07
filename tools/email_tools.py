"""Email tools for the Conversation agent (Gmail).

The agent can only DRAFT. The draft shows up in the chat with Send / Discard buttons, and is sent only when
Mamlesh clicks Send (see services/mailer.py). This keeps prompt-injected text from ever sending email.
"""
import json

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from services import mailer
from services.events import emit


@tool
async def draft_email(to: str, subject: str, body: str, config: RunnableConfig) -> str:
    """Prepare an email from Mamlesh's Gmail. It is NOT sent: it appears in the chat for Mamlesh to review,
    edit and click Send. to: one or more addresses separated by commas. body: plain text, paragraphs separated
    by a blank line, signed off as Mamlesh."""
    try:
        draft = await mailer.create_draft(to, subject, body, run_id=(config.get("configurable") or {}).get("run_id", ""))
    except ValueError as e:
        return f"Could not create the draft: {e}"
    run_id = draft["run_id"]
    if run_id:
        await emit(run_id, "email.draft", draft={k: draft[k] for k in ("_id", "to", "subject", "body", "status")})
    return (f"Draft {draft['_id']} is ready in the chat for Mamlesh to review. It has NOT been sent - "
            "Mamlesh sends it with the Send button.")


@tool
async def email_history(limit: int = 15) -> str:
    """Emails actually sent from Mamlesh's Gmail by this app (newest first): to, subject, sent ok or error, time."""
    return json.dumps(await mailer.sent_log(limit))
