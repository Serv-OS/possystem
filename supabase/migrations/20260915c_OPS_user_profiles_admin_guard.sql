-- 20260915c_OPS_user_profiles_admin_guard.sql  (Ops, tbetcegmszzotrwdtqhi)
--
-- WHY (15 Sep 2026, found while checking who can open the admin portal): the admin portal
-- (?mode=admin, src/admin/CompanyAdminApp.jsx) and several edge functions trust
-- user_profiles.role = 'super_admin'. Only peter@posup.co.uk has it. But the live rules let any
-- signed in, non anonymous user (every venue owner login):
--   * DELETE any user_profiles row ("Allow authenticated access" is FOR ALL, and the only
--     restrictive delete rule blocks anonymous sessions), including someone else's, and
--   * INSERT a user_profiles row with any role (the INSERT column grant includes role).
-- Delete your own row, insert it again with role 'super_admin', and you are a super admin.
-- Users could not UPDATE role (no column grant), which is why it looked safe.
-- 20260721c_rls_lock_user_identity.sql was meant to close this but never went live.
--
-- WHAT THIS DOES (small and targeted, reads are unchanged):
--   1. Creating or deleting a profile through the app's API needs a super admin. New sign ups
--      still get their profile: handle_new_user runs as postgres, which these rules do not apply
--      to, and edge functions use the service role, which they do not apply to either.
--   2. A guard trigger: through the API, only a super admin can create a profile with a role
--      other than 'owner', or change a role. Server side work (sign up, service role, this SQL
--      editor) is not affected.
--   3. TRUNCATE is taken away from anon and authenticated (never used; not reachable from the
--      API, removed for tidiness).
--   4. A self test that pretends to be a venue owner and checks the gap is closed, and pretends
--      to be the super admin and checks the admin portal still recognises you. Every probe runs
--      inside a block that is always rolled back, so it changes nothing.
--
-- Nothing in the app creates or deletes profiles from the browser except the admin portal's
-- delete organisation action, which a super admin runs (still allowed).

-- 1. Only a super admin may create or delete a profile through the API.
drop policy if exists up_insert_super_admin_only on public.user_profiles;
create policy up_insert_super_admin_only on public.user_profiles
  as restrictive for insert to public
  with check (public.is_super_admin());

drop policy if exists up_delete_super_admin_only on public.user_profiles;
create policy up_delete_super_admin_only on public.user_profiles
  as restrictive for delete to public
  using (public.is_super_admin());

-- 2. Role guard.
create or replace function public.user_profiles_role_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
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
$fn$;

drop trigger if exists user_profiles_role_guard on public.user_profiles;
create trigger user_profiles_role_guard
  before insert or update on public.user_profiles
  for each row execute function public.user_profiles_role_guard();

-- 3. Tidy grants.
revoke truncate on public.user_profiles from anon, authenticated;

-- 4. Self test. Results go into settings read by the final SELECT below.
do $probe$
declare
  v_owner uuid;
  v_admin uuid;
  v_rows int;
  v_flag text;
begin
  select p.id into v_owner
    from public.user_profiles p join auth.users u on u.id = p.id
   where p.role = 'owner' and not coalesce(u.is_anonymous, false)
   order by p.created_at limit 1;
  select id into v_admin from public.user_profiles where role = 'super_admin' order by created_at limit 1;

  -- a) A venue owner deletes their own profile: must remove nothing.
  v_flag := 'no owner login to test with';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    delete from public.user_profiles where id = v_owner;
    get diagnostics v_rows = row_count;
    v_flag := case when v_owner is null then 'no owner login to test with' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_owner_delete_own', v_flag, false);

  -- b) A venue owner deletes the super admin's profile: must remove nothing.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    delete from public.user_profiles where id = v_admin;
    get diagnostics v_rows = row_count;
    v_flag := case when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_owner_delete_admin', v_flag, false);

  -- c) A venue owner creates a super admin profile: the role guard must refuse it.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    insert into public.user_profiles (id, email, full_name, role) values (gen_random_uuid(), 'probe@example.invalid', 'probe', 'super_admin');
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%super admin%' or sqlerrm ilike '%row-level security%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_owner_insert_super_admin', v_flag, false);

  -- c2) A venue owner creates any profile at all: the new rule must refuse it.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    insert into public.user_profiles (id, email, full_name, role) values (gen_random_uuid(), 'probe@example.invalid', 'probe', 'owner');
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%row-level security%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_owner_insert_profile', v_flag, false);

  -- d) A venue owner can still change their own location (the app does this): must still work.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set location_id = location_id where id = v_owner;
    get diagnostics v_rows = row_count;
    v_flag := case when v_rows = 1 then 'still works' else 'BROKEN (' || v_rows || ' rows)' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_owner_update_location', v_flag, false);

  -- e) The super admin is still recognised (the admin portal and edge functions).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    v_flag := case when public.is_super_admin() then 'still works' else 'BROKEN' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.probe_admin_recognised', v_flag, false);
end
$probe$;

-- VISIBLE RESULT (the SQL editor shows this last result).
select
  current_setting('servos.probe_owner_delete_own', true)        as owner_deletes_own_profile,
  current_setting('servos.probe_owner_delete_admin', true)      as owner_deletes_your_profile,
  current_setting('servos.probe_owner_insert_super_admin', true) as owner_makes_self_super_admin,
  current_setting('servos.probe_owner_insert_profile', true)    as owner_creates_a_profile,
  current_setting('servos.probe_owner_update_location', true)   as owner_changes_location,
  current_setting('servos.probe_admin_recognised', true)        as you_are_still_super_admin,
  (select count(*) from public.user_profiles where role = 'super_admin') as super_admins,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_profiles'
     and policyname in ('up_insert_super_admin_only', 'up_delete_super_admin_only')) as new_rules;
