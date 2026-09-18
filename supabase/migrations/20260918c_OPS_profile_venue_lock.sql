-- 20260918c_OPS_profile_venue_lock.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this in the SQL editor. Idempotent, no transaction wrapper.   #
-- #  Safe before OR after the code of branch fix/loyalty-giftcard-exposure.   #
-- #  Best run outside service (a few seconds, takes brief locks on           #
-- #  user_profiles and user_locations).                                      #
-- ############################################################################
--
-- WHY (18 Sep 2026, lockdown step 1). Any signed in, non anonymous login could make itself
-- staff of ANY venue:
--   * user_profiles has the permissive policy "Allow authenticated access" FOR ALL
--     USING (auth.role() = 'authenticated') with no WITH CHECK, so it is not row scoped, and
--     authenticated holds UPDATE on org_id, location_id, full_name and bo_access;
--   * public.user_accessible_locations() returns user_locations UNION user_profiles.location_id;
--   * so "update user_profiles set location_id = <any venue> where id = <me>" (or any other
--     row) grants RLS access to that venue through pos_can_access() and every policy below.
--   * org_id is just as bad: can_claim_location() trusts user_profiles.org_id, so a self set
--     org_id let a login claim any unclaimed venue of any company.
--   * the same hole exists one table over: ul_update_self lets a user UPDATE its own
--     user_locations row with no column limit, so it could move that row's location_id to any
--     venue. The role column was pinned by 20260806f; location_id and user_id were not.
-- Live facts checked 18 Sep (read only): of 13 real logins, 11 have user_profiles.location_id
-- and exactly 1 has it with NO matching user_locations row. No anonymous user has one.
--
-- WHAT THIS DOES
--   1. Backfill: every non anonymous user whose user_profiles.location_id has no user_locations
--      row gets one (role from the profile when it is a venue role, else 'manager'), so the one
--      legacy owner keeps exactly the access they have today.
--   2. user_accessible_locations() reads user_locations ONLY. Same signature (SETOF text), same
--      LANGUAGE sql STABLE, same invoker security. user_profiles.location_id becomes what the
--      app always used it for: the venue Back Office opens on, never access.
--   3. user_profiles is row scoped: a login reads and updates only its own row (a super admin
--      reads all, for the admin portal, and may delete, as today). UPDATE on location_id,
--      org_id and bo_access is revoked from authenticated; full_name stays. A guard trigger
--      refuses a change to those three columns through the API unless a super admin makes it,
--      in case a grant ever comes back. The server paths keep working: handle_new_user runs as
--      postgres; create-user, staff-portal and the new profile-admin function use the service
--      role, which these rules and the trigger do not apply to.
--   4. user_locations: a guard trigger refuses a change of location_id or user_id on an
--      existing row through the API unless a super admin makes it. Inserting a row is unchanged
--      (still fenced by ul_insert_self_claim + can_claim_location, which now reads a locked
--      org_id). An upsert that rewrites the same values still works.
--   5. A self test, always rolled back, and a one row result.
--
-- WHAT DEPENDS ON user_accessible_locations() (all keep working; they simply stop honouring a
-- self written profile venue). Read from 000_baseline_ops.sql and later migrations:
--   Functions: pos_can_access(text), pos_can_access(uuid), ops_can_write(uuid),
--     waitlist_can_write(uuid), user_accessible_orgs(), claim_ops_device(text),
--     claim_waitlist_device(text), xero_nightly_post(), and the RPCs in
--     20260907b_ops_rls_1_fences_and_rpcs.sql, 20260907b_ops_rls_2_pairing.sql,
--     20260911_OPS_order_status_displays.sql, 20260914_OPS_category_photos.sql.
--   Policies calling it directly: catering_site_settings, corrective_actions,
--     customer_consents, inventory_item_conversions, inventory_items, item_cost_history,
--     item_packaging_formats, maintenance_notes, maintenance_status_history, menu_item_recipes,
--     ops_alerts, ops_checklist_tasks, ops_checklists, ops_devices, ops_notification_rules,
--     par_levels, po_lines, prep_schedule, production_batches, purchase_orders, recipe_lines,
--     recipes, review_feedback, review_platform_links, review_replies, review_requests,
--     review_settings, review_themes, stock_count_lines, stock_counts, stock_movements,
--     subscriptions, supplier_invoice_lines, supplier_invoices, supplier_products, suppliers,
--     temp_check_schedules, temp_readings, temp_units, waitlist_devices, waste_events,
--     every wf_* table (announcements, audit, availability, doc_templates, documents,
--     holiday_accrual, onboarding, payroll_runs, rate_changes, roles, sales_forecast,
--     sections, shifts, swap_requests, time_off, timesheets, tronc_lines, tronc_runs,
--     user_roles, venue_settings), wifi_captures, wifi_portal_settings, workflows.
--   Through pos_can_access(): bar_tabs, cash_drawers, cash_movements, challenge_21_checks,
--     closed_checks, device_heartbeats, drawer_sessions, floor_tables, inventory_item_conversions,
--     inventory_items, item_packaging_formats, location_features, loyalty_transactions,
--     menu_item_recipes, menu_items, modifier_groups, pos_nudges, prep_schedule,
--     production_batches, recipe_lines, recipes, sections, shifts, staff_auth_events,
--     staff_members, supplier_products, waste_events, workflows.
--   Through ops_can_write(): deliveries, maintenance_requests, ops_alerts, ops_audit,
--     ops_checklist_runs, ops_checklist_tasks, ops_checklists, ops_task_completions, prep_log,
--     temp_check_schedules, temp_readings, temp_units, workflows.
--   Through waitlist_can_write(): quote_accuracy, turn_time_stats, waitlist_config,
--     waitlist_entries, waitlist_sms_inbound, waitlist_status_events, workflows.
--   Through user_accessible_orgs(): campaign_runs, campaign_sends, campaigns,
--     marketing_messages, marketing_suppressions, offers, org_sending_domains, promo_codes,
--     promo_redemptions, segments, wf_staff, workflow_enrollments, workflow_step_sends, workflows.
--
-- SCREENS THAT CHANGE (with the app code of the same branch):
--   * Back Office location switcher, Company Admin (create organisation / location), Staff
--     (team logins list and the Back Office access switch) and the admin portal's user to venue
--     links write through the profile-admin edge function instead of the table.
--   * Before that code is live, those four writes fail with a clear error (nothing is lost) and
--     Staff shows linked team members without their email until the new code is live.

