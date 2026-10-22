-- Recurring series get an editable schedule and a say in the budget.
--   Schedule: every N days | weeks | months | years, counted from anchor_date (a real or planned charge). Month and year
--   schedules can pin days of the month (month_days, 31 = last day; two days = twice a month). starts_on / ends_on bound
--   it (ends_on = cancelled from that date).
--   Budget: 'due' counts each charge in the month it lands (a weekly bill is 4 or 5 charges); 'set_aside' spreads it as
--   a monthly share that builds a fund until the renewal. 'auto' follows the settings default (long vs short intervals).
--   user_edited now also locks amount and schedule: detection only updates dates and suggests a new price.

alter table recurring
  add column source text not null default 'detected' check (source in ('detected', 'manual')),
  add column every int not null default 1 check (every between 1 and 400),
  add column unit text not null default 'month' check (unit in ('day', 'week', 'month', 'year')),
  add column month_days smallint[],
  add column anchor_date date,
  add column starts_on date,
  add column ends_on date,
  add column amount_mode text not null default 'fixed' check (amount_mode in ('fixed', 'estimate')),
  add column share_pct numeric(5,2) not null default 100 check (share_pct > 0 and share_pct <= 100),
  add column budget_mode text not null default 'auto' check (budget_mode in ('auto', 'due', 'set_aside')),
  add column suggested_amount numeric(14,2),
  add column dismissed_amount numeric(14,2),
  add column is_demo boolean not null default false;

update recurring set
  anchor_date = coalesce(last_date, next_date, current_date),
  starts_on = coalesce((select min(t.date) from transactions t where t.recurring_id = recurring.id), last_date, current_date),
  every = case frequency when 'biweekly' then 2 when 'quarterly' then 3 else 1 end,
  unit = case frequency when 'weekly' then 'week' when 'biweekly' then 'week' when 'yearly' then 'year' else 'month' end;

update recurring set month_days = array[
    least(extract(day from anchor_date)::int, case when extract(day from anchor_date) > 15 then extract(day from anchor_date)::int - 15 else extract(day from anchor_date)::int + 15 end),
    greatest(extract(day from anchor_date)::int, case when extract(day from anchor_date) > 15 then extract(day from anchor_date)::int - 15 else extract(day from anchor_date)::int + 15 end)
  ]::smallint[]
  where frequency = 'semimonthly';

alter table recurring alter column anchor_date set not null;
create index transactions_recurring_idx on transactions (recurring_id) where recurring_id is not null;

insert into settings (key, value) values ('recurring_budget', '{"long": "set_aside", "short": "due"}')
  on conflict (key) do nothing;
