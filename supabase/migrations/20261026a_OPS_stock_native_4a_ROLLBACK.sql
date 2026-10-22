-- 20261026a_OPS_stock_native_4a_ROLLBACK.sql
-- Undoes 20261026a_OPS_stock_native_4a.sql (multi site stock Drop 4a: head office reports).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. One transaction: any error and nothing changes. #
-- #  Lock wait 3 s.                                                            #
-- ############################################################################
--
-- WHAT IT DOES
--   Drops everything 20261026a made and nothing else: the three tables (stock_targets,
--   stock_key_ratios, report_export_jobs), the three indexes on the day totals and the demo checks one, the sixteen report
--   functions, the report guard and every stock_rp__ helper, the saves and the export functions, the
--   cron job report-export-run, the vault key report_export_cron_key, the bucket report-exports with
--   its files and its read policy. A waiting or running export is failed in words first. The sales
--   history backfill rows not yet drained are taken out of the queue (reason drop4a_backfill); the
--   backfilled days already totalled stay, they are correct. 4a replaced no function and backed
--   nothing up, so nothing is restored.
--
-- KEPT, AND WHY
--   sales_day_sums rows the backfill made (true totals the drainer keeps up anyway), stock_change_log
--   rows (the audit trail), discounts.kind and every drainer object (that release has its own rollback).
--
-- HOW TO RUN
--   Paste the whole file into the SQL editor and run it once. The check row is the last result.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_targets') is null then
    raise exception 'Drop 4a is not in (no stock_targets). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- Waiting or running exports fail in words (the edge function removes any part on its next run,
-- while the bucket is still there; the bucket goes below, parts included).
create temp table _stock_native4a_rb (metric text, value integer) on commit drop;

with f as (
  update public.report_export_jobs j
     set status = 'failed', error = 'Drop 4a was rolled back.', done_at = now()
   where j.status in ('waiting', 'running')
  returning 1
)
insert into _stock_native4a_rb (metric, value) select 'jobs_failed', count(*) from f;

-- The cron job
do $cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname = 'report-export-run' loop
    perform cron.unschedule(j.jobid);
  end loop;
end
$cron$;

