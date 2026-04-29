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
  ChevronLeft, ChevronRight, BarChart2, Hash, GripVertical,
} from 'lucide-react';
import { dashboardApi, bodyApi } from '../services/api';
import { Link } from 'react-router-dom';

// ── 日付ユーティリティ ────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }
function offsetDate(base, days) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
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
  try { return JSON.parse(localStorage.getItem(key)) ?? def; }
  catch { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── 定数 ─────────────────────────────────────────────────────
const DEFAULT_ORDER = ['weight', 'calories', 'pfc', 'steps', 'sleep'];
const BRAND         = '#16a34a';
const PFC_COLORS    = ['#16a34a', '#f59e0b', '#3b82f6']; // P / F / C

// ── ウィジェット共通シェル（ソート可能）──────────────────────
function WidgetShell({ id, Icon, title, showGraph, onToggle, valueContent, graphContent }) {
  const {
    attributes, listeners, setNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      className="widget-card"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : 1,
      }}
    >
      {/* ヘッダー */}
      <div className="widget-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="widget-label">
          <Icon size={12} strokeWidth={1.8} />
          {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* 値/グラフ切替 */}
          <button
            className="btn-ghost"
            style={{ padding: '2px 4px', borderRadius: 4 }}
            onClick={onToggle}
            title={showGraph ? '数値のみ表示' : 'グラフ表示'}
          >
            {showGraph
              ? <Hash size={11} strokeWidth={2} style={{ color: 'var(--brand)' }} />
              : <BarChart2 size={11} strokeWidth={1.8} style={{ color: 'var(--text-2)' }} />
            }
          </button>
          {/* ドラッグハンドル（長押し300ms） */}
          <span
            {...attributes}
            {...listeners}
            style={{ cursor: 'grab', padding: '2px 2px', color: 'var(--text-3)', lineHeight: 1, touchAction: 'none' }}
            title="長押しで並び替え"
          >
            <GripVertical size={13} strokeWidth={1.5} />
          </span>
        </div>
      </div>

      {/* コンテンツ */}
      {showGraph && graphContent ? graphContent : valueContent}
    </div>
  );
}

