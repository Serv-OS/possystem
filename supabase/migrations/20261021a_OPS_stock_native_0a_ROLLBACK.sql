-- 20261021a_OPS_stock_native_0a_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, OUTSIDE SERVICE, only if 0a has to be undone.   #
-- #  Run 20261022a_OPS_stock_native_0b_ROLLBACK.sql FIRST if 0b ran (this     #
-- #  file refuses while the 0b locks are on). One transaction: any error and  #
-- #  nothing changes. Safe to run twice (a second run changes nothing).       #
-- #  It holds the stock tables for a few seconds (lock wait 3 s, then it      #
-- #  gives up and nothing changes): run it after close.                       #
-- ############################################################################
--
-- Undoes 20261021a_OPS_stock_native_0a.sql (multi site stock, Drop 0a). Every object is named
-- exactly. The one catalog loop (step 8) drops only names that start with the exact text stock_co__
-- (two underscores, compared as plain text, never a LIKE), so no live menu or stock function can be hit.
--
-- WHAT IT DOES, IN ORDER
--   1. Guard: Ops database; the 0b locks are off; 0a's saved function bodies (stock_native_backup,
--      written on the night 0a ran) are present whenever any 0a object is.
--   2. Holds the stock tables (inventory_items first, as every sale does) and records 33 figures per
--      venue of every company that holds stock: row counts of the 26 stock tables, on hand, cost,
--      books, ledger quantity and value, area stock and the base quantity of every recipe line.
--   3. Cron and secret: unschedules stock-save-queue and stock-nightly by name; deletes the vault
--      secret stock_nightly_cron_key.
--   4. Policies: the 51 stock policies go back to user_accessible_locations() and the 14 to
--      accessible_location_uuids(), each to its exact live text of 20 Oct (pinned below).
--   5. Function bodies: replays the seven bodies 0a saved on the night (_stock_receive_lines,
--      approve_stock_count, post_stock_transfer_leg, stock_office_reaches, stock_caller_reaches,
--      stock_cost_rule, user_profiles_fence_guard), so what was live that night comes back, and
--      checks each one against the md5 0a recorded. Their grants were never changed.
--   6. Triggers 0a put on live tables: stock_co_orphan, stock_co_ref_lock_ins and stock_co_ref_lock_upd
--      (6 site tables), stock_co_mirror_ins, _upd and _del (recipe_lines, menu_item_recipes),
--      locations_stock_co_multi, user_profiles_stock_control_guard.
--   7. The Location 2 fills: deletes the packs and unit bridges 0a copied from Provo (found as the
--      rows with a company record created in 0a's own transaction, or logged by the fill in
--      stock_change_log with source 'fill'). A fill that a recipe line or a
--      supplier pack now converts through, or that another pack is nested under, is KEPT (deleting it
--      would change what a sale takes off) and listed in the check row.
--   8. Drops every table 0a created, every function and the queue procedure 0a created (each by its
--      exact signature, then any other internal helper whose name starts with the exact text
--      stock_co__ two underscores), the unique index stock_count_lines_one_per_area, and the columns
--      0a added: company_ref and row_version (6 site tables), suppliers.cc_emails, delivery_fee and
--      approval_limit, user_profiles.stock_control (the web app treats it as optional, so nobody is
--      locked out), and archived_at on supplier_products, item_packaging_formats and
--      inventory_item_conversions where no row has it set.
--   9. Compares the 33 figures with step 2 and raises (nothing changes) on any difference other than
--      the fills deleted in step 7.
--
-- KEPT, ON PURPOSE (the check row says so)
--   * stock_counts.approved_by_staff_id and approved_by_staff_name (they hold the PIN holder of every
--     count approved since 0a).
--   * archived_at on supplier_products, item_packaging_formats, inventory_item_conversions when any row
--     has it set (dropping it would bring switched off rows back to life).
--   * REVALUE rows in stock_movements, 'REVALUE' in stock_movements_movement_type_check and 'COMPANY' in
--     item_cost_history_source_chk (rows may carry them; the ledger stays whole). The opening revalue
--     has its own rollback (20261021a_OPS_stock_native_0a_revalue_ROLLBACK.sql).
--   * The foreign key indexes of 0a step 4 (harmless, they only speed up deletes).
--   * Every site row: items, suppliers, supplier packs, packs, bridges and recipes the save functions
--     wrote after 0a stay as that site's own rows; on hand, cost and the ledger are untouched.
--
-- WEB APP: the Drop 0 web release may read row_version, company_ref and archived_at, which this file
-- drops. Put the web app back to the release before Drop 0 together with this rollback.

do $guard$
declare
  v_any_0a boolean;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if exists (select 1 from pg_trigger g
              where not g.tgisinternal
                and g.tgname in ('stock_co_lock_ins', 'stock_co_lock_upd', 'stock_co_lock_del',
                                 'stock_co_lock_site_price', 'stock_co_lock_ledger')) then
    raise exception 'The 0b locks are still on. Run 20261022a_OPS_stock_native_0b_ROLLBACK.sql first. Nothing was changed.';
  end if;
  v_any_0a := to_regprocedure('public.stock_reach_locations()') is not null
           or to_regprocedure('public.stock_co__writer_ok()') is not null
           or to_regclass('public.stock_co_items') is not null
           or to_regclass('public.stock_co_settings') is not null
           or exists (select 1 from information_schema.columns c
                       where c.table_schema = 'public' and c.table_name = 'inventory_items' and c.column_name = 'company_ref');
  if v_any_0a and to_regclass('public.stock_native_backup') is null then
    raise exception 'The function bodies 0a saved (stock_native_backup) are missing, so the stock functions cannot be put back. Nothing was changed. Ask Claude.';
  end if;
  if to_regclass('public.stock_native_backup') is not null then
    if (select count(distinct b.name) from public.stock_native_backup b
         where b.name in ('_stock_receive_lines', 'approve_stock_count', 'post_stock_transfer_leg', 'stock_office_reaches',
                          'stock_caller_reaches', 'stock_cost_rule', 'user_profiles_fence_guard')) <> 7 then
      raise exception 'stock_native_backup does not hold all seven function bodies 0a saved. Nothing was changed. Ask Claude.';
    end if;
  end if;
