-- 20260918e_OPS_venues_write_fence.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this in the SQL editor, OUTSIDE SERVICE, straight after       #
-- #  20260918d_OPS_profile_venue_lock.sql (it refuses to run before it).      #
-- #  One transaction: it either all lands or nothing changes. It waits at     #
-- #  most 5 seconds for a lock; "lock timeout" means run it again.           #
-- ############################################################################
--
-- WHY (18 Sep 2026, lockdown step 1, review round four item 2). The Ops venues table is world
-- writable: public.locations has the policy "allow all" FOR ALL TO public USING (true) WITH
-- CHECK (true) (000_baseline_ops.sql, around line 9464; its drop in 20260907b C9 is a DRAFT
-- that never ran). So the public anon key, with no login at all, can rename any venue, change
-- its settings, and change its org_id. The new org checks trust org_id: promo-redeem
-- orgForLocation, marketing-admin orgFor, and user_accessible_orgs() behind the policies of
-- promo_codes, offers, campaigns, wf_staff and the rest; moving a venue into your own org hands
-- you its promo codes, offers and staff files. Two more permissive policies sit alongside:
--   * "Allow authenticated access" FOR ALL USING (auth.role() = 'authenticated'), which every
--     anonymous kiosk or online checkout session satisfies;
--   * "Users can update own location settings" (around line 9452), which trusts
--     user_profiles.location_id, the self written profile venue 20260918d stops treating as
--     access.
--
-- WHO WRITES OPS locations FROM A BROWSER (audited 18 Sep 2026, every .from('locations')
-- write in src/ and the admin portal's REST calls; Platform locations writes are a different
-- table, done by the location-admin edge function under the service role):
--   Back Office, a signed in login of THAT venue:
--     LocationSettings.jsx (show_item_images, address, pos_settings.takeaway_customer_details),
--     MenuManager.jsx (quick_screen_ids, quick_screen_mode, quick_screen_auto) and
--     lib/db.js saveQuickScreenIds (called only by MenuManager), MultiLocation.jsx (name),
--     PrintMenu.jsx (print_menu_config), PrintRouting.jsx (pos_settings
--     .default_receipt_printer_id), ReceiptBranding.jsx (receipt_branding), TaxManager.jsx
--     (default_tax_profile_id), AdyenTerminals.jsx (pos_settings.tip_on_receipt),
--     lib/orderScreen/orderScreenData.js (pos_settings.order_screen_keep_paid).
--   Back Office Company Admin, a signed in login creating a venue in ITS OWN company:
--     CompanyAdmin.jsx createLocation (insert org_id, name, address, timezone, currency, status).
--   Admin portal (?mode=admin), the super admin: CompanyAdminApp.jsx create (POST), rename
--     (PATCH name), delete venue and delete organisation (DELETE).
--   Edge functions (service role, not affected): provision-location, location-admin (Platform),
--     profile-admin, marketing-admin, promo-redeem, onboarding functions.
--   NO till, kiosk, KDS, order screen, online, QR or catering page writes Ops locations; they
--   only read it (PairingScreen embeds locations(*); kiosk, online, catering, group order and
--   the bookings widget read branding, tax profile, timezone and org_id anonymously).
--
-- WHAT THIS DOES
--   1. Drops EVERY permissive policy on public.locations ("allow all", "Allow authenticated
--      access", "Users can update own location settings", the draft locations_* names, and
--      anything else found live; the result lists them) and creates exactly four:
--        locations_read    SELECT for everyone, as today. The row holds no secrets (payment
--                          credentials live in the Platform DB and vault), anonymous customer
--                          pages need it, and user_accessible_locations() reads this table, so
--                          this policy must never call it (it would recurse).
--        locations_update  a real (non anonymous) login with access to THAT venue:
--                          id in user_accessible_locations(), which since 20260918d is
--                          user_locations plus every venue for a verified super admin.
--        locations_insert  a real login, into its OWN company (its profile org, or an org of a
--                          venue it is linked to), or a super admin.
--        locations_delete  super admin only.
--   2. Revokes INSERT, UPDATE, DELETE on locations from anon (the raw anon key, no session), and
--      TRUNCATE (which ignores RLS) from anon and authenticated.
--   3. A guard trigger: through the API, org_id and id can never change unless a super admin
--      does it (the service role and this editor pass); and a venue created through the API by
--      anyone but a super admin always gets a server generated id, so nobody can create an Ops
--      venue whose id equals another company's Platform location id (the drifted venues:
--      Birmingham, Provo, San Mateo 1 have Platform ids that are not Ops ids).
--   4. A self test, always rolled back; if ANY probe is not as expected the migration raises
--      and nothing is changed. The insert probes give their own venue code, so no SV-nnnn number
--      is used up.
--
-- SCREENS THAT CHANGE: none for a login of the venue or the super admin. Anything else that
-- wrote Ops locations (the anon key, a kiosk or online session, a login of another venue, a
-- login whose only tie to the venue was its profile venue) is now refused.

