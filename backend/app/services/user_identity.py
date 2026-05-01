import logging
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models

logger = logging.getLogger("user_identity")
logger.setLevel(logging.INFO)


def register_or_reconcile_user(
    *,
    uid: str,
    email: str,
    name: str,
    terms_version: str,
    privacy_version: str,
    db: Session,
) -> tuple[models.User, str, str]:
    email = (email or f"{uid}@unknown.local").strip()
    normalized_email = email.lower()
    display_name = _display_name(name, email, uid)

    existing_by_uid = db.query(models.User).filter_by(id=uid).first()
    existing_by_email = (
        db.query(models.User)
        .filter(func.lower(models.User.email) == normalized_email)
        .first()
    )

    if existing_by_uid and existing_by_email and existing_by_uid.id != existing_by_email.id:
        raise ValueError(
            f"Conflicting users exist for email={email}: uid={existing_by_uid.id}, email_owner={existing_by_email.id}"
        )

    if existing_by_uid:
        user = existing_by_uid
        action = "existing"
    elif existing_by_email:
        user = _rekey_user(existing_by_email, uid, email, display_name, db)
        action = "repaired"
    else:
        user = models.User(id=uid, email=email, name=display_name)
        db.add(user)
        db.flush()
        action = "created"

    user.email = email
    if action == "created" or not (user.name and user.name.strip()):
        user.name = display_name

    group_id = _ensure_user_defaults(
        user=user,
        terms_version=terms_version,
        privacy_version=privacy_version,
        db=db,
    )
    return user, group_id, action


def _display_name(name: str, email: str, uid: str) -> str:
    if name and name.strip():
        return name.strip()
    if email and "@" in email:
        return email.split("@", 1)[0]
    return uid[:8] or "ユーザー"


def _rekey_user(
    source_user: models.User,
    new_uid: str,
    email: str,
    display_name: str,
    db: Session,
) -> models.User:
    logger.warning(
        "Repairing user identity for email=%s old_uid=%s new_uid=%s",
        email,
        source_user.id,
        new_uid,
    )

    temp_email = f"repair-{uuid.uuid4().hex}@local.invalid"
    target_user = models.User(
        id=new_uid,
        email=temp_email,
        name=display_name or source_user.name,
        privacy_public=source_user.privacy_public,
        created_at=source_user.created_at,
    )
    db.add(target_user)
    db.flush()

    old_uid = source_user.id
    _move_user_id_references(old_uid, new_uid, db)

    db.delete(source_user)
    db.flush()

    target_user.email = email
    target_user.name = display_name or source_user.name
    return target_user


def _move_user_id_references(old_uid: str, new_uid: str, db: Session) -> None:
    user_id_models = [
        models.OAuthToken,
        models.ApiKey,
        models.UserPlan,
        models.UserGoals,
        models.WeightLog,
        models.ActivityLog,
        models.MealLog,
        models.UserConsent,
        models.CalendarSetting,
        models.GroupMember,
        models.UsageLog,
        models.MealPlanItem,
        models.ShoppingList,
    ]

    for model in user_id_models:
        db.query(model).filter_by(user_id=old_uid).update(
            {"user_id": new_uid},
            synchronize_session=False,
        )

    db.query(models.GroupInvitation).filter_by(inviter_user_id=old_uid).update(
        {"inviter_user_id": new_uid},
        synchronize_session=False,
    )


def _ensure_user_defaults(
    *,
    user: models.User,
    terms_version: str,
    privacy_version: str,
    db: Session,
) -> str:
    plan = db.query(models.UserPlan).filter_by(user_id=user.id).first()
    if not plan:
        db.add(models.UserPlan(user_id=user.id, plan_type=models.PlanType.free))

    goals = db.query(models.UserGoals).filter_by(user_id=user.id).first()
    if not goals:
        db.add(models.UserGoals(user_id=user.id))

    existing_consents = {
        row.document_type
        for row in db.query(models.UserConsent).filter_by(user_id=user.id).all()
    }
    if "terms" not in existing_consents:
        db.add(
            models.UserConsent(
                user_id=user.id,
                document_type="terms",
                version=terms_version,
            )
        )
    if "privacy" not in existing_consents:
        db.add(
            models.UserConsent(
                user_id=user.id,
                document_type="privacy",
                version=privacy_version,
            )
        )

    membership = db.query(models.GroupMember).filter_by(user_id=user.id).first()
    if membership:
        return membership.group_id

    group_id = str(uuid.uuid4())
    db.add(
        models.Group(
            id=group_id,
            name=f"{user.name}の個人グループ",
            type=models.GroupType.personal,
        )
    )
    db.add(models.GroupMember(group_id=group_id, user_id=user.id, role="owner"))
    return group_id
