-- 20260919c_PLATFORM_fence_1_after_release.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  DATABASE FENCE, STAGE 1, PLATFORM FILE 1 OF 2.                           #
-- #  ONLY AFTER the app release is live, with its edge functions deployed     #
-- #  (location-admin must know save_reader_settings: Back Office, Card        #
-- #  readers, change a tip and Save works). Outside service.                  #
-- #  The guard stops it (changing nothing) in the Ops project.                #
-- ############################################################################
--
-- CONTEXT: the Platform browser client never holds a login (src/lib/supabase.js,
-- persistSession false), so every browser request here, Back Office included, is the
-- raw anon key. A policy cannot tell the Back Office from anyone else, so the only
-- safe closes are the ones no browser needs any more.
--
-- WHAT THIS FILE CHANGES
--   1. TRUNCATE, REFERENCES, TRIGGER taken from anon and authenticated on every table
--      (38 of 42 tables had them; TRUNCATE ignores RLS).
--   2. gift_card_purchases: WRITES become server only. Today the policy
--      gift_card_purchases_service is FOR ALL TO public USING (true), so anyone could
--      mark a purchase paid or fulfilled. No browser writes this table (checkout,
--      fulfil, resend and the webhooks are edge functions on the service role), so
--      closing writes breaks nothing. Reading is left exactly as it was
--      (gift_card_purchases_company_read, which the Platform browser client can never
--      satisfy: it holds no login); 20260919d takes the read grant away as well.
--   3. location_reader_settings: NO browser writes at all (18 Sep review: anyone could
--      change any venue's tip prompts, or put a fake "scan to pay" image on its card
--      readers). The only browser writers were Back Office Card readers and PAX
--      terminals, and the release saves both through location-admin
--      (save_reader_settings). Reads stay: the Back Office screens read them.
--   4. locations: the write grants that no policy used (INSERT, DELETE) are taken from
--      the browser roles. Venue writes go through the location-admin edge function.
--
-- RULES: no begin or commit (any error means nothing changed), every statement can run
-- twice, 3 second lock wait, verification at the bottom, roll back in the comments.


set local lock_timeout = '3s';

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

-- An earlier draft added gift_card_purchases_read_interim here (SELECT to anon, USING true)
-- for a Back Office tab that had not reloaded since the release. It is gone (fix round 3, 19
-- Sep): 20260919d drops it, the runbook runs C and D minutes apart, so the grace it bought was
-- worth nothing while it left a money table readable with the public key. The runbook's step 4
-- now says to reload every Back Office tab first, which the release's own Back Office needs
-- anyway (it reads this list through gift-list). The drop stays so an earlier run of this file
-- is undone.
drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;

drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
revoke insert, update, delete on table public.gift_card_purchases from anon, authenticated;


-- 3. location_reader_settings: no browser writes. Back Office saves through
-- location-admin (save_reader_settings, service role); the upload and Stripe sync edge
-- functions write the rest.
drop policy if exists location_reader_settings_insert on public.location_reader_settings;
drop policy if exists location_reader_settings_write on public.location_reader_settings;
revoke insert, update, delete on table public.location_reader_settings from anon, authenticated;


-- 4. locations: no browser write path at all (UPDATE was already taken, 20260805c).
revoke insert, update, delete on table public.locations from anon, authenticated;

reset lock_timeout;


-- V. Verification (read only). Expect: gift_writes_by_browser = false,
-- gift_policies = gift_card_purchases_company_read SELECT, gift_card_purchases_server ALL;
-- reader_writable_by_browser = false;
-- reader_policies = location_reader_settings_read SELECT; truncate_left = 0.
select
  (has_table_privilege('anon', 'public.gift_card_purchases', 'INSERT')
   or has_table_privilege('anon', 'public.gift_card_purchases', 'UPDATE')
   or has_table_privilege('anon', 'public.gift_card_purchases', 'DELETE'))                          as gift_writes_by_browser,
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'gift_card_purchases')                              as gift_policies,
  (has_column_privilege('anon', 'public.location_reader_settings', 'tip_percentages', 'UPDATE')
   or has_column_privilege('anon', 'public.location_reader_settings', 'idle_screen_image_url', 'UPDATE')
   or has_table_privilege('anon', 'public.location_reader_settings', 'INSERT')
   or has_table_privilege('authenticated', 'public.location_reader_settings', 'INSERT'))            as reader_writable_by_browser,
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'location_reader_settings')                         as reader_policies,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) as truncate_left;


-- -- ============================================================================
-- -- ROLL BACK (paste in the Platform SQL editor only if a screen breaks)
-- -- ============================================================================
-- -- HOW: copy every line from the "-- -- ====" line just above this heading to the
-- -- very end of the file and paste it into the Platform SQL editor. Select all (Cmd+A)
-- -- and press Cmd+/ once: every line loses its first "-- ", and the notes (lines that
-- -- still start with "-- ") stay notes. Then press Run.
-- -- ORDER: if Platform file 2 (20260919d) has run, roll IT back first (the ROLL BACK
-- -- block at the end of 20260919d_PLATFORM_fence_2_after_app.sql). While it is still
-- -- in, this block stops at its first step and changes nothing.
-- -- WHAT: it puts back exactly the policies and write grants this file removed, and can
-- -- run twice. (TRUNCATE, REFERENCES and TRIGGER are not given back: nothing uses them.)
-- set local lock_timeout = '3s';
-- do $rb_guard$
-- begin
--   -- File 2 is in when it has taken the browser's SELECT on this table (this file leaves it).
--   if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gift_card_purchases'
--               and policyname = 'gift_card_purchases_server')
--      and not has_table_privilege('anon', 'public.gift_card_purchases', 'SELECT') then
--     raise exception 'STOPPED, NOTHING WAS CHANGED. Platform file 2 (20260919d) is still in. Roll back file 2 first (the ROLL BACK block at the end of 20260919d_PLATFORM_fence_2_after_app.sql), then run this block again.';
--   end if;
-- end
-- $rb_guard$;
-- drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
-- create policy gift_card_purchases_service on public.gift_card_purchases for all to public using (true) with check (true);
-- drop policy if exists gift_card_purchases_server on public.gift_card_purchases;
-- drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;
-- grant insert, update, delete on table public.gift_card_purchases to anon, authenticated;
-- drop policy if exists location_reader_settings_insert on public.location_reader_settings;
-- drop policy if exists location_reader_settings_write on public.location_reader_settings;
-- create policy location_reader_settings_insert on public.location_reader_settings for insert to public with check (true);
-- create policy location_reader_settings_write on public.location_reader_settings for update to public using (true) with check (true);
-- grant insert, update, delete on table public.location_reader_settings to anon, authenticated;
-- grant insert, delete on table public.locations to anon, authenticated;
-- grant update on table public.locations to authenticated;
-- reset lock_timeout;
