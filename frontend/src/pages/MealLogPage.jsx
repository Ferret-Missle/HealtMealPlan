/**
 * MealLogPage — 読み取り専用の食事ログビュー
 *
 * 食事の記録はFatSecretアプリで行い、このページは同期結果を表示するのみ。
 * 手動追加・検索機能は廃止。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronLeft,
	ChevronRight,
	CloudSun,
	Cookie,
	ExternalLink,
	Moon,
	RefreshCw,
	Sun,
} from "lucide-react";
import { useState } from "react";
import PFCChart from "../components/PFCChart";
import { mealsApi } from "../services/api";
import {
	addJstDays,
	formatJstDate,
	isTodayJst,
	toJstDateString,
} from "../utils/date";

const MEAL_TYPES = [
	{ key: "breakfast", label: "朝食", Icon: Sun },
	{ key: "lunch", label: "昼食", Icon: CloudSun },
	{ key: "dinner", label: "夕食", Icon: Moon },
	{ key: "snack", label: "間食", Icon: Cookie },
];

function fmt(dateStr) {
	return formatJstDate(dateStr, {
		month: "long",
		day: "numeric",
		weekday: "short",
	});
}

export default function MealLogPage() {
	const qc = useQueryClient();
	const [dateStr, setDateStr] = useState(toJstDateString());

	const { data: logs = [], isLoading } = useQuery({
		queryKey: ["meals", dateStr],
		queryFn: () => mealsApi.list(dateStr).then((r) => r.data),
	});

	const syncMutation = useMutation({
		mutationFn: () => mealsApi.syncFatSecret(dateStr),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["meals", dateStr] }),
	});

	const prev = () => setDateStr((d) => addJstDays(d, -1));
	const next = () => setDateStr((d) => addJstDays(d, 1));
	const isToday = isTodayJst(dateStr);

	const totals = logs.reduce(
		(acc, log) => ({
			kcal: acc.kcal + (log.kcal || 0),
			protein: acc.protein + (log.protein_g || 0),
			fat: acc.fat + (log.fat_g || 0),
			carb: acc.carb + (log.carb_g || 0),
		}),
		{ kcal: 0, protein: 0, fat: 0, carb: 0 },
	);

	const logsByType = MEAL_TYPES.reduce((acc, mt) => {
		acc[mt.key] = logs.filter((l) => l.meal_type === mt.key);
		return acc;
	}, {});

	if (isLoading)
		return (
			<div className="loading-screen">
				<div className="spinner" />
			</div>
		);

	return (
		<div>
			<div className="page-header">
				<h1 className="page-title">食事ログ</h1>
				<div className="page-header-actions">
					<button
						className="btn btn-primary btn-sm"
						onClick={() => syncMutation.mutate()}
						disabled={syncMutation.isPending}
					>
						<RefreshCw
							size={13}
							strokeWidth={2}
							style={
								syncMutation.isPending
									? { animation: "spin 0.65s linear infinite" }
									: {}
							}
						/>
						{syncMutation.isPending ? "同期中…" : "同期"}
					</button>
				</div>
			</div>

			{/* Date nav */}
			<div className="date-nav">
				<button className="btn-icon" onClick={prev}>
					<ChevronLeft size={20} strokeWidth={2} />
				</button>
				<span className="date-display">{fmt(dateStr)}</span>
				<button
					className="btn-icon"
					onClick={next}
					disabled={isToday}
					style={{ opacity: isToday ? 0.25 : 1 }}
				>
					<ChevronRight size={20} strokeWidth={2} />
				</button>
			</div>

			{/* Daily totals */}
			{logs.length > 0 ? (
				<div className="card">
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							marginBottom: "var(--sp-3)",
						}}
					>
						<div className="card-title" style={{ marginBottom: 0 }}>
							本日の合計
						</div>
						<div>
							<span className="metric-value" style={{ fontSize: 24 }}>
								{Math.round(totals.kcal)}
							</span>
							<span className="metric-unit">kcal</span>
						</div>
					</div>
					<PFCChart
						protein={totals.protein}
						fat={totals.fat}
						carb={totals.carb}
						size={90}
					/>
				</div>
			) : (
				/* Empty state with FatSecret CTA */
				<div
					className="card"
					style={{ textAlign: "center", padding: "var(--sp-8) var(--sp-5)" }}
				>
					<div style={{ fontSize: 36, marginBottom: "var(--sp-3)" }}>🍽️</div>
					<div
						style={{
							fontWeight: 600,
							fontSize: 15,
							color: "var(--text)",
							marginBottom: 8,
						}}
					>
						この日の記録はありません
					</div>
					<p
						style={{
							fontSize: 13,
							color: "var(--text-2)",
							marginBottom: "var(--sp-5)",
							lineHeight: 1.7,
						}}
					>
						FatSecretアプリで食事を記録すると
						<br />
						「同期」ボタンでここに反映されます
					</p>
					<a
						href="https://www.fatsecret.co.jp/"
						target="_blank"
						rel="noopener noreferrer"
						className="btn btn-secondary"
						style={{ display: "inline-flex" }}
					>
						FatSecretで記録する
						<ExternalLink size={13} strokeWidth={2} />
					</a>
				</div>
			)}

			{/* Meal slots (read-only) */}
			{MEAL_TYPES.map(({ key, label, Icon }) => {
				const slotLogs = logsByType[key];
				if (slotLogs.length === 0) return null;
				const slotKcal = slotLogs.reduce((s, l) => s + (l.kcal || 0), 0);

				return (
					<div className="card" key={key}>
						<div className="meal-slot-header">
							<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
								<Icon
									size={15}
									strokeWidth={1.8}
									style={{ color: "var(--brand)" }}
								/>
								<span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
								<span className="meal-slot-kcal">
									{Math.round(slotKcal)} kcal
								</span>
							</div>
						</div>

						{slotLogs.map((log) => (
							<div key={log.id} className="food-log-row">
								<div style={{ flex: 1, minWidth: 0 }}>
									<div
										style={{
											fontSize: 14,
											fontWeight: 500,
											color: "var(--text)",
										}}
									>
										{log.food_name}
									</div>
									<div
										style={{
											fontSize: 12,
											color: "var(--text-2)",
											marginTop: 2,
										}}
									>
										{Math.round(log.kcal)} kcal
										{log.protein_g > 0 && <> · P{log.protein_g.toFixed(1)}g</>}
										{log.fat_g > 0 && <> · F{log.fat_g.toFixed(1)}g</>}
										{log.carb_g > 0 && <> · C{log.carb_g.toFixed(1)}g</>}
										{log.serving_grams > 0 && (
											<span
												style={{
													color: "var(--text-3)",
													fontSize: 11,
													marginLeft: 6,
												}}
											>
												{log.serving_grams}g
											</span>
										)}
									</div>
								</div>
								{log.source && (
									<span
										className={`tag ${log.source === "fatsecret" ? "tag-green" : "tag-gray"}`}
									>
										{log.source}
									</span>
								)}
							</div>
						))}
					</div>
				);
			})}

			{/* Footer hint */}
			{logs.length > 0 && (
				<div
					style={{
						fontSize: 12,
						color: "var(--text-3)",
						textAlign: "center",
						marginTop: "var(--sp-4)",
					}}
				>
					FatSecretと連携した記録を表示しています
				</div>
			)}
		</div>
	);
}
