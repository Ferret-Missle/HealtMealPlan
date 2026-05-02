import {
	closestCenter,
	DndContext,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Calendar,
	CalendarClock,
	ChevronLeft,
	ChevronRight,
	Flame,
	Footprints,
	GripVertical,
	Layers,
	Link2Off,
	Moon,
	RefreshCw,
	Scale,
	Settings2,
	UtensilsCrossed,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	Cell,
	ComposedChart,
	Line,
	Pie,
	PieChart,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { bodyApi, dashboardApi, mealsApi } from "../services/api";
import {
	addJstDays,
	formatJstDate,
	isTodayJst,
	toJstDateString,
} from "../utils/date";

// ── 日付ユーティリティ ────────────────────────────────────────
function todayStr() {
	return toJstDateString();
}
function offsetDate(base, days) {
	return addJstDays(base, days);
}
function fmtDate(dateStr) {
	return formatJstDate(dateStr, {
		month: "long",
		day: "numeric",
		weekday: "short",
	});
}
function fmtShort(dateStr) {
	return formatJstDate(dateStr, { month: "numeric", day: "numeric" });
}

// ── localStorage ─────────────────────────────────────────────
function lsGet(key, def) {
	try {
		return JSON.parse(localStorage.getItem(key)) ?? def;
	} catch {
		return def;
	}
}
function lsSet(key, val) {
	try {
		localStorage.setItem(key, JSON.stringify(val));
	} catch {}
}

// ── 定数 ─────────────────────────────────────────────────────
const WIDGET_IDS = ["weight", "calories", "pfc", "steps", "sleep", "meals"];

const WIDGET_META = {
	weight: { label: "体重", Icon: Scale },
	calories: { label: "カロリー", Icon: Flame },
	pfc: { label: "PFC", Icon: Layers },
	steps: { label: "歩数", Icon: Footprints },
	sleep: { label: "睡眠", Icon: Moon },
	meals: { label: "食事記録", Icon: UtensilsCrossed },
};

// ── 連携要件マップ ──────────────────────────────────────────
// required: そのウィジェットを機能させるのに必須の外部サービス
//   any:true → どれか1つ連携でOK
//   any:false (default) → すべて必要
// 手動入力で代替可能なウィジェット (calories/pfc/meals) は要件なし
const WIDGET_REQUIREMENTS = {
	weight: {
		services: ["fitbit", "healthplanet"],
		any: true,
		label: "Fitbit / HealthPlanet",
	},
	steps: { services: ["fitbit"], label: "Fitbit" },
	sleep: { services: ["fitbit"], label: "Fitbit" },
};

function isServiceConnected(req, connectedServices = []) {
	if (!req) return true;
	return req.any
		? req.services.some((s) => connectedServices.includes(s))
		: req.services.every((s) => connectedServices.includes(s));
}

const DEFAULT_ORDER = WIDGET_IDS;
const DEFAULT_VIS = Object.fromEntries(
	WIDGET_IDS.map((id) => [id, { value: true, graph: false }]),
);
const DEFAULT_PERIODS = Object.fromEntries(WIDGET_IDS.map((id) => [id, "7d"]));

const BRAND = "#16a34a";
const PFC_COLORS = ["#16a34a", "#f59e0b", "#3b82f6"];
const widgetSyncButtonStyle = {
	marginTop: 6,
	marginBottom: 0,
	width: "100%",
	fontSize: 11,
};
const tipStyle = {
	fontSize: 11,
	padding: "4px 8px",
	borderRadius: 6,
	border: "1px solid #e2e8f0",
};

// ── 共通パーツ ────────────────────────────────────────────────
function Dot({ color }) {
	return (
		<span
			style={{
				display: "inline-block",
				width: 8,
				height: 8,
				borderRadius: "50%",
				background: color,
				marginRight: 4,
			}}
		/>
	);
}
function EmptyGraph({ msg = "データなし" }) {
	return (
		<div style={{ color: "var(--text-2)", fontSize: 12, padding: "8px 0" }}>
			{msg}
		</div>
	);
}
function PeriodPills({ period, onChange, supported = ["1d", "7d", "30d"] }) {
	const labels = { "1d": "1日", "7d": "7日", "30d": "30日" };
	return (
		<div className="period-pills">
			{supported.map((p) => (
				<button
					key={p}
					className={`period-pill${period === p ? " active" : ""}`}
					onClick={() => onChange(p)}
				>
					{labels[p]}
				</button>
			))}
		</div>
	);
}

// ── 連携が必要オーバーレイ ────────────────────────────────────
function NotConnectedOverlay({ label }) {
	return (
		<div className="widget-not-connected">
			<Link2Off
				size={22}
				strokeWidth={1.5}
				className="widget-not-connected-icon"
			/>
			<div className="widget-not-connected-msg">{label} 連携が必要</div>
			<Link
				to="/me"
				className="btn btn-primary btn-sm widget-not-connected-cta"
			>
				連携設定へ →
			</Link>
		</div>
	);
}

// ── ソータブル ウィジェットシェル ─────────────────────────────
function WidgetShell({
	id,
	vis,
	period,
	onPeriodChange,
	valueContent,
	graphContent,
	graphSupport,
	span,
	needsConnection,
	requirementLabel,
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });
	const { label, Icon } = WIDGET_META[id];
	const showBoth = vis.value && vis.graph;
	// span: 'full' | 'span-2' | undefined
	const spanClass =
		span === "full" ? " full" : span === "span-2" ? " span-2" : "";

	return (
		<div
			ref={setNodeRef}
			className={`widget-card${spanClass}`}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.35 : 1,
			}}
		>
			{/* ヘッダー */}
			<div className="widget-header">
				<span className="widget-label">
					<Icon size={12} strokeWidth={1.8} />
					{label}
				</span>
				<span
					{...attributes}
					{...listeners}
					style={{
						cursor: "grab",
						padding: "2px",
						color: "var(--text-3)",
						lineHeight: 1,
						touchAction: "none",
					}}
					title="長押しで並び替え"
				>
					<GripVertical size={13} strokeWidth={1.5} />
				</span>
			</div>

			{needsConnection ? (
				<NotConnectedOverlay label={requirementLabel} />
			) : (
				<>
					{/* 数値セクション */}
					{vis.value && <div>{valueContent}</div>}

					{/* 区切り線（両方表示時） */}
					{showBoth && <div className="widget-divider" />}

					{/* グラフセクション */}
					{vis.graph && (
						<div>
							<PeriodPills
								period={period}
								onChange={onPeriodChange}
								supported={graphSupport}
							/>
							{graphContent}
						</div>
					)}
				</>
			)}
		</div>
	);
}

