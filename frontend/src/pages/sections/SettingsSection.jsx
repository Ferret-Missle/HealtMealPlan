import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Wifi, WifiOff, Trash2, Plus, LogOut, CalendarSync, Target } from 'lucide-react';
import { settingsApi, authApi, bodyApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

const SERVICES = [
  { key: 'fitbit',       label: 'Fitbit',               desc: '歩数・睡眠・心拍・体重' },
  { key: 'healthplanet', label: 'HealthPlanet (タニタ)', desc: '体重・体脂肪・筋肉量・BMI' },
  { key: 'fatsecret',    label: 'FatSecret',             desc: '食品データベース・食事記録' },
  { key: 'google',       label: 'Googleカレンダー',       desc: '予定取得（外食・運動）' },
];

const BYOK_PROVIDERS = [
  { key: 'anthropic', label: 'Anthropic (Claude)',  vision: true },
  { key: 'openai',    label: 'OpenAI (GPT-4o)',     vision: true },
  { key: 'gemini',    label: 'Google Gemini',       vision: true },
  { key: 'groq',      label: 'Groq (Llama 3.1)',    vision: false },
  { key: 'mistral',   label: 'Mistral AI',          vision: false },
];

const DIET_STYLES = ['和食中心', '洋食中心', '高タンパク', '低炭水化物', '糖質制限', 'ベジタリアン', 'ビーガン'];
const GOAL_TYPES = [
  { key: 'lose',     label: '減量' },
  { key: 'maintain', label: '維持' },
  { key: 'gain',     label: '増量' },
];

// "あと X 日" を計算
function daysRemaining(dateStr) {
  if (!dateStr) return null;
  const diff = Math.ceil((new Date(dateStr) - new Date()) / 86400000);
  return diff > 0 ? diff : 0;
}

// 今日から N ヶ月後の日付文字列
function addMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().split('T')[0];
}

