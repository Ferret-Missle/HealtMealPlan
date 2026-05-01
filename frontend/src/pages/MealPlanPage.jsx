import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mealPlanApi, shoppingApi, groupApi } from '../services/api';
import { addJstDays, formatJstDate, isWeekendJst, toJstDateString } from '../utils/date';

// ─── 定数 ────────────────────────────────────────────────────────────────────
const MEAL_JP = { breakfast: '朝', lunch: '昼', dinner: '夕' };
const MEAL_FULL = { breakfast: '朝食', lunch: '昼食', dinner: '夕食' };
const SOURCE_CYCLE = ['conbini', 'bento', 'homecook'];
const SOURCE_LABEL = { conbini: '🏪', bento: '🍱', homecook: '🍳' };
const SOURCE_JP = { conbini: 'コンビニ', bento: '自作弁当', homecook: '自炊' };
// ─── 汎用ヘルパー ─────────────────────────────────────────────────────────────
function nextSource(s) {
  return SOURCE_CYCLE[(SOURCE_CYCLE.indexOf(s) + 1) % SOURCE_CYCLE.length];
}
function isWeekend(dateStr) {
  return isWeekendJst(dateStr);
}
function dateLabel(dateStr) {
  const weekday = formatJstDate(dateStr, { weekday: 'short' });
  return `${formatJstDate(dateStr, { month: 'numeric', day: 'numeric' })}(${weekday})`;
}

// ─── localStorage フック ──────────────────────────────────────────────────────
function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initial;
    } catch {
      return initial;
    }
  });
  function set(v) {
    const next = typeof v === 'function' ? v(value) : v;
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }
  return [value, set];
}

// ─── デフォルト設定 ───────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  lightBreakfast: {},   // { [userId]: bool }
  workDay: {},          // { [userId]: { breakfast, lunch, dinner } }
  weekend: {},          // { [userId]: { breakfast, lunch, dinner } }
};
const DEFAULT_WORKDAY = { breakfast: 'conbini', lunch: 'conbini', dinner: 'homecook' };
const DEFAULT_WEEKEND = { breakfast: 'homecook', lunch: 'homecook', dinner: 'homecook' };

function getMemberDefaults(settings, userId, dayType) {
  return settings[dayType]?.[userId] || (dayType === 'weekend' ? DEFAULT_WEEKEND : DEFAULT_WORKDAY);
}

function buildDayConditions(startDate, days, settings, members) {
  return Array.from({ length: days }, (_, i) => {
    const dateStr = addJstDays(startDate, i);
    const weekend = isWeekend(dateStr);
    return {
      date: dateStr,
      members: members.map((m) => ({
        user_id: m.user_id,
        ...getMemberDefaults(settings, m.user_id, weekend ? 'weekend' : 'workDay'),
        light_breakfast: settings.lightBreakfast?.[m.user_id] || false,
      })),
    };
  });
}