// ── 体重 ──────────────────────────────────────────────────────
function WeightValue({ latest, delta, pct }) {
	return (
		<>
			<div style={{ lineHeight: 1.1, marginTop: 2 }}>
				<span className="widget-value">{latest ?? "—"}</span>
				<span className="widget-unit">kg</span>
			</div>
			{delta && (
				<div className="widget-sub">
					{parseFloat(delta) < 0 ? "▼" : "▲"} {Math.abs(delta)} kg（
					{delta < 0 ? "" : "+"}）
				</div>
			)}
			{pct != null && (
				<div className="progress-bar" style={{ marginTop: 6 }}>
					<div
						className={`progress-fill${pct > 100 ? " over" : ""}`}
						style={{ width: `${Math.min(pct, 100)}%` }}
					/>
				</div>
			)}
		</>
	);
}

function WeightGraph({ history, onBulkSync, isSyncing }) {
	const isEmpty = !history?.length;
	const data = isEmpty
		? []
		: history.map((w) => ({ d: fmtShort(w.date), v: w.weight }));
	const vals = data.map((d) => d.v);
	const lo = data.length ? Math.floor(Math.min(...vals) - 0.5) : 0;
	const hi = data.length ? Math.ceil(Math.max(...vals) + 0.5) : 100;
	return (
		<div>
			{isEmpty ? (
				<EmptyGraph msg="データなし — 右の一括同期で取得できます" />
			) : (
				<ResponsiveContainer width="100%" height={100}>
					<AreaChart
						data={data}
						margin={{ top: 4, right: 4, left: -28, bottom: 0 }}
					>
						<defs>
							<linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor={BRAND} stopOpacity={0.25} />
								<stop offset="95%" stopColor={BRAND} stopOpacity={0} />
							</linearGradient>
						</defs>
						<XAxis
							dataKey="d"
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<YAxis
							domain={[lo, hi]}
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<Tooltip
							contentStyle={tipStyle}
							formatter={(v) => [`${v} kg`, "体重"]}
						/>
						<Area
							type="monotone"
							dataKey="v"
							stroke={BRAND}
							strokeWidth={1.5}
							fill="url(#wGrad)"
							dot={{ r: 2, fill: BRAND }}
						/>
					</AreaChart>
				</ResponsiveContainer>
			)}
			{/* 一括同期ボタン */}
			<button
				className="btn btn-outline btn-sm"
				style={widgetSyncButtonStyle}
				onClick={onBulkSync}
				disabled={isSyncing}
			>
				<RefreshCw
					size={11}
					strokeWidth={2}
					style={
						isSyncing
							? { animation: "spin 0.65s linear infinite", marginRight: 4 }
							: { marginRight: 4 }
					}
				/>
				{isSyncing ? "同期中…" : "過去の体重を一括同期"}
			</button>
		</div>
	);
}

// ── カロリー ──────────────────────────────────────────────────
function CaloriesValue({ intake, target, pct, remaining, yesterdayKcal, avgKcal7 }) {
	const fill = `progress-fill${pct > 100 ? " over" : pct > 75 ? " warn" : ""}`;
	const hasComparison = yesterdayKcal != null || avgKcal7 != null;
	return (
		<>
			<div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginTop: 2 }}>
				<div style={{ lineHeight: 1.1 }}>
					<span className="widget-value">{intake?.toLocaleString() ?? "—"}</span>
					<span className="widget-unit">kcal</span>
				</div>
				{hasComparison && (
					<div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.7, paddingBottom: 2 }}>
						{yesterdayKcal != null && (
							<div>
								昨日 <span style={{ color: "var(--text)", fontWeight: 600 }}>{yesterdayKcal.toLocaleString()}</span>
								{target != null && (
									<span style={{ color: "var(--text-3)", marginLeft: 4 }}>/ 目標 {target.toLocaleString()}</span>
								)}
							</div>
						)}
						{avgKcal7 != null && (
							<div>
								7日平均 <span style={{ color: "var(--text)", fontWeight: 600 }}>{avgKcal7.toLocaleString()}</span>
								{target != null && (
									<span style={{ color: "var(--text-3)", marginLeft: 4 }}>/ 目標 {target.toLocaleString()}</span>
								)}
							</div>
						)}
					</div>
				)}
			</div>
			{remaining != null ? (
				<div className="widget-sub">残り {remaining.toLocaleString()}</div>
			) : (
				target && (
					<div className="widget-sub">目標 {target.toLocaleString()}</div>
				)
			)}
			{pct != null && (
				<div className="progress-bar" style={{ marginTop: 6 }}>
					<div className={fill} style={{ width: `${Math.min(pct, 100)}%` }} />
				</div>
			)}
		</>
	);
}

