import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, ListChecks, UserCircle2, Leaf, Menu, X } from 'lucide-react';

const NAV_ITEMS = [
  { to: '/',      label: 'ダッシュボード', Icon: LayoutDashboard, end: true },
  { to: '/plan',  label: 'プラン',    Icon: CalendarDays,    end: false },
  { to: '/list',  label: 'リスト',    Icon: ListChecks,      end: false },
  { to: '/me',    label: 'マイページ', Icon: UserCircle2,     end: false },
];

export default function Layout({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

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
        <div className="app-header-brand">
          <Leaf size={18} strokeWidth={2.5} className="app-header-logo" />
          <span className="app-header-title">健康ナビ</span>
        </div>
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
