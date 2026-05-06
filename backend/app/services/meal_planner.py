import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from .. import models, security
from ..llm.adapter import get_adapter


SYSTEM_PROMPT = """あなたは管理栄養士です。指定された目標カロリーとPFCバランス（タンパク質・脂質・炭水化物）に厳密に合わせた献立を提案してください。
- 提案料理の serving_grams（1人前の総量g）は、目標カロリーとPFCに ±10% 以内で一致するよう調整してください
- kcal_per_serving / protein_g / fat_g / carb_g は serving_grams に対する栄養素値を計算して記載してください
- 一般的な食材の栄養素データに基づいて、目標値に最も近づく分量を選んでください
- 回答は必ずJSON形式のみで返してください。JSON以外のテキストは含めないでください。"""


def _meal_ratio(meal_type: str, light_breakfast: bool) -> float:
    """1日のうち各食事に割り当てるカロリー比率。"""
    if light_breakfast:
        return {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}.get(meal_type, 0.33)
    return {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}.get(meal_type, 0.33)


def _slot_targets(meal_type: str, light_breakfast: bool, member_contexts: list) -> dict:
    """グループ平均のkcal/PFC目標を返す。"""
    ratio = _meal_ratio(meal_type, light_breakfast)
    n = max(1, len(member_contexts))
    kcal = sum(mc["target_kcal"] * ratio for mc in member_contexts) / n
    p = sum(mc["target_kcal"] * ratio * mc["p_ratio"] / 4 for mc in member_contexts) / n
    f = sum(mc["target_kcal"] * ratio * mc["f_ratio"] / 9 for mc in member_contexts) / n
    c = sum(mc["target_kcal"] * ratio * mc["c_ratio"] / 4 for mc in member_contexts) / n
    return {"kcal": round(kcal), "protein": round(p, 1), "fat": round(f, 1), "carb": round(c, 1)}


def _get_day_cond_members(day_date: str, conditions: dict) -> list:
    """conditions_json から特定日のメンバー別条件リストを返す。"""
    for day_cond in conditions.get("day_conditions", []):
        if day_cond.get("date") == day_date:
            return day_cond.get("members", [])
    return []


def _get_member_source(mc_uid: str, meal_type: str, day_cond_members: list, default_source: str) -> str:
    cond = next((m for m in day_cond_members if m.get("user_id") == mc_uid), None)
    if cond:
        return cond.get(meal_type) or default_source
    return default_source


def _get_member_light_breakfast(mc_uid: str, day_cond_members: list) -> bool:
    cond = next((m for m in day_cond_members if m.get("user_id") == mc_uid), None)
    return bool(cond.get("light_breakfast")) if cond else False


async def generate_menus(plan_id: str, user_id: str, db: Session, conditions: dict | None = None):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    if conditions is None:
        conditions = plan.conditions_json or {}

    members = db.query(models.GroupMember).filter_by(group_id=plan.group_id).all()
    labels = ["A", "B", "C", "D", "E", "F", "G"]
    member_contexts = []
    for idx, member in enumerate(members):
        goals = db.query(models.UserGoals).filter_by(user_id=member.user_id).first()
        if not goals:
            continue
        member_contexts.append({
            "user_id": member.user_id,
            "label": labels[idx],
            "target_kcal": goals.target_kcal or 2000,
            "p_ratio": (getattr(goals, "target_protein_ratio", None) or 0.30),
            "f_ratio": (getattr(goals, "target_fat_ratio", None) or 0.25),
            "c_ratio": (getattr(goals, "target_carb_ratio", None) or 0.45),
            "goal_type": goals.goal_type or "maintain",
            "preferences": goals.preferences_json or {},
            "excluded_foods": goals.excluded_foods_json or [],
        })

    if not member_contexts:
        return

    past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)

    for day in plan.days:
        day_cond_members = _get_day_cond_members(day.date, conditions)
        for slot in day.slots:
            if slot.is_dining_out:
                continue
            await _generate_slot_menu(
                slot, day.date, member_contexts, past_ingredients,
                user_id, db, conditions, day_cond_members
            )


async def _generate_slot_menu(
    slot: models.MealPlanSlot,
    date: str,
    member_contexts: list,
    past_ingredients: list,
    user_id: str,
    db: Session,
    conditions: dict | None = None,
    day_cond_members: list | None = None,
):
    if conditions is None:
        conditions = {}
    if day_cond_members is None:
        day_cond_members = []

    meal_type_str = str(slot.meal_type)
    slot_source = getattr(slot, "source_type", None) or ("homecook" if meal_type_str == "dinner" else "conbini")

    adapter = _get_llm_adapter(user_id, db)

    if slot.sharing_type == "shared":
        light_breakfast = any(m.get("light_breakfast") for m in day_cond_members)
        data = await _call_llm(
            adapter, slot, meal_type_str, slot_source, light_breakfast,
            member_contexts, past_ingredients
        )
        db.add(_make_item(slot.id, None, data, meal_type_str))
    else:
        # メンバーを (source, light_breakfast) でグルーピング → ソースごとに1回 LLM 呼び出し
        groups: dict[tuple, list] = {}
        for mc in member_contexts:
            src = _get_member_source(mc["user_id"], meal_type_str, day_cond_members, slot_source)
            lb = _get_member_light_breakfast(mc["user_id"], day_cond_members)
            key = (src, lb)
            groups.setdefault(key, []).append(mc)

        for (src, lb), members_group in groups.items():
            data = await _call_llm(
                adapter, slot, meal_type_str, src, lb,
                members_group, past_ingredients
            )
            for mc in members_group:
                db.add(_make_item(slot.id, mc["label"], data, meal_type_str))

    db.commit()


