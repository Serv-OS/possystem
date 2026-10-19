-- 20261020a_OPS_channel_parity_2.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Run it BEFORE deploying promo-redeem, and with v5.11.81 on the web.      #
-- #  Safe to run twice. One transaction. Outside service is best (it          #
-- #  replaces functions every public order and QR tab close calls).           #
-- ############################################################################
--
-- WHY (v5.11.81, channel parity round 2: Peter 19 Oct 2026, "fix it all please, we need to be
-- bullet proof"; the POS is central, every channel follows the till):
--   1. A promo code is given back when its order is fully refunded, or voided before it was paid
--      (a catering pay later order burnt its code with no sale). New columns
--      promo_redemptions.released_at / released_reason and promo_release_atomic (service role only;
--      promo-redeem 'release' checks the caller is a till bound to the venue, its staff or the
--      server).
--   2. QR and Pay at table charge the venue's ONE table service rule (venue_service_rule, callable
--      by a QR guest, answers only the rule). QR charged its own percentage; Pay at table charged
--      whatever the last till to publish the table charged.
--   3. The server VAT rule reads an explicit JSON false override as "Use default", as every app
--      engine does (0 live rows carry one).
--   4. A row with no price set (pricing.base null, no price for the order type or menu) never
--      sells for 0.00: the server counts such a line UNKNOWN (never free), as the tills, kiosk,
--      online, QR and catering refuse it. New helper _menu_item_has_price. A real 0.00 still sells.
--   5. A QR tab's check (settle_qr_tab) books the automatic deal lines its rounds took, from the
--      server's own order_pricing, as every till close books its AUTO lines.
--   6. A promo code follows its own offer rules on a public order, as promo-redeem and the apps do
--      (_shared/promoMath.js): a category rule takes its percent off those categories only, a free
--      item code takes that item off, a free delivery code the delivery fee. _public_order_promo
--      takes the order's lines and delivery fee (the old 5 argument function is dropped and
--      replaced; place_public_order passes them). No rule and no lines: every figure as before.
--   7. A deal on some lines takes VAT off those lines' rates only (the till's rule, v5.11.81): the
--      server books the VAT inside what each line was charged when more than one rate meets a deal
--      that hit some lines. A QR tab round now also keeps the deals the server applied
--      (order_pricing.auto_rules, which settle_qr_tab books as deal lines; a round never kept them).
--
-- NOT a live tax calculation (central_tax_constraints.md): the VAT is still worked out ONCE, when
-- the order is booked, by the same function on the venue's stored rules, and stored on the check;
-- the stored rules are read as the apps read them.
--
-- UNDO: 20261020a_OPS_channel_parity_2_ROLLBACK.sql

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_order_line_folded') then
    raise exception 'Run 20261019a_OPS_channel_parity.sql first (it is live). Nothing was changed.';
  end if;
  if to_regclass('public.promo_redemptions') is null or to_regclass('public.device_profiles') is null then
    raise exception 'promo_redemptions or device_profiles is missing: not the OPS DB this file was written for. Nothing was changed.';
  end if;
end
$guard$;

-- 1. A promo code is given back when its order is fully refunded or voided ------------------------
-- WHY: a one time code used on an order that was then refunded in full, or on a catering pay later
-- order cancelled before it was paid, stayed spent: the customer lost the code with no sale. The
-- till (store.refundCheck on a FULL refund, store.voidQueueOrder for an unpaid placed order) now
-- asks promo-redeem 'release'; this marks each use recorded against those orders at the venue as
-- given back and hands the use back to its code, once. A part refund keeps the code used.
alter table public.promo_redemptions add column if not exists released_at timestamptz;
alter table public.promo_redemptions add column if not exists released_reason text;

comment on column public.promo_redemptions.released_at is
  '20261020a (v5.11.81): when this use was given back (its order fully refunded or voided). A released use no longer counts against the code or a per customer limit.';

