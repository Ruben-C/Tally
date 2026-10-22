import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ChevronRight, Landmark, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { useAccounts, useAllocations, useMeta, useMutate, useNetWorth, usePlaidItems } from '../lib/queries';
import { api } from '../lib/api';
import { ACCOUNT_GROUPS, isLiability, money, pct, shortDate, timeAgo } from '../lib/format';
import type { Account, NWPoint } from '../lib/types';
import {
  Badge, Button, ButtonLink, DataTable, Delta, Empty, IconButton, InlineEdit, Meter, Page, PageHeader, Panel, Segmented, Sheet, Skel, Sparkline, Stat, StatGrid, Switch,
  useToast, vars, type TableGroup,
} from '../components/ui';
import { NetWorthChart } from '../components/charts';
import { usePlaidConnect } from '../components/plaid';

const TYPE_EMOJI: Record<string, string> = { depository: '🏦', credit: '💳', investment: '📈', loan: '🧾', other: '💼' };
const TYPE_COLOR: Record<string, string> = { depository: '#4cb1ff', credit: '#ff9f0a', investment: '#3ddc84', loan: '#ff5f6d', other: '#8e8e93' };

export function AccountAvatar({ a, size = '' }: { a: Pick<Account, 'type' | 'institution_logo' | 'institution_color'>; size?: '' | 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size}`} style={vars({ '--c': a.institution_color || TYPE_COLOR[a.type] || '#8e8e93' })}>
      {a.institution_logo ? <img className="inst-logo" src={`data:image/png;base64,${a.institution_logo}`} alt="" /> : TYPE_EMOJI[a.type] || '💼'}
    </span>
  );
}

export function ConnectButton({ className = 'btn primary', label = 'Connect account' }: { className?: string; label?: string }) {
  const meta = useMeta();
  const { start, busy } = usePlaidConnect();
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => (meta.data?.plaid.configured ? start() : toast('Plaid keys aren’t set yet — add PLAID_CLIENT_ID and PLAID_SECRET to Tally’s .env and restart it', { kind: 'error' }))}
    >
      {busy ? <RefreshCw className="spin" /> : <Plus />} {label}
    </button>
  );
}

// First-run panel (no accounts yet): connect a bank or load the demo.
export function ConnectBanner({ big = false }: { big?: boolean }) {
  const meta = useMeta();
  const toast = useToast();
  const demo = useMutate(() => api<{ transactions: number }>('/demo', { body: {} }));
  const configured = meta.data?.plaid.configured;
  if (!big) return null;
  return (
    <Panel>
      <div className="welcome">
        <div className="icon"><Landmark /></div>
        <h2>Connect your accounts</h2>
        <p className="muted">
          Link your bank, cards, loans and investments to see spending, budgets, subscriptions and net worth in one place.
        </p>
        <div className="row wrap" style={{ justifyContent: 'center', marginTop: 4 }}>
          <ConnectButton className="btn primary" label="Connect your first account" />
          <Button icon={<Sparkles />} disabled={demo.isPending} onClick={() => demo.mutateAsync(undefined).then((r) => toast(`Loaded ${r.transactions} demo transactions`))}>
            Explore with demo data
          </Button>
        </div>
        {!configured && meta.data && (
          <p className="faint small">
            Bank connections switch on once Plaid keys are added to Tally's environment. The demo is fully interactive and can be removed in one click.
          </p>
        )}
      </div>
    </Panel>
  );
}

// Which goals this account funds, and how much of it is still free.
function AccountGoals({ accountId, onClose }: { accountId: number; onClose: () => void }) {
  const alloc = useAllocations();
  const a = alloc.data?.find((x) => x.account_id === accountId);
  if (!a) return null;
  return (
    <>
      <div className="section-label">Goals</div>
      {a.goals.length ? (
        <div className="kv">
          {a.goals.map((g) => (
            <Link key={g.goal_id} to={`/goals?open=${g.goal_id}`} viewTransition onClick={onClose}>
              <span className="avatar sm" style={vars({ '--c': g.color })}>{g.emoji}</span>
              <span className="grow ellipsis">{g.name}</span>
              <span className="faint small">{g.mode === 'full' ? 'Whole balance' : g.mode === 'percent' ? `${Number(g.percent)}%` : 'Fixed'}</span>
              <span className="num strong">{money(g.value, { cents: false })}</span>
            </Link>
          ))}
          <div>
            <span className="grow muted">{a.over ? 'Over-allocated by' : 'Not set aside for a goal'}</span>
            <span className={`num strong ${a.over ? 'neg' : ''}`}>{money(Math.abs(a.free), { cents: false })}</span>
          </div>
        </div>
      ) : (
        <div className="kv">
          <Link to="/goals" viewTransition onClick={onClose}>
            <span className="grow muted">Not funding any goals. Use all or part of it for a goal or bucket.</span>
            <ChevronRight size={14} className="faint" />
          </Link>
        </div>
      )}
    </>
  );
}

function AccountSheet({ a, onClose }: { a: Account; onClose: () => void }) {
  const toast = useToast();
  const update = useMutate((body: { display_name?: string; hidden?: boolean }) => api(`/accounts/${a.id}`, { method: 'PATCH', body }));
  const sync = useMutate(() => api(`/plaid/items/${a.item_id}/sync`, { body: {} }));
  const liab = isLiability(a.type);
  const util = a.type === 'credit' && a.credit_limit ? (a.current_balance || 0) / a.credit_limit : null;
  return (
    <Sheet
      title="Account"
      onClose={onClose}
      footer={
        <>
          <ButtonLink to={`/transactions?account=${a.id}`}>View transactions</ButtonLink>
          {a.item_id && (
            <Button icon={<RefreshCw className={sync.isPending ? 'spin' : ''} />} disabled={sync.isPending} onClick={() => sync.mutateAsync(undefined).then(() => toast('Synced')).catch((e) => toast(e.message, { kind: 'error' }))}>
              Sync now
            </Button>
          )}
        </>
      }
    >
      <div className="txn-head">
        <AccountAvatar a={a} size="lg" />
        <div style={{ minWidth: 0 }}>
          <InlineEdit value={a.label} aria-label="Account name" onCommit={(v) => update.mutateAsync({ display_name: v }).then(() => toast('Renamed'))} />
          <div className="meta">{a.institution_name}{a.mask ? ` ··${a.mask}` : ''} · {a.subtype || a.type}</div>
        </div>
        <div className={`amount num ${liab ? 'neg' : ''}`}>{money(liab ? -(a.current_balance || 0) : a.current_balance)}</div>
      </div>
      <div className="kv">
        {a.available_balance != null && (
          <div><span className="k">Available</span><span className="v num">{money(a.available_balance)}</span></div>
        )}
        {a.credit_limit != null && (
          <div><span className="k">Credit limit</span><span className="v num">{money(a.credit_limit, { cents: false })}</span></div>
        )}
        {util != null && (
          <div><span className="k">Utilization</span><span className="v"><span style={{ width: 160 }}><Meter value={util} max={1} color={util > 0.3 ? 'var(--yellow)' : 'var(--green)'} /></span></span></div>
        )}
        {a.balance_30d != null && (
          <div><span className="k">Last 30 days</span><span className="v"><Delta value={(a.current_balance || 0) - a.balance_30d} invert={liab} /></span></div>
        )}
        <div><span className="k">Updated</span><span className="v faint">{a.is_demo ? 'Demo account' : timeAgo(a.last_synced_at || a.updated_at)}</span></div>
      </div>
      <AccountGoals accountId={a.id} onClose={onClose} />
      <div className="section-label">Settings</div>
      <div className="kv">
        <label>
          <span className="grow">
            Hide account
            <span className="faint small" style={{ display: 'block' }}>Leave it out of net worth, budgets and cash flow</span>
          </span>
          <Switch on={a.hidden} label="Hide account" onChange={(v) => update.mutateAsync({ hidden: v }).then(() => toast(v ? 'Account hidden' : 'Account visible'))} />
        </label>
      </div>
    </Sheet>
  );
}

function RepairBanner({ id, name, error }: { id: number; name: string; error: string | null }) {
  const { start, busy } = usePlaidConnect({ itemId: id });
  return (
    <div className="banner warn">
      <div className="icon"><AlertTriangle /></div>
      <div className="grow">
        <span className="strong">{name} needs attention</span>
        <span className="muted"> · {error || 'Sign in again to keep transactions syncing.'}</span>
      </div>
      <Button size="sm" onClick={start} disabled={busy}>Reconnect</Button>
    </div>
  );
}

const RANGES = [
  { value: 30, label: '1M' },
  { value: 90, label: '3M' },
  { value: 180, label: '6M' },
  { value: 365, label: '1Y' },
  { value: 1825, label: 'All' },
];

// Balances are shown the way people think about them: debts as negative numbers.
const signed = (a: Account) => (isLiability(a.type) ? -(a.current_balance || 0) : a.current_balance || 0);
const change30 = (a: Account) => (a.balance_30d == null ? null : (isLiability(a.type) ? -1 : 1) * ((a.current_balance || 0) - a.balance_30d));

export default function Accounts() {
  const accounts = useAccounts();
  const items = usePlaidItems();
  const meta = useMeta();
  const toast = useToast();
  const [days, setDays] = useState(180);
  const [mode, setMode] = useState<'net' | 'split'>('net');
  const nw = useNetWorth(days);
  const [open, setOpen] = useState<Account | null>(null);
  const [scrub, setScrub] = useState<NWPoint | null>(null);
  const syncAll = useMutate(() => api<{ results: { error?: string }[] }>('/plaid/sync', { body: {} }));
  const series = (nw.data || []).filter((p, i, arr) => i === 0 || p.net !== 0 || arr[i - 1].net !== 0);
  const cur = series.at(-1);
  const first = series[0];
  const list = accounts.data || [];
  const shown = scrub || cur;

  const header = (
    <PageHeader
      title="Accounts"
      sub="Net worth across everything you own and owe"
      actions={
        <>
          {(items.data?.length || 0) > 0 && (
            <IconButton
              icon={<RefreshCw className={syncAll.isPending ? 'spin' : ''} />} label="Sync all" disabled={syncAll.isPending}
              onClick={() => syncAll.mutateAsync(undefined).then((r) => toast(r.results.some((x) => x.error) ? 'Some connections failed to sync' : 'Everything is up to date', { kind: r.results.some((x) => x.error) ? 'error' : 'ok' }))}
            />
          )}
          <ConnectButton label="Add account" className="btn primary sm" />
        </>
      }
    />
  );

  if (meta.data && meta.data.accounts === 0)
    return (
      <Page>
        {header}
        <ConnectBanner big />
      </Page>
    );

  const groups: TableGroup<Account>[] = ACCOUNT_GROUPS.map((g) => {
    const rows = list.filter((a) => g.types.includes(a.type));
    const vis = rows.filter((a) => !a.hidden);
    const total = vis.reduce((s, a) => s + signed(a), 0);
    const chg = vis.reduce((s, a) => s + (change30(a) ?? 0), 0);
    return {
      key: g.key,
      label: <>{g.label} <span className="faint">· {rows.length}</span></>,
      rows,
      cells: {
        change: Math.abs(chg) >= 0.5 ? <span className={chg >= 0 ? 'pos' : 'neg'}>{money(chg, { cents: false, sign: true })}</span> : null,
        balance: <span className={total < 0 ? 'neg' : ''}>{money(total, { cents: false })}</span>,
      },
    };
  }).filter((g) => g.rows.length);

  const sk = <Skel w={90} h={18} />;
  const since = first ? new Date(first.date + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 365 ? 'numeric' : undefined }) : '';

  return (
    <Page>
      {header}

      {(items.data || []).filter((i) => i.status !== 'ok').map((i) => (
        <RepairBanner key={i.id} id={i.id} name={i.institution_name || 'A connection'} error={i.error_message} />
      ))}

      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat large label={scrub ? `Net worth · ${shortDate(scrub.date)}` : 'Net worth'} value={shown ? money(shown.net, { cents: false }) : sk}
          sub={shown && first ? <><Delta value={shown.net - first.net} /> {first.net ? pct(Math.abs((shown.net - first.net) / first.net)) : ''} since {since}</> : undefined} />
        <Stat label="Assets" value={shown ? money(shown.assets, { cents: false }) : sk} sub={shown && first ? <><Delta value={shown.assets - first.assets} /> since {since}</> : undefined} />
        <Stat label="Liabilities" tone="bad" value={shown ? money(shown.liabilities, { cents: false }) : sk} sub={shown && first ? <><Delta value={shown.liabilities - first.liabilities} invert /> since {since}</> : undefined} />
        <Stat label="Accounts" value={accounts.data ? list.filter((a) => !a.hidden).length : sk}
          sub={accounts.data ? list.length > 0 && list.every((a) => a.is_demo) ? 'Demo accounts' : `${(items.data || []).length} connection${(items.data || []).length === 1 ? '' : 's'}${list.some((a) => a.hidden) ? ` · ${list.filter((a) => a.hidden).length} hidden` : ''}` : undefined} />
      </StatGrid>

      <Panel
        title={mode === 'net' ? 'Net worth' : 'Assets and debts'}
        meta={scrub ? shortDate(scrub.date) : first ? `since ${since}` : undefined}
        actions={
          <>
            <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'net', label: 'Net' }, { value: 'split', label: 'Assets / Debts' }]} />
            <Segmented size="sm" value={days} onChange={setDays} options={RANGES} />
          </>
        }
        className="wrap-head"
        style={{ marginBottom: 'var(--gap)' }}
      >
        <div className="chart-box">{nw.data ? <NetWorthChart data={series} mode={mode} onScrub={setScrub} /> : <Skel h={200} />}</div>
      </Panel>

      <Panel flush title="All accounts" meta={accounts.data ? `${list.length} accounts` : undefined}>
        <DataTable<Account>
          loading={accounts.isLoading}
          groups={groups}
          rowKey={(a) => a.id}
          onRowClick={(a) => setOpen(a)}
          selected={open?.id}
          rowClass={(a) => a.hidden && 'dim'}
          empty={<Empty compact icon={<Landmark />} title="No accounts" />}
          columns={[
            {
              key: 'name', header: 'Account', wide: true,
              cell: (a) => (
                <div className="cell">
                  <AccountAvatar a={a} size="sm" />
                  <span className="ellipsis primary">{a.label}</span>
                  {a.hidden && <Badge>Hidden</Badge>}
                  {a.item_status && a.item_status !== 'ok' && <Badge tone="warn">Needs attention</Badge>}
                </div>
              ),
              sub: (a) => `${a.institution_name || ''}${a.mask ? ` ··${a.mask}` : ''}`,
            },
            { key: 'inst', header: 'Institution', hide: 'md', cell: (a) => <span className="muted">{a.institution_name || '—'}{a.mask ? <span className="faint"> ··{a.mask}</span> : null}</span> },
            { key: 'type', header: 'Type', hide: 'lg', cell: (a) => <span className="muted" style={{ textTransform: 'capitalize' }}>{a.subtype || a.type}</span> },
            {
              key: 'status', header: 'Updated', hide: 'lg',
              cell: (a) => (
                <span className="row muted" style={{ gap: 6 }}>
                  <i className={`dot ${a.item_status && a.item_status !== 'ok' ? 'warn' : a.is_demo ? 'off' : ''}`} />
                  {a.is_demo ? 'Demo' : timeAgo(a.last_synced_at || a.updated_at)}
                </span>
              ),
            },
            {
              key: 'extra', header: 'Available / used', hide: 'md', width: 170,
              cell: (a) => {
                if (a.type === 'credit' && a.credit_limit) {
                  const u = (a.current_balance || 0) / a.credit_limit;
                  return <span title={`${pct(u)} of ${money(a.credit_limit, { cents: false })} limit`}><div className="meter-cell"><Meter value={u} max={1} color={u > 0.3 ? 'var(--yellow)' : 'var(--green)'} /></div></span>;
                }
                return a.available_balance != null && a.available_balance !== a.current_balance ? <span className="muted num">{money(a.available_balance, { cents: false })} avail.</span> : <span className="faint">—</span>;
              },
            },
            {
              key: 'trend', header: 'Trend', hide: 'sm', shrink: true,
              cell: (a) => {
                const liab = isLiability(a.type);
                const sp = (a.spark || []).map(Number);
                return <Sparkline data={sp} color={liab ? ((sp.at(-1) ?? 0) <= (sp[0] ?? 0) ? 'var(--green)' : 'var(--red)') : undefined} />;
              },
            },
            {
              key: 'change', header: '30 days', num: true, hide: 'sm', sort: (a) => change30(a),
              cell: (a) => { const c = change30(a); return c != null && Math.abs(c) >= 0.5 ? <span className={c >= 0 ? 'pos' : 'neg'}>{money(c, { cents: false, sign: true })}</span> : <span className="faint">—</span>; },
            },
            { key: 'balance', header: 'Balance', num: true, sort: (a) => signed(a), cell: (a) => <span className={`strong ${signed(a) < 0 ? 'neg' : ''}`}>{money(signed(a))}</span> },
          ]}
        />
      </Panel>

      {list.length > 0 && list.every((a) => a.is_demo) && (
        <div className="banner accent" style={{ marginTop: 'var(--gap)' }}>
          <div className="icon"><Landmark /></div>
          <div className="grow">
            <span className="strong">You're looking at demo data.</span>
            <span className="muted"> Remove it from Settings whenever you're ready to connect real accounts.</span>
          </div>
          <ButtonLink size="sm" to="/settings/data">Data settings</ButtonLink>
        </div>
      )}

      {open && <AccountSheet a={list.find((x) => x.id === open.id) || open} onClose={() => setOpen(null)} />}
    </Page>
  );
}
