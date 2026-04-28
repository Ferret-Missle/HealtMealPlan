import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { bodyApi, dashboardApi } from '../services/api';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export default function BodyWeightPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], weight: '', body_fat: '', muscle_mass: '' });
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [goalForm, setGoalForm] = useState({ target_weight: '', target_kcal: '', goal_type: 'loss', deadline: '' });

  const [activeTab, setActiveTab] = useState('weight'); // 'weight' | 'sleep'

  const { data: history = [] } = useQuery({
    queryKey: ['weight-history', days],
    queryFn: () => bodyApi.weightHistory(days).then((r) => r.data),
  });

  // S2-08: 睡眠データ
  const { data: sleepData } = useQuery({
    queryKey: ['sleep-history', days],
    queryFn: () => dashboardApi.sleep(days).then(r => r.data.sleep),
    enabled: activeTab === 'sleep',
  });

  const { data: goals } = useQuery({
    queryKey: ['goals'],
    queryFn: () => bodyApi.goals().then((r) => r.data),
    onSuccess: (d) => setGoalForm((f) => ({
      ...f,
      target_weight: d.target_weight || '',
      target_kcal: d.target_kcal || '',
      goal_type: d.goal_type || 'loss',
      deadline: d.deadline ? d.deadline.split('T')[0] : '',
    })),
  });

  const addMutation = useMutation({
    mutationFn: (data) => bodyApi.addWeight(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['weight-history'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setShowForm(false);
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => bodyApi.sync(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['weight-history'] }),
  });

  const goalMutation = useMutation({
    mutationFn: (data) => bodyApi.updateGoals(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
      setShowGoalForm(false);
    },
  });

  const latest = history[history.length - 1];
  const earliest = history[0];
  const weightChange = latest && earliest && latest.weight && earliest.weight
    ? (latest.weight - earliest.weight).toFixed(1)
    : null;

  // Chart data
  const chartData = {
    labels: history.map((h) => {
      const d = new Date(h.date);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }),
    datasets: [
      {
        label: '体重 (kg)',
        data: history.map((h) => h.weight),
        borderColor: '#4caf50',
        backgroundColor: 'rgba(76,175,80,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      },
    ],
  };

  const bodyFatData = history.some((h) => h.body_fat) ? {
    labels: chartData.labels,
    datasets: [{
      label: '体脂肪率 (%)',
      data: history.map((h) => h.body_fat),
      borderColor: '#ff7043',
      backgroundColor: 'rgba(255,112,67,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 3,
    }],
  } : null;

  const chartOptions = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: false } },
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setGoal = (key) => (e) => setGoalForm((f) => ({ ...f, [key]: e.target.value }));

  const handleAdd = (e) => {
    e.preventDefault();
    addMutation.mutate({
      date: form.date,
      weight: parseFloat(form.weight),
      body_fat: form.body_fat ? parseFloat(form.body_fat) : undefined,
      muscle_mass: form.muscle_mass ? parseFloat(form.muscle_mass) : undefined,
      source: 'manual',
    });
  };

  const handleGoal = (e) => {
    e.preventDefault();
    goalMutation.mutate({
      target_weight: goalForm.target_weight ? parseFloat(goalForm.target_weight) : undefined,
      target_kcal: goalForm.target_kcal ? parseInt(goalForm.target_kcal) : undefined,
      goal_type: goalForm.goal_type,
      deadline: goalForm.deadline || undefined,
    });
  };

  // Sleep chart data
  const sleepLabels = (sleepData || []).map(s => {
    const d = new Date(s.date);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  const sleepChartData = {
    labels: sleepLabels,
    datasets: [
      {
        label: '睡眠時間 (h)',
        data: (sleepData || []).map(s => s.sleep_hours),
        borderColor: '#5c6bc0',
        backgroundColor: 'rgba(92,107,192,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        yAxisID: 'y',
      },
      {
        label: '睡眠スコア',
        data: (sleepData || []).map(s => s.sleep_score),
        borderColor: '#26a69a',
        backgroundColor: 'rgba(38,166,154,0.05)',
        fill: false,
        tension: 0.3,
        pointRadius: 3,
        yAxisID: 'y1',
      },
    ],
  };

  const sleepChartOptions = {
    responsive: true,
    plugins: { legend: { display: true, position: 'top' } },
    scales: {
      y: { beginAtZero: false, title: { display: true, text: '睡眠時間 (h)' } },
      y1: { beginAtZero: false, position: 'right', title: { display: true, text: 'スコア' }, grid: { drawOnChartArea: false } },
    },
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">⚖️ 体重・体組成</h1>
        <button className="btn btn-secondary" style={{ fontSize: 12, padding: '6px 12px' }}
          onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
          {syncMutation.isPending ? '同期中...' : '同期'}
        </button>
      </div>

      {/* Tab selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          className={`btn ${activeTab === 'weight' ? 'btn-primary' : 'btn-outline'}`}
          style={{ flex: 1 }}
          onClick={() => setActiveTab('weight')}
        >⚖️ 体重</button>
        <button
          className={`btn ${activeTab === 'sleep' ? 'btn-primary' : 'btn-outline'}`}
          style={{ flex: 1 }}
          onClick={() => setActiveTab('sleep')}
        >💤 睡眠</button>
      </div>

      {/* Sleep tab (S2-08) */}
      {activeTab === 'sleep' && (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="card-title" style={{ marginBottom: 0 }}>💤 睡眠データ</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[7, 14, 30].map(d => (
                  <button key={d} className={`btn ${days === d ? 'btn-primary' : 'btn-outline'}`} style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => setDays(d)}>{d}日</button>
                ))}
              </div>
            </div>
            {sleepData?.length ? (
              <Line data={sleepChartData} options={sleepChartOptions} />
            ) : (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 13 }}>
                睡眠データがありません。Fitbitを連携してください。
              </div>
            )}
          </div>
          {sleepData && sleepData.length > 0 && (
            <div className="card">
              <div className="card-title">直近の睡眠記録</div>
              {[...sleepData].reverse().slice(0, 7).map(s => (
                <div key={s.date} className="list-item">
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{s.date}</span>
                  <div style={{ textAlign: 'right' }}>
                    {s.sleep_hours ? <span style={{ fontWeight: 600 }}>{s.sleep_hours.toFixed(1)}h</span> : <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>—</span>}
                    {s.sleep_score && <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>スコア {s.sleep_score}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Weight tab */}
      {activeTab === 'weight' && latest && (
        <div className="card">
          <div className="grid-2">
            <div>
              <div className="card-title">現在の体重</div>
              <span className="metric-value">{latest.weight ?? '—'}</span>
              <span className="metric-unit">kg</span>
              {weightChange !== null && (
                <div style={{ fontSize: 12, color: parseFloat(weightChange) < 0 ? 'var(--primary)' : 'var(--accent)', marginTop: 4 }}>
                  {parseFloat(weightChange) < 0 ? '▼' : '▲'} {Math.abs(weightChange)} kg ({days}日間)
                </div>
              )}
            </div>
            <div>
              <div className="card-title">目標体重</div>
              <span className="metric-value" style={{ fontSize: 22 }}>{goals?.target_weight ?? '—'}</span>
              <span className="metric-unit">kg</span>
              {goals?.target_weight && latest.weight && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  あと {Math.abs(latest.weight - goals.target_weight).toFixed(1)} kg
                </div>
              )}
            </div>
          </div>
          {(latest.body_fat || latest.muscle_mass || latest.bmi) && (
            <div className="grid-3" style={{ marginTop: 12 }}>
              {latest.body_fat && (
                <div>
                  <div className="card-title">体脂肪率</div>
                  <span style={{ fontSize: 18, fontWeight: 700 }}>{latest.body_fat}</span>
                  <span className="metric-unit">%</span>
                </div>
              )}
              {latest.muscle_mass && (
                <div>
                  <div className="card-title">筋肉量</div>
                  <span style={{ fontSize: 18, fontWeight: 700 }}>{latest.muscle_mass}</span>
                  <span className="metric-unit">kg</span>
                </div>
              )}
              {latest.bmi && (
                <div>
                  <div className="card-title">BMI</div>
                  <span style={{ fontSize: 18, fontWeight: 700 }}>{latest.bmi}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'weight' && (
        <>
          {/* Action buttons */}
          <div className="grid-2" style={{ marginBottom: 12 }}>
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>+ 記録する</button>
            <button className="btn btn-outline" onClick={() => setShowGoalForm(true)}>🎯 目標設定</button>
          </div>

          {/* Period selector */}
          <div className="period-selector">
            {[7, 14, 30, 90].map((d) => (
              <button
                key={d}
                className={`btn ${days === d ? 'btn-primary' : 'btn-outline'} btn-period`}
                onClick={() => setDays(d)}
              >
                {d}日
              </button>
            ))}
          </div>

          {/* Weight chart */}
          {history.length > 1 && (
            <div className="card">
              <div className="card-title">体重推移</div>
              <Line data={chartData} options={chartOptions} />
            </div>
          )}

          {/* Body fat chart */}
          {bodyFatData && history.length > 1 && (
            <div className="card">
              <div className="card-title">体脂肪率推移</div>
              <Line data={bodyFatData} options={{ ...chartOptions, scales: { y: { beginAtZero: false, max: 50 } } }} />
            </div>
          )}

          {/* History list */}
          {history.length > 0 && (
            <div className="card">
              <div className="card-title">記録履歴</div>
              {[...history].reverse().slice(0, 10).map((log) => (
                <div key={log.id} className="list-item">
                  <span style={{ fontSize: 14 }}>{log.date}</span>
                  <div style={{ textAlign: 'right', fontSize: 13 }}>
                    <strong>{log.weight} kg</strong>
                    {log.body_fat && <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>{log.body_fat}%</span>}
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11, marginLeft: 6 }}>[{log.source}]</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Add weight modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ background: 'white', width: '100%', borderRadius: '16px 16px 0 0', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3>体重を記録</h3>
              <button style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }} onClick={() => setShowForm(false)}>×</button>
            </div>
            <form onSubmit={handleAdd}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">日付</label>
                  <input type="date" className="form-input" value={form.date} onChange={set('date')} required />
                </div>
                <div className="form-group">
                  <label className="form-label">体重 (kg) *</label>
                  <input type="number" className="form-input" value={form.weight} onChange={set('weight')} required step="0.1" min="20" max="300" />
                </div>
                <div className="form-group">
                  <label className="form-label">体脂肪率 (%)</label>
                  <input type="number" className="form-input" value={form.body_fat} onChange={set('body_fat')} step="0.1" min="1" max="70" />
                </div>
                <div className="form-group">
                  <label className="form-label">筋肉量 (kg)</label>
                  <input type="number" className="form-input" value={form.muscle_mass} onChange={set('muscle_mass')} step="0.1" min="1" max="100" />
                </div>
              </div>
              <button type="submit" className="btn btn-primary btn-full" disabled={addMutation.isPending}>
                {addMutation.isPending ? '保存中...' : '記録する'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Goal setting modal */}
      {showGoalForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ background: 'white', width: '100%', borderRadius: '16px 16px 0 0', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3>🎯 目標設定</h3>
              <button style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }} onClick={() => setShowGoalForm(false)}>×</button>
            </div>
            <form onSubmit={handleGoal}>
              <div className="form-group">
                <label className="form-label">目的</label>
                <select className="form-input" value={goalForm.goal_type} onChange={setGoal('goal_type')}>
                  <option value="loss">減量</option>
                  <option value="maintain">維持</option>
                  <option value="gain">増量</option>
                </select>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">目標体重 (kg)</label>
                  <input type="number" className="form-input" value={goalForm.target_weight} onChange={setGoal('target_weight')} step="0.1" min="20" max="300" />
                </div>
                <div className="form-group">
                  <label className="form-label">目標カロリー (kcal)</label>
                  <input type="number" className="form-input" value={goalForm.target_kcal} onChange={setGoal('target_kcal')} min="800" max="5000" />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">達成期限</label>
                <input type="date" className="form-input" value={goalForm.deadline} onChange={setGoal('deadline')} />
              </div>
              <button type="submit" className="btn btn-primary btn-full" disabled={goalMutation.isPending}>
                {goalMutation.isPending ? '保存中...' : '目標を保存'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
