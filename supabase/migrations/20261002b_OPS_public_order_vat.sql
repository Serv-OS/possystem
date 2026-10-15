-- 20261002b_OPS_public_order_vat.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Safe any time, service included. Replaces ONE function, nothing else.    #
-- #  No table changes, no data changes. Takes under a second.                 #
-- ############################################################################
--
-- WHY (found 2 Oct 2026 at Coffee Boy Leeds while fixing the QR table bug; Peter's rule: VAT must
-- be right on every channel, because the reports, the Z, the Tax summary and the Xero daily
-- invoice all read it)
--   QR order QR-FAUOB (5.60, paid on the phone, Adyen) was booked by the server as closed check
--   chk-1790937346153-4st with tax_amount 0. Every till sale that day carried VAT.
--
-- WHAT WENT WRONG
--   The phone works out the VAT with the same tax engine as the till and sends it with the paid
--   check. It sends the raw figure, not pence: 5.60 at 20% goes up as 0.9333333333333327.
--   The server reads every number on a public check through _fence_num, which only accepts up
--   to 6 decimal places and answers 0 for anything else. So the VAT was thrown away and the
--   check was booked with tax_amount 0, which every report reads as "zero rated", not as
--   "unknown". A sale whose VAT happens to be short got through: 3.75 at Huddersfield on
--   29 Sep sent 0.625 and was booked 0.63. That is why it looked random.
--   It has been like this since the public order functions went live (20260919a2, 20 Sep) for
--   every online order, QR pay now order and catering order paid online. A QR tab closed on the
--   phone was not affected (settle_qr_tab reads the number properly since 20260927c). Kiosk and
--   till sales never go through this function.
--
--   Second fault, same line of the same function: it kept a tax breakdown only when the page
--   sent a LIST. No page ever sends a list. The till, the kiosk and the pages all use one
--   record: { totalTax, breakdown: [ one entry per rate ], hasExclusiveTax, ... }. So the named
--   tax lines of a US order (added on sales tax) were dropped as well, and a UK order could
--   never carry its split by rate.
--
-- WHAT THIS FILE DOES (public._public_order_check_row, the one function that builds the check
-- for place_public_order, verify_public_order_payment and confirm_public_order_payment)
--   tax_amount     a JSON number is taken as it is, at any number of decimals, rounded to pence,
--                  never below 0 and never above the goods the SERVER priced at full price. Text
--                  that is a plain number is taken the same way. Anything else books "not
--                  recorded" (null), never a false 0.
--                  WHAT THE CEILING IS NOT: it is a backstop against a nonsense figure, not a
--                  check that the VAT fits the money the check books. This function does not
--                  know the total (_public_order_write_check sets it afterwards). See KNOWN
--                  LIMITS below.
--   tax_breakdown  the till's record is kept when the page sends one (it must carry a number
--                  for totalTax and a list of rates, and be small). A list is kept as before.
--                  Anything else is the empty list, as before.
--   Nothing else in the function changes. The money rules in _public_order_write_check are not
--   touched and read the row exactly as they do today.
--
-- UK AND US
--   UK (VAT inside the price) and US (sales tax added on, tax profiles) are both handled, by the
--   same change: the figure and the breakdown are the page's own, worked out by the one tax
--   engine the till uses (src/lib/taxCompute.js). The server does no tax maths of its own. A
--   second copy of the tax rules in SQL would drift from the till's.
--
-- KNOWN LIMITS (found in review, 2 Oct 2026; none is made worse by this file, none is new money)
--   1. A check booked for LESS than its goods keeps the VAT of the whole goods. Example: a pay
--      now order of 5.60 that staff confirm for 2.00 (confirm_public_order_payment with a part
--      amount), or a card that captured less than was due, books total 2.00 with VAT 0.93 where
--      0.33 is right. settle_qr_tab already scales the VAT in that case (20260927c); this path
--      does not, because the total is set in _public_order_write_check. Follow up: scale it
--      there, by the same rule. Rare, and until today the same sale booked VAT 0.
--   2. A QR order with an automatic offer placed from a page opened BEFORE the app release that
--      goes with this file sends the VAT of the full menu price (the page's fault, fixed in the
--      release: src/lib/publicCheckTax.js offerChargedTax). The server cannot tell, so it books
--      what it is sent. QR pages are opened fresh at the table, so this lasts hours at most.
--
-- BEFORE AND AFTER IT RUNS
--   Before: an online, QR pay now or catering order books tax_amount 0 unless its VAT has 6
--   decimals or fewer. After: it books the VAT the customer was shown, on every page already
--   open on a phone, with no app release needed. The app release that goes with this
--   (src/lib/publicCheckTax.js) also sends the split by rate, which only sticks once this file
--   has run.
--   Sales already booked with 0 are NOT changed here: see
--   supabase/data_fixes/20261002_public_order_vat_backfill.sql.
--
-- Rollback: 20261002b_OPS_public_order_vat_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
declare
  v_src text;
