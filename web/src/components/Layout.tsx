import { useEffect } from 'react';
import { NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { ArrowLeftRight, CalendarClock, Home, Landmark, LineChart, PieChart, Search, Settings, MoreHorizontal, Target } from 'lucide-react';
import { useMeta, usePlaidItems } from '../lib/queries';
import { timeAgo } from '../lib/format';
import CommandPalette, { useCommandPalette } from './CommandPalette';

type NavItem = { to: string; label: string; icon: typeof Home; end?: boolean; badge?: boolean };
const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: Home, end: true }] },
  {
    section: 'Money',
    items: [
      { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, badge: true },
      { to: '/accounts', label: 'Accounts', icon: Landmark },
      { to: '/recurring', label: 'Recurring', icon: CalendarClock },
    ],
  },
  {
    section: 'Plan',
    items: [
      { to: '/budgets', label: 'Budgets', icon: PieChart },
      { to: '/goals', label: 'Goals', icon: Target },
    ],
  },
  { section: 'Reports', items: [{ to: '/insights', label: 'Cash Flow', icon: LineChart }] },
];
const flat = NAV.flatMap((g) => g.items);
const TABS = ['/', '/transactions', '/budgets', '/goals'].map((p) => flat.find((n) => n.to === p)!); // the rest live under More

// Pages open the palette with window.dispatchEvent(new Event('tally:palette')).
export const openPalette = () => window.dispatchEvent(new Event('tally:palette'));

export default function Layout() {
  const meta = useMeta();
  const items = usePlaidItems();
  const loc = useLocation();
  const [palette, setPalette] = useCommandPalette();
  useEffect(() => {
    const h = () => setPalette(true);
    window.addEventListener('tally:palette', h);
    return () => window.removeEventListener('tally:palette', h);
  }, [setPalette]);
  const review = meta.data?.to_review || 0;
  const broken = (items.data || []).filter((i) => i.status !== 'ok').length;
  const last = (items.data || []).map((i) => i.last_synced_at).filter(Boolean).sort().at(-1) || null;
  const moreActive = ['/recurring', '/insights', '/settings', '/more', '/accounts'].some((p) => loc.pathname.startsWith(p));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icons/icon.svg" alt="" />
          <span>Tally</span>
          {meta.data?.demo && <span className="brand-tag">Demo</span>}
        </div>
        <button className="search-trigger" onClick={() => setPalette(true)} title="Search (⌘K)" aria-label="Search">
          <Search />
          <span>Search</span>
          <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
        <nav className="nav">
          {NAV.map((g, i) => (
            <div key={i} className="nav">
              {g.section && <div className="nav-section">{g.section}</div>}
              {g.items.map(({ to, label, icon: Icon, end, badge }) => (
                <NavLink key={to} to={to} end={end} viewTransition className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={label}>
                  <Icon />
                  <span>{label}</span>
                  {badge && review > 0 && <em className="nav-badge">{review > 99 ? '99+' : review}</em>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          {(items.data?.length || 0) > 0 && (
            <div className="sync-status" title={broken ? 'A connection needs attention' : 'Connections healthy'}>
              <i className={`dot ${broken ? 'warn' : ''}`} />
              <span>{broken ? `${broken} connection${broken > 1 ? 's' : ''} need attention` : `Synced ${timeAgo(last)}`}</span>
            </div>
          )}
          <NavLink to="/settings" viewTransition className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title="Settings">
            <Settings />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>
      <main className="main">
        <Outlet />
        {/* Keyed by path: each tab keeps its own scroll position and opens at the top the first time;
            query-string changes (filters) don't jump. */}
        <ScrollRestoration getKey={(l) => l.pathname} />
      </main>
      <nav className="tabbar">
        {TABS.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink key={to} to={to} end={end} viewTransition className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <Icon />
            <span>{label}</span>
            {badge && review > 0 && <em className="nav-badge">{review > 99 ? '99+' : review}</em>}
          </NavLink>
        ))}
        <NavLink to="/more" viewTransition className={`tab ${moreActive ? 'active' : ''}`}>
          <MoreHorizontal />
          <span>More</span>
        </NavLink>
      </nav>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
