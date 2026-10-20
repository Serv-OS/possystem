-- live_policies.sql: row level security on the 27 stock tables EXACTLY as pg_policies showed it on
-- the Ops database (read only, 20 Oct 2026): 92 policies, of which 51 name user_accessible_locations()
-- and 14 name accessible_location_uuids() (none name both; all 65 are TO public) plus one RESTRICTIVE
-- second_step_fence per table. 0a step 8 pins those 65 names in ALTER POLICY statements and refuses
-- unless it finds 51 and 14, so run.mjs loads this AFTER the real migrations: every policy the
-- migrations or ../stock_phase0/policies.sql left on these tables is dropped and the live set made.
do $drop_policies$
declare
  r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public' and tablename = any (array['inventory_item_area_stock', 'inventory_item_areas', 'inventory_item_conversions', 'inventory_items', 'item_cost_history', 'item_packaging_formats', 'menu_item_recipes', 'par_levels', 'po_lines', 'prep_schedule', 'production_batches', 'purchase_orders', 'recipe_lines', 'recipes', 'stock_count_areas', 'stock_count_lines', 'stock_counts', 'stock_movements', 'stock_site_settings', 'stock_transfer_lines', 'stock_transfers', 'storage_areas', 'supplier_invoice_lines', 'supplier_invoices', 'supplier_products', 'suppliers', 'waste_events']) loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$drop_policies$;

alter table public.inventory_item_area_stock enable row level security;
alter table public.inventory_item_areas enable row level security;
alter table public.inventory_item_conversions enable row level security;
alter table public.inventory_items enable row level security;
alter table public.item_cost_history enable row level security;
alter table public.item_packaging_formats enable row level security;
alter table public.menu_item_recipes enable row level security;
alter table public.par_levels enable row level security;
alter table public.po_lines enable row level security;
alter table public.prep_schedule enable row level security;
alter table public.production_batches enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.recipe_lines enable row level security;
alter table public.recipes enable row level security;
alter table public.stock_count_areas enable row level security;
alter table public.stock_count_lines enable row level security;
alter table public.stock_counts enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_site_settings enable row level security;
alter table public.stock_transfer_lines enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.storage_areas enable row level security;
alter table public.supplier_invoice_lines enable row level security;
alter table public.supplier_invoices enable row level security;
alter table public.supplier_products enable row level security;
alter table public.suppliers enable row level security;
alter table public.waste_events enable row level security;

create policy inventory_item_area_stock_read on public.inventory_item_area_stock as permissive for select to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.inventory_item_area_stock as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy inventory_item_areas_rls on public.inventory_item_areas as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.inventory_item_areas as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy inventory_item_conversions_del on public.inventory_item_conversions as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy inventory_item_conversions_sel on public.inventory_item_conversions as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy inventory_item_conversions_upd on public.inventory_item_conversions as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy inventory_item_conversions_write on public.inventory_item_conversions as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.inventory_item_conversions as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy inventory_items_del on public.inventory_items as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy inventory_items_sel on public.inventory_items as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy inventory_items_upd on public.inventory_items as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy inventory_items_write on public.inventory_items as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.inventory_items as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy item_cost_history_rls on public.item_cost_history as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.item_cost_history as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy item_packaging_formats_del on public.item_packaging_formats as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy item_packaging_formats_sel on public.item_packaging_formats as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy item_packaging_formats_upd on public.item_packaging_formats as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy item_packaging_formats_write on public.item_packaging_formats as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.item_packaging_formats as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy menu_item_recipes_del on public.menu_item_recipes as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy menu_item_recipes_sel on public.menu_item_recipes as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy menu_item_recipes_upd on public.menu_item_recipes as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy menu_item_recipes_write on public.menu_item_recipes as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.menu_item_recipes as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy par_levels_rls on public.par_levels as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.par_levels as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy po_lines_rls on public.po_lines as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.po_lines as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy prep_schedule_del on public.prep_schedule as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy prep_schedule_ins on public.prep_schedule as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy prep_schedule_sel on public.prep_schedule as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy prep_schedule_upd on public.prep_schedule as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.prep_schedule as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy production_batches_del on public.production_batches as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy production_batches_ins on public.production_batches as permissive for insert to public
  with check ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy production_batches_sel on public.production_batches as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy production_batches_upd on public.production_batches as permissive for update to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)))
  with check ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy second_step_fence on public.production_batches as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy purchase_orders_rls on public.purchase_orders as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.purchase_orders as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy recipe_lines_del on public.recipe_lines as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy recipe_lines_sel on public.recipe_lines as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy recipe_lines_upd on public.recipe_lines as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy recipe_lines_write on public.recipe_lines as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.recipe_lines as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy recipes_del on public.recipes as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy recipes_sel on public.recipes as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy recipes_upd on public.recipes as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy recipes_write on public.recipes as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.recipes as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy second_step_fence on public.stock_count_areas as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_count_areas_rls on public.stock_count_areas as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.stock_count_lines as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_count_lines_rls on public.stock_count_lines as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.stock_counts as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_counts_rls on public.stock_counts as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.stock_movements as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_movements_read on public.stock_movements as permissive for select to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.stock_site_settings as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_site_settings_insert on public.stock_site_settings as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy stock_site_settings_read on public.stock_site_settings as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy stock_site_settings_update on public.stock_site_settings as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.stock_transfer_lines as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_transfer_lines_delete on public.stock_transfer_lines as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy stock_transfer_lines_insert on public.stock_transfer_lines as permissive for insert to public
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) AND ((to_location_id IS NULL) OR stock_same_company(location_id, to_location_id))));
create policy stock_transfer_lines_select on public.stock_transfer_lines as permissive for select to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));
create policy stock_transfer_lines_update on public.stock_transfer_lines as permissive for update to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))))
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));
create policy second_step_fence on public.stock_transfers as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy stock_transfers_delete on public.stock_transfers as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy stock_transfers_insert on public.stock_transfers as permissive for insert to public
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) AND ((to_location_id IS NULL) OR stock_same_company(location_id, to_location_id))));
create policy stock_transfers_select on public.stock_transfers as permissive for select to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));
create policy stock_transfers_update on public.stock_transfers as permissive for update to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))))
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));
create policy second_step_fence on public.storage_areas as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy storage_areas_rls on public.storage_areas as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.supplier_invoice_lines as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy supplier_invoice_lines_rls on public.supplier_invoice_lines as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.supplier_invoices as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy supplier_invoices_rls on public.supplier_invoices as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.supplier_products as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy supplier_products_del on public.supplier_products as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy supplier_products_sel on public.supplier_products as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy supplier_products_upd on public.supplier_products as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy supplier_products_write on public.supplier_products as permissive for insert to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.suppliers as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy suppliers_rls on public.suppliers as permissive for all to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy second_step_fence on public.waste_events as restrictive for all to authenticated
  using (( SELECT second_step_ok() AS second_step_ok))
  with check (( SELECT second_step_ok() AS second_step_ok));
create policy waste_events_del on public.waste_events as permissive for delete to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
create policy waste_events_ins on public.waste_events as permissive for insert to public
  with check ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy waste_events_sel on public.waste_events as permissive for select to public
  using ((location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids)));
create policy waste_events_upd on public.waste_events as permissive for update to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));
