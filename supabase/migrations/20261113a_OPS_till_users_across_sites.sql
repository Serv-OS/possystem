-- 20261113a_OPS_till_users_across_sites.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi), Supabase SQL editor. Release 5.12.39.
-- Needs 20261111a and 20261112a (one person, many sites).
--
-- Peter, 2 Nov 2026: "I also can't see any way within Team to be able to set which sites they work
-- at". 20261111a's doors start from a Workforce staff record; many till users have none (152 till
-- users, 85 Workforce records). These three start from the TILL USER (staff_members), for Back
-- Office, Team:
--
--   wf_till_add_site(member, location)  "Also works at": a till user at the other site with the same
--     PIN, card, sign in method, name, till role and permissions, linked as one person. When the till
--     user has a Workforce record, this is wf_staff_add_site on it (both records, as Workforce does).
--   wf_till_link(member, other)  joins two till users made by hand at two sites: the other takes
--     this one's PIN, card, sign in method, name, initials and colour. When both have Workforce
--     records, this is wf_staff_link on them.
--   wf_till_unlink(member)  this site only again (wf_staff_unlink when it has a Workforce record).
--
-- Same rules as 20261111a: Back Office access to every site involved and the second step; a PIN
-- used by someone else at any of the person's sites is refused with the name; a wf_audit row.
--
-- And: a Workforce record made later for a linked till user (the clock makes one on first clock in
-- at a site, Workforce, Set up on the POS links one) joins the person automatically, so their hours
-- count across sites with no extra step.
--
-- Safe to run once. Additive: three functions, one trigger, the person_id guard widened to the three
-- new doors. No row changes. Rollback: 20261113a_OPS_till_users_across_sites_ROLLBACK.sql

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_add_site(uuid,uuid,text,numeric)') is null
     or to_regprocedure('public.wf_ot_recompute(uuid,timestamptz)') is null then
    raise exception 'One person, many sites (20261111a and 20261112a) has not run. Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_till_add_site(uuid,uuid)') is not null then
    raise exception '20261113a has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- -- 1. The person_id guard lets the till doors through too ------------------------------------
create or replace function public.wf_people_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_ctx text;
begin
  if tg_op = 'INSERT' and new.person_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.person_id is not distinct from old.person_id then
    return new;
  end if;
  if v_role = 'service_role' then
    return new;
  end if;
  if v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    return new;
  end if;
  get diagnostics v_ctx = pg_context;
  if v_ctx ~ 'function (public\.)?wf_(staff|till)_(add_site|link|unlink)\(' then
    return new;
  end if;
  raise exception 'Link a person to another site from Workforce, Staff, Sites or Team, Sites (person_id is not written directly)'
    using errcode = '42501';
end
$f$;
revoke all on function public.wf_people_link_guard() from public, anon, authenticated, service_role;

-- -- 2. The till doors ---------------------------------------------------------------------------
-- The live Workforce record of a till user, if any.
create function public._wf_staff_of_till(p_member uuid)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $f$
  select w.id from public.wf_staff w where w.pos_user_id = p_member and w.status <> 'leaver' order by w.created_at limit 1
$f$;
revoke all on function public._wf_staff_of_till(uuid) from public, anon, authenticated, service_role;

