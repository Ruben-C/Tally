export type Kind = 'expense' | 'income' | 'transfer';

export interface Group { id: number; name: string; kind: Kind; sort: number }
export interface Category {
  id: number; key: string | null; group_id: number; name: string; emoji: string; color: string; sort: number;
  rollover: boolean; rollover_since: string | null; archived: boolean; tx_count: number;
  budget_kind: BudgetKind; bucket: Bucket | null;
  avg3?: number; last_used?: string | null; rule_count?: number;
}
export interface Account {
  id: number; item_id: number | null; name: string; label: string; display_name: string | null; official_name: string | null;
  mask: string | null; type: string; subtype: string | null; institution_name: string | null;
  current_balance: number | null; available_balance: number | null; credit_limit: number | null; currency: string;
  hidden: boolean; is_demo: boolean; item_status: string | null; item_error: string | null; last_synced_at: string | null;
  institution_color: string | null; institution_logo: string | null; balance_30d: number | null; spark: number[] | null; updated_at: string;
}
export interface Txn {
  id: number; account_id: number; date: string; amount: number; label: string; name: string; merchant_name: string | null;
  display_name: string | null; logo_url: string | null; category_id: number | null; category_locked: boolean; pending: boolean;
  reviewed: boolean; excluded: boolean; notes: string | null; tags: string[]; recurring_id: number | null; pfc_detailed: string | null;
  goal_id?: number | null; goal_name?: string | null; goal_emoji?: string | null;
  /** Lines of a split transaction (at least two, adding up to amount); null when it has one category. */
  splits?: TxnSplit[] | null;
  /** Money a rule (or you) set aside in goals from this transaction, out of the account it landed in. */
  allocations?: TxnAllocation[] | null;
}
export interface TxnAllocation { id: number; goal_id: number; name: string; emoji: string; amount: number; rule_id: number | null }
export interface TxnSplit { id: number; category_id: number; amount: number; note: string | null }
export interface TxnDetail extends Txn { history: Txn[]; stats: { n: number; total: number; avg: number } }
export type RecurUnit = 'day' | 'week' | 'month' | 'year';
export type RecurMode = 'due' | 'set_aside';
export interface Recurring {
  id: number; merchant_key: string; name: string; kind: 'expense' | 'income'; category_id: number | null; account_id: number | null;
  frequency: string; interval_days: number; amount: number; last_date: string | null; next_date: string | null; logo_url: string | null;
  status: 'active' | 'ignored'; category_name: string; emoji: string | null; color: string | null; tx_count: number;
  source: 'detected' | 'manual'; user_edited: boolean; every: number; unit: RecurUnit; month_days: number[] | null;
  anchor_date: string; starts_on: string | null; ends_on: string | null; amount_mode: 'fixed' | 'estimate'; share_pct: number;
  budget_mode: 'auto' | RecurMode; suggested_amount: number | null;
  // Derived by the API: resolved budget treatment, my share, average per month, this month's charge dates and plan.
  mode: RecurMode; long: boolean; ended: boolean; my_amount: number; per_month: number; month_dates: string[];
  plan: { planned: number; fund: number; target: number | null; renews: string | null };
}
export interface RecurDefaults { long: RecurMode; short: RecurMode }
/** One series as the budget sees it in a month. */
export interface SeriesPlan {
  id: number; name: string; logo_url: string | null; mode: RecurMode; long: boolean; amount: number; every: number; unit: RecurUnit;
  planned: number; due: number; dates: string[]; fund: number; target?: number; renews?: string | null;
}
export type BudgetMethod = 'category' | 'zero' | 'flex' | 'percent';
export type BudgetKind = 'fixed' | 'flexible' | 'non_monthly';
export type Bucket = 'need' | 'want' | 'savings';
export interface BudgetRow {
  category_id: number; name: string; emoji: string; color: string; group_id: number; group_name: string; rollover: boolean;
  budget_kind: BudgetKind; bucket: Bucket | null;
  budget: number | null; spent: number; carry: number; available: number | null; avg3: number;
  /** manual: you set it; recurring: no budget of your own, so it's the category's recurring charges. */
  budget_source: 'manual' | 'recurring' | null;
  committed: number; reserve: number; series: SeriesPlan[];
  /** Spent this month on the category's own recurring series. */
  rec_spent: number;
  /** Flex view only: this row is the recurring part ('rec') or the rest ('rest') of a flexible category. */
  part?: 'rec' | 'rest';
}
export interface KindTotals { planned: number; spent: number; available: number; cap: number; carried: number; recurring?: number }
export interface BudgetPlan {
  income: { expected: number; set: number | null; average: number; actual: number };
  saving: number;
  unassigned: number;
  kinds: Record<BudgetKind, KindTotals>;
  flex: { budget: number; set: number | null; auto: number; spent: number };
  buckets: Record<Bucket, { target: number; planned: number; spent: number }>;
  saved: number;
  unsorted: number;
}
export interface Budgets {
  month: string; elapsed: number; method: BudgetMethod; ratios: Record<Bucket, number>; categories: BudgetRow[];
  /** carried: rollover and set-aside funds the budgeted categories can spend on top of `budgeted`. */
  totals: { budgeted: number; spent: number; budgetedSpent: number; carried: number; income: number };
  plan: BudgetPlan;
}
export interface NWPoint { date: string; assets: number; liabilities: number; net: number }
export interface Dashboard {
  month: string;
  method: BudgetMethod;
  spending: { spent: number; prevToDate: number; prevTotal: number; dayOfMonth: number | null; series: { day: number; cur: number | null; prev: number | null }[] };
  income: number;
  /** "Left to spend" under the chosen method: budgeted + carried − spent. `plan` is the month's planned spending; `lines` are side
   *  meters measured against `cap` (planned plus rollover/set-aside funds). */
  budget: { budgeted: number; carried: number; spent: number; plan: number; lines: { key: string; label: string; spent: number; planned: number; cap: number }[] };
  netWorth: { current: number; change30: number; series: NWPoint[] };
  toReview: { count: number; items: Txn[] };
  upcoming: Recurring[];
  recurring: {
    renewals: { saved: number; monthly: number; items: { id: number; name: string; category_id: number; amount: number; renews: string; saved: number }[] };
    underBudget: { category_id: number; name: string; emoji: string; color: string; budget: number; committed: number }[];
  };
  topCategories: BudgetRow[]; // budget is set only where it's a limit you set (null for recurring-derived figures)
  /** Categories with a limit you set, most used first. */
  limits: BudgetRow[];
  brief: {
    movers: { category_id: number; name: string; emoji: string; color: string; cur: number; prev: number; diff: number }[];
    billsThisWeek: { n: number; total: number };
    biggest: { id: number; label: string; amount: number; date: string; category_id: number } | null;
    unusual: { id: number; label: string; amount: number; avg: number } | null;
  };
}
export interface CashMonth { month: string; income: number; expenses: number; net: number }
export interface Breakdown {
  from: string; to: string;
  categories: { category_id: number; name: string; emoji: string; color: string; group_name: string; kind: Kind; total: number; n: number }[];
  merchants: { name: string; logo_url: string | null; total: number; n: number; category_id: number }[];
}
export interface Rule {
  id: number; field: 'merchant' | 'name'; op: 'contains' | 'equals' | 'starts_with'; pattern: string; amount_min: number | null; amount_max: number | null;
  set_category_id: number | null; set_display_name: string | null; mark_reviewed: boolean; category_name: string | null; emoji: string | null;
  color?: string | null; matches?: number;
  account_id: number | null; direction: 'any' | 'in' | 'out'; goal_splits: { goal_id: number; amount: number }[];
  account_label?: string | null; allocations_made?: number; typical_amount?: number | null; last_match?: string | null;
}
export interface PlaidItem {
  id: number; institution_name: string | null; institution_color: string | null; institution_logo: string | null; status: string;
  error_code: string | null; error_message: string | null; last_synced_at: string | null;
  bank_updated_at: string | null; bank_failed_at: string | null; created_at: string; accounts: number;
}
export interface Meta { plaid: { configured: boolean; env: string; oauthRedirect: boolean; webhook: boolean }; demo: boolean; accounts: number; items: number; to_review: number }

