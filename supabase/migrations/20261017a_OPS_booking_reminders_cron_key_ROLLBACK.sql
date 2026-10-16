-- 20261017a_OPS_booking_reminders_cron_key_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Only if 20261017a has to be undone.
-- Puts booking-reminders-nudge back exactly as 20261016c left it (every 5 minutes, no key) and
-- removes the key check. The booking-reminders function from v5.11.73 then finds no check and
-- stays open, as it was before, so reminders carry on either way. The vault key is left (it is
-- harmless, and a second run of 20261017a reuses it).

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
  for j in select jobid from cron.job where jobname = 'booking-reminders-nudge' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule(
    'booking-reminders-nudge',
    '*/5 * * * *',
    $job$
      select net.http_post(
        url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/booking-reminders',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{"action": "send_due"}'::jsonb
      );
      $job$
  );
end
$cron$;

drop function if exists public.booking_reminders_send_due();
drop function if exists public.booking_reminders_cron_ok(text);

commit;

-- Expected: job_every_5_no_key 1, key_check_gone true
select
  (select count(*) from cron.job where jobname = 'booking-reminders-nudge' and schedule = '*/5 * * * *'
     and command like '%net.http_post%' and command not like '%x-cron-key%') as job_every_5_no_key,
  to_regprocedure('public.booking_reminders_cron_ok(text)') is null as key_check_gone;
