import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, CalendarClock, ChevronRight, Eye, EyeOff, Pencil, Plus, Repeat, SlidersHorizontal, Tag } from 'lucide-react';
import { useAccounts, useCategories, useMutate, useRecurring, useRecurringDefaults } from '../lib/queries';
import { api } from '../lib/api';
import { BUDGET_MODE_LABEL, PER_FACTOR, PER_SUFFIX, cadenceLabel, money, pct, relDays, shortDate, todayIso, type Per } from '../lib/format';
import type { Recurring as R, RecurDefaults, RecurMode } from '../lib/types';
import {
  Badge, Button, CatLabel, DataTable, Empty, Field, IconButton, Meter, MerchantAvatar, Page, PageHeader, Panel, SearchInput, Segmented, Sheet, Stat, StatGrid,
  useToast, useWide, vars, type Column,
} from '../components/ui';
import { CategoryPicker } from '../components/TxnSheet';
import RecurringForm from '../components/RecurringForm';

const cents0 = { cents: false } as const;
// Calendar cells are narrow: $3,185 → $3.2k.
const short = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : money(n, cents0));
const isLive = (r: R) => r.status === 'active' && !r.ended;
// Set-aside fund for a long-interval series: what's saved by the end of this month, of the renewal amount.
const fundOf = (r: R) => (r.mode === 'set_aside' && r.long && r.plan.target ? { saved: Math.min(r.plan.fund + r.plan.planned, r.plan.target), target: r.plan.target } : null);

function useSuggestion() {
  const toast = useToast();
  const m = useMutate(({ id, accept }: { id: number; accept: boolean }) => api(`/recurring/${id}`, { method: 'PATCH', body: accept ? { accept_suggestion: true } : { dismiss_suggestion: true } }));
  return (r: R, accept: boolean) => m.mutateAsync({ id: r.id, accept }).then(() => toast(accept ? `${r.name}: ${money(r.suggested_amount)} from now on` : `Kept ${money(r.amount)} for ${r.name}`));
}

function PriceBanner({ r }: { r: R }) {
  const decide = useSuggestion();
  const up = (r.suggested_amount ?? 0) > r.amount;
  return (
    <div className="banner warn">
      <div className="icon"><Tag /></div>
      <div className="grow">
        <span className="strong">{r.name} {up ? 'went up' : 'went down'}</span>
        <span className="muted"> · last charge {money(r.suggested_amount)}, you have {money(r.amount)}</span>
      </div>
      <Button size="sm" variant="ghost" onClick={() => decide(r, false)}>Keep {money(r.amount)}</Button>
      <Button size="sm" variant="primary" onClick={() => decide(r, true)}>Update</Button>
    </div>
  );
}

