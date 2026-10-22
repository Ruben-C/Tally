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

export async function rebuildDerived(accountId) {
  await tx(async (t) => {
    const acct = await t.one('select id, type from accounts where id = $1', [accountId]);
    if (!acct || acct.type === 'investment') return; // market moves aren't in the transactions
    await t.q('delete from balance_history where account_id = $1 and derived', [accountId]);
    const first = await t.one('select date, balance from balance_history where account_id = $1 order by date limit 1', [accountId]);
    if (!first) return;
    const days = await t.q(
      // Card balances include pending charges; bank "current" balances generally don't.
      `select date, sum(amount) as amt from transactions where account_id = $1 and (not pending or $3) and date <= $2
       group by date order by date desc`,
      [accountId, first.date, LIABILITY.has(acct.type)],
    );
    if (!days.length) return;
    const sign = LIABILITY.has(acct.type) ? -1 : 1;
    const byDay = new Map(days.map((d) => [d.date, d.amt]));
    const oldest = days[days.length - 1].date;
    let bal = first.balance;
    const rows = [];
    // Balance at end of day d-1 = balance at end of day d, undoing day d's transactions.
    for (let d = new Date(first.date + 'T00:00:00Z'); ; ) {
      bal = Math.round((bal + sign * (byDay.get(iso(d)) || 0)) * 100) / 100;
      d.setUTCDate(d.getUTCDate() - 1);
      const day = iso(d);
      if (day < addDays(oldest, -1)) break;
      rows.push([day, bal]);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await t.q(
        `insert into balance_history (account_id, date, balance, derived)
         select $1, d::date, b::numeric, true from unnest($2::text[], $3::numeric[]) as u(d, b)
         on conflict do nothing`,
        [accountId, chunk.map((r) => r[0]), chunk.map((r) => r[1])],
      );
    }
  });
}

export const iso = (d) => d.toISOString().slice(0, 10);
export function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
