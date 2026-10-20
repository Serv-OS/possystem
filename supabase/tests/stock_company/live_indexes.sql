-- live_indexes.sql: the indexes the Ops stock tables have on live (read from pg_indexes with
-- read_only: true, 19 Oct 2026, before 20261019c), so the harness plans as Ops does. Each is made only
-- when its table is in the harness schema and the index is not there yet.
do $live_idx$
declare
  r record;
begin
  for r in select * from (values
    ('deliveries', 'CREATE INDEX IF NOT EXISTS deliveries_loc_idx ON public.deliveries USING btree (location_id, created_at DESC)'),
    ('deliveries', 'CREATE INDEX IF NOT EXISTS deliveries_po_idx ON public.deliveries USING btree (po_id)'),
    ('inventory_item_area_stock', 'CREATE INDEX IF NOT EXISTS inventory_item_area_stock_loc_area_idx ON public.inventory_item_area_stock USING btree (location_id, area_id)'),
    ('inventory_item_areas', 'CREATE UNIQUE INDEX IF NOT EXISTS inventory_item_areas_item_area_uniq ON public.inventory_item_areas USING btree (inventory_item_id, area_id)'),
    ('inventory_item_areas', 'CREATE UNIQUE INDEX IF NOT EXISTS inventory_item_areas_primary_uniq ON public.inventory_item_areas USING btree (inventory_item_id) WHERE is_primary'),
    ('inventory_item_areas', 'CREATE INDEX IF NOT EXISTS inventory_item_areas_loc_area_idx ON public.inventory_item_areas USING btree (location_id, area_id)'),
    ('inventory_item_conversions', 'CREATE INDEX IF NOT EXISTS inv_item_conv_item_idx ON public.inventory_item_conversions USING btree (inventory_item_id)'),
    ('inventory_items', 'CREATE INDEX IF NOT EXISTS inventory_items_loc_idx ON public.inventory_items USING btree (location_id)'),
    ('inventory_items', 'CREATE INDEX IF NOT EXISTS inventory_items_loc_kind_idx ON public.inventory_items USING btree (location_id, kind) WHERE (archived_at IS NULL)'),
    ('item_cost_history', 'CREATE INDEX IF NOT EXISTS item_cost_hist_current_idx ON public.item_cost_history USING btree (inventory_item_id) WHERE (effective_to IS NULL)'),
    ('item_cost_history', 'CREATE INDEX IF NOT EXISTS item_cost_hist_item_idx ON public.item_cost_history USING btree (inventory_item_id, effective_from DESC)'),
    ('item_packaging_formats', 'CREATE INDEX IF NOT EXISTS item_pack_fmt_item_idx ON public.item_packaging_formats USING btree (inventory_item_id)'),
    ('par_levels', 'CREATE UNIQUE INDEX IF NOT EXISTS par_levels_location_id_inventory_item_id_key ON public.par_levels USING btree (location_id, inventory_item_id)'),
    ('par_levels', 'CREATE INDEX IF NOT EXISTS par_levels_loc_idx ON public.par_levels USING btree (location_id)'),
    ('po_lines', 'CREATE INDEX IF NOT EXISTS po_lines_po_idx ON public.po_lines USING btree (po_id)'),
    ('production_batches', 'CREATE INDEX IF NOT EXISTS production_batches_loc_idx ON public.production_batches USING btree (location_id, created_at DESC)'),
    ('production_batches', 'CREATE INDEX IF NOT EXISTS production_batches_output_idx ON public.production_batches USING btree (output_item_id)'),
    ('production_batches', 'CREATE UNIQUE INDEX IF NOT EXISTS production_batches_sched_day ON public.production_batches USING btree (location_id, schedule_id, planned_for) WHERE ((schedule_id IS NOT NULL) AND (status <> ''CANCELLED''::text))'),
    ('purchase_orders', 'CREATE INDEX IF NOT EXISTS po_loc_idx ON public.purchase_orders USING btree (location_id, created_at DESC)'),
    ('recipe_lines', 'CREATE INDEX IF NOT EXISTS recipe_lines_comp_idx ON public.recipe_lines USING btree (component_item_id)'),
    ('recipe_lines', 'CREATE INDEX IF NOT EXISTS recipe_lines_recipe_idx ON public.recipe_lines USING btree (recipe_id)'),
    ('recipes', 'CREATE INDEX IF NOT EXISTS recipes_loc_idx ON public.recipes USING btree (location_id) WHERE (archived_at IS NULL)'),
    ('recipes', 'CREATE INDEX IF NOT EXISTS recipes_output_idx ON public.recipes USING btree (output_item_id)'),
    ('stock_count_lines', 'CREATE INDEX IF NOT EXISTS stock_count_lines_count_idx ON public.stock_count_lines USING btree (count_id)'),
    ('stock_count_lines', 'CREATE INDEX IF NOT EXISTS stock_count_lines_count_area_idx ON public.stock_count_lines USING btree (count_id, area_id)'),
    ('stock_movements', 'CREATE UNIQUE INDEX IF NOT EXISTS stock_mv_idem_uniq ON public.stock_movements USING btree (location_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)'),
    ('stock_movements', 'CREATE INDEX IF NOT EXISTS stock_mv_item_idx ON public.stock_movements USING btree (location_id, inventory_item_id, occurred_at DESC)'),
    ('stock_movements', 'CREATE INDEX IF NOT EXISTS stock_mv_loc_time_idx ON public.stock_movements USING btree (location_id, occurred_at DESC)'),
    ('stock_movements', 'CREATE INDEX IF NOT EXISTS stock_mv_item_area_idx ON public.stock_movements USING btree (location_id, inventory_item_id, area_id)'),
    ('stock_movements', 'CREATE INDEX IF NOT EXISTS stock_mv_source_idx ON public.stock_movements USING btree (location_id, source_id) WHERE (source_id IS NOT NULL)'),
    ('stock_movements', 'CREATE INDEX IF NOT EXISTS stock_mv_count_idx ON public.stock_movements USING btree (location_id, inventory_item_id, occurred_at DESC) WHERE (movement_type = ANY (ARRAY[''STOCK_COUNT_ADJ''::text, ''OPENING_BALANCE''::text]))'),
    ('stock_transfer_lines', 'CREATE INDEX IF NOT EXISTS stock_transfer_lines_transfer_idx ON public.stock_transfer_lines USING btree (transfer_id, sort_order)'),
    ('supplier_invoice_lines', 'CREATE INDEX IF NOT EXISTS supplier_invoice_lines_inv_idx ON public.supplier_invoice_lines USING btree (invoice_id)'),
    ('supplier_invoices', 'CREATE INDEX IF NOT EXISTS supplier_invoices_loc_idx ON public.supplier_invoices USING btree (location_id, created_at DESC)'),
    ('supplier_products', 'CREATE INDEX IF NOT EXISTS supplier_products_item_idx ON public.supplier_products USING btree (inventory_item_id)'),
    ('supplier_products', 'CREATE INDEX IF NOT EXISTS supplier_products_sup_idx ON public.supplier_products USING btree (supplier_id)'),
    ('suppliers', 'CREATE INDEX IF NOT EXISTS suppliers_loc_idx ON public.suppliers USING btree (location_id)'),
    ('waste_events', 'CREATE INDEX IF NOT EXISTS waste_events_loc_idx ON public.waste_events USING btree (location_id, occurred_at DESC)')
  ) as t(tbl, stmt) loop
    if to_regclass('public.' || r.tbl) is not null then
      begin
        execute r.stmt;
      exception when undefined_column then
        null;  -- a live column the harness table does not have (production_batches.schedule_id)
      end;
    end if;
  end loop;
end
$live_idx$;
