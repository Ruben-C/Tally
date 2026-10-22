// Authenticated JSON API. Everything here sits behind requireAuth (see server.js).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { config } from '../config.js';
import { requireFreshAuth } from '../auth.js';
import { audit, readAudit } from '../store.js';
import * as plaid from '../plaid.js';
import { loadDemo, removeDemo, hasDemo } from '../demo.js';
import { refreshRecurring, createSeries, settle } from '../recurring.js';
import { UNITS, effectiveMode, isLong, monthPlan, myAmount, occurrences, perMonth } from '../schedule.js';
import { ruleMatches } from '../categorize.js';
import { setSplits } from '../splits.js';
import { iso, addDays } from '../balances.js';
import { goals, applyGoalSplits, plannedSaving } from '../goals.js';

export const api = Router();
api.use(goals);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && res.json(out), next);

const today = () => iso(new Date());
function monthOf(m) {
  if (m && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad('month must be YYYY-MM');
  const start = (m || today().slice(0, 7)) + '-01';
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { start, end: iso(d) }; // [start, end)
}
const shiftMonth = (start, n) => {
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Transactions that count toward spending/income: visible accounts, not excluded. Split transactions count as their
// lines (txn_lines, migration 008), each in its own category.
const FLOW = `from txn_lines t
  join accounts a on a.id = t.account_id and not a.hidden
  join categories c on c.id = t.category_id
  join category_groups g on g.id = c.group_id
  where not t.excluded`;

// ---- meta -------------------------------------------------------------------

api.get('/meta', wrap(async () => {
  const counts = await one(`select (select count(*) from accounts)::int as accounts, (select count(*) from plaid_items)::int as items,
                                   (select count(*) from transactions where not reviewed)::int as to_review`);
  return {
    plaid: { configured: config.plaid.configured, env: config.plaid.env, oauthRedirect: !!config.plaid.redirectUri, webhook: !!config.plaid.webhook },
    demo: await hasDemo(),
    ...counts,
  };
}));

// ---- dashboard --------------------------------------------------------------

api.get('/dashboard', wrap(async (req) => {
  const { start, end } = monthOf(req.query.month);
  const prevStart = shiftMonth(start, -1);
  const t0 = today();
  const dayOfMonth = start === t0.slice(0, 7) + '-01' ? Number(t0.slice(8, 10)) : null;

  const daily = await q(
    `select t.date, sum(t.amount) as amt ${FLOW} and g.kind = 'expense' and t.date >= $1 and t.date < $2 group by t.date`,
    [prevStart, end],
  );
  const by = new Map(daily.map((d) => [d.date, d.amt]));
  const dim = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate();
  const series = [];
  let cur = 0, prev = 0;
  for (let i = 1; i <= Math.max(dim(start), dim(prevStart)); i++) {
    const dd = String(i).padStart(2, '0');
    if (i <= dim(prevStart)) prev += by.get(`${prevStart.slice(0, 8)}${dd}`) || 0;
    if (i <= dim(start)) cur += by.get(`${start.slice(0, 8)}${dd}`) || 0;
    series.push({ day: i, cur: dayOfMonth && i > dayOfMonth ? null : i <= dim(start) ? round(cur) : null, prev: i <= dim(prevStart) ? round(prev) : null });
  }
  const spent = round(series.filter((s) => s.cur != null).at(-1)?.cur ?? 0);
  const prevToDate = round(series[Math.min(dayOfMonth || 99, series.length) - 1]?.prev ?? prev);

  const income = await one(`select coalesce(-sum(t.amount), 0) as v ${FLOW} and g.kind = 'income' and t.date >= $1 and t.date < $2`, [start, end]);
  const summary = await budgetSummary(start.slice(0, 7));
  const budgets = summary.categories;

  const nw = await netWorthSeries(addDays(t0, -90));
  const reviewCount = await one('select count(*)::int as n from transactions t join accounts a on a.id = t.account_id where not t.reviewed');
  const toReview = await q(`${TX_SELECT} where not t.reviewed order by t.date desc, t.id desc limit 6`);
  const upcoming = await q(
    `select r.*, c.name as category_name, c.emoji, c.color from recurring r left join categories c on c.id = r.category_id
      where r.status = 'active' and (r.ends_on is null or r.ends_on > current_date)
        and r.next_date between current_date - 3 and current_date + 21 order by r.next_date limit 6`,
  );
  // Only a budget you set is a limit on the category: a figure from its recurring bills (e.g. a yearly Prime fee set
  // aside monthly) isn't something the rest of its spending can be "over".
  const asLimit = (b) => (b.budget_source === 'manual' ? b : { ...b, budget: null, available: null });
  const top = budgets.filter((b) => b.spent > 0 || b.budget_source === 'manual').sort((a, b) => b.spent - a.spent).slice(0, 6).map(asLimit);
  // Every category with a limit, most used first (rollover counts toward what it can spend), for the Budget panel.
  const capOf = (b) => b.budget + (b.rollover ? b.carry : 0);
  const limits = budgets.filter((b) => b.budget_source === 'manual' && b.budget > 0)
    .sort((a, b) => b.spent / Math.max(capOf(b), 0.01) - a.spent / Math.max(capOf(a), 0.01)).slice(0, 6);
  // Long-interval bills being set aside for, and manual budgets that don't cover their category's recurring charges.
  const setAside = budgets.flatMap((b) => b.series.filter((x) => x.mode === 'set_aside' && x.long).map((x) => ({ ...x, category_id: b.category_id })));
  const savedOf = (x) => Math.min(x.fund + x.planned, x.target ?? Infinity);
  const renewals = {
    saved: round(setAside.reduce((a, x) => a + savedOf(x), 0)),
    monthly: round(setAside.reduce((a, x) => a + x.planned, 0)),
    items: setAside.filter((x) => x.renews && x.renews <= addDays(t0, 60)).sort((a, b) => (a.renews < b.renews ? -1 : 1)).slice(0, 4)
      .map((x) => ({ id: x.id, name: x.name, category_id: x.category_id, amount: x.target, renews: x.renews, saved: round(savedOf(x)) })),
  };
  const underBudget = budgets.filter((b) => b.budget_source === 'manual' && b.committed > b.budget + 0.5)
    .map((b) => ({ category_id: b.category_id, name: b.name, emoji: b.emoji, color: b.color, budget: b.budget, committed: b.committed }));
  // Material for the plain-language brief: category movers (month-to-date vs the same days last month),
  // this week's bills, the biggest purchase, and anything unusually large for its merchant.
  const cutoff = dayOfMonth ?? 31;
  const movers = await q(
    `select c.id as category_id, c.name, c.emoji, c.color,
            coalesce(sum(t.amount) filter (where t.date >= $1 and t.date < $2), 0) as cur,
            coalesce(sum(t.amount) filter (where t.date >= $3 and t.date < $1 and extract(day from t.date) <= $4), 0) as prev
       ${FLOW} and g.kind = 'expense' and t.date >= $3 and t.date < $2 group by c.id`,
    [start, end, prevStart, cutoff],
  );
  // Your share of each bill, as on the Recurring page; series that have ended don't count.
  const week = await one(
    `select count(*)::int as n, coalesce(sum(amount * share_pct / 100), 0) as total from recurring
      where status = 'active' and kind = 'expense' and (ends_on is null or ends_on > current_date)
        and next_date between current_date and current_date + 7`,
  );
  const biggest = await one(`select t.id, coalesce(t.display_name, t.merchant_name, t.name) as label, t.amount, t.date, t.category_id ${FLOW}
      and g.kind = 'expense' and t.date >= $1 and t.date < $2 order by t.amount desc limit 1`, [start, end]);
  // Spending only: a card payment or transfer bigger than usual isn't an unusual charge, nor is an excluded one.
  const unusual = await one(
    `with s as (select t.* from transactions t join accounts a on a.id = t.account_id and not a.hidden
                  join categories c on c.id = t.category_id join category_groups g on g.id = c.group_id
                 where g.kind = 'expense' and not t.excluded and t.amount > 0),
          m as (select lower(coalesce(merchant_name, name)) as k, avg(amount) as avg, count(*) as n from s
                 where date > current_date - 180 group by 1)
     select t.id, coalesce(t.display_name, t.merchant_name, t.name) as label, t.amount, m.avg
       from s t join m on m.k = lower(coalesce(t.merchant_name, t.name))
      where t.date > current_date - 7 and m.n >= 4 and t.amount > m.avg * 2.2 and t.amount - m.avg > 20
      order by t.amount - m.avg desc limit 1`,
  );
  return {
    month: start.slice(0, 7),
    method: summary.method,
    spending: { spent, prevToDate, prevTotal: round(prev), series, dayOfMonth },
    income: round(income.v),
    budget: budgetHeadline(summary),
    netWorth: { current: nw.at(-1)?.net ?? 0, change30: round((nw.at(-1)?.net ?? 0) - (nw.at(-31)?.net ?? nw[0]?.net ?? 0)), series: nw },
    toReview: { count: reviewCount.n, items: toReview },
    upcoming,
    recurring: { renewals, underBudget },
    topCategories: top,
    limits,
    brief: {
      movers: movers.map((m) => ({ ...m, cur: round(m.cur), prev: round(m.prev), diff: round(m.cur - m.prev) })).filter((m) => Math.abs(m.diff) >= 25).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 3),
      billsThisWeek: { n: week.n, total: round(week.total) },
      biggest,
      unusual,
    },
  };
}));

// ---- accounts & net worth ---------------------------------------------------

// Before an account's first known balance it counts at that balance, not $0. Investment accounts have no reconstructed
// history (market moves aren't transactions), so a newly linked one would otherwise look like a jump in net worth.
async function netWorthSeries(from) {
  return q(
    `with days as (select d::date as date from generate_series($1::date, current_date, interval '1 day') d)
     select days.date,
            round(coalesce(sum(case when a.type in ('credit','loan') then 0 else b.balance end), 0), 2) as assets,
            round(coalesce(sum(case when a.type in ('credit','loan') then b.balance else 0 end), 0), 2) as liabilities,
            round(coalesce(sum(case when a.type in ('credit','loan') then -b.balance else b.balance end), 0), 2) as net
       from days
       cross join accounts a
       join lateral (select coalesce(
              (select balance from balance_history h where h.account_id = a.id and h.date <= days.date order by h.date desc limit 1),
              (select balance from balance_history h where h.account_id = a.id order by h.date limit 1)) as balance) b on b.balance is not null
      where not a.hidden
      group by days.date order by days.date`,
    [from],
  );
}

api.get('/accounts', wrap(async () => {
  return q(
    `select a.*, coalesce(a.display_name, a.name) as label, i.status as item_status, i.error_code as item_error, i.last_synced_at,
            i.institution_color, i.institution_logo,
            (select balance from balance_history h where h.account_id = a.id and h.date <= current_date - 30 order by date desc limit 1) as balance_30d,
            (select array_agg(balance order by date) from balance_history h where h.account_id = a.id and h.date > current_date - 90) as spark
       from accounts a left join plaid_items i on i.id = a.item_id
      order by case a.type when 'depository' then 1 when 'credit' then 2 when 'investment' then 3 when 'loan' then 4 else 5 end, a.current_balance desc nulls last`,
  );
}));

api.patch('/accounts/:id', wrap(async (req) => {
  const { display_name, hidden } = req.body;
  const row = await one(
    `update accounts set display_name = case when $2::bool then nullif(trim($3::text), '') else display_name end,
       hidden = coalesce($4::bool, hidden), updated_at = now() where id = $1 returning *`,
    [req.params.id, display_name !== undefined, display_name ?? null, hidden ?? null],
  );
  if (!row) throw bad('not found', 404);
  return row;
}));

api.get('/networth', wrap(async (req) => {
  const days = Math.min(Math.max(Number(req.query.days) || 365, 7), 3650);
  return netWorthSeries(addDays(today(), -days));
}));

// ---- transactions -----------------------------------------------------------

const TX_SELECT = `select t.id, t.account_id, t.date, t.amount, coalesce(t.display_name, t.merchant_name, t.name) as label, t.name,
  t.merchant_name, t.display_name, t.logo_url, t.category_id, t.category_locked, t.pending, t.reviewed, t.excluded, t.notes, t.tags,
  t.recurring_id, t.pfc_detailed, ge.goal_id, gg.name as goal_name, gg.emoji as goal_emoji,
  (select json_agg(json_build_object('id', s.id, 'category_id', s.category_id, 'amount', s.amount, 'note', s.note) order by s.sort, s.id)
     from transaction_splits s where s.transaction_id = t.id) as splits,
  (select json_agg(json_build_object('id', a.id, 'goal_id', a.goal_id, 'name', g.name, 'emoji', g.emoji, 'amount', a.amount, 'rule_id', a.rule_id) order by a.id)
     from goal_allocations a join goals g on g.id = a.goal_id where a.transaction_id = t.id) as allocations
  from transactions t left join goal_entries ge on ge.transaction_id = t.id left join goals gg on gg.id = ge.goal_id`;

api.get('/transactions', wrap(async (req) => {
  const w = ['true'];
  const p = [];
  const add = (sql, v) => {
    p.push(v);
    w.push(sql.replaceAll('?', `$${p.length}`));
  };
  const { q: search, account, category, group, reviewed, from, to, cursor, recurring, kind } = req.query;
  if (search) add(`(coalesce(t.display_name,'') || ' ' || t.name || ' ' || coalesce(t.merchant_name,'') || ' ' || coalesce(t.notes,'') || ' ' || t.amount::text) ilike ?`, `%${String(search).replace(/[%_\\]/g, '\\$&')}%`);
  if (account) add('t.account_id = ?', Number(account));
  // A split transaction shows under each of its lines' categories.
  if (category) add('exists (select 1 from txn_lines l where l.id = t.id and l.category_id = ?)', Number(category));
  if (group) add('exists (select 1 from txn_lines l join categories lc on lc.id = l.category_id where l.id = t.id and lc.group_id = ?)', Number(group));
  if (recurring) add('t.recurring_id = ?', Number(recurring));
  if (reviewed === 'false') w.push('not t.reviewed');
  if (from) add('t.date >= ?::date', from);
  if (to) add('t.date < ?::date', to);
  if (kind === 'income') w.push('t.amount < 0');
  if (kind === 'expense') w.push('t.amount > 0');
  if (cursor) {
    const [d, id] = String(cursor).split('_');
    p.push(d, Number(id));
    w.push(`(t.date, t.id) < ($${p.length - 1}::date, $${p.length})`);
  }
  const limit = Math.min(Number(req.query.limit) || 60, 500);
  const rows = await q(`${TX_SELECT} where ${w.join(' and ')} order by t.date desc, t.id desc limit ${limit + 1}`, p);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, next: more ? `${items.at(-1).date}_${items.at(-1).id}` : null };
}));

