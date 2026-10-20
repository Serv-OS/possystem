-- 20261019c_OPS_stock_company_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Peter runs this by hand in the SQL editor, outside service.
-- Undoes 20261019c_OPS_stock_company.sql (multi site stock, Phase 1, v5.11.80).
--
-- WHAT IT DOES
--   * Stops the runner (pg_cron job msm-stock-run-due) and drops every msm_stock_* / msm_supplier*
--     table, function, trigger and the procedure this file's partner made, plus stock_company,
--     msm_stock_members and stock_pin_tries.
--   * Drops the site columns it added: company_ref on inventory_items, item_packaging_formats,
--     inventory_item_conversions, suppliers, supplier_products; archived_at on the three tables that
--     had none. A pack, unit bridge or supplier price that a publish switched OFF at a site comes back
--     as live there (its archived_at goes with the column). Every site row stays where it is: rows a
--     publish inserted are kept as that site's own rows; on hand, cost and the ledger are untouched.
--   * Drops the indexes it added for Undo (stock_movements_item_fk_idx and the others named below).
--     Costs a publish set by a site's own cost rule stay as they are (they are the site's costs).
--   * Count approval: approve_stock_count is open to Back Office logins again (as 20261019b left it).
--   * Central stock: every venue keeps its mode (central stays central). Nothing here touches
--     stock_depletion_mode.
--
-- Safe to run twice. Bare statements, no begin or commit: one transaction.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

do $cron$
declare
  j record;
begin
  if to_regclass('cron.job') is not null then
    for j in select jobid from cron.job where jobname = 'msm-stock-run-due' loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
end
$cron$;

-- triggers on the site tables and on locations
do $trg$
declare
  t text;
begin
  foreach t in array array['inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'suppliers', 'supplier_products'] loop
    execute format('drop trigger if exists msm_stock_lock_upd on public.%I', t);
    execute format('drop trigger if exists msm_stock_lock_ins on public.%I', t);
    execute format('drop trigger if exists msm_stock_lock_del on public.%I', t);
  end loop;
end
$trg$;
drop trigger if exists locations_stock_company_join on public.locations;

-- functions and the procedure (every overload of each name this file made)
do $fn$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure::text as sig, p.prokind
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'msm\_stock\_%' or p.proname in ('stock_admin_status', 'stock_admin_set_enabled', 'stock_admin_set_member',
            'stock_my_access', 'stock_approve_count_pin', '_stock_company_site_joins'))
       and p.proname <> 'msm_stock_recipe_gaps'
  loop
    if f.prokind = 'p' then
      execute format('drop procedure if exists %s cascade', f.sig);
    else
      execute format('drop function if exists %s cascade', f.sig);
    end if;
  end loop;
end
$fn$;

drop table if exists public.msm_stock_version_rows cascade;
drop table if exists public.msm_stock_version_company cascade;
drop table if exists public.msm_stock_version_sites cascade;
drop table if exists public.msm_stock_versions cascade;
drop table if exists public.msm_stock_changes cascade;
drop table if exists public.msm_stock_drafts cascade;
drop table if exists public.msm_stock_import_rows cascade;
drop table if exists public.msm_supplier_product_sites cascade;
drop table if exists public.msm_supplier_products cascade;
drop table if exists public.msm_supplier_sites cascade;
drop table if exists public.msm_suppliers cascade;
drop table if exists public.msm_stock_bridge_sites cascade;
drop table if exists public.msm_stock_bridges cascade;
drop table if exists public.msm_stock_pack_sites cascade;
drop table if exists public.msm_stock_packs cascade;
drop table if exists public.msm_stock_item_sites cascade;
drop table if exists public.msm_stock_items cascade;
drop table if exists public.msm_stock_members cascade;
drop table if exists public.stock_company cascade;
drop table if exists public.stock_pin_tries cascade;

-- the indexes this file added for Undo's deletes (round 1); the company_ref indexes go with their columns
drop index if exists public.stock_movements_item_fk_idx;
drop index if exists public.stock_count_lines_item_fk_idx;
drop index if exists public.par_levels_item_fk_idx;
drop index if exists public.po_lines_item_fk_idx;
drop index if exists public.po_lines_sp_fk_idx;
drop index if exists public.stock_transfer_lines_item_fk_idx;
drop index if exists public.stock_transfer_lines_to_item_fk_idx;
drop index if exists public.waste_events_item_fk_idx;
drop index if exists public.supplier_invoice_lines_item_fk_idx;
drop index if exists public.item_cost_history_sp_fk_idx;
drop index if exists public.item_pack_fmt_parent_idx;
drop index if exists public.purchase_orders_supplier_fk_idx;
drop index if exists public.supplier_invoices_supplier_fk_idx;
drop index if exists public.deliveries_supplier_fk_idx;
drop index if exists public.recipe_lines_loc_unit_idx;

-- the site columns (each only when there)
do $cols$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items', 'company_ref'), ('item_packaging_formats', 'company_ref'), ('item_packaging_formats', 'archived_at'),
      ('inventory_item_conversions', 'company_ref'), ('inventory_item_conversions', 'archived_at'), ('suppliers', 'company_ref'),
      ('supplier_products', 'company_ref'), ('supplier_products', 'archived_at')
    ) as t(tbl, col)
  loop
    if exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      execute format('alter table public.%I drop column %I', r.tbl, r.col);
    end if;
  end loop;
end
$cols$;

-- count approval as 20261019b left it
do $grant$
begin
  if to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)') is not null then
    grant execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) to authenticated, service_role;
  end if;
end
$grant$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: 0|0|0|0|0|1|<venues central, as before>
select
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (c.relname like 'msm\_stock\_%' or c.relname like 'msm\_supplier%' or c.relname in ('stock_company', 'stock_pin_tries'))) as tables_left,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'msm\_stock\_%' or p.proname in ('stock_admin_status', 'stock_admin_set_enabled', 'stock_admin_set_member',
          'stock_my_access', 'stock_approve_count_pin', '_stock_company_site_joins'))
     and p.proname <> 'msm_stock_recipe_gaps') as functions_left,
  (select count(*) from pg_trigger t where not t.tgisinternal and (t.tgname like 'msm\_stock\_lock\_%' or t.tgname = 'locations_stock_company_join')) as triggers_left,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'company_ref'
     and c.table_name in ('inventory_items', 'item_packaging_formats', 'inventory_item_conversions', 'suppliers', 'supplier_products')) as columns_left,
  (select count(*) from cron.job j where j.jobname = 'msm-stock-run-due') as cron_left,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)')
     and has_function_privilege('authenticated', p.oid, 'execute')) as approve_open_again,
  (select count(*) from public.stock_depletion_mode where mode in ('central', 'paused')) as venues_central;