async def _call_llm(
    adapter, slot, meal_type_str: str, source_type: str, light_breakfast: bool,
    member_contexts: list, past_ingredients: list
) -> dict:
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    sharing_jp = "共有食（全員分同じ料理）" if slot.sharing_type == "shared" else "個別食"
    members_count = len(member_contexts)

    # グループ平均の kcal/PFC 目標を計算
    targets = _slot_targets(meal_type_str, light_breakfast, member_contexts)

    if source_type == "conbini":
        source_note = (
            "【購入スタイル: コンビニ・スーパー購入】\n"
            "コンビニやスーパーで購入できる商品の組み合わせで目標値に近づけてください。\n"
            "例: おにぎり＋サラダチキン＋野菜サラダ、サンドイッチ＋ヨーグルト など。\n"
            "menu_name は組み合わせた商品名を具体的に書いてください（例：『鮭おにぎり＋サラダチキン＋野菜サラダ』）。\n"
            "cooking_summary は「コンビニ購入」と記載してください。"
        )
    elif source_type == "bento":
        source_note = (
            "【購入スタイル: 自作弁当】\n"
            "家で作って持参できるお弁当メニューを提案してください。\n"
            "冷めても美味しく、持ち運びしやすい料理が理想です。\n"
            "cooking_summary に簡単な調理手順を記載してください。"
        )
    elif source_type == "homecook":
        source_note = (
            "【購入スタイル: 自炊】\n"
            "自宅で調理できる料理を提案してください。主菜・副菜・主食をバランスよく組み合わせてOK。\n"
            "cooking_summary に調理手順の概要を記載してください。"
        )
    else:
        source_note = "自炊またはコンビニ購入どちらでも構いません。"

    breakfast_note = ""
    if meal_type_str == "breakfast" and light_breakfast:
        breakfast_note = "【朝食は軽めに】消化が良く手軽な内容（おにぎり、ヨーグルト、フルーツなど）にしてください。\n"

    member_info = "\n".join([
        f"  - メンバー{mc['label']}: 1日目標 {mc['target_kcal']}kcal / 目標:{mc['goal_type']}"
        for mc in member_contexts
    ])

    excluded = list(set(food for mc in member_contexts for food in mc.get("excluded_foods", [])))

    user_prompt = f"""以下の条件で{meal_name_jp}（{sharing_jp}・{members_count}名分）の献立を提案してください。

[★ 1人あたりの栄養目標（必ず ±10% 以内で合わせる）]
- カロリー: 約 {targets['kcal']} kcal
- タンパク質 (P): 約 {targets['protein']} g
- 脂質 (F): 約 {targets['fat']} g
- 炭水化物 (C): 約 {targets['carb']} g

[食事条件]
{breakfast_note}{source_note}

[メンバー情報]
{member_info}

[除外/重複]
除外食材: {", ".join(excluded) if excluded else "なし"}
過去3日の使用食材（重複回避推奨）: {", ".join(past_ingredients) if past_ingredients else "なし"}

[出力ルール]
- serving_grams は 1 人前の総重量（g）。料理の量で目標 kcal/PFC に合わせること。
- kcal_per_serving / protein_g / fat_g / carb_g は serving_grams に対する栄養素値（実測した実値）。
- 一般的な日本食品の栄養素データを使い、目標値に最も近い分量を計算すること。
- ingredients は使用する食材名を具体的にリスト化（コンビニの場合は商品名）。

[出力形式]
以下のJSON形式のみで返してください（説明文不要）:
{{
  "menu_name": "料理名または商品の組み合わせ",
  "kcal_per_serving": 数値,
  "protein_g": 数値,
  "fat_g": 数値,
  "carb_g": 数値,
  "serving_grams": 数値,
  "ingredients": ["食材1", "食材2"],
  "cooking_summary": "調理手順またはコンビニ購入"
}}"""

    try:
        result = await adapter.complete(SYSTEM_PROMPT, user_prompt)
        raw = result.text if hasattr(result, "text") else str(result)
        return _parse_json_response(raw)
    except Exception:
        return _fallback_menu(meal_name_jp, source_type, targets)


