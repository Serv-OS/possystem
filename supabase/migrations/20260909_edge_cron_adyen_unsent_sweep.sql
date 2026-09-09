-- 20260909_edge_cron_adyen_unsent_sweep.sql
--
-- OPS DB ONLY (project ref tbetcegmszzotrwdtqhi). The guard below aborts on the
-- Platform DB.
--
-- Schedules adyen-terminal-charge action 'sweep_unsent' EVERY MINUTE through
-- the pg_cron -> pg_net -> edge function bridge from 20260805b_edge_cron_bridge.sql
-- (public.call_edge_fn). That bridge was confirmed APPLIED on the live Ops DB
-- in the 7 Aug 2026 drift audit (MIGRATION_DRIFT_AUDIT.md: cron.job live with
-- catering-release-5min, hubrise-reconcile-2min, ...). The precheck below still
-- refuses to schedule anything if it is missing, so a restored or staging DB
-- fails here, visibly, instead of logging a failure per minute in
-- cron.job_run_details where nobody reads it.
--
-- WHAT IT SCHEDULES, AND WHY
-- 9 Sep 2026 22:34 UTC, live venue, first in-person live card: terminal-job-create
-- minted an Adyen cloud job (status charging_unsent, charge_minor stamped, target
-- the live AMS1) and the TILL was responsible for the follow-up
-- adyen-terminal-charge 'start' kick. The till never sent it (a Sunmi WebView on
-- a stale bundle, the documented trap), the reader was never asked, and the job
-- sat charging_unsent with nexo_service_id null until the DB sweeper cancelled
-- it 15 minutes later. Same class as 19 Aug (v5.6.86 / v5.6.88).
--
-- The fix has two layers, and this file is the second:
--   1. terminal-job-create now kicks 'start' itself (service role, waitUntil,
--      1.5s after its response is committed), for every till that never kicks;
--   2. THIS JOB: the service-role sweep across every venue, once a minute, for
--      a create-time kick that was itself lost.
--   (A till-side ping of the sweep was built and removed in review: the action
--   is service role only, by decision, see the action block in the function.)
--
-- The sweep is cheap and idempotent: it selects adyen jobs in charging_unsent
-- created 20s to 100s ago (the ceiling sits inside the 120s stall rule of
-- 'result' recovery, which would otherwise abort a late re-kick under the
-- customer; older belongs to terminal_jobs_sweep / paxpay-sweep), not touched
-- in the last 20s, whose terminal is a paired CLOUD reader, and which are not
-- driven by the device itself over the local nexo bridge (MPOS on an Adyen
-- terminal), then fires 'start' for at most ten of them under waitUntil and
-- answers immediately. adyen-terminal-charge's CAS (charging_unsent ->
-- charging) means a kick that races the till, or another sweeper, is harmless:
-- exactly one initiator ever reaches the reader. Money never moves here; only
-- the request the till was supposed to send.
--
-- The action is SERVICE ROLE ONLY (a device or venue-user JWT gets 403).
-- call_edge_fn's vault-held bearer (edge_cron_key, or xero_cron_key as
-- fallback) is the same key that already gets loyalty-reconcile and the other
-- service-role-only functions in (20260806e), so nothing new is needed in vault.
--
-- ORDER OF OPERATIONS
--   1. Deploy the function FIRST. It is not deployed by pushing this file, and
--      edge functions drift silently:
--        npx supabase functions deploy adyen-terminal-charge \
--          --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      (terminal-job-create must be redeployed in the same change for layer 1.)
--      A schedule pointing at a function that does not know 'sweep_unsent' logs
--      a 400 per minute and rescues nothing.
--   2. Apply this migration.
--
-- WHY EVERY MINUTE
-- A customer is standing at the reader. The till's own kick is immediate, the
-- server's create-time kick fires 1.5s later; this is the floor for the case
-- where both were lost. The job is eligible from 20s to 100s after create, an
-- 80s window, so a 1-minute schedule lands in it at least once. One SELECT per
-- minute over an indexed status is nothing, and the function answers in
-- milliseconds when there is nothing to do.

begin;

-- Wrong-database guard. Ops has user_locations and no billing_state; Platform is
-- the other way round (same test as 20260806e).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it - aborting.';
  end if;
end
$guard$;

-- The bridge from 20260805b. Fail here, where it is visible.
do $precheck$
begin
  if to_regprocedure('public.call_edge_fn(text, jsonb)') is null then
    raise exception
      'public.call_edge_fn(text, jsonb) is missing - apply 20260805b_edge_cron_bridge.sql first (it also needs the edge_cron_key / edge_base_url vault secrets).';
  end if;
end
$precheck$;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------
-- Same idiom as 20260805b / 20260806e: unschedule-then-schedule so re-running
-- the file is a no-op, and a warning rather than an error on a database with
-- no pg_cron so the rest of a migration run still lands.
do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database - adyen-unsent-sweep was NOT scheduled.';
    return;
  end if;

  for j in
    select * from (values
      -- name,                   schedule,      command
      ('adyen-unsent-sweep-1min', '* * * * *',  $q$select public.call_edge_fn('adyen-terminal-charge', '{"action":"sweep_unsent"}'::jsonb)$q$)
    ) as t(nm, sch, cmd)
  loop
    if exists (select 1 from cron.job where jobname = j.nm) then
      perform cron.unschedule(j.nm);
    end if;
    perform cron.schedule(j.nm, j.sch, j.cmd);
  end loop;
end;
$$;

commit;


-- ---------------------------------------------------------------------------
-- Verify after applying
-- ---------------------------------------------------------------------------
--   select jobname, schedule, active from cron.job where jobname = 'adyen-unsent-sweep-1min';
--
--   -- wait a minute, then the pg_cron side:
--   select j.jobname, d.status, d.return_message, d.end_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'adyen-unsent-sweep-1min' and d.end_time > now() - interval '10 minutes'
--    order by d.end_time desc;
--
--   -- and the HTTP side. The body is the report, read it:
--   select id, status_code, left(content, 300) from net._http_response order by id desc limit 5;
--
-- A healthy idle tick looks like:
--   {"ok":true,"scanned":0,"kicked":[],"skipped":[]}
-- A rescue looks like:
--   {"ok":true,"scanned":1,"kicked":["<job id>"],"skipped":[]}
-- and leaves a row in the PLATFORM DB's adyen_webhook_events with
-- event_key like 'unsent-sweep:%' (only written when something was kicked).
-- A 400 {"error":"action (...) and job_id required"} means the function was not
-- redeployed with 'sweep_unsent' (step 1 above). A 403 means call_edge_fn's vault
-- key is not the service role key this function accepts.
--
-- To pause it without deleting the schedule:
--   select cron.alter_job((select jobid from cron.job where jobname = 'adyen-unsent-sweep-1min'),
--                         active := false);
