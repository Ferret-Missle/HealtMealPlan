import uuid
from datetime import date as dt_date, timedelta
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from pydantic import BaseModel

from ..database import SessionLocal, get_db
from .. import models
from ..auth_deps import get_current_user

router = APIRouter()

MENU_FEEDBACK_LIMIT = 50


async def _run_generation_bg(plan_id: str, user_id: str, conditions: dict):
    """バックグラウンドで献立生成を実行。独自の DB セッションを使う。"""
    from ..services import meal_planner
    db = SessionLocal()
    try:
        await meal_planner.generate_menus(plan_id, user_id, db, conditions)
    except Exception as e:
        # 進捗をエラーとして記録
        try:
            plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
            if plan:
                cond = dict(plan.conditions_json or {})
                cond["_progress"] = {
                    "step": 0,
                    "total": 0,
                    "message": f"エラーが発生しました: {str(e)[:200]}",
                    "done": True,
                    "error": True,
                }
                plan.conditions_json = cond
                flag_modified(plan, "conditions_json")
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


@router.get("/")
async def list_meal_plans(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        return []
    plans = (
        db.query(models.MealPlan)
        .filter_by(group_id=member.group_id)
        .order_by(models.MealPlan.start_date.desc())
        .limit(10)
        .all()
    )
    return [_plan_summary(p) for p in plans]


@router.get("/{plan_id}")
async def get_meal_plan(
    plan_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    return _plan_detail(plan, current_user.id, db)


class MemberDayCondition(BaseModel):
    user_id: str
    breakfast: str = "conbini"   # conbini | bento | homecook
    lunch: str = "conbini"
    dinner: str = "homecook"
    light_breakfast: bool = False


class DayCondition(BaseModel):
    date: str  # YYYY-MM-DD
    members: list[MemberDayCondition] = []


class FrequentMenus(BaseModel):
    breakfast: list[str] = []
    lunch: list[str] = []
    dinner: list[str] = []


class GeneratePlanRequest(BaseModel):
    start_date: str
    days: int = 7
    day_conditions: list[DayCondition] = []
    # { user_id: { breakfast: [...], lunch: [...], dinner: [...] } }
    frequent_menus: dict[str, FrequentMenus] = {}


def _calc_kcal_budget(meal_type: str, target_kcal: int | None, light_breakfast: bool) -> float | None:
    """単一食事の単純配分（互換用）。ソース未考慮。"""
    if not target_kcal:
        return None
    if light_breakfast:
        ratios = {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}
    else:
        ratios = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}
    return round(target_kcal * ratios.get(meal_type, 0.33))


# meal_planner.SOURCE_KCAL_FACTOR と同じ：drink_only は標準の30%
_SOURCE_KCAL_FACTOR = {"drink_only": 0.30, "conbini": 1.0, "bento": 1.0, "homecook": 1.0}


def _calc_day_kcal_budgets(
    target_kcal: int | None,
    light_breakfast: bool,
    day_sources: dict[str, str],
) -> dict[str, float | None]:
    """1日3食を一度に計算。drink_only の食事は圧縮し、減った分を他の食事へ再分配。"""
    if not target_kcal:
        return {"breakfast": None, "lunch": None, "dinner": None}
    if light_breakfast:
        base = {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}
    else:
        base = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}
    weights = {
        m: base[m] * _SOURCE_KCAL_FACTOR.get(day_sources.get(m), 1.0)
        for m in ("breakfast", "lunch", "dinner")
    }
    total = sum(weights.values())
    if total <= 0:
        return {m: round(target_kcal * base[m]) for m in base}
    return {m: round(target_kcal * (w / total)) for m, w in weights.items()}


def _resolve_source_for_slot(meal_type: str, day_date: str, day_conditions: list[DayCondition]) -> str:
    """Get majority source_type for a slot from per-member day conditions."""
    from collections import Counter
    day_cond = next((d for d in day_conditions if d.date == day_date), None)
    if not day_cond or not day_cond.members:
        return "homecook" if meal_type == "dinner" else "conbini"
    sources = [getattr(m, meal_type, None) for m in day_cond.members]
    sources = [s for s in sources if s]
    if not sources:
        return "homecook" if meal_type == "dinner" else "conbini"
    return Counter(sources).most_common(1)[0][0]


