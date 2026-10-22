import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Check, ChevronRight, Plus, Repeat, Split, Target, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAccounts, useCategories, useGoals, useMutate, useTxn, useUpdateTxn } from '../lib/queries';
import { money, prettyName, shortDate, txnAmount } from '../lib/format';
import type { Category, Txn, TxnAllocation } from '../lib/types';
import RecurringForm from './RecurringForm';
import { Button, CatLabel, DataTable, IconButton, Input, InlineEdit, MerchantAvatar, MoneyInput, Panel, PickerButton, SearchInput, Sheet, Skel, Switch, Textarea, useToast, vars } from './ui';

export function CategoryPicker({ value, onPick, kinds }: { value?: number | null; onPick: (c: Category) => void; kinds?: string[] }) {
  const { data, groupById } = useCategories();
  const [q, setQ] = useState('');
  const groups = (data?.groups || []).filter((g) => !kinds || kinds.includes(g.kind));
  const cats = (data?.categories || []).filter((c) => !c.archived && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  const flat = groups.flatMap((g) => cats.filter((c) => c.group_id === g.id));
  return (
    <div className="stack">
      <form onSubmit={(e) => { e.preventDefault(); if (q && flat[0]) onPick(flat[0]); }}>
        <SearchInput value={q} onChange={setQ} placeholder="Find a category · Enter picks the first match" autoFocus={window.innerWidth > 760} />
      </form>
      {groups.map((g) => {
        const list = cats.filter((c) => c.group_id === g.id);
        if (!list.length) return null;
        return (
          <div key={g.id}>
            <div className="section-label" style={{ marginTop: 0 }}>{groupById.get(g.id)?.name}</div>
            <div className="picker-grid">
              {list.map((c) => (
                <button key={c.id} type="button" className={`picker-option ${value === c.id ? 'on' : ''}`} style={vars({ '--c': c.color })} onClick={() => onPick(c)}>
                  <i className="sw" />
                  <span className="e">{c.emoji}</span>
                  <span className="ellipsis">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Choose which goal or bucket paid for (or received) a transaction.
function GoalPicker({ amount, current, onPick }: { amount: number; current?: number | null; onPick: (id: number) => void }) {
  const goals = useGoals();
  const list = (goals.data?.goals || []).filter((g) => !g.archived);
  if (goals.isLoading) return <Skel h={120} />;
  if (!list.length) return <p className="muted">No goals or buckets yet. <Link className="link" to="/goals">Create one</Link> first.</p>;
  return (
    <div className="stack tight">
      <p className="muted small" style={{ marginBottom: 6 }}>
        {amount > 0 ? `The ${money(amount)} comes out of the bucket you pick, and is left out of your monthly spending so it doesn't count twice.` : `The ${money(-amount)} is added to the goal you pick.`}
      </p>
      {[...list].sort((a, b) => (a.kind === 'bucket' ? -1 : 1) - (b.kind === 'bucket' ? -1 : 1)).map((g) => (
        <button key={g.id} type="button" className={`picker-option ${current === g.id ? 'on' : ''}`} style={vars({ '--c': g.color })} onClick={() => onPick(g.id)}>
          <i className="sw" />
          <span className="e">{g.emoji}</span>
          <span className="ellipsis">{g.name}</span>
          <span className="faint small">{g.kind === 'bucket' ? 'Bucket' : 'Goal'}</span>
          <span className={`x ${amount > 0 && g.balance < amount ? 'warn' : ''}`}>{money(g.balance, { cents: false })}</span>
        </button>
      ))}
    </div>
  );
}

// Split one transaction across categories. Amounts are typed as positive numbers and take the transaction's sign; the
// first line takes whatever the others leave, so the lines always add up. Category picking swaps into the same sheet.
type Line = { category_id: number | null; amount: string; note: string };
const toCents = (v: string | number) => Math.round(Number(v || 0) * 100);
function SplitSheet({ t, onClose }: { t: Txn; onClose: () => void }) {
  const { byId } = useCategories();
  const toast = useToast();
  const sign = t.amount < 0 ? -1 : 1;
  const total = Math.abs(toCents(t.amount));
  const [lines, setLines] = useState<Line[]>(() =>
    t.splits?.length
      ? t.splits.map((l) => ({ category_id: l.category_id, amount: String(Math.abs(l.amount)), note: l.note || '' }))
      : [{ category_id: t.category_id, amount: '', note: '' }, { category_id: null, amount: '', note: '' }],
  );
  const [pickFor, setPickFor] = useState<number | null>(null);
  const others = lines.slice(1).reduce((a, l) => a + toCents(l.amount), 0);
  const first = total - others;
  const ok = first > 0 && lines.slice(1).every((l) => toCents(l.amount) > 0) && lines.every((l) => l.category_id != null);
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const evenly = () => {
    const each = Math.floor(total / lines.length);
    setLines((ls) => ls.map((l, i) => ({ ...l, amount: i === 0 ? '' : String(each / 100) })));
  };
  const saveSplit = useMutate(() =>
    api(`/transactions/${t.id}/splits`, {
      method: 'PUT',
      body: { lines: lines.map((l, i) => ({ category_id: l.category_id, amount: (sign * (i === 0 ? first : toCents(l.amount))) / 100, note: l.note.trim() || null })) },
    }),
  );
  const unsplit = useMutate(() => api(`/transactions/${t.id}/splits`, { method: 'DELETE' }));

  if (pickFor != null)
    return (
      <Sheet title={`Line ${pickFor + 1} category`} onClose={() => setPickFor(null)} size="lg">
        <CategoryPicker value={lines[pickFor]?.category_id} onPick={(c) => { set(pickFor, { category_id: c.id }); setPickFor(null); }} />
      </Sheet>
    );

  return (
    <Sheet
      title="Split transaction" onClose={onClose} size="lg"
      footer={
        <>
          {t.splits?.length ? <Button variant="ghost" onClick={() => unsplit.mutateAsync(undefined).then(() => { toast('Split removed'); onClose(); })}>Remove split</Button> : null}
          <Button variant="primary" style={{ marginLeft: 'auto' }} disabled={!ok || saveSplit.isPending}
            onClick={() => saveSplit.mutateAsync(undefined).then(() => { toast(`Split across ${lines.length} categories`); onClose(); }).catch((e) => toast(e.message, { kind: 'error' }))}>
            Save split
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="split-total">
          <span className="muted">{prettyName(t.label)} · {shortDate(t.date)}</span>
          <span className={`num strong ${t.amount < 0 ? 'pos' : ''}`}>{txnAmount(t.amount)}</span>
        </div>
        <div className="split-lines">
          {lines.map((l, i) => (
            <div key={i} className="split-line">
              <PickerButton sm placeholder="Category" aria-label={`Line ${i + 1} category`} onClick={() => setPickFor(i)}>
                {l.category_id != null && <CatLabel cat={byId.get(l.category_id)} />}
              </PickerButton>
              {i === 0
                ? <MoneyInput sm value={first > 0 ? String(first / 100) : ''} onChange={() => {}} disabled invalid={first <= 0} aria-label="Line 1 amount (the rest)" placeholder="0" title="Takes whatever the other lines leave" />
                : <MoneyInput sm value={l.amount} onChange={(v) => set(i, { amount: v })} aria-label={`Line ${i + 1} amount`} placeholder="0.00" autoFocus={i === lines.length - 1 && !l.amount && i > 1} />}
              <Input sm value={l.note} onChange={(e) => set(i, { note: e.target.value })} placeholder="Note" aria-label={`Line ${i + 1} note`} />
              {i > 0 && lines.length > 2
                ? <IconButton size="sm" icon={<X />} label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
                : <span className="split-gap" />}
            </div>
          ))}
        </div>
        <p className={`small ${first <= 0 ? 'neg' : 'faint'}`}>
          {first <= 0 ? `The lines are ${money((others - total) / 100)} more than the transaction.` : `The first line takes the rest: ${money(first / 100)}.`}
        </p>
        <div className="chips">
          <button type="button" className="chip" disabled={lines.length >= 20} onClick={() => setLines((ls) => [...ls, { category_id: null, amount: '', note: '' }])}><Plus size={12} /> Add line</button>
          <button type="button" className="chip" onClick={evenly}>Split evenly</button>
        </div>
        <p className="faint small">Budgets, cash flow and reports count each line in its own category. Picking a single category later removes the split.</p>
      </div>
    </Sheet>
  );
}

// Transaction detail. `docked` renders it as a panel beside the table (wide screens); otherwise a drawer.
export default function TxnSheet({ id, onClose, onNext, docked = false }: { id: number; onClose: () => void; onNext?: () => void; docked?: boolean }) {
  const tx = useTxn(id);
  const { byId } = useCategories();
  const accounts = useAccounts();
  const update = useUpdateTxn();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [pickingGoal, setPickingGoal] = useState(false);
  const [makingRec, setMakingRec] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const linkGoal = useMutate((goalId: number) => api(`/goals/${goalId}/entries`, { body: { transaction_id: id } }));
  const unlinkGoal = useMutate(() => api(`/transactions/${id}/goal`, { method: 'DELETE' }));
  const removeAlloc = useMutate((a: TxnAllocation) => api(`/goals/${a.goal_id}/allocations/${a.id}`, { method: 'DELETE' }));
  const [notes, setNotes] = useState('');
  const t = tx.data;
  useEffect(() => {
    if (t) {
      setNotes(t.notes || '');
    }
  }, [t?.id, t?.label, t?.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const cat = t?.category_id ? byId.get(t.category_id) : null;
  const acct = accounts.data?.find((a) => a.id === t?.account_id);
  const merchant = t ? prettyName(t.merchant_name || t.name) : '';
  const others = (t?.stats.n || 1) - 1;

  const save = (body: Parameters<typeof update.mutate>[0], msg?: string) =>
    update.mutateAsync(body).then((r) => (msg && toast(msg), r)).catch((e) => toast(e.message, { kind: 'error' }));

  const pick = async (c: Category) => {
    if (!t) return;
    setPicking(false);
    await save({ id: t.id, category_id: c.id });
    if (others > 0)
      toast(`Moved to ${c.name}`, {
        action: {
          label: `Apply to all ${merchant}`,
          run: () => save({ id: t.id, category_id: c.id, applyToMerchant: true }, `Updated every ${merchant} transaction and saved a rule`),
        },
      });
    else toast(`Moved to ${c.name}`);
  };

  const history = useMemo(() => t?.history || [], [t]);

  const pickers = (
    <>
      {picking && (
        <Sheet title="Choose category" onClose={() => setPicking(false)} size="lg">
          <CategoryPicker value={t?.category_id} onPick={pick} />
        </Sheet>
      )}
      {pickingGoal && t && (
        <Sheet title={t.amount > 0 ? 'Pay from a goal' : 'Add to a goal'} onClose={() => setPickingGoal(false)}>
          <GoalPicker amount={t.amount} current={t.goal_id} onPick={(gid) => linkGoal.mutateAsync(gid).then(() => { setPickingGoal(false); toast(t.amount > 0 ? 'Paid from goal · left out of monthly spending' : 'Added to goal'); }).catch((e) => toast(e.message, { kind: 'error' }))} />
        </Sheet>
      )}
      {makingRec && t && <RecurringForm fromTxn={t} onClose={() => setMakingRec(false)} />}
      {splitting && t && <SplitSheet t={t} onClose={() => setSplitting(false)} />}
    </>
  );

  const reviewButton = (size?: 'sm') => t && (!t.reviewed ? (
    <Button size={size} variant="primary" icon={<Check />} disabled={update.isPending} onClick={async () => { await save({ id: t.id, reviewed: true }); (onNext || onClose)(); }} title="Mark reviewed (R)">
      Mark reviewed
    </Button>
  ) : (
    <Button size={size} onClick={() => save({ id: t.id, reviewed: false }, 'Marked as unreviewed')}>Mark unreviewed</Button>
  ));

  const body = !t ? (
    <div className="stack">
      <Skel w="60%" h={16} />
      <Skel h={120} />
      <Skel h={80} />
    </div>
  ) : (
    <div className="txn-detail">
      <div className="txn-head">
        <MerchantAvatar name={t.label} logo={t.logo_url} cat={cat} size="lg" />
        <div style={{ minWidth: 0 }}>
          <InlineEdit
            value={prettyName(t.label)} aria-label="Display name" placeholder={prettyName(t.merchant_name || t.name)} allowEmpty
            onCommit={(v) => save({ id: t.id, display_name: v || null }, v ? 'Renamed' : 'Name reset')}
          />
          <div className="meta">
            {new Date(t.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            {t.pending && <> · <span className="warn">Pending</span></>}
          </div>
        </div>
        <div className={`amount num ${t.amount < 0 ? 'pos' : ''}`}>{txnAmount(t.amount)}</div>
      </div>

      <div className="kv">
        {t.splits?.length ? (
          <button type="button" className="split-kv" onClick={() => setSplitting(true)} title="Edit the split">
            <span className="k">Category</span>
            <span className="v faint small"><Split size={12} style={{ marginRight: 4 }} />Split · {t.splits.length} categories</span>
            <ChevronRight size={14} className="faint" />
            <span className="split-list">
              {t.splits.map((l) => (
                <span key={l.id} className="split-row">
                  <CatLabel cat={byId.get(l.category_id)} />
                  {l.note && <span className="faint small ellipsis">{l.note}</span>}
                  <span className={`num ${l.amount < 0 ? 'pos' : ''}`}>{txnAmount(l.amount)}</span>
                </span>
              ))}
            </span>
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setPicking(true)}>
              <span className="k">Category</span>
              <span className="v"><CatLabel cat={cat} /></span>
              <ChevronRight size={14} className="faint" />
            </button>
            <button type="button" onClick={() => setSplitting(true)} title="Divide it across several categories">
              <span className="k">Split</span>
              <span className="v faint"><Split size={13} style={{ marginRight: 6 }} />Split across categories</span>
              <ChevronRight size={14} className="faint" />
            </button>
          </>
        )}
        <div>
          <span className="k">Account</span>
          <span className="v ellipsis">{acct ? `${acct.label}${acct.mask ? ` ··${acct.mask}` : ''}` : '—'}</span>
        </div>
        <div>
          <span className="k">Statement</span>
          <span className="v ellipsis faint" title={t.name}>{t.name}</span>
        </div>
        {t.recurring_id ? (
          <Link to={`/transactions?recurring=${t.recurring_id}`}>
            <span className="k">Recurring</span>
            <span className="v"><Repeat size={13} className="faint" style={{ marginRight: 6 }} /> See the series</span>
            <ChevronRight size={14} className="faint" />
          </Link>
        ) : (
          <button type="button" onClick={() => setMakingRec(true)} title="Track it as a subscription or bill, e.g. a yearly renewal">
            <span className="k">Recurring</span>
            <span className="v"><Repeat size={13} className="faint" style={{ marginRight: 6 }} /> Make recurring</span>
            <ChevronRight size={14} className="faint" />
          </button>
        )}
        {t.allocations?.map((a) => (
          <div key={a.id}>
            <span className="k">Set aside</span>
            <Link className="v ellipsis" to={`/goals?open=${a.goal_id}`} title={a.rule_id ? 'Set aside by a rule' : undefined}>{a.emoji} {a.name}</Link>
            <span className="num">{money(a.amount)}</span>
            <IconButton size="sm" icon={<X />} label={`Take back from ${a.name}`} onClick={() => removeAlloc.mutateAsync(a).then(() => toast(`Took ${money(a.amount)} back from ${a.name}`)).catch((e) => toast(e.message, { kind: 'error' }))} />
          </div>
        ))}
        {t.goal_id ? (
          <div>
            <span className="k">{t.amount > 0 ? 'Paid from' : 'Added to'}</span>
            <span className="v ellipsis">{t.goal_emoji} {t.goal_name}</span>
            <Button size="sm" variant="ghost" onClick={() => setPickingGoal(true)}>Change</Button>
            <IconButton size="sm" icon={<X />} label="Unlink goal" onClick={() => unlinkGoal.mutateAsync(undefined).then(() => toast('Unlinked from goal'))} />
          </div>
        ) : (
          <button type="button" onClick={() => setPickingGoal(true)}>
            <span className="k">Goal</span>
            <span className="v faint"><Target size={13} style={{ marginRight: 6 }} />{t.amount > 0 ? 'Pay from a goal or bucket' : 'Add to a goal'}</span>
            <ChevronRight size={14} className="faint" />
          </button>
        )}
        <label>
          <span className="grow">
            <span style={{ display: 'block' }}>Exclude</span>
            <span className="faint small">Leave out of budgets and cash flow</span>
          </span>
          <Switch on={t.excluded} label="Exclude from spending" onChange={(v) => save({ id: t.id, excluded: v }, v ? 'Excluded from spending' : 'Included in spending')} />
        </label>
      </div>

      <div className="section-label">Notes</div>
      <Textarea
        placeholder="Add a note…" value={notes} onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== (t.notes || '') && save({ id: t.id, notes }, 'Note saved')}
      />

      {history.length > 0 && (
        <>
          <div className="section-label">
            <span>Other {merchant} transactions</span>
            <span className="faint num" style={{ marginLeft: 'auto' }}>{t.stats.n} in 12 mo · avg {money(Math.abs(t.stats.avg))}</span>
          </div>
          <div className="table-box">
            <DataTable
              sticky={false}
              columns={[
                { key: 'd', header: 'Date', shrink: true, cell: (h) => <span className="muted num">{shortDate(h.date)}</span> },
                { key: 'c', header: 'Category', wide: true, cell: (h) => <CatLabel cat={h.category_id ? byId.get(h.category_id) : null} /> },
                { key: 'a', header: 'Amount', num: true, cell: (h) => <span className={h.amount < 0 ? 'pos' : ''}>{txnAmount(h.amount)}</span> },
              ]}
              rows={history.slice(0, 8)}
              rowKey={(h) => h.id}
            />
          </div>
        </>
      )}
    </div>
  );

  if (docked)
    return (
      <>
        <Panel
          className="dock"
          title={t ? 'Transaction' : ' '}
          actions={<>{reviewButton('sm')}<IconButton size="sm" icon={<X />} label="Close (Esc)" onClick={onClose} /></>}
        >
          {body}
        </Panel>
        {pickers}
      </>
    );

  if (picking || pickingGoal || makingRec || splitting) return pickers;

  return (
    <Sheet title="Transaction" onClose={onClose} footer={reviewButton()}>
      {body}
    </Sheet>
  );
}

