-- 20260805b_edge_cron_bridge.sql  (part B — needs a vault secret)
--
-- Moves the four dormant Vercel crons, plus the two that never had any scheduler,
-- onto pg_cron + pg_net. Ownership moves INSIDE the database so staging schedules
-- staging's work and production schedules production's — no SUPABASE_URL fallback
-- landmine, and no waiting for a Production deployment. The vercel.json `crons`
-- block is removed in the same commit so nothing double-fires when main ships;
-- the api/*-cron.js routes stay as manual/emergency triggers.
--
-- Pattern proven here already: xero-nightly-sales runs pg_cron -> pg_net ->
-- edge function and returned HTTP 200 today.

begin;

-- ---------------------------------------------------------------------------
-- 1. Where do edge-function calls go?
-- ---------------------------------------------------------------------------
-- Resolved from vault so each environment targets itself. There IS a hardcoded
-- fallback, but it is fenced to the exact physical cluster this migration was
-- written against: system_identifier is unique per cluster and changes when the
-- schema is restored into a new Supabase project. A staging DB seeded from a
-- production dump therefore does NOT inherit the production URL — it raises until
-- someone sets the secret. This is the structural fix for "all four cron routes
-- silently fall back to the production Supabase URL".
create or replace function public.edge_base_url()
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare u text; sysid text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name = 'edge_base_url' limit 1;
  if u is not null and u <> '' then
    return rtrim(u, '/');
  end if;

  select system_identifier::text into sysid from pg_control_system();
  if sysid = '7623125441096521075' then          -- the ops dev cluster, 5 Aug 2026
    return 'https://tbetcegmszzotrwdtqhi.supabase.co';
  end if;

  raise exception
    'edge_base_url is not configured on this database (system_identifier=%). Run: select vault.create_secret(''https://<project-ref>.supabase.co'', ''edge_base_url'', ''pg_cron -> edge functions'');',
    sysid;
end;
$$;

comment on function public.edge_base_url() is
  'Base URL for pg_cron -> edge function calls. vault(edge_base_url) wins; the hardcoded fallback applies only on the original dev cluster, so a restored/staging DB fails loudly instead of driving production.';

-- ---------------------------------------------------------------------------
-- 2. The single way scheduled SQL reaches an edge function
-- ---------------------------------------------------------------------------
-- The bearer never leaves the database — it is read from vault inside the function
-- body at call time. edge_cron_key is preferred; xero_cron_key is accepted as a
-- fallback because it already exists on this project and already holds a key the
-- edge functions accept.
create or replace function public.call_edge_fn(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare k text; base text; req bigint;
begin
  if fn is null or fn = '' then raise exception 'call_edge_fn: fn is required'; end if;
  base := public.edge_base_url();

  select decrypted_secret into k from vault.decrypted_secrets where name = 'edge_cron_key' limit 1;
  if k is null or k = '' then
    select decrypted_secret into k from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  end if;
  if k is null or k = '' then
    raise exception 'call_edge_fn: no key in vault (expected edge_cron_key, or xero_cron_key as fallback)';
  end if;

  select net.http_post(
    url                  := base || '/functions/v1/' || fn,
    body                 := coalesce(body, '{}'::jsonb),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    timeout_milliseconds := 25000
  ) into req;

  return req;
end;
$$;

comment on function public.call_edge_fn(text, jsonb) is
  'pg_cron -> edge function bridge. Holds no secrets itself; reads the bearer from vault at call time. Never grant to anon/authenticated.';

revoke all on function public.edge_base_url()           from public;
revoke all on function public.call_edge_fn(text, jsonb) from public;
do $$ begin
  execute 'revoke all on function public.edge_base_url() from anon, authenticated';
  execute 'revoke all on function public.call_edge_fn(text, jsonb) from anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3. Schedules
-- ---------------------------------------------------------------------------
do $$
declare j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database — no jobs were scheduled.';
    return;
  end if;

  for j in
    select * from (values
      -- name,                    schedule,      command,                                                                            active
      ('catering-release-5min',   '*/5 * * * *', $q$select public.call_edge_fn('catering-release')$q$,                                true),
      ('hubrise-reconcile-2min',  '*/2 * * * *', $q$select public.call_edge_fn('hubrise-reconcile')$q$,                               true),
      ('ops-escalate-5min',       '*/5 * * * *', $q$select public.call_edge_fn('ops-escalate')$q$,                                    true),

      -- PARKED (active=false). These two message real customers, and nobody has
      -- confirmed the recipient list or the sandbox posture for this environment.
      -- The plumbing is complete; enabling is one line each:
      --   select cron.alter_job((select jobid from cron.job where jobname='marketing-run-hourly'), active := true);
      --   select cron.alter_job((select jobid from cron.job where jobname='review-request-scan'),  active := true);
      -- Before enabling marketing-run, either set the MARKETING_SANDBOX=true edge
      -- secret (logs instead of sends) or confirm every `customers` row is safe to mail.
      ('marketing-run-hourly',    '0 * * * *',   $q$select public.call_edge_fn('marketing-run')$q$,                                   false),
      ('review-request-scan',     '0 * * * *',   $q$select public.call_edge_fn('review-request', '{"action":"scan_all"}'::jsonb)$q$,  false)
    ) as t(nm, sch, cmd, act)
  loop
    if exists (select 1 from cron.job where jobname = j.nm) then
      perform cron.unschedule(j.nm);
    end if;
    perform cron.schedule(j.nm, j.sch, j.cmd);
    if not j.act then
      perform cron.alter_job((select jobid from cron.job where jobname = j.nm), active := false);
    end if;
  end loop;
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verify after applying
-- ---------------------------------------------------------------------------
--   select jobname, schedule, active from cron.job order by jobname;
--   -- wait one tick, then:
--   select j.jobname, d.status, d.return_message, d.end_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where d.end_time > now() - interval '15 minutes' order by d.end_time desc;
--   -- and confirm the HTTP side actually answered 200:
--   select id, status_code, left(content, 200) from net._http_response order by id desc limit 10;
