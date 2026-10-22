import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Banknote, PieChart, Store } from 'lucide-react';
import { useBreakdown, useCashflow, useCategories } from '../lib/queries';
import { money, monthLabel, pct, prettyName, thisMonth } from '../lib/format';
import type { Breakdown } from '../lib/types';
import { CatLabel, DataTable, Empty, MerchantAvatar, Meter, MonthSwitch, Page, PageHeader, Panel, PanelLink, Segmented, Skel, Stat, StatGrid, useWide } from '../components/ui';
import { CashFlowChart } from '../components/charts';

type Cat = Breakdown['categories'][number];
type Merchant = Breakdown['merchants'][number];

export default function Insights() {
  const [months, setMonths] = useState(12);
  const [month, setMonth] = useState(thisMonth());
  const cf = useCashflow(months);
  const bd = useBreakdown(month);
  const { byId } = useCategories();
  const nav = useNavigate();
  const roomy = useWide(1440); // the half-width tables get their secondary columns only when there's room

  // Averages over complete months only (the current month is partial).
  const full = (cf.data || []).filter((m) => m.month !== thisMonth() && (m.income || m.expenses));
  const avg = (k: 'income' | 'expenses' | 'net') => (full.length ? full.reduce((s, m) => s + m[k], 0) / full.length : 0);
  const rate = avg('income') > 0 ? avg('net') / avg('income') : 0;
  const sel = cf.data?.find((m) => m.month === month);
  // Don't chart the empty months before the first data arrived.
  const firstIdx = (cf.data || []).findIndex((m) => m.income || m.expenses);
  const chartData = (cf.data || []).slice(Math.max(0, Math.min(firstIdx, (cf.data?.length || 0) - 3)));

  // A category that took in more refunds than it spent stays in the list (as a negative), so the total is the same net
  // spending as the cash-flow chart and the Dashboard. Shares are of the categories that spent.
  const expenses = (bd.data?.categories || []).filter((c) => c.kind === 'expense' && c.total !== 0);
  const income = (bd.data?.categories || []).filter((c) => c.kind === 'income' && c.total !== 0);
  const totalExp = expenses.reduce((s, c) => s + c.total, 0);
  const grossExp = expenses.reduce((s, c) => s + Math.max(c.total, 0), 0);
  const totalInc = income.reduce((s, c) => s - c.total, 0);
  const share = (c: Cat) => (grossExp > 0 ? Math.max(c.total, 0) / grossExp : 0);
  const sk = <Skel w={80} h={18} />;
  const openCat = (id: number) => nav(`/transactions?category=${id}&month=${month}`, { viewTransition: true });

  return (
    <Page>
      <PageHeader
        title="Cash Flow"
        sub="What came in, what went out, and where it went"
        actions={<Segmented value={months} onChange={setMonths} options={[{ value: 6, label: '6M' }, { value: 12, label: '12M' }, { value: 24, label: '2Y' }]} />}
      />

      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat label={`Avg. income · ${full.length} mo`} tone="good" value={cf.data ? money(avg('income'), { cents: false }) : sk} sub="per complete month" />
        <Stat label="Avg. spending" value={cf.data ? money(avg('expenses'), { cents: false }) : sk} sub="per complete month" />
        <Stat label="Avg. saved" tone={avg('net') < 0 ? 'bad' : undefined} value={cf.data ? money(avg('net'), { cents: false }) : sk} sub="income − spending" />
        <Stat label="Savings rate" tone={rate < 0 ? 'bad' : rate > 0.2 ? 'good' : undefined} value={cf.data ? pct(rate) : sk} sub="of income kept" />
        <Stat label={`${monthLabel(month)} · net`} tone={sel && sel.net < 0 ? 'bad' : undefined} value={sel ? money(sel.net, { cents: false, sign: true }) : cf.data ? '—' : sk}
          sub={sel ? <span className="num">+{money(sel.income, { cents: false })} in · {money(sel.expenses, { cents: false })} out</span> : undefined} />
      </StatGrid>

      <Panel
        title="Income vs spending"
        meta={<span className="desktop-only">click a month to break it down</span>}
        actions={
          <div className="legend">
            <span><i style={{ background: 'var(--green)' }} />Income</span>
            <span><i style={{ background: 'var(--accent)' }} />Spending</span>
          </div>
        }
        style={{ marginBottom: 'var(--gap)' }}
      >
        <div className="chart-box">{cf.data ? <CashFlowChart data={chartData} selected={month} onSelect={setMonth} /> : <Skel h={200} />}</div>
      </Panel>

      <div className="section-head">
        <h2>{monthLabel(month)}</h2>
        <MonthSwitch month={month} onChange={setMonth} />
      </div>

      <div className="grid grid-dash" style={{ alignItems: 'start' }}>
        <Panel
          flush className="span-7"
          title="Spending by category"
          meta={<span className="num">{money(totalExp, { cents: false })}{sel && sel.income > 0 ? ` · ${pct(totalExp / sel.income)} of income` : ''}</span>}
          actions={<PanelLink to={`/transactions?kind=expense&month=${month}`}>Transactions</PanelLink>}
        >
          {expenses.length > 0 && (
            <div className="share-strip">
              <div className="alloc-bar tall">
                {expenses.filter((c) => c.total > 0).map((c) => <button key={c.category_id} type="button" style={{ flexGrow: c.total, background: c.color }} title={`${c.name} · ${money(c.total, { cents: false })} · ${pct(share(c))}`} onClick={() => openCat(c.category_id)} />)}
              </div>
            </div>
          )}
          <DataTable<Cat>
            loading={!bd.data}
            rows={expenses}
            rowKey={(c) => c.category_id}
            onRowClick={(c) => openCat(c.category_id)}
            defaultSort={{ key: 'total', dir: -1 }}
            empty={<Empty compact icon={<PieChart />} title="No spending this month" />}
            footer
            columns={[
              { key: 'name', header: 'Category', wide: true, sort: (c) => c.name, cell: (c) => <CatLabel cat={c} />, sub: (c) => (c.total < 0 ? `Refunds · ${c.n} txn` : `${pct(share(c))} · ${c.n} txn`), footer: 'Total' },
              ...(roomy ? [{ key: 'group', header: 'Group', sort: (c: Cat) => c.group_name, cell: (c: Cat) => <span className="muted">{c.group_name}</span> }] : []),
              { key: 'share', header: 'Share', width: 170, hide: 'sm', sort: (c) => c.total, cell: (c) => <div className="meter-cell"><Meter value={Math.max(c.total, 0)} max={grossExp} color={c.color} /></div> },
              { key: 'n', header: 'Txns', num: true, hide: 'sm', sort: (c) => c.n, cell: (c) => <span className="muted">{c.n}</span>, footer: <span className="muted">{expenses.reduce((s, c) => s + c.n, 0)}</span> },
              { key: 'avg', header: 'Avg', num: true, hide: 'md', sort: (c) => c.total / Math.max(c.n, 1), cell: (c) => <span className="muted">{money(c.total / Math.max(c.n, 1), { cents: false })}</span> },
              { key: 'total', header: 'Spent', num: true, sort: (c) => c.total, cell: (c) => <span className={`strong ${c.total < 0 ? 'pos' : ''}`}>{money(c.total, { cents: false })}</span>, footer: money(totalExp, { cents: false }) },
            ]}
          />
        </Panel>

        <div className="stack span-5">
          <Panel flush title="Top merchants" meta={bd.data ? `${bd.data.merchants.length} merchants` : undefined}>
            <DataTable<Merchant>
              loading={!bd.data}
              skeletonRows={6}
              rows={(bd.data?.merchants || []).slice(0, 12)}
              rowKey={(m) => m.name}
              onRowClick={(m) => nav(`/transactions?q=${encodeURIComponent(m.name)}&month=${month}`, { viewTransition: true })}
              defaultSort={{ key: 'total', dir: -1 }}
              empty={<Empty compact icon={<Store />} title="No merchants" />}
              columns={[
                { key: 'name', header: 'Merchant', wide: true, sort: (m) => prettyName(m.name), cell: (m) => <div className="cell"><MerchantAvatar name={m.name} logo={m.logo_url} cat={byId.get(m.category_id)} size="sm" /><span className="ellipsis primary">{prettyName(m.name)}</span></div> },
                ...(roomy ? [{ key: 'cat', header: 'Category', cell: (m: Merchant) => <CatLabel cat={byId.get(m.category_id)} /> }] : []),
                { key: 'n', header: 'Visits', num: true, sort: (m) => m.n, cell: (m) => <span className="muted">{m.n}×</span> },
                { key: 'total', header: 'Spent', num: true, sort: (m) => m.total, cell: (m) => <span className="strong">{money(m.total, { cents: false })}</span> },
              ]}
            />
          </Panel>
          <Panel flush title="Income" meta={totalInc ? <span className="num pos">+{money(totalInc, { cents: false })}</span> : undefined} actions={<PanelLink to={`/transactions?kind=income&month=${month}`}>All</PanelLink>}>
            <DataTable<Cat>
              loading={!bd.data}
              skeletonRows={2}
              rows={income}
              rowKey={(c) => c.category_id}
              onRowClick={(c) => openCat(c.category_id)}
              empty={<Empty compact icon={<Banknote />} title="No income this month" />}
              columns={[
                { key: 'name', header: 'Source', wide: true, cell: (c) => <CatLabel cat={c} /> },
                { key: 'n', header: 'Txns', num: true, cell: (c) => <span className="muted">{c.n}</span> },
                { key: 'total', header: 'Received', num: true, cell: (c) => <span className={c.total < 0 ? 'pos strong' : 'strong'}>{c.total < 0 ? '+' : '−'}{money(Math.abs(c.total), { cents: false })}</span> },
              ]}
            />
          </Panel>
        </div>
      </div>
    </Page>
  );
}

