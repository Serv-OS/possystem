-- 20261111a_OPS_wf_people_across_sites.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi), Supabase SQL editor. Release 5.12.36.
--
-- ONE PERSON, MANY SITES (Peter, 2 Nov 2026): "one member of staff might work at 2 sites or 3 sites,
-- in the US overtime is calculated after they have worked 40 hours but they might work 20 hours at one
-- site and 25 hours at another site" and "can we make it so a pos user can be shared between sites too
-- with the same pin changed at one location changed at both".
--
-- Workforce keeps one wf_staff row per site (each site's role, rate, rota and timesheets stay as they
-- are) and one staff_members row (till user) per site. This links the rows of one person:
--
--   person_id    a new uuid column on wf_staff and staff_members. Rows with the same person_id are one
--                person. NULL means "works at this site only" (every row today). It is never a row id,
--                so unlinking one row can never leave the others pointing at it.
--
--   Doors        person_id changes only through three functions, each checking the caller has Back
--                Office access to the company and has finished the second sign in step:
--                  wf_staff_add_site(staff, location, role_key, rate)  "Also works at": makes the row at
--                    the other site from this one, and the till user too when this one has one (same
--                    PIN, card and sign in method; the PIN must not clash at the other site)
--                  wf_staff_link(staff, other)  joins two rows that already exist (the same person
--                    added at two sites by hand); the other row takes this row's details and PIN
--                  wf_staff_unlink(staff)  this site only again
--                Every change writes a wf_audit row. A direct API write to person_id is refused.
--
--   Sync         a change to a linked person's own details (name, contact, date of birth, address,
--                emergency contact, payroll ids, bank) copies to their other sites; a change to a
--                linked till user's PIN, card, sign in method, name, initials or colour copies to their
--                other till users. A PIN already used by someone else at any of the person's sites is
--                refused with that person's name. Role, permissions, pay rate, sections and status stay
--                per site (a manager at one site can be staff at another).
--
-- Payroll (workforce-compute, US venues) reads person_id to count a work week across every linked site.
--
-- Safe to run once. Additive: two columns, two indexes, functions, triggers. No row changes.
-- Rollback: 20261111a_OPS_wf_people_across_sites_ROLLBACK.sql

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.wf_staff') is null or to_regclass('public.staff_members') is null
     or to_regclass('public.wf_audit') is null or to_regclass('public.locations') is null then
    raise exception 'The Workforce tables are missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_regrant_api()') is null or to_regprocedure('public.wf_staff_identity_guard()') is null then
    raise exception 'The staff identity fence (20261104a) has not run. Run it first. Nothing was changed.';
  end if;
  if to_regprocedure('public.user_accessible_orgs()') is null or to_regprocedure('public.user_accessible_locations()') is null
     or to_regprocedure('public.second_step_ok()') is null
     or to_regprocedure('public.is_super_admin()') is null or to_regprocedure('public.is_anon_session()') is null then
    raise exception 'user_accessible_orgs, user_accessible_locations, second_step_ok, is_super_admin or is_anon_session is missing. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'wf_staff' and column_name = 'person_id') then
    raise exception 'wf_staff.person_id exists already (20261111a has run). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- -- 1. The columns -----------------------------------------------------------------------------
alter table public.wf_staff add column person_id uuid;
alter table public.staff_members add column person_id uuid;
create index if not exists idx_wf_staff_person on public.wf_staff (org_id, person_id) where person_id is not null;
create index if not exists idx_staff_members_person on public.staff_members (org_id, person_id) where person_id is not null;
comment on column public.wf_staff.person_id is
  'Rows with the same person_id are one person working at several sites. NULL = this site only. Changed only by wf_staff_add_site, wf_staff_link, wf_staff_unlink. 20261111a.';
comment on column public.staff_members.person_id is
  'Till users with the same person_id share PIN, card, sign in method, name, initials and colour across sites. Set by wf_staff_add_site and wf_staff_link. 20261111a.';

-- -- 2. The Back Office cannot write person_id directly ---------------------------------------
-- The regrant helper now leaves out person_id as well as the four identity columns.
create or replace function public.wf_staff_regrant_api()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_cols text;
  v_n integer;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*)
    into v_cols, v_n
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'wf_staff'
     and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires', 'person_id');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_api() from public, anon, authenticated, service_role;
