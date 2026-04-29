import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Scale, Flame, Footprints, Moon,
  RefreshCw, Utensils, Dumbbell,
  CalendarClock, ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { dashboardApi, bodyApi } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import PFCChart from '../components/PFCChart';
import { Link } from 'react-router-dom';

// ── 日付ユーティリティ ────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }
function offsetDate(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function fmtDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('ja-JP', {
    month: 'long', day: 'numeric', weekday: 'short',
  });
}

// ── コンパクト指標ウィジェット ───────────────────────────────
function Widget({ Icon, label, value, unit, sub, pct, warnOver }) {
  const isOver = pct != null && pct > 100;
  const fillClass = `progress-fill${isOver ? ' over' : warnOver && pct > 75 ? ' warn' : ''}`;

  return (
    <div className="widget-card">
      <div className="widget-header">
        <span className="widget-label">
          <Icon size={12} strokeWidth={1.8} />
          {label}
        </span>
      </div>
      <div style={{ lineHeight: 1.1, marginTop: 2 }}>
        <span className="widget-value">{value ?? '—'}</span>
        {unit && <span className="widget-unit">{unit}</span>}
      </div>
      {sub && <div className="widget-sub">{sub}</div>}
      {pct != null && (
        <div className="progress-bar" style={{ marginTop: 6 }}>
          <div className={fillClass} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </div>
  );
}

// ── 運動予定 vs 実績（折りたたみ）───────────────────────────
function ExercisePanel() {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['exercise-comparison'],
    queryFn: () => dashboardApi.exerciseComparison(7).then(r => r.data.comparison),
    enabled: open,
  });

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        className="btn-ghost"
        style={{ width: '100%', padding: 'var(--sp-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 0 }}
        onClick={() => setOpen(v => !v)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          <Dumbbell size={14} strokeWidth={1.8} style={{ color: 'var(--text-2)' }} />
          運動予定 vs 実績（7日間）
        </span>
        {open
          ? <ChevronUp size={16} strokeWidth={2} style={{ color: 'var(--text-2)' }} />
          : <ChevronDown size={16} strokeWidth={2} style={{ color: 'var(--text-2)' }} />}
      </button>

      {open && (
        <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-2)', fontSize: 13 }}>読込中…</div>
          ) : (data || []).length === 0 ? (
            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>データがありません</div>
          ) : (data || []).map((d, i) => (
            <div key={i} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{d.date}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {d.planned_exercises?.length > 0
                  ? `予定: ${d.planned_exercises.map(e => e.category).join(', ')}`
                  : '予定なし'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                実績: {d.actual_steps ? `${d.actual_steps.toLocaleString()} 歩` : '—'}
                {d.actual_active_kcal ? ` · ${d.actual_active_kcal} kcal` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── メインページ ─────────────────────────────────────────────
export default function DashboardPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [dateStr, setDateStr] = useState(todayStr);
  const isToday = dateStr === todayStr();

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

  const nut   = summary?.nutrition || {};
  const goals = summary?.goals    || {};
  const cal   = summary?.calendar  || {};

  // 体重
  const latestWeight  = weightHistory.at(-1)?.weight ?? summary?.weight;
  const oldestWeight  = weightHistory[0]?.weight;
  const weightDelta   = latestWeight && oldestWeight && latestWeight !== oldestWeight
    ? (latestWeight - oldestWeight).toFixed(1)
    : null;
  const weightPct     = goals.target_weight && latestWeight && oldestWeight
    ? Math.max(0, Math.round(100 - Math.abs(latestWeight - goals.target_weight) / Math.abs((oldestWeight || latestWeight) - goals.target_weight) * 100))
    : null;

  // カロリー
  const calIntake    = nut.kcal ? Math.round(nut.kcal) : null;
  const calTarget    = goals.target_kcal || null;
  const calPct       = calIntake && calTarget ? Math.round(calIntake / calTarget * 100) : null;
  const calRemaining = calIntake && calTarget ? Math.max(0, calTarget - calIntake) : null;

  // 歩数
  const stepGoal = 10000;
  const stepPct  = summary?.steps ? Math.round(summary.steps / stepGoal * 100) : null;

  const hasPFC      = nut.protein_g > 0 || nut.fat_g > 0 || nut.carb_g > 0;
  const hasSchedule = cal.meal_events?.length > 0 || cal.exercise_events?.length > 0;

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
          <RefreshCw
            size={13} strokeWidth={2}
            style={syncMutation.isPending ? { animation: 'spin 0.65s linear infinite' } : {}}
          />
          {syncMutation.isPending ? '同期中…' : '同期'}
        </button>
      </div>

      {/* 日付ナビゲーション */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, marginBottom: 'var(--sp-4)',
      }}>
        <button
          className="btn-ghost"
          style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(d => offsetDate(d, -1))}
        >
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>

        <button
          className="btn-ghost"
          style={{
            padding: '5px 14px', borderRadius: 20,
            fontSize: 13, fontWeight: 600, minWidth: 140, textAlign: 'center',
            color: isToday ? 'var(--brand)' : 'var(--text)',
          }}
          onClick={() => setDateStr(todayStr())}
          title="今日に戻る"
        >
          {isToday ? '今日 · ' : ''}{fmtDate(dateStr)}
        </button>

        <button
          className="btn-ghost"
          style={{ padding: '6px 10px', borderRadius: 8 }}
          onClick={() => setDateStr(d => offsetDate(d, 1))}
          disabled={isToday}
        >
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
          {/* 4指標ウィジェット */}
          <div className="widget-grid">
            <Widget
              Icon={Scale}
              label="体重"
              value={latestWeight}
              unit="kg"
              sub={
                weightDelta
                  ? `${parseFloat(weightDelta) < 0 ? '▼' : '▲'} ${Math.abs(weightDelta)} kg (7日間)`
                  : goals.target_weight
                    ? `目標 ${goals.target_weight} kg`
                    : undefined
              }
              pct={weightPct}
            />
            <Widget
              Icon={Flame}
              label="カロリー"
              value={calIntake?.toLocaleString()}
              unit="kcal"
              sub={
                calRemaining != null
                  ? `残り ${calRemaining.toLocaleString()}`
                  : calTarget
                    ? `目標 ${calTarget.toLocaleString()}`
                    : undefined
              }
              pct={calPct}
              warnOver
            />
            <Widget
              Icon={Footprints}
              label="歩数"
              value={summary?.steps?.toLocaleString()}
              sub={`目標 ${stepGoal.toLocaleString()}`}
              pct={stepPct}
            />
            <Widget
              Icon={Moon}
              label="睡眠"
              value={summary?.sleep_hours?.toFixed(1)}
              unit="h"
              sub={
                summary?.sleep_score
                  ? `スコア ${summary.sleep_score}`
                  : '目標 7 時間'
              }
            />
          </div>

          {/* PFC バランス */}
          {hasPFC && (
            <div className="card">
              <div className="card-title">PFC バランス</div>
              <PFCChart
                protein={nut.protein_g}
                fat={nut.fat_g}
                carb={nut.carb_g}
                size={96}
              />
            </div>
          )}

          {/* 今日の予定 */}
          {hasSchedule && (
            <div className="card">
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <CalendarClock size={12} strokeWidth={2} />
                今日の予定
              </div>
              {cal.meal_events?.map((ev, i) => (
                <div key={i} className="list-item">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Utensils size={14} strokeWidth={1.5} style={{ color: 'var(--text-2)' }} />
                    <span style={{ fontSize: 14 }}>{ev.category}</span>
                  </div>
                  {ev.time && (
                    <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                      {new Date(ev.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              ))}
              {cal.exercise_events?.map((ev, i) => (
                <div key={i} className="list-item">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Dumbbell size={14} strokeWidth={1.5} style={{ color: 'var(--text-2)' }} />
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
          )}

          {/* 運動比較（折りたたみ） */}
          <ExercisePanel />

          {/* 今週の献立へ */}
          <Link
            to="/plan"
            className="btn btn-secondary btn-full"
            style={{ marginTop: 'var(--sp-2)', textDecoration: 'none' }}
          >
            今週の献立を確認する
          </Link>
        </>
      )}
    </div>
  );
}