function RecurringSheet({ r, onClose, onEdit }: { r: R; onClose: () => void; onEdit: () => void }) {
  const toast = useToast();
  const { byId } = useCategories();
  const accounts = useAccounts();
  const [picking, setPicking] = useState(false);
  const update = useMutate((body: Partial<Pick<R, 'status' | 'category_id'>>) => api(`/recurring/${r.id}`, { method: 'PATCH', body }));
  const cat = r.category_id ? byId.get(r.category_id) : null;
  const acct = accounts.data?.find((a) => a.id === r.account_id);
  const fund = fundOf(r);
  if (picking)
    return (
      <Sheet title="Choose category" onClose={() => setPicking(false)} size="lg">
        <CategoryPicker value={r.category_id} onPick={(c) => update.mutateAsync({ category_id: c.id }).then(() => { setPicking(false); toast('Category updated'); })} />
      </Sheet>
    );
  return (
    <Sheet
      title="Recurring series" onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost" style={{ marginRight: 'auto' }} icon={r.status === 'active' ? <EyeOff /> : <Eye />}
            onClick={() => update.mutateAsync({ status: r.status === 'active' ? 'ignored' : 'active' }).then(() => { toast(r.status === 'active' ? 'Hidden from recurring' : 'Back in recurring'); onClose(); })}
          >
            {r.status === 'active' ? 'Not recurring — hide it' : 'Mark as recurring again'}
          </Button>
          <Button variant="primary" icon={<Pencil />} onClick={onEdit}>Edit</Button>
        </>
      }
    >
      <div className="txn-head">
        <MerchantAvatar name={r.name} logo={r.logo_url} cat={cat} size="lg" />
        <div style={{ minWidth: 0 }}>
          <div className="strong ellipsis" style={{ fontSize: 15 }}>{r.name}</div>
          <div className="meta">{cadenceLabel(r)}{r.source === 'manual' ? ' · added by you' : ''}{r.ended ? ` · ended ${shortDate(r.ends_on!)}` : r.status === 'ignored' ? ' · hidden' : ''}</div>
        </div>
        <div className={`amount num ${r.kind === 'income' ? 'pos' : ''}`}>{r.kind === 'income' ? '+' : ''}{money(r.amount)}</div>
      </div>
      {r.suggested_amount != null && isLive(r) && <PriceBanner r={r} />}
      {fund && (
        <div className="stack tight" style={{ marginBottom: 'var(--gap)' }}>
          <div className="row"><span className="muted grow">Set aside for {shortDate(r.plan.renews!)}</span><span className="num strong">{money(fund.saved, cents0)} <span className="faint" style={{ fontWeight: 400 }}>of {money(fund.target, cents0)}</span></span></div>
          <Meter value={fund.saved} max={fund.target} color={r.color || undefined} />
        </div>
      )}
      <div className="kv">
        <button type="button" onClick={() => setPicking(true)}><span className="k">Category</span><span className="v"><CatLabel cat={cat} /></span><ChevronRight size={14} className="faint" /></button>
        <div><span className="k">Account</span><span className="v ellipsis">{acct ? `${acct.label}${acct.mask ? ` ··${acct.mask}` : ''}` : '—'}</span></div>
        <div><span className="k">Next</span><span className="v">{r.next_date ? `${shortDate(r.next_date)} · ${relDays(r.next_date)}` : '—'}</span></div>
        <div><span className="k">Last</span><span className="v">{r.last_date ? shortDate(r.last_date) : '—'}</span></div>
        <div><span className="k">Amount</span><span className="v">{r.amount_mode === 'estimate' ? 'Varies · average of recent payments' : 'Fixed'}</span></div>
        {r.share_pct < 100 && <div><span className="k">Your share</span><span className="v num">{r.share_pct}% · {money(r.my_amount)}</span></div>}
        {r.kind === 'expense' && (
          <div><span className="k">In the budget</span><span className="v">{BUDGET_MODE_LABEL[r.mode]}{r.budget_mode === 'auto' ? ' (default)' : ''}{' · '}<span className="num">{money(r.plan.planned)}</span>{' this month'}</span></div>
        )}
        <div><span className="k">Per month</span><span className="v num">{money(r.per_month)}</span></div>
        <div><span className="k">Per year</span><span className="v num">{money(r.per_month * 12, cents0)}</span></div>
        <Link viewTransition to={`/transactions?recurring=${r.id}`} onClick={onClose}>
          <span className="k">History</span>
          <span className="v">{r.tx_count} payment{r.tx_count === 1 ? '' : 's'} <ArrowRight size={13} style={{ marginLeft: 6 }} /></span>
        </Link>
      </div>
    </Sheet>
  );
}

// How recurring charges count in budgets unless a series says otherwise.
function DefaultsSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const d = useRecurringDefaults();
  const save = useMutate((b: Partial<RecurDefaults>) => api<RecurDefaults>('/recurring/settings', { method: 'PUT', body: b }));
  const set = (b: Partial<RecurDefaults>) => save.mutateAsync(b).then(() => toast('Budget default saved'));
  const opts = (smooth: boolean) => [{ value: 'due' as RecurMode, label: BUDGET_MODE_LABEL.due }, { value: 'set_aside' as RecurMode, label: smooth ? 'Average month' : BUDGET_MODE_LABEL.set_aside }];
  return (
    <Sheet title="Recurring in budgets" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          A category without a budget of its own is budgeted from its recurring charges. These defaults apply to every series set to
          “Default”; each series can choose for itself in its Edit sheet.
        </p>
        <Field as="div" label="Longer than a month" hint={d.data?.long === 'due'
          ? 'Yearly, quarterly or 6-monthly charges are budgeted in full in the month they renew.'
          : 'A $120 yearly charge budgets $10 a month and builds a fund, so the renewal month isn’t overspent. A series added mid-cycle catches up before it renews.'}>
          {d.data && <Segmented value={d.data.long} onChange={(v) => set({ long: v })} options={opts(false)} />}
        </Field>
        <Field as="div" label="Monthly or shorter" hint={d.data?.short === 'due'
          ? 'Each charge counts in the month it lands: a weekly bill is 4 charges in some months and 5 in others.'
          : 'Weekly and every-2-weeks bills budget the average month (52 ÷ 12 weeks); 5-charge months draw on what 4-charge months left over.'}>
          {d.data && <Segmented value={d.data.short} onChange={(v) => set({ short: v })} options={opts(true)} />}
        </Field>
      </div>
    </Sheet>
  );
}

