-- 20260919d_PLATFORM_fence_2_after_app.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  DATABASE FENCE, STAGE 1, PLATFORM FILE 2 OF 2.                           #
-- #  ONLY AFTER these are live (docs/FENCE_STAGE_1_APP.md):                   #
-- #    P2  Back Office card reader settings save through location-admin       #
-- #        (action save_reader_settings), including the PAX idle image;       #
-- #    P3  Back Office "Online purchases" lists through gift-list             #
-- #        (action purchases, staff only), and gift-resend reads the card's   #
-- #        own code (gift_cards.code_plain), not gift_card_purchases.         #
-- #  Run 20260919c first. Outside service.                                    #
-- ############################################################################
--
-- WHAT THIS FILE CLOSES
--   * gift_card_purchases: nobody but the server reads it any more. Today anyone with
--     the public key can read every online gift purchase: names, emails, and the
--     plaintext code of every card bought online, which is spendable money.
--   * The plaintext codes kept on purchases are cleared where the card itself still
--     holds its code (nothing is lost; the card keeps it, server only).
--   * location_reader_settings: the browser writes nothing (today anyone can change
--     any venue's tip prompts or idle screen). Reads stay for the Back Office screens.
--
-- RULES: no begin or commit, runs twice safely, 3 second lock wait, verification and
-- roll back at the end.


set lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null
     or to_regclass('public.gift_card_purchases') is null then
    raise exception 'This file is for the PLATFORM project (yhzjgyrkyjabvhblqxzu). This is not it. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gift_card_purchases'
                  and policyname = 'gift_card_purchases_server') then
    raise exception 'Run 20260919c_PLATFORM_fence_1_safe_now.sql first. Nothing was changed.';
  end if;
end
$guard$;


-- 1. gift_card_purchases: server only (gap G25: on its own, not bundled with loyalty).
drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;
drop policy if exists gift_card_purchases_company_read on public.gift_card_purchases;
revoke all on table public.gift_card_purchases from anon, authenticated;

-- 2. The second copy of each online card code goes; the card keeps its own.
update public.gift_card_purchases p
   set fulfilled_code = null
  from public.gift_cards c
 where c.id = p.gift_card_id
   and p.fulfilled_code is not null
   and c.code_plain is not null
   and upper(c.code_plain) = upper(p.fulfilled_code);

comment on column public.gift_card_purchases.fulfilled_code is
  '20260919d fence: no longer readable by any browser role and cleared where gift_cards.code_plain holds the same code. gift-resend reads the card''s own code.';


-- 3. location_reader_settings: no browser writes (Back Office uses location-admin).
drop policy if exists location_reader_settings_insert on public.location_reader_settings;
drop policy if exists location_reader_settings_write on public.location_reader_settings;
revoke insert, update, delete on table public.location_reader_settings from anon, authenticated;

reset lock_timeout;


-- V. Verification (read only). Expect: gift_policies = gift_card_purchases_server ALL,
-- gift_readable_by_browser = false, codes_left = kept_because_card_has_no_code,
-- reader_policies = location_reader_settings_read SELECT, reader_writable_by_browser = false.
select
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'gift_card_purchases')                          as gift_policies,
  has_table_privilege('anon', 'public.gift_card_purchases', 'SELECT')                            as gift_readable_by_browser,
  (select count(*) from public.gift_card_purchases where fulfilled_code is not null)             as codes_left,
  (select count(*) from public.gift_card_purchases p
     left join public.gift_cards c on c.id = p.gift_card_id
    where p.fulfilled_code is not null and (c.id is null or c.code_plain is null))              as kept_because_card_has_no_code,
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'location_reader_settings')                     as reader_policies,
  (has_column_privilege('anon', 'public.location_reader_settings', 'tip_percentages', 'UPDATE')
   or has_table_privilege('anon', 'public.location_reader_settings', 'INSERT'))                 as reader_writable_by_browser;


-- ROLL BACK (paste in the Platform SQL editor only if a Back Office screen breaks)
-- set lock_timeout = '3s';
-- create policy gift_card_purchases_read_interim on public.gift_card_purchases for select to anon, authenticated using (true);
-- create policy gift_card_purchases_company_read on public.gift_card_purchases for select to public
--   using (company_id in (select user_company_roles.company_id from user_company_roles where user_company_roles.user_id = auth.uid()));
-- grant select on table public.gift_card_purchases to anon, authenticated;
-- create policy location_reader_settings_insert on public.location_reader_settings for insert to public with check (true);
-- create policy location_reader_settings_write on public.location_reader_settings for update to public using (true) with check (true);
-- grant insert (location_id, tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor,
--               idle_screen_enabled, idle_screen_image_url) on public.location_reader_settings to anon, authenticated;
-- grant update (location_id, tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor,
--               idle_screen_enabled, idle_screen_image_url) on public.location_reader_settings to anon, authenticated;
-- reset lock_timeout;
-- The cleared codes do not come back; each card still holds its own (gift_cards.code_plain).
