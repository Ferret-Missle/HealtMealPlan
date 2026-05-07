import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authApi, groupApi, mealPlanApi, shoppingApi } from "../services/api";
import {
	addJstDays,
	formatJstDate,
	isWeekendJst,
	toJstDateString,
} from "../utils/date";

// ─── 定数 ────────────────────────────────────────────────────────────────────
const MEAL_JP = { breakfast: "朝", lunch: "昼", dinner: "夕" };
const MEAL_FULL = { breakfast: "朝食", lunch: "昼食", dinner: "夕食" };
const SOURCE_CYCLE = ["conbini", "bento", "homecook", "drink_only"];
const SOURCE_LABEL = { conbini: "🏪", bento: "🍱", homecook: "🍳", drink_only: "🥤" };
const SOURCE_JP = { conbini: "コンビニ", bento: "自作弁当", homecook: "自炊", drink_only: "飲み物のみ" };
// ─── 汎用ヘルパー ─────────────────────────────────────────────────────────────
function nextSource(s) {
	return SOURCE_CYCLE[(SOURCE_CYCLE.indexOf(s) + 1) % SOURCE_CYCLE.length];
}
function isWeekend(dateStr) {
	return isWeekendJst(dateStr);
}
function dateLabel(dateStr) {
	const weekday = formatJstDate(dateStr, { weekday: "short" });
	return `${formatJstDate(dateStr, { month: "numeric", day: "numeric" })}(${weekday})`;
}

// ─── localStorage フック ──────────────────────────────────────────────────────
function useLocalStorage(key, initial) {
	const [value, setValue] = useState(() => {
		try {
			const stored = localStorage.getItem(key);
			return stored ? JSON.parse(stored) : initial;
		} catch {
			return initial;
		}
	});
	function set(v) {
		const next = typeof v === "function" ? v(value) : v;
		setValue(next);
		try {
			localStorage.setItem(key, JSON.stringify(next));
		} catch {}
	}
	return [value, set];
}

// ─── デフォルト設定 ───────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
	lightBreakfast: {}, // { [userId]: bool }
	workDay: {}, // { [userId]: { breakfast, lunch, dinner } }
	weekend: {}, // { [userId]: { breakfast, lunch, dinner } }
	frequentMenus: {}, // { [userId]: { breakfast: [], lunch: [], dinner: [] } }
};
const DEFAULT_WORKDAY = {
	breakfast: "conbini",
	lunch: "conbini",
	dinner: "homecook",
};
const DEFAULT_WEEKEND = {
	breakfast: "homecook",
	lunch: "homecook",
	dinner: "homecook",
};

function getMemberDefaults(settings, userId, dayType) {
	return (
		settings[dayType]?.[userId] ||
		(dayType === "weekend" ? DEFAULT_WEEKEND : DEFAULT_WORKDAY)
	);
}

function buildDayConditions(startDate, days, settings, members) {
	return Array.from({ length: days }, (_, i) => {
		const dateStr = addJstDays(startDate, i);
		const weekend = isWeekend(dateStr);
		return {
			date: dateStr,
			members: members.map((m) => ({
				user_id: m.user_id,
				...getMemberDefaults(
					settings,
					m.user_id,
					weekend ? "weekend" : "workDay",
				),
				light_breakfast: settings.lightBreakfast?.[m.user_id] || false,
			})),
		};
	});
}

