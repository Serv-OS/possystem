-- 20261111a_OPS_wf_people_across_sites_ROLLBACK.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi) ONLY to undo 20261111a. Release 5.12.36.
--
-- Takes away the links between one person's records at several sites: the person_id columns on
-- wf_staff and staff_members, the three doors (wf_staff_add_site, wf_staff_link, wf_staff_unlink),
-- the sync and PIN check triggers, and puts wf_staff_regrant_api and wf_staff_identity_guard back
-- as 20261104a left them. Records and till users made by "Also works at" STAY (each is a normal
-- record at its site); only the link between them goes, so payroll counts each site alone again and
-- a PIN change no longer copies across. wf_audit rows stay.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wf_staff' and column_name = 'person_id') then
    raise exception '20261111a has not run (or was rolled back already). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop trigger if exists staff_members_person_sync_trg on public.staff_members;
drop trigger if exists staff_members_person_pin_trg on public.staff_members;
drop trigger if exists staff_members_person_guard_trg on public.staff_members;
drop trigger if exists wf_staff_person_sync_trg on public.wf_staff;
drop trigger if exists wf_staff_person_guard_trg on public.wf_staff;

drop function if exists public.wf_people_sync_till();
drop function if exists public.wf_people_till_pin_check();
drop function if exists public.wf_people_sync_staff();
drop function if exists public.wf_staff_unlink(uuid);
drop function if exists public.wf_staff_link(uuid, uuid);
drop function if exists public.wf_staff_add_site(uuid, uuid, text, numeric);
drop function if exists public.wf_people_audit(uuid, uuid, text, uuid, jsonb, jsonb);
drop function if exists public.wf_people_pin_clash(uuid, uuid, text, uuid[], uuid);
drop function if exists public.wf_people_assert_access(uuid, uuid[]);
drop function if exists public.wf_people_link_guard();

drop index if exists public.idx_staff_members_person;
drop index if exists public.idx_wf_staff_person;
alter table public.staff_members drop column if exists person_id;
alter table public.wf_staff drop column if exists person_id;

-- 20261104a's guard and regrant helper, as they were.
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
  if v_ctx ~ 'function (public\.)?wf_staff_set_pos_user\(uuid,uuid,text\)' then
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
     and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_api() from public, anon, authenticated, service_role;
comment on function public.wf_staff_regrant_api() is
  'Grants INSERT and UPDATE on every wf_staff column except portal_user_id, pos_user_id, portal_invite_hash and portal_invite_expires to authenticated. Call it after adding a wf_staff column. 20261104a.';

revoke insert, update on table public.wf_staff from authenticated;
select public.wf_staff_regrant_api() as columns_granted;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: columns 0, doors 0, triggers 0, api_updates_name true.
select
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and column_name = 'person_id' and table_name in ('wf_staff', 'staff_members')) as columns,
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wf_staff_add_site', 'wf_staff_link', 'wf_staff_unlink')) as doors,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in
    ('wf_staff_person_guard_trg', 'staff_members_person_guard_trg', 'wf_staff_person_sync_trg',
     'staff_members_person_pin_trg', 'staff_members_person_sync_trg')) as triggers,
  has_column_privilege('authenticated', 'public.wf_staff', 'name', 'update') as api_updates_name;
