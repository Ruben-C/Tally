// Goals & buckets: balances, account allocations, automatic monthly contributions, history and projections.
//
// A goal's balance = Σ allocations from linked accounts + Σ its own entries.
//   allocation modes: full (whole balance), amount (fixed dollars, capped at the balance), percent (a share).
//   entries: money set aside outside linked accounts, automatic monthly contributions, purchases paid from it.
import { Router } from 'express';
import { q, one, tx } from './db.js';
import { iso } from './balances.js';

export const goals = Router();

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => out !== undefined && res.json(out), next);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthStart = (d = new Date()) => iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
const addMonths = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
const monthsBetween = (a, b) => {
  const x = new Date(a + 'T00:00:00Z'), y = new Date(b + 'T00:00:00Z');
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
};
const ASSET_TYPES = ['depository', 'investment', 'other'];
// For fixed-amount links, the allocated amount is the running total of the allocation ledger.
const LEDGER_AMOUNT = `case when ga.mode = 'amount' then (select coalesce(sum(x.amount), 0) from goal_allocations x where x.goal_id = ga.goal_id and x.account_id = ga.account_id) end`;

export function allocValue(link, balance) {
  const bal = Math.max(Number(balance) || 0, 0);
  if (link.mode === 'full') return round(bal);
  if (link.mode === 'percent') return round((bal * Number(link.percent)) / 100);
  return round(Math.min(Number(link.amount) || 0, bal));
}

async function loadLinks(goalId = null) {
  return q(
    `select ga.id, ga.goal_id, ga.account_id, ga.mode, ga.percent, ga.created_at, ${LEDGER_AMOUNT} as amount,
            a.current_balance as account_balance, coalesce(a.display_name, a.name) as account_label, a.mask, a.type as account_type,
            a.institution_name, a.hidden
       from goal_accounts ga join accounts a on a.id = ga.account_id
      ${goalId ? 'where ga.goal_id = $1' : ''} order by ga.id`,
    goalId ? [goalId] : [],
  );
}

// Adds any missing automatic monthly contributions (idempotent: one per goal per month), stopping once a
// target goal is fully funded. Only for goals funded by hand; account-funded goals grow in the bank.
export async function catchUpAuto() {
  const list = await q(
    `select * from goals g where auto_contribute and monthly_amount > 0 and not archived
       and not exists (select 1 from goal_accounts ga where ga.goal_id = g.id)`,
  );
  const now = monthStart();
  for (const g of list) {
    const last = await one(`select max(month) as m from goal_entries where goal_id = $1 and kind = 'auto'`, [g.id]);
    let m = last.m ? addMonths(last.m, 1) : monthStart(new Date(g.created_at));
    let bal = (await one('select coalesce(sum(amount), 0) as b from goal_entries where goal_id = $1', [g.id])).b;
    for (let i = 0; m <= now && i < 120; i++, m = addMonths(m, 1)) {
      if (g.kind === 'target' && g.target_amount != null && bal >= g.target_amount) break;
      const amt = g.kind === 'target' && g.target_amount != null ? Math.min(g.monthly_amount, round(g.target_amount - bal)) : g.monthly_amount;
      await q(
        `insert into goal_entries (goal_id, date, amount, kind, month, note) values ($1, $2, $3, 'auto', $2, 'Monthly contribution')
         on conflict do nothing`,
        [g.id, m, amt],
      );
      bal += Number(amt);
    }
  }
}