// ─── 設定パネル（ステップ1） ──────────────────────────────────────────────────
function SettingsPanel({ settings, onChange, members }) {
	function setLightBreakfast(uid, val) {
		onChange({
			...settings,
			lightBreakfast: { ...settings.lightBreakfast, [uid]: val },
		});
	}
	function setMealSource(uid, dayType, meal, src) {
		const current = getMemberDefaults(settings, uid, dayType);
		onChange({
			...settings,
			[dayType]: { ...settings[dayType], [uid]: { ...current, [meal]: src } },
		});
	}
	function setFrequentMenu(uid, meal, raw) {
		// カンマ/読点/句点/半角スペース/全角スペース/改行/タブで分割
		const list = raw
			.split(/[,，、。．\.\s　]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const current = settings.frequentMenus?.[uid] || {
			breakfast: [],
			lunch: [],
			dinner: [],
		};
		onChange({
			...settings,
			frequentMenus: {
				...settings.frequentMenus,
				[uid]: { ...current, [meal]: list },
			},
		});
	}

	return (
		<div style={{ background: "var(--bg)", borderRadius: 12, padding: 16 }}>
			<div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
				⚙️ メンバー別デフォルト設定
			</div>
			{members.map((m) => {
				const wd = getMemberDefaults(settings, m.user_id, "workDay");
				const we = getMemberDefaults(settings, m.user_id, "weekend");
				const lb = settings.lightBreakfast?.[m.user_id] || false;
				return (
					<div
						key={m.user_id}
						style={{
							marginBottom: 16,
							paddingBottom: 16,
							borderBottom: "1px solid var(--border)",
						}}
					>
						<div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
							👤 {m.name}
						</div>

						{/* 朝食軽め */}
						<label
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								marginBottom: 10,
								cursor: "pointer",
								fontSize: 13,
							}}
						>
							<input
								type="checkbox"
								checked={lb}
								onChange={(e) => setLightBreakfast(m.user_id, e.target.checked)}
							/>
							朝食を軽めにする
						</label>

						{/* 平日 */}
						<div style={{ marginBottom: 8 }}>
							<div
								style={{
									fontSize: 12,
									color: "var(--text-secondary)",
									marginBottom: 4,
								}}
							>
								平日デフォルト
							</div>
							<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
								{["breakfast", "lunch", "dinner"].map((meal) => (
									<div
										key={meal}
										style={{ display: "flex", alignItems: "center", gap: 4 }}
									>
										<span
											style={{ fontSize: 12, color: "var(--text-secondary)" }}
										>
											{MEAL_JP[meal]}
										</span>
										{SOURCE_CYCLE.map((src) => (
											<button
												key={src}
												onClick={() =>
													setMealSource(m.user_id, "workDay", meal, src)
												}
												className={`btn ${wd[meal] === src ? "btn-primary" : "btn-outline"}`}
												style={{ padding: "2px 8px", fontSize: 12 }}
											>
												{SOURCE_LABEL[src]}
											</button>
										))}
									</div>
								))}
							</div>
						</div>

						{/* 週末 */}
						<div style={{ marginBottom: 10 }}>
							<div
								style={{
									fontSize: 12,
									color: "var(--text-secondary)",
									marginBottom: 4,
								}}
							>
								週末デフォルト
							</div>
							<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
								{["breakfast", "lunch", "dinner"].map((meal) => (
									<div
										key={meal}
										style={{ display: "flex", alignItems: "center", gap: 4 }}
									>
										<span
											style={{ fontSize: 12, color: "var(--text-secondary)" }}
										>
											{MEAL_JP[meal]}
										</span>
										{SOURCE_CYCLE.map((src) => (
											<button
												key={src}
												onClick={() =>
													setMealSource(m.user_id, "weekend", meal, src)
												}
												className={`btn ${we[meal] === src ? "btn-primary" : "btn-outline"}`}
												style={{ padding: "2px 8px", fontSize: 12 }}
											>
												{SOURCE_LABEL[src]}
											</button>
										))}
									</div>
								))}
							</div>
						</div>

						{/* よく食べるメニュー */}
						<div>
							<div
								style={{
									fontSize: 12,
									color: "var(--text-secondary)",
									marginBottom: 4,
								}}
							>
								よく食べるメニュー（カンマ・スペース・句読点で区切り）
							</div>
							{["breakfast", "lunch", "dinner"].map((meal) => {
								const fav =
									(settings.frequentMenus?.[m.user_id]?.[meal] || []).join(", ");
								return (
									<div
										key={meal}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 6,
											marginBottom: 4,
										}}
									>
										<span
											style={{
												fontSize: 12,
												color: "var(--text-secondary)",
												minWidth: 24,
											}}
										>
											{MEAL_JP[meal]}
										</span>
										<input
											type="text"
											defaultValue={fav}
											placeholder="例: 卵かけご飯, 焼き鮭定食"
											onBlur={(e) =>
												setFrequentMenu(m.user_id, meal, e.target.value)
											}
											className="form-input"
											style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
										/>
									</div>
								);
							})}
						</div>
					</div>
				);
			})}
			{members.length === 0 && (
				<div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
					グループメンバーを読み込み中...
				</div>
			)}
		</div>
	);
}

