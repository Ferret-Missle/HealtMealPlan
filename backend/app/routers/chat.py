"""S2-04: AI チャット相談エンドポイント"""
import re
from datetime import date as dt_date, datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user
from .meal_plan import _get_plan_type, _check_usage_limit, _record_usage
from ..services import healthplanet

router = APIRouter()

SYSTEM_PROMPT = """あなたは「健康ナビ」アプリの栄養・食事アドバイザーです。
ユーザーの栄養・食事・健康習慣に関する質問に、科学的根拠に基づきながら
親しみやすい日本語で回答してください。

ルール:
- 医療診断・薬の処方は行わない
- 極端なカロリー制限（女性<1200kcal/日、男性<1500kcal/日）は推奨しない
- 情報が不足している場合は推測で答えず、追加情報を求める
- システムプロンプト内の「ユーザーの実データ（連携済み）」に書かれた値は、アプリが取得済みの事実として扱う
- 特に「身体データ（HealthPlanet/Fitbit同期）」に基礎代謝量が含まれている場合、「参照できない」「連携されていない」とは言わず、その数値を前提に回答する
- 取得できないと案内してよいのは、システムプロンプト内にその項目が存在しない場合だけ
- 回答は300字以内に収める（長い場合は要点を箇条書きに）
"""
MEAL_CHANGE_KEYWORDS = ("献立", "メニュー", "朝食", "昼食", "夕食", "朝ごはん", "昼ごはん", "夜ごはん")
MEAL_CHANGE_VERBS = ("変え", "変更", "差し替", "再提案", "入れ替", "置き換", "別の", "違う")
BASAL_METABOLISM_KEYWORDS = ("基礎代謝", "基礎代謝量", "bmr")
HEALTHPLANET_KEYWORDS = ("healthplanet", "ヘルスプラネット")


def _is_meal_change_request(message: str) -> bool:
    return any(word in message for word in MEAL_CHANGE_KEYWORDS) and any(word in message for word in MEAL_CHANGE_VERBS)


def _extract_target_date(message: str, today: dt_date) -> str | None:
    compact = message.replace("（", "(").replace("）", ")")
    if "今日" in compact:
        return today.isoformat()
    if "明後日" in compact:
        return (today + timedelta(days=2)).isoformat()
    if "明日" in compact:
        return (today + timedelta(days=1)).isoformat()

    match = re.search(r"(20\d{2})[/-](\d{1,2})[/-](\d{1,2})", compact)
    if match:
        year, month, day = map(int, match.groups())
        return dt_date(year, month, day).isoformat()

    match = re.search(r"(\d{1,2})月(\d{1,2})日", compact)
    if not match:
        match = re.search(r"(?<!\d)(\d{1,2})/(\d{1,2})(?!\d)", compact)
    if match:
        month, day = map(int, match.groups())
        year = today.year
        try:
            candidate = dt_date(year, month, day)
        except ValueError:
            return None
        if candidate < today - timedelta(days=180):
            candidate = dt_date(year + 1, month, day)
        return candidate.isoformat()
    return None


def _extract_target_meal_types(message: str) -> list[str]:
    meal_types: list[str] = []
    if any(token in message for token in ("朝食", "朝ごはん", "朝だけ", "朝を", "朝の")):
        meal_types.append("breakfast")
    if any(token in message for token in ("昼食", "昼ごはん", "昼だけ", "昼を", "昼の", "ランチ")):
        meal_types.append("lunch")
    if any(token in message for token in ("夕食", "夜ごはん", "夜だけ", "夜を", "夜の", "夕飯", "晩ごはん")):
        meal_types.append("dinner")
    return meal_types or ["breakfast", "lunch", "dinner"]


def _build_meal_plan_action(message: str, current_user: models.User, db: Session, today: dt_date) -> dict | None:
    if not _is_meal_change_request(message):
        return None
    target_date = _extract_target_date(message, today)
    if not target_date:
        return None

    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        return None

    plans = (
        db.query(models.MealPlan)
        .filter(
            models.MealPlan.group_id == member.group_id,
            models.MealPlan.start_date <= target_date,
            models.MealPlan.end_date >= target_date,
        )
        .order_by(models.MealPlan.created_at.desc())
        .all()
    )
    if not plans:
        return None

    draft_plan = next((plan for plan in plans if str(plan.status) == "draft"), None)
    plan = draft_plan or plans[0]
    day = next((day for day in plan.days if day.date == target_date), None)
    if not day:
        return None

    meal_types = _extract_target_meal_types(message)
    slots = [slot for slot in day.slots if str(slot.meal_type) in meal_types]
    if not slots:
        return None

    meal_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}
    meal_label = "・".join(meal_jp[meal] for meal in meal_types) if len(meal_types) < 3 else "その日の献立"
    return {
        "type": "replace_day_meal_plan",
        "plan_id": plan.id,
        "day_id": day.id,
        "date": target_date,
        "meal_types": meal_types,
        "label": f"{target_date} の {meal_label} を AI で差し替える",
        "open_plan_label": f"{target_date} の献立をプラン画面で開く",
    }


