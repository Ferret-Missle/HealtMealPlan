import json
import uuid
from datetime import date as dt_date, timedelta
from sqlalchemy.orm import Session
from .. import models, security
from ..llm.adapter import get_adapter
from .body_snapshot import estimate_basal_metabolism, get_weight_metric_snapshot
from .plan_progress import write_plan_progress


# ─── 進捗管理 ──────────────────────────────────────────────────
MEAL_JP_MAP = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}
DRINK_ONLY_CANDIDATES = [
    {
        "menu_name": "ザバス ミルクプロテイン 1本",
        "kcal_per_serving": 100,
        "protein_g": 15.0,
        "fat_g": 0.0,
        "carb_g": 10.0,
        "serving_grams": 200,
    },
    {
        "menu_name": "カロリーメイト リキッド 1本",
        "kcal_per_serving": 200,
        "protein_g": 10.0,
        "fat_g": 4.4,
        "carb_g": 31.8,
        "serving_grams": 200,
    },
    {
        "menu_name": "完全食ドリンク 1本",
        "kcal_per_serving": 400,
        "protein_g": 20.0,
        "fat_g": 13.0,
        "carb_g": 45.0,
        "serving_grams": 400,
    },
]
STORE_PREFIX_PATTERN = r"^(?:セブンイレブン|セブン|Seven-?Eleven|7-?Eleven)\s*[:：]?[\s-]*"


def _set_progress(plan_id: str, db: Session, step: int, total: int, message: str, done: bool = False, error: bool = False):
    """plan.progress_json に進捗情報を書き込む。"""
    plan = db.query(models.MealPlan).filter_by(id=plan_id).first()
    if not plan:
        return
    write_plan_progress(plan, {
        "step": step,
        "total": total,
        "message": message,
        "done": done,
        "error": error,
    })
    db.commit()


def _single_drink_fallback(targets: dict | None = None) -> dict:
    if not targets:
        selected = DRINK_ONLY_CANDIDATES[0]
    else:
        target_kcal = targets.get("kcal") or 150
        target_p = targets.get("protein") or 12
        selected = min(
            DRINK_ONLY_CANDIDATES,
            key=lambda candidate: abs(candidate["kcal_per_serving"] - target_kcal)
            + abs(candidate["protein_g"] - target_p) * 6,
        )
    return {
        **selected,
        "ingredients": [selected["menu_name"]],
        "cooking_summary": "飲み物のみ（1本）",
    }


def _strip_store_prefix(value: str) -> str:
    import re

    return re.sub(STORE_PREFIX_PATTERN, "", value.strip(), flags=re.IGNORECASE)


def _normalize_conbini_menu(data: dict) -> dict:
    menu_name = str(data.get("menu_name") or "").strip()
    if menu_name:
        lines = [_strip_store_prefix(line) for line in menu_name.splitlines()]
        lines = [line for line in lines if line]
        data["menu_name"] = "\n".join(lines)

    ingredients = [str(x).strip() for x in (data.get("ingredients") or []) if str(x).strip()]
    if ingredients:
        data["ingredients"] = [_strip_store_prefix(ingredient) for ingredient in ingredients]
    return data


def _normalize_generated_menu(data: dict, source_type: str, targets: dict | None = None) -> dict:
    if source_type == "conbini":
        return _normalize_conbini_menu(data)

    if source_type != "drink_only":
        return data

    menu_name = str(data.get("menu_name") or "").strip()
    menu_lines = [
        line.strip()
        for line in menu_name.replace("＋", "\n").replace("+", "\n").splitlines()
        if line.strip()
    ]
    ingredients = [str(x).strip() for x in (data.get("ingredients") or []) if str(x).strip()]
    looks_multi = len(menu_lines) > 1 or len(ingredients) > 1

    if looks_multi or not menu_lines:
        fallback = _single_drink_fallback(targets)
        for key in ("_input_tokens", "_output_tokens", "_llm_model", "_system_prompt", "_user_prompt"):
            if key in data:
                fallback[key] = data[key]
        return fallback

    data["menu_name"] = menu_lines[0]
    data["ingredients"] = [menu_lines[0]]
    data["cooking_summary"] = "飲み物のみ（1本）"
    return data


