-- 20261019a_OPS_channel_parity.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Run it AFTER v5.11.78 is live on the web (the catering page must send    #
-- #  its menu and its Collection or Delivery prices first, see 3 below).      #
-- #  Safe to run twice. One transaction. Outside service is best (it          #
-- #  replaces three functions every public order and QR tab close calls).     #
-- ############################################################################
--
-- WHY (v5.11.78, channel parity: every channel follows the till's rules, Peter 18 Oct 2026)
--   1. Public checks stored their lines as the page sent them: base price plus priced options.
--      The till stores the options INSIDE the line price. Every reader of closed_checks reads
--      price x qty, so 12 QR and 1 online check with paid options read short: the daily VAT
--      check flagged correct sales as "differs" (7 messages to owners), the Tax and Z report
--      split by rate understated, a part refund paid back too little. New helper
--      _order_line_folded; _public_order_check_row and settle_qr_tab store folded lines. The
--      goods and the VAT they book are worked out from the raw lines exactly as before.
--   2. A QR tab's later rounds now carry their own QR service charge (customer.service_charge,
--      v5.11.78 QrCheckout). settle_qr_tab books it as SERVICE, takes it out of the subtotal
--      and out of the VAT share, as a QR pay now check and the till do. It was booked as goods.
--   3. Catering was valued at BASE price only (v_base), whatever the order type and menu, while
--      v5.11.78's catering page charges the till's price (Collection or Delivery price, then the
--      catering menu's tier, then base). _public_order_value now values catering like every
--      other source, on the menu the page sends. Order matters: the page first, then this file.
--      Before the page is live, a catering guest paying base where a Collection price exists
--      would be valued above what they paid (Payment short).
--   4. A one off fold of the public checks already booked with priced options (about 13 rows:
--      QR, online, catering), guarded: only lines not already folded, only checks whose stored
--      subtotal is their lines' base plus options. Each folded line is marked _foldedBy
--      '20261019a' so the ROLLBACK can put exactly these back.
--
-- NOT a live tax calculation (central_tax_constraints.md): no tax is worked out again anywhere;
-- the stored line shape changes and the service charge moves to its own column.
--
-- UNDO: 20261019a_OPS_channel_parity_ROLLBACK.sql

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_vat') then
    raise exception 'Run 20261009a_OPS_public_order_vat_server.sql first (it is live). Nothing was changed.';
  end if;
end
$guard$;

-- 1. The line helper ----------------------------------------------------------------------------
create or replace function public._order_line_folded(p_line jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $function$
  -- 20261019a (v5.11.78, channel parity): one order line in the TILL'S contract. A customer page
  -- (online, QR, catering) sends a line as its base price plus priced options; the till stores the
  -- options inside the line price and keeps each option's own price for display. Every reader of
  -- closed_checks (the daily VAT check, the Tax and Z report split by rate, a part refund, Product
  -- mix) reads price x qty, so a public line read without its options. This folds them in ONCE and
  -- marks the line (_modsFolded) so it is never folded twice. Same rule as the app's
  -- channelMoney.foldLineMods: option price times greatest(1, option qty). A line with no priced
  -- option, or already folded, comes back exactly as it was.
  select case
    when jsonb_typeof(p_line) is distinct from 'object' then p_line
    when p_line -> '_modsFolded' = 'true'::jsonb then p_line
    when coalesce((select sum(public._fence_num(m ->> 'price') * greatest(1, public._fence_num(m ->> 'qty')))
                     from jsonb_array_elements(case when jsonb_typeof(p_line -> 'mods') = 'array' then p_line -> 'mods' else '[]'::jsonb end) m
                    where jsonb_typeof(m) = 'object'), 0) <= 0 then p_line
    else p_line || jsonb_build_object(
      'price', round(public._fence_num(p_line ->> 'price')
                     + (select sum(public._fence_num(m ->> 'price') * greatest(1, public._fence_num(m ->> 'qty')))
                          from jsonb_array_elements(p_line -> 'mods') m
                         where jsonb_typeof(m) = 'object'), 2),
      '_modsFolded', true)
  end
$function$;

-- 2. Public checks store folded lines ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text, p_check jsonb, p_items jsonb, p_customer jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_type     text := left(coalesce(nullif(p_check ->> 'order_type', ''), p_type), 40);
  v_goods    numeric;
  v_page     numeric;
  v_page_rec jsonb;
  v_pricing  jsonb := case when jsonb_typeof(p_customer -> 'order_pricing') = 'object' then p_customer -> 'order_pricing' end;
  v_share    numeric := 1;
  v_srv      jsonb;
  v_tax      numeric;
  v_rec      jsonb;
begin
  -- The goods the SERVER priced (p_items: price plus modifiers, times quantity), the ceiling of
  -- any VAT figure, as 20261002b.
  select round(coalesce(sum(
           (public._fence_num(x ->> 'price')
            + coalesce((select sum(public._fence_num(m ->> 'price'))
                          from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m), 0))
           * (case when public._fence_num(x ->> 'qty') > 0 then least(public._fence_num(x ->> 'qty'), 999) else 1 end)), 0), 2)
    into v_goods
    from jsonb_array_elements(p_items) x
   where jsonb_typeof(x) = 'object';
  -- The page's figure, read as 20261002b read it: a JSON number at any number of decimals, or
  -- text that is a plain number, rounded to pence, never below 0 and never above the goods.
  if jsonb_typeof(p_check -> 'tax_amount') = 'number'
     or (jsonb_typeof(p_check -> 'tax_amount') = 'string' and p_check ->> 'tax_amount' ~ '^\s*[0-9]{1,12}(\.[0-9]{1,30})?\s*$') then
    v_page := least(greatest(round(btrim(p_check ->> 'tax_amount')::numeric, 2), 0), v_goods);
  end if;
  -- The page's record, kept as 20261002b kept it: the till's shape (a number for totalTax and a
  -- list of rates, small), or a list; anything else is no record.
  v_page_rec := case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown'
                     when jsonb_typeof(p_check -> 'tax_breakdown') = 'object'
                          and jsonb_typeof(p_check -> 'tax_breakdown' -> 'totalTax') = 'number'
                          and jsonb_typeof(p_check -> 'tax_breakdown' -> 'breakdown') = 'array'
                          and length((p_check -> 'tax_breakdown')::text) <= 20000
                     then p_check -> 'tax_breakdown' end;
  -- The share of the goods charged: the venue's automatic deals (order_pricing, the server's own
  -- figures) come off the VAT, as the till books a discounted bill (src/lib/taxShare.js). Promo
  -- codes and loyalty rewards are tenders, not discounts, and leave the VAT alone (the till's rule
  -- today; the owner decides Fix 5 with his accountant).
  if v_pricing is not null and coalesce((v_pricing ->> 'goods_minor')::numeric, 0) > 0
     and coalesce((v_pricing ->> 'auto_minor')::numeric, 0) > 0 then
    v_share := greatest(0, least(1, ((v_pricing ->> 'goods_minor')::numeric - (v_pricing ->> 'auto_minor')::numeric)
                                    / (v_pricing ->> 'goods_minor')::numeric));
  end if;

  -- 20261009a: THE VAT, the server's own, from the venue's Back Office rules.
  v_srv := public._public_order_vat(p_loc, p_items, v_type, v_share);
  if not coalesce((v_srv ->> 'has_rates')::boolean, false) then
    -- No active rates at this venue: no tax set up. The page's figure and record, as before.
    v_tax := v_page;
    v_rec := coalesce(v_page_rec, '[]'::jsonb);
  elsif v_page is not null
        and (coalesce((v_srv ->> 'profiles_in_use')::boolean, false)
             or abs(v_page - (v_srv ->> 'total_tax')::numeric) <= 0.01) then
    -- The page agrees to the penny (a half penny may land either side): its figure, its record.
    -- A venue set up as tax profiles keeps the page's figure whenever it sent one: those maths live
    -- in the page's engine. With no record from the page, the server's split by rate is kept.
    v_tax := v_page;
    v_rec := coalesce(v_page_rec, (v_srv -> 'record') || jsonb_build_object('totalTax', v_page, 'booked', 'page'));
  else
    -- The page sent nothing, or a figure that is not the venue's rule: the server's, and the
    -- record says so. Never null for goods above 0 at a venue with rates.
    v_tax := (v_srv ->> 'total_tax')::numeric;
    v_rec := (v_srv -> 'record') || jsonb_strip_nulls(jsonb_build_object(
               'booked', 'server',
               'reason', case when v_page is null then 'page-sent-none' else 'page-differs' end,
               'pageTaxAmount', v_page));
  end if;

  return jsonb_build_object(
      'id', left(coalesce(nullif(btrim(p_check ->> 'id'), ''), 'chk-' || p_source || '-' || p_ref), 80),
      'ref', p_ref,
      'location_id', p_loc,
      'table_id', left(p_check ->> 'table_id', 80),
      'table_label', left(p_check ->> 'table_label', 80),
      'staff_name', null,
      -- 20261019a (v5.11.78): the lines are stored in the till's contract, a line's paid options
      -- inside its price (public._order_line_folded). The goods and the VAT above read the raw
      -- lines, so neither moves.
      'items', coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then public._order_line_folded(x) || '{"voided": false}'::jsonb else x end
                                          order by n)
                           from jsonb_array_elements(p_items) with ordinality as i(x, n)), '[]'::jsonb),
      'subtotal', round(public._fence_num(p_check ->> 'subtotal'), 2),
      'tax', round(public._fence_num(p_check ->> 'tax'), 2),
      'payment_method', left(p_check ->> 'payment_method', 200),
      'covers', greatest(1, least(99, public._fence_num(p_check ->> 'covers')::int)),
      'voided', false,
      'refunded', false,
      'server', left(coalesce(nullif(p_check ->> 'server', ''), initcap(p_source)), 40),
      'order_type', v_type,
      'customer', case when jsonb_typeof(p_check -> 'customer') = 'object'
                       then (p_check -> 'customer') - 'paid' - 'staff' - 'payment_state' - 'payment_unverified'
                            - 'payment_confirmed_by' - 'order_pricing' - 'placed_via'
                       else p_customer end,
      'discounts', case when jsonb_typeof(p_check -> 'discounts') = 'array' then p_check -> 'discounts' else '[]'::jsonb end,
      'service', round(public._fence_num(p_check ->> 'service'), 2),
      'tip', round(public._fence_num(p_check ->> 'tip'), 2),
      'method', left(coalesce(nullif(p_check ->> 'method', ''), 'card'), 40),
      'refunds', '[]'::jsonb,
      -- 20261009a: the record of the VAT booked (see the rule above). _public_order_write_check
      -- reads this entry only when it is a list, so its money rules see what they saw before.
      'tax_breakdown', v_rec,
      -- 20261009a: the VAT booked (see the rule above).
      'tax_amount', v_tax,
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
end;
$function$;

