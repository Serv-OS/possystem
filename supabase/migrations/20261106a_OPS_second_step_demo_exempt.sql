-- 20261106a_OPS_second_step_demo_exempt.sql
--
-- WHY. Apple's reviewer cannot get into the ServOS Owner app. They sign in with the
-- review account we gave them, and the second step then asks for a six digit code from
-- an authenticator app that only we hold. On 29 Oct 2026 App Review wrote: either let
-- the demo account bypass code verification, give a fixed code, or ship a demo mode.
-- A TOTP code rotates every thirty seconds, so there is no fixed code to send them.
--
-- WHAT. An account that can only ever see DEMO venues is not asked for the second step.
-- Nothing is named in here: no email, no user id. The rule is a property of the account,
-- so it stops applying by itself the moment that account is linked to a real venue.
--
-- WHAT IT DOES NOT OPEN. The password still stands. Enforcement is unchanged for every
-- other login, including every owner, manager and super admin of a trading venue. An
-- account qualifies only when ALL of these hold:
--   it has at least one venue linked (a login with none is not a way in),
--   EVERY linked venue has locations.is_demo = true,
--   its own profile venue, if it has one, is a demo venue too,
--   it is not a super admin.
-- locations.is_demo is set by hand (20261013a) and is false everywhere by default.
--
-- TO REVOKE, on any of these, immediately and with no deploy:
--   update public.locations set is_demo = false where id = '<the venue>';
--   delete from public.user_locations where user_id = '<the account>';
--
-- VERIFY AFTER RUNNING (read only, paste at the bottom of this file's comments):
--   select email, public.second_step_demo_only(id) as skips_second_step
--     from auth.users where email = 'apple@serv-os.app';
--   -- must be false for a real login:
--   select email, public.second_step_demo_only(id) from auth.users where email = 'peter@posup.co.uk';

-- 1. The rule. Pure read, no side effects.
create or replace function public.second_step_demo_only(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    p_user is not null
    -- at least one venue, and not one of them is a trading venue
    and exists (
      select 1 from public.user_locations ul where ul.user_id = p_user
    )
    and not exists (
      select 1
        from public.user_locations ul
        left join public.locations l on l.id = ul.location_id
       where ul.user_id = p_user
         and coalesce(l.is_demo, false) is not true
    )
    -- a super admin reaches every venue regardless of the links above
    and not exists (
      select 1 from public.user_profiles p
       where p.id = p_user and coalesce(p.role, '') = 'super_admin'
    )
    -- the venue on the profile itself, when there is one, must be a demo venue too
    and not exists (
      select 1
        from public.user_profiles p
        left join public.locations l on l.id = p.location_id
       where p.id = p_user
         and p.location_id is not null
         and coalesce(l.is_demo, false) is not true
    )
$fn$;

comment on function public.second_step_demo_only(uuid) is
  'True when this login can only ever reach demo venues, so the second sign in step is not asked of it (App Review, 29 Oct 2026). Never name an account here: the rule is a property of the links.';

revoke all on function public.second_step_demo_only(uuid) from public;

-- 2. The fence reads the rule. Everything above this line in second_step_ok is unchanged;
--    the demo allowance is the LAST thing tried, so no normal login pays for it.
create or replace function public.second_step_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_claims   jsonb := auth.jwt();
  v_enforce  boolean;
  v_methods  text[];
  v_passkey  boolean := false;
  v_user     uuid;
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
  v_user := nullif(v_claims->>'sub', '')::uuid;
  -- A login that can only ever see demo venues (App Review, 29 Oct 2026).
  if public.second_step_demo_only(v_user) then
    return true;
  end if;
  -- The staff app is out of scope: aal1 by design, one person's own records, one function.
  return public.second_step_reach(v_user) = 'staff_app';
exception when others then
  return false;
end
$function$;

-- 3. The screens ask the same question the fence does, so they agree.
create or replace function public.second_step_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select jsonb_build_object('enforce', s.enforce, 'app_gate', s.app_gate)
       from public.second_step_settings s where s.id),
    jsonb_build_object('enforce', false, 'app_gate', true)
  ) || jsonb_build_object(
    'demo', public.second_step_demo_only(nullif(auth.jwt()->>'sub', '')::uuid)
  )
$function$;
