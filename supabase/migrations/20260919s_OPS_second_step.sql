-- 20260919s_OPS_second_step.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  BACK OFFICE SECOND SIGN IN STEP (Face ID, fingerprint, authenticator).   #
-- #  Run it OUTSIDE SERVICE. Peter pastes it into the Ops SQL editor and      #
-- #  presses Run. Claude never runs it. The runbook is docs/SECOND_STEP.md.   #
-- #  There is NO Platform file: nobody ever signs in to Platform (0 logins).  #
-- ############################################################################
--
-- BREAK GLASS (one line, any time, takes effect within 30 seconds, no deploy):
--   update public.second_step_settings set enforce = false, updated_at = now() where id;
-- If sign in ITSELF is broken (Supabase MFA down), also let the app skip the step:
--   update public.second_step_settings set enforce = false, app_gate = false, updated_at = now() where id;
--
-- WHY (Peter, 18 Sep 2026): "so no matter if a hacker gets the password they cant login".
-- A Back Office login that has only typed a password is "aal1". After Face ID, fingerprint
-- or an authenticator app code the auth server stamps its token "aal2". The app asks for the
-- second step at every sign in, but a thief with a password could skip the app and call the
-- database or a server function directly. This file makes the DATABASE refuse aal1 logins
-- too, once Peter switches enforcement on.
--
-- WHAT THIS FILE CHANGES
--   1. public.second_step_settings: one row. enforce (default FALSE) turns the refusal on;
--      app_gate (default TRUE) is the app's break glass. Only the service role can write it.
--   2. public.second_step_resets: the audit trail of lost phone resets (second-step-reset
--      edge function). Service role only.
--   3. Functions: second_step_decide (the pure rule), second_step_ok (the rule for THIS
--      request), second_step_status (what the app reads), second_step_check_request
--      (the PostgREST pre-request check).
--   4. A RESTRICTIVE policy "second_step_fence" on every public table that has row level
--      security, and on storage.objects. Restrictive means it is ANDed with the existing
--      policies: it never lets anyone in, it only refuses a password only login.
--   5. The PostgREST pre-request check (Supabase documents this: "Securing your API"):
--      every Data API request (tables AND the 86 SECURITY DEFINER functions, which skip
--      row level security) first calls second_step_check_request(). Realtime and Storage
--      do not run it, which is why step 4 exists too.
--
-- WHO IS NEVER AFFECTED, whatever the switch says:
--   * anonymous sessions: every till, KDS, kiosk, TV, host stand, manager app, customer page
--   * the service role (every edge function's own writes) and the bare public key
--   * direct database work with no request (this editor, cron, triggers)
--   * a login that finished its second step (aal2)
--
-- WHAT IT DOES NOT FIX (the database fence project, 20260919a to d, does): the tables that
-- are open to the bare public key or to ANY session. A thief with only the public key is
-- not a login, so the second step cannot be what stops them.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again); every
-- statement can run twice; 3 second lock wait (busy tables make it stop, not queue);
-- functions are SECURITY DEFINER with search_path pinned; a self test runs BEFORE the
-- pre-request check is switched on and aborts the whole file if anything is wrong;
-- verification at the bottom; roll back in the comments at the very end.
--
-- AFTER ANY LATER MIGRATION THAT ADDS A TABLE: run this file again. It only adds the fence
-- to tables that do not have it yet (verification query V3 lists any that are missing).


-- ============================================================================
-- 0. Guards
-- ============================================================================
set lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.order_queue') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regprocedure('auth.jwt()') is null
     or to_regrole('authenticator') is null
     or to_regrole('authenticated') is null
     or to_regrole('anon') is null
     or to_regrole('service_role') is null then
    raise exception 'auth.jwt() or a Supabase role is missing. This is not the database this file was written for. Nothing was changed.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. The switch
-- ============================================================================
create table if not exists public.second_step_settings (
  id          boolean primary key default true check (id),
  enforce     boolean not null default false,
  app_gate    boolean not null default true,
  updated_at  timestamptz not null default now(),
  note        text
);
comment on table public.second_step_settings is
  'Back Office second sign in step (docs/SECOND_STEP.md). ONE row. enforce=true: the database and the edge functions refuse password only logins. app_gate=false: break glass, the app stops asking. Service role only.';

insert into public.second_step_settings (id) values (true) on conflict (id) do nothing;

alter table public.second_step_settings enable row level security;
revoke all on table public.second_step_settings from anon, authenticated;
grant select, insert, update on table public.second_step_settings to service_role;


