from datetime import date as dt_date, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user
from ..services import healthplanet, fitbit
from ..services.body_snapshot import aggregate_weight_logs_by_date, merge_missing_weight_metrics

router = APIRouter()


class WeightLogCreate(BaseModel):
    date: str
    weight: float
    body_fat: float | None = None
    muscle_mass: float | None = None
    bmi: float | None = None
    basal_metabolism_kcal: float | None = None
    body_age: int | None = None
    bone_mass: float | None = None
    visceral_fat_level: float | None = None
    source: str = "manual"


@router.get("/weight")
async def get_weight_history(
    days: int = 30,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    start = str(anchor - timedelta(days=max(days - 1, 0)))
    logs = (
        db.query(models.WeightLog)
        .filter(
            models.WeightLog.user_id == current_user.id,
            models.WeightLog.date >= start,
            models.WeightLog.date <= str(anchor),
        )
        .order_by(models.WeightLog.date)
        .all()
    )
    return aggregate_weight_logs_by_date(logs)


@router.post("/weight")
async def add_weight_log(
    payload: WeightLogCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(models.WeightLog)
        .filter_by(user_id=current_user.id, date=payload.date, source=payload.source)
        .first()
    )
    if existing:
        for field, value in payload.model_dump(exclude={"source"}).items():
            if value is not None:
                setattr(existing, field, value)
        db.commit()
        return _weight_to_dict(existing)

    log = models.WeightLog(
        user_id=current_user.id,
        date=payload.date,
        weight=payload.weight,
        body_fat=payload.body_fat,
        muscle_mass=payload.muscle_mass,
        bmi=payload.bmi,
        basal_metabolism_kcal=payload.basal_metabolism_kcal,
        body_age=payload.body_age,
        bone_mass=payload.bone_mass,
        visceral_fat_level=payload.visceral_fat_level,
        source=payload.source,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return _weight_to_dict(log)


@router.post("/sync")
async def sync_body_data(
    target_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    today = target_date or str(dt_date.today())
    synced = []

    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]

    if "healthplanet" in connected:
        try:
            hp = await healthplanet.get_innerscan(current_user.id, today, db)
            if hp:
                hp_payload = merge_missing_weight_metrics(
                    db,
                    current_user.id,
                    {k: v for k, v in hp.items() if k != "source"},
                    source="healthplanet",
                    before_date=today,
                )
                existing = (
                    db.query(models.WeightLog)
                    .filter_by(user_id=current_user.id, date=today, source="healthplanet")
                    .first()
                )
                if existing:
                    # Update existing record
                    for k, v in hp_payload.items():
                        if v is not None:
                            setattr(existing, k, v)
                else:
                    log = models.WeightLog(
                        user_id=current_user.id,
                        date=today,
                        source="healthplanet",
                        **hp_payload,
                    )
                    db.add(log)
                db.commit()
                synced.append("healthplanet")
        except Exception as e:
            import traceback
            print(f"[HealthPlanet sync error] {e}\n{traceback.format_exc()}")

    if "fitbit" in connected:
        try:
            fb = await fitbit.get_weight(current_user.id, today, db)
            if fb:
                existing = (
                    db.query(models.WeightLog)
                    .filter_by(user_id=current_user.id, date=today, source="fitbit")
                    .first()
                )
                if not existing:
                    log = models.WeightLog(
                        user_id=current_user.id,
                        date=today,
                        weight=fb.get("weight"),
                        bmi=fb.get("bmi"),
                        source="fitbit",
                    )
                    db.add(log)
                    db.commit()
                synced.append("fitbit")
        except Exception:
            pass

        try:
            activity = await fitbit.get_activities(current_user.id, today, db)
            activity_log = (
                db.query(models.ActivityLog)
                .filter_by(user_id=current_user.id, date=today)
                .first()
            )
            if activity_log:
                activity_log.steps = activity.get("steps")
                activity_log.active_kcal = activity.get("active_kcal")
                activity_log.calories_out = activity.get("calories_out")
            else:
                db.add(models.ActivityLog(
                    user_id=current_user.id,
                    date=today,
                    steps=activity.get("steps"),
                    active_kcal=activity.get("active_kcal"),
                    calories_out=activity.get("calories_out"),
                    source="fitbit",
                ))
            db.commit()
        except Exception:
            pass

    return {"synced": synced, "date": today}


@router.post("/sync-weight-history")
async def sync_weight_history(
    days: int = 30,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fitbit / HealthPlanet から過去 N 日分の体重を一括取得して保存する。"""
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    end   = str(anchor)
    start = str(anchor - timedelta(days=max(days - 1, 0)))

    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]

    saved = 0

    async def _save_weight(date: str, weight: float | None, source: str, **extra):
        nonlocal saved
        if weight is None and not any(value is not None for value in extra.values()):
            return
        existing = (
            db.query(models.WeightLog)
            .filter_by(user_id=current_user.id, date=date, source=source)
            .first()
        )
        if existing:
            if weight is not None:
                existing.weight = weight
            for field, value in extra.items():
                if value is not None:
                    setattr(existing, field, value)
            return
        db.add(models.WeightLog(
            user_id=current_user.id, date=date, weight=weight, source=source, **extra
        ))
        saved += 1

    if "fitbit" in connected:
        try:
            for e in await fitbit.get_weight_range(current_user.id, start, end, db):
                await _save_weight(e["date"], e.get("weight"), "fitbit", bmi=e.get("bmi"))
        except Exception as exc:
            print(f"[sync-weight-history fitbit] {exc}")

    if "healthplanet" in connected:
        try:
            entries = sorted(
                await healthplanet.get_innerscan_range(current_user.id, start, end, db),
                key=lambda entry: entry["date"],
            )
            for e in entries:
                extra = merge_missing_weight_metrics(
                    db,
                    current_user.id,
                    {
                        "body_fat": e.get("body_fat"),
                        "muscle_mass": e.get("muscle_mass"),
                        "basal_metabolism_kcal": e.get("basal_metabolism_kcal"),
                        "body_age": e.get("body_age"),
                        "bone_mass": e.get("bone_mass"),
                        "visceral_fat_level": e.get("visceral_fat_level"),
                    },
                    source="healthplanet",
                    before_date=e["date"],
                )
                await _save_weight(
                    e["date"], e.get("weight"), "healthplanet",
                    **extra,
                )
        except Exception as exc:
            print(f"[sync-weight-history healthplanet] {exc}")

    db.commit()
    return {"saved": saved, "from": start, "to": end}


@router.get("/activity-history")
async def get_activity_history(
    days: int = 7,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """過去 N 日分の歩数・睡眠・消費カロリーログを返す。"""
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    start = str(anchor - timedelta(days=max(days - 1, 0)))
    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]
    logs = (
        db.query(models.ActivityLog)
        .filter(
            models.ActivityLog.user_id == current_user.id,
            models.ActivityLog.date >= start,
            models.ActivityLog.date <= str(anchor),
        )
        .order_by(models.ActivityLog.date)
        .all()
    )

    has_missing_calories = any(log.calories_out is None for log in logs)
    has_missing_days = len({log.date for log in logs}) < days
    if "fitbit" in connected and (not logs or has_missing_calories or has_missing_days):
        try:
            end = str(anchor)
            activity_entries = await fitbit.get_activities_range(current_user.id, start, end, db)
            for entry in activity_entries:
                log = (
                    db.query(models.ActivityLog)
                    .filter_by(user_id=current_user.id, date=entry["date"])
                    .first()
                )
                if log:
                    log.calories_out = entry["calories_out"]
                else:
                    db.add(models.ActivityLog(
                        user_id=current_user.id,
                        date=entry["date"],
                        calories_out=entry["calories_out"],
                        source="fitbit",
                    ))
            db.commit()
            logs = (
                db.query(models.ActivityLog)
                .filter(
                    models.ActivityLog.user_id == current_user.id,
                    models.ActivityLog.date >= start,
                    models.ActivityLog.date <= str(anchor),
                )
                .order_by(models.ActivityLog.date)
                .all()
            )
        except Exception:
            pass

    return [
        {
            "date":        log.date,
            "steps":       log.steps,
            "active_kcal": log.active_kcal,
            "calories_out": log.calories_out,
            "sleep_hours": log.sleep_hours,
            "sleep_score": log.sleep_score,
        }
        for log in logs
    ]


@router.post("/sync-activity-history")
async def sync_activity_history(
    days: int = 7,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fitbit から過去 N 日分の睡眠・歩数・消費カロリーを一括取得して保存する。"""
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    end   = str(anchor)
    start = str(anchor - timedelta(days=max(days - 1, 0)))

    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]

    saved = 0
    if "fitbit" not in connected:
        return {"saved": 0, "from": start, "to": end}

    try:
        sleep_entries = await fitbit.get_sleep_range(current_user.id, start, end, db)
        for e in sleep_entries:
            log = (
                db.query(models.ActivityLog)
                .filter_by(user_id=current_user.id, date=e["date"])
                .first()
            )
            if log:
                log.sleep_hours = e["sleep_hours"]
                log.sleep_score = e["sleep_score"]
            else:
                db.add(models.ActivityLog(
                    user_id=current_user.id,
                    date=e["date"],
                    sleep_hours=e["sleep_hours"],
                    sleep_score=e["sleep_score"],
                    source="fitbit",
                ))
                saved += 1
        db.commit()
    except Exception as exc:
        print(f"[sync-activity-history] sleep: {exc}")

    try:
        steps_entries = await fitbit.get_steps_range(current_user.id, start, end, db)
        for e in steps_entries:
            log = (
                db.query(models.ActivityLog)
                .filter_by(user_id=current_user.id, date=e["date"])
                .first()
            )
            if log:
                log.steps = e["steps"]
            else:
                db.add(models.ActivityLog(
                    user_id=current_user.id,
                    date=e["date"],
                    steps=e["steps"],
                    source="fitbit",
                ))
                saved += 1
        db.commit()
    except Exception as exc:
        print(f"[sync-activity-history] steps: {exc}")

    try:
        activity_entries = await fitbit.get_activities_range(current_user.id, start, end, db)
        for e in activity_entries:
            log = (
                db.query(models.ActivityLog)
                .filter_by(user_id=current_user.id, date=e["date"])
                .first()
            )
            if log:
                log.calories_out = e["calories_out"]
            else:
                db.add(models.ActivityLog(
                    user_id=current_user.id,
                    date=e["date"],
                    calories_out=e["calories_out"],
                    source="fitbit",
                ))
                saved += 1
        db.commit()
    except Exception as exc:
        print(f"[sync-activity-history] calories: {exc}")

    return {"saved": saved, "from": start, "to": end}


@router.get("/goals")
async def get_goals(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    if not goals:
        return {}
    return _goals_to_dict(goals)


class GoalsUpdate(BaseModel):
    target_weight: float | None = None
    target_kcal: int | None = None
    deadline: str | None = None
    goal_type: str | None = None
    height_cm: float | None = None
    age_group: str | None = None
    gender: str | None = None
    target_protein_ratio: float | None = None
    target_fat_ratio: float | None = None
    target_carb_ratio: float | None = None


@router.put("/goals")
async def update_goals(
    payload: GoalsUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from datetime import datetime
    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    if not goals:
        goals = models.UserGoals(user_id=current_user.id)
        db.add(goals)

    for field, value in payload.model_dump(exclude_none=True).items():
        if field == "deadline" and isinstance(value, str):
            setattr(goals, field, datetime.fromisoformat(value))
        else:
            setattr(goals, field, value)

    # Auto-calculate daily kcal deficit if target weight + deadline set
    if goals.target_weight and goals.target_kcal is None:
        latest = (
            db.query(models.WeightLog)
            .filter_by(user_id=current_user.id)
            .order_by(models.WeightLog.date.desc())
            .first()
        )
        if latest and latest.weight and goals.target_weight < latest.weight:
            weight_diff = latest.weight - goals.target_weight
            if goals.deadline:
                days = max(1, (goals.deadline - datetime.utcnow()).days)
                daily_deficit = (weight_diff * 7200) / days
                goals.target_kcal = max(1200, int(1800 - daily_deficit))

    db.commit()
    return _goals_to_dict(goals)


def _weight_to_dict(log: models.WeightLog) -> dict:
    return {
        "id": log.id,
        "date": log.date,
        "weight": log.weight,
        "body_fat": log.body_fat,
        "muscle_mass": log.muscle_mass,
        "bmi": log.bmi,
        "basal_metabolism_kcal": log.basal_metabolism_kcal,
        "body_age": log.body_age,
        "bone_mass": log.bone_mass,
        "visceral_fat_level": log.visceral_fat_level,
        "source": log.source,
    }


def _goals_to_dict(goals: models.UserGoals) -> dict:
    return {
        "target_weight": goals.target_weight,
        "target_kcal": goals.target_kcal,
        "target_protein_ratio": goals.target_protein_ratio,
        "target_fat_ratio": goals.target_fat_ratio,
        "target_carb_ratio": goals.target_carb_ratio,
        "deadline": goals.deadline.isoformat() if goals.deadline else None,
        "goal_type": goals.goal_type,
        "height_cm": goals.height_cm,
        "age_group": goals.age_group,
        "gender": goals.gender,
        "preferences": goals.preferences_json or {},
        "excluded_foods": goals.excluded_foods_json or [],
    }
