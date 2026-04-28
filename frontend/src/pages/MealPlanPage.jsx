import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mealPlanApi, shoppingApi } from '../services/api';

const MEAL_JP = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };

// T-11: スロット編集パネル
function SlotEditPanel({ planId, slot, onClose, onUpdated }) {
  const qc = useQueryClient();
  const [sharingType, setSharingType] = useState(slot.sharing_type);
  const [isDiningOut, setIsDiningOut] = useState(slot.is_dining_out || false);
  const [diningOutKcal, setDiningOutKcal] = useState(slot.dining_out_kcal || '');
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await mealPlanApi.updateSlot(planId, slot.id, {
        sharing_type: sharingType,
        is_dining_out: isDiningOut,
        dining_out_kcal: isDiningOut && diningOutKcal ? parseFloat(diningOutKcal) : null,
      });
      qc.invalidateQueries({ queryKey: ['meal-plan', planId] });
      onUpdated?.();
      onClose();
    } catch (e) {
      alert('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const handleReplace = async () => {
    setReplacing(true);
    try {
      await mealPlanApi.replaceSlot(planId, slot.id, {});
      qc.invalidateQueries({ queryKey: ['meal-plan', planId] });
      onClose();
    } catch (e) {
      alert(e.response?.data?.detail || 'メニュー差し替えに失敗しました');
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>✏️ {MEAL_JP[slot.meal_type]} を編集</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        {/* 共有/個別切り替え */}
        <div className="form-group">
          <label className="form-label">共有 / 個別</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn ${sharingType === 'shared' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSharingType('shared')}
            >共有食</button>
            <button
              className={`btn ${sharingType === 'individual' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSharingType('individual')}
            >個別食</button>
          </div>
        </div>

        {/* 外食への変更 */}
        <div className="form-group">
          <label className="form-label">
            <input
              type="checkbox"
              checked={isDiningOut}
              onChange={e => setIsDiningOut(e.target.checked)}
              style={{ marginRight: 8 }}
            />
            外食に変更
          </label>
          {isDiningOut && (
            <input
              type="number"
              className="form-input"
              placeholder="外食カロリー（目安 kcal）"
              value={diningOutKcal}
              onChange={e => setDiningOutKcal(e.target.value)}
              min="0"
              style={{ marginTop: 8 }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleReplace} disabled={replacing}>
            {replacing ? 'AI再提案中...' : '🔄 メニューをAI差し替え'}
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MealPlanPage() {
  const qc = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showShopping, setShowShopping] = useState(false);
  const [editingSlot, setEditingSlot] = useState(null);  // { slot, planId }
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState('');

  const { data: plans = [] } = useQuery({
    queryKey: ['meal-plans'],
    queryFn: () => mealPlanApi.list(),
  });

  const { data: planDetail } = useQuery({
    queryKey: ['meal-plan', selectedPlan],
    queryFn: () => mealPlanApi.get(selectedPlan),
    enabled: !!selectedPlan,
  });

  const { data: shopping } = useQuery({
    queryKey: ['shopping', selectedPlan],
    queryFn: () => shoppingApi.get(selectedPlan),
    enabled: !!selectedPlan && showShopping,
  });

  const confirmMutation = useMutation({
    mutationFn: (planId) => mealPlanApi.confirm(planId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      qc.invalidateQueries({ queryKey: ['meal-plan', selectedPlan] });
    },
  });

  const handleGenerate = async (days) => {
    setError('');
    setGenerating(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await mealPlanApi.generate({ start_date: today, days });
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      setSelectedPlan(res.id);
    } catch (e) {
      setError(e.response?.data?.detail || e.message || '献立生成に失敗しました');
    } finally {
      setGenerating(false);
    }
  };

  const handleRecalculate = async () => {
    if (!selectedPlan) return;
    if (!confirm('修正内容を踏まえてAIが献立全体を再計算します。よろしいですか？')) return;
    setRecalculating(true);
    setError('');
    try {
      await mealPlanApi.recalculate(selectedPlan);
      qc.invalidateQueries({ queryKey: ['meal-plan', selectedPlan] });
    } catch (e) {
      setError(e.response?.data?.detail || '再計算に失敗しました');
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">📋 AI献立</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Generate buttons */}
      <div className="card">
        <div className="card-title">献立を生成する</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={() => handleGenerate(1)}
            disabled={generating}
          >
            {generating ? '生成中...' : '今日の献立（1日）'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 1 }}
            onClick={() => handleGenerate(7)}
            disabled={generating}
          >
            {generating ? '生成中...' : '週間献立（7日）'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          ※ 無料プラン: 1日献立は月4回、週間献立は月1回まで
        </div>
      </div>

      {/* Plan list */}
      {plans.length > 0 && (
        <>
          <div className="section-title">献立履歴</div>
          {plans.map((plan) => (
            <div
              key={plan.id}
              className="card"
              style={{ cursor: 'pointer', border: selectedPlan === plan.id ? '2px solid var(--primary)' : '2px solid transparent' }}
              onClick={() => { setSelectedPlan(plan.id); setShowShopping(false); }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {plan.start_date} {plan.start_date !== plan.end_date ? `〜 ${plan.end_date}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {new Date(plan.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <span className={`tag ${plan.status === 'confirmed' ? 'tag-green' : 'tag-orange'}`}>
                  {plan.status === 'confirmed' ? '確定済み' : '下書き'}
                </span>
              </div>
            </div>
          ))}
        </>
      )}

      {/* Plan detail */}
      {planDetail && (
        <div style={{ marginTop: 8 }}>
          <div className="section-title">献立内容</div>

          {planDetail.status === 'draft' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={handleRecalculate}
                disabled={recalculating}
              >
                {recalculating ? '再計算中...' : '🔄 再計算'}
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => confirmMutation.mutate(selectedPlan)}
                disabled={confirmMutation.isPending}
              >
                {confirmMutation.isPending ? '確定中...' : '✓ 献立を確定'}
              </button>
            </div>
          )}

          {planDetail.status === 'confirmed' && (
            <button
              className="btn btn-secondary btn-full"
              style={{ marginBottom: 12 }}
              onClick={() => setShowShopping(!showShopping)}
            >
              🛒 {showShopping ? '献立に戻る' : '買い物リストを見る'}
            </button>
          )}

          {showShopping && shopping ? (
            <div className="card">
              <div className="card-title">🛒 買い物リスト</div>
              {shopping.shared && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>共有食材</div>
                  {shopping.shared.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14 }}>
                      <input type="checkbox" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              )}
              {Object.entries(shopping)
                .filter(([k]) => k !== 'shared')
                .map(([key, items]) => (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>個別（{key.replace('individual_', '')}）</div>
                    {items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14 }}>
                        <input type="checkbox" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                ))
              }
            </div>
          ) : (
            planDetail.days.map((day) => (
              <div key={day.id} className="card">
                <div className="card-title">{day.date}</div>
                {day.slots.map((slot) => (
                  <div key={slot.id} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{MEAL_JP[slot.meal_type] || slot.meal_type}</span>
                      <span className={`tag ${slot.sharing_type === 'shared' ? 'tag-green' : 'tag-gray'}`}>
                        {slot.sharing_type === 'shared' ? '共有' : '個別'}
                      </span>
                      {slot.is_dining_out && <span className="tag tag-orange">外食</span>}
                      {/* T-11: 編集ボタン（下書きのみ） */}
                      {planDetail.status === 'draft' && (
                        <button
                          className="btn-icon"
                          style={{ marginLeft: 'auto', fontSize: 14 }}
                          title="編集"
                          onClick={() => setEditingSlot({ slot, planId: planDetail.id })}
                        >✏️</button>
                      )}
                    </div>

                    {slot.is_dining_out ? (
                      <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--text-secondary)' }}>
                        🍽️ 外食 {slot.dining_out_kcal ? `（目安 ${Math.round(slot.dining_out_kcal)} kcal）` : ''}
                      </div>
                    ) : slot.items.length === 0 ? (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>未生成</div>
                    ) : (
                      slot.items.map((item) => (
                        <ItemCard key={item.id} item={item} planId={planDetail.id} isDraft={planDetail.status === 'draft'} />
                      ))
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {plans.length === 0 && !generating && (
        <div className="empty-state">
          <div style={{ fontSize: 40 }}>📋</div>
          <p>「今日の献立」ボタンで<br />AIが献立を提案します</p>
        </div>
      )}

      {/* Slot edit modal */}
      {editingSlot && (
        <SlotEditPanel
          planId={editingSlot.planId}
          slot={editingSlot.slot}
          onClose={() => setEditingSlot(null)}
        />
      )}
    </div>
  );
}

// T-11: メニューアイテムカード（量調整付き）
function ItemCard({ item, planId, isDraft }) {
  const qc = useQueryClient();
  const [editGrams, setEditGrams] = useState(false);
  const [gramsValue, setGramsValue] = useState(item.serving_grams || '');
  const [saving, setSaving] = useState(false);

  const saveGrams = async () => {
    if (!gramsValue) return;
    setSaving(true);
    try {
      const ratio = gramsValue / (item.serving_grams || gramsValue);
      await mealPlanApi.updateItem(planId, item.id, {
        serving_grams: parseFloat(gramsValue),
        kcal: item.kcal ? item.kcal * ratio : undefined,
        protein_g: item.protein_g ? item.protein_g * ratio : undefined,
        fat_g: item.fat_g ? item.fat_g * ratio : undefined,
        carb_g: item.carb_g ? item.carb_g * ratio : undefined,
      });
      qc.invalidateQueries({ queryKey: ['meal-plan', planId] });
      setEditGrams(false);
    } catch {
      alert('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
      <div style={{ fontWeight: 500, fontSize: 14 }}>{item.menu_name}</div>
      {item.kcal && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {Math.round(item.kcal)} kcal
          {item.protein_g && ` / P${item.protein_g?.toFixed(1)}g`}
          {item.fat_g && ` F${item.fat_g?.toFixed(1)}g`}
          {item.carb_g && ` C${item.carb_g?.toFixed(1)}g`}
          {item.serving_grams && (
            <>
              {' · '}
              {editGrams ? (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="number"
                    value={gramsValue}
                    onChange={e => setGramsValue(e.target.value)}
                    style={{ width: 60, padding: '0 4px', border: '1px solid #ccc', borderRadius: 4, fontSize: 11 }}
                    min="1"
                    onClick={e => e.stopPropagation()}
                  />g
                  <button onClick={saveGrams} disabled={saving} style={{ fontSize: 11, padding: '1px 6px' }} className="btn btn-primary">
                    {saving ? '...' : '保存'}
                  </button>
                  <button onClick={() => setEditGrams(false)} style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                </span>
              ) : (
                <span
                  style={{ cursor: isDraft ? 'pointer' : 'default', textDecoration: isDraft ? 'underline dotted' : 'none' }}
                  onClick={() => isDraft && setEditGrams(true)}
                >
                  {item.serving_grams}g
                  {isDraft && ' ✏️'}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {item.cooking_summary && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{item.cooking_summary}</div>
      )}
      {item.ingredients?.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          食材: {item.ingredients.join(', ')}
        </div>
      )}
    </div>
  );
}
