-- 20260805_scheduled_automations.sql  (part A — no secrets required)
--
-- Fixes the two scheduled jobs that need no credentials, and stops the run-log
-- growing without bound. The edge-function schedules live in part B
-- (20260805b_edge_cron_bridge.sql) because they need a vault secret.
--
-- Context: of the 8 features in this repo that need a timer, 1 worked, 1 had
-- failed 20,538 consecutive times, 1 had never fired, and 5 had no trigger at
-- all (they were declared in vercel.json, but Vercel only runs crons on
-- Production deployments — develop and staging are Previews).

begin;

-- ---------------------------------------------------------------------------
-- 1. Fix paxpay-sweep — 20,538 consecutive failures since 2026-07-21
-- ---------------------------------------------------------------------------
-- terminal_jobs_sweep() guards itself with _terminal_is_service_role(), which
-- reads the PostgREST GUC request.jwt.claims. pg_cron runs as current_user =
-- postgres and never sets that GUC, so the guard was always false and the sweep
-- aborted on line 4 every minute for two weeks. Money-safety consequence:
-- abandoned PaxPay payments are never expired or quarantined, and terminals wedge.
--
-- The wrapper sets the claim transaction-locally (set_config(..., is_local => true))
-- so it is scoped to this one pg_cron transaction and cannot leak into any other
-- session. This is a wrapper rather than a change to the guard itself precisely so
-- the fence stays intact for every other caller.
create or replace function public.terminal_jobs_sweep_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.terminal_jobs_sweep();
end;
$$;

comment on function public.terminal_jobs_sweep_cron() is
  'pg_cron entry point for terminal_jobs_sweep(). Sets the service_role claim transaction-locally so the sweep''s own fence passes. Revoked from anon/authenticated — this is the only caller permitted to bypass that guard.';

revoke all on function public.terminal_jobs_sweep_cron() from public;
do $$ begin
  execute 'revoke all on function public.terminal_jobs_sweep_cron() from anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Reschedule the sweep onto the wrapper, and start purging the run log
-- ---------------------------------------------------------------------------
-- cron.job_run_details is never purged by pg_cron and had reached 20,565 rows /
-- 5.5 MB, growing 1,441/day — almost entirely the paxpay-sweep failure log.
do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database — no jobs were scheduled. Install it and re-run this migration.';
    return;
  end if;

  for j in
    select * from (values
      ('paxpay-sweep',   '* * * * *',  $q$select public.terminal_jobs_sweep_cron()$q$),
      ('cron-log-purge', '30 2 * * *', $q$delete from cron.job_run_details where end_time < now() - interval '7 days'$q$)
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
