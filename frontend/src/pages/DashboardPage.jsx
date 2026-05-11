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
import { useEffect, useRef, useState } from "react";
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
import { bodyApi, dashboardApi, mealsApi, settingsApi } from "../services/api";
import {
	addJstDays,
	formatJstDate,
	isTodayJst,
	startOfJstMonth,
	startOfJstWeek,
	toJstDateString,
} from "../utils/date";

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

function lsGet(key, defaultValue) {
	try {
		return JSON.parse(localStorage.getItem(key)) ?? defaultValue;
	} catch {
		return defaultValue;
	}
}

function lsSet(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		return undefined;
	}
}

const WIDGET_IDS = ["weight", "calories", "pfc", "steps", "sleep", "meals"];

function normalizeWidgetOrder(order = []) {
	const valid = order.filter((id) => WIDGET_IDS.includes(id));
	return [...valid, ...WIDGET_IDS.filter((id) => !valid.includes(id))];
}

const WIDGET_META = {
	weight: { label: "体重", Icon: Scale },
	calories: { label: "カロリー", Icon: Flame },
	pfc: { label: "PFC", Icon: Layers },
	steps: { label: "歩数", Icon: Footprints },
	sleep: { label: "睡眠", Icon: Moon },
	meals: { label: "食事記録", Icon: UtensilsCrossed },
};

const WIDGET_REQUIREMENTS = {
	weight: {
		services: ["fitbit", "healthplanet"],
		any: true,
		label: "Fitbit / HealthPlanet",
	},
	steps: { services: ["fitbit"], label: "Fitbit" },
	sleep: { services: ["fitbit"], label: "Fitbit" },
};

function isServiceConnected(requirement, connectedServices = []) {
	if (!requirement) return true;
	return requirement.any
		? requirement.services.some((service) =>
				connectedServices.includes(service),
			)
		: requirement.services.every((service) =>
				connectedServices.includes(service),
			);
}

const DEFAULT_ORDER = [...WIDGET_IDS];
const DEFAULT_VIS = Object.fromEntries(
	WIDGET_IDS.map((id) => [id, { value: true, graph: false }]),
);
const WIDGET_PERIOD_SUPPORTS = {
	weight: ["7d", "30d"],
	calories: ["1d", "7d", "30d"],
	pfc: ["1d", "7d", "30d"],
	steps: ["1d", "7d", "30d"],
	sleep: ["7d", "30d"],
	meals: ["1d"],
};
const DEFAULT_PERIODS = Object.fromEntries(
	Object.entries(WIDGET_PERIOD_SUPPORTS).map(([id, supported]) => [
		id,
		supported[0] ?? "1d",
	]),
);
const DEFAULT_WIDGET_DATES = Object.fromEntries(
	WIDGET_IDS.map((id) => [id, todayStr()]),
);

const BRAND = "#16a34a";
const CALORIE_BURN = "#f97316";
const CALORIE_BALANCE = "#0f766e";
const CALORIE_DEFICIT = "#15803d";
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

function getWidgetStepDays(period, supported = []) {
	if (supported.length <= 1) return 1;
	if (period === "30d") return 30;
	if (period === "7d") return 7;
	return 1;
}

function getWidgetRangeStart(dateStr, period, supported = []) {
	if (period === "7d" && supported.includes("7d")) {
		return startOfJstWeek(dateStr);
	}
	if (period === "30d" && supported.includes("30d")) {
		return startOfJstMonth(dateStr);
	}
	return dateStr;
}

function getWidgetRangeEnd(dateStr, period, supported = []) {
	const start = getWidgetRangeStart(dateStr, period, supported);
	return offsetDate(start, getWidgetStepDays(period, supported) - 1);
}

function getWidgetHistoryBaseDate(dateStr, period, supported = []) {
	const start = getWidgetRangeStart(dateStr, period, supported);
	return offsetDate(start, getWidgetStepDays(period, supported));
}

function getWidgetRangeLabel(dateStr, period, supported = []) {
	const start = getWidgetRangeStart(dateStr, period, supported);
	const spanDays = getWidgetStepDays(period, supported);
	if (spanDays === 1) return fmtDate(start);
	const end = offsetDate(start, spanDays - 1);
	return `${fmtShort(start)} - ${fmtShort(end)}`;
}

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

