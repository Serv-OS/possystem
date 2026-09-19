-- 20260919c_PLATFORM_fence_1_safe_now.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  DATABASE FENCE, STAGE 1, PLATFORM FILE 1 OF 2.                           #
-- #  Safe with the app that is live today. Any time, ideally outside service. #
-- #  The guard stops it (changing nothing) in the Ops project.                #
-- ############################################################################
--
-- CONTEXT: the Platform browser client never holds a login (src/lib/supabase.js,
-- persistSession false), so every browser request here, Back Office included, is the
-- raw anon key. A policy cannot tell the Back Office from anyone else, so the only
-- safe closes today are the ones no browser needs. The rest waits for the app release
-- (20260919d, after docs/FENCE_STAGE_1_APP.md items P2 and P3).
--
-- WHAT THIS FILE CHANGES
--   1. TRUNCATE, REFERENCES, TRIGGER taken from anon and authenticated on every table
--      (38 of 42 tables had them; TRUNCATE ignores RLS).
--   2. gift_card_purchases: WRITES become server only. Today the policy
--      gift_card_purchases_service is FOR ALL TO public USING (true), so anyone could
--      mark a purchase paid or fulfilled. No browser writes this table (checkout,
--      fulfil, resend and the webhooks are edge functions on the service role), so
--      closing writes breaks nothing. Reading stays open for now ONLY because Back
--      Office "Online purchases" reads it with the anon key; 20260919d closes it.
--   3. location_reader_settings: the browser may only write the six columns Back
--      Office really writes (tipping and idle screen). The Stripe configuration id and
--      the uploaded file fields become server only. Deleting a row (never allowed by a
--      policy) loses its grant too.
--   4. locations: the write grants that no policy used (INSERT, DELETE) are taken from
--      the browser roles. Venue writes go through the location-admin edge function.
--
-- RULES: no begin or commit (any error means nothing changed), every statement can run
-- twice, 3 second lock wait, verification at the bottom, roll back in the comments.


set lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null
     or to_regclass('public.gift_card_purchases') is null
     or to_regclass('public.location_reader_settings') is null then
    raise exception 'This file is for the PLATFORM project (yhzjgyrkyjabvhblqxzu). This is not it. Nothing was changed.';
  end if;
end
$guard$;


-- 1. Grants no browser needs.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;


-- 2. gift_card_purchases: writes server only, reads unchanged for now.
alter table public.gift_card_purchases enable row level security;

drop policy if exists gift_card_purchases_server on public.gift_card_purchases;
create policy gift_card_purchases_server on public.gift_card_purchases
  for all to service_role
  using (true) with check (true);

-- Interim, removed by 20260919d: Back Office "Online purchases" reads with the anon key.
drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;
create policy gift_card_purchases_read_interim on public.gift_card_purchases
  for select to anon, authenticated
  using (true);

drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
revoke insert, update, delete on table public.gift_card_purchases from anon, authenticated;


-- 3. location_reader_settings: only the columns Back Office writes.
-- CardReaders.jsx saves tipping_enabled, tip_percentages, allow_custom_tip,
-- smart_tip_threshold_minor, idle_screen_enabled, idle_screen_image_url;
-- PaxTerminals.jsx upserts location_id and idle_screen_image_url. The upload and sync
-- edge functions (service role) write the rest.
revoke insert, update, delete on table public.location_reader_settings from anon, authenticated;
grant insert (location_id, tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor,
              idle_screen_enabled, idle_screen_image_url)
  on public.location_reader_settings to anon, authenticated;
grant update (location_id, tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor,
              idle_screen_enabled, idle_screen_image_url)
  on public.location_reader_settings to anon, authenticated;


-- 4. locations: no browser write path at all (UPDATE was already taken, 20260805c).
revoke insert, update, delete on table public.locations from anon, authenticated;

reset lock_timeout;


-- V. Verification (read only). Expect: gift_writes_by_browser = false,
-- gift_policies = gift_card_purchases_company_read SELECT, gift_card_purchases_read_interim SELECT,
-- gift_card_purchases_server ALL; reader_protected_columns = false; truncate_left = 0.
select
  (has_table_privilege('anon', 'public.gift_card_purchases', 'INSERT')
   or has_table_privilege('anon', 'public.gift_card_purchases', 'UPDATE')
   or has_table_privilege('anon', 'public.gift_card_purchases', 'DELETE'))                          as gift_writes_by_browser,
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'gift_card_purchases')                              as gift_policies,
  (has_column_privilege('anon', 'public.location_reader_settings', 'stripe_configuration_id', 'UPDATE')
   or has_column_privilege('anon', 'public.location_reader_settings', 'idle_screen_file_id', 'UPDATE')) as reader_protected_columns,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) as truncate_left;


-- ROLL BACK (paste in the Platform SQL editor only if a screen breaks)
-- set lock_timeout = '3s';
-- create policy gift_card_purchases_service on public.gift_card_purchases for all to public using (true) with check (true);
-- drop policy if exists gift_card_purchases_server on public.gift_card_purchases;
-- drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;
-- grant insert, update, delete on table public.gift_card_purchases to anon, authenticated;
-- grant insert, update, delete on table public.location_reader_settings to anon, authenticated;
-- grant insert, delete on table public.locations to anon, authenticated;
-- grant update on table public.locations to authenticated;
-- reset lock_timeout;
-- (TRUNCATE, REFERENCES and TRIGGER are not given back: nothing uses them.)