-- 3. A QR tab books its rounds' service charge as service, lines folded ---------------------------
CREATE OR REPLACE FUNCTION public.settle_qr_tab(p_location_id uuid, p_payment_intent_id text, p_check jsonb DEFAULT '{}'::jsonb, p_proof_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_page       numeric;          -- 20261009a: the phone's figure, clamped as 20260927c clamped it
  v_page_added numeric := 0;
  v_full       numeric := 0;     -- 20261009a: the rounds' goods at menu price (server priced at placement)
  v_share      numeric := 1;
  v_srv        jsonb;
  v_rec        jsonb;
  v_service    numeric := 0;     -- 20261019a: the rounds' QR service charge, booked as service
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
  -- 20261019a (v5.11.78): the QR service charge each round took (customer.service_charge, what the
  -- page charged on that round) is SERVICE, as on a QR pay now check and at the till: never goods
  -- with VAT on it. Never more than was taken above the goods and the tip.
  select coalesce(sum(greatest(0, public._fence_num(q.customer ->> 'service_charge'))), 0) into v_service
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  v_service := least(v_service, greatest(0, round((v_taken - v_goods)::numeric / 100, 2) - least(v_tip, v_booked)));

  -- 20260927c: the phone's figure, taken only when it is a JSON number, clamped to the goods this
  -- check books; the added-on part is clamped to it.
  if jsonb_typeof(p_check -> 'tax_amount') = 'number' then
    v_page := least(greatest(round((p_check ->> 'tax_amount')::numeric, 2), 0),
                    greatest(0, v_booked - least(v_tip, v_booked) - v_service));
    if jsonb_typeof(p_check -> 'exclusive_tax') = 'number' then
      v_page_added := least(greatest(round((p_check ->> 'exclusive_tax')::numeric, 2), 0), v_page);
    end if;
  end if;
  -- 20261009a: THE VAT, the server's own, from the venue's Back Office rules over the rounds'
  -- lines (server priced when each round was placed). The share is the goods booked over the
  -- goods at menu price, so an automatic deal on a round comes off the VAT as the till books a
  -- discounted bill (the phone's own rule, headlessTax.qrTabCloseFields).
  select coalesce(sum((public._fence_num(x ->> 'price')
                       + coalesce((select sum(public._fence_num(m ->> 'price') * greatest(1, public._fence_num(m ->> 'qty')))
                                     from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m
                                    where jsonb_typeof(m) = 'object'), 0))
                      * (case when public._fence_num(x ->> 'qty') >= 1 then public._fence_num(x ->> 'qty') else 1 end)), 0)
    into v_full
    from jsonb_array_elements(v_items) x
   where jsonb_typeof(x) = 'object' and not coalesce((x ->> 'voided')::boolean, false);
  if v_full > 0 then
    v_share := greatest(0, least(1, (v_booked - least(v_tip, v_booked) - v_service) / v_full));
  end if;
  v_srv := public._public_order_vat(v_loc, v_items, 'dine-in', v_share);
  if not coalesce((v_srv ->> 'has_rates')::boolean, false) then
    -- No active rates at this venue: no tax set up. The phone's figures, as 20260927c.
    v_tax := v_page;
    v_added := v_page_added;
    v_rec := case when v_added > 0
                  then jsonb_build_object('totalTax', v_tax, 'exclusiveTax', v_added,
                                          'hasExclusiveTax', true, 'breakdown', '[]'::jsonb,
                                          'source', 'qr_tab_settle')
                  else '[]'::jsonb end;
  elsif v_page is not null
        and (coalesce((v_srv ->> 'profiles_in_use')::boolean, false)
             or abs(v_page - (v_srv ->> 'total_tax')::numeric) <= 0.01) then
    -- The phone agrees to the penny: its figure, with the server's split by rate behind it.
    v_tax := v_page;
    v_added := case when coalesce((v_srv ->> 'profiles_in_use')::boolean, false) then v_page_added
                    else least((v_srv ->> 'exclusive_tax')::numeric, v_tax) end;
    v_rec := (v_srv -> 'record') || jsonb_build_object('totalTax', v_tax, 'exclusiveTax', v_added, 'booked', 'page');
  else
    -- The phone sent nothing, or a figure that is not the venue's rule: the server's, said so.
    v_tax := (v_srv ->> 'total_tax')::numeric;
    v_added := (v_srv ->> 'exclusive_tax')::numeric;
    v_rec := (v_srv -> 'record') || jsonb_strip_nulls(jsonb_build_object(
               'booked', 'server',
               'reason', case when v_page is null then 'page-sent-none' else 'page-differs' end,
               'pageTaxAmount', v_page));
  end if;
  v_added := least(coalesce(v_added, 0), coalesce(v_tax, 0));

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
      -- 20261019a: the till's line contract (paid options inside the price), the service apart.
      'items', coalesce((select jsonb_agg(public._order_line_folded(x) order by n)
                           from jsonb_array_elements(v_items) with ordinality as i(x, n)), '[]'::jsonb),
      'subtotal', greatest(0, v_booked - v_tip - v_added - v_service),
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
      'service', v_service,
      'tip', least(v_tip, v_booked),
      'method', 'card',
      'status', 'paid',
      'refunds', '[]'::jsonb,
      -- 20261009a: the record of the VAT booked (the server's split by rate, see above).
      'tax_breakdown', v_rec,
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
$function$;

-- 3b. Catering is valued like every other source --------------------------------------------------
CREATE OR REPLACE FUNCTION public._public_order_value(p_loc text, p_source text, p_type text, p_items jsonb, p_menu_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_channel  text := public._menu_channel_key(p_type);
  -- 20261019a (v5.11.78): every source is valued the same way, catering too. Catering used to be
  -- floored at base only, so a catering guest paying the Collection or Delivery price (what the
  -- page now charges, lib/cateringPricing.js) could land in Payment short.
  v_base     boolean := false;
  -- The menu the page priced this basket on (fix round 7; the catering page sends its own since
  -- v5.11.78).
  v_menu_id  text := nullif(left(btrim(coalesce(p_menu_id, '')), 80), '');
  v_86       text[] := '{}'::text[];
  v_parents  text[] := '{}'::text[];
  v_sell     boolean;
  v_floor    bigint;
  v_pname    text;
  v_opts     jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_goods    bigint := 0;
  v_unknown  integer := 0;
  v_max_unit bigint := 0;
  it         jsonb;
  md         jsonb;
  v_mods     jsonb;
  v_opt      jsonb;
  v_ents     jsonb;
  v_pick     jsonb;
  v_used     jsonb;
  v_groups   text[];
  v_key      text;
  v_menu     bigint;
  r          public.menu_items%rowtype;
  p          public.menu_items%rowtype;
  v_id       text;
  v_item     bigint;
  v_modsum   bigint;
  v_mod      bigint;
  v_q        numeric;
  v_qty      integer;
  v_unit     bigint;
  v_names    text[];
  v_name     text;
  v_kitchen  text;
  v_receipt  text;
  v_k_menu   text;
  v_r_menu   text;
begin
  -- What the venue has switched off today (eighty_six: one row per 86'd item per venue, the
  -- table both storefronts read). Through to_regclass and EXECUTE, so this file still runs
  -- on a database that has no such table.
  if to_regclass('public.eighty_six') is not null then
    execute 'select coalesce(array_agg(e.item_id::text), ''{}''::text[]) from public.eighty_six e where e.location_id::text = $1'
      into v_86 using p_loc;
  end if;

  -- Every row that is the parent of a live size, once for the whole order (a variants parent
  -- is the row behind Half and Pint: it carries base 0 and is never sold itself).
  select coalesce(array_agg(distinct m.parent_id), '{}'::text[]) into v_parents
    from public.menu_items m
   where m.location_id = p_loc and m.parent_id is not null and coalesce(m.archived, false) = false;

  -- Every option of every modifier group at this venue, by option id: which group holds it,
  -- how many times that group allows one on a line, whether the group lets the SAME option be
  -- picked more than once ("pick with qty"), its menu price in pence and the menu's name for
  -- it. An option id that appears in more than one group gets one entry per group.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_opts
    from (
      select o ->> 'id' as k,
             jsonb_agg(jsonb_build_object(
               'g',   g.id,
               'max', greatest(1, least(99, coalesce(nullif(g.max, 0), nullif(g.max_select, 0), 1))),
               'rep', coalesce(g.selection_type, '') = 'quantity',
               'p',   round(public._fence_num(o ->> 'price') * 100)::bigint,
               'n',   nullif(coalesce(o ->> 'name', o ->> 'label', ''), '')
             ) order by g.id) as v
        from public.modifier_groups g
        cross join lateral jsonb_array_elements(case when jsonb_typeof(g.options) = 'array' then g.options else '[]'::jsonb end) o
       where g.location_id = p_loc
         and jsonb_typeof(o) = 'object'
         and coalesce(o ->> 'id', '') <> ''
       group by o ->> 'id'
    ) t;

  -- AN OPTION THE SERVER CANNOT MATCH BY ID IS WORTH NOTHING (fix round 7, 20 Sep). Round 6
  -- charged such an option at the dearest menu price of any option with the same NAME at the
  -- venue, to stop "Bacon" with a made up id riding a kitchen ticket at 0.00. That rule
  -- charged the storefront's OWN free choices: instruction picks and typed notes arrive with
  -- an ig-<group>-<value> id that is on no modifier group by design
  -- (src/surfaces/online/OnlineItemSheet.jsx:450) or with no id at all
  -- (src/components/InlineItemFlow.jsx:271, src/surfaces/ProductModal.jsx:169,
  -- src/lib/kioskBasket.js:51), and they carry price 0 because that is what the guest was
  -- charged. At any venue whose instruction wording matches one of its own option names
  -- (Sauce, Cheese, Oat, Gluten free, Extra shot), a guest who paid in full came out
  -- "Payment short", got no kitchen ticket, and saw a charge they never paid printed on their
  -- own line; "Check payment" could never clear it. So the server gives an unmatched option
  -- the only value it can prove: ZERO. It can still never TAKE anything off a line (round 3's
  -- repeated minus option forgery stays shut), and what the page declared above zero is kept,
  -- because that is what our own storefront charged.
  -- THE ACCEPTED COST: a doctored page can put a free extra on a kitchen ticket (a real 5.00
  -- Bacon sent under a made up id, declared at 0.00, reaches the kitchen for nothing). That is
  -- one extra given away on one line, and it is the price of never refusing a guest who paid
  -- exactly what our own page asked for. It is written up in docs/FENCE_STAGE_1_PAYMENTS.md.

  for it in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) x loop
    if jsonb_typeof(it) is distinct from 'object' then
      v_unknown := v_unknown + 1;
      v_out := v_out || jsonb_build_array(it);
      continue;
    end if;
    v_id := nullif(btrim(coalesce(it ->> 'itemId', it ->> 'item_id', '')), '');
    r := null;
    p := null;
    if v_id is not null then
      select * into r from public.menu_items m where m.id = v_id and m.location_id = p_loc;
    end if;
    if r.id is not null and r.parent_id is not null then
      select * into p from public.menu_items m where m.id = r.parent_id and m.location_id = p_loc;
    end if;
    -- Does the storefront sell this row, and can the server price it?
    v_sell := false;
    v_floor := null;
    if r.id is not null then
      v_floor := public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_menu_id);
      v_sell := not (r.id = any(v_parents))
                and coalesce(r.archived, false) = false
                and not (coalesce(r.type, '') = 'subitem' and r.sold_alone is not true)
                and not (r.id = any(v_86));
      -- A row the storefront SELLS but the server could not put a price on is not unknown: it
      -- is FREE, because that is exactly what the customer was charged. resolveItemPrice
      -- (lib/menuPricing.js) answers 0 for {"base": 0} and for a row with no pricing at all,
      -- and nothing on the storefront hides a 0.00 row, so a tap water, a cutlery pack or a no
      -- charge side is shown, added and sold for nothing (fix round 5). Refusing to price it
      -- put honest fully paid orders into "Payment short" and REFUSED a QR tab round that
      -- carried one. The rows that used to ride along free are held by the sellability test
      -- above, not by this.
      if v_sell and v_floor is null then
        v_floor := 0;
      end if;
    end if;
    v_item := round(public._fence_num(it ->> 'price') * 100)::bigint;
    if v_sell and v_floor is not null then
      v_item := greatest(v_item, v_floor);
    else
      -- Not on this venue's menu, not something the storefront sells, or nothing the server
      -- can put a price on: UNKNOWN. Never free, never paid by itself.
      v_unknown := v_unknown + 1;
      v_item := greatest(v_item, coalesce(v_floor, 0), 0);
    end if;

    -- Which groups this item's options may come from: its own list, or (a size with none of
    -- its own) the main product's, plus the sub groups those groups' options open.
    v_groups := '{}'::text[];
    if r.id is not null then
      select coalesce(array_agg(t.g), '{}'::text[]) into v_groups
        from (select nullif(btrim(case when jsonb_typeof(e) = 'string' then e #>> '{}'
                                       when jsonb_typeof(e) = 'object' then coalesce(e ->> 'groupId', e ->> 'id') end), '') as g
                from jsonb_array_elements(case when jsonb_typeof(r.assigned_modifier_groups) = 'array'
                                               then r.assigned_modifier_groups else '[]'::jsonb end) e) t
       where t.g is not null;
      if cardinality(v_groups) = 0 and p.id is not null then
        select coalesce(array_agg(t.g), '{}'::text[]) into v_groups
          from (select nullif(btrim(case when jsonb_typeof(e) = 'string' then e #>> '{}'
                                         when jsonb_typeof(e) = 'object' then coalesce(e ->> 'groupId', e ->> 'id') end), '') as g
                  from jsonb_array_elements(case when jsonb_typeof(p.assigned_modifier_groups) = 'array'
                                                 then p.assigned_modifier_groups else '[]'::jsonb end) e) t
         where t.g is not null;
      end if;
      if cardinality(v_groups) > 0 then
        select v_groups || coalesce((select array_agg(distinct nullif(btrim(o ->> 'subGroupId'), ''))
                                       from public.modifier_groups g2
                                       cross join lateral jsonb_array_elements(case when jsonb_typeof(g2.options) = 'array'
                                                                                    then g2.options else '[]'::jsonb end) o
                                      where g2.location_id = p_loc
                                        and g2.id = any(v_groups)
                                        and nullif(btrim(coalesce(o ->> 'subGroupId', '')), '') is not null), '{}'::text[])
          into v_groups;
      end if;
    end if;

    v_modsum := 0;
    v_mods := '[]'::jsonb;
    v_used := '{}'::jsonb;
    for md in select x from jsonb_array_elements(case when jsonb_typeof(it -> 'mods') = 'array' then it -> 'mods' else '[]'::jsonb end) x loop
      if jsonb_typeof(md) is distinct from 'object' then
        v_mods := v_mods || jsonb_build_array(md);
        continue;
      end if;
      v_mod := round(public._fence_num(md ->> 'price') * 100)::bigint;
      v_ents := case when coalesce(md ->> 'id', '') <> '' then v_opts -> (md ->> 'id') end;
      v_pick := null;
      v_menu := null;
      v_name := null;
      if v_ents is not null then
        v_name := nullif(coalesce(v_ents -> 0 ->> 'n', ''), '');
        -- One pass: the dearest menu price this option has anywhere (the floor for a copy that
        -- does not count), and the first group of this item that still has room for it.
        for v_opt in select x from jsonb_array_elements(v_ents) x loop
          v_menu := greatest(coalesce(v_menu, (v_opt ->> 'p')::bigint), (v_opt ->> 'p')::bigint);
          continue when v_pick is not null or not ((v_opt ->> 'g') = any(v_groups));
          v_key := (v_opt ->> 'g') || '|' || (md ->> 'id');
          if coalesce((v_used ->> (v_opt ->> 'g'))::integer, 0) < (v_opt ->> 'max')::integer
             and (coalesce((v_opt ->> 'rep')::boolean, false)
                  or coalesce((v_used ->> v_key)::integer, 0) = 0) then
            v_pick := v_opt;
          end if;
        end loop;
      end if;
      if v_pick is not null then
        -- An option this item really has, within what its group allows: the menu price is the
        -- floor, and the venue's own minus price counts.
        v_mod := greatest(v_mod, (v_pick ->> 'p')::bigint);
        v_key := (v_pick ->> 'g') || '|' || (md ->> 'id');
        v_used := v_used
                  || jsonb_build_object(v_pick ->> 'g', coalesce((v_used ->> (v_pick ->> 'g'))::integer, 0) + 1)
                  || jsonb_build_object(v_key, coalesce((v_used ->> v_key)::integer, 0) + 1);
        v_name := coalesce(nullif(coalesce(v_pick ->> 'n', ''), ''), v_name);
      else
        -- Not one of this item's options, or more copies than its group allows: it can only
        -- add to the line, never take anything off. An id the venue's menu does not have at
        -- all (v_ents null) is worth NOTHING to the server, so the line keeps what the page
        -- said for it, floored at zero: an instruction pick and a typed note stay free, and a
        -- minus priced option repeated past its group's limit cannot take a penny off (fix
        -- round 7 restores this; see the note above the loop).
        v_mod := greatest(v_mod, coalesce(v_menu, 0), 0);
      end if;
      if v_name is not null then
        md := md || jsonb_build_object('name', v_name, 'label', v_name);
      end if;
      md := md || jsonb_build_object('price', round(v_mod / 100.0, 2));
      v_modsum := v_modsum + v_mod;
      v_mods := v_mods || jsonb_build_array(md);
    end loop;

    v_q := public._fence_num(it ->> 'qty');
    v_qty := case when v_q >= 1 then least(999, ceil(v_q))::integer else 1 end;
    v_unit := greatest(0, v_item + v_modsum);
    v_goods := v_goods + v_unit * v_qty;
    if v_sell and v_floor is not null then
      v_max_unit := greatest(v_max_unit, greatest(0, v_item));
    end if;

    it := (it - 'voided' - 'discount') || jsonb_build_object('qty', v_qty, 'price', round(v_item / 100.0, 2));
    if it ? 'mods' then
      it := it || jsonb_build_object('mods', v_mods);
    end if;

    if r.id is not null then
      v_name := coalesce(nullif(r.menu_name, ''), r.name);
      v_pname := null;
      v_names := array[lower(btrim(coalesce(r.name, ''))), lower(btrim(coalesce(r.menu_name, ''))),
                       lower(btrim(coalesce(r.receipt_name, ''))), lower(btrim(coalesce(r.kitchen_name, '')))];
      if p.id is not null then
        -- The storefront names a size "Parent - Size" with a long dash (OnlineItemSheet).
        v_pname := coalesce(nullif(p.menu_name, ''), p.name);
        v_name := v_pname || ' ' || chr(8212) || ' ' || coalesce(nullif(r.menu_name, ''), r.name);
        v_names := v_names || lower(v_name);
      end if;
      if lower(btrim(coalesce(it ->> 'name', ''))) <> all (array_remove(v_names, '')) then
        it := it || jsonb_build_object('name', v_name);
      end if;
      -- 20 Sep 2026, Peter: a size came through to the kitchen as just "Small". The menu row
      -- for a size is named "Small" and its kitchen_name defaults to the same word, and this
      -- used to copy that over the line. lib/itemDisplay.js kitchenOverride is the rule the
      -- whole app uses: a kitchen name counts ONLY when it differs from that row's own name.
      -- Otherwise the line keeps the name the storefront built ("Americano - Small", with the
      -- long dash), which is what the till, the ticket and the receipt have always shown.
      v_kitchen := nullif(btrim(coalesce(it ->> 'kitchenName', it ->> 'kitchen_name', '')), '');
      v_k_menu := nullif(btrim(coalesce(r.kitchen_name, '')), '');
      if v_k_menu is not null and lower(v_k_menu) = lower(btrim(coalesce(r.name, ''))) then
        v_k_menu := null;                     -- not an override, just the row's own name
      end if;
      if v_kitchen is distinct from v_k_menu
         and lower(coalesce(v_kitchen, '')) <> all (array_remove(v_names, '')) then
        it := (it - 'kitchen_name') || jsonb_build_object('kitchenName', v_k_menu);
      end if;
      v_receipt := nullif(btrim(coalesce(it ->> 'receiptName', it ->> 'receipt_name', '')), '');
      v_r_menu := nullif(btrim(coalesce(r.receipt_name, '')), '');
      if v_r_menu is not null and lower(v_r_menu) = lower(btrim(coalesce(r.name, ''))) then
        v_r_menu := null;                     -- same rule as the kitchen name
      end if;
      if v_receipt is distinct from v_r_menu
         and lower(coalesce(v_receipt, '')) <> all (array_remove(v_names, '')) then
        it := (it - 'receipt_name') || jsonb_build_object('receiptName', v_r_menu);
      end if;
      if v_sell and v_floor is not null then
        -- Only a line the storefront really sells, at the server's own price, takes part in
        -- the venue's automatic discounts or can be what a free item loyalty reward makes
        -- free (id, parent id and the names lib/loyaltyMenuMatch.js matches on).
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
                     'unit', v_unit, 'qty', v_qty, 'cat', r.cat,
                     'cats', to_jsonb(coalesce(r.cats, '{}'::text[])),
                     'id', r.id, 'pid', r.parent_id, 'item', greatest(0, v_item),
                     'name', coalesce(nullif(r.menu_name, ''), r.name),
                     'pname', v_pname, 'label', v_name));
      end if;
    end if;
    v_out := v_out || jsonb_build_array(it);
  end loop;

  return jsonb_build_object('items', v_out, 'lines', v_lines, 'goods_minor', v_goods,
                            'unknown_lines', v_unknown, 'max_unit_minor', v_max_unit);