api.get('/transactions/:id', wrap(async (req) => {
  const row = await one(`${TX_SELECT} where t.id = $1`, [req.params.id]);
  if (!row) throw bad('not found', 404);
  const merchant = row.merchant_name || row.name;
  const history = await q(
    `${TX_SELECT} where lower(coalesce(t.merchant_name, t.name)) = lower($1) and t.id <> $2 order by t.date desc limit 12`,
    [merchant, row.id],
  );
  const stats = await one(
    `select count(*)::int as n, coalesce(sum(amount),0) as total, coalesce(avg(amount),0) as avg from transactions
      where lower(coalesce(merchant_name, name)) = lower($1) and date > current_date - 365`,
    [merchant],
  );
  return { ...row, history, stats };
}));

api.patch('/transactions/:id', wrap(async (req) => {
  const b = req.body;
  const row = await tx(async (t) => {
    const cur = await t.one('select * from transactions where id = $1 for update', [req.params.id]);
    if (!cur) throw bad('not found', 404);
    const next = {
      category_id: b.category_id !== undefined ? b.category_id : cur.category_id,
      category_locked: b.category_id !== undefined ? true : cur.category_locked,
      display_name: b.display_name !== undefined ? (String(b.display_name || '').trim() || null) : cur.display_name,
      notes: b.notes !== undefined ? (String(b.notes || '').trim().slice(0, 2000) || null) : cur.notes,
      reviewed: b.reviewed !== undefined ? !!b.reviewed : b.category_id !== undefined ? true : cur.reviewed,
      excluded: b.excluded !== undefined ? !!b.excluded : cur.excluded,
      tags: Array.isArray(b.tags) ? b.tags.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : cur.tags,
    };
    // Picking a single category ends a split.
    if (b.category_id !== undefined) await t.q('delete from transaction_splits where transaction_id = $1', [cur.id]);
    const out = await t.one(
      `update transactions set category_id=$2, category_locked=$3, display_name=$4, notes=$5, reviewed=$6, excluded=$7, tags=$8, updated_at=now()
        where id=$1 returning id`,
      [cur.id, next.category_id, next.category_locked, next.display_name, next.notes, next.reviewed, next.excluded, next.tags],
    );
    // "Apply to all from this merchant": recategorize/rename the others and remember it as a rule.
    let applied = 0;
    if (b.applyToMerchant && (b.category_id !== undefined || b.display_name !== undefined)) {
      const merchant = cur.merchant_name || cur.name;
      const res = await t.q(
        `update transactions set
           category_id = case when $3::bool then $4::int else category_id end,
           category_locked = category_locked or $3::bool,
           display_name = case when $5::bool then $6::text else display_name end, updated_at = now()
         where lower(coalesce(merchant_name, name)) = lower($1) and id <> $2
           and not ($3::bool and exists (select 1 from transaction_splits s where s.transaction_id = transactions.id)) returning id`,
        [merchant, cur.id, b.category_id !== undefined, next.category_id, b.display_name !== undefined, next.display_name],
      );
      applied = res.length;
      await t.q(
        `insert into rules (field, op, pattern, set_category_id, set_display_name) values ('merchant', 'equals', $1, $2, $3)`,
        [merchant, b.category_id !== undefined ? next.category_id : null, b.display_name !== undefined ? next.display_name : null],
      );
    }
    return { id: out.id, applied };
  });
  return { ...(await one(`${TX_SELECT} where t.id = $1`, [row.id])), applied: row.applied };
}));