begin;

set local lock_timeout = '5s';

-- 0. Right database, and 20260918d first (the super admin arm lives there).
do $guard$
declare
  v_src text;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is for the OPS DB (tbetcegmszzotrwdtqhi). Wrong database, nothing changed.';
  end if;
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'user_accessible_locations' and p.pronargs = 0;
  if v_src is null or v_src ilike '%user_profiles%' or v_src not ilike '%is_super_admin%' then
    raise exception 'Run 20260918d_OPS_profile_venue_lock.sql first. Nothing changed.';
  end if;
end
$guard$;

-- 1. Policies.
alter table public.locations enable row level security;

drop policy if exists "allow all" on public.locations;
drop policy if exists "Allow authenticated access" on public.locations;
drop policy if exists "Users can update own location settings" on public.locations;
drop policy if exists locations_anon_update on public.locations;
drop policy if exists locations_select on public.locations;
drop policy if exists locations_insert on public.locations;
drop policy if exists locations_update on public.locations;
drop policy if exists locations_delete on public.locations;

do $sweep$
declare
  r record;
  v_dropped text := '';
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'locations' and permissive = 'PERMISSIVE'
       and policyname not in ('locations_read', 'locations_update', 'locations_insert', 'locations_delete')
  loop
    execute format('drop policy %I on public.locations', r.policyname);
    v_dropped := v_dropped || case when v_dropped = '' then '' else ', ' end || r.policyname;
  end loop;
  perform set_config('servos.loc_swept', coalesce(nullif(v_dropped, ''), 'none'), false);
end
$sweep$;

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  as permissive for select to public
  using (true);

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  as permissive for update to public
  using      (not public.is_anon_session() and id::text in (select public.user_accessible_locations()))
  with check (not public.is_anon_session() and id::text in (select public.user_accessible_locations()));

drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  as permissive for insert to public
  with check (
    auth.uid() is not null
    and not public.is_anon_session()
    and (
      public.is_super_admin()
      or (org_id is not null
          and (org_id = (select up.org_id from public.user_profiles up where up.id = auth.uid())
               or org_id::text in (select public.user_accessible_orgs())))
    )
  );

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  as permissive for delete to public
  using (public.is_super_admin());

-- 2. The raw anon key never writes a venue. TRUNCATE (granted to anon and authenticated by the
--    baseline, and it ignores RLS) is taken from both; PostgREST cannot send it, nothing uses it.
revoke insert, update, delete on table public.locations from anon;
revoke truncate on table public.locations from anon, authenticated;

-- 3. org_id and id never change through the API unless a super admin does it; a venue created
--    through the API gets a server id.
create or replace function public.locations_org_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  -- The service role (edge functions) and postgres (this editor, migrations) pass.
  if v_jwt_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.id := gen_random_uuid();
    return new;
  end if;
  if new.org_id is distinct from old.org_id or new.id is distinct from old.id then
    raise exception 'A venue''s company and id can only be changed by the platform'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists locations_org_guard on public.locations;
create trigger locations_org_guard
  before insert or update on public.locations
  for each row execute function public.locations_org_guard();

-- 4. Self test. Every probe runs inside a block that is always rolled back.
do $probe$
declare
  v_owner     uuid;
  v_owner_org uuid;
  v_admin     uuid;
  v_loc       uuid;
  v_far       uuid;
  v_admin_far uuid;
  v_other_org uuid;
  v_new       uuid;
  v_asked     uuid := gen_random_uuid();
  v_rows      int;
  v_all       int;
  v_flag      text;
  v_fail      text := '';
  v_has_code  boolean;