end;
$function$;

-- 4. The public checks already booked with priced options (one off, guarded) --------------------
with cand as (
  select c.id
    from public.closed_checks c
   where c.source in ('qr', 'online', 'catering')
     and jsonb_typeof(c.items) = 'array'
     and exists (select 1 from jsonb_array_elements(c.items) x
                  where jsonb_typeof(x) = 'object' and public._order_line_folded(x) is distinct from x)
     and not exists (select 1 from jsonb_array_elements(c.items) x
                      where jsonb_typeof(x) = 'object'
                        and (x -> '_modsFolded' = 'true'::jsonb
                             or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m
                                         where jsonb_typeof(m) = 'object' and m ? '_channelPrice')))
     and abs(coalesce(c.subtotal, 0) - coalesce((
           select sum((public._fence_num(x ->> 'price')
                       + coalesce((select sum(public._fence_num(m ->> 'price') * greatest(1, public._fence_num(m ->> 'qty')))
                                     from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m
                                    where jsonb_typeof(m) = 'object'), 0))
                      * (case when public._fence_num(x ->> 'qty') >= 1 then public._fence_num(x ->> 'qty') else 1 end))
             from jsonb_array_elements(c.items) x
            where jsonb_typeof(x) = 'object' and not coalesce((x ->> 'voided')::boolean, false)), 0)) < 0.011
)
update public.closed_checks c
   set items = (select jsonb_agg(case when jsonb_typeof(x) = 'object' and public._order_line_folded(x) is distinct from x
                                      then public._order_line_folded(x) || '{"_foldedBy": "20261019a"}'::jsonb
                                      else x end order by n)
                  from jsonb_array_elements(c.items) with ordinality as i(x, n))
 where c.id in (select id from cand);

