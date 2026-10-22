-- 20261025a_OPS_stock_native_2_ROLLBACK.sql
-- Takes Drop 2 of multi site stock out again (20261025a_OPS_stock_native_2.sql).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand, only if Drop 2 must come out.                   #
-- #  One transaction: any error and nothing changes. Run after UK close.      #
-- ############################################################################
--
-- WHAT IT DOES
--   Waiting or running save jobs of the Drop 2 kinds (set_recipe_sites, msm_recipe, swap_ingredient,
--   facts_rebuild, make_sizes) are marked failed with 'Drop 2 was rolled back.'. The 15 bodies Drop 2
--   rebuilt are put back exactly as they were (the 'd2:' rows of stock_native_backup), so
--   hubrise_menu_fingerprint is its 20261020a text again. Every function and helper Drop 2 made is
--   dropped by its exact signature, then the company guard trigger of the new tables, the five new tables
--   (menu_item_stock_facts first: every channel then reads the typed allergens exactly as before Drop 2),
--   the msm_version_sites_finished index and the five columns. Then the 'd2:' rows go.
--
-- WHAT IT KEEPS (and says so)
--   The supplier item allergens the data step wrote (a union, never fewer), every recipe, site tick, till
--   link, option rule, how and the item roll ups: they are real data the screens of Drop 1 still show.
--   It writes no site row, no login and no menu row; the check row proves it.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.menu_item_stock_facts') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd2:') <> 15 then
    raise exception 'Drop 2 is not in this database (or its 15 saved bodies are missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

create temp table _stock_native2_snap (location_id uuid not null, metric text not null, value numeric, txt text,
                                       primary key (location_id, metric)) on commit drop;
create temp table _stock_native2_now (location_id uuid not null, metric text not null, value numeric, txt text,
                                      primary key (location_id, metric)) on commit drop;
create temp table _stock_native2_rb (metric text primary key, value numeric) on commit drop;

