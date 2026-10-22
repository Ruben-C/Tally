import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, CalendarClock, CheckCheck, Inbox, PieChart, Search, Target } from 'lucide-react';
import { useCategories, useDashboard, useGoals, useMeta, useMutate } from '../lib/queries';
import { api } from '../lib/api';
import { money, prettyName, relDays, shortDate, thisMonth } from '../lib/format';
import type { BudgetRow, Goal, Recurring } from '../lib/types';
import {
  Badge, Button, ButtonLink, CatLabel, DataTable, Delta, Empty, IconButton, MerchantAvatar, Meter, Page, PageHeader, Panel, PanelLink, Skel, Stat, StatGrid, useToast, useWide,
} from '../components/ui';
import { openPalette } from '../components/Layout';
import { METHOD_OPTIONS } from '../components/BudgetMethods';
import { NetWorthChart, SpendingChart } from '../components/charts';
import TxnSheet from '../components/TxnSheet';
import { TxnTable } from '../components/TxnTable';
import { ConnectBanner } from './Accounts';

const today = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

const GOAL_STATUS: Record<string, { label: string; tone?: 'good' | 'warn' | 'bad' | 'accent' }> = {
  done: { label: 'Reached', tone: 'good' },
  on_track: { label: 'On track', tone: 'good' },
  behind: { label: 'Behind', tone: 'bad' },
  overdue: { label: 'Overdue', tone: 'bad' },
  new: { label: 'New', tone: 'accent' },
  no_plan: { label: 'No plan' },
  bucket: { label: 'Bucket' },
};

function GoalsPanel() {
  const goals = useGoals();
  const nav = useNavigate();
  const list = (goals.data?.goals || []).filter((g) => !g.archived);
  return (
    <Panel
      flush className="span-12"
      title="Goals"
      meta={goals.data && goals.data.totals.saved > 0 ? <span className="num">{money(goals.data.totals.saved, { cents: false })} saved · {money(goals.data.totals.monthly, { cents: false })}/mo planned</span> : undefined}
      actions={<PanelLink to="/goals">All goals</PanelLink>}
    >
      <DataTable<Goal>
        loading={goals.isLoading}
        skeletonRows={3}
        rows={list}
        rowKey={(g) => g.id}
        onRowClick={(g) => nav(`/goals?open=${g.id}`, { viewTransition: true })}
        empty={<Empty compact icon={<Target />} title="No goals yet" action={<ButtonLink size="sm" to="/goals">Start a goal or bucket</ButtonLink>}>Save for a trip, or set money aside for big purchases.</Empty>}
        columns={[
          { key: 'name', header: 'Goal', wide: true, cell: (g) => <div className="cell"><span className="avatar sm" style={{ ['--c' as string]: g.color }}>{g.emoji}</span><span className="ellipsis primary">{g.name}</span></div>, sub: (g) => (g.kind === 'bucket' ? 'Bucket' : g.target_date ? `By ${shortDate(g.target_date)}` : 'Goal') },
          { key: 'kind', header: 'Type', hide: 'md', cell: (g) => <span className="muted">{g.kind === 'bucket' ? 'Bucket' : 'Target'}</span> },
          { key: 'date', header: 'Target date', hide: 'lg', cell: (g) => <span className="muted num">{g.target_date ? shortDate(g.target_date) : '—'}</span> },
          { key: 'monthly', header: 'Monthly', num: true, hide: 'md', cell: (g) => <span className="muted">{g.status === 'behind' && g.needed_monthly ? <span className="neg">{money(g.needed_monthly, { cents: false })} needed</span> : g.monthly_amount ? money(g.monthly_amount, { cents: false }) : '—'}</span> },
          { key: 'progress', header: 'Progress', width: 180, hide: 'sm', cell: (g) => (g.target_amount ? <div className="meter-cell"><Meter value={g.balance} max={g.target_amount} color={g.color} /></div> : <span className="faint">—</span>) },
          { key: 'status', header: 'Status', hide: 'sm', cell: (g) => { const s = GOAL_STATUS[g.status] || { label: g.status }; return <Badge tone={s.tone}>{s.label}</Badge>; } },
          { key: 'bal', header: 'Saved', num: true, cell: (g) => <span><span className="strong">{money(g.balance, { cents: false })}</span>{g.target_amount ? <span className="faint"> / {money(g.target_amount, { cents: false })}</span> : null}</span> },
        ]}
      />
    </Panel>
  );
}

