import os
import uuid
import hashlib
import hmac
import base64
import time
import urllib.parse
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
import httpx

from ..database import get_db
from .. import models, security
from ..auth_deps import get_current_user

router = APIRouter()

FITBIT_CLIENT_ID = os.getenv("FITBIT_CLIENT_ID", "")
FITBIT_CLIENT_SECRET = os.getenv("FITBIT_CLIENT_SECRET", "")
FITBIT_REDIRECT_URI = os.getenv("FITBIT_REDIRECT_URI", "http://localhost:8000/api/auth/fitbit/callback")

HEALTHPLANET_CLIENT_ID = os.getenv("HEALTHPLANET_CLIENT_ID", "")
HEALTHPLANET_CLIENT_SECRET = os.getenv("HEALTHPLANET_CLIENT_SECRET", "")
HEALTHPLANET_REDIRECT_URI = os.getenv("HEALTHPLANET_REDIRECT_URI", "http://localhost:8000/api/auth/healthplanet/callback")

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/auth/google/callback")

# FatSecret OAuth 1.0a（食事日記アクセスは無料プランで利用可能）
FATSECRET_CONSUMER_KEY    = os.getenv("FATSECRET_CONSUMER_KEY", "")
FATSECRET_CONSUMER_SECRET = os.getenv("FATSECRET_CONSUMER_SECRET", "")
FATSECRET_REDIRECT_URI    = os.getenv("FATSECRET_REDIRECT_URI", "http://localhost:8000/api/auth/fatsecret/callback")
# Step1 で取得した request_token_secret を一時保持 (oauth_token → (token_secret, user_id))
_fatsecret_request_tokens: dict[str, tuple[str, str]] = {}

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
BACKEND_URL  = os.getenv("BACKEND_URL",  "http://localhost:8000")

# ---- Register / Me ----

class RegisterRequest(BaseModel):
    uid: str
    email: str
    name: str
    terms_version: str = "1.0"
    privacy_version: str = "1.0"


@router.post("/register")
async def register(req: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(models.User).filter(models.User.id == req.uid).first()
    if existing:
        return {"user_id": existing.id}

    user = models.User(id=req.uid, email=req.email, name=req.name)
    db.add(user)

    plan = models.UserPlan(user_id=req.uid, plan_type=models.PlanType.free)
    db.add(plan)

    goals = models.UserGoals(user_id=req.uid)
    db.add(goals)

    # Record consents
    for doc_type, version in [("terms", req.terms_version), ("privacy", req.privacy_version)]:
        consent = models.UserConsent(user_id=req.uid, document_type=doc_type, version=version)
        db.add(consent)

    # Create personal group
    group_id = str(uuid.uuid4())
    group = models.Group(id=group_id, name=f"{req.name}の個人グループ", type=models.GroupType.personal)
    db.add(group)
    member = models.GroupMember(group_id=group_id, user_id=req.uid, role="owner")
    db.add(member)

    db.commit()
    return {"user_id": req.uid, "group_id": group_id}


@router.get("/me")
async def me(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    plan = db.query(models.UserPlan).filter(models.UserPlan.user_id == current_user.id).first()
    member = db.query(models.GroupMember).filter(models.GroupMember.user_id == current_user.id).first()
    oauth_services = [
        t.service for t in db.query(models.OAuthToken).filter(models.OAuthToken.user_id == current_user.id).all()
    ]
    return {
        "id": current_user.id,
        "email": current_user.email,
        "name": current_user.name,
        "plan_type": plan.plan_type if plan else "free",
        "byok_provider": plan.byok_provider if plan else None,
        "group_id": member.group_id if member else None,
        "connected_services": oauth_services,
    }


# ---- Fitbit OAuth (Authorization Code + PKCE) ----

@router.get("/fitbit/login")
async def fitbit_login(user_id: str):
    code_verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode()).digest()
    ).rstrip(b"=").decode()

    params = {
        "client_id": FITBIT_CLIENT_ID,
        "response_type": "code",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "scope": "activity sleep weight heartrate",
        "state": f"{user_id}:{code_verifier}",
        "redirect_uri": FITBIT_REDIRECT_URI,
    }
    url = "https://www.fitbit.com/oauth2/authorize?" + urllib.parse.urlencode(params)
    return {"url": url}


@router.get("/fitbit/callback")
async def fitbit_callback(code: str, state: str, db: Session = Depends(get_db)):
    parts = state.split(":", 1)
    if len(parts) != 2:
        raise HTTPException(400, "Invalid state")
    user_id, code_verifier = parts

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.fitbit.com/oauth2/token",
            data={
                "client_id": FITBIT_CLIENT_ID,
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": FITBIT_REDIRECT_URI,
            },
            auth=(FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET),
        )
    if resp.status_code != 200:
        raise HTTPException(400, f"Fitbit token error: {resp.text}")

    data = resp.json()
    expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 28800))

    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fitbit").first()
    if not token:
        token = models.OAuthToken(user_id=user_id, service="fitbit")
        db.add(token)
    token.access_token = security.encrypt(data["access_token"])
    token.refresh_token = security.encrypt(data["refresh_token"])
    token.expires_at = expires_at
    db.commit()

    return RedirectResponse(f"{FRONTEND_URL}/me?connected=fitbit")