export default function SettingsSection() {
  const { user, profile, logout, refreshProfile } = useAuth();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const connected = searchParams.get('connected');

  const [newApiKey, setNewApiKey] = useState({ provider: 'anthropic', key: '' });
  const [showApiKeyForm, setShowApiKeyForm] = useState(false);
  const [excludedInput, setExcludedInput] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState(connected ? `${connected} を連携しました！` : '');

  // 健康目標
  const [goalForm, setGoalForm] = useState(null); // null = not loaded yet

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
  });

  const { data: goalsData } = useQuery({
    queryKey: ['body-goals'],
    queryFn: () => bodyApi.goals().then((r) => r.data),
  });

  // ロード完了後に一度だけフォームを初期化
  useEffect(() => {
    if (goalsData && goalForm === null) {
      setGoalForm({
        target_weight: goalsData.target_weight ?? '',
        target_kcal:   goalsData.target_kcal   ?? '',
        goal_type:     goalsData.goal_type     ?? 'lose',
        deadline:      goalsData.deadline      ?? '',
      });
    }
  }, [goalsData]); // eslint-disable-line react-hooks/exhaustive-deps

  const goalMutation = useMutation({
    mutationFn: (data) => bodyApi.updateGoals(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['body-goals'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setSuccessMsg('目標を保存しました');
    },
    onError: (e) => setErrorMsg(e.message),
  });

  const prefMutation = useMutation({
    mutationFn: (data) => settingsApi.updatePreferences(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSuccessMsg('設定を保存しました');
    },
  });

  const apiKeyMutation = useMutation({
    mutationFn: (data) => settingsApi.registerApiKey(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      refreshProfile();
      setShowApiKeyForm(false);
      setNewApiKey({ provider: 'anthropic', key: '' });
      setSuccessMsg('APIキーを登録しました');
    },
    onError: (e) => setErrorMsg(e.message),
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (provider) => settingsApi.deleteApiKey(provider),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      refreshProfile();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (service) => authApi.disconnect(service),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      refreshProfile();
    },
  });

  const syncCalMutation = useMutation({
    mutationFn: () => settingsApi.syncCalendars(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSuccessMsg('カレンダーを同期しました');
    },
    onError: (e) => setErrorMsg(e.message),
  });

  const connectedServices = settings?.connected_services || [];
  const apiKeys = settings?.api_keys || [];
  const dietStyles = settings?.preferences?.diet_styles || [];
  const excludedFoods = settings?.excluded_foods || [];

  const handleConnect = async (service) => {
    try {
      if (service === 'fitbit') {
        const res = await authApi.fitbitLoginUrl(user.uid);
        window.location.href = res.data.url;
      } else if (service === 'healthplanet') {
        const res = await authApi.healthplanetLoginUrl(user.uid);
        window.location.href = res.data.url;
      } else if (service === 'google') {
        const res = await authApi.googleLoginUrl(user.uid);
        window.location.href = res.data.url;
      } else if (service === 'fatsecret') {
        const res = await authApi.fatsecretRequestToken(user.uid);
        window.location.href = res.data.authorize_url;
      }
    } catch (e) {
      setErrorMsg('連携の開始に失敗しました: ' + e.message);
    }
  };

  const toggleDietStyle = (style) => {
    const next = dietStyles.includes(style)
      ? dietStyles.filter((s) => s !== style)
      : [...dietStyles, style];
    prefMutation.mutate({ diet_styles: next });
  };

  const addExcluded = () => {
    if (!excludedInput.trim()) return;
    const next = [...new Set([...excludedFoods, excludedInput.trim()])];
    prefMutation.mutate({ excluded_foods: next });
    setExcludedInput('');
  };

  const removeExcluded = (food) => {
    prefMutation.mutate({ excluded_foods: excludedFoods.filter((f) => f !== food) });
  };

  if (isLoading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">設定</h1>
        <button className="btn btn-outline btn-sm" onClick={logout}>
          <LogOut size={14} strokeWidth={2} style={{ marginRight: 4 }} />
          ログアウト
        </button>
      </div>

      {successMsg && <div className="alert alert-success" onClick={() => setSuccessMsg('')}>{successMsg}</div>}
      {errorMsg && <div className="alert alert-error" onClick={() => setErrorMsg('')}>{errorMsg}</div>}

      {/* Profile */}
      <div className="card">
        <div className="card-title">アカウント</div>
        <div style={{ fontSize: 15 }}>
          <strong>{profile?.name || user?.displayName}</strong>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{user?.email}</div>
        </div>
        <div style={{ marginTop: 8 }}>
          <span className={profile?.plan_type === 'byok' ? 'connected-badge' : 'disconnected-badge'}>
            {profile?.plan_type === 'byok' ? `BYOK (${profile.byok_provider})` : '無料プラン (Groq)'}
          </span>
        </div>
      </div>

      {/* 健康目標 */}
      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Target size={13} strokeWidth={1.8} />
        健康目標
      </div>
      {goalForm && (
        <div className="card">
          {/* goal_type */}
          <div className="form-group">
            <label className="form-label">目標タイプ</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {GOAL_TYPES.map(({ key, label }) => (
                <button
                  key={key}
                  className={`btn btn-sm${goalForm.goal_type === key ? ' btn-primary' : ' btn-outline'}`}
                  onClick={() => setGoalForm(f => ({ ...f, goal_type: key }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 目標体重 */}
          <div className="form-group">
            <label className="form-label">目標体重 (kg)</label>
            <input
              className="form-input"
              type="number"
              step="0.1"
              placeholder="例: 65.0"
              value={goalForm.target_weight}
              onChange={e => setGoalForm(f => ({ ...f, target_weight: e.target.value }))}
              style={{ maxWidth: 140 }}
            />
          </div>

          {/* 目標カロリー */}
          <div className="form-group">
            <label className="form-label">1日の目標カロリー (kcal)</label>
            <input
              className="form-input"
              type="number"
              step="50"
              placeholder="例: 1800"
              value={goalForm.target_kcal}
              onChange={e => setGoalForm(f => ({ ...f, target_kcal: e.target.value }))}
              style={{ maxWidth: 140 }}
            />
          </div>

          {/* 期限プリセット */}
          <div className="form-group">
            <label className="form-label">達成期限</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {[
                { label: '1ヶ月', months: 1 },
                { label: '3ヶ月', months: 3 },
                { label: '6ヶ月', months: 6 },
                { label: '1年',   months: 12 },
              ].map(({ label, months }) => {
                const d = addMonths(months);
                const active = goalForm.deadline === d;
                return (
                  <button
                    key={months}
                    className={`btn btn-sm${active ? ' btn-primary' : ' btn-outline'}`}
                    onClick={() => setGoalForm(f => ({ ...f, deadline: d }))}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* カスタム日付 */}
            <input
              className="form-input"
              type="date"
              value={goalForm.deadline}
              onChange={e => setGoalForm(f => ({ ...f, deadline: e.target.value }))}
              style={{ maxWidth: 180 }}
            />
            {goalForm.deadline && (
              <div style={{ fontSize: 12, color: 'var(--brand)', marginTop: 4, fontWeight: 600 }}>
                あと {daysRemaining(goalForm.deadline).toLocaleString()} 日
              </div>
            )}
          </div>

          <button
            className="btn btn-primary btn-full"
            style={{ marginTop: 4 }}
            onClick={() => goalMutation.mutate({
              target_weight: goalForm.target_weight ? parseFloat(goalForm.target_weight) : null,
              target_kcal:   goalForm.target_kcal   ? parseInt(goalForm.target_kcal, 10) : null,
              goal_type:     goalForm.goal_type || null,
              deadline:      goalForm.deadline || null,
            })}
            disabled={goalMutation.isPending}
          >
            {goalMutation.isPending ? '保存中…' : '目標を保存'}
          </button>
        </div>
      )}

      {/* External services */}
      <div className="section-title">外部サービス連携</div>
      {SERVICES.map((svc) => {
        const isConn = connectedServices.includes(svc.key);
        return (
          <div className="card service-card" key={svc.key}>
            <div className="service-card-inner">
              <div className="service-card-info">
                <div className="service-card-name">{svc.label}</div>
                <div className="service-card-desc">{svc.desc}</div>
              </div>
              <div className="service-card-action">
                {isConn ? (
                  <>
                    <span className="connected-badge">
                      <Wifi size={11} strokeWidth={2} style={{ marginRight: 3 }} />
                      連携済み
                    </span>
                    <button className="btn btn-danger btn-sm" onClick={() => disconnectMutation.mutate(svc.key)}>
                      解除
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => handleConnect(svc.key)}>
                    <WifiOff size={13} strokeWidth={2} style={{ marginRight: 4 }} />
                    連携する
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {connectedServices.includes('google') && (
        <button
          className="btn btn-outline btn-full"
          style={{ marginBottom: 12 }}
          onClick={() => syncCalMutation.mutate()}
          disabled={syncCalMutation.isPending}
        >
          <CalendarSync size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {syncCalMutation.isPending ? 'カレンダー同期中…' : 'カレンダーリストを同期'}
        </button>
      )}

      {/* LLM / BYOK */}
      <div className="section-title">LLMプラン</div>
      <div className="card">
        <div className="card-title">
          現在のプラン: {profile?.plan_type === 'byok' ? 'BYOKプラン' : '無料プラン (Groq)'}
        </div>
        {apiKeys.map((k) => (
          <div key={k.provider} className="list-item">
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {BYOK_PROVIDERS.find((p) => p.key === k.provider)?.label || k.provider}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>…{k.hint}</div>
            </div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => deleteKeyMutation.mutate(k.provider)}
            >
              <Trash2 size={13} strokeWidth={2} style={{ marginRight: 4 }} />
              削除
            </button>
          </div>
        ))}

        <button className="btn btn-secondary btn-full" style={{ marginTop: 12 }} onClick={() => setShowApiKeyForm(true)}>
          <Plus size={14} strokeWidth={2} style={{ marginRight: 4 }} />
          APIキーを追加（BYOKプランに切り替え）
        </button>

        {showApiKeyForm && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--bg)', borderRadius: 8 }}>
            <div className="form-group">
              <label className="form-label">プロバイダー</label>
              <select className="form-input" value={newApiKey.provider} onChange={(e) => setNewApiKey((k) => ({ ...k, provider: e.target.value }))}>
                {BYOK_PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}{!p.vision ? ' (写真推定不可)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">APIキー</label>
              <input
                className="form-input"
                type="password"
                placeholder="sk-…"
                value={newApiKey.key}
                onChange={(e) => setNewApiKey((k) => ({ ...k, key: e.target.value }))}
              />
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                ※ AES-256-GCMで暗号化して保存。末尾4文字のみ表示されます。
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => apiKeyMutation.mutate({ provider: newApiKey.provider, api_key: newApiKey.key })}
                disabled={!newApiKey.key || apiKeyMutation.isPending}
              >
                {apiKeyMutation.isPending ? '登録中…' : '登録'}
              </button>
              <button className="btn btn-outline" onClick={() => setShowApiKeyForm(false)}>キャンセル</button>
            </div>
          </div>
        )}
      </div>

      {/* Diet preferences */}
      <div className="section-title">食の好み</div>
      <div className="card">
        <div className="card-title">ダイエットスタイル</div>
        <div className="chip-list">
          {DIET_STYLES.map((style) => (
            <div
              key={style}
              className="chip"
              style={dietStyles.includes(style) ? {} : { background: 'var(--bg)', color: 'var(--text-secondary)' }}
              onClick={() => toggleDietStyle(style)}
            >
              {dietStyles.includes(style) ? '✓ ' : ''}{style}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">除外食材（アレルギー・嫌いなもの）</div>
        <div className="chip-list" style={{ marginBottom: 12 }}>
          {excludedFoods.map((food) => (
            <div key={food} className="chip removable" onClick={() => removeExcluded(food)}>
              {food}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            placeholder="例: 甲殻類、乳製品…"
            value={excludedInput}
            onChange={(e) => setExcludedInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addExcluded()}
          />
          <button className="btn btn-secondary" onClick={addExcluded}>追加</button>
        </div>
      </div>
    </div>
  );
}
