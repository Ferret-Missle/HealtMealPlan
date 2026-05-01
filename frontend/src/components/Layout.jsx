import { useState, useEffect } from 'react';
import { Link, Outlet, NavLink, useLocation } from 'react-router-dom';

import { LayoutDashboard, CalendarDays, ListChecks, UserCircle2, Leaf, Menu, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

const NAV_ITEMS = [
  { to: '/',      label: 'ダッシュボード', Icon: LayoutDashboard, end: true },
  { to: '/plan',  label: 'プラン',    Icon: CalendarDays,    end: false },
  { to: '/list',  label: 'リスト',    Icon: ListChecks,      end: false },
  { to: '/me',    label: 'マイページ', Icon: UserCircle2,     end: false },
];

export default function Layout({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pendingInvitations } = useAuth();
  const location = useLocation();

  const formatExpiresAt = (expiresAt) => new Date(expiresAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // ルート遷移時に自動でドロワーを閉じる
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Esc で閉じる
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // ドロワー展開中は背景スクロールを抑止
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  return (
    <div className="app-layout">
      {/* ── Top header with hamburger ── */}
      <header className="app-header">
        <button
          type="button"
          className="hamburger-btn"
          aria-label={drawerOpen ? 'メニューを閉じる' : 'メニューを開く'}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          {drawerOpen ? <X size={22} strokeWidth={2} /> : <Menu size={22} strokeWidth={2} />}
        </button>
        <Link to="/" className="app-header-brand">
          <Leaf size={18} strokeWidth={2.5} className="app-header-logo" />
          <span className="app-header-title">健康ナビ</span>
        </Link>
      </header>

      {/* ── Drawer overlay ── */}
      <div
        className={`drawer-overlay${drawerOpen ? ' open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden={!drawerOpen}
      />

      {/* ── Drawer ── */}
      <aside
        className={`drawer${drawerOpen ? ' open' : ''}`}
        aria-hidden={!drawerOpen}
      >
        <div className="drawer-brand">
          <Leaf size={20} strokeWidth={2.5} className="drawer-logo" />
          <span className="drawer-title">健康ナビ</span>
        </div>
        <nav className="drawer-nav">
          {NAV_ITEMS.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `drawer-item${isActive ? ' active' : ''}`}
            >
              <Icon size={18} strokeWidth={1.5} className="nav-icon" />
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* ── Main content ── */}
      <div className="app-body">
        <main className="app-main">
          {pendingInvitations.length > 0 && (
            <section className="invite-notice" aria-label="グループ招待のお知らせ">
              <div className="invite-notice-heading">グループ招待があります</div>
              <p className="invite-notice-copy">
                ログイン中のメールアドレス宛に未処理の招待が届いています。下の URL から招待ページへ進めます。
              </p>
              <div className="invite-notice-list">
                {pendingInvitations.map((invitation) => (
                  <article key={invitation.id} className="invite-notice-item">
                    <div className="invite-notice-title">{invitation.group_name} への招待</div>
                    <div className="invite-notice-meta">
                      {invitation.inviter_name} さんから招待されています
                      <span>有効期限: {formatExpiresAt(invitation.expires_at)}</span>
                    </div>
                    <a className="invite-notice-url" href={invitation.invite_url}>
                      {invitation.invite_url}
                    </a>
                    <div className="invite-notice-actions">
                      <Link className="btn btn-primary" to={`/invite/${invitation.token}`}>
                        招待を確認
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          <Outlet />
        </main>
        {children}
      </div>

      {/* ── Mobile: bottom nav ── */}
      <nav className="bottom-nav">
        {NAV_ITEMS.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon">
              <Icon size={22} strokeWidth={1.5} />
            </span>
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
