-- 20261021a_OPS_stock_native_0a_revalue_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, outside UK service, ONLY if the opening revalue #
-- #  (20261021a_OPS_stock_native_0a_revalue.sql) has to be undone.           #
-- #  One transaction: any error and nothing changes. Safe to run twice.       #
-- ############################################################################
--
-- WHAT IT DOES
--   * Deletes the ledger rows the opening revalue wrote: stock_movements with source_type
--     'opening_revalue' (movement_type REVALUE, qty_base 0, key revalue:opening:<item id>).
--     Nothing else: REVALUE rows written by receipts, transfers, count approvals and company cost
--     changes (other source types) stay, and so does the REVALUE value in the movement type check.
--   * On hand, current cost, areas and every other row stay as they are; only the ledger value goes
--     back to what it was before the revalue (Provo about 94.37 and Location 2 about 30.49 below the
--     books again on the 20 Oct figures).
--   * It takes the item row locks every sale takes first, then compares 33 figures per venue before
--     and after inside the transaction, and raises (changing nothing) unless the only differences are
--     the deleted rows and their value.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

select count(*) as items_locked
  from (select i.id from public.inventory_items i order by i.id for no key update) x;

-- ---------------------------------------------------------------- before: the 33 figures per venue
create temp table _stock_native_rvb_snap (
  location_id uuid not null,
  metric text not null,
  value numeric,
  primary key (location_id, metric)
) on commit drop;

insert into _stock_native_rvb_snap (location_id, metric, value)
select v.id, e.key, coalesce(e.value::numeric, 0)
  from (select l.id
          from public.locations l
         where l.org_id in (select distinct l2.org_id from public.locations l2
                             where l2.org_id is not null
                               and (exists (select 1 from public.inventory_items i where i.location_id = l2.id)
                                    or exists (select 1 from public.suppliers s where s.location_id = l2.id)))) v
  cross join lateral jsonb_each_text(jsonb_build_object(
    'n:inventory_items',            (select count(*) from public.inventory_items t where t.location_id = v.id),
    'n:suppliers',                  (select count(*) from public.suppliers t where t.location_id = v.id),
    'n:supplier_products',          (select count(*) from public.supplier_products t where t.location_id = v.id),
    'n:item_packaging_formats',     (select count(*) from public.item_packaging_formats t where t.location_id = v.id),
    'n:inventory_item_conversions', (select count(*) from public.inventory_item_conversions t where t.location_id = v.id),
    'n:recipes',                    (select count(*) from public.recipes t where t.location_id = v.id),
    'n:recipe_lines',               (select count(*) from public.recipe_lines t where t.location_id = v.id),
    'n:menu_item_recipes',          (select count(*) from public.menu_item_recipes t where t.location_id = v.id),
    'n:par_levels',                 (select count(*) from public.par_levels t where t.location_id = v.id),
    'n:storage_areas',              (select count(*) from public.storage_areas t where t.location_id = v.id),
    'n:inventory_item_areas',       (select count(*) from public.inventory_item_areas t where t.location_id = v.id),
    'n:inventory_item_area_stock',  (select count(*) from public.inventory_item_area_stock t where t.location_id = v.id),
    'n:stock_movements',            (select count(*) from public.stock_movements t where t.location_id = v.id),
    'n:purchase_orders',            (select count(*) from public.purchase_orders t where t.location_id = v.id),
    'n:po_lines',                   (select count(*) from public.po_lines t where t.location_id = v.id),
    'n:supplier_invoices',          (select count(*) from public.supplier_invoices t where t.location_id = v.id),
    'n:supplier_invoice_lines',     (select count(*) from public.supplier_invoice_lines t where t.location_id = v.id),
    'n:waste_events',               (select count(*) from public.waste_events t where t.location_id = v.id),
    'n:item_cost_history',          (select count(*) from public.item_cost_history t where t.location_id = v.id),
    'n:stock_counts',               (select count(*) from public.stock_counts t where t.location_id = v.id),
    'n:stock_count_lines',          (select count(*) from public.stock_count_lines t where t.location_id = v.id),
    'n:stock_count_areas',          (select count(*) from public.stock_count_areas t where t.location_id = v.id),
    'n:production_batches',         (select count(*) from public.production_batches t where t.location_id = v.id),
    'n:prep_schedule',              (select count(*) from public.prep_schedule t where t.location_id = v.id),
    'n:stock_transfers',            (select count(*) from public.stock_transfers t where t.location_id = v.id),
    'n:stock_transfer_lines',       (select count(*) from public.stock_transfer_lines t where t.location_id = v.id),
    's:on_hand',         (select coalesce(sum(i.on_hand), 0) from public.inventory_items i where i.location_id = v.id),
    's:current_cost',    (select coalesce(sum(i.current_cost), 0) from public.inventory_items i where i.location_id = v.id),
    's:books',           (select coalesce(sum(i.on_hand * i.current_cost), 0) from public.inventory_items i where i.location_id = v.id),
    's:mv_qty',          (select coalesce(sum(m.qty_base), 0) from public.stock_movements m where m.location_id = v.id),
    's:mv_value',        (select coalesce(sum(m.value_delta), 0) from public.stock_movements m where m.location_id = v.id),
    's:area_on_hand',    (select coalesce(sum(a.on_hand), 0) from public.inventory_item_area_stock a where a.location_id = v.id),
    's:recipe_base_qty', (select coalesce(sum(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)), 0)
                            from public.recipe_lines rl where rl.location_id = v.id)
  )) e;

