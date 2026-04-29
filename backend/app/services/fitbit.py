import os
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from .. import models, security

FITBIT_CLIENT_ID = os.getenv("FITBIT_CLIENT_ID", "")
FITBIT_CLIENT_SECRET = os.getenv("FITBIT_CLIENT_SECRET", "")
BASE_URL = "https://api.fitbit.com"


async def _get_access_token(user_id: str, db: Session) -> str:
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fitbit").first()
    if not token:
        raise ValueError("Fitbit not connected")

    if token.expires_at and token.expires_at < datetime.utcnow() + timedelta(minutes=5):
        await _refresh_token(token, db)

    return security.decrypt(token.access_token)


async def _refresh_token(token: models.OAuthToken, db: Session):
    refresh = security.decrypt(token.refresh_token)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.fitbit.com/oauth2/token",
            data={"grant_type": "refresh_token", "refresh_token": refresh},
            auth=(FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET),
        )
    if resp.status_code != 200:
        raise ValueError(f"Fitbit refresh failed: {resp.text}")

    data = resp.json()
    token.access_token = security.encrypt(data["access_token"])
    token.refresh_token = security.encrypt(data["refresh_token"])
    token.expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 28800))
    db.commit()


async def get_activities(user_id: str, date: str, db: Session) -> dict:
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1/user/-/activities/date/{date}.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    data = resp.json()
    summary = data.get("summary", {})
    return {
        "steps": summary.get("steps", 0),
        "active_kcal": summary.get("activeScore", 0),
        "calories_out": summary.get("caloriesOut", 0),
    }


async def get_sleep(user_id: str, date: str, db: Session) -> dict:
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1.2/user/-/sleep/date/{date}.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    data = resp.json()
    summary = data.get("summary", {})
    stages = summary.get("stages", {})
    total_minutes = sum(stages.values()) if stages else summary.get("totalMinutesAsleep", 0)
    return {
        "sleep_hours": round(total_minutes / 60, 1),
        "sleep_score": data.get("sleep", [{}])[0].get("efficiency", 0) if data.get("sleep") else 0,
    }


async def get_weight(user_id: str, date: str, db: Session) -> dict | None:
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1/user/-/body/log/weight/date/{date}.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    data = resp.json()
    weights = data.get("weight", [])
    if not weights:
        return None
    entry = weights[-1]
    return {
        "weight": entry.get("weight"),
        "bmi": entry.get("bmi"),
        "source": "fitbit",
    }


async def get_weight_range(user_id: str, start: str, end: str, db: Session) -> list[dict]:
    """Fitbit の日付範囲で体重ログを一括取得する。"""
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1/user/-/body/log/weight/date/{start}/{end}.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    entries = resp.json().get("weight", [])
    return [
        {"date": e["date"], "weight": e.get("weight"), "bmi": e.get("bmi")}
        for e in entries
    ]


async def get_sleep_range(user_id: str, start: str, end: str, db: Session) -> list[dict]:
    """Fitbit の日付範囲で睡眠ログを一括取得する。"""
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1.2/user/-/sleep/date/{start}/{end}.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    entries = resp.json().get("sleep", [])
    result: dict[str, dict] = {}
    for e in entries:
        date = e.get("dateOfSleep")
        if not date:
            continue
        minutes = e.get("minutesAsleep", 0)
        result.setdefault(date, {"sleep_hours": 0, "sleep_score": 0})
        result[date]["sleep_hours"]  = round(minutes / 60, 1)
        result[date]["sleep_score"]  = e.get("efficiency", 0)
    return [{"date": d, **v} for d, v in sorted(result.items())]


async def get_heart_rate_zones(user_id: str, date: str, db: Session) -> list:
    access_token = await _get_access_token(user_id, db)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE_URL}/1/user/-/activities/heart/date/{date}/1d.json",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    data = resp.json()
    heart = data.get("activities-heart", [])
    if not heart:
        return []
    return heart[-1].get("value", {}).get("heartRateZones", [])
