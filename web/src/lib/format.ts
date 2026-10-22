import type { RecurUnit } from './types';
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

export const money = (n: number | null | undefined, opts: { cents?: boolean; sign?: boolean } = {}) => {
  if (n == null || Number.isNaN(n)) return '—';
  const s = (opts.cents === false ? usd0 : usd).format(Math.abs(n));
  if (n < 0) return `−${s}`;
  return opts.sign && n > 0 ? `+${s}` : s;
};
export const moneyCompact = (n: number) => (Math.abs(n) >= 10000 ? compact.format(n) : usd0.format(n));

// Transaction amounts: Plaid convention (positive = spent). Show income as +$x, spending as $x.
export const txnAmount = (amount: number) => (amount < 0 ? `+${usd.format(-amount)}` : usd.format(amount));

export const pct = (n: number) => `${Math.round(n * 100)}%`;

const d = (iso: string) => new Date(iso + 'T12:00:00');
export const todayIso = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
export const dayLabel = (iso: string) => {
  const today = todayIso();
  const y = d(today);
  y.setDate(y.getDate() - 1);
  const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (iso === today) return 'Today';
  if (iso === yIso) return 'Yesterday';
  const dt = d(iso);
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(dt.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
export const shortDate = (iso: string) => d(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const monthLabel = (ym: string, long = true) => d(`${ym}-01`).toLocaleDateString('en-US', { month: long ? 'long' : 'short', year: 'numeric' });
export const monthShort = (ym: string) => d(`${ym}-01`).toLocaleDateString('en-US', { month: 'short' });
export const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};
export const thisMonth = () => todayIso().slice(0, 7);
export const daysUntil = (iso: string) => Math.round((d(iso).getTime() - d(todayIso()).getTime()) / 864e5);
export const relDays = (iso: string) => {
  const n = daysUntil(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
};
// Like relDays, but switches to months/years past ~6 weeks: "In 8 months", "2 years ago".
export const relDate = (iso: string) => {
  const n = daysUntil(iso);
  if (Math.abs(n) < 45) return relDays(iso);
  const mo = Math.round(Math.abs(n) / 30.44);
  const span = mo >= 24 ? `${Math.round(mo / 12)} years` : mo === 12 ? '1 year' : `${mo} months`;
  return n > 0 ? `In ${span}` : `${span} ago`;
};
// Today shifted by days/months/years, as YYYY-MM-DD (for date presets).
export const isoFromToday = ({ days = 0, months = 0, years = 0 }: { days?: number; months?: number; years?: number }) => {
  const t = new Date();
  const dt = new Date(t.getFullYear() + years, t.getMonth() + months, t.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
export const timeAgo =(ts: string | null) => {
  if (!ts) return 'never';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// Bank descriptors are often SHOUTING; make them readable without mangling normal names.
export const prettyName = (s: string) => {
  if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-/(&.])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\b(Ach|Pos|Ppd|Llc|Inc)\b/g, (m) => m.toUpperCase());
};

export const FREQ: Record<string, string> = {
  weekly: 'Weekly', biweekly: 'Every 2 weeks', fourweekly: 'Every 4 weeks', semimonthly: 'Twice a month', monthly: 'Monthly', quarterly: 'Quarterly',
  semiannual: 'Every 6 months', yearly: 'Yearly', biennial: 'Every 2 years',
};
const ordinal = (n: number) => (n >= 31 ? 'last day' : `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`);
export const UNIT_LABEL: Record<RecurUnit, [string, string]> = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };
type Sched = { every: number; unit: RecurUnit; month_days?: number[] | null };
// "Weekly", "Every 6 months", "Twice a month (1st & 15th)", "Every 2 years".
export function cadenceLabel(s: Sched) {
  const days = s.month_days ?? [];
  if (s.unit === 'month' && s.every === 1 && days.length === 2) return `Twice a month (${ordinal(days[0])} & ${ordinal(days[1])})`;
  const named = ({ '1day': 'Daily', '1week': 'Weekly', '1month': 'Monthly', '3month': 'Quarterly', '1year': 'Yearly' } as Record<string, string>)[`${s.every}${s.unit}`];
  return named ?? `Every ${s.every} ${UNIT_LABEL[s.unit][s.every === 1 ? 0 : 1]}`;
}
export const BUDGET_MODE_LABEL = { due: 'When it’s due', set_aside: 'Set aside monthly' } as const;
// Normalising amounts for display.
export type Per = 'week' | 'month' | 'year';
export const PER_FACTOR: Record<Per, number> = { week: 12 / 52, month: 1, year: 12 };
export const PER_SUFFIX: Record<Per, string> = { week: '/wk', month: '/mo', year: '/yr' };

export const ACCOUNT_GROUPS: { key: string; label: string; types: string[]; liability?: boolean }[] = [
  { key: 'cash', label: 'Cash', types: ['depository'] },
  { key: 'credit', label: 'Credit Cards', types: ['credit'], liability: true },
  { key: 'investment', label: 'Investments', types: ['investment', 'brokerage'] },
  { key: 'loan', label: 'Loans', types: ['loan'], liability: true },
  { key: 'other', label: 'Other', types: ['other'] },
];
export const isLiability = (type: string) => type === 'credit' || type === 'loan';