function CaloriesGraph({ intake, target, history = [], period = "1d" }) {
	// 7d / 30d：日別kcalの折れ線 + 面グラフ
	if (period !== "1d") {
		if (!history.length) return <EmptyGraph />;
		const days = period === "30d" ? 30 : 7;
		const sliced = history.slice(0, days).reverse();
		const fmtDate = (d) => {
			const parts = d.split("-");
			return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
		};
		const chartData = sliced.map((r) => ({ date: fmtDate(r.date), kcal: r.total_kcal }));
		return (
			<ResponsiveContainer width="100%" height={120}>
				<AreaChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
					<defs>
						<linearGradient id="calGrad" x1="0" y1="0" x2="0" y2="1">
							<stop offset="5%" stopColor={BRAND} stopOpacity={0.3} />
							<stop offset="95%" stopColor={BRAND} stopOpacity={0} />
						</linearGradient>
					</defs>
					<XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
					<YAxis tick={{ fontSize: 9 }} />
					<Tooltip
						formatter={(v) => [`${v.toLocaleString()} kcal`, "摂取"]}
						labelStyle={{ fontSize: 11 }}
						contentStyle={{ fontSize: 11 }}
					/>
					{target && <ReferenceLine y={target} stroke="#94a3b8" strokeDasharray="3 3" label={{ value: "目標", fontSize: 9, fill: "#94a3b8" }} />}
					<Area type="monotone" dataKey="kcal" stroke={BRAND} fill="url(#calGrad)" strokeWidth={2} dot={{ r: 3, fill: BRAND, strokeWidth: 0 }} activeDot={{ r: 4 }} />
				</AreaChart>
			</ResponsiveContainer>
		);
	}

	// 1d：ドーナツ
	if (!intake) return <EmptyGraph />;
	const over = target && intake > target ? intake - target : 0;
	const consumed = intake - over;
	const remain = target ? Math.max(0, target - intake) : 0;
	const data = [
		{ name: "摂取", value: consumed, fill: BRAND },
		{ name: "オーバー", value: over, fill: "#dc2626" },
		{ name: "残り", value: remain, fill: "#e2e8f0" },
	].filter((d) => d.value > 0);
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<ResponsiveContainer width={72} height={72}>
				<PieChart>
					<Pie
						data={data}
						cx="50%"
						cy="50%"
						innerRadius={22}
						outerRadius={34}
						dataKey="value"
						startAngle={90}
						endAngle={-270}
						strokeWidth={0}
					>
						{data.map((d, i) => (
							<Cell key={i} fill={d.fill} />
						))}
					</Pie>
				</PieChart>
			</ResponsiveContainer>
			<div style={{ fontSize: 11, lineHeight: 1.9 }}>
				<div>
					<Dot color={BRAND} />
					摂取 {intake.toLocaleString()}
				</div>
				{target && (
					<div>
						<Dot color="#e2e8f0" />
						残り {remain.toLocaleString()}
					</div>
				)}
				{over > 0 && (
					<div>
						<Dot color="#dc2626" />
						超過 {over.toLocaleString()}
					</div>
				)}
			</div>
		</div>
	);
}

// ── PFC ───────────────────────────────────────────────────────
function PFCValue({ p, f, c, yp, yf, yc }) {
	const hasYesterday = yp != null || yf != null || yc != null;
	return (
		<div
			style={{ marginTop: 4, fontSize: 12, lineHeight: 2, textAlign: "center" }}
		>
			<div style={{ display: "flex", justifyContent: "center", gap: 8, alignItems: "baseline" }}>
				<span>
					<span style={{ color: PFC_COLORS[0], fontWeight: 700 }}>P</span>{" "}
					{p ? `${p.toFixed(1)}g` : "—"}
				</span>
				{hasYesterday && (
					<span style={{ fontSize: 10, color: "var(--text-2)" }}>
						昨日 {yp != null ? `${yp.toFixed(1)}g` : "—"}
					</span>
				)}
			</div>
			<div style={{ display: "flex", justifyContent: "center", gap: 8, alignItems: "baseline" }}>
				<span>
					<span style={{ color: PFC_COLORS[1], fontWeight: 700 }}>F</span>{" "}
					{f ? `${f.toFixed(1)}g` : "—"}
				</span>
				{hasYesterday && (
					<span style={{ fontSize: 10, color: "var(--text-2)" }}>
						昨日 {yf != null ? `${yf.toFixed(1)}g` : "—"}
					</span>
				)}
			</div>
			<div style={{ display: "flex", justifyContent: "center", gap: 8, alignItems: "baseline" }}>
				<span>
					<span style={{ color: PFC_COLORS[2], fontWeight: 700 }}>C</span>{" "}
					{c ? `${c.toFixed(1)}g` : "—"}
				</span>
				{hasYesterday && (
					<span style={{ fontSize: 10, color: "var(--text-2)" }}>
						昨日 {yc != null ? `${yc.toFixed(1)}g` : "—"}
					</span>
				)}
			</div>
		</div>
	);
}

