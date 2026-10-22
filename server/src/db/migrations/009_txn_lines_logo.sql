-- Cash Flow's top merchants (GET /breakdown) reads logo_url through FLOW, which 008's txn_lines left out.
-- New columns go last: create or replace view can only append.
create or replace view txn_lines as
select t.id, s.id as split_id, t.account_id, t.date, coalesce(s.amount, t.amount) as amount,
       coalesce(s.category_id, t.category_id) as category_id, t.excluded, t.pending, t.recurring_id,
       t.name, t.merchant_name, t.display_name, t.logo_url
  from transactions t left join transaction_splits s on s.transaction_id = t.id;
