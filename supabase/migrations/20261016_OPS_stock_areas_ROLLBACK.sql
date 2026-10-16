-- ROLLBACK for 20261016_OPS_stock_areas.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Puts post_stock_movement back to its 11 argument shape (the text of 20260621e_stock_movements.sql),
-- drops post_stock_transfer_leg, the six new tables, the new columns on stock_counts,
-- stock_count_lines and stock_movements, and puts the count_type check back to FULL, PARTIAL, SPOT.
--
-- WHAT IS LOST: every area, every item's area, every count's per area rows, every transfer and
-- its lines, and the area on every movement posted since the migration ran. The ledger itself
-- (stock_movements rows, quantities, costs) and inventory_items.on_hand are NOT touched, so stock
-- totals stay exactly as they are. A count of type AREA or SUPPLIER cannot stay: the check would
-- refuse it, so those counts are set to PARTIAL (their lines keep every figure).
--
-- RUN OUTSIDE SERVICE: the posting function is dropped and created again inside this one
-- transaction, and the API schema cache is reloaded at the end.
--
-- Back Office needs nothing: the probe finds no storage_areas table and every screen goes back
-- to what it did before 16 Oct 2026.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.inventory_items') is null then
    raise exception 'This is not the Ops database (device_profiles or inventory_items is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop function if exists public.post_stock_transfer_leg(uuid, text, text);

-- The 12 argument function goes before the tables it references.
drop function if exists public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid);

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

grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text) to authenticated, anon, service_role;

-- Columns that point at the new tables go before the tables.
alter table public.stock_movements drop column if exists area_id;
alter table public.stock_count_lines drop column if exists area_id;

-- Counts of the new types cannot stay under the old check.
update public.stock_counts set count_type = 'PARTIAL' where count_type in ('AREA', 'SUPPLIER');
alter table public.stock_counts drop constraint if exists stock_counts_count_type_chk;
alter table public.stock_counts drop constraint if exists stock_counts_count_type_check;
alter table public.stock_counts add constraint stock_counts_count_type_check
  check (count_type in ('FULL','PARTIAL','SPOT'));
alter table public.stock_counts drop column if exists supplier_id;
alter table public.stock_counts drop column if exists approval_note;
alter table public.stock_counts drop column if exists started_by_name;
alter table public.stock_counts drop column if exists approved_by_name;

do $realtime$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_count_areas') then
    alter publication supabase_realtime drop table public.stock_count_areas;
  end if;
end
$realtime$;

drop table if exists public.stock_transfer_lines;
drop table if exists public.stock_transfers;
drop table if exists public.stock_count_areas;
drop table if exists public.inventory_item_area_stock;
drop table if exists public.inventory_item_areas;
drop table if exists public.storage_areas;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: fn_11_args 1, fn_12_args 0, tables_left 0.
select
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_movement' and p.pronargs = 11) as fn_11_args,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_movement' and p.pronargs = 12) as fn_12_args,
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('storage_areas', 'inventory_item_areas', 'inventory_item_area_stock', 'stock_count_areas', 'stock_transfers', 'stock_transfer_lines')) as tables_left;
