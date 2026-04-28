"""S2-04: AI チャット相談エンドポイント"""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user
from .meal_plan import _get_plan_type, _check_usage_limit, _record_usage

router = APIRouter()

SYSTEM_PROMPT = """あなたは「健康ナビ」アプリの栄養・食事アドバイザーです。
ユーザーの栄養・食事・健康習慣に関する質問に、科学的根拠に基づきながら
親しみやすい日本語で回答してください。

ルール:
- 医療診断・薬の処方は行わない
- 極端なカロリー制限（女性<1200kcal/日、男性<1500kcal/日）は推奨しない
- 情報が不足している場合は推測で答えず、追加情報を求める
- 回答は300字以内に収める（長い場合は要点を箇条書きに）
"""


class ChatMessage(BaseModel):
    message: str


class ChatHistory(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatHistory] = []


@router.post("/")
async def chat(
    payload: ChatRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "chat", plan_type, db)

    # Get user context (anonymized)
    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    prefs = db.query(models.UserPreferences).filter_by(user_id=current_user.id).first()

    context_parts = []
    if goals:
        context_parts.append(f"目標カロリー: {goals.target_kcal}kcal/日")
        if goals.goal_type:
            context_parts.append(f"目標タイプ: {goals.goal_type}")
    if prefs:
        if prefs.diet_styles:
            context_parts.append(f"食事スタイル: {', '.join(prefs.diet_styles)}")
        if prefs.excluded_foods:
            context_parts.append(f"除外食材: {', '.join(prefs.excluded_foods)}")

    user_context = "\n".join(context_parts)
    system = SYSTEM_PROMPT
    if user_context:
        system += f"\n\nユーザー情報（参考）:\n{user_context}"

    # Build conversation
    messages_text = ""
    for h in payload.history[-6:]:  # last 6 messages for context window
        role = "ユーザー" if h.role == "user" else "アドバイザー"
        messages_text += f"{role}: {h.content}\n"
    messages_text += f"ユーザー: {payload.message}"

    # Call LLM
    user_plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    byok_provider = user_plan.byok_provider if user_plan else None
    api_key_row = None
    if byok_provider:
        api_key_row = (
            db.query(models.ApiKey)
            .filter_by(user_id=current_user.id, provider=byok_provider)
            .first()
        )

    from ..llm.adapter import get_adapter
    from ..security import decrypt
    api_key = decrypt(api_key_row.encrypted_key) if api_key_row else None
    adapter = get_adapter(plan_type, byok_provider, api_key)

    try:
        reply = await adapter.complete(system, messages_text)
    except Exception as e:
        raise HTTPException(500, f"LLM error: {str(e)}")

    _record_usage(current_user.id, "chat", plan_type, db)

    return {
        "reply": reply,
        "plan_type": plan_type,
    }