do $grants$
begin
  revoke execute on function public._order_line_folded(jsonb) from public, anon, authenticated;
  grant execute on function public._order_line_folded(jsonb) to service_role;
end
$grants$;

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   helper 1, check_row_folds 1, settle_books_service 1, catering_valued_like_all 1,
--   public_rows_still_unfolded 0, rows_folded_by_this_file about 13 (12 QR, 1 online on 18 Oct; 0 on a re run is fine),
--   helper_anon_can_call 0
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_order_line_folded') as helper,
  (select case when position('_order_line_folded' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_check_row') as check_row_folds,
  (select case when position('v_service' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'settle_qr_tab') as settle_books_service,
  (select case when position('v_base     boolean := false' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_value') as catering_valued_like_all,
  (select count(*) from public.closed_checks c
    where c.source in ('qr', 'online', 'catering') and jsonb_typeof(c.items) = 'array'
      and exists (select 1 from jsonb_array_elements(c.items) x where jsonb_typeof(x) = 'object' and public._order_line_folded(x) is distinct from x)
      and not exists (select 1 from jsonb_array_elements(c.items) x where jsonb_typeof(x) = 'object' and x -> '_modsFolded' = 'true'::jsonb)
      and c.closed_at > now() - interval '120 days') as public_rows_still_unfolded,
  (select count(*) from public.closed_checks c
    where jsonb_typeof(c.items) = 'array'
      and exists (select 1 from jsonb_array_elements(c.items) x where x ->> '_foldedBy' = '20261019a')) as rows_folded_by_this_file,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_order_line_folded'
     and has_function_privilege('anon', p.oid, 'execute')) as helper_anon_can_call;
