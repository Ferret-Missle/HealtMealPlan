import uuid
from datetime import date as dt_date, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user

router = APIRouter()


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
    return _plan_detail(plan)


class MemberDayCondition(BaseModel):
    user_id: str
    breakfast: str = "conbini"   # conbini | bento | homecook
    lunch: str = "conbini"
    dinner: str = "homecook"
    light_breakfast: bool = False


class DayCondition(BaseModel):
    date: str  # YYYY-MM-DD
    members: list[MemberDayCondition] = []


class GeneratePlanRequest(BaseModel):
    start_date: str
    days: int = 7
    day_conditions: list[DayCondition] = []


def _calc_kcal_budget(meal_type: str, target_kcal: int | None, light_breakfast: bool) -> float | None:
    """Distribute daily kcal budget across meals."""
    if not target_kcal:
        return None
    if light_breakfast:
        ratios = {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}
    else:
        ratios = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}
    return round(target_kcal * ratios.get(meal_type, 0.33))


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
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from ..services import meal_planner

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

    conditions_json = {"day_conditions": [dc.model_dump() for dc in payload.day_conditions]}

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

    for i in range(payload.days):
        day_date = str(dt_date.fromisoformat(payload.start_date) + timedelta(days=i))
        day_id = str(uuid.uuid4())
        day = models.MealPlanDay(id=day_id, meal_plan_id=plan_id, date=day_date)
        db.add(day)

        for meal_type in ["breakfast", "lunch", "dinner"]:
            slot_id = str(uuid.uuid4())
            source = _resolve_source_for_slot(meal_type, day_date, payload.day_conditions)
            light_breakfast = _resolve_light_breakfast_for_slot(day_date, payload.day_conditions)
            # dinner 全員 homecook → shared; それ以外は individual
            sharing = "shared" if meal_type == "dinner" and source == "homecook" else "individual"

            slot = models.MealPlanSlot(
                id=slot_id,
                meal_plan_day_id=day_id,
                meal_type=meal_type,
                sharing_type=sharing,
                source_type=source,
                kcal_budget=_calc_kcal_budget(meal_type, target_kcal, light_breakfast),
            )
            db.add(slot)

    db.commit()

    try:
        await meal_planner.generate_menus(plan_id, current_user.id, db, conditions_json)
    except Exception:
        pass

    _record_usage(current_user.id, "meal_plan_weekly", plan_type, db)
    db.refresh(plan)
    return _plan_detail(plan)


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


class ReplaceMenuRequest(BaseModel):
    user_id: str | None = None  # specify for individual slot


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
    return _plan_detail(plan)


@router.post("/{plan_id}/recalculate")
async def recalculate_plan(
    plan_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2: 再計算 — 修正内容を踏まえてAIが献立全体を再計算"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        raise HTTPException(404, "Plan not found")

    plan_type = _get_plan_type(current_user.id, db)
    _check_usage_limit(current_user.id, "recalculate", plan_type, db)

    # Delete all draft items and regenerate
    for day in plan.days:
        for slot in day.slots:
            if not slot.is_dining_out:
                for item in slot.items:
                    db.delete(item)
    db.commit()

    from ..services import meal_planner
    try:
        await meal_planner.generate_menus(plan_id, current_user.id, db)
    except Exception as e:
        raise HTTPException(500, f"LLM recalculation failed: {str(e)}")

    plan.status = models.PlanStatus.draft
    db.commit()
    _record_usage(current_user.id, "recalculate", plan_type, db)
    db.refresh(plan)
    return _plan_detail(plan)


def _get_plan_type(user_id: str, db: Session) -> str:
    plan = db.query(models.UserPlan).filter_by(user_id=user_id).first()
    return plan.plan_type if plan else "free"


FREE_LIMITS = {
    "meal_plan_daily": 4,
    "meal_plan_weekly": 1,
    "chat": 5,
    "recalculate": 2,
}


def _check_usage_limit(user_id: str, feature: str, plan_type: str, db: Session):
    if plan_type == "byok":
        return
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


def _plan_summary(plan: models.MealPlan) -> dict:
    return {
        "id": plan.id,
        "start_date": plan.start_date,
        "end_date": plan.end_date,
        "status": plan.status,
        "conditions": plan.conditions_json or {},
        "created_at": plan.created_at.isoformat(),
    }


def _plan_detail(plan: models.MealPlan) -> dict:
    days = []
    for day in sorted(plan.days, key=lambda d: d.date):
        slots = []
        for slot in day.slots:
            items = []
            for item in slot.items:
                items.append({
                    "id": item.id,
                    "user_id": item.user_id,
                    "menu_name": item.menu_name,
                    "kcal": item.kcal,
                    "protein_g": item.protein_g,
                    "fat_g": item.fat_g,
                    "carb_g": item.carb_g,
                    "serving_grams": item.serving_grams,
                    "ingredients": item.ingredients_json,
                    "cooking_summary": item.cooking_summary,
                })
            total_kcal = sum(it["kcal"] for it in items if it.get("kcal")) if items else None
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

    return {**_plan_summary(plan), "days": days}
