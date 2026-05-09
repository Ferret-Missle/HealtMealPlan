from datetime import date as dt_date, datetime

from sqlalchemy.orm import Session

from .. import models


WEIGHT_METRIC_FIELDS = (
    "weight",
    "body_fat",
    "muscle_mass",
    "bmi",
    "basal_metabolism_kcal",
    "body_age",
    "bone_mass",
    "visceral_fat_level",
)
BODY_SNAPSHOT_STALE_DAYS = 7
SOURCE_PRIORITY = {
    "manual": 3,
    "healthplanet": 2,
    "fitbit": 1,
}


def normalize_gender(value: str | None) -> str | None:
    lowered = (value or "").strip().lower()
    if lowered in {"male", "man", "m", "男性", "男"}:
        return "male"
    if lowered in {"female", "woman", "f", "女性", "女"}:
        return "female"
    return None


def estimate_age_from_age_group(age_group: str | None) -> int | None:
    import re

    if not age_group:
        return None
    match = re.search(r"(\d{2})", age_group)
    if match:
        decade = int(match.group(1))
        if 10 <= decade <= 90:
            return decade + 5
    return None


def estimate_basal_metabolism(
    latest_body_snapshot: dict | None,
    goals: models.UserGoals | None,
) -> dict | None:
    if not latest_body_snapshot or not goals:
        return None

    weight = latest_body_snapshot.get("weight")
    height_cm = getattr(goals, "height_cm", None)
    age = estimate_age_from_age_group(getattr(goals, "age_group", None))
    gender = normalize_gender(getattr(goals, "gender", None))
    if weight is None or height_cm is None or age is None or gender is None:
        return None

    weight = float(weight)
    height_cm = float(height_cm)
    if gender == "male":
        kcal = 10 * weight + 6.25 * height_cm - 5 * age + 5
    else:
        kcal = 10 * weight + 6.25 * height_cm - 5 * age - 161

    return {
        "value": round(kcal),
        "weight": round(weight, 1),
        "height_cm": round(height_cm, 1),
        "age": age,
        "gender": gender,
        "reference_date": latest_body_snapshot.get("weight_date") or latest_body_snapshot.get("reference_date"),
        "formula": "Mifflin-St Jeor",
    }


def merge_missing_weight_metrics(
    db: Session,
    user_id: str,
    payload: dict,
    *,
    source: str | None = None,
    before_date: str | None = None,
) -> dict:
    merged = dict(payload)
    missing_fields = [field for field in WEIGHT_METRIC_FIELDS if merged.get(field) is None]
    if not missing_fields:
        return merged

    query = db.query(models.WeightLog).filter_by(user_id=user_id)
    if source:
        query = query.filter_by(source=source)
    if before_date:
        query = query.filter(models.WeightLog.date <= before_date)

    logs = (
        query
        .order_by(models.WeightLog.date.desc(), models.WeightLog.created_at.desc())
        .all()
    )
    for log in logs:
        for field in missing_fields:
            if merged.get(field) is not None:
                continue
            value = getattr(log, field, None)
            if value is None:
                continue
            merged[field] = value
        missing_fields = [field for field in missing_fields if merged.get(field) is None]
        if not missing_fields:
            break
    return merged


def get_weight_metric_snapshot(
    db: Session,
    user_id: str,
    preferred_date: str | None = None,
) -> dict | None:
    logs = (
        db.query(models.WeightLog)
        .filter_by(user_id=user_id)
        .order_by(models.WeightLog.date.desc(), models.WeightLog.created_at.desc())
        .all()
    )
    if not logs:
        return None

    def _ordered_key(log: models.WeightLog) -> tuple:
        return (
            1 if preferred_date and log.date == preferred_date else 0,
            log.date or "",
            SOURCE_PRIORITY.get(str(getattr(log, "source", "") or "").lower(), 0),
            getattr(log, "created_at", None) or datetime.min,
        )

    ordered_logs = sorted(logs, key=_ordered_key, reverse=True)

    snapshot: dict[str, object] = {}
    available_sources: list[str] = []
    for log in ordered_logs:
        source = getattr(log, "source", None)
        if source and source not in available_sources:
            available_sources.append(str(source))
        for field in WEIGHT_METRIC_FIELDS:
            if snapshot.get(field) is not None:
                continue
            value = getattr(log, field, None)
            if value is None:
                continue
            snapshot[field] = value
            snapshot[f"{field}_date"] = log.date
            snapshot[f"{field}_source"] = source

    if not snapshot:
        return None
    if available_sources:
        snapshot["available_sources"] = available_sources
    if snapshot.get("weight_date") is not None:
        snapshot["latest_weight_date"] = snapshot["weight_date"]
    reference_date = snapshot.get("weight_date") or snapshot.get("body_fat_date")
    if reference_date:
        snapshot["reference_date"] = reference_date
        try:
            days_since_reference = (dt_date.today() - dt_date.fromisoformat(str(reference_date))).days
            snapshot["days_since_reference"] = days_since_reference
            snapshot["is_stale"] = days_since_reference > BODY_SNAPSHOT_STALE_DAYS
        except ValueError:
            pass
    return snapshot


def build_weight_metric_lines(snapshot: dict | None) -> list[str]:
    if not snapshot:
        return []

    latest_weight_date = snapshot.get("weight_date")

    def _line_with_optional_date(label: str, field: str, suffix: str = "") -> str | None:
        value = snapshot.get(field)
        if value is None:
            return None
        metric_date = snapshot.get(f"{field}_date")
        if latest_weight_date and metric_date and metric_date != latest_weight_date:
            return f"{label} ({metric_date}): {value}{suffix}"
        return f"{label}: {value}{suffix}"

    lines: list[str] = []
    if snapshot.get("is_stale") and snapshot.get("reference_date"):
        lines.append(
            f"身体データは {snapshot['reference_date']} 時点（{snapshot.get('days_since_reference')}日前）の最新記録"
        )
    if snapshot.get("weight") is not None:
        lines.append(f"直近体重 ({latest_weight_date}): {snapshot['weight']}kg")
    for candidate in [
        _line_with_optional_date("体脂肪率", "body_fat", "%"),
        _line_with_optional_date("筋肉量", "muscle_mass", "kg"),
        _line_with_optional_date("BMI", "bmi"),
        _line_with_optional_date("体内年齢", "body_age", "才"),
        _line_with_optional_date("推定骨量", "bone_mass", "kg"),
        _line_with_optional_date("内臓脂肪レベル", "visceral_fat_level"),
    ]:
        if candidate:
            lines.append(candidate)
    return lines
