-- Goals: "target" goals (save up to an amount, optionally by a date) and "bucket"s (money set aside to spend later,
-- a.k.a. sinking funds). Money here is virtual: entries record what you set aside; nothing moves between accounts.
-- A goal can instead follow a real account's balance (account_id), e.g. an emergency fund = the savings account.

create table goals (
  id serial primary key,
  kind text not null check (kind in ('target', 'bucket')),
  name text not null,
  emoji text not null default '🎯',
  color text not null default '#7d7aff',
  target_amount numeric(14,2),                   -- required for target goals; optional "soft cap" for buckets
  target_date date,
  monthly_amount numeric(14,2),                  -- planned contribution per month
  auto_contribute boolean not null default false, -- add monthly_amount on the 1st of each month automatically
  account_id int references accounts(id) on delete set null,
  sort int not null default 0,
  archived boolean not null default false,
  completed_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table goal_entries (
  id serial primary key,
  goal_id int not null references goals(id) on delete cascade,
  date date not null default current_date,
  amount numeric(14,2) not null,                  -- > 0 adds to the goal, < 0 takes from it
  kind text not null default 'manual' check (kind in ('manual', 'auto', 'initial', 'transaction')),
  month date,                                     -- for auto contributions: which month they belong to
  note text,
  transaction_id bigint unique references transactions(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index goal_entries_goal_idx on goal_entries (goal_id, date);
create unique index goal_entries_auto_month on goal_entries (goal_id, month) where kind = 'auto';
