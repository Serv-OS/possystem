-- 20261022a_OPS_stock_native_0b.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql live AND the Drop 0 web release  #
-- #  live through ONE FULL SERVICE first (old Back Office tabs reload after   #
-- #  2 h and 12 h; an old tab that still writes a company field directly is   #
-- #  refused from now on). One transaction: any error and nothing changes.    #
-- #  Run after UK close. Lock wait 3 s (it gives up, nothing changes).        #
-- ############################################################################
--
-- WHY (multi site stock map, 7.5): from 0a every stock item, supplier, supplier pack, pack, unit
-- bridge and recipe has a company record, and the Back Office saves them through the save functions
-- (stock_save_item and the rest), which write the company record and every site row together. This
-- file stops anything else changing those fields behind the save functions' back, so a company
-- record and its site rows can never drift apart, and it closes the ledger columns to direct writes.
--
-- WHAT CHANGES
--   1. Company field lock (stock_co_lock_ins, stock_co_lock_upd, stock_co_lock_del, function
--      stock_co__site_lock, INVOKER): on inventory_items, suppliers, supplier_products,
--      item_packaging_formats, inventory_item_conversions and recipes, a signed in session (any
--      PostgREST call) can no longer change a company field of a row with a company record, add a
--      row that already carries a company record, or delete a row with a company record (archive
--      instead). On recipe_lines and menu_item_recipes: no insert, change or delete for a recipe
--      with a company record. The fields are listed in each trigger's WHEN below; a sale's on hand
--      update never fires these triggers. Refusal words: "Set by head office. Change it in
--      Inventory > Stock items." (42501). Passes: the save functions (writer pass for this
--      transaction, run as the owner), the SQL editor and pg_cron (no request claims).
--   2. Site price lock, multi site companies only (stock_co_lock_site_price, function
--      stock_co__site_price_lock, INVOKER): supplier_products.is_preferred,
--      inventory_items.default_supplier_id and kind, suppliers.min_order_value, delivery_fee,
--      delivery_days and cutoff_time, for rows whose company has had 2 or more open sites
--      (stock_co_settings.multi_since set). One site companies are not touched.
--   3. Ledger lock (stock_co_lock_ledger, function stock_co__ledger_lock, INVOKER): a direct
--      PostgREST change of inventory_items.on_hand or current_cost is refused. Every stock function
--      (sales, deliveries, counts, waste, transfers, batches, the drainer) runs as its owner and is
--      not touched.
--   4. Count approval needs the manager PIN: approve_stock_count is no longer open to signed in
--      sessions (service_role keeps it). Back Office approves through stock_approve_count_pin (0a).
--   5. A dry run proves 1 and 3 inside a rolled back block, as a real manager login at a venue that
--      holds stock (request claims set, role authenticated): renaming an item with a company record
--      and adding 1 to its on hand must both be refused. If either change goes through, this file
--      raises and nothing changes.
--
-- Rollback: 20261022a_OPS_stock_native_0b_ROLLBACK.sql.

do $guard$
declare
  t text;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_co__writer_ok()') is null
     or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_co_suppliers') is null
     or to_regclass('public.stock_co_supplier_items') is null
     or to_regclass('public.stock_co_settings') is null
     or to_regclass('public.stock_change_log') is null
     or to_regprocedure('public.stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql first (its company tables and functions are missing). Nothing was changed.';
  end if;
  foreach t in array array['inventory_items', 'suppliers', 'supplier_products', 'item_packaging_formats',
                           'inventory_item_conversions', 'recipes'] loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = t and c.column_name = 'company_ref') then
      raise exception '%.company_ref is missing, so 0a is not in place. Nothing was changed.', t;
    end if;
  end loop;
  if exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_co_lock_upd') then
    raise exception '0b has run already (the stock_co_lock_upd trigger exists). Nothing was changed.';
  end if;
  if to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)') is null then
    raise exception 'approve_stock_count(uuid, text, text, jsonb, boolean) is missing. Nothing was changed. Ask Claude.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------- 1. the company field lock
-- INVOKER on purpose: current_user is the caller here. stock_co__writer_ok() (0a) answers true for
-- the save functions' own writes (writer pass set to this transaction id, running as postgres) and
-- for sessions with no request claims (SQL editor, pg_cron). Recipe lines and till links have no
-- company_ref of their own: they are free only when every recipe the row names is a site recipe
-- with no company record that this login can see.
create or replace function public.stock_co__site_lock()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $fn$
declare
  v_old_recipe uuid;
  v_new_recipe uuid;