function PFCGraph({ p, f, c, history = [], period = "1d" }) {
	// 7d / 30d：積み上げ棒グラフ（P/F/C）+ 各栄養素の線
	if (period !== "1d") {
		if (!history.length) return <EmptyGraph />;
		const days = period === "30d" ? 30 : 7;
		const sliced = history.slice(0, days).reverse();
		const fmtDate = (d) => {
			const parts = d.split("-");
			return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
		};
		const chartData = sliced.map((r) => ({
			date: fmtDate(r.date),
			P: r.protein_g,
			F: r.fat_g,
			C: r.carb_g,
			// 区切り線：累積値（P/F境界、F/C境界）
			_divPF: r.protein_g,
			_divFC: r.protein_g + r.fat_g,
		}));
		const tooltipFmt = (v, name) => {
			if (name.startsWith("_")) return null; // 区切り線は非表示
			return [`${v.toFixed(1)}g`, name === "P" ? "タンパク質" : name === "F" ? "脂質" : "炭水化物"];
		};
		return (
			<ResponsiveContainer width="100%" height={130}>
				<ComposedChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
					<XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
					<YAxis tick={{ fontSize: 9 }} unit="g" />
					<Tooltip formatter={tooltipFmt} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11 }} />
					<Bar dataKey="P" stackId="pfc" fill={PFC_COLORS[0]} />
					<Bar dataKey="F" stackId="pfc" fill={PFC_COLORS[1]} />
					<Bar dataKey="C" stackId="pfc" fill={PFC_COLORS[2]} radius={[2, 2, 0, 0]} />
					{/* P/F 境界線 */}
					<Line type="stepMiddle" dataKey="_divPF" stroke={PFC_COLORS[0]} strokeWidth={1.5} dot={false} legendType="none" />
					{/* F/C 境界線 */}
					<Line type="stepMiddle" dataKey="_divFC" stroke={PFC_COLORS[1]} strokeWidth={1.5} dot={false} legendType="none" />
				</ComposedChart>
			</ResponsiveContainer>
		);
	}

	// 1d：ドーナツ
	if (!p && !f && !c) return <EmptyGraph />;
	const data = [
		{ name: "タンパク質", value: p ?? 0 },
		{ name: "脂質", value: f ?? 0 },
		{ name: "炭水化物", value: c ?? 0 },
	].filter((d) => d.value > 0);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 6,
			}}
		>
			<ResponsiveContainer width={80} height={80}>
				<PieChart>
					<Pie
						data={data}
						cx="50%"
						cy="50%"
						innerRadius={24}
						outerRadius={38}
						dataKey="value"
						startAngle={90}
						endAngle={-270}
						strokeWidth={0}
					>
						{data.map((_, i) => (
							<Cell key={i} fill={PFC_COLORS[i]} />
						))}
					</Pie>
				</PieChart>
			</ResponsiveContainer>
			<div style={{ fontSize: 11, lineHeight: 1.8, textAlign: "center" }}>
				<div>
					<Dot color={PFC_COLORS[0]} />P {p?.toFixed(1) ?? "—"}g
				</div>
				<div>
					<Dot color={PFC_COLORS[1]} />F {f?.toFixed(1) ?? "—"}g
				</div>
				<div>
					<Dot color={PFC_COLORS[2]} />C {c?.toFixed(1) ?? "—"}g
				</div>
			</div>
		</div>
	);
}

// ── 歩数 ──────────────────────────────────────────────────────
const STEP_GOAL = 10000;

function StepsValue({ steps }) {
	const pct = steps ? Math.round((steps / STEP_GOAL) * 100) : null;
	return (
		<>
			<div style={{ lineHeight: 1.1, marginTop: 2 }}>
				<span className="widget-value">{steps?.toLocaleString() ?? "—"}</span>
				<span className="widget-unit">歩</span>
			</div>
			<div className="widget-sub">目標 {STEP_GOAL.toLocaleString()}</div>
			{pct != null && (
				<div className="progress-bar" style={{ marginTop: 6 }}>
					<div
						className={`progress-fill${pct >= 100 ? " over" : ""}`}
						style={{ width: `${Math.min(pct, 100)}%` }}
					/>
				</div>
			)}
		</>
	);
}

function StepsGraph({ steps, history, period, onBulkSync, isSyncing }) {
	// 1d：今日のドーナツグラフ
	if (period === "1d") {
		if (!steps) return <EmptyGraph />;
		const pct = Math.round((steps / STEP_GOAL) * 100);
		const data = [
			{ name: "達成", value: Math.min(steps, STEP_GOAL), fill: BRAND },
			{ name: "残り", value: Math.max(0, STEP_GOAL - steps), fill: "#e2e8f0" },
		];
		return (
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 4,
				}}
			>
				<ResponsiveContainer width={80} height={80}>
					<PieChart>
						<Pie
							data={data}
							cx="50%"
							cy="50%"
							innerRadius={24}
							outerRadius={38}
							dataKey="value"
							startAngle={90}
							endAngle={-270}
							strokeWidth={0}
						>
							{data.map((d, i) => (
								<Cell key={i} fill={d.fill} />
							))}
						</Pie>
					</PieChart>
				</ResponsiveContainer>
				<div style={{ textAlign: "center" }}>
					<div
						style={{
							fontSize: 20,
							fontWeight: 800,
							color: BRAND,
							lineHeight: 1.1,
						}}
					>
						{pct}%
					</div>
					<div style={{ fontSize: 11, color: "var(--text-2)" }}>
						{steps.toLocaleString()} 歩
					</div>
				</div>
			</div>
		);
	}

	// 7d / 30d：棒グラフ
	const data = (history ?? [])
		.filter((d) => d.steps != null)
		.map((d) => ({ d: fmtShort(d.date), v: d.steps }));
	const xInterval = data.length > 14 ? Math.ceil(data.length / 7) - 1 : 0;

	return (
		<div>
			{data.length < 2 ? (
				<EmptyGraph msg="データなし — 右の一括同期で取得できます" />
			) : (
				<ResponsiveContainer width="100%" height={90}>
					<BarChart
						data={data}
						margin={{ top: 4, right: 4, left: -28, bottom: 0 }}
					>
						<XAxis
							dataKey="d"
							interval={xInterval}
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<YAxis
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<Tooltip
							contentStyle={tipStyle}
							formatter={(v) => [`${v?.toLocaleString()} 歩`, "歩数"]}
						/>
						<ReferenceLine
							y={STEP_GOAL}
							stroke="#f59e0b"
							strokeDasharray="3 3"
							strokeWidth={1}
						/>
						<Bar
							dataKey="v"
							fill={BRAND}
							radius={[2, 2, 0, 0]}
							maxBarSize={18}
						/>
					</BarChart>
				</ResponsiveContainer>
			)}
			<button
				className="btn btn-outline btn-sm"
				style={widgetSyncButtonStyle}
				onClick={onBulkSync}
				disabled={isSyncing}
			>
				<RefreshCw
					size={11}
					strokeWidth={2}
					style={
						isSyncing
							? { animation: "spin 0.65s linear infinite", marginRight: 4 }
							: { marginRight: 4 }
					}
				/>
				{isSyncing ? "同期中…" : "過去の歩数を一括同期"}
			</button>
		</div>
	);
}