function getPeriodLabel(period) {
	return period === "30d" ? "30日" : period === "7d" ? "7日" : "1日";
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

function InlineProgress({ label = "更新中" }) {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				fontSize: 11,
				color: "var(--text-2)",
			}}
		>
			<span
				className="spinner"
				style={{ width: 12, height: 12, borderWidth: 2, flexShrink: 0 }}
			/>
			{label}
		</span>
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
	dateLabel,
	onDatePrev,
	onDateNext,
	onDateToday,
	valueContent,
	graphContent,
	graphSupport,
	span,
	needsConnection,
	requirementLabel,
	isBusy,
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
	const spanClass =
		span === "full" ? " full" : span === "span-2" ? " span-2" : "";
	const showPeriodPills = vis.graph && graphSupport.length > 1;
	const controls = (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				justifyContent: "space-between",
				marginBottom: vis.graph ? 8 : 0,
			}}
		>
			<div>
				{showPeriodPills ? (
					<PeriodPills
						period={period}
						onChange={onPeriodChange}
						supported={graphSupport}
					/>
				) : null}
			</div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					marginLeft: "auto",
				}}
			>
				<span
					style={{ fontSize: 11, color: "var(--text-2)", whiteSpace: "nowrap" }}
				>
					{dateLabel}
				</span>
				<button
					className="btn-ghost"
					style={{ padding: "4px 6px", borderRadius: 8 }}
					onClick={onDatePrev}
					title="前へ"
				>
					<ChevronLeft size={15} strokeWidth={1.8} />
				</button>
				<button
					className="btn-ghost"
					style={{ padding: "4px 8px", borderRadius: 8, fontSize: 11 }}
					onClick={onDateToday}
				>
					今日
				</button>
				<button
					className="btn-ghost"
					style={{ padding: "4px 6px", borderRadius: 8 }}
					onClick={onDateNext}
					title="次へ"
				>
					<ChevronRight size={15} strokeWidth={1.8} />
				</button>
			</div>
		</div>
	);

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
			<div className="widget-header">
				<span className="widget-label">
					<Icon size={12} strokeWidth={1.8} />
					{label}
				</span>
				{isBusy && <InlineProgress />}
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
					{vis.value && <div>{valueContent}</div>}
					{(showBoth || !vis.graph) && <div className="widget-divider" />}
					{controls}
					{vis.graph && <div>{graphContent}</div>}
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
					<span
						style={{ color: parseFloat(delta) < 0 ? "#16a34a" : "#dc2626" }}
					>
						{parseFloat(delta) < 0 ? "▼" : "▲"} {Math.abs(delta)}kg
					</span>
					<span style={{ color: "var(--text-2)", fontSize: 10, marginLeft: 4 }}>
						（7日比）
					</span>
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
function CaloriesValue({
	intake,
	burned,
	balance,
	period = "1d",
	target,
	pct,
	remaining,
	yesterdayKcal,
	avgKcal7,
}) {
	const fill = `progress-fill${pct > 100 ? " over" : pct > 75 ? " warn" : ""}`;
	const isAggregatePeriod = period !== "1d";
	const hasComparison =
		yesterdayKcal != null ||
		avgKcal7 != null ||
		target != null ||
		burned != null ||
		balance != null ||
		(isAggregatePeriod && intake != null);
	const balanceColor =
		balance == null
			? "var(--text-2)"
			: balance <= 0
				? CALORIE_BALANCE
				: "#dc2626";
	const periodLabel = getPeriodLabel(period);
	const showDailyComparison = period === "1d";
	const showBalanceNote = burned != null || balance != null;
	const primaryValue = isAggregatePeriod ? balance : intake;
	const primaryColor = isAggregatePeriod ? balanceColor : "var(--text)";
	const primaryLabel = isAggregatePeriod
		? `${periodLabel}総収支`
		: "摂取カロリー";
	return (
		<>
			<div
				style={{
					display: "flex",
					alignItems: "flex-end",
					gap: 10,
					marginTop: 2,
				}}
			>
				<div style={{ lineHeight: 1.1 }}>
					<div
						style={{
							fontSize: 11,
							color: "var(--text-2)",
							marginBottom: 4,
						}}
					>
						{primaryLabel}
					</div>
					<span className="widget-value" style={{ color: primaryColor }}>
						{primaryValue != null
							? `${primaryValue > 0 && isAggregatePeriod ? "+" : ""}${primaryValue.toLocaleString()}`
							: "—"}
					</span>
					<span className="widget-unit">kcal</span>
				</div>
				{hasComparison && (
					<div
						style={{
							fontSize: 11,
							color: "var(--text-2)",
							lineHeight: 1.7,
							paddingBottom: 2,
						}}
					>
						{isAggregatePeriod && intake != null && (
							<div>
								{periodLabel}総摂取{" "}
								<span style={{ color: BRAND, fontWeight: 700 }}>
									{intake.toLocaleString()}
								</span>
							</div>
						)}
						{showDailyComparison && yesterdayKcal != null && (
							<div>
								昨日{" "}
								<span style={{ color: "var(--orange-text)", fontWeight: 700 }}>
									{yesterdayKcal.toLocaleString()}
								</span>
							</div>
						)}
						{showDailyComparison && avgKcal7 != null && (
							<div>
								7日平均{" "}
								<span style={{ color: "var(--blue-text)", fontWeight: 700 }}>
									{avgKcal7.toLocaleString()}
								</span>
							</div>
						)}
						{burned != null && (
							<div>
								総消費{" "}
								<span style={{ color: CALORIE_BURN, fontWeight: 700 }}>
									{burned.toLocaleString()}
								</span>
							</div>
						)}
						{!isAggregatePeriod && balance != null && (
							<div>
								{periodLabel}総収支{" "}
								<span style={{ color: balanceColor, fontWeight: 700 }}>
									{balance > 0 ? "+" : ""}
									{balance.toLocaleString()}
								</span>
							</div>
						)}
						{target != null && (
							<div>
								{isAggregatePeriod ? "期間目標" : "目標"}{" "}
								<span style={{ color: "var(--text)", fontWeight: 700 }}>
									{target.toLocaleString()}
								</span>
							</div>
						)}
					</div>
				)}
			</div>
			{!isAggregatePeriod && remaining != null ? (
				<div className="widget-sub">残り {remaining.toLocaleString()}</div>
			) : (
				!hasComparison &&
				target && (
					<div className="widget-sub">目標 {target.toLocaleString()}</div>
				)
			)}
			{showBalanceNote && (
				<div className="widget-sub" style={{ fontSize: 10 }}>
					{periodLabel}総収支 = 期間内の摂取合計 - 総消費合計
				</div>
			)}
			{pct != null && (
				<div className="progress-bar" style={{ marginTop: 6 }}>
					<div className={fill} style={{ width: `${Math.min(pct, 100)}%` }} />
				</div>
			)}
		</>
	);
}

function getCalorieAxisConfig(chartData, keys = [], extras = []) {
	const values = chartData
		.flatMap((entry) => keys.map((key) => entry[key]))
		.filter((value) => Number.isFinite(value));
	values.push(...extras.filter((value) => Number.isFinite(value)));

	const maxValue = Math.max(...values, 0);
	const step =
		maxValue <= 1200
			? 200
			: maxValue <= 2400
				? 250
				: maxValue <= 4000
					? 500
					: 1000;
	const top = Math.max(step, Math.ceil(maxValue / step) * step);
	const ticks = [];
	for (let value = 0; value <= top; value += step) ticks.push(value);
	for (const value of extras) {
		if (Number.isFinite(value) && !ticks.includes(value)) ticks.push(value);
	}

	return {
		domain: [0, top],
		ticks: ticks.sort((left, right) => left - right),
	};
}

function getBalanceAxisConfig(chartData) {
	const values = chartData
		.map((entry) => entry.balance)
		.filter((value) => Number.isFinite(value));
	const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 200);
	const step =
		maxAbs <= 600 ? 100 : maxAbs <= 1500 ? 200 : maxAbs <= 3000 ? 500 : 1000;
	const top = Math.max(step, Math.ceil(maxAbs / step) * step);
	const ticks = [];
	for (let value = -top; value <= top; value += step) ticks.push(value);
	return {
		domain: [-top, top],
		ticks,
	};
}