// Current balance and where it comes from, for every goal.
async function balances() {
  const entries = await q(
    `select goal_id, sum(amount) as total, sum(amount) filter (where amount > 0) as added, -sum(amount) filter (where amount < 0) as spent,
            max(date) as last_date, sum(amount) filter (where date >= date_trunc('month', current_date) - interval '3 months') as recent
       from goal_entries group by 1`,
  );
  const byGoal = new Map(entries.map((e) => [e.goal_id, e]));
  const links = await loadLinks();
  const out = new Map();
  const get = (id) => {
    if (!out.has(id)) {
      const e = byGoal.get(id);
      out.set(id, { entries_total: round(e?.total), added: round(e?.added), spent: round(e?.spent), last_date: e?.last_date || null, recent3: Number(e?.recent) || 0, sources: [] });
    }
    return out.get(id);
  };
  for (const e of entries) get(e.goal_id);
  for (const l of links) {
    get(l.goal_id).sources.push({
      account_id: l.account_id, label: l.account_label, mask: l.mask, institution: l.institution_name, type: l.account_type,
      mode: l.mode, amount: l.amount, percent: l.percent, account_balance: round(l.account_balance), value: allocValue(l, l.account_balance),
      short: l.mode === 'amount' && Number(l.amount) > Math.max(Number(l.account_balance) || 0, 0), // the account holds less than allocated
    });
  }
  for (const b of out.values()) b.balance = round(b.sources.reduce((s, x) => s + x.value, 0) + b.entries_total);
  return out;
}

// Month-end balances for the last N months: each allocation from its account's history, plus entries.
async function series(g, links, months = 12) {
  const start = addMonths(monthStart(), -(months - 1));
  const rows = await q(
    `select to_char(m, 'YYYY-MM') as month, m::date as m,
            (select coalesce(sum(amount), 0) from goal_entries e where e.goal_id = $1 and e.date < (m + interval '1 month')) as entries
       from generate_series($2::date, date_trunc('month', current_date), interval '1 month') m`,
    [g.id, start],
  );
  const out = rows.map((r) => ({ month: r.month, m: r.m, balance: Number(r.entries) }));
  for (const l of links) {
    const hist = await q(
      `select to_char(m, 'YYYY-MM') as month,
              coalesce((select balance from balance_history h where h.account_id = $1 and h.date < (m + interval '1 month') order by date desc limit 1),
                       (select balance from balance_history h where h.account_id = $1 order by date limit 1)) as balance
         from generate_series($2::date, date_trunc('month', current_date), interval '1 month') m`,
      [l.account_id, start],
    );
    // Fixed amounts follow the allocation ledger (how much had been allocated by each month end);
    // shares and full balances follow the account's own history.
    const ledger = l.mode === 'amount'
      ? await q(`select date, amount from goal_allocations where goal_id = $1 and account_id = $2 order by date`, [g.id, l.account_id])
      : [];
    hist.forEach((h, i) => {
      if (l.mode === 'amount') {
        const end = addMonths(out[i].m, 1);
        const allocated = ledger.filter((e) => e.date < end).reduce((s, e) => s + Number(e.amount), 0);
        out[i].balance += allocValue({ mode: 'amount', amount: allocated }, h.balance ?? 0);
      } else out[i].balance += allocValue(l, h.balance ?? 0);
    });
  }
  return out.map(({ month, balance }) => ({ month, balance: round(balance) }));
}

// What the budget sets aside for goals each month: active goals' monthly amounts, leaving out finished ones (marked
// complete, or a target goal that has reached its target; automatic contributions stop there too).
export async function plannedSaving() {
  const list = await q('select * from goals where not archived and completed_at is null and monthly_amount > 0');
  if (!list.length) return 0;
  const bal = await balances();
  const reached = (g) => g.kind === 'target' && g.target_amount != null && (bal.get(g.id)?.balance ?? 0) >= Number(g.target_amount);
  return round(list.filter((g) => !reached(g)).reduce((s, g) => s + Number(g.monthly_amount), 0));
}