// ─── 日別カード（ステップ2） ──────────────────────────────────────────────────
function DayRow({ dayCondition, members, schedules, onUpdate }) {
	const { date, members: memberConds } = dayCondition;
	const weekend = isWeekend(date);

	function getMemberCond(userId) {
		return (
			memberConds.find((m) => m.user_id === userId) || {
				user_id: userId,
				breakfast: "conbini",
				lunch: "conbini",
				dinner: "homecook",
				light_breakfast: false,
			}
		);
	}

	function cycleMeal(userId, meal) {
		const cond = getMemberCond(userId);
		const newSrc = nextSource(cond[meal]);
		onUpdate(date, userId, meal, newSrc);
	}

	// 特定日のスケジュールを取得（HH:MM形式に整形）
	function getMemberEvents(userId) {
		const memberData = schedules?.[userId];
		if (!memberData) return null;
		if (!memberData.events || memberData.events.length === 0) return [];

		return memberData.events.filter((ev) => {
			const evDate = (ev.start || "").slice(0, 10);
			return evDate === date;
		});
	}

	function formatEventTime(ev) {
		if (ev.all_day) return "終日";
		const start = ev.start?.slice(11, 16) || "";
		const end = ev.end?.slice(11, 16) || "";
		return start && end ? `${start}〜${end}` : start;
	}

	return (
		<div
			className="card"
			style={{
				marginBottom: 8,
				borderLeft: `4px solid ${weekend ? "#e74c3c" : "var(--primary)"}`,
			}}
		>
			<div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
				{dateLabel(date)}
				{weekend && (
					<span
						style={{
							marginLeft: 6,
							fontSize: 11,
							color: "#e74c3c",
							background: "#fde8e8",
							borderRadius: 4,
							padding: "1px 6px",
						}}
					>
						休日
					</span>
				)}
			</div>

			{members.map((m) => {
				const cond = getMemberCond(m.user_id);
				const events = getMemberEvents(m.user_id);
				return (
					<div key={m.user_id} style={{ marginBottom: 10 }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 6,
								flexWrap: "wrap",
							}}
						>
							<span
								style={{
									fontSize: 13,
									fontWeight: 500,
									minWidth: 60,
									color: "var(--text-secondary)",
								}}
							>
								{m.name}
							</span>
							{["breakfast", "lunch", "dinner"].map((meal) => (
								<button
									key={meal}
									onClick={() => cycleMeal(m.user_id, meal)}
									className="btn btn-outline"
									style={{
										padding: "4px 10px",
										fontSize: 12,
										display: "flex",
										flexDirection: "column",
										alignItems: "center",
										gap: 1,
										lineHeight: 1.2,
										minWidth: 52,
									}}
									title={`${MEAL_FULL[meal]}: ${SOURCE_JP[cond[meal]]} → タップで変更`}
								>
									<span
										style={{ fontSize: 10, color: "var(--text-secondary)" }}
									>
										{MEAL_JP[meal]}
									</span>
									<span>{SOURCE_LABEL[cond[meal]]}</span>
								</button>
							))}
							{cond.light_breakfast && (
								<span className="tag tag-gray" style={{ fontSize: 10 }}>
									朝軽め
								</span>
							)}
						</div>

						{/* 予定表示 */}
						<div
							style={{
								marginTop: 4,
								marginLeft: 66,
								fontSize: 11,
								color: "var(--text-secondary)",
							}}
						>
							{events === null ? (
								<span>📅 Google連携なし</span>
							) : events.length === 0 ? (
								<span>📅 予定なし（仕事日）</span>
							) : (
								<span>
									📅{" "}
									{events
										.map(
											(ev) =>
												`${ev.summary}${ev.all_day ? "" : ` ${formatEventTime(ev)}`}`,
										)
										.join(" / ")}
								</span>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ─── KcalバジェットBar ─────────────────────────────────────────────────────────
function KcalBudgetBar({ actual, budget }) {
	if (!budget) return null;
	const pct = Math.min(100, Math.round((actual / budget) * 100));
	const over = actual > budget;
	return (
		<div style={{ marginTop: 4 }}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					fontSize: 11,
					color: "var(--text-secondary)",
					marginBottom: 2,
				}}
			>
				<span>
					{actual} / {budget} kcal
				</span>
				<span style={{ color: over ? "#e74c3c" : "var(--text-secondary)" }}>
					{over
						? `+${actual - budget} kcal超過`
						: `残り ${budget - actual} kcal`}
				</span>
			</div>
			<div
				style={{
					height: 4,
					borderRadius: 2,
					background: "#eee",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						height: "100%",
						width: `${pct}%`,
						background: over ? "#e74c3c" : "var(--primary)",
						borderRadius: 2,
						transition: "width 0.3s",
					}}
				/>
			</div>
		</div>
	);
}

// ─── ItemCard ────────────────────────────────────────────────────────────────
function ItemCard({ item, planId, isDraft }) {
	const qc = useQueryClient();
	const [editGrams, setEditGrams] = useState(false);
	const [gramsValue, setGramsValue] = useState(item.serving_grams || "");
	const [saving, setSaving] = useState(false);

	const saveGrams = async () => {
		if (!gramsValue) return;
		setSaving(true);
		try {
			const ratio = gramsValue / (item.serving_grams || gramsValue);
			await mealPlanApi.updateItem(planId, item.id, {
				serving_grams: parseFloat(gramsValue),
				kcal: item.kcal ? item.kcal * ratio : undefined,
				protein_g: item.protein_g ? item.protein_g * ratio : undefined,
				fat_g: item.fat_g ? item.fat_g * ratio : undefined,
				carb_g: item.carb_g ? item.carb_g * ratio : undefined,
			});
			qc.invalidateQueries({ queryKey: ["meal-plan", planId] });
			setEditGrams(false);
		} catch {
			alert("保存に失敗しました");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div
			style={{
				background: "var(--surface)",
				borderRadius: 8,
				padding: "8px 10px",
				marginBottom: 6,
			}}
		>
			<div style={{ fontWeight: 500, fontSize: 14, whiteSpace: "pre-line" }}>
				{(item.menu_name || "").replace(/\s*[＋+]\s*/g, "\n")}
			</div>
			{item.kcal && (
				<div
					style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}
				>
					{Math.round(item.kcal)} kcal
					{item.protein_g != null && ` / P${item.protein_g?.toFixed(1)}g`}
					{item.fat_g != null && ` F${item.fat_g?.toFixed(1)}g`}
					{item.carb_g != null && ` C${item.carb_g?.toFixed(1)}g`}
					{item.serving_grams && (
						<>
							{" · "}
							{editGrams ? (
								<span
									style={{
										display: "inline-flex",
										gap: 4,
										alignItems: "center",
									}}
								>
									<input
										type="number"
										value={gramsValue}
										onChange={(e) => setGramsValue(e.target.value)}
										style={{
											width: 60,
											padding: "0 4px",
											border: "1px solid #ccc",
											borderRadius: 4,
											fontSize: 11,
										}}
										min="1"
										onClick={(e) => e.stopPropagation()}
									/>
									g
									<button
										onClick={saveGrams}
										disabled={saving}
										className="btn btn-primary"
										style={{ fontSize: 11, padding: "1px 6px" }}
									>
										{saving ? "..." : "保存"}
									</button>
									<button
										onClick={() => setEditGrams(false)}
										style={{
											fontSize: 11,
											background: "none",
											border: "none",
											cursor: "pointer",
										}}
									>
										✕
									</button>
								</span>
							) : (
								<span
									style={{
										cursor: isDraft ? "pointer" : "default",
										textDecoration: isDraft ? "underline dotted" : "none",
									}}
									onClick={() => isDraft && setEditGrams(true)}
								>
									{item.serving_grams}g{isDraft && " ✏️"}
								</span>
							)}
						</>
					)}
				</div>
			)}
			{item.cooking_summary && (
				<div style={{ marginTop: 6 }}>
					<div
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: "var(--text-secondary)",
							marginBottom: 2,
						}}
					>
						調理手順
					</div>
					<div
						style={{
							fontSize: 12,
							color: "var(--text-secondary)",
							whiteSpace: "pre-line",
							lineHeight: 1.55,
						}}
					>
						{item.cooking_summary}
					</div>
				</div>
			)}
			{item.ingredients?.length > 0 && (
				<div style={{ marginTop: 6 }}>
					<div
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: "var(--text-secondary)",
							marginBottom: 2,
						}}
					>
						食材
					</div>
					<ul
						style={{
							margin: 0,
							paddingLeft: 16,
							fontSize: 11,
							color: "var(--text-secondary)",
							lineHeight: 1.6,
						}}
					>
						{item.ingredients.map((ing, i) => (
							<li key={i}>{ing}</li>
						))}
					</ul>
				</div>
			)}
			{(item.input_tokens != null || item.output_tokens != null) && (
				<div
					style={{
						marginTop: 6,
						paddingTop: 6,
						borderTop: "1px dashed var(--border)",
						fontSize: 10,
						color: "var(--text-3, #94a3b8)",
						display: "flex",
						gap: 8,
						flexWrap: "wrap",
					}}
				>
					<span>🤖 {item.llm_model || "LLM"}</span>
					{item.input_tokens != null && (
						<span>
							入力 <strong>{item.input_tokens.toLocaleString()}</strong> tok
						</span>
					)}
					{item.output_tokens != null && (
						<span>
							出力 <strong>{item.output_tokens.toLocaleString()}</strong> tok
						</span>
					)}
					{item.input_tokens != null && item.output_tokens != null && (
						<span>
							合計 <strong>{(item.input_tokens + item.output_tokens).toLocaleString()}</strong> tok
						</span>
					)}
				</div>
			)}
		</div>
	);
}

// ─── 生成中の進捗表示 ─────────────────────────────────────────────────────
function GenerationProgress({ progress }) {
	if (!progress) return null;
	const { step, total, message, done, error } = progress;
	const pct = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;

	if (error) {
		return (
			<div
				className="card"
				style={{
					borderLeft: "4px solid #dc2626",
					marginBottom: 12,
					background: "#fef2f2",
				}}
			>
				<div style={{ fontWeight: 600, fontSize: 14, color: "#dc2626" }}>
					⚠ 生成エラー
				</div>
				<div style={{ fontSize: 13, marginTop: 4, color: "var(--text-secondary)" }}>
					{message || "不明なエラーが発生しました"}
				</div>
			</div>
		);
	}

	if (done) return null;

	return (
		<div
			className="card"
			style={{
				borderLeft: "4px solid var(--primary)",
				marginBottom: 12,
				background: "rgba(22,163,74,0.04)",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<div
					style={{
						width: 24,
						height: 24,
						border: "3px solid #e2e8f0",
						borderTopColor: "var(--primary)",
						borderRadius: "50%",
						animation: "spin 0.8s linear infinite",
						flexShrink: 0,
					}}
				/>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{ fontWeight: 600, fontSize: 14 }}>AIが献立を生成中…</div>
					<div
						style={{
							fontSize: 12,
							color: "var(--text-secondary)",
							marginTop: 2,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{message || "処理中..."}
					</div>
				</div>
				<div
					style={{
						fontSize: 12,
						color: "var(--text-secondary)",
						fontWeight: 600,
						flexShrink: 0,
					}}
				>
					{step}/{total}
				</div>
			</div>
			{/* プログレスバー */}
			<div
				style={{
					marginTop: 10,
					height: 6,
					background: "#e2e8f0",
					borderRadius: 3,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						height: "100%",
						width: `${pct}%`,
						background: "var(--primary)",
						borderRadius: 3,
						transition: "width 0.3s",
					}}
				/>
			</div>
			{/* 案内 */}
			<div
				style={{
					fontSize: 11,
					color: "var(--text-secondary)",
					marginTop: 8,
					padding: "6px 8px",
					background: "rgba(0,0,0,0.03)",
					borderRadius: 6,
					lineHeight: 1.5,
				}}
			>
				💡 生成はバックグラウンドで実行されています。<br />
				別の画面に移動しても処理は続きます。戻ってきた時に進捗を確認できます。
			</div>
			{/* スピナーアニメーション CSS */}
			<style>{`
				@keyframes spin { to { transform: rotate(360deg); } }
			`}</style>
		</div>
	);
}

// ─── 買い物リスト：セクション分け + チェック機能 ─────────────────────────────
// 文字列配列（旧形式）と { name, category, first_day_offset } 配列（新形式）両対応
function _normalizeShoppingItems(rawList) {
	if (!Array.isArray(rawList)) return [];
	return rawList.map((it) => {
		if (typeof it === "string") {
			return { name: it, category: "perishable", first_day_offset: 0 };
		}
		return {
			name: it.name ?? "",
			category: it.category || "perishable",
			first_day_offset: typeof it.first_day_offset === "number" ? it.first_day_offset : 0,
		};
	});
}

function ShoppingItemRow({ item, planId, listKey }) {
	const storageKey = `shopping_check_${planId}_${listKey}_${item.name}`;
	const [checked, setChecked] = useState(() => {
		try {
			return localStorage.getItem(storageKey) === "1";
		} catch {
			return false;
		}
	});
	const toggle = () => {
		setChecked((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(storageKey, next ? "1" : "0");
			} catch {
				/* ignore */
			}
			return next;
		});
	};
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={toggle}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggle();
				}
			}}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 4px",
				fontSize: 14,
				cursor: "pointer",
				color: checked ? "var(--text-3, #94a3b8)" : "inherit",
				textDecoration: checked ? "line-through" : "none",
				userSelect: "none",
				borderRadius: 4,
			}}
		>
			<input
				type="checkbox"
				checked={checked}
				readOnly
				tabIndex={-1}
				style={{ pointerEvents: "none" }}
			/>
			<span>{item.name}</span>
		</div>
	);
}