# ---- HealthPlanet OAuth ----

# HealthPlanet does not allow localhost as a host domain.
# Use the officially permitted redirect_uri: https://www.healthplanet.jp/success.html
HEALTHPLANET_FIXED_REDIRECT_URI = "https://www.healthplanet.jp/success.html"


@router.get("/healthplanet/login")
async def healthplanet_login(user_id: str):
    params = {
        "client_id": HEALTHPLANET_CLIENT_ID,
        "redirect_uri": HEALTHPLANET_FIXED_REDIRECT_URI,
        "response_type": "code",
        "scope": "innerscan,sphygmomanometer,pedometer",
        "state": user_id,
    }
    url = "https://www.healthplanet.jp/oauth/auth?" + urllib.parse.urlencode(params)
    return {"url": url}


class HealthPlanetCodeRequest(BaseModel):
    user_id: str
    code: str


@router.post("/healthplanet/exchange")
async def healthplanet_exchange(req: HealthPlanetCodeRequest, db: Session = Depends(get_db)):
    """Exchange authorization code for access token (manual code entry flow)."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://www.healthplanet.jp/oauth/token",
            data={
                "client_id": HEALTHPLANET_CLIENT_ID,
                "client_secret": HEALTHPLANET_CLIENT_SECRET,
                "redirect_uri": HEALTHPLANET_FIXED_REDIRECT_URI,
                "code": req.code,
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(400, f"HealthPlanet token error: {resp.text}")

    data = resp.json()
    expires_at = datetime.utcnow() + timedelta(days=30)

    token = db.query(models.OAuthToken).filter_by(user_id=req.user_id, service="healthplanet").first()
    if not token:
        token = models.OAuthToken(user_id=req.user_id, service="healthplanet")
        db.add(token)
    token.access_token = security.encrypt(data["access_token"])
    if data.get("refresh_token"):
        token.refresh_token = security.encrypt(data["refresh_token"])
    token.expires_at = expires_at
    db.commit()

    return {"status": "connected"}


@router.get("/healthplanet/callback")
async def healthplanet_callback(code: str, state: str, db: Session = Depends(get_db)):
    """Legacy callback - kept for compatibility but not used with success.html redirect."""
    user_id = state
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://www.healthplanet.jp/oauth/token",
            data={
                "client_id": HEALTHPLANET_CLIENT_ID,
                "client_secret": HEALTHPLANET_CLIENT_SECRET,
                "redirect_uri": HEALTHPLANET_REDIRECT_URI,
                "code": code,
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(400, f"HealthPlanet token error: {resp.text}")

    data = resp.json()
    expires_at = datetime.utcnow() + timedelta(days=30)

    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="healthplanet").first()
    if not token:
        token = models.OAuthToken(user_id=user_id, service="healthplanet")
        db.add(token)
    token.access_token = security.encrypt(data["access_token"])
    if data.get("refresh_token"):
        token.refresh_token = security.encrypt(data["refresh_token"])
    token.expires_at = expires_at
    db.commit()

    return RedirectResponse(f"{FRONTEND_URL}/me?connected=healthplanet")


# ---- Google Calendar OAuth ----

@router.get("/google/login")
async def google_login(user_id: str):
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "https://www.googleapis.com/auth/calendar.readonly",
        "access_type": "offline",
        "prompt": "consent",
        "state": user_id,
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
    return {"url": url}


@router.get("/google/callback")
async def google_callback(code: str, state: str, db: Session = Depends(get_db)):
    user_id = state
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "code": code,
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(400, f"Google token error: {resp.text}")

    data = resp.json()
    expires_at = datetime.utcnow() + timedelta(seconds=data.get("expires_in", 3600))

    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="google").first()
    if not token:
        token = models.OAuthToken(user_id=user_id, service="google")
        db.add(token)
    token.access_token = security.encrypt(data["access_token"])
    if data.get("refresh_token"):
        token.refresh_token = security.encrypt(data["refresh_token"])
    token.expires_at = expires_at
    db.commit()

    return RedirectResponse(f"{FRONTEND_URL}/me?connected=google")


# ---- FatSecret OAuth 1.0a 3-legged ----
# food_entries.get は Premier Exclusive 非対象 → 無料プランで利用可能。
# ユーザーの食事日記アクセスには 3-legged OAuth 1.0a が必要。
# 食品検索は fatsecret.py の OAuth 2.0 Client Credentials で行う（ユーザー不要）。

def _fs_oauth1_sign(method: str, url: str, params: dict, token_secret: str = "") -> str:
    """OAuth 1.0a HMAC-SHA1 署名を返す（params に署名は含めない）。"""
    sorted_params = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(str(v), safe='')}"
        for k, v in sorted(params.items())
    )
    base_string = "&".join([
        method.upper(),
        urllib.parse.quote(url, safe=""),
        urllib.parse.quote(sorted_params, safe=""),
    ])
    signing_key = (
        f"{urllib.parse.quote(FATSECRET_CONSUMER_SECRET, safe='')}"
        f"&{urllib.parse.quote(token_secret, safe='')}"
    )
    return base64.b64encode(
        hmac.new(signing_key.encode(), base_string.encode(), hashlib.sha1).digest()
    ).decode()


def _fs_auth_header(params: dict) -> str:
    """OAuth Authorization ヘッダー文字列を生成（params は署名込み）。"""
    return "OAuth " + ", ".join(
        f'{k}="{urllib.parse.quote(str(v), safe="")}"'
        for k, v in sorted(params.items())
        if k.startswith("oauth_")
    )


# Cloudflare 対策: ブラウザに近いヘッダー
# ※ Accept-Encoding は設定しない → httpx が自動解凍するため
_FS_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}


@router.get("/fatsecret/login")
async def fatsecret_login(user_id: str):
    """Step 1: request_token を取得して認可 URL を返す。"""
    REQUEST_TOKEN_URL = "https://www.fatsecret.com/oauth/request_token"

    params = {
        "oauth_callback":         FATSECRET_REDIRECT_URI,
        "oauth_consumer_key":     FATSECRET_CONSUMER_KEY,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp":        str(int(time.time())),
        "oauth_version":          "1.0",
    }
    params["oauth_signature"] = _fs_oauth1_sign("POST", REQUEST_TOKEN_URL, params)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            REQUEST_TOKEN_URL,
            headers={**_FS_BROWSER_HEADERS, "Authorization": _fs_auth_header(params)},
        )

    if resp.status_code != 200:
        raise HTTPException(400, f"FatSecret request token error: {resp.text[:300]}")

    token_data = dict(urllib.parse.parse_qsl(resp.text))
    request_token        = token_data.get("oauth_token")
    request_token_secret = token_data.get("oauth_token_secret")

    if not request_token:
        raise HTTPException(400, f"oauth_token missing in response: {resp.text[:200]}")

    _fatsecret_request_tokens[request_token] = (request_token_secret or "", user_id)
    auth_url = f"https://www.fatsecret.com/oauth/authorize?oauth_token={request_token}"
    return {"url": auth_url}


# 後方互換エイリアス
@router.get("/fatsecret/request-token")
async def fatsecret_request_token_compat(user_id: str):
    return await fatsecret_login(user_id)


@router.get("/fatsecret/callback")
async def fatsecret_callback(
    oauth_token:    str | None = None,
    oauth_verifier: str | None = None,
    db: Session = Depends(get_db),
):
    """Step 3: oauth_verifier を使って access_token を取得しDBに保存。"""
    ACCESS_TOKEN_URL = "https://www.fatsecret.com/oauth/access_token"

    if not oauth_token or not oauth_verifier:
        return RedirectResponse(f"{FRONTEND_URL}/me?error=fatsecret_invalid_callback")

    token_secret, user_id = _fatsecret_request_tokens.pop(oauth_token, ("", ""))
    if not user_id:
        return RedirectResponse(f"{FRONTEND_URL}/me?error=fatsecret_session_expired")

    params = {
        "oauth_consumer_key":     FATSECRET_CONSUMER_KEY,
        "oauth_nonce":            uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp":        str(int(time.time())),
        "oauth_token":            oauth_token,
        "oauth_verifier":         oauth_verifier,
        "oauth_version":          "1.0",
    }
    params["oauth_signature"] = _fs_oauth1_sign(
        "POST", ACCESS_TOKEN_URL, params, token_secret
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            ACCESS_TOKEN_URL,
            headers={**_FS_BROWSER_HEADERS, "Authorization": _fs_auth_header(params)},
        )

    if resp.status_code != 200:
        detail = urllib.parse.quote(resp.text[:200])
        return RedirectResponse(
            f"{FRONTEND_URL}/me?error=fatsecret_access_token_failed&detail={detail}"
        )

    access_data   = dict(urllib.parse.parse_qsl(resp.text))
    access_token  = access_data.get("oauth_token", "")
    access_secret = access_data.get("oauth_token_secret", "")

    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fatsecret").first()
    if not token:
        token = models.OAuthToken(user_id=user_id, service="fatsecret")
        db.add(token)
    token.access_token  = security.encrypt(access_token)
    token.refresh_token = security.encrypt(access_secret)   # OAuth 1.0a token_secret
    token.expires_at    = None                              # None = OAuth 1.0a
    db.commit()

    return RedirectResponse(f"{FRONTEND_URL}/me?connected=fatsecret")


# ---- Disconnect ----

@router.delete("/disconnect/{service}")
async def disconnect_service(
    service: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = db.query(models.OAuthToken).filter_by(user_id=current_user.id, service=service).first()
    if token:
        db.delete(token)
        db.commit()
    return {"disconnected": service}
