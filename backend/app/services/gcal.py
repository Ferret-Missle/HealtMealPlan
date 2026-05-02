import os
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from .. import models, security

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")


async def _get_access_token(user_id: str, db: Session) -> str:
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="google").first()
    if not token:
        raise ValueError("Google Calendar not connected")

    if token.expires_at and token.expires_at < datetime.utcnow() + timedelta(minutes=5):
        await _refresh_token(token, db)

    return security.decrypt(token.access_token)


async def _refresh_token(token: models.OAuthToken, db: Session):
    if not token.refresh_token:
        raise ValueError("No Google refresh token")
    refresh = security.decrypt(token.refresh_token)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": refresh,
            },
        )
    if resp.status_code != 200:
        raise ValueError(f"Google refresh failed: {resp.text}")

    data = resp.json()
    token.access_token = security.encrypt(data["access_token"])
    token.expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 3600))
    db.commit()


async def list_calendars(user_id: str, db: Session) -> list:
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    items = resp.json().get("items", [])
    return [
        {
            "id": c["id"],
            "summary": c.get("summary", ""),
            "primary": c.get("primary", False),
        }
        for c in items
    ]


_MEAL_KEYWORDS = ["外食", "ランチ", "ディナー", "夕食", "昼食", "朝食", "食事"]
_EXERCISE_KEYWORDS = ["筋トレ", "ジム", "ランニング", "ウォーキング", "ヨガ", "運動", "トレーニング"]


async def get_user_events(user_id: str, date: str, db: Session) -> list:
    """ユーザー自身のカレンダー予定を（タイトルそのまま）一覧で返す。ダッシュボード表示用。"""
    settings = (
        db.query(models.CalendarSetting)
        .filter_by(user_id=user_id, use_for_meal_plan=True)
        .all()
    )
    calendar_ids = [s.calendar_id for s in settings] if settings else ["primary"]

    access_token = await _get_access_token(user_id, db)
    time_min = f"{date}T00:00:00Z"
    time_max = f"{date}T23:59:59Z"

    events = []
    async with httpx.AsyncClient() as client:
        for cal_id in calendar_ids:
            resp = await client.get(
                f"https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events",
                headers={"Authorization": f"Bearer {access_token}"},
                params={
                    "timeMin": time_min,
                    "timeMax": time_max,
                    "singleEvents": "true",
                    "orderBy": "startTime",
                    "maxResults": 50,
                },
            )
            if resp.status_code != 200:
                continue
            for ev in resp.json().get("items", []):
                start_ev = ev.get("start", {})
                end_ev = ev.get("end", {})
                events.append({
                    "summary": ev.get("summary", "(無題)"),
                    "start": start_ev.get("dateTime", start_ev.get("date", "")),
                    "end": end_ev.get("dateTime", end_ev.get("date", "")),
                    "all_day": "date" in start_ev and "dateTime" not in start_ev,
                })

    return events


async def get_daily_events(user_id: str, date: str, db: Session) -> dict:
    """Fetch calendar events and categorize as meal/exercise. Strips titles/locations for privacy."""
    settings = (
        db.query(models.CalendarSetting)
        .filter_by(user_id=user_id, use_for_meal_plan=True)
        .all()
    )
    if not settings:
        return {"meal_events": [], "exercise_events": []}

    access_token = await _get_access_token(user_id, db)
    time_min = f"{date}T00:00:00Z"
    time_max = f"{date}T23:59:59Z"

    meal_events = []
    exercise_events = []

    async with httpx.AsyncClient() as client:
        for setting in settings:
            resp = await client.get(
                f"https://www.googleapis.com/calendar/v3/calendars/{setting.calendar_id}/events",
                headers={"Authorization": f"Bearer {access_token}"},
                params={
                    "timeMin": time_min,
                    "timeMax": time_max,
                    "singleEvents": "true",
                    "orderBy": "startTime",
                },
            )
            if resp.status_code != 200:
                continue

            for event in resp.json().get("items", []):
                summary = event.get("summary", "")
                start = event.get("start", {}).get("dateTime", event.get("start", {}).get("date", ""))

                # Categorize without exposing full title
                if any(kw in summary for kw in _MEAL_KEYWORDS):
                    category = next((kw for kw in _MEAL_KEYWORDS if kw in summary), "外食")
                    meal_events.append({"category": category, "time": start})
                elif any(kw in summary for kw in _EXERCISE_KEYWORDS):
                    category = next((kw for kw in _EXERCISE_KEYWORDS if kw in summary), "運動")
                    exercise_events.append({"category": category, "time": start})

    return {"meal_events": meal_events, "exercise_events": exercise_events}
