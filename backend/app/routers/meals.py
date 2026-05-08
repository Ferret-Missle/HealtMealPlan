from datetime import date as dt_date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user
from ..services import fatsecret

router = APIRouter()


class MealLogCreate(BaseModel):
    date: str
    meal_type: str  # breakfast / lunch / dinner / snack
    food_name: str
    food_id: str | None = None
    kcal: float
    protein_g: float = 0
    fat_g: float = 0
    carb_g: float = 0
    serving_grams: float | None = None
    source: str = "manual"


class MealLogUpdate(BaseModel):
    kcal: float | None = None
    protein_g: float | None = None
    fat_g: float | None = None
    carb_g: float | None = None
    serving_grams: float | None = None


@router.get("/")
async def get_meal_logs(
    date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target = date or str(dt_date.today())
    logs = (
        db.query(models.MealLog)
        .filter_by(user_id=current_user.id, date=target)
        .order_by(models.MealLog.created_at)
        .all()
    )
    return [_log_to_dict(log) for log in logs]


@router.post("/")
async def add_meal_log(
    payload: MealLogCreate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    log = models.MealLog(
        user_id=current_user.id,
        date=payload.date,
        meal_type=payload.meal_type,
        food_name=payload.food_name,
        food_id=payload.food_id,
        kcal=payload.kcal,
        protein_g=payload.protein_g,
        fat_g=payload.fat_g,
        carb_g=payload.carb_g,
        serving_grams=payload.serving_grams,
        source=payload.source,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return _log_to_dict(log)


@router.put("/{log_id}")
async def update_meal_log(
    log_id: int,
    payload: MealLogUpdate,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    log = db.query(models.MealLog).filter_by(id=log_id, user_id=current_user.id).first()
    if not log:
        raise HTTPException(404, "Log not found")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(log, field, value)
    db.commit()
    return _log_to_dict(log)


@router.delete("/{log_id}")
async def delete_meal_log(
    log_id: int,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    log = db.query(models.MealLog).filter_by(id=log_id, user_id=current_user.id).first()
    if not log:
        raise HTTPException(404, "Log not found")
    db.delete(log)
    db.commit()
    return {"deleted": log_id}


@router.get("/search")
async def search_foods(
    q: str = Query(..., min_length=1),
    page: int = 0,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        result = await fatsecret.search_foods(current_user.id, q, db, page)
        foods = result.get("foods", {}).get("food", [])
        if isinstance(foods, dict):
            foods = [foods]
        return {
            "foods": [
                {
                    "food_id": f.get("food_id"),
                    "food_name": f.get("food_name"),
                    "brand_name": f.get("brand_name"),
                    "food_description": f.get("food_description"),
                }
                for f in foods
            ]
        }
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/food/{food_id}")
async def get_food_detail(
    food_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        result = await fatsecret.get_food(current_user.id, food_id, db)
        food = result.get("food", {})
        servings = food.get("servings", {}).get("serving", [])
        if isinstance(servings, dict):
            servings = [servings]
        return {
            "food_id": food.get("food_id"),
            "food_name": food.get("food_name"),
            "servings": [
                {
                    "serving_id": s.get("serving_id"),
                    "serving_description": s.get("serving_description"),
                    "metric_serving_amount": s.get("metric_serving_amount"),
                    "calories": s.get("calories"),
                    "protein": s.get("protein"),
                    "fat": s.get("fat"),
                    "carbohydrate": s.get("carbohydrate"),
                }
                for s in servings
            ],
        }
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/barcode/{barcode}")
async def search_by_barcode(
    barcode: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        result = await fatsecret.search_by_barcode(current_user.id, barcode, db)
        if not result:
            raise HTTPException(404, "Food not found for barcode")
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))


class PhotoEstimateRequest(BaseModel):
    image_b64: str          # base64-encoded JPEG/PNG
    mime_type: str = "image/jpeg"
    meal_type: str = "lunch"  # context hint


@router.post("/photo-estimate")
async def estimate_from_photo(
    payload: PhotoEstimateRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2-06: 食事の写真から栄養素を推定（BYOKプランのVision対応プロバイダーのみ）"""
    from .meal_plan import _get_plan_type
    from ..llm.adapter import get_adapter
    from ..security import decrypt

    plan_type = _get_plan_type(current_user.id, db)
    user_plan = db.query(models.UserPlan).filter_by(user_id=current_user.id).first()
    byok_provider = user_plan.byok_provider if user_plan else None

    if plan_type == "free":
        raise HTTPException(
            403,
            "写真推定はBYOKプランのVision対応プロバイダー（Anthropic/OpenAI/Gemini）のみ利用可能です。"
        )

    api_key_row = (
        db.query(models.ApiKey)
        .filter_by(user_id=current_user.id, provider=byok_provider)
        .first()
    )
    if not api_key_row:
        raise HTTPException(400, f"APIキーが未登録です: {byok_provider}")

    api_key = decrypt(api_key_row.encrypted_key)
    byok_model = getattr(user_plan, "byok_model", None) if user_plan else None
    adapter = get_adapter(plan_type, byok_provider, api_key, byok_model)

    if not adapter.supports_vision:
        raise HTTPException(
            403,
            f"{byok_provider} はVision非対応です。Anthropic / OpenAI / Gemini を選択してください。"
        )

    system = """あなたは食事の写真から栄養素を推定する専門AIです。
写真に写っている料理を分析し、以下のJSON形式で回答してください。
```json
{
  "dishes": [
    {
      "name": "料理名",
      "estimated_grams": 数値,
      "kcal": 数値,
      "protein_g": 数値,
      "fat_g": 数値,
      "carb_g": 数値,
      "confidence": "high|medium|low"
    }
  ],
  "total_kcal": 数値,
  "total_protein_g": 数値,
  "total_fat_g": 数値,
  "total_carb_g": 数値,
  "note": "推定の注意点（任意）"
}
```
- 料理が複数あれば dishes 配列にすべて含める
- 量の推定が難しい場合は confidence を "low" にする
- JSONのみを返し、前後に説明文を加えないこと"""

    user_msg = f"この{payload.meal_type}の写真の栄養素を推定してください。"

    try:
        response = await adapter.complete_vision(system, user_msg, payload.image_b64, payload.mime_type)
        raw_text = response.text if hasattr(response, "text") else str(response)
        # Extract JSON from response
        import re, json
        match = re.search(r'\{[\s\S]+\}', raw_text)
        if match:
            result = json.loads(match.group(0))
        else:
            raise ValueError("JSON not found in LLM response")
        # トークン使用量を結果に付加
        from ..llm.adapter import estimate_model_cost_jpy
        cost_info = estimate_model_cost_jpy(
            getattr(response, "model", None),
            getattr(response, "input_tokens", None),
            getattr(response, "output_tokens", None),
        )
        result["_token_usage"] = {
            "input_tokens": getattr(response, "input_tokens", None),
            "output_tokens": getattr(response, "output_tokens", None),
            "llm_model": getattr(response, "model", None),
            **cost_info,
        }
        return result
    except Exception as e:
        raise HTTPException(500, f"推定に失敗しました: {str(e)}")


class MealCopyRequest(BaseModel):
    source_date: str   # YYYY-MM-DD
    target_date: str
    meal_type: str | None = None  # if None, copy all meal types


@router.post("/copy")
async def copy_meal_logs(
    payload: MealCopyRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """S2-07: 過去の食事記録を別日にコピー"""
    q = db.query(models.MealLog).filter(
        models.MealLog.user_id == current_user.id,
        models.MealLog.date == payload.source_date,
    )
    if payload.meal_type:
        q = q.filter(models.MealLog.meal_type == payload.meal_type)

    source_logs = q.all()
    if not source_logs:
        raise HTTPException(404, "コピー元の食事記録が見つかりません")

    new_logs = []
    for src in source_logs:
        new_log = models.MealLog(
            user_id=current_user.id,
            date=payload.target_date,
            meal_type=src.meal_type,
            food_name=src.food_name,
            food_id=src.food_id,
            kcal=src.kcal,
            protein_g=src.protein_g,
            fat_g=src.fat_g,
            carb_g=src.carb_g,
            serving_grams=src.serving_grams,
            source="copy",
        )
        db.add(new_log)
        new_logs.append(new_log)

    db.commit()
    for log in new_logs:
        db.refresh(log)
    return [_log_to_dict(log) for log in new_logs]


@router.get("/history")
async def get_meal_history(
    days: int = 7,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return unique food entries from recent days for quick copy."""
    from datetime import timedelta
    today = dt_date.today()
    start = str(today - timedelta(days=days))
    logs = (
        db.query(models.MealLog)
        .filter(
            models.MealLog.user_id == current_user.id,
            models.MealLog.date >= start,
        )
        .order_by(models.MealLog.date.desc())
        .all()
    )
    seen = set()
    unique = []
    for log in logs:
        key = (log.food_name, log.meal_type)
        if key not in seen:
            seen.add(key)
            unique.append(_log_to_dict(log))
    return unique


@router.get("/daily-kcal")
async def get_daily_kcal(
    days: int = 8,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return daily total kcal for the past N days (excluding base_date itself).
    Used by dashboard to show yesterday and 7-day average."""
    from datetime import timedelta
    from collections import defaultdict
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    start = str(anchor - timedelta(days=days))
    end   = str(anchor - timedelta(days=1))   # exclude today/base_date

    logs = (
        db.query(models.MealLog)
        .filter(
            models.MealLog.user_id == current_user.id,
            models.MealLog.date >= start,
            models.MealLog.date <= end,
        )
        .all()
    )

    totals: dict[str, float] = defaultdict(float)
    for log in logs:
        totals[log.date] += log.kcal or 0

    # Return all dates in range (newest first), zero-filled for missing days
    from datetime import timedelta
    all_dates = [str(anchor - timedelta(days=i + 1)) for i in range(days)]
    return [
        {"date": d, "total_kcal": round(totals[d]) if d in totals else 0}
        for d in all_dates
    ]


@router.get("/daily-nutrition")
async def get_daily_nutrition(
    days: int = 31,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return daily PFC + kcal totals for the past N days (excluding base_date itself).
    Used by dashboard PFC / calorie history graphs."""
    from datetime import timedelta
    from collections import defaultdict
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    start = str(anchor - timedelta(days=days))
    end   = str(anchor - timedelta(days=1))

    logs = (
        db.query(models.MealLog)
        .filter(
            models.MealLog.user_id == current_user.id,
            models.MealLog.date >= start,
            models.MealLog.date <= end,
        )
        .all()
    )

    totals: dict[str, dict] = defaultdict(lambda: {"total_kcal": 0.0, "protein_g": 0.0, "fat_g": 0.0, "carb_g": 0.0})
    for log in logs:
        t = totals[log.date]
        t["total_kcal"] += log.kcal or 0
        t["protein_g"]  += log.protein_g or 0
        t["fat_g"]      += log.fat_g or 0
        t["carb_g"]     += log.carb_g or 0

    # Return all dates in range (newest first), zero-filled for missing days
    from datetime import timedelta
    all_dates = [str(anchor - timedelta(days=i + 1)) for i in range(days)]
    empty = {"total_kcal": 0, "protein_g": 0.0, "fat_g": 0.0, "carb_g": 0.0}
    return [
        {
            "date": d,
            "total_kcal": round(totals[d]["total_kcal"]) if d in totals else 0,
            "protein_g":  round(totals[d]["protein_g"], 1) if d in totals else 0.0,
            "fat_g":      round(totals[d]["fat_g"], 1) if d in totals else 0.0,
            "carb_g":     round(totals[d]["carb_g"], 1) if d in totals else 0.0,
        }
        for d in all_dates
    ]


@router.post("/sync-fatsecret-bulk")
async def sync_fatsecret_bulk(
    days: int = 7,
    base_date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """過去 N 日分の FatSecret 食事ログをまとめて同期。"""
    from datetime import timedelta
    anchor = dt_date.fromisoformat(base_date) if base_date else dt_date.today()
    results = []
    for i in range(days):
        target = str(anchor - timedelta(days=i))
        try:
            synced = await fatsecret.sync_food_diary(current_user.id, target, db)
            results.append({"date": target, "synced": synced})
        except Exception as e:
            results.append({"date": target, "synced": 0, "error": str(e)[:120]})
    return {"results": results, "total_dates": len(results)}


@router.post("/sync-fatsecret")
async def sync_fatsecret_logs(
    date: str | None = None,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """FatSecretの食事ログを指定日付で同期する。"""
    target_date = date or str(dt_date.today())
    try:
        synced = await fatsecret.sync_food_diary(current_user.id, target_date, db)
        return {"synced": synced, "date": target_date}
    except Exception as e:
        # FatSecret未連携 or エラーの場合はスルー（既存データはそのまま）
        return {"synced": 0, "date": target_date, "message": str(e)}


def _log_to_dict(log: models.MealLog) -> dict:
    return {
        "id": log.id,
        "date": log.date,
        "meal_type": log.meal_type,
        "food_name": log.food_name,
        "food_id": log.food_id,
        "kcal": log.kcal,
        "protein_g": log.protein_g,
        "fat_g": log.fat_g,
        "carb_g": log.carb_g,
        "serving_grams": log.serving_grams,
        "source": log.source,
    }
