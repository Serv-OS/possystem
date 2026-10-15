-- ROLLBACK for 20261002b_OPS_public_order_vat.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Puts public._public_order_check_row back exactly as 20260919a2 wrote it (the version that was
-- live until 2 Oct 2026). After this, an online, QR pay now or catering order books tax_amount 0
-- again whenever the page sends its VAT with more than 6 decimals, and the split by rate is
-- dropped again. Sales booked while the new version was live keep their VAT.
--
-- The app does not need rolling back with it: the pages that go with 20261002b send the VAT in
-- pence, which the old function reads correctly.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.closed_checks') is null
     or to_regprocedure('public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)') is null then
    raise exception 'This is not the Ops database (the public order functions are missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

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
      'tax_breakdown', case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown' else '[]'::jsonb end,
      'tax_amount', case when p_check ? 'tax_amount' and p_check ->> 'tax_amount' is not null
                         then round(public._fence_num(p_check ->> 'tax_amount'), 2) end,
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

revoke all on function public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- VISIBLE CHECK: both true.
select
  md5(p.prosrc) = 'd75208a18dd7717d17623571888880f2' as old_version_is_back,
  not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') as not_callable_from_a_phone
from pg_proc p
where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure;
