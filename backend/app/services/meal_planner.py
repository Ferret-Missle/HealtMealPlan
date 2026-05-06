import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from .. import models, security
from ..llm.adapter import get_adapter


SYSTEM_PROMPT = """あなたは管理栄養士です。指定された目標カロリーとPFCバランス（タンパク質・脂質・炭水化物）に厳密に合わせた具体的な献立を提案してください。

【絶対遵守ルール】
- 「おまかせ」「お好みで」「適量」など曖昧な表現は禁止。必ず具体的な料理名・商品名を提示すること
- 提案料理の serving_grams（1人前の総量g）は、目標カロリーとPFCに ±10% 以内で一致するよう調整
- kcal_per_serving / protein_g / fat_g / carb_g は serving_grams に対する実値を計算して記載
- 複数の料理を組み合わせる場合、menu_name は改行(\\n)区切りで列挙（「＋」記号は使わない）
  例: "鮭おにぎり\\nサラダチキン\\n野菜サラダ"
- 一般的な日本食品の栄養素データを使い、目標値に最も近づく分量を計算すること
- 回答は必ずJSON形式のみで返すこと。JSON以外のテキストは含めない"""


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
        prefs = goals.preferences_json or {}
        member_contexts.append({
            "user_id": member.user_id,
            "label": labels[idx],
            "target_kcal": goals.target_kcal or 2000,
            "p_ratio": (getattr(goals, "target_protein_ratio", None) or 0.30),
            "f_ratio": (getattr(goals, "target_fat_ratio", None) or 0.25),
            "c_ratio": (getattr(goals, "target_carb_ratio", None) or 0.45),
            "goal_type": goals.goal_type or "maintain",
            "preferences": prefs,
            "excluded_foods": goals.excluded_foods_json or [],
            # plan-time に渡された frequent_menus を後段でマージできるようキー予約
            "frequent_menus": (prefs.get("frequent_menus") if isinstance(prefs, dict) else None) or {},
        })

    if not member_contexts:
        return

    # plan 作成時に送られた frequent_menus を member_contexts にマージ
    plan_freq = conditions.get("frequent_menus") if isinstance(conditions, dict) else None
    if isinstance(plan_freq, dict):
        for mc in member_contexts:
            uid_freq = plan_freq.get(mc["user_id"])
            if isinstance(uid_freq, dict):
                # 結合（plan指定が優先 + UserGoals.preferences の値も保持）
                merged = dict(mc.get("frequent_menus") or {})
                for k, v in uid_freq.items():
                    if v:
                        merged[k] = v
                mc["frequent_menus"] = merged

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
        # 個別食 → メンバーごとに個別生成（各人の目標カロリーを正確に反映）
        for mc in member_contexts:
            src = _get_member_source(mc["user_id"], meal_type_str, day_cond_members, slot_source)
            lb = _get_member_light_breakfast(mc["user_id"], day_cond_members)
            data = await _call_llm(
                adapter, slot, meal_type_str, src, lb,
                [mc], past_ingredients
            )
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
            "コンビニやスーパーで購入してそのまま食べられる商品の組み合わせを提案してください。\n"
            "★許可されるもの:\n"
            "  - おにぎり、サンドイッチ、サラダチキン、惣菜パック\n"
            "  - カット済み果物（パイン・バナナ等のすぐ食べられるもの）\n"
            "  - 野菜ジュース・果汁ジュース・スムージー\n"
            "  - ヨーグルト、プリン、納豆、豆腐\n"
            "  - レンジで温めるだけの弁当・おかず\n"
            "★禁止：調理・加工が必要なもの:\n"
            "  - 皮を剥いたりカットが必要な丸ごと果物（りんご・オレンジなど）\n"
            "  - 生の魚・肉、未調理の野菜（人参・ジャガイモ等）\n"
            "  - 米・パスタ・小麦粉などの未調理食品\n"
            "menu_name は商品名を改行区切りで具体的に書く（例：\"鮭おにぎり\\nサラダチキン\\n野菜サラダ\"）\n"
            "cooking_summary は \"コンビニ購入\" と記載"
        )
    elif source_type == "bento":
        source_note = (
            "【購入スタイル: 自作弁当】\n"
            "家で作って持参できるお弁当メニューを提案してください。\n"
            "冷めても美味しく、持ち運びしやすい料理が理想です。\n"
            "menu_name は複数の料理を改行区切りで列挙（例：\"鶏むね唐揚げ\\n卵焼き\\nブロッコリーの胡麻和え\\n玄米\"）\n"
            "cooking_summary に簡単な調理手順を記載してください。"
        )
    elif source_type == "homecook":
        source_note = (
            "【購入スタイル: 自炊】\n"
            "自宅で調理できる料理を提案してください。主菜・副菜・主食をバランスよく組み合わせてOK。\n"
            "menu_name は複数の料理を改行区切りで列挙（例：\"鮭の塩焼き\\n小松菜の煮浸し\\n味噌汁\\nご飯\"）\n"
            "cooking_summary に調理手順の概要を記載してください。"
        )
    else:
        source_note = "自炊またはコンビニ購入どちらでも構いません。"

    breakfast_note = ""
    if meal_type_str == "breakfast" and light_breakfast:
        breakfast_note = "【朝食は軽めに】消化が良く手軽な内容にしてください。\n"

    # メンバー情報（よく食べるメニューも反映）
    member_lines = []
    fav_lines = []
    for mc in member_contexts:
        member_lines.append(f"  - メンバー{mc['label']}: 1日目標 {mc['target_kcal']}kcal / 目標:{mc['goal_type']}")
        favs = (mc.get("frequent_menus") or {}).get(meal_type_str, [])
        if favs:
            fav_lines.append(f"  - メンバー{mc['label']} がよく食べる{ {'breakfast':'朝食','lunch':'昼食','dinner':'夕食'}.get(meal_type_str,'食事') }: {', '.join(favs)}")
    member_info = "\n".join(member_lines)
    fav_section = ("\n[よく食べるメニュー（参考にしてバリエーションを混ぜる）]\n" + "\n".join(fav_lines)) if fav_lines else ""

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
{member_info}{fav_section}

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
        ("conbini", "朝食"): "鮭おにぎり\nゆで卵\n野菜サラダ",
        ("conbini", "昼食"): "サラダチキン\n玄米おにぎり\n野菜スープ",
        ("conbini", "夕食"): "鶏むね弁当\nミニサラダ\nヨーグルト",
        ("bento", "朝食"): "鮭おにぎり\nゆで卵\nミニサラダ",
        ("bento", "昼食"): "鶏むね唐揚げ\n卵焼き\nブロッコリー胡麻和え\n玄米",
        ("bento", "夕食"): "焼き魚\n卵焼き\n煮物\nご飯",
        ("homecook", "朝食"): "ご飯\n味噌汁\n卵焼き\n焼鮭",
        ("homecook", "昼食"): "鶏むね肉の野菜炒め\nご飯\n小鉢",
        ("homecook", "夕食"): "鮭の塩焼き\n野菜の煮物\n味噌汁\nご飯",
    }
    menu_name = name_map.get((source_type, meal_name)) or "鶏むね肉のグリル\n温野菜\nご飯"

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
        prefs = goals.preferences_json or {}
        member_contexts.append({
            "user_id": member.user_id,
            "label": labels[idx],
            "target_kcal": goals.target_kcal or 2000,
            "p_ratio": (getattr(goals, "target_protein_ratio", None) or 0.30),
            "f_ratio": (getattr(goals, "target_fat_ratio", None) or 0.25),
            "c_ratio": (getattr(goals, "target_carb_ratio", None) or 0.45),
            "goal_type": goals.goal_type or "maintain",
            "preferences": prefs,
            "excluded_foods": goals.excluded_foods_json or [],
            # plan-time に渡された frequent_menus を後段でマージできるようキー予約
            "frequent_menus": (prefs.get("frequent_menus") if isinstance(prefs, dict) else None) or {},
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
