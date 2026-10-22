// Recurring schedules and what they mean for a monthly budget.
// A schedule is "every N days | weeks | months | years" counted from anchor_date; month and year schedules may pin days
// of the month (month_days, 31 = last day). Dates are 'YYYY-MM-DD' strings; all maths is in UTC.
//
// Budget treatment per series (budget_mode, 'auto' resolves through the settings default):
//   due        the month's budget is the charges that land in it (a weekly bill is 4 or 5 charges).
//   set_aside  intervals longer than a month: a monthly share that fills a fund by the renewal. The share is
//              (amount − fund) / months left, so a series added mid-cycle catches up and a full cycle is amount / N.
//              Intervals of a month or less: the average month (amount × charges per month); the fund absorbs the
//              difference between 4- and 5-charge months.
const DAY = 864e5;
const ms = (d) => Date.parse(d + 'T00:00:00Z');
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const mIndex = (d) => +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1);
const monthStartOf = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
const onDay = (i, day) => {
  const y = Math.floor(i / 12), m = i % 12;
  return isoOf(Date.UTC(y, m, Math.min(day, dim(y, m))));
};
export const addDays = (d, n) => isoOf(ms(d) + n * DAY);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const UNITS = ['day', 'week', 'month', 'year'];
const daysOf = (s) => (s.month_days?.length ? [...new Set(s.month_days.map(Number))].sort((a, b) => a - b) : [+s.anchor_date.slice(8)]);

// Average days between charges, and charges per month.
export function intervalDays(s) {
  if (s.unit === 'day') return s.every;
  if (s.unit === 'week') return 7 * s.every;
  if (s.unit === 'month') return (30.44 * s.every) / daysOf(s).length;
  return 365.25 * s.every;
}
export function perMonth(s) {
  if (s.unit === 'day') return 30.4375 / s.every;
  if (s.unit === 'week') return 52 / 12 / s.every;
  if (s.unit === 'month') return daysOf(s).length / s.every;
  return 1 / (12 * s.every);
}
// Longer than a month: these default to "set aside".
export const isLong = (s) => intervalDays(s) > 31.5;

// Legacy frequency name (kept for older clients and the detection upsert).
export function frequencyName(s) {
  const k = `${s.every}${s.unit}${s.unit === 'month' ? daysOf(s).length : ''}`;
  return { '1week': 'weekly', '2week': 'biweekly', '4week': 'fourweekly', '1month2': 'semimonthly', '1month1': 'monthly', '3month1': 'quarterly',
    '6month1': 'semiannual', '1year': 'yearly', '2year': 'biennial' }[k] || 'custom';
}

// Grace around an expected charge: banks post a few days early or late.
export const tolerance = (s) => Math.min(7, Math.max(1, Math.round(intervalDays(s) / 4)));

// Charge dates in [from, to). Bounded by starts_on / ends_on. When the anchor is a known future charge (moved past the
// last payment), nothing is expected between the last payment and it.
export function occurrences(s, from, to) {
  if (!s.anchor_date) return [];
  const lo = s.starts_on && s.starts_on > from ? s.starts_on : from;
  const hi = s.ends_on && s.ends_on < to ? s.ends_on : to;
  if (lo >= hi) return [];
  const gapFrom = s.anchor_date > (s.last_date || '') ? (s.last_date ? addDays(s.last_date, tolerance(s) + 1) : '') : null;
  const keep = (x) => x >= lo && x < hi && !(gapFrom !== null && x >= gapFrom && x < s.anchor_date);
  const out = [];
  if (s.unit === 'day' || s.unit === 'week') {
    const step = (s.unit === 'week' ? 7 : 1) * s.every * DAY;
    const a = ms(s.anchor_date);
    for (let t = a + Math.ceil((ms(lo) - a) / step) * step; t < ms(hi); t += step) if (keep(isoOf(t))) out.push(isoOf(t));
  } else {
    const stepM = s.every * (s.unit === 'year' ? 12 : 1);
    const a = mIndex(s.anchor_date);
    const days = daysOf(s);
    const seen = new Set();
    for (let i = a + Math.ceil((mIndex(lo) - a) / stepM) * stepM; i <= mIndex(hi); i += stepM) {
      for (const d of days) {
        const x = onDay(i, d);
        if (keep(x) && !seen.has(x)) { seen.add(x); out.push(x); }
      }
    }
  }
  return out;
}

const span = (s) => Math.ceil(intervalDays(s) * 2) + 62;
export const nextOn = (s, date) => occurrences(s, date, addDays(date, span(s)))[0] ?? null;
export const prevBefore = (s, date) => occurrences(s, addDays(date, -span(s)), date).at(-1) ?? null;

// The next charge we're waiting for: after the last payment (with grace), else from today.
export function nextExpected(s, today) {
  if (s.last_date) return nextOn(s, addDays(s.last_date, tolerance(s) + 1));
  return nextOn(s, today);
}

export const myAmount = (s) => (Number(s.amount) * Number(s.share_pct ?? 100)) / 100;
export function effectiveMode(s, defaults) {
  if (s.budget_mode === 'due' || s.budget_mode === 'set_aside') return s.budget_mode;
  return isLong(s) ? defaults.long : defaults.short;
}
// When a set-aside fund starts filling: the first charge seen, or when you added the series (whichever is earlier).
const accrualStart = (s) => {
  const created = typeof s.created_at === 'string' ? s.created_at.slice(0, 10) : s.created_at ? isoOf(+new Date(s.created_at)) : null;
  return [s.starts_on, created].filter(Boolean).sort()[0] || s.anchor_date;
};

// One series in the month starting `start` (first of month): what the budget plans for it (`planned`), the charges that
// land in it (`due`, `dates`), and for set-aside series the fund on the 1st (`fund`), the cycle target and renewal date.
export function monthPlan(s, start, mode) {
  const i = mIndex(start);
  const end = monthStartOf(i + 1);
  const amt = myAmount(s);
  const dates = occurrences(s, start, end);
  const due = round(dates.length * amt);
  if (mode !== 'set_aside') return { planned: due, due, dates, fund: 0 };
  if (i < mIndex(accrualStart(s)) || (s.ends_on && s.ends_on <= start)) return { planned: 0, due, dates, fund: 0 };
  if (isLong(s)) {
    const next = nextOn(s, start);
    if (!next) return { planned: 0, due, dates, fund: 0 };
    const prev = prevBefore(s, start);
    const cycleStart = prev ? mIndex(prev) + 1 : mIndex(accrualStart(s));
    const n = Math.max(1, mIndex(next) - cycleStart + 1);
    const share = amt / n;
    return { planned: round(share), due, dates, fund: round(share * (i - cycleStart)), target: round(amt), renews: next };
  }
  // Short intervals, smoothed: the average month; the fund is what the averages have run ahead of (or behind) actual charges.
  const share = amt * perMonth(s);
  let fund = 0;
  for (let m = Math.max(mIndex(accrualStart(s)), i - 120); m < i; m++) fund += share - occurrences(s, monthStartOf(m), monthStartOf(m + 1)).length * amt;
  return { planned: round(share), due, dates, fund: round(fund), target: null, renews: nextOn(s, start) };
}
