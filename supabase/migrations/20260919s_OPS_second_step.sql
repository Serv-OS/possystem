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
-- Fix round (20 Sep 2026, BLOCKER): a stolen password must not be enough to SET UP a second
-- step either. first_factor_needs_email = true means a login with no verified factor must
-- prove it holds the account's email address (a code we send there) before the auth server
-- accepts its FIRST factor. Adding a second factor later needs nothing new: the person is
-- already holding one.
alter table public.second_step_settings add column if not exists first_factor_needs_email boolean not null default true;
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
-- 2b. Proof of the email, before the FIRST factor (fix round, 20 Sep 2026, BLOCKER)
-- ============================================================================
-- WHY. 7 of 13 logins had not signed in for 30 days. A thief with one of those passwords
-- could sign in at aal1, enrol THEIR OWN authenticator app, reach aal2 and pass every fence:
-- the second step would be protecting the thief. The password alone must never be enough to
-- start one. So before the auth server accepts a login's FIRST factor, that login must have
-- typed a code we sent to the address on the account (or an owner or ServOS must have issued
-- one for them). A thief with the password but not the inbox cannot get past it.
--
-- TWO THINGS ENFORCE IT, so neither one alone is the whole fence:
--   * the Supabase MFA verification attempt hook below (the auth server itself calls it, so
--     it cannot be skipped by calling the API directly). Peter switches it on in the
--     dashboard: Authentication, Hooks, "MFA Verification Attempt", public.second_step_mfa_hook.
--   * the switch on step (docs/SECOND_STEP.md): every login that can reach the Back Office and
--     has no verified factor is banned until an owner or ServOS invites it, which proves the
--     same thing a second way. Even if the hook is not switched on, nothing is left open.
create table if not exists public.second_step_enrolment_proof (
  user_id     uuid primary key,
  code_hash   text not null,
  sent_to     text,
  issued_by   uuid,
  issued_kind text not null default 'self' check (issued_kind in ('self', 'owner', 'super_admin')),
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  proved_at   timestamptz,
  used_at     timestamptz
);
comment on table public.second_step_enrolment_proof is
  'Proof that whoever is setting up a FIRST second step holds the account email (second-step-invite edge function). proved_at set when the code was typed; used_at when a factor was verified with it. Service role only.';
create index if not exists second_step_enrolment_proof_expiry_idx on public.second_step_enrolment_proof (expires_at);

alter table public.second_step_enrolment_proof enable row level security;
revoke all on table public.second_step_enrolment_proof from anon, authenticated;
grant select, insert, update, delete on table public.second_step_enrolment_proof to service_role;