begin
  select p.id, p.org_id, ul.location_id into v_owner, v_owner_org, v_loc
    from public.user_profiles p
    join auth.users u on u.id = p.id
    join public.user_locations ul on ul.user_id = p.id
    join public.locations l on l.id = ul.location_id
   where p.role = 'owner' and not coalesce(u.is_anonymous, false) and p.org_id is not null
     and l.org_id = p.org_id
   order by p.created_at limit 1;
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
  select o.id into v_other_org from public.organisations o where o.id is distinct from v_owner_org order by o.id limit 1;
  v_other_org := coalesce(v_other_org, gen_random_uuid());
  select count(*) into v_all from public.locations;
  v_has_code := exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'locations' and column_name = 'venue_code');

  -- a) The raw anon key (no session) renames a venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    set local role anon;
    update public.locations set name = name where id = v_loc;
    get diagnostics v_rows = row_count;
    v_flag := case when v_loc is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%permission denied%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_anon_key', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | anon key writes a venue: ' || v_flag; end if;

  -- b) An anonymous session (kiosk, online checkout) renames a venue: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'is_anonymous', true)::text, true);
    set local role authenticated;
    update public.locations set name = name where id = v_loc;
    get diagnostics v_rows = row_count;
    v_flag := case when v_loc is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%permission denied%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_anon_session', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | anonymous session writes a venue: ' || v_flag; end if;

  -- c) The same anonymous session still READS every venue (kiosk, online, pairing).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'is_anonymous', true)::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.locations;
    v_flag := case when v_rows = v_all then 'reads all' else 'BROKEN (' || v_rows || ' of ' || v_all || ')' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_reads', v_flag, false);
  if v_flag <> 'reads all' then v_fail := v_fail || ' | customer pages read venues: ' || v_flag; end if;

  -- d) The owner saves a setting on their own venue (Back Office settings): works.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.locations set name = name, pos_settings = pos_settings where id = v_loc;
    get diagnostics v_rows = row_count;
    v_flag := case when v_owner is null then 'not tested' when v_rows = 1 then 'works' else 'BROKEN (' || v_rows || ' rows)' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_own_save', v_flag, false);
  if v_flag <> 'works' then v_fail := v_fail || ' | owner saves own venue: ' || v_flag; end if;

  -- e) The owner writes a venue they are not linked to: nothing matches.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.locations set name = name where id = v_far;
    get diagnostics v_rows = row_count;
    v_flag := case when v_owner is null or v_far is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked'; end if;
  end;
  perform set_config('servos.v_other_venue', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner writes another venue: ' || v_flag; end if;

  -- f) The owner moves their own venue into another company (a forged org_id): refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.locations set org_id = v_other_org where id = v_loc;
    if v_owner is null then v_flag := 'not tested'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%only be changed by the platform%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_org_change', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner changes a venue''s company: ' || v_flag; end if;

  -- g) The owner changes their venue's id: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.locations set id = gen_random_uuid() where id = v_loc;
    if v_owner is null then v_flag := 'not tested'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%only be changed by the platform%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_id_change', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner changes a venue id: ' || v_flag; end if;

  -- h) The owner creates a venue in ANOTHER company: refused.
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    if v_has_code then
      execute 'insert into public.locations (org_id, name, status, venue_code) values ($1, $2, $3, $4)'
        using v_other_org, 'Lockdown probe', 'active', 'SV-PROBE-X';
    else
      execute 'insert into public.locations (org_id, name, status) values ($1, $2, $3)'
        using v_other_org, 'Lockdown probe', 'active';
    end if;
    if v_owner is null then v_flag := 'not tested'; end if;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm ilike '%row-level security%' or sqlerrm ilike '%permission denied%' then v_flag := 'blocked';
    elsif sqlerrm <> 'probe_rollback' then v_flag := 'UNCLEAR (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_insert_other', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner creates a venue in another company: ' || v_flag; end if;

  -- i) The owner creates a venue in their OWN company asking for a chosen id: works, and the
  --    server replaces the id (Company Admin "create location" keeps working).
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    if v_has_code then
      execute 'insert into public.locations (id, org_id, name, status, venue_code) values ($1, $2, $3, $4, $5) returning id'
        into v_new using v_asked, v_owner_org, 'Lockdown probe', 'active', 'SV-PROBE-Y';
    else
      execute 'insert into public.locations (id, org_id, name, status) values ($1, $2, $3, $4) returning id'
        into v_new using v_asked, v_owner_org, 'Lockdown probe', 'active';
    end if;
    v_flag := case when v_owner is null then 'not tested' when v_new is not null and v_new <> v_asked then 'works, server id' else 'BROKEN: kept the chosen id' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_insert_own', v_flag, false);
  if v_flag <> 'works, server id' then v_fail := v_fail || ' | owner creates a venue in own company: ' || v_flag; end if;

  -- j) The owner deletes their own venue: nothing matches (super admin only).
  v_flag := 'NOT BLOCKED';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    delete from public.locations where id = v_loc;
    get diagnostics v_rows = row_count;
    v_flag := case when v_owner is null then 'not tested' when v_rows = 0 then 'blocked' else 'NOT BLOCKED' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'blocked'; end if;
  end;
  perform set_config('servos.v_delete', v_flag, false);
  if v_flag <> 'blocked' then v_fail := v_fail || ' | owner deletes a venue: ' || v_flag; end if;

  -- k) The super admin saves a setting on a venue he is NOT linked to: works.
  v_flag := 'not tested';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'is_anonymous', false)::text, true);
    set local role authenticated;
    update public.locations set name = name where id = v_admin_far;
    get diagnostics v_rows = row_count;
    v_flag := case when v_admin is null or v_admin_far is null then 'not tested' when v_rows = 1 then 'works' else 'BROKEN (' || v_rows || ' rows)' end;
    raise exception 'probe_rollback';
  exception when others then
    if sqlerrm <> 'probe_rollback' then v_flag := 'BROKEN (' || sqlerrm || ')'; end if;
  end;
  perform set_config('servos.v_admin_save', v_flag, false);
  if v_flag <> 'works' then v_fail := v_fail || ' | super admin saves an unlinked venue: ' || v_flag; end if;

  -- l) Structure.
  select count(*) into v_rows from pg_policies
   where schemaname = 'public' and tablename = 'locations' and permissive = 'PERMISSIVE'
     and policyname not in ('locations_read', 'locations_update', 'locations_insert', 'locations_delete');
  if v_rows <> 0 then v_fail := v_fail || ' | other permissive policies left: ' || v_rows; end if;
  select count(*) into v_rows from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'locations' and grantee = 'anon'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_rows <> 0 then v_fail := v_fail || ' | anon write grants left: ' || v_rows; end if;
  select count(*) into v_rows from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'locations' and grantee = 'authenticated'
     and privilege_type = 'TRUNCATE';
  if v_rows <> 0 then v_fail := v_fail || ' | truncate grant left'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'locations_org_guard' and not tgisinternal) then
    v_fail := v_fail || ' | guard trigger missing';
  end if;

  if v_fail <> '' then
    raise exception 'SELF TEST FAILED, NOTHING WAS CHANGED:%', v_fail;
  end if;