-- The report functions (exact signatures)
drop function if exists public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_movement(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_gap(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_cogs(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_product_gp(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_waste(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_days_on_hand(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_par(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_key_ratios(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_setup_health(uuid, uuid[], date, date, jsonb, jsonb, integer);
drop function if exists public.stock_report_batches(uuid, uuid[], date, date, jsonb, jsonb, integer);
-- The saves and the export functions
drop function if exists public.stock_save_targets(uuid, jsonb, text);
drop function if exists public.stock_save_key_ratios(uuid, jsonb, text);
drop function if exists public.stock_report_export_start(text, jsonb);
drop function if exists public.stock_report_export_cancel(uuid);
drop function if exists public.report_export_cron_ok(text);
drop function if exists public.report_export_run_due();
drop function if exists public.report_export_claim(integer);
drop function if exists public.report_export_page(uuid);
drop function if exists public.report_export_finish(uuid, jsonb);
drop function if exists public.report_export_reach_ok(uuid, uuid);
-- The report guard and its helpers (by name)
drop function if exists public.stock_report_guard(uuid, uuid[]);
drop function if exists public.stock_rp__is_demo(text);
drop function if exists public.stock_rp__range_ok(date, date);
drop function if exists public.stock_rp__page_cap(integer);
drop function if exists public.stock_rp__week_of(date, smallint);
drop function if exists public.stock_rp__pct(numeric, numeric);
drop function if exists public.stock_rp__sk(numeric);
drop function if exists public.stock_rp__bucket(text, text);
drop function if exists public.stock_rp__type_of(uuid, text);
drop function if exists public.stock_rp__rag(uuid, uuid, text, numeric);
drop function if exists public.stock_rp__snapshot(uuid, date, date);
drop function if exists public.stock_rp__part_locked(uuid, date, date);
drop function if exists public.stock_rp__takes_from(uuid);
drop function if exists public.stock_rp__window(uuid, date, date, boolean);
drop function if exists public.stock_rp__windows(jsonb, date, date, boolean);
drop function if exists public.stock_rp__value_at(uuid[], date);
drop function if exists public.stock_rp__site_value_at(uuid[], date);
drop function if exists public.stock_rp__open_close(jsonb);
drop function if exists public.stock_rp__site_ledger(jsonb);
drop function if exists public.stock_rp__site_ledger_split(jsonb);
drop function if exists public.stock_rp__site_sales(jsonb);
drop function if exists public.stock_rp__daily_use(uuid[]);
drop function if exists public.stock_rp__labour(uuid, date, date);
drop function if exists public.stock_rp__not_posted(uuid[], date, date);
drop function if exists public.stock_rp__reach_for(uuid, uuid, uuid[]);
drop function if exists public.stock_rp__sum_rows(jsonb, text[]);
drop function if exists public.stock_rp__snap_num(jsonb, text, numeric);
drop function if exists public.stock_rp__meta_windows(jsonb);
drop function if exists public.stock_rp__meta(jsonb, text, date, date, boolean, text, jsonb, jsonb, jsonb);
drop function if exists public.stock_rp__col(text, text, text);
drop function if exists public.stock_rp__opt_site(jsonb, jsonb);
drop function if exists public.stock_rp__site_figures(jsonb, jsonb);
drop function if exists public.stock_rp__derive(uuid, jsonb);
drop function if exists public.stock_rp__sum_keys();
drop function if exists public.stock_rp__demo_sales(uuid, date, date);
drop function if exists public.stock_rp__site_old_sold(jsonb);
drop function if exists public.stock_rp__strict_keys();
drop function if exists public.stock_rp__strict(jsonb, jsonb, text[]);
drop function if exists public.stock_rp__fig_notes(jsonb);
drop function if exists public.stock_rp__totals(uuid, jsonb, text[]);
drop function if exists public.stock_rp__league_rows(jsonb);
drop function if exists public.stock_rp__league_keep();
drop function if exists public.stock_rp__league_cols();
drop function if exists public.stock_rp__cogs_rows(uuid, jsonb, text[]);
drop function if exists public.stock_rp__company_sites(uuid);

-- The three indexes on the day totals and the one on the demo checks
drop index if exists public.stock_day_sums_rp;
drop index if exists public.sales_day_sums_rp;
drop index if exists public.stock_day_sums_demo;
drop index if exists public.closed_checks_demo_rp;

-- The bucket, its files and its read policy
delete from storage.objects o where o.bucket_id = 'report-exports';
drop policy if exists report_exports_owner_read on storage.objects;
delete from storage.buckets b where b.id = 'report-exports';

-- The vault key
delete from vault.secrets s where s.name = 'report_export_cron_key';

-- The three tables
drop table if exists public.report_export_jobs;
drop table if exists public.stock_key_ratios;
drop table if exists public.stock_targets;

-- The backfill days not yet drained (the backfilled days already totalled stay, they are correct)
with d as (
  delete from public.sales_day_sums_queue q where q.reason = 'drop4a_backfill'
  returning 1
)
insert into _stock_native4a_rb (metric, value) select 'backfill_rows_dropped', count(*) from d;

notify pgrst, 'reload schema';

-- ============================================================================
-- VISIBLE CHECK: functions_left 0, tables_left 0, bucket_left false, cron_left false, jobs_failed,
-- backfill_rows_dropped.
-- ============================================================================
select (select count(*)::integer from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (p.proname ~ '^stock_rp__' or p.proname ~ '^report_export_' or p.proname ~ '^stock_report_'
                or p.proname in ('stock_save_targets', 'stock_save_key_ratios'))) as functions_left,
       (select count(*)::integer from unnest(array['stock_targets', 'stock_key_ratios', 'report_export_jobs']) t(n) where to_regclass('public.' || t.n) is not null) as tables_left,
       exists (select 1 from storage.buckets b where b.id = 'report-exports') as bucket_left,
       exists (select 1 from cron.job c where c.jobname = 'report-export-run') as cron_left,
       exists (select 1 from vault.secrets s where s.name = 'report_export_cron_key') as vault_key_left,
       (select count(*)::integer from pg_indexes i where i.schemaname = 'public' and i.indexname in ('stock_day_sums_rp', 'sales_day_sums_rp', 'stock_day_sums_demo', 'closed_checks_demo_rp')) as indexes_left,
       coalesce((select r.value from _stock_native4a_rb r where r.metric = 'jobs_failed'), 0) as jobs_failed,
       coalesce((select r.value from _stock_native4a_rb r where r.metric = 'backfill_rows_dropped'), 0) as backfill_rows_dropped;
