import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mealPlanApi, shoppingApi } from '../services/api';

const MEAL_JP = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };
const SOURCE_JP = { conbini: '🏪 コンビニ', homecook: '🍳 自炊' };
const SOURCE_ICON = { conbini: '🏪', homecook: '🍳' };

// ─── 生成条件パネル ───────────────────────────────────────────────────
function GenerateConditionsPanel({ conditions, onChange }) {
  const { lightBreakfast, mealSources, specialDates } = conditions;
  const [dateInput, setDateInput] = useState('');

  const setSource = (meal, val) =>
    onChange({ ...conditions, mealSources: { ...mealSources, [meal]: val } });

  const addSpecialDate = () => {
    if (!dateInput) return;
    if (!specialDates.includes(dateInput)) {
      onChange({ ...conditions, specialDates: [...specialDates, dateInput].sort() });
    }
    setDateInput('');
  };

  const removeSpecialDate = (d) =>
    onChange({ ...conditions, specialDates: specialDates.filter((x) => x !== d) });

  return (
    <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 16, marginTop: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>⚙️ 生成条件</div>

      {/* 朝食を軽めに */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer', fontSize: 14 }}>
        <input
          type="checkbox"
          checked={lightBreakfast}
          onChange={(e) => onChange({ ...conditions, lightBreakfast: e.target.checked })}
        />
        <span>朝食を軽めにする <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>（カロリーを1日の約20%に）</span></span>
      </label>

      {/* 食事ごとのスタイル */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>食事スタイル</div>
        {['breakfast', 'lunch', 'dinner'].map((meal) => {
          const src = mealSources[meal] || 'auto';
          return (
            <div key={meal} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 42, fontSize: 13 }}>{MEAL_JP[meal]}</span>
              {['conbini', 'homecook', 'auto'].map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSource(meal, opt)}
                  className={`btn ${src === opt ? 'btn-primary' : 'btn-outline'}`}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {opt === 'conbini' ? '🏪 コンビニ' : opt === 'homecook' ? '🍳 自炊' : '自動'}
                </button>
              ))}
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
          ※「自動」= 朝昼コンビニ・夕食自炊（デフォルト）
        </div>
      </div>

      {/* 特定日指定 */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
          外出日（終日コンビニ食）
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="date"
            className="form-input"
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
            style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
          />
          <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 13 }} onClick={addSpecialDate}>
            追加
          </button>
        </div>
        {specialDates.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {specialDates.map((d) => (
              <span key={d} className="tag tag-orange" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                📅 {d}
                <button
                  onClick={() => removeSpecialDate(d)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
                >✕</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── スロット編集パネル ───────────────────────────────────────────────
function SlotEditPanel({ planId, slot, onClose }) {
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
      onClose();
    } catch {
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
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>✏️ {MEAL_JP[slot.meal_type]} を編集</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="form-group">
          <label className="form-label">共有 / 個別</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['shared', 'individual'].map((t) => (
              <button
                key={t}
                className={`btn ${sharingType === t ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setSharingType(t)}
              >
                {t === 'shared' ? '共有食' : '個別食'}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">
            <input
              type="checkbox"
              checked={isDiningOut}
              onChange={(e) => setIsDiningOut(e.target.checked)}
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
              onChange={(e) => setDiningOutKcal(e.target.value)}
              min="0"
              style={{ marginTop: 8 }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="btn btn-secondary"
            style={{ flex: 1 }}
            onClick={handleReplace}
            disabled={replacing}
          >
            {replacing ? 'AI再提案中...' : '🔄 メニューをAI差し替え'}
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── メニューアイテムカード ────────────────────────────────────────────
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
    <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
      <div style={{ fontWeight: 500, fontSize: 14 }}>{item.menu_name}</div>
      {item.kcal && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {Math.round(item.kcal)} kcal
          {item.protein_g != null && ` / P${item.protein_g?.toFixed(1)}g`}
          {item.fat_g != null && ` F${item.fat_g?.toFixed(1)}g`}
          {item.carb_g != null && ` C${item.carb_g?.toFixed(1)}g`}
          {item.serving_grams && (
            <>
              {' · '}
              {editGrams ? (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="number"
                    value={gramsValue}
                    onChange={(e) => setGramsValue(e.target.value)}
                    style={{ width: 60, padding: '0 4px', border: '1px solid #ccc', borderRadius: 4, fontSize: 11 }}
                    min="1"
                    onClick={(e) => e.stopPropagation()}
                  />
                  g
                  <button
                    onClick={saveGrams}
                    disabled={saving}
                    style={{ fontSize: 11, padding: '1px 6px' }}
                    className="btn btn-primary"
                  >
                    {saving ? '...' : '保存'}
                  </button>
                  <button
                    onClick={() => setEditGrams(false)}
                    style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <span
                  style={{
                    cursor: isDraft ? 'pointer' : 'default',
                    textDecoration: isDraft ? 'underline dotted' : 'none',
                  }}
                  onClick={() => isDraft && setEditGrams(true)}
                >
                  {item.serving_grams}g{isDraft && ' ✏️'}
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

// ─── kcal予算バー ─────────────────────────────────────────────────────
function KcalBudgetBar({ actual, budget }) {
  if (!budget) return null;
  const pct = Math.min(100, Math.round((actual / budget) * 100));
  const over = actual > budget;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>
        <span>{actual} / {budget} kcal</span>
        <span style={{ color: over ? '#e74c3c' : 'var(--text-secondary)' }}>
          {over ? `+${actual - budget} kcal超過` : `残り ${budget - actual} kcal`}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: '#eee', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: over ? '#e74c3c' : 'var(--primary)',
            borderRadius: 2,
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}

// ─── メインページ ─────────────────────────────────────────────────────
const DEFAULT_CONDITIONS = {
  lightBreakfast: false,
  mealSources: {},     // empty = all "auto"
  specialDates: [],
};

export default function MealPlanPage() {
  const qc = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showShopping, setShowShopping] = useState(false);
  const [editingSlot, setEditingSlot] = useState(null);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState('');
  const [showConditions, setShowConditions] = useState(false);
  const [conditions, setConditions] = useState(DEFAULT_CONDITIONS);

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

  const deleteMutation = useMutation({
    mutationFn: (planId) => mealPlanApi.delete(planId),
    onSuccess: (_, planId) => {
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      if (selectedPlan === planId) setSelectedPlan(null);
    },
    onError: (e) => setError(e.response?.data?.detail || '削除に失敗しました'),
  });

  const handleGenerate = async (days) => {
    setError('');
    setGenerating(true);
    try {
      const today = new Date().toISOString().split('T')[0];
      // Convert camelCase conditions to snake_case for API
      const apiConditions = {
        light_breakfast: conditions.lightBreakfast,
        meal_sources: conditions.mealSources,
        special_dates: conditions.specialDates,
      };
      const res = await mealPlanApi.generate({ start_date: today, days, conditions: apiConditions });
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      setSelectedPlan(res.id);
      setShowConditions(false);
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

  // Summarise conditions for display
  const conditionsSummary = (() => {
    const parts = [];
    if (conditions.lightBreakfast) parts.push('朝食軽め');
    const srcLabels = { conbini: 'コンビニ', homecook: '自炊' };
    ['breakfast', 'lunch', 'dinner'].forEach((m) => {
      const s = conditions.mealSources[m];
      if (s && s !== 'auto') parts.push(`${MEAL_JP[m]}${srcLabels[s]}`);
    });
    if (conditions.specialDates.length > 0) parts.push(`外出日${conditions.specialDates.length}件`);
    return parts.length ? parts.join('・') : 'デフォルト設定';
  })();

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">📋 AI献立</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Generate card */}
      <div className="card">
        <div className="card-title">献立を生成する</div>

        {/* Conditions toggle */}
        <button
          className="btn btn-outline btn-full"
          style={{ marginBottom: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          onClick={() => setShowConditions((v) => !v)}
        >
          <span>⚙️ 生成条件: <span style={{ color: 'var(--primary)', fontWeight: 500 }}>{conditionsSummary}</span></span>
          <span>{showConditions ? '▲' : '▼'}</span>
        </button>

        {showConditions && (
          <GenerateConditionsPanel conditions={conditions} onChange={setConditions} />
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
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
              style={{
                cursor: 'pointer',
                border: selectedPlan === plan.id ? '2px solid var(--primary)' : '2px solid transparent',
              }}
              onClick={() => {
                setSelectedPlan(plan.id);
                setShowShopping(false);
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {plan.start_date}
                    {plan.start_date !== plan.end_date ? ` 〜 ${plan.end_date}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {new Date(plan.created_at).toLocaleString('ja-JP', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                  {plan.conditions && Object.keys(plan.conditions).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {plan.conditions.light_breakfast && (
                        <span className="tag tag-gray" style={{ fontSize: 10 }}>朝食軽め</span>
                      )}
                      {plan.conditions.special_dates?.length > 0 && (
                        <span className="tag tag-orange" style={{ fontSize: 10 }}>
                          外出日{plan.conditions.special_dates.length}件
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span className={`tag ${plan.status === 'confirmed' ? 'tag-green' : 'tag-orange'}`}>
                    {plan.status === 'confirmed' ? '確定済み' : '下書き'}
                  </span>
                  <button
                    className="btn-icon"
                    style={{ fontSize: 16, color: 'var(--text-secondary)', padding: 4 }}
                    title="削除"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('この献立を削除しますか？')) {
                        deleteMutation.mutate(plan.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    🗑️
                  </button>
                </div>
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
              <div className="card-title">🛒 買い物リスト（自炊分）</div>
              {shopping.shared && shopping.shared.length > 0 && (
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
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                      個別（{key.replace('individual_', '')}）
                    </div>
                    {items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14 }}>
                        <input type="checkbox" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                ))}
              {(!shopping.shared || shopping.shared.length === 0) &&
                Object.keys(shopping).filter((k) => k !== 'shared').length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    自炊メニューがないため買い物リストはありません
                  </div>
                )}
            </div>
          ) : (
            planDetail.days.map((day) => (
              <div key={day.id} className="card">
                <div className="card-title">{day.date}</div>
                {day.slots.map((slot) => {
                  const totalKcal = slot.total_kcal;
                  const budget = slot.kcal_budget;
                  return (
                    <div key={slot.id} style={{ marginBottom: 18 }}>
                      {/* Slot header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>
                          {MEAL_JP[slot.meal_type] || slot.meal_type}
                        </span>
                        {slot.source_type && (
                          <span className={`tag ${slot.source_type === 'conbini' ? 'tag-blue' : 'tag-green'}`}>
                            {SOURCE_JP[slot.source_type] || slot.source_type}
                          </span>
                        )}
                        <span className={`tag ${slot.sharing_type === 'shared' ? 'tag-green' : 'tag-gray'}`}>
                          {slot.sharing_type === 'shared' ? '共有' : '個別'}
                        </span>
                        {slot.is_dining_out && <span className="tag tag-orange">外食</span>}
                        {planDetail.status === 'draft' && (
                          <button
                            className="btn-icon"
                            style={{ marginLeft: 'auto', fontSize: 14 }}
                            title="編集"
                            onClick={() => setEditingSlot({ slot, planId: planDetail.id })}
                          >
                            ✏️
                          </button>
                        )}
                      </div>

                      {/* kcal budget bar */}
                      {totalKcal != null && (
                        <KcalBudgetBar actual={totalKcal} budget={budget} />
                      )}
                      {!totalKcal && budget && (
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                          目標: {budget} kcal
                        </div>
                      )}

                      {/* Slot content */}
                      {slot.is_dining_out ? (
                        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--text-secondary)' }}>
                          🍽️ 外食 {slot.dining_out_kcal ? `（目安 ${Math.round(slot.dining_out_kcal)} kcal）` : ''}
                        </div>
                      ) : slot.items.length === 0 ? (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>未生成</div>
                      ) : (
                        slot.items.map((item) => (
                          <ItemCard
                            key={item.id}
                            item={item}
                            planId={planDetail.id}
                            isDraft={planDetail.status === 'draft'}
                          />
                        ))
                      )}
                    </div>
                  );
                })}
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
