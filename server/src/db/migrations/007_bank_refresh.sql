-- When Plaid itself last pulled from the bank (from /item/get status.transactions), as opposed to last_synced_at,
-- which is when Tally last asked Plaid. A stale bank_updated_at means Plaid hasn't refreshed, not that Tally is broken.
alter table plaid_items add column if not exists bank_updated_at timestamptz;
alter table plaid_items add column if not exists bank_failed_at timestamptz;
