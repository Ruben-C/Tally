// Add or edit a recurring series: amount, schedule (every N days/weeks/months/years, optional days of the month),
// next charge, end date, category, your share, and how the budget counts it.
import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useCategories, useMutate, useRecurringDefaults } from '../lib/queries';
import { BUDGET_MODE_LABEL, cadenceLabel, isoFromToday, money, shortDate, todayIso, UNIT_LABEL } from '../lib/format';
import type { Recurring, RecurMode, RecurUnit, Txn } from '../lib/types';
import { Button, CatLabel, DateInput, Field, Input, Modal, MoneyInput, PercentInput, PickerButton, Segmented, Select, Sheet, useIsPhone, useToast } from './ui';
import { CategoryPicker } from './TxnSheet';

const c0 = { cents: false } as const;
const MAX_EVERY: Record<RecurUnit, number> = { day: 400, week: 104, month: 60, year: 10 };

// Same maths as server/src/schedule.js: average days between charges, charges per month.
const intervalDays = (every: number, unit: RecurUnit, perMonthDays: number) =>
  unit === 'day' ? every : unit === 'week' ? 7 * every : unit === 'month' ? (30.44 * every) / perMonthDays : 365.25 * every;
const perMonth = (every: number, unit: RecurUnit, perMonthDays: number) =>
  unit === 'day' ? 30.4375 / every : unit === 'week' ? 52 / 12 / every : unit === 'month' ? perMonthDays / every : 1 / (12 * every);

const PRESETS: { label: string; every: number; unit: RecurUnit; twice?: boolean }[] = [
  { label: 'Weekly', every: 1, unit: 'week' },
  { label: '2 weeks', every: 2, unit: 'week' },
  { label: 'Twice a month', every: 1, unit: 'month', twice: true },
  { label: 'Monthly', every: 1, unit: 'month' },
  { label: 'Quarterly', every: 3, unit: 'month' },
  { label: '6 months', every: 6, unit: 'month' },
  { label: 'Yearly', every: 1, unit: 'year' },
];

