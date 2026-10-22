-- 20261022b_OPS_loyalty_otp_audit.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Safe to run twice. One transaction. Any time, in service too: no till,   #
-- #  stand, table or customer facing row is touched. Nothing to copy or       #
-- #  paste: the key is made here, inside the database vault, never seen.      #
-- ############################################################################
--
-- WHY (v5.11.94, 22 Oct 2026, after PR 317)
--   The name in a loyalty sign in code text is the Twilio Verify SERVICE's friendly name, and each
--   venue has its own service. On 21 Oct 2026 four venues of one company had no service of their
--   own, making one failed, and their customers' codes went out under another venue's name. PR 317
--   made the send refuse instead. This release makes the service eagerly (new venue, rename, name
--   saved, loyalty switched on) and checks EVERY venue every night: the loyalty-otp edge function's
--   `audit` action makes or repairs what is wrong, records each venue's state, and raises a feed
--   alert for a venue still not right.
--
-- WHY OPS AND NOT PLATFORM
--   The services and their rows live in the Platform database, but the Platform project has no
--   pg_cron (only the vault). Ops has pg_cron, pg_net and the vault, and runs every other job
--   (booking-reminders-nudge, stock-nightly). The job posts to the loyalty-otp function, which
--   holds both databases' service keys, so the check itself needs nothing from Platform here.
--
-- WHAT THIS ADDS (the booking-reminders cron key pattern, 20261017a)
--   1  A random key in the vault, secret loyalty_otp_cron_key (64 hex characters from two random
--      uuids). Made once: a second run keeps the same key.
--   2  public.loyalty_otp_cron_ok(p_key): true only for that key. Service role only (the
--      loyalty-otp function asks it); never the public key or a signed in user. Never returns the key.
--   3  public.loyalty_otp_audit_send(): what the job runs. Reads the key from the vault at call time
--      and posts {"action":"audit"} to loyalty-otp with the header x-cron-key. The key is not in the
--      job's text. Nobody may call it but the job (revoked from every API role).
--   4  The job loyalty-otp-audit at 04:10 UTC every night (after stock-nightly at 03:40).
--   5  The table public.loyalty_otp_service_audit: one row per venue, the last check's answer
--      (state, the service sid, the name it carries, the name it should carry, Twilio's words when
--      it refused). RLS on, no policies, service role only: Back Office reads a venue's state
--      through the message-templates function, never this table.
--   6  The table public.loyalty_otp_audit_runs: one row per audit run (when, who, how many venues,
--      how many not ready, the errors it met). The overnight watchdog (watchdog-status, service
--      role) reads it and the audit table, so a venue still not right, a run that did not finish,
--      or a nightly check that stopped running reaches Peter as a GitHub issue in the morning,
--      not only a venue's activity feed. RLS on, no policies, service role only.
--
-- ORDER (either order is safe)
--   1  Run this file. Until loyalty-otp v5.11.94 is deployed the job's post is answered with
--      "Unknown action" and nothing else happens.
--   2  Deploy loyalty-otp (and message-templates, location-admin, provision-location,
--      loyalty-config), each --no-verify-jwt as today. Before this file has run the function
--      refuses the cron route (fails closed); staff, the service role and the send path's own
--      repair work either way.
--
-- AFTER RUNNING
--   Read the check row at the bottom. Then run the first audit by hand (Back Office at a venue >
--   Messages > Verification code > Fix, or one service role call {"action":"audit"} to loyalty-otp)
--   and read: select location_id, ok, state, name, desired_name, twilio_error, checked_at
--             from public.loyalty_otp_service_audit order by ok, checked_at desc;
--
-- UNDO: 20261022b_OPS_loyalty_otp_audit_ROLLBACK.sql (job, functions and tables removed; the vault
-- key is left, it is harmless and a second run of this file reuses it).

begin;

-- Wrong database guard (the same test as 20261017a): Ops has user_locations and no billing_state.
-- And the three things this needs: the vault, pg_net and pg_cron (signatures as live, read 17 Oct 2026:
-- vault.create_secret(text,text,text,uuid), net.http_post(text,jsonb,jsonb,jsonb,integer),
-- cron.schedule(text,text,text), cron.unschedule(bigint)).
do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regclass('public.activity_events') is null then
    raise exception 'activity_events is not there (20260629c). Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'The database vault is not there (vault.create_secret). Nothing was changed.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not there (net.http_post). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$guard$;

