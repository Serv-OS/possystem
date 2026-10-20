-- 20261019b_OPS_stock_phase0_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261019b_OPS_stock_phase0.sql:
--   * _post_stock_movement goes back to 20261018a's text, post_stock_transfer_leg and
--     _stock_counted_after to 20261018c's (byte for byte), inventory_item_areas_rehome to 20261016's;
--   * every venue's central stock mode STAYS as it is (20261019 set it; this file never touched it);
--   * drops stock_receive, _stock_receive_lines, stock_post_invoice, approve_stock_count,
--     stock_record_waste, stock_convert_qty, stock_office_reaches, stock_same_company,
--     stock_cost_rule, stock_phase0_ready, msm_stock_recipe_gaps, stock_usage_weekday_page,
--     stock_usage_rates_page, _stock_caller_is_system and the four triggers (the live
--     stock_usage_by_weekday and stock_usage_rates were never changed and stay);
--   * the transfer insert policies go back to the sender check only (20261016);
--   * drops stock_site_settings (every venue goes back to "cost from price list", the default) and
--     the columns 20261019b added, and its indexes;
--   * unit costs go back to 5 decimals and on hand on items to (14,4): figures with more decimals
--     are ROUNDED to 5 (milk at 0.00114286 per ml becomes 0.00114).
--
-- WHAT IS KEPT: every stock movement posted while it was in (opening balances, late sale
-- adjustments, Short on transfer reversals and waste, receipts), every waste row and every count:
-- the ledger is never touched, so on hand stays exactly as it is. LOST: when each count line was
-- counted, which lines were opening stock, the product on product waste rows and their no recipe
-- tag, the pack label on cost history, the supplier pack on invoice lines, the unit and shortfall
-- notes on transfer lines, and each venue's cost rule.
--
-- Back Office needs nothing: its probe (stock_phase0_ready) finds no function and every screen goes
-- back to what it did before (count approval, receiving and waste by the old paths).
--
-- RUN OUTSIDE SERVICE. Bare statements, no begin or commit: the SQL editor runs the paste as one
-- transaction, so any error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null
     or to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)') is null then
    raise exception 'The stock functions are not the shape 20261018a left. Nothing was changed.';
  end if;
  if to_regprocedure('public._stock_counted_after(uuid,uuid,timestamptz)') is null or to_regclass('public.stock_depletion_mode') is null then
    raise exception 'The central stock functions (20261018c) are missing. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- == The functions as 20261018a and 20261016 left them ==============================================
create or replace function public._post_stock_movement(
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_qty_base          numeric,
  p_movement_type     text,
  p_unit_cost         numeric default null,
  p_source_type       text default null,
  p_source_id         text default null,
  p_idempotency_key   text default null,
  p_occurred_at       timestamptz default null,
  p_created_by        uuid default null,
  p_notes             text default null,
  p_area_id           uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cost numeric;
  v_existing_id uuid;
  v_existing_area uuid;
  v_id uuid;
  v_onhand numeric;
  v_area uuid;
  v_area_onhand numeric;
begin
  -- FENCE 20261018a: the item and a chosen area must be this venue's own.
  if not exists (select 1 from inventory_items i where i.id = p_inventory_item_id and i.location_id = p_location_id) then
    raise exception 'post_stock_movement: stock item % is not at venue %', p_inventory_item_id, p_location_id
      using errcode = '22023';
  end if;
  if p_area_id is not null and not exists (select 1 from storage_areas a where a.id = p_area_id and a.location_id = p_location_id) then
    raise exception 'post_stock_movement: stock area % is not at venue %', p_area_id, p_location_id
      using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    select id, area_id into v_existing_id, v_existing_area from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id and location_id = p_location_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true, 'area_id', v_existing_area);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id and location_id = p_location_id), 0);

  -- Which area. The caller's choice first (a delivery landed somewhere else, a count line, a
  -- transfer leg). Otherwise: a delivery lands in the venue's receiving area when one is
  -- flagged; everything, deliveries included when there is no receiving area, lands in the
  -- item's use area; nothing when the venue has no areas (on_hand only, as before 16 Oct 2026).
  v_area := p_area_id;
  if v_area is null and p_movement_type = 'PURCHASE_RECEIPT' then
    select a.id into v_area from storage_areas a
      where a.location_id = p_location_id and a.is_receiving and a.archived_at is null
      limit 1;
  end if;
  if v_area is null then
    select ia.area_id into v_area
      from inventory_item_areas ia
      join storage_areas a on a.id = ia.area_id
     where ia.inventory_item_id = p_inventory_item_id and ia.is_primary and a.archived_at is null
       and ia.location_id = p_location_id and a.location_id = p_location_id   -- FENCE 20261018a
     limit 1;
  end if;

  insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
      movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes, area_id)
    values (p_location_id, p_inventory_item_id, p_qty_base, v_cost, p_qty_base * coalesce(v_cost, 0),
      p_movement_type, p_source_type, p_source_id, coalesce(p_occurred_at, now()), now(),
      p_created_by, p_idempotency_key, p_notes, v_area)
    returning id into v_id;

  update inventory_items set on_hand = coalesce(on_hand, 0) + p_qty_base, updated_at = now()
    where id = p_inventory_item_id and location_id = p_location_id
    returning on_hand into v_onhand;

  if v_area is not null then
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
      values (p_location_id, p_inventory_item_id, v_area, p_qty_base, now())
      on conflict (inventory_item_id, area_id) do update
        set on_hand = inventory_item_area_stock.on_hand + excluded.on_hand, updated_at = now()
      returning on_hand into v_area_onhand;
  end if;

  return jsonb_build_object('id', v_id, 'on_hand', v_onhand, 'duplicate', false,
    'area_id', v_area, 'area_on_hand', v_area_onhand);