-- Does this login reach the Back Office? 'back_office' (must do the second step),
-- 'staff_app' (the staff app only: it reaches one person's own records through one server
-- function, and signs in at aal1 by design, so it is out of scope), or 'none'.
-- Used by the switch on count, by the lock out step and by second_step_ok below.
create or replace function public.second_step_reach(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_user is null then 'none'
    when exists (select 1 from public.user_profiles p where p.id = p_user and coalesce(p.role, '') = 'super_admin') then 'back_office'
    when exists (select 1 from public.user_locations ul where ul.user_id = p_user) then 'back_office'
    when exists (select 1 from public.user_profiles p where p.id = p_user and p.location_id is not null) then 'back_office'
    when to_regclass('public.wf_staff') is not null
         and exists (select 1 from public.wf_staff w where w.portal_user_id = p_user) then 'staff_app'
    else 'none'
  end
$$;
revoke all on function public.second_step_reach(uuid) from public;
grant execute on function public.second_step_reach(uuid) to service_role;

-- May this login have its FIRST factor accepted? The pure rule, so the hook and the tests
-- read the same thing.
--   * the setting is off                      -> yes (Peter can run without the email step)
--   * the login already holds a verified factor -> yes (adding Face ID after the app)
--   * an unused proof of the email, typed in the last hour -> yes
--   * anything else                           -> no
create or replace function public.second_step_may_enrol(p_user uuid, p_needs_email boolean, p_has_factor boolean, p_proved boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(not p_needs_email, false) or coalesce(p_has_factor, false) or coalesce(p_proved, false)
$$;
revoke all on function public.second_step_may_enrol(uuid, boolean, boolean, boolean) from public;

-- THE SUPABASE MFA VERIFICATION ATTEMPT HOOK. The auth server calls this itself on every
-- verify, so it covers the API as well as our own screens. Input:
--   { "factor_id": uuid, "factor_type": "totp"|"webauthn", "user_id": uuid, "valid": bool }
-- Output: { "decision": "continue" } or { "decision": "reject", "message": "..." }.
-- It NEVER rejects a sign in with a factor the login already holds: only the first enrolment.
create or replace function public.second_step_mfa_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user        uuid;
  v_factor      uuid;
  v_needs       boolean := true;
  v_this_is_new boolean := true;
  v_has_factor  boolean := false;
  v_proved      boolean := false;
begin
  begin
    v_user := nullif(event ->> 'user_id', '')::uuid;
    v_factor := nullif(event ->> 'factor_id', '')::uuid;
  exception when others then
    return jsonb_build_object('decision', 'continue');
  end;
  if v_user is null then
    return jsonb_build_object('decision', 'continue');
  end if;
  -- A wrong code is the auth server's own business: never turn it into our message.
  if coalesce(event ->> 'valid', 'true') = 'false' then
    return jsonb_build_object('decision', 'continue');
  end if;
  select coalesce(s.first_factor_needs_email, true) into v_needs
    from public.second_step_settings s where s.id;
  v_needs := coalesce(v_needs, true);

  -- SIGNING IN IS NEVER TOUCHED. A factor that is already verified is one this login has
  -- held all along, so this is a sign in, not an enrolment, whether it is their only factor
  -- or their third.
  if v_factor is not null then
    select coalesce(bool_or(f.status = 'verified'), false) into v_this_is_new
      from auth.mfa_factors f where f.id = v_factor;
    v_this_is_new := not coalesce(v_this_is_new, false);
    if not v_this_is_new then
      return jsonb_build_object('decision', 'continue');
    end if;
  end if;

  -- Enrolling. Already holding another verified factor (adding Face ID after the app) is
  -- proof enough: they got through the first one.
  select exists (
    select 1 from auth.mfa_factors f
     where f.user_id = v_user and f.status = 'verified'
       and (v_factor is null or f.id is distinct from v_factor)
  ) into v_has_factor;

  select exists (
    select 1 from public.second_step_enrolment_proof e
     where e.user_id = v_user and e.proved_at is not null and e.used_at is null and e.expires_at > now()
  ) into v_proved;

  if public.second_step_may_enrol(v_user, v_needs, v_has_factor, v_proved) then
    return jsonb_build_object('decision', 'continue');
  end if;
  return jsonb_build_object(
    'decision', 'reject',
    'message', 'Before you set up your second step we need to know it is really you. Open Back Office, press "Email me a code", and type the code we send to your email address.');
end
$$;
revoke all on function public.second_step_mfa_hook(jsonb) from public, anon, authenticated;
do $hook_grants$
begin
  if to_regrole('supabase_auth_admin') is not null then
    execute 'grant usage on schema public to supabase_auth_admin';
    execute 'grant execute on function public.second_step_mfa_hook(jsonb) to supabase_auth_admin';
    execute 'grant select on table public.second_step_settings to supabase_auth_admin';
    execute 'grant select on table public.second_step_enrolment_proof to supabase_auth_admin';
  end if;
end
$hook_grants$;


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
  if public.second_step_decide(v_claims, v_enforce) then
    return true;
  end if;
  -- THE STAFF APP IS OUT OF SCOPE (fix round, 20 Sep 2026). It signs in at aal1 by design and
  -- reaches one person's own records through one server function, so it can never reach zero
  -- in the switch on count and must never be refused here either. Only a login that reaches
  -- nothing but the staff app passes: the moment it has a venue link, a profile venue or the
  -- super admin role it is a Back Office login like any other.
  return public.second_step_reach(nullif(v_claims->>'sub', '')::uuid) = 'staff_app';
exception when others then
  -- A lookup that fails must not lock the Back Office out: the fence above already refused
  -- what it could prove. Being unable to prove "staff app" means "not the staff app".
  return false;
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
  c            record;
  v_fail       text := '';
  v_needs_email boolean;
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

  -- The first factor rule (fix round, 20 Sep 2026).
  if public.second_step_may_enrol(null, true,  false, false) then
    raise exception 'Second step self test failed: a first factor with no email proof was allowed. Nothing was changed.';
  end if;
  if not public.second_step_may_enrol(null, true,  true,  false)
     or not public.second_step_may_enrol(null, true,  false, true)
     or not public.second_step_may_enrol(null, false, false, false) then
    raise exception 'Second step self test failed: the first factor rule refuses someone it should allow. Nothing was changed.';
  end if;
  -- Proved with the email step ON, whatever this venue's own setting says right now (the whole
  -- file is one transaction, so the setting is put back before anything is committed).
  select coalesce(s.first_factor_needs_email, true) into v_needs_email from public.second_step_settings s where s.id;
  update public.second_step_settings set first_factor_needs_email = true where id;
  if (public.second_step_mfa_hook('{"user_id":"00000000-0000-0000-0000-0000000000ff","factor_id":"00000000-0000-0000-0000-0000000000fe","valid":true}'::jsonb) ->> 'decision') <> 'reject' then
    raise exception 'Second step self test failed: the MFA hook let a first factor through with no proof. Nothing was changed.';
  end if;
  update public.second_step_settings set first_factor_needs_email = v_needs_email where id;
  if (public.second_step_mfa_hook('{"user_id":"00000000-0000-0000-0000-0000000000ff","valid":false}'::jsonb) ->> 'decision') <> 'continue' then
    raise exception 'Second step self test failed: the MFA hook answered a wrong code instead of the auth server. Nothing was changed.';
  end if;
  if (public.second_step_mfa_hook('{"valid":true}'::jsonb) ->> 'decision') <> 'continue' then
    raise exception 'Second step self test failed: the MFA hook refused an event it could not read. Nothing was changed.';
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
--     back_office_without_second_step = 0 and back_office_password_only_sessions = 0.
--     THE STAFF APP IS NOT COUNTED (fix round, 20 Sep 2026): it signs in at aal1 by design and
--     reaches one person's own records through one server function, so it can never reach zero
--     and is out of scope here and in second_step_ok. Anything with a venue link, a profile
--     venue or the super admin role counts, used lately or not: a login nobody has touched for
--     a year is exactly the one a thief wants.
--   with people as (
--     select u.id, public.second_step_reach(u.id) as reach,
--            exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as has_step,
--            exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'totp') as has_app,
--            exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified' and f.factor_type = 'webauthn') as has_face,
--            coalesce(u.banned_until > now(), false) as banned
--       from auth.users u where not u.is_anonymous)
--   select
--     count(*) as real_logins,
--     count(*) filter (where reach = 'back_office') as back_office_logins,
--     count(*) filter (where reach = 'staff_app') as staff_app_only_logins,
--     count(*) filter (where reach = 'back_office' and has_step) as with_second_step,
--     count(*) filter (where reach = 'back_office' and has_app) as with_authenticator_app,
--     count(*) filter (where reach = 'back_office' and has_face) as with_face_id,
--     count(*) filter (where reach = 'back_office' and not has_step and not banned) as back_office_without_second_step,
--     count(*) filter (where banned) as locked_out_until_invited,
--     (select count(*) from auth.sessions s
--        join auth.users su on su.id = s.user_id
--       where not su.is_anonymous and s.aal is distinct from 'aal2'
--         and public.second_step_reach(su.id) = 'back_office'
--         and coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) > now() - interval '7 days'
--     ) as back_office_password_only_sessions
--   from people;
--
-- V6b. WHO is still to set up, by email, so you can chase them (names and emails, so keep it
--      to yourself). Run it before the lock out below.
--   select u.email, public.second_step_reach(u.id) as reach, u.last_sign_in_at,
--          coalesce(u.banned_until > now(), false) as locked_out
--     from auth.users u
--    where not u.is_anonymous
--      and public.second_step_reach(u.id) = 'back_office'
--      and not exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified')
--    order by u.last_sign_in_at nulls first;
--
-- V9. The first factor rule and its hook (fix round, 20 Sep 2026). Expect needs_email = true
--     and hook_rejects_a_first_factor = true.
--   select (select first_factor_needs_email from public.second_step_settings where id) as needs_email,
--          (public.second_step_mfa_hook('{"user_id":"00000000-0000-0000-0000-0000000000ff","valid":true}'::jsonb) ->> 'decision') = 'reject'
--            as hook_rejects_a_first_factor,
--          has_function_privilege('supabase_auth_admin', 'public.second_step_mfa_hook(jsonb)', 'execute') as auth_server_may_call_it;
--
-- V10. Proofs of email in flight (no codes, they are hashed).
--   select user_id, sent_to, issued_kind, created_at, proved_at, used_at, expires_at, attempts
--     from public.second_step_enrolment_proof order by created_at desc limit 20;
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
-- LOCK OUT THE ONES WHO NEVER SET UP (docs/SECOND_STEP.md step 6a, BEFORE switching on)
-- ============================================================================
-- Every Back Office login with no verified factor is banned until an owner or ServOS invites
-- it. That is what stops a thief claiming a dormant login's second step with its password.
-- Run V6b first so you know who they are. The staff app is not touched.
--   update auth.users u set banned_until = 'infinity'
--    where not u.is_anonymous
--      and public.second_step_reach(u.id) = 'back_office'
--      and not exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified');
--
-- To let one back in (they are with you, or they asked): clear the ban, then have them set up.
--   update auth.users set banned_until = null where email = 'them@example.com';