comment on function public.wf_staff_regrant_api() is
  'Grants INSERT and UPDATE on every wf_staff column except portal_user_id, pos_user_id, portal_invite_hash, portal_invite_expires and person_id to authenticated. Call it after adding a wf_staff column. 20261104a, person_id left out since 20261111a.';

revoke insert, update on table public.wf_staff from authenticated;
select public.wf_staff_regrant_api() as columns_granted;

-- The identity guard also lets wf_staff_add_site set the new row's till user (it makes both rows).
create or replace function public.wf_staff_identity_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_ctx text;
  v_changed boolean;
begin
  if v_role = 'service_role' then
    return new;
  end if;
  if v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    return new;
  end if;
  get diagnostics v_ctx = pg_context;
  if v_ctx ~ 'function (public\.)?wf_staff_set_pos_user\(uuid,uuid,text\)'
     or v_ctx ~ 'function (public\.)?wf_staff_add_site\(uuid,uuid,text,numeric\)'
     or v_ctx ~ 'function (public\.)?wf_staff_link\(uuid,uuid\)' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_changed := new.portal_user_id is not null or new.pos_user_id is not null
              or new.portal_invite_hash is not null or new.portal_invite_expires is not null;
  else
    v_changed := new.portal_user_id is distinct from old.portal_user_id
              or new.pos_user_id is distinct from old.pos_user_id
              or new.portal_invite_hash is distinct from old.portal_invite_hash
              or new.portal_invite_expires is distinct from old.portal_invite_expires;
  end if;
  if v_changed then
    raise exception 'wf_staff.portal_user_id, pos_user_id and the invite columns change only through the staff app service or wf_staff_set_pos_user (an owner of the company)'
      using errcode = '42501';
  end if;
  return new;
end
$f$;
revoke all on function public.wf_staff_identity_guard() from public, anon, authenticated, service_role;

-- person_id on either table: only the three doors, the service role or the database itself.
create function public.wf_people_link_guard()
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
  if v_ctx ~ 'function (public\.)?wf_staff_(add_site|link|unlink)\(' then
    return new;
  end if;
  raise exception 'Link a person to another site from Workforce, Staff, Sites (person_id is not written directly)'
    using errcode = '42501';
end
$f$;
revoke all on function public.wf_people_link_guard() from public, anon, authenticated, service_role;

create trigger wf_staff_person_guard_trg
  before insert or update of person_id on public.wf_staff
  for each row execute function public.wf_people_link_guard();
create trigger staff_members_person_guard_trg
  before insert or update of person_id on public.staff_members
  for each row execute function public.wf_people_link_guard();

-- -- 3. Shared checks --------------------------------------------------------------------------
-- The caller may change Workforce for this company AT EVERY SITE GIVEN: a Back Office login with
-- access to the company and to each site, the second sign in step done; or a super admin, the service
-- role or the database itself. Every site, because a link shares a PIN: a manager of one site must
-- never be able to sign in at another site as someone they linked.
create function public.wf_people_assert_access(p_org uuid, p_locations uuid[])
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role = 'service_role' then return; end if;
  if v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then return; end if;
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office first' using errcode = '42501';
  end if;
  if not public.second_step_ok() then
    raise exception 'Finish your second sign in step first' using errcode = '42501';
  end if;
  if public.is_super_admin() then return; end if;
  if p_org is null or p_org::text not in (select public.user_accessible_orgs()) then
    raise exception 'You do not have access to this company' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(coalesce(p_locations, '{}'::uuid[])) as x(loc)
              where x.loc is not null and x.loc::text not in (select public.user_accessible_locations())) then
    raise exception 'You need access to every site this person works at to do that' using errcode = '42501';
  end if;
end
$f$;
revoke all on function public.wf_people_assert_access(uuid, uuid[]) from public, anon, authenticated, service_role;

