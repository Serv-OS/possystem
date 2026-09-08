-- 20260806j_portal_columns_locked.sql — SECURITY. Lock the portal identity
-- columns to service_role.
--
-- Found by adversarial review, 7 Aug. wf_staff UPDATE RLS is org-wide with NO
-- column fence, so ANY Back Office user with a user_locations row could PATCH
-- another person's wf_staff row over PostgREST — changing `email` and/or
-- `portal_user_id` — then use the staff-app invite flow to set a password on
-- an auth account they do not own. Chained with an owner's uid that is an
-- account takeover of the Back Office.
--
-- Same shape as the existing ul_block_role_self_change_trg guard on
-- user_locations.role: privilege-bearing columns are never client-writable.

begin;

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

commit;
