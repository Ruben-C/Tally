-- Fixed-amount account allocations become a dated ledger, so you can keep adding money from an account to a goal
-- (by hand, or automatically when a rule matches a transfer) and see the history. For mode = 'amount', the
-- allocated amount is the sum of these rows; goal_accounts.amount is no longer the source of truth.
create table goal_allocations (
  id serial primary key,
  goal_id int not null references goals(id) on delete cascade,
  account_id int not null references accounts(id) on delete cascade,
  date date not null default current_date,
  amount numeric(14,2) not null,                   -- > 0 allocates more of the account, < 0 releases it
  note text,
  transaction_id bigint references transactions(id) on delete cascade,  -- the transfer that funded it (rules)
  rule_id int references rules(id) on delete set null,
  created_at timestamptz not null default now()
);
create index goal_allocations_goal_idx on goal_allocations (goal_id, account_id, date);
create unique index goal_allocations_txn_goal on goal_allocations (transaction_id, goal_id) where transaction_id is not null;

insert into goal_allocations (goal_id, account_id, date, amount, note, created_at)
  select goal_id, account_id, created_at::date, amount, 'Initial allocation', created_at
    from goal_accounts where mode = 'amount' and amount > 0;

-- Rules can now also target an account and a direction, and split matching money across goals:
-- goal_splits = [{ "goal_id": 1, "amount": 2500 }, ...]
alter table rules
  add column account_id int references accounts(id) on delete cascade,
  add column direction text not null default 'any' check (direction in ('any', 'in', 'out')),
  add column goal_splits jsonb not null default '[]';
