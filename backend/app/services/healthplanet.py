import os
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from .. import models, security

HEALTHPLANET_CLIENT_ID = os.getenv("HEALTHPLANET_CLIENT_ID", "")
HEALTHPLANET_CLIENT_SECRET = os.getenv("HEALTHPLANET_CLIENT_SECRET", "")
BASE_URL = "https://www.healthplanet.jp"


async def _get_access_token(user_id: str, db: Session) -> str:
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="healthplanet").first()
    if not token:
        raise ValueError("HealthPlanet not connected")

    if token.expires_at and token.expires_at < datetime.utcnow() + timedelta(days=1):
        await _refresh_token(token, db)

    return security.decrypt(token.access_token)


async def _refresh_token(token: models.OAuthToken, db: Session):
    refresh = security.decrypt(token.refresh_token) if token.refresh_token else None
    if not refresh:
        raise ValueError("No HealthPlanet refresh token")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/oauth/token",
            data={
                "client_id": HEALTHPLANET_CLIENT_ID,
                "client_secret": HEALTHPLANET_CLIENT_SECRET,
                "grant_type": "refresh_token",
                "refresh_token": refresh,
            },
        )
    if resp.status_code != 200:
        raise ValueError(f"HealthPlanet refresh failed: {resp.text}")

    data = resp.json()
    token.access_token = security.encrypt(data["access_token"])
    token.expires_at = datetime.utcnow() + timedelta(days=30)
    db.commit()


async def get_innerscan(user_id: str, date: str, db: Session) -> dict | None:
    """Get body composition data (weight, body fat, muscle, BMI)."""
    access_token = await _get_access_token(user_id, db)

    # HealthPlanet requires a date range (max 3 months)
    from_date = date.replace("-", "")
    to_date = date.replace("-", "")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/status/innerscan.json",
            data={
                "access_token": access_token,
                "date": "1",
                "from": f"{from_date}000000",
                "to": f"{to_date}235959",
                # 6021: weight, 6022: body_fat_pct
                # 6023/6024 discontinued on 2020-06-29
                "tag": "6021,6022",
            },
        )
    if resp.status_code != 200:
        raise ValueError(f"HealthPlanet innerscan error {resp.status_code}: {resp.text}")

    data = resp.json()
    data_list = data.get("data", [])
    if not data_list:
        return None

    result = {"source": "healthplanet"}
    for item in data_list:
        tag = item.get("tag")
        keydata = item.get("keydata")
        if tag == "6021":
            result["weight"] = float(keydata)
        elif tag == "6022":
            result["body_fat"] = float(keydata)

    return result if len(result) > 1 else None