// Split across categories: lines [{category_id, amount, note}] adding up to the transaction (see splits.js).
api.put('/transactions/:id/splits', wrap(async (req) => {
  await tx((t) => setSplits(t, Number(req.params.id), req.body.lines));
  return one(`${TX_SELECT} where t.id = $1`, [req.params.id]);
}));

// Undo a split: the transaction goes back to one category (the main line's, or `category_id`).
api.delete('/transactions/:id/splits', wrap(async (req) => {
  await tx(async (t) => {
    await t.q('delete from transaction_splits where transaction_id = $1', [req.params.id]);
    if (req.query.category_id) await t.q('update transactions set category_id = $2, category_locked = true, updated_at = now() where id = $1', [req.params.id, Number(req.query.category_id)]);
  });
  return one(`${TX_SELECT} where t.id = $1`, [req.params.id]);
}));

api.post('/transactions/review', wrap(async (req) => {
  const { ids, all } = req.body;
  const res = all
    ? await q('update transactions set reviewed = true, updated_at = now() where not reviewed returning id')
    : await q('update transactions set reviewed = true, updated_at = now() where id = any($1::bigint[]) and not reviewed returning id', [(ids || []).map(Number)]);
  return { updated: res.length };
}));

// ---- categories -------------------------------------------------------------

api.get('/categories', wrap(async () => {
  const groups = await q('select * from category_groups order by sort, id');
  const categories = await q(
    `select c.*, coalesce(st.n, 0)::int as tx_count, coalesce(st.avg3, 0) as avg3, st.last_used,
            (select count(*) from rules r where r.set_category_id = c.id)::int as rule_count
       from categories c join category_groups g on g.id = c.group_id
       left join (select l.category_id, count(*) as n, max(l.date) as last_used,
                         sum(l.amount) filter (where not a.hidden and l.date >= date_trunc('month', current_date) - interval '3 months' and l.date < date_trunc('month', current_date)) / 3 as avg3
                    from txn_lines l join accounts a on a.id = l.account_id where not l.excluded group by 1) st on st.category_id = c.id
      order by g.sort, c.sort, c.name`,
  );
  return { groups, categories };
}));

api.post('/categories', wrap(async (req) => {
  const { group_id, name, emoji, color } = req.body;
  if (!name?.trim()) throw bad('name required');
  return one(
    `insert into categories (group_id, name, emoji, color, sort) values ($1, $2, coalesce($3, '🏷️'), coalesce($4, '#8e8e93'),
       (select coalesce(max(sort), 0) + 1 from categories where group_id = $1)) returning *`,
    [group_id, name.trim().slice(0, 40), emoji || null, color || null],
  );
}));

api.patch('/categories/:id', wrap(async (req) => {
  const { name, emoji, color, group_id, archived, budget_kind } = req.body;
  let { rollover } = req.body;
  if (budget_kind != null && !['fixed', 'flexible', 'non_monthly'].includes(budget_kind)) throw bad('unknown budget kind');
  if (req.body.bucket !== undefined && ![null, 'need', 'want', 'savings'].includes(req.body.bucket)) throw bad('unknown bucket');
  // Non-monthly budgets only work as sinking funds: the monthly share has to pile up, so rollover comes on with them.
  if (budget_kind === 'non_monthly' && rollover == null) rollover = true;
  const row = await one(
    `update categories set name = coalesce(nullif(trim($2), ''), name), emoji = coalesce($3, emoji), color = coalesce($4, color),
       group_id = coalesce($5, group_id), archived = coalesce($7, archived),
       rollover = coalesce($6, rollover), budget_kind = coalesce($8, budget_kind),
       bucket = case when $9::bool then $10 else bucket end,
       rollover_since = case when $6::bool is true and not rollover then date_trunc('month', current_date)::date
                             when $6::bool is false then null else rollover_since end
     where id = $1 returning *`,
    [req.params.id, name ?? null, emoji ?? null, color ?? null, group_id ?? null, rollover ?? null, archived ?? null,
     budget_kind ?? null, req.body.bucket !== undefined, req.body.bucket ?? null],
  );
  if (!row) throw bad('not found', 404);
  return row;
}));

