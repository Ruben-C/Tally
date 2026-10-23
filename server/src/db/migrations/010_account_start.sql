-- Manual starting point for an account's history: before start_date it counts at start_balance (same sign convention as
-- current_balance). For accounts whose real history can't be rebuilt, e.g. investments linked long after they were opened.
alter table accounts add column start_date date, add column start_balance numeric(14,2);