// ── 睡眠 ──────────────────────────────────────────────────────
function SleepValue({ hours, score }) {
	return (
		<>
			<div style={{ lineHeight: 1.1, marginTop: 2 }}>
				<span className="widget-value">{hours?.toFixed(1) ?? "—"}</span>
				<span className="widget-unit">h</span>
			</div>
			<div className="widget-sub">
				{score ? `スコア ${score}` : "目標 7 時間"}
			</div>
		</>
	);
}

function SleepGraph({ history, onBulkSync, isSyncing }) {
	const isEmpty = !history?.length;
	const data = isEmpty
		? []
		: history
				.filter((d) => d.sleep_hours)
				.map((d) => ({ d: fmtShort(d.date), v: d.sleep_hours }));
	const xInterval = data.length > 14 ? Math.ceil(data.length / 7) - 1 : 0;

	return (
		<div>
			{data.length < 2 ? (
				<EmptyGraph msg="データなし — 右の一括同期で取得できます" />
			) : (
				<ResponsiveContainer width="100%" height={90}>
					<AreaChart
						data={data}
						margin={{ top: 4, right: 4, left: -28, bottom: 0 }}
					>
						<defs>
							<linearGradient id="sleepGrad" x1="0" y1="0" x2="0" y2="1">
								<stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
								<stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
							</linearGradient>
						</defs>
						<XAxis
							dataKey="d"
							interval={xInterval}
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<YAxis
							domain={[0, "auto"]}
							tick={{ fontSize: 9, fill: "var(--text-3)" }}
							axisLine={false}
							tickLine={false}
						/>
						<Tooltip
							contentStyle={tipStyle}
							formatter={(v) => [`${v} h`, "睡眠"]}
						/>
						{/* 目標ライン 7h */}
						<Area
							type="monotone"
							dataKey="v"
							stroke="#3b82f6"
							strokeWidth={1.5}
							fill="url(#sleepGrad)"
							dot={{ r: 2, fill: "#3b82f6" }}
						/>
					</AreaChart>
				</ResponsiveContainer>
			)}
			<button
				className="btn btn-outline btn-sm"
				style={widgetSyncButtonStyle}
				onClick={onBulkSync}
				disabled={isSyncing}
			>
				<RefreshCw
					size={11}
					strokeWidth={2}
					style={
						isSyncing
							? { animation: "spin 0.65s linear infinite", marginRight: 4 }
							: { marginRight: 4 }
					}
				/>
				{isSyncing ? "同期中…" : "過去の睡眠を一括同期"}
			</button>
		</div>
	);
}

// ── 食事記録 ──────────────────────────────────────────────────
const MEAL_TYPE_LABEL = {
	breakfast: "朝食",
	lunch: "昼食",
	dinner: "夕食",
	snack: "間食",
};
const MEAL_TYPE_ORDER = ["breakfast", "lunch", "dinner", "snack"];

function MealsValue({ logs, yesterdayKcal }) {
	const total = logs.reduce((s, l) => s + (l.kcal || 0), 0);
	return (
		<>
			<div style={{ lineHeight: 1.1, marginTop: 2, display: "flex", alignItems: "baseline", gap: 8 }}>
				<div>
					<span className="widget-value">
						{total ? Math.round(total).toLocaleString() : "—"}
					</span>
					<span className="widget-unit">kcal</span>
				</div>
				{yesterdayKcal != null && (
					<span style={{ fontSize: 11, color: "var(--text-2)" }}>
						昨日 {yesterdayKcal.toLocaleString()}
					</span>
				)}
			</div>
			<div className="widget-sub">{logs.length} 件の食事記録</div>
		</>
	);
}

function MealsList({ logs, onSync, isSyncing }) {
	// meal_type ごとにグルーピング
	const grouped = MEAL_TYPE_ORDER.reduce((acc, t) => {
		const items = logs.filter((l) => l.meal_type === t);
		if (items.length) acc[t] = items;
		return acc;
	}, {});

	return (
		<div className="meal-widget-list">
			{logs.length === 0 ? (
				<EmptyGraph msg="食事記録なし — FatSecret 同期か食事ログから追加してください" />
			) : (
				Object.entries(grouped).map(([type, items]) => (
					<div key={type} className="meal-widget-group">
						<div className="meal-widget-group-label">
							{MEAL_TYPE_LABEL[type] || type}
						</div>
						{items.map((item) => (
							<div key={item.id} className="meal-widget-row">
								<span className="meal-widget-name">{item.food_name}</span>
								<span className="meal-widget-kcal">
									{Math.round(item.kcal)} kcal
								</span>
							</div>
						))}
					</div>
				))
			)}
			<div className="meal-widget-actions">
				<button
					className="btn btn-outline btn-sm"
					style={{ flex: 1, fontSize: 11, marginTop: 6, marginBottom: 0 }}
					onClick={onSync}
					disabled={isSyncing}
				>
					<RefreshCw
						size={11}
						strokeWidth={2}
						style={
							isSyncing
								? { animation: "spin 0.65s linear infinite", marginRight: 4 }
								: { marginRight: 4 }
						}
					/>
					{isSyncing ? "同期中…" : "FatSecret 同期"}
				</button>
				<Link
					to="/meals"
					className="btn btn-outline btn-sm"
					style={{
						fontSize: 11,
						textDecoration: "none",
						marginTop: 6,
						marginBottom: 0,
					}}
				>
					食事記録へ
				</Link>
			</div>
		</div>
	);
}

