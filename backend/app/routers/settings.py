from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models, security
from ..auth_deps import get_current_user
from ..services import gcal

router = APIRouter()


class PreferencesUpdate(BaseModel):
    preferences: dict | None = None
    excluded_foods: list[str] | None = None
    diet_styles: list[str] | None = None


@router.get("/")
async def get_settings(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    tokens = db.query(models.OAuthToken).filter_by(user_id=current_user.id).all()
    api_keys = db.query(models.ApiKey).filter_by(user_id=current_user.id).all()
    calendar_settings = db.query(models.CalendarSetting).filter_by(user_id=current_user.id).all()

    return {
        "plan": {
            "plan_type": plan.plan_type if plan else "free",
            "byok_provider": plan.byok_provider if plan else None,
        },
        "connected_services": [t.service for t in tokens],
        "api_keys": [
            {"provider": k.provider, "hint": k.key_hint}
            for k in api_keys
        ],
        "preferences": goals.preferences_json if goals else {},
        "excluded_foods": goals.excluded_foods_json if goals else [],
        "calendar_settings": [
            {
                "id": c.id,
                "calendar_id": c.calendar_id,
                "calendar_name": c.calendar_name,
                "is_shared": c.is_shared,
                "use_for_meal_plan": c.use_for_meal_plan,
            }
            for c in calendar_settings
        ],
    }


@router.put("/preferences")
async def update_preferences(
    payload: PreferencesUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    goals = db.query(models.UserGoals).filter_by(user_id=current_user.id).first()
    if not goals:
        goals = models.UserGoals(user_id=current_user.id)
        db.add(goals)

    if payload.preferences is not None:
        goals.preferences_json = payload.preferences
    if payload.excluded_foods is not None:
        goals.excluded_foods_json = payload.excluded_foods
    if payload.diet_styles is not None:
        prefs = goals.preferences_json or {}
        prefs["diet_styles"] = payload.diet_styles
        goals.preferences_json = prefs

    db.commit()
    return {"updated": True}


# ---- BYOK API Key management ----

class ApiKeyCreate(BaseModel):
    provider: str
    api_key: str


@router.post("/api-keys")
async def register_api_key(
    payload: ApiKeyCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = db.query(models.ApiKey).filter_by(
        user_id=current_user.id, provider=payload.provider
    ).first()
    hint = security.key_hint(payload.api_key)
    encrypted = security.encrypt(payload.api_key)

    if existing:
        existing.encrypted_key = encrypted
        existing.key_hint = hint
    else:
        key = models.ApiKey(
            user_id=current_user.id,
            provider=payload.provider,
            encrypted_key=encrypted,
            key_hint=hint,
        )
        db.add(key)

    # Update plan to BYOK
    plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    if plan:
        plan.plan_type = models.PlanType.byok
        plan.byok_provider = payload.provider

    db.commit()
    return {"provider": payload.provider, "hint": hint}


@router.delete("/api-keys/{provider}")
async def delete_api_key(
    provider: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    key = db.query(models.ApiKey).filter_by(
        user_id=current_user.id, provider=provider
    ).first()
    if key:
        db.delete(key)

    plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    if plan and plan.byok_provider == provider:
        remaining = (
            db.query(models.ApiKey)
            .filter_by(user_id=current_user.id)
            .filter(models.ApiKey.provider != provider)
            .first()
        )
        if remaining:
            plan.byok_provider = remaining.provider
        else:
            plan.plan_type = models.PlanType.free
            plan.byok_provider = None

    db.commit()
    return {"deleted": provider}


# ---- Calendar settings ----

@router.get("/calendars/sync")
async def sync_calendars(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Fetch calendar list from Google and sync to DB."""
    try:
        calendars = await gcal.list_calendars(current_user.id, db)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Google Calendar API error: {str(e)}")

    existing_settings = {
        setting.calendar_id: setting
        for setting in db.query(models.CalendarSetting).filter_by(user_id=current_user.id).all()
    }

    for cal in calendars:
        setting = existing_settings.get(cal["id"])
        if setting:
            setting.calendar_name = cal["summary"]
            setting.is_shared = not cal.get("primary", False)
            continue

        db.add(
            models.CalendarSetting(
                user_id=current_user.id,
                calendar_id=cal["id"],
                calendar_name=cal["summary"],
                is_shared=not cal.get("primary", False),
                use_for_meal_plan=cal.get("primary", False),
            )
        )

    db.commit()
    return {"synced": len(calendars)}


class CalendarSettingUpdate(BaseModel):
    use_for_meal_plan: bool


@router.put("/calendars/{calendar_id}")
async def update_calendar_setting(
    calendar_id: str,
    payload: CalendarSettingUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    setting = (
        db.query(models.CalendarSetting)
        .filter_by(user_id=current_user.id, calendar_id=calendar_id)
        .first()
    )
    if not setting:
        raise HTTPException(404, "Calendar setting not found")
    setting.use_for_meal_plan = payload.use_for_meal_plan
    db.commit()
    return {"updated": True}