-- ── 1. the key, made here once ───────────────────────────────────────────────
do $key$
begin
  if not exists (select 1 from vault.secrets where name = 'loyalty_otp_cron_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'loyalty_otp_cron_key',
      'pg_cron loyalty-otp-audit proves itself to loyalty-otp audit with this (20261022b). Made by the database, never typed.'
    );
  end if;
end
$key$;

-- ── 2. the check the function asks ───────────────────────────────────────────
create or replace function public.loyalty_otp_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'loyalty_otp_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

comment on function public.loyalty_otp_cron_ok(text) is
  '22 Oct 2026 (v5.11.94): is this the loyalty-otp-audit cron key? Service role only (loyalty-otp asks it before an audit). Never returns the key.';

-- Supabase grants new functions to anon and authenticated directly, so both are revoked by name.
revoke all on function public.loyalty_otp_cron_ok(text) from public, anon, authenticated;
grant execute on function public.loyalty_otp_cron_ok(text) to service_role;

-- ── 3. what the job runs ─────────────────────────────────────────────────────
-- The URL is written out, like 20261017a's job (it survived the 22 Sep upgrade that broke
-- edge_base_url), and this file only ever runs on Ops (the guard above). The audit reads every
-- venue and talks to Twilio, so it waits up to 60 seconds for the answer.
create or replace function public.loyalty_otp_audit_send()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  k text;
  req bigint;
begin
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'loyalty_otp_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'loyalty_otp_audit_send: no loyalty_otp_cron_key in the vault (run 20261022b again)';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/loyalty-otp',
    body := '{"action": "audit"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 60000
  ) into req;
  return req;
end
$fn$;

comment on function public.loyalty_otp_audit_send() is
  '22 Oct 2026 (v5.11.94): pg_cron loyalty-otp-audit. Posts audit to loyalty-otp with the vault key in x-cron-key. Holds no key itself. Never grant it to anyone.';

revoke all on function public.loyalty_otp_audit_send() from public, anon, authenticated, service_role;

-- ── 4. the job: 04:10 UTC every night, through the function ──────────────────
do $cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'loyalty-otp-audit' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('loyalty-otp-audit', '10 4 * * *', 'select public.loyalty_otp_audit_send();');
end
$cron$;

-- ── 5. the audit table: the last check's answer per venue, service role only ──
create table if not exists public.loyalty_otp_service_audit (
  location_id   uuid primary key,                  -- the OPS location id (what every client sends)
  company_id    uuid,
  ok            boolean not null default false,
  state         text not null,                      -- ready | no_name | no_service | points_at_shared | missing_on_twilio | twilio_unreadable | name_drift | not_configured
  action_taken  text,                               -- none | created | recreated | renamed
  service_sid   text,                               -- the venue's Twilio Verify service (VA...)
  name          text,                               -- the name the service carries at Twilio
  desired_name  text,                               -- the name it must carry (Back Office override, else the venue name)
  twilio_error  text,                               -- Twilio's words when it refused, never only in a log again
  run_by        text,                               -- cron_key | service_role | staff | loyalty_on | send
  checked_at    timestamptz not null default now()
);

comment on table public.loyalty_otp_service_audit is
  '22 Oct 2026 (v5.11.94): the last nightly (or hand run) check of each venue''s loyalty code text service. Written by loyalty-otp audit (service role). Back Office reads a venue''s state through message-templates service_status, never this table.';

alter table public.loyalty_otp_service_audit enable row level security;
revoke all on table public.loyalty_otp_service_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.loyalty_otp_service_audit to service_role;

-- ── 6. one row per audit run, for the watchdog ───────────────────────────────
create table if not exists public.loyalty_otp_audit_runs (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  run_by      text not null,                       -- cron_key | service_role | staff | loyalty_on
  company_id  uuid,                                -- null: every venue (the nightly run); else one company
  fix         boolean not null default true,
  ok          boolean not null default false,      -- every venue checked, none skipped, no errors
  checked     integer not null default 0,
  ready       integer not null default 0,
  not_ready   integer not null default 0,
  skipped     integer not null default 0,
  errors      jsonb not null default '[]'::jsonb,  -- what the run met (a table write refused, a crash)
  ms          integer
);

