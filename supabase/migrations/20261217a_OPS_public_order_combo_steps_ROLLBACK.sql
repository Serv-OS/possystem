-- 20261217a_OPS_public_order_combo_steps_ROLLBACK.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Puts public._public_order_value back exactly as live had it before 20261217a (md5
-- db3790dba28aaef13a346a11d0a59a36) and drops public.public_order_features. Safe to run twice.
-- The online page and the catering link then stop offering Combos built from steps (they ask
-- public_order_features first). An order already placed keeps the values it was given.
-- Made by supabase/tests/combo_online/gen_20261217a.py.

set lock_timeout = '3s';
set client_min_messages = warning;

-- Fail fast in the wrong database rather than creating a stray function there.
do $$
begin
  if to_regclass('public.menu_items') is null or to_regprocedure('public._public_order_value(text, text, text, jsonb, text)') is null then
    raise exception 'wrong database: public.menu_items or public._public_order_value is missing. This file is for the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

begin;

do $same$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = to_regprocedure('public._public_order_value(text, text, text, jsonb, text)');
  if v_md5 not in ('e820d868e1efdc30600caf3bbbc446fe', 'db3790dba28aaef13a346a11d0a59a36') then
    raise exception '_public_order_value is neither the body 20261217a made nor the one before it (md5 %). Nothing was changed.', v_md5;
  end if;
end $same$;

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
  -- 20261020a (v5.11.81, menus and availability): a line keeps the price it was added at when a
  -- timed menu flips (the till's rule, src/lib/channelMenu.js). The online and QR pages send the
  -- menu each line was priced on (line menuId); it is used when it is one of this venue's menus,
  -- else the order's menu, as before. No line menu (older pages, catering): the order's menu.
  v_menus     text[] := '{}'::text[];
  v_line_menu text;
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

  -- 20261020a: this venue's menus, once for the whole order (a line's own menu must be one of them).
  if to_regclass('public.menus') is not null then
    execute 'select coalesce(array_agg(m.id::text), ''{}''::text[]) from public.menus m where m.location_id::text = $1'
      into v_menus using p_loc;
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
    -- 20261020a: the menu this line was priced on, when the page sent one of this venue's menus.
    v_line_menu := nullif(left(btrim(coalesce(it ->> 'menuId', '')), 80), '');
    if v_line_menu is null or not (v_line_menu = any(v_menus)) then
      v_line_menu := v_menu_id;
    end if;
    if r.id is not null then
      v_floor := public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_line_menu);
      v_noprice := not public._menu_item_has_price(r.pricing, v_channel, v_line_menu);
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

drop function if exists public.public_order_features();

do $done$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public._public_order_value(text, text, text, jsonb, text)')) <> 'db3790dba28aaef13a346a11d0a59a36' then
    raise exception '_public_order_value is not back as live had it. Nothing was changed.';
  end if;
end $done$;

commit;

notify pgrst, 'reload schema';

-- The check: every value true.
select
  (select md5(p.prosrc) = 'db3790dba28aaef13a346a11d0a59a36' from pg_proc p where p.oid = to_regprocedure('public._public_order_value(text, text, text, jsonb, text)')) as pricer_back_as_it_was,
  to_regprocedure('public.public_order_features()') is null as features_gone;
