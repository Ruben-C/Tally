import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronDown, PieChart, RefreshCw, Repeat, SlidersHorizontal, X } from 'lucide-react';
import { useBudgets, useCategoryTrend, useMutate, useTransactions } from '../lib/queries';
import { api } from '../lib/api';
import { BUDGET_MODE_LABEL, cadenceLabel, money, monthLabel, pct, prettyName, shortDate, thisMonth, txnAmount } from '../lib/format';
import type { BudgetKind, BudgetMethod, BudgetRow, Budgets as BudgetsData, Bucket } from '../lib/types';
import {
  Badge, Button, CatLabel, DataTable, Empty, Field, IconButton, Meter, MoneyInput, MonthSwitch, Page, PageHeader, Panel, PanelLink, Segmented, Select, Sheet, Skel, Stat, StatGrid, Switch,
  useToast, useWide, type Column, type TableGroup,
} from '../components/ui';
import { TrendBars } from '../components/charts';
import TxnSheet from '../components/TxnSheet';
import {
  BUCKET_HINT, BUCKET_LABEL, BucketPicker, KIND_HINT, KIND_LABEL, KindPicker, METHOD_OPTIONS, METHOD_SUB, MethodStats, PlanSheet, useSetMethod,
} from '../components/BudgetMethods';

const cents0 = { cents: false } as const;
// What the category can spend this month: its budget, rollover carried in, and set-aside funds for renewals.
const capOf = (r: BudgetRow) => (r.budget || 0) + (r.rollover ? r.carry : 0) + r.reserve;
const carriedIn = (r: BudgetRow) => (r.rollover ? r.carry : 0) + r.reserve;
const rowKey = (r: BudgetRow) => (r.part === 'rec' ? `${r.category_id}:rec` : r.category_id);

// A flexible category with recurring bills becomes two rows: its bills and the rest. Flex files the bills under Fixed;
// the other views keep both rows in the category's group. A budget you set covers the bills first; one that comes from
// the bills covers only them, so the rest is unbudgeted. Same maths as /budgets (kinds and totals.budgetedSpent).
function splitRecurring(r: BudgetRow): BudgetRow[] {
  if (r.budget_kind !== 'flexible' || !r.series.length) return [r];
  const rec: BudgetRow = {
    ...r, part: 'rec', budget_kind: 'fixed', budget: r.committed, spent: r.rec_spent, carry: 0, rollover: false, avg3: 0,
    available: Math.round((r.committed + r.reserve - r.rec_spent) * 100) / 100,
  };
  const restBudget = r.budget_source === 'manual' && r.budget != null ? Math.max(r.budget - r.committed, 0) : null;
  const restSpent = Math.round((r.spent - r.rec_spent) * 100) / 100;
  const rest: BudgetRow = {
    ...r, part: 'rest', budget: restBudget, spent: restSpent, reserve: 0, series: [],
    available: restBudget == null ? null : Math.round((restBudget + (r.rollover ? r.carry : 0) - restSpent) * 100) / 100,
  };
  // A refund leaves the rest negative; it still has to show, or the flexible total won't match the flex stat.
  return restBudget != null || restSpent !== 0 ? [rec, rest] : [rec];
}

function useSaveBudget(month: string) {
  const toast = useToast();
  const m = useMutate((b: { category_id: number; amount: number | null }) => api('/budgets', { method: 'PUT', body: { ...b, month } }));
  return (row: BudgetRow, raw: string) => {
    // 0 is the same as clearing it: the server stores "no budget of your own" either way.
    const n = raw.trim() === '' ? null : Number(raw.replace(/[$,]/g, ''));
    if (n !== null && (!Number.isFinite(n) || n < 0)) return Promise.resolve(toast('Enter a positive amount', { kind: 'error' }));
    const v = n || null;
    const own = row.budget_source === 'manual' ? row.budget : null;
    if (v === own) return Promise.resolve(v == null && row.budget_source === 'recurring' && n === 0
      ? toast(`${row.name}'s figure comes from its recurring bills, not a budget you set. Change them on the Recurring page.`)
      : undefined);
    return m.mutateAsync({ category_id: row.category_id, amount: v }).then(() =>
      toast(v == null
        ? row.committed > 0 || row.reserve > 0 ? `Removed ${row.name} limit · its recurring bills still count` : `Removed ${row.name} budget from ${monthLabel(month)} on`
        : `${row.name}: ${money(v, cents0)}/month from ${monthLabel(month)}`),
    );
  };
}

