import { Outlet, NavLink } from 'react-router-dom';
import { LayoutDashboard, CalendarDays, ListChecks, UserCircle2, Leaf } from 'lucide-react';

const NAV_ITEMS = [
  { to: '/',      label: 'ダッシュボード', Icon: LayoutDashboard, end: true },
  { to: '/plan',  label: 'プラン',    Icon: CalendarDays,    end: false },
  { to: '/list',  label: 'リスト',    Icon: ListChecks,      end: false },
  { to: '/me',    label: 'マイページ', Icon: UserCircle2,     end: false },
];

export default function Layout({ children }) {
  return (
    <div className="app-layout">
      {/* ── Desktop: left sidebar ── */}
      <aside className="side-nav">
        <div className="side-nav-brand">
          <Leaf size={20} strokeWidth={2.5} className="side-nav-logo" />
          <span className="side-nav-title">健康ナビ</span>
        </div>
        <nav className="side-nav-links">
          {NAV_ITEMS.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `side-nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={17} strokeWidth={1.5} className="nav-icon" />
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
