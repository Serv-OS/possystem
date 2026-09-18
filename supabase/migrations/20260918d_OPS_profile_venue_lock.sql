-- 20260918d_OPS_profile_venue_lock.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this in the SQL editor, OUTSIDE SERVICE. One transaction:     #
-- #  it either all lands or nothing changes. It waits at most 5 seconds for   #
-- #  a lock (lock_timeout); if a till holds one longer it stops with "lock    #
-- #  timeout" and changes nothing: just run it again.                         #
-- #  BEFORE running: run supabase/queries/profile_venue_backfill_candidates.sql #
-- #  and paste the user id(s) you confirm into v_confirmed in step 1 below.   #
-- #  Run 20260918e_OPS_venues_write_fence.sql straight after this one.        #
-- ############################################################################
--
-- (Renamed from 20260918c_OPS_profile_venue_lock.sql: main already has
-- 20260918c_OPS_sections_per_location.sql. Nothing of this file has ever run.)
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
--   0. set local lock_timeout = '5s'. is_super_admin() reads user_profiles inside the RLS of
--      almost every table, so an ACCESS EXCLUSIVE lock on user_profiles queued behind one long
--      transaction would freeze every till. Waiting at most 5 s, then giving up, cannot.
--   1. PINNED backfill. The hole is open until this runs, so "every login whose profile venue
--      has no link" can include someone who used the hole this morning; copying their profile
--      role (every email sign up is an owner) would make them a permanent owner of the victim
--      venue. Nothing records WHEN a profile venue was set (user_profiles.updated_at has no
--      trigger, and the hole lets a login write location_id without touching it), so no cut off
--      date can be trusted. Instead: only the user id(s) Peter pastes into v_confirmed are
--      linked. Any other candidate STOPS the migration (nothing changes) with a message listing
--      each one (email, id, venue, same company or not, sign up date). Super admins are never
--      candidates (they reach every venue through step 2, and Peter's profile venue is simply
--      the venue he last switched to).
--   2. user_accessible_locations() = user_locations, plus EVERY location for a verified super
--      admin (public.is_super_admin(), live, guarded by 20260915c; false for anonymous
--      sessions). Same signature (SETOF text), same LANGUAGE sql STABLE, same invoker security,
--      so every policy and pos_can_access(), ops_can_write(), waitlist_can_write(),
--      user_accessible_orgs() pick the super admin arm up with no other change: Peter keeps
--      reaching customer venues after the profile venue stops being access. Cost per call is
--      unchanged (one user_profiles primary key read replaces the old profile arm's one), and
--      is_super_admin() has no column reference, so Postgres runs it once per call as a one
--      time filter, not per location row.
--      user_profiles.location_id becomes what the app always used it for: the venue Back Office
--      opens on, never access.
--   3. user_profiles is row scoped: a login reads and updates only its own row (a super admin
--      reads all, for the admin portal, and may insert and delete, as today). EVERY other
--      permissive policy on the table is dropped: the historical names ("Allow authenticated
--      access", "allow all", "users read own profile", "users update own profile",
--      up_select_self, up_select_super_admin, up_update_self, up_update_super_admin,
--      user_profiles_super_admin_select_all) and any other permissive policy found live (the
--      result lists what was dropped). Restrictive policies (20260915c, up_no_anon_*) stay.
--      UPDATE on location_id, org_id and bo_access is revoked from authenticated and anon;
--      full_name stays. A guard trigger refuses a change to those three columns through the API
--      unless a super admin makes it. The server paths keep working: handle_new_user runs as
--      postgres; create-user, staff-portal and profile-admin use the service role.
--   4. user_locations: a guard trigger refuses a change of location_id or user_id on an
--      existing row through the API unless a super admin makes it.
--   5. Drops the stale set_bo_access(uuid, boolean) RPC (20260721c, if it exists): it gated on
--      the SAME ORG only (any owner of a company could flip any login of that company) and the
--      guard in step 3 makes it fail anyway. profile-admin set_bo_access replaces it.
--   6. A self test. Every probe runs inside a block that is always rolled back; if ANY probe is
--      not exactly as expected the whole migration RAISES and nothing is changed.
--
-- WHAT DEPENDS ON user_accessible_locations() (all keep working; they stop honouring a self
-- written profile venue and start honouring a verified super admin). From 000_baseline_ops.sql
-- and later migrations:
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
-- RULE: the SELECT policy of public.locations must never call user_accessible_locations()
-- (this invoker function reads locations for the super admin arm; that would recurse).
-- 20260918e keeps that read open, as it is today.
--
-- DEPLOY ORDER (lockdown step 1; the browser cannot reach a function that is not deployed:
-- the gateway's 404 has no CORS headers):
--   1. Ops 20260918_OPS_caller_authority_log.sql, if not run yet.
--   2. Ops THIS FILE, then 20260918e_OPS_venues_write_fence.sql, outside service.
--   3. Deploy every changed or importing edge function from main (30, Ops project,
--      --no-verify-jwt): profile-admin, create-user, workforce-compute, marketing-admin,
--      promo-redeem, stripe-webhook-connect, ryft-webhook, gift-bulk-create, gift-config,
--      gift-fulfill, gift-import, gift-issue, gift-list, gift-lookup, gift-purchase-status,
--      gift-redeem, gift-resend, gift-reverse-redeem, gift-void, loyalty-balance, loyalty-config,
--      loyalty-earn, loyalty-enroll, loyalty-member-lookup, loyalty-otp, loyalty-redeem,
--      loyalty-refund, loyalty-rewards, customer-import, loyalty-reconcile. Then subscribe the
--      Stripe Connect webhook endpoint to checkout.session.async_payment_succeeded.
--   4. Merge, so Vercel ships the app.
--   5. Platform 20260918_PLATFORM_gift_purchases_server_only.sql, then 20260918b (after the new
--      gift-resend and gift-list are live).
--
-- SCREENS THAT CHANGE (with the app code of the same branch):
--   * Back Office location switcher, Company Admin (create organisation / location), Staff
--     (team logins list and the Back Office access switch) and the admin portal's user to venue
--     links write through the profile-admin edge function instead of the table.
--   * Between this migration and the app deploy (step 2 to 4), those four writes fail with a
--     clear error (nothing is lost) and Staff shows linked team members without their email.

begin;

set local lock_timeout = '5s';

-- 0. Right database?
do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.user_profiles') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is for the OPS DB (tbetcegmszzotrwdtqhi). Wrong database, nothing changed.';
  end if;
end
$guard$;

-- 1. PINNED backfill. Only the login(s) Peter confirmed keep their profile venue as a link.
do $backfill$
declare
  -- PETER: paste the user id(s) you confirmed from
  -- supabase/queries/profile_venue_backfill_candidates.sql, for example
  --   v_confirmed uuid[] := array['0b1c2d3e-0000-4000-8000-000000000000']::uuid[];
  -- Leave it empty when that query returned no rows.
  v_confirmed uuid[] := array[]::uuid[];
  v_list  text;
  v_count int;
  v_bad   text;
begin
  create temp table _venue_link_candidates on commit drop as
  select p.id          as user_id,
         p.email       as email,
         p.role        as role,
         p.location_id as location_id,
         l.name        as venue,
         (p.org_id is not distinct from l.org_id) as same_company,
         u.created_at  as signed_up
    from public.user_profiles p
    join auth.users u on u.id = p.id
    join public.locations l on l.id = p.location_id
   where p.location_id is not null
     and not coalesce(u.is_anonymous, false)
     and coalesce(p.role, '') <> 'super_admin'
     and not exists (select 1 from public.user_locations ul
                      where ul.user_id = p.id and ul.location_id = p.location_id);

  -- A confirmed id that is not a candidate is a typo: stop.
  select string_agg(c::text, ', ') into v_bad
    from unnest(v_confirmed) c
   where not exists (select 1 from _venue_link_candidates k where k.user_id = c);
  if v_bad is not null then
    raise exception 'STOPPED, NOTHING CHANGED. These confirmed ids are not candidates (typo, or already linked): %', v_bad;
  end if;

  select count(*),
         string_agg(format('%s  id %s  venue "%s" (%s)  role %s  same company: %s  signed up %s',
                           coalesce(email, '(no email)'), user_id, venue, location_id, coalesce(role, '?'),
                           case when same_company then 'yes' else 'NO' end,
                           to_char(signed_up, 'YYYY-MM-DD')), ' | ')
    into v_count, v_list
    from _venue_link_candidates
   where not (user_id = any(v_confirmed));
  if v_count > 0 then
    raise exception 'STOPPED, NOTHING CHANGED. % login(s) have a profile venue but no venue link and are not confirmed: %. Check each one is a real member of that venue (not someone who used the hole), paste the id(s) you confirm into v_confirmed in step 1 and run again. Anyone you do not confirm simply loses the access their profile venue gave them.', v_count, v_list;
  end if;

  insert into public.user_locations (user_id, location_id, role)
  select k.user_id, k.location_id,
         case when k.role in ('owner', 'manager', 'staff', 'viewer') then k.role else 'manager' end
    from _venue_link_candidates k
   where k.user_id = any(v_confirmed)
  on conflict (user_id, location_id) do nothing;
  get diagnostics v_count = row_count;
  perform set_config('servos.backfilled', v_count::text, false);
end
$backfill$;

-- 2. Access is user_locations, plus every venue for a verified super admin.
create or replace function public.user_accessible_locations()
 returns setof text
 language sql
 stable
as $function$
  select ul.location_id::text from public.user_locations ul where ul.user_id = auth.uid()
  union
  select l.id::text from public.locations l where public.is_super_admin();
$function$;

comment on function public.user_accessible_locations() is
  '18 Sep 2026 (20260918d): user_locations, plus every location for a verified super admin (is_super_admin()). user_profiles.location_id is the venue Back Office opens on, never access. Mirrored by supabase/functions/_shared/staffAccess.ts. The locations SELECT policy must never call this function.';

-- 3. user_profiles: own row only (super admin reads all), venue columns server only.
drop policy if exists "Allow authenticated access" on public.user_profiles;
drop policy if exists "allow all" on public.user_profiles;
drop policy if exists "users read own profile" on public.user_profiles;
drop policy if exists "users update own profile" on public.user_profiles;
drop policy if exists up_select_self on public.user_profiles;
drop policy if exists up_select_super_admin on public.user_profiles;
drop policy if exists up_update_self on public.user_profiles;
drop policy if exists up_update_super_admin on public.user_profiles;
drop policy if exists user_profiles_super_admin_select_all on public.user_profiles;

-- Any OTHER permissive policy still live (pasted in the dashboard, or a name no migration
-- recorded) would widen what the four below allow. Drop it and say so in the result.
do $sweep$
declare
  r record;
  v_dropped text := '';
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'user_profiles' and permissive = 'PERMISSIVE'
       and policyname not in ('up_select_own_or_super_admin', 'up_update_own', 'up_insert_super_admin', 'up_delete_super_admin')
  loop
    execute format('drop policy %I on public.user_profiles', r.policyname);
    v_dropped := v_dropped || case when v_dropped = '' then '' else ', ' end || r.policyname;
  end loop;
  perform set_config('servos.up_swept', coalesce(nullif(v_dropped, ''), 'none'), false);
end
$sweep$;

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
-- TRUNCATE ignores RLS; the baseline granted it to authenticated. Nothing uses it.
revoke truncate on table public.user_profiles from anon, authenticated;

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

-- 5. The stale RPC (same org gate, and the guard above makes it fail). profile-admin replaces it.
drop function if exists public.set_bo_access(uuid, boolean);

-- 6. Self test. Every probe runs inside a block that is always rolled back. If any probe is
-- not exactly as expected, the migration raises and NOTHING above is kept.
do $probe$
declare
  v_owner     uuid;
  v_other     uuid;
  v_admin     uuid;
  v_loc       uuid;
  v_far       uuid;
  v_admin_far uuid;
  v_rows      int;
  v_flag      text;
  v_fail      text := '';
  v_all       int;
begin
  -- A real (non anonymous) owner who has a venue link, another login, the super admin, a venue
  -- that owner is NOT linked to, and a venue the super admin is NOT linked to.
  select p.id, ul.location_id into v_owner, v_loc
    from public.user_profiles p
    join auth.users u on u.id = p.id
    join public.user_locations ul on ul.user_id = p.id
   where p.role = 'owner' and not coalesce(u.is_anonymous, false)
   order by p.created_at limit 1;
  select p.id into v_other from public.user_profiles p where p.id is distinct from v_owner order by p.created_at limit 1;
  select p.id into v_admin
    from public.user_profiles p join auth.users u on u.id = p.id
   where p.role = 'super_admin' and not coalesce(u.is_anonymous, false)
   order by p.created_at limit 1;
  select l.id into v_far from public.locations l
   where not exists (select 1 from public.user_locations ul where ul.user_id = v_owner and ul.location_id = l.id)
   order by l.created_at limit 1;
  select l.id into v_admin_far from public.locations l
   where not exists (select 1 from public.user_locations ul where ul.user_id = v_admin and ul.location_id = l.id)
   order by l.created_at limit 1;
  select count(*) into v_all from public.user_profiles;

  -- a) The owner points their own profile at another venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set location_id = v_far where id = v_owner;
    if v_owner is null or v_far is null then v_flag := 'not tested (no owner or no other venue)'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%only the server%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_own_venue', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner sets own venue: ' || v_flag; end if;

  -- b) The owner edits ANOTHER login's profile: nothing matches.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set full_name = full_name where id = v_other;
    get diagnostics v_rows = row_count;
    v_flag := case when v_other is null or v_owner is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked'; end if;
  end;
  perform set_config('servos.p_other_row', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner edits another login: ' || v_flag; end if;

  -- c) The owner reads other logins' profiles: sees only their own.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.user_profiles;
    v_flag := case when v_owner is null then 'not tested' when v_rows = 1 then 'only their own' else 'SEES ' || v_rows || ' ROWS' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_read_others', v_flag, false);
  if v_flag <> 'only their own' then v_fail := v_fail || ' | owner reads profiles: ' || v_flag; end if;

  -- d) The owner can still rename themselves (Back Office account name).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_profiles set full_name = full_name where id = v_owner;
    get diagnostics v_rows = row_count;
    v_flag := case when v_owner is null then 'not tested' when v_rows = 1 then 'still works' else 'BROKEN (' || v_rows || ' rows)' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_own_name', v_flag, false);
  if v_flag <> 'still works' then v_fail := v_fail || ' | owner renames self: ' || v_flag; end if;

  -- e) The owner moves their own venue link to another venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.user_locations set location_id = v_far where user_id = v_owner and location_id = v_loc;
    if v_owner is null or v_far is null then v_flag := 'not tested (no owner or no other venue)'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%cannot be moved%' or sqlerrm ilike '%permission denied%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_move_link', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner moves venue link: ' || v_flag; end if;

  -- f) The owner still reaches their own venue, and not the other one.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    v_flag := case
      when v_owner is null or v_far is null then 'not tested'
      when public.pos_can_access(v_loc) and not public.pos_can_access(v_far)
       and v_loc::text in (select public.user_accessible_locations())
       and v_far::text not in (select public.user_accessible_locations()) then 'own venue only'
      when not public.pos_can_access(v_loc) then 'BROKEN: lost own venue'
      else 'BROKEN: reaches another venue' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_access', v_flag, false);
  if v_flag <> 'own venue only' then v_fail := v_fail || ' | owner access: ' || v_flag; end if;

  -- g) The super admin still sees every profile (admin portal).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.user_profiles;
    v_flag := case when v_admin is null then 'not tested' when v_rows = v_all then 'sees all' else 'BROKEN (' || v_rows || ' of ' || v_all || ')' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_admin_reads', v_flag, false);
  if v_flag <> 'sees all' then v_fail := v_fail || ' | super admin reads profiles: ' || v_flag; end if;

  -- h) The super admin reaches a venue he is NOT linked to (Back Office switcher, Staff,
  --    workforce, stock...): pos_can_access, ops_can_write, user_accessible_locations and
  --    user_accessible_orgs all say yes, and he reads that venue's staff.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    v_flag := case
      when v_admin is null or v_admin_far is null then 'not tested'
      when public.pos_can_access(v_admin_far)
       and public.pos_can_access(v_admin_far::text)
       and public.ops_can_write(v_admin_far)
       and v_admin_far::text in (select public.user_accessible_locations())
       and (select count(*) from public.locations) = (select count(*) from public.user_accessible_locations())
       then 'reaches every venue'
      else 'BROKEN: super admin locked out' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_admin_far', v_flag, false);
  if v_flag <> 'reaches every venue' then v_fail := v_fail || ' | super admin at an unlinked venue: ' || v_flag; end if;

  -- i) An anonymous session (kiosk, online checkout) reaches nothing and is never super admin.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'is_anonymous', true)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.user_accessible_locations();
    v_flag := case when v_rows = 0 and not public.is_super_admin() then 'nothing' else 'REACHES ' || v_rows || ' VENUES' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.p_anon', v_flag, false);
  if v_flag <> 'nothing' then v_fail := v_fail || ' | anonymous session: ' || v_flag; end if;

  -- j) Structure: only the four permissive policies, both guards, no browser column grant, the
  --    stale RPC gone, no login left with a profile venue and no link (outside super admins).
  select count(*) into v_rows from pg_policies
   where schemaname = 'public' and tablename = 'user_profiles' and permissive = 'PERMISSIVE'
     and policyname not in ('up_select_own_or_super_admin', 'up_update_own', 'up_insert_super_admin', 'up_delete_super_admin');
  if v_rows <> 0 then v_fail := v_fail || ' | other permissive policies left: ' || v_rows; end if;
  select count(*) into v_rows from pg_trigger
   where tgname in ('user_profiles_venue_guard', 'user_locations_venue_guard') and not tgisinternal;
  if v_rows <> 2 then v_fail := v_fail || ' | guard triggers: ' || v_rows; end if;
  select count(*) into v_rows from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'user_profiles' and grantee in ('anon', 'authenticated')
     and privilege_type = 'UPDATE' and column_name in ('location_id', 'org_id', 'bo_access');
  if v_rows <> 0 then v_fail := v_fail || ' | venue column grants left: ' || v_rows; end if;
  if to_regprocedure('public.set_bo_access(uuid, boolean)') is not null then
    v_fail := v_fail || ' | set_bo_access still exists';
  end if;

  if v_fail <> '' then
    raise exception 'SELF TEST FAILED, NOTHING WAS CHANGED:%', v_fail;
  end if;