-- ---------------------------------------------------------------- the rows to take out
create temp table _stock_native_rvb_rows (
  id uuid primary key,
  location_id uuid not null,
  value_delta numeric
) on commit drop;

insert into _stock_native_rvb_rows (id, location_id, value_delta)
select m.id, m.location_id, m.value_delta
  from public.stock_movements m
 where m.source_type = 'opening_revalue'
   and m.movement_type = 'REVALUE'
   and m.qty_base = 0;

delete from public.stock_movements m
 using _stock_native_rvb_rows r
 where m.id = r.id;

-- ---------------------------------------------------------------- after: compare inside the transaction
do $compare$
declare
  v_bad text;
begin
  if exists (select 1 from public.stock_movements m where m.source_type = 'opening_revalue') then
    raise exception 'Some opening_revalue rows are not plain REVALUE rows (qty_base not 0), so nothing was changed. Ask Claude.';
  end if;
  with after as (
    select v.id as location_id, e.key as metric, coalesce(e.value::numeric, 0) as value
      from (select distinct s.location_id as id from _stock_native_rvb_snap s) v
      cross join lateral jsonb_each_text(jsonb_build_object(
        'n:inventory_items',            (select count(*) from public.inventory_items t where t.location_id = v.id),
        'n:suppliers',                  (select count(*) from public.suppliers t where t.location_id = v.id),
        'n:supplier_products',          (select count(*) from public.supplier_products t where t.location_id = v.id),
        'n:item_packaging_formats',     (select count(*) from public.item_packaging_formats t where t.location_id = v.id),
        'n:inventory_item_conversions', (select count(*) from public.inventory_item_conversions t where t.location_id = v.id),
        'n:recipes',                    (select count(*) from public.recipes t where t.location_id = v.id),
        'n:recipe_lines',               (select count(*) from public.recipe_lines t where t.location_id = v.id),
        'n:menu_item_recipes',          (select count(*) from public.menu_item_recipes t where t.location_id = v.id),
        'n:par_levels',                 (select count(*) from public.par_levels t where t.location_id = v.id),
        'n:storage_areas',              (select count(*) from public.storage_areas t where t.location_id = v.id),
        'n:inventory_item_areas',       (select count(*) from public.inventory_item_areas t where t.location_id = v.id),
        'n:inventory_item_area_stock',  (select count(*) from public.inventory_item_area_stock t where t.location_id = v.id),
        'n:stock_movements',            (select count(*) from public.stock_movements t where t.location_id = v.id),
        'n:purchase_orders',            (select count(*) from public.purchase_orders t where t.location_id = v.id),
        'n:po_lines',                   (select count(*) from public.po_lines t where t.location_id = v.id),
        'n:supplier_invoices',          (select count(*) from public.supplier_invoices t where t.location_id = v.id),
        'n:supplier_invoice_lines',     (select count(*) from public.supplier_invoice_lines t where t.location_id = v.id),
        'n:waste_events',               (select count(*) from public.waste_events t where t.location_id = v.id),
        'n:item_cost_history',          (select count(*) from public.item_cost_history t where t.location_id = v.id),
        'n:stock_counts',               (select count(*) from public.stock_counts t where t.location_id = v.id),
        'n:stock_count_lines',          (select count(*) from public.stock_count_lines t where t.location_id = v.id),
        'n:stock_count_areas',          (select count(*) from public.stock_count_areas t where t.location_id = v.id),
        'n:production_batches',         (select count(*) from public.production_batches t where t.location_id = v.id),
        'n:prep_schedule',              (select count(*) from public.prep_schedule t where t.location_id = v.id),
        'n:stock_transfers',            (select count(*) from public.stock_transfers t where t.location_id = v.id),
        'n:stock_transfer_lines',       (select count(*) from public.stock_transfer_lines t where t.location_id = v.id),
        's:on_hand',         (select coalesce(sum(i.on_hand), 0) from public.inventory_items i where i.location_id = v.id),
        's:current_cost',    (select coalesce(sum(i.current_cost), 0) from public.inventory_items i where i.location_id = v.id),
        's:books',           (select coalesce(sum(i.on_hand * i.current_cost), 0) from public.inventory_items i where i.location_id = v.id),
        's:mv_qty',          (select coalesce(sum(m.qty_base), 0) from public.stock_movements m where m.location_id = v.id),
        's:mv_value',        (select coalesce(sum(m.value_delta), 0) from public.stock_movements m where m.location_id = v.id),
        's:area_on_hand',    (select coalesce(sum(a.on_hand), 0) from public.inventory_item_area_stock a where a.location_id = v.id),
        's:recipe_base_qty', (select coalesce(sum(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)), 0)
                                from public.recipe_lines rl where rl.location_id = v.id)
      )) e
  ), allowed as (
    select s.location_id, s.metric,
           s.value - case s.metric
                       when 'n:stock_movements' then (select count(*) from _stock_native_rvb_rows r where r.location_id = s.location_id)
                       when 's:mv_value' then (select coalesce(sum(r.value_delta), 0) from _stock_native_rvb_rows r where r.location_id = s.location_id)
                       else 0 end as expected
      from _stock_native_rvb_snap s
  )
  select string_agg(format('%s %s expected %s found %s', a.location_id, a.metric, a.expected, f.value), '; ' order by a.location_id, a.metric)
    into v_bad
    from allowed a
    left join after f on f.location_id = a.location_id and f.metric = a.metric
   where f.value is distinct from a.expected;
  if v_bad is not null then
    raise exception 'Taking the opening revalue out would have changed more than the ledger value, so nothing was changed. Ask Claude. %', v_bad;
  end if;
