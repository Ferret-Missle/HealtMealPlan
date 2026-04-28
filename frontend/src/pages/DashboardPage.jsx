import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dashboardApi, bodyApi } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import MetricCard from '../components/MetricCard';
import PFCChart from '../components/PFCChart';
import { Link } from 'react-router-dom';

// S2-09: 運動予定（カレンダー）vs 実績（Fitbit）比較
function ExerciseComparisonPanel() {
  const [show, setShow] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['exercise-comparison'],
    queryFn: () => dashboardApi.exerciseComparison(7).then(r => r.data.comparison),
    enabled: show,
  });

  if (!show) {
    return (
      <button className="btn btn-outline btn-full" style={{ marginBottom: 8 }} onClick={() => setShow(true)}>
        💪 運動予定 vs 実績を確認（7日間）
      </button>
    );
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>💪 運動予定 vs 実績</div>
        <button className="btn-icon" onClick={() => setShow(false)}>✕</button>
      </div>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 12 }}>読込中...</div>
      ) : (data || []).map((d, i) => (
        <div key={i} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{d.date}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {d.planned_exercises?.length > 0
              ? `予定: ${d.planned_exercises.map(e => e.category).join(', ')}`
              : '予定なし'}
          </div>
          <div style={{ fontSize: 12 }}>
            実績: {d.actual_steps ? `${d.actual_steps.toLocaleString()} 歩` : '—'}
            {d.actual_active_kcal ? ` / ${d.actual_active_kcal} kcal` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function fmt(date) {
  return date.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [date, setDate] = useState(new Date());

  const { data: summary, isLoading } = useQuery({
    queryKey: ['dashboard', isoDate(date)],
    queryFn: () => dashboardApi.today(isoDate(date)).then((r) => r.data),
  });

  const syncMutation = useMutation({
    mutationFn: () => bodyApi.sync(isoDate(date)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard'] }),
  });

  const prev = () => setDate((d) => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
  const next = () => setDate((d) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });

  const isToday = isoDate(date) === isoDate(new Date());
  const nut = summary?.nutrition || {};
  const goals = summary?.goals || {};
  const cal = summary?.calendar || {};

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">🏠 ホーム</h1>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: '6px 12px' }}
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? '同期中...' : '今すぐ同期'}
        </button>
      </div>

      {/* Date navigation */}
      <div className="date-nav">
        <button onClick={prev}>‹</button>
        <span className="date-display">{fmt(date)}</span>
        <button onClick={next} disabled={isToday}>›</button>
      </div>

      {/* Connection banner */}
      {summary?.connected_services?.length === 0 && (
        <div className="alert" style={{ background: '#fff3e0', color: '#e65100', marginBottom: 12 }}>
          外部サービスが未連携です。
          <Link to="/settings" style={{ color: '#bf360c', fontWeight: 600 }}>設定</Link>から連携してください。
        </div>
      )}

      {isLoading ? (
        <div className="loading-screen" style={{ minHeight: 200 }}>
          <div className="spinner" />
        </div>
      ) : (
        <>
          {/* Key metrics grid — grid-2 collapses to 1-col on xs */}
          <div className="grid-2">
            <MetricCard
              title="体重"
              value={summary?.weight}
              unit="kg"
              goal={goals.target_weight}
              icon="⚖️"
            />
            <MetricCard
              title="歩数"
              value={summary?.steps?.toLocaleString()}
              goal={10000}
              icon="👟"
              color="var(--primary)"
            />
            <MetricCard
              title="摂取カロリー"
              value={nut.kcal ? Math.round(nut.kcal) : null}
              unit="kcal"
              goal={goals.target_kcal}
              icon="🔥"
            />
            <MetricCard
              title="睡眠時間"
              value={summary?.sleep_hours}
              unit="時間"
              goal={7}
              icon="😴"
            />
          </div>

          {/* PFC balance */}
          {(nut.protein_g > 0 || nut.fat_g > 0 || nut.carb_g > 0) && (
            <div className="card">
              <div className="card-title">PFCバランス</div>
              <PFCChart
                protein={nut.protein_g}
                fat={nut.fat_g}
                carb={nut.carb_g}
              />
            </div>
          )}

          {/* Calorie progress */}
          {goals.target_kcal && (
            <div className="card">
              <div className="card-title">カロリー摂取進捗</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span>{Math.round(nut.kcal || 0)} kcal 摂取</span>
                <span>目標: {goals.target_kcal} kcal</span>
              </div>
              <div className="progress-bar-wrap">
                <div
                  className={`progress-bar-fill${(nut.kcal || 0) > goals.target_kcal ? ' over' : ''}`}
                  style={{ width: `${Math.min(100, Math.round(((nut.kcal || 0) / goals.target_kcal) * 100))}%` }}
                />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                残り: {Math.max(0, goals.target_kcal - (nut.kcal || 0)).toFixed(0)} kcal
              </div>
            </div>
          )}

          {/* Today's schedule from calendar */}
          {(cal.meal_events?.length > 0 || cal.exercise_events?.length > 0) && (
            <div className="card">
              <div className="card-title">📅 今日の予定</div>
              {cal.meal_events?.map((ev, i) => (
                <div key={i} className="list-item">
                  <span>🍽️ {ev.category}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {ev.time ? new Date(ev.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              ))}
              {cal.exercise_events?.map((ev, i) => (
                <div key={i} className="list-item">
                  <span>💪 {ev.category}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {ev.time ? new Date(ev.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Active calories */}
          {summary?.active_kcal != null && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div className="card-title">消費カロリー（活動）</div>
                  <span className="metric-value">{summary.active_kcal}</span>
                  <span className="metric-unit">kcal</span>
                </div>
                {summary.sleep_score != null && (
                  <div style={{ textAlign: 'right' }}>
                    <div className="card-title">睡眠スコア</div>
                    <span className="metric-value" style={{ fontSize: 22 }}>{summary.sleep_score}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* S2-09: 運動比較パネル */}
          <ExerciseComparisonPanel />

          {/* Quick links */}
          <div className="grid-2" style={{ marginTop: 4 }}>
            <Link to="/meals" className="btn btn-secondary btn-full" style={{ textDecoration: 'none' }}>
              🍽️ 食事を記録
            </Link>
            <Link to="/meal-plan" className="btn btn-secondary btn-full" style={{ textDecoration: 'none' }}>
              📋 献立を見る
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
