-- 20261021a_OPS_stock_native_0a_revalue.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL or writes on production). #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql first (its check row matched).   #
-- #  One transaction: any error and nothing changes. Run it ONCE, after UK    #
-- #  close, straight after 0a. A second run refuses and changes nothing.      #
-- ############################################################################
--
-- WHY (multi site stock map, 7.4): the stock ledger's value (sum of stock_movements.value_delta)
-- should equal what the books say the stock is worth (on hand x current cost) for every item. On
-- 20 Oct they differ at the two demo venues (Provo about 94.37, Location 2 about 30.49, from early
-- seed rows and cost changes made before REVALUE existed). From 0a on, every cost change writes a
-- REVALUE line, so the gap can no longer grow; this file closes the old gap once.
--
-- WHAT IT DOES
--   * For every stock item whose ledger value and books differ to the penny
--     (round(sum(value_delta), 2) <> round(on_hand x current_cost, 2)) it writes ONE stock_movements
--     row: movement_type 'REVALUE', qty_base 0 (no stock moves), unit_cost = the item's current
--     cost, value_delta = round(on hand x cost, 2) minus the ledger value, source_type
--     'opening_revalue', idempotency key 'revalue:opening:<item id>', dated now.
--   * It writes nothing else. On hand, current cost, areas, counts, orders, recipes and every other
--     row stay exactly as they are. It takes the same item row locks every sale takes first, so no
--     sale can post while it runs (the drainer waits, backs off and retries; nothing is lost).
--   * Inside the transaction it compares 33 figures per venue before and after (the 0a figures) and
--     raises, changing nothing, unless the only differences are the new REVALUE rows and their value.
--
-- Rollback: 20261021a_OPS_stock_native_0a_revalue_ROLLBACK.sql (deletes these rows by source_type).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql first (stock_native_backup is missing). Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.stock_movements'::regclass
                    and c.conname = 'stock_movements_movement_type_check'
                    and pg_get_constraintdef(c.oid) like '%''REVALUE''%') then
    raise exception 'stock_movements does not accept REVALUE yet, so 0a is not in place. Nothing was changed.';
  end if;
  if exists (select 1 from public.stock_movements m where m.source_type = 'opening_revalue') then
    raise exception 'The opening revalue has run already (opening_revalue rows exist). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- The item row lock every stock writer takes first (_post_stock_movement, 20261019b), in id order.
select count(*) as items_locked
  from (select i.id from public.inventory_items i order by i.id for no key update) x;

-- ---------------------------------------------------------------- before: the 33 figures per venue
create temp table _stock_native_rv_snap (
  location_id uuid not null,
  metric text not null,
  value numeric,
  primary key (location_id, metric)
) on commit drop;

insert into _stock_native_rv_snap (location_id, metric, value)
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

-- ---------------------------------------------------------------- the items whose ledger and books differ
create temp table _stock_native_rv_items (
  location_id uuid not null,
  item_id uuid primary key,
  current_cost numeric,
  books numeric not null,
  ledger numeric not null,
  diff numeric not null
) on commit drop;

insert into _stock_native_rv_items (location_id, item_id, current_cost, books, ledger, diff)
select i.location_id, i.id, i.current_cost, x.books, x.ledger, x.books - x.ledger
  from public.inventory_items i
  cross join lateral (
    select round(coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0), 2) as books,
           coalesce((select sum(m.value_delta) from public.stock_movements m
                      where m.location_id = i.location_id and m.inventory_item_id = i.id), 0) as ledger
  ) x
 where round(x.ledger, 2) <> x.books;

-- ---------------------------------------------------------------- the REVALUE rows (one per item, keyed, so nothing doubles)
insert into public.stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type,
                                    source_type, source_id, idempotency_key, occurred_at, notes)
select r.location_id, r.item_id, 0, r.current_cost, r.diff, 'REVALUE',
       'opening_revalue', null, 'revalue:opening:' || r.item_id::text, now(),
       'Opening revalue: the ledger value now equals on hand x cost (20261021a_OPS_stock_native_0a_revalue)'
  from _stock_native_rv_items r
 order by r.item_id