end
$guard$;

-- 20261023a: the drainer release reads 0a's tables, so its own rollback runs first.
do $drainer_first$
begin
  if to_regclass('public.stock_sale_takes') is not null then
    raise exception 'The drainer release (20261023a) is still in. Run 20261023a_OPS_stock_drainer_v2_ROLLBACK.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is not null then
    if exists (select 1 from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') then
      raise exception 'The drainer release (20261023a) is still in. Run 20261023a_OPS_stock_drainer_v2_ROLLBACK.sql first. Nothing was changed.';
    end if;
  end if;
end
$drainer_first$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------- 2. hold the stock tables, then the figures before
-- inventory_items first, then the ledger tables, the order every sale takes them in.
lock table public.inventory_items, public.stock_movements, public.inventory_item_area_stock,
           public.suppliers, public.supplier_products, public.item_packaging_formats, public.inventory_item_conversions,
           public.recipes, public.recipe_lines, public.menu_item_recipes, public.prep_schedule, public.par_levels,
           public.purchase_orders, public.po_lines, public.supplier_invoices, public.supplier_invoice_lines,
           public.item_cost_history, public.stock_counts, public.stock_count_lines, public.stock_count_areas,
           public.storage_areas, public.inventory_item_areas, public.stock_site_settings, public.stock_transfers,
           public.stock_transfer_lines, public.production_batches, public.waste_events
  in access exclusive mode;

create temp table _stock_native_rb_snap (
  location_id uuid not null,
  metric text not null,
  value numeric,
  primary key (location_id, metric)
) on commit drop;

insert into _stock_native_rb_snap (location_id, metric, value)
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

-- ---------------------------------------------------------------- 3. cron jobs and the vault secret, by name
do $cron$
declare
  j record;
begin
  if to_regclass('cron.job') is not null then
    for j in select c.jobid from cron.job c where c.jobname in ('stock-save-queue', 'stock-nightly') loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets s where s.name = 'stock_nightly_cron_key';
  end if;
end
$cron$;

-- ---------------------------------------------------------------- 4. the 65 stock policies back to their 20 Oct text
-- Each policy keeps its name, command and roles; only USING and WITH CHECK are set back.
create temp table _stock_native_rb_policies (
  table_name text not null,
  policy_name text not null,
  cmd text not null,
  using_text text,
  check_text text,
  primary key (table_name, policy_name)
) on commit drop;

insert into _stock_native_rb_policies (table_name, policy_name, cmd, using_text, check_text) values
      ('inventory_item_area_stock', 'inventory_item_area_stock_read', 'SELECT',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('inventory_item_areas', 'inventory_item_areas_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('inventory_item_conversions', 'inventory_item_conversions_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('inventory_item_conversions', 'inventory_item_conversions_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('inventory_item_conversions', 'inventory_item_conversions_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('inventory_item_conversions', 'inventory_item_conversions_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('inventory_items', 'inventory_items_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('inventory_items', 'inventory_items_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('inventory_items', 'inventory_items_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('inventory_items', 'inventory_items_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('item_cost_history', 'item_cost_history_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('item_packaging_formats', 'item_packaging_formats_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('item_packaging_formats', 'item_packaging_formats_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('item_packaging_formats', 'item_packaging_formats_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('item_packaging_formats', 'item_packaging_formats_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('menu_item_recipes', 'menu_item_recipes_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('menu_item_recipes', 'menu_item_recipes_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('menu_item_recipes', 'menu_item_recipes_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('menu_item_recipes', 'menu_item_recipes_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('par_levels', 'par_levels_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('po_lines', 'po_lines_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('prep_schedule', 'prep_schedule_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('prep_schedule', 'prep_schedule_ins', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('prep_schedule', 'prep_schedule_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('prep_schedule', 'prep_schedule_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('production_batches', 'production_batches_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('production_batches', 'production_batches_ins', 'INSERT',
       null,
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))'),
      ('production_batches', 'production_batches_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('production_batches', 'production_batches_upd', 'UPDATE',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))'),
      ('purchase_orders', 'purchase_orders_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('recipe_lines', 'recipe_lines_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('recipe_lines', 'recipe_lines_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('recipe_lines', 'recipe_lines_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('recipe_lines', 'recipe_lines_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('recipes', 'recipes_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('recipes', 'recipes_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('recipes', 'recipes_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('recipes', 'recipes_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_count_areas', 'stock_count_areas_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_count_lines', 'stock_count_lines_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_counts', 'stock_counts_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_movements', 'stock_movements_read', 'SELECT',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('stock_site_settings', 'stock_site_settings_insert', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_site_settings', 'stock_site_settings_read', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('stock_site_settings', 'stock_site_settings_update', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('stock_transfer_lines', 'stock_transfer_lines_delete', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('stock_transfer_lines', 'stock_transfer_lines_insert', 'INSERT',
       null,
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) AND ((to_location_id IS NULL) OR stock_same_company(location_id, to_location_id)))'),
      ('stock_transfer_lines', 'stock_transfer_lines_select', 'SELECT',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))',
       null),
      ('stock_transfer_lines', 'stock_transfer_lines_update', 'UPDATE',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))'),
      ('stock_transfers', 'stock_transfers_delete', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('stock_transfers', 'stock_transfers_insert', 'INSERT',
       null,
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) AND ((to_location_id IS NULL) OR stock_same_company(location_id, to_location_id)))'),
      ('stock_transfers', 'stock_transfers_select', 'SELECT',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))',
       null),
      ('stock_transfers', 'stock_transfers_update', 'UPDATE',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))',
       '(((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR ((to_location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))'),
      ('storage_areas', 'storage_areas_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('supplier_invoice_lines', 'supplier_invoice_lines_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('supplier_invoices', 'supplier_invoices_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('supplier_products', 'supplier_products_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('supplier_products', 'supplier_products_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('supplier_products', 'supplier_products_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('supplier_products', 'supplier_products_write', 'INSERT',
       null,
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('suppliers', 'suppliers_rls', 'ALL',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))'),
      ('waste_events', 'waste_events_del', 'DELETE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       null),
      ('waste_events', 'waste_events_ins', 'INSERT',
       null,
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))'),
      ('waste_events', 'waste_events_sel', 'SELECT',
       '(location_id IN ( SELECT accessible_location_uuids() AS accessible_location_uuids))',
       null),
      ('waste_events', 'waste_events_upd', 'UPDATE',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))',
       '((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))')
;

do $policies$
declare
  p record;
  v_missing text;
  v_differ text;
begin
  select string_agg(format('%s on %s', x.policy_name, x.table_name), ', ' order by x.table_name, x.policy_name)
    into v_missing
    from _stock_native_rb_policies x
   where not exists (select 1 from pg_policies g
                      where g.schemaname = 'public' and g.tablename = x.table_name and g.policyname = x.policy_name);
  if v_missing is not null then
    raise exception 'These stock policies no longer exist, so they cannot be put back: %. Nothing was changed. Ask Claude.', v_missing;
  end if;
  for p in select * from _stock_native_rb_policies order by table_name, policy_name loop
    if p.using_text is not null and p.check_text is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)', p.policy_name, p.table_name, p.using_text, p.check_text);
    elsif p.using_text is not null then
      execute format('alter policy %I on public.%I using (%s)', p.policy_name, p.table_name, p.using_text);
    elsif p.check_text is not null then
      execute format('alter policy %I on public.%I with check (%s)', p.policy_name, p.table_name, p.check_text);
    end if;
  end loop;
  select string_agg(format('%s on %s', x.policy_name, x.table_name), ', ' order by x.table_name, x.policy_name)
    into v_differ
    from _stock_native_rb_policies x
    join pg_policies g on g.schemaname = 'public' and g.tablename = x.table_name and g.policyname = x.policy_name
   where g.qual is distinct from x.using_text or g.with_check is distinct from x.check_text or g.cmd <> x.cmd;
  if v_differ is not null then
    raise exception 'These stock policies did not come back to their 20 Oct text: %. Nothing was changed. Ask Claude.', v_differ;
  end if;
end
$policies$;

-- ---------------------------------------------------------------- 5. the seven function bodies saved on the night
create temp table _stock_native_rb_bodies (
  name text primary key,
  signature text not null,
  saved_md5 text,
  restored boolean not null default false
) on commit drop;

insert into _stock_native_rb_bodies (name, signature) values
  ('_stock_receive_lines',      'public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)'),
  ('approve_stock_count',       'public.approve_stock_count(uuid,text,text,jsonb,boolean)'),
  ('post_stock_transfer_leg',   'public.post_stock_transfer_leg(uuid,text,text)'),
  ('stock_office_reaches',      'public.stock_office_reaches(uuid)'),
  ('stock_caller_reaches',      'public.stock_caller_reaches(uuid)'),
  ('stock_cost_rule',           'public.stock_cost_rule(uuid)'),
  ('user_profiles_fence_guard', 'public.user_profiles_fence_guard()');

do $bodies$
declare
  r record;
  v_bad text;
begin
  if to_regclass('public.stock_native_backup') is null then
    return;
  end if;
  for r in
    execute 'select b.name, b.body, b.md5 from public.stock_native_backup b
              where b.name in (select x.name from _stock_native_rb_bodies x) order by b.name'
  loop
    execute r.body;
    update _stock_native_rb_bodies x set saved_md5 = r.md5 where x.name = r.name;
  end loop;
  update _stock_native_rb_bodies x
     set restored = true
   where x.saved_md5 is not null
     and x.saved_md5 = (select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                          from pg_proc p where p.oid = to_regprocedure(x.signature));
  select string_agg(x.name, ', ' order by x.name) into v_bad from _stock_native_rb_bodies x where not x.restored;
  if v_bad is not null then
    raise exception 'These stock functions did not come back to the body 0a saved on the night: %. Nothing was changed. Ask Claude.', v_bad;
  end if;
end
$bodies$;

-- ---------------------------------------------------------------- 6. the triggers 0a put on live tables
drop trigger if exists stock_co_orphan on public.inventory_items;
drop trigger if exists stock_co_orphan on public.suppliers;
drop trigger if exists stock_co_orphan on public.supplier_products;
drop trigger if exists stock_co_orphan on public.item_packaging_formats;
drop trigger if exists stock_co_orphan on public.inventory_item_conversions;
drop trigger if exists stock_co_orphan on public.recipes;
drop trigger if exists stock_co_ref_lock_ins on public.inventory_items;
drop trigger if exists stock_co_ref_lock_upd on public.inventory_items;
drop trigger if exists stock_co_ref_lock_ins on public.suppliers;
drop trigger if exists stock_co_ref_lock_upd on public.suppliers;
drop trigger if exists stock_co_ref_lock_ins on public.supplier_products;
drop trigger if exists stock_co_ref_lock_upd on public.supplier_products;
drop trigger if exists stock_co_ref_lock_ins on public.item_packaging_formats;
drop trigger if exists stock_co_ref_lock_upd on public.item_packaging_formats;
drop trigger if exists stock_co_ref_lock_ins on public.inventory_item_conversions;
drop trigger if exists stock_co_ref_lock_upd on public.inventory_item_conversions;
drop trigger if exists stock_co_ref_lock_ins on public.recipes;
drop trigger if exists stock_co_ref_lock_upd on public.recipes;
drop trigger if exists stock_co_mirror_ins on public.recipe_lines;
drop trigger if exists stock_co_mirror_upd on public.recipe_lines;
drop trigger if exists stock_co_mirror_del on public.recipe_lines;
drop trigger if exists stock_co_mirror_ins on public.menu_item_recipes;
drop trigger if exists stock_co_mirror_upd on public.menu_item_recipes;
drop trigger if exists stock_co_mirror_del on public.menu_item_recipes;
drop trigger if exists locations_stock_co_multi on public.locations;
drop trigger if exists user_profiles_stock_control_guard on public.user_profiles;

-- ---------------------------------------------------------------- 7. the Location 2 fills (packs and bridges 0a copied from Provo)
-- A fill is a pack or bridge with a company record created inside 0a's own transaction (its
-- created_at is 0a's now(), the same instant stock_native_backup.saved_at holds), or one the fill logged
-- in stock_change_log (source 'fill', the new site row id in after.site_row). Each one is deleted
-- on its own, children before parents; it is kept when another pack (not a fill) is nested under it,
-- when the live in use check refuses (a recipe line uses the pack), or when deleting it would change
-- the base quantity or the conversion of any recipe line or supplier pack of that item at that site.
create temp table _stock_native_rb_fills (
  kind text not null,
  row_id uuid not null,
  location_id uuid not null,
  item_id uuid,
  deleted boolean not null,
  why text not null,
  primary key (kind, row_id)
) on commit drop;

do $fills$
declare
  v_at timestamptz;
  v_logged uuid[] := '{}'::uuid[];
  r record;
  v_why text;
  v_b_qty numeric;
  v_b_lines integer;
  v_b_packs integer;
  v_a_qty numeric;
  v_a_lines integer;
  v_a_packs integer;
begin
  if to_regclass('public.stock_native_backup') is null then
    return;
  end if;
  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'item_packaging_formats' and c.column_name = 'company_ref')
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'inventory_item_conversions' and c.column_name = 'company_ref') then
    return;
  end if;
  execute 'select min(b.saved_at) from public.stock_native_backup b' into v_at;
  if v_at is null then
    return;
  end if;
  -- second sign: the fills write one change log row each (source 'fill', the new site row in after)
  if to_regclass('public.stock_change_log') is not null then
    execute $q$
      select coalesce(array_agg((l.after ->> 'site_row')::uuid), '{}'::uuid[])
        from public.stock_change_log l
       where l.source = 'fill' and l.entity in ('pack', 'bridge')
         and coalesce(l.after ->> 'site_row', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    $q$ into v_logged;
  end if;

  for r in
    execute $q$
      with recursive cand as (
        select f.id, f.location_id, f.inventory_item_id, f.parent_format_id
          from public.item_packaging_formats f
         where f.company_ref is not null and (f.created_at = $1 or f.id = any($2))
      ), depth (id, d) as (
        select c.id, 0 from cand c
         where c.parent_format_id is null or c.parent_format_id not in (select c2.id from cand c2)
        union all
        select c.id, depth.d + 1 from cand c join depth on c.parent_format_id = depth.id where depth.d < 20
      )
      select 'pack'::text as kind, c.id, c.location_id, c.inventory_item_id as item_id, coalesce(max(depth.d), 0) as d
        from cand c left join depth on depth.id = c.id
       group by c.id, c.location_id, c.inventory_item_id
      union all
      select 'bridge'::text, f.id, f.location_id, f.inventory_item_id, 0
        from public.inventory_item_conversions f
       where f.company_ref is not null and (f.created_at = $1 or f.id = any($2))
       order by 1 desc, 5 desc, 2
    $q$ using v_at, v_logged
  loop
    v_why := null;
    if r.kind = 'pack' and exists (
         select 1 from public.item_packaging_formats x
          where x.parent_format_id = r.id
            and x.id <> r.id
            and not (x.company_ref is not null and (x.created_at = v_at or x.id = any(v_logged)))) then
      v_why := 'kept: another pack is nested under it';
    else
      select coalesce(sum(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)), 0),
             count(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id))
        into v_b_qty, v_b_lines
        from public.recipe_lines rl
       where rl.location_id = r.location_id and rl.component_item_id = r.item_id;
      select count(public.stock_qty_to_base(sp.inner_qty, sp.inner_unit, sp.inventory_item_id))
        into v_b_packs
        from public.supplier_products sp
       where sp.location_id = r.location_id and sp.inventory_item_id = r.item_id;
      begin
        if r.kind = 'pack' then
          delete from public.item_packaging_formats f where f.id = r.id;
        else
          delete from public.inventory_item_conversions f where f.id = r.id;
        end if;
        select coalesce(sum(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id)), 0),
               count(public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id))
          into v_a_qty, v_a_lines
          from public.recipe_lines rl
         where rl.location_id = r.location_id and rl.component_item_id = r.item_id;
        select count(public.stock_qty_to_base(sp.inner_qty, sp.inner_unit, sp.inventory_item_id))
          into v_a_packs
          from public.supplier_products sp
         where sp.location_id = r.location_id and sp.inventory_item_id = r.item_id;
        if v_a_qty is distinct from v_b_qty or v_a_lines is distinct from v_b_lines or v_a_packs is distinct from v_b_packs then
          raise exception 'stock_native_rb_keep' using errcode = 'P0001';
        end if;
      exception when others then
        v_why := case when sqlerrm = 'stock_native_rb_keep'
                      then 'kept: a recipe line or supplier pack of this item converts through it'
                      else 'kept: ' || sqlerrm end;
      end;
    end if;
    insert into _stock_native_rb_fills (kind, row_id, location_id, item_id, deleted, why)
    values (r.kind, r.id, r.location_id, r.item_id, v_why is null, coalesce(v_why, 'deleted'));
  end loop;
end
$fills$;

-- ---------------------------------------------------------------- 8. the tables, functions, index and columns 0a added
alter table if exists public.stock_co_items drop constraint if exists stock_co_items_main_supplier_item_fk;

-- Each table by its own name, the ones that point at another first; no cascade, so anything else
-- that leans on one of them stops this file (nothing changes) instead of being dropped with it.
drop table if exists public.stock_co_item_sites;
drop table if exists public.stock_co_pack_sites;
drop table if exists public.stock_co_bridge_sites;
drop table if exists public.stock_co_supplier_sites;
drop table if exists public.stock_co_supplier_item_sites;
drop table if exists public.stock_co_recipe_sites;
drop table if exists public.stock_co_recipe_lines;
drop table if exists public.stock_co_recipes;
drop table if exists public.stock_co_supplier_items;
drop table if exists public.stock_co_packs;
drop table if exists public.stock_co_bridges;
drop table if exists public.stock_co_suppliers;
drop table if exists public.stock_co_items;
drop table if exists public.stock_change_log;
drop table if exists public.stock_save_queue;
drop table if exists public.stock_co_site_groups;
drop table if exists public.stock_co_site_settings;
drop table if exists public.stock_co_settings;
drop table if exists public.venue_clock;
drop table if exists public.stock_day_sums;
drop table if exists public.stock_day_sums_repair;
drop table if exists public.sales_day_sums;
drop table if exists public.sales_day_sums_queue;
drop table if exists public.stock_period_snapshots;
drop table if exists public.stock_periods;
drop table if exists public.stock_pin_tries;

-- part 1
drop function if exists public.user_profiles_stock_control_guard();
drop function if exists public.set_stock_control(uuid, text);
drop function if exists public.stock_level(uuid, uuid);
drop function if exists public.stock_reach_orgs();
drop function if exists public.stock_reach_locations();
drop function if exists public.stock_co__multi_mark();
-- part 2
drop function if exists public.stock_co__org_guard();
drop function if exists public.stock_co__site_item_in_use(uuid, uuid);
drop function if exists public.stock_co__unit_in_use(uuid, text);
drop function if exists public.stock_co__base_unit_lock();
drop function if exists public.stock_co__ref_lock();
drop function if exists public.stock_co__writer_ok();
drop function if exists public.stock_co__log(uuid, uuid, text, uuid, text, jsonb, jsonb, text);
drop function if exists public.stock_co__enqueue(uuid, uuid, text, jsonb, uuid[]);
drop function if exists public.stock_co__run_job(bigint);
drop procedure if exists public.stock_save_queue_run(integer);
-- part 3
drop function if exists public._stock_revalue(uuid, uuid, numeric, numeric, numeric, text, text, text);
drop function if exists public.stock_co__cost_rule_of(uuid);
drop function if exists public.stock_co__rate_id_for(uuid, numeric, uuid);
drop function if exists public.stock_co__cost_step(uuid, uuid[], bigint, boolean);
drop function if exists public.stock_co__sync_site(uuid, uuid[], uuid[], boolean, boolean);
drop function if exists public.stock_co__sync_recipes(uuid, uuid[], boolean, boolean);
drop function if exists public.stock_co__allowed(text);
drop function if exists public.stock_co__clean(text, jsonb);
drop function if exists public.stock_co__bridge_needed(uuid);
drop function if exists public.stock_co__guard(uuid, text, text, uuid[]);
drop function if exists public.stock_save_item(jsonb, jsonb, integer, text);
drop function if exists public.stock_archive_item(uuid, integer, boolean, text);
drop function if exists public.stock_save_item_site(uuid, uuid, jsonb, integer, text);
drop function if exists public.stock_save_pack(jsonb, integer, text);
drop function if exists public.stock_archive_pack(uuid, integer, boolean, text);
drop function if exists public.stock_set_pack_default(uuid, text, integer, text);
drop function if exists public.stock_save_bridge(jsonb, integer, text);
drop function if exists public.stock_archive_bridge(uuid, integer, boolean, text);
drop function if exists public.stock_save_supplier(jsonb, jsonb, integer, text);
drop function if exists public.stock_archive_supplier(uuid, integer, boolean, text);
drop function if exists public.stock_save_supplier_site(uuid, uuid, jsonb, integer, text);
drop function if exists public.stock_save_supplier_item(jsonb, integer, text);
drop function if exists public.stock_save_supplier_item_site(uuid, uuid, jsonb, integer, text);
drop function if exists public.stock_archive_supplier_item(uuid, integer, boolean, text);
drop function if exists public.stock_save_recipe(jsonb, jsonb, integer, text);
drop function if exists public.stock_archive_recipe(uuid, integer, boolean, text);
drop function if exists public.stock_link_menu_item(uuid, text, uuid, numeric, text);
drop function if exists public.stock_recost_made_items(uuid, uuid[], text);
drop function if exists public.stock_save_cost_rule(uuid, text, uuid, uuid);
drop function if exists public.stock_site_scope(uuid);
drop function if exists public.stock_item_detail(uuid);
drop function if exists public.stock_changes_page(text, uuid, jsonb, integer);
-- part 3 internal helpers (contract 2.6), each by its exact signature
drop function if exists public.stock_co__company_id(text, uuid);
drop function if exists public.stock_co__site_loc(text, uuid);
drop function if exists public.stock_co__item_at(uuid, uuid);
drop function if exists public.stock_co__conflict(uuid, text[], uuid, integer, uuid, timestamptz);
drop function if exists public.stock_co__currency_check(uuid);
drop function if exists public.stock_co__dims_reached(uuid, uuid);
drop function if exists public.stock_co__log_diff(uuid, uuid, text, uuid, jsonb, jsonb, text);
drop function if exists public.stock_co__made_cost(uuid, uuid, uuid[]);
drop function if exists public.stock_co__new_site_item(uuid, uuid, text, boolean);
drop function if exists public.stock_co__new_site_recipe(uuid, uuid);
drop function if exists public.stock_co__new_site_supplier(uuid, uuid);
drop function if exists public.stock_co__plan_bridges(uuid, uuid[]);
drop function if exists public.stock_co__plan_items(uuid, uuid[]);
drop function if exists public.stock_co__plan_lines(uuid, uuid);
drop function if exists public.stock_co__plan_packs(uuid, uuid[]);
drop function if exists public.stock_co__plan_recipes(uuid, uuid[]);
drop function if exists public.stock_co__plan_sps(uuid, uuid[], uuid[]);
drop function if exists public.stock_co__plan_suppliers(uuid, uuid[]);
drop function if exists public.stock_co__rate_words(uuid);
drop function if exists public.stock_co__reached_site(uuid[]);
drop function if exists public.stock_co__recost(uuid, uuid[], boolean);
drop function if exists public.stock_co__run_sites(uuid, uuid, uuid[], uuid[], uuid[], uuid[], bigint, timestamptz);
drop function if exists public.stock_co__section(text, text[]);
drop function if exists public.stock_co__set_preferred(uuid, uuid, uuid, boolean);
drop function if exists public.stock_co__signed_in();
drop function if exists public.stock_co__sp_unit_cost(uuid);
-- part 4
drop function if exists public.stock_co__orphan();
drop function if exists public.stock_co__orphan_row(text, uuid, integer);
drop function if exists public.stock_co__mirror_lines();
drop function if exists public.stock_co__mirror_recipe(uuid, boolean);
drop function if exists public.stock_co__clock_of(uuid);
drop function if exists public.stock_co__day_start_at(date, time, text);
drop function if exists public.venue_clock_sync(jsonb);
drop function if exists public.stock_nightly_cron_ok(text);
drop function if exists public.stock_nightly_send();
drop function if exists public.stock_nightly_upkeep();
drop function if exists public.stock_co__venue_day(uuid, timestamptz);
drop function if exists public.stock_day_sums_rebuild(uuid, date, date);
drop function if exists public.sales_day_sums_rebuild(uuid, date, date);
drop function if exists public.stock_day_sums_check(uuid, date);
drop function if exists public.sales_day_sums_check(uuid, date);
drop function if exists public.stock_opening_costs(uuid);
drop function if exists public.stock_approve_count_pin(uuid, text, text, text, jsonb, boolean);
-- part 5
drop function if exists public.stock_co__backfill(uuid);
drop function if exists public.stock_co__link(uuid, uuid, uuid);
drop function if exists public.stock_co__fill_packs(uuid, uuid, uuid);
drop function if exists public.stock_co__fill_bridges(uuid, uuid, uuid);

-- Any other internal helper a part added (contract 2.6: the name starts with the exact text
-- stock_co__, two underscores). starts_with() compares plain text, so stock_count_*, stock_cost_rule
-- and stock_convert_qty can never match. No cascade: a helper something else leans on stops the file.
do $helpers$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure::text as sig, p.prokind
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and starts_with(p.proname, 'stock_co__')
  loop
    if f.prokind = 'p' then
      execute format('drop procedure %s', f.sig);
    else
      execute format('drop function %s', f.sig);
    end if;
  end loop;
end
$helpers$;

drop index if exists public.stock_count_lines_one_per_area;

alter table public.inventory_items drop column if exists company_ref;
alter table public.inventory_items drop column if exists row_version;
alter table public.suppliers drop column if exists company_ref;
alter table public.suppliers drop column if exists row_version;
alter table public.suppliers drop column if exists cc_emails;
alter table public.suppliers drop column if exists delivery_fee;
alter table public.suppliers drop column if exists approval_limit;
alter table public.supplier_products drop column if exists company_ref;
alter table public.supplier_products drop column if exists row_version;
alter table public.item_packaging_formats drop column if exists company_ref;
alter table public.item_packaging_formats drop column if exists row_version;
alter table public.inventory_item_conversions drop column if exists company_ref;
alter table public.inventory_item_conversions drop column if exists row_version;
alter table public.recipes drop column if exists company_ref;
alter table public.recipes drop column if exists row_version;
alter table public.user_profiles drop column if exists stock_control;

-- archived_at on the three tables that had none before 0a: dropped only while no row has it set
do $archived$
declare
  t text;
  v_set boolean;
begin
  foreach t in array array['supplier_products', 'item_packaging_formats', 'inventory_item_conversions'] loop
    if exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = t and c.column_name = 'archived_at') then
      execute format('select exists (select 1 from public.%I where archived_at is not null)', t) into v_set;
      if not v_set then
        execute format('alter table public.%I drop column archived_at', t);
      end if;
    end if;
  end loop;
end
$archived$;

drop table if exists public.stock_native_backup;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- 9. after: compare with step 2 inside the transaction
create temp table _stock_native_rb_after (
  location_id uuid not null,
  metric text not null,
  value numeric,
  primary key (location_id, metric)
) on commit drop;

insert into _stock_native_rb_after (location_id, metric, value)
select v.id, e.key, coalesce(e.value::numeric, 0)
  from (select distinct s.location_id as id from _stock_native_rb_snap s) v
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

do $compare$
declare
  v_bad text;
begin
  select string_agg(format('%s %s expected %s found %s', x.location_id, x.metric, x.expected, a.value), '; ' order by x.location_id, x.metric)
    into v_bad
    from (select s.location_id, s.metric,
                 s.value - case s.metric
                             when 'n:item_packaging_formats' then
                               (select count(*) from _stock_native_rb_fills f where f.location_id = s.location_id and f.kind = 'pack' and f.deleted)
                             when 'n:inventory_item_conversions' then
                               (select count(*) from _stock_native_rb_fills f where f.location_id = s.location_id and f.kind = 'bridge' and f.deleted)
                             else 0 end as expected
            from _stock_native_rb_snap s) x
    left join _stock_native_rb_after a on a.location_id = x.location_id and a.metric = x.metric
   where a.value is distinct from x.expected;
  if v_bad is not null then
    raise exception 'The rollback would have changed a stock figure, so nothing was changed. Ask Claude. %', v_bad;
  end if;
end
$compare$;

-- VISIBLE CHECK (the SQL editor shows this last result), one row per venue of a company that holds
-- stock. Expected:
--   figures_unchanged true; delta {} except Location 2: {"n:item_packaging_formats": -<packs_deleted>,
--   "n:inventory_item_conversions": -<bridges_deleted>} (55 and 7 when nothing at Location 2 uses a fill);
--   packs_kept 0, bridges_kept 0 (any kept fill is listed in fills_kept with the reason; fills_deleted lists
--   the ids taken out);
--   bodies_restored 7 (0 on a second run), policies_back {"user_accessible_locations": 51,
--   "accessible_location_uuids": 14, "stock_reach_locations": 0}; tables_left 0, functions_left 0,
--   triggers_left 0, columns_left 0, cron_jobs_left 0, nightly_key_left false;
--   kept: the stock_counts approver columns, archived_at where rows are archived, REVALUE rows.
select l.name as venue,
       l.id as location_id,
       true as figures_unchanged,
       coalesce((select jsonb_object_agg(a.metric, a.value - s.value order by a.metric)
                   from _stock_native_rb_after a
                   join _stock_native_rb_snap s on s.location_id = a.location_id and s.metric = a.metric
                  where a.location_id = l.id and a.value is distinct from s.value), '{}'::jsonb) as delta,
       (select count(*) from _stock_native_rb_fills f where f.location_id = l.id and f.kind = 'pack' and f.deleted) as packs_deleted,
       (select count(*) from _stock_native_rb_fills f where f.location_id = l.id and f.kind = 'pack' and not f.deleted) as packs_kept,
       (select count(*) from _stock_native_rb_fills f where f.location_id = l.id and f.kind = 'bridge' and f.deleted) as bridges_deleted,
       (select count(*) from _stock_native_rb_fills f where f.location_id = l.id and f.kind = 'bridge' and not f.deleted) as bridges_kept,
       coalesce((select jsonb_agg(jsonb_build_object('kind', f.kind, 'id', f.row_id, 'why', f.why) order by f.kind, f.row_id)
                   from _stock_native_rb_fills f where f.location_id = l.id and not f.deleted), '[]'::jsonb) as fills_kept,
       coalesce((select jsonb_agg(f.row_id order by f.kind, f.row_id)
                   from _stock_native_rb_fills f where f.location_id = l.id and f.deleted), '[]'::jsonb) as fills_deleted,
       (select count(*) from _stock_native_rb_bodies b where b.restored) as bodies_restored,
       jsonb_build_object(
         'user_accessible_locations', (select count(*) from pg_policies g join _stock_native_rb_policies x
                                         on x.table_name = g.tablename and x.policy_name = g.policyname
                                        where g.schemaname = 'public'
                                          and strpos(coalesce(g.qual, '') || coalesce(g.with_check, ''), 'user_accessible_locations()') > 0),
         'accessible_location_uuids', (select count(*) from pg_policies g join _stock_native_rb_policies x
                                         on x.table_name = g.tablename and x.policy_name = g.policyname
                                        where g.schemaname = 'public'
                                          and strpos(coalesce(g.qual, '') || coalesce(g.with_check, ''), 'accessible_location_uuids()') > 0),
         'stock_reach_locations', (select count(*) from pg_policies g
                                    where g.schemaname = 'public'
                                      and strpos(coalesce(g.qual, '') || coalesce(g.with_check, ''), 'stock_reach_') > 0)) as policies_back,
       (select count(*) from unnest(array[
          'stock_native_backup', 'stock_co_settings', 'stock_co_site_settings', 'stock_co_site_groups', 'stock_co_items',
          'stock_co_item_sites', 'stock_co_packs', 'stock_co_pack_sites', 'stock_co_bridges', 'stock_co_bridge_sites',
          'stock_co_suppliers', 'stock_co_supplier_sites', 'stock_co_supplier_items', 'stock_co_supplier_item_sites',
          'stock_co_recipes', 'stock_co_recipe_lines', 'stock_co_recipe_sites', 'stock_change_log', 'stock_save_queue',
          'venue_clock', 'stock_day_sums', 'stock_day_sums_repair', 'sales_day_sums', 'sales_day_sums_queue',
          'stock_periods', 'stock_period_snapshots', 'stock_pin_tries']) t(n)
         where to_regclass('public.' || t.n) is not null) as tables_left,
       (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (starts_with(p.proname, 'stock_co__')
                or p.proname in ('user_profiles_stock_control_guard', 'set_stock_control', 'stock_level', 'stock_reach_locations',
                                 'stock_reach_orgs', 'stock_save_queue_run', '_stock_revalue', 'stock_save_item', 'stock_archive_item',
                                 'stock_save_item_site', 'stock_save_pack', 'stock_archive_pack', 'stock_set_pack_default',
                                 'stock_save_bridge', 'stock_archive_bridge', 'stock_save_supplier', 'stock_archive_supplier',
                                 'stock_save_supplier_site', 'stock_save_supplier_item', 'stock_save_supplier_item_site',
                                 'stock_archive_supplier_item', 'stock_save_recipe', 'stock_archive_recipe', 'stock_link_menu_item',
                                 'stock_recost_made_items', 'stock_save_cost_rule', 'stock_site_scope', 'stock_item_detail',
                                 'stock_changes_page', 'venue_clock_sync', 'stock_nightly_cron_ok', 'stock_nightly_send',
                                 'stock_nightly_upkeep', 'stock_day_sums_rebuild', 'sales_day_sums_rebuild', 'stock_day_sums_check',
                                 'sales_day_sums_check', 'stock_opening_costs', 'stock_approve_count_pin'))) as functions_left,
       (select count(*) from pg_trigger g
         where not g.tgisinternal
           and g.tgname in ('stock_co_orphan', 'stock_co_mirror_ins', 'stock_co_mirror_upd', 'stock_co_mirror_del',
                            'locations_stock_co_multi', 'user_profiles_stock_control_guard', 'stock_co_org_guard',
                            'stock_co_base_unit_lock')) as triggers_left,
       (select count(*) from information_schema.columns c
         where c.table_schema = 'public'
           and ((c.column_name in ('company_ref', 'row_version')
                 and c.table_name in ('inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats',
                                      'inventory_item_conversions', 'recipes'))
                or (c.table_name = 'suppliers' and c.column_name in ('cc_emails', 'delivery_fee', 'approval_limit'))
                or (c.table_name = 'user_profiles' and c.column_name = 'stock_control'))) as columns_left,
       (select count(*) from pg_indexes x where x.schemaname = 'public' and x.indexname = 'stock_count_lines_one_per_area') as index_left,
       case when to_regclass('cron.job') is null then 0
            else (select count(*) from cron.job c where c.jobname in ('stock-save-queue', 'stock-nightly')) end as cron_jobs_left,
       case when to_regclass('vault.secrets') is null then false
            else exists (select 1 from vault.secrets s where s.name = 'stock_nightly_cron_key') end as nightly_key_left,
       jsonb_build_object(
         'stock_counts_approver_columns',
           (select count(*) from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = 'stock_counts'
               and c.column_name in ('approved_by_staff_id', 'approved_by_staff_name')) = 2,
         'archived_at_kept_on', coalesce((select jsonb_agg(c.table_name order by c.table_name) from information_schema.columns c
                                           where c.table_schema = 'public' and c.column_name = 'archived_at'
                                             and c.table_name in ('supplier_products', 'item_packaging_formats', 'inventory_item_conversions')), '[]'::jsonb),
         'revalue_rows', (select count(*) from public.stock_movements m where m.location_id = l.id and m.movement_type = 'REVALUE'),
         'check_values_kept', 'REVALUE in stock_movements_movement_type_check, COMPANY in item_cost_history_source_chk',
         'fk_indexes_kept', true) as kept
  from public.locations l
 where l.id in (select distinct s.location_id from _stock_native_rb_snap s)
 order by l.org_id, l.name;
