-- Budget methods. The stored budget stays the same (a monthly amount per category); each method is a different view
-- over it. Two category tags drive the views:
--   budget_kind: fixed | flexible | non_monthly  (Flex view: one number for everything flexible)
--   bucket:      need | want | savings | null     (50/30/20 view; null = not sorted yet)
-- budget_plan holds the month-level figures, sticky like budgets (a row applies until a later month changes it):
-- expected income (null = use the 3-month average) and an optional explicit flex number (null = whatever is left).

alter table categories
  add column budget_kind text not null default 'flexible' check (budget_kind in ('fixed', 'flexible', 'non_monthly')),
  add column bucket text check (bucket in ('need', 'want', 'savings'));

update categories set budget_kind = 'fixed' where key in ('rent', 'utilities', 'internet_phone', 'insurance', 'subscriptions');
update categories set budget_kind = 'non_monthly' where key in ('travel', 'gifts', 'taxes', 'education');

update categories set bucket = 'need'
  where key in ('groceries', 'rent', 'utilities', 'internet_phone', 'car', 'transit', 'parking', 'insurance', 'medical', 'fees', 'taxes');
update categories set bucket = 'want' where key is not null and bucket is null
  and group_id in (select id from category_groups where kind = 'expense');

create table budget_plan (
  month date not null,                           -- first of the month; applies to later months until changed
  field text not null check (field in ('income', 'flex')),
  amount numeric(14,2),                          -- null = back to automatic from this month on
  primary key (month, field)
);

insert into settings (key, value) values ('budget_method', '{"method": "category", "ratios": {"need": 50, "want": 30, "savings": 20}}')
  on conflict (key) do nothing;