create or replace function public.promo_release_atomic(p_location_id text, p_order_ids text[], p_order_ref text default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_prefix   text := case when nullif(btrim(coalesce(p_order_ref, '')), '') is not null
                          then 'chk-' || btrim(p_order_ref) || '-' end;
  v_row      record;
  v_released integer := 0;
begin
  if nullif(btrim(coalesce(p_location_id, '')), '') is null then
    return jsonb_build_object('released', 0);
  end if;
  -- Each unreleased use of these orders at this venue: by the order id (a closed check id), or for
  -- a catering pay later order by its ref (its id is chk-<ref>-<uuid>, the page's own).
  for v_row in
    select r.id, r.promo_code_id, r.offer_id
      from public.promo_redemptions r
     where r.location_id = p_location_id
       and r.released_at is null
       and (r.order_id = any(coalesce(p_order_ids, '{}'::text[]))
            or (v_prefix is not null and left(coalesce(r.order_id, ''), length(v_prefix)) = v_prefix))
     order by r.redeemed_at, r.id
     for update of r
  loop
    -- The code row is locked as promo_redeem_atomic locks it, so a redeem and a release of the
    -- same code never interleave.
    perform 1 from public.promo_codes c where c.id = v_row.promo_code_id for update;
    update public.promo_redemptions
       set released_at = now(), released_reason = left(coalesce(nullif(btrim(p_reason), ''), 'refund'), 200)
     where id = v_row.id and released_at is null;
    if found then
      update public.promo_codes
         set uses_count = greatest(0, coalesce(uses_count, 0) - 1),
             status     = case when status = 'redeemed' and greatest(0, coalesce(uses_count, 0) - 1) < coalesce(uses_allowed, 1)
                               then 'issued' else status end,
             updated_at = now()
       where id = v_row.promo_code_id;
      update public.offers
         set redeemed_count = greatest(0, coalesce(redeemed_count, 0) - 1), updated_at = now()
       where id = v_row.offer_id;
      v_released := v_released + 1;
    end if;
  end loop;
  return jsonb_build_object('released', v_released);
end
$function$;

revoke all on function public.promo_release_atomic(text, text[], text, text) from public;
revoke all on function public.promo_release_atomic(text, text[], text, text) from anon, authenticated;
grant execute on function public.promo_release_atomic(text, text[], text, text) to service_role;

comment on function public.promo_release_atomic(text, text[], text, text) is
  '20261020a (v5.11.81): gives back the promo code uses of fully refunded or voided orders at a venue (released_at, the use handed back to the code). Called only by promo-redeem release, which checks the caller is a till bound to the venue, its staff or the service role.';

-- 2. The venue's one table service rule (QR and Pay at table) -------------------------------------
-- WHY: QR pay now and QR tabs charged their own percentage (Back Office, Online Ordering), whatever
-- the tables charged, and Pay at table charged the bill stamped by whichever till last published
-- the table. Both now take the venue's table service rule: the service charge switched on for
-- table service on its device profiles, the master till's first, then Back Office order
-- (src/lib/venueServiceRule.js pickVenueServiceRule is the same rule). The QR page cannot read
-- device profiles, so this answers it: only the rule, nothing else about the venue.
create or replace function public.venue_service_rule(p_location_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce((
    select jsonb_build_object(
             'enabled', true,
             'rate', public._fence_num_or_null(p.service_charge ->> 'rate'),
             'applyTo', case when p.service_charge ->> 'applyTo' = 'minCovers' then 'minCovers' else 'all' end,
             'minCovers', greatest(1, round(coalesce(public._fence_num_or_null(p.service_charge ->> 'minCovers'),
                                                     case when p.service_charge ->> 'applyTo' = 'minCovers' then 1 else 8 end)))::integer)
      from public.device_profiles p
     where p.location_id = p_location_id
       and p.table_service_enabled is distinct from false
       and jsonb_typeof(p.service_charge) = 'object'
       and lower(coalesce(p.service_charge ->> 'enabled', 'false')) = 'true'
       and coalesce(public._fence_num_or_null(p.service_charge ->> 'rate'), 0) > 0
     order by coalesce(p.is_master, false) desc, p.sort_order nulls last, p.created_at nulls last, p.id
     limit 1), '{"enabled": false}'::jsonb)
$function$;

revoke all on function public.venue_service_rule(uuid) from public;
grant execute on function public.venue_service_rule(uuid) to anon, authenticated, service_role;

comment on function public.venue_service_rule(uuid) is
  '20261020a (v5.11.81): the venue''s one table service charge rule ({enabled, rate, applyTo, minCovers} or {enabled:false}). QR and Pay at table charge it; src/lib/venueServiceRule.js is the same rule.';

-- 3. The server VAT rule reads an explicit "false" override as "Use default" ----------------------
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
    -- 20261020a (v5.11.81): an explicit JSON false is "Use default", as every app engine reads it
    -- (src/lib/taxRule.js taxOverrideFor: a falsy override). Its text 'false' named no rate here, so
    -- the line fell to the item's own rate (flagged) where the till took the venue default.
    if v_has_ov and (case when v_ov ? v_type then v_ov -> v_type else v_ov -> v_alias end) = 'false'::jsonb then
      v_ov_id := null;
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

-- 4. A row with no price set never sells for 0.00 -------------------------------------------------
-- WHY: a row whose pricing.base is null, with no price for the order type and no tier on the menu,
-- was sold for 0.00 on every channel (the server valued it free, like tap water at a real 0.00).
-- src/lib/menuPricing.js hasNoSellPrice is the same rule; the multi site menu's "no price".
create or replace function public._menu_item_has_price(p_pricing jsonb, p_channel text, p_menu_id text default null)
returns boolean
language plpgsql
immutable
set search_path to 'pg_catalog'
as $function$
declare
  v_keys text[] := case when p_channel = 'driveThru' then array['driveThru', 'takeaway'] else array[coalesce(p_channel, 'dineIn')] end;
  v_tier jsonb;
  k      text;
begin
  -- A row with no pricing object keeps the legacy scalar rule (it is priced, 0.00 included).
  if jsonb_typeof(p_pricing) is distinct from 'object' then
    return true;
  end if;
  if nullif(btrim(coalesce(p_menu_id, '')), '') is not null and jsonb_typeof(p_pricing -> 'menus' -> p_menu_id) = 'object' then
    v_tier := p_pricing -> 'menus' -> p_menu_id;
    foreach k in array v_keys || array['all', 'base'] loop
      if v_tier ? k and jsonb_typeof(v_tier -> k) <> 'null'
         and not (jsonb_typeof(v_tier -> k) = 'string' and btrim(v_tier ->> k) = '') then
        return true;
      end if;
    end loop;
  end if;
  foreach k in array v_keys || array['base'] loop
    if p_pricing ? k and jsonb_typeof(p_pricing -> k) <> 'null'
       and not (jsonb_typeof(p_pricing -> k) = 'string' and btrim(p_pricing ->> k) = '') then
      return true;
    end if;
  end loop;
  return false;
end
$function$;

revoke all on function public._menu_item_has_price(jsonb, text, text) from public;
revoke all on function public._menu_item_has_price(jsonb, text, text) from anon, authenticated;
grant execute on function public._menu_item_has_price(jsonb, text, text) to service_role;

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
  v_noprice  boolean;    -- 20261020a: the row has no price set for this sale (the "no price" rule)
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
    v_noprice := false;
    if r.id is not null then
      v_floor := public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_menu_id);
      v_noprice := not public._menu_item_has_price(r.pricing, v_channel, v_menu_id);
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
    -- 20261020a (v5.11.81): a row with NO price set (pricing.base null, no price for this order
    -- type or menu: the multi site menu's "no price") never sells for 0.00. It was valued free like
    -- a real 0.00 (tap water, base 0). Paid options can still price it; a line that comes to
    -- nothing is UNKNOWN, never free (the till, kiosk, online, QR and catering refuse it too).
    if v_sell and v_noprice and v_unit <= 0 then
      v_unknown := v_unknown + 1;
    end if;
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
                     -- 20261020a (v5.11.81): the line's place in the order, so a deal's saving can
                     -- be booked on the line it hit (_public_order_auto 'line_minor').
                     'n', jsonb_array_length(v_out),
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

-- 5. A QR tab's check books the deal lines its rounds took ----------------------------------------
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
  v_deals      jsonb := '[]'::jsonb;   -- 20261020a: the deals the server applied to each round
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

  -- 20261020a (v5.11.81): the automatic deal lines the server applied when each round was placed
  -- (customer.order_pricing.auto_rules), summed per rule, as the till's close books its AUTO lines
  -- (src/lib/headlessTax.js qrTabDealLines, the same shape). The money already came off each round;
  -- this records the deal, so reports show it and the daily VAT check reads the goods charged.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.rule_id, 'label', d.name, 'type', 'amount',
           'value', round(d.minor / 100.0, 2), 'amount', round(d.minor / 100.0, 2),
           'scope', 'check', 'isAuto', true, 'source', 'auto') order by d.first_at, d.rule_id), '[]'::jsonb)
    into v_deals
    from (select coalesce(nullif(x ->> 'rule_id', ''), nullif(x ->> 'name', ''), 'deal') as rule_id,
                 coalesce(max(nullif(x ->> 'name', '')), 'Deal') as name,
                 sum(greatest(0, round(coalesce(public._fence_num_or_null(x ->> 'saving_minor'), 0))))::bigint as minor,
                 min(q.created_at) as first_at
            from public.order_queue q
            cross join lateral jsonb_array_elements(case when jsonb_typeof(q.customer -> 'order_pricing' -> 'auto_rules') = 'array'
                                                         then q.customer -> 'order_pricing' -> 'auto_rules' else '[]'::jsonb end) x
           where q.location_id = v_loc and q.ref = any(v_refs) and jsonb_typeof(x) = 'object'
           group by 1) d
   where d.minor > 0;

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
      'discounts', v_deals,
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

-- 6. A promo code follows its own rules: categories, a free item, free delivery -------------------
-- WHY: a promo code's own rules were never read on any channel: an offer for some categories only
-- took its percent off the whole bill, a free item code ("Welcome: free hot drink") took nothing
-- off, a free delivery code took nothing off. _shared/promoMath.js (promo-redeem and the apps) and
-- this function now work a code out on the basket's own lines the same way, in pence. With no
-- category rule and nothing but a subtotal, every figure is exactly what it was.
-- The old 5 argument function goes first, so place_public_order's calls reach this one.
drop function if exists public._public_order_promo(text, text, bigint, text, boolean);

