-- ROLLBACK for 20261005b_OPS_report_day_sums.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Removes public.report_day_sums and its eight working parts (_rds_*). Nothing else: no
-- table, no data, no rule and no index is touched. Nothing else in the database uses them
-- (they were new on 5 Oct 2026).
--
-- The app does not need rolling back with it: src/lib/reportDaySums.js is told the function
-- is not there, answers "not available", and the reports fall back to the browser read they
-- used before.
--
-- The small index from 20261005b2 (idx_closed_checks_refunded) is NOT dropped here. It is
-- harmless on its own; its own rollback file removes it.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.closed_checks') is null then
    raise exception 'This is not the Ops database (closed_checks is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

drop function if exists public.report_day_sums(text[], date, date, jsonb);
drop function if exists public._rds_refund(jsonb, numeric, numeric, numeric, numeric, numeric);
drop function if exists public._rds_legacy_tenders(text, text, text, numeric, numeric, jsonb, jsonb, jsonb, jsonb);
drop function if exists public._rds_gift_minor(jsonb);
drop function if exists public._rds_ms(jsonb);
drop function if exists public._rds_wall(date, integer, text);
drop function if exists public._rds_tender_bucket(text);
drop function if exists public._rds_canon(text);
drop function if exists public._rds_num(jsonb);

-- So the app stops seeing the function straight away.
notify pgrst, 'reload schema';

-- VISIBLE CHECK: one row, both true.
select
  to_regprocedure('public.report_day_sums(text[], date, date, jsonb)') is null as function_is_gone,
  not exists (select 1 from pg_proc h
               where h.pronamespace = 'public'::regnamespace and h.proname like '\_rds\_%') as working_parts_are_gone;