begin
  if to_regclass('public.closed_checks') is null then
    raise exception 'This is not the Ops database (closed_checks is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)') is null
     or to_regprocedure('public._fence_num(text)') is null then
    raise exception 'The public order functions (20260919a2) are not here. Nothing was changed.';
  end if;
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure;
  -- Only ever replace the version this file was written against (20260919a2, read from the live
  -- database on 2 Oct 2026), or this file's own version on a second run.
  if md5(v_src) <> 'd75208a18dd7717d17623571888880f2' and position('20261002b' in v_src) = 0 then
    raise exception 'public._public_order_check_row is not the version this file was written against. Nothing was changed. Send Claude this message.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- The closed check of a public order, exactly as 20260919a2 wrote it, with two entries changed:
-- tax_breakdown and tax_amount. Its grants (service role only) are kept by create or replace.
create or replace function public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text,
                                                          p_check jsonb, p_items jsonb, p_customer jsonb)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
      'id', left(coalesce(nullif(btrim(p_check ->> 'id'), ''), 'chk-' || p_source || '-' || p_ref), 80),
      'ref', p_ref,
      'location_id', p_loc,
      'table_id', left(p_check ->> 'table_id', 80),
      'table_label', left(p_check ->> 'table_label', 80),
      'staff_name', null,
      'items', coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then x || '{"voided": false}'::jsonb else x end
                                          order by n)
                           from jsonb_array_elements(p_items) with ordinality as i(x, n)), '[]'::jsonb),
      'subtotal', round(public._fence_num(p_check ->> 'subtotal'), 2),
      'tax', round(public._fence_num(p_check ->> 'tax'), 2),
      'payment_method', left(p_check ->> 'payment_method', 200),
      'covers', greatest(1, least(99, public._fence_num(p_check ->> 'covers')::int)),
      'voided', false,
      'refunded', false,
      'server', left(coalesce(nullif(p_check ->> 'server', ''), initcap(p_source)), 40),
      'order_type', left(coalesce(nullif(p_check ->> 'order_type', ''), p_type), 40),
      'customer', case when jsonb_typeof(p_check -> 'customer') = 'object'
                       then (p_check -> 'customer') - 'paid' - 'staff' - 'payment_state' - 'payment_unverified'
                            - 'payment_confirmed_by' - 'order_pricing' - 'placed_via'
                       else p_customer end,
      'discounts', case when jsonb_typeof(p_check -> 'discounts') = 'array' then p_check -> 'discounts' else '[]'::jsonb end,
      'service', round(public._fence_num(p_check ->> 'service'), 2),
      'tip', round(public._fence_num(p_check ->> 'tip'), 2),
      'method', left(coalesce(nullif(p_check ->> 'method', ''), 'card'), 40),
      'refunds', '[]'::jsonb,
      -- 20261002b: THE TAX RECORD. Every page, the kiosk and the till write ONE record, not a
      -- list: { totalTax, breakdown: [ one entry per rate ], hasExclusiveTax, ... }
      -- (src/lib/taxCompute.js). Only a list was kept before, and no page sends a list, so the
      -- split by rate (UK) and the named sales tax lines (US) never reached the check. The
      -- record is kept when it carries a number for totalTax and a list of rates and is small.
      -- _public_order_write_check reads this entry only when it is a list, so its money rules
      -- see exactly what they saw before.
      'tax_breakdown', case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown'
                            when jsonb_typeof(p_check -> 'tax_breakdown') = 'object'
                                 and jsonb_typeof(p_check -> 'tax_breakdown' -> 'totalTax') = 'number'
                                 and jsonb_typeof(p_check -> 'tax_breakdown' -> 'breakdown') = 'array'
                                 and length((p_check -> 'tax_breakdown')::text) <= 20000
                            then p_check -> 'tax_breakdown'
                            else '[]'::jsonb end,
      -- 20261002b: THE VAT. The page's own figure, from the same tax engine as the till. It
      -- arrives as a raw number (5.60 at 20% is 0.9333333333333327) and _fence_num answers 0
      -- for anything past 6 decimals, so the check was booked with tax_amount 0 (QR-FAUOB,
      -- Coffee Boy Leeds, 2 Oct 2026). A JSON number is now taken as it is (as settle_qr_tab
      -- does since 20260927c), rounded to pence, never below 0 and never above the goods the
      -- SERVER priced (p_items: price plus modifiers, times quantity, as _public_order_value
      -- counts them). Text that is a plain number is taken the same way. Anything else is
      -- "not recorded" (null): a 0 here means zero rated to every report.
      -- The ceiling is a backstop only: the total is set later, in _public_order_write_check,
      -- so a check booked for less than its goods keeps this figure (KNOWN LIMITS in the header).
      'tax_amount', case
                      when jsonb_typeof(p_check -> 'tax_amount') = 'number'
                        or (jsonb_typeof(p_check -> 'tax_amount') = 'string'
                            and p_check ->> 'tax_amount' ~ '^\s*[0-9]{1,12}(\.[0-9]{1,30})?\s*$')
                      then least(
                             greatest(round(btrim(p_check ->> 'tax_amount')::numeric, 2), 0),
                             (select round(coalesce(sum(
                                       (public._fence_num(x ->> 'price')
                                        + coalesce((select sum(public._fence_num(m ->> 'price'))
                                                      from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array'
                                                                                     then x -> 'mods' else '[]'::jsonb end) m), 0))
                                       * (case when public._fence_num(x ->> 'qty') > 0
                                               then least(public._fence_num(x ->> 'qty'), 999) else 1 end)), 0), 2)
                                from jsonb_array_elements(p_items) x
                               where jsonb_typeof(x) = 'object'))
                    end,
      'source', p_source,
      'gift_card', case when jsonb_typeof(p_check -> 'gift_card') = 'object' then p_check -> 'gift_card' end,
      'loyalty', case when jsonb_typeof(p_check -> 'loyalty') = 'object' then p_check -> 'loyalty' end,
      'promo', case when jsonb_typeof(p_check -> 'promo') = 'object' then p_check -> 'promo' end,
      'stripe_payment_intent_id', left(p_check ->> 'stripe_payment_intent_id', 120),
      'payment_intents', case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' end,
      -- v5.9.11 (rebase, fix round 3): what paid the check, one entry per tender
      -- (src/lib/accounting/tenders.js). The accounting layer posts card, cash, gift card and
      -- credits from this, so a check written here must carry it or a QR, online or catering
      -- sale lands in Unallocated. The page builds it from what it really charged, like
      -- gift_card, loyalty and promo beside it; _public_order_write_check falls back to one
      -- card tender for the money the server itself proved, so the column is never empty.
      'tenders', case when jsonb_typeof(p_check -> 'tenders') = 'array'
                       and jsonb_array_length(p_check -> 'tenders') > 0
                      then p_check -> 'tenders' end,
      'processor', case when p_check ->> 'processor' in ('stripe', 'ryft', 'adyen') then p_check ->> 'processor' else 'stripe' end,
      'customer_phone', left(p_check ->> 'customer_phone', 40),
      'closed_at_wanted', p_check ->> 'closed_at');