CREATE OR REPLACE FUNCTION public._public_order_promo(p_loc text, p_code text, p_subtotal_minor bigint, p_check_id text, p_consume boolean, p_lines jsonb DEFAULT NULL::jsonb, p_delivery_minor bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_org  uuid;
  c      public.promo_codes%rowtype;
  o      public.offers%rowtype;
  v_sub  numeric := greatest(0, coalesce(p_subtotal_minor, 0)) / 100.0;
  v_amt  numeric := 0;
  v_key  text;
  v_res  jsonb;
  -- 20261020a (v5.11.81): the offer's category rules, a free item and free delivery, worked out on
  -- the order's own lines (_public_order_value lines: unit with options, qty, cat, cats, id, pid) and
  -- its delivery fee, the same steps in pence as _shared/promoMath.js promoDiscountForBasket.
  v_lines    jsonb := case when jsonb_typeof(p_lines) = 'array' then p_lines end;
  v_sub_m    bigint := greatest(0, coalesce(p_subtotal_minor, 0));
  v_inc      text[];
  v_exc      text[];
  v_rule     boolean;
  v_gross    bigint := 0;
  v_elig     bigint := 0;
  v_base     bigint;
  v_unit     bigint;
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  select l.org_id into v_org from public.locations l where l.id::text = p_loc;
  select * into c from public.promo_codes pc where upper(pc.code) = v_code limit 1;
  if c.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'code', v_code);
  end if;
  if c.org_id is distinct from v_org then
    return jsonb_build_object('ok', false, 'reason', 'wrong_venue', 'code', v_code);
  end if;
  if c.status in ('voided', 'expired') or c.voided_at is not null
     or (c.expires_at is not null and c.expires_at < now()) then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_code);
  end if;
  select * into o from public.offers ofr where ofr.id = c.offer_id;
  if o.id is null or not coalesce(o.active, false)
     or (o.valid_from is not null and o.valid_from > now())
     or (o.valid_to is not null and o.valid_to < now()) then
    return jsonb_build_object('ok', false, 'reason', 'inactive', 'code', v_code);
  end if;
  if coalesce(cardinality(o.venue_ids), 0) > 0 and not (p_loc = any(o.venue_ids)) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_venue', 'code', v_code);
  end if;
  if o.min_spend is not null and v_sub < o.min_spend then
    return jsonb_build_object('ok', false, 'reason', 'min_spend', 'code', v_code);
  end if;
  -- 20261020a: the eligible goods. No category rule, or no lines: the whole subtotal, exactly as
  -- before. A rule: the subtotal times the share of the lines' value in those categories.
  v_inc := coalesce(o.include_category_ids, '{}'::text[]);
  v_exc := coalesce(o.exclude_category_ids, '{}'::text[]);
  v_rule := cardinality(v_inc) > 0 or cardinality(v_exc) > 0;
  if v_lines is not null then
    select coalesce(sum(t.u * t.q), 0)::bigint,
           coalesce(sum(t.u * t.q) filter (where (cardinality(v_inc) = 0 or public._fence_cat_match(t.cat, t.cats, v_inc))
                                             and not (cardinality(v_exc) > 0 and public._fence_cat_match(t.cat, t.cats, v_exc))), 0)::bigint
      into v_gross, v_elig
      from (select greatest(0, coalesce(round(public._fence_num(x ->> 'unit')), 0))::bigint as u,
                   greatest(1, coalesce(round(public._fence_num(x ->> 'qty')), 1))::bigint as q,
                   x ->> 'cat' as cat,
                   case when jsonb_typeof(x -> 'cats') = 'array' then x -> 'cats' else '[]'::jsonb end as cats
              from jsonb_array_elements(v_lines) x where jsonb_typeof(x) = 'object') t;
  end if;
  v_base := case when v_rule and v_lines is not null and v_gross > 0 then round(v_sub_m::numeric * v_elig / v_gross)::bigint else v_sub_m end;
  if o.reward_type = 'free_item' and v_lines is not null and o.reward_item_id is not null then
    select min(greatest(0, coalesce(round(public._fence_num(x ->> 'unit')), 0)))::bigint into v_unit
      from jsonb_array_elements(v_lines) x
     where jsonb_typeof(x) = 'object'
       and (x ->> 'id' = o.reward_item_id::text or x ->> 'pid' = o.reward_item_id::text);
    if v_unit is null then
      return jsonb_build_object('ok', false, 'reason', 'free_item_not_in_basket', 'code', v_code);
    end if;
    if v_gross > 0 and v_sub_m < v_gross then
      v_unit := round(v_unit::numeric * v_sub_m / v_gross)::bigint;
    end if;
  end if;
  v_amt := greatest(0, case o.reward_type
                         when 'percent' then case when v_base <> v_sub_m then round(v_base::numeric * coalesce(o.reward_value, 0) / 100) / 100.0
                                                  else round(v_sub * coalesce(o.reward_value, 0) / 100, 2) end
                         when 'fixed'   then case when v_base <> v_sub_m then least(round(coalesce(o.reward_value, 0) * 100), v_base) / 100.0
                                                  else least(coalesce(o.reward_value, 0), v_sub) end
                         when 'free_item' then coalesce(least(v_unit, v_base), 0) / 100.0
                         when 'free_delivery' then greatest(0, coalesce(p_delivery_minor, 0)) / 100.0
                         else 0 end);
  v_key := case when coalesce(p_check_id, '') <> '' then p_check_id || ':' || v_code end;
  if p_consume then
    if v_key is null then
      return jsonb_build_object('ok', false, 'reason', 'no_check', 'code', v_code);
    end if;
    if not exists (select 1 from public.promo_redemptions pr where pr.idempotency_key = v_key) then
      if to_regprocedure('public.promo_redeem_atomic(uuid, integer, uuid, uuid, text, uuid, text, text, uuid, numeric, numeric, text)') is null then
        return jsonb_build_object('ok', false, 'reason', 'unsupported', 'code', v_code);
      end if;
      v_res := public.promo_redeem_atomic(c.id, c.uses_count, o.id, c.org_id, c.code, c.customer_id, p_loc,
                                          p_check_id, null, v_sub, v_amt, v_key);
      if coalesce(v_res ->> 'result', '') not in ('redeemed', 'idempotent_hit') then
        return jsonb_build_object('ok', false, 'reason', coalesce(v_res ->> 'result', 'failed'), 'code', v_code);
      end if;
    end if;
  elsif c.uses_count >= coalesce(c.uses_allowed, 1)
        and not (v_key is not null and exists (select 1 from public.promo_redemptions pr where pr.idempotency_key = v_key)) then
    -- Spent, unless the use is this very order's own (a retry).
    return jsonb_build_object('ok', false, 'reason', 'already_used', 'code', v_code);
  end if;
  return jsonb_build_object('ok', true, 'code', v_code, 'amount_minor', round(v_amt * 100)::bigint, 'offer_id', o.id);
end;
$function$;

revoke all on function public._public_order_promo(text, text, bigint, text, boolean, jsonb, bigint) from public;
revoke all on function public._public_order_promo(text, text, bigint, text, boolean, jsonb, bigint) from anon, authenticated;
grant execute on function public._public_order_promo(text, text, bigint, text, boolean, jsonb, bigint) to service_role;

