-- 20261024a_OPS_stock_native_1_ROLLBACK.sql
-- Takes Drop 1 of multi site stock (20261024a_OPS_stock_native_1.sql) back out. The Stock control levels
-- switch off again (the 24 Drop 0 bodies come back, exactly as they were saved before Drop 1 ran).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. Lock wait 3 s.           #
-- #  Run the web release of Drop 0 first (the Drop 1 screens need Drop 1).    #
-- ############################################################################
--
-- WHAT IT DOES
--   1. Save jobs of the Drop 1 kinds still waiting or running are marked failed ('Drop 1 was rolled
--      back.'), so the Drop 0 runner never meets a kind it does not know.
--   2. The 24 bodies Drop 1 rebuilt are put back from stock_native_backup (names 'd1:...').
--   3. Every function, helper and trigger Drop 1 made is dropped by its exact name; the four columns it
--      added go (stock_co_items.category_id, stock_co_item_sites.paused_from and paused_until,
--      stock_co_site_groups.row_version), then its seven tables.
--   4. The 'd1:' backup rows are deleted.
--
-- KEPT, ON PURPOSE (Drop 0 reads them): every price here, tick, pause flag, run out and company price
--   Drop 1 saved; the free text category of every item (it always held the category's name); the
--   delivery days and cut off of every site supplier row (they were written from the order rules).
--   Dated prices that were still waiting will never apply (the check row counts them).
--
-- It writes no site row and no login: the last step compares every count, version and sum per venue with
-- the snapshot taken at the start, and stops (undoing everything) on any difference.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_order_rules') is null then
    raise exception 'Drop 1 is not there, so there is nothing to take back. Nothing was changed.';
  end if;
  if (select count(*) from public.stock_native_backup b
       where b.name in ('d1:stock_co__allowed', 'd1:stock_co__clean', 'd1:stock_co__guard', 'd1:stock_save_item', 'd1:stock_archive_item',
                        'd1:stock_save_item_site', 'd1:stock_save_pack', 'd1:stock_archive_pack', 'd1:stock_set_pack_default',
                        'd1:stock_save_bridge', 'd1:stock_archive_bridge', 'd1:stock_save_supplier', 'd1:stock_archive_supplier',
                        'd1:stock_save_supplier_site', 'd1:stock_save_supplier_item', 'd1:stock_save_supplier_item_site',
                        'd1:stock_archive_supplier_item', 'd1:stock_save_recipe', 'd1:stock_archive_recipe', 'd1:stock_link_menu_item',
                        'd1:stock_co__run_job', 'd1:stock_save_queue_run', 'd1:stock_nightly_upkeep', 'd1:stock_item_detail')) <> 24 then
    raise exception 'The 24 Drop 0 bodies are not all in stock_native_backup. Nothing was changed. Send this line to Claude.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------- the snapshot (no site row may change)
create temp table _stock_native1_rb_snap (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native1_rb_now (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native1_rb_count (
  k  text primary key,
  v  integer not null
) on commit drop;

do $snap$
begin
  perform 1
     from public.inventory_items i
    where i.location_id in (select l.id from public.locations l
                             where exists (select 1 from public.stock_co_item_sites s where s.location_id = l.id))
    order by i.id
      for no key update;
  insert into _stock_native1_rb_snap (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',  (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',         (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',        (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products', (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products', (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:recipes',           (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',        (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',      (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id))
   ) as m(metric, value)
   where exists (select 1 from public.stock_co_item_sites s where s.location_id = l.id)
      or exists (select 1 from public.stock_co_supplier_sites s where s.location_id = l.id);

  insert into _stock_native1_rb_count (k, v)
  values ('dated_prices_dropped', (select count(*) from public.stock_co_dated_prices d where d.status = 'waiting')),
         ('import_jobs_dropped', (select count(*) from public.stock_co_import_jobs j)),
         ('queue_rows_failed', (select count(*) from public.stock_save_queue q
                                 where q.status in ('waiting', 'running')
                                   and q.kind in ('set_sites', 'pause', 'change_prices', 'import_commit', 'copy_site', 'category_rename',
                                                  'resync_site')));
end
$snap$;

-- ---------------------------------------------------------------- 1. the save jobs Drop 0 does not know
update public.stock_save_queue
   set status = 'failed', last_error = 'Drop 1 was rolled back.', done_at = clock_timestamp()
 where status in ('waiting', 'running')
   and kind in ('set_sites', 'pause', 'change_prices', 'import_commit', 'copy_site', 'category_rename', 'resync_site');

-- ---------------------------------------------------------------- 2. the 24 Drop 0 bodies back (levels off)
do $replay$
declare
  r record;
begin
  for r in
    select b.name, b.body
      from public.stock_native_backup b
     where b.name in ('d1:stock_co__allowed', 'd1:stock_co__clean', 'd1:stock_co__guard', 'd1:stock_save_item', 'd1:stock_archive_item',
                      'd1:stock_save_item_site', 'd1:stock_save_pack', 'd1:stock_archive_pack', 'd1:stock_set_pack_default',
                      'd1:stock_save_bridge', 'd1:stock_archive_bridge', 'd1:stock_save_supplier', 'd1:stock_archive_supplier',
                      'd1:stock_save_supplier_site', 'd1:stock_save_supplier_item', 'd1:stock_save_supplier_item_site',
                      'd1:stock_archive_supplier_item', 'd1:stock_save_recipe', 'd1:stock_archive_recipe', 'd1:stock_link_menu_item',
                      'd1:stock_co__run_job', 'd1:stock_save_queue_run', 'd1:stock_nightly_upkeep', 'd1:stock_item_detail')
     order by b.name
  loop
    execute r.body;
  end loop;
end
$replay$;

-- ---------------------------------------------------------------- 3. what Drop 1 made, by exact name
drop function if exists public.stock_items_page(uuid, uuid[], text, jsonb, jsonb, integer);
drop function if exists public.stock_item_used_in(uuid, jsonb, integer);
drop function if exists public.stock_suppliers_page(uuid, uuid[], text, jsonb, jsonb, integer);
drop function if exists public.stock_supplier_detail(uuid);
drop function if exists public.stock_prices_page(uuid, uuid, text, jsonb, integer);
drop function if exists public.stock_needs_attention(uuid, uuid[]);
drop function if exists public.stock_paused_items(uuid);
drop function if exists public.stock_golive_plan(uuid);
drop function if exists public.stock_import_check(uuid, jsonb, integer);
drop function if exists public.stock_set_item_sites(uuid[], uuid[], jsonb, text);
drop function if exists public.stock_pause_items(uuid[], uuid[], date, date, boolean, text);
drop function if exists public.stock_change_prices(jsonb, boolean, text);
drop function if exists public.stock_cancel_dated_price(uuid, text);
drop function if exists public.stock_import_stage(uuid, jsonb, jsonb);
drop function if exists public.stock_import_commit(uuid, uuid[]);
drop function if exists public.stock_import_cancel(uuid);
drop function if exists public.stock_copy_site(uuid, uuid, text);
drop function if exists public.stock_save_order_rules(uuid, uuid, jsonb, integer, text);
drop function if exists public.stock_copy_order_rules(uuid, uuid, uuid[], text);
drop function if exists public.stock_save_category(jsonb, integer, text);
drop function if exists public.stock_archive_category(uuid, integer, boolean, text);
drop function if exists public.stock_save_settings(uuid, jsonb, integer);
drop function if exists public.stock_make_company_record(text, uuid, integer, text);
drop function if exists public.stock_save_golive_step(uuid, jsonb, integer);
drop function if exists public.stock_save_site_group(jsonb);
drop function if exists public.stock_delete_site_group(uuid);
drop function if exists public.stock_suggest_change(text, uuid, text);
drop function if exists public.stock_resync_site(uuid);
drop function if exists public.stock_nightly_health(uuid);

drop function if exists public.stock_co__d1_step(bigint);
drop function if exists public.stock_co__category_rename_step(uuid, jsonb, integer);
drop function if exists public.stock_co__copy_site_step(uuid, uuid, jsonb, integer);
drop function if exists public.stock_co__supplier_packs_step(uuid, uuid[], uuid, integer);
drop function if exists public.stock_co__supplier_rows_step(uuid, uuid[], uuid, integer);
drop function if exists public.stock_co__import_apply(uuid, integer);
drop function if exists public.stock_co__import_flush(uuid[], uuid[], text, text);
drop function if exists public.stock_co__import_check_row(uuid, text, jsonb);
drop function if exists public.stock_co__apply_dated_prices(integer);
drop function if exists public.stock_co__following(uuid[]);
drop function if exists public.stock_co__price_apply(uuid, jsonb);
drop function if exists public.stock_co__dated_put(uuid, uuid, uuid, numeric, date, uuid, uuid);
drop function if exists public.stock_co__price_plan(jsonb, jsonb, integer);
drop function if exists public.stock_co__day_begun(uuid, uuid[], date);
drop function if exists public.stock_co__pause_at(uuid[], uuid, boolean, date, date);
drop function if exists public.stock_co__set_sites_at(uuid[], uuid, text, text);
drop function if exists public.stock_co__d1_source();
drop function if exists public.stock_co__put_rules(uuid, uuid, uuid, uuid, jsonb, uuid);
drop function if exists public.stock_co__clean_rules(jsonb);
drop function if exists public.stock_co__org_site(uuid);
drop function if exists public.stock_co__items_of(uuid[]);
drop function if exists public.stock_co__filter_keys(jsonb, text[]);
drop function if exists public.stock_co__filter_bool(jsonb, text);
drop function if exists public.stock_co__filter_uuid(jsonb, text);
drop function if exists public.stock_co__read_scope(uuid, uuid[]);
drop function if exists public.stock_co__enqueue_job(uuid, uuid, text, jsonb, uuid[]);
drop function if exists public.stock_co__cant_order_off(uuid, uuid[]);
drop function if exists public.stock_co__category_for(uuid, text);
drop function if exists public.stock_co__si_unit_cost(uuid);
drop function if exists public.stock_co__unit_of_price(uuid, numeric);
drop function if exists public.stock_co__qty_in_base(uuid, numeric, text);
drop function if exists public.stock_co__paused_now(uuid, uuid, date);
drop function if exists public.stock_co__today(uuid);
drop function if exists public.stock_co__need_max(text, text);
drop function if exists public.stock_co__need_version(text, integer);
drop function if exists public.stock_co__need_of(text, uuid, uuid);
drop function if exists public.stock_co__seed_order_rules(uuid);
drop function if exists public.stock_co__derive_days(uuid);
drop function if exists public.stock_co__dow_of(jsonb);

drop trigger if exists stock_co_d1_org_guard on public.stock_order_rules;
drop trigger if exists stock_co_d1_org_guard on public.stock_co_dated_prices;
drop trigger if exists stock_co_d1_org_guard on public.stock_co_categories;
drop trigger if exists stock_co_d1_org_guard on public.stock_co_golive_steps;
drop trigger if exists stock_co_d1_org_guard on public.stock_co_site_health;
drop trigger if exists stock_co_d1_org_guard on public.stock_co_import_rows;
drop trigger if exists stock_co_items_category_guard on public.stock_co_items;
drop function if exists public.stock_co__d1_org_guard();

drop index if exists public.stock_co_items_category;
alter table public.stock_co_items drop column if exists category_id;
alter table public.stock_co_item_sites drop constraint if exists stock_co_item_sites_pause_days;
alter table public.stock_co_item_sites drop column if exists paused_from;
alter table public.stock_co_item_sites drop column if exists paused_until;
alter table public.stock_co_site_groups drop column if exists row_version;

drop table if exists public.stock_co_import_rows;
drop table if exists public.stock_co_import_jobs;
drop table if exists public.stock_co_dated_prices;
drop table if exists public.stock_order_rules;
drop table if exists public.stock_co_golive_steps;
drop table if exists public.stock_co_site_health;
drop table if exists public.stock_co_categories;

-- ---------------------------------------------------------------- 4. the backup rows of Drop 1
delete from public.stock_native_backup b
 where b.name in ('d1:stock_co__allowed', 'd1:stock_co__clean', 'd1:stock_co__guard', 'd1:stock_save_item', 'd1:stock_archive_item',
                  'd1:stock_save_item_site', 'd1:stock_save_pack', 'd1:stock_archive_pack', 'd1:stock_set_pack_default',
                  'd1:stock_save_bridge', 'd1:stock_archive_bridge', 'd1:stock_save_supplier', 'd1:stock_archive_supplier',
                  'd1:stock_save_supplier_site', 'd1:stock_save_supplier_item', 'd1:stock_save_supplier_item_site',
                  'd1:stock_archive_supplier_item', 'd1:stock_save_recipe', 'd1:stock_archive_recipe', 'd1:stock_link_menu_item',
                  'd1:stock_co__run_job', 'd1:stock_save_queue_run', 'd1:stock_nightly_upkeep', 'd1:stock_item_detail');

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------- the compare: no site row changed
do $compare$
declare
  v_bad text;
begin
  insert into _stock_native1_rb_now (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',  (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',         (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',        (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products', (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products', (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:recipes',           (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',        (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',      (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id))
   ) as m(metric, value)
   where l.id in (select s.location_id from _stock_native1_rb_snap s);
  select string_agg(b.metric || ' at ' || b.location_id::text, ', ') into v_bad
    from _stock_native1_rb_snap b
    left join _stock_native1_rb_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.value is distinct from b.value;
  if v_bad is not null then
    raise exception 'The rollback changed a site row (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare$;

-- VISIBLE CHECK (paste it back to Claude). Expected: bodies_restored 24, drop1_left 0, site_rows_changed 0.
select
  (select count(*)::integer
     from (values
       ('public.stock_co__allowed(text)', '1a61b7cf3384939cf5c602e547dd906e'),
       ('public.stock_co__clean(text,jsonb)', '0d6b3b3acb2648f2c554641327e7b897'),
       ('public.stock_co__guard(uuid,text,text,uuid[])', 'c224e1e46da49d27130c67751be35763'),
       ('public.stock_save_item(jsonb,jsonb,integer,text)', 'b97ba7787ce200ca960386fa9ea08a21'),
       ('public.stock_archive_item(uuid,integer,boolean,text)', '45f6b86f9cfe07fa956cd48673edb8a0'),
       ('public.stock_save_item_site(uuid,uuid,jsonb,integer,text)', '15a6251d811a4dc7b6d6ca6044003841'),
       ('public.stock_save_pack(jsonb,integer,text)', '39a2b6167347e083b98ef9893f37230e'),
       ('public.stock_archive_pack(uuid,integer,boolean,text)', '76e8ad8a870d692fd1de7864830a095a'),
       ('public.stock_set_pack_default(uuid,text,integer,text)', '247dfba7b4a240c89f9709f3c57006af'),
       ('public.stock_save_bridge(jsonb,integer,text)', 'e4d3e7233e00797b4d1e2b7871e75f88'),
       ('public.stock_archive_bridge(uuid,integer,boolean,text)', 'd447b7f0985b5ba7ce13ab5aa92f6862'),
       ('public.stock_save_supplier(jsonb,jsonb,integer,text)', '807f4a60bb08ff6f989eab8a2c344f50'),
       ('public.stock_archive_supplier(uuid,integer,boolean,text)', 'b73aaff7b2dcc8d96774757ec6b8a227'),
       ('public.stock_save_supplier_site(uuid,uuid,jsonb,integer,text)', '30aeea13c057aac577f8917d2a3cd8df'),
       ('public.stock_save_supplier_item(jsonb,integer,text)', '9489d7b6c52c7c01c330f0d5a124b9b2'),
       ('public.stock_save_supplier_item_site(uuid,uuid,jsonb,integer,text)', '6208c21ed8d450631238c8cfafedf9ea'),
       ('public.stock_archive_supplier_item(uuid,integer,boolean,text)', 'de5581c5e3fd99a1c155f836531bc3f0'),
       ('public.stock_save_recipe(jsonb,jsonb,integer,text)', '49574e0d8e9768cfb643296dabd71804'),
       ('public.stock_archive_recipe(uuid,integer,boolean,text)', 'f9e6e10b9363442894fdb897ebce5a41'),
       ('public.stock_link_menu_item(uuid,text,uuid,numeric,text)', 'c346686e8608256779bbf21e9dc9cdf4'),
       ('public.stock_co__run_job(bigint)', '79b49ec0f5087d6ff36460f2147d0c2f'),
       ('public.stock_save_queue_run(integer)', 'c51af18907f35ff136334ff7461f9ae5'),
       ('public.stock_nightly_upkeep()', '6f74ec2cf9499fb6412090b143149e8d'),
       ('public.stock_item_detail(uuid)', '237948f39a88613c62e381d1d843e28a')
     ) as e(sig, want)
     join pg_proc p on p.oid = to_regprocedure(e.sig)
    where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = e.want) as bodies_restored,
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('stock_items_page', 'stock_set_item_sites', 'stock_change_prices', 'stock_copy_site', 'stock_nightly_health',
                        'stock_co__d1_step', 'stock_co__need_of', 'stock_co__d1_org_guard'))
  + (select count(*)::integer from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relname in ('stock_order_rules', 'stock_co_dated_prices', 'stock_co_import_jobs', 'stock_co_import_rows', 'stock_co_categories',
                          'stock_co_golive_steps', 'stock_co_site_health')) as drop1_left,
  (select r.v from _stock_native1_rb_count r where r.k = 'dated_prices_dropped') as dated_prices_dropped,
  (select r.v from _stock_native1_rb_count r where r.k = 'import_jobs_dropped') as import_jobs_dropped,
  (select r.v from _stock_native1_rb_count r where r.k = 'queue_rows_failed') as queue_rows_failed,
  (select count(*)::integer from _stock_native1_rb_snap b
     join _stock_native1_rb_now a on a.location_id = b.location_id and a.metric = b.metric
    where a.value is distinct from b.value) as site_rows_changed;
