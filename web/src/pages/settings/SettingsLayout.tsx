// Settings shell: a compact sub-nav on the left and the chosen page across the rest of the width (desktop),
// or a drill-down menu → page with a back button (phones). Nav rows carry live status/counts.
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Database, KeyRound, LayoutGrid, Landmark, Palette, Tags, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useCategories, useMeta, usePlaidItems, useRules } from '../../lib/queries';
import { ACCENTS, usePrefs } from '../../lib/prefs';
import { timeAgo } from '../../lib/format';
import { Page, PageHeader, Panel, useIsPhone } from '../../components/ui';

export type Passkey = { id: string; name: string; backedUp?: boolean; createdAt: number; lastUsedAt: number | null };
export type Session = { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string; ua: string };
export const usePasskeys = () => useQuery({ queryKey: ['passkeys'], queryFn: () => api<Passkey[]>('/passkeys') });
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/sessions') });

type Item = { to: string; label: string; icon: ReactNode; sub: ReactNode; end?: ReactNode; status?: 'ok' | 'warn' | 'bad' };

export function useSettingsMenu(): { group: string; items: Item[] }[] {
  const meta = useMeta();
  const items = usePlaidItems();
  const cats = useCategories();
  const rules = useRules();
  const passkeys = usePasskeys();
  const sessions = useSessions();
  const prefs = usePrefs();
  const banks = items.data || [];
  const broken = banks.filter((b) => b.status !== 'ok').length;
  const last = banks.map((b) => b.last_synced_at).filter(Boolean).sort().at(-1) || null;
  const active = (cats.data?.categories || []).filter((c) => !c.archived).length;
  const configured = meta.data?.plaid.configured;

  return [
    {
      group: 'Money',
      items: [
        {
          to: 'connections', label: 'Connections', icon: <Landmark />,
          status: !meta.data ? undefined : !configured ? 'warn' : broken ? 'bad' : banks.length ? 'ok' : undefined,
          end: banks.length || undefined,
          sub: !meta.data ? '…' : !configured ? 'Plaid not set up yet' : broken ? `${broken} need${broken === 1 ? 's' : ''} attention`
            : banks.length ? `${banks.length} bank${banks.length > 1 ? 's' : ''} · synced ${timeAgo(last)}` : 'No banks connected',
        },
        { to: 'categories', label: 'Categories', icon: <Tags />, end: cats.data ? active : undefined, sub: cats.data ? `${active} categories in ${cats.data.groups.length} groups` : '…' },
        { to: 'rules', label: 'Rules', icon: <Wand2 />, end: rules.data?.length || undefined, sub: rules.data ? (rules.data.length ? `${rules.data.length} rule${rules.data.length > 1 ? 's' : ''}` : 'Automate categories and names') : '…' },
      ],
    },
    {
      group: 'You',
      items: [
        {
          to: 'appearance', label: 'Appearance', icon: <Palette />,
          sub: `${prefs.theme === 'system' ? 'Matches device' : prefs.theme === 'dark' ? 'Dark' : 'Light'} · ${ACCENTS.find((a) => a.value === prefs.accent)?.label}${prefs.density !== 'default' ? ` · ${prefs.density}` : ''}${prefs.privacy ? ' · Privacy on' : ''}`,
        },
        {
          to: 'security', label: 'Passkeys & sign-in', icon: <KeyRound />,
          status: passkeys.data && passkeys.data.length < 2 ? 'warn' : undefined,
          end: passkeys.data?.length,
          sub: passkeys.data && sessions.data ? `${passkeys.data.length} passkey${passkeys.data.length === 1 ? '' : 's'} · ${sessions.data.length} signed-in device${sessions.data.length === 1 ? '' : 's'}` : '…',
        },
        { to: 'data', label: 'Data & privacy', icon: <Database />, sub: meta.data?.demo ? 'Demo data loaded · export' : 'Export, maintenance' },
      ],
    },
  ];
}

// Desktop: compact sub-nav. Phones: a list with one-line status under each entry.
function SettingsNav({ phone }: { phone: boolean }) {
  const menu = useSettingsMenu();
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  // Tablets show the nav as a horizontal strip: keep the current page's tab in view.
  useEffect(() => {
    nav.current?.querySelector('.subnav-link.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  if (phone)
    return (
      <div className="stack settings-menu-list">
        {menu.map((g) => (
          <Panel key={g.group} title={g.group} flush>
            <div className="list">
              {g.items.map((it) => (
                <Link key={it.to} to={`/settings/${it.to}`} viewTransition className="rowlink">
                  {it.icon}
                  <span className="grow">
                    <span style={{ display: 'block', fontWeight: 500 }}>{it.label}</span>
                    <span className="sub row" style={{ gap: 6 }}>{it.status && <i className={`dot ${it.status === 'ok' ? '' : it.status}`} />}<span className="ellipsis">{it.sub}</span></span>
                  </span>
                  <ChevronRight size={16} className="faint" />
                </Link>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    );
  return (
    <nav className="subnav" aria-label="Settings" ref={nav}>
      <NavLink to="/settings" end viewTransition className={({ isActive }) => `subnav-link ${isActive ? 'active' : ''}`}>
        <LayoutGrid />
        <span>Overview</span>
      </NavLink>
      {menu.map((g) => (
        <div key={g.group} className="subnav">
          <div className="subnav-section">{g.group}</div>
          {g.items.map((it) => (
            <NavLink key={it.to} to={`/settings/${it.to}`} viewTransition className={({ isActive }) => `subnav-link ${isActive ? 'active' : ''}`} title={typeof it.sub === 'string' ? it.sub : undefined}>
              {it.icon}
              <span>{it.label}</span>
              {(it.status || it.end != null) && (
                <span className="end">
                  {it.end}
                  {it.status && it.status !== 'ok' && <i className={`dot ${it.status}`} />}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

// Header for each settings page: title, one-line purpose, actions; optional toolbar row underneath.
export function SettingsHeader({ title, sub, actions, toolbar }: { title: string; sub?: ReactNode; actions?: ReactNode; toolbar?: ReactNode }) {
  return (
    <>
      <div className="pane-head">
        <div className="t">
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {toolbar && <div className="pane-toolbar">{toolbar}</div>}
    </>
  );
}

const TITLES: Record<string, string> = {
  connections: 'Connections', categories: 'Categories', rules: 'Rules', appearance: 'Appearance', security: 'Passkeys & sign-in', data: 'Data & privacy',
};

export default function SettingsLayout() {
  const loc = useLocation();
  const phone = useIsPhone();
  const atRoot = /^\/settings\/?$/.test(loc.pathname);
  const section = TITLES[loc.pathname.split('/')[2] || ''] || 'Overview';
  // On phones the root is the menu itself; on desktop it's the Overview page.
  const showMenuOnly = phone && atRoot;
  return (
    <Page>
      {phone && !atRoot ? (
        <PageHeader title={section} back="/settings" />
      ) : (
        <PageHeader title="Settings" />
      )}
      <div className={`settings ${showMenuOnly ? 'at-root' : 'at-page'}`}>
        {(!phone || showMenuOnly) && (
          <aside className="settings-side">
            <SettingsNav phone={phone} />
          </aside>
        )}
        {!showMenuOnly && (
          <section className="settings-pane">
            <Outlet />
          </section>
        )}
      </div>
    </Page>
  );
}