def _resolve_light_breakfast_for_slot(day_date: str, day_conditions: list[DayCondition]) -> bool:
    """Return True if any member has light_breakfast set for this day."""
    day_cond = next((d for d in day_conditions if d.date == day_date), None)
    if not day_cond:
        return False
    return any(m.light_breakfast for m in day_cond.members)


@router.post("/generate")
async def generate_meal_plan(
    payload: GeneratePlanRequest,
    background_tasks: BackgroundTasks,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    member = db.query(models.GroupMember).filter_by(user_id=current_user.id).first()
    if not member:
        raise HTTPException(400, "No group found")

    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "meal_plan_weekly", plan_type, db)

    end_date = str(
        dt_date.fromisoformat(payload.start_date) + timedelta(days=payload.days - 1)
    )

    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    target_kcal = goals.target_kcal if goals else None

    conditions_json = {
        "day_conditions": [dc.model_dump() for dc in payload.day_conditions],
        "frequent_menus": {uid: fm.model_dump() for uid, fm in payload.frequent_menus.items()},
    }

    plan_id = str(uuid.uuid4())
    plan = models.MealPlan(
        id=plan_id,
        group_id=member.group_id,
        start_date=payload.start_date,
        end_date=end_date,
        status=models.PlanStatus.draft,
        conditions_json=conditions_json,
    )
    db.add(plan)

    total_slots = 0
    for i in range(payload.days):
        day_date = str(dt_date.fromisoformat(payload.start_date) + timedelta(days=i))
        day_id = str(uuid.uuid4())
        day = models.MealPlanDay(id=day_id, meal_plan_id=plan_id, date=day_date)
        db.add(day)

        # 1日分のソースをまず確定（kcal配分の正規化に使用）
        light_breakfast = _resolve_light_breakfast_for_slot(day_date, payload.day_conditions)
        day_sources = {
            mt: _resolve_source_for_slot(mt, day_date, payload.day_conditions)
            for mt in ("breakfast", "lunch", "dinner")
        }
        day_kcals = _calc_day_kcal_budgets(target_kcal, light_breakfast, day_sources)

        for meal_type in ["breakfast", "lunch", "dinner"]:
            slot_id = str(uuid.uuid4())
            source = day_sources[meal_type]
            sharing = "shared" if meal_type == "dinner" and source == "homecook" else "individual"

            slot = models.MealPlanSlot(
                id=slot_id,
                meal_plan_day_id=day_id,
                meal_type=meal_type,
                sharing_type=sharing,
                source_type=source,
                kcal_budget=day_kcals[meal_type],
            )
            db.add(slot)
            total_slots += 1

    # 初期進捗を書き込み（フロントが即座にローディング画面に遷移できるよう）
    conditions_json_with_progress = {
        **conditions_json,
        "_progress": {
            "step": 0,
            "total": total_slots,
            "message": "🚀 献立生成を開始しています...",
            "done": False,
            "error": False,
        },
    }
    plan.conditions_json = conditions_json_with_progress
    flag_modified(plan, "conditions_json")
    db.commit()

    _record_usage(current_user.id, "meal_plan_weekly", plan_type, db)

    # バックグラウンドで生成を実行（レスポンスはすぐ返す）
    background_tasks.add_task(_run_generation_bg, plan_id, current_user.id, conditions_json)

    db.refresh(plan)
    return _plan_detail(plan, current_user.id, db)


