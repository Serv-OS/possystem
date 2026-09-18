-- 20260918b_PLATFORM_gift_purchases_clear_codes.sql
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Run AFTER gift-resend and gift-list from branch                         #
-- #  fix/loyalty-giftcard-exposure are deployed (they read the card's own    #
-- #  code, gift_cards.code_plain). Before that, Back Office Resend would say #
-- #  "No code stored" for these purchases. Idempotent.                       #
-- ############################################################################
--
-- WHY (18 Sep 2026). gift_card_purchases.fulfilled_code kept a second plaintext copy of every
-- online gift card code, in the table the anon key could read. gift-fulfill no longer writes it
-- (code_last4 only). This clears the old copies. Nothing is lost: each purchase's card keeps its
-- code on gift_cards (code_plain), which only the service role reads; the only rows whose code
-- would be lost are purchases whose card is gone or has no code_plain, and those are left alone
-- and counted below.

do $guard$
begin
  if to_regclass('public.gift_card_purchases') is null
     or to_regclass('public.user_locations') is not null then
    raise exception 'This is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu). Wrong database, nothing changed.';
  end if;
end
$guard$;

update public.gift_card_purchases p
   set fulfilled_code = null
  from public.gift_cards c
 where c.id = p.gift_card_id
   and p.fulfilled_code is not null
   and c.code_plain is not null
   and upper(c.code_plain) = upper(p.fulfilled_code);

-- VISIBLE RESULT. Expect codes_left = kept_because_card_has_no_code (normally 0).
select
  (select count(*) from public.gift_card_purchases where fulfilled_code is not null) as codes_left,
  (select count(*) from public.gift_card_purchases p
     left join public.gift_cards c on c.id = p.gift_card_id
    where p.fulfilled_code is not null and (c.id is null or c.code_plain is null))  as kept_because_card_has_no_code;