-- ============================================================================
-- SWITCH ENFORCEMENT ON (docs/SECOND_STEP.md step 7, only when V6 says everyone is set up)
-- ============================================================================
--   update public.second_step_settings set enforce = true, updated_at = now(), note = 'switched on by Peter' where id;


-- ============================================================================
-- BREAK GLASS FOR PETER HIMSELF (the only super admin)
-- ============================================================================
-- 1. The SWITCH is the first answer, and it needs no phone: one line, takes effect in 30
--    seconds, no deploy. It is at the top of this file.
--      update public.second_step_settings set enforce = false, app_gate = false, updated_at = now() where id;
--
-- 2. LOST PHONE, keep the account. Clear his own factors from the SQL editor (the product
--    refuses a self reset on purpose), then sign in and set up again.
--      delete from auth.mfa_factors
--       where user_id = (select id from auth.users where email = 'peter@posup.co.uk');
--    The same thing lives in the dashboard: Authentication, Users, the user, Delete MFA factor.
--
-- 3. A SECOND SUPER ADMIN, so one lost phone is never the end of it. Make the second account
--    in the admin portal (or let them sign up), then:
--      update public.user_profiles set role = 'super_admin'
--       where id = (select id from auth.users where email = 'the.second@example.com');
--    Have them set up their own second step the same day, on their own phone, and check
--    V6 shows two super admins with a second step before you switch enforcement on.
--
-- 4. IF THE DATABASE ITSELF IS REFUSING EVERYONE (the check went on but something is wrong),
--    take the Data API check off first, then decide at leisure:
--      alter role authenticator reset pgrst.db_pre_request;
--      notify pgrst, 'reload config';


