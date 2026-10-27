-- 20261104a_OPS_wf_staff_identity_fence_ROLLBACK.sql
-- Undoes 20261104a (the wf_staff identity fence). Ops DB only (tbetcegmszzotrwdtqhi).
-- One transaction: any error and nothing changes. Run after UK close, never on 1 Nov 2026.
--
-- WHAT IT PUTS BACK
--   1. authenticated gets INSERT and UPDATE on the whole wf_staff table again (every column, as
--      before 20261104a). The column by column grants go with the table level revoke.
--   2. The two new triggers, the door (wf_staff_set_pos_user) and the regrant helper are dropped.
--   3. The 20260806j trigger (wf_staff_block_portal_cols_trg) comes back as it was: the service
--      role may change portal_user_id and the invite columns, nobody else; pos_user_id is open
--      to every Back Office login of the company again (the gap this release closed).
--
-- WHAT IT KEEPS
--   Every wf_audit row written by the fence (the log is append only). Every staff row as it is.
--
-- AFTER IT
--   The 5.11.104 web app's Set up on the POS calls the door first and, told it does not exist,
--   writes pos_user_id directly as 5.11.103 did. Nothing else in the app needs the fence.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.wf_staff') is null then
    raise exception 'wf_staff is missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_set_pos_user(uuid,uuid,text)') is null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.wf_staff'::regclass and tgname = 'wf_staff_identity_guard_trg') then
    raise exception 'The staff identity fence (20261104a) is not in. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- 1. Triggers and functions go.
drop trigger if exists wf_staff_identity_guard_trg on public.wf_staff;
drop trigger if exists wf_staff_identity_audit_trg on public.wf_staff;
drop function if exists public.wf_staff_identity_guard();
drop function if exists public.wf_staff_identity_audit();
drop function if exists public.wf_staff_set_pos_user(uuid, uuid, text);
drop function if exists public.wf_staff_regrant_api();

-- 2. The 20260806j trigger, as it was.
create or replace function public.wf_staff_block_portal_cols()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- service_role (the staff-portal edge fn) is the only legitimate writer.
  if coalesce(current_setting('request.jwt.claims', true)::json->>'role', '') = 'service_role' then
    return new;
  end if;
  if new.portal_user_id is distinct from old.portal_user_id
     or new.portal_invite_hash is distinct from old.portal_invite_hash
     or new.portal_invite_expires is distinct from old.portal_invite_expires then
    raise exception 'portal_user_id / portal_invite_* are managed by the staff-portal service and cannot be set directly';
  end if;
  return new;
end $$;

drop trigger if exists wf_staff_block_portal_cols_trg on public.wf_staff;
create trigger wf_staff_block_portal_cols_trg
  before update on public.wf_staff
  for each row execute function public.wf_staff_block_portal_cols();

-- 3. The whole table back for the API login. Revoking at table level also drops the column grants.
revoke insert, update on table public.wf_staff from authenticated;
grant insert, update on table public.wf_staff to authenticated;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: api_updates_pos_user true, api_updates_portal_user true,
-- api_inserts_identity true, column_grants_left 0, fence_triggers_left 0, door_left false,
-- helpers_left 0, old_guard_back true.
select
  has_column_privilege('authenticated', 'public.wf_staff', 'pos_user_id', 'update') as api_updates_pos_user,
  has_column_privilege('authenticated', 'public.wf_staff', 'portal_user_id', 'update') as api_updates_portal_user,
  has_column_privilege('authenticated', 'public.wf_staff', 'portal_user_id', 'insert') as api_inserts_identity,
  (select count(*)::int from pg_attribute a
    where a.attrelid = 'public.wf_staff'::regclass and a.attnum > 0 and not a.attisdropped and a.attacl is not null) as column_grants_left,
  (select count(*)::int from pg_trigger where tgrelid = 'public.wf_staff'::regclass
    and tgname in ('wf_staff_identity_guard_trg', 'wf_staff_identity_audit_trg')) as fence_triggers_left,
  to_regprocedure('public.wf_staff_set_pos_user(uuid,uuid,text)') is not null as door_left,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('wf_staff_identity_guard', 'wf_staff_identity_audit', 'wf_staff_regrant_api')) as helpers_left,
  exists (select 1 from pg_trigger where tgrelid = 'public.wf_staff'::regclass and tgname = 'wf_staff_block_portal_cols_trg') as old_guard_back;