SYSTEM_PROMPT = """あなたは家庭料理に詳しい管理栄養士です。目標カロリーとPFCに合わせ、一般的な日本の家庭で現実的に用意しやすい献立を提案してください。

【必須ルール】
- 回答はJSONのみ
- serving_grams は1人前の総量(g)。kcal_per_serving / protein_g / fat_g / carb_g はその実値を記載
- 栄養値は目標カロリー・PFCにできるだけ近づけ、±10%以内を目指す
- 複数料理を出す場合、menu_name は改行(\\n)区切りで列挙し、「＋」は使わない
- 曖昧語は禁止。「おまかせ」「適量」だけでなく、「小鉢」「温野菜」「焼き魚」「高たんぱく○○」「プレート」のようなカテゴリ名・説明名でも逃げない
- homecook / bento の menu_name 各行は、家庭で何を作るか一読で分かる一般的な料理名にする
- 高価すぎる食材、特殊すぎる食材、家庭にない調味料、長時間の凝った調理は避ける

【cooking_summary】
- homecook / bento: 1手順ごとに改行し、「番号. 動詞で始まる短い指示」で書く
- conbini: 「コンビニ購入」
- drink_only: 「飲み物のみ（1本）」"""

MAX_MENU_PREFERENCE_ITEMS = 3
MAX_BODY_INFO_LINES = 4
MAX_PAST_INGREDIENTS = 10
MAX_SAME_DAY_INGREDIENTS = 8
MAX_PLAN_USED_INGREDIENTS = 8
MAX_RECENT_SAME_MEALS = 3


def _trim_text_items(values: list | None, limit: int) -> list[str]:
    if not values or limit <= 0:
        return []
    items: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
        if len(items) >= limit:
            break
    return items


def _format_member_menu_line(label: str, title: str, items: list[str]) -> str:
    return f"- メンバー{label} {title}: {', '.join(items)}"


def _meal_ratio(meal_type: str, light_breakfast: bool) -> float:
    """単純比率（互換用）：朝25/昼35/夕40、軽朝食なら20/35/45。"""
    if light_breakfast:
        return {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}.get(meal_type, 0.33)
    return {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}.get(meal_type, 0.33)


# ソースタイプごとの倍率（標準=1.0）
# drink_only: 飲み物のみは標準の30%まで圧縮 → その分は他の食事へ再分配
SOURCE_KCAL_FACTOR = {
    "drink_only": 0.30,
    "conbini": 1.0,
    "bento": 1.0,
    "homecook": 1.0,
}


def _meal_weights(light_breakfast: bool, day_sources: dict[str, str]) -> dict[str, float]:
    """1日3食のkcal配分比率を返す（合計=1.0に正規化）。
    朝昼晩のベース比率にソース倍率を掛け、減った分を他に再分配。"""
    if light_breakfast:
        base = {"breakfast": 0.20, "lunch": 0.35, "dinner": 0.45}
    else:
        base = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}
    weights = {
        m: base[m] * SOURCE_KCAL_FACTOR.get(day_sources.get(m), 1.0)
        for m in ("breakfast", "lunch", "dinner")
    }
    total = sum(weights.values())
    if total <= 0:
        return base  # フォールバック
    return {k: v / total for k, v in weights.items()}


def _slot_targets(
    meal_type: str,
    light_breakfast: bool,
    member_contexts: list,
    day_sources_per_member: dict[str, dict[str, str]] | None = None,
    slot_kcal_budget: float | None = None,
) -> dict:
    """グループ平均のkcal/PFC目標を返す。
    day_sources_per_member: {user_id: {breakfast: src, lunch: src, dinner: src}}
    """
    n = max(1, len(member_contexts))
    total_kcal = total_p = total_f = total_c = 0.0
    for mc in member_contexts:
        if day_sources_per_member:
            sources = day_sources_per_member.get(mc["user_id"], {})
            weights = _meal_weights(light_breakfast, sources)
            ratio = weights.get(meal_type, 0.33)
        else:
            ratio = _meal_ratio(meal_type, light_breakfast)
        kcal = mc["target_kcal"] * ratio
        total_kcal += kcal
        total_p += kcal * mc["p_ratio"] / 4
        total_f += kcal * mc["f_ratio"] / 9
        total_c += kcal * mc["c_ratio"] / 4
    target_kcal = slot_kcal_budget if slot_kcal_budget is not None else (total_kcal / n)
    if total_kcal > 0 and target_kcal is not None:
        scale = target_kcal / (total_kcal / n)
        total_p *= scale
        total_f *= scale
        total_c *= scale
    return {
        "kcal": round(target_kcal) if target_kcal is not None else None,
        "protein": round(total_p / n, 1),
        "fat": round(total_f / n, 1),
        "carb": round(total_c / n, 1),
    }