// Status for target goals: done / on track / behind, how much per month is needed, and when it'll be reached.
function plan(g, b, hist = []) {
  const balance = round(b?.balance);
  const linked = (b?.sources || []).length > 0;
  const out = { balance, added: round(b?.added), spent: round(b?.spent), last_activity: b?.last_date || null, sources: b?.sources || [], entries_total: round(b?.entries_total) };
  if (g.kind !== 'target' || !g.target_amount) {
    return { ...out, progress: g.target_amount ? Math.min(balance / g.target_amount, 1) : null, status: 'bucket' };
  }
  const remaining = round(Math.max(g.target_amount - balance, 0));
  const progress = Math.min(balance / g.target_amount, 1);
  if (remaining <= 0) return { ...out, progress: 1, remaining: 0, status: 'done' };
  const fresh = !linked && !(b?.added > 0);
  // Pace: the planned monthly amount, else the recent trend (account growth + contributions over 3 months).
  const trend = linked && hist.length >= 4 ? hist.at(-1).balance - hist.at(-4).balance : b?.recent3 || 0;
  const pace = g.monthly_amount > 0 ? Number(g.monthly_amount) : Math.max(round(trend / 3), 0);
  const thisMonth = monthStart();
  const projected = pace > 0 ? addMonths(thisMonth, Math.ceil(remaining / pace)) : null;
  let needed = null, status = 'no_plan';
  if (g.target_date) {
    const monthsLeft = Math.max(monthsBetween(thisMonth, g.target_date), 1);
    needed = round(remaining / monthsLeft);
    status = g.target_date < iso(new Date()) ? 'overdue' : fresh ? 'new' : pace >= needed - 0.5 ? 'on_track' : 'behind';
  } else if (pace > 0) status = fresh ? 'new' : 'on_track';
  return { ...out, progress, remaining, pace: round(pace), needed_monthly: needed, projected_date: projected, status };
}

// How each account's balance is split across goals, and what's still free.
async function allocations() {
  const accounts = await q(
    `select id, coalesce(display_name, name) as label, mask, type, institution_name, current_balance, hidden
       from accounts where type = any($1) order by type, current_balance desc nulls last`,
    [ASSET_TYPES],
  );
  const links = await q(
    `select ga.goal_id, ga.account_id, ga.mode, ga.percent, ${LEDGER_AMOUNT} as amount, g.name, g.emoji, g.color
       from goal_accounts ga join goals g on g.id = ga.goal_id where not g.archived`,
  );
  return accounts.map((a) => {
    const mine = links.filter((l) => l.account_id === a.id).map((l) => ({
      goal_id: l.goal_id, name: l.name, emoji: l.emoji, color: l.color, mode: l.mode, amount: l.amount, percent: l.percent, value: allocValue(l, a.current_balance),
    }));
    const balance = round(Math.max(Number(a.current_balance) || 0, 0));
    const allocated = round(mine.reduce((s, l) => s + l.value, 0));
    const full = mine.some((l) => l.mode === 'full');
    return { account_id: a.id, label: a.label, mask: a.mask, type: a.type, institution: a.institution_name, hidden: a.hidden, balance, allocated, free: round(balance - allocated), over: allocated > balance + 0.5 || (full && mine.length > 1), goals: mine };
  });
}

goals.get('/goals/allocations', wrap(async () => allocations()));

goals.get('/goals', wrap(async () => {
  await catchUpAuto();
  const list = await q('select * from goals order by archived, sort, id');
  const bal = await balances();
  const links = await loadLinks();
  const out = [];
  for (const g of list) {
    const mine = links.filter((l) => l.goal_id === g.id);
    const history = await series(g, mine, 6);
    out.push({ ...g, ...plan(g, bal.get(g.id), history), history });
  }
  const active = out.filter((g) => !g.archived);
  const alloc = await allocations();
  const cash = alloc.filter((a) => a.type === 'depository' && !a.hidden);
  return {
    goals: out,
    totals: {
      saved: round(active.reduce((s, g) => s + g.balance, 0)),
      // Same as the budget's goal saving (plannedSaving): finished goals don't need more.
      monthly: round(active.filter((g) => !g.completed_at && g.status !== 'done').reduce((s, g) => s + (Number(g.monthly_amount) || 0), 0)),
      from_accounts: round(active.reduce((s, g) => s + g.sources.reduce((x, y) => x + y.value, 0), 0)),
      set_aside: round(active.reduce((s, g) => s + g.entries_total, 0)),
      cash: round(cash.reduce((s, a) => s + a.balance, 0)),
    },
    accounts: alloc.filter((a) => a.goals.length),
  };
}));

