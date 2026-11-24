-- 20261206a_OPS_wf_pos_user_managers_ROLLBACK.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Undoes 20261206a: puts wf_staff_set_pos_user back exactly as 20261104a made it (owners only).
-- Links managers made while 20261206a was in place stay as they are; they are ordinary links.
-- After this, a manager who presses "Set as POS user" is refused again.

set client_min_messages = warning;

create or replace function public.wf_staff_set_pos_user(p_staff_id uuid, p_pos_user_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_uid uuid := auth.uid();
  v_trusted boolean := false;
  st public.wf_staff;
  sm public.staff_members;
  v_other uuid;
  v_prev uuid;
begin
  if p_staff_id is null then
    raise exception 'No staff record given' using errcode = '22023';
  end if;
  -- Who is asking. The service role and the database itself are trusted; a login must be an owner.
  if v_role = 'service_role' then
    v_trusted := true;
  elsif v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    v_trusted := true;
  else
    if v_uid is null or public.is_anon_session() then
      raise exception 'Sign in to Back Office first' using errcode = '42501';
    end if;
    if not public.second_step_ok() then
      raise exception 'Finish your second sign in step first' using errcode = '42501';
    end if;
  end if;

  select * into st from public.wf_staff where id = p_staff_id for update;
  if not found then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;

  if not v_trusted then
    v_trusted := public.is_super_admin()
      or exists (select 1 from public.user_profiles p
                  where p.id = v_uid and p.role = 'owner' and p.org_id is not null and p.org_id = st.org_id)
      or exists (select 1 from public.user_locations ul
                   join public.locations l on l.id = ul.location_id
                  where ul.user_id = v_uid and lower(coalesce(ul.role, '')) in ('owner', 'admin') and l.org_id = st.org_id);
    if not v_trusted then
      raise exception 'Only an owner of this company can link a till user to a staff record' using errcode = '42501';
    end if;
  end if;

  if st.status = 'leaver' then
    raise exception 'This person is a leaver. Reinstate them before linking a till user' using errcode = '22023';
  end if;

  if p_pos_user_id is not null then
    select * into sm from public.staff_members where id = p_pos_user_id;
    if not found then
      raise exception 'No till user with that id' using errcode = '22023';
    end if;
    if not (sm.org_id is not null and sm.org_id = st.org_id)
       and not exists (select 1 from public.locations l where l.id = sm.location_id and l.org_id = st.org_id) then
      raise exception 'That till user belongs to another company' using errcode = '22023';
    end if;
    select w.id into v_other from public.wf_staff w
     where w.pos_user_id = p_pos_user_id and w.id <> st.id and w.status <> 'leaver' limit 1;
    if found then
      raise exception 'That till user is already linked to another staff record' using errcode = '23505';
    end if;
  end if;

  v_prev := st.pos_user_id;
  if v_prev is not distinct from p_pos_user_id then
    return jsonb_build_object('ok', true, 'changed', false, 'staff_id', st.id, 'pos_user_id', p_pos_user_id, 'previous', v_prev);
  end if;
  perform set_config('wf.identity_reason', coalesce(left(btrim(p_reason), 200), ''), true);
  update public.wf_staff set pos_user_id = p_pos_user_id, updated_at = now() where id = st.id;
  perform set_config('wf.identity_reason', '', true);
  return jsonb_build_object('ok', true, 'changed', true, 'staff_id', st.id, 'pos_user_id', p_pos_user_id, 'previous', v_prev);
end
$f$;
revoke all on function public.wf_staff_set_pos_user(uuid, uuid, text) from public, anon;
grant execute on function public.wf_staff_set_pos_user(uuid, uuid, text) to authenticated, service_role;
comment on function public.wf_staff_set_pos_user(uuid, uuid, text) is
  'The one door for wf_staff.pos_user_id: an owner of the company (user_profiles owner of the org, user_locations owner or admin at a venue of it, or a super admin), the service role, or the database. Writes a wf_audit row. 20261104a.';

notify pgrst, 'reload schema';

-- Check: one row, wf_staff_set_pos_user | f
select p.proname, position('v_manager' in pg_get_functiondef(p.oid)) > 0 as manager_rule
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'wf_staff_set_pos_user';
