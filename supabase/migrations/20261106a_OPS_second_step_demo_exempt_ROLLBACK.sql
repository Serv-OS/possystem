-- 20261106a_OPS_second_step_demo_exempt_ROLLBACK.sql
--
-- Puts second_step_ok() and second_step_status() back exactly as they were before
-- 20261106a, then drops the rule. After this every password only login is asked for
-- the second step again, demo venues included.
--
-- NOTE. You rarely need this file. To stop ONE account skipping the step, take its demo
-- venue away instead, which works immediately and changes no code:
--   update public.locations set is_demo = false where id = '<the venue>';

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
begin
  if public.second_step_decide(v_claims, true, false) then
    return true;
  end if;
  select s.enforce, s.passkey_methods into v_enforce, v_methods
    from public.second_step_settings s where s.id;
  v_passkey := public.second_step_session_passkey(v_claims, coalesce(v_methods, array['webauthn', 'passkey']));
  if public.second_step_decide(v_claims, v_enforce, v_passkey) then
    return true;
  end if;
  return public.second_step_reach(nullif(v_claims->>'sub', '')::uuid) = 'staff_app';
exception when others then
  return false;
end
$function$;

create or replace function public.second_step_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select jsonb_build_object('enforce', s.enforce, 'app_gate', s.app_gate) from public.second_step_settings s where s.id),
    jsonb_build_object('enforce', false, 'app_gate', true)
  )
$function$;

drop function if exists public.second_step_demo_only(uuid);
