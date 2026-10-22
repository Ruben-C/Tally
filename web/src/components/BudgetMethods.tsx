// Budget methods: one stored budget (a monthly amount per category), several ways of reading it.
//   category  — a limit per category (the default)
//   zero      — the same, plus "left to assign": expected income − budgets − goal saving, aiming for $0
//   flex      — fixed bills and non-monthly set-asides come off the top; everything flexible shares one number
//   percent   — 50/30/20 (or your own split) of expected income across needs, wants and savings
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useMutate } from '../lib/queries';
import { money, monthLabel, pct } from '../lib/format';
import type { BudgetKind, BudgetMethod, Budgets, Bucket } from '../lib/types';
import { Badge, Button, Field, Meter, MoneyInput, PercentInput, Segmented, Sheet, Stat, StatGrid, useToast } from './ui';

const cents0 = { cents: false } as const;

export const METHOD_OPTIONS: { value: BudgetMethod; label: string }[] = [
  { value: 'category', label: 'Category' },
  { value: 'zero', label: 'Zero-based' },
  { value: 'flex', label: 'Flex' },
  { value: 'percent', label: '50/30/20' },
];
export const METHOD_SUB: Record<BudgetMethod, string> = {
  category: 'Monthly targets per category',
  zero: 'Give every dollar of income a job',
  flex: 'Fixed bills off the top, one number for the rest',
  percent: 'Needs, wants and savings as shares of income',
};
export const KIND_LABEL: Record<BudgetKind, string> = { fixed: 'Fixed', flexible: 'Flexible', non_monthly: 'Non-monthly' };
export const KIND_HINT: Record<BudgetKind, string> = {
  fixed: 'Bills that cost about the same every month.',
  flexible: 'Day-to-day spending that shares the flex number.',
  non_monthly: 'Irregular costs: set aside a monthly share that rolls over until you spend it.',
};
export const BUCKET_LABEL: Record<Bucket, string> = { need: 'Needs', want: 'Wants', savings: 'Savings' };
export const BUCKET_HINT: Record<Bucket, string> = {
  need: 'Things you must pay: housing, groceries, bills, minimum debt payments.',
  want: 'Things you could cut: eating out, entertainment, shopping, travel.',
  savings: 'Spending that builds your future, like extra debt payments.',
};

export function useSetMethod() {
  const toast = useToast();
  const m = useMutate((b: { method?: BudgetMethod; ratios?: Record<Bucket, number> }) => api('/budget-method', { method: 'PUT', body: b }));
  return (b: { method?: BudgetMethod; ratios?: Record<Bucket, number> }) =>
    m.mutateAsync(b).catch((e: Error) => toast(e.message || 'Could not save', { kind: 'error' }));
}

// Meter on its own line above the caption (Stat's sub is inline text otherwise).
const BucketSub = ({ meter, children }: { meter: ReactNode; children: ReactNode }) => (
  <span className="bucket-sub">{meter}<span>{children}</span></span>
);

