import asyncio
from datetime import date as dt_date, timedelta
from fastapi import APIRouter, Depends, Request, Query
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user
from ..services import fitbit, healthplanet, gcal

limiter = Limiter(key_func=get_remote_address)
router = APIRouter()


@router.get("/today")
async def today_summary(
    request: Request,
    target_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    today = target_date or str(dt_date.today())

    # Fetch from DB first (cached)
    weight_log = (
        db.query(models.WeightLog)
        .filter_by(user_id=current_user.id, date=today)
        .order_by(models.WeightLog.created_at.desc())
        .first()
    )
    activity_log = (
        db.query(models.ActivityLog)
        .filter_by(user_id=current_user.id, date=today)
        .first()
    )

    meal_logs = (
        db.query(models.MealLog)
        .filter_by(user_id=current_user.id, date=today)
        .all()
    )

    goals = (
        db.query(models.UserGoals)
        .filter_by(user_id=current_user.id)
        .first()
    )

    # Try live fetch if no cached data
    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]

    if not activity_log and "fitbit" in connected:
        try:
            act_data = await fitbit.get_activities(current_user.id, today, db)
            sleep_data = await fitbit.get_sleep(current_user.id, today, db)
            activity_log = models.ActivityLog(
                user_id=current_user.id,
                date=today,
                steps=act_data.get("steps", 0),
                active_kcal=act_data.get("active_kcal", 0),
                sleep_hours=sleep_data.get("sleep_hours"),
                sleep_score=sleep_data.get("sleep_score"),
                source="fitbit",
            )
            db.add(activity_log)
            db.commit()
        except Exception:
            pass

    if not weight_log and "healthplanet" in connected:
        try:
            hp_data = await healthplanet.get_innerscan(current_user.id, today, db)
            if hp_data:
                weight_log = models.WeightLog(
                    user_id=current_user.id,
                    date=today,
                    weight=hp_data.get("weight"),
                    body_fat=hp_data.get("body_fat"),
                    muscle_mass=hp_data.get("muscle_mass"),
                    bmi=hp_data.get("bmi"),
                    source="healthplanet",
                )
                db.add(weight_log)
                db.commit()
        except Exception:
            pass

    # Calendar events
    calendar_events = {"meal_events": [], "exercise_events": []}
    if "google" in connected:
        try:
            calendar_events = await gcal.get_daily_events(current_user.id, today, db)
        except Exception:
            pass

    # Aggregate meal nutrition
    total_kcal = sum(m.kcal for m in meal_logs)
    total_protein = sum(m.protein_g for m in meal_logs)
    total_fat = sum(m.fat_g for m in meal_logs)
    total_carb = sum(m.carb_g for m in meal_logs)

    return {
        "date": today,
        "weight": weight_log.weight if weight_log else None,
        "body_fat": weight_log.body_fat if weight_log else None,
        "steps": activity_log.steps if activity_log else None,
        "active_kcal": activity_log.active_kcal if activity_log else None,
        "sleep_hours": activity_log.sleep_hours if activity_log else None,
        "sleep_score": activity_log.sleep_score if activity_log else None,
        "nutrition": {
            "kcal": total_kcal,
            "protein_g": total_protein,
            "fat_g": total_fat,
            "carb_g": total_carb,
        },
        "goals": {
            "target_kcal": goals.target_kcal if goals else None,
            "target_weight": goals.target_weight if goals else None,
            "target_protein_ratio": goals.target_protein_ratio if goals else 0.30,
            "target_fat_ratio": goals.target_fat_ratio if goals else 0.25,
            "target_carb_ratio": goals.target_carb_ratio if goals else 0.45,
        },
        "calendar": calendar_events,
        "connected_services": connected,
    }


@router.get("/calendar")
async def get_calendar_events(
    date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """ダッシュボード用: 指定日のカレンダー予定一覧（タイトルそのまま）を返す。"""
    target = date or str(dt_date.today())

    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]

    if "google" not in connected:
        return {"connected": False, "events": []}

    try:
        events = await gcal.get_user_events(current_user.id, target, db)
        return {"connected": True, "events": events}
    except Exception:
        return {"connected": True, "events": []}


@router.get("/sleep")
async def get_sleep_history(
    days: int = Query(7, ge=1, le=30),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2-08: 睡眠データ週間グラフ — Fitbitから睡眠時間・スコアを取得"""
    today = dt_date.today()
    records = []

    for i in range(days - 1, -1, -1):
        target = str(today - timedelta(days=i))
        activity = (
            db.query(models.ActivityLog)
            .filter_by(user_id=current_user.id, date=target)
            .first()
        )
        records.append({
            "date": target,
            "sleep_hours": activity.sleep_hours if activity else None,
            "sleep_score": activity.sleep_score if activity else None,
        })

    # Try to fetch missing days from Fitbit
    connected = [
        t.service
        for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    ]
    if "fitbit" in connected:
        for record in records:
            if record["sleep_hours"] is None:
                try:
                    sleep_data = await fitbit.get_sleep(current_user.id, record["date"], db)
                    record["sleep_hours"] = sleep_data.get("sleep_hours")
                    record["sleep_score"] = sleep_data.get("sleep_score")
                    # Persist to ActivityLog
                    existing = (
                        db.query(models.ActivityLog)
                        .filter_by(user_id=current_user.id, date=record["date"])
                        .first()
                    )
                    if existing:
                        existing.sleep_hours = record["sleep_hours"]
                        existing.sleep_score = record["sleep_score"]
                    else:
                        db.add(models.ActivityLog(
                            user_id=current_user.id,
                            date=record["date"],
                            sleep_hours=record["sleep_hours"],
                            sleep_score=record["sleep_score"],
                            source="fitbit",
                        ))
                    db.commit()
                except Exception:
                    pass

    return {"sleep": records}


@router.get("/exercise-comparison")
async def get_exercise_comparison(
    days: int = Query(7, ge=1, le=14),
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2-09: 運動予定（カレンダー）と実績（Fitbit）を比較"""
    today = dt_date.today()
    comparison = []

    for i in range(days - 1, -1, -1):
        target = str(today - timedelta(days=i))

        # Fitbit actual
        activity = (
            db.query(models.ActivityLog)
            .filter_by(user_id=current_user.id, date=target)
            .first()
        )

        # Calendar planned
        planned_exercises = []
        connected = [
            t.service
            for t in db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
        ]
        if "google" in connected:
            try:
                events = await gcal.get_daily_events(current_user.id, target, db)
                planned_exercises = events.get("exercise_events", [])
            except Exception:
                pass

        comparison.append({
            "date": target,
            "planned_exercises": planned_exercises,
            "actual_steps": activity.steps if activity else None,
            "actual_active_kcal": activity.active_kcal if activity else None,
            "actual_sleep_hours": activity.sleep_hours if activity else None,
        })

    return {"comparison": comparison}
