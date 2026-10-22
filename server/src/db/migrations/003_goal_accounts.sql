-- Goals funded by accounts, Monarch-style: any number of accounts per goal, each contributing
--   full    : the account's whole balance
--   amount  : a fixed dollar amount of it (e.g. $10,000 of a $20,000 savings account)
--   percent : a share of it that moves with the balance (e.g. 80% of a brokerage account)
-- A goal's balance = its account allocations + its manual entries (money set aside elsewhere, purchases paid from it).

create table goal_accounts (
  id serial primary key,
  goal_id int not null references goals(id) on delete cascade,
  account_id int not null references accounts(id) on delete cascade,
  mode text not null check (mode in ('full', 'amount', 'percent')),
  amount numeric(14,2),
  percent numeric(6,3),
  created_at timestamptz not null default now(),
  unique (goal_id, account_id),
  check ((mode = 'amount' and amount is not null and amount >= 0) or (mode = 'percent' and percent > 0 and percent <= 100) or mode = 'full')
);
create index goal_accounts_account_idx on goal_accounts (account_id);

insert into goal_accounts (goal_id, account_id, mode, created_at)
  select id, account_id, 'full', created_at from goals where account_id is not null;
alter table goals drop column account_id;