end $$;
revoke all on function public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) from public, anon, authenticated, service_role;

create or replace function public.inventory_item_areas_rehome()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_primary then
    update stock_movements set area_id = new.area_id
     where location_id = new.location_id and inventory_item_id = new.inventory_item_id and area_id is null;
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
    select new.location_id, new.inventory_item_id, new.area_id, coalesce(sum(m.qty_base), 0), now()
      from stock_movements m
     where m.location_id = new.location_id and m.inventory_item_id = new.inventory_item_id and m.area_id = new.area_id
    on conflict (inventory_item_id, area_id) do update set on_hand = excluded.on_hand, updated_at = now();
  end if;
  return new;
end $$;

create or replace function public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t record;
  v_l record;
  v_mine boolean;
  v_lines integer := 0;
  v_cost numeric;
  v_qty numeric;
  v_area uuid;
  v_item record;
  v_before numeric;
  v_new_avg numeric;
  v_res jsonb;
begin
  if p_leg not in ('out', 'in', 'both', 'cancel') then
    raise exception 'post_stock_transfer_leg: leg must be out, in, both or cancel (got %)', coalesce(p_leg, 'null');
  end if;

  select * into v_t from stock_transfers where id = p_transfer_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Transfer not found');
  end if;

  -- Who is asking (FENCE 20261018a): the same rule as post_stock_movement. The receiving leg
  -- belongs to the receiving venue; every other leg to the sending venue.
  if p_leg = 'in' then
    v_mine := v_t.to_location_id is not null and public.stock_caller_reaches(v_t.to_location_id);
  else
    v_mine := public.stock_caller_reaches(v_t.location_id);
  end if;
  if not coalesce(v_mine, false) then
    return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
  end if;

  -- Already past this step: nothing moves twice.
  if (p_leg in ('out', 'both') and v_t.status <> 'DRAFT') or (p_leg = 'in' and v_t.status <> 'SENT')
     or (p_leg = 'cancel' and v_t.status = 'CANCELLED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
  end if;
  if p_leg = 'cancel' and v_t.status not in ('DRAFT', 'SENT') then
    return jsonb_build_object('ok', false, 'error', 'A transfer that is ' || lower(v_t.status) || ' cannot be cancelled: move the stock back with a new transfer');
  end if;

  -- FENCE 20261018a: stock moves between venues of ONE company only. A cancel only puts the
  -- stock back at the sender, so it is never refused for this.
  if p_leg in ('out', 'in') and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id
     and not exists (select 1 from locations a join locations b on b.org_id = a.org_id
                      where a.id = v_t.location_id and b.id = v_t.to_location_id and a.org_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'Stock can only move between venues of the same company');
  end if;
  -- FENCE 20261018a: the sender's own lines and areas, checked before anything posts (a return
  -- from plpgsql does not roll back, so a refusal half way through would leave a half leg).
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and v_t.from_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.from_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer leaves from is not at the sending venue');
  end if;
  if p_leg = 'both' and v_t.to_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.to_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer goes to is not at this venue');
  end if;
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and exists (select 1 from stock_transfer_lines l
                  where l.transfer_id = p_transfer_id and not l.dropped and coalesce(l.qty_base, 0) > 0
                    and not exists (select 1 from inventory_items i where i.id = l.inventory_item_id and i.location_id = v_t.location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A line names a stock item that is not at the sending venue');
  end if;

  if p_leg = 'cancel' then
    -- A SENT transfer has already posted TRANSFER_OUT at the sender: put every line back where it came from.
    if v_t.status = 'SENT' then
      for v_l in
        select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
      loop
        if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          coalesce(v_l.unit_cost, (select current_cost from inventory_items where id = v_l.inventory_item_id), 0),
          'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':cancel',
          now(), null, 'Transfer ' || coalesce(v_t.reference, '') || ' cancelled, stock back', v_t.from_area_id);
        v_lines := v_lines + 1;
      end loop;
    end if;
    update stock_transfers set status = 'CANCELLED', cancelled_by_name = p_by_name, cancelled_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'CANCELLED', 'lines', v_lines);
  end if;
  if p_leg = 'both' and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id then
    return jsonb_build_object('ok', false, 'error', 'A transfer to another venue is sent, then received there');
  end if;
  if p_leg = 'in' and (v_t.to_location_id is null or v_t.to_location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'A transfer within one venue has no receiving step');
  end if;

  if p_leg in ('out', 'both') then
    for v_l in
      select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
    loop
      if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
      v_cost := coalesce((select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
      update stock_transfer_lines set unit_cost = v_cost where id = v_l.id;
      perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_l.qty_base, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out',
        now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      if p_leg = 'both' then
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
          now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.to_area_id);
      end if;
      v_lines := v_lines + 1;
    end loop;
    if v_lines = 0 then
      return jsonb_build_object('ok', false, 'error', 'This transfer has no lines with a quantity');
    end if;
    if p_leg = 'both' then
      update stock_transfers set status = 'DONE', sent_by_name = p_by_name, sent_at = now(),
        received_by_name = p_by_name, received_at = now(), updated_at = now() where id = p_transfer_id;
      return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'DONE', 'lines', v_lines);
    end if;
    update stock_transfers set status = 'SENT', sent_by_name = p_by_name, sent_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'SENT', 'lines', v_lines);
  end if;

  -- p_leg = 'in'
  if exists (select 1 from stock_transfer_lines where transfer_id = p_transfer_id and not dropped and to_inventory_item_id is null) then
    return jsonb_build_object('ok', false, 'error', 'Every line must be matched to one of your items or dropped before you receive');
  end if;
  -- Every matched item must be at the receiving venue BEFORE anything posts: a return from
  -- plpgsql does not roll back, so a refusal half way through the loop would leave the lines
  -- already posted at the receiver with the head still SENT (16 Oct review).
  if exists (select 1 from stock_transfer_lines l
              where l.transfer_id = p_transfer_id and not l.dropped
                and not exists (select 1 from inventory_items i where i.id = l.to_inventory_item_id and i.location_id = v_t.to_location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A matched item is not at the receiving venue');
  end if;
  -- Where it lands: the chosen area (only when it is a live area of the receiving venue), else
  -- the receiving area, else (null) the item's use area.
  v_area := v_t.to_area_id;
  if v_area is not null and not exists (select 1 from storage_areas a
      where a.id = v_area and a.location_id = v_t.to_location_id and a.archived_at is null) then
    v_area := null;
  end if;
  if v_area is null then
    select a.id into v_area from storage_areas a
      where a.location_id = v_t.to_location_id and a.is_receiving and a.archived_at is null limit 1;
  end if;
  for v_l in
    select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
  loop
    v_qty := coalesce(v_l.qty_received_base, v_l.qty_base);
    if coalesce(v_qty, 0) <= 0 then continue; end if;
    select id, on_hand, current_cost, cost_method into v_item from inventory_items
      where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
    if not found then
      -- checked before the loop; a raise rolls the whole leg back
      raise exception 'post_stock_transfer_leg: matched item % is not at venue %', v_l.to_inventory_item_id, v_t.to_location_id;
    end if;
    v_before := coalesce(v_item.on_hand, 0);
    v_cost := coalesce(v_l.unit_cost, v_item.current_cost, 0);
    v_res := public._post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
      v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
      now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_area);
    -- The receiver's cost moves the way a delivery moves it (costAfterReceipt in
    -- supabase/functions/_shared/stockCosting.js): moving average, or the last cost replaces.
    -- The received cost stands on its own only when on hand plus received is zero or below,
    -- the same rule as movingAverageCost. A zero cost never re-costs the item.
    if coalesce((v_res ->> 'duplicate')::boolean, false) = false and v_cost > 0 then
      if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before + v_qty <= 0 then
        v_new_avg := v_cost;
      else
        v_new_avg := (v_before * coalesce(v_item.current_cost, 0) + v_qty * v_cost) / (v_before + v_qty);
      end if;
      update item_cost_history set effective_to = now()
        where location_id = v_t.to_location_id and inventory_item_id = v_l.to_inventory_item_id and effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, source, effective_from)
        values (v_t.to_location_id, v_l.to_inventory_item_id, v_new_avg, 'TRANSFER', now());
      update inventory_items set current_cost = v_new_avg, updated_at = now()
        where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
    end if;
    v_lines := v_lines + 1;
  end loop;
  update stock_transfers set status = 'RECEIVED', received_by_name = p_by_name, received_at = now(), updated_at = now()
    where id = p_transfer_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', v_lines);
