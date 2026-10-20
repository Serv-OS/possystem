-- policies.sql: row level security on the stock tables, word for word as pg_policies showed it on the
-- Ops database on 18 Oct 2026 (read only). Loaded after ../stock_function_fences/live/helpers.sql,
-- which defines user_accessible_locations and accessible_location_uuids.

do $rls$
declare
  t text;
begin
  -- one rule for every command, the user_accessible_locations form
  foreach t in array array['stock_counts', 'stock_count_lines', 'stock_count_areas', 'purchase_orders', 'po_lines',
                           'suppliers', 'supplier_invoices', 'supplier_invoice_lines', 'item_cost_history',
                           'storage_areas', 'inventory_item_areas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all using ((location_id)::text in (select user_accessible_locations())) '
                || 'with check ((location_id)::text in (select user_accessible_locations()))', t || '_rls', t);
  end loop;
  -- read by any session that reaches the venue (tills too), written by Back Office logins
  foreach t in array array['inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'supplier_products',
                           'recipes', 'recipe_lines', 'menu_item_recipes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select using (location_id in (select accessible_location_uuids()))', t || '_sel', t);
    execute format('create policy %I on public.%I for insert with check ((location_id)::text in (select user_accessible_locations()))', t || '_write', t);
    execute format('create policy %I on public.%I for update using ((location_id)::text in (select user_accessible_locations())) '
                || 'with check ((location_id)::text in (select user_accessible_locations()))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete using ((location_id)::text in (select user_accessible_locations()))', t || '_del', t);
  end loop;
end
$rls$;

alter table public.stock_movements enable row level security;
create policy stock_movements_read on public.stock_movements for select using ((location_id)::text in (select user_accessible_locations()));

alter table public.inventory_item_area_stock enable row level security;
create policy inventory_item_area_stock_read on public.inventory_item_area_stock for select using ((location_id)::text in (select user_accessible_locations()));

alter table public.waste_events enable row level security;
create policy waste_events_sel on public.waste_events for select using (location_id in (select accessible_location_uuids()));
create policy waste_events_ins on public.waste_events for insert with check (location_id in (select accessible_location_uuids()));
create policy waste_events_upd on public.waste_events for update using ((location_id)::text in (select user_accessible_locations()))
  with check ((location_id)::text in (select user_accessible_locations()));
create policy waste_events_del on public.waste_events for delete using ((location_id)::text in (select user_accessible_locations()));

alter table public.production_batches enable row level security;
create policy production_batches_sel on public.production_batches for select using (location_id in (select accessible_location_uuids()));

-- Transfers (20261016): both ends read and update, only the sender inserts and deletes.
alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;
do $tr$
declare t text;
begin
  foreach t in array array['stock_transfers', 'stock_transfer_lines'] loop
    execute format('create policy %I_select on public.%I for select using ((location_id)::text in (select user_accessible_locations()) '
                || 'or (to_location_id)::text in (select user_accessible_locations()))', t, t);
    execute format('create policy %I_insert on public.%I for insert with check ((location_id)::text in (select user_accessible_locations()))', t, t);
    execute format('create policy %I_update on public.%I for update using ((location_id)::text in (select user_accessible_locations()) '
                || 'or (to_location_id)::text in (select user_accessible_locations())) with check ((location_id)::text in (select user_accessible_locations()) '
                || 'or (to_location_id)::text in (select user_accessible_locations()))', t, t);
    execute format('create policy %I_delete on public.%I for delete using ((location_id)::text in (select user_accessible_locations()))', t, t);
  end loop;
end
$tr$;
revoke update on public.stock_transfers from authenticated, anon;
grant update (to_area_id, note, updated_at) on public.stock_transfers to authenticated;
revoke update on public.stock_transfer_lines from authenticated, anon;
grant update (to_inventory_item_id, qty_received_base, dropped) on public.stock_transfer_lines to authenticated;

-- msm access helpers (20261017, the parts msm_can_view needs).
create or replace function public.msm_role(p_org uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select m.role from public.msm_members m join public.msm_company c on c.org_id = m.org_id and c.enabled
   where m.org_id = p_org and m.user_id = auth.uid() and not public.is_anon_session();
$fn$;
create or replace function public.msm_can_view(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select public.msm_role(p_org) is not null or public.is_super_admin();
$fn$;
grant execute on function public.msm_role(uuid) to authenticated, service_role;
grant execute on function public.msm_can_view(uuid) to authenticated, service_role;