// ── 体重 ──────────────────────────────────────────────────────
function WeightValue({ latest, delta, pct }) {
  const isOver = pct != null && pct > 100;
  return (
    <>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{latest ?? '—'}</span>
        <span className="widget-unit">kg</span>
      </div>
      {delta && (
        <div className="widget-sub">
          {parseFloat(delta) < 0 ? '▼' : '▲'} {Math.abs(delta)} kg（7日間）
        </div>
      )}
      {pct != null && (
        <div className="progress-bar" style={{ marginTop: 6 }}>
          <div className={`progress-fill${isOver ? ' over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </>
  );
}

function WeightGraph({ history }) {
  if (!history?.length) return <EmptyGraph />;
  const data = history.map(w => ({ d: fmtShort(w.date), v: w.weight }));
  const vals  = data.map(d => d.v);
  const lo    = Math.floor(Math.min(...vals) - 0.5);
  const hi    = Math.ceil(Math.max(...vals) + 0.5);
  return (
    <div style={{ marginTop: 6 }}>
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
          <Area type="monotone" dataKey="v" stroke={BRAND} strokeWidth={1.5}
            fill="url(#wGrad)" dot={{ r: 2, fill: BRAND }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── カロリー ──────────────────────────────────────────────────
function CaloriesValue({ intake, target, pct, remaining }) {
  const isOver = pct != null && pct > 100;
  const fill   = `progress-fill${isOver ? ' over' : pct > 75 ? ' warn' : ''}`;
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
  const over      = target && intake > target ? intake - target : 0;
  const consumed  = intake - over;
  const remaining = target ? Math.max(0, target - intake) : 0;
  const data = [
    { name: '摂取',     value: consumed,  fill: BRAND },
    { name: 'オーバー', value: over,       fill: '#dc2626' },
    { name: '残り',     value: remaining,  fill: '#e2e8f0' },
  ].filter(d => d.value > 0);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <ResponsiveContainer width={80} height={80}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={26} outerRadius={38}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.8 }}>
        <div><Dot color={BRAND} /> 摂取 {intake.toLocaleString()} kcal</div>
        {target && <div><Dot color="#e2e8f0" /> 残り {remaining.toLocaleString()} kcal</div>}
        {over > 0 && <div><Dot color="#dc2626" /> オーバー {over.toLocaleString()}</div>}
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <ResponsiveContainer width={80} height={80}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={26} outerRadius={38}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((_, i) => <Cell key={i} fill={PFC_COLORS[i]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.8 }}>
        <div><Dot color={PFC_COLORS[0]} /> P {p?.toFixed(1) ?? '—'}g</div>
        <div><Dot color={PFC_COLORS[1]} /> F {f?.toFixed(1) ?? '—'}g</div>
        <div><Dot color={PFC_COLORS[2]} /> C {c?.toFixed(1) ?? '—'}g</div>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <ResponsiveContainer width={80} height={80}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={26} outerRadius={38}
            dataKey="value" startAngle={90} endAngle={-270} strokeWidth={0}>
            {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, lineHeight: 1.8 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: BRAND, lineHeight: 1.2 }}>{pct}%</div>
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
    <div style={{ marginTop: 6 }}>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} formatter={(v, n) => [`${v}h`, n]} />
          <Bar dataKey="ディープ" stackId="a" fill="#1d4ed8" />
          <Bar dataKey="レム"     stackId="a" fill="#60a5fa" />
          <Bar dataKey="浅い"     stackId="a" fill="#bfdbfe" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      {score && <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2, textAlign: 'right' }}>スコア {score}</div>}
    </div>
  );
}

// ── 今日の予定（常時フルワイド・ソート対象外）────────────────
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

// ── 共通パーツ ────────────────────────────────────────────────
const tipStyle = { fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' };
function Dot({ color }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 4 }} />;
}
function EmptyGraph() {
  return <div style={{ color: 'var(--text-2)', fontSize: 12, padding: '10px 0' }}>データなし</div>;
}

// ── メインページ ─────────────────────────────────────────────
export default function DashboardPage() {
  const qc = useQueryClient();
  const [dateStr, setDateStr] = useState(todayStr);
  const isToday = dateStr === todayStr();

  // ウィジェット順序・グラフ表示状態（localStorage で永続化）
  const [order,  setOrder]  = useState(() => lsGet('db-order',  DEFAULT_ORDER));
  const [graphs, setGraphs] = useState(() => lsGet('db-graphs', {}));

  const toggleGraph = (id) => setGraphs(prev => {
    const next = { ...prev, [id]: !prev[id] };
    lsSet('db-graphs', next);
    return next;
  });

  // データ取得
  const { data: summary, isLoading } = useQuery({
    queryKey: ['dashboard', dateStr],
    queryFn: () => dashboardApi.today(dateStr).then(r => r.data),
  });
  const { data: weightHistory = [] } = useQuery({
    queryKey: ['weight-history', 7],
    queryFn: () => bodyApi.weightHistory(7).then(r => r.data),
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
    ? Math.max(0, Math.round(100 - Math.abs(latestW - goals.target_weight) / Math.abs((oldestW || latestW) - goals.target_weight) * 100))
    : null;

  const calIntake    = nut.kcal ? Math.round(nut.kcal) : null;
  const calTarget    = goals.target_kcal || null;
  const calPct       = calIntake && calTarget ? Math.round(calIntake / calTarget * 100) : null;
  const calRemaining = calIntake && calTarget ? Math.max(0, calTarget - calIntake) : null;

  // DnD（長押し 300ms でドラッグ開始）
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

  // ウィジェット定義マップ
  const widgetMap = {
    weight: (
      <WidgetShell key="weight" id="weight" Icon={Scale} title="体重"
        showGraph={!!graphs.weight} onToggle={() => toggleGraph('weight')}
        valueContent={<WeightValue latest={latestW} delta={wDelta} pct={wPct} />}
        graphContent={<WeightGraph history={weightHistory} />}
      />
    ),
    calories: (
      <WidgetShell key="calories" id="calories" Icon={Flame} title="カロリー"
        showGraph={!!graphs.calories} onToggle={() => toggleGraph('calories')}
        valueContent={<CaloriesValue intake={calIntake} target={calTarget} pct={calPct} remaining={calRemaining} />}
        graphContent={<CaloriesGraph intake={calIntake} target={calTarget} />}
      />
    ),
    pfc: (
      <WidgetShell key="pfc" id="pfc" Icon={Layers} title="PFC"
        showGraph={!!graphs.pfc} onToggle={() => toggleGraph('pfc')}
        valueContent={<PFCValue p={nut.protein_g} f={nut.fat_g} c={nut.carb_g} />}
        graphContent={<PFCGraph p={nut.protein_g} f={nut.fat_g} c={nut.carb_g} />}
      />
    ),
    steps: (
      <WidgetShell key="steps" id="steps" Icon={Footprints} title="歩数"
        showGraph={!!graphs.steps} onToggle={() => toggleGraph('steps')}
        valueContent={<StepsValue steps={summary?.steps} />}
        graphContent={<StepsGraph steps={summary?.steps} />}
      />
    ),
    sleep: (
      <WidgetShell key="sleep" id="sleep" Icon={Moon} title="睡眠"
        showGraph={!!graphs.sleep} onToggle={() => toggleGraph('sleep')}
        valueContent={<SleepValue hours={summary?.sleep_hours} score={summary?.sleep_score} />}
        graphContent={<SleepGraph hours={summary?.sleep_hours} score={summary?.sleep_score} />}
      />
    ),
  };

  return (
    <div>
      {/* ヘッダー */}
      <div className="page-header">
        <h1 className="page-title">ダッシュボード</h1>
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

      {/* 日付ナビゲーション */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 'var(--sp-4)' }}>
        <button className="btn-ghost" style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(d => offsetDate(d, -1))}>
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>
        <button
          className="btn-ghost"
          style={{ padding: '5px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, minWidth: 140, textAlign: 'center', color: isToday ? 'var(--brand)' : 'var(--text)' }}
          onClick={() => setDateStr(todayStr())}
          title="今日に戻る"
        >
          {isToday ? '今日 · ' : ''}{fmtDate(dateStr)}
        </button>
        <button className="btn-ghost" style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(d => offsetDate(d, 1))} disabled={isToday}>
          <ChevronRight size={18} strokeWidth={1.8} style={{ opacity: isToday ? 0.3 : 1 }} />
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
          {/* ソート可能なウィジェットグリッド */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={order} strategy={rectSortingStrategy}>
              <div className="widget-grid">
                {order.map(id => widgetMap[id]).filter(Boolean)}
              </div>
            </SortableContext>
          </DndContext>

          {/* 今日の予定（フルワイド固定） */}
          <ScheduleCard cal={cal} />

          {/* 今週の献立へ */}
          <Link to="/plan" className="btn btn-secondary btn-full"
            style={{ marginTop: 'var(--sp-2)', textDecoration: 'none' }}>
            今週の献立を確認する
          </Link>
        </>
      )}
    </div>
  );
}