end $$;
revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;

-- 20261018c's late sale guard, word for word (the drainer books its own late:<key> again).
create or replace function public._stock_counted_after(p_loc uuid, p_item uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stock_movements m
                  where m.location_id = p_loc and m.inventory_item_id = p_item and m.occurred_at > p_at
                    and m.movement_type in ('STOCK_COUNT_ADJ', 'OPENING_BALANCE')
                    and m.source_type is distinct from 'late_sale')
      or exists (select 1 from stock_counts c join stock_count_lines l on l.count_id = c.id
                  where c.location_id = p_loc and upper(c.status) = 'APPROVED' and c.approved_at > p_at
                    and l.inventory_item_id = p_item);
$$;
revoke all on function public._stock_counted_after(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- == The new functions and triggers =================================================================
drop trigger if exists stock_count_lines_counted_at_trg on public.stock_count_lines;
drop trigger if exists stock_counts_keep_approved_trg on public.stock_counts;
drop trigger if exists inventory_items_keep_history_trg on public.inventory_items;
drop trigger if exists item_packaging_formats_in_use_trg on public.item_packaging_formats;
drop function if exists public.stock_count_lines_counted_at();
drop function if exists public.stock_counts_keep_approved();
drop function if exists public._stock_caller_is_system();
drop function if exists public.stock_usage_weekday_page(uuid, integer, uuid, text, text);
drop function if exists public.stock_usage_rates_page(uuid, integer, uuid);
drop function if exists public.inventory_items_keep_history();
drop function if exists public.item_packaging_formats_in_use();
drop function if exists public.stock_receive(uuid, text, text, jsonb, uuid, text);
drop function if exists public.stock_post_invoice(uuid, jsonb, jsonb, jsonb, uuid);
drop function if exists public._stock_receive_lines(uuid, text, text, jsonb, uuid, text);
drop function if exists public.approve_stock_count(uuid, text, text, jsonb, boolean);
drop function if exists public.stock_record_waste(uuid, jsonb, jsonb);
drop function if exists public.msm_stock_recipe_gaps(uuid);
drop function if exists public.stock_phase0_ready();
drop function if exists public.stock_cost_rule(uuid);

-- The transfer insert rules as 20261016 wrote them (sender only), then the helpers they used.
drop policy if exists stock_transfers_insert on public.stock_transfers;
create policy stock_transfers_insert on public.stock_transfers
  for insert
  with check ((location_id)::text in (select user_accessible_locations()));
drop policy if exists stock_transfer_lines_insert on public.stock_transfer_lines;
create policy stock_transfer_lines_insert on public.stock_transfer_lines
  for insert
  with check ((location_id)::text in (select user_accessible_locations()));
drop function if exists public.stock_same_company(uuid, uuid);
drop function if exists public.stock_office_reaches(uuid);
drop function if exists public.stock_convert_qty(numeric, text, text, uuid[]);

-- == Tables, columns and indexes ====================================================================
drop table if exists public.stock_site_settings;
drop index if exists public.recipe_lines_loc_recipe_idx;
drop index if exists public.recipe_lines_loc_pack_unit_idx;
drop index if exists public.item_pack_fmt_loc_item_idx;
drop index if exists public.inv_item_conv_loc_item_idx;
drop index if exists public.supplier_products_loc_item_idx;
drop index if exists public.po_lines_loc_po_idx;
drop index if exists public.item_cost_hist_loc_item_idx;
drop index if exists public.stock_count_lines_loc_item_idx;
drop index if exists public.waste_events_loc_menu_item_idx;
drop index if exists public.supplier_invoices_posted_number_uniq;
alter table public.stock_count_lines drop column if exists counted_at;
alter table public.stock_count_lines drop column if exists is_opening;
alter table public.stock_counts drop column if exists opening_value;
alter table public.waste_events drop column if exists menu_item_id;
alter table public.waste_events drop column if exists no_recipe;
alter table public.item_cost_history drop column if exists pack_label;
alter table public.supplier_invoice_lines drop column if exists supplier_product_id;
alter table public.stock_transfer_lines drop column if exists to_base_unit;
alter table public.stock_transfer_lines drop column if exists short_qty_base;
alter table public.stock_transfer_lines drop column if exists to_unit_cost;

-- Precision back to the old types (8 decimal costs are ROUNDED to 5).
do $precision$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items', 'current_cost', 'numeric(12,5)'),
      ('inventory_items', 'on_hand', 'numeric(14,4)'),
      ('stock_movements', 'unit_cost', 'numeric(12,5)'),
      ('item_cost_history', 'base_unit_cost', 'numeric(12,5)'),
      ('item_cost_history', 'moving_avg_cost', 'numeric(12,5)'),
      ('stock_count_lines', 'unit_cost', 'numeric(12,5)'),
      ('stock_transfer_lines', 'unit_cost', 'numeric(12,5)'),
      ('production_batches', 'output_unit_cost', 'numeric(12,5)')
    ) as t(tbl, col, target)
  loop
    if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
         where a.attrelid = format('public.%I', r.tbl)::regclass and a.attname = r.col and not a.attisdropped) is distinct from r.target then
      execute format('alter table public.%I alter column %I type %s', r.tbl, r.col, r.target);
    end if;
  end loop;
