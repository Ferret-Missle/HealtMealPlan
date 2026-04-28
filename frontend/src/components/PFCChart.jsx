import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

export default function PFCChart({ protein, fat, carb, size = 120 }) {
  const total = protein + fat + carb || 1;

  const data = {
    labels: ['タンパク質', '脂質', '炭水化物'],
    datasets: [
      {
        data: [protein || 0, fat || 0, carb || 0],
        backgroundColor: ['#e53935', '#fb8c00', '#43a047'],
        borderWidth: 0,
      },
    ],
  };

  const options = {
    cutout: '65%',
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    responsive: false,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Doughnut data={data} options={options} width={size} height={size} />
      <div style={{ fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#e53935', display: 'inline-block' }} />
          <span>P: <strong className="pfc-p">{protein?.toFixed(1) ?? 0}g</strong></span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>({Math.round((protein * 4 / total / 4) * 100 / (total / 9))}%)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fb8c00', display: 'inline-block' }} />
          <span>F: <strong className="pfc-f">{fat?.toFixed(1) ?? 0}g</strong></span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#43a047', display: 'inline-block' }} />
          <span>C: <strong className="pfc-c">{carb?.toFixed(1) ?? 0}g</strong></span>
        </div>
      </div>
    </div>
  );
}
