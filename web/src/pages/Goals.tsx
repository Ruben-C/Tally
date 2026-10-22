// Goals: savings targets (an amount, optionally by a date) and buckets (money set aside to spend later).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, Archive, Check, Link2, Pencil, Plus, Repeat, Target, Trash2, Wand2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAllocations, useCategories, useGoal, useGoals, useMutate } from '../lib/queries';
import { isoFromToday, money, prettyName, shortDate, todayIso } from '../lib/format';
import type { Goal, GoalDetail } from '../lib/types';
import {
  Badge, Button, CatAvatar, DataTable, DateInput, EmojiPicker, Empty, Field, IconButton, Input, Meter, Modal, MoneyInput, Page, PageHeader, Panel, Segmented, Sheet, Skel, Sparkline, Stat, StatGrid, SwatchPicker, Switch,
  useToast, useWide, vars, type Column,
} from '../components/ui';
import { GoalChart } from '../components/charts';
import TxnSheet from '../components/TxnSheet';
import { AllocationList, FundingBreakdown, FundingEditor, draftFromSources, linksPayload, linksValid, valueOf, type LinkDraft } from '../components/Funding';

const EMOJIS = ['🎯', '🛟', '✈️', '🗾', '🏖️', '🏠', '🚗', '🔧', '💻', '📱', '🎁', '💍', '👶', '🎓', '🩺', '🐾', '🛋️', '🎸', '🚲', '📷', '🏦', '💰', '🌱', '🎉'];
const COLORS = ['#30d158', '#34c759', '#66d4cf', '#40c8e0', '#0a84ff', '#5e5ce6', '#7d7aff', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#ffd60a'];

const TEMPLATES: { kind: Goal['kind']; name: string; emoji: string; color: string; target?: number; monthly?: number }[] = [
  { kind: 'target', name: 'Emergency fund', emoji: '🛟', color: '#30d158', target: 10000 },
  { kind: 'target', name: 'Vacation', emoji: '✈️', color: '#40c8e0', target: 3000 },
  { kind: 'target', name: 'Home down payment', emoji: '🏠', color: '#5e5ce6', target: 40000 },
  { kind: 'target', name: 'New car', emoji: '🚗', color: '#ff9f0a', target: 8000 },
  { kind: 'bucket', name: 'Big purchases', emoji: '🛋️', color: '#bf5af2' },
  { kind: 'bucket', name: 'Car maintenance', emoji: '🔧', color: '#ff9f0a', monthly: 100 },
  { kind: 'bucket', name: 'Gifts', emoji: '🎁', color: '#ff375f', monthly: 75 },
  { kind: 'bucket', name: 'Medical', emoji: '🩺', color: '#ff453a', monthly: 50 },
];

const monthName = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const monthsUntil = (iso: string) => {
  const d = new Date(iso + 'T12:00'), n = new Date();
  return Math.max((d.getFullYear() - n.getFullYear()) * 12 + (d.getMonth() - n.getMonth()), 1);
};

const ETA = (iso: string) => new Date(iso + 'T12:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
const c0 = { cents: false } as const;

export function StatusChip({ g }: { g: Goal }) {
  if (g.status === 'done') return <Badge tone="good" icon={<Check />}>Reached</Badge>;
  if (g.status === 'on_track') return <Badge tone="good">On track</Badge>;
  if (g.status === 'behind') return <Badge tone="bad">Behind</Badge>;
  if (g.status === 'overdue') return <Badge tone="bad">Past date</Badge>;
  if (g.status === 'no_plan') return <Badge>No plan yet</Badge>;
  if (g.status === 'new') return <Badge>Just started</Badge>;
  return <Badge tone="outline">Bucket</Badge>;
}

// One plain sentence about where the goal stands.
export function goalSentence(g: Goal) {
  if (g.kind === 'bucket') {
    const parts = [];
    if (g.monthly_amount) parts.push(`${money(g.monthly_amount, { cents: false })}/month ${g.auto_contribute ? 'added automatically' : 'planned'}`);
    if (g.spent > 0) parts.push(`${money(g.spent, { cents: false })} spent from it so far`);
    if (g.target_amount) parts.push(`${money(Math.max(g.target_amount - g.balance, 0), { cents: false })} until it's full`);
    return parts.join(' · ') || 'Add money whenever you like, and pay for purchases from it.';
  }
  if (g.status === 'done') return `You reached ${money(g.target_amount, { cents: false })}. Nice work.`;
  const left = money(g.remaining ?? 0, { cents: false });
  if (g.status === 'behind' && g.target_date && g.needed_monthly)
    return `${left} to go. Save ${money(g.needed_monthly, { cents: false })}/month to make ${monthName(g.target_date)}${g.pace ? ` (now ${money(g.pace, { cents: false })}/month)` : ''}.`;
  if (g.status === 'overdue') return `${left} to go and the target date has passed. Pick a new date or adjust the amount.`;
  if (g.projected_date) return `${left} to go. At ${money(g.pace ?? 0, { cents: false })}/month you'll get there by ${monthName(g.projected_date)}.`;
  return `${left} to go. Set a monthly amount to see when you'll get there.`;
}

// Add or take money: from a specific account (allocates more / less of it to the goal) or "separately"
// (money tracked only in Tally). Accounts the goal already counts in full or by percentage aren't offered.
function MoneyModal({ g, mode, onClose }: { g: Goal; mode: 'add' | 'take'; onClose: () => void }) {
  const toast = useToast();
  const alloc = useAllocations();
  const [m, setM] = useState(mode);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayIso());
  const tracked = new Set(g.sources.filter((x) => x.mode !== 'amount').map((x) => x.account_id));
  const linked = g.sources.filter((x) => x.mode === 'amount');
  const isLinked = (id: number) => linked.some((l) => l.account_id === id);
  // Accounts already funding this goal first, then the rest.
  const options = (alloc.data || [])
    .filter((a) => !tracked.has(a.account_id) && !a.hidden && (m === 'add' || isLinked(a.account_id)))
    .sort((a, b) => Number(isLinked(b.account_id)) - Number(isLinked(a.account_id)));
  const [from, setFrom] = useState<number | 'separate'>(linked[0]?.account_id ?? 'separate');
  useEffect(() => {
    if (!alloc.data) return; // wait for the accounts before correcting the default
    if (from !== 'separate' && !options.some((o) => o.account_id === from)) setFrom(options[0]?.account_id ?? 'separate');
  }, [m, alloc.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const acct = from === 'separate' ? null : (alloc.data || []).find((a) => a.account_id === from);
  const mine = acct?.goals.find((x) => x.goal_id === g.id)?.value || 0;
  const v = Number(amount.replace(/[$,]/g, ''));
  const ok = Number.isFinite(v) && v > 0;
  const limit = m === 'take' ? (acct ? mine : Math.max(g.entries_total, 0)) : acct ? acct.free : null;
  const save = useMutate(() =>
    acct
      ? api(`/goals/${g.id}/allocate`, { body: { account_id: acct.account_id, amount: (m === 'add' ? 1 : -1) * v, note: note || null, date } })
      : api(`/goals/${g.id}/entries`, { body: { amount: (m === 'add' ? 1 : -1) * v, note: note || null, date } }),
  );
  const submit = () => ok && save.mutateAsync(undefined).then(() => {
    toast(m === 'add' ? `${money(v)} ${acct ? `of ${acct.label} ` : ''}now set aside for ${g.name}` : `Took ${money(v)} from ${g.name}`);
    onClose();
  }).catch((e) => toast(e.message, { kind: 'error' }));

  return (
    <Modal onClose={onClose}>
      <div className="row between" style={{ marginBottom: 14 }}>
        <h2 className="ellipsis">{g.name}</h2>
        <Segmented size="sm" value={m} onChange={setM} options={[{ value: 'add', label: 'Add' }, { value: 'take', label: 'Take out' }]} />
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <span className="field-label">{m === 'add' ? 'From' : 'Take from'}</span>
        <div className="g-sources">
          {options.map((o) => {
            const here = o.goals.find((x) => x.goal_id === g.id)?.value || 0;
            return (
              <button key={o.account_id} type="button" className={`picker-option ${from === o.account_id ? 'on' : ''}`} onClick={() => setFrom(o.account_id)}>
                <span className="ellipsis">{o.label}{o.mask ? <span className="faint"> ··{o.mask}</span> : null}</span>
                {isLinked(o.account_id) && <Badge>Funding this</Badge>}
                <span className="x">{m === 'add' ? `${money(Math.max(o.free, 0), c0)} free` : `${money(here, c0)} here`}</span>
              </button>
            );
          })}
          <button type="button" className={`picker-option ${from === 'separate' ? 'on' : ''}`} onClick={() => setFrom('separate')}>
            <span className="ellipsis">Separately <span className="faint">· not tied to an account</span></span>
            {m === 'take' && <span className="x">{money(Math.max(g.entries_total, 0), c0)} here</span>}
          </button>
        </div>
      </div>
      <div className="form-grid">
        <Field label="Amount" full>
          <MoneyInput lg value={amount} onChange={setAmount} placeholder="0.00" autoFocus step={10} onKeyDown={(e) => e.key === 'Enter' && submit()} aria-label="Amount" />
        </Field>
        <div className="chips full">
          {[100, 250, 500, 1000].map((n) => <button key={n} className="chip" onClick={() => setAmount(String(n))}>{money(n, c0)}</button>)}
          {limit != null && limit > 0 && <button className="chip" onClick={() => setAmount(String(Math.floor(limit * 100) / 100))}>{m === 'add' ? 'All free' : 'All'} {money(limit, c0)}</button>}
        </div>
        <Field label="Note"><Input placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Date"><DateInput value={date} max={todayIso()} onChange={setDate} aria-label="Date" /></Field>
      </div>
      {ok && limit != null && v > limit + 0.005 && (
        <p className="inline-alert warn" style={{ marginTop: 10 }}>
          {m === 'add' ? `Only ${money(Math.max(limit, 0))} of ${acct?.label} isn't already set aside for other goals.` : `Only ${money(limit)} is held here${m === 'take' && acct ? '; that much will be released' : ''}.`}
        </p>
      )}
      <p className="field-hint" style={{ marginTop: 10 }}>
        {acct ? `Sets aside part of ${acct.label} for this ${g.kind === 'bucket' ? 'bucket' : 'goal'}. Money doesn't move; it's earmarked.` : 'Tracked only in Tally, e.g. cash or an account you haven\'t connected.'}
      </p>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ok || save.isPending} onClick={submit} icon={m === 'add' ? <ArrowDownLeft /> : <ArrowUpRight />}>{m === 'add' ? 'Add' : 'Take out'}</Button>
      </div>
    </Modal>
  );
}

export function GoalEditor({ goal, onClose, preset }: { goal?: Goal; onClose: (created?: number) => void; preset?: Partial<(typeof TEMPLATES)[number]> }) {
  const toast = useToast();
  const alloc = useAllocations();
  const [kind, setKind] = useState<Goal['kind']>(goal?.kind || preset?.kind || 'target');
  const [name, setName] = useState(goal?.name || preset?.name || '');
  const [emoji, setEmoji] = useState(goal?.emoji || preset?.emoji || '🎯');
  const [color, setColor] = useState(goal?.color || preset?.color || '#7d7aff');
  const [target, setTarget] = useState(goal?.target_amount != null ? String(goal.target_amount) : preset?.target ? String(preset.target) : '');
  const [date, setDate] = useState(goal?.target_date || '');
  const [monthly, setMonthly] = useState(goal?.monthly_amount != null ? String(goal.monthly_amount) : preset?.monthly ? String(preset.monthly) : '');
  const [auto, setAuto] = useState(goal?.auto_contribute ?? !!preset?.monthly);
  const [links, setLinks] = useState<LinkDraft[]>(goal ? draftFromSources(goal.sources) : []);
  const [start, setStart] = useState('');
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(/[$,]/g, '')));
  const t = num(target), mo = num(monthly);
  const fromAccounts = links.reduce((s, d) => s + valueOf(d, alloc.data?.find((a) => a.account_id === d.account_id)?.balance || 0), 0);
  const have = fromAccounts + (goal ? goal.entries_total : num(start) || 0);
  const suggestion = kind === 'target' && t && date ? Math.ceil(Math.max(t - have, 0) / monthsUntil(date)) : null;
  const valid = !!name.trim() && (kind === 'bucket' || (t != null && t > 0)) && linksValid(links);

  const save = useMutate(() => {
    const body = {
      kind, name, emoji, color, target_amount: t, target_date: kind === 'target' ? date || null : null,
      monthly_amount: mo, auto_contribute: !links.length && !!mo && auto, accounts: linksPayload(links),
      ...(goal ? {} : { starting_amount: num(start) || 0 }),
    };
    return goal ? api<Goal>(`/goals/${goal.id}`, { method: 'PATCH', body }) : api<Goal>('/goals', { body });
  });
  const del = useMutate(() => api(`/goals/${goal!.id}`, { method: 'DELETE' }));
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <Sheet size="lg" title={goal ? `Edit ${goal.name}` : kind === 'target' ? 'New savings goal' : 'New bucket'} onClose={() => onClose()}
      footer={
        <>
          {goal && <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDel(true)} style={{ marginRight: 'auto' }}>Delete</Button>}
          <Button variant="ghost" onClick={() => onClose()}>Cancel</Button>
          <Button variant="primary" disabled={!valid || save.isPending}
            onClick={() => save.mutateAsync(undefined).then((g) => { toast(goal ? 'Goal updated' : `${name} created`); onClose(goal ? undefined : g.id); }).catch((e) => toast(e.message, { kind: 'error' }))}>
            {goal ? 'Save changes' : kind === 'target' ? 'Create goal' : 'Create bucket'}
          </Button>
        </>
      }>
      <div className="form-grid">
        {!goal && (
          <Field as="div" label="Type" full hint={kind === 'target' ? 'Save up to a set amount, optionally by a date.' : 'Set money aside for bigger purchases and pay for them from it.'}>
            <Segmented value={kind} onChange={setKind} options={[{ value: 'target', label: 'Savings goal' }, { value: 'bucket', label: 'Bucket' }]} />
          </Field>
        )}
        <Field label="Name">
          <div className="row">
            <CatAvatar cat={{ emoji, color }} />
            <Input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'target' ? 'e.g. Japan trip' : 'e.g. New laptop'} autoFocus={!goal} />
          </div>
        </Field>
        <Field label={kind === 'target' ? 'Target amount' : 'Fill up to (optional)'}>
          <MoneyInput value={target} onChange={setTarget} placeholder={kind === 'target' ? '5,000' : 'No limit'} step={100} />
        </Field>
        <div className="field full">
          <span className="field-label">Icon & colour</span>
          <div className="g-icons">
            <EmojiPicker value={emoji} options={EMOJIS} onChange={setEmoji} />
            <SwatchPicker value={color} options={COLORS} onChange={setColor} />
          </div>
        </div>
        {kind === 'target' && (
          <Field label="By (optional)">
            <DateInput value={date} min={todayIso()} onChange={setDate} clearable aria-label="Target date"
              presets={[{ label: '6 months', value: isoFromToday({ months: 6 }) }, { label: '1 year', value: isoFromToday({ years: 1 }) }, { label: '2 years', value: isoFromToday({ years: 2 }) }]} />
          </Field>
        )}
        <Field label="Monthly amount" hint={!links.length && mo ? undefined : 'Optional. Used to project when you get there.'}>
          <MoneyInput value={monthly} onChange={setMonthly} placeholder="Optional" suffix="/mo" step={10} />
          {suggestion != null && suggestion > 0 && Number(monthly || 0) !== suggestion && (
            <button type="button" className="chip" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => setMonthly(String(suggestion))}>
              Use {money(suggestion, c0)}/mo to make {shortDate(date)}
            </button>
          )}
        </Field>
        {!links.length && !!mo && (
          <div className="kv full">
            <label>
              <Repeat size={14} className="faint" />
              <span className="grow">
                <span style={{ display: 'block' }}>Add it automatically each month</span>
                <span className="faint small">On the 1st{kind === 'target' ? ', stopping once the goal is reached' : ''}. Match it with a recurring transfer at your bank.</span>
              </span>
              <Switch on={auto} label="Auto contribute" onChange={setAuto} />
            </label>
          </div>
        )}

        <div className="field full">
          <span className="field-label">Funded by accounts</span>
          <span className="field-hint">Count all of an account, a fixed amount of it, or a percentage. Mix as many as you like, e.g. $10,000 of savings plus 80% of a brokerage account.</span>
          <FundingEditor goalId={goal?.id} drafts={links} onChange={setLinks} />
        </div>

        {!goal && (
          <Field label={links.length ? 'Also set aside elsewhere (optional)' : 'Already saved (optional)'}>
            <MoneyInput value={start} onChange={setStart} placeholder="0" step={100} />
          </Field>
        )}
        {have > 0 && (
          <div className="g-total full">
            <span className="muted">{kind === 'target' ? 'Counts toward this goal now' : 'In this bucket now'}</span>
            <span className="num strong">{money(have, c0)}{t ? <span className="faint" style={{ fontWeight: 400 }}> of {money(t, c0)}</span> : null}</span>
          </div>
        )}
      </div>
      {confirmDel && goal && (
        <Modal onClose={() => setConfirmDel(false)}>
          <h2 style={{ marginBottom: 8 }}>Delete {goal.name}?</h2>
          <p className="muted">This removes its {money(goal.balance)} balance and history from Tally. Purchases paid from it count as normal spending again. Your bank accounts aren't affected.</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="danger" className="solid" onClick={() => del.mutateAsync(undefined).then(() => { toast('Deleted'); onClose(); })}>Delete</Button>
          </div>
        </Modal>
      )}
    </Sheet>
  );
}

