// Finds subscriptions, bills and paychecks: the same merchant at a steady cadence for a similar amount.
// Works on any data (Plaid or demo) and links transactions to their series. Series you've edited (user_edited) or added
// yourself keep their amount and schedule: detection only moves their dates and suggests a new price when it changes.
import { q, tx } from './db.js';
import { merchantKey } from './categorize.js';
import { frequencyName, intervalDays, nextExpected } from './schedule.js';

const CADENCES = [
  { frequency: 'weekly', days: 7, tol: 2, every: 1, unit: 'week' },
  { frequency: 'biweekly', days: 14, tol: 3, every: 2, unit: 'week' },
  { frequency: 'fourweekly', days: 28, tol: 1, every: 4, unit: 'week' },
  { frequency: 'monthly', days: 30, tol: 5, every: 1, unit: 'month' },
  { frequency: 'quarterly', days: 91, tol: 10, every: 3, unit: 'month' },
  { frequency: 'semiannual', days: 182, tol: 15, every: 6, unit: 'month' },
  { frequency: 'yearly', days: 365, tol: 20, every: 1, unit: 'year' },
  { frequency: 'biennial', days: 730, tol: 30, every: 2, unit: 'year' },
];
const LOOKBACK_DAYS = 800; // two yearly charges, or a two-yearly one

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const today = () => new Date().toISOString().slice(0, 10);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dom = (d) => +d.slice(8, 10);
// The day of the month a bill usually lands on (posting shifts it a day or two around weekends).
const usualDay = (occ) => {
  const counts = new Map();
  for (const t of occ.slice(-6)) counts.set(dom(t.date), (counts.get(dom(t.date)) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
};
// Twice a month (e.g. the 1st and 15th) vs every two weeks: twice-monthly charges keep returning to two days of the month.
function semimonthlyDays(occ) {
  const days = occ.map((t) => dom(t.date));
  const counts = new Map();
  for (const d of days) counts.set(d, (counts.get(d) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  const centres = [];
  for (const d of top) if (centres.every((c) => Math.abs(c - d) > 6)) centres.push(d);
  if (centres.length < 2) return null;
  const pair = centres.slice(0, 2).sort((a, b) => a - b);
  const near = days.filter((d) => pair.some((c) => Math.abs(c - d) <= 3)).length / days.length;
  return near >= 0.8 && occ.length >= 4 ? pair : null;
}

// Transactions grouped by kind + merchant, same-day duplicates (split charges) collapsed into one occurrence.
export function groupByMerchant(txns) {
  const groups = new Map();
  for (const t of txns) {
    const k = merchantKey(t);
    if (!k) continue;
    const key = `${t.amount < 0 ? 'income' : 'expense'}:${k}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const out = new Map();
  for (const [key, list] of groups) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const occ = [];
    for (const t of list) {
      const last = occ[occ.length - 1];
      if (last && last.date === t.date) last.amount += t.amount;
      else occ.push({ ...t });
    }
    out.set(key, { occ, ids: list.map((t) => t.id) });
  }
  return out;
}

export function detect(groups, now = today()) {
  const found = [];
  for (const [key, { occ, ids }] of groups) {
    if (occ.length < 2) continue;
    const gaps = occ.slice(1).map((t, i) => daysBetween(occ[i].date, t.date));
    const g = median(gaps);
    let cad = CADENCES.find((c) => Math.abs(g - c.days) <= c.tol);
    let monthDays = null;
    if (g >= 12 && g <= 18) {
      const pair = semimonthlyDays(occ);
      if (pair) { cad = { frequency: 'semimonthly', days: 15, tol: 4, every: 1, unit: 'month' }; monthDays = pair; }
    }
    if (!cad) continue;
    const minOcc = cad.days >= 91 ? 2 : 3;
    if (occ.length < minOcc) continue;
    const regular = gaps.filter((x) => Math.abs(x - cad.days) <= cad.tol * 2).length / gaps.length;
    if (regular < 0.7) continue;
    const recent = occ.slice(-4).map((t) => Math.abs(t.amount));
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const spread = Math.max(...recent) - Math.min(...recent);
    if (avg < 1 || spread / avg > 0.35) continue;
    const last = occ[occ.length - 1];
    // A cadence that has clearly lapsed (missed two cycles) is no longer recurring.
    if (daysBetween(last.date, now) > cad.days * 2 + cad.tol) continue;
    if (cad.unit === 'month' || cad.unit === 'year') monthDays ??= [usualDay(occ)];
    found.push({
      merchant_key: key,
      kind: key.startsWith('income:') ? 'income' : 'expense',
      name: last.display_name || last.merchant_name || last.name,
      category_id: last.category_id,
      account_id: last.account_id,
      every: cad.every,
      unit: cad.unit,
      month_days: monthDays,
      amount: Math.round(Math.abs(last.amount) * 100) / 100,
      recent_avg: Math.round(avg * 100) / 100,
      first_date: occ[0].date,
      last_date: last.date,
      logo_url: last.logo_url,
      ids,
    });
  }
  return found;
}

const SERIES_COLS = 'id, merchant_key, kind, status, user_edited, source, amount, amount_mode, every, unit, month_days, anchor_date, starts_on, ends_on, last_date, next_date, dismissed_amount, created_at';

// After any change to a series or its payments: re-derive next_date and the legacy frequency fields.
export async function settle(t, ids) {
  const rows = await t.q(`select ${SERIES_COLS} from recurring ${ids ? 'where id = any($1::int[])' : ''}`, ids ? [ids] : []);
  const now = today();
  for (const s of rows) {
    const next = nextExpected(s, now);
    await t.q(
      `update recurring set next_date = $2, frequency = $3, interval_days = $4
        where id = $1 and (next_date is distinct from $2 or frequency is distinct from $3 or interval_days is distinct from $4)`,
      [s.id, next, frequencyName(s), Math.round(intervalDays(s))],
    );
  }
}

// Payments seen for a series you own: dates move, the price is only suggested (or averaged, for estimated bills).
async function trackLocked(t, s, g) {
  const lastOcc = g.occ[g.occ.length - 1];
  const lastAmt = Math.round(Math.abs(lastOcc.amount) * 100) / 100;
  const recent = g.occ.slice(-3).map((x) => Math.abs(x.amount));
  const avg = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
  const estimate = s.amount_mode === 'estimate';
  const suggest = !estimate && Math.abs(lastAmt - Number(s.amount)) >= 0.01 && lastAmt !== Number(s.dismissed_amount) ? lastAmt : null;
  await t.q(
    `update recurring set last_date = greatest(last_date, $2::date), starts_on = least(coalesce(starts_on, $3::date), $3::date),
       amount = case when $4::bool then $5 else amount end, suggested_amount = $6, logo_url = coalesce(logo_url, $7), updated_at = now()
     where id = $1`,
    [s.id, lastOcc.date, g.occ[0].date, estimate, avg, suggest, lastOcc.logo_url ?? null],
  );
  await t.q('update transactions set recurring_id = $1 where id = any($2::bigint[]) and recurring_id is null', [s.id, g.ids]);
}

export async function refreshRecurring() {
  const txns = await q(
    `select t.id, t.date, t.amount, t.name, t.merchant_name, t.display_name, t.category_id, t.account_id, t.logo_url
       from transactions t
       join categories c on c.id = t.category_id
       join category_groups g on g.id = c.group_id
       join accounts a on a.id = t.account_id
      where not t.excluded and g.kind <> 'transfer'
        and t.date > current_date - $1::int`,
    [LOOKBACK_DAYS],
  );
  const groups = groupByMerchant(txns);
  const found = detect(groups);
  await tx(async (t) => {
    const existing = new Map((await t.q(`select ${SERIES_COLS} from recurring`)).map((r) => [r.merchant_key, r]));
    for (const r of found) {
      const cur = existing.get(r.merchant_key);
      if (cur && (cur.user_edited || cur.source === 'manual')) continue; // handled below with the other locked series
      const row = await t.one(
        `insert into recurring (merchant_key, name, kind, category_id, account_id, frequency, interval_days, amount, last_date, logo_url,
                                every, unit, month_days, anchor_date, starts_on)
         values ($1,$2,$3,$4,$5,'custom',0,$6,$7,$8,$9,$10,$11,$7,$12)
         on conflict (merchant_key) do update set
           name = excluded.name, category_id = excluded.category_id, kind = excluded.kind, account_id = excluded.account_id,
           amount = excluded.amount, last_date = excluded.last_date, every = excluded.every, unit = excluded.unit,
           month_days = excluded.month_days, anchor_date = excluded.anchor_date, starts_on = excluded.starts_on,
           logo_url = coalesce(excluded.logo_url, recurring.logo_url), suggested_amount = null, updated_at = now()
         returning id`,
        [r.merchant_key, r.name, r.kind, r.category_id, r.account_id, r.amount, r.last_date, r.logo_url, r.every, r.unit, r.month_days, r.first_date],
      );
      await t.q('update transactions set recurring_id = $1 where id = any($2::bigint[]) and recurring_id is distinct from $1', [row.id, r.ids]);
    }
    // Series you added or edited: follow their payments whether or not the pattern is detectable yet.
    for (const s of existing.values()) {
      if (!(s.user_edited || s.source === 'manual')) continue;
      const g = groups.get(s.merchant_key);
      if (g) await trackLocked(t, s, g);
    }
    // Rows whose pattern disappeared (merchant gone, data removed) and that the user never touched.
    await t.q(
      `delete from recurring r where not r.user_edited and r.source = 'detected' and r.status = 'active' and not (r.merchant_key = any($1::text[]))`,
      [found.map((r) => r.merchant_key)],
    );
    await settle(t);
  });
  return found.length;
}

// A series you add by hand, optionally from one of its payments (it then follows that merchant's later charges).
export async function createSeries(t, s, fromTxn) {
  const mk = fromTxn && merchantKey(fromTxn);
  const key = mk ? `${fromTxn.amount < 0 ? 'income' : 'expense'}:${mk}` : `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = today();
  const startsOn = fromTxn ? fromTxn.date : s.anchor_date < now ? s.anchor_date : now;
  const row = await t.one(
    `insert into recurring (merchant_key, name, kind, category_id, account_id, frequency, interval_days, amount, last_date, logo_url, status,
                            source, user_edited, every, unit, month_days, anchor_date, starts_on, ends_on, amount_mode, share_pct, budget_mode)
     values ($1,$2,$3,$4,$5,'custom',0,$6,$7,$8,'active','manual',true,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (merchant_key) do update set
       name = excluded.name, kind = excluded.kind, category_id = excluded.category_id, account_id = coalesce(excluded.account_id, recurring.account_id),
       amount = excluded.amount, last_date = greatest(recurring.last_date, excluded.last_date), status = 'active', user_edited = true,
       every = excluded.every, unit = excluded.unit, month_days = excluded.month_days, anchor_date = excluded.anchor_date,
       starts_on = least(recurring.starts_on, excluded.starts_on), ends_on = excluded.ends_on, amount_mode = excluded.amount_mode,
       share_pct = excluded.share_pct, budget_mode = excluded.budget_mode, suggested_amount = null, updated_at = now()
     returning id`,
    [key, s.name, s.kind, s.category_id, s.account_id, s.amount, fromTxn?.date ?? null, fromTxn?.logo_url ?? null, s.every, s.unit, s.month_days,
     s.anchor_date, startsOn, s.ends_on, s.amount_mode, s.share_pct, s.budget_mode],
  );
  if (fromTxn) {
    await t.q('update transactions set recurring_id = $1 where id = $2', [row.id, fromTxn.id]);
    // Earlier and later payments to the same merchant join the series too.
    const txns = await t.q(
      `select id, date, amount, name, merchant_name, display_name, logo_url from transactions
        where not excluded and date > current_date - $1::int and sign(amount) = sign($2::numeric)`,
      [LOOKBACK_DAYS, fromTxn.amount],
    );
    const g = groupByMerchant(txns).get(key);
    if (g) await trackLocked(t, (await t.q(`select ${SERIES_COLS} from recurring where id = $1`, [row.id]))[0], g);
  }
  await settle(t, [row.id]);
  return row.id;
}