-- A PIN used by someone else at any site where this person has a till user (or will have one).
create function public.wf_people_pin_clash(p_person uuid, p_org uuid, p_pin text, p_locations uuid[], p_self uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp as $f$
  select sm.name || ' at ' || coalesce(l.name, 'another site')
    from public.staff_members sm
    left join public.locations l on l.id = sm.location_id
   where coalesce(p_pin, '') <> ''
     and sm.pin = p_pin
     and coalesce(sm.active, true)
     and sm.location_id = any (p_locations)
     and sm.id is distinct from p_self
     and (p_person is null or sm.person_id is distinct from p_person)
   limit 1
$f$;
revoke all on function public.wf_people_pin_clash(uuid, uuid, text, uuid[], uuid) from public, anon, authenticated, service_role;

create function public.wf_people_audit(p_loc uuid, p_org uuid, p_action text, p_entity_id uuid, p_before jsonb, p_after jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_uid uuid := auth.uid();
  v_actor text;
begin
  select coalesce(p.full_name, p.email, v_uid::text) into v_actor from public.user_profiles p where p.id = v_uid;
  insert into public.wf_audit (location_id, org_id, actor_id, actor_name, action, entity, entity_id, reason, before, after)
  values (p_loc, p_org, v_uid, coalesce(v_actor, case when v_uid is null then 'system' else v_uid::text end),
          p_action, 'wf_staff', p_entity_id::text, null, coalesce(p_before, '{}'::jsonb), coalesce(p_after, '{}'::jsonb));
end
$f$;
revoke all on function public.wf_people_audit(uuid, uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

-- -- 4. The doors ------------------------------------------------------------------------------
-- "Also works at": a new row at p_location_id for the same person, and a till user there when this
-- row has one.
create function public.wf_staff_add_site(p_staff_id uuid, p_location_id uuid, p_role_key text default null, p_rate numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  src public.wf_staff;
  sm public.staff_members;
  v_loc_org uuid;
  v_person uuid;
  v_new uuid := gen_random_uuid();
  v_new_sm uuid;
  v_clash text;
  v_locs uuid[];
begin
  if p_staff_id is null or p_location_id is null then
    raise exception 'Pick a person and a site' using errcode = '22023';
  end if;
  select * into src from public.wf_staff where id = p_staff_id for update;
  if not found then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;
  select l.org_id into v_loc_org from public.locations l where l.id = p_location_id;
  if v_loc_org is null or v_loc_org::text <> src.org_id::text then
    raise exception 'That site belongs to another company' using errcode = '22023';
  end if;
  perform public.wf_people_assert_access(src.org_id,
    array[src.location_id, p_location_id] || coalesce((select array_agg(w.location_id) from public.wf_staff w
                                                         where src.person_id is not null and w.person_id = src.person_id), '{}'::uuid[]));
  if src.status = 'leaver' then
    raise exception 'This person is a leaver. Reinstate them first' using errcode = '22023';
  end if;
  if p_location_id = src.location_id then
    raise exception 'They already work at this site' using errcode = '22023';
  end if;
  if src.person_id is not null and exists (
       select 1 from public.wf_staff w
        where w.person_id = src.person_id and w.location_id = p_location_id and w.status <> 'leaver') then
    raise exception 'They already work at that site' using errcode = '23505';
  end if;

  v_person := coalesce(src.person_id, gen_random_uuid());
  if src.person_id is null then
    update public.wf_staff set person_id = v_person, updated_at = now() where id = src.id;
  end if;

  insert into public.wf_staff (
    id, org_id, location_id, name, photo_url, role_key, section_ids, primary_venue_id, venue_ids,
    contract_type, rate_override, dob, ni_number, tax_ref, bank_sort_code, bank_account_masked,
    address, emergency_contact, mobile, email, right_to_work, start_date, status,
    bank_account, bank_account_name, payroll_employee_id, ssn_last4, person_id)
  values (
    v_new, src.org_id, p_location_id, src.name, src.photo_url, coalesce(nullif(btrim(p_role_key), ''), src.role_key),
    '{}'::uuid[], p_location_id, array[p_location_id],
    coalesce(src.contract_type, 'partTime'), p_rate, src.dob, src.ni_number, src.tax_ref, src.bank_sort_code, src.bank_account_masked,
    src.address, src.emergency_contact, src.mobile, src.email, src.right_to_work, current_date, 'active',
    src.bank_account, src.bank_account_name, src.payroll_employee_id, src.ssn_last4, v_person);

  if src.pos_user_id is not null then
    select * into sm from public.staff_members where id = src.pos_user_id for update;
    if found then
      select array_agg(distinct x) into v_locs
        from unnest(array[p_location_id] || coalesce((select array_agg(s.location_id) from public.staff_members s where s.person_id = v_person), '{}'::uuid[])) as x;
      v_clash := public.wf_people_pin_clash(v_person, src.org_id, sm.pin, v_locs, sm.id);
      if v_clash is not null then
        raise exception 'Their PIN is already used by %. Change their PIN first, then add the site', v_clash using errcode = '23505';
      end if;
      if sm.person_id is null then
        update public.staff_members set person_id = v_person where id = sm.id;
      end if;
      v_new_sm := gen_random_uuid();
      insert into public.staff_members (id, location_id, org_id, name, role, pin, color, initials, active, permissions, nfc_card_id, auth_method, person_id)
      values (v_new_sm, p_location_id, sm.org_id, sm.name, sm.role, sm.pin, sm.color, sm.initials, true, coalesce(sm.permissions, '[]'::jsonb), sm.nfc_card_id, coalesce(sm.auth_method, 'pin'), v_person);
      update public.wf_staff set pos_user_id = v_new_sm, updated_at = now() where id = v_new;
    end if;
  end if;

  perform public.wf_people_audit(p_location_id, src.org_id, 'staff.site_added', v_new,
    jsonb_build_object('from_staff_id', src.id, 'from_location_id', src.location_id),
    jsonb_build_object('person_id', v_person, 'location_id', p_location_id, 'role_key', coalesce(nullif(btrim(p_role_key), ''), src.role_key), 'rate_override', p_rate, 'till_user', v_new_sm));
  return jsonb_build_object('ok', true, 'staff_id', v_new, 'person_id', v_person, 'pos_user_id', v_new_sm);
end
$f$;
revoke all on function public.wf_staff_add_site(uuid, uuid, text, numeric) from public, anon;
grant execute on function public.wf_staff_add_site(uuid, uuid, text, numeric) to authenticated, service_role;

-- Join two rows that already exist. The other row (and its till user) takes this row's details and PIN.
create function public.wf_staff_link(p_staff_id uuid, p_other_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  a public.wf_staff;
  b public.wf_staff;
  sa public.staff_members;
  v_person uuid;
begin
  if p_staff_id is null or p_other_id is null or p_staff_id = p_other_id then
    raise exception 'Pick two different staff records' using errcode = '22023';
  end if;
  select * into a from public.wf_staff where id = p_staff_id for update;
  select * into b from public.wf_staff where id = p_other_id for update;
  if a.id is null or b.id is null then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;
  if a.org_id <> b.org_id then
    raise exception 'Those two records belong to different companies' using errcode = '22023';
  end if;
  perform public.wf_people_assert_access(a.org_id,
    array[a.location_id, b.location_id] || coalesce((select array_agg(w.location_id) from public.wf_staff w
                                                       where w.person_id is not null and w.person_id in (a.person_id, b.person_id)), '{}'::uuid[]));
  if a.location_id = b.location_id then
    raise exception 'Both records are at the same site. Link records at different sites' using errcode = '22023';
  end if;

  v_person := coalesce(a.person_id, b.person_id, gen_random_uuid());
  -- Two people already linked elsewhere become one: every row of the other person moves over.
  if a.person_id is not null and b.person_id is not null and a.person_id <> b.person_id then
    update public.wf_staff set person_id = v_person, updated_at = now() where person_id = b.person_id and org_id = a.org_id;
    update public.staff_members set person_id = v_person where person_id = b.person_id and org_id = a.org_id;
  end if;
  update public.wf_staff set person_id = v_person, updated_at = now() where id in (a.id, b.id) and person_id is distinct from v_person;

  -- Never two active rows of one person at one site.
  if exists (select 1 from public.wf_staff w where w.person_id = v_person and w.status <> 'leaver'
              group by w.location_id having count(*) > 1) then
    raise exception 'This person would have two records at one site. Archive the extra record first' using errcode = '23505';
  end if;

  -- The other records take this one's own details: touching name here fires the sync, which copies
  -- every personal field from this row. (Setting person_id above does not sync, so nothing was
  -- copied the wrong way first.)
  update public.wf_staff set name = a.name, updated_at = now() where id = a.id;

  -- Till users: the other one takes this one's PIN, card, sign in method, name, initials and colour in
  -- the same statement that links it, so the PIN check runs on the PIN it will have.
  if a.pos_user_id is not null then
    select * into sa from public.staff_members where id = a.pos_user_id for update;
    if found then
      if b.pos_user_id is not null then
        update public.staff_members
           set pin = sa.pin, nfc_card_id = sa.nfc_card_id, auth_method = sa.auth_method,
               name = sa.name, initials = sa.initials, color = sa.color, person_id = v_person
         where id = b.pos_user_id;
      end if;
      update public.staff_members set person_id = v_person where id = sa.id and person_id is distinct from v_person;
      update public.staff_members o
         set pin = sa.pin, nfc_card_id = sa.nfc_card_id, auth_method = sa.auth_method, name = sa.name, initials = sa.initials, color = sa.color
       where o.person_id = v_person and o.org_id is not distinct from sa.org_id and o.id <> sa.id
         and (o.pin, o.nfc_card_id, o.auth_method, o.name, o.initials, o.color)
             is distinct from (sa.pin, sa.nfc_card_id, sa.auth_method, sa.name, sa.initials, sa.color);
    end if;
  elsif b.pos_user_id is not null then
    update public.staff_members set person_id = v_person where id = b.pos_user_id and person_id is distinct from v_person;
  end if;

  perform public.wf_people_audit(b.location_id, a.org_id, 'staff.person_linked', b.id,
    jsonb_build_object('person_id', b.person_id, 'name', b.name),
    jsonb_build_object('person_id', v_person, 'linked_to', a.id, 'name', a.name));
  return jsonb_build_object('ok', true, 'person_id', v_person);
end
$f$;
revoke all on function public.wf_staff_link(uuid, uuid) from public, anon;
grant execute on function public.wf_staff_link(uuid, uuid) to authenticated, service_role;

-- This site only again. The record and its till user stay; only the link goes.
create function public.wf_staff_unlink(p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  st public.wf_staff;
begin
  select * into st from public.wf_staff where id = p_staff_id for update;
  if not found then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;
  perform public.wf_people_assert_access(st.org_id, array[st.location_id]);
  if st.person_id is null then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;
  update public.wf_staff set person_id = null, updated_at = now() where id = st.id;
  if st.pos_user_id is not null then
    update public.staff_members set person_id = null where id = st.pos_user_id;
  end if;
  perform public.wf_people_audit(st.location_id, st.org_id, 'staff.person_unlinked', st.id,
    jsonb_build_object('person_id', st.person_id), jsonb_build_object('person_id', null));
  return jsonb_build_object('ok', true, 'changed', true);
end
$f$;
revoke all on function public.wf_staff_unlink(uuid) from public, anon;
grant execute on function public.wf_staff_unlink(uuid) to authenticated, service_role;

-- -- 5. Sync -----------------------------------------------------------------------------------
-- A linked person's own details follow them to every site.
create function public.wf_people_sync_staff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
begin
  if new.person_id is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  update public.wf_staff o
     set name = new.name, photo_url = new.photo_url, dob = new.dob, ni_number = new.ni_number, tax_ref = new.tax_ref,
         bank_sort_code = new.bank_sort_code, bank_account_masked = new.bank_account_masked, bank_account = new.bank_account,
         bank_account_name = new.bank_account_name, address = new.address, emergency_contact = new.emergency_contact,
         mobile = new.mobile, email = new.email, payroll_employee_id = new.payroll_employee_id, ssn_last4 = new.ssn_last4,
         updated_at = now()
   where o.person_id = new.person_id and o.org_id = new.org_id and o.id <> new.id
     and (o.name, o.photo_url, o.dob, o.ni_number, o.tax_ref, o.bank_sort_code, o.bank_account_masked, o.bank_account,
          o.bank_account_name, o.address, o.emergency_contact, o.mobile, o.email, o.payroll_employee_id, o.ssn_last4)
         is distinct from
         (new.name, new.photo_url, new.dob, new.ni_number, new.tax_ref, new.bank_sort_code, new.bank_account_masked, new.bank_account,
          new.bank_account_name, new.address, new.emergency_contact, new.mobile, new.email, new.payroll_employee_id, new.ssn_last4);
  return new;
end
$f$;
revoke all on function public.wf_people_sync_staff() from public, anon, authenticated, service_role;
create trigger wf_staff_person_sync_trg
  after update of name, photo_url, dob, ni_number, tax_ref, bank_sort_code, bank_account_masked, bank_account,
                  bank_account_name, address, emergency_contact, mobile, email, payroll_employee_id, ssn_last4
  on public.wf_staff
  for each row execute function public.wf_people_sync_staff();

-- A linked till user's PIN may not clash with anyone else's at any of the person's sites.
create function public.wf_people_till_pin_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_locs uuid[];
  v_clash text;
begin
  if new.person_id is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.pin is not distinct from old.pin and new.person_id is not distinct from old.person_id then
    return new;
  end if;
  select array_agg(distinct s.location_id) into v_locs
    from public.staff_members s where s.person_id = new.person_id and s.org_id is not distinct from new.org_id;
  v_locs := coalesce(v_locs, '{}'::uuid[]) || new.location_id;
  -- A shared PIN signs in at every site, so only someone who may manage every one of them changes it.
  if tg_op = 'UPDATE' and new.pin is distinct from old.pin then
    perform public.wf_people_assert_access(new.org_id, v_locs);
  end if;
  v_clash := public.wf_people_pin_clash(new.person_id, new.org_id, new.pin, v_locs, new.id);
  if v_clash is not null then
    raise exception 'That PIN is already used by %. Pick another PIN', v_clash using errcode = '23505';
  end if;
  return new;
end
$f$;
revoke all on function public.wf_people_till_pin_check() from public, anon, authenticated, service_role;
create trigger staff_members_person_pin_trg
  before insert or update of pin, person_id on public.staff_members
  for each row execute function public.wf_people_till_pin_check();

-- A linked till user's PIN, card, sign in method, name, initials and colour follow them.
create function public.wf_people_sync_till()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
begin
  if new.person_id is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  update public.staff_members o
     set pin = new.pin, nfc_card_id = new.nfc_card_id, auth_method = new.auth_method,
         name = new.name, initials = new.initials, color = new.color
   where o.person_id = new.person_id and o.org_id is not distinct from new.org_id and o.id <> new.id
     and (o.pin, o.nfc_card_id, o.auth_method, o.name, o.initials, o.color)
         is distinct from (new.pin, new.nfc_card_id, new.auth_method, new.name, new.initials, new.color);
  return new;
end
$f$;
revoke all on function public.wf_people_sync_till() from public, anon, authenticated, service_role;
create trigger staff_members_person_sync_trg
  after update of pin, nfc_card_id, auth_method, name, initials, color on public.staff_members
  for each row execute function public.wf_people_sync_till();

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: columns 2, api_writes_person_id false, api_updates_name true,
-- doors 3, doors_open_to_anon false, triggers 5, staff_rows_linked 0, till_rows_linked 0.
select
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and column_name = 'person_id' and table_name in ('wf_staff', 'staff_members')) as columns,
  has_column_privilege('authenticated', 'public.wf_staff', 'person_id', 'update') as api_writes_person_id,
  has_column_privilege('authenticated', 'public.wf_staff', 'name', 'update') as api_updates_name,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wf_staff_add_site', 'wf_staff_link', 'wf_staff_unlink')) as doors,
  (has_function_privilege('anon', 'public.wf_staff_add_site(uuid,uuid,text,numeric)', 'execute')
    or has_function_privilege('anon', 'public.wf_staff_link(uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.wf_staff_unlink(uuid)', 'execute')) as doors_open_to_anon,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in
    ('wf_staff_person_guard_trg', 'staff_members_person_guard_trg', 'wf_staff_person_sync_trg',
     'staff_members_person_pin_trg', 'staff_members_person_sync_trg')) as triggers,
  (select count(*)::int from public.wf_staff where person_id is not null) as staff_rows_linked,
  (select count(*)::int from public.staff_members where person_id is not null) as till_rows_linked;