end
$compare$;

-- VISIBLE CHECK (the SQL editor shows this last result), one row per venue of a company that holds
-- stock. Expected: rows_deleted and value_removed as the revalue's check row showed (0 and 0 on a
-- second run), rows_left 0, on_hand_unchanged true, cost_unchanged true, and ledger_after back to
-- the ledger value before the revalue (ledger_before minus value_removed).
select l.name as venue,
       l.id as location_id,
       (select count(*) from _stock_native_rvb_rows r where r.location_id = l.id) as rows_deleted,
       (select coalesce(sum(r.value_delta), 0) from _stock_native_rvb_rows r where r.location_id = l.id) as value_removed,
       (select count(*) from public.stock_movements m where m.location_id = l.id and m.source_type = 'opening_revalue') as rows_left,
       (select s.value from _stock_native_rvb_snap s where s.location_id = l.id and s.metric = 's:mv_value') as ledger_before,
       (select coalesce(sum(m.value_delta), 0) from public.stock_movements m where m.location_id = l.id) as ledger_after,
       (select s.value from _stock_native_rvb_snap s where s.location_id = l.id and s.metric = 's:on_hand')
         = (select coalesce(sum(i.on_hand), 0) from public.inventory_items i where i.location_id = l.id) as on_hand_unchanged,
       (select s.value from _stock_native_rvb_snap s where s.location_id = l.id and s.metric = 's:current_cost')
         = (select coalesce(sum(i.current_cost), 0) from public.inventory_items i where i.location_id = l.id) as cost_unchanged
  from public.locations l
 where l.id in (select distinct s.location_id from _stock_native_rvb_snap s)
 order by l.org_id, l.name;
