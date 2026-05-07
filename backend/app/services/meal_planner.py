import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from .. import models, security
from ..llm.adapter import get_adapter


# ─── 進捗管理 ──────────────────────────────────────────────────
MEAL_JP_MAP = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}


def _set_progress(plan_id: str, db: Session, step: int, total: int, message: str, done: bool = False, error: bool = False):
    """plan.conditions_json に進捗情報を書き込む。"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return
    cond = dict(plan.conditions_json or {})
    cond["_progress"] = {
        "step": step,
        "total": total,
        "message": message,
        "done": done,
        "error": error,
    }
    plan.conditions_json = cond
    flag_modified(plan, "conditions_json")
    db.commit()


SYSTEM_PROMPT = """あなたは家庭料理に詳しい管理栄養士です。指定された目標カロリーとPFCバランス（タンパク質・脂質・炭水化物）に厳密に合わせ、家庭で作りやすい現実的な献立を提案してください。

【絶対遵守ルール】
- 「おまかせ」「お好みで」「適量」など曖昧な表現は禁止。必ず具体的な料理名・商品名を提示すること
- 提案料理の serving_grams（1人前の総量g）は、目標カロリーとPFCに ±10% 以内で一致するよう調整
- kcal_per_serving / protein_g / fat_g / carb_g は serving_grams に対する実値を計算して記載
- 複数の料理を組み合わせる場合、menu_name は改行(\\n)区切りで列挙（「＋」記号は使わない）
- 一般的な日本食品の栄養素データを使い、目標値に最も近づく分量を計算すること
- 回答は必ずJSON形式のみで返すこと。JSON以外のテキストは含めない

【家庭料理重視（コスト・入手性）】
- スーパーで普通に買える食材を使う。家庭料理として一般的な献立にすること
- 推奨食材: 鶏むね肉/鶏もも肉/豚こま肉/豚バラ肉/挽き肉/卵/豆腐/納豆/鮭/サバ/ツナ缶/玉ねぎ/人参/キャベツ/もやし/ほうれん草/小松菜/ピーマン/ブロッコリー/きのこ類/じゃがいも
- 高価/特殊で家庭料理に向かない食材は避ける:
  ✗ 和牛/牛ヒレ/サーロイン/ラム/ジビエ
  ✗ 鯛/ウニ/イクラ/カニ/伊勢海老/フォアグラ/トリュフ/キャビア
  ✗ 業務用調味料、特殊スパイス（家庭にないもの）
- 凝った技法（低温調理、本格的な煮込み数時間など）は避け、20-40分で作れる現実的な料理に

【食材集約（買い物まとめ重視）】
- 1週間の献立で食材をなるべく重複させ、買い物リストが集約されるよう設計
- 主菜のタンパク源は週で2-3種類に絞る（例: 鶏むね・豚こま・鮭の3種をローテーション）
- 同じ食材を異なる調理法・味付けで使い回す（例: 鶏むね → 月：照り焼き／水：油淋鶏／金：チキン南蛮）
- 野菜も週で5-7種類に絞り、複数日で活用する
- 調味料も家庭にある定番（醤油・みりん・酒・味噌・コンソメ・中華だし・カレー粉等）の範囲で

【バラエティ（食材集約と両立）】
- メニュー名は毎日変える（同じ料理の繰り返しは厳禁）
- 同じタンパク源でも調理法・味付け・系統（和洋中）を変えてバラエティを出す
- 食材は集約しつつ、料理としては別物に見せる工夫を

