import os
import json
import logging
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth

from .database import get_db
from . import models

logger = logging.getLogger("auth_deps")
logger.setLevel(logging.INFO)

bearer_scheme = HTTPBearer()

_firebase_initialized = False
_firebase_init_error = None


def _init_firebase():
    global _firebase_initialized, _firebase_init_error
    if _firebase_initialized:
        return

    # 1) Base64エンコード版を優先（Renderなど環境変数で改行が壊れる対策）
    sa_b64 = os.getenv("FIREBASE_SERVICE_ACCOUNT_BASE64", "")
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")

    if sa_b64:
        try:
            import base64
            # Render等で改行/空白が混入した場合に備えてクリーニング
            sa_b64_clean = sa_b64.strip().replace(" ", "").replace("\n", "").replace("\r", "")
            logger.info(f"BASE64 env var length (cleaned): {len(sa_b64_clean)}")
            sa_json = base64.b64decode(sa_b64_clean).decode("utf-8")
            logger.info(f"Decoded JSON length: {len(sa_json)}")
        except Exception as e:
            _firebase_init_error = f"Failed to decode BASE64: {e}"
            logger.error(_firebase_init_error)
            _firebase_initialized = True
            return

    if not sa_json:
        _firebase_init_error = "Neither FIREBASE_SERVICE_ACCOUNT_BASE64 nor FIREBASE_SERVICE_ACCOUNT_JSON is set"
        logger.warning(_firebase_init_error)
        _firebase_initialized = True
        return

    try:
        sa_dict = json.loads(sa_json)
        pk = sa_dict.get("private_key", "")
        # repr()で \n が実際の改行か文字列かを判別できるようログ出力
        logger.info(f"private_key repr[:80]: {repr(pk[:80])}")

        # private_key の \n が文字列 \n のままの場合、実際の改行に置換
        backslash_n = "\\" + "n"
        if backslash_n in pk:
            sa_dict["private_key"] = pk.replace(backslash_n, "\n")
            pk = sa_dict["private_key"]
            logger.info("Applied backslash-n -> newline replacement")
        else:
            logger.info("private_key already has real newlines (no replacement needed)")

        logger.info(f"private_key after fix repr[:80]: {repr(pk[:80])}")
        cred = credentials.Certificate(sa_dict)
        firebase_admin.initialize_app(cred)
        logger.info(f"Firebase initialized for project: {sa_dict.get('project_id')}")
    except Exception as e:
        _firebase_init_error = f"Firebase init failed: {type(e).__name__}: {e}"
        logger.error(_firebase_init_error)
    _firebase_initialized = True


def require_firebase_admin():
    _init_firebase()
    if _firebase_init_error:
        logger.error(f"Firebase admin unavailable: {_firebase_init_error}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Firebase not configured: {_firebase_init_error}",
        )
    return firebase_auth


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    _init_firebase()
    token = credentials.credentials

    # Dev fallback: if token is a plain UID (no dots), skip Firebase verification
    if "." not in token:
        uid = token
    else:
        if _firebase_init_error:
            logger.error(f"Cannot verify token, firebase not init: {_firebase_init_error}")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Firebase not configured: {_firebase_init_error}",
            )
        try:
            decoded = firebase_auth.verify_id_token(token)
            uid = decoded["uid"]
        except Exception as e:
            logger.error(f"Token verify failed: {type(e).__name__}: {e}")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid authentication token: {type(e).__name__}",
            )

    user = db.query(models.User).filter(models.User.id == uid).first()
    if not user:
        logger.warning(f"User row not found in DB for uid={uid}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"User not found in DB (uid={uid[:8]}...). Please re-register.",
        )
    return user
