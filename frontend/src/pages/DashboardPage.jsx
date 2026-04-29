import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AreaChart, Area,
  PieChart, Pie, Cell,
  BarChart, Bar,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  Scale, Flame, Layers, Footprints, Moon,
  RefreshCw, Utensils, Dumbbell, CalendarClock,
  ChevronLeft, ChevronRight, GripVertical, Settings2,
} from 'lucide-react';
import { dashboardApi, bodyApi } from '../services/api';
import { Link } from 'react-router-dom';

// ── 日付ユーティリティ ────────────────────────────────────────
// ※ toISOString() は UTC を返すためタイムゾーンがズレる → ローカル日付を使う
function localDateStr(d = new Date()) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function todayStr() { return localDateStr(); }
function offsetDate(base, days) {
  const d = new Date(base + 'T00:00:00'); // ローカル0時として解釈
  d.setDate(d.getDate() + days);
  return localDateStr(d);                 // ローカル日付で文字列化
}
function fmtDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('ja-JP', {
    month: 'long', day: 'numeric', weekday: 'short',
  });
}
function fmtShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('ja-JP', {
    month: 'numeric', day: 'numeric',
  });
}

// ── localStorage ─────────────────────────────────────────────
function lsGet(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── 定数 ─────────────────────────────────────────────────────
const WIDGET_IDS = ['weight', 'calories', 'pfc', 'steps', 'sleep'];

const WIDGET_META = {
  weight:   { label: '体重',     Icon: Scale },
  calories: { label: 'カロリー', Icon: Flame },
  pfc:      { label: 'PFC',      Icon: Layers },
  steps:    { label: '歩数',     Icon: Footprints },
  sleep:    { label: '睡眠',     Icon: Moon },
};

const DEFAULT_ORDER   = WIDGET_IDS;
const DEFAULT_VIS     = Object.fromEntries(WIDGET_IDS.map(id => [id, { value: true, graph: false }]));
const DEFAULT_PERIODS = Object.fromEntries(WIDGET_IDS.map(id => [id, '7d']));

const BRAND      = '#16a34a';
const PFC_COLORS = ['#16a34a', '#f59e0b', '#3b82f6'];
const tipStyle   = { fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid #e2e8f0' };

// ── 共通パーツ ────────────────────────────────────────────────
function Dot({ color }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 4 }} />;
}
function EmptyGraph({ msg = 'データなし' }) {
  return <div style={{ color: 'var(--text-2)', fontSize: 12, padding: '8px 0' }}>{msg}</div>;
}
function PeriodPills({ period, onChange, supported = ['1d', '7d', '30d'] }) {
  const labels = { '1d': '1日', '7d': '7日', '30d': '30日' };
  return (
    <div className="period-pills">
      {supported.map(p => (
        <button key={p} className={`period-pill${period === p ? ' active' : ''}`} onClick={() => onChange(p)}>
          {labels[p]}
        </button>
      ))}
    </div>
  );
}

// ── ソータブル ウィジェットシェル ─────────────────────────────
function WidgetShell({ id, vis, period, onPeriodChange, valueContent, graphContent, graphSupport }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const { label, Icon } = WIDGET_META[id];
  const showBoth = vis.value && vis.graph;

  return (
    <div
      ref={setNodeRef}
      className="widget-card"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
    >
      {/* ヘッダー */}
      <div className="widget-header">
        <span className="widget-label">
          <Icon size={12} strokeWidth={1.8} />
          {label}
        </span>
        <span
          {...attributes} {...listeners}
          style={{ cursor: 'grab', padding: '2px', color: 'var(--text-3)', lineHeight: 1, touchAction: 'none' }}
          title="長押しで並び替え"
        >
          <GripVertical size={13} strokeWidth={1.5} />
        </span>
      </div>

      {/* 数値セクション */}
      {vis.value && <div>{valueContent}</div>}

      {/* 区切り線（両方表示時） */}
      {showBoth && <div className="widget-divider" />}

      {/* グラフセクション */}
      {vis.graph && (
        <div>
          <PeriodPills period={period} onChange={onPeriodChange} supported={graphSupport} />
          {graphContent}
        </div>
      )}
    </div>
  );
}

