create or replace function public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t record;
  v_l record;
  v_role text;
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

  -- Who is asking: the service role passes; a signed in login must hold the venue of this leg.
  -- nullif: a session where the claim was set and has since gone back to '' must not break on ''::jsonb
  v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if v_role <> 'service_role' then
    if p_leg = 'in' then
      v_mine := v_t.to_location_id is not null and v_t.to_location_id::text in (select user_accessible_locations());
    else
      v_mine := v_t.location_id::text in (select user_accessible_locations());
    end if;
    if not coalesce(v_mine, false) then
      return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
    end if;
  end if;

  -- Already past this step: nothing moves twice.
  if (p_leg in ('out', 'both') and v_t.status <> 'DRAFT') or (p_leg = 'in' and v_t.status <> 'SENT')
     or (p_leg = 'cancel' and v_t.status = 'CANCELLED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
  end if;
  if p_leg = 'cancel' and v_t.status not in ('DRAFT', 'SENT') then
    return jsonb_build_object('ok', false, 'error', 'A transfer that is ' || lower(v_t.status) || ' cannot be cancelled: move the stock back with a new transfer');
  end if;

  if p_leg = 'cancel' then
    -- A SENT transfer has already posted TRANSFER_OUT at the sender: put every line back where it came from.
    if v_t.status = 'SENT' then
      for v_l in
        select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
      loop
        if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
        perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
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
      select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
    loop
      if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
      v_cost := coalesce((select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
      update stock_transfer_lines set unit_cost = v_cost where id = v_l.id;
      perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_l.qty_base, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out',
        now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      if p_leg = 'both' then
        perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
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
    select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
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
    v_res := post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
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
