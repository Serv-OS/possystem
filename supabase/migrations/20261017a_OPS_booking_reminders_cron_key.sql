-- 20261017a_OPS_booking_reminders_cron_key.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016c_OPS_booking_guest_manage.sql FIRST (it is live: the job    #
-- #  booking-reminders-nudge already runs every 5 minutes).                   #
-- #  Safe to run twice. One transaction. Any time, in service too: no till,   #
-- #  stand or table is touched. Nothing to copy or paste: the key is made     #
-- #  here, inside the database vault, and nobody ever sees it.                #
-- ############################################################################
--
-- WHY (PR 295 follow up, 17 Oct 2026)
--   booking-reminders send_due is the sweep that texts and emails guests their confirmations,
--   reminders, change and cancel messages. The function is public (the booking page calls it
--   with the public key), so ANYONE could start the sweep. It could never send twice (the ledger
--   stops that), but it answered with booking ids and why each guest was skipped, and only the
--   scheduled job should run it. The host stand also started it on boot and every hour.
--
-- WHAT THIS ADDS
--   1  A random key in the database vault, secret booking_reminders_cron_key (64 hex characters
--      from two random uuids). Made once: a second run keeps the same key.
--   2  public.booking_reminders_cron_ok(p_key): true only for that key. Only the service role may
--      call it (the booking-reminders function asks it), never the public key or a signed in user.
--      The key itself is never returned.
--   3  public.booking_reminders_send_due(): what the job runs. It reads the key from the vault at
--      call time and posts send_due to the function with the header x-cron-key. The key is not
--      in the job's text (cron.job shows only the function name). Nobody may call it but the job.
--      It waits up to 25 seconds for the answer (the old job waited the default 5).
--   4  The job booking-reminders-nudge, every 5 minutes as now, now runs that function.
--
-- ORDER (either order is safe, this one is cleanest)
--   1  Run this file. The function live today ignores the header, so reminders carry on.
--   2  Deploy booking-reminders (PR for v5.11.73). From then on send_due runs only for this job or
--      the service role. Before this file has run it stays open as today, so reminders never stop
--      whichever comes first.
--
-- AFTER RUNNING
--   Read the check row at the bottom. Then, after deploying booking-reminders, wait 5 minutes and
--   run the read only check in the PR (the job's answers should be 200 with "ledger":"v2").
--
-- UNDO: 20261017a_OPS_booking_reminders_cron_key_ROLLBACK.sql (puts the job back as 20261016c
-- left it; the deployed function then stays open again, as today).

begin;

-- Wrong database guard (same test as 20260825f): Ops has user_locations and no billing_state.
-- And the three things this needs: the vault, pg_net and pg_cron (signatures as live, read 17 Oct 2026:
-- vault.create_secret(text,text,text,uuid), net.http_post(text,jsonb,jsonb,jsonb,integer),
-- cron.schedule(text,text,text), cron.unschedule(bigint)).
do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'The database vault is not there (vault.create_secret). Nothing was changed.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not there (net.http_post). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$guard$;

-- ── 1. the key, made here once ───────────────────────────────────────────────
do $key$
begin
  if not exists (select 1 from vault.secrets where name = 'booking_reminders_cron_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'booking_reminders_cron_key',
      'pg_cron booking-reminders-nudge proves itself to booking-reminders send_due with this (20261017a). Made by the database, never typed.'
    );
  end if;
end
$key$;

-- ── 2. the check the function asks ───────────────────────────────────────────
create or replace function public.booking_reminders_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'booking_reminders_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

comment on function public.booking_reminders_cron_ok(text) is
  '17 Oct 2026 (v5.11.73): is this the booking-reminders cron key? Service role only (booking-reminders asks it before send_due). Never returns the key.';

-- Supabase grants new functions to anon and authenticated directly, so both are revoked by name.
revoke all on function public.booking_reminders_cron_ok(text) from public, anon, authenticated;
grant execute on function public.booking_reminders_cron_ok(text) to service_role;

-- ── 3. what the job runs ─────────────────────────────────────────────────────
-- The URL is written out, like 20261016c's job (it survived the 22 Sep upgrade that broke
-- edge_base_url), and this file only ever runs on Ops (the guard above).
create or replace function public.booking_reminders_send_due()
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  k text;
  req bigint;
begin
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'booking_reminders_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'booking_reminders_send_due: no booking_reminders_cron_key in the vault (run 20261017a again)';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/booking-reminders',
    body := '{"action": "send_due"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

comment on function public.booking_reminders_send_due() is
  '17 Oct 2026 (v5.11.73): pg_cron booking-reminders-nudge. Posts send_due to booking-reminders with the vault key in x-cron-key. Holds no key itself. Never grant it to anyone.';

revoke all on function public.booking_reminders_send_due() from public, anon, authenticated, service_role;

-- ── 4. the job: every 5 minutes, as now, through the function ────────────────
do $cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'booking-reminders-nudge' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('booking-reminders-nudge', '*/5 * * * *', 'select public.booking_reminders_send_due();');
end
$cron$;

commit;

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   cron_key_secret 1, key_check_right true, key_check_wrong_refused true, key_check_short_refused true,
--   key_check_service_only 1, sender_closed 1, job_every_5_with_key 1, job_count 1, key_not_in_job 1
select
  (select count(*) from vault.secrets where name = 'booking_reminders_cron_key') as cron_key_secret,
  public.booking_reminders_cron_ok((select decrypted_secret from vault.decrypted_secrets where name = 'booking_reminders_cron_key' limit 1)) as key_check_right,
  not public.booking_reminders_cron_ok(repeat('0', 64)) as key_check_wrong_refused,
  not public.booking_reminders_cron_ok('') and not public.booking_reminders_cron_ok(null) as key_check_short_refused,
  (select case when not has_function_privilege('anon', 'public.booking_reminders_cron_ok(text)', 'execute')
                and not has_function_privilege('authenticated', 'public.booking_reminders_cron_ok(text)', 'execute')
                and has_function_privilege('service_role', 'public.booking_reminders_cron_ok(text)', 'execute')
           then 1 else 0 end) as key_check_service_only,
  (select case when not has_function_privilege('anon', 'public.booking_reminders_send_due()', 'execute')
                and not has_function_privilege('authenticated', 'public.booking_reminders_send_due()', 'execute')
                and not has_function_privilege('service_role', 'public.booking_reminders_send_due()', 'execute')
           then 1 else 0 end) as sender_closed,
  (select count(*) from cron.job where jobname = 'booking-reminders-nudge' and schedule = '*/5 * * * *'
     and command like '%public.booking_reminders_send_due()%') as job_every_5_with_key,
  (select count(*) from cron.job where jobname = 'booking-reminders-nudge') as job_count,
  (select count(*) from cron.job j where j.jobname = 'booking-reminders-nudge'
     and position((select decrypted_secret from vault.decrypted_secrets where name = 'booking_reminders_cron_key' limit 1) in j.command) = 0) as key_not_in_job;
