// Realistic demo data so Tally is usable before Plaid keys exist. Everything is simulated forward from a
// starting balance (paychecks, rent, bills, card spending, card payments), so balances, net worth history,
// budgets and recurring detection all behave exactly as they will with real accounts. Removable in one click.
import { q, one, tx } from './db.js';
import { loadCategorizer } from './categorize.js';
import { snapshot, rebuildDerived, iso, addDays } from './balances.js';
import { refreshRecurring, createSeries } from './recurring.js';
import { applyGoalSplits } from './goals.js';

let pendingSplits = null;

const DAYS = 215;

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = [
  { key: 'chk', name: 'Everyday Checking', type: 'depository', subtype: 'checking', inst: 'Harbor Bank', mask: '4821', start: 5400 },
  { key: 'sav', name: 'High-Yield Savings', type: 'depository', subtype: 'savings', inst: 'Harbor Bank', mask: '9034', start: 15200 },
  { key: 'visa', name: 'Rewards Visa', type: 'credit', subtype: 'credit card', inst: 'Summit Card', mask: '1177', start: 980, limit: 15000 },
  { key: 'mc', name: 'Cash Back Mastercard', type: 'credit', subtype: 'credit card', inst: 'Summit Card', mask: '6402', start: 120, limit: 6000 },
  { key: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', inst: 'Evergreen Invest', mask: '3310', start: 38200 },
  { key: '401k', name: '401(k)', type: 'investment', subtype: '401k', inst: 'Evergreen Invest', mask: '7756', start: 81500 },
  { key: 'auto', name: 'Auto Loan', type: 'loan', subtype: 'auto', inst: 'Northwind Auto', mask: '5520', start: 16400 },
];

const DEMO_BUDGETS = {
  groceries: 600, restaurants: 450, coffee: 80, bars: 100, rent: 2150, utilities: 150, internet_phone: 170, car: 620,
  rideshare: 120, shopping: 300, clothing: 150, entertainment: 100, subscriptions: 45, travel: 250, fitness: 60, pets: 70,
  personal_care: 60, medical: 50,
};

function generate(today) {
  const r = rng(20261012);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const amt = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  const out = [];
  const add = (acct, date, amount, name, merchant, primary, detailed) => out.push({ acct, date, amount, name, merchant, primary, detailed });

  const start = addDays(today, -DAYS);
  for (let i = 0; i <= DAYS; i++) {
    const date = addDays(start, i);
    const d = new Date(date + 'T00:00:00Z');
    const dom = d.getUTCDate();
    const dow = d.getUTCDay();

    // Income & fixed bills (checking)
    if (dow === 5 && Math.floor(i / 7) % 2 === 0) add('chk', date, -3184.62, 'ACME CORP PAYROLL PPD', 'Acme Corp', 'INCOME', 'INCOME_WAGES');
    if (dom === 1) add('chk', date, 2150, 'PARKSIDE APTS RENT WEB PMT', 'Parkside Apartments', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT');
    if (dom === 2) {
      add('chk', date, 800, 'Online Transfer to SAV ...9034', null, 'TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS');
      add('sav', date, -800, 'Online Transfer from CHK ...4821', null, 'TRANSFER_IN', 'TRANSFER_IN_SAVINGS');
    }
    if (dom === 3) add('chk', date, 49.99, 'BLINK FITNESS MEMBERSHIP', 'Blink Fitness', 'PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS');
    if (dom === 8) add('chk', date, 79.99, 'COMCAST XFINITY', 'Xfinity', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE');
    if (dom === 12) {
      add('chk', date, 412.5, 'NORTHWIND AUTO LOAN PMT', 'Northwind Auto', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT');
      add('auto', date, -412.5, 'PAYMENT RECEIVED - THANK YOU', null, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT');
    }
    if (dom === 15) add('chk', date, amt(68, 142), 'CITY POWER & LIGHT', 'City Power & Light', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY');
    if (dom === 22) add('chk', date, 85, 'VERIZON WIRELESS', 'Verizon', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE');
    if (dom === 28) add('sav', date, -Math.round(15200 * 0.042 / 12 * 100) / 100, 'INTEREST PAYMENT', 'Harbor Bank Interest', 'INCOME', 'INCOME_INTEREST_EARNED');
    if (dom === 20) add('mc', date, 54.18 + (r() < 0.5 ? 0 : 6.3), 'CHEWY.COM', 'Chewy', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_PET_SUPPLIES');

    // Subscriptions (Cash Back card)
    if (dom === 5) add('mc', date, 15.49, 'NETFLIX.COM', 'Netflix', 'ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES');
    if (dom === 11) add('mc', date, 11.99, 'SPOTIFY USA', 'Spotify', 'ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO');
    if (dom === 18) add('mc', date, 2.99, 'APPLE.COM/BILL', 'iCloud+', 'GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES');
    if (dom === 24) add('mc', date, 17, 'NYTIMES DIGITAL', 'The New York Times', 'ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES');
    if (dow === 1) add('mc', date, 69.99, 'HELLOFRESH', 'HelloFresh', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');

    // Everyday card spending (Rewards Visa)
    if (dow === 0 || (dow === 3 && r() < 0.6)) add('visa', date, amt(38, 185), 'GROCERY', pick(['Whole Foods Market', "Trader Joe's", 'Safeway']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES');
    if (dow >= 1 && dow <= 5 && r() < 0.55) add('visa', date, amt(4.5, 8.75), 'COFFEE', pick(['Blue Bottle Coffee', 'Starbucks', 'Philz Coffee']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE');
    if (r() < 0.32) add('visa', date, amt(12, 38), 'LUNCH', pick(['Sweetgreen', 'Chipotle', 'Tender Greens', 'Souvla']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD');
    if ((dow === 5 || dow === 6) && r() < 0.55) add('visa', date, amt(42, 135), 'DINNER', pick(['Nopa', 'Tartine Manufactory', 'Zuni Cafe', 'Kin Khao', 'Flour + Water']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT');
    if (dow === 6 && r() < 0.35) add('visa', date, amt(18, 64), 'BAR', pick(['Trick Dog', 'Zeitgeist', 'Bar Agricole']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR');
    if (r() < 0.2) add('visa', date, amt(11, 36), 'RIDE', pick(['Uber', 'Lyft']), 'TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES');
    if (r() < 0.09) add('visa', date, amt(42, 68), 'GAS', pick(['Shell', 'Chevron']), 'TRANSPORTATION', 'TRANSPORTATION_GAS');
    if (r() < 0.06) add('visa', date, amt(6, 24), 'PARKING', 'SFMTA Parking', 'TRANSPORTATION', 'TRANSPORTATION_PARKING');
    if (r() < 0.1) add('visa', date, amt(9, 145), 'AMAZON MKTPL', 'Amazon', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES');
    if (r() < 0.04) add('visa', date, amt(25, 120), 'TARGET', 'Target', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES');
    if (r() < 0.03) add('visa', date, amt(39, 160), 'CLOTHING', pick(['Uniqlo', 'Everlane', 'Patagonia']), 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES');
    if (r() < 0.035) add('visa', date, amt(14, 80), 'FUN', pick(['AMC Theatres', 'Ticketmaster', 'Steam']), 'ENTERTAINMENT', 'ENTERTAINMENT_OTHER_ENTERTAINMENT');
    if (r() < 0.03) add('visa', date, amt(8, 42), 'CVS PHARMACY', 'CVS Pharmacy', 'MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS');
    if (r() < 0.02) add('visa', date, amt(35, 85), 'HAIRCUT', 'Floyd\'s Barbershop', 'PERSONAL_CARE', 'PERSONAL_CARE_HAIR_AND_BEAUTY');
    if (r() < 0.015) add('visa', date, amt(25, 110), 'GIFT', pick(['Etsy', 'Paper Source']), 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES');
    if (r() < 0.012) add('visa', date, amt(18, 60), 'HOME', pick(['The Home Depot', 'Flora Grubb Gardens']), 'HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_HARDWARE');
  }
  // One trip ~2 months ago, one electronics purchase, a refund.
  const trip = addDays(today, -62);
  add('visa', addDays(trip, -21), 428.4, 'DELTA AIR LINES', 'Delta', 'TRAVEL', 'TRAVEL_FLIGHTS');
  add('visa', addDays(trip, -14), 684.0, 'AIRBNB', 'Airbnb', 'TRAVEL', 'TRAVEL_LODGING');
  for (let k = 0; k < 4; k++) add('visa', addDays(trip, k), amt(28, 120), 'TRIP DINING', pick(['Pike Place Chowder', 'The Pink Door', 'Din Tai Fung']), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT');
  add('visa', addDays(today, -101), 1299, 'APPLE STORE', 'Apple', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ELECTRONICS');
  add('visa', addDays(today, -9), -46.2, 'AMAZON MKTPL REFUND', 'Amazon', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES');
  // A yearly renewal (only one charge in the window, so it's added by hand below) and a weekly meal kit (4 or 5 a month).
  add('visa', addDays(today, -150), 139, 'AMAZON PRIME*ANNUAL', 'Amazon Prime', 'ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES');

  return out.filter((t) => t.date >= start && t.date <= today).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function loadDemo() {
  const existing = await one('select count(*)::int as n from accounts where is_demo');
  if (existing.n) return { already: true };
  const today = iso(new Date());
  const txns = generate(today);

  // Simulate balances forward; pay each card in full on the 25th from checking.
  const bal = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.start]));
  const isLiab = (k) => ['visa', 'mc', 'auto'].includes(k);
  const all = [];
  const byDate = Map.groupBy(txns, (t) => t.date);
  for (let i = 0; i <= DAYS; i++) {
    const date = addDays(today, -DAYS + i);
    for (const t of byDate.get(date) || []) {
      bal[t.acct] += isLiab(t.acct) ? t.amount : -t.amount;
      all.push(t);
    }
    if (new Date(date + 'T00:00:00Z').getUTCDate() === 25) {
      for (const card of ['visa', 'mc']) {
        const due = Math.round(bal[card] * 100) / 100;
        if (due <= 0) continue;
        const label = card === 'visa' ? 'SUMMIT CARD AUTOPAY VISA' : 'SUMMIT CARD AUTOPAY MC';
        const pay = [
          { acct: 'chk', date, amount: due, name: label, merchant: null, primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
          { acct: card, date, amount: -due, name: 'AUTOPAY PAYMENT - THANK YOU', merchant: null, primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' },
        ];
        bal.chk -= due;
        bal[card] -= due;
        all.push(...pay);
      }
    }
  }

  const categorize = await loadCategorizer();
  const ids = {};
  await tx(async (t) => {
    for (const a of ACCOUNTS) {
      const row = await t.one(
        `insert into accounts (plaid_account_id, name, mask, type, subtype, institution_name, current_balance, available_balance, credit_limit, is_demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) returning id`,
        [`demo-${a.key}`, a.name, a.mask, a.type, a.subtype, a.inst, Math.round(bal[a.key] * 100) / 100,
         a.type === 'credit' ? a.limit - bal[a.key] : a.type === 'depository' ? bal[a.key] : null, a.limit ?? null],
      );
      ids[a.key] = row.id;
    }
    const cols = { account_id: [], date: [], amount: [], name: [], merchant: [], cat: [], pp: [], pd: [], pending: [], reviewed: [], tid: [] };
    all.forEach((x, n) => {
      const base = { name: x.merchant ? x.merchant.toUpperCase() : x.name, merchant_name: x.merchant, amount: x.amount, pfc_primary: x.primary, pfc_detailed: x.detailed, account_type: ACCOUNTS.find((a) => a.key === x.acct).type };
      const c = categorize(base);
      const age = (Date.parse(today) - Date.parse(x.date)) / 864e5;
      cols.account_id.push(ids[x.acct]);
      cols.date.push(x.date);
      cols.amount.push(x.amount);
      cols.name.push(base.name);
      cols.merchant.push(x.merchant);
      cols.cat.push(c.category_id);
      cols.pp.push(x.primary);
      cols.pd.push(x.detailed);
      cols.pending.push(age < 2 && (x.acct === 'visa' || x.acct === 'mc'));
      cols.reviewed.push(age > 6);
      cols.tid.push(`demo-${n}`);
    });
    await t.q(
      `insert into transactions (account_id, date, amount, name, merchant_name, category_id, pfc_primary, pfc_detailed, pending, reviewed, plaid_transaction_id, is_demo)
       select * , true from unnest($1::int[], $2::date[], $3::numeric[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::bool[], $10::bool[], $11::text[])`,
      [cols.account_id, cols.date, cols.amount, cols.name, cols.merchant, cols.cat, cols.pp, cols.pd, cols.pending, cols.reviewed, cols.tid],
    );
  });

  // Investments: a gently rising random walk ending at today's value.
  const r = rng(77);
  for (const k of ['brk', '401k']) {
    let v = ACCOUNTS.find((a) => a.key === k).start;
    const dates = [], vals = [];
    for (let i = DAYS; i >= 0; i--) {
      const date = addDays(today, -i);
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      if (dow !== 0 && dow !== 6) v *= 1 + 0.0005 + (r() - 0.5) * 0.022;
      if (k === '401k' && new Date(date + 'T00:00:00Z').getUTCDate() === 15) v += 850;
      dates.push(date);
      vals.push(Math.round(v * 100) / 100);
    }
    await q(
      `insert into balance_history (account_id, date, balance) select $1, d, b from unnest($2::date[], $3::numeric[]) u(d, b)`,
      [ids[k], dates, vals],
    );
    await q('update accounts set current_balance = $2 where id = $1', [ids[k], vals[vals.length - 1]]);
  }
  for (const a of ACCOUNTS) {
    if (a.type === 'investment') continue;
    await snapshot(ids[a.key], Math.round(bal[a.key] * 100) / 100, today);
    await rebuildDerived(ids[a.key]);
  }

  // Budgets, only if the user has none yet.
  const hasBudgets = await one('select count(*)::int as n from budgets');
  if (!hasBudgets.n) {
    const month = addDays(today.slice(0, 8) + '01', 0);
    const first = new Date(month + 'T00:00:00Z');
    first.setUTCMonth(first.getUTCMonth() - 6);
    await q(
      `insert into budgets (category_id, month, amount)
       select c.id, $1::date, b.amount::numeric from jsonb_each_text($2::jsonb) as b(key, amount) join categories c on c.key = b.key`,
      [iso(first), JSON.stringify(DEMO_BUDGETS)],
    );
    await q(`update categories set rollover = true, rollover_since = $1 where key = 'travel'`, [iso(first)]);
    await q(`insert into settings (key, value) values ('demo_budgets', $1) on conflict (key) do update set value = excluded.value`, [JSON.stringify({ month: iso(first), budgets: DEMO_BUDGETS })]);
  }
  await seedGoals(ids, today);
  if (pendingSplits) await applyGoalSplits(pendingSplits);
  pendingSplits = null;
  await refreshRecurring();
  await seedSeries(today);
  return { accounts: ACCOUNTS.length, transactions: all.length };
}

// Series added by hand: the yearly Prime renewal from its one charge, and a domain that renews every two years.
async function seedSeries(today) {
  const prime = await one(`select id, date, amount, name, merchant_name, display_name, logo_url from transactions where is_demo and merchant_name = 'Amazon Prime'`);
  const subs = await one(`select id from categories where key = 'subscriptions'`);
  const base = { kind: 'expense', category_id: subs?.id ?? null, account_id: null, month_days: null, ends_on: null, amount_mode: 'fixed', share_pct: 100, budget_mode: 'auto' };
  await tx(async (t) => {
    if (prime) await createSeries(t, { ...base, name: 'Amazon Prime', amount: 139, every: 1, unit: 'year', anchor_date: prime.date }, prime);
    await createSeries(t, { ...base, name: 'Domain renewal', amount: 34.98, every: 2, unit: 'year', anchor_date: addDays(today, 140) });
    await t.q(`update recurring set is_demo = true where source = 'manual' and name in ('Amazon Prime', 'Domain renewal')`);
  });
}

// A mix of savings goals and buckets, with history, an automatic plan, and a purchase paid from a bucket.
async function seedGoals(ids, today) {
  const ago = (m, d = 1) => {
    const x = new Date(today + 'T00:00:00Z');
    return iso(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - m, d)));
  };
  const mk = (g) => one(
    `insert into goals (kind, name, emoji, color, target_amount, target_date, monthly_amount, auto_contribute, sort, is_demo, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) returning id`,
    [g.kind, g.name, g.emoji, g.color, g.target ?? null, g.date ?? null, g.monthly ?? null, !!g.auto, g.sort, g.created],
  );
  const link = async (goal, account, mode, value, created) => {
    await q(`insert into goal_accounts (goal_id, account_id, mode, amount, percent, created_at) values ($1,$2,$3,$4,$5,$6)`,
      [goal, account, mode, mode === 'amount' ? value : null, mode === 'percent' ? value : null, created]);
    if (mode === 'amount') await q(`insert into goal_allocations (goal_id, account_id, date, amount, note) values ($1,$2,$3,$4,'Initial allocation')`, [goal, account, created, value]);
  };
  const add = (id, date, amount, kind = 'manual', note = null, month = null) =>
    q(`insert into goal_entries (goal_id, date, amount, kind, note, month) values ($1,$2,$3,$4,$5,$6)`, [id, date, amount, kind, note, month]);

  // Account-funded: part of the savings account is the emergency fund; the rest plus most of the brokerage is the down payment.
  const ef = await mk({ kind: 'target', name: 'Emergency fund', emoji: '🛟', color: '#30d158', target: 15000, sort: 1, created: ago(6) });
  await link(ef.id, ids.sav, 'amount', 9000, ago(6));
  const home = await mk({ kind: 'bucket', name: 'Home down payment', emoji: '🏠', color: '#5e5ce6', target: 60000, sort: 2, created: ago(6) });
  await link(home.id, ids.sav, 'amount', 8000, ago(6));
  await link(home.id, ids.brk, 'percent', 60, ago(6));
  // The monthly checking → savings transfer is split across goals by a rule (applied to the last 3 months).
  const rule = await one(
    `insert into rules (field, op, pattern, account_id, direction, goal_splits) values ('name', 'contains', 'transfer from chk', $1, 'in', $2) returning id`,
    [ids.sav, JSON.stringify([{ goal_id: home.id, amount: 500 }, { goal_id: ef.id, amount: 300 }])],
  );
  pendingSplits = { ruleId: rule.id, since: ago(3) };

  const japan = await mk({ kind: 'target', name: 'Japan trip', emoji: '🗾', color: '#ff375f', target: 6000, date: ago(-6, 15), monthly: 450, auto: true, sort: 3, created: ago(5) });
  await add(japan.id, ago(5, 3), 800, 'initial', 'Starting balance');
  for (let m = 5; m >= 0; m--) await add(japan.id, ago(m), 450, 'auto', 'Monthly contribution', ago(m));

  const laptop = await mk({ kind: 'bucket', name: 'New laptop', emoji: '💻', color: '#40c8e0', target: 2400, sort: 3, created: ago(4) });
  for (const [m, a] of [[4, 300], [3, 250], [2, 400], [1, 250], [0, 150]]) await add(laptop.id, ago(m, 6), a, 'manual');

  const car = await mk({ kind: 'bucket', name: 'Car maintenance', emoji: '🔧', color: '#ff9f0a', monthly: 100, auto: true, sort: 4, created: ago(6) });
  for (let m = 6; m >= 0; m--) await add(car.id, ago(m), 100, 'auto', 'Monthly contribution', ago(m));
  const gas = await one(`select t.id, t.amount, t.date from transactions t join accounts a on a.id = t.account_id
                          where a.is_demo and t.merchant_name in ('Shell', 'Chevron') order by t.date desc limit 1`);
  if (gas) {
    await q(`insert into goal_entries (goal_id, date, amount, kind, note, transaction_id) values ($1,$2,$3,'transaction','Oil change',$4)`, [car.id, gas.date, -gas.amount, gas.id]);
    await q('update transactions set excluded = true where id = $1', [gas.id]);
  }

  const gifts = await mk({ kind: 'target', name: 'Holiday gifts', emoji: '🎁', color: '#bf5af2', target: 1200, date: `${today.slice(0, 4)}-12-15`, monthly: 150, sort: 5, created: ago(3) });
  for (const m of [3, 2, 1]) await add(gifts.id, ago(m, 20), 150, 'manual');
}

export async function removeDemo() {
  await q('delete from goals where is_demo');
  await q('delete from recurring where is_demo');
  await q('delete from accounts where is_demo');
  const s = await one(`select value from settings where key = 'demo_budgets'`);
  if (s) {
    // Remove only the budget rows the demo created and the user left untouched.
    await q(
      `delete from budgets b using categories c, jsonb_each_text($2::jsonb) as d(key, amount)
        where b.category_id = c.id and c.key = d.key and b.month = $1::date and b.amount = d.amount::numeric`,
      [s.value.month, JSON.stringify(s.value.budgets)],
    );
    await q(`delete from settings where key = 'demo_budgets'`);
  }
  await refreshRecurring();
}

export const hasDemo = async () => (await one('select exists(select 1 from accounts where is_demo) as x')).x;