// This month at a glance: each day shows what's due.
function Calendar({ items, onOpen }: { items: R[]; onOpen: (r: R) => void }) {
  const today = todayIso();
  const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  const first = new Date(y, m, 1).getDay();
  const dim = new Date(y, m + 1, 0).getDate();
  const byDay = new Map<number, R[]>();
  for (const r of items) for (const date of r.month_dates) byDay.set(+date.slice(8), [...(byDay.get(+date.slice(8)) || []), r]);
  const todayN = +today.slice(8);
  return (
    <div className="calendar rec-cal">
      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => <div key={i} className="dow">{x}</div>)}
      {Array.from({ length: first }, (_, i) => <div key={`b${i}`} className="cal-day blank" />)}
      {Array.from({ length: dim }, (_, i) => {
        const day = i + 1;
        const list = byDay.get(day) || [];
        const total = list.reduce((s, r) => s + (r.kind === 'expense' ? r.amount : 0), 0);
        const inc = list.reduce((s, r) => s + (r.kind === 'income' ? r.amount : 0), 0);
        return (
          <button
            key={day} type="button" className={`cal-day ${day === todayN ? 'today' : ''} ${day < todayN ? 'past' : ''} ${list.length ? 'has' : ''}`}
            title={list.map((r) => `${r.name} ${money(r.amount)}`).join('\n') || undefined} onClick={() => list[0] && onOpen(list[0])} disabled={!list.length}
          >
            <span className="d">{day}</span>
            {list.length > 0 && <span className="sw-row">{list.slice(0, 4).map((r) => <i key={r.id} style={vars({ '--c': r.color || 'var(--text-3)' })} />)}</span>}
            {total > 0 && <span className="amt num">{short(total)}</span>}
            {inc > 0 && <span className="amt num pos">+{short(inc)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default function Recurring() {
  const rec = useRecurring();
  const { byId } = useCategories();
  const accounts = useAccounts();
  const toast = useToast();
  const nav = useNavigate();
  const wide = useWide(1440);
  const [tab, setTab] = useState<'expense' | 'income' | 'ignored'>('expense');
  const [per, setPer] = useState<Per>('month');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<R | null>(null);
  const [editing, setEditing] = useState<R | 'new' | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const update = useMutate(({ id, status }: { id: number; status: R['status'] }) => api(`/recurring/${id}`, { method: 'PATCH', body: { status } }));
  const all = useMemo(() => rec.data || [], [rec.data]);
  const active = useMemo(() => all.filter(isLive), [all]);
  const list = useMemo(() => {
    const base = tab === 'ignored' ? all.filter((r) => !isLive(r)) : active.filter((r) => r.kind === tab);
    const needle = q.trim().toLowerCase();
    return needle ? base.filter((r) => r.name.toLowerCase().includes(needle) || (r.category_name || '').toLowerCase().includes(needle)) : base;
  }, [all, active, tab, q]);
  const f = PER_FACTOR[per];
  const unit = PER_SUFFIX[per];
  const monthly = (k: 'expense' | 'income') => active.filter((r) => r.kind === k).reduce((s, r) => s + r.per_month, 0);
  const t0 = todayIso();
  const due = active.filter((r) => r.kind === 'expense').flatMap((r) => r.month_dates.filter((x) => x >= t0).map(() => r.my_amount));
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const week = active.filter((r) => r.kind === 'expense' && r.next_date && r.next_date >= t0 && r.next_date <= weekEnd);
  const funds = active.map(fundOf).filter((x) => x != null);
  const priceChanges = active.filter((r) => r.suggested_amount != null);
  const acctLabel = (id: number | null) => {
    const a = id != null ? accounts.data?.find((x) => x.id === id) : null;
    return a ? `${a.label}${a.mask ? ` ··${a.mask}` : ''}` : '—';
  };
  const toggle = (r: R) =>
    update.mutateAsync({ id: r.id, status: r.status === 'active' ? 'ignored' : 'active' }).then(() =>
      toast(r.status === 'active' ? `${r.name} hidden` : `${r.name} is recurring again`, { action: { label: 'Undo', run: () => update.mutate({ id: r.id, status: r.status }) } }),
    );

  // Beside the calendar rail (≥1440px) the table has no room for these two until >1600px.
  const columns: Column<R>[] = [
    {
      key: 'name', header: 'Name', wide: true, sort: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <div className="cell" style={{ maxWidth: 260 }}>
          <MerchantAvatar name={r.name} logo={r.logo_url} cat={r.category_id ? byId.get(r.category_id) : null} size="sm" />
          <span className="ellipsis primary">{r.name}</span>
          {r.suggested_amount != null && isLive(r) && <Badge tone="warn" title={`Last charge ${money(r.suggested_amount)}`}>Price changed</Badge>}
        </div>
      ),
      sub: (r) => `${cadenceLabel(r)}${r.next_date ? ` · ${relDays(r.next_date)}` : ''}`,
      footer: `${list.length} series`,
    },
    { key: 'cat', header: 'Category', hide: 'sm', width: 150, sort: (r) => r.category_name, cell: (r) => <CatLabel cat={r.category_id ? byId.get(r.category_id) : null} /> },
    { key: 'freq', header: 'Repeats', hide: wide ? 'xl' : 'md', width: 140, sort: (r) => r.interval_days, cell: (r) => <span className="muted ellipsis" style={{ display: 'block' }}>{cadenceLabel(r)}</span> },
    {
      key: 'next', header: 'Next', hide: 'sm', width: 150, sort: (r) => r.next_date,
      cell: (r) => {
        if (!r.next_date) return <span className="faint">{r.ended ? 'Ended' : '—'}</span>;
        const late = r.next_date < t0;
        return <span className="num"><span>{shortDate(r.next_date)}</span> <span className={late ? 'warn small' : 'faint small'}>{late ? `expected ${relDays(r.next_date).toLowerCase()}` : relDays(r.next_date).toLowerCase()}</span></span>;
      },
    },
    { key: 'acct', header: 'Account', hide: 'xl', width: 170, sort: (r) => acctLabel(r.account_id), cell: (r) => <span className="muted ellipsis" style={{ display: 'block', maxWidth: 160 }}>{acctLabel(r.account_id)}</span> },
    ...(tab === 'expense'
      ? [{
          key: 'budget', header: 'In budget', hide: 'lg' as const, width: 170, sort: (r: R) => r.mode,
          cell: (r: R) => {
            const fund = fundOf(r);
            if (fund) return <span className="stack" style={{ gap: 2 }}><Meter value={fund.saved} max={fund.target} color={r.color || undefined} showPct={false} /><span className="faint small num">{money(fund.saved, cents0)} of {money(fund.target, cents0)} saved</span></span>;
            return <span className="muted small">{r.mode === 'set_aside' ? 'Average month' : BUDGET_MODE_LABEL.due}</span>;
          },
        } satisfies Column<R>]
      : []),
    {
      key: 'amt', header: 'Amount', num: true, width: 100, sort: (r) => r.amount,
      cell: (r) => <span className={r.kind === 'income' ? 'pos' : ''} style={{ fontWeight: 500 }} title={r.share_pct < 100 ? `Your share: ${money(r.my_amount)}` : undefined}>{r.kind === 'income' ? '+' : ''}{money(r.amount)}{r.amount_mode === 'estimate' ? <span className="faint"> ~</span> : null}</span>,
    },
    {
      key: 'mo', header: `Per ${per}`, num: true, hide: wide ? 'xl' : 'sm', width: 100, sort: (r) => r.per_month, cell: (r) => <span className="muted">{money(r.per_month * f, cents0)}</span>,
      footer: money(list.reduce((s, r) => s + r.per_month, 0) * f, cents0),
    },
    {
      key: 'act', header: '', shrink: true, hide: 'sm',
      cell: (r) => (
        <span className="row-actions">
          <IconButton size="sm" icon={<Pencil />} label={`Edit ${r.name}`} onClick={() => setEditing(r)} />
          <IconButton size="sm" icon={<Repeat />} label={`See ${r.tx_count} payments`} onClick={() => nav(`/transactions?recurring=${r.id}`, { viewTransition: true })} />
          <IconButton size="sm" icon={r.status === 'active' ? <EyeOff /> : <Eye />} label={r.status === 'active' ? 'Not recurring — hide' : 'Mark as recurring again'} onClick={() => toggle(r)} />
        </span>
      ),
    },
  ];

  const calendar = (
    <Panel title={new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} meta={`${money(due.reduce((s, x) => s + x, 0), cents0)} still due`}>
      <Calendar items={active} onOpen={setOpen} />
    </Panel>
  );

  return (
    <Page>
      <PageHeader
        title="Recurring"
        sub="Subscriptions, bills and paychecks: found in your history or added by you"
        actions={<Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>New</Button>}
        toolbar={
          <>
            <Segmented value={tab} onChange={setTab} options={[
              { value: 'expense', label: `Bills ${active.filter((r) => r.kind === 'expense').length || ''}` },
              { value: 'income', label: `Income ${active.filter((r) => r.kind === 'income').length || ''}` },
              { value: 'ignored', label: `Hidden ${all.length - active.length || ''}` },
            ]} />
            <SearchInput value={q} onChange={setQ} placeholder="Filter by name or category" style={{ maxWidth: 300 }} />
            <Segmented size="sm" value={per} onChange={setPer} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} />
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal />} onClick={() => setDefaultsOpen(true)}>Budget defaults</Button>
          </>
        }
      />

      {priceChanges.slice(0, 3).map((r) => <PriceBanner key={r.id} r={r} />)}

      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat label="Bills & subscriptions" value={<>{money(monthly('expense') * f, cents0)}<span className="unit">{unit}</span></>} sub={`${active.filter((r) => r.kind === 'expense').length} active series`} />
        <Stat label="Recurring income" value={<>{money(monthly('income') * f, cents0)}<span className="unit">{unit}</span></>} tone="good"
          sub={monthly('income') > 0 ? `Bills take ${pct(monthly('expense') / monthly('income'))}` : undefined} />
        <Stat label="Still due this month" value={money(due.reduce((s, x) => s + x, 0), cents0)} sub={`${due.length} payment${due.length === 1 ? '' : 's'}`} />
        <Stat label="Due in the next 7 days" value={money(week.reduce((s, r) => s + r.my_amount, 0), cents0)} sub={week.length ? week.slice(0, 3).map((r) => r.name).join(', ') : 'Nothing'} />
        <Stat label="Set aside for renewals" value={money(funds.reduce((s, x) => s + x.saved, 0), cents0)} onClick={() => setDefaultsOpen(true)} title="How recurring counts in budgets"
          sub={funds.length ? `of ${money(funds.reduce((s, x) => s + x.target, 0), cents0)} across ${funds.length} long-interval bill${funds.length === 1 ? '' : 's'}` : 'Nothing longer than monthly'} />
      </StatGrid>

      <div className={wide ? 'split rec-split' : 'stack'}>
        <Panel flush className="clip">
          <DataTable
            columns={columns}
            rows={list}
            rowKey={(r) => r.id}
            onRowClick={setOpen}
            loading={rec.isLoading}
            defaultSort={{ key: 'next', dir: 1 }}
            footer
            rowClass={(r) => !!r.next_date && r.next_date < t0 && isLive(r) && 'late'}
            empty={
              <Empty icon={tab === 'ignored' ? <EyeOff /> : <CalendarClock />} title={q ? 'No matches' : tab === 'ignored' ? 'Nothing hidden' : 'Nothing recurring yet'}
                action={!q && tab !== 'ignored' ? <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>Add one</Button> : undefined}>
                {q ? 'Nothing matches that filter.' : tab === 'ignored' ? 'Series you hide or that have ended land here.' : 'Tally spots repeating charges once it has a few months of history. Add yearly ones yourself, or use “Make recurring” on a payment.'}
              </Empty>
            }
          />
        </Panel>
        <div className={wide ? 'rail' : 'grid cols-2'} style={wide ? undefined : { alignItems: 'start' }}>
          {calendar}
          {tab !== 'ignored' && (
            <Panel title="Next up" flush>
              <DataTable
                sticky={false}
                columns={[
                  { key: 'n', header: 'Name', wide: true, cell: (r: R) => <span className="ellipsis" style={{ display: 'block' }}>{r.name}</span> },
                  { key: 'd', header: 'When', shrink: true, cell: (r: R) => <span className="muted">{relDays(r.next_date!)}</span> },
                  { key: 'a', header: 'Amount', num: true, cell: (r: R) => <span className={r.kind === 'income' ? 'pos' : ''}>{money(r.amount)}</span> },
                ]}
                rows={active.filter((r) => r.next_date && r.next_date >= t0).sort((a, b) => (a.next_date! < b.next_date! ? -1 : 1)).slice(0, 8)}
                rowKey={(r) => r.id}
                onRowClick={setOpen}
                empty={<Empty compact title="Nothing coming up" />}
              />
            </Panel>
          )}
          {tab === 'ignored' && list.length > 0 && <Badge>Hidden and ended series don't count toward totals or budgets</Badge>}
        </div>
      </div>
      {open && !editing && all.some((x) => x.id === open.id) && <RecurringSheet r={all.find((x) => x.id === open.id) || open} onClose={() => setOpen(null)} onEdit={() => setEditing(all.find((x) => x.id === open.id) || open)} />}
      {editing && <RecurringForm series={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {defaultsOpen && <DefaultsSheet onClose={() => setDefaultsOpen(false)} />}
    </Page>
  );
}