def _menu_feedback_from_preferences(prefs: dict | None) -> dict[str, dict[str, list[str]]]:
    raw = prefs.get("menu_feedback") if isinstance(prefs, dict) else None
    normalized: dict[str, dict[str, list[str]]] = {}
    for meal_type in ("breakfast", "lunch", "dinner"):
        meal_data = raw.get(meal_type) if isinstance(raw, dict) else {}
        if not isinstance(meal_data, dict):
            meal_data = {}
        normalized[meal_type] = {
            "good": [str(x).strip() for x in meal_data.get("good", []) if str(x).strip()],
            "bad": [str(x).strip() for x in meal_data.get("bad", []) if str(x).strip()],
        }
    return normalized


def _gather_body_info(user_id: str, db: Session, scope: str, goals) -> dict | None:
    """ユーザーの身体情報を scope に応じてまとめる。
    scope: "off" | "minimal" | "medium" | "full"
    - off:     何も渡さない（None を返す）
    - minimal: 体重・体脂肪・BMI・目標体重・身長・年齢/性別
    - medium:  + 7日活動量平均、体重トレンド
    - full:    + 直近7日食事量平均（過不足の傾向）
    """
    if scope == "off" or not scope:
        return None

    info: dict = {}
    latest_weight_value = None

    weight_snapshot = get_weight_metric_snapshot(db, user_id)
    if weight_snapshot:
        if weight_snapshot.get("weight") is not None:
            latest_weight_value = float(weight_snapshot["weight"])
            info["weight_kg"] = latest_weight_value
        if weight_snapshot.get("body_fat") is not None:
            info["body_fat_pct"] = weight_snapshot["body_fat"]
        if weight_snapshot.get("muscle_mass") is not None:
            info["muscle_mass_kg"] = weight_snapshot["muscle_mass"]
        if weight_snapshot.get("bmi") is not None:
            info["bmi"] = weight_snapshot["bmi"]
        if weight_snapshot.get("body_age") is not None:
            info["body_age"] = weight_snapshot["body_age"]
        if weight_snapshot.get("bone_mass") is not None:
            info["bone_mass_kg"] = weight_snapshot["bone_mass"]
        if weight_snapshot.get("visceral_fat_level") is not None:
            info["visceral_fat_level"] = weight_snapshot["visceral_fat_level"]
        if weight_snapshot.get("weight_date") is not None:
            info["weight_date"] = weight_snapshot["weight_date"]
        if weight_snapshot.get("reference_date") is not None:
            info["body_reference_date"] = weight_snapshot["reference_date"]
        if weight_snapshot.get("days_since_reference") is not None:
            info["body_days_since_reference"] = weight_snapshot["days_since_reference"]
        if weight_snapshot.get("is_stale"):
            info["body_data_stale"] = True

    # 目標体重・身長・属性
    if goals:
        if goals.target_weight is not None:
            info["target_weight_kg"] = goals.target_weight
        if getattr(goals, "height_cm", None) is not None:
            info["height_cm"] = goals.height_cm
        if getattr(goals, "age_group", None):
            info["age_group"] = goals.age_group
        if getattr(goals, "gender", None):
            info["gender"] = goals.gender

    estimated_basal = estimate_basal_metabolism(weight_snapshot, goals)
    if estimated_basal is not None:
        info["basal_metabolism_kcal"] = estimated_basal["value"]
        info["basal_metabolism_source"] = "estimated"

    if scope == "minimal":
        return info

    # === medium 以上：活動量と体重トレンド ===
    from datetime import timedelta as _td
    today = dt_date.today()
    seven_ago = str(today - _td(days=7))

    activities = (
        db.query(models.ActivityLog)
        .filter(
            models.ActivityLog.user_id == user_id,
            models.ActivityLog.date >= seven_ago,
        )
        .all()
    )
    if activities:
        steps_vals = [a.steps for a in activities if a.steps]
        kcal_vals = [a.active_kcal for a in activities if a.active_kcal]
        if steps_vals:
            info["avg_steps_7d"] = round(sum(steps_vals) / len(steps_vals))
        if kcal_vals:
            info["avg_active_kcal_7d"] = round(sum(kcal_vals) / len(kcal_vals))

    # 体重トレンド（7日前との差）
    week_ago_weight = (
        db.query(models.WeightLog)
        .filter(
            models.WeightLog.user_id == user_id,
            models.WeightLog.date <= seven_ago,
        )
        .order_by(models.WeightLog.date.desc())
        .first()
    )
    if latest_weight_value is not None and week_ago_weight and week_ago_weight.weight:
        info["weight_delta_7d_kg"] = round(latest_weight_value - week_ago_weight.weight, 2)

    if scope == "medium":
        return info

    # === full：食事傾向 ===
    meal_logs = (
        db.query(models.MealLog)
        .filter(
            models.MealLog.user_id == user_id,
            models.MealLog.date >= seven_ago,
        )
        .all()
    )
    if meal_logs:
        from collections import defaultdict
        daily = defaultdict(lambda: {"kcal": 0.0, "p": 0.0, "f": 0.0, "c": 0.0})
        for m in meal_logs:
            d = daily[m.date]
            d["kcal"] += m.kcal or 0
            d["p"] += m.protein_g or 0
            d["f"] += m.fat_g or 0
            d["c"] += m.carb_g or 0
        n = len(daily)
        if n:
            info["avg_intake_kcal_7d"] = round(sum(d["kcal"] for d in daily.values()) / n)
            info["avg_intake_p_7d"] = round(sum(d["p"] for d in daily.values()) / n, 1)
            info["avg_intake_f_7d"] = round(sum(d["f"] for d in daily.values()) / n, 1)
            info["avg_intake_c_7d"] = round(sum(d["c"] for d in daily.values()) / n, 1)

    return info


