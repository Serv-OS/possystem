-- 20260920p_OPS_passkey_second_step.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  PASSKEYS ARE THE SECOND STEP (Face ID, Touch ID, Windows Hello).         #
-- #  RUN 20260919s_OPS_second_step.sql FIRST (it is already in, 19 Sep).      #
-- #  Safe to paste while the venue is trading: it only replaces functions and #
-- #  adds two small tables. It never touches the fence policies, the Data API #
-- #  check or the switch, and enforcement stays exactly as you left it (off). #
-- #  Peter pastes it into the Ops SQL editor. Claude never runs it.           #
-- #  The runbook is docs/SECOND_STEP.md.                                      #
-- ############################################################################
--
-- WHY (Peter, 20 Sep 2026): "I just want it more secure I hate multi factor auth apps, this is
-- what toast does I want this", with a screenshot of Toast's passkey sign in. A passkey is the
-- fingerprint on his laptop, the face on his phone, Windows Hello on Windows. Nobody types a
-- code from an app ever again.
--
-- THE THING THIS FILE EXISTS TO FIX. Supabase REFUSED to switch WebAuthn on as an MFA factor on
-- this project ("Enabling of MFA with WebAuthn not currently supported"), so a passkey here is
-- Supabase's PASSKEY SIGN IN, which is a FIRST factor: it replaces the password. GoTrue gives a
-- first factor sign in "aal1". Our whole fence, as it went live on 19 September, passes a real
-- login only at "aal2". So a passkey sign in would have been refused by the database the moment
-- enforcement went on: everybody locked out, exactly the wrong way round.
--
-- WHAT COUNTS AS DONE, FROM NOW ON. A real login passes when:
--   * its session is aal2 (an MFA factor was verified: unchanged, and still true for anyone who
--     set up an authenticator app before this file), OR
--   * IT SIGNED IN WITH A PASSKEY. That is proved on the server, not by the app: GoTrue records
--     what a session was authenticated with in auth.mfa_amr_claims, one row per method per
--     session. The claim 'amr' in the token says the same thing when it carries it. Both are
--     read here, so it works whichever way this project's GoTrue is built.
-- Everything else is exactly as it was: anonymous tills, kiosks, KDS, TVs, customer pages, the
-- service role, the bare key, the staff app and direct SQL are never refused.
--
-- WHAT THIS FILE CHANGES
--   1. second_step_settings gains passkey_methods: the method names that count as a passkey
--      (GoTrue has used 'webauthn' and 'passkey'; both are in the default, and Peter can add
--      one in a single line if a new name turns up, with no deploy).
--   2. second_step_passkeys: OUR record of which login holds which passkey, so the switch on
--      count and the Back Office list have something to read that is not the auth schema.
--      Written by the app through second_step_passkey_record (below); never trusted for
--      letting anybody IN.
--   3. second_step_session_passkey(claims): did THIS session sign in with a passkey?
--   4. second_step_decide / second_step_ok: the rule above.
--   5. second_step_has_second_step(user): a verified MFA factor OR a passkey. The switch on
--      count and the lock out use it.
--   6. second_step_passkey_record / second_step_passkey_forget: the app tells us it registered
--      or removed one (for its own login only).
--
-- RULES OF THE FILE: no begin or commit (the editor runs the paste as one transaction, so any
-- error means NOTHING changed and you can run it again); every statement can run twice; a self
-- test at the end aborts the whole file if any rule is wrong; roll back at the very end.


-- ============================================================================
-- 0. Guards
-- ============================================================================
set lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regclass('public.second_step_settings') is null
     or to_regprocedure('public.second_step_decide(jsonb, boolean)') is null
     or to_regprocedure('public.second_step_ok()') is null then
    raise exception 'Run 20260919s_OPS_second_step.sql first. Nothing was changed.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. Which method names count as a passkey
-- ============================================================================
alter table public.second_step_settings
  add column if not exists passkey_methods text[] not null default array['webauthn', 'passkey', 'webauthn_credential'];
comment on column public.second_step_settings.passkey_methods is
  'The authentication method names that count as a passkey sign in (auth.mfa_amr_claims.authentication_method, and the token amr claim). Add one here if GoTrue starts using a new name: no deploy needed.';


-- ============================================================================
-- 2. Our own record of who holds a passkey
-- ============================================================================
-- Supabase keeps the passkeys themselves (the public keys) in its own auth schema, and the app
-- lists them straight from GoTrue. This table is only so the SERVER can count who has set one
-- up, for the switch on gate and the lock out, without reaching into the auth schema's shape,
-- which is Supabase's to change. It never lets anybody in: signing in with a passkey is proved
-- by the session itself (section 3).
create table if not exists public.second_step_passkeys (
  user_id        uuid not null,
  credential_id  text not null,
  friendly_name  text,
  device_hint    text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  removed_at     timestamptz,
  primary key (user_id, credential_id)
);
comment on table public.second_step_passkeys is
  'Which login holds which passkey (docs/SECOND_STEP.md). Written by second_step_passkey_record from the app, for its own login only. Used for counting and for the Back Office list, never for access.';