goals.get('/goals/:id', wrap(async (req) => {
  await catchUpAuto();
  const g = await one('select * from goals where id = $1', [req.params.id]);
  if (!g) throw bad('not found', 404);
  const entries = await q(
    `select e.*, coalesce(t.display_name, t.merchant_name, t.name) as txn_label, t.category_id as txn_category_id
       from goal_entries e left join transactions t on t.id = e.transaction_id
      where e.goal_id = $1 and (e.amount <> 0 or e.transaction_id is not null) order by e.date desc, e.id desc limit 200`,
    [g.id],
  );
  const allocations = await q(
    `select x.*, coalesce(a.display_name, a.name) as account_label, r.pattern as rule_pattern
       from goal_allocations x join accounts a on a.id = x.account_id left join rules r on r.id = x.rule_id
      where x.goal_id = $1 order by x.date desc, x.id desc limit 200`,
    [g.id],
  );
  const rules = await q(
    `select r.id, r.pattern, r.direction, coalesce(a.display_name, a.name) as account_label, (s->>'amount')::numeric as amount
       from rules r cross join jsonb_array_elements(r.goal_splits) s left join accounts a on a.id = r.account_id
      where (s->>'goal_id')::int = $1`,
    [g.id],
  );
  const history = await series(g, await loadLinks(g.id), 12);
  return { ...g, ...plan(g, (await balances()).get(g.id), history), history, entries, allocations, rules };
}));

function clean(b, partial = false) {
  const out = {};
  const num = (v) => (v === '' || v == null ? null : Number(v));
  if (!partial || b.kind !== undefined) {
    if (!['target', 'bucket'].includes(b.kind)) throw bad('kind must be target or bucket');
    out.kind = b.kind;
  }
  if (!partial || b.name !== undefined) {
    out.name = String(b.name || '').trim().slice(0, 60);
    if (!out.name) throw bad('name required');
  }
  for (const k of ['emoji', 'color']) if (b[k] !== undefined) out[k] = String(b[k]).slice(0, 16);
  for (const k of ['target_amount', 'monthly_amount']) {
    if (b[k] === undefined) continue;
    const v = num(b[k]);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 1e9)) throw bad(`${k} must be a positive amount`);
    out[k] = v;
  }
  if (b.target_date !== undefined) {
    if (b.target_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.target_date)) throw bad('target_date must be YYYY-MM-DD');
    out.target_date = b.target_date || null;
  }
  if (b.auto_contribute !== undefined) out.auto_contribute = !!b.auto_contribute;
  if (b.archived !== undefined) out.archived = !!b.archived;
  return out;
}

function cleanLinks(list) {
  if (!Array.isArray(list)) throw bad('accounts must be a list');
  const seen = new Set();
  return list.map((l) => {
    const account_id = Number(l.account_id);
    if (!account_id || seen.has(account_id)) throw bad('each account can be linked once');
    seen.add(account_id);
    const mode = ['full', 'amount', 'percent'].includes(l.mode) ? l.mode : null;
    if (!mode) throw bad('mode must be full, amount or percent');
    const amount = mode === 'amount' ? Number(l.amount) : null;
    const percent = mode === 'percent' ? Number(l.percent) : null;
    if (mode === 'amount' && !(amount >= 0 && amount < 1e10)) throw bad('enter an amount for each account');
    if (mode === 'percent' && !(percent > 0 && percent <= 100)) throw bad('percent must be between 0 and 100');
    return { account_id, mode, amount, percent };
  });
}

