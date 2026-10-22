-- Tally schema. Money convention follows Plaid: amount > 0 is money leaving the account (spending),
-- amount < 0 is money coming in (income, refunds). Balances: credit/loan balances are amounts owed.

create table settings (
  key text primary key,
  value jsonb not null
);

create table plaid_items (
  id serial primary key,
  item_id text unique not null,
  access_token_enc text not null,
  institution_id text,
  institution_name text,
  institution_color text,
  institution_logo text,
  cursor text,
  status text not null default 'ok',            -- ok | login_required | pending_expiration | error
  error_code text,
  error_message text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table accounts (
  id serial primary key,
  item_id int references plaid_items(id) on delete cascade,
  plaid_account_id text unique,
  name text not null,
  official_name text,
  display_name text,
  mask text,
  type text not null,                           -- depository | credit | loan | investment | other
  subtype text,
  institution_name text,
  current_balance numeric(14,2),
  available_balance numeric(14,2),
  credit_limit numeric(14,2),
  currency text not null default 'USD',
  hidden boolean not null default false,
  is_demo boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table balance_history (
  account_id int not null references accounts(id) on delete cascade,
  date date not null,
  balance numeric(14,2) not null,
  derived boolean not null default false,       -- reconstructed backwards from transactions, recomputed each sync
  primary key (account_id, date)
);

create table category_groups (
  id serial primary key,
  name text not null,
  kind text not null check (kind in ('expense', 'income', 'transfer')),
  sort int not null default 0
);

create table categories (
  id serial primary key,
  key text unique,                              -- stable slug for the Plaid mapping; null for user-made
  group_id int not null references category_groups(id),
  name text not null,
  emoji text not null default '🏷️',
  color text not null default '#8b8fa3',
  sort int not null default 0,
  rollover boolean not null default false,
  rollover_since date,
  archived boolean not null default false
);

create table recurring (
  id serial primary key,
  merchant_key text unique not null,
  name text not null,
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  category_id int references categories(id) on delete set null,
  account_id int references accounts(id) on delete set null,
  frequency text not null,                      -- weekly | biweekly | semimonthly | monthly | quarterly | yearly
  interval_days int not null,
  amount numeric(14,2) not null,
  last_date date,
  next_date date,
  logo_url text,
  status text not null default 'active' check (status in ('active', 'ignored')),
  user_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table transactions (
  id bigserial primary key,
  account_id int not null references accounts(id) on delete cascade,
  plaid_transaction_id text unique,
  pending_transaction_id text,
  date date not null,
  authorized_date date,
  amount numeric(14,2) not null,
  currency text not null default 'USD',
  name text not null,
  merchant_name text,
  display_name text,
  logo_url text,
  website text,
  category_id int references categories(id) on delete set null,
  category_locked boolean not null default false,  -- the user picked it; syncs and rules leave it alone
  pfc_primary text,
  pfc_detailed text,
  pending boolean not null default false,
  reviewed boolean not null default false,
  excluded boolean not null default false,
  notes text,
  tags text[] not null default '{}',
  recurring_id int references recurring(id) on delete set null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_date_idx on transactions (date desc, id desc);
create index transactions_account_idx on transactions (account_id, date);
create index transactions_category_idx on transactions (category_id, date);
create index transactions_unreviewed_idx on transactions (date desc) where not reviewed;
create index transactions_merchant_idx on transactions (lower(coalesce(merchant_name, name)));

create table budgets (
  category_id int not null references categories(id) on delete cascade,
  month date not null,                          -- first of the month; applies to later months until changed
  amount numeric(14,2) not null,
  primary key (category_id, month)
);

create table rules (
  id serial primary key,
  field text not null default 'merchant' check (field in ('merchant', 'name')),
  op text not null default 'contains' check (op in ('contains', 'equals', 'starts_with')),
  pattern text not null,
  amount_min numeric(14,2),
  amount_max numeric(14,2),
  set_category_id int references categories(id) on delete cascade,
  set_display_name text,
  mark_reviewed boolean not null default false,
  created_at timestamptz not null default now()
);

-- Default categories (Copilot-style: emoji + colour, grouped).
insert into category_groups (id, name, kind, sort) values
  (1, 'Food & Drink', 'expense', 10),
  (2, 'Home', 'expense', 20),
  (3, 'Transportation', 'expense', 30),
  (4, 'Shopping', 'expense', 40),
  (5, 'Lifestyle', 'expense', 50),
  (6, 'Health & Wellness', 'expense', 60),
  (7, 'Financial', 'expense', 70),
  (8, 'Other', 'expense', 80),
  (9, 'Income', 'income', 90),
  (10, 'Transfers', 'transfer', 100);
select setval('category_groups_id_seq', 100);

insert into categories (key, group_id, name, emoji, color, sort) values
  ('groceries', 1, 'Groceries', '🛒', '#34c759', 1),
  ('restaurants', 1, 'Restaurants', '🍽️', '#ff9f0a', 2),
  ('coffee', 1, 'Coffee', '☕', '#a2845e', 3),
  ('bars', 1, 'Bars & Alcohol', '🍸', '#bf5af2', 4),
  ('rent', 2, 'Rent & Mortgage', '🏠', '#5e5ce6', 1),
  ('utilities', 2, 'Utilities', '💡', '#ffd60a', 2),
  ('internet_phone', 2, 'Internet & Phone', '📶', '#64d2ff', 3),
  ('home_improvement', 2, 'Home & Garden', '🪴', '#30d158', 4),
  ('car', 3, 'Car & Gas', '⛽', '#ff453a', 1),
  ('rideshare', 3, 'Rideshare & Taxi', '🚕', '#ffcc00', 2),
  ('transit', 3, 'Public Transit', '🚇', '#0a84ff', 3),
  ('parking', 3, 'Parking & Tolls', '🅿️', '#6e6e73', 4),
  ('shopping', 4, 'Shopping', '🛍️', '#ff375f', 1),
  ('clothing', 4, 'Clothing', '👕', '#ff6482', 2),
  ('electronics', 4, 'Electronics', '💻', '#5ac8fa', 3),
  ('entertainment', 5, 'Entertainment', '🎬', '#bf5af2', 1),
  ('subscriptions', 5, 'Subscriptions', '📺', '#7d7aff', 2),
  ('travel', 5, 'Travel', '✈️', '#40c8e0', 3),
  ('gifts', 5, 'Gifts & Donations', '🎁', '#ff2d55', 4),
  ('pets', 5, 'Pets', '🐾', '#ac8e68', 5),
  ('education', 5, 'Education', '🎓', '#0071e3', 6),
  ('fitness', 6, 'Fitness', '💪', '#32d74b', 1),
  ('medical', 6, 'Medical', '🩺', '#ff6961', 2),
  ('personal_care', 6, 'Personal Care', '💇', '#e5a0ff', 3),
  ('insurance', 7, 'Insurance', '🛡️', '#8e8e93', 1),
  ('fees', 7, 'Fees & Interest', '🧾', '#d70015', 2),
  ('taxes', 7, 'Taxes', '🏛️', '#636366', 3),
  ('services', 8, 'Services', '🧰', '#98989d', 1),
  ('other', 8, 'Other', '🏷️', '#8e8e93', 9),
  ('paycheck', 9, 'Paycheck', '💰', '#30d158', 1),
  ('interest_income', 9, 'Interest', '📈', '#66d4cf', 2),
  ('other_income', 9, 'Other Income', '💵', '#34c759', 3),
  ('transfer', 10, 'Transfer', '🔁', '#8e8e93', 1),
  ('credit_card_payment', 10, 'Credit Card Payment', '💳', '#8e8e93', 2),
  ('loan_payment', 10, 'Loan Payment', '🏦', '#8e8e93', 3),
  ('investment_transfer', 10, 'Investment Transfer', '📊', '#8e8e93', 4);
