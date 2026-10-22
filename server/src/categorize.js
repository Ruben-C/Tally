// Picks a category for a transaction. Order: the user's rules, then what the user last chose for the
// same merchant (Tally learns from your edits), then Plaid's personal_finance_category, then a fallback.
import { q } from './db.js';

// Plaid personal_finance_category (detailed first, then primary) -> category key.
const DETAILED = {
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  FOOD_AND_DRINK_COFFEE: 'coffee',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'bars',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'clothing',
  GENERAL_MERCHANDISE_ELECTRONICS: 'electronics',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'pets',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'gifts',
  GENERAL_MERCHANDISE_SUPERSTORES: 'shopping',
  RENT_AND_UTILITIES_RENT: 'rent',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'internet_phone',
  RENT_AND_UTILITIES_TELEPHONE: 'internet_phone',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'rent',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'credit_card_payment',
  LOAN_PAYMENTS_CAR_PAYMENT: 'car',
  TRANSPORTATION_GAS: 'car',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'rideshare',
  TRANSPORTATION_PUBLIC_TRANSIT: 'transit',
  TRANSPORTATION_PARKING: 'parking',
  TRANSPORTATION_TOLLS: 'parking',
  ENTERTAINMENT_TV_AND_MOVIES: 'subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'subscriptions',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'fitness',
  GENERAL_SERVICES_INSURANCE: 'insurance',
  GENERAL_SERVICES_EDUCATION: 'education',
  GENERAL_SERVICES_AUTOMOTIVE: 'car',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'gifts',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'taxes',
  INCOME_WAGES: 'paycheck',
  INCOME_INTEREST_EARNED: 'interest_income',
  INCOME_DIVIDENDS: 'interest_income',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'investment_transfer',
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'investment_transfer',
};
const PRIMARY = {
  INCOME: 'other_income',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  LOAN_PAYMENTS: 'loan_payment',
  BANK_FEES: 'fees',
  ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK: 'restaurants',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'home_improvement',
  MEDICAL: 'medical',
  PERSONAL_CARE: 'personal_care',
  GENERAL_SERVICES: 'services',
  GOVERNMENT_AND_NON_PROFIT: 'taxes',
  TRANSPORTATION: 'car',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES: 'utilities',
};

export function keyForPfc(primary, detailed, amount) {
  const k = DETAILED[detailed] || PRIMARY[primary];
  if (k) return k;
  return amount < 0 ? 'other_income' : 'other';
}

export const merchantKey = (t) =>
  String(t.merchant_name || t.name || '')
    .toLowerCase()
    .replace(/\b(pos|ach|debit|credit|purchase|payment|recurring|online|www|com|inc|llc)\b/g, ' ')
    .replace(/[#*]\s*\w*\d\w*/g, ' ')
    .replace(/\d{3,}/g, ' ')
    .replace(/[^a-z0-9&' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function ruleMatches(rule, t) {
  if (rule.account_id && t.account_id !== rule.account_id) return false;
  if (rule.direction === 'in' && !(t.amount < 0)) return false;
  if (rule.direction === 'out' && !(t.amount > 0)) return false;
  const p = String(rule.pattern || '').toLowerCase();
  if (p) {
    const hay = String((rule.field === 'merchant' ? t.merchant_name || t.name : t.name) || '').toLowerCase();
    const ok = rule.op === 'equals' ? hay === p : rule.op === 'starts_with' ? hay.startsWith(p) : hay.includes(p);
    if (!ok) return false;
  } else if (!rule.account_id && rule.direction === 'any') return false; // a rule must test something
  const abs = Math.abs(t.amount);
  if (rule.amount_min != null && abs < rule.amount_min) return false;
  if (rule.amount_max != null && abs > rule.amount_max) return false;
  return true;
}

// Loads everything the categorizer needs once per sync batch.
export async function loadCategorizer() {
  const cats = await q('select id, key from categories where not archived');
  const byKey = Object.fromEntries(cats.filter((c) => c.key).map((c) => [c.key, c.id]));
  const rules = await q('select * from rules order by id');
  // Merchant memory: the most recent user-chosen category per merchant.
  const learned = new Map();
  for (const r of await q(
    `select distinct on (lower(coalesce(merchant_name, name))) coalesce(merchant_name, name) as m, category_id
       from transactions where category_locked and category_id is not null
        and not exists (select 1 from transaction_splits s where s.transaction_id = transactions.id)
      order by lower(coalesce(merchant_name, name)), updated_at desc`,
  ))
    learned.set(merchantKey({ name: r.m }), r.category_id);

  return function categorize(t) {
    const out = { category_id: null, display_name: null, reviewed: false };
    for (const r of rules) {
      if (!ruleMatches(r, t)) continue;
      if (r.set_category_id && !out.category_id) out.category_id = r.set_category_id;
      if (r.set_display_name && !out.display_name) out.display_name = r.set_display_name;
      if (r.mark_reviewed) out.reviewed = true;
    }
    // Money arriving on a card or loan is a payment from another account, not income or a refund.
    if (!out.category_id && t.account_type && (t.account_type === 'credit' || t.account_type === 'loan') && t.amount < 0 &&
        ['LOAN_PAYMENTS', 'TRANSFER_IN'].includes(t.pfc_primary))
      out.category_id = byKey[t.account_type === 'credit' ? 'credit_card_payment' : 'loan_payment'];
    if (!out.category_id) out.category_id = learned.get(merchantKey(t)) ?? null;
    if (!out.category_id) out.category_id = byKey[keyForPfc(t.pfc_primary, t.pfc_detailed, t.amount)] ?? byKey.other;
    return out;
  };
}

export { ruleMatches };