on conflict (location_id, idempotency_key) where idempotency_key is not null do nothing;

-- ---------------------------------------------------------------- after: compare inside the transaction
do $compare$
declare
  v_bad text;
  v_off integer;
begin
  with after as (
    select v.id as location_id, e.key as metric, coalesce(e.value::numeric, 0) as value
      from (select distinct s.location_id as id from _stock_native_rv_snap s) v
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
           s.value + case s.metric
                       when 'n:stock_movements' then (select count(*) from _stock_native_rv_items r where r.location_id = s.location_id)
                       when 's:mv_value' then (select coalesce(sum(r.diff), 0) from _stock_native_rv_items r where r.location_id = s.location_id)
                       else 0 end as expected
      from _stock_native_rv_snap s
  )
  select string_agg(format('%s %s expected %s found %s', a.location_id, a.metric, a.expected, f.value), '; ' order by a.location_id, a.metric)
    into v_bad
    from allowed a
    left join after f on f.location_id = a.location_id and f.metric = a.metric
   where f.value is distinct from a.expected;
  if v_bad is not null then
    raise exception 'The opening revalue would have changed more than the ledger value, so nothing was changed. Ask Claude. %', v_bad;
  end if;

  select count(*) into v_off
    from public.inventory_items i
   where round(coalesce((select sum(m.value_delta) from public.stock_movements m
                          where m.location_id = i.location_id and m.inventory_item_id = i.id), 0), 2)
         <> round(coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0), 2);
  if v_off <> 0 then
    raise exception '% item(s) still have a ledger value different from on hand x cost after the revalue, so nothing was changed. Ask Claude.', v_off;
  end if;
end
$compare$;

-- VISIBLE CHECK (the SQL editor shows this last result), one row per venue of a company that holds
-- stock. Expected (20 Oct figures; the demo venues trade, so the amounts move a little):
--   Provo       items_off_before about 24, revalue_rows the same, revalue_value about 94.37
--   Location 2  items_off_before about 10, revalue_rows the same, revalue_value about 30.49
--   Birmingham  0, 0, 0
--   every venue: items_off_after 0, on_hand_unchanged true, cost_unchanged true,
--   counts_unchanged_except_movements true, ledger_after equal to books_after (to the penny per item)
select l.name as venue,
       l.id as location_id,
       (select count(*) from _stock_native_rv_items r where r.location_id = l.id) as items_off_before,
       (select count(*) from public.stock_movements m where m.location_id = l.id and m.source_type = 'opening_revalue') as revalue_rows,
       (select coalesce(sum(m.value_delta), 0) from public.stock_movements m where m.location_id = l.id and m.source_type = 'opening_revalue') as revalue_value,
       (select count(*) from public.inventory_items i
         where i.location_id = l.id
           and round(coalesce((select sum(m.value_delta) from public.stock_movements m
                                where m.location_id = i.location_id and m.inventory_item_id = i.id), 0), 2)
               <> round(coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0), 2)) as items_off_after,
       (select s.value from _stock_native_rv_snap s where s.location_id = l.id and s.metric = 's:mv_value') as ledger_before,
       (select coalesce(sum(m.value_delta), 0) from public.stock_movements m where m.location_id = l.id) as ledger_after,
       (select coalesce(sum(round(coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0), 2)), 0)
          from public.inventory_items i where i.location_id = l.id) as books_after,
       (select s.value from _stock_native_rv_snap s where s.location_id = l.id and s.metric = 's:on_hand')
         = (select coalesce(sum(i.on_hand), 0) from public.inventory_items i where i.location_id = l.id) as on_hand_unchanged,
       (select s.value from _stock_native_rv_snap s where s.location_id = l.id and s.metric = 's:current_cost')
         = (select coalesce(sum(i.current_cost), 0) from public.inventory_items i where i.location_id = l.id) as cost_unchanged,
       true as counts_unchanged_except_movements
  from public.locations l
 where l.id in (select distinct s.location_id from _stock_native_rv_snap s)
 order by l.org_id, l.name;