function ShoppingSection({ title, hint, items, planId, listKey }) {
	if (!items?.length) return null;
	return (
		<div style={{ marginBottom: 14 }}>
			<div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{title}</div>
			{hint && (
				<div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
					{hint}
				</div>
			)}
			{items.map((item, i) => (
				<ShoppingItemRow
					key={`${item.name}-${i}`}
					item={item}
					planId={planId}
					listKey={listKey}
				/>
			))}
		</div>
	);
}

function ShoppingListBlock({ title, rawItems, planId, listKey }) {
	const items = _normalizeShoppingItems(rawItems);
	if (!items.length) return null;

	const shelf = items.filter((it) => it.category === "shelf_stable");
	const freshEarly = items.filter(
		(it) => it.category !== "shelf_stable" && it.first_day_offset <= 2,
	);
	const freshLate = items.filter(
		(it) => it.category !== "shelf_stable" && it.first_day_offset > 2,
	);

	return (
		<div style={{ marginBottom: 16 }}>
			<div
				style={{
					fontWeight: 700,
					fontSize: 14,
					marginBottom: 6,
					borderBottom: "1px solid var(--border)",
					paddingBottom: 4,
				}}
			>
				{title}
			</div>
			<ShoppingSection
				title="🧂 調味料・乾物・保存食"
				hint="1週間分まとめて購入OK"
				items={shelf}
				planId={planId}
				listKey={listKey}
			/>
			<ShoppingSection
				title="🥬 生鮮（前半 1〜3日目）"
				hint="開始から 3日以内に消費する食材"
				items={freshEarly}
				planId={planId}
				listKey={listKey}
			/>
			<ShoppingSection
				title="🥩 生鮮（後半 4日目以降）"
				hint="後半に必要 — 開始3日後ごろの追加買い物推奨"
				items={freshLate}
				planId={planId}
				listKey={listKey}
			/>
		</div>
	);
}