// Summary row for the chosen method. `onPlan` opens the plan sheet (income, flex number, ratios).
export function MethodStats({ d, onPlan }: { d: Budgets | undefined; onPlan: () => void }) {
  if (!d) return <StatGrid style={{ marginBottom: 'var(--gap)' }}>{[0, 1, 2, 3].map((i) => <Stat key={i} label="" value="—" />)}</StatGrid>;
  const p = d.plan;
  const t = d.totals;
  const pace = d.elapsed > 0 && d.elapsed < 1 ? d.elapsed : null;
  const incomeStat = (
    <Stat label="Expected income" value={money(p.income.expected, cents0)} onClick={onPlan} title="Change expected income"
      sub={p.income.set != null ? `Set by you · ${money(p.income.actual, cents0)} so far` : `3-month average · ${money(p.income.actual, cents0)} so far`} />
  );

  if (d.method === 'zero') {
    const u = p.unassigned;
    const left = t.budgeted + t.carried - t.budgetedSpent;
    return (
      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat large label={u >= 0 ? 'Left to assign' : 'Over-assigned'} value={money(Math.abs(u), cents0)} tone={u < 0 ? 'bad' : undefined}
          sub={u === 0 ? <Badge tone="good">Every dollar has a job</Badge> : u > 0 ? 'Give it to a category or a goal' : 'Budgets and goal saving exceed income'} />
        {incomeStat}
        <Stat label="Budgeted" value={money(t.budgeted, cents0)} sub={`${d.categories.filter((c) => c.budget != null).length} categories`} />
        <Stat label="Goal saving" value={money(p.saving, cents0)} to="/goals" sub="Monthly goal contributions" />
        <Stat label={left >= 0 ? 'Left in budgets' : 'Over budgets'} value={money(Math.abs(left), cents0)} tone={left < 0 ? 'bad' : undefined}
          sub={`${money(t.budgetedSpent, cents0)} spent`} />
        <Stat label="Not budgeted" value={money(t.spent - t.budgetedSpent, cents0)} sub="Spent outside any budget" />
      </StatGrid>
    );
  }

  if (d.method === 'flex') {
    const f = p.flex;
    const left = f.budget - f.spent;
    const k = p.kinds;
    const ahead = pace != null && f.budget > 0 ? f.spent / f.budget > pace + 0.05 : null;
    return (
      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        <Stat large label={left >= 0 ? 'Flex left' : 'Flex over'} value={money(Math.abs(left), cents0)} tone={left < 0 ? 'bad' : undefined}
          sub={<>{money(f.spent, cents0)} of {money(f.budget, cents0)}{ahead != null && <Badge tone={ahead ? 'bad' : 'good'}>{ahead ? 'Ahead of pace' : 'On pace'}</Badge>}</>} />
        <Stat label="Flex budget" value={money(f.budget, cents0)} onClick={onPlan} title="Change the flex number"
          sub={f.set != null ? `Set by you · ${money(f.auto, cents0)} left over` : 'What income leaves after the rest'} />
        {incomeStat}
        <Stat label="Fixed" value={money(k.fixed.planned, cents0)} title={k.fixed.recurring ? 'Includes recurring bills in flexible categories' : undefined}
          sub={`${money(k.fixed.spent, cents0)} paid so far${k.fixed.recurring ? ` · ${money(k.fixed.recurring, cents0)} recurring` : ''}`} />
        {/* Goals can do the same job; the stat only shows while some category is non-monthly. */}
        {d.categories.some((c) => c.budget_kind === 'non_monthly') && (
          <Stat label="Non-monthly" value={money(k.non_monthly.planned, cents0)} sub={`${money(k.non_monthly.available, cents0)} set aside`} />
        )}
        <Stat label="Goal saving" value={money(p.saving, cents0)} to="/goals" sub="Monthly goal contributions" />
      </StatGrid>
    );
  }

  if (d.method === 'percent') {
    const inc = p.income.expected;
    const b = p.buckets;
    const bucketStat = (k: 'need' | 'want') => (
      <Stat key={k} label={`${BUCKET_LABEL[k]} · ${d.ratios[k]}%`} value={money(b[k].spent, cents0)} tone={b[k].spent > b[k].target ? 'bad' : undefined}
        sub={<BucketSub meter={<Meter value={b[k].spent} max={b[k].target} pace={pace} />}>{inc > 0 ? pct(b[k].spent / inc) : '—'} of income · target {money(b[k].target, cents0)}</BucketSub>} />
    );
    // Savings: income that didn't go to spending, plus spending in categories marked as savings. A finished month uses
    // the income that arrived; the current one can't (paychecks are still coming), so it shows the room left to save:
    // expected income minus what's been spent so far.
    const done = d.elapsed >= 1;
    const saved = (done ? p.saved : inc - d.totals.spent) + b.savings.spent;
    return (
      <StatGrid style={{ marginBottom: 'var(--gap)' }}>
        {incomeStat}
        {bucketStat('need')}
        {bucketStat('want')}
        <Stat label={`${done ? 'Saved' : 'Room to save'} · ${d.ratios.savings}%`} value={money(saved, cents0)} tone={saved < b.savings.target ? 'bad' : undefined}
          sub={<BucketSub meter={<Meter value={Math.min(Math.max(saved, 0), b.savings.target)} max={b.savings.target} />}>{done ? `${p.income.actual > 0 ? pct(saved / p.income.actual) : '—'} of income` : 'Income left after spending so far'} · target {money(b.savings.target, cents0)}</BucketSub>} />
        <Stat label="Split" value={`${d.ratios.need}/${d.ratios.want}/${d.ratios.savings}`} onClick={onPlan} title="Change the split"
          sub={p.unsorted > 0 ? <Badge tone="warn">{p.unsorted} categories not sorted</Badge> : 'Every category sorted'} />
      </StatGrid>
    );
  }

  // Rollover and set-aside funds are money the budgets can spend too (the table's Remaining column counts them).
  const cap = t.budgeted + t.carried;
  const left = cap - t.budgetedSpent;
  const ahead = pace != null && cap > 0 ? t.budgetedSpent / cap > pace + 0.05 : null;
  return (
    <StatGrid style={{ marginBottom: 'var(--gap)' }}>
      <Stat large label={left >= 0 ? 'Left to spend' : 'Over budget'} value={money(Math.abs(left), cents0)} tone={left < 0 ? 'bad' : undefined}
        sub={<>{pct(cap > 0 ? t.budgetedSpent / cap : 0)} used{ahead != null && <Badge tone={ahead ? 'bad' : 'good'}>{ahead ? 'Ahead of pace' : 'On pace'}</Badge>}</>} />
      <Stat label="Budgeted" value={money(t.budgeted, cents0)}
        sub={`${d.categories.filter((c) => c.budget != null).length} categories${t.carried ? ` · ${money(t.carried, { sign: true, cents: false })} carried in` : ''}`} />
      <Stat label="Spent in budgets" value={money(t.budgetedSpent, cents0)} sub={pace != null ? `${pct(d.elapsed)} of the month gone` : undefined} />
      <Stat label="Not budgeted" value={money(t.spent - t.budgetedSpent, cents0)} sub="Spent outside any budget" />
      <Stat label="Total spent" value={money(t.spent, cents0)} />
      <Stat label="Income" value={money(t.income, cents0)} tone="good" sub={t.income > 0 ? `${money(t.income - t.spent, { sign: true, cents: false })} net` : undefined} />
    </StatGrid>
  );
}