@router.delete("/{plan_id}/delete")
async def delete_meal_plan(
    plan_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    # グループメンバーであることを確認
    member = db.query(models.GroupMember).filter_by(
        group_id=plan.group_id, user_id=current_user.id
    ).first()
    if not member:
        raise HTTPException(403, "Not authorized")
    db.delete(plan)  # cascade: days → slots → items, shopping_lists
    db.commit()
    return {"deleted": plan_id}


@router.put("/{plan_id}/confirm")
async def confirm_meal_plan(
    plan_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    plan.status = models.PlanStatus.confirmed
    db.commit()

    # Auto-generate shopping list
    from ..services import meal_planner
    await meal_planner.generate_shopping_list(plan_id, db)

    return {"confirmed": True, "plan_id": plan_id}


class SlotUpdate(BaseModel):
    sharing_type: str | None = None  # "shared" | "individual"
    is_dining_out: bool | None = None
    dining_out_kcal: float | None = None


@router.put("/{plan_id}/slots/{slot_id}")
async def update_slot(
    plan_id: str,
    slot_id: str,
    payload: SlotUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    slot = db.query(models.MealPlanSlot).filter_by(id=slot_id).first()
    if not slot:
        raise HTTPException(404, "Slot not found")
    if payload.sharing_type is not None:
        slot.sharing_type = payload.sharing_type
    if payload.is_dining_out is not None:
        slot.is_dining_out = payload.is_dining_out
        if payload.is_dining_out:
            # Remove AI-generated items when switching to dining-out
            for item in slot.items:
                db.delete(item)
    if payload.dining_out_kcal is not None:
        slot.dining_out_kcal = payload.dining_out_kcal
    db.commit()
    return {"updated": True}


class ItemPortionUpdate(BaseModel):
    serving_grams: float | None = None
    kcal: float | None = None
    protein_g: float | None = None
    fat_g: float | None = None
    carb_g: float | None = None


def _normalize_menu_feedback(data: dict | None) -> dict[str, dict[str, list[str]]]:
    normalized: dict[str, dict[str, list[str]]] = {}
    for meal_type in ("breakfast", "lunch", "dinner"):
        meal_data = data.get(meal_type) if isinstance(data, dict) else {}
        if not isinstance(meal_data, dict):
            meal_data = {}
        normalized[meal_type] = {
            "good": [str(x).strip() for x in meal_data.get("good", []) if str(x).strip()],
            "bad": [str(x).strip() for x in meal_data.get("bad", []) if str(x).strip()],
        }
    return normalized


def _feedback_status(
    menu_feedback: dict[str, dict[str, list[str]]] | None,
    meal_type: str,
    menu_name: str | None,
) -> str | None:
    if not menu_feedback or not menu_name:
        return None
    if menu_name in menu_feedback.get(meal_type, {}).get("good", []):
        return "good"
    if menu_name in menu_feedback.get(meal_type, {}).get("bad", []):
        return "bad"
    return None


def _split_menu_entries(menu_name: str | None) -> list[str]:
    if not menu_name:
        return []
    normalized = str(menu_name).replace("＋", "\n").replace("+", "\n")
    entries: list[str] = []
    for raw in normalized.splitlines():
        name = raw.strip(" ・-\t")
        if name and name not in entries:
            entries.append(name)
    return entries


def _get_user_menu_feedback(user_id: str, db: Session) -> dict[str, dict[str, list[str]]]:
    goals = db.query(models.UserGoals).filter_by(user_id=user_id).first()
    prefs = goals.preferences_json if goals else {}
    raw = prefs.get("menu_feedback") if isinstance(prefs, dict) else None
    return _normalize_menu_feedback(raw)


def _apply_menu_feedback(
    preferences: dict | None,
    meal_type: str,
    menu_name: str,
    feedback: str | None,
) -> dict:
    prefs = dict(preferences or {})
    feedback_map = _normalize_menu_feedback(prefs.get("menu_feedback"))
    for bucket in ("good", "bad"):
        feedback_map[meal_type][bucket] = [name for name in feedback_map[meal_type][bucket] if name != menu_name]
    if feedback in {"good", "bad"}:
        feedback_map[meal_type][feedback].insert(0, menu_name)
    for bucket in ("good", "bad"):
        unique_names: list[str] = []
        for name in feedback_map[meal_type][bucket]:
            if name not in unique_names:
                unique_names.append(name)
        feedback_map[meal_type][bucket] = unique_names[:MENU_FEEDBACK_LIMIT]
    prefs["menu_feedback"] = feedback_map
    return prefs


@router.put("/{plan_id}/items/{item_id}")
async def update_plan_item(
    plan_id: str,
    item_id: str,
    payload: ItemPortionUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2: 量の調整 — 特定メンバーの特定の食事の量を増減"""
    item = db.query(models.MealPlanItem).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(item, field, value)
    db.commit()
    return {"updated": True, "item_id": item_id}


class ItemFeedbackUpdate(BaseModel):
    feedback: str | None = None
    menu_name: str | None = None


@router.put("/{plan_id}/items/{item_id}/feedback")
async def update_plan_item_feedback(
    plan_id: str,
    item_id: str,
    payload: ItemFeedbackUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")

    item = db.query(models.MealPlanItem).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    if not item.menu_name:
        raise HTTPException(400, "Item has no menu name")

    target_menu_name = (payload.menu_name or "").strip() or item.menu_name
    if target_menu_name != item.menu_name:
        menu_entries = _split_menu_entries(item.menu_name)
        if target_menu_name not in menu_entries:
            raise HTTPException(400, "menu_name is not part of the item")

    slot = db.query(models.MealPlanSlot).filter_by(id=item.meal_plan_slot_id).first()
    if not slot:
        raise HTTPException(404, "Slot not found")
    day = db.query(models.MealPlanDay).filter_by(id=slot.meal_plan_day_id, meal_plan_id=plan_id).first()
    if not day:
        raise HTTPException(400, "Item does not belong to the specified plan")

    feedback = (payload.feedback or "").strip().lower() or None
    if feedback not in {None, "good", "bad"}:
        raise HTTPException(400, "feedback must be good, bad, or null")

    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    if not goals:
        goals = models.UserGoals(user_id=current_user.id)
        db.add(goals)

    prefs = _apply_menu_feedback(goals.preferences_json or {}, str(slot.meal_type), target_menu_name, feedback)
    goals.preferences_json = prefs
    db.commit()

    return {
        "updated": True,
        "menu_name": target_menu_name,
        "feedback_status": _feedback_status(
            _normalize_menu_feedback(prefs.get("menu_feedback")),
            str(slot.meal_type),
            target_menu_name,
        ),
    }


class ReplaceMenuRequest(BaseModel):
    user_id: str | None = None  # specify for individual slot


class ReplaceDayRequest(BaseModel):
    meal_types: list[str] | None = None


@router.post("/{plan_id}/slots/{slot_id}/replace")
async def replace_slot_menu(
    plan_id: str,
    slot_id: str,
    payload: ReplaceMenuRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2: メニューの差し替え — 特定食事のメニューをAI再提案"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    slot = db.query(models.MealPlanSlot).filter_by(id=slot_id).first()
    if not slot:
        raise HTTPException(404, "Slot not found")

    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "recalculate", plan_type, db)

    # Delete existing items for this slot (for specified user or all)
    q = db.query(models.MealPlanItem).filter_by(meal_plan_slot_id=slot_id)
    if payload.user_id:
        q = q.filter_by(user_id=payload.user_id)
    for item in q.all():
        db.delete(item)
    db.commit()

    # Re-generate menu for this slot
    from ..services import meal_planner
    target_user_ids = [payload.user_id] if payload.user_id else None
    try:
        await meal_planner.generate_slot_menu(plan_id, slot_id, current_user.id, db, target_user_ids)
    except Exception as e:
        raise HTTPException(500, f"LLM generation failed: {str(e)}")

    _record_usage(current_user.id, "recalculate", plan_type, db)
    db.refresh(plan)
    return _plan_detail(plan, current_user.id, db)


@router.post("/{plan_id}/days/{day_id}/replace")
async def replace_day_menu(
    plan_id: str,
    day_id: str,
    payload: ReplaceDayRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")
    day = db.query(models.MealPlanDay).filter_by(id=day_id, meal_plan_id=plan_id).first()
    if not day:
        raise HTTPException(404, "Day not found")

    requested_meal_types = payload.meal_types or ["breakfast", "lunch", "dinner"]
    valid_meal_types = [meal for meal in requested_meal_types if meal in {"breakfast", "lunch", "dinner"}]
    if not valid_meal_types:
        raise HTTPException(400, "meal_types must contain breakfast, lunch, or dinner")

    slots = [slot for slot in day.slots if str(slot.meal_type) in valid_meal_types]
    if not slots:
        raise HTTPException(404, "No slots found for the requested meal types")

    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "recalculate", plan_type, db)

    meal_order = {"breakfast": 0, "lunch": 1, "dinner": 2}
    slots = sorted(slots, key=lambda slot: meal_order.get(str(slot.meal_type), 99))
    for slot in slots:
        for item in list(slot.items):
            db.delete(item)
    db.commit()

    from ..services import meal_planner
    try:
        for slot in slots:
            await meal_planner.generate_slot_menu(plan_id, slot.id, current_user.id, db)
    except Exception as e:
        raise HTTPException(500, f"LLM generation failed: {str(e)}")

    plan.status = models.PlanStatus.draft
    db.commit()
    _record_usage(current_user.id, "recalculate", plan_type, db)
    db.refresh(plan)
    return _plan_detail(plan, current_user.id, db)


@router.post("/{plan_id}/recalculate")
async def recalculate_plan(
    plan_id: str,
    background_tasks: BackgroundTasks,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2: 再計算 — 修正内容を踏まえてAIが献立全体を再計算（バックグラウンド実行）"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")

    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "recalculate", plan_type, db)

    total_slots = 0
    for day in plan.days:
        for slot in day.slots:
            if not slot.is_dining_out:
                for item in slot.items:
                    db.delete(item)
                total_slots += 1

    # 進捗初期化
    cond = dict(plan.conditions_json or {})
    cond["_progress"] = {
        "step": 0,
        "total": total_slots,
        "message": "🔄 献立を再計算しています...",
        "done": False,
        "error": False,
    }
    plan.conditions_json = cond
    flag_modified(plan, "conditions_json")
    plan.status = models.PlanStatus.draft
    db.commit()

    _record_usage(current_user.id, "recalculate", plan_type, db)

    background_tasks.add_task(_run_generation_bg, plan_id, current_user.id, plan.conditions_json)

    db.refresh(plan)
    return _plan_detail(plan, current_user.id, db)


def _get_plan_type(user_id: str, db: Session) -> str:
    plan = db.query(models.UserPlan).filter_by(user_id=user_id).first()
    if not plan:
        return "free"
    # 無料切替フラグが有効なら BYOK でも free 扱い（上限適用）
    if getattr(plan, "force_free_llm", False):
        return "free"
    return plan.plan_type


FREE_LIMITS = {
    "meal_plan_daily": 4,
    "meal_plan_weekly": 1,
    "chat": 5,
    "recalculate": 2,
}


def _is_developer(user_id: str) -> bool:
    """環境変数 DEVELOPER_USER_IDS（カンマ区切り）に含まれていれば開発者扱い。"""
    import os
    raw = os.getenv("DEVELOPER_USER_IDS", "")
    devs = {s.strip() for s in raw.split(",") if s.strip()}
    return user_id in devs


def _check_usage_limit(user_id: str, feature: str, plan_type: str, db: Session):
    if plan_type == "byok":
        return
    if _is_developer(user_id):
        return  # 開発者は無制限
    from datetime import datetime
    limit = FREE_LIMITS.get(feature, 999)
    start_of_month = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    count = (
        db.query(models.UsageLog)
        .filter(
            models.UsageLog.user_id == user_id,
            models.UsageLog.feature == feature,
            models.UsageLog.used_at >= start_of_month,
        )
        .count()
    )
    if count >= limit:
        raise HTTPException(429, f"Monthly limit ({limit}) reached for {feature}. Please upgrade to BYOK plan.")


def _record_usage(user_id: str, feature: str, plan_type: str, db: Session):
    log = models.UsageLog(user_id=user_id, feature=feature, plan_type=plan_type)
    db.add(log)
    db.commit()


def _plan_ai_usage_summary(plan: models.MealPlan) -> dict:
    from ..llm.adapter import estimate_model_cost_jpy

    model_order: list[str] = []
    input_tokens_total = 0
    output_tokens_total = 0
    has_input_tokens = False
    has_output_tokens = False
    estimated_total_cost_jpy = 0.0
    has_cost = False

    for day in plan.days:
        for slot in day.slots:
            for item in slot.items:
                model_name = getattr(item, "llm_model", None)
                if model_name and model_name not in model_order:
                    model_order.append(model_name)

                input_tokens = getattr(item, "input_tokens", None)
                output_tokens = getattr(item, "output_tokens", None)
                if input_tokens is not None:
                    input_tokens_total += int(input_tokens)
                    has_input_tokens = True
                if output_tokens is not None:
                    output_tokens_total += int(output_tokens)
                    has_output_tokens = True

                cost_info = estimate_model_cost_jpy(model_name, input_tokens, output_tokens)
                total_cost = cost_info.get("estimated_total_cost_jpy")
                if total_cost is not None:
                    estimated_total_cost_jpy += float(total_cost)
                    has_cost = True

    return {
        "llm_models": model_order,
        "primary_llm_model": model_order[0] if model_order else None,
        "llm_model_count": len(model_order),
        "input_tokens_total": input_tokens_total if has_input_tokens else None,
        "output_tokens_total": output_tokens_total if has_output_tokens else None,
        "total_tokens": (input_tokens_total + output_tokens_total) if (has_input_tokens or has_output_tokens) else None,
        "estimated_total_cost_jpy": round(estimated_total_cost_jpy, 4) if has_cost else None,
    }


def _plan_summary(plan: models.MealPlan) -> dict:
    return {
        "id": plan.id,
        "start_date": plan.start_date,
        "end_date": plan.end_date,
        "status": plan.status,
        "conditions": plan.conditions_json or {},
        "created_at": plan.created_at.isoformat(),
        **_plan_ai_usage_summary(plan),
    }


def _plan_detail(plan: models.MealPlan, current_user_id: str | None = None, db: Session | None = None) -> dict:
    from ..llm.adapter import estimate_model_cost_jpy

    menu_feedback = _get_user_menu_feedback(current_user_id, db) if current_user_id and db else None
    days = []
    for day in sorted(plan.days, key=lambda d: d.date):
        slots = []
        for slot in day.slots:
            items = []
            for item in slot.items:
                cost_info = estimate_model_cost_jpy(
                    getattr(item, "llm_model", None),
                    getattr(item, "input_tokens", None),
                    getattr(item, "output_tokens", None),
                )
                menu_entries = _split_menu_entries(item.menu_name)
                items.append({
                    "id": item.id,
                    "user_id": item.user_id,
                    "menu_name": item.menu_name,
                    "menu_entries": [
                        {
                            "name": menu_entry,
                            "feedback_status": _feedback_status(menu_feedback, str(slot.meal_type), menu_entry),
                        }
                        for menu_entry in menu_entries
                    ],
                    "kcal": item.kcal,
                    "protein_g": item.protein_g,
                    "fat_g": item.fat_g,
                    "carb_g": item.carb_g,
                    "serving_grams": item.serving_grams,
                    "ingredients": item.ingredients_json,
                    "cooking_summary": item.cooking_summary,
                    "input_tokens": getattr(item, "input_tokens", None),
                    "output_tokens": getattr(item, "output_tokens", None),
                    "llm_model": getattr(item, "llm_model", None),
                    "system_prompt": getattr(item, "system_prompt", None),
                    "user_prompt": getattr(item, "user_prompt", None),
                    "feedback_status": _feedback_status(menu_feedback, str(slot.meal_type), item.menu_name),
                    **cost_info,
                })
            total_kcal = sum(it["kcal"] for it in items if it["kcal"] is not None) if items else None
            slots.append({
                "id": slot.id,
                "meal_type": slot.meal_type,
                "sharing_type": slot.sharing_type,
                "is_dining_out": getattr(slot, "is_dining_out", False),
                "dining_out_kcal": getattr(slot, "dining_out_kcal", None),
                "source_type": getattr(slot, "source_type", None),
                "kcal_budget": getattr(slot, "kcal_budget", None),
                "total_kcal": round(total_kcal) if total_kcal else None,
                "items": items,
            })
        days.append({"id": day.id, "date": day.date, "slots": slots})

    progress = (plan.conditions_json or {}).get("_progress")
    return {**_plan_summary(plan), "days": days, "progress": progress}
