-- 20261009a_OPS_public_order_vat_server.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Safe any time, service included. Replaces TWO functions and adds four    #
-- #  small helpers. No table changes, no data changes. Under a second.        #
-- ############################################################################
--
-- WHY (VAT audit, 8 Oct 2026). Peter's rule: "VAT despite the order type should follow the Tax
-- rules set on the back office per menu item." A sale is never saved without VAT when the venue
-- has rates. Preston QR-4OGI7 (8 Oct, 4.85, paid on the phone) was booked with tax_amount NULL:
-- the phone had read tax_rates before its sign in finished, got an empty list, worked out no VAT
-- and sent none; the server had no tax maths of its own and booked what it was sent. Every
-- online, QR pay now, QR tab close and catering sale went through the same door.
--
-- WHAT THIS FILE DOES. The server works the VAT out ITSELF, line by line, from the venue's own
-- Back Office rules, and only then looks at what the page sent:
--   _vat_for_lines          the maths, pure (jsonb in, jsonb out), so it can be tested here
--                           against the live sales with no table access. For each line: the
--                           menu row by itemId (a size inherits its parent's rate and overrides
--                           the way the till does, src/store/index.js addItem), the per order
--                           type override (tax_overrides[order type]; collection and drive thru
--                           read Takeaway, a bar tab reads Bar, as src/lib/taxRule.js), else the
--                           row's tax_rate_id, else the venue default. Inclusive: gross x r/(1+r).
--                           Added on (exclusive): gross x r. The raw VAT is summed, scaled ONCE
--                           by the share of the goods charged (automatic offers; the till's rule,
--                           src/lib/taxShare.js) and rounded ONCE, half up to the penny
--                           (_vat_round; src/lib/taxRule.js roundVat: 5.85 at 20% is exactly
--                           0.975 and books 0.98).
--                           A line whose rate cannot be matched (another venue's rate id, not on
--                           this menu) takes the venue default and the record says so
--                           (tax_breakdown.fallbacks, as the till since 8 Oct 2026). Never a
--                           silent 0, never null.
--   _public_order_vat       loads the venue's active rates and the menu rows the lines name
--                           (and their parents) and calls the maths. has_rates false when the
--                           venue has no active rates: that is "no tax set up", left as before.
--   _public_order_check_row the check of a paid online, QR pay now or catering order
--                           (place_public_order). The page's figure is kept when it is within 1p
--                           of the server's (and the page's own record with it); otherwise the
--                           server's figure is booked and the record carries source 'server',
--                           booked 'server', the page's figure and why ('page-sent-none' or
--                           'page-differs'). A venue set up as tax profiles (US) keeps the
--                           page's figure whenever it sent one: the profile maths live in the
--                           page's engine; with none sent, the server's figure is booked and
--                           flagged. Never null for goods above 0 at a venue with rates.
--                           Every public sale now carries its split by rate (the Xero daily
--                           invoice reads it; 139 Barnsley kiosk and QR sales had none).
--   settle_qr_tab           the check of a QR tab the guest closes on their phone: the same rule
--                           over the tab's rounds (order_queue items the server priced at
--                           placement), order type dine-in, share = goods booked / goods at menu
--                           price (an automatic deal on a round), compared with the figure the
--                           phone sends (20260927c).
--   _vat_order_type_key     the alias table, a mirror of src/lib/taxRule.js TAX_ORDER_TYPE_ALIASES
--                           (change both together).
--
-- WHAT IT DOES NOT DO. Money is untouched: totals, tips, tenders, payment proofs and every other
-- entry of both checks are exactly as 20261002b and 20260927c wrote them. Sales already booked
-- are not changed here (the coordinator hands the owner the record corrections separately).
--
-- THE TILL AND THE SERVER MUST AGREE TO THE PENNY. The self test below runs the maths over the
-- 14 live QR sales of the audit (typed in as fixtures): 13 give exactly their stored VAT (QR-4OGI7
-- among them: it gives the 0.81 the audit said was due, which the owner had already written onto
-- the record by the time this file was made), and QR-186RY (5.85) gives 0.98 where 0.97 was
-- stored: that sale sits exactly on a half penny and the 2 Oct backfill rounded a float down;
-- under the one rounding rule (half up, D3) it is 0.98, and the page now sends 0.98 too. A page
-- figure 1p apart is kept (the within 1p rule), so a half penny never fights. The same maths
-- re derived 200 recent till sales on a local PostgreSQL (supabase/tests/public_order_vat).
--
-- Rollback: 20261009a_OPS_public_order_vat_server_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
declare
  v_row  text;
  v_tab  text;
