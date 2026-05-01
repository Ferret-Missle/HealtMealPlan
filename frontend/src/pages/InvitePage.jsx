import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { groupApi } from '../services/api';

export const INVITE_TOKEN_KEY = 'pending_invite_token';

export default function InvitePage() {
  const { token } = useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('idle'); // idle | joining | success | error
  const [errorMsg, setErrorMsg] = useState('');

  // トークンを sessionStorage に保存しておく
  // （未ログインの場合にログイン後も使えるようにする）
  useEffect(() => {
    if (token) sessionStorage.setItem(INVITE_TOKEN_KEY, token);
  }, [token]);

  // ログイン済みなら自動で参加処理
  useEffect(() => {
    if (loading || !user || status !== 'idle') return;
    setStatus('joining');
    groupApi
      .join(token)
      .then(() => {
        sessionStorage.removeItem(INVITE_TOKEN_KEY);
        setStatus('success');
        // 少し待ってからホームへ
        setTimeout(() => navigate('/', { replace: true }), 1800);
      })
      .catch((e) => {
        sessionStorage.removeItem(INVITE_TOKEN_KEY);
        setStatus('error');
        setErrorMsg(e.response?.data?.detail || 'グループへの参加に失敗しました');
      });
  }, [loading, user, status, token, navigate]);

  // ─── ローディング中 ───────────────────────────────────────────────
  if (loading || status === 'joining') {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        {status === 'joining' && (
          <p style={{ marginTop: 16, color: 'var(--text-secondary)' }}>グループに参加中...</p>
        )}
      </div>
    );
  }

  // ─── 参加成功 ──────────────────────────────────────────────────────
  if (status === 'success') {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h2 style={{ marginBottom: 8 }}>グループに参加しました！</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>
            ホームページに移動します...
          </p>
          <Link to="/" className="btn btn-primary btn-full" replace>
            今すぐホームへ
          </Link>
        </div>
      </div>
    );
  }

  // ─── エラー ────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
          <h2 style={{ marginBottom: 8 }}>参加できませんでした</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 20 }}>{errorMsg}</p>
          <Link to="/" className="btn btn-primary btn-full">
            ホームへ戻る
          </Link>
        </div>
      </div>
    );
  }

  // ─── 未ログイン ────────────────────────────────────────────────────
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <h1>🥗 健康ナビ</h1>
          <p>グループへの招待リンクです</p>
        </div>
        <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 24 }}>
          グループに参加するにはアカウントが必要です。
        </p>
        <Link to="/login" className="btn btn-primary btn-full" style={{ marginBottom: 10 }}>
          ログインして参加
        </Link>
        <Link to="/register" className="btn btn-outline btn-full">
          新規登録して参加
        </Link>
        <div className="auth-legal-links" style={{ marginTop: 20 }}>
          <Link to="/terms">利用規約</Link>
          <span aria-hidden="true">·</span>
          <Link to="/privacy">プライバシーポリシー</Link>
        </div>
      </div>
    </div>
  );
}
