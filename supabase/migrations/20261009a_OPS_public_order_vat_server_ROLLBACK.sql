-- ROLLBACK for 20261009a_OPS_public_order_vat_server.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Puts public._public_order_check_row back exactly as 20261002b left it and public.settle_qr_tab
-- back exactly as 20260927c left it (both read from the live database on 8 Oct 2026, byte for
-- byte: the md5 checks at the bottom prove it), and drops the four helpers 20261009a added.
-- After this the server books whatever VAT the page sends again (null when it sends none), and a
-- QR tab close carries no split by rate. Sales booked while 20261009a was live keep their VAT.
--
-- The app does not need rolling back with it: the pages that go with 20261009a wait for the venue
-- rates and send the VAT in pence, which both old functions read correctly.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.closed_checks') is null
     or to_regprocedure('public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)') is null
     or to_regprocedure('public.settle_qr_tab(uuid, text, jsonb, uuid[])') is null then
    raise exception 'This is not the Ops database (the public order functions are missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- public._public_order_check_row as 20261002b wrote it (the page's figure, rounded and clamped; its record kept).
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

revoke all on function public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- public.settle_qr_tab as 20260927c wrote it (the phone's figure, clamped; no split by rate).
create or replace function public.settle_qr_tab(
  p_location_id       uuid,
  p_payment_intent_id text,
  p_check             jsonb default '{}'::jsonb,
  p_proof_ids         uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid        uuid := auth.uid();
  v_loc        text := p_location_id::text;
  v_refs       text[];
  v_first      public.order_queue%rowtype;
  v_tab_ref    text;
  v_ids        uuid[];
  v_taken      bigint := 0;
  v_balance    bigint := 0;
  v_check_id   text;
  v_cc         jsonb;
  v_items      jsonb;
  v_goods      bigint := 0;
  v_tip        numeric;
  v_booked     numeric;
  v_tax        numeric;          -- 20260927c: the VAT this check books (null = none sent)
  v_added      numeric := 0;     -- 20260927c: the added-on (US) part of it
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;
  if coalesce(p_payment_intent_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  -- Lock the tab's rounds first, so two phones closing the same tab one after the other
  -- get "already closed", never a second check.
  perform 1 from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr'
     and public._fence_bool(q.customer ->> 'tab_open')
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id
   for update;
  select array_agg(q.ref order by q.created_at) into v_refs
    from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
     and public._fence_bool(q.customer ->> 'tab_open')
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id;
  if v_refs is null then
    return jsonb_build_object('ok', true, 'closed', 0, 'reason', 'already_closed');
  end if;
  if not (public._qr_tab_is_member(v_loc, p_payment_intent_id, v_uid)
          or public.pos_can_access(v_loc) or public.is_super_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours',
                              'message', 'Only the person who opened this tab, someone who joined it, or staff can close it.');
  end if;
  select * into v_first from public.order_queue q
   where q.location_id = v_loc and q.ref = v_refs[1];
  v_tab_ref := coalesce(v_first.customer ->> 'tab_ref', v_first.ref);

  -- This tab's own money.
  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_ids
    from public.payment_proofs p
   where p.location_id = v_loc
     and p.used_by_ref is null
     and ((p.kind = 'capture' and p.payment_ref = p_payment_intent_id)
          or (p.kind = 'card' and p.id = any(coalesce(p_proof_ids, '{}'::uuid[]))
              and (p.meta ->> 'order_ref' = v_tab_ref
                   or p.meta ->> 'order_ref' = any(v_refs)
                   or p.meta ->> 'parent_ref' = p_payment_intent_id)));
  perform 1 from public.payment_proofs p where p.id = any(v_ids) for update;
  select coalesce(sum(p.amount_minor), 0) into v_taken from public.payment_proofs p where p.id = any(v_ids);
  if v_taken <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_captured',
                              'message', 'We could not confirm the payment yet. Please try again, or ask a member of staff.');
  end if;

  -- The tab's balance as the server values it.
  select coalesce(sum(greatest(round(q.total * 100)::bigint,
                               coalesce((q.customer -> 'order_pricing' ->> 'value_minor')::bigint,
                                        (public._public_order_value(v_loc, 'qr', q.type, q.items,
                                                                    q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint))), 0)
    into v_balance
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  if v_taken < v_balance then
    update public.order_queue
       set customer = customer
                      || jsonb_build_object('payment_state', 'short', 'payment_unverified', true,
                                            'tab_close_short', jsonb_build_object('paid_minor', v_taken, 'due_minor', v_balance,
                                                                                  'at', now()))
     where location_id = v_loc and ref = any(v_refs);
    return jsonb_build_object('ok', false, 'reason', 'short', 'paid_minor', v_taken, 'due_minor', v_balance,
                              'message', 'Your card paid part of this tab. A member of staff will settle the rest with you.');
  end if;

  select coalesce(jsonb_agg(e.item), '[]'::jsonb) into v_items
    from public.order_queue q
    cross join lateral jsonb_array_elements(case when jsonb_typeof(q.items) = 'array' then q.items else '[]'::jsonb end) as e(item)
   where q.location_id = v_loc and q.ref = any(v_refs);
  -- THE TIP IS CAPPED AT WHAT WAS TAKEN OVER THE GOODS (fix round 5, 19 Sep). The tip was the
  -- one money field on a QR check still decided by the phone: a tab of one 95 pound Feast
  -- placed with customer.tip = 95 and a genuine 9500 capture booked subtotal 0.00 and tip
  -- 95.00, so the venue booked no sale at all and then paid 95 pounds of its OWN takings out
  -- through tronc and the P&L. A tip can only be money taken ABOVE the server's own value of
  -- the rounds: goods less the venue's automatic deals (a round's order_pricing, or the
  -- server's own valuation for a round an old page placed). A page that declares more than
  -- that has the rest booked as the sale it is.
  select coalesce(sum(greatest(0, coalesce((q.customer -> 'order_pricing' ->> 'goods_minor')::bigint,
                                           (public._public_order_value(v_loc, 'qr', q.type, q.items,
                                                                       q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint, 0)
                                  - coalesce((q.customer -> 'order_pricing' ->> 'auto_minor')::bigint, 0))), 0)
    into v_goods
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  select coalesce(sum(public._fence_num(q.customer ->> 'tip')), 0) into v_tip
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  v_tip := least(greatest(0, v_tip), greatest(0, round((v_taken - v_goods)::numeric / 100, 2)));
  v_booked := round(v_taken::numeric / 100, 2);

  -- 20260927c: THE VAT. The page's own figure (the server has no tax maths), taken only when it
  -- is a JSON number, clamped to the goods this check books; the added-on part is clamped to it.
  if jsonb_typeof(p_check -> 'tax_amount') = 'number' then
    v_tax := least(greatest(round((p_check ->> 'tax_amount')::numeric, 2), 0),
                   greatest(0, v_booked - least(v_tip, v_booked)));
    if jsonb_typeof(p_check -> 'exclusive_tax') = 'number' then
      v_added := least(greatest(round((p_check ->> 'exclusive_tax')::numeric, 2), 0), v_tax);
    end if;
  end if;

  update public.order_queue
     set status = 'collected',
         customer = customer - 'payment_unverified' - 'payment_state' - 'tab_close_short'
   where location_id = v_loc and ref = any(v_refs);

  v_check_id := 'chk-qr-' || left(md5(v_loc || ':' || p_payment_intent_id), 16);
  if not exists (select 1 from public.closed_checks c where c.id = v_check_id) then
    v_cc := jsonb_build_object(
      'id', v_check_id,
      'ref', v_tab_ref,
      'location_id', v_loc,
      'table_id', null,
      'table_label', left(coalesce(p_check ->> 'table_label', 'Table ' || coalesce(v_first.customer ->> 'tableLabel', '')), 80),
      'items', v_items,
      'subtotal', greatest(0, v_booked - v_tip - v_added),
      'tax', 0,
      'tax_amount', v_tax,
      'total', v_booked,
      'covers', 1,
      'closed_at', now(),
      'voided', false,
      'refunded', false,
      'server', 'QR',
      'order_type', 'dine-in',
      'customer', (v_first.customer - 'tab_join_code' - 'payment_unverified' - 'payment_state' - 'tab_close_short')
                  || jsonb_build_object('tab_closed_at', now(), 'tab_balance_minor', v_balance, 'shortfall', 0),
      'discounts', '[]'::jsonb,
      'service', 0,
      'tip', least(v_tip, v_booked),
      'method', 'card',
      'status', 'paid',
      'refunds', '[]'::jsonb,
      'tax_breakdown', case when v_added > 0
                            then jsonb_build_object('totalTax', v_tax, 'exclusiveTax', v_added,
                                                    'hasExclusiveTax', true, 'breakdown', '[]'::jsonb,
                                                    'source', 'qr_tab_settle')
                            else '[]'::jsonb end,
      'source', 'qr',
      'stripe_payment_intent_id', case when coalesce(v_first.customer ->> 'processor', 'stripe') = 'stripe' then p_payment_intent_id end,
      'payment_intents', jsonb_build_array(jsonb_build_object('id', p_payment_intent_id, 'amountMinor', v_taken)),
      -- The server's own tender list (fix round 7, 20 Sep): one card entry for the capture,
      -- with the tip the server allowed on it. The other three public checks have carried one
      -- since round 6; this was the one paid public check still relying on the legacy method
      -- fallback, and the one that would silently diverge if that fallback ever changed.
      'tenders', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                   'method', 'card',
                   'amount', greatest(0, v_booked - least(v_tip, v_booked)),
                   'tip', least(v_tip, v_booked),
                   'psp_ref', p_payment_intent_id,
                   'processor', case when v_first.customer ->> 'processor' in ('stripe', 'ryft', 'adyen')
                                     then v_first.customer ->> 'processor' else 'stripe' end))),
      'processor', case when v_first.customer ->> 'processor' in ('stripe', 'ryft', 'adyen') then v_first.customer ->> 'processor' else 'stripe' end);
    insert into public.closed_checks
    select * from jsonb_populate_record(null::public.closed_checks, v_cc);
  end if;

  update public.payment_proofs
     set used_by_ref = v_loc || ':' || v_tab_ref, used_at = now()
   where id = any(v_ids);

  return jsonb_build_object('ok', true, 'closed', array_length(v_refs, 1), 'check_id', v_check_id,
                            'booked', v_booked, 'shortfall', 0, 'balance_minor', v_balance);
end;
$fn$;

-- The helpers 20261009a added. Nothing else calls them once the two functions above are back.
drop function if exists public._public_order_vat(text, jsonb, text, numeric);
drop function if exists public._vat_for_lines(jsonb, jsonb, jsonb, text, numeric);
drop function if exists public._vat_order_type_key(text);
drop function if exists public._vat_round(numeric);

-- VISIBLE CHECK: every column true.
select
  md5(p.prosrc) = '767b8354a392322aaa6857055cbf9961' as check_row_is_20261002b_again,
  md5(q.prosrc) = '6a335ccfad4f783e2a9cb9b88928c1bb' as settle_tab_is_20260927c_again,
  not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') as check_row_not_callable_from_a_phone,
  not exists (select 1 from pg_proc where proname in ('_vat_round', '_vat_order_type_key', '_vat_for_lines', '_public_order_vat')) as helpers_gone
from pg_proc p, pg_proc q
where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure
  and q.oid = 'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure;