begin
  if public.stock_co__writer_ok() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name in ('recipe_lines', 'menu_item_recipes') then
    if tg_op in ('UPDATE', 'DELETE') then
      v_old_recipe := old.recipe_id;
    end if;
    if tg_op in ('UPDATE', 'INSERT') then
      v_new_recipe := new.recipe_id;
    end if;
    if (v_old_recipe is null or exists (select 1 from public.recipes r where r.id = v_old_recipe and r.company_ref is null))
       and (v_new_recipe is null or exists (select 1 from public.recipes r where r.id = v_new_recipe and r.company_ref is null)) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
  end if;
  raise exception 'Set by head office. Change it in Inventory > Stock items.'
    using errcode = '42501',
          detail = format('A direct %s on %s of a row with a company record.', lower(tg_op), tg_table_name),
          hint = 'Save it on the Back Office stock screens.';
end
$fn$;

-- inventory_items: company fields only. Not on_hand, current_cost, updated_at, cost_method, kind,
-- is_tracked, is_sellable, storage_location, default_supplier_id, notes.
create or replace trigger stock_co_lock_upd before update on public.inventory_items for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.name, old.category, old.accounting_group, old.base_unit, old.allergens, old.sku,
         old.barcode, old.shelf_life_days, old.returns_to_shelf, old.purchase_tax_rate_id, old.archived_at)
        is distinct from
        (new.company_ref, new.location_id, new.name, new.category, new.accounting_group, new.base_unit, new.allergens, new.sku,
         new.barcode, new.shelf_life_days, new.returns_to_shelf, new.purchase_tax_rate_id, new.archived_at))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.inventory_items for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.inventory_items for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- suppliers: company fields only. Not account_number, email, cc_emails, min_order_value,
-- delivery_fee, delivery_days, cutoff_time, notes (site values).
create or replace trigger stock_co_lock_upd before update on public.suppliers for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.name, old.contact_name, old.phone, old.payment_terms_days, old.archived_at,
         old.approval_limit)
        is distinct from
        (new.company_ref, new.location_id, new.name, new.contact_name, new.phone, new.payment_terms_days, new.archived_at,
         new.approval_limit))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.suppliers for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.suppliers for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- supplier_products: company fields only. Not is_preferred (the site's main pack, lock 2).
create or replace trigger stock_co_lock_upd before update on public.supplier_products for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.inventory_item_id, old.supplier_id, old.supplier_sku, old.pack_description,
         old.pack_qty, old.inner_qty, old.inner_unit, old.pack_price, old.purchase_tax_rate_id, old.price_includes_tax,
         old.archived_at)
        is distinct from
        (new.company_ref, new.location_id, new.inventory_item_id, new.supplier_id, new.supplier_sku, new.pack_description,
         new.pack_qty, new.inner_qty, new.inner_unit, new.pack_price, new.purchase_tax_rate_id, new.price_includes_tax,
         new.archived_at))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.supplier_products for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.supplier_products for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- item_packaging_formats (packs)
create or replace trigger stock_co_lock_upd before update on public.item_packaging_formats for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.inventory_item_id, old.name, old.qty_in_base, old.parent_format_id,
         old.is_count_default, old.is_purchase_default, old.archived_at)
        is distinct from
        (new.company_ref, new.location_id, new.inventory_item_id, new.name, new.qty_in_base, new.parent_format_id,
         new.is_count_default, new.is_purchase_default, new.archived_at))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.item_packaging_formats for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.item_packaging_formats for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- inventory_item_conversions (unit bridges)
create or replace trigger stock_co_lock_upd before update on public.inventory_item_conversions for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.inventory_item_id, old.from_qty, old.from_unit, old.to_qty, old.to_unit,
         old.archived_at)
        is distinct from
        (new.company_ref, new.location_id, new.inventory_item_id, new.from_qty, new.from_unit, new.to_qty, new.to_unit,
         new.archived_at))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.inventory_item_conversions for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.inventory_item_conversions for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- recipes
create or replace trigger stock_co_lock_upd before update on public.recipes for each row
  when ((old.company_ref is not null or new.company_ref is not null) and
        (old.company_ref, old.location_id, old.name, old.recipe_type, old.output_item_id, old.yield_qty, old.yield_unit,
         old.wastage_pct, old.gp_target_pct, old.method, old.photo, old.archived_at)
        is distinct from
        (new.company_ref, new.location_id, new.name, new.recipe_type, new.output_item_id, new.yield_qty, new.yield_unit,
         new.wastage_pct, new.gp_target_pct, new.method, new.photo, new.archived_at))
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_ins before insert on public.recipes for each row
  when (new.company_ref is not null) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.recipes for each row
  when (old.company_ref is not null) execute function public.stock_co__site_lock();

-- recipe_lines and menu_item_recipes: any insert, change or delete for a recipe with a company
-- record (the function looks the recipe up). An update that changes nothing does not fire.
create or replace trigger stock_co_lock_ins before insert on public.recipe_lines for each row
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_upd before update on public.recipe_lines for each row
  when (old.* is distinct from new.*) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.recipe_lines for each row
  execute function public.stock_co__site_lock();

