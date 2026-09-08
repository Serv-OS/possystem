-- DRAFT, DO NOT RUN (8 Sep 2026). The adversarial pass found 12 breaks and 25 gaps that are NOT applied yet;
-- they are listed at the end of docs/PRE_LIVE_SECURITY_MIGRATIONS.md. A fix pass must land before this file is run.

-- 20260907b_ops_rls_3_after_app.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #                                                                          #
-- #  DO NOT RUN THIS FILE UNTIL THE APP CHANGES LISTED BELOW ARE LIVE ON     #
-- #  EVERY DEVICE. It removes the last "allow all" policies and the direct   #
-- #  reads the customer surfaces make today. Run it too early and:          #
-- #    online order tracking goes blank, QR tab resume and "settle bill"     #
-- #    stop, QR tabs vanish from the floor plan, catering capacity reads 0,  #
-- #    and the pairing screen cannot look a code up.                         #
-- #                                                                          #
-- #  Requires files 1 and 2 first (the guard checks).                        #
-- ############################################################################
--
-- APP CHANGES THAT MUST BE DEPLOYED FIRST (details in
-- docs/PRE_LIVE_SECURITY_MIGRATIONS.md, section "App changes")
--   A1  src/lib/customerLookup.js            attributeOnlineOrder -> rpc attribute_public_order
--   A2  src/surfaces/online/OrderTracker.jsx   poll -> rpc order_track_row
--   A3  src/surfaces/online/OnlineSurface.jsx  :141 -> qr_table_open_tabs, :187 -> qr_tab_rounds, :230 -> order_track_check
--   A4  src/surfaces/qr/QrCheckout.jsx         :371 -> qr_table_tab_count
--   A5  src/lib/qrTableSession.js              body -> rpc sync_qr_table_session
--   A6  src/surfaces/qr/TabResumeScreen.jsx    :142 -> rpc qr_close_tab
--   A7  src/surfaces/qr/JoinTabScreen.jsx      join code check -> qr_tab_rounds(p_tab_handle, p_join_code)
--   A8  src/surfaces/catering/CateringSurface.jsx :131 and :217 -> catering_day_load
--   A9  src/lib/prepTime.js                    delete the direct read fallback (online_kitchen_load must be deployed)
--   A10 src/surfaces/PairingScreen.jsx         claim_device_v2 replaces the SELECT by code and the pre claim UPDATE; store device_secret
--   A11 src/surfaces/KioskSurface.jsx          same as A10
--   A12 src/lib/supabase.js claimPairedDeviceOnBoot -> reclaim_device(id, secret), loud on failure
--   A13 src/surfaces/CustomerDisplaySurface.jsx :84 and src/surfaces/KioskApp.jsx :85 -> rpc device_profile_public
--   A14 src/surfaces/online/OnlineCheckout.jsx  remove the client decrement_stock calls (stock-deplete already runs server side)
--   P1  src/backoffice/sections/DeviceRegistry.jsx:182 setPairingCode(data.pairing_code)
--       src/backoffice/sections/KioskRegistry.jsx:108 to :115 show the code from the returned row (add .select() to the update)
--       (or move both to rpc issue_pairing_code)
--
-- WHAT THIS FILE DOES
--   1. order_queue: drop "allow all"; recreate the public INSERT carve-out without 'kiosk'
--   2. active_sessions: drop "allow all"
--   3. customers / customer_locations / customer_orders: drop the legacy *_all trio
--   4. devices: remove the interim anonymous read by code arm
--   5. devices trigger: replace browser generated codes with server codes (needs P1)
--   6. device_profiles: reads become tenant fenced (needs A13)
--   7. closed_checks: public INSERT carve-out without 'kiosk'
--   8. decrement_stock: paired device or Back Office only (needs A14)
--
-- RULES OF THE FILE: bare idempotent statements, no begin / commit, drop policy
-- if exists before create, verification at the bottom.