// ─── 日カード × メンバーごとの折りたたみ表示 ─────────────────────────────────
function MemberDayCard({
	memberLabel,
	memberName,
	isMe,
	daySlots,
	planId,
	planStatus,
	onEditSlot,
}) {
	const [expanded, setExpanded] = useState(isMe);

	// このメンバー用の朝・昼・夕アイテムを抽出
	const slotItems = daySlots.map((slot) => {
		let item = null;
		if (slot.is_dining_out) {
			item = { dining_out: true, kcal: slot.dining_out_kcal };
		} else if (slot.sharing_type === "shared") {
			item = slot.items.find((it) => it.user_id == null) || null;
		} else {
			item = slot.items.find((it) => it.user_id === memberLabel) || null;
		}
		return { slot, item };
	});

	const totals = slotItems.reduce(
		(acc, { slot, item }) => {
			if (slot.is_dining_out) {
				acc.kcal += slot.dining_out_kcal || 0;
				return acc;
			}
			acc.kcal += item?.kcal || 0;
			acc.p += item?.protein_g || 0;
			acc.f += item?.fat_g || 0;
			acc.c += item?.carb_g || 0;
			return acc;
		},
		{ kcal: 0, p: 0, f: 0, c: 0 },
	);

	return (
		<div
			style={{
				border: `1px solid ${isMe ? "var(--primary)" : "var(--border)"}`,
				borderRadius: 8,
				marginBottom: 6,
				background: "var(--surface)",
				overflow: "hidden",
			}}
		>
			<button
				onClick={() => setExpanded((v) => !v)}
				style={{
					width: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "8px 12px",
					background: isMe ? "rgba(22,163,74,0.06)" : "transparent",
					border: "none",
					cursor: "pointer",
					fontSize: 13,
					fontWeight: 600,
					gap: 8,
				}}
			>
				<span style={{ flexShrink: 0 }}>
					{isMe && "👤 "}
					{memberName}{" "}
					{isMe && (
						<span style={{ fontSize: 10, color: "var(--primary)" }}>
							（自分）
						</span>
					)}
				</span>
				<span
					style={{
						fontSize: 11,
						color: "var(--text-secondary)",
						fontWeight: 400,
						display: "flex",
						gap: 8,
						alignItems: "baseline",
						flexWrap: "wrap",
						justifyContent: "flex-end",
					}}
				>
					<span style={{ fontWeight: 600, color: "var(--text)" }}>
						{Math.round(totals.kcal)}kcal
					</span>
					<span>P{totals.p.toFixed(0)}</span>
					<span>F{totals.f.toFixed(0)}</span>
					<span>C{totals.c.toFixed(0)}</span>
					<span>{expanded ? "▲" : "▼"}</span>
				</span>
			</button>
			{expanded && (
				<div style={{ padding: "0 12px 10px 12px" }}>
					{slotItems.map(({ slot, item }) => (
						<div key={slot.id} style={{ marginTop: 10 }}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									marginBottom: 4,
								}}
							>
								<span style={{ fontWeight: 600, fontSize: 13 }}>
									{MEAL_FULL[slot.meal_type] || slot.meal_type}
								</span>
								{slot.source_type && (
									<span
										className={`tag ${slot.source_type === "conbini" ? "tag-blue" : slot.source_type === "bento" ? "tag-orange" : "tag-green"}`}
										style={{ fontSize: 10 }}
									>
										{SOURCE_LABEL[slot.source_type]} {SOURCE_JP[slot.source_type]}
									</span>
								)}
								<span
									className={`tag ${slot.sharing_type === "shared" ? "tag-green" : "tag-gray"}`}
									style={{ fontSize: 10 }}
								>
									{slot.sharing_type === "shared" ? "共有" : "個別"}
								</span>
								{slot.is_dining_out && <span className="tag tag-orange" style={{ fontSize: 10 }}>外食</span>}
								{planStatus === "draft" && (
									<button
										className="btn-icon"
										style={{ marginLeft: "auto", fontSize: 12 }}
										title="編集"
										onClick={() => onEditSlot({ slot, planId })}
									>
										✏️
									</button>
								)}
							</div>
							{slot.is_dining_out ? (
								<div
									style={{
										background: "var(--bg)",
										borderRadius: 6,
										padding: "6px 8px",
										fontSize: 12,
										color: "var(--text-secondary)",
									}}
								>
									🍽️ 外食 {slot.dining_out_kcal ? `（目安 ${Math.round(slot.dining_out_kcal)} kcal）` : ""}
								</div>
							) : item ? (
								<ItemCard
									item={item}
									planId={planId}
									isDraft={planStatus === "draft"}
								/>
							) : (
								<div style={{ fontSize: 12, color: "var(--text-secondary)" }}>未生成</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ─── SlotEditPanel ────────────────────────────────────────────────────────────
function SlotEditPanel({ planId, slot, onClose }) {
	const qc = useQueryClient();
	const [sharingType, setSharingType] = useState(slot.sharing_type);
	const [isDiningOut, setIsDiningOut] = useState(slot.is_dining_out || false);
	const [diningOutKcal, setDiningOutKcal] = useState(
		slot.dining_out_kcal || "",
	);
	const [replacing, setReplacing] = useState(false);
	const [saving, setSaving] = useState(false);

	const handleSave = async () => {
		setSaving(true);
		try {
			await mealPlanApi.updateSlot(planId, slot.id, {
				sharing_type: sharingType,
				is_dining_out: isDiningOut,
				dining_out_kcal:
					isDiningOut && diningOutKcal ? parseFloat(diningOutKcal) : null,
			});
			qc.invalidateQueries({ queryKey: ["meal-plan", planId] });
			onClose();
		} catch {
			alert("保存に失敗しました");
		} finally {
			setSaving(false);
		}
	};

	const handleReplace = async () => {
		setReplacing(true);
		try {
			await mealPlanApi.replaceSlot(planId, slot.id, {});
			qc.invalidateQueries({ queryKey: ["meal-plan", planId] });
			onClose();
		} catch (e) {
			alert(e.response?.data?.detail || "メニュー差し替えに失敗しました");
		} finally {
			setReplacing(false);
		}
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-content" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<h3>✏️ {MEAL_FULL[slot.meal_type]} を編集</h3>
					<button className="btn-icon" onClick={onClose}>
						✕
					</button>
				</div>
				<div className="form-group">
					<label className="form-label">共有 / 個別</label>
					<div style={{ display: "flex", gap: 8 }}>
						{["shared", "individual"].map((t) => (
							<button
								key={t}
								className={`btn ${sharingType === t ? "btn-primary" : "btn-outline"}`}
								onClick={() => setSharingType(t)}
							>
								{t === "shared" ? "共有食" : "個別食"}
							</button>
						))}
					</div>
				</div>
				<div className="form-group">
					<label className="form-label">
						<input
							type="checkbox"
							checked={isDiningOut}
							onChange={(e) => setIsDiningOut(e.target.checked)}
							style={{ marginRight: 8 }}
						/>
						外食に変更
					</label>
					{isDiningOut && (
						<input
							type="number"
							className="form-input"
							placeholder="外食カロリー（目安 kcal）"
							value={diningOutKcal}
							onChange={(e) => setDiningOutKcal(e.target.value)}
							min="0"
							style={{ marginTop: 8 }}
						/>
					)}
				</div>
				<div style={{ display: "flex", gap: 8, marginTop: 16 }}>
					<button
						className="btn btn-secondary"
						style={{ flex: 1 }}
						onClick={handleReplace}
						disabled={replacing}
					>
						{replacing ? "AI再提案中..." : "🔄 メニューをAI差し替え"}
					</button>
					<button
						className="btn btn-primary"
						style={{ flex: 1 }}
						onClick={handleSave}
						disabled={saving}
					>
						{saving ? "保存中..." : "保存"}
					</button>
				</div>
			</div>
		</div>
	);
}

// ─── メインページ ─────────────────────────────────────────────────────────────
export default function MealPlanPage() {
	const qc = useQueryClient();
	const today = toJstDateString();

	// ステップ管理
	const [step, setStep] = useState(null); // null | 'settings' | 'configure'
	const [startDate, setStartDate] = useState(today);
	const [showSettings, setShowSettings] = useState(false);
	const [settings, setSettings] = useLocalStorage(
		"meal_plan_settings_v2",
		DEFAULT_SETTINGS,
	);
	const [dayConditions, setDayConditions] = useState([]);

	// 結果表示
	const [selectedPlan, setSelectedPlan] = useState(null);
	const [showShopping, setShowShopping] = useState(false);
	const [editingSlot, setEditingSlot] = useState(null);
	const [recalculating, setRecalculating] = useState(false);
	const [generating, setGenerating] = useState(false);
	const [error, setError] = useState("");

	// データ取得
	const { data: plans = [] } = useQuery({
		queryKey: ["meal-plans"],
		queryFn: () => mealPlanApi.list(),
	});

	const { data: planDetail } = useQuery({
		queryKey: ["meal-plan", selectedPlan],
		queryFn: () => mealPlanApi.get(selectedPlan),
		enabled: !!selectedPlan,
		// 生成中（progress.done が false）は 2秒ごとにポーリング
		refetchInterval: (query) => {
			const data = query.state.data;
			const prog = data?.progress;
			return prog && prog.done === false ? 2000 : false;
		},
		refetchIntervalInBackground: true,
	});

	const { data: shopping } = useQuery({
		queryKey: ["shopping", selectedPlan],
		queryFn: () => shoppingApi.get(selectedPlan),
		enabled: !!selectedPlan && showShopping,
	});

	const { data: myGroup } = useQuery({
		queryKey: ["my-group"],
		queryFn: () => groupApi.myGroup().then((r) => r.data),
	});
	const members = myGroup?.members || [];

	const { data: meUser } = useQuery({
		queryKey: ["auth-me"],
		queryFn: () => authApi.me().then((r) => r.data),
	});
	const currentUserId = meUser?.id;

	// label "A","B","C"... と user_id をマッピング
	const labelByUserId = {};
	const userIdByLabel = {};
	const memberNameByLabel = {};
	const labels = ["A", "B", "C", "D", "E", "F", "G"];
	members.forEach((m, i) => {
		labelByUserId[m.user_id] = labels[i];
		userIdByLabel[labels[i]] = m.user_id;
		memberNameByLabel[labels[i]] = m.name;
	});

	const { data: schedules = {} } = useQuery({
		queryKey: ["group-schedules", startDate],
		queryFn: () => groupApi.schedules(startDate, 7),
		enabled: step === "configure",
		retry: false,
	});

	// ─── アクション ────────────────────────────────────────────────────────────

	function handleGoToConfigure() {
		const conds = buildDayConditions(startDate, 7, settings, members);
		setDayConditions(conds);
		setStep("configure");
		setShowSettings(false);
	}

	function updateDayCondition(date, userId, meal, newSource) {
		setDayConditions((prev) =>
			prev.map((dc) => {
				if (dc.date !== date) return dc;
				return {
					...dc,
					members: dc.members.map((m) =>
						m.user_id === userId ? { ...m, [meal]: newSource } : m,
					),
				};
			}),
		);
	}

	async function handleGenerate() {
		setError("");
		setGenerating(true);
		try {
			// frequentMenus を user_id ごとに整形
			const frequentMenus = {};
			members.forEach((m) => {
				const fm = settings.frequentMenus?.[m.user_id];
				if (fm && (fm.breakfast?.length || fm.lunch?.length || fm.dinner?.length)) {
					frequentMenus[m.user_id] = {
						breakfast: fm.breakfast || [],
						lunch: fm.lunch || [],
						dinner: fm.dinner || [],
					};
				}
			});
			const res = await mealPlanApi.generate({
				start_date: startDate,
				days: 7,
				day_conditions: dayConditions,
				frequent_menus: frequentMenus,
			});
			qc.invalidateQueries({ queryKey: ["meal-plans"] });
			setSelectedPlan(res.id);
			setStep(null);
		} catch (e) {
			setError(
				e.response?.data?.detail || e.message || "献立生成に失敗しました",
			);
		} finally {
			setGenerating(false);
		}
	}

	const confirmMutation = useMutation({
		mutationFn: (planId) => mealPlanApi.confirm(planId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["meal-plans"] });
			qc.invalidateQueries({ queryKey: ["meal-plan", selectedPlan] });
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (planId) => mealPlanApi.delete(planId),
		onSuccess: (_, planId) => {
			qc.invalidateQueries({ queryKey: ["meal-plans"] });
			if (selectedPlan === planId) setSelectedPlan(null);
		},
		onError: (e) => setError(e.response?.data?.detail || "削除に失敗しました"),
	});

	const handleRecalculate = async () => {
		if (!selectedPlan) return;
		if (
			!confirm("修正内容を踏まえてAIが献立全体を再計算します。よろしいですか？")
		)
			return;
		setRecalculating(true);
		setError("");
		try {
			await mealPlanApi.recalculate(selectedPlan);
			qc.invalidateQueries({ queryKey: ["meal-plan", selectedPlan] });
		} catch (e) {
			setError(e.response?.data?.detail || "再計算に失敗しました");
		} finally {
			setRecalculating(false);
		}
	};

	// ─── ステップ1: 日付選択 + 設定 ───────────────────────────────────────────
	if (step === "settings") {
		return (
			<div>
				<div className="page-header">
					<h1 className="page-title">プランを作成</h1>
					<div className="page-header-actions">
						<button
							className="btn btn-outline btn-sm"
							onClick={() => setStep(null)}
						>
							← 戻る
						</button>
					</div>
				</div>

				{error && <div className="alert alert-error">{error}</div>}

				<div className="card">
					<div className="card-title">開始日を選択</div>
					<input
						type="date"
						className="form-input"
						value={startDate}
						min={today}
						onChange={(e) => setStartDate(e.target.value)}
					/>
					<div
						style={{
							fontSize: 12,
							color: "var(--text-secondary)",
							marginTop: 6,
						}}
					>
						{startDate} 〜 {addJstDays(startDate, 6)} の7日間
					</div>
				</div>

				<div className="card">
					<button
						className="btn btn-outline btn-full"
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
						}}
						onClick={() => setShowSettings((v) => !v)}
					>
						<span>⚙️ メンバー別デフォルト設定</span>
						<span>{showSettings ? "▲" : "▼"}</span>
					</button>
					{showSettings && (
						<div style={{ marginTop: 12 }}>
							<SettingsPanel
								settings={settings}
								onChange={setSettings}
								members={members}
							/>
						</div>
					)}
				</div>

				<button
					className="btn btn-primary btn-full"
					onClick={handleGoToConfigure}
					disabled={!startDate || members.length === 0}
				>
					7日間の食事スタイルを設定する →
				</button>
				{members.length === 0 && (
					<div
						style={{
							fontSize: 12,
							color: "var(--text-secondary)",
							textAlign: "center",
							marginTop: 8,
						}}
					>
						※ グループを作成・参加してから献立を生成できます
					</div>
				)}
			</div>
		);
	}

	// ─── ステップ2: 7日間の食事スタイル設定 ────────────────────────────────────
	if (step === "configure") {
		return (
			<div>
				<div className="page-header">
					<h1 className="page-title">プランを設定</h1>
					<div className="page-header-actions">
						<button
							className="btn btn-outline btn-sm"
							onClick={() => setStep("settings")}
						>
							← 戻る
						</button>
					</div>
				</div>

				{error && <div className="alert alert-error">{error}</div>}

				<div
					style={{
						background: "var(--surface)",
						borderRadius: 8,
						padding: "8px 12px",
						marginBottom: 12,
						fontSize: 12,
						color: "var(--text-secondary)",
					}}
				>
					ボタンをタップするたびに{" "}
					{Object.entries(SOURCE_LABEL)
						.map(([k, v]) => `${v}${SOURCE_JP[k]}`)
						.join(" → ")}{" "}
					が切り替わります
				</div>

				{dayConditions.map((dc) => (
					<DayRow
						key={dc.date}
						dayCondition={dc}
						members={members}
						schedules={schedules}
						onUpdate={updateDayCondition}
					/>
				))}

				<button
					className="btn btn-primary btn-full"
					style={{ marginTop: 8 }}
					onClick={handleGenerate}
					disabled={generating}
				>
					{generating
						? "AIが献立を生成中... (しばらくお待ちください)"
						: "✨ この内容で献立を生成する"}
				</button>
				<div
					style={{
						fontSize: 12,
						color: "var(--text-secondary)",
						textAlign: "center",
						marginTop: 6,
					}}
				>
					※ 無料プラン: 週間献立は月1回まで
				</div>
			</div>
		);
	}

	// ─── メイン画面（履歴 + 詳細） ─────────────────────────────────────────────
	return (
		<div>
			<div className="page-header">
				<h1 className="page-title">プラン</h1>
				<div className="page-header-actions">
					<button
						className="btn btn-primary btn-sm"
						onClick={() => {
							setError("");
							setStep("settings");
						}}
					>
						＋ 新しい献立
					</button>
				</div>
			</div>

			{error && <div className="alert alert-error">{error}</div>}

			{/* 献立履歴 */}
			{plans.length > 0 && (
				<>
					<div className="section-title">献立履歴</div>
					{plans.map((plan) => (
						<div
							key={plan.id}
							className="card"
							style={{
								cursor: "pointer",
								border:
									selectedPlan === plan.id
										? "2px solid var(--primary)"
										: "2px solid transparent",
							}}
							onClick={() => {
								setSelectedPlan(plan.id);
								setShowShopping(false);
							}}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "flex-start",
									gap: 8,
								}}
							>
								<div style={{ flex: 1, minWidth: 0 }}>
									<div style={{ fontWeight: 600, fontSize: 14 }}>
										{plan.start_date}
										{plan.start_date !== plan.end_date
											? ` 〜 ${plan.end_date}`
											: ""}
									</div>
									<div
										style={{
											fontSize: 12,
											color: "var(--text-secondary)",
											marginTop: 2,
										}}
									>
										{new Date(plan.created_at).toLocaleString("ja-JP", {
											month: "numeric",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</div>
								</div>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 6,
										flexShrink: 0,
									}}
								>
									<span
										className={`tag ${plan.status === "confirmed" ? "tag-green" : "tag-orange"}`}
									>
										{plan.status === "confirmed" ? "確定済み" : "下書き"}
									</span>
									<button
										className="btn-icon"
										style={{
											fontSize: 16,
											color: "var(--text-secondary)",
											padding: 4,
										}}
										title="削除"
										onClick={(e) => {
											e.stopPropagation();
											if (window.confirm("この献立を削除しますか？"))
												deleteMutation.mutate(plan.id);
										}}
										disabled={deleteMutation.isPending}
									>
										🗑️
									</button>
								</div>
							</div>
						</div>
					))}
				</>
			)}

			{/* 献立詳細 */}
			{planDetail && (
				<div style={{ marginTop: 8 }}>
					<div className="section-title">献立内容</div>

					{/* 生成進捗 */}
					<GenerationProgress progress={planDetail.progress} />

					{planDetail.status === "draft" &&
						(!planDetail.progress || planDetail.progress.done) && (
							<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
								<button
									className="btn btn-secondary"
									style={{ flex: 1 }}
									onClick={handleRecalculate}
									disabled={recalculating}
								>
									{recalculating ? "再計算中..." : "🔄 再計算"}
								</button>
								<button
									className="btn btn-primary"
									style={{ flex: 1 }}
									onClick={() => confirmMutation.mutate(selectedPlan)}
									disabled={confirmMutation.isPending}
								>
									{confirmMutation.isPending ? "確定中..." : "✓ 献立を確定"}
								</button>
							</div>
						)}

					{planDetail.status === "confirmed" && (
						<button
							className="btn btn-secondary btn-full"
							style={{ marginBottom: 12 }}
							onClick={() => setShowShopping(!showShopping)}
						>
							🛒 {showShopping ? "献立に戻る" : "買い物リストを見る"}
						</button>
					)}

					{showShopping && shopping ? (
						<div className="card">
							<div className="card-title">🛒 買い物リスト（自炊分）</div>
							<ShoppingListBlock
								title="共有食材"
								rawItems={shopping.shared}
								planId={planDetail.id}
								listKey="shared"
							/>
							{Object.entries(shopping)
								.filter(([k]) => k !== "shared")
								.map(([key, items]) => (
									<ShoppingListBlock
										key={key}
										title={`個別（${key.replace("individual_", "")}）`}
										rawItems={items}
										planId={planDetail.id}
										listKey={key}
									/>
								))}
							{(!shopping.shared || shopping.shared.length === 0) &&
								Object.keys(shopping).filter((k) => k !== "shared").length ===
									0 && (
									<div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
										自炊メニューがないため買い物リストはありません
									</div>
								)}
						</div>
					) : (
						planDetail.days.map((day) => (
							<div key={day.id} className="card">
								<div className="card-title">{dateLabel(day.date)}</div>
								{members.map((m) => {
									const label = labelByUserId[m.user_id];
									const isMe = m.user_id === currentUserId;
									return (
										<MemberDayCard
											key={m.user_id}
											memberLabel={label}
											memberName={m.name}
											isMe={isMe}
											daySlots={day.slots}
											planId={planDetail.id}
											planStatus={planDetail.status}
											onEditSlot={setEditingSlot}
										/>
									);
								})}
							</div>
						))
					)}
				</div>
			)}

			{plans.length === 0 && (
				<div className="empty-state">
					<div style={{ fontSize: 40 }}>📋</div>
					<p>
						「新しい献立を作成」ボタンで
						<br />
						AIが7日分の献立を提案します
					</p>
				</div>
			)}

			{editingSlot && (
				<SlotEditPanel
					planId={editingSlot.planId}
					slot={editingSlot.slot}
					onClose={() => setEditingSlot(null)}
				/>
			)}
		</div>
	);
}
