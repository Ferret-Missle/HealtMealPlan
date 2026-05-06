import os
import base64
import hashlib
import urllib.parse
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel
import httpx

from ..database import get_db
from .. import models, security
from ..auth_deps import get_current_user, require_firebase_admin
from ..services.user_identity import register_or_reconcile_user
from ..services import fatsecret

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

# FatSecret のユーザー委任は OAuth 1.0a 3-legged を使う。
FATSECRET_CONSUMER_KEY    = os.getenv("FATSECRET_CONSUMER_KEY", "")
FATSECRET_CONSUMER_SECRET = os.getenv("FATSECRET_CONSUMER_SECRET", "")
FATSECRET_REDIRECT_URI    = os.getenv("FATSECRET_REDIRECT_URI", "")

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
    try:
        user, group_id, action = register_or_reconcile_user(
            uid=req.uid,
            email=req.email,
            name=req.name,
            terms_version=req.terms_version,
            privacy_version=req.privacy_version,
            db=db,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="User registration conflict detected. Please retry after reloading.",
        ) from exc

    return {"user_id": user.id, "group_id": group_id, "status": action}


@router.get("/me")
async def me(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    plan = db.query(models.UserPlan).filter(models.UserPlan.user_id == current_user.id).first()
    member = db.query(models.GroupMember).filter(models.GroupMember.user_id == current_user.id).first()
    oauth_services = [
        t.service for t in db.query(models.OAuthToken).filter(models.OAuthToken.user_id == current_user.id).all()
    ]
    import os
    dev_ids = {s.strip() for s in os.getenv("DEVELOPER_USER_IDS", "").split(",") if s.strip()}
    return {
        "id": current_user.id,
        "email": current_user.email,
        "name": current_user.name,
        "plan_type": plan.plan_type if plan else "free",
        "byok_provider": plan.byok_provider if plan else None,
        "group_id": member.group_id if member else None,
        "connected_services": oauth_services,
        "is_developer": current_user.id in dev_ids,
    }


@router.delete("/me")
async def delete_my_account(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    firebase_auth = require_firebase_admin()
    user_id = current_user.id
    user_email = current_user.email

    member = db.query(models.GroupMember).filter_by(user_id=user_id).first()
    if member:
        other_members = (
            db.query(models.GroupMember)
            .filter(
                models.GroupMember.group_id == member.group_id,
                models.GroupMember.user_id != user_id,
            )
            .order_by(models.GroupMember.user_id.asc())
            .all()
        )

        if member.role == "owner" and other_members:
            other_members[0].role = "owner"

        group = db.query(models.Group).filter_by(id=member.group_id).first()
        db.delete(member)
        db.flush()

        if group and not db.query(models.GroupMember).filter_by(group_id=group.id).first():
            db.delete(group)

    db.query(models.GroupInvitation).filter(
        models.GroupInvitation.inviter_user_id == user_id
    ).delete(synchronize_session=False)

    db.query(models.GroupInvitation).filter(
        func.lower(models.GroupInvitation.invited_email) == user_email.lower()
    ).delete(synchronize_session=False)

    db.query(models.MealPlanItem).filter(
        models.MealPlanItem.user_id == user_id
    ).update({"user_id": None}, synchronize_session=False)
    db.query(models.ShoppingList).filter(
        models.ShoppingList.user_id == user_id
    ).update({"user_id": None}, synchronize_session=False)
    db.query(models.UsageLog).filter(
        models.UsageLog.user_id == user_id
    ).delete(synchronize_session=False)

    db.delete(current_user)
    db.flush()

    try:
        firebase_auth.delete_user(user_id)
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=502,
            detail=f"Failed to delete Firebase account: {type(exc).__name__}",
        ) from exc

    db.commit()
    return {"deleted_user_id": user_id}


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

    # ユーザーがDBに存在しない場合は登録を促すエラーにリダイレクト
    if not db.query(models.User).filter_by(id=user_id).first():
        return RedirectResponse(f"{FRONTEND_URL}/login?error=please_register_first")

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
# 公開URL（Render等）が使える環境ではバックエンドの callback に直接リダイレクトさせる。
# HealthPlanet開発者ポータルで HEALTHPLANET_REDIRECT_URI を事前登録しておくこと。


@router.get("/healthplanet/login")
async def healthplanet_login(user_id: str):
    # HealthPlanet は state パラメータを callback に返さないため、
    # user_id をリダイレクト URI のパスに埋め込む
    redirect_uri = f"{BACKEND_URL}/api/auth/healthplanet/callback/{user_id}"
    params = {
        "client_id": HEALTHPLANET_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "innerscan,sphygmomanometer,pedometer",
    }
    url = "https://www.healthplanet.jp/oauth/auth?" + urllib.parse.urlencode(params)
    return {"url": url}


class HealthPlanetCodeRequest(BaseModel):
    user_id: str
    code: str


@router.post("/healthplanet/exchange")
async def healthplanet_exchange(req: HealthPlanetCodeRequest, db: Session = Depends(get_db)):
    """Exchange authorization code for access token (manual code entry flow / 旧手動方式)."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://www.healthplanet.jp/oauth/token",
            data={
                "client_id": HEALTHPLANET_CLIENT_ID,
                "client_secret": HEALTHPLANET_CLIENT_SECRET,
                "redirect_uri": HEALTHPLANET_REDIRECT_URI,
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
async def healthplanet_callback_legacy(code: str, state: str | None = None, db: Session = Depends(get_db)):
    """旧コールバック（state経由のuser_id取得）— 後方互換用。"""
    if not state:
        return RedirectResponse(f"{FRONTEND_URL}/me?error=healthplanet_no_state")
    return await _healthplanet_exchange(state, code, HEALTHPLANET_REDIRECT_URI, db)


@router.get("/healthplanet/callback/{user_id}")
async def healthplanet_callback(user_id: str, code: str, db: Session = Depends(get_db)):
    """新コールバック — user_id をパスに埋め込む方式（state不要）。"""
    redirect_uri = f"{BACKEND_URL}/api/auth/healthplanet/callback/{user_id}"
    return await _healthplanet_exchange(user_id, code, redirect_uri, db)


async def _healthplanet_exchange(user_id: str, code: str, redirect_uri: str, db):
    # ユーザーがDBに存在しない場合は登録を促すエラーにリダイレクト
    from .. import models as _m
    if not db.query(_m.User).filter_by(id=user_id).first():
        return RedirectResponse(f"{FRONTEND_URL}/login?error=please_register_first")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://www.healthplanet.jp/oauth/token",
            data={
                "client_id": HEALTHPLANET_CLIENT_ID,
                "client_secret": HEALTHPLANET_CLIENT_SECRET,
                "redirect_uri": redirect_uri,
                "code": code,
                "grant_type": "authorization_code",
            },
        )
    if resp.status_code != 200:
        detail = urllib.parse.quote(resp.text[:200])
        return RedirectResponse(f"{FRONTEND_URL}/me?error=healthplanet_token_{resp.status_code}&detail={detail}")

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

    # ユーザーがDBに存在しない場合は登録を促すエラーにリダイレクト
    if not db.query(models.User).filter_by(id=user_id).first():
        return RedirectResponse(f"{FRONTEND_URL}/login?error=please_register_first")

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
# FatSecret は OAuth 2.0 でユーザー委任を提供しない。
# 食事日記などの private resource は OAuth 1.0a の callback 付き認可を使う。


@router.get("/fatsecret/login")
async def fatsecret_login(user_id: str):
    """OAuth 1.0a request token を取得し、認可 URL を返す。"""
    if not FATSECRET_CONSUMER_KEY or not FATSECRET_CONSUMER_SECRET:
        raise HTTPException(500, "FatSecret OAuth 1.0 credentials are not configured")

    callback_url = FATSECRET_REDIRECT_URI or f"{BACKEND_URL}/api/auth/fatsecret/callback"
    try:
        authorize_url = await fatsecret.begin_user_authorization(callback_url, user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"url": authorize_url, "authorize_url": authorize_url}


@router.get("/fatsecret/request-token")
async def fatsecret_request_token_compat(user_id: str):
    return await fatsecret_login(user_id)


@router.get("/fatsecret/callback")
async def fatsecret_callback(
    oauth_token: str | None = None,
    oauth_verifier: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    """OAuth 1.0a callback を Access Token に交換して DB に保存。"""
    if error:
        return RedirectResponse(f"{FRONTEND_URL}/me?error=fatsecret_{error}")
    if not oauth_token or not oauth_verifier:
        return RedirectResponse(f"{FRONTEND_URL}/me?error=fatsecret_invalid_callback")

    try:
        oauth_result = await fatsecret.complete_user_authorization(
            request_token=oauth_token,
            verifier=oauth_verifier,
        )
    except ValueError as exc:
        detail = urllib.parse.quote(str(exc)[:200])
        return RedirectResponse(
            f"{FRONTEND_URL}/me?error=fatsecret_token_failed&detail={detail}"
        )

    user_id = oauth_result["user_id"]

    # ユーザーがDBに存在しない場合は登録を促すエラーにリダイレクト
    if not db.query(models.User).filter_by(id=user_id).first():
        return RedirectResponse(f"{FRONTEND_URL}/login?error=please_register_first")

    token = db.query(models.OAuthToken).filter_by(user_id=user_id, service="fatsecret").first()
    if not token:
        token = models.OAuthToken(user_id=user_id, service="fatsecret")
        db.add(token)
    token.access_token = security.encrypt(oauth_result["access_token"])
    token.refresh_token = security.encrypt(oauth_result["access_token_secret"])
    token.expires_at = None
    token.extra_json = {"oauth_version": "1.0a", "delegated": True}
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