-- 0. Right database?
do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.user_profiles') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is for the OPS DB (tbetcegmszzotrwdtqhi). Wrong database, nothing changed.';
  end if;
end
$guard$;

-- 1. Backfill: nobody loses the access they have today.
insert into public.user_locations (user_id, location_id, role)
select p.id,
       p.location_id,
       case when p.role in ('owner', 'manager', 'staff', 'viewer') then p.role else 'manager' end
  from public.user_profiles p
  join auth.users u on u.id = p.id
  join public.locations l on l.id = p.location_id
 where p.location_id is not null
   and not coalesce(u.is_anonymous, false)
   and not exists (select 1 from public.user_locations ul
                    where ul.user_id = p.id and ul.location_id = p.location_id)
on conflict (user_id, location_id) do nothing;

-- 2. Access is user_locations only.
create or replace function public.user_accessible_locations()
 returns setof text
 language sql
 stable
as $function$
  select location_id::text from public.user_locations where user_id = auth.uid();
$function$;

comment on function public.user_accessible_locations() is
  '18 Sep 2026 (20260918c): user_locations only. user_profiles.location_id is the venue Back Office opens on, never access. Mirrored by supabase/functions/_shared/staffAccess.ts.';

-- 3. user_profiles: own row only (super admin reads all), venue columns server only.
drop policy if exists "Allow authenticated access" on public.user_profiles;

drop policy if exists up_select_own_or_super_admin on public.user_profiles;
create policy up_select_own_or_super_admin on public.user_profiles
  as permissive for select to public
  using (id = auth.uid() or public.is_super_admin());

drop policy if exists up_update_own on public.user_profiles;
create policy up_update_own on public.user_profiles
  as permissive for update to public
  using (id = auth.uid())
  with check (id = auth.uid());

-- Inserting and deleting stay super admin only (20260915c's restrictive rules still apply);
-- these permissive twins keep the admin portal's "delete organisation" working now that the
-- blanket policy is gone.
drop policy if exists up_insert_super_admin on public.user_profiles;
create policy up_insert_super_admin on public.user_profiles
  as permissive for insert to public
  with check (public.is_super_admin());

drop policy if exists up_delete_super_admin on public.user_profiles;
create policy up_delete_super_admin on public.user_profiles
  as permissive for delete to public
  using (public.is_super_admin());

revoke update (location_id, org_id, bo_access) on table public.user_profiles from authenticated;
revoke update (location_id, org_id, bo_access) on table public.user_profiles from anon;

create or replace function public.user_profiles_venue_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  -- Only requests made with a user's session through the API are checked. The service role
  -- (edge functions), postgres (handle_new_user, this editor) pass.
  if v_jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.location_id is distinct from old.location_id
      or new.org_id is distinct from old.org_id
      or new.bo_access is distinct from old.bo_access)
     and not public.is_super_admin() then
    raise exception 'Only the server can change a login''s venue, company or Back Office access'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists user_profiles_venue_guard on public.user_profiles;
create trigger user_profiles_venue_guard
  before update on public.user_profiles
  for each row execute function public.user_profiles_venue_guard();

-- 4. user_locations: a row can never be moved to another venue or user from the browser.
create or replace function public.user_locations_venue_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if (new.location_id is distinct from old.location_id or new.user_id is distinct from old.user_id)
     and not public.is_super_admin() then
    raise exception 'A venue link cannot be moved; ask the venue owner to add you'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists user_locations_venue_guard on public.user_locations;