type Activity =
  | { key: string; date: string; sort: number; type: 'entry'; e: GoalDetail['entries'][number] }
  | { key: string; date: string; sort: number; type: 'alloc'; x: GoalDetail['allocations'][number] };

function GoalSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const goal = useGoal(id);
  const { byId } = useCategories();
  const [money_, setMoney] = useState<'add' | 'take' | null>(null);
  const [editing, setEditing] = useState(false);
  const [txn, setTxn] = useState<number | null>(null);
  const delEntry = useMutate((e: number) => api(`/goals/${id}/entries/${e}`, { method: 'DELETE' }));
  const delAlloc = useMutate((a: number) => api(`/goals/${id}/allocations/${a}`, { method: 'DELETE' }));
  const update = useMutate((body: Record<string, unknown>) => api(`/goals/${id}`, { method: 'PATCH', body }));
  const g = goal.data as GoalDetail | undefined;

  if (editing && g) return <GoalEditor goal={g} onClose={() => setEditing(false)} />;
  if (txn != null) return <TxnSheet id={txn} onClose={() => setTxn(null)} />;

  const activity: Activity[] = g
    ? [
        ...g.entries.map((e) => ({ key: `e${e.id}`, date: e.date, sort: e.id, type: 'entry' as const, e })),
        ...g.allocations.map((x) => ({ key: `a${x.id}`, date: x.date, sort: x.id, type: 'alloc' as const, x })),
      ].sort((p, q) => (p.date < q.date ? 1 : p.date > q.date ? -1 : q.sort - p.sort)).slice(0, 60)
    : [];

  const activityCols: Column<Activity>[] = [
    { key: 'd', header: 'Date', shrink: true, hide: 'sm', cell: (r) => <span className="muted num">{shortDate(r.date)}</span> },
    {
      key: 'what', header: 'What', wide: true,
      // Phone: date and detail go on the second line; the first line keeps just what happened.
      sub: (r) => [shortDate(r.date), r.type === 'alloc' ? r.x.note : r.e.transaction_id ? r.e.note : null, r.type === 'alloc' && r.x.rule_id ? 'by rule' : null].filter(Boolean).join(' · '),
      cell: (r) => {
        if (r.type === 'alloc') {
          const x = r.x;
          return (
            <div className="cell">
              {x.rule_id ? <Wand2 size={13} className="faint" /> : <Link2 size={13} className="faint" />}
              <span className="ellipsis">{x.amount > 0 ? 'Set aside from' : 'Released from'} {x.account_label}{x.note ? <span className="faint desktop-only"> · {x.note}</span> : null}{x.rule_id ? <span className="faint desktop-only"> · by rule</span> : null}</span>
            </div>
          );
        }
        const e = r.e;
        const cat = e.txn_category_id ? byId.get(e.txn_category_id) : null;
        return (
          <div className="cell">
            {e.kind === 'transaction' ? <span style={{ width: 13, textAlign: 'center', fontSize: 11 }}>{cat?.emoji || '·'}</span> : e.kind === 'auto' ? <Repeat size={13} className="faint" /> : e.amount > 0 ? <ArrowDownLeft size={13} className="faint" /> : <ArrowUpRight size={13} className="faint" />}
            {e.transaction_id ? (
              <button className="link ellipsis" style={{ background: 'none', border: 0, padding: 0 }} onClick={() => setTxn(e.transaction_id!)}>{prettyName(e.txn_label || 'Purchase')}</button>
            ) : <span className="ellipsis">{e.note || (e.kind === 'initial' ? 'Starting balance' : e.kind === 'auto' ? 'Monthly contribution' : e.amount > 0 ? 'Added separately' : 'Taken out')}</span>}
            {e.transaction_id && e.note ? <span className="faint ellipsis desktop-only">· {e.note}</span> : null}
          </div>
        );
      },
    },
    {
      key: 'a', header: 'Amount', num: true,
      cell: (r) => {
        const amt = r.type === 'alloc' ? r.x.amount : r.e.amount;
        return <span className={amt > 0 ? 'pos' : ''}>{amt === 0 ? 'Linked' : `${amt > 0 ? '+' : '−'}${money(Math.abs(amt))}`}</span>;
      },
    },
    {
      key: 'x', header: '', shrink: true,
      cell: (r) =>
        r.type === 'alloc' ? (
          <span className="row-actions"><IconButton size="sm" icon={<X />} label="Undo" onClick={() => delAlloc.mutateAsync(r.x.id).then(() => toast('Removed'))} /></span>
        ) : r.e.kind !== 'auto' ? (
          <span className="row-actions"><IconButton size="sm" icon={<X />} label={r.e.transaction_id ? 'Unlink purchase' : 'Remove entry'} onClick={() => delEntry.mutateAsync(r.e.id).then(() => toast(r.e.transaction_id ? 'Purchase unlinked; it counts as spending again' : 'Entry removed'))} /></span>
        ) : null,
    },
  ];

  return (
    <Sheet size="lg" title={g ? <span className="row"><CatAvatar cat={{ emoji: g.emoji, color: g.color }} size="sm" /> {g.name} <StatusChip g={g} /></span> : ''} onClose={onClose}
      actions={g && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(true)}>Edit</Button>}
      footer={g ? (
        <>
          <Button icon={<ArrowUpRight />} onClick={() => setMoney('take')}>Take out</Button>
          <Button variant="primary" icon={<ArrowDownLeft />} onClick={() => setMoney('add')}>Add money</Button>
        </>
      ) : undefined}>
      {!g ? <div className="stack"><Skel h={60} /><Skel h={180} /><Skel h={120} /></div> : (
        <div className="stack">
          <StatGrid className="g-stats">
            <Stat label="Balance" value={money(g.balance, c0)} sub={g.target_amount ? `of ${money(g.target_amount, c0)} · ${Math.round((g.progress || 0) * 100)}%` : g.kind === 'bucket' ? 'In bucket' : undefined} />
            {g.kind === 'target' && <Stat label="Target date" value={g.target_date ? ETA(g.target_date) : '—'} sub={g.projected_date && g.status !== 'done' ? `On pace for ${ETA(g.projected_date)}` : undefined} />}
            <Stat label="Monthly" value={g.monthly_amount ? money(g.monthly_amount, c0) : '—'} sub={g.monthly_amount ? (g.auto_contribute ? 'Automatic' : 'Planned') : g.needed_monthly ? `Needs ${money(g.needed_monthly, c0)}` : undefined} tone={g.status === 'behind' ? 'bad' : undefined} />
            <Stat label="Added" value={money(g.added, c0)} />
            <Stat label="Spent from it" value={money(g.spent, c0)} />
          </StatGrid>
          {g.target_amount ? <Meter value={g.balance} max={g.target_amount} color={g.color} /> : null}
          <p className="muted">{goalSentence(g)}</p>
          {g.status === 'done' && !g.completed_at && (
            <Button icon={<Archive />} onClick={() => update.mutateAsync({ archived: true, completed: true }).then(() => { toast('Archived'); onClose(); })} style={{ alignSelf: 'flex-start' }}>
              Mark complete & archive
            </Button>
          )}

          <div className="cols-2 grid">
            <div>
              <div className="section-title">Balance by month</div>
              <div style={{ height: 180 }}><GoalChart data={g.history} color={g.color} target={g.target_amount} /></div>
            </div>
            <div>
              <div className="section-title">Where it's held <Button size="sm" variant="ghost" icon={<Link2 />} style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>Change</Button></div>
              <FundingBreakdown g={g} />
              {g.rules.length > 0 && (
                <>
                  <div className="section-title" style={{ marginTop: 14 }}>Funded automatically</div>
                  <div className="kv">
                    {g.rules.map((r) => (
                      <Link key={r.id} to="/settings/rules" viewTransition onClick={onClose}>
                        <Wand2 size={13} className="faint" />
                        <span className="grow ellipsis">{r.pattern ? `“${r.pattern}”` : 'Any transaction'}{r.account_label ? ` into ${r.account_label}` : ''}</span>
                        <span className="num pos">+{money(r.amount, c0)}</span>
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {activity.length > 0 && (
            <div>
              <div className="section-title">Activity <span className="faint num" style={{ fontWeight: 400 }}>{activity.length}</span></div>
              <div className="mini-table">
                <DataTable sticky={false} columns={activityCols} rows={activity} rowKey={(r) => r.key} />
              </div>
            </div>
          )}
        </div>
      )}
      {money_ && g && <MoneyModal g={g} mode={money_} onClose={() => setMoney(null)} />}
    </Sheet>
  );
}

export default function Goals() {
  const goals = useGoals();
  const wide = useWide(1440);
  const [filter, setFilter] = useState<'all' | 'target' | 'bucket'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState<null | Partial<(typeof TEMPLATES)[number]>>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = useMemo(() => goals.data?.goals || [], [goals.data]);
  const visible = useMemo(() => list.filter((g) => (showArchived ? g.archived : !g.archived) && (filter === 'all' || g.kind === filter)), [list, filter, showArchived]);
  const archived = list.filter((g) => g.archived).length;
  const t = goals.data?.totals;
  const active = list.filter((g) => !g.archived);
  const behind = active.filter((g) => g.status === 'behind' || g.status === 'overdue');
  const accounts = goals.data?.accounts || [];
  const split = wide && accounts.length > 0; // the funding rail sits beside the table

  // Deep link from elsewhere (e.g. the dashboard): /goals?open=ID
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('open');
    if (id) setOpen(Number(id));
  }, []);

  const columns: Column<Goal>[] = [
    {
      key: 'name', header: 'Name', wide: true, minWidth: 150, sort: (g) => g.name.toLowerCase(),
      cell: (g) => (
        <div className="cell">
          <CatAvatar cat={{ emoji: g.emoji, color: g.color }} size="sm" />
          <span className="ellipsis primary">{g.name}</span>
        </div>
      ),
      sub: (g) => <>{g.target_amount ? `${money(g.balance, c0)} of ${money(g.target_amount, c0)}` : g.kind === 'bucket' ? 'Bucket' : ''}{g.status === 'behind' && g.needed_monthly ? <span className="neg"> · needs {money(g.needed_monthly, c0)}/mo</span> : null}</>,
      footer: `${visible.length} ${filter === 'bucket' ? 'buckets' : filter === 'target' ? 'goals' : 'goals & buckets'}`,
    },
    { key: 'kind', header: 'Type', hide: 'xl', width: 80, sort: (g) => g.kind, cell: (g) => <span className="muted">{g.kind === 'bucket' ? 'Bucket' : 'Goal'}</span> },
    { key: 'status', header: 'Status', hide: 'sm', width: 110, sort: (g) => g.status, cell: (g) => (g.status === 'bucket' ? <span className="faint">—</span> : <StatusChip g={g} />) },
    { key: 'bal', header: 'Balance', num: true, width: 100, sort: (g) => g.balance, cell: (g) => <span style={{ fontWeight: 500 }}>{money(g.balance, c0)}</span>, footer: money(visible.reduce((s, g) => s + g.balance, 0), c0) },
    { key: 'target', header: 'Target', num: true, hide: 'sm', width: 100, sort: (g) => g.target_amount, cell: (g) => <span className="muted">{g.target_amount ? money(g.target_amount, c0) : '—'}</span> },
    {
      key: 'prog', header: 'Progress', hide: 'sm', width: 130, sort: (g) => g.progress,
      cell: (g) => (g.target_amount ? <Meter value={g.balance} max={g.target_amount} color={g.color} /> : <Sparkline data={g.history.map((h) => h.balance)} color={g.color} width={120} height={18} />),
    },
    {
      key: 'mo', header: 'Monthly', num: true, hide: 'md', width: 110, sort: (g) => g.needed_monthly ?? g.monthly_amount,
      cell: (g) =>
        g.status === 'behind' && g.needed_monthly ? <span className="neg" title={g.monthly_amount ? `Planned ${money(g.monthly_amount, c0)}` : undefined}>needs {money(g.needed_monthly, c0)}</span>
          : g.monthly_amount ? <span>{money(g.monthly_amount, c0)}{g.auto_contribute ? <span className="faint small"> auto</span> : null}</span> : <span className="faint">—</span>,
      footer: t?.monthly ? money(t.monthly, c0) : undefined,
    },
    {
      key: 'date', header: 'By / ETA', hide: 'md', width: 120, sort: (g) => g.target_date ?? g.projected_date,
      cell: (g) => (g.target_date ? <span className="num">{ETA(g.target_date)}{g.projected_date && g.status !== 'done' && g.projected_date.slice(0, 7) !== g.target_date.slice(0, 7) ? <span className="faint small"> → {ETA(g.projected_date)}</span> : null}</span>
        : g.projected_date && g.status !== 'done' ? <span className="faint num">~{ETA(g.projected_date)}</span> : <span className="faint">—</span>),
    },
    ...(split || !wide ? [] : [{
      key: 'src', header: 'Funded by', hide: 'lg' as const, width: 200, sort: (g: Goal) => g.sources[0]?.label ?? '',
      cell: (g: Goal) => <span className="faint ellipsis" style={{ display: 'block', maxWidth: 200 }}>{g.sources.length ? `${g.sources[0].label}${g.sources.length > 1 ? ` +${g.sources.length - 1}` : ''}` : Math.abs(g.entries_total) > 0 ? 'Set aside in Tally' : '—'}</span>,
    }]),
  ];

  const empty = !goals.isLoading && !active.length && !showArchived;

  return (
    <Page>
      <PageHeader
        title="Goals"
        sub="Savings targets, and buckets of money for bigger purchases"
        actions={<Button variant="primary" size="sm" icon={<Plus />} onClick={() => setCreating({ kind: filter === 'bucket' ? 'bucket' : 'target' })}>New</Button>}
        toolbar={!empty ? (
          <>
            <Segmented value={filter} onChange={setFilter} options={[
              { value: 'all', label: 'All' },
              { value: 'target', label: `Goals ${active.filter((g) => g.kind === 'target').length || ''}` },
              { value: 'bucket', label: `Buckets ${active.filter((g) => g.kind === 'bucket').length || ''}` },
            ]} />
            {archived > 0 && <button className={`chip ${showArchived ? 'on' : ''}`} onClick={() => setShowArchived((v) => !v)}><Archive /> Archived {archived}</button>}
          </>
        ) : undefined}
      />

      {empty ? (
        <Panel title="What are you saving for?" meta="Start from a template, or from scratch">
          <p className="muted" style={{ maxWidth: 640, marginBottom: 14 }}>
            Savings goals track progress toward an amount and date. Buckets hold money for bigger purchases: add to them over time, then pay for things from them without wrecking your monthly budget.
          </p>
          <div className="g-templates">
            {TEMPLATES.map((tp) => (
              <button key={tp.name} className="picker-option" style={vars({ '--c': tp.color })} onClick={() => setCreating(tp)}>
                <i className="sw" />
                <span className="e">{tp.emoji}</span>
                <span className="ellipsis">{tp.name}</span>
                <span className="x">{tp.kind === 'target' ? money(tp.target!, c0) : tp.monthly ? `${money(tp.monthly, c0)}/mo` : 'Bucket'}</span>
              </button>
            ))}
            <button className="picker-option" onClick={() => setCreating({})}><Plus size={13} /> <span>Blank goal</span></button>
          </div>
        </Panel>
      ) : (
        <>
          <StatGrid style={{ marginBottom: 'var(--gap)' }}>
            <Stat large label={`Saved across ${active.length} goal${active.length === 1 ? '' : 's'}`} value={money(t?.saved || 0, c0)} />
            <Stat label="Monthly plan" value={<>{money(t?.monthly || 0, c0)}<span className="unit">/mo</span></>} />
            <Stat label="In linked accounts" value={money(t?.from_accounts || 0, c0)} sub={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`} />
            <Stat label="Set aside in Tally" value={money(t?.set_aside || 0, c0)} sub="Not tied to an account" />
            <Stat label="Behind" value={behind.length} tone={behind.length ? 'bad' : undefined} sub={behind.length ? behind.map((g) => g.name).join(', ') : 'Everything on track'} />
          </StatGrid>

          <div className={split ? 'split' : 'stack'}>
            <Panel flush className="clip">
              <DataTable
                columns={columns}
                rows={visible}
                rowKey={(g) => g.id}
                onRowClick={(g) => setOpen(g.id)}
                loading={goals.isLoading}
                footer
                rowClass={(g) => g.status === 'done' && 'done'}
                empty={<Empty icon={showArchived ? <Archive /> : <Target />} title={showArchived ? 'Nothing archived' : 'Nothing here yet'} action={!showArchived && <Button size="sm" icon={<Plus />} onClick={() => setCreating({ kind: filter === 'bucket' ? 'bucket' : 'target' })}>New {filter === 'bucket' ? 'bucket' : 'goal'}</Button>} />}
              />
            </Panel>
            {accounts.length > 0 && (
              <div className={split ? 'rail' : undefined}>
                <Panel title="Accounts funding goals" meta="Click a segment to open its goal">
                  <AllocationList accounts={accounts} onOpenGoal={setOpen} />
                </Panel>
              </div>
            )}
          </div>
        </>
      )}

      {open != null && <GoalSheet id={open} onClose={() => setOpen(null)} />}
      {creating && <GoalEditor preset={creating} onClose={(id) => { setCreating(null); if (id) setOpen(id); }} />}
    </Page>
  );
}
