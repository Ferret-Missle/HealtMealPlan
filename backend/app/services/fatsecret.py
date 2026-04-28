import os
import uuid
import hashlib
import hmac
import base64
import time
import json
import urllib.parse
from cachetools import TTLCache
import httpx
from sqlalchemy.orm import Session
from .. import models, security

CONSUMER_KEY = os.getenv("FATSECRET_CONSUMER_KEY", "")
CONSUMER_SECRET = os.getenv("FATSECRET_CONSUMER_SECRET", "")
API_URL = "https://platform.fatsecret.com/rest/server.api"

_search_cache: TTLCache = TTLCache(maxsize=500, ttl=3600)  # 1 hour cache


def _oauth1_header(method: str, url: str, token: str, token_secret: str, extra: dict = None) -> str:
    params = {
        "oauth_consumer_key": CONSUMER_KEY,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    if extra:
        params.update(extra)

    sorted_params = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(str(v), safe='')}"
        for k, v in sorted(params.items())
    )
    base_string = "&".join([
        method.upper(),
        urllib.parse.quote(url, safe=""),
        urllib.parse.quote(sorted_params, safe=""),
    ])
    signing_key = f"{urllib.parse.quote(CONSUMER_SECRET, safe='')}&{urllib.parse.quote(token_secret, safe='')}"
    signature = base64.b64encode(
        hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()
    ).decode()
    params["oauth_signature"] = signature

    return "OAuth " + ", ".join(
        f'{k}="{urllib.parse.quote(str(v), safe="")}"'
        for k, v in sorted(params.items())
        if k.startswith("oauth_")
    )


def _get_credentials(user_id: str, db: Session) -> tuple[str, str]:
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fatsecret").first()
    if not token:
        raise ValueError("FatSecret not connected")
    return security.decrypt(token.access_token), security.decrypt(token.refresh_token)


async def search_foods(user_id: str, query: str, db: Session, page: int = 0) -> dict:
    cache_key = f"search:{query}:{page}"
    if cache_key in _search_cache:
        return _search_cache[cache_key]

    oauth_token, oauth_secret = _get_credentials(user_id, db)
    params = {
        "method": "foods.search",
        "search_expression": query,
        "format": "json",
        "region": "JP",
        "language": "ja",
        "page_number": str(page),
        "max_results": "20",
    }
    header = _oauth1_header("POST", API_URL, oauth_token, oauth_secret, params)

    async with httpx.AsyncClient() as client:
        resp = await client.post(API_URL, data=params, headers={"Authorization": header})
    resp.raise_for_status()
    result = resp.json()
    _search_cache[cache_key] = result
    return result


async def get_food(user_id: str, food_id: str, db: Session) -> dict:
    cache_key = f"food:{food_id}"
    if cache_key in _search_cache:
        return _search_cache[cache_key]

    oauth_token, oauth_secret = _get_credentials(user_id, db)
    params = {
        "method": "food.get.v2",
        "food_id": food_id,
        "format": "json",
        "region": "JP",
        "language": "ja",
    }
    header = _oauth1_header("POST", API_URL, oauth_token, oauth_secret, params)

    async with httpx.AsyncClient() as client:
        resp = await client.post(API_URL, data=params, headers={"Authorization": header})
    resp.raise_for_status()
    result = resp.json()
    _search_cache[cache_key] = result
    return result


async def get_food_entries(user_id: str, date: str, db: Session) -> list:
    """Get food diary entries for a specific date."""
    oauth_token, oauth_secret = _get_credentials(user_id, db)
    # FatSecret uses days since Jan 1, 1970 (Unix epoch / 86400)
    from datetime import date as dt_date
    d = dt_date.fromisoformat(date)
    epoch_date = (d - dt_date(1970, 1, 1)).days

    params = {
        "method": "food_entries.get",
        "date": str(epoch_date),
        "format": "json",
    }
    header = _oauth1_header("POST", API_URL, oauth_token, oauth_secret, params)

    async with httpx.AsyncClient() as client:
        resp = await client.post(API_URL, data=params, headers={"Authorization": header})
    resp.raise_for_status()
    data = resp.json()
    entries = data.get("food_entries", {}).get("food_entry", [])
    if isinstance(entries, dict):
        entries = [entries]
    return entries


async def sync_food_diary(user_id: str, date: str, db: Session) -> int:
    """FatSecretの食事日記を指定日付でDBに同期する。既存レコードは上書きしない。"""
    from .. import models
    entries = await get_food_entries(user_id, date, db)
    synced = 0
    for entry in entries:
        food_id = str(entry.get("food_id", ""))
        meal_type_raw = entry.get("meal_name", "dinner").lower()
        meal_map = {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner", "snack": "snack"}
        meal_type = meal_map.get(meal_type_raw, "snack")

        # 重複チェック
        exists = (
            db.query(models.MealLog)
            .filter_by(user_id=user_id, date=date, food_id=food_id, meal_type=meal_type)
            .first()
        )
        if exists:
            continue

        # 栄養情報
        nutrition = entry.get("nutritional_content", {})
        log = models.MealLog(
            user_id=user_id,
            date=date,
            meal_type=meal_type,
            food_name=entry.get("food_entry_name", ""),
            food_id=food_id,
            kcal=float(nutrition.get("calories", 0) or 0),
            protein_g=float(nutrition.get("protein", 0) or 0),
            fat_g=float(nutrition.get("fat", 0) or 0),
            carb_g=float(nutrition.get("carbohydrate", 0) or 0),
            serving_grams=float(entry.get("metric_serving_amount", 0) or 0),
            source="fatsecret",
        )
        db.add(log)
        synced += 1

    if synced > 0:
        db.commit()
    return synced


async def search_by_barcode(user_id: str, barcode: str, db: Session) -> dict | None:
    oauth_token, oauth_secret = _get_credentials(user_id, db)
    params = {
        "method": "food.find_id_for_barcode",
        "barcode": barcode,
        "format": "json",
    }
    header = _oauth1_header("POST", API_URL, oauth_token, oauth_secret, params)

    async with httpx.AsyncClient() as client:
        resp = await client.post(API_URL, data=params, headers={"Authorization": header})
    resp.raise_for_status()
    data = resp.json()
    food_id = data.get("food_id", {}).get("value")
    if not food_id:
        return None
    return await get_food(user_id, food_id, db)