def _make_item(slot_id: str, user_label: str | None, data: dict, meal_type_str: str) -> models.MealPlanItem:
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    return models.MealPlanItem(
        id=str(uuid.uuid4()),
        meal_plan_slot_id=slot_id,
        user_id=user_label,
        menu_name=data.get("menu_name", meal_name_jp),
        kcal=data.get("kcal_per_serving"),
        protein_g=data.get("protein_g"),
        fat_g=data.get("fat_g"),
        carb_g=data.get("carb_g"),
        serving_grams=data.get("serving_grams"),
        ingredients_json=data.get("ingredients", []),
        cooking_summary=data.get("cooking_summary"),
    )


def _get_llm_adapter(user_id: str, db: Session):
    plan_rec = db.query(models.UserPlan).filter_by(user_id=user_id).first()
    plan_type = plan_rec.plan_type if plan_rec else "free"
    byok_provider = plan_rec.byok_provider if plan_rec else None

    api_key = None
    if plan_type == "byok" and byok_provider:
        key_rec = db.query(models.ApiKey).filter_by(user_id=user_id, provider=byok_provider).first()
        if key_rec:
            api_key = security.decrypt(key_rec.encrypted_key)

    return get_adapter(plan_type, byok_provider, api_key)


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


def _fallback_menu(meal_name: str, source_type: str = "auto", targets: dict | None = None) -> dict:
    """LLM呼び出しが失敗した場合のフォールバック。targetsがあればそれを使う。"""
    name_map = {
        ("conbini", "朝食"): "おにぎり＋ゆで卵＋サラダ（コンビニ）",
        ("conbini", "昼食"): "サラダチキン＋おにぎり＋野菜スープ（コンビニ）",
        ("conbini", "夕食"): "鶏むね弁当＋サラダ（コンビニ）",
        ("bento", "朝食"): "鮭おにぎり＋ゆで卵＋ミニサラダ",
        ("bento", "昼食"): "鶏むね肉弁当（玄米・卵焼き・野菜）",
        ("bento", "夕食"): "幕の内弁当（魚・卵焼き・煮物）",
        ("homecook", "朝食"): "ご飯・味噌汁・卵焼き・焼鮭",
        ("homecook", "昼食"): "鶏むね肉の野菜炒め定食",
        ("homecook", "夕食"): "鮭の塩焼き・小鉢・味噌汁",
    }
    menu_name = name_map.get((source_type, meal_name)) or f"{meal_name}（おまかせ）"

    if targets:
        kcal = targets.get("kcal", 500)
        p = targets.get("protein", 20)
        f = targets.get("fat", 15)
        c = targets.get("carb", 65)
    else:
        # ざっくりデフォルト
        defaults_by_meal = {"朝食": (450, 18, 12, 65), "昼食": (600, 30, 18, 70), "夕食": (550, 28, 18, 60)}
        kcal, p, f, c = defaults_by_meal.get(meal_name, (500, 20, 15, 65))

    return {
        "menu_name": menu_name,
        "kcal_per_serving": kcal,
        "protein_g": p,
        "fat_g": f,
        "carb_g": c,
        "serving_grams": max(200, round(kcal * 0.6)),  # 大まかに kcal × 0.6 (g)
        "ingredients": [],
        "cooking_summary": "コンビニ購入" if source_type == "conbini" else "",
    }


async def generate_slot_menu(
    plan_id: str,
    slot_id: str,
    user_id: str,
    db: Session,
    target_user_ids: list[str] | None = None,
):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    slot = db.query(models.MealPlanSlot).filter_by(id=slot_id).first()
    if not slot:
        return

    day = None
    for d in plan.days:
        if slot in d.slots:
            day = d
            break
    if not day:
        return

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
            "user_id": member.user_id,
            "label": labels[idx],
            "target_kcal": goals.target_kcal or 2000,
            "p_ratio": (getattr(goals, "target_protein_ratio", None) or 0.30),
            "f_ratio": (getattr(goals, "target_fat_ratio", None) or 0.25),
            "c_ratio": (getattr(goals, "target_carb_ratio", None) or 0.45),
            "goal_type": goals.goal_type or "maintain",
            "preferences": goals.preferences_json or {},
            "excluded_foods": goals.excluded_foods_json or [],
        })

    if member_contexts:
        conditions = plan.conditions_json or {}
        day_cond_members = _get_day_cond_members(day.date, conditions)
        past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)
        await _generate_slot_menu(
            slot, day.date, member_contexts, past_ingredients,
            user_id, db, conditions, day_cond_members
        )


async def generate_shopping_list(plan_id: str, db: Session):
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    shared_ingredients: list[str] = []
    individual_ingredients: dict[str, list[str]] = {}

    for day in plan.days:
        for slot in day.slots:
            if getattr(slot, "source_type", None) in ("conbini", "bento"):
                continue
            for item in slot.items:
                ingredients = item.ingredients_json or []
                if item.user_id is None:
                    shared_ingredients.extend(ingredients)
                else:
                    if item.user_id not in individual_ingredients:
                        individual_ingredients[item.user_id] = []
                    individual_ingredients[item.user_id].extend(ingredients)

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