create index if not exists loyalty_otp_audit_runs_ran_at_idx on public.loyalty_otp_audit_runs (ran_at desc);

comment on table public.loyalty_otp_audit_runs is
  '22 Oct 2026 (v5.11.94): one row per loyalty code text audit run (loyalty-otp audit, service role). The watchdog reads the newest full run (company_id null) to know the nightly check ran and finished. Rows older than 90 days are removed by the audit itself.';

alter table public.loyalty_otp_audit_runs enable row level security;
revoke all on table public.loyalty_otp_audit_runs from public, anon, authenticated;
revoke all on sequence public.loyalty_otp_audit_runs_id_seq from public, anon, authenticated;
grant select, insert, delete on table public.loyalty_otp_audit_runs to service_role;
grant usage on sequence public.loyalty_otp_audit_runs_id_seq to service_role;

commit;

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   cron_key_secret 1, key_check_right true, key_check_wrong_refused true, key_check_short_refused true,
--   key_check_service_only 1, sender_closed 1, job_0410_with_key 1, job_count 1, key_not_in_job 1,
--   audit_table_closed 1, runs_table_closed 1
select
  (select count(*) from vault.secrets where name = 'loyalty_otp_cron_key') as cron_key_secret,
  public.loyalty_otp_cron_ok((select decrypted_secret from vault.decrypted_secrets where name = 'loyalty_otp_cron_key' limit 1)) as key_check_right,
  not public.loyalty_otp_cron_ok(repeat('0', 64)) as key_check_wrong_refused,
  not public.loyalty_otp_cron_ok('') and not public.loyalty_otp_cron_ok(null) as key_check_short_refused,
  (select case when not has_function_privilege('anon', 'public.loyalty_otp_cron_ok(text)', 'execute')
                and not has_function_privilege('authenticated', 'public.loyalty_otp_cron_ok(text)', 'execute')
                and has_function_privilege('service_role', 'public.loyalty_otp_cron_ok(text)', 'execute')
           then 1 else 0 end) as key_check_service_only,
  (select case when not has_function_privilege('anon', 'public.loyalty_otp_audit_send()', 'execute')
                and not has_function_privilege('authenticated', 'public.loyalty_otp_audit_send()', 'execute')
                and not has_function_privilege('service_role', 'public.loyalty_otp_audit_send()', 'execute')
           then 1 else 0 end) as sender_closed,
  (select count(*) from cron.job where jobname = 'loyalty-otp-audit' and schedule = '10 4 * * *'
     and command like '%public.loyalty_otp_audit_send()%') as job_0410_with_key,
  (select count(*) from cron.job where jobname = 'loyalty-otp-audit') as job_count,
  (select count(*) from cron.job j where j.jobname = 'loyalty-otp-audit'
     and position((select decrypted_secret from vault.decrypted_secrets where name = 'loyalty_otp_cron_key' limit 1) in j.command) = 0) as key_not_in_job,
  (select case when (select relrowsecurity from pg_class where oid = 'public.loyalty_otp_service_audit'::regclass)
                and not has_table_privilege('anon', 'public.loyalty_otp_service_audit', 'select')
                and not has_table_privilege('authenticated', 'public.loyalty_otp_service_audit', 'select')
                and has_table_privilege('service_role', 'public.loyalty_otp_service_audit', 'insert')
           then 1 else 0 end) as audit_table_closed,
  (select case when (select relrowsecurity from pg_class where oid = 'public.loyalty_otp_audit_runs'::regclass)
                and not has_table_privilege('anon', 'public.loyalty_otp_audit_runs', 'select')
                and not has_table_privilege('authenticated', 'public.loyalty_otp_audit_runs', 'select')
                and has_table_privilege('service_role', 'public.loyalty_otp_audit_runs', 'insert')
                and has_table_privilege('service_role', 'public.loyalty_otp_audit_runs', 'select')
           then 1 else 0 end) as runs_table_closed;