// Replaces a goal's account links, keeping the original link date for accounts that stay linked.
async function setLinks(t, goalId, links) {
  const ids = links.map((l) => l.account_id);
  const types = ids.length ? await t.q('select id, type from accounts where id = any($1::int[])', [ids]) : [];
  for (const l of links) {
    const a = types.find((x) => x.id === l.account_id);
    if (!a) throw bad('account not found', 404);
    if (!ASSET_TYPES.includes(a.type)) throw bad('only cash, investment and other asset accounts can fund a goal');
  }
  // Unlinked accounts and links that stop being fixed amounts lose their ledger.
  await t.q(
    `delete from goal_allocations x where x.goal_id = $1 and (not (x.account_id = any($2::int[])) or x.account_id = any($3::int[]))`,
    [goalId, ids, links.filter((l) => l.mode !== 'amount').map((l) => l.account_id)],
  );
  await t.q('delete from goal_accounts where goal_id = $1 and not (account_id = any($2::int[]))', [goalId, ids]);
  for (const l of links) {
    await t.q(
      `insert into goal_accounts (goal_id, account_id, mode, amount, percent) values ($1,$2,$3,$4,$5)
       on conflict (goal_id, account_id) do update set mode = excluded.mode, amount = excluded.amount, percent = excluded.percent`,
      [goalId, l.account_id, l.mode, l.amount, l.percent],
    );
    if (l.mode === 'amount') {
      // Editing the total records the difference in the ledger, so history shows when it changed.
      const cur = await t.one('select coalesce(sum(amount), 0) as v from goal_allocations where goal_id = $1 and account_id = $2', [goalId, l.account_id]);
      const delta = round(l.amount - Number(cur.v));
      if (Math.abs(delta) >= 0.005)
        await t.q(`insert into goal_allocations (goal_id, account_id, amount, note) values ($1,$2,$3,$4)`, [goalId, l.account_id, delta, Number(cur.v) ? 'Adjusted' : 'Initial allocation']);
    }
  }
}

// Allocate more (or less) of an account to a goal. Creates a fixed-amount link if there isn't one.
export async function allocate(t, { goalId, accountId, amount, date = null, note = null, transactionId = null, ruleId = null }) {
  const link = await t.one('select mode from goal_accounts where goal_id = $1 and account_id = $2', [goalId, accountId]);
  if (link && link.mode !== 'amount') return { skipped: link.mode }; // already counts all / a share of this account
  if (!link) {
    const a = await t.one('select type from accounts where id = $1', [accountId]);
    if (!a) throw bad('account not found', 404);
    if (!ASSET_TYPES.includes(a.type)) throw bad('only cash, investment and other asset accounts can fund a goal');
    await t.q(`insert into goal_accounts (goal_id, account_id, mode, amount) values ($1,$2,'amount',0)`, [goalId, accountId]);
  }
  const cur = await t.one('select coalesce(sum(amount), 0) as v from goal_allocations where goal_id = $1 and account_id = $2', [goalId, accountId]);
  const delta = round(Math.max(Number(amount), -Number(cur.v))); // can't release more than is allocated
  if (!delta) return { skipped: 'nothing' };
  const row = await t.one(
    `insert into goal_allocations (goal_id, account_id, date, amount, note, transaction_id, rule_id)
     values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7) on conflict do nothing returning *`,
    [goalId, accountId, date, delta, note, transactionId, ruleId],
  );
  return row || { skipped: 'duplicate' };
}