api.delete('/categories/:id', wrap(async (req) => {
  const c = await one('select * from categories where id = $1', [req.params.id]);
  if (!c) throw bad('not found', 404);
  if (c.key) throw bad("built-in categories can be archived but not deleted");
  const other = await one(`select id from categories where key = 'other'`);
  await tx(async (t) => {
    await t.q('update transactions set category_id = $2 where category_id = $1', [c.id, other.id]);
    await t.q('update transaction_splits set category_id = $2 where category_id = $1', [c.id, other.id]);
    await t.q('delete from categories where id = $1', [c.id]);
  });
  return { ok: true };
}));

// ---- budgets ----------------------------------------------------------------

async function budgetRows(start, end) {
  const cats = await q(
    `select c.id as category_id, c.name, c.emoji, c.color, c.group_id, g.name as group_name, c.rollover, c.rollover_since, c.budget_kind, c.bucket
       from categories c join category_groups g on g.id = c.group_id
      where g.kind = 'expense' and not c.archived order by g.sort, c.sort`,
  );
  const allBudgets = await q('select category_id, month, amount from budgets where month < $1 order by month', [end]);
  const effective = (catId, monthStart) => {
    let v = null;
    for (const b of allBudgets) if (b.category_id === catId && b.month <= monthStart) v = b.amount;
    return v;
  };
  const spentRows = await q(`select t.category_id, sum(t.amount) as s ${FLOW} and t.date >= $1 and t.date < $2 group by 1`, [start, end]);
  const spent = new Map(spentRows.map((r) => [r.category_id, r.s]));
  // Of that, payments to the category's own recurring series (the Flex view counts them as fixed).
  const recRows = await q(
    `select t.category_id, sum(t.amount) as s ${FLOW} and t.date >= $1 and t.date < $2
        and exists (select 1 from recurring r where r.id = t.recurring_id and r.category_id = t.category_id and r.status = 'active' and r.kind = 'expense')
      group by 1`,
    [start, end],
  );
  const recSpent = new Map(recRows.map((r) => [r.category_id, r.s]));

  // Rollover: unspent (or overspent) budget carries forward month to month since it was switched on.
  const sinceMin = cats.filter((c) => c.rollover && c.rollover_since && c.rollover_since < start).map((c) => c.rollover_since).sort()[0];
  const hist = new Map();
  if (sinceMin) {
    for (const r of await q(
      `select t.category_id, to_char(t.date, 'YYYY-MM-01') as m, sum(t.amount) as s ${FLOW} and t.date >= $1 and t.date < $2 group by 1, 2`,
      [sinceMin, start],
    ))
      hist.set(`${r.category_id}:${r.m}`, r.s);
  }
  // Average of the 3 full months before this one, as a budgeting hint.
  const avgRows = await q(
    `select t.category_id, sum(t.amount) / 3 as avg ${FLOW} and t.date >= $1 and t.date < $2 group by 1`,
    [shiftMonth(start, -3), start],
  );
  const avg = new Map(avgRows.map((r) => [r.category_id, r.avg]));

  // Recurring bills and subscriptions: a category without a budget of its own is budgeted from its series
  // (each charge in the month it lands, or a monthly share set aside for long intervals; see schedule.js).
  const byCat = new Map();
  for (const s of await activeSeries()) {
    if (!byCat.has(s.category_id)) byCat.set(s.category_id, []);
    byCat.get(s.category_id).push(s);
  }
  const committedAt = (catId, m) => round((byCat.get(catId) || []).reduce((a, s) => a + monthPlan(s, m, s.mode).planned, 0));

  return cats.map((c) => {
    const manual = effective(c.category_id, start) || null; // 0 means "no budget from this month on"
    // Series that had ended before this month, or didn't exist yet, aren't part of it.
    const existed = (s) => [s.starts_on, iso(new Date(s.created_at))].filter(Boolean).sort()[0] < end;
    const series = (byCat.get(c.category_id) || []).filter((s) => !(s.ends_on && s.ends_on <= start) && existed(s)).map((s) => {
      const p = monthPlan(s, start, s.mode);
      return { id: s.id, name: s.name, logo_url: s.logo_url, mode: s.mode, long: isLong(s), amount: round(myAmount(s)), every: s.every, unit: s.unit, ...p };
    });
    const committed = round(series.reduce((a, s) => a + s.planned, 0));
    // Set-aside funds count toward what's available when the budget comes from the series and rollover isn't already
    // carrying the unspent shares forward.
    const fund = round(series.reduce((a, s) => a + (s.mode === 'set_aside' ? s.fund : 0), 0));
    const fromSeries = manual == null && (committed > 0 || fund > 0);
    const budget = manual ?? (fromSeries ? committed : null);
    const reserve = fromSeries && !c.rollover ? fund : 0;
    let carry = 0;
    if (c.rollover && c.rollover_since && c.rollover_since < start) {
      for (let m = c.rollover_since; m < start; m = shiftMonth(m, 1))
        carry += (effective(c.category_id, m) || (byCat.has(c.category_id) ? committedAt(c.category_id, m) : 0)) - (hist.get(`${c.category_id}:${m}`) || 0);
    }
    const s = round(spent.get(c.category_id) || 0);
    return {
      ...c, budget, budget_source: manual != null ? 'manual' : fromSeries ? 'recurring' : null, committed, reserve, series,
      rec_spent: round(recSpent.get(c.category_id) || 0),
      spent: s, carry: round(carry), available: budget == null ? null : round(budget + carry + reserve - s), avg3: round(avg.get(c.category_id) || 0),
    };
  });
}

// ---- recurring budget defaults ----------------------------------------------

const MODES = ['due', 'set_aside'];
const DEFAULT_TREATMENT = { long: 'set_aside', short: 'due' };
async function recurringDefaults() {
  const row = await one(`select value from settings where key = 'recurring_budget'`);
  const v = row?.value || {};
  return { long: MODES.includes(v.long) ? v.long : DEFAULT_TREATMENT.long, short: MODES.includes(v.short) ? v.short : DEFAULT_TREATMENT.short };
}
// Active expense series with a category, each with its budget treatment resolved.
async function activeSeries() {
  const defaults = await recurringDefaults();
  const rows = await q(`select * from recurring where status = 'active' and kind = 'expense' and category_id is not null`);
  return rows.map((s) => ({ ...s, mode: effectiveMode(s, defaults) }));
}

const METHODS = ['category', 'zero', 'flex', 'percent'];
const DEFAULT_RATIOS = { need: 50, want: 30, savings: 20 };

async function budgetMethod() {
  const row = await one(`select value from settings where key = 'budget_method'`);
  const v = row?.value || {};
  return { method: METHODS.includes(v.method) ? v.method : 'category', ratios: { ...DEFAULT_RATIOS, ...v.ratios } };
}

// Month-level plan figures (expected income, flex number): the latest row at or before the month wins; a null amount
// means "automatic" from that month on.
async function planValue(field, start) {
  const r = await one('select amount from budget_plan where field = $1 and month <= $2 order by month desc limit 1', [field, start]);
  return r?.amount ?? null;
}