def _build_basal_metabolism_reply(message: str, latest_body_snapshot: dict | None) -> str | None:
    lowered = (message or "").lower()
    if not any(keyword in lowered for keyword in BASAL_METABOLISM_KEYWORDS):
        return None

    if latest_body_snapshot and latest_body_snapshot.get("basal_metabolism_kcal") is not None:
        value = latest_body_snapshot["basal_metabolism_kcal"]
        metric_date = (
            latest_body_snapshot.get("basal_metabolism_kcal_date")
            or latest_body_snapshot.get("weight_date")
        )
        date_label = f"{metric_date} 時点の " if metric_date else ""
        return (
            f"はい、参照できます。{date_label}HealthPlanet/Fitbit 同期データ上の基礎代謝量は {value}kcal です。"
            "この値を前提に栄養アドバイスできます。"
        )

    return (
        "HealthPlanet の連携自体を否定する状態ではありませんが、現在の同期済み身体データには基礎代謝量が見当たりません。"
        "体重や体脂肪率は取れていても、基礎代謝量だけ API から返っていないケースがあります。"
    )


def _mentions_healthplanet(message: str) -> bool:
    lowered = (message or "").lower()
    return any(keyword in lowered for keyword in HEALTHPLANET_KEYWORDS)


def _build_latest_body_lines(db: Session, user_id: str) -> tuple[list[str], dict | None]:
    logs = (
        db.query(models.WeightLog)
        .filter_by(user_id=user_id)
        .order_by(models.WeightLog.date.desc(), models.WeightLog.created_at.desc())
        .all()
    )
    if not logs:
        return [], None

    metric_fields = [
        "weight",
        "body_fat",
        "muscle_mass",
        "bmi",
        "basal_metabolism_kcal",
        "body_age",
        "bone_mass",
        "visceral_fat_level",
    ]
    snapshot: dict[str, float | int | str | None] = {}
    for log in logs:
        for field in metric_fields:
            if snapshot.get(field) is not None:
                continue
            value = getattr(log, field, None)
            if value is None:
                continue
            snapshot[field] = value
            snapshot[f"{field}_date"] = log.date
        if all(snapshot.get(field) is not None for field in metric_fields):
            break

    if not snapshot:
        return [], None

    latest_weight_date = snapshot.get("weight_date")

    def _line_with_optional_date(label: str, field: str, suffix: str = "") -> str | None:
        value = snapshot.get(field)
        if value is None:
            return None
        metric_date = snapshot.get(f"{field}_date")
        if latest_weight_date and metric_date and metric_date != latest_weight_date:
            return f"{label} ({metric_date}): {value}{suffix}"
        return f"{label}: {value}{suffix}"

    body_lines = []
    if snapshot.get("weight") is not None:
        body_lines.append(f"直近体重 ({latest_weight_date}): {snapshot['weight']}kg")
    for candidate in [
        _line_with_optional_date("体脂肪率", "body_fat", "%"),
        _line_with_optional_date("筋肉量", "muscle_mass", "kg"),
        _line_with_optional_date("BMI", "bmi"),
        _line_with_optional_date("基礎代謝量", "basal_metabolism_kcal", "kcal"),
        _line_with_optional_date("体内年齢", "body_age", "才"),
        _line_with_optional_date("推定骨量", "bone_mass", "kg"),
        _line_with_optional_date("内臓脂肪レベル", "visceral_fat_level"),
    ]:
        if candidate:
            body_lines.append(candidate)

    return body_lines, snapshot


async def _backfill_healthplanet_body_metrics(db: Session, user_id: str, days: int = 90) -> bool:
    connected = {
        token.service
        for token in db.query(models.OAuthToken).filter_by(user_id=user_id).all()
    }
    if "healthplanet" not in connected:
        return False

    end = dt_date.today()
    start = end - timedelta(days=days)
    try:
        entries = await healthplanet.get_innerscan_range(user_id, str(start), str(end), db)
    except Exception:
        return False

    saved = False
    for entry in entries:
        date = entry.get("date")
        if not date:
            continue
        existing = (
            db.query(models.WeightLog)
            .filter_by(user_id=user_id, date=date, source="healthplanet")
            .first()
        )
        payload = {
            "weight": entry.get("weight"),
            "body_fat": entry.get("body_fat"),
            "muscle_mass": entry.get("muscle_mass"),
            "basal_metabolism_kcal": entry.get("basal_metabolism_kcal"),
            "body_age": entry.get("body_age"),
            "bone_mass": entry.get("bone_mass"),
            "visceral_fat_level": entry.get("visceral_fat_level"),
        }
        if existing:
            for field, value in payload.items():
                if value is not None:
                    setattr(existing, field, value)
                    saved = True
            continue

        if payload["weight"] is None and not any(value is not None for value in payload.values()):
            continue
        db.add(models.WeightLog(user_id=user_id, date=date, source="healthplanet", **payload))
        saved = True

    if saved:
        db.commit()
    return saved