begin
  if to_regclass('public.closed_checks') is null or to_regclass('public.menu_items') is null
     or to_regclass('public.tax_rates') is null then
    raise exception 'This is not the Ops database (closed_checks, menu_items or tax_rates is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)') is null
     or to_regprocedure('public.settle_qr_tab(uuid, text, jsonb, uuid[])') is null
     or to_regprocedure('public._fence_num(text)') is null
     or to_regprocedure('public._fence_bool(text)') is null
     or to_regprocedure('public._public_order_value(text, text, text, jsonb, text)') is null then
    raise exception 'The public order functions (20260919a2, 20260927c, 20261002b) are not all here. Nothing was changed.';
  end if;
  select p.prosrc into v_row from pg_proc p
   where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure;
  select p.prosrc into v_tab from pg_proc p
   where p.oid = 'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure;
  -- Only ever replace the versions this file was written against (read from the live database on
  -- 8 Oct 2026: _public_order_check_row as 20261002b left it, settle_qr_tab as 20260927c left it),
  -- or this file's own versions on a second run.
  if md5(v_row) <> '767b8354a392322aaa6857055cbf9961' and position('20261009a' in v_row) = 0 then
    raise exception 'public._public_order_check_row is not the version this file was written against (20261002b). Nothing was changed. Send Claude this message.';
  end if;
  if md5(v_tab) <> '6a335ccfad4f783e2a9cb9b88928c1bb' and position('20261009a' in v_tab) = 0 then
    raise exception 'public.settle_qr_tab is not the version this file was written against (20260927c). Nothing was changed. Send Claude this message.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. The one rounding rule: half up to the penny, applied ONCE per check
--    (src/lib/taxRule.js roundHalfUpMinor). Postgres round(numeric, 2) is half
--    away from zero on the exact value, which is half up for VAT.
-- ============================================================================
create or replace function public._vat_round(p numeric)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $fn$
  select round(coalesce(p, 0), 2);
$fn$;

-- ============================================================================
-- 2. Which override key an order type reads. MIRROR of src/lib/taxRule.js
--    TAX_ORDER_TYPE_ALIASES: change both together.
--      collection  -> takeaway   food taken away is takeaway for VAT (Peter, 8 Oct 2026)
--      drive-thru  -> takeaway
--      bar-tab     -> bar        a bar tab follows the item's Bar override
--    An override under the sale's own key still wins (read first, in _vat_for_lines).
-- ============================================================================
create or replace function public._vat_order_type_key(p_type text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case coalesce(p_type, '')
           when 'collection' then 'takeaway'
           when 'drive-thru' then 'takeaway'
           when 'bar-tab'    then 'bar'
           else coalesce(nullif(p_type, ''), 'dine-in')
         end;
$fn$;

-- ============================================================================
-- 3. The maths, pure. p_lines: the sale's lines as order_queue / _public_order_value carry them
--    ({itemId, price, qty, mods:[{price, qty}], parentId, name, uid, voided}); p_menu: the menu
--    rows named by the lines and their parents ({id, parent_id, tax_rate_id, tax_overrides});
--    p_rates: the venue's rates ({id, name, code, rate, type, applies_to, is_default, active,
--    location_id}); p_type: the sale's order type; p_share: the share of the goods charged
--    (1 = no discount).
--    Returns { has_rates, total_tax, exclusive_tax, goods, record } where record is the
--    tax_breakdown the check stores: { subtotal, totalTax, total, exclusiveTax, breakdown:
--    [{ rate, tax, net, gross, items }], hasExclusiveTax, source: 'server', share (when < 1),
--    fallbacks (only when a line fell to the default) }. total_tax is null when the venue has no
--    active rates.
-- ============================================================================
create or replace function public._vat_for_lines(p_lines jsonb, p_menu jsonb, p_rates jsonb, p_type text, p_share numeric default 1)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog
as $fn$
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
$fn$;

-- ============================================================================
-- 4. The venue's rows, then the maths. p_lines as above; p_type the sale's order type; p_share
--    the share of the goods charged. Reads menu_items (the lines' rows and their parents) and the
--    venue's active tax_rates; says whether the venue is set up as tax profiles (US), whose maths
--    live in the page's engine. Runs inside SECURITY DEFINER callers, so RLS never hides a row.
-- ============================================================================
create or replace function public._public_order_vat(p_loc text, p_lines jsonb, p_type text, p_share numeric default 1)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_rates    jsonb;
  v_menu     jsonb;
  v_profiles boolean := false;
  v_out      jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id::text, 'location_id', t.location_id::text, 'name', t.name, 'code', t.code,
           'rate', trim_scale(t.rate), 'type', t.type, 'applies_to', to_jsonb(t.applies_to),
           'is_default', t.is_default, 'active', t.active)), '[]'::jsonb)
    into v_rates
    from public.tax_rates t
   where t.location_id::text = p_loc and coalesce(t.active, true);
  with ids as (
    select distinct nullif(btrim(coalesce(x ->> 'itemId', x ->> 'item_id', x ->> 'id', '')), '') as id
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) x
     where jsonb_typeof(x) = 'object'
    union
    select distinct nullif(btrim(coalesce(x ->> 'parentId', x ->> 'parent_id', '')), '')
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) x
     where jsonb_typeof(x) = 'object'
  ), rows_ as (
    select m.id, m.parent_id, m.tax_rate_id, m.tax_overrides
      from public.menu_items m
     where m.location_id = p_loc and m.id in (select id from ids where id is not null)
    union
    select pm.id, pm.parent_id, pm.tax_rate_id, pm.tax_overrides
      from public.menu_items m
      join public.menu_items pm on pm.location_id = m.location_id and pm.id = m.parent_id
     where m.location_id = p_loc and m.id in (select id from ids where id is not null)
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'parent_id', r.parent_id,
                                                'tax_rate_id', r.tax_rate_id::text, 'tax_overrides', r.tax_overrides)), '[]'::jsonb)
    into v_menu
    from rows_ r;
  -- Tax profiles in use at this venue? Their stacked and compound lines live in the page's engine
  -- (src/lib/taxEngine.js); the maths here are the rates only.
  if to_regclass('public.tax_profiles') is not null then
    execute 'select exists (select 1 from public.tax_profiles tp where tp.location_id::text = $1)' into v_profiles using p_loc;
  end if;
  if not v_profiles then
    v_profiles := exists (select 1 from public.locations l where l.id::text = p_loc and l.default_tax_profile_id is not null)
                  or exists (select 1 from public.menu_items m where m.location_id = p_loc and m.tax_profile_id is not null)
                  or exists (select 1 from public.menu_categories c where c.location_id = p_loc and c.tax_profile_id is not null);
  end if;
  v_out := public._vat_for_lines(p_lines, v_menu, v_rates, p_type, p_share);
  return v_out || jsonb_build_object('profiles_in_use', v_profiles);