create or replace trigger stock_co_lock_ins before insert on public.menu_item_recipes for each row
  execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_upd before update on public.menu_item_recipes for each row
  when (old.* is distinct from new.*) execute function public.stock_co__site_lock();
create or replace trigger stock_co_lock_del before delete on public.menu_item_recipes for each row
  execute function public.stock_co__site_lock();

-- ---------------------------------------------------------------- 2. the site price lock (multi site companies only)
-- Fires only when one of its columns is in the update's SET list (BEFORE UPDATE OF), so a sale never
-- fires it; the function then compares old and new and looks up the company of the row. A row it
-- cannot place in a company the login reaches is refused too (fails closed).
create or replace function public.stock_co__site_price_lock()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $fn$
declare
  v_changed boolean;
  v_ref uuid := coalesce(new.company_ref, old.company_ref);
  v_org uuid;
begin
  if public.stock_co__writer_ok() then
    return new;
  end if;
  if tg_table_name = 'inventory_items' then
    v_changed := (old.default_supplier_id, old.kind) is distinct from (new.default_supplier_id, new.kind);
  elsif tg_table_name = 'suppliers' then
    v_changed := (old.min_order_value, old.delivery_fee, old.delivery_days, old.cutoff_time)
                 is distinct from (new.min_order_value, new.delivery_fee, new.delivery_days, new.cutoff_time);
  else
    v_changed := old.is_preferred is distinct from new.is_preferred;
  end if;
  if not v_changed then
    return new;
  end if;
  if tg_table_name = 'inventory_items' then
    select c.org_id into v_org from public.stock_co_items c where c.id = v_ref;
  elsif tg_table_name = 'suppliers' then
    select c.org_id into v_org from public.stock_co_suppliers c where c.id = v_ref;
  else
    select c.org_id into v_org from public.stock_co_supplier_items c where c.id = v_ref;
  end if;
  if v_org is not null
     and not exists (select 1 from public.stock_co_settings s where s.org_id = v_org and s.multi_since is not null) then
    return new;
  end if;
  raise exception '%', case when tg_table_name = 'suppliers'
                            then 'Set by head office for each site. Change it in Purchasing > Suppliers.'
                            else 'Set by head office for each site. Change it in Inventory > Stock items.' end
    using errcode = '42501',
          detail = format('A direct update on %s of a site value in a multi site company.', tg_table_name),
          hint = 'Save it on the Back Office stock screens.';
end
$fn$;

create or replace trigger stock_co_lock_site_price before update of default_supplier_id, kind on public.inventory_items for each row
  when (old.company_ref is not null or new.company_ref is not null)
  execute function public.stock_co__site_price_lock();
create or replace trigger stock_co_lock_site_price before update of min_order_value, delivery_fee, delivery_days, cutoff_time on public.suppliers for each row
  when (old.company_ref is not null or new.company_ref is not null)
  execute function public.stock_co__site_price_lock();
create or replace trigger stock_co_lock_site_price before update of is_preferred on public.supplier_products for each row
  when (old.company_ref is not null or new.company_ref is not null)
  execute function public.stock_co__site_price_lock();

-- ---------------------------------------------------------------- 3. the ledger lock
-- current_user is 'authenticated' or 'anon' only for a direct PostgREST update; inside every stock
-- function (definer) it is the owner, so sales, deliveries, counts, waste, transfers, batches and the
-- drainer never reach the function. An update that leaves both columns as they were passes.
create or replace function public.stock_co__ledger_lock()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $fn$
begin
  if current_user::text not in ('authenticated', 'anon') then
    return new;
  end if;
  if old.on_hand is not distinct from new.on_hand and old.current_cost is not distinct from new.current_cost then
    return new;
  end if;
  raise exception 'On hand and cost change only through deliveries, counts, waste, transfers, batches and sales.'
    using errcode = '42501',
          detail = 'A direct update of inventory_items.on_hand or current_cost.',
          hint = 'Receive, count, waste or transfer it on the stock screens.';
end
$fn$;

create or replace trigger stock_co_lock_ledger before update of on_hand, current_cost on public.inventory_items for each row
  when (current_user in ('authenticated', 'anon'))
  execute function public.stock_co__ledger_lock();

-- ---------------------------------------------------------------- grants of the three lock functions
-- Revoked from public and anon by name; signed in sessions and the service role keep EXECUTE (the
-- triggers run as the caller).
revoke all on function public.stock_co__site_lock() from public, anon;
revoke all on function public.stock_co__site_price_lock() from public, anon;
revoke all on function public.stock_co__ledger_lock() from public, anon;
grant execute on function public.stock_co__site_lock() to authenticated, service_role;
grant execute on function public.stock_co__site_price_lock() to authenticated, service_role;
grant execute on function public.stock_co__ledger_lock() to authenticated, service_role;