-- ============================================================================
-- 2. The reset audit trail
-- ============================================================================
create table if not exists public.second_step_resets (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  actor_id         uuid not null,
  actor_kind       text not null check (actor_kind in ('super_admin', 'owner')),
  target_id        uuid not null,
  location_id      uuid,
  reason           text,
  factors_removed  integer not null default 0,
  factor_types     text[] not null default '{}',
  outcome          text not null default 'started' check (outcome in ('started', 'done', 'partial', 'failed')),
  emailed          boolean not null default false
);
comment on table public.second_step_resets is
  'Every lost phone reset of a Back Office second step (second-step-reset edge function). Written before anything is removed. Service role only.';
create index if not exists second_step_resets_target_idx on public.second_step_resets (target_id, created_at desc);
create index if not exists second_step_resets_actor_idx on public.second_step_resets (actor_id, created_at desc);

alter table public.second_step_resets enable row level security;
revoke all on table public.second_step_resets from anon, authenticated;
grant select, insert, update on table public.second_step_resets to service_role;


-- ============================================================================
-- 3. The rule
-- ============================================================================
-- The pure rule. Mirrors classifyCaller + mustRefuse in
-- supabase/functions/_shared/second-step.ts: change both together.
create or replace function public.second_step_decide(p_claims jsonb, p_enforce boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_claims is null                          then true   -- no request at all (editor, cron, triggers)
    when p_claims->>'role' = 'service_role'        then true   -- edge functions' own writes
    when coalesce(p_claims->>'sub', '') = ''       then true   -- the bare public key (no user)
    when p_claims->>'is_anonymous' = 'true'        then true   -- tills, kiosks, KDS, TVs, customer pages
    when p_claims->>'aal' = 'aal2'                 then true   -- finished the second step
    else not coalesce(p_enforce, false)                        -- password only: allowed only while OFF
  end
$$;
revoke all on function public.second_step_decide(jsonb, boolean) from public;

-- The rule for the request running now. Reads the switch ONLY for a password only login,
-- so the till fleet never touches the settings table.
create or replace function public.second_step_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims  jsonb := auth.jwt();
  v_enforce boolean;
begin
  if public.second_step_decide(v_claims, true) then
    return true;
  end if;
  select s.enforce into v_enforce from public.second_step_settings s where s.id;
  return public.second_step_decide(v_claims, v_enforce);
end
$$;
revoke all on function public.second_step_ok() from public;
grant execute on function public.second_step_ok() to anon, authenticated, service_role;

-- What the app reads at sign in (break glass). Anyone signed in may read two booleans.
create or replace function public.second_step_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('enforce', s.enforce, 'app_gate', s.app_gate) from public.second_step_settings s where s.id),
    jsonb_build_object('enforce', false, 'app_gate', true)
  )
$$;
revoke all on function public.second_step_status() from public;
grant execute on function public.second_step_status() to authenticated, service_role;

-- The PostgREST pre-request check. NEVER drop this function while
-- pgrst.db_pre_request still names it: every Data API request would fail. Use the roll
-- back block at the end, which switches the check off first.
create or replace function public.second_step_check_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.second_step_ok() then
    raise exception using
      errcode = '42501',
      message = 'second_step_required',
      detail  = 'This Back Office sign in has not finished its second step.',
      hint    = 'Sign out, then sign in again with Face ID, fingerprint or your authenticator app code.';
  end if;
end
$$;
grant execute on function public.second_step_check_request() to anon, authenticated, service_role, authenticator;


-- ============================================================================
-- 4. The fence: a RESTRICTIVE policy on every public table with row level security
-- ============================================================================
-- (select ...) makes Postgres work the answer out once per statement, not per row.
do $fence$
declare
  r record;
  n_added integer := 0;
  n_had   integer := 0;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and c.relname not in ('second_step_settings', 'second_step_resets')
    order by c.relname
  loop
    if exists (select 1 from pg_policy p where p.polrelid = r.oid and p.polname = 'second_step_fence') then
      n_had := n_had + 1;
    else
      execute format(
        'create policy second_step_fence on %I.%I as restrictive for all to authenticated '
        'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))',
        'public', r.relname);
      n_added := n_added + 1;
    end if;
  end loop;
  raise notice 'second_step_fence: added to % tables, % already had it', n_added, n_had;
end
$fence$;

-- Storage (bucket files): same fence. Signed upload links (the staff app's right to work
-- upload) run as the storage superuser and are not affected.
do $storage$
begin
  if not exists (
    select 1 from pg_policy p
    where p.polrelid = 'storage.objects'::regclass and p.polname = 'second_step_fence'
  ) then
    execute 'create policy second_step_fence on storage.objects as restrictive for all to authenticated '
            'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))';
  end if;
exception when insufficient_privilege or undefined_table or invalid_schema_name then
  raise warning 'The storage fence was NOT added (%). Add second_step_fence on storage.objects from the dashboard (Storage, Policies).', sqlerrm;
end
$storage$;