// Rules with goal splits: allocate matching money to goals, in the rule's goal account if it has one (money that is
// moved on automatically), otherwise in the account it landed in. Idempotent per
// (transaction, goal). `txnIds` limits to specific (e.g. newly synced) transactions; `since` to a date range.
export async function applyGoalSplits({ txnIds = null, ruleId = null, since = null } = {}) {
  const { ruleMatches } = await import('./categorize.js');
  const rules = await q(`select * from rules where jsonb_array_length(goal_splits) > 0 ${ruleId ? 'and id = $1' : ''}`, ruleId ? [ruleId] : []);
  if (!rules.length) return 0;
  const where = [], params = [];
  if (txnIds) { params.push(txnIds); where.push(`id = any($${params.length}::bigint[])`); }
  if (since) { params.push(since); where.push(`date >= $${params.length}::date`); }
  if (!txnIds && !since) return 0; // never back-fill all history implicitly
  const txns = await q(`select id, account_id, date, amount, name, merchant_name, display_name from transactions where ${where.join(' and ')}`, params);
  let n = 0;
  await tx(async (t) => {
    for (const r of rules)
      for (const x of txns.filter((x) => ruleMatches(r, x)))
        for (const sp of r.goal_splits) {
          const goal = await t.one('select id, archived from goals where id = $1', [sp.goal_id]);
          if (!goal || goal.archived) continue;
          const out = await allocate(t, {
            goalId: goal.id, accountId: r.goal_account_id || x.account_id, amount: sp.amount, date: x.date,
            note: `From ${x.display_name || x.merchant_name || x.name}`, transactionId: x.id, ruleId: r.id,
          });
          if (out?.id) n++;
        }
  });
  return n;
}

goals.post('/goals', wrap(async (req) => {
  const g = clean(req.body);
  if (g.kind === 'target' && !g.target_amount) throw bad('a savings goal needs a target amount');
  const links = req.body.accounts ? cleanLinks(req.body.accounts) : [];
  return tx(async (t) => {
    const r = await t.one(
      `insert into goals (kind, name, emoji, color, target_amount, target_date, monthly_amount, auto_contribute, sort)
       values ($1,$2,coalesce($3,'🎯'),coalesce($4,'#7d7aff'),$5,$6,$7,$8,(select coalesce(max(sort),0)+1 from goals)) returning *`,
      [g.kind, g.name, g.emoji, g.color, g.target_amount, g.target_date, g.monthly_amount, !!g.auto_contribute && !links.length],
    );
    await setLinks(t, r.id, links);
    const start = Number(req.body.starting_amount) || 0;
    if (start > 0) await t.q(`insert into goal_entries (goal_id, amount, kind, note) values ($1, $2, 'initial', 'Starting balance')`, [r.id, start]);
    // With a starting balance, automatic contributions begin next month.
    if (r.auto_contribute && start > 0)
      await t.q(`insert into goal_entries (goal_id, date, amount, kind, month, note) values ($1, date_trunc('month', current_date), 0, 'auto', date_trunc('month', current_date), 'Monthly contribution') on conflict do nothing`, [r.id]);
    return r;
  });
}));

