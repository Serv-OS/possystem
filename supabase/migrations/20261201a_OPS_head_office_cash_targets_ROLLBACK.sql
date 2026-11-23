-- Rollback twin of 20261201a_OPS_head_office_cash_targets.sql. Drops the four slice 2 tables.
-- THE ROWS GO WITH THEM: every target, safe movement, safe count and bank deposit. Export first
-- if a site has started using the safe. 20261130a's six tables stay.
begin;
drop table if exists public.hq_bank_deposits cascade;
drop table if exists public.hq_safe_counts cascade;
drop table if exists public.hq_safe_movements cascade;
drop table if exists public.hq_targets cascade;
commit;
