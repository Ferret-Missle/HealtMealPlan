from sqlalchemy.orm.attributes import flag_modified


def sanitize_conditions(conditions: dict | None) -> dict:
    data = dict(conditions or {})
    data.pop("_progress", None)
    return data


def read_plan_progress(plan) -> dict | None:
    progress = getattr(plan, "progress_json", None)
    if isinstance(progress, dict) and progress:
        return progress
    conditions = getattr(plan, "conditions_json", None)
    if isinstance(conditions, dict):
        legacy = conditions.get("_progress")
        if isinstance(legacy, dict):
            return legacy
    return None


def write_plan_progress(plan, progress: dict | None) -> None:
    plan.progress_json = progress
    flag_modified(plan, "progress_json")