-- -- ============================================================================
-- -- ROLL BACK (only if told to). TWO pastes, 10 seconds apart, in this order.
-- -- ============================================================================
-- -- HOW: each PASTE below is copied on its own, pasted into the Ops SQL editor, selected
-- -- all (Cmd+A) and uncommented with Cmd+/ once: every line loses its first "-- ", and the
-- -- notes (lines that still start with "-- ") stay notes. Then press Run.
-- -- NOTHING IS DROPPED (fix round, 20 Sep 2026):
-- --   * second_step_check_request keeps its name and gets an EMPTY body. If PostgREST missed
-- --     the reload in paste 1, every till would have failed with "function does not exist";
-- --     an empty function can never do that.
-- --   * second_step_status and second_step_settings STAY, so app_gate = false still works.
-- --     That is the app's own break glass: without it the sign in screens would keep asking
-- --     for a second step the database no longer knows about, and only a redeploy could stop
-- --     them. This block turns it off for you.
-- --   * second_step_resets and second_step_enrolment_proof stay: they are the audit trails.
-- -- ALSO: switch the MFA hook off in the dashboard (Authentication, Hooks, MFA Verification
-- -- Attempt, disable) if you rolled back because setting a second step up was the problem.
-- -- The line below does the same thing without the dashboard.
--
-- -- PASTE 1: take the Data API check off first, so no request can call a changing function.
-- alter role authenticator reset pgrst.db_pre_request;
-- notify pgrst, 'reload config';
--
-- -- PASTE 2 (wait 10 seconds): switch it all off and take the fence off the tables.
-- update public.second_step_settings
--    set enforce = false, app_gate = false, first_factor_needs_email = false,
--        updated_at = now(), note = 'rolled back'
--  where id;
-- create or replace function public.second_step_check_request() returns void
--   language plpgsql stable security definer set search_path = '' as $rb$ begin return; end $rb$;
-- do $rb_fence$ declare r record; begin
--   for r in select polrelid::regclass as tbl from pg_policy where polname = 'second_step_fence' loop
--     execute format('drop policy if exists second_step_fence on %s', r.tbl);
--   end loop;
-- end $rb_fence$;