$fn$;

-- create or replace keeps the grants; said again so the file stands on its own.
revoke all on function public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ============================================================================
-- Self test: the real case, and the edges. Any failure aborts the whole paste,
-- so the old function stays.
-- ============================================================================
do $test$
declare
  v_items jsonb := '[{"name": "Mont Blanc", "price": 5.60, "qty": 1, "mods": []}]'::jsonb;
  v_two   jsonb := '[{"name": "Latte", "price": 4.10, "qty": 2, "mods": [{"label": "Oat", "price": 0.50}]}]'::jsonb;   -- goods 9.20
  v_rec   jsonb := '{"totalTax": 0.9333333333333327, "hasExclusiveTax": false, "breakdown": [{"tax": 0.9333333333333327, "gross": 5.6, "rate": {"rate": 0.2, "type": "inclusive"}}]}'::jsonb;
  r       jsonb;
begin
  -- QR-FAUOB: what the phone really sent.
  r := public._public_order_check_row('loc', 'QR-T1', 'qr', 'dine-in', '{"tax_amount": 0.9333333333333327}'::jsonb, v_items, '{}'::jsonb);
  if (r ->> 'tax_amount')::numeric is distinct from 0.93 then
    raise exception 'Self test 1: 5.60 at 20%% must book 0.93, got %. Nothing was changed.', r ->> 'tax_amount';
  end if;
  -- 5.85 at 20%: the till books 0.97 (the raw figure is 0.9749999999999996), so does this.
  r := public._public_order_check_row('loc', 'QR-T2', 'qr', 'dine-in', '{"tax_amount": 0.9749999999999996}'::jsonb,
                                      '[{"price": 5.85, "qty": 1}]'::jsonb, '{}'::jsonb);
  if (r ->> 'tax_amount')::numeric is distinct from 0.97 then
    raise exception 'Self test 2: got %. Nothing was changed.', r ->> 'tax_amount';
  end if;
  -- Already pence, a real zero, and text that is a plain number.
  if (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": 0.63}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0.63
     or (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": 0}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0
     or (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": "0.9333333333333327"}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0.93 then
    raise exception 'Self test 3: pence, zero or text number not booked as sent. Nothing was changed.';
  end if;
  -- Not sent, null, or not a number: not recorded, never a false 0.
  if public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": null}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": "lots"}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": {"a": 1}}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null then
    raise exception 'Self test 4: a missing or unreadable VAT must be null. Nothing was changed.';
  end if;
  -- A page cannot book less than 0 or more than the goods the server priced.
  if (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": -3}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 999}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 5.60
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 999}'::jsonb, v_two, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 9.20
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 1.5333333333333334}'::jsonb, v_two, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 1.53 then
    raise exception 'Self test 5: the VAT is not kept between 0 and the goods. Nothing was changed.';
  end if;
  -- The tax record: the till's shape is kept, a list is kept, anything else is the empty list.
  if public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', jsonb_build_object('tax_breakdown', v_rec), v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from v_rec
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": [{"tax": 2}]}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[{"tax": 2}]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": {"totalTax": "1", "breakdown": []}}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": {"totalTax": 1}}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": "x"}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in',
          jsonb_build_object('tax_breakdown', jsonb_build_object('totalTax', 1, 'breakdown', '[]'::jsonb, 'pad', repeat('x', 20000))),
          v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb then
    raise exception 'Self test 6: the tax record is not kept or refused as designed. Nothing was changed.';
  end if;
  -- Nothing else moved: the other entries of the row, for the real case.
  r := public._public_order_check_row('loc', 'QR-T7', 'qr', 'dine-in',
         '{"id": "chk-1", "subtotal": 5.6, "tip": 0.5, "service": 0, "method": "card", "processor": "adyen", "tax_amount": 0.9333333333333327}'::jsonb,
         v_items, '{"name": "x"}'::jsonb);
  if r ->> 'id' <> 'chk-1' or r ->> 'ref' <> 'QR-T7' or r ->> 'source' <> 'qr' or (r ->> 'subtotal')::numeric <> 5.60
     or (r ->> 'tip')::numeric <> 0.50 or r ->> 'processor' <> 'adyen' or r -> 'items' -> 0 ->> 'voided' <> 'false'
     or r -> 'customer' ->> 'name' <> 'x' then
    raise exception 'Self test 7: another entry of the check row changed. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)', 'execute') then
    raise exception 'Self test 8: the function became callable from a phone. Nothing was changed.';
  end if;
end
$test$;

-- VISIBLE CHECK (the SQL editor shows this last result): one row, all four true, and
-- qr_fauob_would_now_book = 0.93.
select
  position('20261002b' in p.prosrc) > 0 as new_version_is_live,
  (public._public_order_check_row('loc', 'QR-CHECK', 'qr', 'dine-in', '{"tax_amount": 0.9333333333333327}'::jsonb,
                                  '[{"price": 5.60, "qty": 1}]'::jsonb, '{}'::jsonb) ->> 'tax_amount')::numeric as qr_fauob_would_now_book,
  jsonb_typeof(public._public_order_check_row('loc', 'QR-CHECK', 'qr', 'dine-in',
                 '{"tax_breakdown": {"totalTax": 0.93, "breakdown": [{"tax": 0.93}]}}'::jsonb,
                 '[{"price": 5.60, "qty": 1}]'::jsonb, '{}'::jsonb) -> 'tax_breakdown') = 'object' as split_by_rate_is_kept,
  not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') as not_callable_from_a_phone,
  has_function_privilege('service_role', p.oid, 'execute') as server_can_still_call_it
from pg_proc p
where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure;
