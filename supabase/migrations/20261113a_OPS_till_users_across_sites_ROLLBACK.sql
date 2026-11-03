-- 20261113a_OPS_till_users_across_sites_ROLLBACK.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi) ONLY to undo 20261113a. Release 5.12.39.
-- Takes away the Team doors and the inherit trigger and puts the person_id guard back as 20261111a
-- left it. Till users already linked STAY linked (Workforce, Staff, Sites can still unlink them).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_till_add_site(uuid,uuid)') is null then
    raise exception '20261113a has not run (or was rolled back already). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop trigger if exists wf_staff_zz_person_inherit_trg on public.wf_staff;
drop function if exists public.wf_people_inherit_from_till();
drop function if exists public.wf_till_unlink(uuid);
drop function if exists public.wf_till_link(uuid, uuid);
drop function if exists public.wf_till_add_site(uuid, uuid);
drop function if exists public._wf_staff_of_till(uuid);

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
  if v_ctx ~ 'function (public\.)?wf_staff_(add_site|link|unlink)\(' then
    return new;
  end if;
  raise exception 'Link a person to another site from Workforce, Staff, Sites (person_id is not written directly)'
    using errcode = '42501';
end
$f$;
revoke all on function public.wf_people_link_guard() from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: doors 0, inherit false.
select
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wf_till_add_site', 'wf_till_link', 'wf_till_unlink')) as doors,
  exists (select 1 from pg_trigger where tgname = 'wf_staff_zz_person_inherit_trg') as inherit;