CREATE OR REPLACE FUNCTION public.place_public_order(p_location_id uuid, p_order jsonb, p_check jsonb DEFAULT NULL::jsonb, p_proof_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid         uuid := auth.uid();
  v_loc         text := p_location_id::text;
  v_source      text := lower(coalesce(p_order ->> 'source', ''));
  v_ref         text := btrim(coalesce(p_order ->> 'ref', ''));
  v_raw         jsonb := case when jsonb_typeof(p_order -> 'customer') = 'object' then p_order -> 'customer' else '{}'::jsonb end;
  v_customer    jsonb;
  v_items       jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_total       numeric := round(public._fence_num(p_order ->> 'total'), 2);
  v_type        text := left(coalesce(nullif(p_order ->> 'type', ''), 'collection'), 40);
  -- Which menu the page priced this basket on (fix round 7): the storefront's own
  -- effectiveMenuId. A per menu 0.00 is a real price on THAT menu and nowhere else.
  v_menu_id     text := nullif(left(btrim(coalesce(p_order ->> 'menu_id', '')), 80), '');
  v_check       jsonb := case when jsonb_typeof(p_check) = 'object' then p_check end;
  v_check_id    text := null;
  v_ip          text := public._fence_client_ip();
  v_tab         boolean;
  v_pi          text;
  v_proof_ids   uuid[] := coalesce(p_proof_ids, '{}'::uuid[]);
  v_card_minor  bigint := 0;
  v_gift_minor  bigint := 0;
  v_card_refs   text[] := '{}'::text[];
  v_bound_ids   uuid[] := '{}'::uuid[];
  v_val         jsonb;
  v_auto        jsonb := jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  v_decl        jsonb;
  v_promo       jsonb := null;
  v_goods_minor bigint := 0;
  v_auto_minor  bigint := 0;
  v_promo_minor bigint := 0;
  v_loy_decl    bigint := 0;
  v_loy_minor   bigint := 0;
  v_unknown     integer := 0;
  v_tol         bigint := 0;
  v_client_due  bigint := 0;
  v_pricing     jsonb := null;
  v_due_minor   bigint := 0;
  v_value_minor bigint := 0;
  v_running     bigint := 0;
  v_paid        boolean := false;
  v_unverified  boolean := false;
  v_state       text := null;
  v_status      text;
  v_token       text;
  v_join        text := null;
  v_tab_ref     text;
  v_written_id  text := null;
  v_sent_at     timestamptz;
  v_event_date  date;
  v_existing    public.public_order_tokens%rowtype;
  v_first       public.order_queue%rowtype;
  v_hold        public.payment_proofs%rowtype;
  v_code_given  text;
  v_bucket      text;
  v_cc          jsonb;
  v_pay_ref     text;
  v_processor   text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session', 'message', 'Please reload the page and try again.');
  end if;
  if p_location_id is null
     or not exists (select 1 from public.locations l where l.id = p_location_id and coalesce(l.status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'venue', 'message', 'This venue is not taking orders.');
  end if;
  if v_source not in ('online', 'qr', 'catering') then
    return jsonb_build_object('ok', false, 'reason', 'source');
  end if;
  if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$' then
    return jsonb_build_object('ok', false, 'reason', 'ref');
  end if;

  -- A retry by the same session gets the first answer back.
  select * into v_existing from public.public_order_tokens t where t.location_id = v_loc and t.ref = v_ref;
  if v_existing.ref is not null then
    if v_existing.placed_by = v_uid then
      return (select jsonb_build_object('ok', true, 'idempotent', true, 'ref', v_ref, 'paid', q.paid,
                                        'status', q.status,
                                        'payment_unverified', coalesce(q.customer ->> 'payment_state', '') in ('checking', 'short'),
                                        'payment_state', q.customer ->> 'payment_state',
                                        'track_token', v_existing.token,
                                        'tab_join_code', q.customer ->> 'tab_join_code')
                from public.order_queue q where q.location_id = v_loc and q.ref = v_ref);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;
  if exists (select 1 from public.order_queue q where q.location_id = v_loc and q.ref = v_ref) then
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;

  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 200 or pg_column_size(v_items) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'items');
  end if;
  if pg_column_size(v_raw) > 32768 then
    return jsonb_build_object('ok', false, 'reason', 'customer');
  end if;
  if v_total < 0 or v_total > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'total');
  end if;
  if public._fence_is_locked('order:uid:' || v_uid::text) then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this device. Please wait a few minutes.');
  end if;

  -- Server fields a phone must never set, on any order. Tab fields and the card payment
  -- id are put back below only where the server has checked them.
  v_customer := v_raw - 'paid' - 'payment_verified' - 'payment_unverified' - 'payment_state' - 'payment_ref'
                      - 'payment_processor' - 'payment_confirmed_by' - 'payment_confirmed_note'
                      - 'payment_verified_at' - 'order_pricing' - 'tab_join_code' - 'staff' - 'placed_via'
                      - 'tab_open' - 'tab_ref' - 'round_ref' - 'tab_opened_at' - 'pre_auth_amount'
                      - 'tab_running_total' - 'payment_intent_id';
  v_tab := v_source = 'qr' and public._fence_bool(v_raw ->> 'tab_open');
  v_pi := nullif(left(btrim(coalesce(v_raw ->> 'payment_intent_id', '')), 200), '');
  v_check_id := case when v_check is not null then nullif(left(btrim(coalesce(v_check ->> 'id', '')), 80), '') end;

  -- What the order is worth to the server: its lines from the menu, less the venue's own
  -- automatic discounts (catering has none).
  v_val := public._public_order_value(v_loc, v_source, v_type, v_items, v_menu_id);
  v_items := v_val -> 'items';
  v_goods_minor := (v_val ->> 'goods_minor')::bigint;
  v_unknown := (v_val ->> 'unknown_lines')::integer;
  if v_source in ('online', 'qr') then
    v_auto := public._public_order_auto(v_loc, v_source, v_val -> 'lines');
    v_auto_minor := least(v_goods_minor, (v_auto ->> 'total_minor')::bigint);
  end if;
  v_tol := least(50, jsonb_array_length(v_items) + 3);
  v_decl := public._public_order_declared(p_order, v_check, v_source);

  -- Money proofs named by the caller: this venue, not used before, fresh, and bound to this
  -- order (its processor order reference, its check's ledger key, or a card payment no other
  -- order names).
  perform 1 from public.payment_proofs p where p.id = any(v_proof_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind = 'gift'), 0),
         coalesce(array_agg(p.payment_ref) filter (where p.kind = 'card'), '{}'::text[]),
         coalesce(array_agg(p.id), '{}'::uuid[])
    into v_card_minor, v_gift_minor, v_card_refs, v_bound_ids
    from public.payment_proofs p
   where p.id = any(v_proof_ids)
     and p.location_id = v_loc
     and p.kind in ('card', 'gift')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '24 hours'
     and public._public_order_proof_bound(v_loc, v_ref, v_check_id, p.kind, p.payment_ref, p.meta);

  if v_tab then
    -- A QR tab: the card hold must be proven by the server.
    if v_pi is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    select * into v_hold
      from public.payment_proofs p
     where p.kind = 'preauth' and p.payment_ref = v_pi and p.location_id = v_loc
     order by p.verified_at desc
     limit 1
     for update;
    if v_hold.id is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    -- A hold that was already captured is a closed tab: no new rounds on it.
    if exists (select 1 from public.payment_proofs p
                where p.kind = 'capture' and p.payment_ref = v_pi and p.location_id = v_loc) then
      return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                'message', 'This tab is already closed. Please start a new order.');
    end if;
    -- Every item of a round must be on the menu: a round is settled from its value later.
    if v_unknown > 0 then
      return jsonb_build_object('ok', false, 'reason', 'items',
                                'message', 'Something in this order is no longer on the menu. Please refresh the menu and try again.');
    end if;
    select * into v_first
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = v_pi
     order by q.created_at
     limit 1;
    if v_first.ref is not null then
      -- A new round on an open tab: only the tab's opener, a phone that joined it with
      -- the table code, or a round that carries the code.
      select max(q.customer ->> 'tab_join_code') into v_join
        from public.order_queue q
       where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
         and public._fence_bool(q.customer ->> 'tab_open')
         and q.customer ->> 'payment_intent_id' = v_pi;
      if not public._qr_tab_is_member(v_loc, v_pi, v_uid) then
        v_bucket := 'join:' || v_loc || ':' || md5(v_pi);
        if public._fence_is_locked(v_bucket) then
          return jsonb_build_object('ok', false, 'reason', 'locked', 'message', 'Too many wrong codes. Ask a member of staff.');
        end if;
        v_code_given := nullif(public._fence_norm_code(coalesce(p_order ->> 'tab_join_code', v_raw ->> 'tab_join_code')), '');
        if v_code_given is null or coalesce(v_join, '') = '' or v_code_given <> public._fence_norm_code(v_join) then
          if v_code_given is not null then
            perform public._fence_count(v_bucket, 8, interval '1 hour', interval '1 hour');
          end if;
          return jsonb_build_object('ok', false, 'reason', 'tab_not_yours',
                                    'message', 'Ask the person who opened this tab for the table code.');
        end if;
      end if;
      v_tab_ref := coalesce(v_first.customer ->> 'tab_ref', v_first.ref);
      v_customer := v_customer || jsonb_build_object('tab_opened_at',
                      coalesce(v_first.customer ->> 'tab_opened_at', v_first.created_at::text));
    else
      -- Opening a tab. The hold must have been checked in the last 30 minutes (the
      -- phone asks for the proof just before it places the first round), must not have
      -- opened another tab already (a tab whose rounds were all collected), and must not
      -- belong to another order.
      if v_hold.used_by_ref is not null then
        return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                  'message', 'This tab is already closed. Please start a new order.');
      end if;
      if v_hold.verified_at < now() - interval '30 minutes'
         or (nullif(btrim(coalesce(v_hold.meta ->> 'order_ref', '')), '') is not null and v_hold.meta ->> 'order_ref' <> v_ref) then
        return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                  'message', 'We could not confirm the card hold for this tab. Please try again.');
      end if;
    end if;
    -- What this round is worth (never below the menu, less the automatic discounts), and
    -- the tab may never run past its card hold (fix round 2): the hold is all the money a
    -- tab is sure of.
    v_value_minor := greatest(round(v_total * 100)::bigint, v_goods_minor - v_auto_minor - v_tol);
    select coalesce(sum(greatest(round(q.total * 100)::bigint,
                                 coalesce((q.customer -> 'order_pricing' ->> 'value_minor')::bigint, 0))), 0)
      into v_running
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = v_pi;
    if v_running + v_value_minor > v_hold.amount_minor then
      return jsonb_build_object('ok', false, 'reason', 'over_hold',
                                'hold_minor', v_hold.amount_minor, 'running_minor', v_running, 'round_minor', v_value_minor,
                                'message', 'This round would take the tab past its card hold. Close the tab and start a new one, or ask a member of staff.');
    end if;
    if v_first.ref is not null then
      if not public._qr_tab_is_member(v_loc, v_pi, v_uid) then
        insert into public.qr_tab_members (location_id, pi_hash, uid)
        values (v_loc, md5(v_pi), v_uid)
        on conflict do nothing;
      end if;
    else
      update public.payment_proofs set used_by_ref = v_loc || ':' || v_ref, used_at = now() where id = v_hold.id;
      v_join := public._fence_random_digits(6);
      v_tab_ref := v_ref;
      v_customer := v_customer || jsonb_build_object('tab_opened_at', now());
    end if;
    v_customer := v_customer || jsonb_build_object(
                    'tab_open', true, 'payment_intent_id', v_pi, 'tab_join_code', v_join,
                    'tab_ref', v_tab_ref, 'round_ref', v_ref,
                    'pre_auth_amount', round(v_hold.amount_minor / 100.0, 2),
                    -- 20261020a (v5.11.81): a round keeps the deals the server applied (auto_rules,
                    -- which settle_qr_tab books as the check's deal lines; a round never kept them)
                    -- and what each took off which line (auto_lines).
                    'order_pricing', jsonb_build_object('goods_minor', v_goods_minor, 'auto_minor', v_auto_minor,
                                                        'auto_rules', v_auto -> 'rules', 'auto_lines', v_auto -> 'line_minor',
                                                        'value_minor', v_value_minor, 'hold_minor', v_hold.amount_minor));
    v_total := greatest(v_total, round(v_value_minor / 100.0, 2));
    v_paid := false;
    v_status := 'prep';
  else
    -- QR has no pay later: a QR order is either paid now or a round of a tab. Online
    -- always pays too; an online order that arrives without its check (the page could
    -- not build it) is treated as paid now with an empty check, so it is proven or
    -- checked like any other. Only catering has pay later.
    if v_check is null and v_source = 'qr' then
      return jsonb_build_object('ok', false, 'reason', 'payment', 'message', 'Please pay for your order to send it.');
    end if;
    if v_check is null and v_source = 'online' then
      v_check := '{}'::jsonb;
    end if;
    -- The card payment id stays only when it is this order's own proven payment.
    if v_pi is not null and v_pi = any(v_card_refs) then
      v_customer := v_customer || jsonb_build_object('payment_intent_id', v_pi);
    end if;
    -- The promo code the order names: checked here (nothing written yet), and used up
    -- below, once nothing can refuse the order any more (a pay later order only checks it;
    -- the page records the use after placing).
    if v_decl ->> 'promo_code' is not null and v_unknown = 0 then
      -- 20261020a: with the order's own lines and delivery fee (category rules, a free item, free delivery).
      v_promo := public._public_order_promo(v_loc, v_decl ->> 'promo_code', v_goods_minor - v_auto_minor,
                                            v_check_id, false, v_val -> 'lines',
                                            round(greatest(0, coalesce(public._fence_num(v_customer ->> 'delivery_fee'), 0)) * 100)::bigint);
      if coalesce((v_promo ->> 'ok')::boolean, false) then
        v_promo_minor := least((v_decl ->> 'promo_minor')::bigint, (v_promo ->> 'amount_minor')::bigint);
      end if;
    end if;
    v_loy_decl := (v_decl ->> 'loyalty_minor')::bigint;
    if v_check is not null then
      -- A percent reward is worked out on the goods less the venue's AUTOMATIC deals, which is
      -- the figure the storefront takes its percent of (OnlineCheckout.jsx:891 and :291), and
      -- a free item reward is the cheapest line the server priced. The whole loyalty benefit
      -- is then capped at what is LEFT to pay for the goods, deals and promo code off
      -- (OnlineCheckout.jsx:338), so an order can never be given away twice over.
      v_loy_minor := public._public_order_loyalty(v_loc, v_ref, v_check_id, v_loy_decl,
                                                  greatest(0, v_goods_minor - v_auto_minor),
                                                  greatest(0, v_goods_minor - v_auto_minor - v_promo_minor),
                                                  v_val -> 'lines');
    end if;
    v_client_due := greatest(round(v_total * 100)::bigint,
                             case when v_check is not null
                                  then round(greatest(0, public._fence_num(v_check ->> 'total')) * 100)::bigint else 0 end);
    v_pricing := jsonb_build_object(
                   'goods_minor', v_goods_minor, 'auto_minor', v_auto_minor, 'auto_rules', v_auto -> 'rules',
                   -- 20261020a (v5.11.81): what each deal took off which line, for the check's VAT.
                   'auto_lines', v_auto -> 'line_minor',
                   'promo_code', v_decl ->> 'promo_code', 'promo_minor', v_promo_minor,
                   'promo_reason', case when v_promo is not null and not coalesce((v_promo ->> 'ok')::boolean, false)
                                        then v_promo ->> 'reason' end,
                   'loyalty_declared_minor', v_loy_decl, 'loyalty_minor', v_loy_minor,
                   'tolerance_minor', v_tol, 'client_due_minor', v_client_due,
                   'unknown_lines', v_unknown, 'max_unit_minor', (v_val ->> 'max_unit_minor')::bigint,
                   'menu_id', v_menu_id);
    v_due_minor := public._public_order_due(v_pricing, v_loy_minor);
    if v_check is not null then
      v_paid := v_unknown = 0
                and case when v_due_minor > 0 then (v_card_minor + v_gift_minor) >= v_due_minor
                         else (v_card_minor + v_gift_minor) > 0 or v_loy_minor > 0 or v_promo_minor > 0 end;
      v_unverified := not v_paid;
      -- Money may have been taken: never refused for the venue, but one network can
      -- only send so many orders it cannot prove.
      if v_unverified and v_ip is not null and public._fence_is_locked('order:unproven:ip:' || v_ip) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this network. Please ask a member of staff.');
      end if;
      -- Nothing refuses the order from here on: use the promo code up now. A code another
      -- order used up a moment ago is no discount after all. The loyalty discount worked out
      -- above keeps the smaller ceiling it was given (it was valued net of a promo code that
      -- turned out not to apply). That can only make the order MORE short, never less, which
      -- is the right way round: staff confirm it on the till.
      if v_promo_minor > 0 then
        v_promo := public._public_order_promo(v_loc, v_decl ->> 'promo_code', v_goods_minor - v_auto_minor,
                                              v_check_id, true, v_val -> 'lines',
                                              round(greatest(0, coalesce(public._fence_num(v_customer ->> 'delivery_fee'), 0)) * 100)::bigint);
        if not coalesce((v_promo ->> 'ok')::boolean, false) then
          v_promo_minor := 0;
          v_pricing := v_pricing || jsonb_build_object('promo_minor', 0, 'promo_reason', v_promo ->> 'reason');
          v_due_minor := public._public_order_due(v_pricing, v_loy_minor);
          v_paid := v_unknown = 0
                    and case when v_due_minor > 0 then (v_card_minor + v_gift_minor) >= v_due_minor
                             else (v_card_minor + v_gift_minor) > 0 or v_loy_minor > 0 end;
          v_unverified := not v_paid;
        end if;
      end if;
      if v_unverified then
        v_state := case when v_unknown > 0 or (v_card_minor + v_gift_minor) > 0 then 'short' else 'checking' end;
      end if;
      v_status := case when v_paid and v_source <> 'catering' then 'prep' else 'received' end;
    else
      -- Catering pay later: no money taken, so the venue collects it later, at no less
      -- than the amount due.
      v_paid := false;
      v_status := 'received';
      if (v_ip is not null and public._fence_is_locked('order:later:ip:' || v_ip))
         or public._fence_is_locked('order:later:loc:' || v_loc) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders right now. Please try again in a few minutes.');
      end if;
    end if;
    v_customer := v_customer || jsonb_build_object('order_pricing',
                    v_pricing || jsonb_build_object('due_minor', v_due_minor, 'proven_minor', v_card_minor + v_gift_minor));
    v_total := greatest(v_total, round(v_due_minor / 100.0, 2));
  end if;

  if v_check is not null then
    v_cc := public._public_order_check_row(v_loc, v_ref, v_source, v_type, v_check, v_items, v_customer);
    v_pay_ref := coalesce(nullif(v_check ->> 'stripe_payment_intent_id', ''),
                          case when jsonb_typeof(v_check -> 'payment_intents') = 'array'
                               then nullif(v_check -> 'payment_intents' -> 0 ->> 'id', '') end,
                          v_pi);
    v_processor := case when coalesce(v_check ->> 'processor', v_raw ->> 'processor') in ('stripe', 'ryft', 'adyen')
                        then coalesce(v_check ->> 'processor', v_raw ->> 'processor') end;
  end if;
  if v_unverified then
    v_customer := v_customer || jsonb_strip_nulls(jsonb_build_object(
                    'payment_unverified', true, 'payment_state', v_state,
                    'payment_ref', left(v_pay_ref, 200), 'payment_processor', v_processor));
  end if;

  begin
    v_sent_at := nullif(p_order ->> 'sent_at', '')::timestamptz;
  exception when others then
    v_sent_at := null;
  end;
  if v_sent_at is null or v_sent_at < now() - interval '1 hour' or v_sent_at > now() + interval '400 days' then
    v_sent_at := now();
  end if;
  begin
    v_event_date := nullif(p_order ->> 'event_date', '')::date;
  exception when others then
    v_event_date := null;
  end;
  if v_event_date is not null and (v_event_date < current_date - 1 or v_event_date > current_date + 400) then
    v_event_date := null;
  end if;

  perform set_config('servos.public_order', 'on', true);
  insert into public.order_queue
    (ref, location_id, type, customer, items, total, status, staff, sent_at, collection_time, is_asap,
     source, paid, payment_method, event_date)
  values
    (v_ref, v_loc, v_type, v_customer, v_items, v_total, v_status, null, v_sent_at,
     left(nullif(p_order ->> 'collection_time', ''), 40), public._fence_bool(p_order ->> 'is_asap'),
     v_source, v_paid, case when v_paid then left(coalesce(nullif(p_order ->> 'payment_method', ''), 'card'), 40) else null end,
     v_event_date);
  perform set_config('servos.public_order', 'off', true);

  if v_paid and v_check is not null then
    v_written_id := public._public_order_write_check(
                      v_cc, least(v_card_minor, v_due_minor), '{}'::jsonb,
                      jsonb_build_object('goods_minor', v_goods_minor,
                                         'owed_minor', greatest(0, v_goods_minor - v_auto_minor
                                                                   - v_promo_minor - v_loy_minor),
                                         'proven_minor', v_card_minor + v_gift_minor,
                                         'gift_minor', v_gift_minor, 'loyalty_minor', v_loy_minor,
                                         'promo_minor', v_promo_minor));
    update public.payment_proofs
       set used_by_ref = v_loc || ':' || v_ref, used_at = now()
     where location_id = v_loc and used_by_ref is null
       and (id = any(v_bound_ids)
            or (kind = 'loyalty' and id = any(v_proof_ids)
                and public._public_order_proof_bound(v_loc, v_ref, v_check_id, kind, payment_ref, meta)));
  elsif v_check is not null then
    insert into public.public_order_pending_checks
      (location_id, ref, check_row, due_minor, client_total, payment_refs, placed_by, pricing, unknown_lines)
    values
      (v_loc, v_ref, v_cc, v_due_minor, round(public._fence_num(v_check ->> 'total'), 2),
       public._public_order_payment_refs(v_check, v_pi), v_uid, v_pricing, v_unknown)
    on conflict (location_id, ref) do nothing;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.public_order_tokens (location_id, ref, token, placed_by, paid)
  values (v_loc, v_ref, v_token, v_uid, v_paid);

  perform public._fence_count('order:uid:' || v_uid::text, 30, interval '10 minutes', interval '10 minutes');
  if v_unverified and v_ip is not null then
    perform public._fence_count('order:unproven:ip:' || v_ip, 60, interval '10 minutes', interval '10 minutes');
  end if;
  if not v_tab and v_check is null then
    if v_ip is not null then
      perform public._fence_count('order:later:ip:' || v_ip, 20, interval '10 minutes', interval '10 minutes');
    end if;
    perform public._fence_count('order:later:loc:' || v_loc, 200, interval '10 minutes', interval '10 minutes');
  end if;

  return jsonb_build_object('ok', true, 'ref', v_ref, 'paid', v_paid, 'status', v_status,
                            'payment_unverified', v_unverified, 'payment_state', v_state, 'track_token', v_token,
                            'tab_join_code', v_join, 'check_id', v_written_id,
                            'due_minor', case when v_tab then null else v_due_minor end,
                            'proven_minor', case when v_tab then null else v_card_minor + v_gift_minor end);
end;
$function$;

-- 7. A deal on some lines takes VAT off those lines' rates only ------------------------------------
-- WHY (confirmed minor, "UK VAT on a targeted discount is spread over every rate"): a deal on the
-- 20% burger beside a 0% sandwich booked the VAT as the whole bill's VAT times charged over goods,
-- the same share on every rate, so the 0% line "lost" VAT it never had. The till, kiosk and the
-- online and QR pages now book the VAT inside what EACH line was charged (taxShare
-- .inclusiveTaxOnChargedLines); the server books the same from its own deal figures, so a page's
-- figure still agrees with it to the penny. Still worked out ONCE, when the order is booked, by
-- the same VAT function on the venue's stored rules; one rate, or a deal spread evenly: unchanged.
--   _public_order_auto   also answers what each deal took off which line ('line_minor').
--   _order_lines_charged (new, internal) each line at what it was charged.
--   _public_order_check_row  the per line VAT, only when some line kept a different share.
CREATE OR REPLACE FUNCTION public._public_order_auto(p_loc text, p_channel text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tz      text;
  u_line    integer[];
  u_price   bigint[];
  u_used    boolean[];
  l_cat     text[];
  l_cats    jsonb[];
  v_n       integer := 0;
  v_total   bigint := 0;
  v_applied jsonb := '[]'::jsonb;
  r         public.discount_rules%rowtype;
  g         jsonb;
  v_ids     text[];
  v_rids    text[];
  v_avail   integer[];
  v_deal    integer[];
  v_reward  integer[];
  v_pick    integer[];
  v_claim   integer[];
  v_need    integer;
  v_fire    integer;
  v_count   integer;
  v_save    bigint;
  v_orig    bigint;
  v_rtype   text;
  v_rv      numeric;
  v_gi      integer;
  k         integer;
  u_save    bigint[];
  v_lsave   jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from public.locations l where l.id::text = p_loc;

  select array_agg(x ->> 'cat' order by li), array_agg(coalesce(x -> 'cats', '[]'::jsonb) order by li)
    into l_cat, l_cats
    from jsonb_array_elements(p_lines) with ordinality as l(x, li);
  select array_agg(li::integer order by li, q), array_agg(coalesce((x ->> 'unit')::bigint, 0) order by li, q)
    into u_line, u_price
    from jsonb_array_elements(p_lines) with ordinality as l(x, li)
    cross join lateral generate_series(1, greatest(1, least(999, coalesce((x ->> 'qty')::integer, 1)))) as q;
  v_n := coalesce(cardinality(u_line), 0);
  if v_n = 0 or v_n > 5000 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  u_used := array_fill(false, array[v_n]);
  u_save := array_fill(0::bigint, array[v_n]);

  for r in
    select * from public.discount_rules d
     where d.location_id = p_loc and d.active is true
     order by d.priority desc nulls last, d.sort_order nulls last, d.created_at, d.id
  loop
    if r.channels is not null and public._fence_js_truthy(r.channels)
       and not public._fence_js_truthy(r.channels -> p_channel) then
      continue;
    end if;
    if not (public._fence_rule_live(r.schedule, v_tz, now())
            or public._fence_rule_live(r.schedule, v_tz, now() - interval '20 minutes')) then
      continue;
    end if;
    v_rtype := coalesce(r.reward_type, 'percent');
    v_rv := coalesce(r.reward_value, 0);

    if coalesce(r.trigger_type, 'buy_x') = 'bundle' then
      continue when jsonb_typeof(r.trigger_groups) is distinct from 'array' or jsonb_array_length(r.trigger_groups) = 0;
      v_fire := null;
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        select count(*) into v_count
          from generate_subscripts(u_line, 1) s
         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids);
        if v_count < v_need then
          v_fire := 0;
          exit;
        end if;
        v_fire := least(coalesce(v_fire, v_count / v_need), v_count / v_need);
      end loop;
      continue when coalesce(v_fire, 0) < 1;
      v_orig := 0;
      v_claim := '{}'::integer[];
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        v_pick := array(select s from generate_subscripts(u_line, 1) s
                         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                         order by u_price[s], s
                         limit v_need * v_fire);
        v_orig := v_orig + coalesce((select sum(u_price[s]) from unnest(v_pick) s), 0);
        v_claim := v_claim || v_pick;
      end loop;
      v_save := round(greatest(0, v_orig - v_rv * 100 * v_fire))::bigint;
      continue when v_save <= 0;
      foreach k in array v_claim loop
        u_used[k] := true;
      end loop;
      -- 20261020a: each unit's part of the saving, by its price (lib/discountEngine.js spreads a
      -- bundle's saving over its items the same way).
      if v_orig > 0 then
        foreach k in array v_claim loop
          u_save[k] := u_save[k] + round(u_price[k]::numeric * v_save / v_orig)::bigint;
        end loop;
      end if;

    elsif coalesce(r.trigger_type, 'buy_x') = 'buy_x' then
      v_ids := coalesce(r.trigger_category_ids, '{}'::text[]);
      v_rids := coalesce(r.reward_category_ids, '{}'::text[]);
      v_need := coalesce(r.trigger_qty, 2) + coalesce(r.reward_qty, 1);
      continue when v_need <= 0;
      v_avail := array(select s from generate_subscripts(u_line, 1) s
                        where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                        order by u_price[s], s);
      continue when coalesce(cardinality(v_avail), 0) < v_need;
      v_fire := cardinality(v_avail) / v_need;
      v_deal := v_avail[1 : v_need * v_fire];
      v_reward := v_deal[1 : greatest(0, coalesce(r.reward_qty, 1) * v_fire)];
      if coalesce(cardinality(v_rids), 0) > 0 then
        v_reward := array(select s from unnest(v_reward) with ordinality as a(s, o)
                           where public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_rids)
                           order by o);
      end if;
      continue when coalesce(cardinality(v_reward), 0) = 0;
      select coalesce(sum(case v_rtype
                            when 'percent' then round(u_price[s] * v_rv / 100)
                            when 'amount'  then least(round(v_rv * 100), u_price[s])
                            when 'free'    then u_price[s]
                            else 0 end), 0)::bigint
        into v_save
        from unnest(v_reward) s;
      continue when v_save <= 0;
      foreach k in array v_deal loop
        u_used[k] := true;
      end loop;
      -- 20261020a: each reward unit's own saving (the sum above, unit by unit).
      foreach k in array v_reward loop
        u_save[k] := u_save[k] + (case v_rtype
                                    when 'percent' then round(u_price[k] * v_rv / 100)
                                    when 'amount'  then least(round(v_rv * 100), u_price[k])
                                    when 'free'    then u_price[k]
                                    else 0 end)::bigint;
      end loop;
    else
      continue;
    end if;

    v_total := v_total + v_save;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('rule_id', r.id, 'name', r.name, 'saving_minor', v_save));
  end loop;

  -- 20261020a (v5.11.81): what the deals took off each line, by the line's place in the order
  -- (_public_order_value's 'n'), so the check books a deal's VAT on the lines it hit.
  select coalesce(jsonb_agg(jsonb_build_object('n', (p_lines -> (t.li - 1) ->> 'n')::integer, 'saving_minor', t.sv) order by t.li), '[]'::jsonb)
    into v_lsave
    from (select u_line[s] as li, sum(u_save[s])::bigint as sv
            from generate_subscripts(u_line, 1) s
           group by u_line[s]) t
   where t.sv > 0 and coalesce(p_lines -> (t.li - 1) ->> 'n', '') ~ '^[0-9]{1,6}$';
  return jsonb_build_object('total_minor', v_total, 'rules', v_applied, 'line_minor', v_lsave);
end;
$function$;

create or replace function public._order_lines_charged(p_items jsonb, p_saves jsonb, p_auto_minor bigint)
returns jsonb
language plpgsql
stable
set search_path = public
as $function$
-- 20261020a (v5.11.81): what each line of a public order was charged after the venue's automatic
-- deals, the till's steps (_shared/lineCharged.js chargedLineValues, src/lib/taxBasis.js
-- allocateCheckBasis): each deal's saving comes off the line it hit (p_saves: { n, saving_minor },
-- n = the line's place in p_items), whatever is left of the deals' total (p_auto_minor) is spread
-- over the lines by value. Returns { items, differ, factor }: the lines at what each was charged
-- (the options folded into the price, the line's tax keys kept, so the VAT rules read them as
-- before), and whether some line kept a different share of its money from the rest (only then
-- does a deal's VAT belong to some rates more than others). Null when there is nothing to do.
declare
  v_n      integer;
  g        numeric[] := '{}'::numeric[];
  rem      numeric[] := '{}'::numeric[];
  x        jsonb;
  s        jsonb;
  v_qty    numeric;
  v_unit   numeric;
  v_left   numeric;
  v_take   numeric;
  v_idx    integer;
  v_rest   numeric;
  v_factor numeric;
  v_f      numeric;
  v_first  numeric;
  v_differ boolean := false;
  v_out    jsonb := '[]'::jsonb;
  i        integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_saves) is distinct from 'array' then
    return null;
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n = 0 or v_n > 1000 or jsonb_array_length(p_saves) = 0 then
    return null;
  end if;
  -- Each line's money as the VAT rules read it (_vat_for_lines): unit price plus its options
  -- (price x qty each), times the quantity. A voided line or a non line is worth nothing.
  for i in 1 .. v_n loop
    x := p_items -> (i - 1);
    v_unit := 0;
    v_qty := 1;
    if jsonb_typeof(x) = 'object' and not coalesce((x ->> 'voided')::boolean, false) then
      v_qty := case when jsonb_typeof(x -> 'qty') = 'number' then (x ->> 'qty')::numeric else public._fence_num(x ->> 'qty') end;
      if v_qty is null or v_qty < 1 then v_qty := 1; end if;
      v_unit := (case when jsonb_typeof(x -> 'price') = 'number' then (x ->> 'price')::numeric else public._fence_num(x ->> 'price') end)
                + coalesce((select sum((case when jsonb_typeof(m -> 'price') = 'number' then (m ->> 'price')::numeric else public._fence_num(m ->> 'price') end)
                                       * greatest(1, case when jsonb_typeof(m -> 'qty') = 'number' then (m ->> 'qty')::numeric else public._fence_num(m ->> 'qty') end))
                              from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m
                             where jsonb_typeof(m) = 'object'), 0);
    end if;
    g := g || (v_unit * v_qty);
    rem := rem || (v_unit * v_qty);
  end loop;
  -- The deals' savings off the lines they hit, never more than a line holds or than the total.
  v_left := greatest(0, coalesce(p_auto_minor, 0)) / 100.0;
  for s in select e from jsonb_array_elements(p_saves) e loop
    exit when v_left <= 0;
    continue when jsonb_typeof(s) is distinct from 'object' or coalesce(s ->> 'n', '') !~ '^[0-9]{1,6}$';
    v_idx := (s ->> 'n')::integer + 1;
    continue when v_idx > v_n;
    v_take := least(greatest(0, public._fence_num(s ->> 'saving_minor')) / 100.0, greatest(0, rem[v_idx]), v_left);
    if v_take > 0 then
      rem[v_idx] := rem[v_idx] - v_take;
      v_left := v_left - v_take;
    end if;
  end loop;
  -- The rest spread by value.
  select coalesce(sum(r), 0) into v_rest from unnest(rem) r;
  v_factor := case when v_rest > 0 then greatest(0, 1 - v_left / v_rest) else 0 end;
  for i in 1 .. v_n loop
    x := p_items -> (i - 1);
    v_f := case when g[i] <> 0 then rem[i] * v_factor / g[i] else 0 end;
    if g[i] > 0 then
      if v_first is null then
        v_first := v_f;
      elsif abs(v_f - v_first) > 0.000000001 then
        v_differ := true;
      end if;
    end if;
    if jsonb_typeof(x) = 'object' and not coalesce((x ->> 'voided')::boolean, false) then
      v_qty := case when jsonb_typeof(x -> 'qty') = 'number' then (x ->> 'qty')::numeric else public._fence_num(x ->> 'qty') end;
      if v_qty is null or v_qty < 1 then v_qty := 1; end if;
      x := (x - 'mods') || jsonb_build_object('price', rem[i] * v_factor / v_qty, 'qty', v_qty);
    end if;
    v_out := v_out || jsonb_build_array(x);
  end loop;
  return jsonb_build_object('items', v_out, 'differ', v_differ, 'factor', v_factor);