create trigger user_locations_venue_guard
  before update on public.user_locations
  for each row execute function public.user_locations_venue_guard();

-- 5. Self test. Every probe runs inside a block that is always rolled back.
do $probe$
declare
  v_owner uuid;
  v_other uuid;
  v_admin uuid;
  v_loc   uuid;
  v_far   uuid;
  v_rows  int;
  v_flag  text;
begin
  -- A real (non anonymous) owner who has a venue link, another login, the super admin, and a
  -- venue that owner is NOT linked to.
  select p.id, ul.location_id into v_owner, v_loc
    from public.user_profiles p
    join auth.users u on u.id = p.id
    join public.user_locations ul on ul.user_id = p.id
   where p.role = 'owner' and not coalesce(u.is_anonymous, false)
   order by p.created_at limit 1;
  select p.id into v_other from public.user_profiles p where p.id is distinct from v_owner order by p.created_at limit 1;
  select id into v_admin from public.user_profiles where role = 'super_admin' order by created_at limit 1;
  select l.id into v_far from public.locations l
   where not exists (select 1 from public.user_locations ul where ul.user_id = v_owner and ul.location_id = l.id)
   limit 1;

  -- a) The owner points their own profile at another venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set location_id = v_far where id = v_owner;
    get diagnostics v_rows = row_count;
    if v_owner is null or v_far is null then v_flag := 'not tested (no owner or no other venue)'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%only the server%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_own_venue', v_flag, false);

  -- b) The owner points ANOTHER login's profile at a venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set full_name = full_name where id = v_other;
    get diagnostics v_rows = row_count;
    v_flag := case when v_other is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_other_row', v_flag, false);

  -- c) The owner reads other logins' profiles: sees only their own.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.user_profiles;
    v_flag := case when v_rows = 1 then 'only their own' else 'SEES ' || v_rows || ' ROWS' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_read_others', v_flag, false);

  -- d) The owner can still rename themselves (Back Office account name).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set full_name = full_name where id = v_owner;
    get diagnostics v_rows = row_count;
    v_flag := case when v_rows = 1 then 'still works' else 'BROKEN (' || v_rows || ' rows)' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_own_name', v_flag, false);

  -- e) The owner moves their own venue link to another venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_locations set location_id = v_far where user_id = v_owner and location_id = v_loc;
    get diagnostics v_rows = row_count;
    if v_owner is null or v_far is null then v_flag := 'not tested (no owner or no other venue)'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%cannot be moved%' or sqlerrm ilike '%permission denied%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_move_link', v_flag, false);

  -- f) The owner still reaches their own venue, and not the other one.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    v_flag := case
      when v_owner is null then 'not tested'
      when public.pos_can_access(v_loc) and (v_far is null or not public.pos_can_access(v_far)) then 'own venue only'
      when not public.pos_can_access(v_loc) then 'BROKEN: lost own venue'
      else 'BROKEN: reaches another venue' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_access', v_flag, false);

  -- g) The super admin still sees every profile (admin portal).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.user_profiles;
    v_flag := case when v_admin is null then 'not tested' when v_rows > 1 then 'still sees all (' || v_rows || ')' else 'BROKEN (' || v_rows || ')' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_admin_reads', v_flag, false);
end
$probe$;

-- VISIBLE RESULT (the SQL editor shows this last result). Expect: blocked, blocked,
-- only their own, still works, blocked, own venue only, still sees all (N), 0, 0, 2, 0.
select
  current_setting('servos.p_own_venue', true)   as owner_sets_own_venue,
  current_setting('servos.p_other_row', true)   as owner_edits_another_login,
  current_setting('servos.p_read_others', true) as owner_reads_profiles,
  current_setting('servos.p_own_name', true)    as owner_renames_self,
  current_setting('servos.p_move_link', true)   as owner_moves_venue_link,
  current_setting('servos.p_access', true)      as owner_access,
  current_setting('servos.p_admin_reads', true) as you_read_all_profiles,
  (select count(*) from public.user_profiles p join auth.users u on u.id = p.id
    where p.location_id is not null and not coalesce(u.is_anonymous, false)
      and not exists (select 1 from public.user_locations ul where ul.user_id = p.id and ul.location_id = p.location_id))
                                                as logins_with_venue_but_no_link,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_profiles'
     and policyname = 'Allow authenticated access')                           as blanket_policy_left,
  (select count(*) from pg_trigger where tgname in ('user_profiles_venue_guard', 'user_locations_venue_guard')
     and not tgisinternal)                                                     as guard_triggers,
  (select count(*) from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'user_profiles' and grantee in ('anon', 'authenticated')
      and privilege_type = 'UPDATE' and column_name in ('location_id', 'org_id', 'bo_access')) as venue_update_grants_left;