function useSetTag() {
  const toast = useToast();
  const m = useMutate((b: { id: number; budget_kind?: BudgetKind; bucket?: Bucket }) => api(`/categories/${b.id}`, { method: 'PATCH', body: b }));
  return (row: BudgetRow, b: { budget_kind?: BudgetKind; bucket?: Bucket }) =>
    m.mutateAsync({ id: row.category_id, ...b }).then(() =>
      toast(b.budget_kind ? `${row.name}: ${KIND_LABEL[b.budget_kind]}${b.budget_kind === 'non_monthly' && !row.rollover ? ' · rollover on' : ''}` : `${row.name}: ${BUCKET_LABEL[b.bucket!]}`),
    );
}

// Budget figure editable in place: reads as a plain figure; click (or Enter on it) to type, Enter/blur saves, Esc cancels.
function BudgetCell({ row, month, empty = 'Set' }: { row: BudgetRow; month: string; empty?: string }) {
  const save = useSaveBudget(month);
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState('');
  // Only a budget you set fills the field; one from recurring bills is the placeholder, so blurring doesn't save it.
  const own = row.budget_source === 'manual' && row.budget != null ? String(row.budget) : '';
  if (!editing)
    return (
      <button type="button" className="budget-figure num" title={row.budget_source === 'recurring' ? `From ${row.series.length} recurring charge${row.series.length === 1 ? '' : 's'} · click to set your own` : 'Edit budget'} onClick={() => { setV(own); setEditing(true); }}>
        {row.budget_source === 'recurring' && <Repeat size={11} className="faint" aria-label="From recurring" style={{ marginRight: 4 }} />}
        {row.budget != null ? money(row.budget, cents0) : <span className="faint">{empty}</span>}
      </button>
    );
  return (
    <MoneyInput
      sm variant="inline" className="budget-input" value={v} onChange={setV} placeholder={row.budget_source === 'recurring' ? String(row.budget) : 'None'} aria-label={`${row.name} budget`} autoFocus
      selectOnFocus step={10}
      onBlur={() => { setEditing(false); save(row, v); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { e.stopPropagation(); setV(own); setEditing(false); }
      }}
    />
  );
}

// The category's recurring bills and what each puts in this month's budget.
function SeriesList({ row }: { row: BudgetRow }) {
  const short = row.budget_source === 'manual' && row.budget != null && row.committed > row.budget + 0.5;
  return (
    <div>
      <div className="section-title">
        <span>Recurring</span>
        <span className="faint num" style={{ fontWeight: 400 }}>{money(row.committed)} this month</span>
        <span style={{ marginLeft: 'auto' }}><PanelLink to="/recurring">Recurring</PanelLink></span>
      </div>
      {short && (
        <div className="banner warn" style={{ marginBottom: 8 }}>
          <div className="grow"><span className="strong">Budget is below its bills</span><span className="muted"> · recurring charges need {money(row.committed, cents0)}, the budget is {money(row.budget, cents0)}</span></div>
        </div>
      )}
      <div className="mini-table">
        <DataTable
          sticky={false}
          rows={row.series}
          rowKey={(x) => x.id}
          columns={[
            {
              key: 'n', header: 'Series', wide: true,
              cell: (x) => <span className="ellipsis" style={{ display: 'block' }}>{x.name}</span>,
              sub: (x) => `${cadenceLabel(x)} · ${x.long && x.mode === 'set_aside' ? 'set aside' : x.mode === 'set_aside' ? 'average month' : BUDGET_MODE_LABEL.due.toLowerCase()}`,
            },
            {
              key: 'f', header: 'Fund', shrink: true,
              cell: (x) => (x.mode === 'set_aside' && x.long && x.target
                ? <span className="faint small num" title={x.renews ? `Renews ${shortDate(x.renews)}` : undefined}>{money(Math.min(x.fund + x.planned, x.target), cents0)} of {money(x.target, cents0)}</span>
                : x.dates.length > 1 ? <span className="faint small">{x.dates.length} charges</span> : null),
            },
            { key: 'a', header: 'This month', num: true, cell: (x) => <span className="num">{money(x.planned)}</span> },
          ]}
        />
      </div>
    </div>
  );
}

