import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from .. import models, security
from ..llm.adapter import get_adapter


SYSTEM_PROMPT = """あなたは健康的な食事の専門家です。指定された条件に基づいて、栄養バランスの取れた献立を提案してください。
回答は必ずJSON形式のみで返してください。JSON以外のテキストは含めないでください。"""


async def generate_menus(plan_id: str, user_id: str, db: Session):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    # Get group members
    members = db.query(models.GroupMember).filter_by(group_id=plan.group_id).all()
    member_contexts = []
    labels = ["A", "B", "C", "D", "E", "F", "G"]

    for idx, member in enumerate(members):
        label = labels[idx]
        goals = db.query(models.UserGoals).filter_by(user_id=member.user_id).first()
        if not goals:
            continue

        latest_weight = (
            db.query(models.WeightLog)
            .filter_by(user_id=member.user_id)
            .order_by(models.WeightLog.date.desc())
            .first()
        )

        member_contexts.append({
            "label": f"メンバー{label}",
            "target_kcal": goals.target_kcal or 2000,
            "goal_type": goals.goal_type or "maintain",
            "preferences": goals.preferences_json or {},
            "excluded_foods": goals.excluded_foods_json or [],
        })

    if not member_contexts:
        return

    # Get past 3 days ingredients for dedup
    past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)

    # Generate for each day slot
    for day in plan.days:
        for slot in day.slots:
            await _generate_slot_menu(slot, day.date, member_contexts, past_ingredients, user_id, db)


async def _generate_slot_menu(
    slot: models.MealPlanSlot,
    date: str,
    member_contexts: list,
    past_ingredients: list,
    user_id: str,
    db: Session,
):
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(str(slot.meal_type), "食事")
    sharing_jp = "共有食" if slot.sharing_type == "shared" else "個別食"
    members_count = len(member_contexts)

    member_info = "\n".join([
        f"メンバー{mc['label']}: 目標カロリー{mc['target_kcal']}kcal / 目標:{mc['goal_type']}"
        for mc in member_contexts
    ])

    excluded = list(set(
        food
        for mc in member_contexts
        for food in mc.get("excluded_foods", [])
    ))

    user_prompt = f"""以下の条件で{meal_name_jp}（{sharing_jp}・{members_count}名分）の献立を提案してください。

[メンバー情報]
{member_info}

[共通条件]
除外食材: {", ".join(excluded) if excluded else "なし"}
過去3日の使用食材（重複回避）: {", ".join(past_ingredients) if past_ingredients else "なし"}

[出力形式]
以下のJSON形式で返してください:
{{
  "menu_name": "料理名",
  "kcal_per_serving": 数値,
  "protein_g": 数値,
  "fat_g": 数値,
  "carb_g": 数値,
  "serving_grams": 数値,
  "ingredients": ["食材1", "食材2"],
  "cooking_summary": "調理手順の概要"
}}"""

    # Get LLM adapter for user
    plan_rec = db.query(models.UserPlan).filter_by(user_id=user_id).first()
    plan_type = plan_rec.plan_type if plan_rec else "free"
    byok_provider = plan_rec.byok_provider if plan_rec else None

    api_key = None
    if plan_type == "byok" and byok_provider:
        key_rec = db.query(models.ApiKey).filter_by(user_id=user_id, provider=byok_provider).first()
        if key_rec:
            api_key = security.decrypt(key_rec.encrypted_key)

    adapter = get_adapter(plan_type, byok_provider, api_key)

    try:
        raw = await adapter.complete(SYSTEM_PROMPT, user_prompt)
        data = _parse_json_response(raw)
    except Exception:
        data = _fallback_menu(meal_name_jp)

    # Save items to DB
    if slot.sharing_type == "shared":
        item = models.MealPlanItem(
            id=str(uuid.uuid4()),
            meal_plan_slot_id=slot.id,
            user_id=None,  # shared
            menu_name=data.get("menu_name", meal_name_jp),
            kcal=data.get("kcal_per_serving"),
            protein_g=data.get("protein_g"),
            fat_g=data.get("fat_g"),
            carb_g=data.get("carb_g"),
            serving_grams=data.get("serving_grams"),
            ingredients_json=data.get("ingredients", []),
            cooking_summary=data.get("cooking_summary"),
        )
        db.add(item)
    else:
        for mc in member_contexts:
            item = models.MealPlanItem(
                id=str(uuid.uuid4()),
                meal_plan_slot_id=slot.id,
                user_id=mc["label"],  # Use label for privacy
                menu_name=data.get("menu_name", meal_name_jp),
                kcal=data.get("kcal_per_serving"),
                protein_g=data.get("protein_g"),
                fat_g=data.get("fat_g"),
                carb_g=data.get("carb_g"),
                serving_grams=data.get("serving_grams"),
                ingredients_json=data.get("ingredients", []),
                cooking_summary=data.get("cooking_summary"),
            )
            db.add(item)

    db.commit()


