import os
import uuid
import hmac
import base64
import time
import urllib.parse
import httpx
from cachetools import TTLCache
from sqlalchemy.orm import Session
from .. import models, security

# OAuth 1.0a（食品検索用 — IP ホワイトリスト不要）
CONSUMER_KEY    = os.getenv("FATSECRET_CONSUMER_KEY", "")
CONSUMER_SECRET = os.getenv("FATSECRET_CONSUMER_SECRET", "")

# OAuth 2.0 はアプリレベルの signed request 用のみ。
# ユーザー委任（食事日記など）は OAuth 1.0a 3-legged を使う。
API_URL           = "https://platform.fatsecret.com/rest/server.api"
REQUEST_TOKEN_URL = "https://authentication.fatsecret.com/oauth/request_token"
AUTHORIZE_URL     = "https://authentication.fatsecret.com/oauth/authorize"
ACCESS_TOKEN_URL  = "https://authentication.fatsecret.com/oauth/access_token"

_search_cache: TTLCache = TTLCache(maxsize=500, ttl=3600)
_pending_oauth_tokens: TTLCache = TTLCache(maxsize=500, ttl=900)


# ── OAuth 1.0a helpers ───────────────────────────────────────────────

def _percent_encode(value: str) -> str:
    return urllib.parse.quote(str(value), safe="~")


def _normalize_params(params: dict) -> str:
    encoded_items: list[tuple[str, str]] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            for item in value:
                encoded_items.append((_percent_encode(key), _percent_encode(item)))
        else:
            encoded_items.append((_percent_encode(key), _percent_encode(value)))
    encoded_items.sort()
    return "&".join(f"{k}={v}" for k, v in encoded_items)


def _build_oauth1_params(
    method: str,
    url: str,
    *,
    request_params: dict | None = None,
    token: str = "",
    token_secret: str = "",
    callback: str | None = None,
    verifier: str | None = None,
) -> dict[str, str]:
    oauth_params = {
        "oauth_consumer_key": CONSUMER_KEY,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    if token:
        oauth_params["oauth_token"] = token
    if callback:
        oauth_params["oauth_callback"] = callback
    if verifier:
        oauth_params["oauth_verifier"] = verifier

    signature_params = {**oauth_params, **(request_params or {})}
    signature_base = "&".join(
        [
            method.upper(),
            _percent_encode(url),
            _percent_encode(_normalize_params(signature_params)),
        ]
    )
    signing_key = f"{_percent_encode(CONSUMER_SECRET)}&{_percent_encode(token_secret)}"
    oauth_signature = base64.b64encode(
        hmac.digest(signing_key.encode(), signature_base.encode(), "sha1")
    ).decode()
    oauth_params["oauth_signature"] = oauth_signature
    return oauth_params


async def _signed_oauth1_request(
    method: str,
    url: str,
    *,
    data: dict | None = None,
    token: str = "",
    token_secret: str = "",
    callback: str | None = None,
    verifier: str | None = None,
) -> httpx.Response:
    payload = dict(data or {})
    oauth_params = _build_oauth1_params(
        method,
        url,
        request_params=payload,
        token=token,
        token_secret=token_secret,
        callback=callback,
        verifier=verifier,
    )
    signed_payload = {**payload, **oauth_params}
    request_kwargs: dict[str, dict[str, str]] = {}
    if method.upper() == "GET":
        request_kwargs["params"] = signed_payload
    else:
        request_kwargs["data"] = signed_payload

    async with httpx.AsyncClient() as client:
        return await client.request(method.upper(), url, **request_kwargs)


def _parse_form_encoded(text: str) -> dict[str, str]:
    parsed = urllib.parse.parse_qs(text, keep_blank_values=True)
    return {key: values[0] for key, values in parsed.items()}


async def _api_call_public(params: dict) -> dict:
    """食品検索など、ユーザー認証不要の API 呼び出し（OAuth 1.0a 2-legged）。"""
    resp = await _signed_oauth1_request("POST", API_URL, data=params)
    resp.raise_for_status()
    return resp.json()


# ── OAuth 1.0a 3-legged（ユーザー委任 — 食事日記用）─────────────────

async def begin_user_authorization(callback_url: str, user_id: str) -> str:
    """FatSecret 3-legged OAuth を開始し、認可 URL を返す。"""
    resp = await _signed_oauth1_request(
        "POST",
        REQUEST_TOKEN_URL,
        callback=callback_url,
    )
    if resp.status_code != 200:
        raise ValueError(f"FatSecret request token error: {resp.text}")

    data = _parse_form_encoded(resp.text)
    request_token = data.get("oauth_token", "")
    request_token_secret = data.get("oauth_token_secret", "")
    if not request_token or not request_token_secret:
        raise ValueError("FatSecret request token response was incomplete")

    _pending_oauth_tokens[request_token] = {
        "user_id": user_id,
        "request_token_secret": request_token_secret,
    }
    return AUTHORIZE_URL + "?" + urllib.parse.urlencode({"oauth_token": request_token})


async def complete_user_authorization(
    request_token: str,
    verifier: str,
) -> dict[str, str]:
    pending = _pending_oauth_tokens.get(request_token)
    if not pending:
        raise ValueError("FatSecret authorization expired. Please start the connection again.")

    resp = await _signed_oauth1_request(
        "GET",
        ACCESS_TOKEN_URL,
        token=request_token,
        token_secret=pending["request_token_secret"],
        verifier=verifier,
    )
    if resp.status_code != 200:
        raise ValueError(f"FatSecret access token error: {resp.text}")

    data = _parse_form_encoded(resp.text)
    access_token = data.get("oauth_token", "")
    access_token_secret = data.get("oauth_token_secret", "")
    if not access_token or not access_token_secret:
        raise ValueError("FatSecret access token response was incomplete")

    _pending_oauth_tokens.pop(request_token, None)
    return {
        "user_id": pending["user_id"],
        "access_token": access_token,
        "access_token_secret": access_token_secret,
    }


async def _api_call_user(user_id: str, db: Session, params: dict) -> dict:
    """食事記録など、ユーザートークンが必要な API 呼び出し（OAuth 1.0a delegated）。"""
    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fatsecret").first()
    if not token:
        raise ValueError("FatSecretが連携されていません。設定画面から連携してください。")

    access_token = security.decrypt(token.access_token)
    access_token_secret = security.decrypt(token.refresh_token) if token.refresh_token else ""
    if not access_token_secret:
        raise ValueError("FatSecretトークンシークレットがありません。再連携してください。")

    resp = await _signed_oauth1_request(
        "POST",
        API_URL,
        data=params,
        token=access_token,
        token_secret=access_token_secret,
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
    data = await _api_call_public(params)
    food_id = data.get("food_id", {}).get("value")
    if not food_id:
        return None
    return await get_food(user_id, food_id, db)
