"""Healthcare tools: Mamlesh's own health log and goals, stored in MongoDB (there is no external health system).

Collections:
  health_entries  {_id, type, value, unit, details, date (YYYY-MM-DD), created_at}
  health_goals    {_id: metric, metric, start, target, unit, start_date, deadline}
"""
import json
import secrets
from datetime import date as Date, datetime, timedelta, timezone

from langchain_core.tools import tool

from services import db as database
from utils.env import UTC_OFFSET_MINUTES

# Weight is just an entry with type "weight"; these are other common types (any other type is allowed too).
ENTRY_TYPES = ("weight", "steps", "sleep", "water", "calories", "workout", "meal", "blood_pressure",
               "heart_rate", "body_fat", "waist", "mood", "symptom", "medication", "note")


def _today() -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=UTC_OFFSET_MINUTES)).strftime("%Y-%m-%d")


def _date(value: str) -> str:
    """Accept YYYY-MM-DD (or empty for today)."""
    if not value:
        return _today()
    return Date.fromisoformat(value.strip()[:10]).isoformat()


def _db():
    if database.db is None:
        raise RuntimeError("MongoDB is not connected, so health data can't be saved.")
    return database.db


async def _add(entry_type: str, value, unit: str, details: str, date: str) -> dict:
    entry = {
        "_id": secrets.token_hex(4),
        "type": entry_type.strip().lower().replace(" ", "_"),
        "value": value,
        "unit": unit,
        "details": details,
        "date": _date(date),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await _db().health_entries.insert_one(entry)
    return entry


# ---------- progress maths ----------

async def goal_progress(goal: dict) -> dict:
    """How far along a numeric goal is, based on the logged entries of that metric."""
    rows = await _db().health_entries.find({"type": goal["metric"], "value": {"$ne": None}}).sort("date", 1).to_list(2000)
    current = rows[-1]["value"] if rows else goal["start"]
    total = goal["start"] - goal["target"]          # e.g. 92 - 80 = 12 kg to lose
    done = goal["start"] - current
    out = {
        "metric": goal["metric"], "unit": goal.get("unit", ""), "start": goal["start"], "target": goal["target"],
        "current": current, "start_date": goal.get("start_date"), "deadline": goal.get("deadline") or None,
        "change_so_far": round(current - goal["start"], 2) + 0.0, "remaining": round(current - goal["target"], 2) + 0.0,
        "percent_done": round(done / total * 100, 1) if total else None,
        "entries": len(rows),
    }
    # Weekly rate from the last 30 days (needs at least 2 entries a few days apart)
    recent = [r for r in rows if r["date"] >= (Date.fromisoformat(_today()) - timedelta(days=30)).isoformat()]
    if len(recent) >= 2:
        days = (Date.fromisoformat(recent[-1]["date"]) - Date.fromisoformat(recent[0]["date"])).days
        if days >= 3:
            per_week = (recent[-1]["value"] - recent[0]["value"]) / days * 7
            out["rate_per_week_last_30_days"] = round(per_week, 2)
            if per_week and (goal["target"] - current) / per_week > 0:
                weeks = (goal["target"] - current) / per_week
                out["estimated_finish"] = (Date.fromisoformat(recent[-1]["date"]) + timedelta(weeks=weeks)).isoformat()
    if out["deadline"] and out["remaining"]:
        weeks_left = (Date.fromisoformat(out["deadline"]) - Date.fromisoformat(_today())).days / 7
        if weeks_left > 0:
            out["needed_per_week_to_hit_deadline"] = round(-out["remaining"] / weeks_left, 2)
    return out


async def overview(days: int = 30) -> dict:
    """Everything the UI and the agent need: goals with progress, the weight series and recent entries."""
    db = _db()
    since = (Date.fromisoformat(_today()) - timedelta(days=days)).isoformat()
    goals = [await goal_progress(g) for g in await db.health_goals.find().to_list(50)]
    weights = await db.health_entries.find({"type": "weight"}, {"_id": 0, "date": 1, "value": 1}).sort("date", 1).to_list(2000)
    recent = await db.health_entries.find({"date": {"$gte": since}}).sort([("date", -1), ("created_at", -1)]).to_list(200)
    latest = {}
    for e in recent:
        latest.setdefault(e["type"], e)
    return {"today": _today(), "goals": goals, "weights": weights, "latest_by_type": latest,
            "recent_entries": [{**e, "id": e.pop("_id")} for e in recent[:60]]}


# ---------- tools ----------

@tool
async def log_weight(kg: float, date: str = "", note: str = "") -> str:
    """Log Mamlesh's body weight in kg. date: YYYY-MM-DD, empty = today."""
    entry = await _add("weight", float(kg), "kg", note, date)
    goal = await _db().health_goals.find_one({"_id": "weight"})
    reply = {"saved": {"id": entry["_id"], "weight_kg": kg, "date": entry["date"]}}
    if goal:
        reply["goal_progress"] = await goal_progress(goal)
    return json.dumps(reply)


@tool
async def log_health(entry_type: str, value: float | None = None, unit: str = "", details: str = "", date: str = "") -> str:
    """Log any health data for Mamlesh. entry_type: steps, sleep (hours), water (litres), calories, workout, meal,
    blood_pressure (put '120/80' in details), heart_rate, body_fat, waist, mood, symptom, medication, note - or any
    other short name. value: the number if there is one. details: free text (what, how, how much). date: YYYY-MM-DD, empty = today."""
    entry = await _add(entry_type, value, unit, details, date)
    return json.dumps({"saved": {"id": entry["_id"], "type": entry["type"], "value": value, "unit": unit,
                                 "details": details, "date": entry["date"]}})


@tool
async def set_health_goal(metric: str, target: float, start: float | None = None, unit: str = "", deadline: str = "") -> str:
    """Create or update a numeric health goal, e.g. metric='weight', start=92, target=80, unit='kg'.
    start defaults to the latest logged value. deadline: YYYY-MM-DD (optional)."""
    metric = metric.strip().lower()
    if start is None:
        last = await _db().health_entries.find({"type": metric, "value": {"$ne": None}}).sort("date", -1).to_list(1)
        if not last:
            return f"No {metric} logged yet, so give the starting value."
        start = last[0]["value"]
    goal = {"_id": metric, "metric": metric, "start": float(start), "target": float(target), "unit": unit,
            "start_date": _today(), "deadline": _date(deadline) if deadline else ""}
    await _db().health_goals.replace_one({"_id": metric}, goal, upsert=True)
    return json.dumps({"goal_saved": goal, "progress": await goal_progress(goal)}, default=str)


@tool
async def health_summary(days: int = 30) -> str:
    """Mamlesh's health overview: goals with progress (current, remaining, % done, weekly rate, estimated finish),
    the latest value of each kind of entry, and the weight history."""
    o = await overview(days)
    o.pop("recent_entries")
    return json.dumps(o, default=str)


@tool
async def health_history(entry_type: str = "", days: int = 30) -> str:
    """List Mamlesh's health entries (newest first), optionally only one entry_type (e.g. 'weight', 'workout').
    Each entry has an id that delete_health_entry can use."""
    query = {"date": {"$gte": (Date.fromisoformat(_today()) - timedelta(days=days)).isoformat()}}
    if entry_type:
        query["type"] = entry_type.strip().lower().replace(" ", "_")
    rows = await _db().health_entries.find(query).sort([("date", -1), ("created_at", -1)]).to_list(300)
    return json.dumps([{"id": r["_id"], **{k: r[k] for k in ("type", "value", "unit", "details", "date")}} for r in rows])


@tool
async def delete_health_entry(entry_id: str) -> str:
    """Delete one wrong health entry by its id (from health_history). Only when Mamlesh asks to remove/correct it."""
    result = await _db().health_entries.delete_one({"_id": entry_id})
    return "Deleted." if result.deleted_count else f"No entry with id {entry_id}."
