export default function MetricCard({ title, value, unit, goal, icon, color }) {
  const pct = goal && value != null ? Math.min(100, Math.round((value / goal) * 100)) : null;
  const over = pct != null && pct > 100;

  return (
    <div className="card" style={{ position: 'relative' }}>
      <div className="card-title">{icon && <span style={{ marginRight: 4 }}>{icon}</span>}{title}</div>
      <div>
        <span className="metric-value" style={color ? { color } : {}}>{value ?? '—'}</span>
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {goal != null && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          目標: {goal}{unit}
        </div>
      )}
      {pct != null && (
        <div className="progress-bar-wrap">
          <div className={`progress-bar-fill${over ? ' over' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </div>
  );
}