end
$precision$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: phase0_functions_left 0, triggers_left 0, columns_left 0, settings_table 0,
-- core_is_18a 1, leg_is_18c 1, weekday_2_args 1, cost_5dp 1, counted_is_18c 1, venues_central (as
-- before the rollback: the modes stay). So: 0|0|0|0|1|1|1|1|1|<n>
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
     ('stock_receive', '_stock_receive_lines', 'stock_post_invoice', 'approve_stock_count', 'stock_record_waste',
      'stock_convert_qty', 'stock_office_reaches', 'stock_same_company', 'stock_cost_rule', 'stock_phase0_ready',
      'msm_stock_recipe_gaps', 'stock_usage_weekday_page', 'stock_usage_rates_page', '_stock_caller_is_system',
      'stock_counts_keep_approved', 'stock_count_lines_counted_at')) as phase0_functions_left,
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname in
     ('stock_count_lines_counted_at_trg', 'stock_counts_keep_approved_trg', 'inventory_items_keep_history_trg',
      'item_packaging_formats_in_use_trg')) as triggers_left,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and (c.table_name, c.column_name) in (
     ('stock_count_lines', 'counted_at'), ('stock_count_lines', 'is_opening'), ('stock_counts', 'opening_value'),
     ('waste_events', 'menu_item_id'), ('waste_events', 'no_recipe'), ('item_cost_history', 'pack_label'),
     ('supplier_invoice_lines', 'supplier_product_id'), ('stock_transfer_lines', 'to_base_unit'),
     ('stock_transfer_lines', 'short_qty_base'), ('stock_transfer_lines', 'to_unit_cost'))) as columns_left,
  (select count(*) from pg_class c where c.oid = to_regclass('public.stock_site_settings')) as settings_table,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)')
     and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 'e9865d7cad62f582db4e904bf41ad512') as core_is_18a,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)')
     and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '541ac92297e3784706a2f7a958d5c396') as leg_is_18c,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.stock_usage_by_weekday(uuid,integer)')) as weekday_2_args,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'inventory_items'
     and c.column_name = 'current_cost' and c.numeric_scale = 5) as cost_5dp,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public._stock_counted_after(uuid,uuid,timestamptz)')
     and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 'd9792fc95826ff4691437bbeb7133dea') as counted_is_18c,
  (select count(*) from public.stock_depletion_mode where mode in ('central', 'paused')) as venues_central;