-- ---------------------------------------------------------------- 4. count approval needs the manager PIN
revoke execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) to service_role;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- 5. the dry run (rolled back, as a real manager login)
create temp table _stock_native_0b_dry (
  check_name text primary key,
  refused boolean,
  sql_state text,
  words text,
  item_id uuid,
  login_id uuid
) on commit drop;

do $dry$
declare
  v_item uuid;
  v_login uuid;
  v_state text;
  v_words text;
  v_detail text;
  c record;
begin
  -- a live item with a company record at a venue where a manager login is linked
  select i.id, ul.user_id into v_item, v_login
    from public.inventory_items i
    join public.user_locations ul on ul.location_id = i.location_id
    left join public.user_profiles p on p.id = ul.user_id
   where i.company_ref is not null
     and i.archived_at is null
     and coalesce(p.role, '') <> 'super_admin'
   order by (ul.role = 'manager') desc nulls last, (p.role = 'manager') desc nulls last, i.location_id, i.id, ul.user_id
   limit 1;

  for c in
    select * from (values
      ('name', 'update public.inventory_items set name = name || '' x'' where id = $1',
       'Set by head office. Change it in Inventory > Stock items.'),
      ('on_hand', 'update public.inventory_items set on_hand = coalesce(on_hand, 0) + 1 where id = $1',
       'On hand and cost change only through deliveries, counts, waste, transfers, batches and sales.')
    ) v(check_name, stmt, words)
  loop
    if v_item is null then
      insert into _stock_native_0b_dry values
        (c.check_name, null, null, 'No live stock item with a company record at a venue with a linked manager login, so the dry run could not run.', null, null);
      continue;
    end if;
    v_state := null;
    v_words := null;
    v_detail := null;
    begin
      perform set_config('request.jwt.claims',
                         jsonb_build_object('role', 'authenticated', 'sub', v_login, 'aal', 'aal2',
                                            'is_anonymous', false, 'aud', 'authenticated')::text, true);
      set local role authenticated;
      execute c.stmt using v_item;
      get diagnostics v_detail = row_count;
      raise exception 'stock_native_0b dry run reached its end' using errcode = 'P0001', detail = v_detail;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_words = message_text, v_detail = pg_exception_detail;
    end;
    if v_state = 'P0001' and v_words = 'stock_native_0b dry run reached its end' then
      if coalesce(v_detail, '0') <> '0' then
        raise exception 'The new lock did NOT refuse a direct % change by a signed in login (item %, login %), so nothing was changed. Ask Claude.',
          c.check_name, v_item, v_login;
      end if;
      insert into _stock_native_0b_dry values
        (c.check_name, null, null, 'The dry run login could not see the item (row level security), so the lock was not reached.', v_item, v_login);
    else
      insert into _stock_native_0b_dry values
        (c.check_name, v_state = '42501' and v_words = c.words, v_state, v_words, v_item, v_login);
    end if;
  end loop;
end
$dry$;

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   lock_triggers {"stock_co_lock_ins": 8, "stock_co_lock_upd": 8, "stock_co_lock_del": 8,
--                  "stock_co_lock_site_price": 3, "stock_co_lock_ledger": 1}
--   approve_open_to_logins false, dry_run_name_refused true, dry_run_on_hand_refused true,
--   save_rows_since_0a more than 0 once the Drop 0 web release has saved anything (a hint only).
--   A null in a dry_run column means the dry run could not run (dry_run_words says why): tell Claude.
select
  (select jsonb_object_agg(x.tgname, x.n) from (
     select g.tgname, count(*) as n
       from pg_trigger g
      where not g.tgisinternal
        and g.tgname in ('stock_co_lock_ins', 'stock_co_lock_upd', 'stock_co_lock_del', 'stock_co_lock_site_price', 'stock_co_lock_ledger')
      group by g.tgname) x) as lock_triggers,
  has_function_privilege('authenticated', 'public.approve_stock_count(uuid,text,text,jsonb,boolean)', 'execute') as approve_open_to_logins,
  (select d.refused from _stock_native_0b_dry d where d.check_name = 'name') as dry_run_name_refused,
  (select d.refused from _stock_native_0b_dry d where d.check_name = 'on_hand') as dry_run_on_hand_refused,
  (select count(*) from public.stock_change_log l where l.source in ('save', 'save_unversioned')) as save_rows_since_0a,
  (select d.login_id from _stock_native_0b_dry d where d.check_name = 'name') as dry_run_login,
  (select d.item_id from _stock_native_0b_dry d where d.check_name = 'name') as dry_run_item,
  (select jsonb_object_agg(d.check_name, d.words) from _stock_native_0b_dry d) as dry_run_words;
