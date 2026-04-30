import os
import uuid
import hashlib
import hmac
import base64
import time
import urllib.parse
import httpx
from cachetools import TTLCache
from sqlalchemy.orm import Session
from .. import models, security

CONSUMER_KEY    = os.getenv("FATSECRET_CONSUMER_KEY", "")
CONSUMER_SECRET = os.getenv("FATSECRET_CONSUMER_SECRET", "")
API_URL         = "https://platform.fatsecret.com/rest/server.api"
TOKEN_URL       = "https://oauth.fatsecret.com/connect/token"

_search_cache: TTLCache = TTLCache(maxsize=500, ttl=3600)

# ── OAuth 2.0 Client Credentials（食品検索用）─────────────────────────

# Bearer token キャッシュ（24時間有効）
_bearer: dict = {"token": None, "expires_at": 0.0}


async def _get_bearer_token(scope: str = "basic barcode") -> str:
    """Client Credentials フローで Bearer token を取得（24時間キャッシュ）。"""
    now = time.time()
    if _bearer["token"] and _bearer["expires_at"] > now + 60:
        return _bearer["token"]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            TOKEN_URL,
            data={"grant_type": "client_credentials", "scope": scope},
            auth=(CONSUMER_KEY, CONSUMER_SECRET),
        )
    resp.raise_for_status()
    data = resp.json()
    _bearer["token"]      = data["access_token"]
    _bearer["expires_at"] = now + data.get("expires_in", 86400)
    return _bearer["token"]


async def _api_call_public(params: dict, scope: str = "basic barcode") -> dict:
    """食品検索など、ユーザー認証不要の API 呼び出し（OAuth 2.0 Bearer）。"""
    token = await _get_bearer_token(scope)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            API_URL,
            data=params,
            headers={"Authorization": f"Bearer {token}"},
        )
    resp.raise_for_status()
    return resp.json()


# ── OAuth 1.0a（ユーザー食事日記用）──────────────────────────────────

def _oauth1_header(access_token: str, token_secret: str, extra_params: dict) -> str:
    """ユーザーの OAuth 1.0a トークンで署名した Authorization ヘッダーを返す。"""
    params = {
        "oauth_consumer_key":     CONSUMER_KEY,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp":        str(int(time.time())),
        "oauth_token":            access_token,
        "oauth_version":          "1.0",
    }
    # 署名ベースに API パラメータも含める
    all_params = {**params, **extra_params}
    sorted_params = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(str(v), safe='')}"
        for k, v in sorted(all_params.items())
    )
    base_string = "&".join([
        "POST",
        urllib.parse.quote(API_URL, safe=""),
        urllib.parse.quote(sorted_params, safe=""),
    ])
    signing_key = (
        f"{urllib.parse.quote(CONSUMER_SECRET, safe='')}"
        f"&{urllib.parse.quote(token_secret, safe='')}"
    )
    sig = base64.b64encode(
        hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()
    ).decode()
    params["oauth_signature"] = sig
    return "OAuth " + ", ".join(
        f'{k}="{urllib.parse.quote(str(v), safe="")}"'
        for k, v in sorted(params.items())
        if k.startswith("oauth_")
    )


async def _api_call_user(user_id: str, db: Session, params: dict) -> dict:
    """食事記録など、ユーザートークンが必要な API 呼び出し（OAuth 1.0a 3-legged）。"""
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fatsecret").first()
    if not token:
        raise ValueError("FatSecretが連携されていません。設定画面から連携してください。")
    access_token  = security.decrypt(token.access_token)
    token_secret  = security.decrypt(token.refresh_token) if token.refresh_token else ""
    auth_header   = _oauth1_header(access_token, token_secret, params)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            API_URL,
            data=params,
            headers={"Authorization": auth_header},
        )
    resp.raise_for_status()
    return resp.json()


# ── 公開 API ────────────────────────────────────────────────────────

async def search_foods(user_id: str, query: str, db: Session, page: int = 0) -> dict:
    """食品検索（ユーザートークン不要）。"""
    cache_key = f"search:{query}:{page}"
    if cache_key in _search_cache:
        return _search_cache[cache_key]

    params = {
        "method":            "foods.search",
        "search_expression": query,
        "format":            "json",
        "region":            "JP",
        "language":          "ja",
        "page_number":       str(page),
        "max_results":       "20",
    }
    result = await _api_call_public(params)
    _search_cache[cache_key] = result
    return result


async def get_food(user_id: str, food_id: str, db: Session) -> dict:
    """食品詳細取得（ユーザートークン不要）。"""
    cache_key = f"food:{food_id}"
    if cache_key in _search_cache:
        return _search_cache[cache_key]

    params = {
        "method":    "food.get.v2",
        "food_id":   food_id,
        "format":    "json",
        "region":    "JP",
        "language":  "ja",
    }
    result = await _api_call_public(params)
    _search_cache[cache_key] = result
    return result


async def get_food_entries(user_id: str, date: str, db: Session) -> list:
    """食事日記取得（有料プランのユーザートークンが必要）。"""
    from datetime import date as dt_date
    d = dt_date.fromisoformat(date)
    epoch_date = (d - dt_date(1970, 1, 1)).days

    params = {
        "method": "food_entries.get",
        "date":   str(epoch_date),
        "format": "json",
    }
    data = await _api_call_user(user_id, db, params)
    entries = data.get("food_entries", {}).get("food_entry", [])
    if isinstance(entries, dict):
        entries = [entries]
    return entries


async def sync_food_diary(user_id: str, date: str, db: Session) -> int:
    """FatSecretの食事日記を指定日付でDBに同期する（有料プランのみ）。既存レコードは上書きしない。"""
    from .. import models
    try:
        entries = await get_food_entries(user_id, date, db)
    except ValueError as e:
        raise ValueError(str(e))
    except Exception as e:
        raise ValueError(f"FatSecret diary sync requires a paid plan: {e}")
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
    """バーコード検索（barcode スコープが必要）。"""
    params = {
        "method":  "food.find_id_for_barcode",
        "barcode": barcode,
        "format":  "json",
    }
    data = await _api_call_public(params, scope="basic barcode")
    food_id = data.get("food_id", {}).get("value")
    if not food_id:
        return None
    return await get_food(user_id, food_id, db)
