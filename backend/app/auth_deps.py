import os
import json
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth

from .database import get_db
from . import models

bearer_scheme = HTTPBearer()

_firebase_initialized = False


def _init_firebase():
    global _firebase_initialized
    if _firebase_initialized:
        return
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "{}")
    try:
        sa_dict = json.loads(sa_json)
        if sa_dict:
            cred = credentials.Certificate(sa_dict)
            firebase_admin.initialize_app(cred)
        else:
            # Dev mode: skip Firebase, accept any token as user_id
            pass
    except Exception:
        pass
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
        try:
            decoded = firebase_auth.verify_id_token(token)
            uid = decoded["uid"]
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication token",
            )

    user = db.query(models.User).filter(models.User.id == uid).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user