def _get_past_ingredients(group_id: str, start_date: str, db: Session) -> list:
    since = str(dt_date.fromisoformat(start_date) - timedelta(days=3))
    members = db.query(models.GroupMember).filter_by(group_id=group_id).all()
    ingredients = set()
    for member in members:
        logs = (
            db.query(models.MealLog)
            .filter(
                models.MealLog.user_id == member.user_id,
                models.MealLog.date >= since,
            )
            .all()
        )
        for log in logs:
            ingredients.add(log.food_name)
    return list(ingredients)[:20]


def _parse_json_response(text: str) -> dict:
    text = text.strip()
    if "```json" in text:
        text = text.split("```json")[1].split("```")[0].strip()
    elif "```" in text:
        text = text.split("```")[1].split("```")[0].strip()
    return json.loads(text)


def _fallback_menu(meal_name: str) -> dict:
    defaults = {
        "朝食": {"menu_name": "ご飯・味噌汁・卵焼き", "kcal_per_serving": 450, "protein_g": 18, "fat_g": 12, "carb_g": 65},
        "昼食": {"menu_name": "鶏胸肉の野菜炒め定食", "kcal_per_serving": 580, "protein_g": 35, "fat_g": 15, "carb_g": 70},
        "夕食": {"menu_name": "鮭の塩焼き・野菜スープ", "kcal_per_serving": 520, "protein_g": 30, "fat_g": 18, "carb_g": 55},
    }
    base = defaults.get(meal_name, {"menu_name": meal_name, "kcal_per_serving": 500, "protein_g": 20, "fat_g": 15, "carb_g": 65})
    base["serving_grams"] = 300
    base["ingredients"] = []
    base["cooking_summary"] = ""
    return base


async def generate_slot_menu(
    plan_id: str,
    slot_id: str,
    user_id: str,
    db: Session,
    target_user_ids: list[str] | None = None,
):
    """特定スロットのみを再生成（メニュー差し替え機能）"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    slot = db.query(models.MealPlanSlot).filter_by(id=slot_id).first()
    if not slot:
        return

    # Find the day date for this slot
    day = None
    for d in plan.days:
        if slot in d.slots:
            day = d
            break
    if not day:
        return

    # Build member contexts
    members = db.query(models.GroupMember).filter_by(group_id=plan.group_id).all()
    if target_user_ids:
        members = [m for m in members if m.user_id in target_user_ids]

    labels = ["A", "B", "C", "D", "E", "F", "G"]
    member_contexts = []
    for idx, member in enumerate(members):
        goals = db.query(models.UserGoals).filter_by(user_id=member.user_id).first()
        if not goals:
            continue
        member_contexts.append({
            "label": labels[idx],
            "target_kcal": goals.target_kcal or 2000,
            "goal_type": goals.goal_type or "maintain",
            "preferences": goals.preferences_json or {},
            "excluded_foods": goals.excluded_foods_json or [],
        })

    if member_contexts:
        past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)
        await _generate_slot_menu(slot, day.date, member_contexts, past_ingredients, user_id, db)


async def generate_shopping_list(plan_id: str, db: Session):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    shared_ingredients: list[str] = []
    individual_ingredients: dict[str, list[str]] = {}

    for day in plan.days:
        for slot in day.slots:
            for item in slot.items:
                ingredients = item.ingredients_json or []
                if item.user_id is None:
                    shared_ingredients.extend(ingredients)
                else:
                    if item.user_id not in individual_ingredients:
                        individual_ingredients[item.user_id] = []
                    individual_ingredients[item.user_id].extend(ingredients)

    # Deduplicate
    shared_unique = list(dict.fromkeys(shared_ingredients))
    sl = models.ShoppingList(
        id=str(uuid.uuid4()),
        meal_plan_id=plan_id,
        list_type="shared",
        user_id=None,
        items_json=shared_unique,
    )
    db.add(sl)

    for user_label, items in individual_ingredients.items():
        sl_ind = models.ShoppingList(
            id=str(uuid.uuid4()),
            meal_plan_id=plan_id,
            list_type="individual",
            user_id=user_label,
            items_json=list(dict.fromkeys(items)),
        )
        db.add(sl_ind)

    db.commit()
