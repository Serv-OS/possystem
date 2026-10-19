-- 20261018a_OPS_stock_function_fences_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261018a_OPS_stock_function_fences.sql: puts
-- post_stock_movement and post_stock_transfer_leg back to their 20261016 text, set_inventory_on_hand
-- back to its live text of 5 Aug 2026 (000_baseline_ops.sql), gives EXECUTE back to PUBLIC and anon
-- exactly as before, and drops stock_caller_reaches and _post_stock_movement.
--
-- Only if a till, kiosk or Back Office screen is refused stock it should post ("this session cannot
-- move stock at venue ..."). Rolling back OPENS THE DOORS AGAIN: anyone with the public key can
-- post stock at any venue. The stock-deplete function keeps its own caller check (it falls back to
-- accessible_location_ids when stock_caller_reaches is gone).
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null
     or to_regprocedure('public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text)') is null
     or to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)') is null then
    raise exception 'The three stock functions are not the shape 20261018a left. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- post_stock_movement, the 20261016 text.
create or replace function public.post_stock_movement(
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
  if p_idempotency_key is not null then
    select id, area_id into v_existing_id, v_existing_area from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true, 'area_id', v_existing_area);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id), 0);

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

-- set_inventory_on_hand, the live text of 5 Aug 2026 (000_baseline_ops.sql).
CREATE OR REPLACE FUNCTION public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cur numeric;
  v_delta numeric;
  v_res jsonb;
begin
  select coalesce(on_hand, 0) into v_cur from inventory_items
    where id = p_inventory_item_id and location_id = p_location_id;
  if not found then return jsonb_build_object('error', 'item not found'); end if;
  v_delta := p_counted_qty - v_cur;
  if v_delta = 0 then return jsonb_build_object('on_hand', v_cur, 'delta', 0); end if;
  v_res := post_stock_movement(p_location_id, p_inventory_item_id, v_delta, 'STOCK_COUNT_ADJ',
    null, 'manual_count', null, null, now(), p_created_by, p_notes);
  return v_res || jsonb_build_object('delta', v_delta);
end $function$;

-- post_stock_transfer_leg, the 20261016 text.
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

-- Who may call them: as before 20261018a.
grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to public, anon, authenticated, service_role;
grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to public, anon, authenticated, service_role;
revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;

drop function if exists public.stock_caller_reaches(uuid);
drop function if exists public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid);

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: reach_rule 0, trusted_core 0, fenced_functions 0, anon_can_call 2, public_can_call 2.
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'stock_caller_reaches') as reach_rule,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_post_stock_movement') as trusted_core,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and p.prosrc like '%stock_caller_reaches%') as fenced_functions,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and has_function_privilege('anon', p.oid, 'execute')) as anon_can_call,
  (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
      and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_call;