end
$probe$;

commit;

-- VISIBLE RESULT (read only). Expect: blocked, blocked, reads all, works, blocked, blocked,
-- blocked, blocked, works, server id, blocked, works; swept_policies lists what was dropped
-- (normally: allow all, Allow authenticated access, Users can update own location settings are
-- dropped by name above, so "none").
select
  current_setting('servos.v_anon_key', true)     as anon_key_writes_venue,
  current_setting('servos.v_anon_session', true) as kiosk_session_writes_venue,
  current_setting('servos.v_reads', true)        as customer_pages_read_venues,
  current_setting('servos.v_own_save', true)     as owner_saves_own_venue,
  current_setting('servos.v_other_venue', true)  as owner_writes_other_venue,
  current_setting('servos.v_org_change', true)   as owner_moves_venue_to_other_company,
  current_setting('servos.v_id_change', true)    as owner_changes_venue_id,
  current_setting('servos.v_insert_other', true) as owner_creates_venue_in_other_company,
  current_setting('servos.v_insert_own', true)   as owner_creates_venue_in_own_company,
  current_setting('servos.v_delete', true)       as owner_deletes_venue,
  current_setting('servos.v_admin_save', true)   as you_save_an_unlinked_venue,
  current_setting('servos.loc_swept', true)      as swept_policies,
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'locations') as policies_now;
