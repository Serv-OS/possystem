-- 20260921s_OPS_second_step_passkey_list.sql
--
-- ASK SUPABASE WHICH PASSKEYS A LOGIN HAS, INSTEAD OF TRUSTING OUR OWN LIST.
--
-- WHY (21 Sep 2026, live). Three logins on this project hold a passkey. Our own
-- record, public.second_step_passkeys, has a row for two of them:
--
--   peter+coffeeboy@serv-os.app   passkey in Supabase: 1   our record: 1
--   pwar2804@gmail.com            passkey in Supabase: 1   our record: 1
--   peter@posup.co.uk             passkey in Supabase: 1   our record: 0   <--
--
-- The row is written by the browser after the passkey is made
-- (second_step_passkey_record), so anything that interrupts that one call
-- leaves a passkey Supabase knows about and we do not.
--
-- THAT IS A HOLE IN THE RESET. second-step-reset removes the passkeys it finds
-- in OUR table, so for that third login a reset would report a clean sweep
-- while the passkey stayed alive on the device: a passkey signs in on its own,
-- with no password, which is exactly what a reset is supposed to end.
--
-- The truth lives in auth.webauthn_credentials, which no API key can read (the
-- auth schema is not exposed) and no client should. So: two SECURITY DEFINER
-- functions, service_role only, that answer the two questions the reset and
-- the team list ask.
--
-- WHAT THE ADMIN ROUTE WANTS. DELETE /auth/v1/admin/users/{user}/passkeys/{id}
-- takes the CREDENTIAL ROW's id, the uuid, not the WebAuthn credential id
-- bytes. Verified against the two rows we recorded correctly: both match
-- auth.webauthn_credentials.id exactly. So this returns that uuid as text and
-- the reset needs no translation.
--
-- SAFE DURING SERVICE. Two new read only functions. Nothing is altered, nothing
-- is dropped, no policy is touched, no till is affected.

set local lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.second_step_passkeys') is null then
    raise exception 'The passkey step (20260920p) has not run on this database. Nothing was changed.';
  end if;
end
$guard$;


-- ── Which passkeys does this login have, according to Supabase itself ────────
create or replace function public.second_step_user_passkeys(p_user uuid)
returns table (credential_id text, friendly_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id::text, w.friendly_name, w.created_at
  from auth.webauthn_credentials w
  where w.user_id = p_user
  order by w.created_at
$$;
comment on function public.second_step_user_passkeys(uuid) is
  'The passkeys Supabase holds for one login, as the ids the admin passkey route deletes by. For second-step-reset, so a reset can never leave behind a passkey our own table never recorded. Service role only.';

-- ── How many does each of these logins have (the team list) ──────────────────
create or replace function public.second_step_passkey_counts(p_users uuid[])
returns table (user_id uuid, passkeys integer)
language sql
stable
security definer
set search_path = ''
as $$
  select u, (select count(*)::integer from auth.webauthn_credentials w where w.user_id = u)
  from unnest(coalesce(p_users, '{}'::uuid[])) as u
$$;
comment on function public.second_step_passkey_counts(uuid[]) is
  'Passkeys per login from Supabase, for the Sign in security team list. Service role only.';

-- Schema public grants EXECUTE on every NEW function to anon and authenticated
-- by default, and `revoke ... from public` does NOT take that away. Revoke by
-- name, or a browser holding the public key could list who has a passkey
-- (v5.9.15 learned this the hard way).
revoke all on function public.second_step_user_passkeys(uuid) from public, anon, authenticated;
revoke all on function public.second_step_passkey_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.second_step_user_passkeys(uuid) to service_role;
grant execute on function public.second_step_passkey_counts(uuid[]) to service_role;


-- ── Self test: it must be right, and it must be private ─────────────────────
do $check$
declare
  v_user uuid;
  v_n integer;
begin
  if to_regprocedure('public.second_step_user_passkeys(uuid)') is null
     or to_regprocedure('public.second_step_passkey_counts(uuid[])') is null then
    raise exception 'Self test: a function is missing. Nothing was changed.';
  end if;

  if has_function_privilege('anon', 'public.second_step_user_passkeys(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.second_step_user_passkeys(uuid)', 'execute')
     or has_function_privilege('anon', 'public.second_step_passkey_counts(uuid[])', 'execute')
     or has_function_privilege('authenticated', 'public.second_step_passkey_counts(uuid[])', 'execute') then
    raise exception 'Self test: the passkey list is not private. Nothing was changed.';
  end if;

  -- It must find the passkeys that are really there. Take a login that has one.
  select w.user_id into v_user from auth.webauthn_credentials w limit 1;
  if v_user is not null then
    select count(*) into v_n from public.second_step_user_passkeys(v_user);
    if v_n < 1 then
      raise exception 'Self test: a login with a passkey came back with none. Nothing was changed.';
    end if;
    select passkeys into v_n from public.second_step_passkey_counts(array[v_user]);
    if coalesce(v_n, 0) < 1 then
      raise exception 'Self test: the count says none for a login that has one. Nothing was changed.';
    end if;
  end if;
end
$check$;


-- ── Check it worked ─────────────────────────────────────────────────────────
-- Expect: one row per login that holds a passkey, and ours_missing = 0 once
-- the reset has been redeployed and the next reset reconciles. Today the third
-- login shows ours_missing = 1, which is the hole this closes.
select u.email,
       (select count(*) from public.second_step_user_passkeys(u.id))        as in_supabase,
       (select count(*) from public.second_step_passkeys p
          where p.user_id = u.id and p.removed_at is null)                  as in_our_record
from auth.users u
where exists (select 1 from auth.webauthn_credentials w where w.user_id = u.id)
order by u.email;


-- ============================================================================
-- ROLL BACK (nothing else needs undoing: these two functions are all this file
-- adds, and the reset falls back to our own table when they are not there)
-- ============================================================================
--   drop function if exists public.second_step_user_passkeys(uuid);
--   drop function if exists public.second_step_passkey_counts(uuid[]);
