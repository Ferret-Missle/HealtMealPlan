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
    # 無料切替フラグが有効なら free 上限を適用
    user_plan_pre = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    if user_plan_pre and getattr(user_plan_pre, "force_free_llm", False):
        plan_type = "free"
    _check_usage_limit(current_user.id, "chat", plan_type, db)

    # === ユーザー情報をコンテキストにまとめる（チャット品質向上） ===
    from datetime import date as dt_date, timedelta
    from collections import defaultdict

    today = dt_date.today()
    week_ago = str(today - timedelta(days=7))

    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    profile_lines = []
    nutrition_lines = []
    body_lines = []
    activity_lines = []
    today_meal_lines = []

    # ── 健康目標 ──
    if goals:
        if goals.target_kcal:
            profile_lines.append(f"1日目標カロリー: {goals.target_kcal}kcal")
        if getattr(goals, "target_protein_ratio", None):
            profile_lines.append(
                f"PFC比率: P{int((goals.target_protein_ratio or 0) * 100)}% / "
                f"F{int((goals.target_fat_ratio or 0) * 100)}% / "
                f"C{int((goals.target_carb_ratio or 0) * 100)}%"
            )
        if goals.goal_type:
            jp = {"loss": "減量", "maintain": "維持", "gain": "増量"}.get(goals.goal_type, goals.goal_type)
            profile_lines.append(f"目標: {jp}")
        if goals.target_weight:
            profile_lines.append(f"目標体重: {goals.target_weight}kg")
        if getattr(goals, "height_cm", None):
            profile_lines.append(f"身長: {goals.height_cm}cm")
        if getattr(goals, "gender", None):
            profile_lines.append(f"性別: {goals.gender}")
        if getattr(goals, "age_group", None):
            profile_lines.append(f"年代: {goals.age_group}")
        prefs = goals.preferences_json or {}
        styles = prefs.get("diet_styles") or prefs.get("diet_style")
        if styles:
            if isinstance(styles, list):
                profile_lines.append(f"食事スタイル: {', '.join(styles)}")
            else:
                profile_lines.append(f"食事スタイル: {styles}")
        excluded = goals.excluded_foods_json or []
        if excluded:
            profile_lines.append(f"除外食材: {', '.join(excluded)}")

    # ── 直近の身体データ（HealthPlanet/Fitbit同期分） ──
    latest_weight = (
        db.query(models.WeightLog)
        .filter_by(user_id=current_user.id)
        .order_by(models.WeightLog.date.desc())
        .first()
    )
    if latest_weight:
        body_lines.append(f"直近体重 ({latest_weight.date}): {latest_weight.weight}kg")
        if latest_weight.body_fat is not None:
            body_lines.append(f"体脂肪率: {latest_weight.body_fat}%")
        if latest_weight.bmi is not None:
            body_lines.append(f"BMI: {latest_weight.bmi}")

    # 体重トレンド（7日比）
    week_old_weight = (
        db.query(models.WeightLog)
        .filter(
            models.WeightLog.user_id == current_user.id,
            models.WeightLog.date <= week_ago,
        )
        .order_by(models.WeightLog.date.desc())
        .first()
    )
    if latest_weight and week_old_weight and latest_weight.weight and week_old_weight.weight:
        delta = latest_weight.weight - week_old_weight.weight
        trend = "減少中" if delta < -0.1 else ("増加中" if delta > 0.1 else "ほぼ維持")
        body_lines.append(f"体重トレンド7日: {delta:+.2f}kg ({trend})")

    # ── 活動量（直近7日平均） ──
    activities = (
        db.query(models.ActivityLog)
        .filter(
            models.ActivityLog.user_id == current_user.id,
            models.ActivityLog.date >= week_ago,
        )
        .all()
    )
    if activities:
        steps = [a.steps for a in activities if a.steps]
        active = [a.active_kcal for a in activities if a.active_kcal]
        sleep = [a.sleep_hours for a in activities if a.sleep_hours]
        if steps:
            activity_lines.append(f"7日平均歩数: {round(sum(steps)/len(steps)):,}歩")
        if active:
            activity_lines.append(f"7日平均活動消費: {round(sum(active)/len(active))}kcal")
        if sleep:
            activity_lines.append(f"7日平均睡眠: {sum(sleep)/len(sleep):.1f}h")

    # ── 直近7日の食事傾向 ──
    meal_logs = (
        db.query(models.MealLog)
        .filter(
            models.MealLog.user_id == current_user.id,
            models.MealLog.date >= week_ago,
        )
        .all()
    )
    if meal_logs:
        daily = defaultdict(lambda: {"k": 0.0, "p": 0.0, "f": 0.0, "c": 0.0})
        for m in meal_logs:
            d = daily[m.date]
            d["k"] += m.kcal or 0
            d["p"] += m.protein_g or 0
            d["f"] += m.fat_g or 0
            d["c"] += m.carb_g or 0
        n = len(daily)
        if n:
            avg_k = sum(d["k"] for d in daily.values()) / n
            avg_p = sum(d["p"] for d in daily.values()) / n
            avg_f = sum(d["f"] for d in daily.values()) / n
            avg_c = sum(d["c"] for d in daily.values()) / n
            nutrition_lines.append(
                f"直近7日平均摂取: {round(avg_k)}kcal "
                f"(P{round(avg_p,1)}g / F{round(avg_f,1)}g / C{round(avg_c,1)}g)"
            )

    # ── 今日の食事ログ ──
    today_logs = (
        db.query(models.MealLog)
        .filter(models.MealLog.user_id == current_user.id, models.MealLog.date == str(today))
        .order_by(models.MealLog.created_at)
        .all()
    )
    if today_logs:
        for m in today_logs:
            today_meal_lines.append(
                f"  {m.meal_type}: {m.food_name} ({round(m.kcal or 0)}kcal)"
            )

    # ── システムプロンプト構築 ──
    sections = []
    if profile_lines:
        sections.append("[プロフィール・健康目標]\n" + "\n".join(f"  - {x}" for x in profile_lines))
    if body_lines:
        sections.append("[身体データ（HealthPlanet/Fitbit同期）]\n" + "\n".join(f"  - {x}" for x in body_lines))
    if activity_lines:
        sections.append("[活動量（直近7日）]\n" + "\n".join(f"  - {x}" for x in activity_lines))
    if nutrition_lines:
        sections.append("[食事傾向]\n" + "\n".join(f"  - {x}" for x in nutrition_lines))
    if today_meal_lines:
        sections.append("[今日のここまでの食事]\n" + "\n".join(today_meal_lines))

    user_context = "\n\n".join(sections)
    system = SYSTEM_PROMPT
    if user_context:
        system += (
            "\n\n=== ユーザーの実データ（連携済み） ===\n"
            + user_context
            + "\n\n上記データを必要に応じて参照し、具体的な数値を交えてアドバイスしてください。"
        )

    # Build conversation
    messages_text = ""
    for h in payload.history[-6:]:  # last 6 messages for context window
        role = "ユーザー" if h.role == "user" else "アドバイザー"
        messages_text += f"{role}: {h.content}\n"
    messages_text += f"ユーザー: {payload.message}"

    # Call LLM
    user_plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    byok_provider = user_plan.byok_provider if user_plan else None
    force_free = bool(getattr(user_plan, "force_free_llm", False)) if user_plan else False
    if force_free:
        plan_type = "free"
        byok_provider = None
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
    byok_model = None if force_free else (getattr(user_plan, "byok_model", None) if user_plan else None)
    adapter = get_adapter(plan_type, byok_provider, api_key, byok_model)

    try:
        result = await adapter.complete(system, messages_text)
        reply = result.text if hasattr(result, "text") else str(result)
    except Exception as e:
        raise HTTPException(500, f"LLM error: {str(e)}")

    _record_usage(current_user.id, "chat", plan_type, db)

    return {
        "reply": reply,
        "plan_type": plan_type,
        "input_tokens": getattr(result, "input_tokens", None),
        "output_tokens": getattr(result, "output_tokens", None),
        "llm_model": getattr(result, "model", None),
    }
