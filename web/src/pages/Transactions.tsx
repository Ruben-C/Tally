import { useEffect, useMemo, useRef, useState, type Key } from 'react';
import { useSearchParams } from 'react-router';
import { CheckCheck, Download, Search as SearchIcon, Tags, X } from 'lucide-react';
import { useAccounts, useCategories, useMutate, useTransactions, useUpdateTxn, type TxnFilters } from '../lib/queries';
import { api } from '../lib/api';
import { money, monthLabel, shiftMonth } from '../lib/format';
import type { Category, Txn } from '../lib/types';
import { Button, ButtonLink, Empty, Page, PageHeader, Panel, SearchInput, Segmented, Select, Sheet, useToast, useWide } from '../components/ui';
import { TxnTable } from '../components/TxnTable';
import TxnSheet, { CategoryPicker } from '../components/TxnSheet';

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function Transactions() {
  const [sp, setSp] = useSearchParams();
  const [search, setSearch] = useState(sp.get('q') || '');
  const q = useDebounced(search);
  const [open, setOpen] = useState<number | null>(null);
  const [picking, setPicking] = useState<Txn[] | null>(null); // rows whose category is being set
  const [sel, setSel] = useState<Set<Key>>(new Set());
  const toast = useToast();
  const { data: cats, byId } = useCategories();
  const accounts = useAccounts();
  const update = useUpdateTxn();
  const docked = useWide();
  useEffect(() => {
    if (!docked || open == null) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.sheet') && setOpen(null);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [docked, open]);

  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const month = sp.get('month');
  const filters: TxnFilters = {
    q: q || undefined,
    category: sp.get('category') ? Number(sp.get('category')) : undefined,
    account: sp.get('account') ? Number(sp.get('account')) : undefined,
    recurring: sp.get('recurring') ? Number(sp.get('recurring')) : undefined,
    reviewed: sp.get('review') ? 'false' : undefined,
    kind: (sp.get('kind') as 'income' | 'expense') || undefined,
    from: month ? `${month}-01` : undefined,
    to: month ? `${shiftMonth(month, 1)}-01` : undefined,
  };
  const list = useTransactions(filters, 100);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) || [], [list.data]);
  const totals = useMemo(() => {
    let out = 0, inn = 0;
    for (const t of rows) if (!t.excluded) t.amount > 0 ? (out += t.amount) : (inn -= t.amount);
    return { out, inn };
  }, [rows]);

  // Infinite scroll
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage(), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  // Drop selections that scrolled out of the current filter.
  useEffect(() => setSel(new Set()), [q, sp]);

  const review = useMutate((ids: number[]) => api<{ updated: number }>('/transactions/review', { body: { ids } }));
  const unreviewed = rows.filter((r) => !r.reviewed);
  const selectedRows = rows.filter((r) => sel.has(r.id));
  const anyFilter = !!(filters.q || filters.category || filters.account || filters.reviewed || filters.kind || month || filters.recurring);
  const cat = filters.category ? byId.get(filters.category) : null;

  const markReviewed = (ids: number[]) => review.mutateAsync(ids).then((r) => { toast(`Marked ${r.updated} reviewed`); setSel(new Set()); });
  const applyCategory = async (c: Category) => {
    const targets = picking || [];
    setPicking(null);
    await Promise.all(targets.map((t) => update.mutateAsync({ id: t.id, category_id: c.id }))).catch((e) => toast(e.message, { kind: 'error' }));
    toast(targets.length === 1 ? `Moved to ${c.name}` : `Moved ${targets.length} transactions to ${c.name}`);
    setSel(new Set());
  };
  const nextUnreviewed = () => {
    const i = rows.findIndex((t) => t.id === open);
    const next = rows.find((t, j) => j > i && !t.reviewed);
    setOpen(next ? next.id : null);
  };

  const toolbar = (
    <>
      <SearchInput value={search} onChange={setSearch} placeholder="Search merchants, notes, amounts" style={{ maxWidth: 340 }} />
      <Select auto variant="filter" className="desktop-only" value={sp.get('account') || ''} onChange={(e) => set('account', e.target.value || null)} onClear={() => set('account', null)} aria-label="Account">
        <option value="">All accounts</option>
        {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.label}{a.mask ? ` ··${a.mask}` : ''}</option>)}
      </Select>
      <Select auto variant="filter" className="desktop-only" value={sp.get('category') || ''} onChange={(e) => set('category', e.target.value || null)} onClear={() => set('category', null)} aria-label="Category">
        <option value="">All categories</option>
        {cats?.groups.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {cats.categories.filter((c) => c.group_id === g.id && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
          </optgroup>
        ))}
      </Select>
      <Segmented
        value={filters.kind || ''}
        onChange={(v) => set('kind', v || null)}
        options={[{ value: '', label: 'All' }, { value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }]}
      />
      <button className={`chip ${filters.reviewed ? 'on' : ''}`} onClick={() => set('review', filters.reviewed ? null : '1')}>Needs review</button>
      {cat && <button className="chip on mobile-only" onClick={() => set('category', null)}>{cat.emoji} {cat.name} <X /></button>}
      {month && <button className="chip on" onClick={() => set('month', null)}>{monthLabel(month)} <X /></button>}
      {filters.account && <button className="chip on mobile-only" onClick={() => set('account', null)}>{accounts.data?.find((a) => a.id === filters.account)?.label} <X /></button>}
      {filters.recurring && <button className="chip on" onClick={() => set('recurring', null)}>Recurring series <X /></button>}
      {anyFilter && <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setSp(new URLSearchParams(), { replace: true }); }}>Clear</Button>}
    </>
  );

  return (
    <Page>
      <PageHeader
        title="Transactions"
        sub={
          rows.length ? (
            <span className="num">
              {rows.length}{list.hasNextPage ? '+' : ''} shown · <span className="pos">+{money(totals.inn, { cents: false })}</span> in · {money(totals.out, { cents: false })} out
            </span>
          ) : undefined
        }
        actions={
          <>
            {filters.reviewed && unreviewed.length > 0 && !sel.size && (
              <Button size="sm" icon={<CheckCheck />} onClick={() => markReviewed(unreviewed.map((r) => r.id))}>Mark {unreviewed.length} reviewed</Button>
            )}
            <ButtonLink href="/api/export/transactions.csv" variant="ghost" size="sm" icon={<Download />} title="Export CSV" />
          </>
        }
        toolbar={toolbar}
      />

      {sel.size > 0 && (
        <div className="banner accent" role="status">
          <span className="strong num">{sel.size} selected</span>
          <span className="faint num">{money(selectedRows.reduce((a, t) => a + t.amount, 0))}</span>
          <div className="row" style={{ marginLeft: 'auto' }}>
            <Button size="sm" icon={<Tags />} onClick={() => setPicking(selectedRows)}>Categorize…</Button>
            <Button size="sm" icon={<CheckCheck />} onClick={() => markReviewed(selectedRows.map((t) => t.id))}>Mark reviewed</Button>
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
          </div>
        </div>
      )}

      <div className={docked && open != null ? 'with-dock' : undefined}>
        <Panel flush className="clip">
          <TxnTable
            rows={rows}
            byDay
            loading={list.isLoading}
            skeletonRows={14}
            selectedId={open}
            onOpen={(t) => setOpen(t.id)}
            onPickCategory={(t) => setPicking([t])}
            select={{ selected: sel, onChange: setSel }}
            onKeyAction={{
              r: (t) => !t.reviewed && markReviewed([t.id]),
              c: (t) => setPicking([t]),
              x: (t) => setSel((s) => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; }),
            }}
            empty={
              anyFilter ? (
                <Empty icon={<SearchIcon />} title="No matches" action={<Button size="sm" onClick={() => { setSearch(''); setSp(new URLSearchParams(), { replace: true }); }}>Clear filters</Button>}>
                  Nothing matches these filters.
                </Empty>
              ) : (
                <Empty title="No transactions yet">Connect an account and your transactions will appear here.</Empty>
              )
            }
          />
          {rows.length > 0 && (
            <div ref={sentinel} className="dt-more">
              {list.isFetchingNextPage ? 'Loading…' : list.hasNextPage ? ' ' : `${rows.length} transactions · that's everything`}
            </div>
          )}
          {rows.length > 0 && (
            <div className="panel-foot desktop-only">
              <span><span className="kbd">↑</span> <span className="kbd">↓</span> move · <span className="kbd">Enter</span> open · <span className="kbd">R</span> reviewed · <span className="kbd">C</span> category · <span className="kbd">X</span> select</span>
            </div>
          )}
        </Panel>
        {open != null && docked && <TxnSheet docked id={open} onClose={() => setOpen(null)} onNext={nextUnreviewed} />}
      </div>

      {open != null && !docked && <TxnSheet id={open} onClose={() => setOpen(null)} onNext={nextUnreviewed} />}
      {picking && (
        <Sheet title={picking.length === 1 ? 'Choose category' : `Categorize ${picking.length} transactions`} onClose={() => setPicking(null)} size="lg">
          <CategoryPicker value={picking.length === 1 ? picking[0].category_id : null} onPick={applyCategory} />
        </Sheet>
      )}
    </Page>
  );
}
