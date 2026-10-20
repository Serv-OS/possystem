-- helpers_20oct.sql: live function texts the Drop 0 proof needs that no file in this repo
-- defines in their live form (pg_get_functiondef, read only, Ops, 20 Oct 2026), with their live
-- ACLs. Loaded by run.mjs and rehearse.mjs after ../../stock_function_fences/live/helpers.sql and
-- before the real migrations. The user_profiles triggers are created here as live has them (the
-- fence guard trigger after 20260921u, by run.mjs, because that file defines its function).

-- _fence_num (live)
CREATE OR REPLACE FUNCTION public._fence_num(p text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select case when p ~ '^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$' then trim(p)::numeric else 0 end;
$function$;
revoke all on function public._fence_num(text) from public, anon, authenticated;
grant execute on function public._fence_num(text) to service_role;

-- _fence_num_or_null (live)
CREATE OR REPLACE FUNCTION public._fence_num_or_null(p text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select case when p ~ '^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$' then trim(p)::numeric end;
$function$;
revoke all on function public._fence_num_or_null(text) from public, anon, authenticated;
grant execute on function public._fence_num_or_null(text) to service_role;

-- _fence_bypass (live)
CREATE OR REPLACE FUNCTION public._fence_bypass()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select coalesce(current_setting('servos.fence_bypass', true), '') = 'on';
$function$;
revoke all on function public._fence_bypass() from public, anon, authenticated;
grant execute on function public._fence_bypass() to service_role;

-- _fence_api_role (live)
CREATE OR REPLACE FUNCTION public._fence_api_role()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
$function$;
revoke all on function public._fence_api_role() from public, anon, authenticated;
grant execute on function public._fence_api_role() to service_role;

-- _org_created_by_me (live)
CREATE OR REPLACE FUNCTION public._org_created_by_me(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select auth.uid() is not null
     and not public.is_anon_session()
     and exists (select 1 from public.organisations o where o.id = p_org and o.created_by = auth.uid());
$function$;
revoke all on function public._org_created_by_me(uuid) from public;
grant execute on function public._org_created_by_me(uuid) to anon, authenticated, service_role;

-- user_accessible_orgs (live)
CREATE OR REPLACE FUNCTION public.user_accessible_orgs()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select distinct l.org_id::text
    from public.locations l
   where l.org_id is not null
     and l.id::text in (select public.user_accessible_locations());
$function$;
revoke all on function public.user_accessible_orgs() from public;
grant execute on function public.user_accessible_orgs() to anon, authenticated, service_role;

-- user_profiles_role_guard (live)
CREATE OR REPLACE FUNCTION public.user_profiles_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  -- Only requests made with a user's session through the API are checked.
  if v_jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.role is distinct from 'owner' and not public.is_super_admin() then
      raise exception 'Only a super admin can give a profile this role' using errcode = '42501';
    end if;
  elsif new.role is distinct from old.role and not public.is_super_admin() then
    raise exception 'Only a super admin can change a profile role' using errcode = '42501';
  end if;
  return new;
end;
$function$;
grant execute on function public.user_profiles_role_guard() to public, anon, authenticated, service_role;

-- user_profiles_bo_sections_guard (live)
CREATE OR REPLACE FUNCTION public.user_profiles_bo_sections_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_api_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_me_role     text;
  v_me_sections text[];
begin
  -- Only requests made with a person's (or the public) key through the API are checked.
  if v_api_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.bo_sections is not null then
      raise exception 'A new login starts with everything. Limit it in Back Office, Team.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.bo_sections is distinct from old.bo_sections
     and coalesce(current_setting('servos.bo_sections_write', true), '') <> 'on' then
    raise exception 'What a login can open is changed by the owner, in Back Office, Team.' using errcode = '42501';
  end if;
  -- Switching ON (off to on; a null bo_access counts as on, so it is never "switching on").
  if old.bo_access is false and new.bo_access is distinct from false then
    -- The person asking, from their own row (which they can always read). No row = nothing known
    -- about them, which is treated as a limited person who opens nothing (fail closed).
    select p.role, p.bo_sections into v_me_role, v_me_sections
      from public.user_profiles p where p.id = auth.uid();
    if not found then
      v_me_role := null;
      v_me_sections := '{}'::text[];
    end if;
    if lower(coalesce(v_me_role, '')) not in ('owner', 'super_admin')
       and v_me_sections is not null
       and (new.bo_sections is null or not (new.bo_sections <@ v_me_sections)) then
      raise exception 'Only the owner can switch this login on.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.user_profiles_bo_sections_guard() from public, anon, authenticated;
grant execute on function public.user_profiles_bo_sections_guard() to service_role;

-- set_bo_sections (live)
CREATE OR REPLACE FUNCTION public.set_bo_sections(p_user uuid, p_sections text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid       uuid := auth.uid();
  v_keys      constant text[] := array['overview', 'menu', 'floorplan', 'inventory', 'produce', 'purchasing', 'operations', 'team', 'workforce', 'customers', 'channels', 'hardware', 'reports', 'card-payments', 'settings'];
  v_super     boolean;
  v_me_role   text;
  v_me_org    uuid;
  v_role      text;
  v_org       uuid;
  v_clean     text[];
  v_bad       text;
  v_rows      integer;
begin
  -- Somebody real, signed in. A device or a visitor (anonymous session) is never an owner.
  if v_uid is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to change what a login can open.' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'Pick a login first.' using errcode = '22023';
  end if;
  -- Nobody changes their own, ServOS staff included.
  if p_user = v_uid then
    raise exception 'You cannot change what your own login can open.' using errcode = '42501';
  end if;

  v_super := public.is_super_admin();
  select p.role, p.org_id into v_me_role, v_me_org from public.user_profiles p where p.id = v_uid;
  if not v_super and (v_me_role is distinct from 'owner' or v_me_org is null) then
    raise exception 'Only the owner can change what a login can open.' using errcode = '42501';
  end if;

  -- The login being changed, held so two people saving at once cannot cross.
  select p.role, p.org_id into v_role, v_org from public.user_profiles p where p.id = p_user for update;
  -- One answer for "no such login" and "not your company", so nobody can probe for ids.
  if not found or (not v_super and v_org is distinct from v_me_org) then
    raise exception 'That login is not in your company.' using errcode = '42501';
  end if;
  if lower(coalesce(v_role, '')) in ('owner', 'super_admin') then
    raise exception 'An owner always opens everything. It cannot be limited.' using errcode = '42501';
  end if;

  -- Null = everything. A list is checked key by key, then kept in sidebar order with no repeats.
  if p_sections is null then
    v_clean := null;
  else
    if coalesce(array_ndims(p_sections), 1) <> 1 then
      raise exception 'The list of sections is not a plain list.' using errcode = '22023';
    end if;
    select s.k into v_bad from unnest(p_sections) as s(k) where s.k is null or s.k <> all (v_keys) limit 1;
    if found then
      raise exception 'Unknown part of Back Office: %', coalesce(v_bad, '(empty)') using errcode = '22023';
    end if;
    select coalesce(array_agg(k.key order by k.ord), '{}'::text[]) into v_clean
      from unnest(v_keys) with ordinality as k(key, ord)
     where k.key = any (p_sections);
  end if;

  -- The pass for the guard above, for this one statement, then shut again. It lasts for this
  -- request at most, and if the update fails the whole request is undone, the pass with it.
  perform set_config('servos.bo_sections_write', 'on', true);
  update public.user_profiles set bo_sections = v_clean where id = p_user;
  get diagnostics v_rows = row_count;
  perform set_config('servos.bo_sections_write', 'off', true);
  -- Never report a change that did not land (a rule on the table filtering this update away).
  if v_rows <> 1 then
    raise exception 'Not saved. Nothing was changed.' using errcode = '42501';
  end if;

  return jsonb_build_object('ok', true, 'sections', to_jsonb(v_clean));
end;
$function$;
revoke all on function public.set_bo_sections(uuid, text[]) from public, anon, service_role;
grant execute on function public.set_bo_sections(uuid, text[]) to authenticated;

-- the two user_profiles triggers live has besides the fence guard
create trigger user_profiles_role_guard before insert or update on public.user_profiles
  for each row execute function public.user_profiles_role_guard();
create trigger user_profiles_bo_sections_guard before insert or update on public.user_profiles
  for each row execute function public.user_profiles_bo_sections_guard();
