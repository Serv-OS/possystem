-- v5.5.563 — Stock & Production: slice 2 (append-only movements ledger)
--
-- The single source of truth for on-hand and inventory value. On-hand is NEVER a
-- mutable column edited in place — it is the running SUM of signed movements.
-- inventory_items.on_hand is kept as a fast cache, maintained atomically by the
-- post_stock_movement RPC. Corrections are NEW reversing rows, never UPDATE/DELETE.
--
-- This is additive and independent of the existing stock_levels/eighty_six daily-
-- count system (which is keyed by menu item id, a different keyspace). Sale
-- depletion into this ledger is wired in slice 3 once recipes map menu items to
-- stock items; for now movements come from manual adjustments and counts.

create table if not exists stock_movements (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  inventory_item_id  uuid not null references inventory_items(id) on delete cascade,
  qty_base           numeric(16,4) not null,         -- signed, in the item's base unit
  unit_cost          numeric(12,5),                  -- £ per base unit applied at this move
  value_delta        numeric(16,4),                  -- qty_base * unit_cost
  movement_type      text not null check (movement_type in (
                        'OPENING_BALANCE','PURCHASE_RECEIPT','SALE_DEPLETION','WASTE',
                        'STOCK_COUNT_ADJ','PRODUCTION_CONSUME','PRODUCTION_OUTPUT',
                        'TRANSFER_IN','TRANSFER_OUT','RETURN','MANUAL_ADJ')),
  source_type        text,                           -- 'closed_check','invoice','count','batch','transfer','manual'…
  source_id          text,                           -- polymorphic ref (text: closed_checks use uuid/ref)
  occurred_at        timestamptz not null default now(),
  posted_at          timestamptz not null default now(),
  created_by         uuid,
  idempotency_key    text,                           -- dedupes retries; unique per location
  reversal_of        uuid references stock_movements(id) on delete set null,
  notes              text
);
create index if not exists stock_mv_item_idx on stock_movements(location_id, inventory_item_id, occurred_at desc);
create index if not exists stock_mv_loc_time_idx on stock_movements(location_id, occurred_at desc);
create unique index if not exists stock_mv_idem_uniq on stock_movements(location_id, idempotency_key) where idempotency_key is not null;

alter table stock_movements enable row level security;
drop policy if exists stock_movements_read on stock_movements;
create policy stock_movements_read on stock_movements
  for select using (location_id in (select location_id from user_accessible_locations()));
-- No insert/update/delete policy: the ledger is append-only and written ONLY via
-- the SECURITY DEFINER RPCs below (or the service role).

-- Post one movement. Idempotent on (location_id, idempotency_key). Updates the
-- inventory_items.on_hand cache atomically. Values at the supplied unit_cost, else
-- the item's current_cost, else 0. Returns { id, on_hand, duplicate }.
create or replace function post_stock_movement(
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
  p_notes             text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cost numeric;
  v_existing_id uuid;
  v_id uuid;
  v_onhand numeric;
begin
  if p_idempotency_key is not null then
    select id into v_existing_id from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id), 0);

  insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
      movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes)
    values (p_location_id, p_inventory_item_id, p_qty_base, v_cost, p_qty_base * coalesce(v_cost, 0),
      p_movement_type, p_source_type, p_source_id, coalesce(p_occurred_at, now()), now(),
      p_created_by, p_idempotency_key, p_notes)
    returning id into v_id;

  update inventory_items set on_hand = coalesce(on_hand, 0) + p_qty_base, updated_at = now()
    where id = p_inventory_item_id and location_id = p_location_id
    returning on_hand into v_onhand;

  return jsonb_build_object('id', v_id, 'on_hand', v_onhand, 'duplicate', false);
end $$;

-- Set on-hand to a counted quantity by posting the delta as a STOCK_COUNT_ADJ.
-- (Full mobile counts with sessions/approval land in slice 4; this is the simple
-- per-item set used by the Stock items screen.) Returns { id, on_hand, delta }.
create or replace function set_inventory_on_hand(
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_counted_qty       numeric,
  p_created_by        uuid default null,
  p_notes             text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;

grant execute on function post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text) to authenticated, anon, service_role;
grant execute on function set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to authenticated, anon, service_role;