// ── 体重 ──────────────────────────────────────────────────────
function WeightValue({ latest, delta, pct }) {
  return (
    <>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{latest ?? '—'}</span>
        <span className="widget-unit">kg</span>
      </div>
      {delta && (
        <div className="widget-sub">
          {parseFloat(delta) < 0 ? '▼' : '▲'} {Math.abs(delta)} kg（{delta < 0 ? '' : '+'}）
        </div>
      )}
      {pct != null && (
        <div className="progress-bar" style={{ marginTop: 6 }}>
          <div className={`progress-fill${pct > 100 ? ' over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </>
  );
}

function WeightGraph({ history, period }) {
  if (!history?.length) return <EmptyGraph />;
  const data = history.map(w => ({ d: fmtShort(w.date), v: w.weight }));
  const vals = data.map(d => d.v);
  const lo   = Math.floor(Math.min(...vals) - 0.5);
  const hi   = Math.ceil(Math.max(...vals) + 0.5);
  return (
    <ResponsiveContainer width="100%" height={88}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
        <defs>
          <linearGradient id="wGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={BRAND} stopOpacity={0.25} />
            <stop offset="95%" stopColor={BRAND} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="d" tick={{ fontSize: 9, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
        <YAxis domain={[lo, hi]} tick={{ fontSize: 9, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tipStyle} formatter={v => [`${v} kg`, '体重']} />
        <Area type="monotone" dataKey="v" stroke={BRAND} strokeWidth={1.5} fill="url(#wGrad)" dot={{ r: 2, fill: BRAND }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── カロリー ──────────────────────────────────────────────────
function CaloriesValue({ intake, target, pct, remaining }) {
  const fill = `progress-fill${pct > 100 ? ' over' : pct > 75 ? ' warn' : ''}`;
  return (
    <>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{intake?.toLocaleString() ?? '—'}</span>
        <span className="widget-unit">kcal</span>
      </div>
      {remaining != null
        ? <div className="widget-sub">残り {remaining.toLocaleString()}</div>
        : target && <div className="widget-sub">目標 {target.toLocaleString()}</div>}
      {pct != null && (
        <div className="progress-bar" style={{ marginTop: 6 }}>
          <div className={fill} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </>
  );
}

function CaloriesGraph({ intake, target }) {
  if (!intake) return <EmptyGraph />;
  const over     = target && intake > target ? intake - target : 0;
  const consumed = intake - over;
  const remain   = target ? Math.max(0, target - intake) : 0;
  const data = [
    { name: '摂取',     value: consumed, fill: BRAND },
    { name: 'オーバー', value: over,     fill: '#dc2626' },
    { name: '残り',     value: remain,   fill: '#e2e8f0' },
  ].filter(d => d.value > 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <ResponsiveContainer width={72} height={72}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={22} outerRadius={34}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.9 }}>
        <div><Dot color={BRAND} />摂取 {intake.toLocaleString()}</div>
        {target && <div><Dot color="#e2e8f0" />残り {remain.toLocaleString()}</div>}
        {over > 0 && <div><Dot color="#dc2626" />超過 {over.toLocaleString()}</div>}
      </div>
    </div>
  );
}

// ── PFC ───────────────────────────────────────────────────────
function PFCValue({ p, f, c }) {
  return (
    <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.9 }}>
      <div><span style={{ color: PFC_COLORS[0], fontWeight: 700 }}>P</span>{' '}{p ? `${p.toFixed(1)}g` : '—'}</div>
      <div><span style={{ color: PFC_COLORS[1], fontWeight: 700 }}>F</span>{' '}{f ? `${f.toFixed(1)}g` : '—'}</div>
      <div><span style={{ color: PFC_COLORS[2], fontWeight: 700 }}>C</span>{' '}{c ? `${c.toFixed(1)}g` : '—'}</div>
    </div>
  );
}

function PFCGraph({ p, f, c }) {
  if (!p && !f && !c) return <EmptyGraph />;
  const data = [
    { name: 'タンパク質', value: p ?? 0 },
    { name: '脂質',       value: f ?? 0 },
    { name: '炭水化物',   value: c ?? 0 },
  ].filter(d => d.value > 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <ResponsiveContainer width={72} height={72}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={22} outerRadius={34}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((_, i) => <Cell key={i} fill={PFC_COLORS[i]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.9 }}>
        <div><Dot color={PFC_COLORS[0]} />P {p?.toFixed(1) ?? '—'}g</div>
        <div><Dot color={PFC_COLORS[1]} />F {f?.toFixed(1) ?? '—'}g</div>
        <div><Dot color={PFC_COLORS[2]} />C {c?.toFixed(1) ?? '—'}g</div>
      </div>
    </div>
  );
}

// ── 歩数 ──────────────────────────────────────────────────────
const STEP_GOAL = 10000;

function StepsValue({ steps }) {
  const pct = steps ? Math.round(steps / STEP_GOAL * 100) : null;
  return (
    <>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{steps?.toLocaleString() ?? '—'}</span>
        <span className="widget-unit">歩</span>
      </div>
      <div className="widget-sub">目標 {STEP_GOAL.toLocaleString()}</div>
      {pct != null && (
        <div className="progress-bar" style={{ marginTop: 6 }}>
          <div className={`progress-fill${pct >= 100 ? ' over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </>
  );
}

function StepsGraph({ steps }) {
  if (!steps) return <EmptyGraph />;
  const pct  = Math.round(steps / STEP_GOAL * 100);
  const data = [
    { name: '達成', value: Math.min(steps, STEP_GOAL), fill: BRAND },
    { name: '残り', value: Math.max(0, STEP_GOAL - steps), fill: '#e2e8f0' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <ResponsiveContainer width={72} height={72}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={22} outerRadius={34}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.6 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: BRAND, lineHeight: 1.1 }}>{pct}%</div>
        <div style={{ color: 'var(--text-2)' }}>{steps.toLocaleString()} 歩</div>
      </div>
    </div>
  );
}

// ── 睡眠 ──────────────────────────────────────────────────────
function SleepValue({ hours, score }) {
  return (
    <>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{hours?.toFixed(1) ?? '—'}</span>
        <span className="widget-unit">h</span>
      </div>
      <div className="widget-sub">{score ? `スコア ${score}` : '目標 7 時間'}</div>
    </>
  );
}

function SleepGraph({ hours, score }) {
  if (!hours) return <EmptyGraph />;
  const deep  = parseFloat((hours * 0.20).toFixed(1));
  const rem   = parseFloat((hours * 0.25).toFixed(1));
  const light = parseFloat((hours - deep - rem).toFixed(1));
  const data  = [
    { name: '今日', ディープ: deep, レム: rem, 浅い: light },
    { name: '目標', ディープ: 1.4,  レム: 1.75, 浅い: 3.85 },
  ];
  return (
    <>
      <ResponsiveContainer width="100%" height={76}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} formatter={(v, n) => [`${v}h`, n]} />
          <Bar dataKey="ディープ" stackId="a" fill="#1d4ed8" />
          <Bar dataKey="レム"     stackId="a" fill="#60a5fa" />
          <Bar dataKey="浅い"     stackId="a" fill="#bfdbfe" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      {score && <div style={{ fontSize: 11, color: 'var(--text-2)', textAlign: 'right' }}>スコア {score}</div>}
    </>
  );
}

// ── 今日の予定（フルワイド固定） ─────────────────────────────
function ScheduleCard({ cal }) {
  const events = [
    ...(cal?.meal_events     || []).map(e => ({ ...e, type: 'meal' })),
    ...(cal?.exercise_events || []).map(e => ({ ...e, type: 'ex' })),
  ].sort((a, b) => (a.time || '') < (b.time || '') ? -1 : 1);
  if (!events.length) return null;
  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <CalendarClock size={12} strokeWidth={2} />
        今日の予定
      </div>
      {events.map((ev, i) => (
        <div key={i} className="list-item">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {ev.type === 'meal'
              ? <Utensils size={14} strokeWidth={1.5} style={{ color: 'var(--text-2)' }} />
              : <Dumbbell size={14} strokeWidth={1.5} style={{ color: 'var(--text-2)' }} />}
            <span style={{ fontSize: 14 }}>{ev.category}</span>
          </div>
          {ev.time && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {new Date(ev.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── ウィジェット設定パネル ────────────────────────────────────
function SettingsPanel({ vis, onToggle }) {
  return (
    <div className="dash-settings">
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        ウィジェット表示設定
      </div>
      {WIDGET_IDS.map(id => {
        const { label } = WIDGET_META[id];
        return (
          <div key={id} className="dash-settings-row">
            <span style={{ fontWeight: 500 }}>{label}</span>
            <div className="dash-settings-toggles">
              {[['value', '数値'], ['graph', 'グラフ']].map(([key, lbl]) => (
                <button
                  key={key}
                  className={`btn btn-sm${vis[id][key] ? ' btn-primary' : ' btn-outline'}`}
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
  const isToday = dateStr === todayStr();

  // ウィジェット設定（localStorage 永続化）
  const [order,        setOrder]        = useState(() => lsGet('db-order',   DEFAULT_ORDER));
  const [vis,          setVis]          = useState(() => lsGet('db-vis',     DEFAULT_VIS));
  const [periods,      setPeriods]      = useState(() => lsGet('db-periods', DEFAULT_PERIODS));
  const [showSettings, setShowSettings] = useState(false);

  const toggleVis = (id, key) => setVis(prev => {
    const next = { ...prev, [id]: { ...prev[id], [key]: !prev[id][key] } };
    lsSet('db-vis', next);
    return next;
  });
  const setPeriod = (id, p) => setPeriods(prev => {
    const next = { ...prev, [id]: p };
    lsSet('db-periods', next);
    return next;
  });

  // データ取得
  const { data: summary, isLoading } = useQuery({
    queryKey: ['dashboard', dateStr],
    queryFn: () => dashboardApi.today(dateStr).then(r => r.data),
  });

  // 体重履歴：選択中の期間に応じて日数を調整
  const weightDays = periods.weight === '30d' ? 30 : 7;
  const { data: weightHistory = [] } = useQuery({
    queryKey: ['weight-history', weightDays],
    queryFn: () => bodyApi.weightHistory(weightDays).then(r => r.data),
  });

  const syncMutation = useMutation({
    mutationFn: () => bodyApi.sync(dateStr),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['weight-history'] });
    },
  });

  // 派生値
  const nut   = summary?.nutrition || {};
  const goals = summary?.goals     || {};
  const cal   = summary?.calendar  || {};

  const latestW  = weightHistory.at(-1)?.weight ?? summary?.weight;
  const oldestW  = weightHistory[0]?.weight;
  const wDelta   = latestW && oldestW && latestW !== oldestW
    ? (latestW - oldestW).toFixed(1) : null;
  const wPct     = goals.target_weight && latestW && oldestW
    ? Math.max(0, Math.round(100 - Math.abs(latestW - goals.target_weight)
        / Math.abs((oldestW || latestW) - goals.target_weight) * 100))
    : null;

  const calIntake    = nut.kcal ? Math.round(nut.kcal) : null;
  const calTarget    = goals.target_kcal || null;
  const calPct       = calIntake && calTarget ? Math.round(calIntake / calTarget * 100) : null;
  const calRemaining = calIntake && calTarget ? Math.max(0, calTarget - calIntake) : null;

  // DnD（長押し 300ms）
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 300, tolerance: 5 } })
  );
  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setOrder(prev => {
      const next = arrayMove(prev, prev.indexOf(active.id), prev.indexOf(over.id));
      lsSet('db-order', next);
      return next;
    });
  };

  // ウィジェット定義
  const widgetDef = {
    weight: {
      support: ['1d', '7d', '30d'],
      value:   <WeightValue latest={latestW} delta={wDelta} pct={wPct} />,
      graph:   <WeightGraph history={weightHistory} period={periods.weight} />,
    },
    calories: {
      support: ['1d'],
      value:   <CaloriesValue intake={calIntake} target={calTarget} pct={calPct} remaining={calRemaining} />,
      graph:   <CaloriesGraph intake={calIntake} target={calTarget} />,
    },
    pfc: {
      support: ['1d'],
      value:   <PFCValue p={nut.protein_g} f={nut.fat_g} c={nut.carb_g} />,
      graph:   <PFCGraph p={nut.protein_g} f={nut.fat_g} c={nut.carb_g} />,
    },
    steps: {
      support: ['1d'],
      value:   <StepsValue steps={summary?.steps} />,
      graph:   <StepsGraph steps={summary?.steps} />,
    },
    sleep: {
      support: ['1d'],
      value:   <SleepValue hours={summary?.sleep_hours} score={summary?.sleep_score} />,
      graph:   <SleepGraph hours={summary?.sleep_hours} score={summary?.sleep_score} />,
    },
  };

  return (
    <div>
      {/* ヘッダー */}
      <div className="page-header">
        <h1 className="page-title">ダッシュボード</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn btn-sm${showSettings ? ' btn-primary' : ' btn-outline'}`}
            onClick={() => setShowSettings(v => !v)}
            title="ウィジェット設定"
          >
            <Settings2 size={13} strokeWidth={1.8} />
            設定
          </button>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw size={13} strokeWidth={2}
              style={syncMutation.isPending ? { animation: 'spin 0.65s linear infinite' } : {}} />
            {syncMutation.isPending ? '同期中…' : '同期'}
          </button>
        </div>
      </div>

      {/* ウィジェット設定パネル */}
      {showSettings && <SettingsPanel vis={vis} onToggle={toggleVis} />}

      {/* 日付ナビゲーション */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 'var(--sp-4)' }}>
        <button
          className="btn-ghost"
          style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(prev => offsetDate(prev, -1))}
        >
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>

        {/* 日付ラベル：クリックで今日に戻る */}
        <button
          className="btn-ghost"
          style={{
            padding: '5px 14px', borderRadius: 20,
            fontSize: 13, fontWeight: 600, minWidth: 140, textAlign: 'center',
            color: isToday ? 'var(--brand)' : 'var(--text)',
          }}
          onClick={() => setDateStr(todayStr())}
          title="クリックで今日に戻る"
        >
          {isToday ? '今日 · ' : ''}{fmtDate(dateStr)}
        </button>

        <button
          className="btn-ghost"
          style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(prev => offsetDate(prev, 1))}
        >
          <ChevronRight size={18} strokeWidth={1.8} />
        </button>
      </div>

      {/* 未連携バナー */}
      {!isLoading && summary?.connected_services?.length === 0 && (
        <div className="alert alert-warn">
          外部サービスが未連携です。
          <Link to="/me" style={{ fontWeight: 700, marginLeft: 4 }}>マイページ → 設定</Link>から連携してください。
        </div>
      )}

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-10)' }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={order} strategy={rectSortingStrategy}>
              <div className="widget-grid">
                {order.map(id => {
                  const def = widgetDef[id];
                  if (!def) return null;
                  const v = vis[id] ?? { value: true, graph: false };
                  // 何も表示しない設定の場合でも最低限シェルは表示
                  return (
                    <WidgetShell
                      key={id}
                      id={id}
                      vis={v}
                      period={periods[id] ?? '1d'}
                      onPeriodChange={p => setPeriod(id, p)}
                      valueContent={def.value}
                      graphContent={def.graph}
                      graphSupport={def.support}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>

          <ScheduleCard cal={cal} />

          <Link to="/plan" className="btn btn-secondary btn-full"
            style={{ marginTop: 'var(--sp-2)', textDecoration: 'none' }}>
            今週の献立を確認する
          </Link>
        </>
      )}
    </div>
  );
}
