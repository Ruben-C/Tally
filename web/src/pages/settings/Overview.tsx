// Settings landing (desktop): health and inventory at a glance, the few things that need attention,
// and the switches people flip most. Every figure links to the page that manages it.
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useCategories, useMeta, usePlaidItems, useRules } from '../../lib/queries';
import { setDensity, setPrivacy, setTheme, usePrefs, type Density, type Theme } from '../../lib/prefs';
import { timeAgo } from '../../lib/format';
import { Badge, ButtonLink, CatLabel, DataTable, FormRow, Panel, PanelLink, Segmented, Stat, StatGrid, Switch } from '../../components/ui';
import { SettingsHeader, usePasskeys, useSessions } from './SettingsLayout';

const STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  ok: { label: 'Healthy', tone: 'good' },
  login_required: { label: 'Sign-in needed', tone: 'bad' },
  pending_expiration: { label: 'Expiring soon', tone: 'warn' },
  error: { label: 'Sync error', tone: 'bad' },
};

export default function Overview() {
  const meta = useMeta();
  const items = usePlaidItems();
  const rules = useRules();
  const cats = useCategories();
  const passkeys = usePasskeys();
  const sessions = useSessions();
  const prefs = usePrefs();
  const broken = (items.data || []).filter((i) => i.status !== 'ok');
  const tasks: { tone: 'warn' | 'bad'; title: string; body: string; to: string; cta: string }[] = [];
  if (meta.data && !meta.data.plaid.configured)
    tasks.push({ tone: 'warn', title: 'Finish bank connection setup', body: 'Add your Plaid keys so Tally can link real accounts.', to: 'connections', cta: 'Set up' });
  for (const b of broken)
    tasks.push({ tone: 'bad', title: `${b.institution_name || 'A bank'} needs you to sign in again`, body: b.error_message || 'Transactions stop syncing until you reconnect.', to: 'connections', cta: 'Reconnect' });
  if (passkeys.data && passkeys.data.length < 2)
    tasks.push({ tone: 'warn', title: 'Add a backup passkey', body: 'Passkeys are the only way in. A second device keeps you from being locked out.', to: 'security', cta: 'Add one' });
  if (meta.data?.demo && meta.data.plaid.configured)
    tasks.push({ tone: 'warn', title: 'Demo data is still loaded', body: 'Remove it once your real accounts are connected.', to: 'data', cta: 'Review' });

  const activeCats = (cats.data?.categories || []).filter((c) => !c.archived);
  const unused = activeCats.filter((c) => !c.tx_count).length;
  const topRules = [...(rules.data || [])].sort((a, b) => (b.matches || 0) - (a.matches || 0)).slice(0, 6);
  const last = (items.data || []).map((b) => b.last_synced_at).filter(Boolean).sort().at(-1) || null;

  return (
    <>
      <SettingsHeader title="Overview" sub="Health, inventory and the switches you use most." />

      <StatGrid>
        <Stat label="Bank connections" value={items.data?.length ?? '—'} sub={meta.data && !meta.data.plaid.configured ? <span className="warn">Plaid not set up</span> : broken.length ? <span className="neg">{broken.length} need attention</span> : `Synced ${timeAgo(last)}`} to="connections" />
        <Stat label="Accounts" value={meta.data?.accounts ?? '—'} sub={meta.data?.demo ? 'Demo data loaded' : undefined} to="/accounts" />
        <Stat label="Categories" value={activeCats.length || '—'} sub={cats.data ? `${cats.data.groups.length} groups · ${unused} unused` : undefined} to="categories" />
        <Stat label="Rules" value={rules.data?.length ?? '—'} sub={rules.data ? `${rules.data.reduce((a, r) => a + (r.matches || 0), 0)} matches` : undefined} to="rules" />
        <Stat label="Passkeys" value={passkeys.data?.length ?? '—'} sub={passkeys.data && passkeys.data.length < 2 ? <span className="warn">Add a backup</span> : 'Enough to recover'} to="security" />
        <Stat label="Signed-in devices" value={sessions.data?.length ?? '—'} to="security" />
      </StatGrid>

      <div className="grid cols-2">
        <Panel title="Needs attention" meta={tasks.length ? `${tasks.length} item${tasks.length > 1 ? 's' : ''}` : undefined} flush>
          {tasks.length ? (
            <DataTable
              sticky={false}
              rows={tasks}
              rowKey={(t) => t.title}
              columns={[
                {
                  key: 't', header: 'Issue', wide: true,
                  cell: (t) => (
                    <div className="cell">
                      <AlertTriangle size={14} className={t.tone === 'bad' ? 'neg' : 'warn'} style={{ flex: 'none' }} />
                      <span className="ellipsis primary" title={t.body}>{t.title}</span>
                    </div>
                  ),
                  sub: (t) => t.body,
                },
                { key: 'a', shrink: true, cell: (t) => <ButtonLink to={t.to} size="sm">{t.cta}</ButtonLink> },
              ]}
            />
          ) : (
            <div className="row" style={{ padding: '12px 14px', gap: 8 }}>
              <CheckCircle2 size={15} className="pos" />
              <span className="muted">Everything is set up and healthy.</span>
            </div>
          )}
        </Panel>

        <Panel title="Quick switches">
          <FormRow label="Theme">
            <Segmented size="sm" value={prefs.theme} onChange={(v: Theme) => setTheme(v)} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </FormRow>
          <FormRow label="Density">
            <Segmented size="sm" value={prefs.density} onChange={(v: Density) => setDensity(v)} options={[{ value: 'compact', label: 'Compact' }, { value: 'default', label: 'Default' }, { value: 'comfortable', label: 'Comfortable' }]} />
          </FormRow>
          <FormRow label="Privacy mode" hint="Blur amounts; hover to peek">
            <Switch on={prefs.privacy} label="Privacy mode" onChange={setPrivacy} />
          </FormRow>
        </Panel>

        <Panel title="Connections" actions={<PanelLink to="connections">Manage</PanelLink>} flush>
          <DataTable
            sticky={false}
            rows={items.data || []}
            rowKey={(b) => b.id}
            loading={items.isLoading}
            skeletonRows={2}
            empty={<div className="dt-empty">{meta.data?.plaid.configured ? 'No banks connected yet.' : 'Bank connections aren’t set up yet.'}</div>}
            columns={[
              { key: 'n', header: 'Institution', wide: true, cell: (b) => <span className="primary ellipsis">{b.institution_name || 'Bank'}</span> },
              { key: 's', header: 'Status', shrink: true, cell: (b) => { const s = STATUS[b.status] || STATUS.error; return <Badge tone={s.tone}>{s.label}</Badge>; } },
              { key: 'a', header: 'Accounts', num: true, cell: (b) => b.accounts },
              { key: 'l', header: 'Last sync', align: 'right', hide: 'sm', cell: (b) => <span className="muted">{timeAgo(b.last_synced_at)}</span> },
            ]}
          />
        </Panel>

        <Panel title="Busiest rules" actions={<PanelLink to="rules">All rules</PanelLink>} flush>
          <DataTable
            sticky={false}
            rows={topRules}
            rowKey={(r) => r.id}
            loading={rules.isLoading}
            skeletonRows={3}
            empty={<div className="dt-empty">No rules yet. <Link className="link" to="rules">Create one</Link></div>}
            columns={[
              { key: 'p', header: 'Matches on', wide: true, cell: (r) => <span className="ellipsis" style={{ display: 'block' }}>{r.pattern ? <code>{r.pattern}</code> : <span className="muted">{r.account_label || 'Any transaction'}</span>}</span> },
              { key: 'c', header: 'Sets', hide: 'sm', cell: (r) => (r.set_category_id ? <CatLabel cat={{ emoji: r.emoji || '', color: r.color || '#8e8e93', name: r.category_name || '' }} /> : r.goal_splits.length ? <span className="muted">{r.goal_splits.length} goal split{r.goal_splits.length > 1 ? 's' : ''}</span> : <span className="muted">{r.set_display_name ? 'Rename' : 'Review'}</span>) },
              { key: 'm', header: 'Matches', num: true, cell: (r) => r.matches ?? 0 },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