const incomeBetween = async (from, to) =>
  (await one(`select coalesce(-sum(t.amount), 0) as v ${FLOW} and g.kind = 'income' and t.date >= $1 and t.date < $2`, [from, to])).v;

// The month's budget under every method; /budgets returns it whole and the dashboard reads its headline from it, so the
// two can't disagree.
async function budgetSummary(month) {
  const { start, end } = monthOf(month);
  const rows = await budgetRows(start, end);
  const income = await incomeBetween(start, end);
  const t0 = today();
  const elapsed = start <= t0 && t0 < end ? (Number(t0.slice(8, 10)) - 0.5) / new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).getUTCDate() : start > t0 ? 0 : 1;
  const { method, ratios } = await budgetMethod();

  // Expected income: what you set, else the average of the 3 full months before this one.
  const incomeSet = await planValue('income', start);
  const incomeAvg = round((await incomeBetween(shiftMonth(start, -3), start)) / 3);
  const expected = incomeSet ?? incomeAvg;
  // Planned saving: monthly contributions of active goals (the money leaves through transfers, which budgets don't see).
  const saving = { v: await plannedSaving() };

  const sumBy = (pred, f) => round(rows.filter(pred).reduce((a, r) => a + f(r), 0));
  const capOf = (r) => (r.budget || 0) + (r.rollover ? r.carry : 0) + r.reserve;
  const kinds = {};
  for (const k of ['fixed', 'flexible', 'non_monthly']) {
    const is = (r) => r.budget_kind === k;
    // Fixed bills without a budget fall back to the 3-month average so the flex number isn't overstated.
    const planned = k === 'fixed' ? sumBy(is, (r) => (r.budget != null ? r.budget : r.avg3)) : sumBy(is, (r) => r.budget || 0);
    kinds[k] = { planned, spent: sumBy(is, (r) => r.spent), available: sumBy((r) => is(r) && r.available != null, (r) => r.available), cap: sumBy(is, capOf),
      carried: sumBy(is, (r) => capOf(r) - (r.budget || 0)) };
  }
  // Recurring bills count as fixed whatever their category: a flexible category's series (their monthly plan, set-aside
  // funds and payments) move to fixed, and only the rest of the category stays in flex. A budget you set on such a
  // category is taken to cover its bills first. Budgets.tsx splits the rows the same way (splitRecurring).
  kinds.fixed.recurring = 0;
  for (const r of rows) {
    if (r.budget_kind !== 'flexible' || !r.series.length) continue;
    const f = kinds.fixed, x = kinds.flexible;
    const restBudget = r.budget_source === 'manual' ? Math.max(r.budget - r.committed, 0) : 0;
    const restCap = restBudget + (r.rollover ? r.carry : 0);
    f.planned += r.committed; f.recurring += r.committed; f.spent += r.rec_spent; f.cap += r.committed + r.reserve;
    f.available += r.committed + r.reserve - r.rec_spent; f.carried += r.reserve;
    x.planned += restBudget - (r.budget || 0); x.spent -= r.rec_spent; x.cap += restCap - capOf(r); x.carried -= r.reserve;
    x.available += (r.budget_source === 'manual' ? restCap - (r.spent - r.rec_spent) : 0) - (r.available ?? 0);
  }
  for (const k of Object.keys(kinds)) for (const f of Object.keys(kinds[k])) kinds[k][f] = round(kinds[k][f]);
  const flexSet = await planValue('flex', start);
  const flexAuto = round(expected - kinds.fixed.planned - kinds.non_monthly.planned - saving.v);
  const buckets = {};
  for (const b of ['need', 'want', 'savings']) {
    const is = (r) => r.bucket === b;
    buckets[b] = { target: round((expected * (ratios[b] || 0)) / 100), planned: sumBy(is, (r) => r.budget || 0), spent: sumBy(is, (r) => r.spent) };
  }
  const totalSpent = sumBy(() => true, (r) => r.spent);
  // Budgets as the Budgets page rows show them (splitRecurring): a flexible category with recurring bills is its bills
  // plus the rest of a budget you set, so bills above that budget still count; one budgeted from its bills covers only
  // them, rollover and set-aside funds included.
  const split = (r) => r.budget_kind === 'flexible' && r.series.length > 0;
  const budgeted = sumBy(() => true, (r) => (split(r) && r.budget_source === 'manual' ? Math.max(r.budget, r.committed) : r.budget || 0));
  const carried = sumBy((r) => r.budget != null, (r) => (split(r) && r.budget_source !== 'manual' ? r.reserve : capOf(r) - r.budget));

  return {
    month: start.slice(0, 7),
    elapsed: round(elapsed),
    method,
    ratios,
    categories: rows,
    totals: {
      budgeted,
      spent: totalSpent,
      // A flexible category budgeted from its recurring bills is two rows on the Budgets page: the bills (budgeted) and the
      // rest (not budgeted). Count only what a budget covers, the same way.
      budgetedSpent: round(rows.filter((r) => r.budget).reduce((s, r) => s + (split(r) && r.budget_source !== 'manual' ? r.rec_spent : r.spent), 0)),
      // Rollover carried in and set-aside funds: money the budgets can spend on top of this month's amounts.
      carried,
      income: round(income),
    },
    plan: {
      income: { expected: round(expected), set: incomeSet, average: incomeAvg, actual: round(income) },
      saving: round(saving.v),
      unassigned: round(expected - budgeted - saving.v),
      kinds,
      flex: { budget: round(flexSet ?? flexAuto), set: flexSet, auto: flexAuto, spent: kinds.flexible.spent },
      buckets,
      // Savings, 50/30/20 style: whatever income wasn't spent this month (transfers to savings don't count as spending).
      saved: round(income - totalSpent),
      unsorted: rows.filter((r) => !r.bucket && (r.spent > 0 || r.budget)).length,
    },
  };
}

api.get('/budgets', wrap((req) => budgetSummary(req.query.month)));

// What "left to spend" means under the chosen method, from the same figures the Budgets page shows:
//   category, zero — category budgets against the spending they cover
//   flex           — the flex number against flexible spending (fixed bills are tracked separately)
//   percent        — the needs + wants share of expected income against everything that isn't savings
// Left = budgeted + carried − spent, where `carried` is rollover and set-aside funds (a yearly bill paid from its fund
// isn't overspending). `plan` is the whole month's planned spending (the chart's budget line); `lines` are secondary
// meters, each measured against `cap` (its planned amount plus what was carried in for it).
function budgetHeadline(b) {
  const { kinds, flex, buckets } = b.plan;
  const line = (key, label, k) => ({ key, label, spent: k.spent, planned: k.planned, cap: round(k.planned + k.carried) });
  if (b.method === 'flex') {
    const lines = [line('fixed', 'Fixed bills', kinds.fixed)];
    if (kinds.non_monthly.planned || kinds.non_monthly.spent || kinds.non_monthly.carried) lines.push(line('non_monthly', 'Non-monthly', kinds.non_monthly));
    return { budgeted: flex.budget, carried: 0, spent: flex.spent, plan: round(flex.budget + kinds.fixed.planned + kinds.non_monthly.planned), lines };
  }
  if (b.method === 'percent') {
    const budgeted = round(buckets.need.target + buckets.want.target);
    return {
      budgeted, carried: 0, spent: round(b.totals.spent - buckets.savings.spent), plan: budgeted,
      lines: ['need', 'want'].map((k) => ({ key: k, label: k === 'need' ? 'Needs' : 'Wants', spent: buckets[k].spent, planned: buckets[k].target, cap: buckets[k].target })),
    };
  }
  return { budgeted: b.totals.budgeted, carried: b.totals.carried, spent: b.totals.budgetedSpent, plan: b.totals.budgeted, lines: [] };
}