def _format_body_info(body_info: dict | None) -> str:
    """body_info dict をプロンプト用テキストに整形。Noneや空なら空文字。"""
    if not body_info:
        return ""
    lines = []
    if body_info.get("body_data_stale") and body_info.get("body_reference_date") is not None:
        lines.append(
            f"  - 注意: 身体データは {body_info['body_reference_date']} 時点の最新記録"
            f"（{body_info.get('body_days_since_reference')}日前）"
        )
    if "weight_kg" in body_info:
        line = f"  - 体重: {body_info['weight_kg']}kg"
        if "target_weight_kg" in body_info:
            diff = body_info["weight_kg"] - body_info["target_weight_kg"]
            phase = "減量" if diff > 0 else ("増量" if diff < 0 else "維持")
            line += f" / 目標: {body_info['target_weight_kg']}kg ({diff:+.1f}kg / {phase}フェーズ)"
        lines.append(line)
    if "body_fat_pct" in body_info:
        lines.append(f"  - 体脂肪率: {body_info['body_fat_pct']}%")
    elif "bmi" in body_info:
        lines.append(f"  - BMI: {body_info['bmi']}")
    if "weight_delta_7d_kg" in body_info:
        d = body_info["weight_delta_7d_kg"]
        trend = "減少中" if d < -0.1 else ("増加中" if d > 0.1 else "ほぼ維持")
        lines.append(f"  - 体重トレンド7日: {d:+.2f}kg ({trend})")
    if "avg_intake_kcal_7d" in body_info:
        lines.append(
            f"  - 直近7日平均食事量: {body_info['avg_intake_kcal_7d']}kcal "
            f"(P{body_info.get('avg_intake_p_7d')}g / F{body_info.get('avg_intake_f_7d')}g / C{body_info.get('avg_intake_c_7d')}g)"
        )
    elif "avg_steps_7d" in body_info:
        lines.append(f"  - 直近7日平均歩数: {body_info['avg_steps_7d']:,}歩")
    return "\n".join(lines[:MAX_BODY_INFO_LINES])


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
        menu_feedback = _menu_feedback_from_preferences(prefs)
        scope = (prefs.get("body_data_scope") if isinstance(prefs, dict) else None) or "off"
        body_info = _gather_body_info(member.user_id, db, scope, goals)
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
            "frequent_menus": (prefs.get("frequent_menus") if isinstance(prefs, dict) else None) or {},
            "liked_menus": {meal: menu_feedback[meal]["good"] for meal in ("breakfast", "lunch", "dinner")},
            "disliked_menus": {meal: menu_feedback[meal]["bad"] for meal in ("breakfast", "lunch", "dinner")},
            "body_info": body_info,
        })

    if not member_contexts:
        return

    # plan 作成時に送られた frequent_menus を member_contexts にマージ
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
        same_day_used_ingredients: list[str] = []
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
                same_day_used_ingredients=same_day_used_ingredients,
                recent_same_meal=plan_done_by_meal.get(mt, [])[-5:],
                plan_used_ingredients=plan_used_ingredients,
                all_day_slots=list(day.slots),
            )
            if new_names:
                same_day_done.extend(new_names)
                plan_done_by_meal.setdefault(mt, []).extend(new_names)
            if new_ings:
                same_day_used_ingredients.extend(new_ings)
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
    same_day_used_ingredients: list[str] | None = None,
    recent_same_meal: list[str] | None = None,
    plan_used_ingredients: list[str] | None = None,
    all_day_slots: list | None = None,
    user_request: str | None = None,
):
    if conditions is None:
        conditions = {}
    if day_cond_members is None:
        day_cond_members = []
    if same_day_done is None:
        same_day_done = []
    if same_day_used_ingredients is None:
        same_day_used_ingredients = []
    if recent_same_meal is None:
        recent_same_meal = []
    if plan_used_ingredients is None:
        plan_used_ingredients = []
    if all_day_slots is None:
        all_day_slots = []

    meal_type_str = str(slot.meal_type)
    slot_source = getattr(slot, "source_type", None) or ("homecook" if meal_type_str == "dinner" else "conbini")

    # 1日の各食事のソースをメンバー別に算出（kcal配分の正規化に使う）
    day_sources_per_member: dict[str, dict[str, str]] = {}
    for mc in member_contexts:
        member_sources: dict[str, str] = {}
        for s in all_day_slots:
            if getattr(s, "is_dining_out", False):
                continue
            mt = str(s.meal_type)
            default_src = getattr(s, "source_type", None) or (
                "homecook" if mt == "dinner" else "conbini"
            )
            if s.sharing_type == "shared":
                member_sources[mt] = default_src
            else:
                member_sources[mt] = _get_member_source(
                    mc["user_id"], mt, day_cond_members, default_src
                )
        day_sources_per_member[mc["user_id"]] = member_sources

    adapter = _get_llm_adapter(user_id, db)

    new_names: list[str] = []
    new_ingredients: list[str] = []

    if slot.sharing_type == "shared":
        light_breakfast = any(m.get("light_breakfast") for m in day_cond_members)
        data = await _call_llm(
            adapter, slot, meal_type_str, slot_source, light_breakfast,
            member_contexts, past_ingredients, same_day_done, recent_same_meal,
            plan_used_ingredients,
            same_day_used_ingredients=same_day_used_ingredients,
            day_sources_per_member=day_sources_per_member,
            user_request=user_request,
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
                same_day_used_ingredients=same_day_used_ingredients,
                day_sources_per_member={mc["user_id"]: day_sources_per_member.get(mc["user_id"], {})},
                user_request=user_request,
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
    same_day_used_ingredients: list[str] | None = None,
    day_sources_per_member: dict | None = None,
    user_request: str | None = None,
) -> dict:
    same_day_done = same_day_done or []
    recent_same_meal = recent_same_meal or []
    plan_used_ingredients = plan_used_ingredients or []
    same_day_used_ingredients = same_day_used_ingredients or []
    meal_name_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    sharing_jp = "共有食（全員分同じ料理）" if slot.sharing_type == "shared" else "個別食"
    members_count = len(member_contexts)

    # グループ平均の kcal/PFC 目標を計算（ソース別倍率を考慮）
    targets = _slot_targets(
        meal_type_str,
        light_breakfast,
        member_contexts,
        day_sources_per_member,
        slot_kcal_budget=getattr(slot, "kcal_budget", None),
    )

    if source_type == "conbini":
        source_note = (
            "【購入: コンビニ・スーパー】\n"
            "そのまま食べられる商品だけを提案してください。おにぎり、サンドイッチ、サラダチキン、惣菜、ヨーグルト、カット果物、温めるだけの弁当は可です。\n"
            "調理が必要な生鮮品や未調理食品は不可です。menu_name は商品名を改行区切りで書き、店舗名は付けないでください。"
        )
    elif source_type == "bento":
        source_note = (
            "【購入: 自作弁当】\n"
            "冷めても食べやすく持ち運びしやすい、一般的な弁当向け料理にしてください。\n"
            "menu_name 各行は料理として通じる具体名にし、『おかず』『小鉢』『高たんぱく○○』のような曖昧名は使わないでください。"
        )
    elif source_type == "homecook":
        source_note = (
            "【購入: 自炊】\n"
            "家庭で普通に作れる献立にしてください。主菜・副菜・汁物・主食を組み合わせても構いません。\n"
            "menu_name 各行は『何を作るか』が一読で分かる料理名にし、『小鉢』『温野菜』『焼き魚』『プレート』のようなカテゴリ名は使わないでください。"
        )
    elif source_type == "drink_only":
        source_note = (
            "【購入: 飲み物のみ】\n"
            "固形物は禁止です。必ず市販の飲み物1本だけを提案し、目標 kcal/PFC に最も近い商品を優先してください。\n"
            "menu_name は商品名1つだけ、ingredients も1要素のみです。プロテイン飲料、完全食ドリンク、栄養補助ドリンク、豆乳、甘酒は可です。"
        )
    else:
        source_note = "自炊またはコンビニ購入どちらでも構いません。"

    breakfast_note = ""
    if meal_type_str == "breakfast" and light_breakfast:
        breakfast_note = "【朝食は軽め】消化が良く、短時間で食べやすい内容にしてください。\n"

    user_request_section = ""
    if user_request:
        user_request_section = (
            "\n[今回の差し替え希望]\n"
            f"{user_request}\n"
            "希望を優先しつつ、栄養目標と除外条件は守ってください。"
        )

    # メンバー情報（よく食べるメニューも反映）
    member_lines = []
    fav_lines = []
    liked_lines = []
    disliked_lines = []
    body_sections = []
    for mc in member_contexts:
        member_lines.append(f"  - メンバー{mc['label']}: 1日目標 {mc['target_kcal']}kcal / 目標:{mc['goal_type']}")
        favs = _trim_text_items((mc.get("frequent_menus") or {}).get(meal_type_str, []), MAX_MENU_PREFERENCE_ITEMS)
        if favs:
            fav_lines.append(_format_member_menu_line(mc["label"], f"がよく食べる{ {'breakfast':'朝食','lunch':'昼食','dinner':'夕食'}.get(meal_type_str,'食事') }", favs))
        liked = _trim_text_items((mc.get("liked_menus") or {}).get(meal_type_str, []), MAX_MENU_PREFERENCE_ITEMS)
        if liked:
            liked_lines.append(_format_member_menu_line(mc["label"], f"がまた食べたい{ {'breakfast':'朝食','lunch':'昼食','dinner':'夕食'}.get(meal_type_str,'食事') }", liked))
        disliked = _trim_text_items((mc.get("disliked_menus") or {}).get(meal_type_str, []), MAX_MENU_PREFERENCE_ITEMS)
        if disliked:
            disliked_lines.append(_format_member_menu_line(mc["label"], f"が避けたい{ {'breakfast':'朝食','lunch':'昼食','dinner':'夕食'}.get(meal_type_str,'食事') }", disliked))
        body_text = _format_body_info(mc.get("body_info"))
        if body_text:
            body_sections.append(f"[メンバー{mc['label']} の身体情報]\n{body_text}")
    member_info = "\n".join(member_lines)
    fav_section = ("\n[参考メニュー]\n" + "\n".join(fav_lines)) if fav_lines else ""
    liked_section = ("\n[優先メニュー]\n" + "\n".join(liked_lines) + "\n近い味・構成の料理は優先して構いません。") if liked_lines else ""
    disliked_section = ("\n[避けるメニュー]\n" + "\n".join(disliked_lines) + "\n近い主食・主菜・主要タンパク源も避けてください。") if disliked_lines else ""
    body_section = ("\n\n" + "\n\n".join(body_sections) + "\n身体情報は減量・維持・増量の方向づけにだけ使ってください。") if body_sections else ""

    excluded = list(set(food for mc in member_contexts for food in mc.get("excluded_foods", [])))
    excluded = _trim_text_items(excluded, MAX_PAST_INGREDIENTS)
    compact_past_ingredients = _trim_text_items(past_ingredients, MAX_PAST_INGREDIENTS)

    # 同日内ですでに提案済みのメニューを抽出（朝→昼→夕の順で蓄積される）
    same_day_section = ""
    if same_day_done:
        same_day_flat = "; ".join(s.replace("\n", " / ") for s in _trim_text_items(same_day_done, MAX_RECENT_SAME_MEALS))
        same_day_section = (
            f"\n[同日NGメニュー]\n"
            f"{same_day_flat}\n"
            f"同じ主食・主菜・主要タンパク源・調理法は避けてください。\n"
        )

    same_day_ingredients_section = ""
    if same_day_used_ingredients:
        from collections import Counter
        same_day_counter = Counter(str(ing).strip() for ing in same_day_used_ingredients if str(ing).strip())
        same_day_top = [ing for ing, _ in same_day_counter.most_common(MAX_SAME_DAY_INGREDIENTS)]
        if same_day_top:
            same_day_ingredients_section = (
                f"\n[同日NG食材]\n"
                f"{', '.join(same_day_top)}\n"
                f"卵・鶏・豚・牛・魚・豆腐など主要タンパク源の再利用は禁止です。\n"
            )

    # プラン内ですでに使用された食材（買い物まとめのため再活用を促す）
    plan_used_section = ""
    historical_plan_used_ingredients = [
        ing for ing in plan_used_ingredients if ing not in set(same_day_used_ingredients)
    ]
    if historical_plan_used_ingredients:
        # 重複を除き使用回数の多い順に最大15個
        from collections import Counter
        counter = Counter(historical_plan_used_ingredients)
        top_used = [ing for ing, _ in counter.most_common(MAX_PLAN_USED_INGREDIENTS)]
        plan_used_section = (
            f"\n[再活用候補食材]\n"
            f"{', '.join(top_used)}\n"
            f"別日なら味付けや調理法を変えて再利用して構いません。\n"
        )

    # 同じ食事タイプでプラン内の他日に提案済みのメニュー（連続/類似を避ける）
    meal_jp = {"breakfast": "朝食", "lunch": "昼食", "dinner": "夕食"}.get(meal_type_str, "食事")
    recent_section = ""
    if recent_same_meal:
        recent_flat = "; ".join(s.replace("\n", " / ") for s in _trim_text_items(recent_same_meal, MAX_RECENT_SAME_MEALS))
        recent_section = (
            f"\n[他日の近い{meal_jp}]\n"
            f"{recent_flat}\n"
            f"直近で同じ料理名や同じ主菜・主食・主要タンパク源は避けてください。\n"
        )

    user_prompt = f"""以下の条件で{meal_name_jp}（{sharing_jp}・{members_count}名分）の献立を提案してください。

[1人あたりの栄養目標]
- カロリー: 約 {targets['kcal']} kcal
- タンパク質 (P): 約 {targets['protein']} g
- 脂質 (F): 約 {targets['fat']} g
- 炭水化物 (C): 約 {targets['carb']} g

[食事条件]
{breakfast_note}{source_note}

{user_request_section}

[メンバー情報]
{member_info}{fav_section}{liked_section}{disliked_section}{body_section}

[除外/重複]
除外食材: {", ".join(excluded) if excluded else "なし"}
過去3日の使用食材: {", ".join(compact_past_ingredients) if compact_past_ingredients else "なし"}{same_day_ingredients_section}{plan_used_section}{same_day_section}{recent_section}

[出力ルール]
- homecook / bento は、各行が家庭で一般的に通じる料理名になるようにしてください。
- ingredients は使う食材名を具体的に書いてください（conbini / drink_only は商品名可）。

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
}}

[最終チェック]
1. 同日NGメニューや直近の{meal_jp}と、料理名・主食・主菜・主要タンパク源が重なっていないか確認
2. homecook / bento の menu_name に曖昧なカテゴリ名が混ざっていないか確認"""

    try:
        result = await adapter.complete(SYSTEM_PROMPT, user_prompt, json_mode=True)
        raw = result.text if hasattr(result, "text") else str(result)
        data = _parse_json_response(raw)
        data = _normalize_generated_menu(data, source_type, targets)
        data["_input_tokens"] = getattr(result, "input_tokens", None)
        data["_output_tokens"] = getattr(result, "output_tokens", None)
        data["_llm_model"] = getattr(result, "model", None)
        data["_system_prompt"] = SYSTEM_PROMPT
        data["_user_prompt"] = user_prompt
        return data
    except Exception:
        fallback = _fallback_menu(meal_name_jp, source_type, targets)
        fallback["_system_prompt"] = SYSTEM_PROMPT
        fallback["_user_prompt"] = user_prompt
        return fallback


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
        system_prompt=data.get("_system_prompt"),
        user_prompt=data.get("_user_prompt"),
    )


