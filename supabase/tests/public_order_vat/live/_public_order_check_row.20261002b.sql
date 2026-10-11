CREATE OR REPLACE FUNCTION public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text, p_check jsonb, p_items jsonb, p_customer jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$;
