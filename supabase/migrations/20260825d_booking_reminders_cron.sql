-- 20260825d_booking_reminders_cron.sql — OPS database, hand-applied.
-- The pre-order nudge (booking-reminders {action:'send_due'}) has relied on a
-- RUNNING host stand as its clock (BookingsSurface fires it hourly) — a known
-- gap the fn's own header documents. A sleeping iPad = no morning nudges.
-- This gives the job a server-side clock: pg_cron + pg_net every 15 minutes.
-- send_due is ledger-idempotent (booking_reminders unique per booking/kind/
-- channel), so cadence is safe at any frequency; 15 minutes keeps nudges
-- timely without hammering. The fn deploys --no-verify-jwt and send_due
-- performs no privileged action beyond its own fenced reads/sends.

begin;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'booking-reminders-nudge';
    perform cron.schedule(
      'booking-reminders-nudge',
      '*/15 * * * *',
      $job$
      select net.http_post(
        url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/booking-reminders',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{"action": "send_due"}'::jsonb
      );
      $job$
    );
  else
    raise warning 'pg_cron not installed — booking reminder nudges still need a running host stand';
  end if;
end $$;

commit;
