-- Where a rule's goal splits are held. Null = the account the matching transaction is in. Set it when the money is
-- moved on automatically (e.g. a paycheck lands in checking, then a scheduled transfer sends it to a brokerage).
alter table rules add column goal_account_id int references accounts(id) on delete set null;