create function public.wf_till_add_site(p_member uuid, p_location uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  sm public.staff_members;
  v_org uuid;
  v_loc_org uuid;
  v_staff uuid;
  v_person uuid;
  v_new uuid;
  v_clash text;
  v_locs uuid[];
begin
  if p_member is null or p_location is null then
    raise exception 'Pick a till user and a site' using errcode = '22023';
  end if;
  select * into sm from public.staff_members where id = p_member for update;
  if not found then
    raise exception 'No till user with that id' using errcode = 'P0002';
  end if;
  v_org := coalesce(sm.org_id, (select l.org_id from public.locations l where l.id = sm.location_id));
  select l.org_id into v_loc_org from public.locations l where l.id = p_location;
  if v_org is null or v_loc_org is null or v_loc_org <> v_org then
    raise exception 'That site belongs to another company' using errcode = '22023';
  end if;
  if p_location = sm.location_id then
    raise exception 'They already work at this site' using errcode = '22023';
  end if;
  -- A till user with a Workforce record: Workforce's own door makes both records.
  v_staff := public._wf_staff_of_till(sm.id);
  if v_staff is not null then
    return public.wf_staff_add_site(v_staff, p_location, null, null);
  end if;

  select array_agg(distinct x) into v_locs
    from unnest(array[sm.location_id, p_location] || coalesce((select array_agg(s.location_id) from public.staff_members s
                                                                 where sm.person_id is not null and s.person_id = sm.person_id), '{}'::uuid[])) as x;
  perform public.wf_people_assert_access(v_org, v_locs);
  if coalesce(sm.active, true) = false then
    raise exception 'This till user is switched off. Switch them on first' using errcode = '22023';
  end if;
  if sm.person_id is not null and exists (select 1 from public.staff_members s
       where s.person_id = sm.person_id and s.location_id = p_location and coalesce(s.active, true)) then
    raise exception 'They already work at that site' using errcode = '23505';
  end if;
  v_person := coalesce(sm.person_id, gen_random_uuid());
  v_clash := public.wf_people_pin_clash(v_person, v_org, sm.pin, v_locs, sm.id);
  if v_clash is not null then
    raise exception 'Their PIN is already used by %. Change their PIN first, then add the site', v_clash using errcode = '23505';
  end if;
  if sm.person_id is null then
    update public.staff_members set person_id = v_person where id = sm.id;
  end if;
  v_new := gen_random_uuid();
  insert into public.staff_members (id, location_id, org_id, name, role, pin, color, initials, active, permissions, nfc_card_id, auth_method, person_id)
  values (v_new, p_location, v_org, sm.name, sm.role, sm.pin, sm.color, sm.initials, true, coalesce(sm.permissions, '[]'::jsonb), sm.nfc_card_id, coalesce(sm.auth_method, 'pin'), v_person);
  perform public.wf_people_audit(p_location, v_org, 'till.site_added', v_new,
    jsonb_build_object('from_till_user', sm.id, 'from_location_id', sm.location_id),
    jsonb_build_object('person_id', v_person, 'location_id', p_location, 'role', sm.role));
  return jsonb_build_object('ok', true, 'pos_user_id', v_new, 'person_id', v_person, 'staff_id', null);
end
$f$;
revoke all on function public.wf_till_add_site(uuid, uuid) from public, anon;
grant execute on function public.wf_till_add_site(uuid, uuid) to authenticated, service_role;

create function public.wf_till_link(p_member uuid, p_other uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  a public.staff_members;
  b public.staff_members;
  v_org uuid;
  v_sa uuid;
  v_sb uuid;
  v_person uuid;
  v_locs uuid[];
begin
  if p_member is null or p_other is null or p_member = p_other then
    raise exception 'Pick two different till users' using errcode = '22023';
  end if;
  select * into a from public.staff_members where id = p_member for update;
  select * into b from public.staff_members where id = p_other for update;
  if a.id is null or b.id is null then
    raise exception 'No till user with that id' using errcode = 'P0002';
  end if;
  v_org := coalesce(a.org_id, (select l.org_id from public.locations l where l.id = a.location_id));
  if v_org is null or v_org <> coalesce(b.org_id, (select l.org_id from public.locations l where l.id = b.location_id)) then
    raise exception 'Those two till users belong to different companies' using errcode = '22023';
  end if;
  if a.location_id = b.location_id then
    raise exception 'Both are at the same site. Link till users at different sites' using errcode = '22023';
  end if;
  -- Both with Workforce records: Workforce's own door links both records and both till users.
  v_sa := public._wf_staff_of_till(a.id);
  v_sb := public._wf_staff_of_till(b.id);
  if v_sa is not null and v_sb is not null then
    return public.wf_staff_link(v_sa, v_sb);
  end if;

  select array_agg(distinct x) into v_locs
    from unnest(array[a.location_id, b.location_id] || coalesce((select array_agg(s.location_id) from public.staff_members s
                                                                   where s.person_id is not null and s.person_id in (a.person_id, b.person_id)), '{}'::uuid[])) as x;
  perform public.wf_people_assert_access(v_org, v_locs);

  v_person := coalesce(a.person_id, b.person_id, (select w.person_id from public.wf_staff w where w.id in (v_sa, v_sb) and w.person_id is not null limit 1), gen_random_uuid());
  if a.person_id is not null and b.person_id is not null and a.person_id <> b.person_id then
    update public.staff_members set person_id = v_person where person_id = b.person_id and org_id is not distinct from v_org;
    update public.wf_staff set person_id = v_person, updated_at = now() where person_id = b.person_id and org_id = v_org;
  end if;
  -- The other takes this one's PIN and card in the same statement that links it (the PIN check runs
  -- on the PIN it will have).
  update public.staff_members
     set pin = a.pin, nfc_card_id = a.nfc_card_id, auth_method = a.auth_method, name = a.name, initials = a.initials, color = a.color, person_id = v_person
   where id = b.id;
  update public.staff_members set person_id = v_person where id = a.id and person_id is distinct from v_person;
  -- The one Workforce record either has joins the person too.
  update public.wf_staff set person_id = v_person, updated_at = now()
   where id in (v_sa, v_sb) and person_id is distinct from v_person;
  if exists (select 1 from public.wf_staff w where w.person_id = v_person and w.status <> 'leaver'
              group by w.location_id having count(*) > 1) then
    raise exception 'This person would have two Workforce records at one site. Archive the extra record first' using errcode = '23505';
  end if;
  perform public.wf_people_audit(b.location_id, v_org, 'till.person_linked', b.id,
    jsonb_build_object('person_id', b.person_id, 'name', b.name),
    jsonb_build_object('person_id', v_person, 'linked_to', a.id, 'name', a.name));
  return jsonb_build_object('ok', true, 'person_id', v_person);
end
$f$;
revoke all on function public.wf_till_link(uuid, uuid) from public, anon;
grant execute on function public.wf_till_link(uuid, uuid) to authenticated, service_role;

create function public.wf_till_unlink(p_member uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  sm public.staff_members;
  v_org uuid;
  v_staff uuid;
begin
  select * into sm from public.staff_members where id = p_member for update;
  if not found then
    raise exception 'No till user with that id' using errcode = 'P0002';
  end if;
  v_staff := public._wf_staff_of_till(sm.id);
  if v_staff is not null then
    return public.wf_staff_unlink(v_staff);
  end if;
  v_org := coalesce(sm.org_id, (select l.org_id from public.locations l where l.id = sm.location_id));
  perform public.wf_people_assert_access(v_org, array[sm.location_id]);
  if sm.person_id is null then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  update public.staff_members set person_id = null where id = sm.id;
  perform public.wf_people_audit(sm.location_id, v_org, 'till.person_unlinked', sm.id,
    jsonb_build_object('person_id', sm.person_id), jsonb_build_object('person_id', null));
  return jsonb_build_object('ok', true, 'changed', true);
end
$f$;
revoke all on function public.wf_till_unlink(uuid) from public, anon;
grant execute on function public.wf_till_unlink(uuid) to authenticated, service_role;

-- -- 3. A Workforce record made later for a linked till user joins the person ------------------
-- Fires after the person_id guard (triggers fire in name order), so it is never refused: it only
-- copies the link the till user already has, and only when the person has no other live record at
-- that site.
create function public.wf_people_inherit_from_till()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_person uuid;
begin
  if new.person_id is not null or new.pos_user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.pos_user_id is not distinct from old.pos_user_id then
    return new;
  end if;
  select s.person_id into v_person from public.staff_members s
   where s.id = new.pos_user_id and s.person_id is not null and (s.org_id is null or s.org_id = new.org_id);
  if v_person is null then
    return new;
  end if;
  if exists (select 1 from public.wf_staff w where w.person_id = v_person and w.location_id = new.location_id
              and w.status <> 'leaver' and w.id <> new.id) then
    return new;
  end if;
  new.person_id := v_person;
  return new;
end
$f$;
revoke all on function public.wf_people_inherit_from_till() from public, anon, authenticated, service_role;
create trigger wf_staff_zz_person_inherit_trg
  before insert or update of pos_user_id on public.wf_staff
  for each row execute function public.wf_people_inherit_from_till();

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: doors 3, doors_open_to_anon false, inherit true, guard_allows_till true.
select
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wf_till_add_site', 'wf_till_link', 'wf_till_unlink')) as doors,
  (has_function_privilege('anon', 'public.wf_till_add_site(uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.wf_till_link(uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.wf_till_unlink(uuid)', 'execute')) as doors_open_to_anon,
  exists (select 1 from pg_trigger where tgname = 'wf_staff_zz_person_inherit_trg') as inherit,
  position('wf_(staff|till)' in pg_get_functiondef('public.wf_people_link_guard()'::regprocedure)) > 0 as guard_allows_till;