function CaloriesGraph({
	history = [],
	target,
	period = "1d",
	totalBalance = null,
}) {
	if (!history.length) return <EmptyGraph />;
	const chartData = history.reduce((entries, entry) => {
		const balance = Number.isFinite(entry.balance) ? entry.balance : null;
		const deficit =
			Number.isFinite(balance) && balance < 0 ? Math.abs(balance) : 0;
		const previousCumulative = entries.at(-1)?.cumulativeDeficit ?? 0;
		return [
			...entries,
			{
				date:
					period === "1d"
						? fmtShort(entry.date)
						: `${parseInt(entry.date.split("-")[1], 10)}/${parseInt(entry.date.split("-")[2], 10)}`,
				intake: Number.isFinite(entry.total_kcal) ? entry.total_kcal : 0,
				burned: Number.isFinite(entry.calories_out) ? entry.calories_out : null,
				balance,
				deficit,
				cumulativeDeficit: Number.isFinite(balance)
					? previousCumulative + deficit
					: null,
			},
		];
	}, []);
	const hasBurnedData = chartData.some((entry) =>
		Number.isFinite(entry.burned),
	);
	const hasBalanceData = chartData.some((entry) =>
		Number.isFinite(entry.balance),
	);
	const hasCompleteBalanceData =
		chartData.length > 0 &&
		chartData.every((entry) => Number.isFinite(entry.balance));
	const { domain, ticks } = getCalorieAxisConfig(
		chartData,
		["intake", "burned"],
		[target],
	);
	const balanceAxis = getBalanceAxisConfig(chartData);
	const deficitAxis = getCalorieAxisConfig(chartData, ["cumulativeDeficit"]);
	const periodLabel = getPeriodLabel(period);
	const showDeficitTrend = period !== "1d";
	const totalDeficit = hasCompleteBalanceData
		? (chartData.at(-1)?.cumulativeDeficit ?? 0)
		: null;
	const totalBalanceColor =
		totalBalance == null
			? "var(--text-2)"
			: totalBalance <= 0
				? CALORIE_BALANCE
				: "#dc2626";

	return (
		<div style={{ display: "grid", gap: 10 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 12,
					flexWrap: "wrap",
				}}
			>
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: 12,
						fontSize: 11,
						color: "var(--text-2)",
					}}
				>
					<span>
						<Dot color={BRAND} />
						摂取カロリー
					</span>
					<span>
						<Dot color={CALORIE_BURN} />
						総消費カロリー
					</span>
					{!hasBurnedData && <span>総消費データは未同期です</span>}
				</div>
				<div style={{ fontSize: 11, color: "var(--text-2)" }}>
					{periodLabel}総収支{" "}
					<span style={{ color: totalBalanceColor, fontWeight: 700 }}>
						{totalBalance == null
							? "—"
							: `${totalBalance > 0 ? "+" : ""}${totalBalance.toLocaleString()} kcal`}
					</span>
				</div>
			</div>
			<div
				style={{
					fontSize: 11,
					color: "var(--text-2)",
					display: "flex",
					gap: 12,
					flexWrap: "wrap",
				}}
			>
				<span>
					<Dot color={CALORIE_BALANCE} />
					収支（摂取 - 総消費）
				</span>
				{!hasBalanceData && <span>収支は総消費データ取得後に表示されます</span>}
			</div>
			<ResponsiveContainer width="100%" height={196}>
				<ComposedChart
					data={chartData}
					margin={{ top: 6, right: 8, left: -20, bottom: 0 }}
				>
					<XAxis
						dataKey="date"
						tick={{ fontSize: 9, fill: "var(--text-3)" }}
						interval="preserveStartEnd"
						axisLine={false}
						tickLine={false}
					/>
					<YAxis
						yAxisId="bars"
						domain={domain}
						ticks={ticks}
						allowDecimals={false}
						tick={{ fontSize: 9, fill: "var(--text-3)" }}
						axisLine={false}
						tickLine={false}
					/>
					<YAxis
						yAxisId="balance"
						orientation="right"
						domain={balanceAxis.domain}
						ticks={balanceAxis.ticks}
						allowDecimals={false}
						tick={{ fontSize: 9, fill: CALORIE_BALANCE }}
						axisLine={false}
						tickLine={false}
						hide={!hasBalanceData}
					/>
					<Tooltip
						contentStyle={tipStyle}
						formatter={(value, name) => {
							const label =
								name === "intake"
									? "摂取"
									: name === "burned"
										? "総消費"
										: "収支";
							return [`${Number(value).toLocaleString()} kcal`, label];
						}}
					/>
					{target && (
						<ReferenceLine
							yAxisId="bars"
							y={target}
							stroke="#94a3b8"
							strokeDasharray="3 3"
							label={{ value: "目標", fontSize: 9, fill: "#94a3b8" }}
						/>
					)}
					<Bar
						yAxisId="bars"
						dataKey="intake"
						name="intake"
						fill={BRAND}
						radius={[4, 4, 0, 0]}
					/>
					<Bar
						yAxisId="bars"
						dataKey="burned"
						name="burned"
						fill={CALORIE_BURN}
						radius={[4, 4, 0, 0]}
					/>
					{hasBalanceData && (
						<>
							<ReferenceLine
								yAxisId="balance"
								y={0}
								stroke="#cbd5e1"
								strokeDasharray="3 3"
							/>
							<Line
								yAxisId="balance"
								type="monotone"
								dataKey="balance"
								name="balance"
								stroke={CALORIE_BALANCE}
								strokeWidth={2}
								dot={{ r: 3, fill: CALORIE_BALANCE, strokeWidth: 0 }}
								activeDot={{ r: 4 }}
								connectNulls={false}
							/>
						</>
					)}
				</ComposedChart>
			</ResponsiveContainer>
			{showDeficitTrend && (
				<div style={{ display: "grid", gap: 8 }}>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 12,
							flexWrap: "wrap",
							fontSize: 11,
							color: "var(--text-2)",
						}}
					>
						<span>
							<Dot color={CALORIE_DEFICIT} />
							累積マイナス収支
						</span>
						<span>
							{periodLabel}で削れたカロリー{" "}
							<span style={{ color: CALORIE_DEFICIT, fontWeight: 700 }}>
								{totalDeficit == null
									? "—"
									: `${totalDeficit.toLocaleString()} kcal`}
							</span>
						</span>
					</div>
					{hasCompleteBalanceData ? (
						<ResponsiveContainer width="100%" height={96}>
							<AreaChart
								data={chartData}
								margin={{ top: 6, right: 8, left: -20, bottom: 0 }}
							>
								<XAxis
									dataKey="date"
									tick={{ fontSize: 9, fill: "var(--text-3)" }}
									interval="preserveStartEnd"
									axisLine={false}
									tickLine={false}
								/>
								<YAxis
									domain={deficitAxis.domain}
									ticks={deficitAxis.ticks}
									allowDecimals={false}
									tick={{ fontSize: 9, fill: CALORIE_DEFICIT }}
									axisLine={false}
									tickLine={false}
								/>
								<Tooltip
									contentStyle={tipStyle}
									formatter={(value) => [
										`${Number(value).toLocaleString()} kcal`,
										"累積マイナス収支",
									]}
								/>
								<Area
									type="monotone"
									dataKey="cumulativeDeficit"
									stroke={CALORIE_DEFICIT}
									strokeWidth={2}
									fill={CALORIE_DEFICIT}
									fillOpacity={0.16}
									dot={{ r: 2.5, fill: CALORIE_DEFICIT, strokeWidth: 0 }}
									activeDot={{ r: 4 }}
								/>
							</AreaChart>
						</ResponsiveContainer>
					) : (
						<div style={{ fontSize: 11, color: "var(--text-2)" }}>
							累積マイナス収支は総消費データ取得後に表示されます
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── PFC ───────────────────────────────────────────────────────
function PFCValue({ p, f, c, tp, tf, tc }) {
	const pfcRow = (color, label, val, target) => {
		const delta = val != null && target != null ? val - target : null;
		return (
			<div
				style={{
					display: "flex",
					justifyContent: "center",
					gap: 6,
					alignItems: "baseline",
				}}
			>
				<span>
					<span style={{ color, fontWeight: 700 }}>{label}</span>{" "}
					{val != null ? `${val.toFixed(1)}g` : "—"}
				</span>
				{delta != null && (
					<span
						style={{
							fontSize: 10,
							fontWeight: 600,
							color: delta === 0 ? "var(--text-2)" : "var(--text)",
						}}
					>
						差 {delta >= 0 ? "+" : ""}
						{delta.toFixed(1)}g
					</span>
				)}
				{target != null && (
					<span style={{ fontSize: 10, color: "var(--text-2)" }}>
						(推奨 {target.toFixed(0)}g)
					</span>
				)}
			</div>
		);
	};
	return (
		<div
			style={{ marginTop: 4, fontSize: 12, lineHeight: 2, textAlign: "center" }}
		>
			{pfcRow(PFC_COLORS[0], "P", p, tp)}
			{pfcRow(PFC_COLORS[1], "F", f, tf)}
			{pfcRow(PFC_COLORS[2], "C", c, tc)}
		</div>
	);
}

// 棒の上端に区切り線を描くカスタムシェイプ（モジュールスコープで定義して参照を固定）
function PBarShape({ x, y, width, height, fill }) {
	if (!width || !height) return null;
	return (
		<g>
			<rect x={x} y={y} width={width} height={height} fill={fill} />
			<line
				x1={x}
				y1={y}
				x2={x + width}
				y2={y}
				stroke={PFC_COLORS[0]}
				strokeWidth={2}
			/>
		</g>
	);
}
function FBarShape({ x, y, width, height, fill }) {
	if (!width || !height) return null;
	return (
		<g>
			<rect x={x} y={y} width={width} height={height} fill={fill} />
			<line
				x1={x}
				y1={y}
				x2={x + width}
				y2={y}
				stroke={PFC_COLORS[1]}
				strokeWidth={2}
			/>
		</g>
	);
}

function PFCGraph({ p, f, c, history = [], period = "1d" }) {
	// 7d / 30d：積み上げ棒グラフ（P/F/C）+ 区切り線
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
		}));
		const tooltipFmt = (v, name) => [
			`${v.toFixed(1)}g`,
			name === "P" ? "タンパク質" : name === "F" ? "脂質" : "炭水化物",
		];
		return (
			<ResponsiveContainer width="100%" height={130}>
				<ComposedChart
					data={chartData}
					margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
				>
					<XAxis
						dataKey="date"
						tick={{ fontSize: 9 }}
						interval="preserveStartEnd"
					/>
					<YAxis tick={{ fontSize: 9 }} unit="g" />
					<Tooltip
						formatter={tooltipFmt}
						labelStyle={{ fontSize: 11 }}
						contentStyle={{ fontSize: 11 }}
					/>
					{/* P/F 境界線：P棒の上端に色付き線 */}
					<Bar
						dataKey="P"
						stackId="pfc"
						fill={PFC_COLORS[0]}
						shape={<PBarShape />}
					/>
					{/* F/C 境界線：F棒の上端に色付き線 */}
					<Bar
						dataKey="F"
						stackId="pfc"
						fill={PFC_COLORS[1]}
						shape={<FBarShape />}
					/>
					<Bar
						dataKey="C"
						stackId="pfc"
						fill={PFC_COLORS[2]}
						radius={[2, 2, 0, 0]}
					/>
				</ComposedChart>
			</ResponsiveContainer>
		);
	}

	// 1d：ドーナツ（%表示）
	if (!p && !f && !c) return <EmptyGraph />;
	const data = [
		{ name: "P", value: p ?? 0 },
		{ name: "F", value: f ?? 0 },
		{ name: "C", value: c ?? 0 },
	].filter((d) => d.value > 0);
	const renderPctLabel = ({
		cx,
		cy,
		midAngle,
		innerRadius,
		outerRadius,
		percent,
	}) => {
		if (percent < 0.08) return null;
		const RADIAN = Math.PI / 180;
		const r = innerRadius + (outerRadius - innerRadius) * 0.5;
		const x = cx + r * Math.cos(-midAngle * RADIAN);
		const y = cy + r * Math.sin(-midAngle * RADIAN);
		return (
			<text
				x={x}
				y={y}
				fill="white"
				textAnchor="middle"
				dominantBaseline="central"
				fontSize={8}
				fontWeight="bold"
			>
				{`${Math.round(percent * 100)}%`}
			</text>
		);
	};
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 6,
			}}
		>
			<ResponsiveContainer width={84} height={84}>
				<PieChart>
					<Pie
						data={data}
						cx="50%"
						cy="50%"
						innerRadius={22}
						outerRadius={40}
						dataKey="value"
						startAngle={90}
						endAngle={-270}
						strokeWidth={0}
						label={renderPctLabel}
						labelLine={false}
					>
						{data.map((_, i) => (
							<Cell key={i} fill={PFC_COLORS[i]} />
						))}
					</Pie>
				</PieChart>
			</ResponsiveContainer>
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
			<div
				style={{
					lineHeight: 1.1,
					marginTop: 2,
					display: "flex",
					alignItems: "baseline",
					gap: 8,
				}}
			>
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
function ScheduleCard({ connected, calendarData, isLoading }) {
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

	if (isLoading && !calendarData) {
		return (
			<div className="card">
				<div
					className="card-title"
					style={{ display: "flex", alignItems: "center", gap: 5 }}
				>
					<CalendarClock size={12} strokeWidth={2} />
					今日の予定
				</div>
				<div style={{ padding: "8px 0" }}>
					<InlineProgress label="Googleカレンダーを取得中" />
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
									timeZone: "Asia/Tokyo",
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
					marginBottom: 4,
					textTransform: "uppercase",
					letterSpacing: "0.05em",
				}}
			>
				ウィジェット表示設定
			</div>
			<div
				style={{
					fontSize: 10,
					color: "var(--text-3, #94a3b8)",
					marginBottom: 8,
				}}
			>
				☁ cloud に保存（端末を変えても同じ設定が反映されます・並び順も同期）
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
	const autoBodySyncRef = useRef("");
	const todayDate = todayStr();

	// ウィジェット設定：cloud 同期（初期はローカルキャッシュをフォールバック）
	const [order, setOrder] = useState(() =>
		normalizeWidgetOrder(lsGet("db-order", DEFAULT_ORDER)),
	);
	const [vis, setVis] = useState(() => lsGet("db-vis", DEFAULT_VIS));
	const [periods, setPeriods] = useState(() =>
		lsGet("db-periods", DEFAULT_PERIODS),
	);
	const [widgetDates, setWidgetDates] = useState(() =>
		lsGet("db-dates", DEFAULT_WIDGET_DATES),
	);
	const [showSettings, setShowSettings] = useState(false);
	const [deferredQueriesEnabled, setDeferredQueriesEnabled] = useState(false);

	useEffect(() => {
		const frameId = window.requestAnimationFrame(() => {
			setDeferredQueriesEnabled(true);
		});
		return () => window.cancelAnimationFrame(frameId);
	}, []);

	// Cloud から初回ロード
	const dashSettingsLoadedRef = useRef(false);
	const { data: dashSettingsData } = useQuery({
		queryKey: ["dashboard-settings"],
		queryFn: () => settingsApi.getDashboard(),
		staleTime: 60 * 1000,
	});
	useEffect(() => {
		if (dashSettingsData?.settings && !dashSettingsLoadedRef.current) {
			const s = dashSettingsData.settings;
			if (Array.isArray(s.order)) setOrder(normalizeWidgetOrder(s.order));
			if (s.vis && typeof s.vis === "object")
				setVis({ ...DEFAULT_VIS, ...s.vis });
			if (s.periods && typeof s.periods === "object")
				setPeriods({ ...DEFAULT_PERIODS, ...s.periods });
			if (s.dates && typeof s.dates === "object")
				setWidgetDates({ ...DEFAULT_WIDGET_DATES, ...s.dates });
			dashSettingsLoadedRef.current = true;
		}
	}, [dashSettingsData]);

	// Cloud 保存（debounce, 初回ロード前は保存しない）
	const dashSaveTimerRef = useRef(null);
	const persistDashSettings = (next) => {
		if (!dashSettingsLoadedRef.current) return;
		if (dashSaveTimerRef.current) clearTimeout(dashSaveTimerRef.current);
		dashSaveTimerRef.current = setTimeout(() => {
			settingsApi.updateDashboard(next).catch((e) => {
				console.warn("dashboard settings save failed:", e);
			});
		}, 800);
	};

	const toggleVis = (id, key) =>
		setVis((prev) => {
			const next = { ...prev, [id]: { ...prev[id], [key]: !prev[id][key] } };
			lsSet("db-vis", next);
			persistDashSettings({ order, vis: next, periods, dates: widgetDates });
			return next;
		});
	const setPeriod = (id, p) =>
		setPeriods((prev) => {
			const next = { ...prev, [id]: p };
			lsSet("db-periods", next);
			persistDashSettings({ order, vis, periods: next, dates: widgetDates });
			return next;
		});
	const setWidgetDate = (id, valueOrUpdater) =>
		setWidgetDates((prev) => {
			const current = prev[id] ?? todayDate;
			const nextDate =
				typeof valueOrUpdater === "function"
					? valueOrUpdater(current)
					: valueOrUpdater;
			const next = { ...prev, [id]: nextDate };
			lsSet("db-dates", next);
			persistDashSettings({ order, vis, periods, dates: next });
			return next;
		});

	const weightPeriod = periods.weight ?? DEFAULT_PERIODS.weight;
	const caloriesPeriod = periods.calories ?? DEFAULT_PERIODS.calories;
	const pfcPeriod = periods.pfc ?? DEFAULT_PERIODS.pfc;
	const stepsPeriod = periods.steps ?? DEFAULT_PERIODS.steps;
	const sleepPeriod = periods.sleep ?? DEFAULT_PERIODS.sleep;
	const mealsPeriod = periods.meals ?? DEFAULT_PERIODS.meals;

	const weightDate = widgetDates.weight ?? todayDate;
	const caloriesDate = widgetDates.calories ?? todayDate;
	const pfcDate = widgetDates.pfc ?? todayDate;
	const stepsDate = widgetDates.steps ?? todayDate;
	const sleepDate = widgetDates.sleep ?? todayDate;
	const mealsDate = widgetDates.meals ?? todayDate;

	const weightDays = weightPeriod === "30d" ? 30 : 7;
	const caloriesDays = getWidgetStepDays(
		caloriesPeriod,
		WIDGET_PERIOD_SUPPORTS.calories,
	);
	const pfcDays = getWidgetStepDays(pfcPeriod, WIDGET_PERIOD_SUPPORTS.pfc);
	const stepsDays = getWidgetStepDays(stepsPeriod, WIDGET_PERIOD_SUPPORTS.steps);
	const sleepDays = getWidgetStepDays(sleepPeriod, WIDGET_PERIOD_SUPPORTS.sleep);

	const weightRangeEnd = getWidgetRangeEnd(
		weightDate,
		weightPeriod,
		WIDGET_PERIOD_SUPPORTS.weight,
	);
	const caloriesRangeEnd = getWidgetRangeEnd(
		caloriesDate,
		caloriesPeriod,
		WIDGET_PERIOD_SUPPORTS.calories,
	);
	const pfcRangeEnd = getWidgetRangeEnd(
		pfcDate,
		pfcPeriod,
		WIDGET_PERIOD_SUPPORTS.pfc,
	);
	const stepsRangeEnd = getWidgetRangeEnd(
		stepsDate,
		stepsPeriod,
		WIDGET_PERIOD_SUPPORTS.steps,
	);
	const sleepRangeEnd = getWidgetRangeEnd(
		sleepDate,
		sleepPeriod,
		WIDGET_PERIOD_SUPPORTS.sleep,
	);
	const caloriesHistoryBaseDate = getWidgetHistoryBaseDate(
		caloriesDate,
		caloriesPeriod,
		WIDGET_PERIOD_SUPPORTS.calories,
	);
	const pfcHistoryBaseDate = getWidgetHistoryBaseDate(
		pfcDate,
		pfcPeriod,
		WIDGET_PERIOD_SUPPORTS.pfc,
	);

	const widgetDateLabel = {
		weight: getWidgetRangeLabel(weightDate, weightPeriod, WIDGET_PERIOD_SUPPORTS.weight),
		calories: getWidgetRangeLabel(caloriesDate, caloriesPeriod, WIDGET_PERIOD_SUPPORTS.calories),
		pfc: getWidgetRangeLabel(pfcDate, pfcPeriod, WIDGET_PERIOD_SUPPORTS.pfc),
		steps: getWidgetRangeLabel(stepsDate, stepsPeriod, WIDGET_PERIOD_SUPPORTS.steps),
		sleep: getWidgetRangeLabel(sleepDate, sleepPeriod, WIDGET_PERIOD_SUPPORTS.sleep),
		meals: getWidgetRangeLabel(mealsDate, mealsPeriod, WIDGET_PERIOD_SUPPORTS.meals),
	};

	const moveWidgetDate = (id, direction) => {
		const supported = WIDGET_PERIOD_SUPPORTS[id] ?? ["1d"];
		const period = periods[id] ?? DEFAULT_PERIODS[id] ?? supported[0] ?? "1d";
		const stepDays = getWidgetStepDays(period, supported);
		setWidgetDate(id, (prev) => offsetDate(prev, direction * stepDays));
	};

	const { data: dashboardMeta, isLoading } = useQuery({
		queryKey: ["dashboard-summary", "meta", todayDate],
		queryFn: () => dashboardApi.today(todayDate).then((r) => r.data),
	});
	const connectedServices = dashboardMeta?.connected_services ?? [];
	const connectedServicesKey = connectedServices.slice().sort().join(",");
	const goals = dashboardMeta?.goals || {};

	const shouldLoadWeightSummary = deferredQueriesEnabled && vis.weight.value;
	const { data: weightSummary, isFetching: isWeightSummaryFetching } = useQuery({
		queryKey: ["dashboard-summary", "weight", weightDate],
		queryFn: () => dashboardApi.today(weightDate).then((r) => r.data),
		enabled: shouldLoadWeightSummary,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadCaloriesSummary =
		deferredQueriesEnabled &&
		(vis.calories.value || (vis.calories.graph && caloriesPeriod === "1d"));
	const { data: caloriesSummary, isFetching: isCaloriesSummaryFetching } = useQuery({
		queryKey: ["dashboard-summary", "calories", caloriesDate],
		queryFn: () => dashboardApi.today(caloriesDate).then((r) => r.data),
		enabled: shouldLoadCaloriesSummary,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadPfcSummary =
		deferredQueriesEnabled && (vis.pfc.value || (vis.pfc.graph && pfcPeriod === "1d"));
	const { data: pfcSummary, isFetching: isPfcSummaryFetching } = useQuery({
		queryKey: ["dashboard-summary", "pfc", pfcDate],
		queryFn: () => dashboardApi.today(pfcDate).then((r) => r.data),
		enabled: shouldLoadPfcSummary,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadStepsSummary =
		deferredQueriesEnabled && (vis.steps.value || (vis.steps.graph && stepsPeriod === "1d"));
	const { data: stepsSummary, isFetching: isStepsSummaryFetching } = useQuery({
		queryKey: ["dashboard-summary", "steps", stepsDate],
		queryFn: () => dashboardApi.today(stepsDate).then((r) => r.data),
		enabled: shouldLoadStepsSummary,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadSleepSummary = deferredQueriesEnabled && vis.sleep.value;
	const { data: sleepSummary, isFetching: isSleepSummaryFetching } = useQuery({
		queryKey: ["dashboard-summary", "sleep", sleepDate],
		queryFn: () => dashboardApi.today(sleepDate).then((r) => r.data),
		enabled: shouldLoadSleepSummary,
		staleTime: 5 * 60 * 1000,
	});

	const todayTrackedWidgets = [weightDate, caloriesDate, pfcDate, stepsDate, sleepDate].filter(
		(date, index) =>
			[
				vis.weight.value || vis.weight.graph,
				vis.calories.value || vis.calories.graph,
				vis.pfc.value || vis.pfc.graph,
				vis.steps.value || vis.steps.graph,
				vis.sleep.value || vis.sleep.graph,
			][index] && isTodayJst(date),
	);
	const shouldAutoSyncBody =
		deferredQueriesEnabled &&
		todayTrackedWidgets.length > 0 &&
		connectedServices.some(
			(service) => service === "fitbit" || service === "healthplanet",
		);
	const { mutate: runBodySync, isPending: isBodySyncing } = useMutation({
		mutationFn: () => bodyApi.sync(todayDate),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
			qc.invalidateQueries({ queryKey: ["weight-history"] });
			qc.invalidateQueries({ queryKey: ["activity-history"] });
		},
	});

	useEffect(() => {
		if (!shouldAutoSyncBody) return;
		const syncKey = `${todayTrackedWidgets.join("|")}:${connectedServicesKey}`;
		if (autoBodySyncRef.current === syncKey) return;
		autoBodySyncRef.current = syncKey;
		runBodySync();
	}, [connectedServicesKey, runBodySync, shouldAutoSyncBody, todayTrackedWidgets]);

	const shouldLoadWeightHistory =
		deferredQueriesEnabled && (vis.weight.value || vis.weight.graph);
	const { data: weightHistory = [], isFetching: isWeightHistoryFetching } = useQuery({
		queryKey: ["weight-history", weightDays, weightRangeEnd],
		queryFn: () => bodyApi.weightHistory(weightDays, weightRangeEnd).then((r) => r.data),
		enabled: shouldLoadWeightHistory,
		staleTime: 5 * 60 * 1000,
	});
	const weightSyncMutation = useMutation({
		mutationFn: ({ days, baseDate }) => bodyApi.syncWeightHistory(days, baseDate),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["weight-history"] });
			qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
		},
	});

	const shouldLoadCaloriesActivityHistory =
		deferredQueriesEnabled && (vis.calories.graph || vis.calories.value) && caloriesPeriod !== "1d";
	const { data: caloriesActivityHistory = [], isFetching: isCaloriesActivityHistoryFetching } = useQuery({
		queryKey: ["activity-history", "calories", caloriesDays, caloriesRangeEnd],
		queryFn: () => bodyApi.activityHistory(caloriesDays, caloriesRangeEnd).then((r) => r.data),
		enabled: shouldLoadCaloriesActivityHistory,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadStepsHistory =
		deferredQueriesEnabled && vis.steps.graph && stepsPeriod !== "1d";
	const { data: stepsHistory = [], isFetching: isStepsHistoryFetching } = useQuery({
		queryKey: ["activity-history", "steps", stepsDays, stepsRangeEnd],
		queryFn: () => bodyApi.activityHistory(stepsDays, stepsRangeEnd).then((r) => r.data),
		enabled: shouldLoadStepsHistory,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadSleepHistory = deferredQueriesEnabled && vis.sleep.graph;
	const { data: sleepHistory = [], isFetching: isSleepHistoryFetching } = useQuery({
		queryKey: ["activity-history", "sleep", sleepDays, sleepRangeEnd],
		queryFn: () => bodyApi.activityHistory(sleepDays, sleepRangeEnd).then((r) => r.data),
		enabled: shouldLoadSleepHistory,
		staleTime: 5 * 60 * 1000,
	});
	const activitySyncMutation = useMutation({
		mutationFn: ({ days, baseDate }) => bodyApi.syncActivityHistory(days, baseDate),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["activity-history"] });
			qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
		},
	});

	const shouldLoadMeals =
		deferredQueriesEnabled && (vis.meals.value || vis.meals.graph);
	const { data: mealLogs = [], isFetching: isMealLogsFetching } = useQuery({
		queryKey: ["meals", mealsDate],
		queryFn: () => mealsApi.list(mealsDate).then((r) => r.data),
		enabled: shouldLoadMeals,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadMealsDailyKcal =
		deferredQueriesEnabled && (vis.meals.value || vis.meals.graph);
	const { data: mealsDailyKcal = [], isFetching: isMealsDailyKcalFetching } = useQuery({
		queryKey: ["meals-daily-kcal", "meals", mealsDate],
		queryFn: () => mealsApi.dailyKcal(mealsDate, 8),
		enabled: shouldLoadMealsDailyKcal,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadCaloriesDailyKcal = deferredQueriesEnabled && vis.calories.value;
	const { data: caloriesDailyKcal = [], isFetching: isCaloriesDailyKcalFetching } = useQuery({
		queryKey: ["meals-daily-kcal", "calories", caloriesDate],
		queryFn: () => mealsApi.dailyKcal(caloriesDate, 8),
		enabled: shouldLoadCaloriesDailyKcal,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadCaloriesNutrition =
		deferredQueriesEnabled && (vis.calories.graph || vis.calories.value) && caloriesPeriod !== "1d";
	const { data: caloriesDailyNutrition = [], isFetching: isCaloriesDailyNutritionFetching } = useQuery({
		queryKey: ["meals-daily-nutrition", "calories", caloriesHistoryBaseDate, caloriesDays],
		queryFn: () => mealsApi.dailyNutrition(caloriesHistoryBaseDate, caloriesDays),
		enabled: shouldLoadCaloriesNutrition,
		staleTime: 5 * 60 * 1000,
	});
	const shouldLoadPfcNutrition =
		deferredQueriesEnabled && vis.pfc.graph && pfcPeriod !== "1d";
	const { data: pfcDailyNutrition = [], isFetching: isPfcDailyNutritionFetching } = useQuery({
		queryKey: ["meals-daily-nutrition", "pfc", pfcHistoryBaseDate, pfcDays],
		queryFn: () => mealsApi.dailyNutrition(pfcHistoryBaseDate, pfcDays),
		enabled: shouldLoadPfcNutrition,
		staleTime: 5 * 60 * 1000,
	});

	const caloriesYesterdayKcal = (() => {
		const yStr = offsetDate(caloriesDate, -1);
		const rec = caloriesDailyKcal.find((r) => r.date === yStr);
		return rec ? rec.total_kcal : null;
	})();
	const mealsYesterdayKcal = (() => {
		const yStr = offsetDate(mealsDate, -1);
		const rec = mealsDailyKcal.find((r) => r.date === yStr);
		return rec ? rec.total_kcal : null;
	})();
	const avgKcal7 = (() => {
		const vals = caloriesDailyKcal
			.slice(0, 7)
			.map((r) => r.total_kcal)
			.filter((v) => v > 0);
		if (!vals.length) return null;
		return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
	})();
	const calorieHistory = (() => {
		if (caloriesPeriod === "1d") return [];
		const activityByDate = new Map(
			caloriesActivityHistory.map((entry) => [entry.date, entry]),
		);
		return caloriesDailyNutrition
			.map((entry) => {
				const activity = activityByDate.get(entry.date);
				const caloriesOut = Number.isFinite(activity?.calories_out)
					? activity.calories_out
					: null;
				return {
					date: entry.date,
					total_kcal: entry.total_kcal,
					calories_out: caloriesOut,
					balance:
						caloriesOut != null ? entry.total_kcal - caloriesOut : null,
				};
			})
			.reverse();
	})();
	const caloriePeriodHistory = (() => {
		if (caloriesPeriod !== "1d") return calorieHistory;
		const singleDayIntake = Number.isFinite(caloriesSummary?.nutrition?.kcal)
			? Math.round(caloriesSummary.nutrition.kcal)
			: null;
		const singleDayBurned = Number.isFinite(caloriesSummary?.calories_out)
			? Math.round(caloriesSummary.calories_out)
			: null;
		if (singleDayIntake == null && singleDayBurned == null) return [];
		return [
			{
				date: caloriesDate,
				total_kcal: singleDayIntake,
				calories_out: singleDayBurned,
				balance:
					singleDayIntake != null && singleDayBurned != null
						? singleDayIntake - singleDayBurned
						: null,
			},
		];
	})();

	const syncFatSecretMutation = useMutation({
		mutationFn: ({ date }) => mealsApi.syncFatSecret(date),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["meals"] });
			qc.invalidateQueries({ queryKey: ["meals-daily-kcal"] });
			qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
			qc.invalidateQueries({ queryKey: ["meals-daily-nutrition"] });
		},
	});

	const { data: calendarData, isFetching: isCalendarFetching } = useQuery({
		queryKey: ["dashboard-calendar", todayDate],
		queryFn: () => dashboardApi.calendar(todayDate),
		enabled: deferredQueriesEnabled && connectedServices.includes("google"),
		staleTime: 5 * 60 * 1000,
	});
	const widgetBusy = {
		weight:
			isBodySyncing ||
			(shouldLoadWeightHistory && isWeightHistoryFetching) ||
			(shouldLoadWeightSummary && isWeightSummaryFetching),
		calories:
			(shouldLoadCaloriesSummary && isCaloriesSummaryFetching) ||
			(shouldLoadCaloriesDailyKcal && isCaloriesDailyKcalFetching) ||
			(shouldLoadCaloriesNutrition && isCaloriesDailyNutritionFetching) ||
			(shouldLoadCaloriesActivityHistory && isCaloriesActivityHistoryFetching),
		pfc:
			(shouldLoadPfcSummary && isPfcSummaryFetching) ||
			(shouldLoadPfcNutrition && isPfcDailyNutritionFetching),
		steps:
			isBodySyncing ||
			(shouldLoadStepsSummary && isStepsSummaryFetching) ||
			(shouldLoadStepsHistory && isStepsHistoryFetching),
		sleep:
			isBodySyncing ||
			(shouldLoadSleepSummary && isSleepSummaryFetching) ||
			(shouldLoadSleepHistory && isSleepHistoryFetching),
		meals:
			(shouldLoadMeals && isMealLogsFetching) ||
			(shouldLoadMealsDailyKcal && isMealsDailyKcalFetching),
	};

	const syncMutation = useMutation({
		mutationFn: async () => {
			await bodyApi.sync(todayDate);
			await Promise.allSettled([
				bodyApi.syncWeightHistory(weightDays, weightRangeEnd),
				bodyApi.syncActivityHistory(
					Math.max(caloriesDays, stepsDays, sleepDays),
					todayDate,
				),
				mealsApi.syncFatSecretBulk(todayDate, 8),
			]);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
			qc.invalidateQueries({ queryKey: ["weight-history"] });
			qc.invalidateQueries({ queryKey: ["activity-history"] });
			qc.invalidateQueries({ queryKey: ["meals"] });
			qc.invalidateQueries({ queryKey: ["meals-daily-kcal"] });
			qc.invalidateQueries({ queryKey: ["meals-daily-nutrition"] });
			qc.invalidateQueries({ queryKey: ["dashboard-calendar"] });
		},
	});

	const latestW = weightHistory.at(-1)?.weight ?? weightSummary?.weight;
	const oldestW = weightHistory[0]?.weight;
	const wRef7d = (() => {
		if (!weightHistory.length) return null;
		const cutoff = offsetDate(weightDate, -7);
		return (
			[...weightHistory].reverse().find((w) => w.date <= cutoff)?.weight ??
			weightHistory[0]?.weight
		);
	})();
	const wDelta =
		latestW && wRef7d && latestW !== wRef7d
			? (latestW - wRef7d).toFixed(1)
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

	const caloriesNut = caloriesSummary?.nutrition || {};
	const pfcNut = pfcSummary?.nutrition || {};
	const calorieIntakeTotal = caloriePeriodHistory.reduce(
		(sum, entry) =>
			sum + (Number.isFinite(entry.total_kcal) ? Math.round(entry.total_kcal) : 0),
		0,
	);
	const calorieBurnedEntries = caloriePeriodHistory.filter((entry) =>
		Number.isFinite(entry.calories_out),
	);
	const calorieBurnedTotal = calorieBurnedEntries.reduce(
		(sum, entry) => sum + Math.round(entry.calories_out),
		0,
	);
	const hasCompleteCalorieBurnedData =
		caloriePeriodHistory.length > 0 &&
		calorieBurnedEntries.length === caloriePeriodHistory.length;
	const calIntake = caloriePeriodHistory.length ? calorieIntakeTotal : (caloriesNut.kcal ? Math.round(caloriesNut.kcal) : null);
	const calBurned =
		calorieBurnedEntries.length > 0 ? calorieBurnedTotal : null;
	const calBalance =
		calIntake != null && hasCompleteCalorieBurnedData && calBurned != null
			? calIntake - calBurned
			: null;
	const dailyCalTarget = goals.target_kcal || null;
	const calTarget =
		dailyCalTarget != null
			? dailyCalTarget * (caloriesPeriod === "1d" ? 1 : caloriesDays)
			: null;
	const calPct =
		calIntake && calTarget ? Math.round((calIntake / calTarget) * 100) : null;
	const calRemaining =
		calIntake != null && calTarget != null ? calTarget - calIntake : null;

	const proteinRatio = goals.target_protein_ratio ?? 0.3;
	const fatRatio = goals.target_fat_ratio ?? 0.25;
	const carbRatio = goals.target_carb_ratio ?? 0.45;
	const targetProtein = calTarget
		? Math.round((calTarget * proteinRatio) / 4)
		: null;
	const targetFat = calTarget ? Math.round((calTarget * fatRatio) / 9) : null;
	const targetCarb = calTarget ? Math.round((calTarget * carbRatio) / 4) : null;

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
			persistDashSettings({ order: next, vis, periods, dates: widgetDates });
			return next;
		});
	};

	// ウィジェット定義
	const widgetDef = {
		weight: {
			support: WIDGET_PERIOD_SUPPORTS.weight,
			value: <WeightValue latest={latestW} delta={wDelta} pct={wPct} />,
			graph: (
				<WeightGraph
					history={weightHistory}
					onBulkSync={() =>
						weightSyncMutation.mutate({
							days: weightDays,
							baseDate: weightRangeEnd,
						})
					}
					isSyncing={weightSyncMutation.isPending}
				/>
			),
		},
		calories: {
			support: WIDGET_PERIOD_SUPPORTS.calories,
			value: (
				<CaloriesValue
					intake={calIntake}
					burned={calBurned}
					balance={calBalance}
					period={caloriesPeriod}
					target={calTarget}
					pct={calPct}
					remaining={calRemaining}
					yesterdayKcal={caloriesYesterdayKcal}
					avgKcal7={avgKcal7}
				/>
			),
			graph: (
				<CaloriesGraph
					target={dailyCalTarget}
					history={caloriePeriodHistory}
					period={caloriesPeriod}
					totalBalance={calBalance}
				/>
			),
		},
		pfc: {
			support: WIDGET_PERIOD_SUPPORTS.pfc,
			value: (
				<PFCValue
					p={pfcNut.protein_g}
					f={pfcNut.fat_g}
					c={pfcNut.carb_g}
					tp={targetProtein}
					tf={targetFat}
					tc={targetCarb}
				/>
			),
			graph: (
				<PFCGraph
					p={pfcNut.protein_g}
					f={pfcNut.fat_g}
					c={pfcNut.carb_g}
					history={pfcDailyNutrition}
					period={pfcPeriod}
				/>
			),
		},
		steps: {
			support: WIDGET_PERIOD_SUPPORTS.steps,
			value: <StepsValue steps={stepsSummary?.steps} />,
			graph: (
				<StepsGraph
					steps={stepsSummary?.steps}
					history={stepsHistory}
					period={stepsPeriod}
					onBulkSync={() =>
						activitySyncMutation.mutate({
							days: stepsDays,
							baseDate: stepsRangeEnd,
						})
					}
					isSyncing={activitySyncMutation.isPending}
				/>
			),
		},
		sleep: {
			support: WIDGET_PERIOD_SUPPORTS.sleep,
			value: (
				<SleepValue
					hours={sleepSummary?.sleep_hours}
					score={sleepSummary?.sleep_score}
				/>
			),
			graph: (
				<SleepGraph
					history={sleepHistory}
					onBulkSync={() =>
						activitySyncMutation.mutate({
							days: sleepDays,
							baseDate: sleepRangeEnd,
						})
					}
					isSyncing={activitySyncMutation.isPending}
				/>
			),
		},
		meals: {
			support: WIDGET_PERIOD_SUPPORTS.meals,
			value: <MealsValue logs={mealLogs} yesterdayKcal={mealsYesterdayKcal} />,
			graph: (
				<MealsList
					logs={mealLogs}
					onSync={() => syncFatSecretMutation.mutate({ date: mealsDate })}
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

			{/* 未連携バナー */}
			{!isLoading && connectedServices.length === 0 && (
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
											period={periods[id] ?? DEFAULT_PERIODS[id]}
											onPeriodChange={(p) => setPeriod(id, p)}
											dateLabel={widgetDateLabel[id]}
											onDatePrev={() => moveWidgetDate(id, -1)}
											onDateNext={() => moveWidgetDate(id, 1)}
											onDateToday={() => setWidgetDate(id, todayDate)}
											valueContent={def.value}
											graphContent={def.graph}
											graphSupport={def.support}
											span={
												v.graph
													? id === "meals"
														? "span-2"
														: id === "weight" ||
															  id === "sleep" ||
															  (id === "steps" && stepsPeriod !== "1d")
															? "span-2"
															: null
													: null
											}
											needsConnection={
												!isServiceConnected(
													WIDGET_REQUIREMENTS[id],
													connectedServices,
												)
											}
											requirementLabel={WIDGET_REQUIREMENTS[id]?.label}
											isBusy={widgetBusy[id]}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>

					<ScheduleCard
						connected={connectedServices.includes("google")}
						calendarData={calendarData}
						isLoading={deferredQueriesEnabled && isCalendarFetching}
					/>

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