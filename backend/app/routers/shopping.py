from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from .. import models
from ..auth_deps import get_current_user

router = APIRouter()


@router.get("/{plan_id}")
async def get_shopping_list(
    plan_id: str,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lists = db.query(models.ShoppingList).filter_by(meal_plan_id=plan_id).all()
    if not lists:
        raise HTTPException(404, "Shopping list not found")

    result = {}
    for sl in lists:
        key = sl.list_type if sl.list_type == "shared" else f"individual_{sl.user_id}"
        result[key] = sl.items_json

    return result
