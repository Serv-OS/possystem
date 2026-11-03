-- 20261118a_OPS_wf_staff_primary_location.sql (5.12.55). Run in the Ops SQL editor. ASCII only.
--
-- Peter, 3 Nov 2026: a person who works at several sites has a PRIMARY LOCATION. They earn holiday or
-- PTO at every site into one balance, and time off is taken (and charged) at the primary location.
-- The primary is wf_staff.primary_venue_id, kept the same on every linked record (person_id). This
-- door sets it: only someone with access to every site the person works at (and past the second
-- step), and only to one of those sites. The Back Office staff save no longer rewrites it (5.12.55).

do $guard$
begin
  if to_regprocedure('public.wf_people_assert_access(uuid, uuid[])') is null then
    raise exception 'Run 20261111a_OPS_wf_people_across_sites first. Nothing was changed.';
  end if;
end
$guard$;

begin;

create or replace function public.wf_staff_set_primary(p_staff_id uuid, p_location uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  st public.wf_staff;
  v_locs uuid[];
  v_before uuid;
begin
  select * into st from public.wf_staff where id = p_staff_id for update;
  if not found then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;
  if st.person_id is null then
    v_locs := array[st.location_id];
  else
    select array_agg(distinct location_id) into v_locs from public.wf_staff
     where org_id = st.org_id and person_id = st.person_id and coalesce(status, '') <> 'leaver';
  end if;
  perform public.wf_people_assert_access(st.org_id, v_locs);
  if not (p_location = any(v_locs)) then
    raise exception 'The primary location must be one of the sites this person works at.' using errcode = '22023';
  end if;
  v_before := st.primary_venue_id;
  if st.person_id is null then
    update public.wf_staff set primary_venue_id = p_location, updated_at = now() where id = st.id;
  else
    update public.wf_staff set primary_venue_id = p_location, updated_at = now()
     where org_id = st.org_id and person_id = st.person_id;
  end if;
  perform public.wf_people_audit(st.location_id, st.org_id, 'staff.primary_location', st.id,
    jsonb_build_object('primary_venue_id', v_before), jsonb_build_object('primary_venue_id', p_location));
  return jsonb_build_object('ok', true, 'primary_venue_id', p_location);
end
$f$;
revoke all on function public.wf_staff_set_primary(uuid, uuid) from public, anon;
grant execute on function public.wf_staff_set_primary(uuid, uuid) to authenticated, service_role;

commit;

-- Check: one row, true.
select to_regprocedure('public.wf_staff_set_primary(uuid, uuid)') is not null as primary_location_door_ready;
