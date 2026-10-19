-- is_anon_session and is_super_admin: 20260805c_anon_fences.sql (verbatim)
create or replace function public.is_anon_session()
returns boolean
language sql
stable
as $fn$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean,
    false
  );
$fn$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select not public.is_anon_session()
     and coalesce((select role = 'super_admin' from public.user_profiles where id = auth.uid()), false);
$fn$;

-- user_accessible_locations: 20260921u_OPS_owner_holds_own_company.sql (verbatim)
create or replace function public.user_accessible_locations()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select ul.location_id::text
    from public.user_locations ul
   where ul.user_id = auth.uid()
     and not public.is_anon_session()
  union
  select l.id::text
    from public.locations l
   where public.is_super_admin()
  union
  -- NEW 21 Sep 2026: the owner of an organisation holds every venue in it the
  -- moment it is created. No link row, no hand holding, no silent refusal.
  select l.id::text
    from public.locations l
    join public.user_profiles p on p.id = auth.uid()
   where not public.is_anon_session()
     and p.role = 'owner'
     and p.org_id is not null
     and l.org_id = p.org_id;
$fn$;

-- accessible_location_ids and accessible_location_uuids: 20260927a_OPS_rls_set_form.sql (verbatim)
create or replace function public.accessible_location_ids()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select s.k
    from (
      select public.user_accessible_locations() as k
      union
      select d.location_id::text
        from public.devices d
       where d.device_uid = auth.uid()
         and d.bound_via is not null
         and d.status in ('active', 'online')
      union
      select o.location_id::text
        from public.ops_devices o
       where o.device_uid = auth.uid()
         and o.active
    ) s
   where s.k is not null;
$$;
comment on function public.accessible_location_ids() is 'Venues the caller may use, as text. Same set as pos_can_access(text) allows. For RLS: col in (select public.accessible_location_ids()). 20260927a.';

create or replace function public.accessible_location_uuids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select k::uuid
    from public.accessible_location_ids() as k
   where k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;
