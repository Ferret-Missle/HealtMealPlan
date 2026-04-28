import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Wifi, WifiOff, Trash2, Plus, LogOut, CalendarSync } from 'lucide-react';
import { settingsApi, authApi } from '../../services/api';
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

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
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