create index if not exists second_step_passkeys_user_idx on public.second_step_passkeys (user_id) where removed_at is null;

alter table public.second_step_passkeys enable row level security;
revoke all on table public.second_step_passkeys from anon, authenticated;
grant select, insert, update, delete on table public.second_step_passkeys to service_role;


-- ============================================================================
-- 3. Did THIS session sign in with a passkey?
-- ============================================================================
-- Two ways, because GoTrue does not promise either one on this project:
--   * the token's own 'amr' claim, which is an array of { method, timestamp };
--   * auth.mfa_amr_claims, the table GoTrue fills in per session (read with the definer's
--     rights, so a login cannot see anyone else's).
-- A missing table or claim simply means "no", never an error.
create or replace function public.second_step_amr_has_passkey(p_claims jsonb, p_methods text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(p_claims -> 'amr') = 'array' then p_claims -> 'amr' else '[]'::jsonb end) e
     where lower(coalesce(e ->> 'method', e #>> '{}')) = any (
             select lower(m) from unnest(coalesce(p_methods, '{}'::text[])) m)
  )
$$;
revoke all on function public.second_step_amr_has_passkey(jsonb, text[]) from public;

create or replace function public.second_step_session_passkey(p_claims jsonb, p_methods text[])
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_found   boolean := false;
begin
  if public.second_step_amr_has_passkey(p_claims, p_methods) then
    return true;
  end if;
  begin
    v_session := nullif(p_claims ->> 'session_id', '')::uuid;
  exception when others then
    return false;
  end;
  if v_session is null or to_regclass('auth.mfa_amr_claims') is null then
    return false;
  end if;
  execute 'select exists (select 1 from auth.mfa_amr_claims c where c.session_id = $1'
       || ' and lower(c.authentication_method) = any (select lower(m) from unnest($2::text[]) m))'
    into v_found using v_session, coalesce(p_methods, '{}'::text[]);
  return coalesce(v_found, false);
exception when others then
  return false;
end
$$;
revoke all on function public.second_step_session_passkey(jsonb, text[]) from public;


-- ============================================================================
-- 4. The rule
-- ============================================================================
-- p_passkey is "this session signed in with a passkey", worked out by the caller (so the pure
-- rule stays pure and the self test can drive every branch). Mirrors classifyCaller and
-- mustRefuse in supabase/functions/_shared/second-step.ts: change both together.
-- No DEFAULT on p_passkey: with one, a two argument call could mean either function and
-- Postgres refuses it ("could not choose a best candidate function").
create or replace function public.second_step_decide(p_claims jsonb, p_enforce boolean, p_passkey boolean)
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
    when p_claims->>'aal' = 'aal2'                 then true   -- an MFA factor was verified
    when coalesce(p_passkey, false)                then true   -- signed in with a passkey (aal1 by design)
    else not coalesce(p_enforce, false)                        -- password only: allowed only while OFF
  end
$$;
revoke all on function public.second_step_decide(jsonb, boolean, boolean) from public;

-- The two argument shape stays, so anything that already calls it keeps working.
create or replace function public.second_step_decide(p_claims jsonb, p_enforce boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.second_step_decide(p_claims, p_enforce, false)
$$;
revoke all on function public.second_step_decide(jsonb, boolean) from public;

create or replace function public.second_step_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims   jsonb := auth.jwt();
  v_enforce  boolean;
  v_methods  text[];
  v_passkey  boolean := false;
begin
  -- Everyone who is never refused, without touching a table.
  if public.second_step_decide(v_claims, true, false) then
    return true;
  end if;
  select s.enforce, s.passkey_methods into v_enforce, v_methods
    from public.second_step_settings s where s.id;
  -- A PASSKEY SIGN IN IS DONE (20 Sep 2026): it is a first factor, so the session is aal1, and
  -- it is stronger than the password it replaced. Checked before the switch is applied, so it
  -- is true whether enforcement is on or off.
  v_passkey := public.second_step_session_passkey(v_claims, coalesce(v_methods, array['webauthn', 'passkey']));
  if public.second_step_decide(v_claims, v_enforce, v_passkey) then
    return true;
  end if;
  -- The staff app is out of scope: aal1 by design, one person's own records, one function.
  return public.second_step_reach(nullif(v_claims->>'sub', '')::uuid) = 'staff_app';
exception when others then
  return false;
end
$$;
revoke all on function public.second_step_ok() from public;
grant execute on function public.second_step_ok() to anon, authenticated, service_role;


-- ============================================================================
-- 5. Who has finished their second step
-- ============================================================================
-- A verified MFA factor (an authenticator app set up before this file) OR a passkey. The switch
-- on count (V6) and the lock out both read this, so nobody who has done the work is locked out.
create or replace function public.second_step_has_second_step(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has boolean := false;
begin
  if p_user is null then return false; end if;
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
    into v_has;
  if v_has then return true; end if;
  select exists (select 1 from public.second_step_passkeys k where k.user_id = p_user and k.removed_at is null)
    into v_has;
  return coalesce(v_has, false);
exception when others then
  return false;
end
$$;
revoke all on function public.second_step_has_second_step(uuid) from public;
grant execute on function public.second_step_has_second_step(uuid) to service_role;


-- ============================================================================
-- 6. The app tells us about its own passkeys
-- ============================================================================
-- Called by the signed in person for THEIR OWN login, straight after GoTrue accepted the
-- registration (or after they removed one). It can never write another login's row, and what it
-- writes is only used for counting and for the Back Office list.
create or replace function public.second_step_passkey_record(p_credential_id text, p_friendly_name text default null, p_device_hint text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if v_user is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    raise exception 'not allowed';
  end if;
  if coalesce(btrim(p_credential_id), '') = '' then
    raise exception 'credential id required';
  end if;
  insert into public.second_step_passkeys (user_id, credential_id, friendly_name, device_hint, last_used_at)
  values (v_user, left(btrim(p_credential_id), 400), left(nullif(btrim(coalesce(p_friendly_name, '')), ''), 120),
          left(nullif(btrim(coalesce(p_device_hint, '')), ''), 80), now())
  on conflict (user_id, credential_id) do update
    set friendly_name = coalesce(excluded.friendly_name, public.second_step_passkeys.friendly_name),
        device_hint   = coalesce(excluded.device_hint, public.second_step_passkeys.device_hint),
        last_used_at  = now(),
        removed_at    = null;
end
$$;
revoke all on function public.second_step_passkey_record(text, text, text) from public;
grant execute on function public.second_step_passkey_record(text, text, text) to authenticated;

create or replace function public.second_step_passkey_forget(p_credential_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := nullif(auth.jwt() ->> 'sub', '')::uuid;
begin
  if v_user is null then raise exception 'not allowed'; end if;
  update public.second_step_passkeys
     set removed_at = now()
   where user_id = v_user and credential_id = left(btrim(coalesce(p_credential_id, '')), 400);
end
$$;
revoke all on function public.second_step_passkey_forget(text) from public;
grant execute on function public.second_step_passkey_forget(text) to authenticated;


-- ============================================================================
-- 7. Self test (aborts the WHOLE file, changing nothing, if anything is wrong)
-- ============================================================================
do $selftest$
declare
  m constant text[] := array['webauthn', 'passkey'];
begin
  -- the pure rule
  if not public.second_step_decide('{"role":"authenticated","sub":"a","is_anonymous":false,"aal":"aal1"}'::jsonb, true, true) then
    raise exception 'Self test: a passkey sign in was refused. Nothing was changed.';
  end if;
  if public.second_step_decide('{"role":"authenticated","sub":"a","is_anonymous":false,"aal":"aal1"}'::jsonb, true, false) then
    raise exception 'Self test: a password only login was allowed. Nothing was changed.';
  end if;
  if not public.second_step_decide('{"role":"authenticated","sub":"a","is_anonymous":false,"aal":"aal2"}'::jsonb, true, false)
     or not public.second_step_decide('{"role":"authenticated","sub":"t","is_anonymous":true,"aal":"aal1"}'::jsonb, true, false)
     or not public.second_step_decide('{"role":"service_role"}'::jsonb, true, false)
     or not public.second_step_decide(null, true, false) then
    raise exception 'Self test: somebody who must never be refused was refused. Nothing was changed.';
  end if;
  -- the amr claim, in both shapes GoTrue writes
  if not public.second_step_amr_has_passkey('{"amr":[{"method":"webauthn","timestamp":1}]}'::jsonb, m)
     or not public.second_step_amr_has_passkey('{"amr":[{"method":"password"},{"method":"passkey"}]}'::jsonb, m)
     or not public.second_step_amr_has_passkey('{"amr":["webauthn"]}'::jsonb, m) then
    raise exception 'Self test: a passkey in the token was not seen. Nothing was changed.';
  end if;
  if public.second_step_amr_has_passkey('{"amr":[{"method":"password"}]}'::jsonb, m)
     or public.second_step_amr_has_passkey('{}'::jsonb, m)
     or public.second_step_amr_has_passkey(null, m) then
    raise exception 'Self test: a password sign in was read as a passkey. Nothing was changed.';
  end if;
  -- the two argument shape still answers
  if public.second_step_decide('{"role":"authenticated","sub":"a","is_anonymous":false,"aal":"aal1"}'::jsonb, true) then
    raise exception 'Self test: the old two argument rule changed its answer. Nothing was changed.';
  end if;
  -- grants
  if has_function_privilege('anon', 'public.second_step_passkey_record(text, text, text)', 'execute')
     or has_table_privilege('authenticated', 'public.second_step_passkeys', 'select') then
    raise exception 'Self test: the passkey record is not private. Nothing was changed.';
  end if;
end
$selftest$;

reset lock_timeout;


-- ============================================================================
-- 8. Verification (run these after; each one says what you should see)
-- ============================================================================
-- P1. The rule, from the database itself. Expect every row ok = true.
--   select label, public.second_step_decide(claims::jsonb, enforce, passkey) = expected as ok from (values
--     ('passkey sign in, switch on', '{"sub":"a","is_anonymous":false,"aal":"aal1"}', true,  true,  true),
--     ('password only, switch on',   '{"sub":"a","is_anonymous":false,"aal":"aal1"}', true,  false, false),
--     ('password only, switch off',  '{"sub":"a","is_anonymous":false,"aal":"aal1"}', false, false, true),
--     ('authenticator app (aal2)',   '{"sub":"b","is_anonymous":false,"aal":"aal2"}', true,  false, true),
--     ('anonymous till',             '{"sub":"t","is_anonymous":true,"aal":"aal1"}',  true,  false, true)
--   ) as t(label, claims, enforce, passkey, expected);
--
-- P2. What GoTrue calls a passkey sign in ON THIS PROJECT. Sign in with a passkey yourself,
--     then run this. Expect your session to be listed with its method name. If the name is not
--     in passkey_methods, add it (P3) BEFORE you switch enforcement on.
--   select c.session_id, c.authentication_method, c.created_at
--     from auth.mfa_amr_claims c
--     join auth.sessions s on s.id = c.session_id
--    where s.user_id = (select id from auth.users where email = 'peter@posup.co.uk')
--    order by c.created_at desc limit 10;
--
-- P3. Add a method name (no deploy):
--   update public.second_step_settings
--      set passkey_methods = passkey_methods || 'the_new_name', updated_at = now() where id;
--
-- P4. Who has finished their second step now (passkeys included). Expect
--     back_office_without_second_step = 0 before you switch on.
--   with people as (
--     select u.id, public.second_step_reach(u.id) as reach,
--            public.second_step_has_second_step(u.id) as has_step,
--            coalesce(u.banned_until > now(), false) as banned
--       from auth.users u where not u.is_anonymous)
--   select count(*) filter (where reach = 'back_office') as back_office_logins,
--          count(*) filter (where reach = 'staff_app') as staff_app_only_logins,
--          count(*) filter (where reach = 'back_office' and has_step) as with_second_step,
--          count(*) filter (where reach = 'back_office' and not has_step and not banned) as back_office_without_second_step
--     from people;
--
-- P5. The passkeys we know about (no keys, no secrets).
--   select user_id, friendly_name, device_hint, created_at, last_used_at, removed_at
--     from public.second_step_passkeys order by created_at desc limit 50;


-- -- ============================================================================
-- -- ROLL BACK (only if told to; paste it, select all, Cmd+/ once, Run)
-- -- ============================================================================
-- -- It puts the rule back to "aal2 only", which is what was live on 19 September. DO NOT run
-- -- it while anybody is signing in with a passkey and enforcement is ON: they would be refused.
-- -- Switch enforcement off first (one line, the top of 20260919s), or leave it off.
-- -- Nothing is dropped: the tables and the new functions stay, unused.
-- update public.second_step_settings set enforce = false, updated_at = now(), note = 'passkey rule rolled back' where id;
-- create or replace function public.second_step_ok() returns boolean
--   language plpgsql stable security definer set search_path = '' as $rb$
-- declare
--   v_claims  jsonb := auth.jwt();
--   v_enforce boolean;
-- begin
--   if public.second_step_decide(v_claims, true) then return true; end if;
--   select s.enforce into v_enforce from public.second_step_settings s where s.id;
--   if public.second_step_decide(v_claims, v_enforce) then return true; end if;
--   return public.second_step_reach(nullif(v_claims->>'sub', '')::uuid) = 'staff_app';
-- exception when others then
--   return false;
-- end $rb$;
