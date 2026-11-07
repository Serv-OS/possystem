-- ROLLBACK for 20261129a_OPS_xero_auto_bills.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Stops the job, drops the function and the two switch columns. Bills and credit notes go to
-- Xero only when someone presses Push again. Documents already in Xero stay there, and their
-- xero_sync_log rows stay (the screens keep showing In Xero). No data is touched otherwise.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $$ begin perform cron.unschedule('xero-auto-bills'); exception when others then null; end $$;
drop function if exists public.xero_auto_bills_post();
alter table public.xero_config drop column if exists auto_bills;
alter table public.xero_config drop column if exists auto_bills_since;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0 and no row.
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'xero_config' and column_name in ('auto_bills', 'auto_bills_since')) as columns_left,
       (select schedule from cron.job where jobname = 'xero-auto-bills') as job_schedule;
