-- 20261009c_OPS_vat_check_cron_ROLLBACK.sql
--
-- Undoes 20261009c_OPS_vat_check_cron.sql: stops the daily VAT check and drops its table.
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Peter runs it by hand.
--
-- The vat-check edge function keeps answering when called by hand (it says the run row could
-- not be written and still returns what it found). The venue messages it wrote stay: they are
-- ServOS messages to venues like any other, withdrawn from Company Admin if wanted.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS database (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
end
$guard$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'vat-check-daily') then
    perform cron.unschedule('vat-check-daily');
  end if;
end;
$$;

drop policy if exists vat_check_runs_read on public.vat_check_runs;
drop table if exists public.vat_check_runs;
