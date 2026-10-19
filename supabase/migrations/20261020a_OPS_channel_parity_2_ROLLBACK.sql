-- 20261020a_OPS_channel_parity_2_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Puts back exactly what 20261020a replaced: the functions as
-- they were live on 19 Oct 2026 (read from production), and drops what it added. A promo use given
-- back while 20261020a was live stays given back. Checks written in between keep their deal lines.
-- Safe to run twice. One transaction.

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
end
$guard$;

-- 5. settle_qr_tab as it was ----------------------------------------------------------------------
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

-- 4. _public_order_value as it was ----------------------------------------------------------------
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
        -- v5.11.78 round 1: a size counts under its product's categories ("Also in" list
        -- included), the till's rule (lib/lineCategories.js) and the kiosk's; it read the size
        -- row's own, so a deal could differ between the server and the till.
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
                     'unit', v_unit, 'qty', v_qty,
                     'cat', case when p.id is not null and coalesce(p.cat, '') <> '' then p.cat else r.cat end,
                     'cats', to_jsonb(coalesce(case when p.id is not null and coalesce(p.cat, '') <> '' then p.cats else r.cats end, '{}'::text[])),
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

drop function if exists public._menu_item_has_price(jsonb, text, text);

-- 3. _vat_for_lines as it was ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._vat_for_lines(p_lines jsonb, p_menu jsonb, p_rates jsonb, p_type text, p_share numeric DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_type      text := coalesce(nullif(btrim(p_type), ''), 'dine-in');
  v_alias     text := public._vat_order_type_key(v_type);
  v_share     numeric := case when p_share is null or p_share > 1 then 1 when p_share < 0 then 0 else p_share end;
  v_rates     jsonb := '[]'::jsonb;
  v_default   jsonb;
  v_menu      jsonb := '{}'::jsonb;
  ln          jsonb;
  r           jsonb;
  p           jsonb;
  v_rate_id   text;
  v_ov        jsonb;
  v_ov_id     text;
  v_has_ov    boolean;
  v_rate      jsonb;
  v_note      text;
  v_note_id   text;
  v_item_id   text;
  v_qty       numeric;
  v_unit      numeric;
  v_gross     numeric;
  v_net       numeric;
  v_tax       numeric;
  v_pct       numeric;
  v_sum_tax   numeric := 0;
  v_sum_net   numeric := 0;
  v_sum_gross numeric := 0;
  v_sum_excl  numeric := 0;
  v_by_rate   jsonb := '{}'::jsonb;
  v_order     text[] := '{}'::text[];
  v_entry     jsonb;
  v_fallbacks jsonb := '[]'::jsonb;
  v_breakdown jsonb := '[]'::jsonb;
  v_total_tax numeric;
  v_excl      numeric;
  v_record    jsonb;
  k           text;
begin
  -- Active rates only (an inactive rate charges nothing: src/lib/tax.js), keyed for lookup.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rates
    from jsonb_array_elements(case when jsonb_typeof(p_rates) = 'array' then p_rates else '[]'::jsonb end) x
   where jsonb_typeof(x) = 'object' and coalesce(x ->> 'id', '') <> ''
     and coalesce((x ->> 'active')::boolean, true);
  if jsonb_array_length(v_rates) = 0 then
    return jsonb_build_object('has_rates', false, 'total_tax', null, 'exclusive_tax', 0, 'goods', 0, 'record', null);
  end if;
  select x into v_default from jsonb_array_elements(v_rates) x where coalesce((x ->> 'is_default')::boolean, false) limit 1;
  select coalesce(jsonb_object_agg(x ->> 'id', x), '{}'::jsonb) into v_menu
    from jsonb_array_elements(case when jsonb_typeof(p_menu) = 'array' then p_menu else '[]'::jsonb end) x
   where jsonb_typeof(x) = 'object' and coalesce(x ->> 'id', '') <> '';

  for ln in select x from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) x loop
    continue when jsonb_typeof(ln) is distinct from 'object';
    continue when coalesce((ln ->> 'voided')::boolean, false);
    v_item_id := nullif(btrim(coalesce(ln ->> 'itemId', ln ->> 'item_id', ln ->> 'id', '')), '');
    r := case when v_item_id is not null then v_menu -> v_item_id end;
    p := null;
    if r is not null and coalesce(r ->> 'parent_id', '') <> '' then
      p := v_menu -> (r ->> 'parent_id');
    elsif r is null and coalesce(ln ->> 'parentId', ln ->> 'parent_id', '') <> '' then
      -- A size row that is not on this menu any more: its parent's rule (headlessTax.qrTaxLines).
      r := v_menu -> coalesce(ln ->> 'parentId', ln ->> 'parent_id');
    end if;

    -- The line's Back Office rule: the row's rate and overrides; a size with no overrides of its
    -- own reads its parent's overrides and, when it has no rate, its parent's rate (the till's
    -- rule, src/store/index.js addItem). A line not on the menu keeps whatever rate it carries.
    v_note := null;
    v_note_id := null;
    if r is not null then
      v_rate_id := nullif(r ->> 'tax_rate_id', '');
      v_ov := case when jsonb_typeof(r -> 'tax_overrides') = 'object' then r -> 'tax_overrides' else '{}'::jsonb end;
      if p is not null and v_ov = '{}'::jsonb then
        v_ov := case when jsonb_typeof(p -> 'tax_overrides') = 'object' then p -> 'tax_overrides' else '{}'::jsonb end;
        if v_rate_id is null then v_rate_id := nullif(p ->> 'tax_rate_id', ''); end if;
      end if;
    else
      v_rate_id := nullif(coalesce(ln ->> 'taxRateId', ln ->> 'tax_rate_id', ''), '');
      v_ov := case when jsonb_typeof(ln -> 'taxOverrides') = 'object' then ln -> 'taxOverrides'
                   when jsonb_typeof(ln -> 'tax_overrides') = 'object' then ln -> 'tax_overrides'
                   else '{}'::jsonb end;
      if v_rate_id is null then
        v_note := 'item-not-on-menu';
      end if;
    end if;

    -- 1. the override for this order type: its own key first, then the alias. A JSON null is the
    --    item editor's "Use default" (an explicit override); a missing key is no override.
    v_has_ov := false;
    v_ov_id := null;
    if v_ov ? v_type then
      v_has_ov := true;
      v_ov_id := nullif(v_ov ->> v_type, '');
    elsif v_alias <> v_type and v_ov ? v_alias then
      v_has_ov := true;
      v_ov_id := nullif(v_ov ->> v_alias, '');
    end if;
    v_rate := null;
    if v_has_ov then
      if v_ov_id is not null then
        select x into v_rate from jsonb_array_elements(v_rates) x where x ->> 'id' = v_ov_id limit 1;
        if v_rate is null then
          -- the override names a rate this venue does not have: the item's own rate, flagged
          v_note := 'override-rate-not-found';
          v_note_id := v_ov_id;
        end if;
      else
        v_rate_id := null;   -- "Use default"
      end if;
    end if;
    -- 2. the item's own rate; 3. the venue default (flagged when a named rate could not be matched).
    if v_rate is null and v_rate_id is not null then
      select x into v_rate from jsonb_array_elements(v_rates) x where x ->> 'id' = v_rate_id limit 1;
      if v_rate is null then
        v_note := case when v_rate_id = '__not_in_menu__' then 'item-not-on-menu' else 'rate-not-found' end;
        v_note_id := v_rate_id;
      end if;
    end if;
    if v_rate is null and v_note is null and v_item_id = 'custom' then
      v_note := 'custom-item';   -- an open price line typed at a till: no Back Office rule
    end if;
    if v_rate is null then
      v_rate := v_default;
      if v_rate is null then
        v_note := 'no-default-rate';   -- 4. rates, but none flagged default: this line books no VAT
        v_note_id := coalesce(v_note_id, v_rate_id);
      end if;
    end if;
    if v_note is not null then
      v_fallbacks := v_fallbacks || jsonb_build_array(jsonb_build_object(
                       'source', 'fallback', 'reason', v_note,
                       'lineId', coalesce(ln ->> 'lineId', ln ->> 'uid', ln ->> 'id'),
                       'itemId', coalesce(v_item_id, ln ->> 'id'),
                       'name', case when jsonb_typeof(ln -> 'name') = 'string' then ln ->> 'name' end,
                       'rateId', v_note_id));
    end if;

    -- The line's money: unit price plus its modifiers (price x qty each, src/lib/channelMoney.js
    -- modsTotal), times the quantity. A JSON number is read as it is (a till line can carry a
    -- float like 4.8500000000000005, which _fence_num would refuse); text goes through _fence_num.
    -- UK VAT inside the price: tax = gross - gross / (1 + r). Added on: tax = gross x r on top.
    v_qty := case when jsonb_typeof(ln -> 'qty') = 'number' then (ln ->> 'qty')::numeric else public._fence_num(ln ->> 'qty') end;
    if v_qty is null or v_qty < 1 then v_qty := 1; end if;
    v_unit := (case when jsonb_typeof(ln -> 'price') = 'number' then (ln ->> 'price')::numeric else public._fence_num(ln ->> 'price') end)
              + coalesce((select sum((case when jsonb_typeof(m -> 'price') = 'number' then (m ->> 'price')::numeric else public._fence_num(m ->> 'price') end)
                                     * greatest(1, case when jsonb_typeof(m -> 'qty') = 'number' then (m ->> 'qty')::numeric else public._fence_num(m ->> 'qty') end))
                            from jsonb_array_elements(case when jsonb_typeof(ln -> 'mods') = 'array' then ln -> 'mods' else '[]'::jsonb end) m
                           where jsonb_typeof(m) = 'object'), 0);
    v_gross := v_unit * v_qty;
    v_pct := case when v_rate is null then 0 else coalesce((v_rate ->> 'rate')::numeric, 0) end;
    if v_rate is null or v_pct = 0 then
      v_net := v_gross; v_tax := 0;
    elsif coalesce(v_rate ->> 'type', 'inclusive') = 'exclusive' then
      v_net := v_gross; v_tax := v_gross * v_pct; v_gross := v_net + v_tax;
      v_sum_excl := v_sum_excl + v_tax;
    else
      v_net := v_gross / (1 + v_pct); v_tax := v_gross - v_net;
    end if;
    v_sum_gross := v_sum_gross + v_gross;
    v_sum_net := v_sum_net + v_net;
    v_sum_tax := v_sum_tax + v_tax;
    if v_rate is not null then
      k := v_rate ->> 'id';
      v_entry := coalesce(v_by_rate -> k, jsonb_build_object(
                   'rate', jsonb_strip_nulls(jsonb_build_object(
                             'id', k, 'code', v_rate ->> 'code', 'name', v_rate ->> 'name',
                             'rate', trim_scale(v_pct), 'type', coalesce(v_rate ->> 'type', 'inclusive'),
                             'active', true,
                             'appliesTo', case when jsonb_typeof(v_rate -> 'applies_to') = 'array' then v_rate -> 'applies_to' else '["all"]'::jsonb end,
                             'isDefault', coalesce((v_rate ->> 'is_default')::boolean, false),
                             'locationId', v_rate ->> 'location_id')),
                   'tax', 0, 'net', 0, 'gross', 0, 'items', 0));
      if not (v_by_rate ? k) then v_order := v_order || k; end if;
      v_by_rate := v_by_rate || jsonb_build_object(k, v_entry || jsonb_build_object(
                     'tax',   (v_entry ->> 'tax')::numeric + v_tax,
                     'net',   (v_entry ->> 'net')::numeric + v_net,
                     'gross', (v_entry ->> 'gross')::numeric + v_gross,
                     'items', (v_entry ->> 'items')::int + 1));
    end if;
  end loop;

  -- One share, one rounding (taxShare.scaleTaxRecord then taxRule.roundVat): the raw sum is scaled
  -- by the goods charged over the goods at menu price, then rounded half up to the penny.
  v_total_tax := public._vat_round(v_sum_tax * v_share);
  v_excl := public._vat_round(v_sum_excl * v_share);
  foreach k in array v_order loop
    v_entry := v_by_rate -> k;
    v_breakdown := v_breakdown || jsonb_build_array(v_entry || jsonb_build_object(
                     'tax',   trim_scale(round((v_entry ->> 'tax')::numeric * v_share, 6)),
                     'net',   trim_scale(round((v_entry ->> 'net')::numeric * v_share, 6)),
                     'gross', trim_scale(round((v_entry ->> 'gross')::numeric * v_share, 6))));
  end loop;
  -- Highest rate first, as calculateOrderTax orders its breakdown.
  select coalesce(jsonb_agg(x order by (x -> 'rate' ->> 'rate')::numeric desc), '[]'::jsonb) into v_breakdown
    from jsonb_array_elements(v_breakdown) x;
  v_record := jsonb_build_object(
                'subtotal', trim_scale(round(v_sum_net * v_share, 6)),
                'totalTax', v_total_tax,
                'total', trim_scale(round(v_sum_gross * v_share, 6)),
                'exclusiveTax', v_excl,
                'breakdown', v_breakdown,
                'hasExclusiveTax', v_sum_excl > 0,
                'source', 'server');
  if v_share < 1 then v_record := v_record || jsonb_build_object('share', trim_scale(v_share)); end if;
  if jsonb_array_length(v_fallbacks) > 0 then v_record := v_record || jsonb_build_object('fallbacks', v_fallbacks); end if;
  return jsonb_build_object('has_rates', true, 'total_tax', v_total_tax, 'exclusive_tax', v_excl,
                            'goods', trim_scale(round(v_sum_gross, 2)), 'record', v_record);
end;
$function$;

-- 2. The venue's one table service rule -----------------------------------------------------------
drop function if exists public.venue_service_rule(uuid);

-- 1. The promo give back --------------------------------------------------------------------------
drop function if exists public.promo_release_atomic(text, text[], text, text);
-- The two columns go too. A use given back while this file was live stays given back (the code's
-- use count was handed back then); nothing reads the columns once this rollback has run.
alter table public.promo_redemptions drop column if exists released_reason;
alter table public.promo_redemptions drop column if exists released_at;

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: release_fn 0, released_columns 0, service_rule_fn 0, has_price_fn 0,
--   vat_false_is_default 0, value_no_price 0, settle_books_deals 0
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'promo_release_atomic') as release_fn,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'promo_redemptions'
     and column_name in ('released_at', 'released_reason')) as released_columns,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'venue_service_rule') as service_rule_fn,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_menu_item_has_price') as has_price_fn,
  (select case when position('= ''false''::jsonb' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_vat_for_lines') as vat_false_is_default,
  (select case when position('v_noprice' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_value') as value_no_price,
  (select case when position('v_deals' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'settle_qr_tab') as settle_books_deals;