// ── 今日の予定（フルワイド固定） ─────────────────────────────
function ScheduleCard({ calendarData, dateStr }) {
	const connected = calendarData?.connected;
	const events = calendarData?.events ?? [];

	// 未連携: 連携 CTA カードを表示
	if (!connected) {
		return (
			<div className="card">
				<div
					className="card-title"
					style={{ display: "flex", alignItems: "center", gap: 5 }}
				>
					<CalendarClock size={12} strokeWidth={2} />
					今日の予定
				</div>
				<div className="widget-not-connected" style={{ minHeight: 100 }}>
					<Link2Off
						size={22}
						strokeWidth={1.5}
						className="widget-not-connected-icon"
					/>
					<div className="widget-not-connected-msg">
						Googleカレンダー未連携
						<br />
						<span style={{ fontSize: 11, color: "var(--text-2)" }}>
							連携すると本日の予定を表示できます
						</span>
					</div>
					<Link
						to="/me"
						className="btn btn-primary btn-sm widget-not-connected-cta"
					>
						連携設定へ →
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="card">
			<div
				className="card-title"
				style={{ display: "flex", alignItems: "center", gap: 5 }}
			>
				<CalendarClock size={12} strokeWidth={2} />
				今日の予定
				<span
					style={{
						marginLeft: "auto",
						fontSize: 11,
						color: "var(--text-2)",
						fontWeight: 400,
					}}
				>
					{events.length} 件
				</span>
			</div>
			{events.length === 0 ? (
				<div style={{ fontSize: 13, color: "var(--text-2)", padding: "8px 0" }}>
					予定なし
				</div>
			) : (
				events.map((ev, i) => {
					const timeStr = ev.all_day
						? "終日"
						: ev.start
							? new Date(ev.start).toLocaleTimeString("ja-JP", {
									hour: "2-digit",
									minute: "2-digit",
								})
							: "";
					return (
						<div key={i} className="list-item">
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									flex: 1,
									minWidth: 0,
								}}
							>
								<Calendar
									size={13}
									strokeWidth={1.5}
									style={{ color: "var(--text-2)", flexShrink: 0 }}
								/>
								<span
									style={{
										fontSize: 13,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
								>
									{ev.summary}
								</span>
							</div>
							{timeStr && (
								<span
									style={{
										fontSize: 12,
										color: "var(--text-2)",
										flexShrink: 0,
										marginLeft: 8,
									}}
								>
									{timeStr}
								</span>
							)}
						</div>
					);
				})
			)}
		</div>
	);
}

// ── ウィジェット設定パネル ────────────────────────────────────
function SettingsPanel({ vis, onToggle }) {
	return (
		<div className="dash-settings">
			<div
				style={{
					fontSize: 12,
					fontWeight: 700,
					color: "var(--text-2)",
					marginBottom: 8,
					textTransform: "uppercase",
					letterSpacing: "0.05em",
				}}
			>
				ウィジェット表示設定
			</div>
			{WIDGET_IDS.map((id) => {
				const { label } = WIDGET_META[id];
				return (
					<div key={id} className="dash-settings-row">
						<span style={{ fontWeight: 500 }}>{label}</span>
						<div className="dash-settings-toggles">
							{[
								["value", "数値"],
								["graph", "グラフ"],
							].map(([key, lbl]) => (
								<button
									key={key}
									className={`btn btn-sm${vis[id][key] ? " btn-primary" : " btn-outline"}`}
									onClick={() => onToggle(id, key)}
									style={{ minWidth: 52 }}
								>
									{lbl}
								</button>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

// ── メインページ ─────────────────────────────────────────────
export default function DashboardPage() {
	const qc = useQueryClient();

	// 日付
	const [dateStr, setDateStr] = useState(todayStr);
	const isToday = isTodayJst(dateStr);

	// ウィジェット設定（localStorage 永続化）
	const [order, setOrder] = useState(() => lsGet("db-order", DEFAULT_ORDER));
	const [vis, setVis] = useState(() => lsGet("db-vis", DEFAULT_VIS));
	const [periods, setPeriods] = useState(() =>
		lsGet("db-periods", DEFAULT_PERIODS),
	);
	const [showSettings, setShowSettings] = useState(false);

	const toggleVis = (id, key) =>
		setVis((prev) => {
			const next = { ...prev, [id]: { ...prev[id], [key]: !prev[id][key] } };
			lsSet("db-vis", next);
			return next;
		});
	const setPeriod = (id, p) =>
		setPeriods((prev) => {
			const next = { ...prev, [id]: p };
			lsSet("db-periods", next);
			return next;
		});

	// データ取得
	const { data: summary, isLoading } = useQuery({
		queryKey: ["dashboard", dateStr],
		queryFn: () => dashboardApi.today(dateStr).then((r) => r.data),
	});

	// 体重履歴：選択中の期間に応じて日数を調整
	const weightDays = periods.weight === "30d" ? 30 : 7;
	const { data: weightHistory = [] } = useQuery({
		queryKey: ["weight-history", weightDays],
		queryFn: () => bodyApi.weightHistory(weightDays).then((r) => r.data),
	});

	const bulkSyncMutation = useMutation({
		mutationFn: () => bodyApi.syncWeightHistory(weightDays),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["weight-history"] }),
	});

	// 睡眠・歩数履歴：ウィジェットごとに独立したクエリ
	const sleepDays = periods.sleep === "30d" ? 30 : 7;
	const stepsDays = periods.steps === "30d" ? 30 : 7;

	const { data: sleepHistory = [] } = useQuery({
		queryKey: ["activity-history", sleepDays],
		queryFn: () => bodyApi.activityHistory(sleepDays).then((r) => r.data),
	});

	const { data: stepsHistory = [] } = useQuery({
		queryKey: ["activity-history", stepsDays],
		queryFn: () => bodyApi.activityHistory(stepsDays).then((r) => r.data),
		enabled: periods.steps !== "1d",
	});

	// 同期はより多い日数に合わせて実行
	const sleepBulkSyncMutation = useMutation({
		mutationFn: () =>
			bodyApi.syncActivityHistory(Math.max(sleepDays, stepsDays)),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["activity-history"] }),
	});

	// 食事記録
	const { data: mealLogs = [] } = useQuery({
		queryKey: ["meals", dateStr],
		queryFn: () => mealsApi.list(dateStr).then((r) => r.data),
	});

	// 昨日・7日平均カロリー（食事記録ウィジェットのサブ表示用）
	const { data: dailyKcal = [] } = useQuery({
		queryKey: ["meals-daily-kcal", dateStr],
		queryFn: () => mealsApi.dailyKcal(dateStr, 8),
		staleTime: 5 * 60 * 1000,
	});

	// PFC・カロリー履歴（calories / pfc ウィジェットの 7d / 30d 用 + 前日値表示）
	const calPeriod = periods.calories ?? "1d";
	const pfcPeriod = periods.pfc ?? "1d";
	const nutritionDays = (() => {
		const max = Math.max(
			calPeriod === "30d" ? 30 : calPeriod === "7d" ? 7 : 2,
			pfcPeriod === "30d" ? 30 : pfcPeriod === "7d" ? 7 : 2,
		);
		return max + 1; // +1 for safety; minimum 3 to always include yesterday
	})();
	const { data: dailyNutrition = [] } = useQuery({
		queryKey: ["meals-daily-nutrition", dateStr, nutritionDays],
		queryFn: () => mealsApi.dailyNutrition(dateStr, nutritionDays),
		staleTime: 5 * 60 * 1000,
	});
	const yesterdayNutrition = (() => {
		const yStr = offsetDate(dateStr, -1);
		return dailyNutrition.find((r) => r.date === yStr) ?? null;
	})();
	const yesterdayKcal = (() => {
		const yStr = offsetDate(dateStr, -1);
		const rec = dailyKcal.find((r) => r.date === yStr);
		return rec ? rec.total_kcal : null;
	})();
	const avgKcal7 = (() => {
		const vals = dailyKcal.slice(0, 7).map((r) => r.total_kcal).filter((v) => v > 0);
		if (!vals.length) return null;
		return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
	})();

	const syncFatSecretMutation = useMutation({
		mutationFn: () => mealsApi.syncFatSecret(dateStr),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["meals", dateStr] });
			qc.invalidateQueries({ queryKey: ["meals-daily-kcal", dateStr] });
			qc.invalidateQueries({ queryKey: ["dashboard", dateStr] });
		},
	});

	// カレンダー予定（個別クエリ）
	const { data: calendarData } = useQuery({
		queryKey: ["dashboard-calendar", dateStr],
		queryFn: () => dashboardApi.calendar(dateStr),
		staleTime: 5 * 60 * 1000,
	});

	// 一括同期：すべてのデータソースをまとめて更新
	const syncMutation = useMutation({
		mutationFn: async () => {
			await bodyApi.sync(dateStr);
			await Promise.allSettled([
				bodyApi.syncWeightHistory(weightDays),
				bodyApi.syncActivityHistory(Math.max(sleepDays, stepsDays)),
				mealsApi.syncFatSecret(dateStr),
			]);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard"] });
			qc.invalidateQueries({ queryKey: ["weight-history"] });
			qc.invalidateQueries({ queryKey: ["activity-history"] });
			qc.invalidateQueries({ queryKey: ["meals", dateStr] });
			qc.invalidateQueries({ queryKey: ["dashboard-calendar", dateStr] });
		},
	});

	// 派生値
	const nut = summary?.nutrition || {};
	const goals = summary?.goals || {};

	const latestW = weightHistory.at(-1)?.weight ?? summary?.weight;
	const oldestW = weightHistory[0]?.weight;
	const wDelta =
		latestW && oldestW && latestW !== oldestW
			? (latestW - oldestW).toFixed(1)
			: null;
	const wPct =
		goals.target_weight && latestW && oldestW
			? Math.max(
					0,
					Math.round(
						100 -
							(Math.abs(latestW - goals.target_weight) /
								Math.abs((oldestW || latestW) - goals.target_weight)) *
								100,
					),
				)
			: null;

	const calIntake = nut.kcal ? Math.round(nut.kcal) : null;
	const calTarget = goals.target_kcal || null;
	const calPct =
		calIntake && calTarget ? Math.round((calIntake / calTarget) * 100) : null;
	const calRemaining =
		calIntake != null && calTarget != null ? calTarget - calIntake : null;

	// DnD（長押し 300ms）
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { delay: 300, tolerance: 5 },
		}),
	);
	const handleDragEnd = ({ active, over }) => {
		if (!over || active.id === over.id) return;
		setOrder((prev) => {
			const next = arrayMove(
				prev,
				prev.indexOf(active.id),
				prev.indexOf(over.id),
			);
			lsSet("db-order", next);
			return next;
		});
	};

	// ウィジェット定義
	const widgetDef = {
		weight: {
			support: ["7d", "30d"], // 1日は体重トレンドとして意味がないため除外
			value: <WeightValue latest={latestW} delta={wDelta} pct={wPct} />,
			graph: (
				<WeightGraph
					history={weightHistory}
					onBulkSync={() => bulkSyncMutation.mutate()}
					isSyncing={bulkSyncMutation.isPending}
				/>
			),
		},
		calories: {
			support: ["1d", "7d", "30d"],
			value: (
				<CaloriesValue
					intake={calIntake}
					target={calTarget}
					pct={calPct}
					remaining={calRemaining}
					yesterdayKcal={yesterdayNutrition?.total_kcal ?? null}
					avgKcal7={avgKcal7}
				/>
			),
			graph: (
				<CaloriesGraph
					intake={calIntake}
					target={calTarget}
					history={dailyNutrition}
					period={calPeriod}
				/>
			),
		},
		pfc: {
			support: ["1d", "7d", "30d"],
			value: (
				<PFCValue
					p={nut.protein_g}
					f={nut.fat_g}
					c={nut.carb_g}
					yp={yesterdayNutrition?.protein_g ?? null}
					yf={yesterdayNutrition?.fat_g ?? null}
					yc={yesterdayNutrition?.carb_g ?? null}
				/>
			),
			graph: (
				<PFCGraph
					p={nut.protein_g}
					f={nut.fat_g}
					c={nut.carb_g}
					history={dailyNutrition}
					period={pfcPeriod}
				/>
			),
		},
		steps: {
			support: ["1d", "7d", "30d"],
			value: <StepsValue steps={summary?.steps} />,
			graph: (
				<StepsGraph
					steps={summary?.steps}
					history={stepsHistory}
					period={periods.steps ?? "1d"}
					onBulkSync={() => sleepBulkSyncMutation.mutate()}
					isSyncing={sleepBulkSyncMutation.isPending}
				/>
			),
		},
		sleep: {
			support: ["7d", "30d"],
			value: (
				<SleepValue hours={summary?.sleep_hours} score={summary?.sleep_score} />
			),
			graph: (
				<SleepGraph
					history={sleepHistory}
					onBulkSync={() => sleepBulkSyncMutation.mutate()}
					isSyncing={sleepBulkSyncMutation.isPending}
				/>
			),
		},
		meals: {
			support: ["1d"],
			value: <MealsValue logs={mealLogs} yesterdayKcal={yesterdayKcal} />,
			graph: (
				<MealsList
					logs={mealLogs}
					onSync={() => syncFatSecretMutation.mutate()}
					isSyncing={syncFatSecretMutation.isPending}
				/>
			),
		},
	};

	return (
		<div>
			{/* ヘッダー */}
			<div className="page-header">
				<h1 className="page-title">ダッシュボード</h1>
				<div className="page-header-actions">
					<button
						className={`btn btn-outline btn-sm page-action-toggle${showSettings ? " is-active" : ""}`}
						onClick={() => setShowSettings((v) => !v)}
						title="ウィジェット設定"
					>
						<Settings2 size={13} strokeWidth={1.8} />
						設定
					</button>
					<button
						className="btn btn-primary btn-sm"
						onClick={() => syncMutation.mutate()}
						disabled={syncMutation.isPending}
						title="体重・歩数・睡眠・食事をまとめて同期"
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
						{syncMutation.isPending ? "同期中…" : "一括同期"}
					</button>
				</div>
			</div>

			{/* ウィジェット設定パネル */}
			{showSettings && <SettingsPanel vis={vis} onToggle={toggleVis} />}

			{/* 日付ナビゲーション */}
			<div className="dash-date-nav">
				<button
					className="btn-ghost"
					style={{ padding: "6px 10px", borderRadius: 8 }}
					onClick={() => setDateStr((prev) => offsetDate(prev, -1))}
				>
					<ChevronLeft size={18} strokeWidth={1.8} />
				</button>

				{/* 日付ラベル：クリックで今日に戻る */}
				<button
					className="btn-ghost"
					style={{
						padding: "5px 14px",
						borderRadius: 20,
						fontSize: 13,
						fontWeight: 600,
						minWidth: 140,
						textAlign: "center",
						color: isToday ? "var(--brand)" : "var(--text)",
					}}
					onClick={() => setDateStr(todayStr())}
					title="クリックで今日に戻る"
				>
					{isToday ? "今日 · " : ""}
					{fmtDate(dateStr)}
				</button>

				<button
					className="btn-ghost"
					style={{ padding: "6px 10px", borderRadius: 8 }}
					onClick={() => setDateStr((prev) => offsetDate(prev, 1))}
				>
					<ChevronRight size={18} strokeWidth={1.8} />
				</button>
			</div>

			{/* 未連携バナー */}
			{!isLoading && summary?.connected_services?.length === 0 && (
				<div className="alert alert-warn">
					外部サービスが未連携です。
					<Link to="/me" style={{ fontWeight: 700, marginLeft: 4 }}>
						マイページ → 設定
					</Link>
					から連携してください。
				</div>
			)}

			{isLoading ? (
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						padding: "var(--sp-10)",
					}}
				>
					<div className="spinner" />
				</div>
			) : (
				<>
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext items={order} strategy={rectSortingStrategy}>
							<div className="widget-grid">
								{order.map((id) => {
									const def = widgetDef[id];
									if (!def) return null;
									const v = vis[id] ?? { value: true, graph: false };
									// 何も表示しない設定の場合でも最低限シェルは表示
									return (
										<WidgetShell
											key={id}
											id={id}
											vis={v}
											period={periods[id] ?? "7d"}
											onPeriodChange={(p) => setPeriod(id, p)}
											valueContent={def.value}
											graphContent={def.graph}
											graphSupport={def.support}
											span={
												v.graph
													? id === "meals"
														? "span-2"
														: id === "weight" ||
															  id === "sleep" ||
															  (id === "steps" && periods.steps !== "1d")
															? "span-2"
															: null
													: null
											}
											needsConnection={
												!isServiceConnected(
													WIDGET_REQUIREMENTS[id],
													summary?.connected_services,
												)
											}
											requirementLabel={WIDGET_REQUIREMENTS[id]?.label}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>

					<ScheduleCard calendarData={calendarData} dateStr={dateStr} />

					<Link
						to="/plan"
						className="btn btn-secondary btn-full"
						style={{ marginTop: "var(--sp-2)", textDecoration: "none" }}
					>
						今週の献立を確認する
					</Link>
				</>
			)}
		</div>
	);
}
