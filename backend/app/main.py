import os
import logging
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from .database import engine, Base
from .routers import auth, dashboard, meals, body, settings, meal_plan, group, shopping, chat

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address)
_SERVER_STARTED_AT = datetime.utcnow().isoformat() + "Z"


def _run_migrations():
    """create_all では既存テーブルへのカラム追加ができないため、ALTER TABLE で補完する。"""
    from sqlalchemy import text
    with engine.connect() as conn:
        # meal_plans.conditions_json
        try:
            conn.execute(text(
                "ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS conditions_json JSON"
            ))
        except Exception as e:
            logger.warning("Migration conditions_json skipped: %s", e)
        # meal_plan_slots.source_type / kcal_budget
        try:
            conn.execute(text(
                "ALTER TABLE meal_plan_slots ADD COLUMN IF NOT EXISTS source_type VARCHAR"
            ))
        except Exception as e:
            logger.warning("Migration source_type skipped: %s", e)
        try:
            conn.execute(text(
                "ALTER TABLE meal_plan_slots ADD COLUMN IF NOT EXISTS kcal_budget FLOAT"
            ))
        except Exception as e:
            logger.warning("Migration kcal_budget skipped: %s", e)
        # meal_plan_items に LLM トークン情報・プロンプト
        for col, ddl in [
            ("input_tokens", "ALTER TABLE meal_plan_items ADD COLUMN IF NOT EXISTS input_tokens INTEGER"),
            ("output_tokens", "ALTER TABLE meal_plan_items ADD COLUMN IF NOT EXISTS output_tokens INTEGER"),
            ("llm_model", "ALTER TABLE meal_plan_items ADD COLUMN IF NOT EXISTS llm_model VARCHAR"),
            ("system_prompt", "ALTER TABLE meal_plan_items ADD COLUMN IF NOT EXISTS system_prompt TEXT"),
            ("user_prompt", "ALTER TABLE meal_plan_items ADD COLUMN IF NOT EXISTS user_prompt TEXT"),
            ("byok_model", "ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS byok_model VARCHAR"),
            ("force_free_llm", "ALTER TABLE user_plans ADD COLUMN IF NOT EXISTS force_free_llm BOOLEAN DEFAULT FALSE"),
            ("dashboard_settings_json", "ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_settings_json JSON"),
            ("shared_settings_json", "ALTER TABLE groups ADD COLUMN IF NOT EXISTS shared_settings_json JSON"),
        ]:
            try:
                conn.execute(text(ddl))
            except Exception as e:
                logger.warning("Migration %s skipped: %s", col, e)
        conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


app = FastAPI(title="健康ナビ API", version="1.0.0", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
# Vercel のプレビューデプロイ URL (xxx-git-branch-user.vercel.app, xxx-hash.vercel.app)
# も許可するため正規表現で *.vercel.app を許可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(meals.router, prefix="/api/meals", tags=["meals"])
app.include_router(body.router, prefix="/api/body", tags=["body"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(meal_plan.router, prefix="/api/meal-plans", tags=["meal_plan"])
app.include_router(group.router, prefix="/api/groups", tags=["group"])
app.include_router(shopping.router, prefix="/api/shopping", tags=["shopping"])
app.include_router(chat.router, prefix="/api/chat", tags=["chat"])


@app.get("/health")
async def health():
    """サーバ稼働確認 + 現在動いているコードのコミットハッシュを返す。"""
    import subprocess
    commit = os.getenv("RENDER_GIT_COMMIT") or os.getenv("VERCEL_GIT_COMMIT_SHA") or "unknown"
    if commit == "unknown":
        try:
            commit = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                stderr=subprocess.DEVNULL,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            ).decode().strip()
        except Exception:
            pass
    return {
        "status": "ok",
        "commit": commit[:7] if commit and commit != "unknown" else commit,
        "started_at": _SERVER_STARTED_AT,
    }


def _require_debug_enabled():
    """ENABLE_DEBUG_ENDPOINTS=1 でない限り debug 系を 404 として隠す。"""
    from fastapi import HTTPException
    if os.getenv("ENABLE_DEBUG_ENDPOINTS", "").lower() not in ("1", "true", "yes"):
        raise HTTPException(404, "Not found")


@app.get("/debug/firebase-key")
async def debug_firebase_key():
    """Firebase private_key の形式を診断するエンドポイント。鍵の初期化は行わない。"""
    _require_debug_enabled()
    import base64 as _base64
    import json as _json

    result: dict = {}

    sa_b64 = os.getenv("FIREBASE_SERVICE_ACCOUNT_BASE64", "").strip()
    sa_json_raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")

    result["BASE64_set"] = bool(sa_b64)
    result["JSON_set"] = bool(sa_json_raw)

    sa_json = ""
    if sa_b64:
        try:
            clean = sa_b64.replace(" ", "").replace("\n", "").replace("\r", "")
            result["BASE64_cleaned_length"] = len(clean)
            sa_json = _base64.b64decode(clean).decode("utf-8")
            result["decoded_json_length"] = len(sa_json)
            result["source"] = "BASE64"
        except Exception as e:
            result["BASE64_decode_error"] = str(e)
            return result
    elif sa_json_raw:
        sa_json = sa_json_raw
        result["source"] = "JSON_raw"

    if not sa_json:
        result["error"] = "No credential env var found"
        return result

    try:
        sa_dict = _json.loads(sa_json)
        pk = sa_dict.get("private_key", "")
        result["private_key_length"] = len(pk)
        result["private_key_repr_first80"] = repr(pk[:80])
        backslash_n = "\\" + "n"
        result["has_literal_backslash_n"] = backslash_n in pk
        result["has_real_newlines"] = "\n" in pk
        result["starts_with_begin"] = pk.strip().startswith("-----BEGIN")
        result["ends_with_end"] = pk.strip().endswith("-----")
        result["project_id"] = sa_dict.get("project_id")
        result["client_email_preview"] = sa_dict.get("client_email", "")[:40]
    except Exception as e:
        result["json_parse_error"] = str(e)

    return result


@app.get("/debug/env")
async def debug_env():
    """環境変数の登録状態を確認するためのデバッグエンドポイント。値は秘匿。"""
    _require_debug_enabled()
    sa = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    keys_to_check = [
        "FIREBASE_SERVICE_ACCOUNT_JSON",
        "FRONTEND_URL",
        "BACKEND_URL",
        "FITBIT_CLIENT_ID",
        "FITBIT_REDIRECT_URI",
        "HEALTHPLANET_CLIENT_ID",
        "HEALTHPLANET_REDIRECT_URI",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_REDIRECT_URI",
        "FATSECRET_CONSUMER_KEY",
        "FATSECRET_REDIRECT_URI",
    ]
    result = {}
    for k in keys_to_check:
        v = os.getenv(k, "")
        result[k] = {
            "set": bool(v),
            "length": len(v),
            "first_chars": v[:20] if v else "(empty)",
        }
    # FIREBASE JSON の中身もチェック
    if sa:
        try:
            import json as _json
            parsed = _json.loads(sa)
            result["FIREBASE_SERVICE_ACCOUNT_JSON"]["project_id"] = parsed.get("project_id")
            result["FIREBASE_SERVICE_ACCOUNT_JSON"]["client_email"] = parsed.get("client_email", "")[:30] + "..."
            result["FIREBASE_SERVICE_ACCOUNT_JSON"]["json_valid"] = True
        except Exception as e:
            result["FIREBASE_SERVICE_ACCOUNT_JSON"]["json_valid"] = False
            result["FIREBASE_SERVICE_ACCOUNT_JSON"]["parse_error"] = str(e)
    return result
