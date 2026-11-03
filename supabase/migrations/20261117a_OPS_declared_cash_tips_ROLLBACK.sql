-- 20261117a ROLLBACK: removes the declared cash tips column (and every amount declared in it).
-- Deploy the previous workforce-clock, staff-portal and workforce-compute FIRST.
begin;
alter table public.wf_timesheets drop constraint if exists wf_timesheets_declared_cash_tips_range;
alter table public.wf_timesheets drop column if exists declared_cash_tips;
commit;