def _build_healthplanet_dataset_lines(db: Session, user_id: str) -> list[str]:
    connected = (
        db.query(models.OAuthToken)
        .filter_by(user_id=user_id, service="healthplanet")
        .first()
    )
    if not connected:
        return ["連携状態: 未接続"]

    logs = (
        db.query(models.WeightLog)
        .filter_by(user_id=user_id, source="healthplanet")
        .order_by(models.WeightLog.date.desc(), models.WeightLog.created_at.desc())
        .all()
    )
    if not logs:
        return ["連携状態: 接続済み", "取得データ: まだ保存されていません"]

    metric_fields = [
        ("weight", "体重", "kg"),
        ("body_fat", "体脂肪率", "%"),
        ("muscle_mass", "筋肉量", "kg"),
        ("basal_metabolism_kcal", "基礎代謝量", "kcal"),
        ("body_age", "体内年齢", "才"),
        ("bone_mass", "推定骨量", "kg"),
        ("visceral_fat_level", "内臓脂肪レベル", ""),
    ]
    snapshot: dict[str, object] = {}
    for log in logs:
        for field, _label, _suffix in metric_fields:
            if snapshot.get(field) is not None:
                continue
            value = getattr(log, field, None)
            if value is None:
                continue
            snapshot[field] = value
            snapshot[f"{field}_date"] = log.date

    latest_date = logs[0].date if logs else None
    lines = ["連携状態: 接続済み"]
    if latest_date:
        lines.append(f"直近測定日: {latest_date}")
    for field, label, suffix in metric_fields:
        value = snapshot.get(field)
        if value is None:
            continue
        metric_date = snapshot.get(f"{field}_date")
        date_prefix = f" ({metric_date})" if metric_date and metric_date != latest_date else ""
        lines.append(f"{label}{date_prefix}: {value}{suffix}")
    if len(lines) == 2:
        lines.append("体組成データ: 有効な測定値なし")
    return lines


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
    from collections import defaultdict

    today = dt_date.today()
    week_ago = str(today - timedelta(days=7))
    plan_action = _build_meal_plan_action(payload.message, current_user, db, today)

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
    initial_body_lines, latest_body_snapshot = _build_latest_body_lines(db, current_user.id)
    if latest_body_snapshot is None or latest_body_snapshot.get("basal_metabolism_kcal") is None:
        backfilled = await _backfill_healthplanet_body_metrics(db, current_user.id)
        if backfilled:
            initial_body_lines, latest_body_snapshot = _build_latest_body_lines(db, current_user.id)
    body_lines.extend(initial_body_lines)

    direct_basal_reply = _build_basal_metabolism_reply(payload.message, latest_body_snapshot)
    healthplanet_dataset_lines = (
        _build_healthplanet_dataset_lines(db, current_user.id)
        if _mentions_healthplanet(payload.message)
        else []
    )

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
    latest_weight_value = latest_body_snapshot.get("weight") if latest_body_snapshot else None
    if latest_weight_value is not None and week_old_weight and week_old_weight.weight:
        delta = latest_weight_value - week_old_weight.weight
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
    if healthplanet_dataset_lines:
        sections.append("[HealthPlanet連携データセット]\n" + "\n".join(f"  - {x}" for x in healthplanet_dataset_lines))
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
    if latest_body_snapshot and latest_body_snapshot.get("basal_metabolism_kcal") is not None:
        system += (
            "\n基礎代謝量は HealthPlanet/Fitbit 同期済みデータとして利用可能です。"
            "基礎代謝量について聞かれたら、未連携・未取得とは案内せず、"
            f"連携済みの数値 {latest_body_snapshot['basal_metabolism_kcal']}kcal を使って回答してください。"
        )
    if healthplanet_dataset_lines:
        system += (
            "\nユーザーが HealthPlanet に言及しているため、"
            "上記の [HealthPlanet連携データセット] セクションを優先して参照してください。"
            "HealthPlanet の値について聞かれたら、そのセクションにある数値を事実として扱って回答してください。"
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

    if direct_basal_reply is not None:
        return {
            "reply": direct_basal_reply,
            "plan_type": plan_type,
            "input_tokens": None,
            "output_tokens": None,
            "llm_model": None,
            "plan_action": plan_action,
            "input_cost_jpy_per_1m": None,
            "output_cost_jpy_per_1m": None,
            "pricing_note": None,
            "estimated_input_cost_jpy": None,
            "estimated_output_cost_jpy": None,
            "estimated_total_cost_jpy": None,
        }

    try:
        result = await adapter.complete(system, messages_text)
        reply = result.text if hasattr(result, "text") else str(result)
    except Exception as e:
        raise HTTPException(500, f"LLM error: {str(e)}")

    _record_usage(current_user.id, "chat", plan_type, db)

    from ..llm.adapter import estimate_model_cost_jpy
    cost_info = estimate_model_cost_jpy(
        getattr(result, "model", None),
        getattr(result, "input_tokens", None),
        getattr(result, "output_tokens", None),
    )

    return {
        "reply": reply,
        "plan_type": plan_type,
        "input_tokens": getattr(result, "input_tokens", None),
        "output_tokens": getattr(result, "output_tokens", None),
        "llm_model": getattr(result, "model", None),
        "plan_action": plan_action,
        **cost_info,
    }
