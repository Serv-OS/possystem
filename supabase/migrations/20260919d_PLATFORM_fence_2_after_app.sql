-- 20260919d_PLATFORM_fence_2_after_app.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  DATABASE FENCE, STAGE 1, PLATFORM FILE 2 OF 2.                           #
-- #  ONLY AFTER these are live (docs/FENCE_STAGE_1_APP.md):                   #
-- #    P3  Back Office "Online purchases" lists through gift-list             #
-- #        (action purchases, staff only), and gift-resend reads the card's   #
-- #        own code (gift_cards.code_plain), not gift_card_purchases.         #
-- #  Run 20260919c first. Outside service.                                    #
-- #  BEFORE running it, run the read only gift card count at the end of this  #
-- #  file and write the number down (runbook step 5).                         #
-- ############################################################################
--
-- WHAT THIS FILE CLOSES
--   * gift_card_purchases: nobody but the server reads it any more. Until now anyone
--     with the public key could read every online gift purchase: names, emails, and the
--     plaintext code of every card bought online, which is spendable money.
--   * The plaintext codes kept on purchases are cleared where the card itself still
--     holds its code (nothing is lost; the card keeps it, server only).
--   (location_reader_settings browser writes were already closed by 20260919c.)
--
-- WHAT IT CANNOT DO: codes that were readable until now may already have been copied.
-- This file does not void or change any card (that is the owner's decision). The
-- read only queries at the end count and list the cards bought online before the
-- fence that still hold money, per company, for owner review (runbook step 5).
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
    raise exception 'Run 20260919c_PLATFORM_fence_1_after_release.sql first. Nothing was changed.';
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

reset lock_timeout;


-- V. Verification (read only). Expect: gift_policies = gift_card_purchases_server ALL,
-- gift_readable_by_browser = false, codes_left = kept_because_card_has_no_code,
-- reader_writable_by_browser = false.
select
  (select string_agg(policyname || ' ' || cmd, ', ' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'gift_card_purchases')                          as gift_policies,
  has_table_privilege('anon', 'public.gift_card_purchases', 'SELECT')                            as gift_readable_by_browser,
  (select count(*) from public.gift_card_purchases where fulfilled_code is not null)             as codes_left,
  (select count(*) from public.gift_card_purchases p
     left join public.gift_cards c on c.id = p.gift_card_id
    where p.fulfilled_code is not null and (c.id is null or c.code_plain is null))              as kept_because_card_has_no_code,
  (has_column_privilege('anon', 'public.location_reader_settings', 'tip_percentages', 'UPDATE')
   or has_table_privilege('anon', 'public.location_reader_settings', 'INSERT'))                 as reader_writable_by_browser;


-- GIFT CARDS WHOSE CODE WAS READABLE BEFORE THE FENCE (read only, paste one at a time).
-- Every card bought online before this file had its code on gift_card_purchases, which
-- anyone could read. These queries show which of those cards still hold money. They
-- change nothing and show no code, name or email.
--
-- 1. How many, per company (run it BEFORE this file too, and write the numbers down).
--    Cards bought after the release never had their code copied onto the purchase; to
--    leave them out add: and p.fulfilled_at < 'YYYY-MM-DD' (the day of the release).
-- select c.company_id, count(*) as live_cards, sum(c.balance_minor) as balance_minor
--   from public.gift_card_purchases p
--   join public.gift_cards c on c.id = p.gift_card_id
--  where p.fulfilled_at is not null
--    and c.status = 'active' and c.voided_at is null and c.balance_minor > 0
--    and (c.expires_at is null or c.expires_at > now())
--  group by c.company_id order by 2 desc;
--
-- 2. The list for an owner to review (card id, last 4, balance, bought, last used):
-- select c.company_id, c.id as card_id, c.code_last4, c.balance_minor, c.initial_amount_minor,
--        p.created_at::date as bought_on,
--        (select max(t.created_at)::date from public.gift_card_transactions t where t.card_id = c.id) as last_used
--   from public.gift_card_purchases p
--   join public.gift_cards c on c.id = p.gift_card_id
--  where p.fulfilled_at is not null
--    and c.status = 'active' and c.voided_at is null and c.balance_minor > 0
--    and (c.expires_at is null or c.expires_at > now())
--  order by c.company_id, p.created_at;
--
-- THE SAFE OPTION (proposed, not done here): flag each of these cards for its owner.
-- Nothing is voided. For each company the owner decides, card by card: leave it, or
-- (for a card that looks at risk, for example spent in an unusual place) issue the buyer
-- a new card for the same balance in Back Office, Gift cards, and void the old one.
-- Watch these cards in Gift cards for unexpected redemptions for the next 30 days.


-- -- ============================================================================
-- -- ROLL BACK (paste in the Platform SQL editor only if a Back Office screen breaks)
-- -- ============================================================================
-- -- HOW: copy every line from the "-- -- ====" line just above this heading to the
-- -- very end of the file and paste it into the Platform SQL editor. Select all (Cmd+A)
-- -- and press Cmd+/ once: every line loses its first "-- ", and the notes (lines that
-- -- still start with "-- ") stay notes. Then press Run.
-- -- WHAT: it puts back exactly the read policies and grants this file removed, and can
-- -- run twice. The cleared codes do not come back; each card still holds its own
-- -- (gift_cards.code_plain).
-- set lock_timeout = '3s';
-- drop policy if exists gift_card_purchases_read_interim on public.gift_card_purchases;
-- drop policy if exists gift_card_purchases_company_read on public.gift_card_purchases;
-- create policy gift_card_purchases_read_interim on public.gift_card_purchases for select to anon, authenticated using (true);
-- create policy gift_card_purchases_company_read on public.gift_card_purchases for select to public
--   using (company_id in (select user_company_roles.company_id from user_company_roles where user_company_roles.user_id = auth.uid()));
-- grant select on table public.gift_card_purchases to anon, authenticated;
-- reset lock_timeout;