export default function Dashboard() {
  const meta = useMeta();
  const dash = useDashboard();
  const { byId } = useCategories();
  const toast = useToast();
  const nav = useNavigate();
  const [open, setOpen] = useState<number | null>(null);
  const [scrub, setScrub] = useState<{ day: number; cur: number | null; prev: number | null } | null>(null);
  const roomy = useWide(1500); // room for the account column in the half-width review table
  const reviewAll = useMutate(() => api<{ updated: number }>('/transactions/review', { body: { all: true } }));
  const d = dash.data;
  const month = d?.month || thisMonth();
  const dim = d?.spending.series.filter((s) => s.cur !== null || s.prev !== null).length || 30;
  const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
  // Today counts as a day left: its spending isn't done yet.
  const daysLeft = d?.spending.dayOfMonth ? daysInMonth - d.spending.dayOfMonth + 1 : 0;
  // What the budgets can spend: this month's amounts plus rollover and set-aside funds (as on the Budgets page).
  const cap = d ? d.budget.budgeted + d.budget.carried : 0;
  const left = d ? cap - d.budget.spent : 0;
  // The headline follows the method picked on the Budgets page, with its words.
  const method = d?.method ?? 'category';
  const flex = method === 'flex';
  const hasBudget = !!d && (flex || d.budget.budgeted > 0);
  const leftLabel = flex ? (left < 0 ? 'Flex over' : 'Flex left') : left < 0 ? 'Over budget' : 'Left to spend';
  const basis = flex ? 'flex number' : method === 'percent' ? 'for needs & wants' : 'budgeted';
  const diff = d ? d.spending.spent - d.spending.prevToDate : 0;
  const items = d?.toReview.items || [];
  // Halfway through today, the same even pace the Budgets page marks.
  const pace = d?.spending.dayOfMonth ? (d.spending.dayOfMonth - 0.5) / daysInMonth : null;
  // A limit you set, plus any rollover carried in.
  const capOf = (c: BudgetRow) => (c.budget || 0) + (c.rollover ? c.carry : 0);
  const over = (d?.limits || []).filter((c) => c.available != null && c.available < 0);
  const limited = over.length ? over : (d?.limits || []).slice(0, 4);
  const noLimit = (c: BudgetRow) => (d?.method === 'flex' && c.budget_kind === 'flexible' ? 'In flex' : 'No budget');
  const mover = d?.brief.movers[0];
  const unusual = d?.brief.unusual;

  const header = (
    <PageHeader
      title="Dashboard"
      sub={today()}
      actions={<IconButton className="mobile-only" icon={<Search />} label="Search" onClick={openPalette} />}
    />
  );

  if (meta.data && meta.data.accounts === 0)
    return (
      <Page>
        {header}
        <ConnectBanner big />
      </Page>
    );

  const sk = <Skel w={90} h={18} />;
  const dayName = (day: number) => new Date(+month.slice(0, 4), +month.slice(5, 7) - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <Page>
      {header}

      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat label="Spent this month" to="/insights" value={d ? money(d.spending.spent, { cents: false }) : sk}
          sub={d && <><Delta value={diff} invert /> vs. last month</>} />
        <Stat label={leftLabel} to="/budgets" tone={left < 0 ? 'bad' : undefined}
          value={d ? (hasBudget ? money(Math.abs(left), { cents: false }) : '—') : sk}
          sub={d && (hasBudget ? (daysLeft > 0 && left > 0 ? `${money(left / daysLeft, { cents: false })}/day · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : `of ${money(cap, { cents: false })} ${basis}`) : 'No budget set')} />
        <Stat label="Income this month" to={`/transactions?kind=income&month=${month}`} tone={d && d.income > 0 ? 'good' : undefined}
          value={d ? money(d.income, { cents: false }) : sk}
          sub={d && d.income > 0 ? `${Math.round((d.spending.spent / d.income) * 100)}% spent so far` : 'Nothing yet'} />
        <Stat label="Net worth" to="/accounts" value={d ? money(d.netWorth.current, { cents: false }) : sk}
          sub={d && <><Delta value={d.netWorth.change30} /> last 30 days</>} />
        <Stat label="To review" to="/transactions?review=1" value={d ? d.toReview.count : sk}
          sub={d && (d.toReview.count ? 'new transactions' : 'All caught up')} />
        <Stat label="Bills · next 7 days" to="/recurring" value={d ? money(d.brief.billsThisWeek.total, { cents: d.brief.billsThisWeek.total < 100 }) : sk}
          sub={d && (d.brief.billsThisWeek.n ? `${d.brief.billsThisWeek.n} bill${d.brief.billsThisWeek.n > 1 ? 's' : ''} due` : 'Nothing due')} />
      </StatGrid>

      <div className="grid grid-dash">
        {/* Spending this month vs last month: scrub the chart and the head follows. */}
        <Panel
          className="span-8"
          bodyClassName="chart-body"
          title="Spending this month"
          meta={
            d && (scrub ? (
              <span className="num">
                {dayName(scrub.day)}: <span className="strong" style={{ color: 'var(--text)' }}>{money(scrub.cur ?? scrub.prev ?? 0, { cents: false })}</span>
                {scrub.prev != null && <> · last month {money(scrub.prev, { cents: false })}</>}
                {scrub.cur != null && scrub.prev != null && <> <Delta value={scrub.cur - scrub.prev} invert /></>}
              </span>
            ) : (
              <span className="num">
                <span className="strong" style={{ color: 'var(--text)' }}>{money(d.spending.spent, { cents: false })}</span> · last month {money(d.spending.prevTotal, { cents: false })} total
              </span>
            ))
          }
          actions={
            <div className="legend desktop-only">
              <span><i style={{ background: 'var(--accent)' }} />This month</span>
              <span><i style={{ background: 'var(--chart-prev)' }} />Last month</span>
            </div>
          }
        >
          <div className="chart-box fill">{d ? <SpendingChart series={d.spending.series.slice(0, dim)} month={month} budget={d.budget.plan > 0 ? d.budget.plan : undefined} onScrub={setScrub} /> : <Skel h={260} />}</div>
        </Panel>

        {/* Budget summary */}
        <Panel className="span-4" title="Budget" meta={d && <>{METHOD_OPTIONS.find((o) => o.value === method)?.label}{cap > 0 && ` · ${Math.round((d.budget.spent / cap) * 100)}% used`}</>} actions={<PanelLink to="/budgets">Details</PanelLink>} flush>
          {!d ? (
            <div className="panel-body"><Skel h={180} /></div>
          ) : hasBudget ? (
            <>
              <div className="panel-body dash-budget">
                <dl className="figures">
                  <div><dt>{flex ? 'Flex number' : method === 'percent' ? 'Needs + wants' : 'Budgeted'}</dt><dd className="num">{money(d.budget.budgeted, { cents: false })}</dd></div>
                  <div><dt>Spent</dt><dd className="num">{money(d.budget.spent, { cents: false })}</dd></div>
                  <div><dt>{left >= 0 ? 'Left' : 'Over'}</dt><dd className={`num ${left < 0 ? 'neg' : ''}`}>{money(Math.abs(left), { cents: false })}</dd></div>
                  <div><dt>Per day</dt><dd className="num">{daysLeft > 0 && left > 0 ? money(left / daysLeft, { cents: false }) : '—'}</dd></div>
                </dl>
                <Meter value={d.budget.spent} max={cap} pace={pace} />
                <div className="faint small">
                  {pace != null ? `Day ${d.spending.dayOfMonth} of ${daysInMonth} · the tick marks an even pace` : 'Month complete'}
                  {d.budget.carried !== 0 && ` · ${money(d.budget.carried, { sign: true, cents: false })} carried in`}
                </div>
                {d.budget.lines.map((l) => (
                  <div key={l.key} className="dash-budget-line">
                    <div className="row small">
                      <span className="muted">{l.label}</span>
                      <span className="num" style={{ marginLeft: 'auto' }}>
                        <span className={l.spent > l.cap + 0.5 ? 'neg' : ''}>{money(l.spent, { cents: false })}</span>
                        <span className="faint"> of {money(l.planned, { cents: false })}{l.cap - l.planned >= 1 && ` + ${money(l.cap - l.planned, { cents: false })} set aside`}</span>
                      </span>
                    </div>
                    <Meter value={l.spent} max={l.cap} pace={flex ? undefined : pace} />
                  </div>
                ))}
              </div>
              {limited.length > 0 && <DataTable<BudgetRow>
                sticky={false}
                rows={limited}
                rowKey={(c) => c.category_id}
                onRowClick={(c) => nav(`/transactions?category=${c.category_id}&month=${month}`, { viewTransition: true })}
                columns={[
                  { key: 'c', header: over.length ? 'Over budget' : 'Closest to limit', wide: true, cell: (c) => <CatLabel cat={c} /> },
                  { key: 's', header: 'Spent', num: true, cell: (c) => <span className={c.spent > capOf(c) ? 'neg' : ''}>{money(c.spent, { cents: false })}</span> },
                  { key: 'b', header: 'of', num: true, cell: (c) => <span className="faint">{money(capOf(c), { cents: false })}</span> },
                ]}
              />}
            </>
          ) : (
            <Empty icon={<PieChart />} title="No budget yet" action={<ButtonLink variant="primary" size="sm" to="/budgets">Set a budget</ButtonLink>}>
              Give your categories monthly targets and Tally tracks your pace.
            </Empty>
          )}
        </Panel>

        {/* Review queue */}
        <Panel
          flush className="span-7"
          title="To review"
          meta={d && d.toReview.count > 0 ? <span className="num">{d.toReview.count} new</span> : undefined}
          actions={
            <>
              {d && d.toReview.count > 0 && (
                <Button size="sm" variant="ghost" icon={<CheckCheck />} onClick={() => reviewAll.mutateAsync(undefined).then((r) => toast(`Marked ${r.updated} as reviewed`))}>
                  <span className="desktop-only">Mark all reviewed</span>
                </Button>
              )}
              <PanelLink to="/transactions?review=1">All</PanelLink>
            </>
          }
        >
          {unusual && (
            <button type="button" className="dash-hint" onClick={() => setOpen(unusual.id)}>
              <AlertTriangle />
              <span className="ellipsis"><b>{prettyName(unusual.label)}</b> charged <b className="num">{money(unusual.amount)}</b>, {(unusual.amount / unusual.avg).toFixed(1)}× your usual there</span>
            </button>
          )}
          <TxnTable
            rows={items}
            showDate
            showNotes={false}
            showAccount={roomy}
            loading={!d}
            skeletonRows={6}
            selectedId={open}
            onOpen={(t) => setOpen(t.id)}
            empty={<Empty compact icon={<Inbox />} title="All caught up">New transactions show up here so you can check their categories.</Empty>}
          />
        </Panel>

        {/* Upcoming recurring */}
        <Panel flush className="span-5" title="Upcoming" meta="next 3 weeks" actions={<PanelLink to="/recurring">Recurring</PanelLink>}
          foot={d && (d.recurring.renewals.saved > 0 || d.recurring.underBudget.length > 0) && (
            <div className="stack tight" style={{ width: '100%' }}>
              {d.recurring.renewals.saved > 0 && (
                <span className="row">
                  <span className="muted grow">Set aside for renewals{d.recurring.renewals.items[0] ? ` · ${d.recurring.renewals.items[0].name} ${relDays(d.recurring.renewals.items[0].renews).toLowerCase()}` : ''}</span>
                  <span className="num">{money(d.recurring.renewals.saved, { cents: false })} <span className="faint">· {money(d.recurring.renewals.monthly, { cents: false })} this month</span></span>
                </span>
              )}
              {d.recurring.underBudget.map((u) => (
                <button key={u.category_id} type="button" className="row dash-warn" onClick={() => nav('/budgets', { viewTransition: true })}>
                  <AlertTriangle size={13} style={{ color: 'var(--yellow)', flex: 'none' }} />
                  <span className="grow">{u.emoji} {u.name} budget is below its bills</span>
                  <span className="num muted">{money(u.budget, { cents: false })} &lt; {money(u.committed, { cents: false })}</span>
                </button>
              ))}
            </div>
          )}>
          <DataTable<Recurring>
            loading={!d}
            skeletonRows={6}
            rows={d?.upcoming || []}
            rowKey={(r) => r.id}
            onRowClick={() => nav('/recurring', { viewTransition: true })}
            empty={<Empty compact icon={<CalendarClock />} title="Nothing due soon">Bills and subscriptions due in the next three weeks appear here.</Empty>}
            columns={[
              { key: 'n', header: 'Bill', wide: true, cell: (r) => <div className="cell"><MerchantAvatar name={r.name} logo={r.logo_url} cat={r.category_id ? byId.get(r.category_id) : null} size="sm" /><span className="ellipsis primary">{r.name}</span></div>, sub: (r) => relDays(r.next_date!) },
              { key: 'd', header: 'Due', hide: 'sm', cell: (r) => <span className="muted num">{shortDate(r.next_date!)} <span className="faint">· {relDays(r.next_date!).replace('In ', '')}</span></span> },
              { key: 'a', header: 'Amount', num: true, cell: (r) => <span className={r.kind === 'income' ? 'pos' : ''}>{r.kind === 'income' ? '+' : ''}{money(r.amount)}</span> },
            ]}
          />
        </Panel>

        {/* Net worth */}
        <Panel
          className="span-6 pair"
          bodyClassName="chart-body"
          title="Net worth"
          meta={d && <span className="num"><span className="strong" style={{ color: 'var(--text)' }}>{money(d.netWorth.current, { cents: false })}</span> <Delta value={d.netWorth.change30} suffix="30d" /></span>}
          actions={<PanelLink to="/accounts">Accounts</PanelLink>}
        >
          <div className="chart-box fill">{d ? <NetWorthChart data={d.netWorth.series} /> : <Skel h={200} />}</div>
        </Panel>

        {/* Top categories */}
        <Panel
          flush className="span-6 pair"
          title="Top categories"
          meta={mover ? <>{mover.emoji} {mover.name} {mover.diff > 0 ? 'up' : 'down'} <span className="num">{money(Math.abs(mover.diff), { cents: false })}</span> vs. last month</> : undefined}
          actions={<PanelLink to="/insights">Cash flow</PanelLink>}
        >
          <DataTable<BudgetRow>
            loading={!d}
            skeletonRows={6}
            rows={d?.topCategories || []}
            rowKey={(c) => c.category_id}
            onRowClick={(c) => nav(`/transactions?category=${c.category_id}&month=${month}`, { viewTransition: true })}
            empty={<Empty compact icon={<PieChart />} title="No spending yet this month" />}
            columns={[
              { key: 'c', header: 'Category', wide: true, cell: (c) => <CatLabel cat={c} /> },
              { key: 'm', header: 'Of budget', width: 160, hide: 'sm', cell: (c) => (c.budget ? <div className="meter-cell"><Meter value={c.spent} max={capOf(c)} color={c.color} pace={pace} /></div> : <span className="faint">{noLimit(c)}</span>) },
              { key: 'avg', header: '3-mo avg', num: true, hide: 'lg', cell: (c) => <span className="muted">{money(c.avg3, { cents: false })}</span> },
              { key: 's', header: 'Spent', num: true, cell: (c) => <span><span className="strong">{money(c.spent, { cents: false })}</span>{c.budget ? <span className="faint"> / {money(capOf(c), { cents: false })}</span> : null}</span> },
            ]}
          />
        </Panel>

        <GoalsPanel />
      </div>

      {open != null && (
        <TxnSheet
          id={open}
          onClose={() => setOpen(null)}
          onNext={() => {
            const i = items.findIndex((t) => t.id === open);
            const next = items.find((t, j) => j > i && !t.reviewed);
            setOpen(next ? next.id : null);
          }}
        />
      )}
    </Page>
  );
}
