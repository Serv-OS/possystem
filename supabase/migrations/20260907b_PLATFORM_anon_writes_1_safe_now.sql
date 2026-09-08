-- DRAFT, DO NOT RUN (8 Sep 2026). The adversarial pass found 12 breaks and 25 gaps that are NOT applied yet;
-- they are listed at the end of docs/PRE_LIVE_SECURITY_MIGRATIONS.md. A fix pass must land before this file is run.

-- 20260907b_PLATFORM_anon_writes_1_safe_now.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Run this file any time. It needs NO app change.                          #
-- #  The guard at the top aborts if you paste it into the Ops project.        #
-- ############################################################################
--
-- CONTEXT THAT SHAPES EVERYTHING HERE
--   src/lib/supabase.js:30 builds platformSupabase with persistSession:false,
--   so every browser call to this database (Back Office included) arrives as
--   the raw `anon` role with no JWT and auth.uid() NULL. A policy written
--   `to authenticated` or on auth.uid() matches nothing from a browser. That
--   is why the remaining holes on this database are USING(true) policies, and
--   why six of them cannot be closed by SQL until the Back Office writes move
--   behind an edge function (readiness blocker 1, Gate 3). Those six are in
--   20260907b_PLATFORM_anon_writes_2_after_app.sql.
--
-- WHAT THIS FILE CLOSES (readiness finding 2 and its neighbours)
--   1. locations_anon_update. Verified ABSENT in the 6 Aug baseline (20260805c
--      B1 dropped it and revoked anon's UPDATE); restated here idempotently,
--      plus the INSERT / DELETE / TRUNCATE / REFERENCES / TRIGGER grants anon
--      and authenticated still held on locations with no policy behind them.
--      Every Back Office write to platform locations already goes through
--      supabase/functions/location-admin (service role) and the RPCs
--      location_branding_merge / challenge21_reset.
--   2. The three DEAD bluetooth write policies on payment_devices
--      (pd_write_bt / pd_update_bt / pd_delete_bt): fenced on
--      connection_kind = 'bluetooth', which the CHECK constraint forbids.
--   3. payment_devices column level SELECT: registration_code (a pairing
--      secret), stripe_account_id and registered_by_user_id leave the anon
--      read. This is 20260805d, re verified 7 Sep 2026 against the three
--      browser select lists (networkReader.js:63, StatusDrawerCardReaders.jsx:71,
--      CardReaders.jsx:93 which already excludes registration_code). A DO
--      block checks every granted column exists before granting.
--   4. Function EXECUTE for anon / authenticated / PUBLIC on the four RPCs only
--      service role edge functions call (get_effective_markup exposes our own
--      markup; upsert_customer_stamp_card and redeem_gift_card_atomic write
--      customer balances; get_plan_and_fee_for_gmv is pricing logic).
--   5. TRUNCATE / REFERENCES / TRIGGER on every table for anon and
--      authenticated (readiness medium 3).
--
-- RULES OF THE FILE: bare idempotent statements, no begin / commit, drop policy
-- if exists before create, PUBLIC named explicitly in every revoke,
-- verification at the bottom.


-- ============================================================================
-- 0. Guard
-- ============================================================================
do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null then
    raise exception 'This file is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu). This is not it. Aborting.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. locations: no browser write path of any kind
-- ============================================================================
-- Idempotent restatement of 20260805c B1 (Peter's decision, 5 Aug 2026).
drop policy if exists locations_anon_update on public.locations;
revoke update on table public.locations from anon;

-- The grants that were left behind: with no insert / delete policy RLS
-- blocked them, but a single permissive policy pasted into the dashboard
-- would have reopened both. `authenticated` never reaches this database from
-- a browser and edge functions use service_role, so it loses them too.
revoke insert, update, delete, truncate, references, trigger on table public.locations from anon, authenticated;

-- Reads are deliberately untouched: "anon can read locations" is how
-- src/lib/customerUrl.js:173 resolves a venue from its public slug before any
-- session exists, and the Back Office reads the same table as anon. The
-- narrow security_barrier view (20260805c B6 lists the 22 customer columns)
-- can only replace it once Back Office reads move behind an edge function.


-- ============================================================================
-- 2. payment_devices
-- ============================================================================
-- 2a. Dead policies. connection_kind is constrained to 'network' or 'tap_to_pay'
-- (payment_devices_connection_kind_check), so no row could ever satisfy these.
-- Dropping them removes a write path that would come alive the moment someone
-- relaxed the constraint.
drop policy if exists pd_write_bt  on public.payment_devices;
drop policy if exists pd_update_bt on public.payment_devices;
drop policy if exists pd_delete_bt on public.payment_devices;

-- 2b. Column level SELECT for the browser roles. pd_read_all (SELECT to anon,
-- authenticated USING true) stays: it is how a till finds its reader. The
-- table level SELECT is revoked and granted back per column, withholding
-- registration_code, stripe_account_id and registered_by_user_id.
--
-- WARNING: any future browser select('*') on payment_devices, or a select list that
--   names a withheld column, fails with "permission denied for column". Add
--   the column to this grant rather than re granting the table.
do $cols$
declare
  c text;
  wanted text[] := array[
    'id','location_id','stripe_reader_id','device_type','connection_kind','serial_number','label',
    'bound_pos_device_id','status','battery_level','last_seen_at','created_at','notes','ip_address',
    'firmware_version','last_status_check_at','stripe_terminal_location_id','customer_display_enabled',
    'processor','ryft_terminal_id','adyen_terminal_id'
  ];
begin
  foreach c in array wanted loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'payment_devices' and column_name = c
    ) then
      raise exception 'payment_devices.% does not exist on this database. Re verify the column list before applying the grant.', c;
    end if;
  end loop;
end
$cols$;

revoke select on table public.payment_devices from anon, authenticated;
grant select (
  id, location_id, stripe_reader_id, device_type, connection_kind, serial_number, label,
  bound_pos_device_id, status, battery_level, last_seen_at, created_at, notes, ip_address,
  firmware_version, last_status_check_at, stripe_terminal_location_id, customer_display_enabled,
  processor, ryft_terminal_id, adyen_terminal_id
) on public.payment_devices to anon, authenticated;
-- withheld: registration_code, stripe_account_id, registered_by_user_id


-- ============================================================================
-- 3. Function EXECUTE
-- ============================================================================
-- All four are called only through platformAdmin (service role) in
-- supabase/functions (stripe-process-payment-on-reader:116,
-- stripe-create-payment-intent:83, gift-checkout-session:196, loyalty-earn:244,
-- gift-redeem:182). No src/ caller (grep 7 Sep 2026). PUBLIC must be named:
-- a created function carries a default EXECUTE grant to PUBLIC (20260805c B2).
revoke execute on function public.get_effective_markup(uuid, text)                        from public, anon, authenticated;
revoke execute on function public.upsert_customer_stamp_card(uuid, uuid, uuid)            from public, anon, authenticated;
revoke execute on function public.redeem_gift_card_atomic(uuid, uuid, integer, text, uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.get_plan_and_fee_for_gmv(numeric, text)                 from public, anon, authenticated;
grant  execute on function public.get_effective_markup(uuid, text)                        to service_role;
grant  execute on function public.upsert_customer_stamp_card(uuid, uuid, uuid)            to service_role;
grant  execute on function public.redeem_gift_card_atomic(uuid, uuid, integer, text, uuid, text, text, uuid) to service_role;
grant  execute on function public.get_plan_and_fee_for_gmv(numeric, text)                 to service_role;


-- ============================================================================
-- 4. Grant hygiene (readiness medium 3)
-- ============================================================================
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;


-- ============================================================================
-- 5. Recorded, not changed
-- ============================================================================
-- * platform_settings: src/admin/sections/AdminBillingManager.jsx:371 UPDATEs
--   it as anon. There is no UPDATE policy on the table, so that save already
--   fails silently. Nothing to close here; the screen needs the payments-admin
--   edge function (same as its reads, 20260805c B4b).
-- * location_reader_settings insert / write, and the six service_all style
--   policies on customer_loyalty, loyalty_config, loyalty_tiers,
--   stamp_card_programs, customer_stamp_cards, gift_card_purchases: see
--   20260907b_PLATFORM_anon_writes_2_after_app.sql. Each is the ONLY policy that
--   lets a Back Office screen read or write its own configuration, because the
--   Back Office is anon here. Closing them today takes those screens offline.
-- * mra_read_authenticated and ps_read (SELECT true to authenticated): inert for
--   the browser (never authenticated here); left as the baseline records them.


-- ============================================================================
-- V. Verification (read only, paste after applying)
-- ============================================================================
-- 1. locations: no write policy, only the two reads (expect 2 rows, both SELECT):
-- select policyname, cmd, roles from pg_policies where tablename = 'locations' order by 1;
--
-- 2. locations grants for the browser roles (expect SELECT only for anon and authenticated):
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'locations' and grantee in ('anon','authenticated') order by 1, 2;
--
-- 3. payment_devices: pd_read_all only (expect 1 row):
-- select policyname, cmd, roles from pg_policies where tablename = 'payment_devices' order by 1;
--
-- 4. payment_devices column grants (registration_code, stripe_account_id, registered_by_user_id must be absent):
-- select grantee, column_name from information_schema.column_privileges
--  where table_schema = 'public' and table_name = 'payment_devices' and grantee in ('anon','authenticated')
--    and privilege_type = 'SELECT' order by 1, 2;
--
-- 5. Function EXECUTE (expect false for anon and authenticated on all four):
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('get_effective_markup','upsert_customer_stamp_card','redeem_gift_card_atomic','get_plan_and_fee_for_gmv')
--  order by 1;
--
-- 6. TRUNCATE / REFERENCES / TRIGGER gone (expect 0 rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated')
--    and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');
--
-- 7. Smoke: open a customer link /online/<slug> with no session (venue must resolve);
--    take a card payment on a network reader from the till (reader discovery must work).
