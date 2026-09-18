-- 20260918_PLATFORM_gift_purchases_server_only.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Peter runs this in the SQL editor. Idempotent, no transaction wrapper.   #
-- #  Safe before OR after the code of branch fix/loyalty-giftcard-exposure.   #
-- ############################################################################
--
-- WHY (18 Sep 2026, lockdown step 1). gift_card_purchases has the policy
-- gift_card_purchases_service FOR ALL TO public USING (true) WITH CHECK (true). `public` includes
-- anon, so the Platform anon key (it ships in every web bundle) could:
--   * read every row of every company: sender and recipient names and emails, and
--     fulfilled_code, the plaintext 16 character code of every online gift card, spendable;
--   * write status (and amount, session ids) to replay or fake a fulfilment.
-- 20260805c B5b and 20260907b PLATFORM file 2 wrote this fix and left it waiting, because Back
-- Office "Online purchases" read the table with that anon client.
--
-- WHAT THIS DOES
--   1. Drops gift_card_purchases_service (public) and gift_card_purchases_company_read (inert:
--      the browser never holds a Platform JWT), and allows ONLY the service role, which the
--      edge functions use (gift-checkout-session, gift-fulfill, gift-purchase-status,
--      gift-resend, gift-list, stripe-webhook-connect, ryft-webhook).
--   2. Takes every table privilege on it away from anon and authenticated, so a pasted
--      permissive policy cannot silently reopen it.
-- It does NOT clear the codes already stored: run 20260918b_PLATFORM_gift_purchases_clear_codes.sql
-- after the new gift-resend and gift-list are deployed (they read the card's own code instead).
--
-- WHAT CHANGES ON SCREEN: Back Office -> Gift cards -> Online purchases reads through gift-list
-- (staff only) with the branch's code. If this runs before that code is live, the tab shows an
-- empty list until it is (nothing is lost). Buying a gift card online, the success page and the
-- emailed card are unchanged: every one of those paths is already an edge function.

do $guard$
begin
  if to_regclass('public.gift_card_purchases') is null
     or to_regclass('public.user_locations') is not null then
    raise exception 'This is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu). Wrong database, nothing changed.';
  end if;
end
$guard$;

alter table public.gift_card_purchases enable row level security;

drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
drop policy if exists gift_card_purchases_company_read on public.gift_card_purchases;
create policy gift_card_purchases_service on public.gift_card_purchases
  for all to service_role using (true) with check (true);

revoke all on table public.gift_card_purchases from anon, authenticated;

comment on column public.gift_card_purchases.fulfilled_code is
  '18 Sep 2026: no longer written (gift-fulfill stores code_last4 only; the code lives on gift_cards.code_plain, service role only). Old values are cleared by 20260918b. Never readable by anon or authenticated.';

-- VISIBLE RESULT. Expect: 1 policy, to {service_role}; 0 browser grants.
select
  (select string_agg(policyname || ' ' || cmd || ' ' || roles::text, '; ')
     from pg_policies where schemaname = 'public' and tablename = 'gift_card_purchases') as policies,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'gift_card_purchases'
      and grantee in ('anon', 'authenticated'))                                        as browser_grants_left;