-- ============================================================================
-- 5. Self test (aborts the WHOLE file, changing nothing, if anything is wrong)
-- ============================================================================
do $selftest$
declare
  c      record;
  v_fail text := '';
  v_anon constant text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","is_anonymous":true,"aal":"aal1"}';
  v_aal2 constant text := '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","is_anonymous":false,"aal":"aal2"}';
begin
  for c in
    select * from (values
      ('no request',                 null::jsonb,                                                                                         true,  true),
      ('service role',               '{"role":"service_role"}'::jsonb,                                                                   true,  true),
      ('public key only',            '{"role":"anon"}'::jsonb,                                                                           true,  true),
      ('anonymous till, switch on',  '{"role":"authenticated","sub":"a","is_anonymous":true,"aal":"aal1"}'::jsonb,                        true,  true),
      ('aal2 login, switch on',      '{"role":"authenticated","sub":"b","is_anonymous":false,"aal":"aal2"}'::jsonb,                       true,  true),
      ('aal1 login, switch off',     '{"role":"authenticated","sub":"c","is_anonymous":false,"aal":"aal1"}'::jsonb,                       false, true),
      ('aal1 login, switch on',      '{"role":"authenticated","sub":"c","is_anonymous":false,"aal":"aal1"}'::jsonb,                       true,  false),
      ('no aal claim, switch on',    '{"role":"authenticated","sub":"d","is_anonymous":false}'::jsonb,                                    true,  false),
      ('aal1 login, no switch row',  '{"role":"authenticated","sub":"e","is_anonymous":false,"aal":"aal1"}'::jsonb,                       null,  true)
    ) as t(label, claims, enforce, expected)
  loop
    if public.second_step_decide(c.claims, c.enforce) is distinct from c.expected then
      v_fail := v_fail || c.label || '; ';
    end if;
  end loop;
  if v_fail <> '' then
    raise exception 'Second step self test failed (%). Nothing was changed.', v_fail;
  end if;

  if not has_function_privilege('anon', 'public.second_step_check_request()', 'execute')
     or not has_function_privilege('authenticated', 'public.second_step_check_request()', 'execute')
     or not has_function_privilege('service_role', 'public.second_step_check_request()', 'execute')
     or not has_function_privilege('authenticated', 'public.second_step_ok()', 'execute')
     or has_table_privilege('authenticated', 'public.second_step_settings', 'update')
     or has_table_privilege('anon', 'public.second_step_settings', 'select') then
    raise exception 'Second step self test failed: grants are wrong. Nothing was changed.';
  end if;

  -- The real check, run as the roles PostgREST uses, for callers that must NEVER be refused.
  perform set_config('request.jwt.claims', v_anon, true);
  execute 'set local role authenticated';
  perform public.second_step_check_request();
  if not public.second_step_ok() then raise exception 'Self test: an anonymous till was refused. Nothing was changed.'; end if;
  execute 'reset role';

  perform set_config('request.jwt.claims', v_aal2, true);
  execute 'set local role authenticated';
  perform public.second_step_check_request();
  execute 'reset role';

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  perform public.second_step_check_request();
  execute 'reset role';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute 'set local role service_role';
  perform public.second_step_check_request();
  execute 'reset role';

  perform set_config('request.jwt.claims', '', true);
end
$selftest$;


-- ============================================================================
-- 6. Switch the PostgREST pre-request check on
-- ============================================================================
-- With enforce still FALSE this refuses nobody. It is what makes the switch cover the Data
-- API's SECURITY DEFINER functions, which skip row level security. If Supabase refuses the
-- role change, the file still completes (the tables and storage stay fenced) and V2 shows it
-- is missing.
do $prerequest$
begin
  execute 'alter role authenticator set pgrst.db_pre_request = ''public.second_step_check_request''';
  perform pg_notify('pgrst', 'reload config');
exception when others then
  raise warning 'The Data API check was NOT switched on (%). The tables and storage are still fenced. Tell ServOS support.', sqlerrm;
end
$prerequest$;

reset lock_timeout;