end
$probe$;

commit;

-- VISIBLE RESULT (read only; the SQL editor shows this last result). Expect: backfilled = the
-- number of ids you confirmed, then blocked, blocked, only their own, still works, blocked,
-- own venue only, sees all, reaches every venue, nothing, and 0 logins left with a venue but no
-- link. swept_policies lists any unrecorded permissive policy that was dropped (usually none).
select
  current_setting('servos.backfilled', true)    as backfilled,
  current_setting('servos.p_own_venue', true)   as owner_sets_own_venue,
  current_setting('servos.p_other_row', true)   as owner_edits_another_login,
  current_setting('servos.p_read_others', true) as owner_reads_profiles,
  current_setting('servos.p_own_name', true)    as owner_renames_self,
  current_setting('servos.p_move_link', true)   as owner_moves_venue_link,
  current_setting('servos.p_access', true)      as owner_access,
  current_setting('servos.p_admin_reads', true) as you_read_all_profiles,
  current_setting('servos.p_admin_far', true)   as you_at_an_unlinked_venue,
  current_setting('servos.p_anon', true)        as anonymous_session,
  current_setting('servos.up_swept', true)      as swept_policies,
  (select count(*) from public.user_profiles p join auth.users u on u.id = p.id
    where p.location_id is not null and not coalesce(u.is_anonymous, false) and coalesce(p.role, '') <> 'super_admin'
      and not exists (select 1 from public.user_locations ul where ul.user_id = p.id and ul.location_id = p.location_id))
                                                as logins_with_venue_but_no_link;