do $snap$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  insert into _stock_native2_snap (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',             (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',            (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',                   (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',                  (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products',           (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products',          (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:item_packaging_formats',      (select count(*) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('rv:item_packaging_formats',     (select sum(x.row_version) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('n:inventory_item_conversions',  (select count(*) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('rv:inventory_item_conversions', (select sum(x.row_version) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('n:recipes',                     (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('rv:recipes',                    (select sum(x.row_version) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:recipe_lines',                (select count(*) from public.recipe_lines x where x.location_id = l.id)::numeric),
     ('n:menu_item_recipes',           (select count(*) from public.menu_item_recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',                  (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:inventory_item_areas',        (select count(*) from public.inventory_item_areas x where x.location_id = l.id)::numeric),
     ('n:stock_movements',             (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',                     (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',                (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',                       (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',                      (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',                    (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:area_on_hand',                (select sum(x.on_hand) from public.inventory_item_area_stock x where x.location_id = l.id))
   ) as m(metric, value)
   where l.org_id = any (v_orgs);
  insert into _stock_native2_snap (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
end
$snap$;

insert into _stock_native2_rb (metric, value)
values ('facts_rows', (select count(*) from public.menu_item_stock_facts)),
       ('msm_jobs', (select count(*) from public.stock_msm_recipe_jobs));

with f as (
  update public.stock_save_queue q
     set status = 'failed', last_error = 'Drop 2 was rolled back.', done_at = clock_timestamp()
   where q.status in ('waiting', 'running')
     and q.kind in ('set_recipe_sites', 'msm_recipe', 'swap_ingredient', 'facts_rebuild', 'make_sizes')
  returning 1
)
insert into _stock_native2_rb (metric, value) select 'queue_rows_failed', count(*) from f;

-- the 15 bodies back, exactly as they were before Drop 2
do $replay$
declare
  b record;
  v_n integer := 0;
begin
  for b in
    select x.name, x.body from public.stock_native_backup x
     where x.name in ('d2:stock_co__allowed', 'd2:stock_co__clean', 'd2:stock_save_recipe', 'd2:stock_archive_recipe',
                      'd2:stock_link_menu_item', 'd2:stock_save_supplier_item', 'd2:stock_save_item', 'd2:stock_item_detail',
                      'd2:stock_make_company_record', 'd2:stock_co__run_job', 'd2:stock_save_queue_run', 'd2:stock_co__copy_site_step',
                      'd2:stock_co__import_check_row', 'd2:stock_co__import_apply', 'd2:hubrise_menu_fingerprint')
     order by x.name
  loop
    execute b.body;
    v_n := v_n + 1;
  end loop;
  if v_n <> 15 then
    raise exception 'Only % of the 15 bodies were found. Nothing was changed. Send this line to Claude.', v_n;
  end if;
end
$replay$;

-- the five new tables (their trigger stock_co_d2_org_guard goes with them), menu_item_stock_facts first
drop table if exists public.menu_item_stock_facts;
drop table if exists public.stock_msm_recipe_jobs;
drop table if exists public.stock_msm_recipe_cursor;
drop table if exists public.recipe_cost_daily;
drop table if exists public.stock_prep_ticks;
drop index if exists public.msm_version_sites_finished;

-- every function and helper Drop 2 made, by exact signature (the two trigger functions included)
drop function if exists public.stock_co__d2_org_guard();
drop function if exists public.stock_co__d2_cost_guard();
drop function if exists public.stock_co__allergen_ids(text[]);
drop function if exists public.stock_co__diet_ids();
drop function if exists public.stock_co__allergen_label(text);
drop function if exists public.stock_co__norm_name(text);
drop function if exists public.stock_co__recipe_sites_of(uuid);
drop function if exists public.stock_co__menu_price_net(uuid, text);
drop function if exists public.stock_co__unit_cost_js(uuid, uuid, uuid[]);
drop function if exists public.stock_co__recipe_cost_at(uuid, uuid, text);
drop function if exists public.stock_co__recipe_total(uuid, uuid, text);
drop function if exists public.stock_co__cost_rows(uuid[], uuid[], date);
drop function if exists public.stock_co__d2_enqueue(uuid, uuid, text, jsonb, uuid[]);
drop function if exists public.stock_co__facts_of_item(uuid, uuid);
drop function if exists public.stock_co__facts_walk(uuid, uuid, uuid[]);
drop function if exists public.stock_co__facts_of_recipe(uuid, uuid, uuid[]);
drop function if exists public.stock_co__facts_rebuild_site(uuid, text[]);
drop function if exists public.stock_co__facts_mark(uuid, text[], uuid, text);
drop function if exists public.stock_co__facts_rebuild_item(uuid);
drop function if exists public.stock_co__recipe_nested(uuid);
drop function if exists public.stock_co__recipe_components(uuid);
drop function if exists public.stock_co__recipe_lines_clean(uuid, uuid, jsonb);
drop function if exists public.stock_co__recipe_put(uuid, uuid, jsonb, jsonb, jsonb, text);
drop function if exists public.stock_co__recipe_on_at(uuid, uuid, text, text, text);
drop function if exists public.stock_co__recipe_off_at(uuid, uuid, text);
drop function if exists public.stock_co__resolve_modifier(uuid, uuid);
drop function if exists public.stock_co__option_rule_sites(uuid, jsonb);
drop function if exists public.stock_co__match_recipe(uuid, text);
drop function if exists public.stock_co__unit_fits(uuid, text, uuid);
drop function if exists public.stock_co__swap_plan(jsonb, jsonb, integer);
drop function if exists public.stock_co__swap_apply(uuid, jsonb, uuid[], jsonb);
drop function if exists public.stock_co__make_size(uuid, text, numeric, jsonb);
drop function if exists public.stock_co__d2_step(bigint);
drop function if exists public.stock_co__cost_row_of(uuid, uuid);
drop function if exists public.stock_recipes_page(uuid, uuid[], text, jsonb, jsonb, integer);
drop function if exists public.stock_recipe_detail(uuid);
drop function if exists public.stock_recipe_cost(uuid, uuid[], text);
drop function if exists public.stock_plate_costs(uuid, text, integer);
drop function if exists public.stock_recipe_missing(uuid, uuid[], jsonb, integer);
drop function if exists public.stock_recipe_facts(uuid, uuid[]);
drop function if exists public.stock_recipe_card(uuid, text, uuid);
drop function if exists public.stock_prep_list(uuid, date);
drop function if exists public.stock_batch_how(uuid, uuid[], text, jsonb, integer);
drop function if exists public.stock_recipe_menu_products(uuid, text, jsonb, integer);
drop function if exists public.stock_co__set_how(uuid, uuid, text, uuid);
drop function if exists public.stock_set_recipe_sites(uuid, jsonb, integer, text);
drop function if exists public.stock_recipe_link_products(jsonb, text);
drop function if exists public.stock_batch_set_how(uuid, uuid, text, integer, text);
drop function if exists public.stock_save_option_rule(jsonb, integer, text);
drop function if exists public.stock_archive_option_rule(uuid, integer, boolean, text);
drop function if exists public.stock_swap_ingredient(jsonb, boolean, text);
drop function if exists public.stock_make_sizes(uuid, jsonb, integer, text);
drop function if exists public.stock_prep_tick(uuid, uuid, numeric, text);
drop function if exists public.stock_prep_untick(uuid);
drop function if exists public.stock_facts_signoff(uuid, text, text);
drop function if exists public.stock_facts_rebuild(uuid, text[]);
drop function if exists public.stock_msm_recipe_scan();
drop function if exists public.stock_msm_recipe_run(integer);
drop function if exists public.stock_nightly_recipes(uuid);

alter table public.stock_co_recipes drop column if exists updated_by;
alter table public.stock_co_recipe_sites drop column if exists why_on;
alter table public.stock_co_recipe_sites drop column if exists linked_at;
alter table public.stock_co_supplier_items drop column if exists facts_checked_by_name;
alter table public.stock_co_items drop column if exists facts_source;

do $now$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  insert into _stock_native2_now (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',             (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',            (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',                   (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',                  (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products',           (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products',          (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:item_packaging_formats',      (select count(*) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('rv:item_packaging_formats',     (select sum(x.row_version) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('n:inventory_item_conversions',  (select count(*) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('rv:inventory_item_conversions', (select sum(x.row_version) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('n:recipes',                     (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('rv:recipes',                    (select sum(x.row_version) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:recipe_lines',                (select count(*) from public.recipe_lines x where x.location_id = l.id)::numeric),
     ('n:menu_item_recipes',           (select count(*) from public.menu_item_recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',                  (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:inventory_item_areas',        (select count(*) from public.inventory_item_areas x where x.location_id = l.id)::numeric),
     ('n:stock_movements',             (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',                     (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',                (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',                       (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',                      (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',                    (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:area_on_hand',                (select sum(x.on_hand) from public.inventory_item_area_stock x where x.location_id = l.id))
   ) as m(metric, value)
   where l.org_id = any (v_orgs);
  insert into _stock_native2_now (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
end
$now$;

do $compare$
declare
  v_diff text;
begin
  select string_agg(coalesce(a.location_id, b.location_id)::text || ' ' || coalesce(a.metric, b.metric), ', ' order by 1) into v_diff
    from _stock_native2_snap a
    full join _stock_native2_now b on b.location_id = a.location_id and b.metric = a.metric
   where a.metric is null or b.metric is null or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_diff is not null then
    raise exception 'A site row, a login or a menu row changed: %. Nothing was changed. Send this line to Claude.', left(v_diff, 600);
  end if;
end
$compare$;

insert into _stock_native2_rb (metric, value)
select 'bodies_restored', count(*)
  from (values
    ('public.stock_co__allowed(text)', '551ef9810f8f5d40112eb6995db3757d'),
    ('public.stock_co__clean(text,jsonb)', '503a049bb411a9f8be3c8c057bb51a3b'),
    ('public.stock_save_recipe(jsonb,jsonb,integer,text)', '6edac3d07dbef3bca9efbf9f9d1996bc'),
    ('public.stock_archive_recipe(uuid,integer,boolean,text)', 'aaa6f1df489ec3ba9f89d3bf47f1d7b6'),
    ('public.stock_link_menu_item(uuid,text,uuid,numeric,text)', '82912cf90532d46b9c777f9ab0b9679f'),
    ('public.stock_save_supplier_item(jsonb,integer,text)', '4216382a95e15945cd00ea12548c0131'),
    ('public.stock_save_item(jsonb,jsonb,integer,text)', '92f7cb59e261422d8540441b261f7756'),
    ('public.stock_item_detail(uuid)', '3c651bd7668b19e1f21fc2dcf343cbb8'),
    ('public.stock_make_company_record(text,uuid,integer,text)', '54a721d04be5b45edb5de0194b3e16b0'),
    ('public.stock_co__run_job(bigint)', 'c05acf44319f338f23ac992700053383'),
    ('public.stock_save_queue_run(integer)', '69963d8c329feb65136f4f010a1e09c8'),
    ('public.stock_co__copy_site_step(uuid,uuid,jsonb,integer)', 'e4fea542cb89a94868b5efc65843a917'),
    ('public.stock_co__import_check_row(uuid,text,jsonb)', '5dafb0125a57e802aa3caf96a825784a'),
    ('public.stock_co__import_apply(uuid,integer)', 'ef093dc6b21c7a1a9d8116638ca5804b'),
    ('public.hubrise_menu_fingerprint(text)', '8d6218c9a3bcd982d022857911325d08')
  ) as e(sig, want)
  join pg_proc p on p.oid = to_regprocedure(e.sig)
 where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = e.want;

do $restored$
begin
  if (select value from _stock_native2_rb where metric = 'bodies_restored') <> 15 then
    raise exception 'The 15 bodies are not all back as they were. Nothing was changed. Send this line to Claude.';
  end if;
end
$restored$;

delete from public.stock_native_backup b where left(b.name, 3) = 'd2:';

notify pgrst, 'reload schema';

select (select value from _stock_native2_rb where metric = 'bodies_restored')::integer as bodies_restored,
       (select value from _stock_native2_rb where metric = 'facts_rows')::integer as facts_rows_dropped,
       (select value from _stock_native2_rb where metric = 'msm_jobs')::integer as msm_jobs_dropped,
       (select value from _stock_native2_rb where metric = 'queue_rows_failed')::integer as queue_rows_failed,
       0 as site_rows_changed,
       false as menu_rows_changed;
