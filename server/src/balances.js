// Balance history: a real snapshot per account per day (taken on every sync), plus history before the
// first snapshot reconstructed by walking transactions backwards. Derived rows are recomputed every time
// so late-arriving historical transactions (Plaid backfills up to 2 years) are reflected.
import { q, tx } from './db.js';

export const LIABILITY = new Set(['credit', 'loan']);

export async function snapshot(accountId, balance, date = null) {
  if (balance == null) return;
  await q(
    `insert into balance_history (account_id, date, balance, derived) values ($1, coalesce($3::date, current_date), $2, false)
     on conflict (account_id, date) do update set balance = excluded.balance, derived = false`,
    [accountId, balance, date],
  );
}

// Investments get no reconstruction from their own transactions (market moves aren't in them), only from transfers
// other accounts name them in ("Withdrawal to Brokerage - 1234"). Before an account's start_date it counts at
// start_balance, whatever the reconstruction says.
export async function rebuildDerived(accountId) {
  await tx(async (t) => {
    const acct = await t.one('select id, type, mask, item_id, start_date, start_balance from accounts where id = $1', [accountId]);
    if (!acct) return;
    await t.q('delete from balance_history where account_id = $1 and derived', [accountId]);
    const first = await t.one('select date, balance from balance_history where account_id = $1 order by date limit 1', [accountId]);
    if (first) await t.q(
      `insert into balance_history (account_id, date, balance, derived)
       select $1, d::date, b::numeric, true from unnest($2::text[], $3::numeric[]) as u(d, b)
       on conflict do nothing`,
      [accountId, ...unzip(walkBack(first, await stepsBack(t, acct, first.date), acct.type === 'investment'))],
    );
    if (acct.start_date) {
      const before = addDays(acct.start_date, -1);
      await t.q('delete from balance_history where account_id = $1 and derived and date < $2', [accountId, before]);
      // From the start date up to the oldest rebuilt day, hold that oldest balance (else the day before's would show through).
      await t.q(
        `insert into balance_history (account_id, date, balance, derived)
         select $1, $2::date, balance, true from balance_history where account_id = $1 and date >= $2 order by date limit 1
         on conflict do nothing`,
        [accountId, acct.start_date],
      );
      await t.q(
        `insert into balance_history (account_id, date, balance, derived) values ($1, $2, $3, true)
         on conflict (account_id, date) do update set balance = excluded.balance where balance_history.derived`,
        [accountId, before, acct.start_balance ?? 0],
      );
    }
  });
}

// What to add to a day's closing balance to get the day before's, per day with any movement, newest first.
async function stepsBack(t, acct, until) {
  if (acct.type !== 'investment') {
    const liab = LIABILITY.has(acct.type);
    // Card balances include pending charges; bank "current" balances generally don't.
    const rows = await t.q(
      `select date, sum(amount) as amt from transactions where account_id = $1 and (not pending or $3) and date <= $2
       group by date order by date desc`,
      [acct.id, until, liab],
    );
    return rows.map((r) => ({ date: r.date, amt: liab ? -r.amt : r.amt }));
  }
  if (!/^\d{4}$/.test(acct.mask || '')) return [];
  // A transfer names the account by its mask. Money leaving the other account (amount > 0) arrived here.
  const rows = await t.q(
    `select t.date, sum(t.amount) as amt from transactions t join accounts s on s.id = t.account_id
      where t.account_id <> $1 and not t.pending and t.date <= $2 and t.name ~ ('(^|[^0-9])' || $3 || '([^0-9]|$)')
        and (s.item_id = $4 or t.pfc_primary in ('TRANSFER_IN', 'TRANSFER_OUT'))
      group by t.date order by t.date desc`,
    [acct.id, until, acct.mask, acct.item_id],
  );
  return rows.map((r) => ({ date: r.date, amt: -r.amt }));
}

// Balance at end of day d-1 = balance at end of day d, undoing day d's movement. Runs to the day before the oldest one.
function walkBack(first, steps, floorZero) {
  if (!steps.length) return [];
  const byDay = new Map(steps.map((s) => [s.date, s.amt]));
  const stop = addDays(steps[steps.length - 1].date, -1);
  let bal = first.balance;
  const rows = [];
  for (let d = new Date(first.date + 'T00:00:00Z'); ; ) {
    bal = Math.round((bal + (byDay.get(iso(d)) || 0)) * 100) / 100;
    if (floorZero) bal = Math.max(0, bal); // a brokerage can't go below zero; growth we can't see made up the difference
    d.setUTCDate(d.getUTCDate() - 1);
    const day = iso(d);
    if (day < stop) break;
    rows.push([day, bal]);
  }
  return rows;
}

const unzip = (rows) => [rows.map((r) => r[0]), rows.map((r) => r[1])];

export const iso = (d) => d.toISOString().slice(0, 10);
export function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