end;
$fn$;

revoke all on function public._vat_round(numeric) from public, anon, authenticated;
revoke all on function public._vat_order_type_key(text) from public, anon, authenticated;
revoke all on function public._vat_for_lines(jsonb, jsonb, jsonb, text, numeric) from public, anon, authenticated;
revoke all on function public._public_order_vat(text, jsonb, text, numeric) from public, anon, authenticated;

-- ============================================================================
-- 5. The closed check of a public order, exactly as 20261002b wrote it, with tax_amount and
--    tax_breakdown now decided by the rule above. Its grants (service role only) are kept by
--    create or replace. Same signature.
-- ============================================================================
create or replace function public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text,
                                                          p_check jsonb, p_items jsonb, p_customer jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
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
$fn$;

-- create or replace keeps the grants; said again so the file stands on its own.
revoke all on function public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ============================================================================
-- 6. A QR tab the guest closes on their phone, exactly as 20260927c wrote it, with the VAT now
--    worked out here from the tab's rounds and compared with the phone's figure. Same signature,
--    so create or replace keeps the grants from 20260919a2.
-- ============================================================================
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
  v_page       numeric;          -- 20261009a: the phone's figure, clamped as 20260927c clamped it
  v_page_added numeric := 0;
  v_full       numeric := 0;     -- 20261009a: the rounds' goods at menu price (server priced at placement)
  v_share      numeric := 1;
  v_srv        jsonb;
  v_rec        jsonb;
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

  -- 20260927c: the phone's figure, taken only when it is a JSON number, clamped to the goods this
  -- check books; the added-on part is clamped to it.
  if jsonb_typeof(p_check -> 'tax_amount') = 'number' then
    v_page := least(greatest(round((p_check ->> 'tax_amount')::numeric, 2), 0),
                    greatest(0, v_booked - least(v_tip, v_booked)));
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
    v_share := greatest(0, least(1, (v_booked - least(v_tip, v_booked)) / v_full));
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
$fn$;