-- ============================================================================
-- 0. Guards
-- ============================================================================
do $guard$
declare
  r record;
  n int := 0;
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS DB (tbetcegmszzotrwdtqhi). This is not it. Aborting.';
  end if;
  if to_regprocedure('public.attribute_public_order(uuid, text, text, text, text, boolean, numeric, jsonb, text)') is null
     or to_regprocedure('public.sync_qr_table_session(uuid, text)') is null then
    raise exception 'Run 20260907b_ops_rls_1_fences_and_rpcs.sql first.';
  end if;
  if to_regprocedure('public.claim_device_v2(text)') is null
     or to_regprocedure('public.reclaim_device(uuid, text)') is null then
    raise exception 'Run 20260907b_ops_rls_2_pairing.sql first.';
  end if;
  -- prepTime.js falls back to direct reads when this RPC is missing (A9).
  if to_regprocedure('public.online_kitchen_load(text)') is null then
    raise exception 'online_kitchen_load(text) is not deployed (20260902_online_kitchen_load.sql). Apply it first or the storefront busy quote breaks.';
  end if;
  -- Every live device must be bound before active_sessions loses "allow all",
  -- or the tables vanishing regression (20260429 revert) comes back.
  for r in
    select id, name, type, status from public.devices
     where device_uid is null and status in ('active', 'online')
  loop
    n := n + 1;
    raise notice 'UNBOUND ACTIVE DEVICE: % [%] %', r.name, r.type, r.id;
  end loop;
  if n > 0 then
    raise exception '% active/online device(s) have no device_uid. Re-pair them (or mark them removed) before running this file.', n;
  end if;
end
$guard$;


-- ============================================================================
-- 1. order_queue
-- ============================================================================
alter table public.order_queue enable row level security;
drop policy if exists "allow all" on public.order_queue;

-- Public checkout INSERT without the kiosk arm (a kiosk is a bound device and
-- passes order_queue_tenant).
drop policy if exists order_queue_public_insert on public.order_queue;
create policy order_queue_public_insert on public.order_queue
  for insert
  with check (
    (auth.uid() is null or public.is_anon_session())
    and source in ('online', 'qr', 'catering')
    and status in ('prep', 'received')
    and staff is null
    and public.is_active_public_location(location_id)
  );


-- ============================================================================
-- 2. active_sessions
-- ============================================================================
alter table public.active_sessions enable row level security;
drop policy if exists "allow all" on public.active_sessions;


-- ============================================================================
-- 3. customers trio: the is_anonymous escape hatch goes for good
-- ============================================================================
-- The restrictive fences from file 1 already denied anonymous sessions; this
-- removes the permissive policies that carried the hatch so nothing can ever
-- re open it by dropping a restrictive policy.
drop policy if exists customers_all          on public.customers;
drop policy if exists customer_locations_all on public.customer_locations;
drop policy if exists customer_orders_all    on public.customer_orders;


-- ============================================================================
-- 4. devices: no anonymous read by code
-- ============================================================================
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices
  for select
  using (
    device_uid = auth.uid()
    or location_id in (select public.pos_accessible_location_ids())
    or public.is_super_admin()
  );


-- ============================================================================
-- 5. devices trigger: server side codes always
-- ============================================================================
-- A browser supplied code is replaced with a 12 symbol server code. The Back
-- Office must display the code from the returned row (P1) or it shows the
-- value it sent. issue_pairing_code() sets rpos.device_issue so the code it
-- chose is kept.
create or replace function public.devices_pairing_code_issued_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.pairing_code is not null
     and (tg_op = 'INSERT' or new.pairing_code is distinct from old.pairing_code) then
    if coalesce(current_setting('rpos.device_issue', true), '') <> '1' then
      new.pairing_code := public._device_gen_pairing_code();
    else
      new.pairing_code := upper(btrim(new.pairing_code));
    end if;
    new.pairing_expires_at := now() + interval '4 hours';
    new.device_uid         := null;
    new.device_secret_hash := null;
    new.secret_issued_at   := null;
    new.paired_at          := null;
  elsif tg_op = 'UPDATE' and new.pairing_code is null and old.pairing_code is not null then
    new.pairing_expires_at := null;
  end if;
  return new;