def _get_llm_adapter(user_id: str, db: Session):
    plan_rec = db.query(models.UserPlan).filter_by(user_id=user_id).first()
    plan_type = plan_rec.plan_type if plan_rec else "free"
    byok_provider = plan_rec.byok_provider if plan_rec else None
    byok_model = getattr(plan_rec, "byok_model", None) if plan_rec else None
    force_free = bool(getattr(plan_rec, "force_free_llm", False)) if plan_rec else False

    # 無料切替フラグが有効なら BYOK を無視して Groq を使う
    if force_free:
        plan_type = "free"
        byok_provider = None
        byok_model = None

    api_key = None
    if plan_type == "byok" and byok_provider:
        key_rec = db.query(models.ApiKey).filter_by(user_id=user_id, provider=byok_provider).first()
        if key_rec:
            api_key = security.decrypt(key_rec.encrypted_key)

    return get_adapter(plan_type, byok_provider, api_key, byok_model)


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
    if source_type == "drink_only":
        return _single_drink_fallback(targets)

    name_map = {
        ("conbini", "朝食"): "鮭おにぎり\nゆで卵\n野菜サラダ",
        ("conbini", "昼食"): "サラダチキン\n玄米おにぎり\n野菜スープ",
        ("conbini", "夕食"): "鶏むね弁当\nミニサラダ\nヨーグルト",
        ("bento", "朝食"): "鮭おにぎり\nゆで卵\nミニサラダ",
        ("bento", "昼食"): "鶏むね唐揚げ\n卵焼き\nブロッコリー胡麻和え\n玄米",
        ("bento", "夕食"): "さばの塩焼き\n卵焼き\nひじき煮\nご飯",
        ("homecook", "朝食"): "ご飯\n味噌汁\n卵焼き\n焼鮭",
        ("homecook", "昼食"): "鶏むね肉の生姜焼き\nほうれん草のおひたし\nご飯",
        ("homecook", "夕食"): "鮭の塩焼き\nかぼちゃの煮物\n味噌汁\nご飯",
    }
    menu_name = name_map.get((source_type, meal_name)) or "鶏むね肉の照り焼き\nキャベツの胡麻和え\nご飯"

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
    user_request: str | None = None,
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
        menu_feedback = _menu_feedback_from_preferences(prefs)
        scope = (prefs.get("body_data_scope") if isinstance(prefs, dict) else None) or "off"
        body_info = _gather_body_info(member.user_id, db, scope, goals)
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
            "liked_menus": {meal: menu_feedback[meal]["good"] for meal in ("breakfast", "lunch", "dinner")},
            "disliked_menus": {meal: menu_feedback[meal]["bad"] for meal in ("breakfast", "lunch", "dinner")},
            "body_info": body_info,
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
        same_day_used_ingredients: list[str] = []
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
                if it.ingredients_json:
                    same_day_used_ingredients.extend([str(x) for x in it.ingredients_json if x])
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
            same_day_used_ingredients=same_day_used_ingredients,
            recent_same_meal=recent_same_meal[-5:],
            plan_used_ingredients=plan_used_ingredients,
            all_day_slots=list(day.slots),
            user_request=user_request,
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