-- ============================================================================
-- Self test: the live sales of the audit, the rules, and the edges. Any failure aborts the whole
-- paste, so the old functions stay. No table is read or written here except two read only
-- checks against the live rows at the end, which are skipped on a database without them.
-- ============================================================================
do $test$
declare
  -- The venues' rates, as live on 8 Oct 2026 (Preston ab45c80b, Huddersfield 5435c88e, Leeds 1e252e7c).
  v_rates jsonb := '[
    {"id":"8a476d3a-a8e2-404c-8473-073182bb7443","location_id":"ab45c80b-416d-4631-93e2-05048e52e0fa","name":"Zero Rate","code":"ZERO","rate":0,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"0ed7ee06-cfe6-493a-aaa3-46bef1051489","location_id":"ab45c80b-416d-4631-93e2-05048e52e0fa","name":"Reduced Rate","code":"VAT5","rate":0.05,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"229a7558-c675-47e9-bb16-c756815591d9","location_id":"ab45c80b-416d-4631-93e2-05048e52e0fa","name":"Standard Rate","code":"VAT20","rate":0.2,"type":"inclusive","applies_to":["all"],"is_default":true,"active":true},
    {"id":"f2d44561-f146-4fa5-b9a5-75aeb6d26a05","location_id":"5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9","name":"Zero Rate","code":"ZERO","rate":0,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"a779f62e-4bc6-49ba-9860-dbb23d19adca","location_id":"5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9","name":"Reduced Rate","code":"VAT5","rate":0.05,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"b4c75881-8771-4780-bac4-afc501f4a77e","location_id":"5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9","name":"Standard Rate","code":"VAT20","rate":0.2,"type":"inclusive","applies_to":["all"],"is_default":true,"active":true},
    {"id":"60168c55-b69b-40b3-9980-68c87ed40f5f","location_id":"1e252e7c-c875-4971-b91d-1e945c26956b","name":"Zero Rate","code":"ZERO","rate":0,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"1913bd65-00cf-4772-90b9-0cb260d8c029","location_id":"1e252e7c-c875-4971-b91d-1e945c26956b","name":"Reduced Rate","code":"VAT5","rate":0.05,"type":"inclusive","applies_to":["all"],"is_default":false,"active":true},
    {"id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","location_id":"1e252e7c-c875-4971-b91d-1e945c26956b","name":"Standard Rate","code":"VAT20","rate":0.2,"type":"inclusive","applies_to":["all"],"is_default":true,"active":true}]'::jsonb;
  -- The menu rows the 14 sales name (and their parents), and Leeds' two donuts with a takeaway override.
  v_menu jsonb := '[
    {"id":"m-1789669490611_5c9bdaa9","parent_id":null,"tax_rate_id":"b4c75881-8771-4780-bac4-afc501f4a77e","tax_overrides":{}},
    {"id":"m-1790045533928_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789995550481_8e52e0fa","parent_id":"m-1789995542460_8e52e0fa","tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789995542460_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789999898410_8e52e0fa","parent_id":"m-1789999873622_8e52e0fa","tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789999873622_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789994276688_8e52e0fa","parent_id":"m-1789994263373_8e52e0fa","tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789994263373_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789995489544_5c26956b","parent_id":"m-1789995447762_5c26956b","tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}},
    {"id":"m-1789995447762_5c26956b","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}},
    {"id":"m-1789669490611_5c26956b","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}},
    {"id":"m-1789160862696_5c26956b","parent_id":"m-1789160788884_5c26956b","tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}},
    {"id":"m-1789160788884_5c26956b","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}},
    {"id":"m-1790045576340_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789160871459_8e52e0fa","parent_id":"m-1789160788884_8e52e0fa","tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789160788884_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1790046914854_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-impmumnjwf6-1_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1790045914908_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789993275989_8e52e0fa","parent_id":"m-1789993262178_8e52e0fa","tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1789993262178_8e52e0fa","parent_id":null,"tax_rate_id":"229a7558-c675-47e9-bb16-c756815591d9","tax_overrides":{}},
    {"id":"m-1790142700776_5c26956b","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{"delivery":"60168c55-b69b-40b3-9980-68c87ed40f5f","takeaway":"60168c55-b69b-40b3-9980-68c87ed40f5f"}},
    {"id":"m-1790143103850_5c26956b","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{"delivery":"60168c55-b69b-40b3-9980-68c87ed40f5f","takeaway":"60168c55-b69b-40b3-9980-68c87ed40f5f"}}]'::jsonb;
  -- The 14 live QR sales (ref, lines, stored VAT). QR-186RY sits on a half penny: stored 0.97, the
  -- one rounding rule gives 0.98 (see the header). QR-4OGI7 stored NULL and must give 0.81.
  v_sales jsonb := '[
    {"ref":"QR-N2IYX","vat":0.63,"items":[{"itemId":"m-1789669490611_5c9bdaa9","price":3.75,"qty":1,"mods":[]}]},
    {"ref":"QR-HAFUU","vat":0.81,"items":[{"itemId":"m-1790045533928_8e52e0fa","price":4.85,"qty":1,"mods":[]}]},
    {"ref":"QR-186RY","vat":0.98,"items":[{"itemId":"m-1789995550481_8e52e0fa","price":5.85,"qty":1,"mods":[]}]},
    {"ref":"QR-2ODON","vat":0.73,"items":[{"itemId":"m-1789999898410_8e52e0fa","price":4.4,"qty":1,"mods":[]}]},
    {"ref":"QR-6CYF8","vat":0.73,"items":[{"itemId":"m-1789999898410_8e52e0fa","price":4.4,"qty":1,"mods":[{"price":0}]}]},
    {"ref":"QR-PVON8","vat":0.86,"items":[{"itemId":"m-1789994276688_8e52e0fa","price":5.15,"qty":1,"mods":[]}]},
    {"ref":"QR-FAUOB","vat":0.93,"items":[{"itemId":"m-1789995489544_5c26956b","price":5.6,"qty":1,"mods":[]}]},
    {"ref":"QR-8IFJ5","vat":0.64,"items":[{"itemId":"m-1789669490611_5c26956b","price":3.85,"qty":1,"mods":[]}]},
    {"ref":"QR-J99J4","vat":0.63,"items":[{"itemId":"m-1789160862696_5c26956b","price":3.8,"qty":1,"mods":[]}]},
    {"ref":"QR-9AWBI","vat":0.81,"items":[{"itemId":"m-1790045576340_8e52e0fa","price":4.85,"qty":1,"mods":[]}]},
    {"ref":"QR-6ZVYQ","vat":0.72,"items":[{"itemId":"m-1789160871459_8e52e0fa","price":4.3,"qty":1,"mods":[{"price":0},{"price":0}]}]},
    {"ref":"QR-4OGI7","vat":0.81,"items":[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1,"mods":[]}]},
    {"ref":"QR-WBDGS","vat":1.39,"items":[{"itemId":"m-impmumnjwf6-1_8e52e0fa","price":3.5,"qty":1,"mods":[]},{"itemId":"m-1790045914908_8e52e0fa","price":4.85,"qty":1,"mods":[]}]},
    {"ref":"QR-I6BI0","vat":1.32,"items":[{"itemId":"m-impmumnjwf6-1_8e52e0fa","price":3.5,"qty":1,"mods":[]},{"itemId":"m-1789993275989_8e52e0fa","price":4.4,"qty":1,"mods":[{"price":0}]}]}]'::jsonb;
  v_items  jsonb := '[{"name": "Mont Blanc", "price": 5.60, "qty": 1, "mods": []}]'::jsonb;
  v_two    jsonb := '[{"name": "Latte", "price": 4.10, "qty": 2, "mods": [{"label": "Oat", "price": 0.50}]}]'::jsonb;   -- goods 9.20
  v_pagerec jsonb := '{"totalTax": 0.9333333333333327, "hasExclusiveTax": false, "breakdown": [{"tax": 0.9333333333333327, "gross": 5.6, "rate": {"rate": 0.2, "type": "inclusive"}}]}'::jsonb;
  v_us     jsonb := '[{"id":"us","name":"Sales Tax","code":"US_SALES","rate":0.08875,"type":"exclusive","applies_to":["all"],"is_default":true,"active":true}]'::jsonb;
  s        jsonb;
  r        jsonb;
  v_rates_for text;
  v_n      int := 0;
begin
  -- 1. The 14 live QR sales re derived to the penny, each with its own venue's rates.
  for s in select x from jsonb_array_elements(v_sales) x loop
    v_rates_for := (select m ->> 'tax_rate_id' from jsonb_array_elements(v_menu) m where m ->> 'id' = s -> 'items' -> 0 ->> 'itemId');
    r := public._vat_for_lines(s -> 'items', v_menu,
           (select jsonb_agg(t) from jsonb_array_elements(v_rates) t
             where t ->> 'location_id' = (select t2 ->> 'location_id' from jsonb_array_elements(v_rates) t2 where t2 ->> 'id' = v_rates_for)),
           'dine-in', 1);
    if (r ->> 'total_tax')::numeric is distinct from (s ->> 'vat')::numeric then
      raise exception 'Self test 1: % must give %, got %. Nothing was changed.', s ->> 'ref', s ->> 'vat', r ->> 'total_tax';
    end if;
    if r -> 'record' ? 'fallbacks' or r -> 'record' -> 'breakdown' -> 0 -> 'rate' ->> 'id' <> v_rates_for then
      raise exception 'Self test 1: % did not follow its own menu row. Nothing was changed.', s ->> 'ref';
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> 14 then raise exception 'Self test 1: 14 sales expected, % run.', v_n; end if;

  -- 2. The Back Office rule per order type (D2): Leeds Bueno Filled Donut 3.75 at 20% in, the
  --    Takeaway override to Zero Rate; collection and drive thru read Takeaway; delivery has its
  --    own; dine-in and bar read the item's own rate.
  if (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.63
     or (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'takeaway') ->> 'total_tax')::numeric <> 0
     or (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'collection') ->> 'total_tax')::numeric <> 0
     or (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'drive-thru') ->> 'total_tax')::numeric <> 0
     or (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'delivery') ->> 'total_tax')::numeric <> 0
     or (public._vat_for_lines('[{"itemId":"m-1790142700776_5c26956b","price":3.75,"qty":1}]', v_menu, v_rates, 'bar-tab') ->> 'total_tax')::numeric <> 0.63 then
    raise exception 'Self test 2: the per order type override is not read as the till reads it. Nothing was changed.';
  end if;
  if public._vat_order_type_key('collection') <> 'takeaway' or public._vat_order_type_key('drive-thru') <> 'takeaway'
     or public._vat_order_type_key('bar-tab') <> 'bar' or public._vat_order_type_key('dine-in') <> 'dine-in'
     or public._vat_order_type_key(null) <> 'dine-in' then
    raise exception 'Self test 2: the order type alias table differs from src/lib/taxRule.js. Nothing was changed.';
  end if;
  -- An override under the sale's own key wins over the alias; an explicit null override is "Use default".
  r := public._vat_for_lines('[{"itemId":"x","price":10,"qty":1}]',
         '[{"id":"x","parent_id":null,"tax_rate_id":"1913bd65-00cf-4772-90b9-0cb260d8c029","tax_overrides":{"takeaway":"60168c55-b69b-40b3-9980-68c87ed40f5f","collection":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf"}}]',
         v_rates, 'collection');
  if (r ->> 'total_tax')::numeric <> 1.67 then raise exception 'Self test 2: the sale''s own key must win (got %).', r ->> 'total_tax'; end if;
  r := public._vat_for_lines('[{"itemId":"x","price":10,"qty":1}]',
         '[{"id":"x","parent_id":null,"tax_rate_id":"1913bd65-00cf-4772-90b9-0cb260d8c029","tax_overrides":{"takeaway":null}}]',
         (select jsonb_agg(t) from jsonb_array_elements(v_rates) t where t ->> 'location_id' = '1e252e7c-c875-4971-b91d-1e945c26956b'), 'takeaway');
  if (r ->> 'total_tax')::numeric <> 1.67 or r -> 'record' ? 'fallbacks' then raise exception 'Self test 2: a null override is "Use default" (got %).', r ->> 'total_tax'; end if;

  -- 3. A size inherits its parent's rule the way the till does: no rate of its own takes the
  --    parent's; no overrides of its own read the parent's overrides; its own rate is kept.
  r := public._vat_for_lines('[{"itemId":"size","price":2.35,"qty":1}]',
         '[{"id":"size","parent_id":"donut","tax_rate_id":null,"tax_overrides":{}},
           {"id":"donut","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{"takeaway":"60168c55-b69b-40b3-9980-68c87ed40f5f"}}]',
         v_rates, 'dine-in');
  if (r ->> 'total_tax')::numeric <> 0.39 or r -> 'record' ? 'fallbacks' then raise exception 'Self test 3: a size must take its parent''s rate (got %).', r ->> 'total_tax'; end if;
  if (public._vat_for_lines('[{"itemId":"size","price":2.35,"qty":1}]',
         '[{"id":"size","parent_id":"donut","tax_rate_id":null,"tax_overrides":{}},
           {"id":"donut","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{"takeaway":"60168c55-b69b-40b3-9980-68c87ed40f5f"}}]',
         v_rates, 'takeaway') ->> 'total_tax')::numeric <> 0 then
    raise exception 'Self test 3: a size must read its parent''s takeaway override. Nothing was changed.';
  end if;
  if (public._vat_for_lines('[{"itemId":"size","price":2.35,"qty":1}]',
         '[{"id":"size","parent_id":"donut","tax_rate_id":"1913bd65-00cf-4772-90b9-0cb260d8c029","tax_overrides":{}},
           {"id":"donut","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}}]',
         v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.11 then
    raise exception 'Self test 3: a size with its own rate keeps it (2.35 at 5%% is 0.11). Nothing was changed.';
  end if;

  -- 4. A line whose rate cannot be matched takes the venue default and the record says so (D4);
  --    a venue with rates but no default books 0 for the line, flagged. Never silently.
  r := public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1,"name":"Cooler","uid":"l1"}]',
         '[{"id":"m-1790046914854_8e52e0fa","parent_id":null,"tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf","tax_overrides":{}}]',
         (select jsonb_agg(t) from jsonb_array_elements(v_rates) t where t ->> 'location_id' = 'ab45c80b-416d-4631-93e2-05048e52e0fa'), 'dine-in');
  if (r ->> 'total_tax')::numeric <> 0.81 or r -> 'record' -> 'fallbacks' -> 0 ->> 'reason' <> 'rate-not-found'
     or r -> 'record' -> 'fallbacks' -> 0 ->> 'rateId' <> '6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf'
     or r -> 'record' -> 'fallbacks' -> 0 ->> 'lineId' <> 'l1' or r -> 'record' -> 'fallbacks' -> 0 ->> 'name' <> 'Cooler' then
    raise exception 'Self test 4: another venue''s rate id must take the default and be flagged (got %). Nothing was changed.', r;
  end if;
  r := public._vat_for_lines('[{"itemId":"not-here","price":4.85,"qty":1}]', '[]', v_rates, 'dine-in');
  if (r ->> 'total_tax')::numeric <> 0.81 or r -> 'record' -> 'fallbacks' -> 0 ->> 'reason' <> 'item-not-on-menu' then
    raise exception 'Self test 4: a line not on the menu must take the default and be flagged. Nothing was changed.';
  end if;
  r := public._vat_for_lines('[{"itemId":"x","price":10,"qty":1}]',
         '[{"id":"x","parent_id":null,"tax_rate_id":null,"tax_overrides":{}}]',
         '[{"id":"z","name":"Zero","rate":0,"type":"inclusive","is_default":false,"active":true}]', 'dine-in');
  if (r ->> 'total_tax')::numeric <> 0 or r -> 'record' -> 'fallbacks' -> 0 ->> 'reason' <> 'no-default-rate' then
    raise exception 'Self test 4: rates with no default must be flagged. Nothing was changed.';
  end if;
  -- An inactive rate charges nothing and is not a rate the venue holds; no active rates is "no tax set up".
  r := public._vat_for_lines('[{"itemId":"x","price":10,"qty":1}]', '[]',
         '[{"id":"old","name":"Old","rate":0.175,"type":"inclusive","is_default":true,"active":false}]', 'dine-in');
  if coalesce((r ->> 'has_rates')::boolean, true) or r ->> 'total_tax' is not null then
    raise exception 'Self test 4: inactive rates are not rates. Nothing was changed.';
  end if;

  -- 5. One rounding, one share (D3, D8): half up to the penny on the summed raw VAT, scaled once
  --    by the goods charged over the goods at menu price.
  if (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":10.05,"qty":1}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 1.68
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":5.85,"qty":1}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.98
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":1.9,"qty":3}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.95
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":10,"qty":1}]', v_menu, v_rates, 'dine-in', 0.5) ->> 'total_tax')::numeric <> 0.83
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":4.1,"qty":2,"mods":[{"price":0.5}]}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 1.53
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":4.1,"qty":1,"mods":[{"price":0.5,"qty":2}]}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.85
     or (public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":10,"qty":1,"voided":true},{"itemId":"m-1790046914854_8e52e0fa","price":5,"qty":1}]', v_menu, v_rates, 'dine-in') ->> 'total_tax')::numeric <> 0.83 then
    raise exception 'Self test 5: the rounding or the share is not the till''s. Nothing was changed.';
  end if;
  r := public._vat_for_lines('[{"itemId":"m-1790046914854_8e52e0fa","price":10,"qty":1}]', v_menu, v_rates, 'dine-in', 0.5);
  if (r -> 'record' ->> 'share')::numeric <> 0.5 or (r -> 'record' ->> 'total')::numeric <> 5
     or (r -> 'record' -> 'breakdown' -> 0 ->> 'gross')::numeric <> 5 or r -> 'record' ->> 'source' <> 'server'
     or (r -> 'record' ->> 'subtotal')::numeric + (r -> 'record' ->> 'totalTax')::numeric - (r -> 'record' ->> 'total')::numeric not between -0.005 and 0.005 then
    raise exception 'Self test 5: a scaled record must describe the discounted bill in full (got %).', r -> 'record';
  end if;
  -- Two rates on one check: the split by rate, highest first, adds up.
  r := public._vat_for_lines('[{"itemId":"a","price":5.6,"qty":1},{"itemId":"b","price":2.1,"qty":1},{"itemId":"c","price":3,"qty":1}]',
         '[{"id":"a","tax_rate_id":"6368f6fb-ff7a-4dfd-a44c-8db4e09b58bf"},{"id":"b","tax_rate_id":"1913bd65-00cf-4772-90b9-0cb260d8c029"},{"id":"c","tax_rate_id":"60168c55-b69b-40b3-9980-68c87ed40f5f"}]',
         v_rates, 'dine-in');
  if (r ->> 'total_tax')::numeric <> 1.03 or jsonb_array_length(r -> 'record' -> 'breakdown') <> 3
     or r -> 'record' -> 'breakdown' -> 0 -> 'rate' ->> 'code' <> 'VAT20' or r -> 'record' -> 'breakdown' -> 2 -> 'rate' ->> 'code' <> 'ZERO'
     or (r -> 'record' -> 'breakdown' -> 1 ->> 'tax')::numeric not between 0.0999 and 0.1001
     or (r -> 'record' -> 'breakdown' -> 0 -> 'rate' ->> 'rate')::numeric <> 0.2 or (r -> 'record' -> 'breakdown' -> 0 ->> 'items')::int <> 1 then
    raise exception 'Self test 5: the split by rate is not the till''s record (got %).', r -> 'record';
  end if;
  -- Added on (US) tax: 20.00 at 8.875% is 1.775, booked 1.78 on top; the record says so.
  r := public._vat_for_lines('[{"itemId":"x","price":20,"qty":1}]', '[{"id":"x","tax_rate_id":"us"}]', v_us, 'collection');
  if (r ->> 'total_tax')::numeric <> 1.78 or (r ->> 'exclusive_tax')::numeric <> 1.78 or not (r -> 'record' ->> 'hasExclusiveTax')::boolean
     or (r -> 'record' ->> 'total')::numeric <> 21.775 then
    raise exception 'Self test 5: added on tax is not booked as the till books it (got %).', r;
  end if;

  -- 6. _public_order_check_row at a venue the database does not know ('loc': no rates): exactly
  --    20261002b (its own self tests, kept).
  r := public._public_order_check_row('loc', 'QR-T1', 'qr', 'dine-in', '{"tax_amount": 0.9333333333333327}'::jsonb, v_items, '{}'::jsonb);
  if (r ->> 'tax_amount')::numeric is distinct from 0.93 then
    raise exception 'Self test 6: 5.60 at 20%% must book 0.93, got %. Nothing was changed.', r ->> 'tax_amount';
  end if;
  if (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": 0.63}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0.63
     or (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": 0}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0
     or (public._public_order_check_row('loc', 'T3', 'online', 'collection', '{"tax_amount": "0.9333333333333327"}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0.93 then
    raise exception 'Self test 6: pence, zero or text number not booked as sent. Nothing was changed.';
  end if;
  if public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": null}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": "lots"}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null
     or public._public_order_check_row('loc', 'T4', 'qr', 'dine-in', '{"tax_amount": {"a": 1}}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount' is not null then
    raise exception 'Self test 6: with no rates at the venue a missing VAT is still null (no tax set up). Nothing was changed.';
  end if;
  if (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": -3}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 0
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 999}'::jsonb, v_items, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 5.60
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 999}'::jsonb, v_two, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 9.20
     or (public._public_order_check_row('loc', 'T5', 'qr', 'dine-in', '{"tax_amount": 1.5333333333333334}'::jsonb, v_two, '{}'::jsonb) ->> 'tax_amount')::numeric is distinct from 1.53 then
    raise exception 'Self test 6: the VAT is not kept between 0 and the goods. Nothing was changed.';
  end if;
  if public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', jsonb_build_object('tax_breakdown', v_pagerec), v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from v_pagerec
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": [{"tax": 2}]}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[{"tax": 2}]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": {"totalTax": "1", "breakdown": []}}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{"tax_breakdown": "x"}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb
     or public._public_order_check_row('loc', 'T6', 'qr', 'dine-in', '{}'::jsonb, v_items, '{}'::jsonb) -> 'tax_breakdown' is distinct from '[]'::jsonb then
    raise exception 'Self test 6: the page''s record is not kept or refused as 20261002b did. Nothing was changed.';
  end if;
  r := public._public_order_check_row('loc', 'QR-T7', 'qr', 'dine-in',
         '{"id": "chk-1", "subtotal": 5.6, "tip": 0.5, "service": 0, "method": "card", "processor": "adyen", "tax_amount": 0.9333333333333327}'::jsonb,
         v_items, '{"name": "x"}'::jsonb);
  if r ->> 'id' <> 'chk-1' or r ->> 'ref' <> 'QR-T7' or r ->> 'source' <> 'qr' or (r ->> 'subtotal')::numeric <> 5.60
     or (r ->> 'tip')::numeric <> 0.50 or r ->> 'processor' <> 'adyen' or r -> 'items' -> 0 ->> 'voided' <> 'false'
     or r -> 'customer' ->> 'name' <> 'x' or r ->> 'order_type' <> 'dine-in' then
    raise exception 'Self test 6: another entry of the check row changed. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public._public_order_vat(text, jsonb, text, numeric)', 'execute')
     or has_function_privilege('authenticated', 'public._vat_for_lines(jsonb, jsonb, jsonb, text, numeric)', 'execute') then
    raise exception 'Self test 6: a function became callable from a phone. Nothing was changed.';
  end if;

  -- 7. QR-4OGI7 itself, against the LIVE rows (read only; skipped on a database without them):
  --    the page sends nothing, the server books 0.81 and says so; the page's own 0.81 is kept;
  --    a figure that is not the venue's rule is replaced; the half penny neighbour is kept.
  if exists (select 1 from public.menu_items m where m.id = 'm-1790046914854_8e52e0fa' and m.location_id = 'ab45c80b-416d-4631-93e2-05048e52e0fa'
                                                   and m.tax_rate_id::text = '229a7558-c675-47e9-bb16-c756815591d9')
     and exists (select 1 from public.tax_rates t where t.id::text = '229a7558-c675-47e9-bb16-c756815591d9' and t.rate = 0.2 and t.is_default and t.active) then
    r := public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-4OGI7', 'qr', 'dine-in', '{}'::jsonb,
           '[{"itemId":"m-1790046914854_8e52e0fa","name":"Mixed Berry Cooler","price":4.85,"qty":1,"mods":[]}]'::jsonb, '{}'::jsonb);
    if (r ->> 'tax_amount')::numeric is distinct from 0.81 or r -> 'tax_breakdown' ->> 'source' <> 'server'
       or r -> 'tax_breakdown' ->> 'booked' <> 'server' or r -> 'tax_breakdown' ->> 'reason' <> 'page-sent-none'
       or r -> 'tax_breakdown' -> 'breakdown' -> 0 -> 'rate' ->> 'id' <> '229a7558-c675-47e9-bb16-c756815591d9' then
      raise exception 'Self test 7: QR-4OGI7 with no figure from the page must book 0.81 from the server (got % %). Nothing was changed.', r ->> 'tax_amount', r -> 'tax_breakdown';
    end if;
    r := public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-4OGI7', 'qr', 'dine-in', jsonb_build_object('tax_amount', 0.81, 'tax_breakdown', v_pagerec),
           '[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1}]'::jsonb, '{}'::jsonb);
    if (r ->> 'tax_amount')::numeric is distinct from 0.81 or r -> 'tax_breakdown' is distinct from v_pagerec then
      raise exception 'Self test 7: a page figure that agrees is kept with its record. Nothing was changed.';
    end if;
    r := public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-4OGI7', 'qr', 'dine-in', '{"tax_amount": 0.80}'::jsonb,
           '[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1}]'::jsonb, '{}'::jsonb);
    if (r ->> 'tax_amount')::numeric is distinct from 0.80 or r -> 'tax_breakdown' ->> 'booked' <> 'page' or r -> 'tax_breakdown' ->> 'source' <> 'server' then
      raise exception 'Self test 7: a page figure 1p off is kept (a half penny may land either side), with the server''s split by rate. Nothing was changed.';
    end if;
    r := public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-4OGI7', 'qr', 'dine-in', '{"tax_amount": 0}'::jsonb,
           '[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1}]'::jsonb, '{}'::jsonb);
    if (r ->> 'tax_amount')::numeric is distinct from 0.81 or r -> 'tax_breakdown' ->> 'reason' <> 'page-differs' or (r -> 'tax_breakdown' ->> 'pageTaxAmount')::numeric <> 0 then
      raise exception 'Self test 7: a page figure of 0 at a 20%% venue is replaced by the server''s and flagged. Nothing was changed.';
    end if;
    -- An automatic deal: the server's own order_pricing scales the VAT (10.00 of goods, 5.00 off: 0.83).
    r := public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-D', 'qr', 'dine-in', '{}'::jsonb,
           '[{"itemId":"m-1790046914854_8e52e0fa","price":10,"qty":1}]'::jsonb,
           '{"order_pricing": {"goods_minor": 1000, "auto_minor": 500}}'::jsonb);
    if (r ->> 'tax_amount')::numeric is distinct from 0.83 or (r -> 'tax_breakdown' ->> 'share')::numeric <> 0.5 then
      raise exception 'Self test 7: an automatic deal must come off the VAT as the till books a discounted bill (got %). Nothing was changed.', r ->> 'tax_amount';
    end if;
  end if;
end
$test$;

-- VISIBLE CHECK (the SQL editor shows this last result): one row, every column true, and
-- qr_4ogi7_books = 0.81 (null only on a database without Preston's rows).
select
  position('20261009a' in p.prosrc) > 0 as check_row_is_new,
  position('20261009a' in q.prosrc) > 0 as settle_tab_is_new,
  (public._vat_for_lines('[{"itemId":"x","price":5.85,"qty":1}]', '[{"id":"x","tax_rate_id":"s"}]',
                         '[{"id":"s","name":"Standard Rate","rate":0.2,"type":"inclusive","is_default":true,"active":true}]', 'dine-in') ->> 'total_tax')::numeric = 0.98 as half_penny_rounds_up,
  (select (public._public_order_check_row('ab45c80b-416d-4631-93e2-05048e52e0fa', 'QR-4OGI7', 'qr', 'dine-in', '{}'::jsonb,
            '[{"itemId":"m-1790046914854_8e52e0fa","price":4.85,"qty":1}]'::jsonb, '{}'::jsonb) ->> 'tax_amount')::numeric
     where exists (select 1 from public.menu_items m where m.id = 'm-1790046914854_8e52e0fa')) as qr_4ogi7_books,
  not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') as check_row_not_callable_from_a_phone,
  has_function_privilege('authenticated', q.oid, 'execute') as settle_tab_still_callable_by_the_phone
from pg_proc p, pg_proc q
where p.oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure
  and q.oid = 'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure;
