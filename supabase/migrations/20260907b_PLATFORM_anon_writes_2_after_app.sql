-- DRAFT, DO NOT RUN (8 Sep 2026). The adversarial pass found 12 breaks and 25 gaps that are NOT applied yet;
-- they are listed at the end of docs/PRE_LIVE_SECURITY_MIGRATIONS.md. A fix pass must land before this file is run.

-- 20260907b_PLATFORM_anon_writes_2_after_app.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #                                                                          #
-- #  DO NOT RUN THIS FILE UNTIL THE APP CHANGES LISTED BELOW ARE LIVE.       #
-- #  Every statement here takes a Back Office screen offline if its write   #
-- #  still goes straight to the table as the anon role.                     #
-- ############################################################################
--
-- WHY THESE WAIT
--   The platform browser client has no JWT (src/lib/supabase.js:30,
--   persistSession:false). The Back Office reaches these tables as `anon`, so
--   the USING(true) policies below are, today, the ONLY thing letting the
--   Back Office read and write its own loyalty, gift and card reader
--   configuration. They are also what lets anyone with the anon key (it ships
--   in the browser bundle) read every member's points balance, rewrite tipping
--   prompts for any venue, or delete stamp programmes.
--
-- APP CHANGES THAT MUST BE DEPLOYED FIRST (details in
-- docs/PRE_LIVE_SECURITY_MIGRATIONS.md, section "App changes")
--   P2  supabase/functions/location-admin: add action save_reader_settings
--       (same authed() fence, whitelist tipping_enabled, tip_percentages,
--       allow_custom_tip, smart_tip_threshold_minor, idle_screen_enabled,
--       idle_screen_image_url); src/backoffice/sections/CardReaders.jsx:814
--       calls it instead of platformSupabase.from('location_reader_settings')
--   P3  a service role loyalty-admin edge function (or more location-admin
--       actions) fenced like location-admin.authed(), and these screens moved
--       onto it:
--         src/backoffice/sections/LoyaltyManager.jsx  :1023 :1331 :1351 :1532 :1538 :1625 :1745 :1835 :1838 :1855 :1857
--         src/backoffice/sections/Customers.jsx        :145 :157
--         src/backoffice/sections/reports/LoyaltyReport.jsx :45 :48
--         src/backoffice/sections/OnlineOrdering.jsx   :69
--         src/backoffice/sections/GiftCards.jsx        :1266
--
-- Run section 1 once P2 is live and section 2 once P3 is live. They are
-- independent; each is idempotent on its own.


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
-- 1. location_reader_settings (needs P2)
-- ============================================================================
-- Live: location_reader_settings_insert (INSERT to public WITH CHECK true) and
-- location_reader_settings_write (UPDATE to public true/true) from 20260713g.
-- Any anon key holder can rewrite any venue's tipping prompts and idle screen.
-- Reads stay open (the till reads its own venue's prompts as anon).
drop policy if exists location_reader_settings_insert on public.location_reader_settings;
drop policy if exists location_reader_settings_write  on public.location_reader_settings;
revoke insert, update, delete on table public.location_reader_settings from anon, authenticated;
-- The edge function stripe-sync-location-reader-config and location-admin use
-- service_role and are unaffected.


-- ============================================================================
-- 2. The six service_all style policies (needs P3)
-- ============================================================================
-- Re scoping to service_role is the same as dropping: service_role bypasses
-- RLS. The names finally mean what they say. This is 20260805c B5b, applied.

-- customer_loyalty: every member's points balance, lifetime spend, member_code.
-- Only policy on the table, so reads die with it too.
drop policy if exists service_all on public.customer_loyalty;
create policy service_all on public.customer_loyalty
  for all to service_role using (true) with check (true);

-- loyalty_tiers: only policy on the table.
drop policy if exists service_all on public.loyalty_tiers;
create policy service_all on public.loyalty_tiers
  for all to service_role using (true) with check (true);

-- loyalty_config: only policy on the table.
drop policy if exists service_all on public.loyalty_config;
create policy service_all on public.loyalty_config
  for all to service_role using (true) with check (true);

-- stamp_card_programs and customer_stamp_cards: the anon_read_* twins
-- (SELECT true) also go. Customer surfaces never read these tables directly
-- (loyalty-balance / loyalty-earn / loyalty-redeem / wallet-pass are service
-- role); only the Back Office did, and P3 moves it.
drop policy if exists service_all_stamp_programs on public.stamp_card_programs;
drop policy if exists anon_read_stamp_programs   on public.stamp_card_programs;
create policy service_all_stamp_programs on public.stamp_card_programs
  for all to service_role using (true) with check (true);

drop policy if exists service_all_stamp_cards on public.customer_stamp_cards;
drop policy if exists anon_read_stamp_cards   on public.customer_stamp_cards;
create policy service_all_stamp_cards on public.customer_stamp_cards
  for all to service_role using (true) with check (true);

-- gift_card_purchases: sender and recipient names and emails plus the
-- fulfilled code. gift_card_purchases_company_read stays (it matches a real
-- JWT, which the browser never has here, so it is inert but harmless).
drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
create policy gift_card_purchases_service on public.gift_card_purchases
  for all to service_role using (true) with check (true);

-- Defence in depth on the six: the browser roles lose the write grants, so a
-- pasted permissive policy cannot silently reopen them.
revoke insert, update, delete on table
  public.customer_loyalty, public.loyalty_tiers, public.loyalty_config,
  public.stamp_card_programs, public.customer_stamp_cards, public.gift_card_purchases
from anon, authenticated;


-- ============================================================================
-- V. Verification (read only, paste after applying)
-- ============================================================================
-- 1. location_reader_settings: read policy only (expect 1 row, SELECT):
-- select policyname, cmd, roles from pg_policies where tablename = 'location_reader_settings' order by 1;
--
-- 2. The six tables: every policy is to service_role except gift_card_purchases_company_read:
-- select tablename, policyname, cmd, roles from pg_policies
--  where tablename in ('customer_loyalty','loyalty_tiers','loyalty_config','stamp_card_programs',
--                      'customer_stamp_cards','gift_card_purchases')
--  order by 1, 2;
--
-- 3. Browser roles hold no write grants on those tables (expect 0 rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and grantee in ('anon','authenticated')
--    and table_name in ('location_reader_settings','customer_loyalty','loyalty_tiers','loyalty_config',
--                       'stamp_card_programs','customer_stamp_cards','gift_card_purchases')
--    and privilege_type in ('INSERT','UPDATE','DELETE');
--
-- 4. Smoke: Back Office -> Loyalty loads and saves a tier; Back Office -> Card
--    readers saves tipping prompts; kiosk loyalty phone lookup still returns a
--    balance (edge function path); gift purchase tab lists purchases.
