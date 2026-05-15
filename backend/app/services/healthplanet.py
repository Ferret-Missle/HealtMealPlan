import os
from datetime import datetime, timedelta
import httpx
from sqlalchemy.orm import Session
from .. import models, security

HEALTHPLANET_CLIENT_ID = os.getenv("HEALTHPLANET_CLIENT_ID", "")
HEALTHPLANET_CLIENT_SECRET = os.getenv("HEALTHPLANET_CLIENT_SECRET", "")
BASE_URL = "https://www.healthplanet.jp"
HP_INNERSCAN_TAGS = {
    "6021": ("weight", float),
    "6022": ("body_fat", float),
    "6023": ("muscle_mass", float),
    "6026": ("visceral_fat_level", float),
    "6027": ("basal_metabolism_kcal", float),
    "6028": ("body_age", lambda value: int(float(value))),
    "6029": ("bone_mass", float),
}
HP_INNERSCAN_TAG_LIST = ",".join(HP_INNERSCAN_TAGS.keys())


def _collapse_healthplanet_innerscan_items(data_list: list[dict]) -> list[dict]:
    by_date: dict[str, dict] = {}
    for item in data_list:
        raw_timestamp = str(item.get("date") or "")
        raw_date = raw_timestamp[:8]
        if len(raw_date) != 8:
            continue
        formatted = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        record = by_date.setdefault(
            formatted,
            {"source": "healthplanet", "_field_timestamps": {}},
        )
        tag = item.get("tag")
        keydata = item.get("keydata")
        mapping = HP_INNERSCAN_TAGS.get(tag)
        if not mapping or keydata in (None, ""):
            continue
        field_name, caster = mapping
        previous_timestamp = record["_field_timestamps"].get(field_name, "")
        if raw_timestamp < previous_timestamp:
            continue
        record[field_name] = caster(keydata)
        record["_field_timestamps"][field_name] = raw_timestamp

    return [
        {"date": entry_date, **{k: v for k, v in record.items() if k != "_field_timestamps"}}
        for entry_date, record in sorted(by_date.items())
        if len(record) > 1
    ]


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
    """Get body composition data from HealthPlanet.

    HealthPlanet 公式仕様では 6023/6026/6027/6028/6029 は 2020-06-29 に連携終了扱いのため、
    返ってこないケースがある。その場合は None のまま扱う。
    """
    entries = await get_innerscan_range(user_id, date, date, db)
    if not entries:
        return None
    entry = entries[-1]
    return {key: value for key, value in entry.items() if key != "date"}


async def get_innerscan_range(user_id: str, from_date: str, to_date: str, db: Session) -> list[dict]:
    """HealthPlanet の日付範囲で体組成データを一括取得する。"""
    access_token = await _get_access_token(user_id, db)
    from_fmt = from_date.replace("-", "") + "000000"
    to_fmt   = to_date.replace("-", "")   + "235959"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE_URL}/status/innerscan.json",
            data={
                "access_token": access_token,
                "date": "1",
                "from": from_fmt,
                "to":   to_fmt,
                "tag":  HP_INNERSCAN_TAG_LIST,
            },
        )
    if resp.status_code != 200:
        raise ValueError(f"HealthPlanet range error {resp.status_code}: {resp.text}")

    data_list = resp.json().get("data", [])
    return _collapse_healthplanet_innerscan_items(data_list)
