import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { loginEmail, loginGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchParams] = useSearchParams();

  // OAuthコールバックからのエラー（ユーザーがDB未登録でサービス連携しようとした場合）
  const callbackError = searchParams.get('error');
  const callbackErrorMsg =
    callbackError === 'please_register_first'
      ? 'アカウントが未登録です。先に新規登録してください。'
      : null;

  const handleEmail = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await loginEmail(email, password);
    } catch (err) {
      setError('メールアドレスまたはパスワードが正しくありません');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setLoading(true);
    try {
      await loginGoogle();
    } catch (err) {
      setError('Googleログインに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <h1>🥗 健康ナビ</h1>
          <p>AIパーソナライズ献立で健康的な毎日を</p>
        </div>

        {callbackErrorMsg && <div className="alert alert-error">{callbackErrorMsg}</div>}
        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleEmail}>
          <div className="form-group">
            <label className="form-label">メールアドレス</label>
            <input
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label className="form-label">パスワード</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>

        <div className="auth-divider">または</div>

        <button className="btn btn-outline btn-full" onClick={handleGoogle} disabled={loading}>
          <span>G</span> Googleでログイン
        </button>

        <p style={{ textAlign: 'center', marginTop: 20, fontSize: 14, color: 'var(--text-secondary)' }}>
          アカウントをお持ちでない方は{' '}
          <Link to="/register" style={{ color: 'var(--primary-dark)' }}>新規登録</Link>
        </p>

        <div className="auth-legal-links">
          <Link to="/terms">利用規約</Link>
          <span aria-hidden="true">·</span>
          <Link to="/privacy">プライバシーポリシー</Link>
        </div>
      </div>
    </div>
  );
}
