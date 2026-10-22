-- Split transactions: one bank transaction divided across categories. The transaction row is untouched (Plaid sync,
-- recurring detection and goals keep working on it); its lines live here and must add up to its amount. A split has
-- at least two lines; line 0 (lowest sort) is the main one and absorbs any later change in the bank amount.
create table if not exists transaction_splits (
  id bigserial primary key,
  transaction_id bigint not null references transactions(id) on delete cascade,
  category_id int not null references categories(id),
  amount numeric(14,2) not null,
  note text,
  sort int not null default 0
);
create index if not exists transaction_splits_txn_idx on transaction_splits (transaction_id, sort);
create index if not exists transaction_splits_cat_idx on transaction_splits (category_id);

-- What money aggregation reads (FLOW in routes/api.js): one row per transaction, or one per line when it's split.
-- Same id for every line of a transaction; split_id tells them apart.
create or replace view txn_lines as
select t.id, s.id as split_id, t.account_id, t.date, coalesce(s.amount, t.amount) as amount,
       coalesce(s.category_id, t.category_id) as category_id, t.excluded, t.pending, t.recurring_id,
       t.name, t.merchant_name, t.display_name
  from transactions t left join transaction_splits s on s.transaction_id = t.id;
