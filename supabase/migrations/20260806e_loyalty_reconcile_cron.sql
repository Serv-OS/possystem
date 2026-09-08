-- 20260806e_loyalty_reconcile_cron.sql
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi
--   (the guard below aborts if you run it against the Platform DB)
--
-- Schedules supabase/functions/loyalty-reconcile hourly.
--
-- WHAT IT SCHEDULES
-- loyalty-redeem debits the points on PLATFORM (loyalty_redeem_points + the
-- loyalty_redemption_claims row, one transaction) and writes the ops.loyalty_transactions
-- audit row afterwards — two clusters, no shared transaction. Its own comment says a
-- scheduled anti-join of the claims against the ledger "would close the gap properly; it does
-- not exist yet". This is that job. Until it runs, a redemption whose ledger write failed all
-- three retries is missing from every loyalty report and its only trace is a log line and one
-- activity_events row. (The MONEY was already recoverable — loyalty-refund reads the claim
-- rows directly. This is about the books.)
--
-- ⚠ ORDER OF OPERATIONS — this file is LAST of three:
--   1. 20260806c_redeem_atomic.sql SECTION B, on the PLATFORM DB (yhzjgyrkyjabvhblqxzu).
--      It creates public.loyalty_redemption_claims, which is the table the function reads.
--      Nothing here can check that — it is a different Postgres cluster — so if it has not been
--      applied the job will simply return 503 with that instruction on every tick.
--   2. Deploy the function. It is NOT deployed by pushing this file, and edge functions drift
--      silently:
--        npx supabase functions deploy loyalty-reconcile \
--          --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      A schedule pointing at a function that was never deployed logs a 404 per tick and
--      reconciles nothing.
--   3. Apply this migration.
-- 20260805b_edge_cron_bridge.sql must also already be in place — the precheck below refuses
-- to schedule anything without public.call_edge_fn.
--
-- WHY HOURLY, AND WHY :17
-- The gap this closes is a reporting gap on an already-recoverable redemption, so lag costs
-- nothing; hourly is ample and gives every claim 168 passes inside the function's default
-- 7-day lookback window. :17 keeps it off the top of the hour, where marketing-run-hourly and
-- review-request-scan already fire together.
--
-- The function is service-role only, so call_edge_fn's vault-held bearer is what gets it in;
-- nothing else can reach it.

begin;

-- Wrong-database guard. Ops has user_locations and no billing_state; Platform is the other
-- way round (same test as 20260806b and 20260806c Section A).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it — aborting.';
  end if;
end
$guard$;

-- The bridge from 20260805b. Without it cron.schedule would happily accept the command and
-- every tick would fail with "function call_edge_fn does not exist" in job_run_details, which
-- nobody reads — fail here instead, where it is visible.
do $precheck$
begin
  -- to_regprocedure, not to_regproc: the former takes a full signature, the latter takes a
  -- bare name and throws on an overloaded one.
  if to_regprocedure('public.call_edge_fn(text, jsonb)') is null then
    raise exception
      'public.call_edge_fn(text, jsonb) is missing — apply 20260805b_edge_cron_bridge.sql first (it also needs the edge_cron_key / edge_base_url vault secrets).';
  end if;
end
$precheck$;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------
-- Same idiom as 20260805b: unschedule-then-schedule so re-running the file is a no-op, and a
-- warning rather than an error on a database with no pg_cron (local, or a restore where the
-- extension has not been enabled yet) so the rest of a migration run still lands.
do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database — loyalty-reconcile was NOT scheduled.';
    return;
  end if;

  for j in
    select * from (values
      -- name,                      schedule,       command
      ('loyalty-reconcile-hourly',  '17 * * * *',   $q$select public.call_edge_fn('loyalty-reconcile')$q$)
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
--   select jobname, schedule, active from cron.job where jobname = 'loyalty-reconcile-hourly';
--
--   -- wait for a tick (or force one), then the pg_cron side:
--   select j.jobname, d.status, d.return_message, d.end_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'loyalty-reconcile-hourly' and d.end_time > now() - interval '2 hours'
--    order by d.end_time desc;
--
--   -- and the HTTP side — the body is the report, so read it, do not just check for 200:
--   select id, status_code, left(content, 500) from net._http_response order by id desc limit 5;
--
-- A healthy tick looks like:
--   {"ok":true,"complete":true,"scanned":N,"missing":0,"backfilled":0,"raced":0,
--    "unresolved":0,"failed":0, ...}
-- `complete:false` means the window was not fully walked — `stopped_on` says which bound was
-- hit and `next_after` is the cursor to resume from:
--   select public.call_edge_fn('loyalty-reconcile', '{"after":"<next_after>"}'::jsonb);
-- The function's own run budget is deliberately shorter than call_edge_fn's 25s pg_net timeout,
-- so a long run answers `complete:false` instead of finishing after pg_net stopped listening and
-- leaving no report to read.
-- `unresolved` > 0 means a claim could not be rebuilt into a ledger row: location_id is NOT NULL
-- on loyalty_transactions and none of the three sources for it answered (the closed check named
-- in the key, loyalty-redeem's own activity_events alert row, or a company that has exactly one
-- venue). It will not guess a venue. Those keys are in samples.unresolved_keys and need a person.
--
-- ---------------------------------------------------------------------------
-- Manual / one-off use
-- ---------------------------------------------------------------------------
-- The hourly tick only looks at the last 7 days. To sweep everything once — safely first:
--   select public.call_edge_fn('loyalty-reconcile',
--          '{"lookback_hours":87600,"max_scan":20000,"dry_run":true}'::jsonb);
-- then drop dry_run to write. A sweep that size will very likely answer `complete:false` on the
-- run budget, so repeat it with the `after` cursor it hands back until `complete:true`. Re-running
-- is harmless either way: the backfill upserts on the unique idempotency_key with ON CONFLICT DO
-- NOTHING, so a second pass over the same ground finds nothing to do.
--
-- To pause it without deleting the schedule:
--   select cron.alter_job((select jobid from cron.job where jobname = 'loyalty-reconcile-hourly'),
--                         active := false);
