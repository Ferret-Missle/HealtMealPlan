import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShoppingBag, ExternalLink, CheckCheck, RotateCcw } from 'lucide-react';
import { mealPlanApi } from '../services/api';

function recipeSearchUrl(foodName) {
  return `https://www.google.com/search?q=${encodeURIComponent(foodName + ' レシピ')}`;
}

export default function ShoppingListPage() {
  const [checked, setChecked] = useState(new Set());

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['meal-plans'],
    queryFn: () => mealPlanApi.list(),
  });

  // 最新の確定済みプランを使用
  const activePlan = plans.find(p => p.status === 'confirmed') || plans[0];

  const { data: planDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['meal-plan-detail', activePlan?.id],
    queryFn: () => mealPlanApi.get(activePlan.id),
    enabled: !!activePlan?.id,
  });

  const toggle = (id) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const resetAll = () => setChecked(new Set());

  // プランのアイテムをフラットに展開
  const items = planDetail?.slots?.flatMap(slot =>
    slot.items?.map(item => ({
      id: `${slot.id}-${item.id}`,
      name: item.food_name,
      meal: slot.meal_type_label || slot.meal_type,
      grams: item.serving_grams,
      kcal: item.kcal,
    })) || []
  ) || [];

  const checkedCount = items.filter(i => checked.has(i.id)).length;

  if (isLoading || detailLoading) {
    return <div className="loading-screen"><div className="spinner" /></div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">リスト</h1>
        {items.length > 0 && checked.size > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={resetAll}>
            <RotateCcw size={13} strokeWidth={2} />
            リセット
          </button>
        )}
      </div>

      {!activePlan ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--sp-10)' }}>
          <ShoppingBag size={40} strokeWidth={1.2} style={{ color: 'var(--text-3)', margin: '0 auto var(--sp-4)' }} />
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
            プランがありません
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 'var(--sp-4)' }}>
            「プラン」タブでAI献立を生成すると<br />買い物リストが自動作成されます
          </p>
          <a href="/plan" className="btn btn-primary" style={{ display: 'inline-flex' }}>
            プランを作成する
          </a>
        </div>
      ) : (
        <>
          {/* Progress summary */}
          {items.length > 0 && (
            <div className="card" style={{ marginBottom: 'var(--sp-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 2 }}>買い物進捗</div>
                  <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em' }}>
                    {checkedCount}
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginLeft: 3 }}>/ {items.length} 品</span>
                  </div>
                </div>
                {checkedCount === items.length && items.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--brand-text)', fontWeight: 600, fontSize: 13 }}>
                    <CheckCheck size={18} strokeWidth={2} />
                    完了！
                  </div>
                )}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${items.length > 0 ? (checkedCount / items.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          {/* Plan title */}
          <div className="section-title">
            {activePlan.title || activePlan.week_start_date + ' の献立'}
          </div>

          {/* Shopping items */}
          <div className="card">
            {items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--sp-8)', color: 'var(--text-2)', fontSize: 13 }}>
                アイテムがありません
              </div>
            ) : (
              items.map((item) => {
                const done = checked.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={`shop-item${done ? ' checked' : ''}`}
                    onClick={() => toggle(item.id)}
                  >
                    <div className="shop-item-check">
                      {done && <CheckCheck size={13} strokeWidth={3} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="shop-item-name">{item.name}</div>
                      <div className="shop-item-meta">
                        {item.meal}
                        {item.grams ? ` · ${item.grams}g` : ''}
                        {item.kcal ? ` · ${Math.round(item.kcal)}kcal` : ''}
                      </div>
                    </div>
                    <a
                      href={recipeSearchUrl(item.name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="recipe-link"
                      onClick={e => e.stopPropagation()}
                    >
                      レシピ
                      <ExternalLink size={10} strokeWidth={2.5} />
                    </a>
                  </div>
                );
              })
            )}
          </div>

          {/* Hint */}
          <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', marginTop: 'var(--sp-4)', lineHeight: 1.6 }}>
            「レシピ」をタップするとGoogleで検索します<br />
            チェックはこのセッション中のみ保持されます
          </div>
        </>
      )}
    </div>
  );
}
