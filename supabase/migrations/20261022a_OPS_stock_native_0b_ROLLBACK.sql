-- 20261022a_OPS_stock_native_0b_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, outside UK service, ONLY if 0b has to be undone #
-- #  (or before the 0a rollback, which refuses while these locks are on).     #
-- #  One transaction: any error and nothing changes. Safe to run twice.       #
-- ############################################################################
--
-- WHAT IT DOES
--   * Takes the locks off: drops the triggers stock_co_lock_ins, stock_co_lock_upd and
--     stock_co_lock_del (inventory_items, suppliers, supplier_products, item_packaging_formats,
--     inventory_item_conversions, recipes, recipe_lines, menu_item_recipes), stock_co_lock_site_price
--     (inventory_items, suppliers, supplier_products) and stock_co_lock_ledger (inventory_items), and
--     their three functions, each by its exact name.
--   * Count approval is open to signed in Back Office sessions again (approve_stock_count granted
--     back to authenticated, as 0a left it).
--   * Nothing else: 0a stays in place, no row is changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop trigger if exists stock_co_lock_ins on public.inventory_items;
drop trigger if exists stock_co_lock_upd on public.inventory_items;
drop trigger if exists stock_co_lock_del on public.inventory_items;
drop trigger if exists stock_co_lock_site_price on public.inventory_items;
drop trigger if exists stock_co_lock_ledger on public.inventory_items;

drop trigger if exists stock_co_lock_ins on public.suppliers;
drop trigger if exists stock_co_lock_upd on public.suppliers;
drop trigger if exists stock_co_lock_del on public.suppliers;
drop trigger if exists stock_co_lock_site_price on public.suppliers;

drop trigger if exists stock_co_lock_ins on public.supplier_products;
drop trigger if exists stock_co_lock_upd on public.supplier_products;
drop trigger if exists stock_co_lock_del on public.supplier_products;
drop trigger if exists stock_co_lock_site_price on public.supplier_products;

drop trigger if exists stock_co_lock_ins on public.item_packaging_formats;
drop trigger if exists stock_co_lock_upd on public.item_packaging_formats;
drop trigger if exists stock_co_lock_del on public.item_packaging_formats;

drop trigger if exists stock_co_lock_ins on public.inventory_item_conversions;
drop trigger if exists stock_co_lock_upd on public.inventory_item_conversions;
drop trigger if exists stock_co_lock_del on public.inventory_item_conversions;

drop trigger if exists stock_co_lock_ins on public.recipes;
drop trigger if exists stock_co_lock_upd on public.recipes;
drop trigger if exists stock_co_lock_del on public.recipes;

drop trigger if exists stock_co_lock_ins on public.recipe_lines;
drop trigger if exists stock_co_lock_upd on public.recipe_lines;
drop trigger if exists stock_co_lock_del on public.recipe_lines;

drop trigger if exists stock_co_lock_ins on public.menu_item_recipes;
drop trigger if exists stock_co_lock_upd on public.menu_item_recipes;
drop trigger if exists stock_co_lock_del on public.menu_item_recipes;

drop function if exists public.stock_co__site_lock();
drop function if exists public.stock_co__site_price_lock();
drop function if exists public.stock_co__ledger_lock();

do $grant$
begin
  if to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)') is not null then
    grant execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) to authenticated, service_role;
  end if;
end
$grant$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected: lock_triggers_left 0,
-- lock_functions_left 0, approve_open_to_logins true, company_tables_kept true (0a stays).
select
  (select count(*) from pg_trigger g
    where not g.tgisinternal
      and g.tgname in ('stock_co_lock_ins', 'stock_co_lock_upd', 'stock_co_lock_del', 'stock_co_lock_site_price', 'stock_co_lock_ledger')) as lock_triggers_left,
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock')) as lock_functions_left,
  coalesce((select has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p
             where p.oid = to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)')), false) as approve_open_to_logins,
  to_regclass('public.stock_co_items') is not null as company_tables_kept;