// Everything about one category this month: figures, budget + rollover, 6-month trend, transactions.
function BudgetDetail({ row, month, flex, onOpenTxn }: { row: BudgetRow; month: string; flex: boolean; onOpenTxn: (id: number) => void }) {
  const toast = useToast();
  const save = useSaveBudget(month);
  const setTag = useSetTag();
  // Non-monthly costs are easier to think of per year; the budget is still stored per month (a twelfth).
  const [yearly, setYearly] = useState(row.budget_kind === 'non_monthly');
  const shown = (v: number | null) => (v == null ? '' : String(yearly ? Math.round(v * 12) : v));
  // Only a budget you set fills the field; one from recurring charges shows as the placeholder.
  const own = row.budget_source === 'manual' ? row.budget : null;
  const [amount, setAmount] = useState(shown(own));
  useEffect(() => setAmount(shown(own)), [row.category_id, own, yearly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setYearly(row.budget_kind === 'non_monthly'), [row.category_id, row.budget_kind]);
  const commit = (raw: string) => save(row, yearly && raw.trim() !== '' ? String(Math.round((Number(raw) / 12) * 100) / 100) : raw);
  const trend = useCategoryTrend(row.category_id, 6);
  const txns = useTransactions({ category: row.category_id, from: `${month}-01`, to: undefined }, 20);
  const setRollover = useMutate((v: boolean) => api(`/categories/${row.category_id}`, { method: 'PATCH', body: { rollover: v } }));
  const items = (txns.data?.pages[0]?.items || []).filter((t) => t.date.startsWith(month));
  const cap = capOf(row);
  // Flex: a flexible category needs no budget. Its everyday spending shares the flex number and its recurring bills
  // count as fixed, so the panel shows those two apart and any budget is an optional limit (same split as splitRecurring).
  const shared = flex && row.budget_kind === 'flexible';
  // Outside Flex, a category budgeted from its bills is measured on those bills (the table shows it as two rows).
  const parts = splitRecurring(row);
  const billsOnly = parts[0].part === 'rec' && row.budget_source !== 'manual';
  const avail = parts.length > 1 || billsOnly ? parts.reduce((a, r) => a + (r.available ?? 0), 0) : row.available;
  const everyday = Math.round((row.spent - row.rec_spent) * 100) / 100;
  const limit = own != null ? Math.max(own - row.committed, 0) : null;

  return (
    <div className="stack">
      {shared ? (
        <StatGrid className="bare budget-detail-stats">
          <Stat label="Everyday" value={money(everyday, cents0)}
            sub={limit != null ? `${limit > 0 ? pct(everyday / limit) : '—'} of your ${money(limit, cents0)} limit` : 'Uses flex'} />
          {row.series.length > 0
            ? <Stat label="Bills" value={money(row.committed, cents0)} sub="Counted as fixed" />
            : <Stat label="Limit" value={limit != null ? money(limit, cents0) : 'None'} sub={limit != null ? undefined : 'Shares the flex number'} />}
          <Stat label="3-mo avg" value={row.avg3 > 0 ? money(row.avg3, cents0) : '—'} />
        </StatGrid>
      ) : (
      <StatGrid className="bare budget-detail-stats">
        <Stat label="Spent" value={money(row.spent, cents0)}
          sub={billsOnly ? `${money(row.rec_spent, cents0)} on its bills · the rest isn't budgeted` : cap > 0 ? `${pct(row.spent / cap)} of ${money(cap, cents0)}` : 'No budget'} />
        <Stat
          label={avail != null && avail < 0 ? 'Over' : 'Left'}
          value={avail != null ? money(Math.abs(avail), cents0) : '—'}
          tone={avail != null && avail < 0 ? 'bad' : undefined}
          sub={row.reserve ? `${money(row.reserve, cents0)} set aside` : row.rollover && row.carry ? `${money(row.carry, { sign: true, cents: false })} carried in` : undefined}
        />
        <Stat label="3-mo avg" value={row.avg3 > 0 ? money(row.avg3, cents0) : '—'} />
      </StatGrid>
      )}

      <Field as="div" label={shared ? 'Limit (optional)' : yearly ? 'Yearly budget' : 'Monthly budget'}
        hint={shared ? `Not needed for Flex: spending here comes out of the flex number${row.series.length ? ' and its recurring bills count as fixed' : ''}. Set a limit only if you want a cap on this category${row.series.length ? ' (it includes its bills)' : ''}.`
          : row.budget_source === 'recurring' ? `From its recurring charges this month. Type an amount to set your own from ${monthLabel(month)}.`
          : yearly ? `Sets aside a twelfth each month from ${monthLabel(month)}${row.budget != null ? ` (${money(row.budget, cents0)}/mo)` : ''}.` : `Applies to ${monthLabel(month)} and every month after until you change it.`}>
        <div className="row">
          <MoneyInput className="grow" value={amount} onChange={setAmount} placeholder={shared ? 'No limit' : row.committed > 0 ? money(row.committed, cents0) : 'No budget'} suffix={yearly ? '/yr' : '/mo'} step={yearly ? 100 : 10} onKeyDown={(e) => e.key === 'Enter' && commit(amount)} />
          <Segmented size="sm" value={yearly ? 'yr' : 'mo'} onChange={(v) => setYearly(v === 'yr')} options={[{ value: 'mo', label: 'Month' }, { value: 'yr', label: 'Year' }]} />
          <Button variant="primary" onClick={() => commit(amount)} disabled={amount === shown(own)}>Save</Button>
        </div>
      </Field>
      <div className="chips">
        {row.avg3 > 0 && <button className="chip" onClick={() => setAmount(String(Math.ceil((row.avg3 * (yearly ? 12 : 1)) / 10) * 10))}>3-mo avg {money(row.avg3, cents0)}/mo</button>}
        {row.spent > 0 && !yearly && <button className="chip" onClick={() => setAmount(String(Math.ceil(row.spent / 10) * 10))}>This month {money(row.spent, cents0)}</button>}
        {shared && own != null && <button className="chip" onClick={() => save(row, '')}>Remove limit</button>}
        {!shared && row.budget_source === 'manual' && row.committed > 0 && <button className="chip" onClick={() => save(row, '')}>Use recurring · {money(row.committed, cents0)}/mo</button>}
        {!shared && row.budget_source === 'manual' && !row.committed && <button className="chip" onClick={() => save(row, '')}>Remove budget</button>}
      </div>

      <div className="kv">
        <label>
          <span className="grow">
            <span style={{ display: 'block' }}>Roll over leftovers</span>
            <span className="faint small">Unspent money carries into next month; overspending reduces it.</span>
          </span>
          <Switch on={row.rollover} label="Rollover" onChange={(v) => setRollover.mutateAsync(v).then(() => toast(v ? 'Rollover on from this month' : 'Rollover off'))} />
        </label>
      </div>

      <Field as="div" label="Budget type" hint={KIND_HINT[row.budget_kind]}>
        <KindPicker value={row.budget_kind} onChange={(v) => setTag(row, { budget_kind: v })} />
      </Field>
      <Field as="div" label="Needs, wants or savings" hint={row.bucket ? BUCKET_HINT[row.bucket] : 'Not sorted yet: the 50/30/20 view leaves it out.'}>
        <BucketPicker value={row.bucket} onChange={(v) => setTag(row, { bucket: v })} />
      </Field>

      {row.series.length > 0 && <SeriesList row={row} />}

      <div>
        <div className="section-title">Last 6 months</div>
        <div style={{ height: 120 }}>{trend.data ? <TrendBars data={trend.data} color={row.color} /> : <Skel h={110} />}</div>
      </div>

      <div>
        <div className="section-title">
          <span>{monthLabel(month)}</span>
          <span className="faint num" style={{ fontWeight: 400 }}>{items.length} transaction{items.length === 1 ? '' : 's'}</span>
          <span style={{ marginLeft: 'auto' }}><PanelLink to={`/transactions?category=${row.category_id}&month=${month}`}>All</PanelLink></span>
        </div>
        <div className="mini-table">
          <DataTable
            sticky={false}
            rows={items}
            rowKey={(t) => t.id}
            loading={txns.isLoading}
            skeletonRows={3}
            onRowClick={(t) => onOpenTxn(t.id)}
            empty={<Empty compact title="Nothing spent yet" />}
            columns={[
              { key: 'd', header: 'Date', shrink: true, cell: (t) => <span className="muted num">{shortDate(t.date)}</span> },
              { key: 'n', header: 'Merchant', wide: true, cell: (t) => <span className="ellipsis" style={{ display: 'block' }}>{prettyName(t.label)}</span> },
              { key: 'a', header: 'Amount', num: true, cell: (t) => <span className={t.amount < 0 ? 'pos' : ''}>{txnAmount(t.amount)}</span> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

export default function Budgets() {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') || thisMonth();
  const b = useBudgets(month);
  const wide = useWide(1280);
  const [selId, setSelId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [txn, setTxn] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const setMethodRemote = useSetMethod();
  const setTag = useSetTag();
  const d = b.data;
  // Switch instantly; the server copy catches up (it's the same budget, only the view changes).
  const [methodLocal, setMethodLocal] = useState<BudgetMethod | null>(null);
  const method: BudgetMethod = methodLocal ?? d?.method ?? 'category';
  const setMethod = (m: BudgetMethod) => { setMethodLocal(m); setMethodRemote({ method: m }); };
  const view: BudgetsData | undefined = d && { ...d, method };

  // Flex plans a fixed category without a budget at its 3-month average (so the flex number isn't overstated); the table
  // shows that estimate and counts it in the Fixed total, the same as the Fixed stat and the Dashboard.
  const estOf = (r: BudgetRow) => (method === 'flex' && r.budget_kind === 'fixed' && r.budget == null && r.avg3 > 0 ? r.avg3 : 0);
  const shows = (r: BudgetRow) => r.budget != null || r.spent !== 0 || estOf(r) > 0;
  const rows = useMemo(() => {
    const visible = (d?.categories || []).filter((r) => showAll || shows(r));
    return visible.flatMap(splitRecurring);
  }, [d, showAll, method]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = (d?.categories || []).filter((r) => !shows(r)).length;
  // On wide screens the rail always shows something: the chosen category, else the one most over (or most spent).
  const fallback = useMemo(() => [...rows].sort((a, b) => (a.available ?? 0) - (b.available ?? 0) || b.spent - a.spent)[0], [rows]);
  // Look the category up whole: in Flex the table rows are its split halves, and the detail panel does its own split.
  const selCat = selId ?? (wide ? fallback?.category_id : undefined);
  const sel = d?.categories.find((c) => c.category_id === selCat) || null;

  // Rows are grouped by what the method cares about: category groups, budget type, or needs/wants/savings.
  // bspent: spending in the group's budgeted rows, which is what its meter measures (unbudgeted rows aren't "over"), against
  // cap: their budgets plus rollover and set-aside funds, like each row's own meter.
  type G = TableGroup<BudgetRow> & { budget: number; cap: number; spent: number; bspent: number; avail: number; order: number; target?: number };
  const groups: G[] = useMemo(() => {
    const out: G[] = [];
    const keyOf = (r: BudgetRow): { key: string | number; label: string; order: number } => {
      if (method === 'flex') return { key: r.budget_kind, label: KIND_LABEL[r.budget_kind], order: ['fixed', 'flexible', 'non_monthly'].indexOf(r.budget_kind) };
      if (method === 'percent') {
        const k = r.bucket;
        return k ? { key: k, label: `${BUCKET_LABEL[k]} · ${d?.ratios[k] ?? 0}%`, order: ['need', 'want', 'savings'].indexOf(k) } : { key: 'unsorted', label: 'Not sorted', order: 9 };
      }
      return { key: r.group_id, label: r.group_name, order: 0 };
    };
    for (const r of rows) {
      const k = keyOf(r);
      let g = out.find((x) => x.key === k.key);
      if (!g) out.push((g = { key: k.key, label: k.label, order: k.order, rows: [], budget: 0, cap: 0, spent: 0, bspent: 0, avail: 0 }));
      g.rows.push(r);
      const est = estOf(r);
      g.budget += (r.budget || 0) + est;
      g.cap += capOf(r) + est;
      g.spent += r.spent;
      if (r.budget != null || est) g.bspent += r.spent;
      g.avail += r.available ?? (est ? est - r.spent : 0);
    }
    // Flex: the flexible group is measured against the one flex number. 50/30/20: each bucket against its share of income.
    for (const g of out) {
      if (method === 'flex' && g.key === 'flexible' && d) { g.budget = d.plan.flex.budget; g.avail = d.plan.flex.budget - g.spent; g.target = g.budget; }
      if (method === 'percent' && d && g.key !== 'unsorted') { const t = d.plan.buckets[g.key as Bucket].target; g.target = t; g.budget = t; g.avail = t - g.spent; }
    }
    out.sort((a, b) => a.order - b.order);
    return out.map((g) => ({
      ...g,
      label: g.target != null ? <>{g.label} <span className="faint" style={{ fontWeight: 400 }}>{method === 'flex' ? 'flex number' : 'target'}</span></> : g.label,
      cells: {
        budget: g.budget ? <span className="budget-sum">{money(g.budget, cents0)}</span> : null,
        spent: money(g.spent, cents0),
        left: g.budget || g.avail ? <span className={g.avail < 0 ? 'neg' : ''}>{g.avail < 0 ? `${money(-g.avail, cents0)} over` : money(g.avail, cents0)}</span> : null,
        progress: g.budget ? <Meter value={g.target != null ? g.spent : g.bspent} max={g.target != null ? g.budget : g.cap} pace={g.target != null ? d?.elapsed : undefined} color="var(--text-3)" /> : null,
      },
    }));
  }, [rows, method, d]); // eslint-disable-line react-hooks/exhaustive-deps

  // Totals add up the groups, so the flex number and 50/30/20 targets count in place of their rows.
  const sums = useMemo(() => ({
    budget: groups.reduce((a, g) => a + g.budget, 0),
    avail: groups.reduce((a, g) => a + g.avail, 0),
    spent: rows.reduce((a, r) => a + r.spent, 0),
    carried: rows.reduce((a, r) => a + carriedIn(r), 0),
    avg: rows.reduce((a, r) => a + r.avg3, 0),
  }), [groups, rows]);

  const columns: Column<BudgetRow>[] = [
    {
      key: 'cat', header: 'Category', width: 240, sort: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <div className="cell">
          <CatLabel cat={r} />
          {r.part === 'rec' && <Badge title={`${r.series.length} recurring bill${r.series.length === 1 ? '' : 's'}: ${r.series.map((x) => x.name).join(', ')}`}><Repeat size={10} /> {r.series.length === 1 ? r.series[0].name : `${r.series.length} bills`}</Badge>}
          {r.part === 'rest' && <span className="faint small">rest</span>}
          {r.rollover && <RefreshCw size={11} className="faint" style={{ flex: 'none' }} aria-label="Rollover on" />}
          {r.committed > 0 && r.budget_source === 'manual' && r.budget != null && r.committed > r.budget + 0.5 && <Badge tone="warn" title={`Recurring charges need ${money(r.committed)}`}>Below bills</Badge>}
        </div>
      ),
      sub: (r) => (r.available != null ? (r.available >= 0 ? `${money(r.available, cents0)} left of ${money(capOf(r), cents0)}` : <span className="neg">{money(-r.available, cents0)} over</span>)
        : method === 'flex' && r.budget_kind === 'flexible' ? 'From the flex number' : estOf(r) ? 'Planned at its 3-month average' : 'No budget'),
      footer: 'Total',
    },
    { key: 'budget', header: 'Budget', align: 'right', width: 112, hide: 'sm', sort: (r) => r.budget, cell: (r) => (r.part === 'rec'
      ? <span className="budget-figure num" title="Its recurring bills this month · edit them on the Recurring page"><Repeat size={11} className="faint" style={{ marginRight: 4 }} />{money(r.budget, cents0)}</span>
      : r.part === 'rest'
        ? <span className="budget-figure num" title="The category's budget minus its recurring bills · open the category to change it">{r.budget != null ? money(r.budget, cents0) : <span className="faint">—</span>}</span>
        : <BudgetCell row={r} month={month} empty={method === 'flex' && r.budget_kind === 'flexible' ? '—' : estOf(r) ? `~${money(estOf(r), cents0)}` : 'Set'} />), footer: <span className="num">{money(sums.budget, cents0)}</span> },
    { key: 'spent', header: 'Spent', num: true, width: 100, sort: (r) => r.spent, cell: (r) => <span style={{ fontWeight: 500 }}>{money(r.spent, cents0)}</span>, footer: money(sums.spent, cents0) },
    {
      key: 'left', header: 'Remaining', num: true, width: 110, hide: 'sm', sort: (r) => r.available,
      cell: (r) => (r.available == null ? <span className="faint">—</span> : <span className={r.available < 0 ? 'neg' : 'muted'}>{r.available < 0 ? `${money(-r.available, cents0)} over` : money(r.available, cents0)}</span>),
      footer: <span className={sums.avail < 0 ? 'neg' : ''}>{sums.avail < 0 ? `${money(-sums.avail, cents0)} over` : money(sums.avail, cents0)}</span>,
    },
    {
      key: 'progress', header: 'Progress', wide: true, hide: 'sm', sort: (r) => (capOf(r) > 0 ? r.spent / capOf(r) : null),
      cell: (r) => (capOf(r) > 0 ? <Meter value={r.spent} max={capOf(r)} pace={d?.elapsed} color={r.color} /> : <span className="faint small">{method === 'flex' && r.budget_kind === 'flexible' ? 'In flex' : 'Not budgeted'}</span>),
    },
    { key: 'avg', header: '3-mo avg', num: true, width: 96, hide: 'md', sort: (r) => r.avg3, cell: (r) => <span className="faint">{r.avg3 > 0 ? money(r.avg3, cents0) : '—'}</span>, footer: <span className="faint">{money(sums.avg, cents0)}</span> },
    ...(method === 'flex' || method === 'percent'
      ? [{
          key: 'tag', header: method === 'flex' ? 'Type' : 'Bucket', width: 132, hide: 'xl' as const,
          sort: (r: BudgetRow) => (method === 'flex' ? r.budget_kind : r.bucket ?? 'z'),
          cell: (r: BudgetRow) => (
            <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ display: 'block' }}>
              {r.part === 'rec' ? <span className="faint small">Recurring</span> : method === 'flex' ? (
                <Select sm className="budget-tag" value={r.budget_kind} aria-label={`${r.name} budget type`} onChange={(e) => setTag(r, { budget_kind: e.target.value as BudgetKind })}>
                  {(['fixed', 'flexible', 'non_monthly'] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
              ) : (
                <Select sm className="budget-tag" value={r.bucket ?? ''} aria-label={`${r.name} bucket`} onChange={(e) => e.target.value && setTag(r, { bucket: e.target.value as Bucket })}>
                  {!r.bucket && <option value="">Not sorted</option>}
                  {(['need', 'want', 'savings'] as const).map((k) => <option key={k} value={k}>{BUCKET_LABEL[k]}</option>)}
                </Select>
              )}
            </span>
          ),
        } satisfies Column<BudgetRow>]
      : []),
    {
      key: 'carry', header: 'Carried in', num: true, width: 96, hide: 'lg', sort: (r) => carriedIn(r) || null,
      cell: (r) => (carriedIn(r) ? <span className={carriedIn(r) < 0 ? 'neg' : 'pos'} title={r.reserve ? `${money(r.reserve)} set aside for renewals` : undefined}>{money(carriedIn(r), { sign: true, cents: false })}</span> : <span className="faint">—</span>),
      footer: sums.carried ? <span className={sums.carried < 0 ? 'neg' : 'pos'}>{money(sums.carried, { sign: true, cents: false })}</span> : undefined,
    },
  ];

  const open = (r: BudgetRow) => {
    setSelId(r.category_id);
    if (!wide) setSheetOpen(true);
  };

  const table = (
    <Panel flush className="clip">
      <DataTable
        columns={columns}
        groups={groups}
        rowKey={rowKey}
        onRowClick={open}
        selected={wide ? sel?.category_id : undefined}
        loading={!d}
        skeletonRows={12}
        footer
        empty={
          <Empty icon={<PieChart />} title="No budgets yet" action={<Button size="sm" variant="primary" onClick={() => setShowAll(true)}>Show all categories</Button>}>
            Pick a category and give it a monthly target.
          </Empty>
        }
      />
      {hidden > 0 && d && (
        <div className="panel-foot">
          <Button size="sm" variant="ghost" icon={<ChevronDown style={{ transform: showAll ? 'rotate(180deg)' : 'none' }} />} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Hide unused categories' : `Show ${hidden} unused categories`}
          </Button>
          <span className="desktop-only">Click a budget figure to edit it in place</span>
        </div>
      )}
    </Panel>
  );

  return (
    <Page>
      <PageHeader
        title="Budgets"
        sub={METHOD_SUB[method]}
        context={<MonthSwitch month={month} onChange={(m) => setSp(m === thisMonth() ? {} : { month: m }, { replace: true })} />}
        toolbar={
          <>
            <Segmented value={method} onChange={setMethod} options={METHOD_OPTIONS} />
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal />} onClick={() => setPlanOpen(true)} disabled={!d}>Plan</Button>
            <span className="faint small desktop-only" style={{ marginLeft: 'auto' }}>The method you pick here is what the Dashboard shows too. Your budgets stay the same.</span>
          </>
        }
      />

      <MethodStats d={view} onPlan={() => setPlanOpen(true)} />

      {wide ? (
        <div className="split">
          {table}
          <div className="rail">
            {sel ? (
              <Panel className="budget-rail" title={<CatLabel cat={sel} />} meta={sel.group_name}
                actions={selId != null && <IconButton size="sm" icon={<X />} label="Clear selection" onClick={() => setSelId(null)} />}>
                <BudgetDetail key={sel.category_id} row={sel} month={month} flex={method === 'flex'} onOpenTxn={setTxn} />
              </Panel>
            ) : d ? <Panel><Empty compact title="Pick a category" /></Panel> : <Panel><Skel h={300} /></Panel>}
          </div>
        </div>
      ) : table}

      {!wide && sheetOpen && sel && txn == null && (
        <Sheet title={<CatLabel cat={sel} />} onClose={() => setSheetOpen(false)}>
          <BudgetDetail row={sel} month={month} flex={method === 'flex'} onOpenTxn={setTxn} />
        </Sheet>
      )}
      {txn != null && <TxnSheet id={txn} onClose={() => setTxn(null)} />}
      {planOpen && view && <PlanSheet d={view} onClose={() => setPlanOpen(false)} />}
    </Page>
  );
}
