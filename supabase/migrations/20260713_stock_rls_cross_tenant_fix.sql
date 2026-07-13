-- 20260713_stock_rls_cross_tenant_fix.sql
--
-- SECURITY FIX — cross-tenant leak on the stock / purchasing tables.
--
-- Every one of these tables shipped (migrations 20260621d–h / 20260622*) with an RLS
-- predicate of the form:
--     location_id IN ( SELECT <table>.location_id FROM user_accessible_locations() )
-- user_accessible_locations() returns SETOF text with NO location_id column, so the inner
-- `<table>.location_id` is a CORRELATED reference to the OUTER row's own location_id. The
-- subquery therefore yields the outer row's location_id (once per accessible location), and
--     location_id IN ( its-own-location_id )
-- is ALWAYS TRUE for any authenticated user who has >= 1 accessible location. Result: any
-- authenticated user could read AND write EVERY location's stock & purchasing data.
-- (Anonymous paired devices have zero accessible locations, so they evaluated to FALSE and
-- were already denied — their stock reads run through service-role edge fns, unaffected.)
--
-- Correct, non-correlated predicate (identical to the form used by the wf_* and ops_* tables
-- on this DB):
--     location_id::text IN ( SELECT user_accessible_locations() )
--
-- Behaviour-preserving for every legitimate access path: own-location (incl. multi-site)
-- access is unchanged; only cross-tenant access is closed. For a single-location tenant the
-- old and new predicates return identical rows, so this cannot change current live behaviour.
-- Idempotent (DROP … IF EXISTS then CREATE).

-- ── ALL policies (SELECT/INSERT/UPDATE/DELETE): fix USING *and* WITH CHECK ──────────────
drop policy if exists inventory_items_rls on public.inventory_items;
create policy inventory_items_rls on public.inventory_items for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists item_packaging_formats_rls on public.item_packaging_formats;
create policy item_packaging_formats_rls on public.item_packaging_formats for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists par_levels_rls on public.par_levels;
create policy par_levels_rls on public.par_levels for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists po_lines_rls on public.po_lines;
create policy po_lines_rls on public.po_lines for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists production_batches_rls on public.production_batches;
create policy production_batches_rls on public.production_batches for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists purchase_orders_rls on public.purchase_orders;
create policy purchase_orders_rls on public.purchase_orders for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists recipe_lines_rls on public.recipe_lines;
create policy recipe_lines_rls on public.recipe_lines for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists recipes_rls on public.recipes;
create policy recipes_rls on public.recipes for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists stock_counts_rls on public.stock_counts;
create policy stock_counts_rls on public.stock_counts for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists supplier_invoices_rls on public.supplier_invoices;
create policy supplier_invoices_rls on public.supplier_invoices for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists supplier_products_rls on public.supplier_products;
create policy supplier_products_rls on public.supplier_products for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists suppliers_rls on public.suppliers;
create policy suppliers_rls on public.suppliers for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists waste_events_rls on public.waste_events;
create policy waste_events_rls on public.waste_events for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

-- ── SELECT-only read policy (writes go via RPC / service role) ──────────────────────────
drop policy if exists stock_movements_read on public.stock_movements;
create policy stock_movements_read on public.stock_movements for select
  using (location_id::text in (select user_accessible_locations()));