-- ============================================================================
-- 7. Verification (run these after; each one says what you should see)
-- ============================================================================
-- V1. The switch. Expect ONE row: enforce false, app_gate true.
--   select enforce, app_gate, updated_at from public.second_step_settings;
--
-- V2. The pre-request check is on. Expect a line pgrst.db_pre_request=public.second_step_check_request.
--   select unnest(rolconfig) as setting from pg_roles where rolname = 'authenticator';
--
-- V3. Every public table with row level security has the fence. Expect missing = 0.
--   select count(*) filter (where p.polname is not null) as fenced,
--          count(*) filter (where p.polname is null and c.relname not in ('second_step_settings','second_step_resets')) as missing
--   from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
--   left join pg_policy p on p.polrelid = c.oid and p.polname = 'second_step_fence'
--   where ns.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity;
--
-- V4. Storage is fenced. Expect 1.
--   select count(*) from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'second_step_fence';
--
-- V5. The rule, from the database itself. Expect every row ok = true.
--   select label, public.second_step_decide(claims::jsonb, enforce) = expected as ok from (values
--     ('anonymous till, switch on', '{"sub":"a","is_anonymous":true,"aal":"aal1"}', true, true),
--     ('aal2 login, switch on',     '{"sub":"b","is_anonymous":false,"aal":"aal2"}', true, true),
--     ('aal1 login, switch off',    '{"sub":"c","is_anonymous":false,"aal":"aal1"}', false, true),
--     ('aal1 login, switch on',     '{"sub":"c","is_anonymous":false,"aal":"aal1"}', true, false),
--     ('service role',              '{"role":"service_role"}', true, true)
--   ) as t(label, claims, enforce, expected);
--
-- V6. Who has set up (COUNTS ONLY, no names or emails). Switch enforcement on only when
--     active_without_second_step = 0 and password_only_sessions_7_days = 0.
--   select
--     count(*) filter (where not u.is_anonymous) as real_logins,
--     count(*) filter (where not u.is_anonymous and u.last_sign_in_at > now() - interval '30 days') as active_30_days,
--     count(*) filter (where not u.is_anonymous and exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')) as with_second_step,
--     count(*) filter (where not u.is_anonymous and exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp')) as with_authenticator_app,
--     count(*) filter (where not u.is_anonymous and exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'webauthn')) as with_face_id,
--     count(*) filter (where not u.is_anonymous and u.last_sign_in_at > now() - interval '30 days'
--                      and not exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')) as active_without_second_step,
--     (select count(*) from auth.sessions s join auth.users su on su.id = s.user_id
--        where not su.is_anonymous and s.aal is distinct from 'aal2'
--          and coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) > now() - interval '7 days') as password_only_sessions_7_days
--   from auth.users u;
--
-- V7. Devices running on a Back Office login instead of their own device identity (device
--     and venue names only). Each one drops its sign in when that person sets up their
--     second step (the auth server signs out their other password only sessions), so plan
--     to re-pair it. See docs/SECOND_STEP.md step 3.
--   with real_logins as (
--     select u.id, exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as has_second_step
--     from auth.users u where not u.is_anonymous)
--   select d.kind, d.device, coalesce(l.name, '(no venue)') as venue, d.seen as last_seen, r.has_second_step as login_has_second_step
--   from (
--     select 'Till or KDS'::text as kind, name as device, location_id::text as location_id, device_uid::text as uid, last_seen::timestamptz as seen from public.devices
--     union all select 'Manager app', name, location_id::text, device_uid::text, last_seen_at from public.ops_devices
--     union all select 'Host stand', name, location_id::text, device_uid::text, last_seen_at from public.waitlist_devices
--     union all select 'Menu board or order screen', name, location_id::text, device_uid::text, last_seen_at from public.menu_board_screens
--     union all select 'Card terminal', coalesce(label, serial_number), location_id::text, device_uid::text, last_seen_at from public.terminal_devices
--   ) d
--   join real_logins r on r.id::text = d.uid
--   left join public.locations l on l.id::text = d.location_id
--   order by venue, kind, device;
--
-- V8. Resets so far (ids only).
--   select created_at, actor_kind, factors_removed, factor_types, outcome, emailed from public.second_step_resets order by created_at desc limit 20;


-- ============================================================================
-- SWITCH ENFORCEMENT ON (docs/SECOND_STEP.md step 6, only when V6 says everyone is set up)
-- ============================================================================
--   update public.second_step_settings set enforce = true, updated_at = now(), note = 'switched on by Peter' where id;


-- ============================================================================
-- ROLL BACK (only if told to). TWO pastes, 10 seconds apart, in this order.
-- ============================================================================
-- PASTE 1: switch the pre-request check off first, so no request can call a missing function.
--   alter role authenticator reset pgrst.db_pre_request;
--   notify pgrst, 'reload config';
--
-- PASTE 2 (wait 10 seconds): remove the fence and the functions.
--   do $$ declare r record; begin
--     for r in select polrelid::regclass as tbl from pg_policy where polname = 'second_step_fence' loop
--       execute format('drop policy if exists second_step_fence on %s', r.tbl);
--     end loop;
--   end $$;
--   drop function if exists public.second_step_check_request();
--   drop function if exists public.second_step_status();
--   drop function if exists public.second_step_ok();
--   drop function if exists public.second_step_decide(jsonb, boolean);
--   Keep public.second_step_resets (it is the audit trail) and public.second_step_settings
--   (harmless; the edge functions read enforce = false from it, and OFF when it is missing).