end;
$function$;

revoke all on function public._order_lines_charged(jsonb, jsonb, bigint) from public;
revoke all on function public._order_lines_charged(jsonb, jsonb, bigint) from anon, authenticated;
grant execute on function public._order_lines_charged(jsonb, jsonb, bigint) to service_role;

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
  v_lc       jsonb;
  v_by       jsonb;
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
  -- 20261020a (v5.11.81, the till's rule, taxShare.inclusiveTaxOnChargedLines): a deal on SOME
  -- lines takes VAT off those lines' rates only. With more than one rate and deals that kept some
  -- lines' share apart from the rest, the VAT is the VAT inside what each line was charged (the
  -- server's own deal figures per line, order_pricing.auto_lines). One rate, or the same share
  -- on every line: the figure above, unchanged. Added on (US) tax already has the deals in its
  -- basis on the page and is left alone.
  if v_share < 1 and v_pricing is not null and jsonb_typeof(v_pricing -> 'auto_lines') = 'array'
     and jsonb_array_length(v_pricing -> 'auto_lines') > 0
     and coalesce((v_srv ->> 'has_rates')::boolean, false)
     and coalesce((v_srv ->> 'exclusive_tax')::numeric, 0) = 0
     and jsonb_typeof(v_srv -> 'record' -> 'breakdown') = 'array'
     and jsonb_array_length(v_srv -> 'record' -> 'breakdown') > 1 then
    v_lc := public._order_lines_charged(p_items, v_pricing -> 'auto_lines', coalesce((v_pricing ->> 'auto_minor')::bigint, 0));
    if v_lc is not null and coalesce((v_lc ->> 'differ')::boolean, false) then
      v_by := public._public_order_vat(p_loc, v_lc -> 'items', v_type, 1);
      if coalesce((v_by ->> 'has_rates')::boolean, false) and coalesce((v_by ->> 'exclusive_tax')::numeric, 0) = 0 then
        v_srv := v_by || jsonb_build_object('record', (v_by -> 'record')
                   || jsonb_build_object('share', trim_scale(v_share), 'byLine', true));
      end if;
    end if;
  end if;
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

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   release_fn 1, release_anon_can_call 0, released_columns 2, service_rule_fn 1,
--   service_rule_anon_can_call 1, vat_false_is_default 1, has_price_fn 1, value_no_price 1,
--   settle_books_deals 1, promo_takes_lines 1, old_promo_gone 0, order_passes_lines 1,
--   deals_by_line 1, lines_charged_fn 1, lines_charged_anon_can_call 0, check_vat_by_line 1,
--   round_keeps_deals 1
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'promo_release_atomic') as release_fn,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'promo_release_atomic'
     and has_function_privilege('anon', p.oid, 'execute')) as release_anon_can_call,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'promo_redemptions'
     and column_name in ('released_at', 'released_reason')) as released_columns,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'venue_service_rule') as service_rule_fn,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'venue_service_rule'
     and has_function_privilege('anon', p.oid, 'execute')) as service_rule_anon_can_call,
  (select case when position('= ''false''::jsonb' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_vat_for_lines') as vat_false_is_default,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_menu_item_has_price') as has_price_fn,
  (select case when position('v_noprice' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_value') as value_no_price,
  (select case when position('v_deals' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'settle_qr_tab') as settle_books_deals,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_promo'
     and pg_get_function_identity_arguments(p.oid) like '%p_lines jsonb%') as promo_takes_lines,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_promo'
     and pg_get_function_identity_arguments(p.oid) = 'p_loc text, p_code text, p_subtotal_minor bigint, p_check_id text, p_consume boolean') as old_promo_gone,
  (select case when position('v_val -> ''lines''' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'place_public_order') as order_passes_lines,
  (select case when position('line_minor' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_auto') as deals_by_line,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_order_lines_charged') as lines_charged_fn,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_order_lines_charged'
     and has_function_privilege('anon', p.oid, 'execute')) as lines_charged_anon_can_call,
  (select case when position('byLine' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_public_order_check_row') as check_vat_by_line,
  (select case when position('''auto_rules'', v_auto -> ''rules'', ''auto_lines''' in pg_get_functiondef(p.oid)) > 0 then 1 else 0 end
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'place_public_order') as round_keeps_deals;