【cooking_summary の書き方（重要）】
- 手順は **必ず1手順ごとに改行(\\n)** で区切ること。1行に複数手順を詰め込まない
- 各手順は「番号. 動詞で始まる短い指示」の形式
- 良い例: "1. 鶏むね肉を一口大に切る\\n2. 塩こしょうを振り片栗粉をまぶす\\n3. フライパンに油を熱する\\n4. 鶏肉を中火で両面焼く\\n5. 醤油・みりん・砂糖を加え煮絡める"
- 悪い例（NG）: "鶏肉を切って塩こしょうしてから片栗粉をまぶし、フライパンで焼いて..." ← 改行なし禁止
- コンビニの場合は "セブンイレブン購入" の1行のみでOK"""


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

    # 全自炊スロット数を計算（進捗total用）
    total_slots = sum(
        1 for d in plan.days for s in d.slots if not s.is_dining_out
    )
    _set_progress(plan_id, db, 0, total_slots, "🔍 メンバー情報と目標カロリーを準備中...")

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

    meal_order = {"breakfast": 0, "lunch": 1, "dinner": 2}
    plan_done_by_meal: dict[str, list[str]] = {"breakfast": [], "lunch": [], "dinner": []}
    # プラン内で使用済みの食材を集約（再利用を促す）
    plan_used_ingredients: list[str] = []
    sorted_days = sorted(plan.days, key=lambda d: d.date)
    done_count = 0
    for day in sorted_days:
        day_cond_members = _get_day_cond_members(day.date, conditions)
        sorted_slots = sorted(
            [s for s in day.slots if not s.is_dining_out],
            key=lambda s: meal_order.get(str(s.meal_type), 99),
        )
        same_day_done: list[str] = []
        for slot in sorted_slots:
            mt = str(slot.meal_type)
            meal_jp = MEAL_JP_MAP.get(mt, mt)
            sharing_jp = "共有" if slot.sharing_type == "shared" else "個別"
            _set_progress(
                plan_id, db, done_count, total_slots,
                f"📅 {day.date} の{meal_jp}（{sharing_jp}）を生成中... ({done_count + 1}/{total_slots})",
            )
            new_names, new_ings = await _generate_slot_menu(
                slot, day.date, member_contexts, past_ingredients,
                user_id, db, conditions, day_cond_members,
                same_day_done=same_day_done,
                recent_same_meal=plan_done_by_meal.get(mt, [])[-5:],
                plan_used_ingredients=plan_used_ingredients,
            )
            if new_names:
                same_day_done.extend(new_names)
                plan_done_by_meal.setdefault(mt, []).extend(new_names)
            if new_ings:
                plan_used_ingredients.extend(new_ings)
            done_count += 1

    _set_progress(plan_id, db, total_slots, total_slots, "✅ 生成完了", done=True)


async def _generate_slot_menu(
    slot: models.MealPlanSlot,
    date: str,
    member_contexts: list,
    past_ingredients: list,
    user_id: str,
    db: Session,
    conditions: dict | None = None,
    day_cond_members: list | None = None,
    same_day_done: list[str] | None = None,
    recent_same_meal: list[str] | None = None,
    plan_used_ingredients: list[str] | None = None,
):
    if conditions is None:
        conditions = {}
    if day_cond_members is None:
        day_cond_members = []
    if same_day_done is None:
        same_day_done = []
    if recent_same_meal is None:
        recent_same_meal = []
    if plan_used_ingredients is None:
        plan_used_ingredients = []

    meal_type_str = str(slot.meal_type)
    slot_source = getattr(slot, "source_type", None) or ("homecook" if meal_type_str == "dinner" else "conbini")

    adapter = _get_llm_adapter(user_id, db)

    new_names: list[str] = []
    new_ingredients: list[str] = []

    if slot.sharing_type == "shared":
        light_breakfast = any(m.get("light_breakfast") for m in day_cond_members)
        data = await _call_llm(
            adapter, slot, meal_type_str, slot_source, light_breakfast,
            member_contexts, past_ingredients, same_day_done, recent_same_meal,
            plan_used_ingredients,
        )
        db.add(_make_item(slot.id, None, data, meal_type_str))
        if data.get("menu_name"):
            new_names.append(data["menu_name"])
        if data.get("ingredients"):
            new_ingredients.extend([str(x) for x in data["ingredients"] if x])
    else:
        for mc in member_contexts:
            src = _get_member_source(mc["user_id"], meal_type_str, day_cond_members, slot_source)
            lb = _get_member_light_breakfast(mc["user_id"], day_cond_members)
            data = await _call_llm(
                adapter, slot, meal_type_str, src, lb,
                [mc], past_ingredients, same_day_done, recent_same_meal,
                plan_used_ingredients,
            )
            db.add(_make_item(slot.id, mc["label"], data, meal_type_str))
            if data.get("menu_name"):
                new_names.append(data["menu_name"])
            if data.get("ingredients"):
                new_ingredients.extend([str(x) for x in data["ingredients"] if x])

    db.commit()
    return new_names, new_ingredients


async def _call_llm(
    adapter, slot, meal_type_str: str, source_type: str, light_breakfast: bool,
    member_contexts: list, past_ingredients: list,
    same_day_done: list[str] | None = None,
    recent_same_meal: list[str] | None = None,
    plan_used_ingredients: list[str] | None = None,
) -> dict:
    same_day_done = same_day_done or []
    recent_same_meal = recent_same_meal or []
    plan_used_ingredients = plan_used_ingredients or []
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    sharing_jp = "共有食（全員分同じ料理）" if slot.sharing_type == "shared" else "個別食"
    members_count = len(member_contexts)

    # グループ平均の kcal/PFC 目標を計算
    targets = _slot_targets(meal_type_str, light_breakfast, member_contexts)

    if source_type == "conbini":
        source_note = (
            "【購入スタイル: コンビニ・スーパー購入】\n"
            "★店舗統一ルール: 必ず【セブンイレブン】1店舗で買える商品のみで構成すること。\n"
            "  - 複数のコンビニを跨いで買い回るような提案は厳禁\n"
            "  - セブンイレブンで通常販売されている定番商品名を使う\n"
            "  - どうしてもセブンに該当商品がない場合のみ、代わりに『大手スーパー（イトーヨーカドー等）』で代用可\n"
            "そのまま食べられる商品の組み合わせを提案してください。\n"
            "★許可されるもの:\n"
            "  - おにぎり（鮭/梅/ツナマヨ/昆布等の定番）、サンドイッチ、サラダチキン、惣菜パック\n"
            "  - カット済み果物（パイン・バナナ等のすぐ食べられるもの）\n"
            "  - 野菜ジュース・果汁ジュース・スムージー\n"
            "  - ヨーグルト、プリン、納豆、豆腐\n"
            "  - レンジで温めるだけの弁当・おかず\n"
            "★禁止：調理・加工が必要なもの:\n"
            "  - 皮を剥いたりカットが必要な丸ごと果物（りんご・オレンジなど）\n"
            "  - 生の魚・肉、未調理の野菜（人参・ジャガイモ等）\n"
            "  - 米・パスタ・小麦粉などの未調理食品\n"
            "menu_name は商品名を改行区切りで具体的に書く（例：\"セブンイレブン 鮭おにぎり\\nセブンイレブン サラダチキン プレーン\\nセブンイレブン 千切りキャベツ\"）\n"
            "cooking_summary は \"セブンイレブン購入\" と記載"
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
    elif source_type == "drink_only":
        source_note = (
            "【購入スタイル: 飲み物のみ】\n"
            "固形物は提案しないでください。代わりに以下のような飲み物のみを提案してください：\n"
            "  - プロテインドリンク（ザバス、SAVAS MILK PROTEIN 等の市販品）\n"
            "  - 野菜ジュース・果汁ジュース・スムージー\n"
            "  - 完全食ドリンク（COMP、Huel など）\n"
            "  - 豆乳・牛乳・甘酒\n"
            "  - 栄養補助ドリンク（カロリーメイト リキッド 等）\n"
            "目標 kcal/PFC に近づくよう、複数の飲み物を組み合わせて構いません。\n"
            "menu_name は商品名を改行区切り（例：\"ザバス ミルクプロテイン\\n野菜ジュース\"）\n"
            "cooking_summary は \"飲み物のみ\" と記載"
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

    # 同日内ですでに提案済みのメニューを抽出（朝→昼→夕の順で蓄積される）
    same_day_section = ""
    if same_day_done:
        same_day_flat = "; ".join(s.replace("\n", " / ") for s in same_day_done)
        same_day_section = (
            f"\n[★ 同日内で既に提案済みのメニュー（必ず避ける）]\n"
            f"{same_day_flat}\n"
            f"上記と似た組み合わせ（例：おにぎり+サラダチキンの繰り返し、同じ主食、同じタンパク源）は厳禁。\n"
            f"主食・主菜・タンパク源・調理法を変えてバリエーションを出してください。\n"
        )

    # プラン内ですでに使用された食材（買い物まとめのため再活用を促す）
    plan_used_section = ""
    if plan_used_ingredients:
        # 重複を除き使用回数の多い順に最大15個
        from collections import Counter
        counter = Counter(plan_used_ingredients)
        top_used = [ing for ing, _ in counter.most_common(15)]
        plan_used_section = (
            f"\n[★ プラン内で既に使用された食材（買い物まとめのため積極的に再活用）]\n"
            f"{', '.join(top_used)}\n"
            f"上記の食材を異なる調理法・味付けで使い回すことで、買い物リストを集約してください。\n"
            f"全く新しい食材を毎回追加するのではなく、これらの食材を中心にメニューを構成すること。\n"
        )

    # 同じ食事タイプでプラン内の他日に提案済みのメニュー（連続/類似を避ける）
    meal_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    recent_section = ""
    if recent_same_meal:
        recent_flat = "; ".join(s.replace("\n", " / ") for s in recent_same_meal)
        recent_section = (
            f"\n[★ プラン内の他日の{meal_jp}（連続を避ける）]\n"
            f"{recent_flat}\n"
            f"上記と同じ料理や、主菜・主食・タンパク源が同じ料理は出さないでください。\n"
            f"7日間でバラエティ豊かになるよう、和洋中・主食種類・タンパク源（鶏/豚/牛/魚/卵/豆/海鮮）・調理法を毎回変えること。\n"
        )

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
過去3日の使用食材（重複回避推奨）: {", ".join(past_ingredients) if past_ingredients else "なし"}{plan_used_section}{same_day_section}{recent_section}

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
        data = _parse_json_response(raw)
        # トークン使用量を結果データに付加
        data["_input_tokens"] = getattr(result, "input_tokens", None)
        data["_output_tokens"] = getattr(result, "output_tokens", None)
        data["_llm_model"] = getattr(result, "model", None)
        return data
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
        input_tokens=data.get("_input_tokens"),
        output_tokens=data.get("_output_tokens"),
        llm_model=data.get("_llm_model"),
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
        ("conbini", "朝食"): "セブンイレブン 鮭おにぎり\nセブンイレブン ゆで卵\nセブンイレブン 野菜サラダ",
        ("conbini", "昼食"): "セブンイレブン サラダチキン\nセブンイレブン 玄米おにぎり\nセブンイレブン 野菜スープ",
        ("conbini", "夕食"): "セブンイレブン 鶏むね弁当\nセブンイレブン ミニサラダ\nセブンイレブン ヨーグルト",
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
        "cooking_summary": "セブンイレブン購入" if source_type == "conbini" else "",
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
        # plan-time の frequent_menus をマージ
        plan_freq = conditions.get("frequent_menus") if isinstance(conditions, dict) else None
        if isinstance(plan_freq, dict):
            for mc in member_contexts:
                uid_freq = plan_freq.get(mc["user_id"])
                if isinstance(uid_freq, dict):
                    merged = dict(mc.get("frequent_menus") or {})
                    for k, v in uid_freq.items():
                        if v:
                            merged[k] = v
                    mc["frequent_menus"] = merged

        day_cond_members = _get_day_cond_members(day.date, conditions)
        past_ingredients = _get_past_ingredients(plan.group_id, plan.start_date, db)
        # 同日の他スロットで既に生成されているメニュー名を抽出
        same_day_done: list[str] = []
        meal_order = {"breakfast": 0, "lunch": 1, "dinner": 2}
        cur_order = meal_order.get(str(slot.meal_type), 99)
        for s in day.slots:
            if s.id == slot.id:
                continue
            if meal_order.get(str(s.meal_type), 99) >= cur_order:
                continue
            for it in s.items:
                if it.menu_name:
                    same_day_done.append(it.menu_name)
        # プラン全体の同じ食事タイプの他日メニューを集める（自分の slot は除外）
        cur_meal_type = str(slot.meal_type)
        recent_same_meal: list[str] = []
        plan_used_ingredients: list[str] = []
        for d in plan.days:
            for s in d.slots:
                # 自分の slot のメニューも食材集約のため記録
                if d.id == day.id and s.id == slot.id:
                    continue
                if str(s.meal_type) == cur_meal_type and d.id != day.id:
                    for it in s.items:
                        if it.menu_name:
                            recent_same_meal.append(it.menu_name)
                for it in s.items:
                    if it.ingredients_json:
                        plan_used_ingredients.extend(
                            [str(x) for x in it.ingredients_json if x]
                        )
        await _generate_slot_menu(
            slot, day.date, member_contexts, past_ingredients,
            user_id, db, conditions, day_cond_members,
            same_day_done=same_day_done,
            recent_same_meal=recent_same_meal[-5:],
            plan_used_ingredients=plan_used_ingredients,
        )


# 保存可能な食材のキーワード（調味料・乾物・缶詰・レトルトなど 1週間分まとめ買いOK）
SHELF_STABLE_KEYWORDS = [
    "醤油", "しょうゆ", "みりん", "酒", "料理酒", "砂糖", "塩", "コショウ", "胡椒", "こしょう",
    "味噌", "みそ", "だし", "出汁", "コンソメ", "ブイヨン", "鶏ガラ", "中華だし", "鶏がら",
    "ケチャップ", "マヨネーズ", "ソース", "ウスター", "中濃", "とんかつ", "オイスター",
    "酢", "ポン酢", "ドレッシング", "オリーブオイル", "ごま油", "サラダ油", "油",
    "片栗粉", "小麦粉", "薄力粉", "強力粉", "パン粉", "天ぷら粉", "唐揚げ粉",
    "カレー粉", "カレールー", "シチュールー", "ハヤシ", "中華調味料",
    "胡麻", "ごま", "すりごま", "海苔", "のり", "ふりかけ", "ゆかり", "わかめ",
    "かつお節", "鰹節", "煮干し", "昆布", "干し椎茸",
    "米", "玄米", "もち米", "麦", "雑穀",
    "パスタ", "スパゲッティ", "マカロニ", "そうめん", "うどん", "蕎麦", "そば",
    "ラーメン", "中華麺", "焼きそば麺",
    "ツナ缶", "ツナ", "鯖缶", "サバ缶", "コーン缶", "トマト缶", "ホール", "水煮",
    "豆乳", "ジャム", "蜂蜜", "はちみつ", "メープル", "シロップ",
    "レトルト", "インスタント", "カレー（レトルト）", "パスタソース", "ミートソース",
    "オリーブ", "ピクルス", "梅干し", "梅干", "漬物", "佃煮",
    "わさび", "からし", "マスタード", "豆板醤", "甜麺醤", "コチュジャン",
    "バター", "マーガリン",  # 比較的長持ち
]

# 生鮮で短期使用が望ましいもの（3日以内に消費したい食材のキーワード）
PERISHABLE_KEYWORDS = [
    "鶏", "豚", "牛", "ひき肉", "挽肉", "挽き肉", "ハム", "ベーコン", "ソーセージ",
    "魚", "鮭", "鯖", "サバ", "鯵", "アジ", "鰤", "ブリ", "鱈", "タラ", "鯛", "タイ",
    "イカ", "タコ", "海老", "エビ", "ホタテ", "あさり", "しじみ",
    "刺身", "切り身",
    "豆腐", "厚揚げ", "油揚げ", "がんもどき", "納豆",
    "卵", "玉子", "牛乳", "ヨーグルト", "チーズ", "生クリーム", "生クリーム",
    "葉物", "レタス", "サラダ", "ほうれん草", "小松菜", "水菜", "春菊", "白菜",
    "キャベツ", "もやし", "豆苗", "ニラ", "ねぎ", "長ねぎ", "青ねぎ", "万能ねぎ",
    "きのこ", "しめじ", "えのき", "舞茸", "しいたけ", "椎茸", "エリンギ", "なめこ",
    "トマト", "きゅうり", "茄子", "なす", "ピーマン", "パプリカ", "ブロッコリー", "アスパラ",
]


def _classify_ingredient(name: str) -> str:
    """食材名から保存可能(shelf_stable)か生鮮(perishable)かを判定。"""
    if not name:
        return "perishable"
    n = name.lower()
    # 保存可能優先（醤油・米など）
    for kw in SHELF_STABLE_KEYWORDS:
        if kw in name:
            return "shelf_stable"
    for kw in PERISHABLE_KEYWORDS:
        if kw in name:
            return "perishable"
    # デフォルトは生鮮扱い（安全側）
    return "perishable"


async def generate_shopping_list(plan_id: str, db: Session):
    """買い物リストを生成。
    items_json の構造（新形式）:
    [
      { "name": "鶏むね肉", "category": "perishable" | "shelf_stable",
        "first_day_offset": 0..6 },
      ...
    ]
    """
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return

    # 既存の shopping_list を削除（再生成時の重複を防ぐ）
    existing = db.query(models.ShoppingList).filter_by(meal_plan_id=plan_id).all()
    for s in existing:
        db.delete(s)
    db.commit()

    sorted_days = sorted(plan.days, key=lambda d: d.date)

    # 各食材の最初に登場する day_offset を記録
    shared_first_day: dict[str, int] = {}
    individual_first_day: dict[str, dict[str, int]] = {}

    for day_idx, day in enumerate(sorted_days):
        for slot in day.slots:
            # コンビニ・弁当・飲み物のみは買い物リストから除外（自炊のみ）
            if getattr(slot, "source_type", None) in ("conbini", "bento", "drink_only"):
                continue
            for item in slot.items:
                ings = item.ingredients_json or []
                for ing in ings:
                    name = str(ing).strip()
                    if not name:
                        continue
                    if item.user_id is None:
                        if name not in shared_first_day:
                            shared_first_day[name] = day_idx
                    else:
                        d = individual_first_day.setdefault(item.user_id, {})
                        if name not in d:
                            d[name] = day_idx

    def _build_items(first_day_map: dict[str, int]) -> list[dict]:
        return [
            {
                "name": name,
                "category": _classify_ingredient(name),
                "first_day_offset": offset,
            }
            for name, offset in first_day_map.items()
        ]

    sl = models.ShoppingList(
        id=str(uuid.uuid4()),
        meal_plan_id=plan_id,
        list_type="shared",
        user_id=None,
        items_json=_build_items(shared_first_day),
    )
    db.add(sl)

    for user_label, ing_map in individual_first_day.items():
        sl_ind = models.ShoppingList(
            id=str(uuid.uuid4()),
            meal_plan_id=plan_id,
            list_type="individual",
            user_id=user_label,
            items_json=_build_items(ing_map),
        )
        db.add(sl_ind)

    db.commit()
