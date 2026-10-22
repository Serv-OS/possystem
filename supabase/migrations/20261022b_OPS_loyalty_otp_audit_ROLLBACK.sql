-- 20261022b_OPS_loyalty_otp_audit_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Only if 20261022b has to be undone.
-- Removes the nightly job, the key check, the sender and the two audit tables. The loyalty-otp function
-- from v5.11.94 then finds no check and refuses the cron route (fails closed); staff, the service
-- role and the send path's own repair keep working. The vault key is left (it is harmless, and a
-- second run of 20261022b reuses it). Feed alerts already written stay on the activity feed.
-- While it is undone the watchdog says, once a morning, that the nightly check is not installed:
-- that is true, nothing is checking the venues' code text services.

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
end
$guard$;

do $cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'loyalty-otp-audit' loop
    perform cron.unschedule(j.jobid);
  end loop;
end
$cron$;

drop function if exists public.loyalty_otp_audit_send();
drop function if exists public.loyalty_otp_cron_ok(text);
drop table if exists public.loyalty_otp_service_audit;
drop table if exists public.loyalty_otp_audit_runs;

commit;

-- Expected: job_gone 0, key_check_gone true, sender_gone true, table_gone true, runs_table_gone true
select
  (select count(*) from cron.job where jobname = 'loyalty-otp-audit') as job_gone,
  to_regprocedure('public.loyalty_otp_cron_ok(text)') is null as key_check_gone,
  to_regprocedure('public.loyalty_otp_audit_send()') is null as sender_gone,
  to_regclass('public.loyalty_otp_service_audit') is null as table_gone,
  to_regclass('public.loyalty_otp_audit_runs') is null as runs_table_gone;