end;
$fn$;
-- The trigger object itself (devices_pairing_code_issued) already points at
-- this function; replacing the body is enough.


-- ============================================================================
-- 6. device_profiles: tenant fenced reads
-- ============================================================================
drop policy if exists device_profiles_read_open on public.device_profiles;
drop policy if exists device_profiles_read_tenant on public.device_profiles;
create policy device_profiles_read_tenant on public.device_profiles
  for select
  using (location_id in (select public.pos_accessible_location_ids()) or public.is_super_admin());


-- ============================================================================
-- 7. closed_checks: public carve-out without the kiosk arm
-- ============================================================================
drop policy if exists closed_checks_insert on public.closed_checks;
create policy closed_checks_insert on public.closed_checks
  for insert
  with check (
    location_id in (select public.pos_accessible_location_keys())
    or public.is_super_admin()
    or (
      (auth.uid() is null or public.is_anon_session())
      and source in ('online', 'qr', 'catering')
      and status = 'paid'
      and staff_id is null
      and public.is_active_public_location(location_id)
    )
  );


-- ============================================================================
-- 8. decrement_stock: device or Back Office only
-- ============================================================================
create or replace function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_new_remaining int;
  v_par int;
begin
  if p_qty is null or p_qty < 1 or p_qty > 50 then
    raise exception 'decrement_stock: p_qty must be between 1 and 50';
  end if;
  if not (public.pos_can_access(p_location_id) or public.is_super_admin()) then
    raise exception 'decrement_stock: not allowed for this location';
  end if;

  update public.stock_levels
     set remaining = greatest(0, remaining - p_qty),
         updated_at = now()
   where location_id = p_location_id and item_id = p_item_id
  returning remaining, par into v_new_remaining, v_par;

  if not found then
    return jsonb_build_object('tracked', false);
  end if;

  if v_new_remaining <= 0 then
    insert into public.eighty_six (location_id, item_id)
    values (p_location_id, p_item_id)
    on conflict (location_id, item_id) do nothing;
  end if;

  return jsonb_build_object('tracked', true, 'remaining', v_new_remaining, 'par', v_par);
end;
$fn$;


-- ============================================================================
-- V. Verification (read only, paste after applying)
-- ============================================================================
-- 1. No "allow all" anywhere (expect 0 rows):
-- select tablename, policyname from pg_policies where schemaname = 'public' and policyname = 'allow all';
--
-- 2. No is_anonymous escape hatch anywhere (expect 0 rows):
-- select tablename, policyname from pg_policies
--  where schemaname = 'public' and (coalesce(qual,'') like '%is_anonymous%' or coalesce(with_check,'') like '%is_anonymous%');
--
-- 3. No auth.uid() IS NULL arm on the customer tables (expect 0 rows):
-- select tablename, policyname from pg_policies
--  where tablename in ('customers','customer_locations','customer_orders')
--    and (coalesce(qual,'') like '%auth.uid() IS NULL%' or coalesce(with_check,'') like '%auth.uid() IS NULL%');
--
-- 4. devices_select has no anonymous arm (qual must not mention pairing_code):
-- select qual from pg_policies where tablename = 'devices' and policyname = 'devices_select';
--
-- 5. device_profiles read is fenced:
-- select policyname, qual from pg_policies where tablename = 'device_profiles' and cmd = 'SELECT';
--
-- 6. Smoke, as a fresh anonymous session with no device (expect 0 rows from each):
-- select count(*) from public.order_queue;
-- select count(*) from public.active_sessions;
-- select count(*) from public.customers;
-- select count(*) from public.devices;