// Month-level settings: expected income, the flex number, the 50/30/20 split.
export function PlanSheet({ d, onClose }: { d: Budgets; onClose: () => void }) {
  const toast = useToast();
  const setMethod = useSetMethod();
  const savePlan = useMutate((b: { field: 'income' | 'flex'; amount: number | null }) => api('/budget-plan', { method: 'PUT', body: { ...b, month: d.month } }));
  const p = d.plan;
  const [income, setIncome] = useState(p.income.set != null ? String(p.income.set) : '');
  const [flex, setFlex] = useState(p.flex.set != null ? String(p.flex.set) : '');
  const [ratios, setRatios] = useState({ need: String(d.ratios.need), want: String(d.ratios.want), savings: String(d.ratios.savings) });
  const sum = Number(ratios.need || 0) + Number(ratios.want || 0) + Number(ratios.savings || 0);
  const from = `Applies to ${monthLabel(d.month)} and every month after until you change it.`;

  const save = async (field: 'income' | 'flex', raw: string) => {
    const amount = raw.trim() === '' ? null : Number(raw);
    await savePlan.mutateAsync({ field, amount });
    toast(amount == null ? `${field === 'income' ? 'Expected income' : 'Flex number'} is automatic again` : `${field === 'income' ? 'Expected income' : 'Flex number'}: ${money(amount, cents0)}/month`);
  };

  return (
    <Sheet title="Budget plan" onClose={onClose}>
      <div className="stack">
        <Field label="Expected monthly income" hint={<>{from} Leave empty to use the 3-month average ({money(p.income.average, cents0)}).</>}>
          <div className="row">
            <MoneyInput className="grow" value={income} onChange={setIncome} placeholder={`Auto · ${money(p.income.average, cents0)}`} suffix="/mo" step={100} />
            <Button variant="primary" onClick={() => save('income', income)} disabled={income === (p.income.set != null ? String(p.income.set) : '')}>Save</Button>
          </div>
        </Field>

        <Field label="Flex number" hint={<>Used by the Flex method. Leave empty for whatever is left: income − fixed − non-monthly − goal saving ({money(p.flex.auto, cents0)}).</>}>
          <div className="row">
            <MoneyInput className="grow" value={flex} onChange={setFlex} placeholder={`Auto · ${money(p.flex.auto, cents0)}`} suffix="/mo" step={50} />
            <Button variant="primary" onClick={() => save('flex', flex)} disabled={flex === (p.flex.set != null ? String(p.flex.set) : '')}>Save</Button>
          </div>
        </Field>

        <Field as="div" label="Split of income" error={sum !== 100 ? `Adds up to ${sum}%, needs 100%` : undefined}
          hint="Used by the 50/30/20 method. Common variants: 50/30/20, 70/20/10, 60/20/20.">
          <div className="row">
            {(['need', 'want', 'savings'] as const).map((k) => (
              <label key={k} className="grow stack" style={{ gap: 4 }}>
                <span className="faint small">{BUCKET_LABEL[k]}</span>
                <PercentInput value={ratios[k]} onChange={(v) => setRatios((r) => ({ ...r, [k]: v }))} invalid={sum !== 100} aria-label={`${BUCKET_LABEL[k]} percent`} />
              </label>
            ))}
          </div>
          <div className="chips" style={{ marginTop: 8 }}>
            {[[50, 30, 20], [70, 20, 10], [60, 20, 20], [80, 0, 20]].map(([n, w, s]) => (
              <button key={`${n}${w}${s}`} type="button" className="chip" onClick={() => setRatios({ need: String(n), want: String(w), savings: String(s) })}>{w ? `${n}/${w}/${s}` : `${n}/${s}`}</button>
            ))}
            <Button size="sm" variant="primary" style={{ marginLeft: 'auto' }} disabled={sum !== 100 || (Number(ratios.need) === d.ratios.need && Number(ratios.want) === d.ratios.want)}
              onClick={() => setMethod({ ratios: { need: Number(ratios.need), want: Number(ratios.want), savings: Number(ratios.savings) } }).then(() => toast('Split saved'))}>
              Save split
            </Button>
          </div>
        </Field>
      </div>
    </Sheet>
  );
}

export function KindPicker({ value, onChange }: { value: BudgetKind; onChange: (v: BudgetKind) => void }) {
  return <Segmented size="sm" value={value} onChange={onChange} options={(['fixed', 'flexible', 'non_monthly'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />;
}
export function BucketPicker({ value, onChange }: { value: Bucket | null; onChange: (v: Bucket) => void }) {
  return <Segmented<Bucket | ''> size="sm" value={value ?? ''} onChange={(v) => v && onChange(v)} options={(['need', 'want', 'savings'] as const).map((k) => ({ value: k, label: BUCKET_LABEL[k] }))} />;
}
