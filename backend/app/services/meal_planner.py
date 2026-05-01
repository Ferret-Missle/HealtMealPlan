import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from .. import models, security
from ..llm.adapter import get_adapter


SYSTEM_PROMPT = """あなたは健康的な食事の専門家です。指定された条件に基づいて、栄養バランスの取れた献立を提案してください。
回答は必ずJSON形式のみで返してください。JSON以外のテキストは含めないでください。"""


async def generate_menus(plan_id: str, user_id: str, db: Session, conditions: dict | None = None):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    if conditions is None:
        conditions = plan.conditions_json or {}

    # Get group members
    members = db.query(models.GroupMember).filter_by(group_id=plan.group_id).all()
    member_contexts = []
    labels = ["A", "B", "C", "D", "E", "F", "G"]

    for idx, member in enumerate(members):
        label = labels[idx]
        goals = db.query(models.UserGoals).filter_by(user_id=member.user_id).first()
        if not goals:
            continue

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
            if slot.is_dining_out:
                continue
            await _generate_slot_menu(slot, day.date, member_contexts, past_ingredients, user_id, db, conditions)


async def _generate_slot_menu(
    slot: models.MealPlanSlot,
    date: str,
    member_contexts: list,
    past_ingredients: list,
    user_id: str,
    db: Session,
    conditions: dict | None = None,
):
    if conditions is None:
        conditions = {}

    meal_type_str = str(slot.meal_type)
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    sharing_jp = "共有食（全員分）" if slot.sharing_type == "shared" else "個別食"
    members_count = len(member_contexts)

    # ── 条件解析 ──────────────────────────────────────────────
    source_type = getattr(slot, "source_type", None) or "auto"
    kcal_budget = getattr(slot, "kcal_budget", None)
    light_breakfast = conditions.get("light_breakfast", False)
    special_dates = conditions.get("special_dates", [])

    # Source context for prompt
    if source_type == "conbini":
        source_note = (
            "【購入スタイル: コンビニ・スーパー購入】\n"
            "コンビニやスーパーで購入できる商品を具体的に提案してください。\n"
            "例: おにぎり、サンドイッチ、惣菜パン、カップスープ、サラダチキン、冷蔵惣菜など。\n"
            "menu_nameは「おにぎり（鮭）＋野菜サラダ＋ゆで卵」のように具体的な商品名を書いてください。\n"
            "cooking_summaryは「コンビニ購入」と記載してください。"
        )
    elif source_type == "homecook":
        source_note = (
            "【購入スタイル: 自炊】\n"
            "自宅で調理できる料理を提案してください。\n"
            "cooking_summaryに調理手順の概要を記載してください。"
        )
    else:
        source_note = "自炊またはコンビニ購入どちらでも構いません。"

    # Light breakfast note
    breakfast_note = ""
    if meal_type_str == "breakfast" and light_breakfast:
        breakfast_note = "【朝食は軽めに】朝食のカロリーを抑えめ（目標の70〜80%程度）にしてください。消化が良く手軽な内容が理想です。\n"

    # kcal budget note
    kcal_note = ""
    if kcal_budget:
        kcal_note = f"【目標カロリー】この食事の目標カロリーは約 {int(kcal_budget)} kcal です。できるだけ近い値で提案してください。\n"

    member_info = "\n".join([
        f"メンバー{mc['label']}: 1日目標カロリー{mc['target_kcal']}kcal / 目標:{mc['goal_type']}"
        for mc in member_contexts
    ])

    excluded = list(set(
        food
        for mc in member_contexts
        for food in mc.get("excluded_foods", [])
    ))

    user_prompt = f"""以下の条件で{meal_name_jp}（{sharing_jp}・{members_count}名分）の献立を提案してください。

[食事条件]
{breakfast_note}{kcal_note}{source_note}

[メンバー情報]
{member_info}

[共通条件]
除外食材: {", ".join(excluded) if excluded else "なし"}
過去3日の使用食材（重複回避）: {", ".join(past_ingredients) if past_ingredients else "なし"}

[出力形式]
以下のJSON形式で返してください:
{{
  "menu_name": "料理名（コンビニの場合は商品名を具体的に）",
  "kcal_per_serving": 数値,
  "protein_g": 数値,
  "fat_g": 数値,
  "carb_g": 数値,
  "serving_grams": 数値,
  "ingredients": ["食材1", "食材2"],
  "cooking_summary": "調理手順またはコンビニ購入"
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
        data = _fallback_menu(meal_name_jp, source_type)

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


def _fallback_menu(meal_name: str, source_type: str = "auto") -> dict:
    if source_type == "conbini":
        defaults = {
            "朝食": {"menu_name": "おにぎり（鮭）＋野菜サラダ", "kcal_per_serving": 380, "protein_g": 14, "fat_g": 8, "carb_g": 62},
            "昼食": {"menu_name": "サラダチキン＋サンドイッチ＋野菜スープ", "kcal_per_serving": 520, "protein_g": 30, "fat_g": 14, "carb_g": 65},
            "夕食": {"menu_name": "幕の内弁当（コンビニ）", "kcal_per_serving": 600, "protein_g": 25, "fat_g": 18, "carb_g": 80},
        }
    else:
        defaults = {
            "朝食": {"menu_name": "ご飯・味噌汁・卵焼き", "kcal_per_serving": 450, "protein_g": 18, "fat_g": 12, "carb_g": 65},
            "昼食": {"menu_name": "鶏胸肉の野菜炒め定食", "kcal_per_serving": 580, "protein_g": 35, "fat_g": 15, "carb_g": 70},
            "夕食": {"menu_name": "鮭の塩焼き・野菜スープ", "kcal_per_serving": 520, "protein_g": 30, "fat_g": 18, "carb_g": 55},
        }
    base = defaults.get(meal_name, {"menu_name": meal_name, "kcal_per_serving": 500, "protein_g": 20, "fat_g": 15, "carb_g": 65})
    base["serving_grams"] = 300
    base["ingredients"] = []
    base["cooking_summary"] = "コンビニ購入" if source_type == "conbini" else ""
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
        conditions = plan.conditions_json or {}
        past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)
        await _generate_slot_menu(slot, day.date, member_contexts, past_ingredients, user_id, db, conditions)


async def generate_shopping_list(plan_id: str, db: Session):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    shared_ingredients: list[str] = []
    individual_ingredients: dict[str, list[str]] = {}

    for day in plan.days:
        for slot in day.slots:
            if getattr(slot, "source_type", None) == "conbini":
                # コンビニ購入スロットは買い物リスト不要
                continue
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