export default function RecurringForm({ series, fromTxn, onClose }: { series?: Recurring; fromTxn?: Txn; onClose: (id?: number) => void }) {
  const toast = useToast();
  const { byId } = useCategories();
  const defaults = useRecurringDefaults();
  const r = series;
  const [name, setName] = useState(r?.name ?? fromTxn?.label ?? '');
  const [kind, setKind] = useState<'expense' | 'income'>(r?.kind ?? (fromTxn && fromTxn.amount < 0 ? 'income' : 'expense'));
  const [amount, setAmount] = useState(String(r?.amount ?? (fromTxn ? Math.abs(fromTxn.amount) : '')));
  const [amountMode, setAmountMode] = useState<'fixed' | 'estimate'>(r?.amount_mode ?? 'fixed');
  const phone = useIsPhone();
  const [every, setEvery] = useState(String(r?.every ?? 1));
  const [unit, setUnit] = useState<RecurUnit>(r?.unit ?? (fromTxn ? 'year' : 'month'));
  const [twice, setTwice] = useState((r?.month_days?.length ?? 0) === 2);
  const [days, setDays] = useState<[string, string]>([String(r?.month_days?.[0] ?? 1), String(r?.month_days?.[1] ?? 15)]);
  // A new series from a payment: its next charge is one cycle after it (yearly by default, the usual reason to add one by hand).
  const [next, setNext] = useState(r ? (r.next_date ?? r.anchor_date) : fromTxn ? '' : isoFromToday({ months: 1 }));
  const [ends, setEnds] = useState(r?.ends_on ?? '');
  const [categoryId, setCategoryId] = useState<number | null>(r?.category_id ?? fromTxn?.category_id ?? null);
  const [share, setShare] = useState(String(r?.share_pct ?? 100));
  const [budgetMode, setBudgetMode] = useState<'auto' | RecurMode>(r?.budget_mode ?? 'auto');
  const [picking, setPicking] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const n = Math.max(1, Math.floor(Number(every) || 1));
  const monthDays = unit === 'month' && n === 1 && twice ? [Number(days[0]), Number(days[1])] : null;
  const perMonthDays = monthDays ? 2 : 1;
  const long = intervalDays(n, unit, perMonthDays) > 31.5;
  const resolved: RecurMode = budgetMode === 'auto' ? (defaults.data ? (long ? defaults.data.long : defaults.data.short) : long ? 'set_aside' : 'due') : budgetMode;
  const amt = Number(amount) || 0;
  const mine = (amt * (Number(share) || 100)) / 100;
  const mo = mine * perMonth(n, unit, perMonthDays);
  // From a payment with no next date picked: one cycle after that payment.
  const nextFromTxn = useMemo(() => {
    if (!fromTxn) return '';
    const d = new Date(fromTxn.date + 'T12:00');
    if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'week') d.setDate(d.getDate() + 7 * n);
    else if (unit === 'month') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return d.toISOString().slice(0, 10);
  }, [fromTxn, n, unit]);
  const nextDate = next || nextFromTxn;

  const daysOk = !monthDays || monthDays.every((x) => Number.isInteger(x) && x >= 1 && x <= 31);
  const valid = name.trim() && amt > 0 && n >= 1 && n <= MAX_EVERY[unit] && daysOk && nextDate && Number(share) > 0 && Number(share) <= 100;

  const save = useMutate(() => {
    const body = {
      name: name.trim(), kind, amount: amt, amount_mode: amountMode, every: n, unit, month_days: monthDays, ends_on: ends || null,
      category_id: categoryId, share_pct: Number(share) || 100, budget_mode: budgetMode,
    };
    if (r) return api<Recurring>(`/recurring/${r.id}`, { method: 'PATCH', body: { ...body, next_date: nextDate } });
    // From a payment the schedule is anchored on that payment (it links its history); else on the next charge.
    return api<Recurring>('/recurring', { body: { ...body, anchor_date: fromTxn && !next ? fromTxn.date : nextDate, from_transaction_id: fromTxn?.id } });
  });
  const del = useMutate(() => api(`/recurring/${r!.id}`, { method: 'DELETE' }));

  if (picking)
    return (
      <Sheet title="Choose category" onClose={() => setPicking(false)} size="lg">
        <CategoryPicker value={categoryId} kinds={[kind]} onPick={(c) => { setCategoryId(c.id); setPicking(false); }} />
      </Sheet>
    );

  // A long-interval series with no payment yet fills its first fund in the months left before the first charge.
  const monthIdx = (iso: string) => +iso.slice(0, 4) * 12 + +iso.slice(5, 7);
  const monthsLeft = nextDate ? monthIdx(nextDate) - monthIdx(todayIso()) + 1 : 0;
  const cycleMonths = Math.round(intervalDays(n, unit, perMonthDays) / 30.44);
  const catchUp = long && resolved === 'set_aside' && !fromTxn && !r?.last_date && monthsLeft >= 1 && monthsLeft < cycleMonths ? mine / monthsLeft : null;
  const treatHint = catchUp != null
    ? `Sets aside ${money(catchUp)}/mo until the first charge on ${shortDate(nextDate)} so the fund is full, then about ${money(mo)}/mo.`
    : resolved === 'due'
    ? long ? `Budgets the full ${money(mine, c0)} in the month it’s charged.` : `Budgets each charge in the month it lands (${unit === 'week' ? '4 or 5 a month' : 'as scheduled'}).`
    : long ? `Budgets about ${money(mo)}/mo and builds a fund for the ${money(mine, c0)} renewal, so that month isn’t overspent.`
    : `Budgets the average month (${money(mo)}); the difference between short and long months evens out.`;

  return (
    <Sheet size="lg" title={r ? `Edit ${r.name}` : fromTxn ? 'Make recurring' : 'New recurring'} onClose={() => onClose()}
      footer={
        <>
          {r?.source === 'manual' && <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmDel(true)} style={{ marginRight: 'auto' }}>Delete</Button>}
          <Button variant="ghost" onClick={() => onClose()}>Cancel</Button>
          <Button variant="primary" disabled={!valid || save.isPending}
            onClick={() => save.mutateAsync(undefined).then((x) => { toast(r ? `${name} updated` : `${name} added`); onClose(x.id); }).catch((e: Error) => toast(e.message, { kind: 'error' }))}>
            {r ? 'Save changes' : 'Add'}
          </Button>
        </>
      }>
      <div className="form-grid">
        {!r && !fromTxn && (
          <Field as="div" label="Type" full>
            <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Bill or subscription' }, { value: 'income', label: 'Income' }]} />
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amazon Prime" autoFocus={!r} />
        </Field>
        <Field label="Amount" hint={amountMode === 'estimate' ? 'Updated to the average of the last 3 payments.' : r?.suggested_amount != null ? `Last payment was ${money(r.suggested_amount)}.` : undefined}>
          <div className="row">
            <MoneyInput className="grow" value={amount} onChange={setAmount} placeholder="0.00" step={1} />
            <Segmented size="sm" value={amountMode} onChange={setAmountMode} options={[{ value: 'fixed', label: 'Fixed' }, { value: 'estimate', label: 'Varies' }]} />
          </div>
        </Field>

        <Field as="div" label="Repeats" full hint={cadenceLabel({ every: n, unit, month_days: monthDays })}>
          <div className="row wrap">
            <span className="muted">Every</span>
            <Input sm style={{ width: 72 }} type="number" min={1} max={MAX_EVERY[unit]} value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Every" invalid={n > MAX_EVERY[unit]} />
            <Select sm auto value={unit} onChange={(e) => setUnit(e.target.value as RecurUnit)} aria-label="Unit">
              {(['day', 'week', 'month', 'year'] as const).map((u) => <option key={u} value={u}>{UNIT_LABEL[u][n === 1 ? 0 : 1]}</option>)}
            </Select>
            {unit === 'month' && n === 1 && (
              <Segmented size="sm" value={twice ? 'twice' : 'once'} onChange={(v) => setTwice(v === 'twice')} options={[{ value: 'once', label: 'Once' }, { value: 'twice', label: 'Twice' }]} />
            )}
            {monthDays && (
              <>
                <span className="muted">on the</span>
                <Input sm style={{ width: 64 }} type="number" min={1} max={31} value={days[0]} onChange={(e) => setDays([e.target.value, days[1]])} aria-label="First day of the month" invalid={!daysOk} />
                <span className="muted">and</span>
                <Input sm style={{ width: 64 }} type="number" min={1} max={31} value={days[1]} onChange={(e) => setDays([days[0], e.target.value])} aria-label="Second day of the month" invalid={!daysOk} />
              </>
            )}
          </div>
          <div className="chips" style={{ marginTop: 6 }}>
            {PRESETS.map((p) => {
              const on = n === p.every && unit === p.unit && (p.unit !== 'month' || n !== 1 || !!p.twice === twice);
              return <button key={p.label} type="button" className={`chip sm ${on ? 'on' : ''}`} onClick={() => { setEvery(String(p.every)); setUnit(p.unit); setTwice(!!p.twice); }}>{p.label}</button>;
            })}
          </div>
        </Field>

        <Field label="Next charge" hint={monthDays ? 'Charges then follow the days above.' : unit === 'month' || unit === 'year' ? 'Later charges land on the same day of the month.' : undefined}>
          <DateInput value={nextDate} onChange={setNext} aria-label="Next charge" />
        </Field>
        <Field label="Ends (optional)" hint="Cancelled? Nothing is expected or budgeted from this date.">
          <DateInput value={ends} onChange={setEnds} clearable aria-label="Ends on" presets={[{ label: 'Today', value: todayIso() }]} />
        </Field>
        <Field as="div" label="Category">
          <PickerButton placeholder="Choose a category" onClick={() => setPicking(true)} onClear={categoryId ? () => setCategoryId(null) : undefined}>
            {categoryId ? <CatLabel cat={byId.get(categoryId)} /> : null}
          </PickerButton>
        </Field>
        <Field label="Your share" hint={Number(share) < 100 ? `Budgets ${money(mine)} of ${money(amt)}. Categorise repayments to the same category.` : 'Lower it for a shared plan you’re paid back for.'}>
          <PercentInput value={share} onChange={setShare} aria-label="Your share" invalid={!(Number(share) > 0 && Number(share) <= 100)} />
        </Field>

        {kind === 'expense' && (
          <Field as="div" label="In the budget" full hint={treatHint}>
            <Segmented value={budgetMode} onChange={setBudgetMode} options={[
              { value: 'auto', label: phone ? 'Default' : `Default · ${BUDGET_MODE_LABEL[defaults.data ? (long ? defaults.data.long : defaults.data.short) : long ? 'set_aside' : 'due'].toLowerCase()}` },
              { value: 'due', label: BUDGET_MODE_LABEL.due },
              { value: 'set_aside', label: BUDGET_MODE_LABEL.set_aside },
            ]} />
          </Field>
        )}

        {amt > 0 && (
          <div className="g-total full">
            <span className="muted">{cadenceLabel({ every: n, unit, month_days: monthDays })}{nextDate ? ` · next ${shortDate(nextDate)}` : ''}</span>
            <span className="num strong">{money(mo)}<span className="faint" style={{ fontWeight: 400 }}>/mo · {money(mo * 12, c0)}/yr</span></span>
          </div>
        )}
      </div>
      {confirmDel && r && (
        <Modal onClose={() => setConfirmDel(false)}>
          <h2 style={{ marginBottom: 8 }}>Delete {r.name}?</h2>
          <p className="muted">It stops counting toward budgets and upcoming bills. Its payments stay in your transactions.</p>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => del.mutateAsync(undefined).then(() => { toast(`${r.name} deleted`); onClose(); })}>Delete</Button>
          </div>
        </Modal>
      )}
    </Sheet>
  );
}