goals.patch('/goals/:id', wrap(async (req) => {
  const g = clean(req.body, true);
  if (req.body.completed !== undefined) g.completed_at = req.body.completed ? new Date().toISOString() : null;
  const links = req.body.accounts !== undefined ? cleanLinks(req.body.accounts) : null;
  if (links?.length) g.auto_contribute = false;
  return tx(async (t) => {
    const keys = Object.keys(g);
    const row = keys.length
      ? await t.one(`update goals set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [req.params.id, ...keys.map((k) => g[k])])
      : await t.one('select * from goals where id = $1', [req.params.id]);
    if (!row) throw bad('not found', 404);
    if (row.kind === 'target' && !row.target_amount) throw bad('a savings goal needs a target amount');
    if (links) await setLinks(t, row.id, links);
    return row;
  });
}));

goals.delete('/goals/:id', wrap(async (req) => {
  // Transactions that were "paid from" this goal go back to counting as normal spending.
  await tx(async (t) => {
    await t.q(`update transactions set excluded = false, updated_at = now() where id in (select transaction_id from goal_entries where goal_id = $1 and transaction_id is not null)`, [req.params.id]);
    await t.q('delete from goals where id = $1', [req.params.id]);
  });
  return { ok: true };
}));

// Add or take money. With transaction_id: "paid from this goal". The purchase is excluded from monthly spending
// (so it doesn't hit the budget twice). When the goal follows a whole account or a share of one, the purchase
// already lowers that balance, so it's linked without subtracting again.
goals.post('/goals/:id/entries', wrap(async (req) => {
  const g = await one('select * from goals where id = $1', [req.params.id]);
  if (!g) throw bad('not found', 404);
  const { transaction_id, note, date, exclude = true } = req.body;
  let amount = Number(req.body.amount);
  return tx(async (t) => {
    if (transaction_id) {
      const txn = await t.one('select id, amount, date, account_id from transactions where id = $1', [transaction_id]);
      if (!txn) throw bad('transaction not found', 404);
      const tracks = await t.one(
        `select exists(select 1 from goal_accounts where goal_id = $1 and account_id = $2 and mode in ('full', 'percent')) as x`,
        [g.id, txn.account_id],
      );
      if (tracks.x) amount = 0;
      else if (!Number.isFinite(amount) || amount === 0) amount = -Number(txn.amount);
      await t.q('delete from goal_entries where transaction_id = $1', [txn.id]); // move between goals
      const e = await t.one(
        `insert into goal_entries (goal_id, date, amount, kind, note, transaction_id) values ($1, $2, $3, 'transaction', $4, $5) returning *`,
        [g.id, txn.date, round(amount), note || (tracks.x ? 'Already reflected in the linked account' : null), txn.id],
      );
      if (exclude && txn.amount > 0) await t.q('update transactions set excluded = true, reviewed = true, updated_at = now() where id = $1', [txn.id]);
      return e;
    }
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e9) throw bad('amount required');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must be YYYY-MM-DD');
    return t.one(`insert into goal_entries (goal_id, date, amount, kind, note) values ($1, coalesce($2::date, current_date), $3, 'manual', $4) returning *`,
      [g.id, date || null, round(amount), note ? String(note).slice(0, 200) : null]);
  });
}));

goals.delete('/goals/:id/entries/:entry', wrap(async (req) => {
  await tx(async (t) => {
    const e = await t.one('delete from goal_entries where id = $1 and goal_id = $2 returning *', [req.params.entry, req.params.id]);
    if (e?.transaction_id) await t.q('update transactions set excluded = false, updated_at = now() where id = $1', [e.transaction_id]);
  });
  return { ok: true };
}));

goals.post('/goals/:id/allocate', wrap(async (req) => {
  const g = await one('select id from goals where id = $1', [req.params.id]);
  if (!g) throw bad('not found', 404);
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || !amount || Math.abs(amount) > 1e10) throw bad('amount required');
  if (req.body.date && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) throw bad('date must be YYYY-MM-DD');
  const out = await tx((t) => allocate(t, { goalId: g.id, accountId: Number(req.body.account_id), amount, date: req.body.date || null, note: req.body.note ? String(req.body.note).slice(0, 200) : null }));
  if (out.skipped === 'full' || out.skipped === 'percent') throw bad(`this goal already counts ${out.skipped === 'full' ? 'all' : 'a percentage'} of that account`);
  if (out.skipped) throw bad('nothing allocated to take back');
  return out;
}));

goals.delete('/goals/:id/allocations/:alloc', wrap(async (req) => {
  await q('delete from goal_allocations where id = $1 and goal_id = $2', [req.params.alloc, req.params.id]);
  return { ok: true };
}));

// Unlink a transaction from whichever goal paid for it.
goals.delete('/transactions/:id/goal', wrap(async (req) => {
  await tx(async (t) => {
    const e = await t.one('delete from goal_entries where transaction_id = $1 returning *', [req.params.id]);
    if (e) await t.q('update transactions set excluded = false, updated_at = now() where id = $1', [req.params.id]);
  });
  return { ok: true };
}));