export type GoalStatus = 'new' | 'done' | 'on_track' | 'behind' | 'overdue' | 'no_plan' | 'bucket';
export interface Goal {
  id: number; kind: 'target' | 'bucket'; name: string; emoji: string; color: string;
  target_amount: number | null; target_date: string | null; monthly_amount: number | null; auto_contribute: boolean;
  sources: GoalSource[]; entries_total: number; archived: boolean; completed_at: string | null; created_at: string;
  balance: number; added: number; spent: number; last_activity: string | null; progress: number | null; remaining?: number;
  pace?: number; needed_monthly?: number | null; projected_date?: string | null; status: GoalStatus;
  history: { month: string; balance: number }[];
}
export interface GoalEntry { id: number; date: string; amount: number; kind: 'manual' | 'auto' | 'initial' | 'transaction'; note: string | null; transaction_id: number | null; txn_label: string | null; txn_category_id: number | null }
export interface GoalAllocationEvent { id: number; goal_id: number; account_id: number; account_label: string; date: string; amount: number; note: string | null; transaction_id: number | null; rule_id: number | null; rule_pattern: string | null }
export interface GoalDetail extends Goal {
  entries: GoalEntry[];
  allocations: GoalAllocationEvent[];
  rules: { id: number; pattern: string; direction: string; account_label: string | null; amount: number }[];
}
export type AllocMode = 'full' | 'amount' | 'percent';
export interface GoalSource { account_id: number; label: string; mask: string | null; institution: string | null; type: string; mode: AllocMode; amount: number | null; percent: number | null; account_balance: number; value: number; short: boolean }
export interface AccountAlloc {
  account_id: number; label: string; mask: string | null; type: string; institution: string | null; hidden: boolean;
  balance: number; allocated: number; free: number; over: boolean;
  goals: { goal_id: number; name: string; emoji: string; color: string; mode: AllocMode; amount: number | null; percent: number | null; value: number }[];
}
export interface GoalsResponse { goals: Goal[]; totals: { saved: number; monthly: number; from_accounts: number; set_aside: number; cash: number }; accounts: AccountAlloc[] }