// ─── 設定パネル（ステップ1） ──────────────────────────────────────────────────
function SettingsPanel({ settings, onChange, members }) {
  function setLightBreakfast(uid, val) {
    onChange({ ...settings, lightBreakfast: { ...settings.lightBreakfast, [uid]: val } });
  }
  function setMealSource(uid, dayType, meal, src) {
    const current = getMemberDefaults(settings, uid, dayType);
    onChange({
      ...settings,
      [dayType]: { ...settings[dayType], [uid]: { ...current, [meal]: src } },
    });
  }

  return (
    <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>⚙️ メンバー別デフォルト設定</div>
      {members.map((m) => {
        const wd = getMemberDefaults(settings, m.user_id, 'workDay');
        const we = getMemberDefaults(settings, m.user_id, 'weekend');
        const lb = settings.lightBreakfast?.[m.user_id] || false;
        return (
          <div key={m.user_id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>👤 {m.name}</div>

            {/* 朝食軽め */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={lb} onChange={(e) => setLightBreakfast(m.user_id, e.target.checked)} />
              朝食を軽めにする
            </label>

            {/* 平日 */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>平日デフォルト</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['breakfast', 'lunch', 'dinner'].map((meal) => (
                  <div key={meal} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{MEAL_JP[meal]}</span>
                    {SOURCE_CYCLE.map((src) => (
                      <button
                        key={src}
                        onClick={() => setMealSource(m.user_id, 'workDay', meal, src)}
                        className={`btn ${wd[meal] === src ? 'btn-primary' : 'btn-outline'}`}
                        style={{ padding: '2px 8px', fontSize: 12 }}
                      >
                        {SOURCE_LABEL[src]}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* 週末 */}
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>週末デフォルト</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['breakfast', 'lunch', 'dinner'].map((meal) => (
                  <div key={meal} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{MEAL_JP[meal]}</span>
                    {SOURCE_CYCLE.map((src) => (
                      <button
                        key={src}
                        onClick={() => setMealSource(m.user_id, 'weekend', meal, src)}
                        className={`btn ${we[meal] === src ? 'btn-primary' : 'btn-outline'}`}
                        style={{ padding: '2px 8px', fontSize: 12 }}
                      >
                        {SOURCE_LABEL[src]}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {members.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>グループメンバーを読み込み中...</div>
      )}
    </div>
  );
}

// ─── 日別カード（ステップ2） ──────────────────────────────────────────────────
function DayRow({ dayCondition, members, schedules, onUpdate }) {
  const { date, members: memberConds } = dayCondition;
  const weekend = isWeekend(date);

  function getMemberCond(userId) {
    return memberConds.find((m) => m.user_id === userId) || {
      user_id: userId, breakfast: 'conbini', lunch: 'conbini', dinner: 'homecook', light_breakfast: false,
    };
  }

  function cycleMeal(userId, meal) {
    const cond = getMemberCond(userId);
    const newSrc = nextSource(cond[meal]);
    onUpdate(date, userId, meal, newSrc);
  }

  // 特定日のスケジュールを取得（HH:MM形式に整形）
  function getMemberEvents(userId) {
    const memberData = schedules?.[userId];
    if (!memberData) return null;
    if (!memberData.events || memberData.events.length === 0) return [];

    return memberData.events.filter((ev) => {
      const evDate = (ev.start || '').slice(0, 10);
      return evDate === date;
    });
  }

  function formatEventTime(ev) {
    if (ev.all_day) return '終日';
    const start = ev.start?.slice(11, 16) || '';
    const end = ev.end?.slice(11, 16) || '';
    return start && end ? `${start}〜${end}` : start;
  }

  return (
    <div
      className="card"
      style={{
        marginBottom: 8,
        borderLeft: `4px solid ${weekend ? '#e74c3c' : 'var(--primary)'}`,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
        {dateLabel(date)}
        {weekend && <span style={{ marginLeft: 6, fontSize: 11, color: '#e74c3c', background: '#fde8e8', borderRadius: 4, padding: '1px 6px' }}>休日</span>}
      </div>

      {members.map((m) => {
        const cond = getMemberCond(m.user_id);
        const events = getMemberEvents(m.user_id);
        return (
          <div key={m.user_id} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 60, color: 'var(--text-secondary)' }}>{m.name}</span>
              {['breakfast', 'lunch', 'dinner'].map((meal) => (
                <button
                  key={meal}
                  onClick={() => cycleMeal(m.user_id, meal)}
                  className="btn btn-outline"
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1,
                    lineHeight: 1.2,
                    minWidth: 52,
                  }}
                  title={`${MEAL_FULL[meal]}: ${SOURCE_JP[cond[meal]]} → タップで変更`}
                >
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{MEAL_JP[meal]}</span>
                  <span>{SOURCE_LABEL[cond[meal]]}</span>
                </button>
              ))}
              {cond.light_breakfast && (
                <span className="tag tag-gray" style={{ fontSize: 10 }}>朝軽め</span>
              )}
            </div>

            {/* 予定表示 */}
            <div style={{ marginTop: 4, marginLeft: 66, fontSize: 11, color: 'var(--text-secondary)' }}>
              {events === null ? (
                <span>📅 Google連携なし</span>
              ) : events.length === 0 ? (
                <span>📅 予定なし（仕事日）</span>
              ) : (
                <span>
                  📅 {events.map((ev) => `${ev.summary}${ev.all_day ? '' : ` ${formatEventTime(ev)}`}`).join(' / ')}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── KcalバジェットBar ─────────────────────────────────────────────────────────
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
        <div style={{ height: '100%', width: `${pct}%`, background: over ? '#e74c3c' : 'var(--primary)', borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

// ─── ItemCard ────────────────────────────────────────────────────────────────
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
                  <button onClick={saveGrams} disabled={saving} className="btn btn-primary" style={{ fontSize: 11, padding: '1px 6px' }}>
                    {saving ? '...' : '保存'}
                  </button>
                  <button onClick={() => setEditGrams(false)} style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                </span>
              ) : (
                <span
                  style={{ cursor: isDraft ? 'pointer' : 'default', textDecoration: isDraft ? 'underline dotted' : 'none' }}
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
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>食材: {item.ingredients.join(', ')}</div>
      )}
    </div>
  );
}

// ─── SlotEditPanel ────────────────────────────────────────────────────────────
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
          <h3>✏️ {MEAL_FULL[slot.meal_type]} を編集</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="form-group">
          <label className="form-label">共有 / 個別</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['shared', 'individual'].map((t) => (
              <button key={t} className={`btn ${sharingType === t ? 'btn-primary' : 'btn-outline'}`} onClick={() => setSharingType(t)}>
                {t === 'shared' ? '共有食' : '個別食'}
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">
            <input type="checkbox" checked={isDiningOut} onChange={(e) => setIsDiningOut(e.target.checked)} style={{ marginRight: 8 }} />
            外食に変更
          </label>
          {isDiningOut && (
            <input type="number" className="form-input" placeholder="外食カロリー（目安 kcal）" value={diningOutKcal} onChange={(e) => setDiningOutKcal(e.target.value)} min="0" style={{ marginTop: 8 }} />
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

// ─── メインページ ─────────────────────────────────────────────────────────────
export default function MealPlanPage() {
  const qc = useQueryClient();
  const today = toJstDateString();

  // ステップ管理
  const [step, setStep] = useState(null); // null | 'settings' | 'configure'
  const [startDate, setStartDate] = useState(today);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useLocalStorage('meal_plan_settings_v2', DEFAULT_SETTINGS);
  const [dayConditions, setDayConditions] = useState([]);

  // 結果表示
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showShopping, setShowShopping] = useState(false);
  const [editingSlot, setEditingSlot] = useState(null);
  const [recalculating, setRecalculating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  // データ取得
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

  const { data: myGroup } = useQuery({
    queryKey: ['my-group'],
    queryFn: () => groupApi.myGroup().then((r) => r.data),
  });
  const members = myGroup?.members || [];

  const { data: schedules = {} } = useQuery({
    queryKey: ['group-schedules', startDate],
    queryFn: () => groupApi.schedules(startDate, 7),
    enabled: step === 'configure',
    retry: false,
  });

  // ─── アクション ────────────────────────────────────────────────────────────

  function handleGoToConfigure() {
    const conds = buildDayConditions(startDate, 7, settings, members);
    setDayConditions(conds);
    setStep('configure');
    setShowSettings(false);
  }

  function updateDayCondition(date, userId, meal, newSource) {
    setDayConditions((prev) =>
      prev.map((dc) => {
        if (dc.date !== date) return dc;
        return {
          ...dc,
          members: dc.members.map((m) =>
            m.user_id === userId ? { ...m, [meal]: newSource } : m
          ),
        };
      })
    );
  }

  async function handleGenerate() {
    setError('');
    setGenerating(true);
    try {
      const res = await mealPlanApi.generate({
        start_date: startDate,
        days: 7,
        day_conditions: dayConditions,
      });
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      setSelectedPlan(res.id);
      setStep(null);
    } catch (e) {
      setError(e.response?.data?.detail || e.message || '献立生成に失敗しました');
    } finally {
      setGenerating(false);
    }
  }

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

  // ─── ステップ1: 日付選択 + 設定 ───────────────────────────────────────────
  if (step === 'settings') {
    return (
      <div>
        <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-icon" onClick={() => setStep(null)}>←</button>
          <h1 className="page-title" style={{ margin: 0 }}>📋 新しい献立を作成</h1>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="card">
          <div className="card-title">開始日を選択</div>
          <input
            type="date"
            className="form-input"
            value={startDate}
            min={today}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            {startDate} 〜 {addJstDays(startDate, 6)} の7日間
          </div>
        </div>

        <div className="card">
          <button
            className="btn btn-outline btn-full"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            onClick={() => setShowSettings((v) => !v)}
          >
            <span>⚙️ メンバー別デフォルト設定</span>
            <span>{showSettings ? '▲' : '▼'}</span>
          </button>
          {showSettings && (
            <div style={{ marginTop: 12 }}>
              <SettingsPanel settings={settings} onChange={setSettings} members={members} />
            </div>
          )}
        </div>

        <button
          className="btn btn-primary btn-full"
          onClick={handleGoToConfigure}
          disabled={!startDate || members.length === 0}
        >
          7日間の食事スタイルを設定する →
        </button>
        {members.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 8 }}>
            ※ グループを作成・参加してから献立を生成できます
          </div>
        )}
      </div>
    );
  }

  // ─── ステップ2: 7日間の食事スタイル設定 ────────────────────────────────────
  if (step === 'configure') {
    return (
      <div>
        <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-icon" onClick={() => setStep('settings')}>←</button>
          <h1 className="page-title" style={{ margin: 0 }}>📋 食事スタイルを設定</h1>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          ボタンをタップするたびに {Object.entries(SOURCE_LABEL).map(([k, v]) => `${v}${SOURCE_JP[k]}`).join(' → ')} が切り替わります
        </div>

        {dayConditions.map((dc) => (
          <DayRow
            key={dc.date}
            dayCondition={dc}
            members={members}
            schedules={schedules}
            onUpdate={updateDayCondition}
          />
        ))}

        <button
          className="btn btn-primary btn-full"
          style={{ marginTop: 8 }}
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? 'AIが献立を生成中... (しばらくお待ちください)' : '✨ この内容で献立を生成する'}
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 6 }}>
          ※ 無料プラン: 週間献立は月1回まで
        </div>
      </div>
    );
  }

  // ─── メイン画面（履歴 + 詳細） ─────────────────────────────────────────────
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">📋 AI献立</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* 新規生成ボタン */}
      <button
        className="btn btn-primary btn-full"
        style={{ marginBottom: 16 }}
        onClick={() => { setError(''); setStep('settings'); }}
      >
        ＋ 新しい献立を作成（7日間）
      </button>

      {/* 献立履歴 */}
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
              onClick={() => { setSelectedPlan(plan.id); setShowShopping(false); }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {plan.start_date}{plan.start_date !== plan.end_date ? ` 〜 ${plan.end_date}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {new Date(plan.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
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
                      if (window.confirm('この献立を削除しますか？')) deleteMutation.mutate(plan.id);
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

      {/* 献立詳細 */}
      {planDetail && (
        <div style={{ marginTop: 8 }}>
          <div className="section-title">献立内容</div>

          {planDetail.status === 'draft' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleRecalculate} disabled={recalculating}>
                {recalculating ? '再計算中...' : '🔄 再計算'}
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => confirmMutation.mutate(selectedPlan)} disabled={confirmMutation.isPending}>
                {confirmMutation.isPending ? '確定中...' : '✓ 献立を確定'}
              </button>
            </div>
          )}

          {planDetail.status === 'confirmed' && (
            <button className="btn btn-secondary btn-full" style={{ marginBottom: 12 }} onClick={() => setShowShopping(!showShopping)}>
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
                      <input type="checkbox" /><span>{item}</span>
                    </div>
                  ))}
                </div>
              )}
              {Object.entries(shopping).filter(([k]) => k !== 'shared').map(([key, items]) => (
                <div key={key} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>個別（{key.replace('individual_', '')}）</div>
                  {items.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14 }}>
                      <input type="checkbox" /><span>{item}</span>
                    </div>
                  ))}
                </div>
              ))}
              {(!shopping.shared || shopping.shared.length === 0) && Object.keys(shopping).filter((k) => k !== 'shared').length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>自炊メニューがないため買い物リストはありません</div>
              )}
            </div>
          ) : (
            planDetail.days.map((day) => (
              <div key={day.id} className="card">
                <div className="card-title">{dateLabel(day.date)}</div>
                {day.slots.map((slot) => (
                  <div key={slot.id} style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{MEAL_FULL[slot.meal_type] || slot.meal_type}</span>
                      {slot.source_type && (
                        <span className={`tag ${slot.source_type === 'conbini' ? 'tag-blue' : slot.source_type === 'bento' ? 'tag-orange' : 'tag-green'}`}>
                          {SOURCE_LABEL[slot.source_type]} {SOURCE_JP[slot.source_type] || slot.source_type}
                        </span>
                      )}
                      <span className={`tag ${slot.sharing_type === 'shared' ? 'tag-green' : 'tag-gray'}`}>
                        {slot.sharing_type === 'shared' ? '共有' : '個別'}
                      </span>
                      {slot.is_dining_out && <span className="tag tag-orange">外食</span>}
                      {planDetail.status === 'draft' && (
                        <button className="btn-icon" style={{ marginLeft: 'auto', fontSize: 14 }} title="編集" onClick={() => setEditingSlot({ slot, planId: planDetail.id })}>
                          ✏️
                        </button>
                      )}
                    </div>

                    {slot.total_kcal != null && <KcalBudgetBar actual={slot.total_kcal} budget={slot.kcal_budget} />}
                    {!slot.total_kcal && slot.kcal_budget && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>目標: {slot.kcal_budget} kcal</div>
                    )}

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

      {plans.length === 0 && (
        <div className="empty-state">
          <div style={{ fontSize: 40 }}>📋</div>
          <p>「新しい献立を作成」ボタンで<br />AIが7日分の献立を提案します</p>
        </div>
      )}

      {editingSlot && (
        <SlotEditPanel planId={editingSlot.planId} slot={editingSlot.slot} onClose={() => setEditingSlot(null)} />
      )}
    </div>
  );
}
