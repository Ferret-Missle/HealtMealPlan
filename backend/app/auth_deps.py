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
            sa_json = base64.b64decode(sa_b64).decode("utf-8")
            logger.info("Loaded Firebase credentials from BASE64 env var")
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
        # private_key の \n が文字列 \n のままの場合、実際の改行に置換
        if "private_key" in sa_dict and "\\n" in sa_dict["private_key"]:
            sa_dict["private_key"] = sa_dict["private_key"].replace("\\n", "\n")
        cred = credentials.Certificate(sa_dict)
        firebase_admin.initialize_app(cred)
        logger.info(f"Firebase initialized for project: {sa_dict.get('project_id')}")
    except Exception as e:
        _firebase_init_error = f"Firebase init failed: {type(e).__name__}: {e}"
        logger.error(_firebase_init_error)
    _firebase_initialized = True


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