api.put('/budget-method', wrap(async (req) => {
  const cur = await budgetMethod();
  const method = req.body.method ?? cur.method;
  if (!METHODS.includes(method)) throw bad('unknown method');
  const ratios = { ...cur.ratios };
  if (req.body.ratios) {
    for (const k of Object.keys(DEFAULT_RATIOS)) {
      const v = Number(req.body.ratios[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw bad('ratios must be 0–100');
      ratios[k] = Math.round(v);
    }
    if (ratios.need + ratios.want + ratios.savings !== 100) throw bad('ratios must add up to 100');
  }
  const value = { method, ratios };
  await q(`insert into settings (key, value) values ('budget_method', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(value)]);
  return value;
}));

api.put('/budget-plan', wrap(async (req) => {
  const { field, month, amount } = req.body;
  if (!['income', 'flex'].includes(field)) throw bad('field must be income or flex');
  const { start } = monthOf(month);
  let v = null;
  if (amount !== null && amount !== '' && amount !== undefined) {
    v = Number(amount);
    if (!Number.isFinite(v) || v < 0 || v > 1e8) throw bad('amount must be a positive number');
    v = round(v);
  }
  // A null row means "automatic"; only store it if an earlier month would otherwise apply.
  const earlier = await one('select amount from budget_plan where field = $1 and month < $2 order by month desc limit 1', [field, start]);
  if (v === null && (!earlier || earlier.amount === null)) await q('delete from budget_plan where field = $1 and month = $2', [field, start]);
  else await q(`insert into budget_plan (month, field, amount) values ($1, $2, $3) on conflict (month, field) do update set amount = excluded.amount`, [start, field, v]);
  return { ok: true };
}));

api.put('/budgets', wrap(async (req) => {
  const { category_id, month, amount } = req.body;
  const { start } = monthOf(month);
  if (amount === null || amount === '') {
    await q('delete from budgets where category_id = $1 and month = $2', [category_id, start]);
    // Clearing a budget from this month on: record an explicit zero if an earlier month would otherwise apply.
    const earlier = await one('select amount from budgets where category_id = $1 and month < $2 order by month desc limit 1', [category_id, start]);
    if (earlier) await q('insert into budgets (category_id, month, amount) values ($1, $2, 0)', [category_id, start]);
  } else {
    const v = Number(amount);
    if (!Number.isFinite(v) || v < 0 || v > 1e8) throw bad('amount must be a positive number');
    await q(
      `insert into budgets (category_id, month, amount) values ($1, $2, $3) on conflict (category_id, month) do update set amount = excluded.amount`,
      [category_id, start, round(v)],
    );
  }
  return { ok: true };
}));

// ---- cash flow & trends -----------------------------------------------------

api.get('/cashflow', wrap(async (req) => {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const start = shiftMonth(today().slice(0, 7) + '-01', -(months - 1));
  const rows = await q(
    `select to_char(t.date, 'YYYY-MM') as month,
            coalesce(-sum(t.amount) filter (where g.kind = 'income'), 0) as income,
            coalesce(sum(t.amount) filter (where g.kind = 'expense'), 0) as expenses
       ${FLOW} and t.date >= $1 group by 1 order by 1`,
    [start],
  );
  const by = new Map(rows.map((r) => [r.month, r]));
  const out = [];
  for (let m = start; out.length < months; m = shiftMonth(m, 1)) {
    const r = by.get(m.slice(0, 7)) || { income: 0, expenses: 0 };
    out.push({ month: m.slice(0, 7), income: round(r.income), expenses: round(r.expenses), net: round(r.income - r.expenses) });
  }
  return out;
}));

api.get('/breakdown', wrap(async (req) => {
  const { start, end } = monthOf(req.query.month);
  const to = req.query.months ? shiftMonth(start, Number(req.query.months)) : end;
  const categories = await q(
    `select c.id as category_id, c.name, c.emoji, c.color, g.name as group_name, g.kind, sum(t.amount) as total, count(*)::int as n
       ${FLOW} and g.kind <> 'transfer' and t.date >= $1 and t.date < $2 group by c.id, g.id order by abs(sum(t.amount)) desc`,
    [start, to],
  );
  const merchants = await q(
    `select coalesce(t.display_name, t.merchant_name, t.name) as name, max(t.logo_url) as logo_url, sum(t.amount) as total, count(*)::int as n,
            (array_agg(t.category_id order by t.date desc))[1] as category_id
       ${FLOW} and g.kind = 'expense' and t.date >= $1 and t.date < $2 group by 1 order by sum(t.amount) desc limit 10`,
    [start, to],
  );
  return { from: start, to, categories: categories.map((c) => ({ ...c, total: round(c.total) })), merchants: merchants.map((m) => ({ ...m, total: round(m.total) })) };
}));

api.get('/categories/:id/trend', wrap(async (req) => {
  const months = Math.min(Number(req.query.months) || 6, 24);
  const start = shiftMonth(today().slice(0, 7) + '-01', -(months - 1));
  const rows = await q(
    `select to_char(t.date, 'YYYY-MM') as month, sum(t.amount) as total ${FLOW} and t.category_id = $1 and t.date >= $2 group by 1`,
    [req.params.id, start],
  );
  const by = new Map(rows.map((r) => [r.month, r.total]));
  const out = [];
  for (let m = start; out.length < months; m = shiftMonth(m, 1)) out.push({ month: m.slice(0, 7), total: round(by.get(m.slice(0, 7)) || 0) });
  return out;
}));

// ---- recurring --------------------------------------------------------------

const isoDate = (v, name) => {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${name} must be YYYY-MM-DD`);
  return v;
};
// Validates the editable parts of a series; `base` fills whatever the body leaves out.
function seriesFields(b, base = {}) {
  const pick = (k) => (b[k] !== undefined ? b[k] : base[k]);
  const out = {};
  out.name = String(pick('name') ?? '').trim().slice(0, 80);
  if (!out.name) throw bad('name required');
  out.kind = pick('kind') ?? 'expense';
  if (!['expense', 'income'].includes(out.kind)) throw bad('kind must be expense or income');
  out.amount = round(Math.abs(Number(pick('amount'))));
  if (!Number.isFinite(out.amount) || out.amount <= 0 || out.amount > 1e8) throw bad('amount must be a positive number');
  out.every = Number(pick('every') ?? 1);
  out.unit = pick('unit') ?? 'month';
  if (!UNITS.includes(out.unit)) throw bad('unit must be day, week, month or year');
  const maxEvery = { day: 400, week: 104, month: 60, year: 10 }[out.unit];
  if (!Number.isInteger(out.every) || out.every < 1 || out.every > maxEvery) throw bad(`every must be 1–${maxEvery} ${out.unit}s`);
  let days = pick('month_days');
  if (out.unit === 'day' || out.unit === 'week' || days == null || (Array.isArray(days) && !days.length)) days = null;
  else {
    days = [...new Set((Array.isArray(days) ? days : [days]).map(Number))].sort((x, y) => x - y);
    if (days.length > 2 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) throw bad('month_days: one or two days, 1–31');
  }
  out.month_days = days;
  out.anchor_date = isoDate(pick('anchor_date'), 'anchor_date');
  if (!out.anchor_date) throw bad('anchor_date required (a charge date)');
  out.ends_on = isoDate(pick('ends_on'), 'ends_on');
  out.amount_mode = pick('amount_mode') ?? 'fixed';
  if (!['fixed', 'estimate'].includes(out.amount_mode)) throw bad('amount_mode must be fixed or estimate');
  out.share_pct = Number(pick('share_pct') ?? 100);
  if (!Number.isFinite(out.share_pct) || out.share_pct <= 0 || out.share_pct > 100) throw bad('share_pct must be 1–100');
  out.budget_mode = pick('budget_mode') ?? 'auto';
  if (!['auto', 'due', 'set_aside'].includes(out.budget_mode)) throw bad('budget_mode must be auto, due or set_aside');
  out.category_id = pick('category_id') ?? null;
  out.account_id = pick('account_id') ?? null;
  return out;
}

api.get('/recurring', wrap(async () => {
  const rows = await q(
    `select r.*, coalesce(c.name, 'Uncategorized') as category_name, c.emoji, c.color,
            (select count(*) from transactions t where t.recurring_id = r.id)::int as tx_count
       from recurring r left join categories c on c.id = r.category_id
      order by r.status, r.next_date nulls last`,
  );
  const defaults = await recurringDefaults();
  const { start, end } = monthOf();
  const t0 = today();
  return rows.map((r) => {
    const mode = r.kind === 'expense' ? effectiveMode(r, defaults) : 'due';
    const p = monthPlan(r, start, mode);
    return {
      ...r, mode, long: isLong(r), ended: !!(r.ends_on && r.ends_on <= t0),
      per_month: round(myAmount(r) * perMonth(r)), my_amount: round(myAmount(r)),
      month_dates: occurrences(r, start, end),
      plan: { planned: p.planned, fund: p.fund, target: p.target ?? null, renews: p.renews ?? r.next_date },
    };
  });
}));

api.get('/recurring/settings', wrap(async () => recurringDefaults()));
api.put('/recurring/settings', wrap(async (req) => {
  const v = { ...(await recurringDefaults()) };
  for (const k of ['long', 'short']) if (req.body[k] !== undefined) {
    if (!MODES.includes(req.body[k])) throw bad(`${k} must be due or set_aside`);
    v[k] = req.body[k];
  }
  await q(`insert into settings (key, value) values ('recurring_budget', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify(v)]);
  return v;
}));

api.post('/recurring', wrap(async (req) => {
  const fromId = req.body.from_transaction_id;
  const txn = fromId ? await one('select id, date, amount, name, merchant_name, display_name, logo_url, category_id, account_id from transactions where id = $1', [fromId]) : null;
  if (fromId && !txn) throw bad('transaction not found', 404);
  const base = txn ? { name: txn.display_name || txn.merchant_name || txn.name, kind: txn.amount < 0 ? 'income' : 'expense', amount: Math.abs(txn.amount),
    anchor_date: txn.date, category_id: txn.category_id, account_id: txn.account_id } : {};
  const f = seriesFields(req.body, base);
  const id = await tx((t) => createSeries(t, f, txn));
  return one('select * from recurring where id = $1', [id]);
}));

api.patch('/recurring/:id', wrap(async (req) => {
  const cur = await one('select * from recurring where id = $1', [req.params.id]);
  if (!cur) throw bad('not found', 404);
  const b = req.body;
  if (b.status && !['active', 'ignored'].includes(b.status)) throw bad('bad status');
  // Price change suggested by a new payment: accept (becomes the amount) or dismiss (not suggested again for that price).
  if (b.accept_suggestion && cur.suggested_amount != null) b.amount = cur.suggested_amount;
  const f = seriesFields({ ...b, anchor_date: b.next_date ?? b.anchor_date }, cur);
  const row = await tx(async (t) => {
    const r = await t.one(
      `update recurring set status = coalesce($2, status), name = $3, category_id = $4, kind = $5, amount = $6, every = $7, unit = $8,
         month_days = $9, anchor_date = $10, ends_on = $11, amount_mode = $12, share_pct = $13, budget_mode = $14, account_id = $15,
         suggested_amount = case when $16::bool or $17::bool or $6 <> amount then null else suggested_amount end,
         dismissed_amount = case when $17::bool then suggested_amount else dismissed_amount end,
         user_edited = true, updated_at = now()
       where id = $1 returning id`,
      [cur.id, b.status ?? null, f.name, f.category_id, f.kind, f.amount, f.every, f.unit, f.month_days, f.anchor_date, f.ends_on, f.amount_mode,
       f.share_pct, f.budget_mode, f.account_id, !!b.accept_suggestion, !!b.dismiss_suggestion],
    );
    await settle(t, [r.id]);
    return r;
  });
  return one('select * from recurring where id = $1', [row.id]);
}));

// Only series you added can be deleted; detected ones would come back, so they're hidden instead.
api.delete('/recurring/:id', wrap(async (req) => {
  const cur = await one('select source from recurring where id = $1', [req.params.id]);
  if (!cur) throw bad('not found', 404);
  if (cur.source !== 'manual') throw bad('detected series can be hidden, not deleted');
  await q('delete from recurring where id = $1', [req.params.id]);
  return { ok: true };
}));

api.post('/recurring/refresh', wrap(async () => ({ found: await refreshRecurring() })));

// ---- rules ------------------------------------------------------------------

const RULE_TX = 'select id, account_id, date, name, merchant_name, display_name, amount, category_id, category_locked from transactions order by date desc, id desc';

api.get('/rules', wrap(async () => {
  const rules = await q(
    `select r.*, c.name as category_name, c.emoji, c.color, coalesce(a.display_name, a.name) as account_label,
            (select count(*) from goal_allocations x where x.rule_id = r.id)::int as allocations_made
       from rules r left join categories c on c.id = r.set_category_id left join accounts a on a.id = r.account_id order by r.id desc`,
  );
  const txns = await q(RULE_TX);
  return rules.map((r) => {
    const hits = txns.filter((t) => ruleMatches(r, t));
    return { ...r, matches: hits.length, last_match: hits[0]?.date || null, typical_amount: hits.length ? round(Math.abs(hits[0].amount)) : null };
  });
}));

// Live preview while editing a rule: how many transactions it would touch, and a few examples.
api.post('/rules/preview', wrap(async (req) => {
  const { field = 'merchant', op = 'contains', pattern = '', amount_min = null, amount_max = null, account_id = null, direction = 'any' } = req.body;
  const rule = { field, op, pattern: String(pattern).trim(), amount_min: amount_min === '' ? null : amount_min, amount_max: amount_max === '' ? null : amount_max, account_id: account_id ? Number(account_id) : null, direction };
  if (!rule.pattern && !rule.account_id && direction === 'any') return { count: 0, locked: 0, sample: [] };
  const hits = (await q(RULE_TX)).filter((t) => ruleMatches(rule, t));
  return { count: hits.length, locked: hits.filter((t) => t.category_locked).length, sample: hits.slice(0, 5), typical_amount: hits.length ? round(Math.abs(hits[0].amount)) : null };
}));

function cleanSplits(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('goal_splits must be a list');
  return list.map((x) => ({ goal_id: Number(x.goal_id), amount: round(x.amount) })).filter((x) => x.goal_id && x.amount > 0);
}

api.patch('/rules/:id', wrap(async (req) => {
  const { field, op, pattern, amount_min, amount_max, set_category_id, set_display_name, mark_reviewed, account_id, direction } = req.body;
  if (direction !== undefined && !['any', 'in', 'out'].includes(direction)) throw bad('bad direction');
  if (account_id !== undefined || direction !== undefined || req.body.goal_splits !== undefined)
    await q(
      `update rules set account_id = case when $2::bool then $3::int else account_id end, direction = coalesce($4, direction),
         goal_splits = coalesce($5::jsonb, goal_splits) where id = $1`,
      [req.params.id, account_id !== undefined, account_id || null, direction ?? null, req.body.goal_splits !== undefined ? JSON.stringify(cleanSplits(req.body.goal_splits)) : null],
    );
  const row = await one(
    `update rules set field = coalesce($2, field), op = coalesce($3, op), pattern = coalesce(trim($4), pattern),
       amount_min = case when $5::bool then $6::numeric else amount_min end, amount_max = case when $7::bool then $8::numeric else amount_max end,
       set_category_id = case when $9::bool then $10::int else set_category_id end,
       set_display_name = case when $11::bool then nullif(trim($12), '') else set_display_name end,
       mark_reviewed = coalesce($13, mark_reviewed)
     where id = $1 returning *`,
    [req.params.id, field ?? null, op ?? null, pattern ?? null, amount_min !== undefined, amount_min === '' ? null : amount_min ?? null,
     amount_max !== undefined, amount_max === '' ? null : amount_max ?? null, set_category_id !== undefined, set_category_id ?? null,
     set_display_name !== undefined, set_display_name ?? null, mark_reviewed ?? null],
  );
  if (!row) throw bad('not found', 404);
  if (!row.set_category_id && !row.set_display_name && !row.mark_reviewed && !row.goal_splits.length) throw bad('a rule needs something to do');
  if (!row.pattern && !row.account_id && row.direction === 'any') throw bad('a rule needs a merchant pattern, an account, or a direction');
  return row;
}));

api.post('/rules', wrap(async (req) => {
  const { field = 'merchant', op = 'contains', pattern = '', amount_min = null, amount_max = null, set_category_id = null, set_display_name = null, mark_reviewed = false, account_id = null, direction = 'any' } = req.body;
  const splits = cleanSplits(req.body.goal_splits);
  if (!String(pattern).trim() && !account_id && direction === 'any') throw bad('a rule needs a merchant pattern, an account, or a direction');
  if (!['any', 'in', 'out'].includes(direction)) throw bad('bad direction');
  if (!set_category_id && !set_display_name?.trim() && !mark_reviewed && !splits.length) throw bad('a rule needs something to do');
  return one(
    `insert into rules (field, op, pattern, amount_min, amount_max, set_category_id, set_display_name, mark_reviewed, account_id, direction, goal_splits)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [field, op, String(pattern).trim(), amount_min, amount_max, set_category_id, set_display_name?.trim() || null, !!mark_reviewed, account_id || null, direction, JSON.stringify(splits)],
  );
}));

api.delete('/rules/:id', wrap(async (req) => {
  await q('delete from rules where id = $1', [req.params.id]);
  return { ok: true };
}));

// Apply a rule to existing transactions (leaves ones whose category the user picked by hand).
api.post('/rules/:id/apply', wrap(async (req) => {
  const rule = await one('select * from rules where id = $1', [req.params.id]);
  if (!rule) throw bad('not found', 404);
  if (req.body.since && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.since)) throw bad('since must be YYYY-MM-DD');
  const allocated = req.body.since ? await applyGoalSplits({ ruleId: rule.id, since: req.body.since }) : 0;
  const txns = await q('select id, account_id, name, merchant_name, amount, category_locked from transactions');
  const ids = txns.filter((t) => ruleMatches(rule, t)).map((t) => t.id);
  if (!ids.length || (!rule.set_category_id && !rule.set_display_name && !rule.mark_reviewed)) return { updated: 0, allocated };
  const res = await q(
    `update transactions set
       category_id = case when $2::int is not null and not category_locked then $2 else category_id end,
       display_name = coalesce($3, display_name),
       reviewed = reviewed or $4, updated_at = now()
     where id = any($1::bigint[]) returning id`,
    [ids, rule.set_category_id, rule.set_display_name, rule.mark_reviewed],
  );
  return { updated: res.length, allocated };
}));

// ---- Plaid ------------------------------------------------------------------

api.get('/plaid/items', wrap(async () =>
  q(`select i.id, i.institution_name, i.institution_color, i.institution_logo, i.status, i.error_code, i.error_message, i.last_synced_at, i.bank_updated_at, i.bank_failed_at, i.created_at,
            (select count(*) from accounts a where a.item_id = i.id)::int as accounts
       from plaid_items i order by i.created_at`),
));

api.post('/plaid/link-token', wrap(async (req) => ({ link_token: await plaid.createLinkToken({ itemId: req.body.item_id || null }) })));

api.post('/plaid/exchange', wrap(async (req) => {
  if (!req.body.public_token) throw bad('public_token required');
  const id = await plaid.exchangePublicToken(req.body.public_token, req.body.metadata);
  return { id };
}));

api.post('/plaid/items/:id/sync', wrap(async (req) => plaid.syncItem(Number(req.params.id))));
api.post('/plaid/items/:id/refresh', wrap(async (req) => plaid.refreshItem(Number(req.params.id))));
api.post('/plaid/items/:id/repaired', wrap(async (req) => {
  await q(`update plaid_items set status = 'ok', error_code = null, error_message = null where id = $1`, [req.params.id]);
  return plaid.syncItem(Number(req.params.id));
}));
api.post('/plaid/sync', wrap(async () => ({ results: await plaid.syncAll() })));
api.delete('/plaid/items/:id', requireFreshAuth, wrap(async (req) => ({ ok: await plaid.removeItem(Number(req.params.id)) })));

// ---- demo data --------------------------------------------------------------

api.post('/demo', wrap(async () => {
  const r = await loadDemo();
  audit('demo_loaded');
  return r;
}));
api.delete('/demo', wrap(async () => {
  await removeDemo();
  audit('demo_removed');
  return { ok: true };
}));

// ---- export & audit ---------------------------------------------------------

api.get('/export/transactions.csv', async (req, res, next) => {
  try {
    const rows = await q(
      `select t.date, coalesce(t.display_name, t.merchant_name, t.name) as name, t.name as original, t.amount,
              coalesce((select 'Split: ' || string_agg(sc.name || ' ' || s.amount::text, '; ' order by s.sort, s.id)
                          from transaction_splits s join categories sc on sc.id = s.category_id where s.transaction_id = t.id), c.name) as category,
              coalesce(a.display_name, a.name) as account, t.pending, t.reviewed, t.excluded, t.notes, array_to_string(t.tags, ';') as tags
         from transactions t join accounts a on a.id = t.account_id left join categories c on c.id = t.category_id order by t.date desc, t.id desc`,
    );
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    const head = Object.keys(rows[0] || { date: 0, name: 0, original: 0, amount: 0, category: 0, account: 0, pending: 0, reviewed: 0, excluded: 0, notes: 0, tags: 0 });
    res.type('text/csv').attachment(`tally-transactions-${today()}.csv`);
    res.send([head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n'));
  } catch (e) {
    next(e);
  }
});

api.get('/audit', wrap(async () => readAudit(100)));
