import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function RegisterPage() {
  const { registerEmail, loginGoogle } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', terms: false, privacy: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.terms || !form.privacy) {
      setError('利用規約とプライバシーポリシーへの同意が必要です');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await registerEmail(form.email, form.password, form.name);
    } catch (err) {
      setError(err.message || '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <h1>🥗 健康ナビ</h1>
          <p>新規アカウント登録</p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">お名前</label>
            <input className="form-input" value={form.name} onChange={set('name')} required />
          </div>
          <div className="form-group">
            <label className="form-label">メールアドレス</label>
            <input type="email" className="form-input" value={form.email} onChange={set('email')} required />
          </div>
          <div className="form-group">
            <label className="form-label">パスワード（6文字以上）</label>
            <input type="password" className="form-input" value={form.password} onChange={set('password')} minLength={6} required />
          </div>

          <div style={{ marginBottom: 16, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={form.terms} onChange={set('terms')} style={{ marginTop: 3 }} />
              <span><a href="#" style={{ color: 'var(--primary-dark)' }}>利用規約</a>に同意します</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={form.privacy} onChange={set('privacy')} style={{ marginTop: 3 }} />
              <span><a href="#" style={{ color: 'var(--primary-dark)' }}>プライバシーポリシー</a>に同意します（健康データはアプリ内のみ使用）</span>
            </label>
          </div>

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? '登録中...' : 'アカウント作成'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
          すでにアカウントをお持ちの方は{' '}
          <Link to="/login" style={{ color: 'var(--primary-dark)' }}>ログイン</Link>
        </p>
      </div>
    </div>
  );
}
