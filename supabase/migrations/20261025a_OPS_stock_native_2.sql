-- 20261025a_OPS_stock_native_2.sql
-- Multi site stock, Drop 2: recipes, batch and prep, allergens and calories to every channel (map 8.3).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql, its revalue file,              #
-- #  20261022a_OPS_stock_native_0b.sql, 20261024a_OPS_stock_native_1.sql     #
-- #  AND 20261023a_OPS_stock_drainer_v2.sql live first (the guard refuses     #
-- #  otherwise). One transaction: any error and nothing changes.              #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- WHAT IT IS
--   The recipe screens of Drop 2 read and save through the functions made here: the recipe list
--   (stock_recipes_page), one recipe with its lines, sites, option rules and facts (stock_recipe_detail),
--   the cost of a recipe at any site (stock_recipe_cost, the SQL twin of costing.js computeRecipe),
--   Recipe missing (till products that sold with no recipe), tick a recipe on and off per site with
--   every ingredient ticked there (stock_set_recipe_sites), link till products, how each site gets a
--   batch (bought in, made here, made to order), option rules (oat milk replaces whole milk), swap an
--   ingredient, make sizes, the prep list with Done ticks, recipe cards for staff and devices, and the
--   allergens, may contain, diets, ingredient declaration and calories of every till product at every
--   site (menu_item_stock_facts), rolled up from the supplier items each site buys. Every channel
--   reads that table beside the typed allergens, so a product never shows fewer allergens than before.
--   The Multi site menu queue (stock_msm_recipe_scan and stock_msm_recipe_run, inside the save queue
--   runner) ticks a company recipe on at a site when the Multi site menu adds its product there.
--
-- WHAT IT NEVER DOES
--   It writes no site row (stock items, suppliers, supplier packs, packs, unit bridges, recipes, lines,
--   till links, pars, areas, the ledger), no login (user_profiles, user_locations) and no menu row
--   (menu_items, any msm_ table: one additive index on msm_version_sites is the only menu change).
--   Nothing here moves an on hand, a cost, a ledger or a count number. Allergens are never removed by
--   this file or by anything it makes: the shown set is a union, a removed one only sets a warning until
--   someone checks. Before the check row it compares every count, version and sum of the site rows per
--   venue, and the md5 of every login and menu row, with the snapshot it took under the item row locks
--   at the start, and stops (undoing everything) on any difference.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once (one paste is one transaction; no begin
--   or commit in here). The first statement is the guard. Then:
--     set local lock_timeout = '3s';  set local statement_timeout = '300s';
--   It checks that the 40 stock bodies it rebuilds or leans on are still the text it was written
--   against (else: 'A stock function changed since this file was written. Ask Claude for a new file.'),
--   saves the 15 it rebuilds in stock_native_backup (names 'd2:...') for the rollback, takes the item
--   row locks and the snapshot, builds, moves the item allergens onto the supplier items as a union,
--   builds the first facts rows, seeds the Multi site menu cursor, compares, and shows the check row
--   last. Paste it back.
--
-- IF IT STOPS
--   Any error means nothing changed. A lock wait or 'deadlock detected': run it again a quiet minute
--   later. Any other words: send them to Claude.
--
-- ROLLBACK
--   20261025a_OPS_stock_native_2_ROLLBACK.sql (puts the 15 Drop 1 bodies back; the facts table goes and
--   every channel reads the typed allergens exactly as before Drop 2).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_co_recipes') is null or to_regclass('public.stock_save_queue') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql and its revalue file first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_co_lock_upd') then
    raise exception 'Run 20261022a_OPS_stock_native_0b.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_order_rules') is null
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'stock_co_items' and c.column_name = 'category_id')
     or (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd1:') <> 24 then
    raise exception 'Run 20261024a_OPS_stock_native_1.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_co_option_rules') is null
     or to_regclass('public.stock_co_option_rule_sites') is null
     or to_regprocedure('public.stock_explode_lines(uuid,jsonb,text,text)') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') <> 7 then
    raise exception 'Run 20261023a_OPS_stock_drainer_v2.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.menu_item_stock_facts') is not null or to_regclass('public.stock_msm_recipe_jobs') is not null then
    raise exception 'Drop 2 has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE BODIES THIS FILE REBUILDS OR LEANS ON, STILL AS BUILT
-- ============================================================================
-- The house rule: md5 of the function source with every run of white space made one space. Read live
-- 21 Oct 2026 for the Drop 1 and 0a bodies (the 20261024a file on main is the live text); the six
-- drainer bodies computed from the drainer file text (20261023a at ab6552a6) with the same rule. The
-- first 15 are rebuilt below from that text, changing only what contract section 1.5 lists; the other
-- 25 are checked only.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
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
      ('public.hubrise_menu_fingerprint(text)', '8d6218c9a3bcd982d022857911325d08'),
      ('public.stock_co__guard(uuid,text,text,uuid[])', '03e4984a451353649de11b73acdd4e11'),
      ('public.stock_co__need_of(text,uuid,uuid)', 'a7cb781c5c5931f347d05252a6327ff1'),
      ('public.stock_co__d1_step(bigint)', 'f199e0018f911cb3941139bf30959762'),
      ('public.stock_co__sync_recipes(uuid,uuid[],boolean,boolean)', '77d43d74e1791813cffdf82254f650ad'),
      ('public.stock_co__sync_site(uuid,uuid[],uuid[],boolean,boolean)', '68980e8bc9d49446950d5389d924d6e8'),
      ('public.stock_co__plan_recipes(uuid,uuid[])', 'c5d4dabdbc022eba3bc29f6fac2c3f35'),
      ('public.stock_co__plan_lines(uuid,uuid)', '35a4eb7806b0214cedd4364822676f3c'),
      ('public.stock_co__new_site_recipe(uuid,uuid)', 'fcc7d12e0c4e8fe1057e54417c619390'),
      ('public.stock_co__made_cost(uuid,uuid,uuid[])', '4e2b32920c54bc904a87342413034afb'),
      ('public.stock_co__recost(uuid,uuid[],boolean)', 'd162532c34b8b1c1d701c9dbef2f4af2'),
      ('public.stock_recost_made_items(uuid,uuid[],text)', 'ceca5292974b81336d88ed5fa32efd6d'),
      ('public.stock_co__run_sites(uuid,uuid,uuid[],uuid[],uuid[],uuid[],bigint,timestamptz)', '7eeb435c8c677730049190e85456fd4a'),
      ('public.stock_co__set_sites_at(uuid[],uuid,text,text)', '913a3c42943b8fcbfad1106003fcfa5f'),
      ('public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'),
      ('public.stock_co__today(uuid)', 'ebf8561b02839372d44f0b42def127e2'),
      ('public.stock_co__org_guard()', '000c0e067df8ab8197dee16872fa79b4'),
      ('public.stock_co__d1_org_guard()', 'f259202b0e85a4a1f13f210949ffbca3'),
      ('public.stock_nightly_upkeep()', 'a5a6840362abc7d648281f0e47a89da5'),
      ('public.stock_items_page(uuid,uuid[],text,jsonb,jsonb,integer)', 'fa7a53906c9ad73500eb369d0edf601f'),
      ('public.stock_explode_lines(uuid,jsonb,text,text)', '0c60388fa92f2b14ae4c16c4f1ecf357'),
      ('public._stock_explode_made(uuid,uuid,numeric,text,uuid[])', 'a3f0d94ee7595d774e07d70c466ae242'),
      ('public.stock_explode(uuid,jsonb,text,text)', 'dcd6342c924d7213b5e53ea84c1aa09f'),
      ('public.stock_explode_skipped(uuid,jsonb,text)', '66d98dd337b94dd1d163e2ddcf61ebfc'),
      ('public.stock_qty_to_base(numeric,text,uuid)', '2d730b51be380bf6ed82a0d86a612643'),
      ('public.stock_co__option_org_guard()', '46b35552fbc89c416898279545bf4633')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- The 15 bodies this file rebuilds, as they are tonight (pg_get_functiondef text, replayable), in the
-- existing owner only stock_native_backup, named 'd2:<name>'. The Drop 2 rollback replays exactly these.
insert into public.stock_native_backup (name, body, md5, saved_at)
select 'd2:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))), now()
  from (values
    ('public.stock_co__allowed(text)'), ('public.stock_co__clean(text,jsonb)'), ('public.stock_save_recipe(jsonb,jsonb,integer,text)'),
    ('public.stock_archive_recipe(uuid,integer,boolean,text)'), ('public.stock_link_menu_item(uuid,text,uuid,numeric,text)'),
    ('public.stock_save_supplier_item(jsonb,integer,text)'), ('public.stock_save_item(jsonb,jsonb,integer,text)'),
    ('public.stock_item_detail(uuid)'), ('public.stock_make_company_record(text,uuid,integer,text)'),
    ('public.stock_co__run_job(bigint)'), ('public.stock_save_queue_run(integer)'),
    ('public.stock_co__copy_site_step(uuid,uuid,jsonb,integer)'), ('public.stock_co__import_check_row(uuid,text,jsonb)'),
    ('public.stock_co__import_apply(uuid,integer)'), ('public.hubrise_menu_fingerprint(text)')
  ) as e(sig)
  join pg_proc p on p.oid = to_regprocedure(e.sig);

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd2:') <> 15 then
    raise exception 'The 15 bodies were not all saved. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- STEP 1. THE SNAPSHOT (no site row, login or menu row may change)
-- ============================================================================
-- Every inventory_items row of the companies that hold stock is locked (for no key update, id order)
-- as Drop 1 did: the data step reads stock_co_supplier_items and the first facts build reads recipes,
-- and the writer must not run between. Then every count, version and sum per venue, and the md5 of
-- every user_profiles, user_locations and menu_items row (Drop 2 never writes a menu row).
create temp table _stock_native2_snap (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native2_now (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native2_seed (
  org_id  uuid not null,
  metric  text not null,
  value   numeric,
  primary key (org_id, metric)
) on commit drop;

do $snap$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  perform 1
     from public.inventory_items i
    where i.location_id in (select l.id from public.locations l where l.org_id = any (v_orgs))
    order by i.id
      for no key update;
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
  -- the figures the check row reports per company, read before anything changes
  insert into _stock_native2_seed (org_id, metric, value)
  select o.org_id, m.metric, m.value
    from (select distinct i.org_id from public.stock_co_items i) o
   cross join lateral (values
     ('items_with_allergens', (select count(*) from public.stock_co_items i
                                where i.org_id = o.org_id and jsonb_typeof(i.allergens) = 'array' and jsonb_array_length(i.allergens) > 0)::numeric),
     ('links_live', (select count(*) from public.menu_item_recipes m
                       join public.recipes r on r.id = m.recipe_id and r.archived_at is null and r.company_ref is not null
                       join public.locations l on l.id = m.location_id
                      where l.org_id = o.org_id)::numeric)
   ) as m(metric, value);
end
$snap$;

-- ============================================================================
-- STEP 2. TABLES AND COLUMNS (contract 1.2)
-- ============================================================================

-- The facts a till product carries at one site, from the recipe linked there (map 4.24). Never a cost,
-- never a method. allergens is the SHOWN set: the union of what was typed on the menu item at the last
-- rebuild and what the recipe says, never shrunk by a rebuild (a removed one sets needs_check until
-- someone checks).
create table public.menu_item_stock_facts (
  location_id       text not null,
  menu_item_id      text not null,
  recipe_id         uuid references public.stock_co_recipes(id) on delete set null,
  site_recipe_id    uuid,
  allergens         text[] not null default '{}',
  recipe_allergens  text[] not null default '{}',
  typed_allergens   text[] not null default '{}',
  may_contain       text[] not null default '{}',
  diets             text[] not null default '{}',
  ingredients_text  text,
  kcal              numeric,
  kcal_complete     boolean not null default false,
  portion_g         numeric,
  nutrition         jsonb,
  needs_check       boolean not null default false,
  check_words       text,
  facts_hash        text,
  checked_by        uuid,
  checked_by_name   text,
  checked_at        timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (location_id, menu_item_id)
);
create index menu_item_stock_facts_check on public.menu_item_stock_facts (location_id) where needs_check;
create index menu_item_stock_facts_recipe on public.menu_item_stock_facts (recipe_id);
comment on table public.menu_item_stock_facts is
  'Stock owned (20261025a). Written only by stock definer functions (stock_facts_rebuild, stock_facts_signoff). Never written by a menu save.';

-- The Multi site menu queue (map 4.26): one job per venue item a publish added at a site whose menu
-- product has a company recipe. A job never touches the menu.
create table public.stock_msm_recipe_jobs (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references public.organisations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  version_id      uuid not null,
  menu_item_id    text not null,
  msm_product_id  uuid,
  recipe_id       uuid references public.stock_co_recipes(id) on delete set null,
  status          text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'skipped', 'failed')),
  reason          text,
  attempts        integer not null default 0,
  due_at          timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  done_at         timestamptz,
  unique (version_id, location_id, menu_item_id)
);
create index stock_msm_recipe_jobs_due on public.stock_msm_recipe_jobs (due_at) where status = 'waiting';
create index stock_msm_recipe_jobs_loc on public.stock_msm_recipe_jobs (location_id, status);
comment on table public.stock_msm_recipe_jobs is
  'The Multi site menu recipe queue (20261025a): a company recipe ticked on at a site after a publish added its product there. Written only by stock_msm_recipe_scan and stock_msm_recipe_run.';

-- Where the scan got to (one row): nothing already published is replayed.
create table public.stock_msm_recipe_cursor (
  one          boolean primary key default true check (one),
  finished_at  timestamptz not null,
  version_id   uuid,
  location_id  text,
  scanned_at   timestamptz
);
comment on table public.stock_msm_recipe_cursor is 'The Multi site menu recipe scan cursor (20261025a): the newest msm_version_sites row read. One row.';

-- The daily recipe cost per site (design D19): what the recipe list and the GP columns read, written
-- by the nightly run and by every recipe save and site tick.
create table public.recipe_cost_daily (
  location_id     uuid not null references public.locations(id) on delete cascade,
  recipe_id       uuid not null references public.stock_co_recipes(id) on delete cascade,
  day             date not null,
  cost            numeric,
  cost_per_yield  numeric,
  yield_base      numeric,
  menu_item_id    text,
  sale_price      numeric,
  sale_price_net  numeric,
  gp_pct          numeric,
  missing         integer not null default 0,
  computed_at     timestamptz not null default now(),
  primary key (location_id, recipe_id, day)
);
create index recipe_cost_daily_recipe on public.recipe_cost_daily (recipe_id, location_id, day desc);
comment on table public.recipe_cost_daily is
  'The cost of a company recipe at one site on one venue business day (20261025a): a dish the plate cost (dine in), a batch or prep the batch cost. Written by stock_co__cost_rows only.';

-- A Done tick on the prep list (design 2.7): who made how much, on the venue business day. A tick is not
-- a stock number.
create table public.stock_prep_ticks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid not null references public.locations(id) on delete cascade,
  business_day    date not null,
  recipe_id       uuid not null references public.stock_co_recipes(id) on delete cascade,
  site_recipe_id  uuid,
  output_item_id  uuid,
  qty             numeric not null check (qty > 0),
  done_by         uuid,
  done_by_name    text,
  done_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index stock_prep_ticks_day on public.stock_prep_ticks (location_id, business_day, recipe_id);
comment on table public.stock_prep_ticks is 'Prep list Done ticks (20261025a): who made how much of a batch on a venue day. Not a stock number. Written by stock_prep_tick and stock_prep_untick only.';

-- The one menu table change (map 4.26): additive, no trigger, no ALTER, no function. The scan reads
-- finished publishes by finished_at; the live table has no such index.
create index if not exists msm_version_sites_finished on public.msm_version_sites (finished_at) where status in ('done', 'nothing');

-- Columns added (constant defaults only, each only when missing).
alter table public.stock_co_recipes add column if not exists updated_by uuid;
comment on column public.stock_co_recipes.updated_by is 'The login of the last company save (20261025a).';
alter table public.stock_co_recipe_sites add column if not exists why_on text;
comment on column public.stock_co_recipe_sites.why_on is 'Why this recipe is on at this site (20261025a): Added by <name>, Added by the Multi site menu, Linked under Recipe missing by <name>, Copied from <site>.';
alter table public.stock_co_recipe_sites add column if not exists linked_at timestamptz;
comment on column public.stock_co_recipe_sites.linked_at is 'When site_menu_item_id was last set (20261025a).';
alter table public.stock_co_supplier_items add column if not exists facts_checked_by_name text;
comment on column public.stock_co_supplier_items.facts_checked_by_name is 'The name beside facts_checked_by (20261025a).';
do $facts_source$
begin
  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'stock_co_items' and c.column_name = 'facts_source') then
    alter table public.stock_co_items add column facts_source text
      check (facts_source is null or facts_source in ('supplier_items', 'item'));
  end if;
end
$facts_source$;
comment on column public.stock_co_items.facts_source is 'item when the item''s own allergens are the facts source (no supplier item); null means the supplier items (20261025a).';

-- Row level security, grants and the second sign in step. Read rules (Drop 0 contract 1.2): R_LOC is
-- location_id in stock_reach_locations(). The facts table is read like menu_items (anon read, SELECT
-- only). The cursor is the service role's only. No write policy anywhere.
alter table public.menu_item_stock_facts enable row level security;
alter table public.stock_msm_recipe_jobs enable row level security;
alter table public.stock_msm_recipe_cursor enable row level security;
alter table public.recipe_cost_daily enable row level security;
alter table public.stock_prep_ticks enable row level security;
revoke all on table public.menu_item_stock_facts from public, anon, authenticated, service_role;
revoke all on table public.stock_msm_recipe_jobs from public, anon, authenticated, service_role;
revoke all on table public.stock_msm_recipe_cursor from public, anon, authenticated, service_role;
revoke all on table public.recipe_cost_daily from public, anon, authenticated, service_role;
revoke all on table public.stock_prep_ticks from public, anon, authenticated, service_role;
grant select on table public.menu_item_stock_facts to anon, authenticated, service_role;
grant select on table public.stock_msm_recipe_jobs to authenticated, service_role;
grant select on table public.stock_msm_recipe_cursor to service_role;
grant select on table public.recipe_cost_daily to authenticated, service_role;
grant select on table public.stock_prep_ticks to authenticated, service_role;
create policy menu_item_stock_facts_anon_read on public.menu_item_stock_facts as permissive for select to public
  using (true);
create policy stock_msm_recipe_jobs_read on public.stock_msm_recipe_jobs as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy recipe_cost_daily_read on public.recipe_cost_daily as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_prep_ticks_read on public.stock_prep_ticks as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
do $fence_d2$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.menu_item_stock_facts as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
    create policy second_step_fence on public.stock_msm_recipe_jobs as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
    create policy second_step_fence on public.stock_msm_recipe_cursor as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
    create policy second_step_fence on public.recipe_cost_daily as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
    create policy second_step_fence on public.stock_prep_ticks as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_d2$;

-- ============================================================================
-- STEP 3. THE COMPANY GUARD OF THE NEW TABLES (contract 1.4)
-- ============================================================================
-- A row's org_id is locations.org_id of its location_id; a cost row or a prep tick names a recipe of
-- the same company as the site. menu_item_stock_facts has no trigger (location_id is text, written
-- only by definer functions that already checked the site).
create or replace function public.stock_co__d2_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  select l.org_id into v_org from locations l where l.id = new.location_id;
  if v_org is null or new.org_id is distinct from v_org then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  if tg_table_name in ('recipe_cost_daily', 'stock_prep_ticks')
     and not exists (select 1 from stock_co_recipes r where r.id = new.recipe_id and r.org_id = v_org) then
    raise exception 'That recipe is not in this company.' using errcode = '22023';
  end if;
  return new;
end
$fn$;

-- recipe_cost_daily has no org_id column: the guard reads the site's company for the recipe check.
create or replace function public.stock_co__d2_cost_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  select l.org_id into v_org from locations l where l.id = new.location_id;
  if v_org is null then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  if not exists (select 1 from stock_co_recipes r where r.id = new.recipe_id and r.org_id = v_org) then
    raise exception 'That recipe is not in this company.' using errcode = '22023';
  end if;
  return new;
end
$fn$;

create trigger stock_co_d2_org_guard before insert or update on public.stock_msm_recipe_jobs
  for each row execute function public.stock_co__d2_org_guard();
create trigger stock_co_d2_org_guard before insert or update on public.recipe_cost_daily
  for each row execute function public.stock_co__d2_cost_guard();
create trigger stock_co_d2_org_guard before insert or update on public.stock_prep_ticks
  for each row execute function public.stock_co__d2_org_guard();

-- ============================================================================
-- STEP 4. HELPERS (owner only, the stock_co__ prefix): the pure twins and the cost rule
-- ============================================================================

-- The SQL twin of src/lib/kioskAllergens.js normaliseAllergenId over a list: lower, trim, runs of
-- space, underscore or hyphen to one space, the alias table word for word, distinct, the 14 UK
-- allergens in the order of UK_ALLERGENS first, then any other id alphabetically. Owner only.
create or replace function public.stock_co__allergen_ids(p_values text[])
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  with raw as (
    select btrim(regexp_replace(lower(v), '[[:space:]_-]+', ' ', 'g')) as s
      from unnest(coalesce(p_values, '{}'::text[])) v
     where v is not null
  ),
  al(k, v) as (values
    ('cereals containing gluten', 'gluten'), ('wheat', 'gluten'), ('dairy', 'milk'), ('lactose', 'milk'), ('egg', 'eggs'),
    ('soya', 'soy'), ('soybean', 'soy'), ('soybeans', 'soy'), ('shellfish', 'crustaceans'), ('crustacean', 'crustaceans'),
    ('tree nuts', 'nuts'), ('tree nut', 'nuts'), ('treenuts', 'nuts'), ('nut', 'nuts'), ('peanut', 'peanuts'),
    ('sesame seeds', 'sesame'), ('sulphur dioxide', 'sulphites'), ('sulfur dioxide', 'sulphites'), ('sulphite', 'sulphites'),
    ('sulfites', 'sulphites'), ('sulfite', 'sulphites'), ('mollusc', 'molluscs'), ('mollusk', 'molluscs'), ('mollusks', 'molluscs'),
    ('lupine', 'lupin')),
  uk(id, o) as (values
    ('gluten', 1), ('milk', 2), ('eggs', 3), ('fish', 4), ('crustaceans', 5), ('nuts', 6), ('peanuts', 7),
    ('soy', 8), ('sesame', 9), ('celery', 10), ('mustard', 11), ('sulphites', 12), ('molluscs', 13), ('lupin', 14)),
  ids as (
    select distinct coalesce(al.v, r.s) as id
      from raw r
      left join al on al.k = r.s
     where r.s <> ''
  )
  select coalesce(array_agg(i.id order by coalesce(uk.o, 99), i.id), '{}'::text[])
    from ids i
    left join uk on uk.id = i.id;
$fn$;

-- The diet ids ServOS knows: the Menu Manager DIET_TAGS ids plus the three free ids. Owner only.
create or replace function public.stock_co__diet_ids()
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select array['vegan', 'vegetarian', 'pescatarian', 'halal', 'kosher', 'gluten_free', 'dairy_free', 'nut_free']::text[];
$fn$;

-- The plain label of an allergen id (the src/data/seed.js ALLERGENS labels; Tree nuts for nuts). Owner only.
create or replace function public.stock_co__allergen_label(p_id text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case p_id
    when 'gluten' then 'Gluten' when 'crustaceans' then 'Crustaceans' when 'eggs' then 'Eggs' when 'fish' then 'Fish'
    when 'peanuts' then 'Peanuts' when 'soy' then 'Soy' when 'milk' then 'Milk' when 'nuts' then 'Tree nuts'
    when 'celery' then 'Celery' when 'mustard' then 'Mustard' when 'sesame' then 'Sesame' when 'sulphites' then 'Sulphites'
    when 'lupin' then 'Lupin' when 'molluscs' then 'Molluscs'
    else initcap(coalesce(p_id, '')) end;
$fn$;

-- The twin of supabase/functions/_shared/msmModel.js normName: lower, & to ' and ', every character
-- that is not a letter, digit or space to a space, runs of spaces to one, trim. Owner only.
create or replace function public.stock_co__norm_name(p_name text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select btrim(regexp_replace(regexp_replace(replace(lower(coalesce(p_name, '')), '&', ' and '), '[^[:alnum:][:space:]]', ' ', 'g'),
                              '[[:space:]]+', ' ', 'g'));
$fn$;

-- The sites a company recipe is on at. Owner only.
create or replace function public.stock_co__recipe_sites_of(p_recipe uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(s.location_id order by s.location_id), '{}'::uuid[])
    from stock_co_recipe_sites s
   where s.recipe_id = p_recipe and s.on_here;
$fn$;

-- The gross and net sale price of a till product at a site (src/lib/tax.js resolveTaxRate plus netOf,
-- order type dine in): gross = pricing.base; the rate is the item's tax_rate_id (or its parent's when
-- null) in this venue's rates, else the venue's default rate (as resolveTaxRate falls back), else the
-- first rate line of the item's or the venue's default tax profile with order type all, else 0; net =
-- gross / (1 + rate) when the rate is inclusive, else gross. Owner only.
create or replace function public.stock_co__menu_price_net(p_loc uuid, p_menu_item_id text)
returns table (gross numeric, net numeric, rate numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_m record;
  v_rate_id uuid;
  v_prof uuid;
  v_incl boolean := false;
  v_txt text;
begin
  select m.pricing, m.tax_rate_id, m.tax_profile_id, m.parent_id into v_m
    from menu_items m where m.id = p_menu_item_id and m.location_id = p_loc::text;
  if not found then
    return;
  end if;
  v_txt := btrim(coalesce(v_m.pricing ->> 'base', ''));
  gross := case when v_txt ~ '^-?[0-9]+(\.[0-9]+)?$' then v_txt::numeric end;
  v_rate_id := v_m.tax_rate_id;
  v_prof := v_m.tax_profile_id;
  if v_m.parent_id is not null and (v_rate_id is null or v_prof is null) then
    select coalesce(v_rate_id, p.tax_rate_id), coalesce(v_prof, p.tax_profile_id) into v_rate_id, v_prof
      from menu_items p where p.id = v_m.parent_id and p.location_id = p_loc::text;
  end if;
  rate := null;
  if v_rate_id is not null then
    select r.rate, coalesce(r.type, 'inclusive') = 'inclusive' into rate, v_incl
      from tax_rates r where r.id = v_rate_id and r.location_id = p_loc and coalesce(r.active, true);
  end if;
  if rate is null then
    select r.rate, coalesce(r.type, 'inclusive') = 'inclusive' into rate, v_incl
      from tax_rates r where r.location_id = p_loc and coalesce(r.is_default, false) and coalesce(r.active, true)
     order by r.created_at, r.id limit 1;
  end if;
  if rate is null then
    if v_prof is null then
      select l.default_tax_profile_id into v_prof from locations l where l.id = p_loc;
    end if;
    if v_prof is not null then
      select x.rate, coalesce(x.mode, 'exclusive') = 'inclusive' into rate, v_incl
        from tax_profile_lines x
       where x.profile_id = v_prof and x.location_id = p_loc and coalesce(x.line_type, 'rate') = 'rate'
         and coalesce(x.active, true) and 'all' = any(coalesce(x.order_types, array['all']))
       order by x.sort_order, x.id limit 1;
    end if;
  end if;
  rate := coalesce(rate, 0);
  net := case when gross is null then null when v_incl and rate > 0 then gross / (1 + rate) else gross end;
  return next;
end
$fn$;

-- The cost per base unit of one site item, the way costing.js componentUnitCost rolls it up: a MADE
-- item with a live recipe that outputs it (BATCH and PREP first, then newest) is its lines that apply to
-- dine in (computeRecipe passes no order type down, which is dine in), to base units through
-- stock_qty_to_base, over the usable share, at their own cost, plus wastage, over the yield; anything
-- else is its current cost. Null when a cost is missing (computeRecipe throws there), a line cannot be
-- worked out, a recipe loops, or the yield is not above 0. Differs from stock_co__made_cost (0a, left as
-- it is) only in those two points: the dine in scoping of nested lines and a missing cost. Owner only.
create or replace function public.stock_co__unit_cost_js(p_loc uuid, p_item uuid, p_path uuid[])
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_item record;
  v_r record;
  v_l record;
  v_dt boolean;
  v_total numeric := 0;
  v_q numeric;
  v_u numeric;
  v_c numeric;
  v_y numeric;
begin
  if p_item is null or p_item = any(coalesce(p_path, '{}'::uuid[])) or coalesce(cardinality(p_path), 0) > 12 then
    return null;
  end if;
  select i.id, i.kind, i.base_unit, i.current_cost into v_item from inventory_items i where i.id = p_item and i.location_id = p_loc;
  if not found then
    return null;
  end if;
  select r.id, r.yield_qty, r.yield_unit, r.wastage_pct into v_r
    from recipes r
   where r.location_id = p_loc and r.output_item_id = p_item and r.archived_at is null
   order by (r.recipe_type in ('BATCH', 'PREP')) desc, r.updated_at desc, r.id
   limit 1;
  if v_item.kind is distinct from 'MADE' or v_r.id is null then
    return v_item.current_cost;
  end if;
  v_dt := exists (select 1 from recipe_lines rl where rl.recipe_id = v_r.id and jsonb_typeof(rl.order_types) = 'array' and rl.order_types ? 'drive-thru');
  for v_l in
    select rl.component_item_id, rl.qty, rl.unit, rl.usable_pct, rl.order_types from recipe_lines rl
     where rl.recipe_id = v_r.id and rl.location_id = p_loc
     order by rl.sort_order, rl.id
  loop
    continue when not public.stock_line_applies(v_l.order_types, 'dine-in', v_dt);
    if not exists (select 1 from inventory_items c where c.id = v_l.component_item_id and c.location_id = p_loc) then
      return null;
    end if;
    v_q := public.stock_qty_to_base(v_l.qty, v_l.unit, v_l.component_item_id);
    v_u := coalesce(v_l.usable_pct, 100) / 100.0;
    if v_q is null or v_u <= 0 then
      return null;
    end if;
    v_c := public.stock_co__unit_cost_js(p_loc, v_l.component_item_id, coalesce(p_path, '{}'::uuid[]) || p_item);
    if v_c is null then
      return null;
    end if;
    v_total := v_total + (v_q / v_u) * v_c;
  end loop;
  v_total := v_total * (1 + coalesce(v_r.wastage_pct, 0) / 100.0);
  v_y := public.stock_qty_to_base(coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), v_item.base_unit), p_item);
  if v_y is null or v_y <= 0 then
    return null;
  end if;
  return v_total / v_y;
end
$fn$;

-- The cost of one company recipe at one site, line by line: the twin of costing.js computeRecipe
-- (contract 1.7). For each company line in sort order that applies to the order type (null = dine in):
-- the site item, qty_base through stock_qty_to_base in the site unit ('@' plus the site pack id, or the
-- unit code), usable = coalesce(usable_pct, 100) / 100 (0 or less: missing 'usable'), unit cost =
-- stock_co__made_cost (a MADE item with a live recipe: its recipe cost per base unit, recursive with the
-- cycle guard; a PURCHASED item or a MADE item with no recipe: current_cost; null current_cost: missing
-- 'no price'), line cost = (qty_base / usable) * unit cost. The nested made cost is order type blind,
-- as computeRecipe passes no order type down. Owner only.
create or replace function public.stock_co__recipe_cost_at(p_recipe uuid, p_loc uuid, p_order_type text)
returns table (line_id uuid, component_item_id uuid, site_item_id uuid, qty_base numeric, usable_pct numeric,
               unit_cost numeric, cost numeric, missing text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ot text := public.stock_norm_order_type(p_order_type);
  v_dt boolean;
  v_unit text;
  v_kind text;
  v_cost numeric;
  r record;
begin
  v_dt := exists (select 1 from stock_co_recipe_lines l
                   where l.recipe_id = p_recipe and jsonb_typeof(l.order_types) = 'array' and l.order_types ? 'drive-thru');
  for r in
    select l.id, l.component_item_id, l.qty, l.unit, l.pack_id, l.usable_pct, l.order_types
      from stock_co_recipe_lines l
     where l.recipe_id = p_recipe and l.component_item_id is not null
     order by l.sort_order, l.id
  loop
    continue when not public.stock_line_applies(r.order_types, v_ot, v_dt);
    line_id := r.id;
    component_item_id := r.component_item_id;
    usable_pct := coalesce(r.usable_pct, 100);
    qty_base := null;
    unit_cost := null;
    cost := null;
    missing := null;
    select s.site_item_id into site_item_id from stock_co_item_sites s where s.item_id = r.component_item_id and s.location_id = p_loc;
    if site_item_id is null then
      missing := 'not at site';
      return next;
      continue;
    end if;
    v_unit := case when r.pack_id is not null
                   then '@' || coalesce((select ps.site_pack_id::text from stock_co_pack_sites ps
                                          where ps.pack_id = r.pack_id and ps.location_id = p_loc), '')
                   else r.unit end;
    qty_base := public.stock_qty_to_base(r.qty, v_unit, site_item_id);
    if qty_base is null then
      missing := 'unit';
      return next;
      continue;
    end if;
    if usable_pct <= 0 then
      missing := 'usable';
      return next;
      continue;
    end if;
    select i.kind, i.current_cost into v_kind, v_cost from inventory_items i where i.id = site_item_id;
    if v_cost is null
       and not (v_kind = 'MADE' and exists (select 1 from recipes x
                                             where x.location_id = p_loc and x.output_item_id = site_item_id and x.archived_at is null)) then
      missing := 'no price';
      return next;
      continue;
    end if;
    unit_cost := public.stock_co__unit_cost_js(p_loc, site_item_id, '{}'::uuid[]);
    if unit_cost is null then
      missing := 'no price';
      return next;
      continue;
    end if;
    cost := (qty_base / (usable_pct / 100.0)) * unit_cost;
    return next;
  end loop;
end
$fn$;

-- The whole of one company recipe at one site: total = sum of the line costs times (1 + wastage / 100)
-- (null when any line is missing), yield_base = stock_qty_to_base(yield_qty, yield unit, the output
-- site item) or, for a dish with no made item, the yield quantity in its own unit, per_yield = total /
-- yield_base. Owner only.
create or replace function public.stock_co__recipe_total(p_recipe uuid, p_loc uuid, p_order_type text)
returns table (total numeric, yield_base numeric, per_yield numeric, missing integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r record;
  v_sum numeric;
  v_miss integer;
  v_out uuid;
  v_base text;
begin
  select r.yield_qty, r.yield_unit, r.wastage_pct, r.output_item_id into v_r from stock_co_recipes r where r.id = p_recipe;
  if not found then
    return;
  end if;
  select coalesce(sum(c.cost), 0), count(*) filter (where c.missing is not null)
    into v_sum, v_miss
    from public.stock_co__recipe_cost_at(p_recipe, p_loc, p_order_type) c;
  missing := coalesce(v_miss, 0);
  if v_r.output_item_id is not null then
    select s.site_item_id into v_out from stock_co_item_sites s where s.item_id = v_r.output_item_id and s.location_id = p_loc;
    if v_out is null then
      yield_base := null;
    else
      select i.base_unit into v_base from inventory_items i where i.id = v_out;
      yield_base := public.stock_qty_to_base(coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), v_base, 'each'), v_out);
    end if;
  else
    yield_base := coalesce(v_r.yield_qty, 1);
  end if;
  if yield_base is null or yield_base <= 0 then
    missing := missing + 1;
    yield_base := null;
  end if;
  total := case when missing = 0 then v_sum * (1 + coalesce(v_r.wastage_pct, 0) / 100.0) end;
  per_yield := case when total is not null and yield_base is not null then total / yield_base end;
  return next;
end
$fn$;

-- Upserts recipe_cost_daily for the (recipe, site) pairs on at those sites (p_recipe_ids null = every
-- live company recipe; p_locs null = every site it is on; p_day null = each site's business day now).
-- A dish: the plate cost, dine in; a batch or prep: the batch cost and the cost per yield unit. The
-- sale price comes from the menu at that site (stock_co__menu_price_net). Returns how many rows. Owner only.
create or replace function public.stock_co__cost_rows(p_recipe_ids uuid[], p_locs uuid[], p_day date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record;
  v_total numeric;
  v_yield numeric;
  v_per numeric;
  v_miss integer;
  v_gross numeric;
  v_net numeric;
  v_rate numeric;
  v_day date;
  v_gp numeric;
  v_n integer := 0;
begin
  for r in
    select rs.recipe_id, rs.location_id, rs.site_menu_item_id, c.kind
      from stock_co_recipe_sites rs
      join stock_co_recipes c on c.id = rs.recipe_id
     where rs.on_here and c.archived_at is null
       and (p_recipe_ids is null or rs.recipe_id = any(p_recipe_ids))
       and (p_locs is null or rs.location_id = any(p_locs))
     order by rs.location_id, rs.recipe_id
  loop
    v_day := coalesce(p_day, public.stock_co__today(r.location_id));
    select t.total, t.yield_base, t.per_yield, t.missing into v_total, v_yield, v_per, v_miss
      from public.stock_co__recipe_total(r.recipe_id, r.location_id, case when r.kind = 'dish' then 'dine-in' end) t;
    v_gross := null;
    v_net := null;
    v_rate := null;
    if r.site_menu_item_id is not null then
      select p.gross, p.net, p.rate into v_gross, v_net, v_rate
        from public.stock_co__menu_price_net(r.location_id, r.site_menu_item_id) p;
    end if;
    v_gp := case when v_total is not null and v_net is not null and v_net > 0 then round((v_net - v_total) / v_net * 100, 4) end;
    insert into recipe_cost_daily (location_id, recipe_id, day, cost, cost_per_yield, yield_base, menu_item_id, sale_price,
                                   sale_price_net, gp_pct, missing, computed_at)
    values (r.location_id, r.recipe_id, v_day, v_total, v_per, v_yield, r.site_menu_item_id, v_gross, v_net, v_gp,
            coalesce(v_miss, 0), now())
    on conflict (location_id, recipe_id, day) do update
      set cost = excluded.cost, cost_per_yield = excluded.cost_per_yield, yield_base = excluded.yield_base,
          menu_item_id = excluded.menu_item_id, sale_price = excluded.sale_price, sale_price_net = excluded.sale_price_net,
          gp_pct = excluded.gp_pct, missing = excluded.missing, computed_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$fn$;

-- One waiting save queue row of a Drop 2 kind (set_recipe_sites, msm_recipe, swap_ingredient,
-- facts_rebuild, make_sizes). Owner only.
create or replace function public.stock_co__d2_enqueue(p_org uuid, p_loc uuid, p_kind text, p_payload jsonb, p_entity_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_kind is null or p_kind not in ('set_recipe_sites', 'msm_recipe', 'swap_ingredient', 'facts_rebuild', 'make_sizes') then
    raise exception 'This database does not know the save job kind %.', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if p_org is null
     or (p_loc is null and p_kind in ('set_recipe_sites', 'facts_rebuild'))
     or (p_loc is not null and not exists (select 1 from locations l where l.id = p_loc and l.org_id = p_org)) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  insert into stock_save_queue (org_id, location_id, kind, payload, entity_ids, created_by)
  values (p_org, p_loc, p_kind, coalesce(p_payload, '{}'::jsonb), coalesce(p_entity_ids, '{}'::uuid[]), auth.uid())
  returning id into v_id;
  return v_id;
end
$fn$;

-- ============================================================================
-- STEP 5. HELPERS: the allergen, diet, declaration and calorie facts (map 4.24)
-- ============================================================================

-- The facts of one company item at one site: the supplier item the site buys from (the preferred pack
-- at that site, else the company main supplier item, else the newest live one), or the item's own
-- allergens when it has no live supplier item or facts_source is 'item'. Owner only.
create or replace function public.stock_co__facts_of_item(p_item uuid, p_loc uuid)
returns table (allergens text[], may_contain text[], diets text[], ingredients_text text, kcal100 numeric, nutrition jsonb,
               checked boolean, changed_at timestamptz, supplier_name text, source text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_item record;
  v_si record;
  v_k text;
  v_have boolean := false;
begin
  select i.allergens, i.facts_source, i.main_supplier_item_id into v_item from stock_co_items i where i.id = p_item;
  if not found then
    return;
  end if;
  if v_item.facts_source is distinct from 'item' then
    select si.id, si.allergens, si.may_contain, si.diets, si.ingredients_text, si.nutrition, si.facts_checked_at, si.updated_at,
           m.name as sname
      into v_si
      from stock_co_supplier_items si
      join stock_co_suppliers m on m.id = si.supplier_id
      left join lateral (select 1 as pref
                           from stock_co_supplier_item_sites x
                           join supplier_products sp on sp.id = x.site_supplier_product_id
                          where x.supplier_item_id = si.id and x.location_id = p_loc and sp.is_preferred and sp.archived_at is null
                          limit 1) pf on true
     where si.item_id = p_item and si.archived_at is null
     order by (pf.pref is not null) desc, (si.id = v_item.main_supplier_item_id) desc, si.created_at desc, si.id
     limit 1;
    v_have := found;
  end if;
  if not v_have then
    allergens := public.stock_co__allergen_ids(array(select jsonb_array_elements_text(
                   case when jsonb_typeof(v_item.allergens) = 'array' then v_item.allergens else '[]'::jsonb end)));
    may_contain := '{}'::text[];
    diets := '{}'::text[];
    ingredients_text := null;
    kcal100 := null;
    nutrition := null;
    checked := false;
    changed_at := null;
    supplier_name := null;
    source := 'item';
    return next;
    return;
  end if;
  allergens := public.stock_co__allergen_ids(v_si.allergens);
  may_contain := public.stock_co__allergen_ids(v_si.may_contain);
  diets := coalesce(v_si.diets, '{}'::text[]);
  ingredients_text := v_si.ingredients_text;
  v_k := btrim(coalesce(v_si.nutrition ->> 'kcal', ''));
  kcal100 := case when v_k ~ '^[0-9]+(\.[0-9]+)?$' then v_k::numeric end;
  nutrition := case when jsonb_typeof(v_si.nutrition) = 'object' then v_si.nutrition end;
  checked := v_si.facts_checked_at is not null;
  changed_at := coalesce((select max(c.at) from stock_change_log c
                           where c.entity = 'supplier_item' and c.entity_id = v_si.id and c.field in ('facts', 'allergens')),
                         v_si.updated_at);
  supplier_name := v_si.sname;
  source := 'supplier_items';
  return next;
end
$fn$;

-- The walk behind stock_co__facts_of_recipe: every line of a company recipe at one site, through made
-- items (a line whose site item is MADE and has a live recipe there with a company record: that
-- recipe's facts, depth 12, cycle guard). Allergens and may contain are unions; diets the intersection
-- (a dish is vegan only when every ingredient is); packaging lines (item type other) count for
-- nothing. The kcal rule (contract 1.7): a line's grams = its base quantity when the base unit is a
-- weight (to g) or a volume (ml counted as g); a count unit cannot be weighed unless the item is made
-- with a complete recipe; kcal_total = sum(g * kcal100 / 100); cooked_g = sum(g) * cooking yield;
-- portions = cooked_g / portion_weight_g, else the yield in count units, else 1; kcal = kcal_total /
-- portions; any line with no calories makes kcal null and the recipe incomplete. Answers one jsonb.
-- Owner only.
create or replace function public.stock_co__facts_walk(p_recipe uuid, p_loc uuid, p_path uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r record;
  r record;
  f record;
  v_sub jsonb;
  v_subrec uuid;
  v_site uuid;
  v_kind text;
  v_base text;
  v_dim text;
  v_canon numeric;
  v_unit text;
  v_qb numeric;
  v_g numeric;
  v_kcal numeric;
  v_alls text[] := '{}'::text[];
  v_may text[] := '{}'::text[];
  v_diets text[] := null;
  v_line_alls text[];
  v_lines jsonb := '[]'::jsonb;
  v_complete boolean := true;
  v_why text := null;
  v_kcal_total numeric := 0;
  v_grams numeric := 0;
  v_n integer := 0;
  v_nutr jsonb := '{"fat_g": 0, "saturates_g": 0, "carbs_g": 0, "sugars_g": 0, "protein_g": 0, "salt_g": 0, "fibre_g": 0}'::jsonb;
  v_broken text[] := '{}'::text[];
  v_k text;
  v_v text;
  v_changed_at timestamptz := null;
  v_changed_words text := null;
  v_tz text;
  v_cooked numeric;
  v_portions numeric;
  v_yield_base numeric;
  v_yield_each numeric;
  v_out uuid;
  v_name text;
  v_sub_text text;
  v_text text;
begin
  select c.* into v_r from stock_co_recipes c where c.id = p_recipe;
  if not found then
    return null;
  end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from locations l where l.id = p_loc;
  for r in
    select l.id, l.component_item_id, l.qty, l.unit, l.pack_id, l.sort_order, ci.name, ci.type
      from stock_co_recipe_lines l
      join stock_co_items ci on ci.id = l.component_item_id
     where l.recipe_id = p_recipe
     order by l.sort_order, l.id
  loop
    continue when coalesce(r.type, 'food') = 'other';
    v_n := v_n + 1;
    v_site := null;
    v_kind := null;
    v_base := null;
    v_dim := null;
    v_canon := null;
    v_qb := null;
    v_g := null;
    v_kcal := null;
    v_sub := null;
    v_subrec := null;
    v_sub_text := null;
    v_name := r.name;
    select s.site_item_id into v_site from stock_co_item_sites s where s.item_id = r.component_item_id and s.location_id = p_loc;
    if v_site is not null then
      select i.kind, i.base_unit into v_kind, v_base from inventory_items i where i.id = v_site;
      select u.dimension, u.to_canonical into v_dim, v_canon from stock_units u where u.code = lower(btrim(coalesce(v_base, '')));
      v_unit := case when r.pack_id is not null
                     then '@' || coalesce((select ps.site_pack_id::text from stock_co_pack_sites ps
                                            where ps.pack_id = r.pack_id and ps.location_id = p_loc), '')
                     else r.unit end;
      v_qb := public.stock_qty_to_base(r.qty, v_unit, v_site);
      if v_kind = 'MADE' then
        select t.company_ref into v_subrec
          from recipes t
         where t.location_id = p_loc and t.output_item_id = v_site and t.archived_at is null and t.company_ref is not null
         order by (t.recipe_type in ('BATCH', 'PREP')) desc, t.updated_at desc, t.id
         limit 1;
      end if;
    end if;
    if v_subrec is not null and not (v_subrec = any(coalesce(p_path, '{}'::uuid[]) || p_recipe)) and coalesce(cardinality(p_path), 0) < 12 then
      v_sub := public.stock_co__facts_walk(v_subrec, p_loc, coalesce(p_path, '{}'::uuid[]) || p_recipe);
    end if;
    if v_sub is not null then
      v_line_alls := array(select jsonb_array_elements_text(v_sub -> 'allergens'));
      v_alls := public.stock_co__allergen_ids(v_alls || v_line_alls);
      v_may := public.stock_co__allergen_ids(v_may || array(select jsonb_array_elements_text(v_sub -> 'may_contain')));
      if jsonb_typeof(v_sub -> 'diets') = 'array' then
        if v_diets is null then
          v_diets := array(select jsonb_array_elements_text(v_sub -> 'diets'));
        else
          v_diets := array(select d from unnest(v_diets) d where d in (select jsonb_array_elements_text(v_sub -> 'diets')));
        end if;
      else
        v_diets := coalesce(v_diets, '{}'::text[]);
      end if;
      if coalesce((v_sub ->> 'complete')::boolean, false) and v_qb is not null and (v_sub ->> 'yield_base')::numeric > 0 then
        v_g := v_qb * (v_sub ->> 'cooked_g')::numeric / (v_sub ->> 'yield_base')::numeric;
        v_kcal := v_qb * (v_sub ->> 'kcal_total')::numeric / (v_sub ->> 'yield_base')::numeric;
        for v_k in select x from unnest(array['fat_g', 'saturates_g', 'carbs_g', 'sugars_g', 'protein_g', 'salt_g', 'fibre_g']) x loop
          if (v_sub -> 'nutr' ->> v_k) is null then
            v_broken := v_broken || v_k;
          else
            v_nutr := jsonb_set(v_nutr, array[v_k], to_jsonb((v_nutr ->> v_k)::numeric
                        + v_qb * (v_sub -> 'nutr' ->> v_k)::numeric / (v_sub ->> 'yield_base')::numeric));
          end if;
        end loop;
      else
        v_why := coalesce(v_why, coalesce(v_sub ->> 'why', 'Not enough data: ' || r.name || ' cannot be worked out yet'));
      end if;
      v_sub_text := v_sub ->> 'text';
      if (v_sub ->> 'changed_at') is not null and ((v_sub ->> 'changed_at')::timestamptz > v_changed_at or v_changed_at is null) then
        v_changed_at := (v_sub ->> 'changed_at')::timestamptz;
        v_changed_words := v_sub ->> 'changed_words';
      end if;
    else
      select * into f from public.stock_co__facts_of_item(r.component_item_id, p_loc);
      v_line_alls := coalesce(f.allergens, '{}'::text[]);
      v_alls := public.stock_co__allergen_ids(v_alls || v_line_alls);
      v_may := public.stock_co__allergen_ids(v_may || coalesce(f.may_contain, '{}'::text[]));
      if v_diets is null then
        v_diets := coalesce(f.diets, '{}'::text[]);
      else
        v_diets := array(select d from unnest(v_diets) d where d = any(coalesce(f.diets, '{}'::text[])));
      end if;
      if v_qb is not null and v_dim in ('WEIGHT', 'VOLUME') then
        v_g := v_qb * coalesce(v_canon, 1);
      end if;
      if v_g is null then
        v_why := coalesce(v_why, 'Not enough data: ' || r.name || ' cannot be weighed');
      elsif f.kcal100 is null then
        v_why := coalesce(v_why, 'Not enough data: ' || r.name || ' has no calories yet');
      else
        v_kcal := v_g * f.kcal100 / 100;
      end if;
      for v_k in select x from unnest(array['fat_g', 'saturates_g', 'carbs_g', 'sugars_g', 'protein_g', 'salt_g', 'fibre_g']) x loop
        v_v := btrim(coalesce(f.nutrition ->> v_k, ''));
        if v_g is not null and v_v ~ '^[0-9]+(\.[0-9]+)?$' then
          v_nutr := jsonb_set(v_nutr, array[v_k], to_jsonb((v_nutr ->> v_k)::numeric + v_g * v_v::numeric / 100));
        else
          v_broken := v_broken || v_k;
        end if;
      end loop;
      if f.changed_at is not null and (v_changed_at is null or f.changed_at > v_changed_at) then
        v_changed_at := f.changed_at;
        v_changed_words := case when f.supplier_name is not null
                                then 'Check again: ' || r.name || ' from ' || f.supplier_name || ' changed ' || to_char(f.changed_at at time zone v_tz, 'FMDD Mon')
                                else 'Check again: ' || r.name || ' changed ' || to_char(f.changed_at at time zone v_tz, 'FMDD Mon') end;
      end if;
    end if;
    if v_kcal is null then
      v_complete := false;
    else
      v_kcal_total := v_kcal_total + v_kcal;
    end if;
    v_grams := v_grams + coalesce(v_g, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('name', v_name, 'grams', v_g, 'sort', r.sort_order,
                                                               'has_allergens', cardinality(coalesce(v_line_alls, '{}'::text[])) > 0,
                                                               'sub', v_sub_text));
  end loop;
  if v_n = 0 then
    v_complete := false;
    v_why := coalesce(v_why, 'Not enough data: the recipe has no ingredients yet');
  end if;
  for v_k in select x from unnest(v_broken) x loop
    v_nutr := v_nutr || jsonb_build_object(v_k, null);
  end loop;
  -- the yield in base units (what a parent recipe divides by) and in count units
  v_yield_base := null;
  v_yield_each := null;
  if v_r.output_item_id is not null then
    select s.site_item_id into v_out from stock_co_item_sites s where s.item_id = v_r.output_item_id and s.location_id = p_loc;
    if v_out is not null then
      select i.base_unit into v_base from inventory_items i where i.id = v_out;
      v_yield_base := public.stock_qty_to_base(coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), v_base, 'each'), v_out);
    end if;
  else
    v_yield_base := coalesce(v_r.yield_qty, 1);
  end if;
  select coalesce(v_r.yield_qty, 1) * u.to_canonical into v_yield_each
    from stock_units u where u.code = lower(btrim(coalesce(nullif(v_r.yield_unit, ''), 'each'))) and u.dimension = 'COUNT';
  v_cooked := v_grams * coalesce(v_r.cooking_yield_pct, 100) / 100.0;
  v_portions := case when coalesce(v_r.portion_weight_g, 0) > 0 and v_cooked > 0 then v_cooked / v_r.portion_weight_g
                     when v_yield_each > 0 then v_yield_each
                     else 1 end;
  select string_agg(case when (x ->> 'has_allergens')::boolean then '*' || (x ->> 'name') || '*' else (x ->> 'name') end
                    || case when (x ->> 'sub') is not null then ' (' || (x ->> 'sub') || ')' else '' end, ', '
                    order by (x ->> 'grams')::numeric desc nulls last, (x ->> 'sort')::integer)
    into v_text
    from jsonb_array_elements(v_lines) x;
  return jsonb_build_object(
    'allergens', to_jsonb(v_alls), 'may_contain', to_jsonb(v_may), 'diets', to_jsonb(coalesce(v_diets, '{}'::text[])),
    'text', v_text, 'complete', v_complete, 'why', case when v_complete then null else v_why end,
    'kcal_total', case when v_complete then v_kcal_total end, 'grams', v_grams, 'cooked_g', v_cooked,
    'yield_base', v_yield_base, 'portions', v_portions,
    'kcal', case when v_complete and v_portions > 0 then round(v_kcal_total / v_portions, 1) end,
    'portion_g', case when v_cooked > 0 and v_portions > 0 then round(v_cooked / v_portions, 1) end,
    'nutr', case when v_complete then v_nutr else null end,
    'nutrition', case when v_complete and v_portions > 0 then
                   (select jsonb_object_agg(e.key, case when e.value is null or jsonb_typeof(e.value) = 'null' then null
                                                        else to_jsonb(round((e.value #>> '{}')::numeric / v_portions, 2)) end)
                      from jsonb_each(v_nutr || jsonb_build_object('kcal', v_kcal_total)) e) end,
    'changed_at', v_changed_at, 'changed_words', v_changed_words, 'lines', v_n);
end
$fn$;

-- The facts of one company recipe at one site, in the contract's shape: allergens (what the recipe
-- says), may contain, diets, the ingredient declaration in weight order (allergen names in '*'), kcal
-- per portion, the other nutrition numbers per portion, the newest supplier item change among the
-- ingredients, and facts_hash (md5 of the ordered facts). Owner only.
create or replace function public.stock_co__facts_of_recipe(p_recipe uuid, p_loc uuid, p_path uuid[])
returns table (allergens text[], recipe_allergens text[], may_contain text[], diets text[], ingredients_text text, kcal numeric,
               kcal_complete boolean, portion_g numeric, nutrition jsonb, changed_at timestamptz, changed_words text, facts_hash text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  w jsonb := public.stock_co__facts_walk(p_recipe, p_loc, p_path);
begin
  if w is null then
    return;
  end if;
  recipe_allergens := array(select jsonb_array_elements_text(w -> 'allergens'));
  allergens := recipe_allergens;
  may_contain := array(select jsonb_array_elements_text(w -> 'may_contain'));
  diets := array(select jsonb_array_elements_text(w -> 'diets'));
  ingredients_text := w ->> 'text';
  kcal := (w ->> 'kcal')::numeric;
  kcal_complete := coalesce((w ->> 'complete')::boolean, false);
  portion_g := (w ->> 'portion_g')::numeric;
  nutrition := case when jsonb_typeof(w -> 'nutrition') = 'object' then w -> 'nutrition' end;
  changed_at := (w ->> 'changed_at')::timestamptz;
  changed_words := w ->> 'changed_words';
  facts_hash := md5(concat_ws('|', array_to_string(recipe_allergens, ','), array_to_string(may_contain, ','), array_to_string(diets, ','),
                              coalesce(kcal::text, ''), coalesce(ingredients_text, ''), coalesce(portion_g::text, ''),
                              coalesce(nutrition::text, '')));
  return next;
end
$fn$;

-- The facts rows of one site, all or the named products: one row per live till link whose site recipe
-- has a company record. typed_allergens = the menu item's allergens as ids; recipe_allergens = the
-- recipe's; allergens (shown) = the row's old shown set union typed union recipe, NEVER fewer;
-- needs_check when the old shown set holds an id that neither typed nor recipe holds now, or when the
-- facts changed after a checked row; everything else overwritten from the recipe. A product with no live
-- link keeps its row (the archive rule marks it). Rows are never deleted. Owner only.
create or replace function public.stock_co__facts_rebuild_site(p_loc uuid, p_menu_item_ids text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record;
  f record;
  v_old menu_item_stock_facts;
  v_typed text[];
  v_shown text[];
  v_gone text[];
  v_need boolean;
  v_words text;
  v_n integer := 0;
  v_nc integer := 0;
begin
  for r in
    select m.menu_item_id, m.recipe_id as site_recipe_id, t.company_ref as recipe_id, mi.allergens as typed
      from menu_item_recipes m
      join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null
      left join menu_items mi on mi.id = m.menu_item_id and mi.location_id = p_loc::text
     where m.location_id = p_loc
       and (p_menu_item_ids is null or m.menu_item_id = any(p_menu_item_ids))
     order by m.menu_item_id
  loop
    select * into f from public.stock_co__facts_of_recipe(r.recipe_id, p_loc, '{}'::uuid[]);
    v_typed := public.stock_co__allergen_ids(r.typed);
    v_old := null;
    select * into v_old from menu_item_stock_facts x where x.location_id = p_loc::text and x.menu_item_id = r.menu_item_id;
    v_shown := public.stock_co__allergen_ids(coalesce(v_old.allergens, '{}'::text[]) || v_typed || coalesce(f.recipe_allergens, '{}'::text[]));
    v_gone := array(select a from unnest(coalesce(v_old.allergens, '{}'::text[])) a
                     where not (a = any(v_typed || coalesce(f.recipe_allergens, '{}'::text[]))) order by a);
    v_need := false;
    v_words := null;
    if cardinality(v_gone) > 0 then
      v_need := true;
      v_words := 'Check again: the recipe no longer has ' || array_to_string(v_gone, ', ');
    elsif v_old.checked_at is not null and v_old.facts_hash is distinct from f.facts_hash then
      v_need := true;
      v_words := coalesce(f.changed_words, 'Check again: the recipe changed');
    elsif coalesce(v_old.needs_check, false) then
      v_need := true;
      v_words := v_old.check_words;
    end if;
    insert into menu_item_stock_facts (location_id, menu_item_id, recipe_id, site_recipe_id, allergens, recipe_allergens, typed_allergens,
                                       may_contain, diets, ingredients_text, kcal, kcal_complete, portion_g, nutrition, needs_check,
                                       check_words, facts_hash, checked_by, checked_by_name, checked_at, updated_at)
    values (p_loc::text, r.menu_item_id, r.recipe_id, r.site_recipe_id, v_shown, coalesce(f.recipe_allergens, '{}'::text[]), v_typed,
            coalesce(f.may_contain, '{}'::text[]), coalesce(f.diets, '{}'::text[]), f.ingredients_text, f.kcal,
            coalesce(f.kcal_complete, false), f.portion_g, f.nutrition, v_need, v_words, f.facts_hash, null, null, null, now())
    on conflict (location_id, menu_item_id) do update
      set recipe_id = excluded.recipe_id, site_recipe_id = excluded.site_recipe_id, allergens = excluded.allergens,
          recipe_allergens = excluded.recipe_allergens, typed_allergens = excluded.typed_allergens, may_contain = excluded.may_contain,
          diets = excluded.diets, ingredients_text = excluded.ingredients_text, kcal = excluded.kcal, kcal_complete = excluded.kcal_complete,
          portion_g = excluded.portion_g, nutrition = excluded.nutrition, needs_check = excluded.needs_check,
          check_words = excluded.check_words, facts_hash = excluded.facts_hash, updated_at = now()
    where (menu_item_stock_facts.recipe_id, menu_item_stock_facts.site_recipe_id, menu_item_stock_facts.allergens, menu_item_stock_facts.recipe_allergens,
           menu_item_stock_facts.typed_allergens, menu_item_stock_facts.may_contain, menu_item_stock_facts.diets, menu_item_stock_facts.ingredients_text,
           menu_item_stock_facts.kcal, menu_item_stock_facts.kcal_complete, menu_item_stock_facts.portion_g, menu_item_stock_facts.nutrition,
           menu_item_stock_facts.needs_check, menu_item_stock_facts.check_words, menu_item_stock_facts.facts_hash)
          is distinct from
          (excluded.recipe_id, excluded.site_recipe_id, excluded.allergens, excluded.recipe_allergens, excluded.typed_allergens, excluded.may_contain,
           excluded.diets, excluded.ingredients_text, excluded.kcal, excluded.kcal_complete, excluded.portion_g, excluded.nutrition,
           excluded.needs_check, excluded.check_words, excluded.facts_hash);
    v_n := v_n + 1;
    if v_need then
      v_nc := v_nc + 1;
    end if;
  end loop;
  return jsonb_build_object('rows', v_n, 'needs_check', v_nc);
end
$fn$;

-- Marks the facts rows of products that lost their recipe (archived or unlinked): the recipe side goes
-- (recipe_allergens empty, kcal null), the shown set stays, needs_check when it showed any allergen,
-- with the words. Never deletes a row. Returns how many rows. Owner only.
create or replace function public.stock_co__facts_mark(p_loc uuid, p_menu_item_ids text[], p_recipe uuid, p_words text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n integer;
begin
  update menu_item_stock_facts x
     set recipe_allergens = '{}'::text[], kcal = null, kcal_complete = false, nutrition = null, portion_g = null,
         needs_check = x.needs_check or cardinality(x.allergens) > 0,
         check_words = case when cardinality(x.allergens) > 0 then p_words else x.check_words end,
         updated_at = now()
   where x.location_id = p_loc::text
     and ((p_menu_item_ids is not null and x.menu_item_id = any(p_menu_item_ids))
          or (p_recipe is not null and x.recipe_id = p_recipe))
     and not exists (select 1 from menu_item_recipes m
                      join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null
                     where m.location_id = p_loc and m.menu_item_id = x.menu_item_id);
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- The facts of every till product whose recipe uses a company item (directly or through the made items
-- of batch and prep recipes, depth 12), at every site of the company: inline when at most 1,000 facts
-- rows, else one queued facts_rebuild job per site. Answers {"rows", "queued"}. Owner only.
create or replace function public.stock_co__facts_rebuild_item(p_item uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_recipes uuid[];
  v_n integer;
  v_rows integer := 0;
  v_q integer := 0;
  s record;
  v_res jsonb;
begin
  select i.org_id into v_org from stock_co_items i where i.id = p_item;
  if v_org is null then
    return jsonb_build_object('rows', 0, 'queued', 0);
  end if;
  with recursive up(recipe_id, depth) as (
    select l.recipe_id, 1 from stock_co_recipe_lines l where l.component_item_id = p_item
    union
    select l.recipe_id, u.depth + 1
      from up u
      join stock_co_recipes r on r.id = u.recipe_id and r.output_item_id is not null
      join stock_co_recipe_lines l on l.component_item_id = r.output_item_id
     where u.depth < 12
  )
  select array_agg(distinct recipe_id) into v_recipes from up;
  if v_recipes is null then
    return jsonb_build_object('rows', 0, 'queued', 0);
  end if;
  select count(*) into v_n
    from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
   where t.company_ref = any(v_recipes);
  for s in
    select m.location_id, array_agg(m.menu_item_id order by m.menu_item_id) as ids
      from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
     where t.company_ref = any(v_recipes)
     group by m.location_id
     order by m.location_id
  loop
    if v_n <= 1000 then
      v_res := public.stock_co__facts_rebuild_site(s.location_id, s.ids);
      v_rows := v_rows + coalesce((v_res ->> 'rows')::integer, 0);
    else
      perform public.stock_co__d2_enqueue(v_org, s.location_id, 'facts_rebuild', jsonb_build_object('menu_item_ids', to_jsonb(s.ids)), '{}'::uuid[]);
      v_q := v_q + 1;
    end if;
  end loop;
  return jsonb_build_object('rows', v_rows, 'queued', v_q);
end
$fn$;

-- ============================================================================
-- STEP 6. HELPERS: the recipe writers, the match rules, swap, sizes and the queue step
-- ============================================================================

-- The nested company batch and prep recipes a recipe uses, through made items (depth 12). Owner only.
create or replace function public.stock_co__recipe_nested(p_recipe uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with recursive w(recipe_id, depth, path) as (
    select p_recipe, 0, array[p_recipe]
    union all
    select r2.id, w.depth + 1, w.path || r2.id
      from w
      join stock_co_recipe_lines l on l.recipe_id = w.recipe_id and l.component_item_id is not null
      join lateral (select x.id from stock_co_recipes x
                     where x.output_item_id = l.component_item_id and x.archived_at is null and x.kind in ('batch', 'prep')
                     order by x.updated_at desc, x.id limit 1) r2 on true
     where w.depth < 12 and not (r2.id = any(w.path))
  )
  select coalesce(array_agg(distinct w.recipe_id), '{}'::uuid[]) from w where w.recipe_id <> p_recipe;
$fn$;

-- Every company item a recipe needs at a site: its made item, every line's item, through the nested
-- recipes. Owner only.
create or replace function public.stock_co__recipe_components(p_recipe uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(distinct z.item order by z.item), '{}'::uuid[])
    from (select l.component_item_id as item
            from stock_co_recipe_lines l
           where l.component_item_id is not null and l.recipe_id = any(array[p_recipe] || public.stock_co__recipe_nested(p_recipe))
          union
          select r.output_item_id
            from stock_co_recipes r
           where r.output_item_id is not null and r.id = any(array[p_recipe] || public.stock_co__recipe_nested(p_recipe))) z;
$fn$;

-- The lines of a recipe save, cleaned into the company form (the loop of stock_save_recipe): each line
-- {component_item_id or site_component_item_id, qty, unit ('@' plus a site pack id, '@' with pack_id, or
-- a unit code), pack_id, usable_pct, note, order_types}, answered as [{component_item_id, qty, unit,
-- pack_id, usable_pct, sort_order, note, order_types, base_qty}]. p_loc may be null (an import with no
-- site): then no site id is accepted and base_qty is null. The refusal words are stock_save_recipe's.
-- Owner only.
create or replace function public.stock_co__recipe_lines_clean(p_org uuid, p_loc uuid, p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_ln jsonb;
  v_comp uuid;
  v_site_comp uuid;
  v_u text;
  v_unit text;
  v_site_unit text;
  v_pack uuid;
  v_n integer := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return v_lines;
  end if;
  for v_line in select e.value from jsonb_array_elements(p_lines) with ordinality e(value, ord) order by e.ord loop
    v_ln := public.stock_co__clean('recipe_line', v_line);
    if v_ln ? 'component_item_id' and v_ln ? 'site_component_item_id' then
      raise exception 'Send the company id or the site id of a line''s item, not both.' using errcode = '22023';
    end if;
    continue when coalesce(v_ln ->> 'component_item_id', v_ln ->> 'site_component_item_id') is null
               or coalesce((v_ln ->> 'qty')::numeric, 0) <= 0;
    v_site_comp := null;
    if (v_ln ->> 'site_component_item_id') is not null then
      v_site_comp := (v_ln ->> 'site_component_item_id')::uuid;
      v_comp := null;
      if p_loc is not null then
        select s.item_id into v_comp from stock_co_item_sites s where s.site_item_id = v_site_comp and s.location_id = p_loc;
      end if;
      if v_comp is null then
        raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
      end if;
    else
      v_comp := (v_ln ->> 'component_item_id')::uuid;
      if not exists (select 1 from stock_co_items x where x.id = v_comp and x.org_id = p_org) then
        raise exception 'A line names a stock item that is not in this company.' using errcode = '22023';
      end if;
      if p_loc is not null then
        select s.site_item_id into v_site_comp from stock_co_item_sites s where s.item_id = v_comp and s.location_id = p_loc;
      end if;
    end if;
    v_u := btrim(coalesce(v_ln ->> 'unit', ''));
    v_pack := null;
    v_site_unit := null;
    if v_u like '@_%' then
      if substr(v_u, 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'A line is in a pack ServOS does not know.' using errcode = '22023';
      end if;
      if p_loc is not null then
        select ps.pack_id into v_pack from stock_co_pack_sites ps
         where ps.site_pack_id = substr(v_u, 2)::uuid and ps.location_id = p_loc;
      end if;
      if v_pack is null then
        select p.id into v_pack from stock_co_packs p where p.id = substr(v_u, 2)::uuid and p.item_id = v_comp;
      end if;
      v_unit := '@';
      v_site_unit := lower(v_u);
    elsif v_u = '@' then
      v_pack := (v_ln ->> 'pack_id')::uuid;
      v_unit := '@';
      if p_loc is not null then
        v_site_unit := '@' || (select ps.site_pack_id from stock_co_pack_sites ps where ps.pack_id = v_pack and ps.location_id = p_loc)::text;
      end if;
    else
      if (v_ln ->> 'pack_id') is not null then
        raise exception 'A line with a pack has the unit "@".' using errcode = '22023';
      end if;
      v_unit := lower(v_u);
      if not exists (select 1 from stock_units su where su.code = v_unit) then
        raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_u using errcode = '22023';
      end if;
      v_site_unit := v_unit;
    end if;
    if v_unit = '@' and (v_pack is null or not exists (select 1 from stock_co_packs x where x.id = v_pack and x.item_id = v_comp)) then
      raise exception 'A line is in a pack that is not one of its item''s packs.' using errcode = '22023';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'component_item_id', v_comp, 'qty', (v_ln ->> 'qty')::numeric, 'unit', v_unit, 'pack_id', v_pack,
      'usable_pct', coalesce((v_ln ->> 'usable_pct')::numeric, 100), 'sort_order', v_n, 'note', v_ln ->> 'note',
      'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' and jsonb_array_length(v_ln -> 'order_types') > 0
                          then v_ln -> 'order_types' end,
      'base_qty', case when v_site_comp is not null and v_site_unit is not null
                       then public.stock_qty_to_base((v_ln ->> 'qty')::numeric, v_site_unit, v_site_comp) end));
    v_n := v_n + 1;
  end loop;
  return v_lines;
end
$fn$;

-- The write part of stock_save_recipe, no guard: the company row (p_recipe: the cleaned company keys,
-- with "id" for an edit and "local_location_id" for a new local recipe), the lines (p_lines: the
-- cleaned company lines of stock_co__recipe_lines_clean, or null to leave them), the change log and the
-- site steps through stock_co__run_sites for every site the recipe is on. p_by {"uid", "name"}. Used by
-- stock_save_recipe, the import, swap and make sizes. Answers {"id", "row_version", "created",
-- "log_id", "lines_saved", "run"}. Owner only.
create or replace function public.stock_co__recipe_put(p_org uuid, p_loc uuid, p_recipe jsonb, p_lines jsonb, p_by jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_id uuid := (p_recipe ->> 'id')::uuid;
  v_old stock_co_recipes;
  v_new stock_co_recipes;
  v_co jsonb := p_recipe - array['id', 'local_location_id'];
  v_log bigint;
  v_old_lines jsonb;
  v_run jsonb := null;
  v_sites uuid[];
  v_created boolean := false;
  v_q integer;
begin
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'kind') is null then
      raise exception 'A new recipe needs a name and its type.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_recipes,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', p_org,
                                  'local_location_id', nullif(p_recipe ->> 'local_location_id', '')::uuid,
                                  'yield_qty', 1, 'yield_unit', 'each', 'wastage_pct', 0, 'restricted', false, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now(), 'updated_by', nullif(p_by ->> 'uid', '')::uuid) || v_co);
    v_new.restricted := coalesce(v_new.restricted, false);
    insert into stock_co_recipes select (v_new).*;
    v_id := v_new.id;
    v_created := true;
    v_log := public.stock_co__log_diff(p_org, null, 'recipe', v_id, null, to_jsonb(v_new), p_source);
  else
    select * into v_old from stock_co_recipes x where x.id = v_id for update;
    if v_old.id is null or v_old.org_id is distinct from p_org then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    v_new.updated_by := coalesce(nullif(p_by ->> 'uid', '')::uuid, v_old.updated_by);
    update stock_co_recipes x
       set (kind, name, yield_qty, yield_unit, output_item_id, wastage_pct, gp_target_pct, method, photo, food_kind, meal_food_pct,
            portion_weight_g, cooking_yield_pct, shelf_life_days, msm_product_id, row_version, updated_at, updated_by)
         = (v_new.kind, v_new.name, v_new.yield_qty, v_new.yield_unit, v_new.output_item_id, v_new.wastage_pct, v_new.gp_target_pct,
            v_new.method, v_new.photo, v_new.food_kind, v_new.meal_food_pct, v_new.portion_weight_g, v_new.cooking_yield_pct,
            v_new.shelf_life_days, v_new.msm_product_id, v_new.row_version, v_new.updated_at, v_new.updated_by)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(p_org, null, 'recipe', v_id, to_jsonb(v_old), to_jsonb(v_new), p_source);
  end if;
  if jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('component_item_id', l.component_item_id, 'qty', l.qty, 'unit', l.unit,
                                                 'pack_id', l.pack_id, 'usable_pct', l.usable_pct, 'sort_order', l.sort_order,
                                                 'note', l.note, 'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
      into v_old_lines from stock_co_recipe_lines l where l.recipe_id = v_id;
    delete from stock_co_recipe_lines l where l.recipe_id = v_id;
    insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, pack_id, usable_pct, order_types, note,
                                       sort_order, base_qty)
    select p_org, v_id, x.component_item_id, x.qty, x.unit, x.pack_id, x.usable_pct, x.order_types, x.note, x.sort_order, x.base_qty
      from jsonb_to_recordset(p_lines) as x(component_item_id uuid, qty numeric, unit text, pack_id uuid, usable_pct numeric,
                                            sort_order integer, note text, order_types jsonb, base_qty numeric);
    if v_old_lines is distinct from (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(p_lines) e) then
      v_log := coalesce(public.stock_co__log(p_org, null, 'recipe', v_id, 'lines', v_old_lines,
                                             (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(p_lines) e),
                                             p_source), v_log);
    end if;
  end if;
  v_sites := array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id);
  if cardinality(v_sites) > 0 then
    v_run := public.stock_co__run_sites(p_org, coalesce(p_loc, v_sites[1]), v_sites, '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);
  end if;
  select count(*) into v_q from stock_co_recipe_lines l where l.recipe_id = v_id;
  return jsonb_build_object('id', v_id, 'row_version', v_new.row_version, 'created', v_created, 'log_id', v_log,
                            'lines_saved', v_q, 'run', v_run);
end
$fn$;

-- A company recipe switched on at one site: every component item of the recipe (through made items)
-- added there (stock_co__set_sites_at 'add', why_on 'On because <recipe> is sold here' where new), its
-- nested batch and prep recipes on there too, the site recipe made or on_here true, the recipe written
-- (stock_co__sync_recipes, which mirrors the lines and the till link), the till link when a till product
-- is named (the stock_link_menu_item body), why_on and linked_at on the recipe site row, today's cost row
-- and the facts of the linked product. A refusal in words (an ingredient that cannot be set up there, a
-- till product not on that menu) comes back as {"ok": false, "error"} and nothing at that site is
-- written. Owner only.
create or replace function public.stock_co__recipe_on_at(p_recipe uuid, p_loc uuid, p_menu_item_id text, p_why text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r stock_co_recipes;
  v_org uuid;
  v_lname text;
  v_items uuid[];
  v_new_items uuid[];
  v_res jsonb;
  v_sid uuid;
  v_menu text := nullif(btrim(coalesce(p_menu_item_id, '')), '');
  v_old_menu text;
  v_nested uuid;
  v_sub jsonb;
  v_src text := coalesce(nullif(public.stock_co__d1_source(), ''), 'save');
begin
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  select * into v_r from stock_co_recipes r where r.id = p_recipe;
  select l.org_id, l.name into v_org, v_lname from locations l where l.id = p_loc;
  if v_r.id is null or v_org is null or v_r.org_id is distinct from v_org then
    return jsonb_build_object('ok', false, 'error', 'That site is not in this company.');
  end if;
  if v_r.archived_at is not null then
    return jsonb_build_object('ok', false, 'error', 'This recipe is archived, so it cannot be linked.');
  end if;
  begin
    -- 1. every item the recipe needs, ticked on here
    v_items := public.stock_co__recipe_components(p_recipe);
    v_new_items := array(select x from unnest(v_items) x
                          where not exists (select 1 from stock_co_item_sites s where s.item_id = x and s.location_id = p_loc and s.on_here));
    if cardinality(v_items) > 0 then
      v_res := public.stock_co__set_sites_at(v_items, p_loc, 'add', p_by);
      if jsonb_array_length(coalesce(v_res -> 'refused', '[]'::jsonb)) > 0 then
        raise exception 'Not written at %: % uses an item or a pack that is not set up there. Add the item at that site first.', v_lname, v_r.name
          using errcode = '55000';
      end if;
      update stock_co_item_sites s set why_on = 'On because ' || v_r.name || ' is sold here'
       where s.item_id = any(v_new_items) and s.location_id = p_loc;
    end if;
    -- 2. the nested batch and prep recipes it is made from, on here too (no till link)
    for v_nested in select x from unnest(public.stock_co__recipe_nested(p_recipe)) x loop
      if not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = v_nested and s.location_id = p_loc and s.on_here) then
        v_sub := public.stock_co__recipe_on_at(v_nested, p_loc, null, 'On because ' || v_r.name || ' is sold here', p_by);
        if not coalesce((v_sub ->> 'ok')::boolean, false) then
          raise exception '%', coalesce(v_sub ->> 'error', 'A recipe it is made from could not be set up there.') using errcode = '55000';
        end if;
      end if;
    end loop;
    -- 3. the site recipe
    select s.site_recipe_id, s.site_menu_item_id into v_sid, v_old_menu
      from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
    if v_sid is null then
      v_sid := public.stock_co__new_site_recipe(p_recipe, p_loc);
    else
      update stock_co_recipe_sites s set on_here = true, row_version = s.row_version + 1, updated_at = now()
       where s.recipe_id = p_recipe and s.location_id = p_loc and not s.on_here;
    end if;
    -- 4. the till link, when given (the stock_link_menu_item body)
    if v_menu is not null then
      if not exists (select 1 from menu_items m where m.id = v_menu and m.location_id = p_loc::text) then
        raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
      end if;
      update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
       where s.location_id = p_loc and s.site_menu_item_id = v_menu and s.recipe_id <> p_recipe;
      update stock_co_recipe_sites s
         set site_menu_item_id = v_menu, linked_at = now(), row_version = s.row_version + 1, updated_at = now()
       where s.recipe_id = p_recipe and s.location_id = p_loc and s.site_menu_item_id is distinct from v_menu;
    end if;
    update stock_co_recipe_sites s
       set why_on = coalesce(s.why_on, nullif(btrim(coalesce(p_why, '')), ''), 'Added by ' || coalesce(nullif(btrim(coalesce(p_by, '')), ''), 'head office'))
     where s.recipe_id = p_recipe and s.location_id = p_loc;
    -- 5. the recipe at the site: columns, lines, the till link
    perform public.stock_co__sync_recipes(p_loc, array[p_recipe], true, false);
    if v_menu is not null then
      insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
      values (p_loc, v_menu, v_sid, 1)
      on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id;
      if v_old_menu is distinct from v_menu then
        perform public.stock_co__log(v_org, p_loc, 'menu_link', p_recipe, 'menu_item_id', to_jsonb(v_old_menu), to_jsonb(v_menu), v_src);
      end if;
    end if;
    perform public.stock_co__log(v_org, p_loc, 'recipe_site', p_recipe, 'on_here', to_jsonb(false), to_jsonb(true), v_src);
    -- 6. today's cost row and the facts of the linked product
    perform public.stock_co__cost_rows(array[p_recipe], array[p_loc], null);
    select s.site_menu_item_id into v_old_menu from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
    if v_old_menu is not null then
      perform public.stock_co__facts_rebuild_site(p_loc, array[v_old_menu]);
    end if;
    return jsonb_build_object('ok', true, 'location_id', p_loc, 'site_recipe_id', v_sid, 'menu_item_id', v_old_menu,
                              'items_added', cardinality(v_new_items));
  exception
    when lock_not_available or deadlock_detected or query_canceled then
      raise;
    when others then
      return jsonb_build_object('ok', false, 'location_id', p_loc, 'error', sqlerrm, 'code', sqlstate);
  end;
end
$fn$;

-- A company recipe switched off at one site: that site's till links of the site recipe deleted (logged
-- entity menu_link), on_here false, the site recipe archived by the writer, the facts rows marked (as
-- the archive does). Items ticked on because of this recipe stay on. Owner only.
create or replace function public.stock_co__recipe_off_at(p_recipe uuid, p_loc uuid, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_sid uuid;
  v_menus text[];
  v_m text;
  v_src text := coalesce(nullif(public.stock_co__d1_source(), ''), 'save');
  v_marked integer := 0;
begin
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  select l.org_id into v_org from locations l where l.id = p_loc;
  select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
  if v_sid is null or v_org is null then
    return jsonb_build_object('ok', true, 'location_id', p_loc, 'site_recipe_id', null, 'unlinked', 0, 'facts_rows', 0);
  end if;
  v_menus := array(select m.menu_item_id from menu_item_recipes m where m.location_id = p_loc and m.recipe_id = v_sid order by m.menu_item_id);
  foreach v_m in array v_menus loop
    perform public.stock_co__log(v_org, p_loc, 'menu_link', p_recipe, 'menu_item_id', to_jsonb(v_m), null, v_src);
  end loop;
  delete from menu_item_recipes m where m.location_id = p_loc and m.recipe_id = v_sid;
  update stock_co_recipe_sites s
     set site_menu_item_id = null, on_here = false, row_version = s.row_version + 1, updated_at = now()
   where s.recipe_id = p_recipe and s.location_id = p_loc;
  perform public.stock_co__log(v_org, p_loc, 'recipe_site', p_recipe, 'on_here', to_jsonb(true), to_jsonb(false), v_src);
  perform public.stock_co__sync_recipes(p_loc, array[p_recipe], true, false);
  v_marked := public.stock_co__facts_mark(p_loc, case when cardinality(v_menus) > 0 then v_menus end, p_recipe,
                                          'Check again: this product is no longer linked to a recipe');
  return jsonb_build_object('ok', true, 'location_id', p_loc, 'site_recipe_id', v_sid, 'unlinked', cardinality(v_menus),
                            'facts_rows', v_marked);
end
$fn$;

-- The site's own modifier for an option rule, in order: the option's menu product through
-- msm_product_sites ('msm'); the same menu_items.master_id as a venue item another site of the rule
-- resolved to ('master_id'); the option name equal (normalised) to a sub item of this venue's menu or
-- to an option of one of the dish's modifier groups ('name'); else null. Owner only.
create or replace function public.stock_co__resolve_modifier(p_rule uuid, p_loc uuid)
returns table (site_modifier_id text, resolved_by text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r record;
  v_name text;
begin
  select ru.recipe_id, ru.option_name, ru.option_msm_product_id into v_r from stock_co_option_rules ru where ru.id = p_rule;
  if not found then
    return;
  end if;
  site_modifier_id := null;
  resolved_by := null;
  if v_r.option_msm_product_id is not null then
    select ps.venue_item_id into site_modifier_id
      from msm_product_sites ps
     where ps.product_id = v_r.option_msm_product_id and ps.location_id = p_loc::text and coalesce(ps.active, true)
     order by ps.venue_item_id limit 1;
    if site_modifier_id is not null then
      resolved_by := 'msm';
      return next;
      return;
    end if;
  end if;
  select mi.id into site_modifier_id
    from stock_co_option_rule_sites rs
    join menu_items o on o.id = rs.site_modifier_id and o.location_id = rs.location_id::text and o.master_id is not null
    join menu_items mi on mi.master_id = o.master_id and mi.location_id = p_loc::text and not coalesce(mi.archived, false)
   where rs.rule_id = p_rule and rs.location_id <> p_loc and rs.site_modifier_id is not null
   order by mi.id limit 1;
  if site_modifier_id is not null then
    resolved_by := 'master_id';
    return next;
    return;
  end if;
  v_name := public.stock_co__norm_name(v_r.option_name);
  if v_name <> '' then
    select mi.id into site_modifier_id
      from menu_items mi
     where mi.location_id = p_loc::text and not coalesce(mi.archived, false) and mi.parent_id is not null
       and public.stock_co__norm_name(mi.name) = v_name
     order by mi.id limit 1;
    if site_modifier_id is null then
      select coalesce(o ->> 'itemId', o ->> 'id') into site_modifier_id
        from stock_co_recipe_sites rs
        join menu_items d on d.id = rs.site_menu_item_id and d.location_id = p_loc::text
       cross join lateral jsonb_array_elements(case when jsonb_typeof(d.assigned_modifier_groups) = 'array'
                                                   then d.assigned_modifier_groups else '[]'::jsonb end) g(gv)
        join modifier_groups mg on mg.id = case when jsonb_typeof(g.gv) = 'string' then g.gv #>> '{}' else g.gv ->> 'id' end
                               and mg.location_id = p_loc::text
       cross join lateral jsonb_array_elements(case when jsonb_typeof(mg.options) = 'array' then mg.options else '[]'::jsonb end) o
       where rs.recipe_id = v_r.recipe_id and rs.location_id = p_loc
         and jsonb_typeof(o) = 'object' and public.stock_co__norm_name(o ->> 'name') = v_name
         and coalesce(o ->> 'itemId', o ->> 'id') is not null
       order by 1 limit 1;
    end if;
    if site_modifier_id is not null then
      resolved_by := 'name';
      return next;
      return;
    end if;
  end if;
  return next;
end
$fn$;

-- The site rows of an option rule, at every site the dish is on: a hand value wins (p_hand
-- [{"location_id", "site_modifier_id"}]), an existing hand row stays, else stock_co__resolve_modifier;
-- a site it cannot resolve gets a row with site_modifier_id null (the rule does nothing there). Answers
-- {"sites": [...], "not_found": [site names]}. Owner only.
create or replace function public.stock_co__option_rule_sites(p_rule uuid, p_hand jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r record;
  s record;
  v_mod text;
  v_by text;
  v_sites jsonb := '[]'::jsonb;
  v_nf jsonb := '[]'::jsonb;
begin
  select ru.recipe_id, ru.org_id into v_r from stock_co_option_rules ru where ru.id = p_rule;
  for s in
    select rs.location_id, l.name
      from stock_co_recipe_sites rs join locations l on l.id = rs.location_id
     where rs.recipe_id = v_r.recipe_id and rs.on_here
     order by l.name, l.id
  loop
    v_mod := null;
    v_by := null;
    select nullif(btrim(coalesce(h ->> 'site_modifier_id', '')), '') into v_mod
      from jsonb_array_elements(case when jsonb_typeof(p_hand) = 'array' then p_hand else '[]'::jsonb end) h
     where lower(h ->> 'location_id') = s.location_id::text limit 1;
    if v_mod is not null then
      v_by := 'hand';
    else
      select x.site_modifier_id, x.resolved_by into v_mod, v_by
        from stock_co_option_rule_sites x where x.rule_id = p_rule and x.location_id = s.location_id and x.resolved_by = 'hand';
      if v_mod is null then
        select z.site_modifier_id, z.resolved_by into v_mod, v_by from public.stock_co__resolve_modifier(p_rule, s.location_id) z;
      end if;
    end if;
    insert into stock_co_option_rule_sites (rule_id, org_id, location_id, site_modifier_id, resolved_by)
    values (p_rule, v_r.org_id, s.location_id, v_mod, case when v_mod is null then null else v_by end)
    on conflict (rule_id, location_id) do update
      set site_modifier_id = excluded.site_modifier_id, resolved_by = excluded.resolved_by,
          row_version = stock_co_option_rule_sites.row_version + 1, updated_at = now()
      where stock_co_option_rule_sites.site_modifier_id is distinct from excluded.site_modifier_id
         or stock_co_option_rule_sites.resolved_by is distinct from excluded.resolved_by;
    v_sites := v_sites || jsonb_build_array(jsonb_build_object('location_id', s.location_id, 'site_modifier_id', v_mod,
                                                                'resolved_by', case when v_mod is null then null else v_by end));
    if v_mod is null then
      v_nf := v_nf || to_jsonb(s.name);
    end if;
  end loop;
  return jsonb_build_object('sites', v_sites, 'not_found', v_nf);
end
$fn$;

-- The Recipe missing suggestion for a till product at a site: (1) 'msm' the product's menu product and a
-- company recipe with that msm_product_id, else another site's venue item of the same product that has
-- a live link; (2) 'master' a venue item at another site of the company with the same master_id and a
-- live link; (3) 'name' a company recipe with the same normalised name, or another site's linked product
-- with the same normalised name when the gross prices are within 15%; else no row. Owner only.
create or replace function public.stock_co__match_recipe(p_loc uuid, p_menu_item_id text)
returns table (recipe_id uuid, how text, price_diff_pct numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_prod uuid;
  v_master text;
  v_name text;
  v_price numeric;
  v_txt text;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  select mi.master_id, public.stock_co__norm_name(mi.name), btrim(coalesce(mi.pricing ->> 'base', '')) into v_master, v_name, v_txt
    from menu_items mi where mi.id = p_menu_item_id and mi.location_id = p_loc::text;
  if not found or v_org is null then
    return;
  end if;
  v_price := case when v_txt ~ '^-?[0-9]+(\.[0-9]+)?$' then v_txt::numeric end;
  recipe_id := null;
  how := null;
  price_diff_pct := null;
  select ps.product_id into v_prod from msm_product_sites ps where ps.location_id = p_loc::text and ps.venue_item_id = p_menu_item_id;
  if v_prod is not null then
    select r.id into recipe_id from stock_co_recipes r
     where r.org_id = v_org and r.msm_product_id = v_prod and r.archived_at is null
     order by r.created_at, r.id limit 1;
    if recipe_id is null then
      select t.company_ref into recipe_id
        from msm_product_sites ps2
        join menu_item_recipes m on m.location_id::text = ps2.location_id and m.menu_item_id = ps2.venue_item_id
        join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null
       where ps2.product_id = v_prod and ps2.location_id <> p_loc::text
       order by ps2.location_id limit 1;
    end if;
    if recipe_id is not null then
      how := 'msm';
      return next;
      return;
    end if;
  end if;
  if v_master is not null then
    select t.company_ref into recipe_id
      from menu_items o
      join locations l2 on l2.id::text = o.location_id and l2.org_id = v_org
      join menu_item_recipes m on m.location_id = l2.id and m.menu_item_id = o.id
      join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null
     where o.master_id = v_master and o.location_id <> p_loc::text
     order by o.location_id, o.id limit 1;
    if recipe_id is not null then
      how := 'master';
      return next;
      return;
    end if;
  end if;
  if coalesce(v_name, '') <> '' then
    select r.id into recipe_id from stock_co_recipes r
     where r.org_id = v_org and r.archived_at is null and r.kind = 'dish' and public.stock_co__norm_name(r.name) = v_name
     order by r.created_at, r.id limit 1;
    if recipe_id is not null then
      how := 'name';
      return next;
      return;
    end if;
    select t.company_ref, round(abs(z.price - v_price) / v_price * 100, 2) into recipe_id, price_diff_pct
      from menu_items o
      join locations l2 on l2.id::text = o.location_id and l2.org_id = v_org
      join menu_item_recipes m on m.location_id = l2.id and m.menu_item_id = o.id
      join recipes t on t.id = m.recipe_id and t.archived_at is null and t.company_ref is not null
     cross join lateral (select case when btrim(coalesce(o.pricing ->> 'base', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                                     then btrim(o.pricing ->> 'base')::numeric end as price) z
     where o.location_id <> p_loc::text and public.stock_co__norm_name(o.name) = v_name
       and v_price > 0 and z.price is not null and abs(z.price - v_price) / v_price <= 0.15
     order by abs(z.price - v_price), o.location_id, o.id limit 1;
    if recipe_id is not null then
      how := 'name';
      return next;
      return;
    end if;
  end if;
  return;
end
$fn$;

-- Does a unit fit an item: the same dimension as its base unit, or a live company bridge of the item
-- reaches it. A pack line ('@') fits only its own item's pack. Owner only.
create or replace function public.stock_co__unit_fits(p_item uuid, p_unit text, p_pack uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when p_unit = '@' then exists (select 1 from stock_co_packs p where p.id = p_pack and p.item_id = p_item and p.archived_at is null)
    else exists (select 1 from stock_co_items i
                   join stock_units b on b.code = i.base_unit
                   join stock_units u on u.code = lower(btrim(coalesce(p_unit, '')))
                  where i.id = p_item
                    and (u.dimension = b.dimension
                         or exists (select 1 from stock_co_bridges br
                                      join stock_units f on f.code = br.from_unit join stock_units t on t.code = br.to_unit
                                     where br.item_id = p_item and br.archived_at is null
                                       and ((f.dimension = u.dimension and t.dimension = b.dimension)
                                            or (t.dimension = u.dimension and f.dimension = b.dimension)))))
  end;
$fn$;

-- The preview of Swap an ingredient (contract 1.8): the live company recipes of the from item's company
-- using it (or the named ones), each with the line before and after, the sites it is on and a problem
-- when the unit does not fit the new item. Keyset on (lower(name), id), at most 200 a page. Owner only.
create or replace function public.stock_co__swap_plan(p_spec jsonb, p_after jsonb, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  v_mode text := p_spec ->> 'mode';
  v_from uuid := (p_spec ->> 'from_item_id')::uuid;
  v_to uuid := nullif(p_spec ->> 'to_item_id', '')::uuid;
  v_qty numeric := nullif(p_spec ->> 'qty', '')::numeric;
  v_unit text := nullif(lower(btrim(coalesce(p_spec ->> 'unit', ''))), '');
  v_factor numeric := nullif(p_spec ->> 'factor', '')::numeric;
  v_ids uuid[];
  v_org uuid;
  v_k text;
  v_aid uuid;
  v_from_name text;
  v_to_name text;
  v_rows jsonb;
  v_total integer;
  v_sites integer;
  v_last record;
  v_page uuid[];
begin
  select i.org_id, i.name into v_org, v_from_name from stock_co_items i where i.id = v_from;
  if v_to is not null then
    select i.name into v_to_name from stock_co_items i where i.id = v_to;
  end if;
  if jsonb_typeof(p_spec -> 'recipe_ids') = 'array' then
    v_ids := array(select lower(x)::uuid from jsonb_array_elements_text(p_spec -> 'recipe_ids') x);
  end if;
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  with base as (
    select r.id, lower(r.name) as k
      from stock_co_recipes r
     where r.org_id = v_org and r.archived_at is null
       and (v_ids is null or r.id = any(v_ids))
       and exists (select 1 from stock_co_recipe_lines l where l.recipe_id = r.id and l.component_item_id = v_from)
  )
  select array(select b.id from base b where v_aid is null or (b.k, b.id) > (v_k, v_aid) order by b.k, b.id limit v_lim + 1),
         case when v_aid is null then (select count(*)::integer from base) end,
         case when v_aid is null then (select count(distinct s.location_id)::integer from base b join stock_co_recipe_sites s on s.recipe_id = b.id and s.on_here) end
    into v_page, v_total, v_sites;
  select coalesce(jsonb_agg(row_to_json(z)::jsonb order by z.k, z.id), '[]'::jsonb) into v_rows
    from (
      select r.id as recipe_id, r.id, lower(r.name) as k, r.name,
             jsonb_build_object('qty', l.qty, 'unit', case when l.unit = '@' then coalesce(pk.name, 'pack') else l.unit end, 'name', v_from_name) as line_before,
             jsonb_build_object('qty', case when v_mode = 'amount' and v_qty is not null then v_qty
                                           when v_mode = 'amount' and v_factor is not null then l.qty * v_factor
                                           else l.qty end,
                                'unit', case when v_mode = 'amount' and v_qty is not null then v_unit
                                            when l.unit = '@' then coalesce(pk.name, 'pack') else l.unit end,
                                'name', case when v_mode = 'swap' then v_to_name else v_from_name end) as line_after,
             (select count(*) from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here) as sites_on,
             case when v_mode = 'swap' and not public.stock_co__unit_fits(v_to, l.unit, l.pack_id)
                    then 'Give the amount in a unit ' || coalesce(v_to_name, 'the new item') || ' uses.'
                  when v_mode = 'amount' and v_qty is not null and not public.stock_co__unit_fits(v_from, v_unit, null)
                    then 'Give the amount in a unit ' || coalesce(v_from_name, 'the item') || ' uses.'
                  end as problem
        from unnest(v_page[1:v_lim]) p(id)
        join stock_co_recipes r on r.id = p.id
        join lateral (select * from stock_co_recipe_lines x where x.recipe_id = r.id and x.component_item_id = v_from
                       order by x.sort_order, x.id limit 1) l on true
        left join stock_co_packs pk on pk.id = l.pack_id) z;
  if cardinality(v_page) > v_lim then
    select lower(r.name) as k, r.id into v_last from stock_co_recipes r where r.id = v_page[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id), 'total', v_total,
                              'words', format('%s recipes change at %s sites', coalesce(v_total, 0), coalesce(v_sites, 0)));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null, 'total', v_total,
                            'words', format('%s recipes change at %s sites', coalesce(v_total, 0), coalesce(v_sites, 0)));
end
$fn$;

-- Applies a swap or an amount change to the named recipes: every matching line of each recipe, the
-- recipe saved through stock_co__recipe_put (its row_version bumped, change log source 'swap'), then
-- today's cost rows and the facts of its linked products at every site. A recipe whose unit does not
-- fit is skipped and listed. Answers {"changed", "skipped": [{"recipe_id", "problem"}]}. Owner only.
create or replace function public.stock_co__swap_apply(p_org uuid, p_spec jsonb, p_recipe_ids uuid[], p_by jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_mode text := p_spec ->> 'mode';
  v_from uuid := (p_spec ->> 'from_item_id')::uuid;
  v_to uuid := nullif(p_spec ->> 'to_item_id', '')::uuid;
  v_qty numeric := nullif(p_spec ->> 'qty', '')::numeric;
  v_unit text := nullif(lower(btrim(coalesce(p_spec ->> 'unit', ''))), '');
  v_factor numeric := nullif(p_spec ->> 'factor', '')::numeric;
  v_rid uuid;
  v_lines jsonb;
  v_clean jsonb;
  v_sites uuid[];
  v_skipped jsonb := '[]'::jsonb;
  v_changed integer := 0;
  v_name text;
  v_bad boolean;
  v_site uuid;
  v_tick jsonb;
begin
  select i.name into v_name from stock_co_items i where i.id = case when v_mode = 'swap' then v_to else v_from end;
  foreach v_rid in array coalesce(p_recipe_ids, '{}'::uuid[]) loop
    continue when not exists (select 1 from stock_co_recipes r where r.id = v_rid and r.org_id = p_org and r.archived_at is null);
    select bool_or(case when v_mode = 'swap' then not public.stock_co__unit_fits(v_to, l.unit, l.pack_id)
                        when v_qty is not null then not public.stock_co__unit_fits(v_from, v_unit, null)
                        else false end)
      into v_bad
      from stock_co_recipe_lines l where l.recipe_id = v_rid and l.component_item_id = v_from;
    if coalesce(v_bad, false) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('recipe_id', v_rid,
                     'problem', 'Give the amount in a unit ' || coalesce(v_name, 'the item') || ' uses.'));
      continue;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'component_item_id', case when l.component_item_id = v_from and v_mode = 'swap' then v_to else l.component_item_id end,
             'qty', case when l.component_item_id = v_from and v_mode = 'amount' and v_qty is not null then v_qty
                         when l.component_item_id = v_from and v_mode = 'amount' and v_factor is not null then l.qty * v_factor
                         else l.qty end,
             'unit', case when l.component_item_id = v_from and v_mode = 'amount' and v_qty is not null then v_unit else l.unit end,
             'pack_id', case when l.component_item_id = v_from and v_mode = 'amount' and v_qty is not null then null else l.pack_id end,
             'usable_pct', l.usable_pct, 'note', l.note, 'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
      into v_lines
      from stock_co_recipe_lines l where l.recipe_id = v_rid;
    v_sites := public.stock_co__recipe_sites_of(v_rid);
    begin
      -- the new item ticked on at every site the recipe is on, so the site recipe can be written there
      if v_mode = 'swap' then
        foreach v_site in array coalesce(v_sites, '{}'::uuid[]) loop
          v_tick := public.stock_co__set_sites_at(array[v_to], v_site, 'add', p_by ->> 'name');
          if jsonb_array_length(coalesce(v_tick -> 'refused', '[]'::jsonb)) > 0 then
            raise exception 'Not written at %: % cannot be set up there.', (select l.name from locations l where l.id = v_site), v_name
              using errcode = '55000';
          end if;
        end loop;
      end if;
      v_clean := public.stock_co__recipe_lines_clean(p_org, v_sites[1], v_lines);
      perform public.stock_co__recipe_put(p_org, v_sites[1], jsonb_build_object('id', v_rid), v_clean, p_by, 'swap');
      perform public.stock_co__cost_rows(array[v_rid], null, null);
      perform public.stock_co__facts_rebuild_site(s.location_id, array[s.site_menu_item_id])
         from stock_co_recipe_sites s where s.recipe_id = v_rid and s.on_here and s.site_menu_item_id is not null;
      v_changed := v_changed + 1;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        raise;
      when sqlstate '55000' or sqlstate '22023' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('recipe_id', v_rid, 'problem', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('changed', v_changed, 'skipped', v_skipped);
end
$fn$;

-- One size of a recipe (Make sizes): a new company recipe '<name> (<size name>)' with every line scaled
-- by the factor, the same food kind, target and method, switched on at the same sites with no till link.
-- Answers {"id", "name"}. Owner only.
create or replace function public.stock_co__make_size(p_recipe uuid, p_size_name text, p_factor numeric, p_by jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r stock_co_recipes;
  v_lines jsonb;
  v_sites uuid[];
  v_put jsonb;
  v_loc uuid;
  v_name text;
begin
  select * into v_r from stock_co_recipes r where r.id = p_recipe;
  v_name := v_r.name || ' (' || btrim(p_size_name) || ')';
  v_sites := public.stock_co__recipe_sites_of(p_recipe);
  select coalesce(jsonb_agg(jsonb_build_object('component_item_id', l.component_item_id, 'qty', l.qty * p_factor, 'unit', l.unit,
                                               'pack_id', l.pack_id, 'usable_pct', l.usable_pct, 'note', l.note,
                                               'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
    into v_lines from stock_co_recipe_lines l where l.recipe_id = p_recipe;
  v_put := public.stock_co__recipe_put(v_r.org_id, v_sites[1],
             jsonb_build_object('name', v_name, 'kind', v_r.kind, 'food_kind', v_r.food_kind, 'meal_food_pct', v_r.meal_food_pct,
                                'yield_qty', v_r.yield_qty, 'yield_unit', v_r.yield_unit, 'wastage_pct', v_r.wastage_pct,
                                'gp_target_pct', v_r.gp_target_pct, 'method', v_r.method, 'photo', v_r.photo,
                                'portion_weight_g', case when v_r.portion_weight_g is not null then v_r.portion_weight_g * p_factor end,
                                'cooking_yield_pct', v_r.cooking_yield_pct, 'shelf_life_days', v_r.shelf_life_days,
                                'output_item_id', null, 'local_location_id', v_r.local_location_id),
             public.stock_co__recipe_lines_clean(v_r.org_id, v_sites[1], v_lines), p_by, 'make_sizes');
  foreach v_loc in array v_sites loop
    perform public.stock_co__recipe_on_at((v_put ->> 'id')::uuid, v_loc, null, 'Added by ' || coalesce(p_by ->> 'name', 'head office'),
                                          p_by ->> 'name');
  end loop;
  return jsonb_build_object('id', v_put ->> 'id', 'name', v_name);
end
$fn$;

-- One step of a Drop 2 save job (contract 1.8): set_recipe_sites (one site: the recipe on there),
-- msm_recipe (bookkeeping only), swap_ingredient (20 recipes a step), facts_rebuild (one site),
-- make_sizes (one size a step). Returns {"status", "progress"} as stock_co__d1_step does. Owner only.
create or replace function public.stock_co__d2_step(p_job bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  j stock_save_queue;
  v_done integer;
  v_total integer;
  v_ref jsonb;
  v_res jsonb;
  v_fin boolean := false;
  v_pl jsonb;
  v_ids uuid[];
  v_chunk uuid[];
  v_sizes jsonb;
  v_n integer;
begin
  select * into j from stock_save_queue q where q.id = p_job;
  v_done := coalesce((j.progress ->> 'done')::integer, 0);
  v_total := (j.progress ->> 'total')::integer;
  v_ref := case when jsonb_typeof(j.progress -> 'refused') = 'array' then j.progress -> 'refused' else '[]'::jsonb end;
  v_pl := j.payload;
  if j.kind = 'set_recipe_sites' then
    v_total := 1;
    v_res := public.stock_co__recipe_on_at((j.payload ->> 'recipe_id')::uuid, j.location_id, nullif(j.payload ->> 'menu_item_id', ''),
                                           j.payload ->> 'why', j.payload ->> 'by_name');
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      v_ref := v_ref || jsonb_build_array(jsonb_build_object('location_id', j.location_id, 'error', v_res ->> 'error'));
    end if;
    v_done := 1;
    v_fin := true;
  elsif j.kind = 'msm_recipe' then
    v_total := 0;
    v_fin := true;
  elsif j.kind = 'swap_ingredient' then
    v_ids := array(select lower(x)::uuid from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'recipe_ids') = 'array'
                                                                               then j.payload -> 'recipe_ids' else '[]'::jsonb end) x);
    v_total := cardinality(v_ids);
    v_chunk := v_ids[v_done + 1 : v_done + 20];
    if cardinality(v_chunk) > 0 then
      v_res := public.stock_co__swap_apply(j.org_id, j.payload -> 'spec', v_chunk, coalesce(j.payload -> 'by', '{}'::jsonb));
      v_ref := v_ref || coalesce(v_res -> 'skipped', '[]'::jsonb);
    end if;
    v_done := v_done + coalesce(cardinality(v_chunk), 0);
    v_fin := v_done >= v_total;
  elsif j.kind = 'facts_rebuild' then
    v_total := 1;
    v_res := public.stock_co__facts_rebuild_site(j.location_id,
               case when jsonb_typeof(j.payload -> 'menu_item_ids') = 'array'
                    then array(select jsonb_array_elements_text(j.payload -> 'menu_item_ids')) end);
    v_done := 1;
    v_fin := true;
  elsif j.kind = 'make_sizes' then
    v_sizes := case when jsonb_typeof(j.payload -> 'sizes') = 'array' then j.payload -> 'sizes' else '[]'::jsonb end;
    v_total := jsonb_array_length(v_sizes);
    if v_done < v_total then
      v_res := public.stock_co__make_size((j.payload ->> 'recipe_id')::uuid, v_sizes -> v_done ->> 'name',
                                          (v_sizes -> v_done ->> 'factor')::numeric, coalesce(j.payload -> 'by', '{}'::jsonb));
      v_done := v_done + 1;
    end if;
    v_fin := v_done >= v_total;
  else
    raise exception 'This database does not know this kind of save job.' using errcode = '22023';
  end if;
  if v_pl is distinct from j.payload then
    update stock_save_queue q set payload = v_pl where q.id = p_job;
  end if;
  return jsonb_build_object('status', case when v_fin then 'done' else 'waiting' end,
                            'progress', jsonb_build_object('done', v_done, 'total', greatest(coalesce(v_total, v_done), v_done),
                                                           'refused', (select coalesce(jsonb_agg(e order by o), '[]'::jsonb)
                                                                         from jsonb_array_elements(v_ref) with ordinality x(e, o) where o <= 50)));
end
$fn$;

-- ============================================================================
-- STEP 6. THE READS (contract 1.6 and 1.7): keyset pages of at most 100, never OFFSET
-- ============================================================================

-- The latest cost row of a recipe at a site (nightly, and written inline by every recipe save and site
-- tick). Owner only.
create or replace function public.stock_co__cost_row_of(p_recipe uuid, p_loc uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select to_jsonb(c) from recipe_cost_daily c
   where c.recipe_id = p_recipe and c.location_id = p_loc
   order by c.day desc limit 1;
$fn$;

-- The recipe list, company view and one site view (contract 1.7). Scope as stock_items_page.
create or replace function public.stock_recipes_page(p_org uuid, p_sites uuid[], p_search text default null, p_filters jsonb default null,
                                                     p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_f jsonb := public.stock_co__filter_keys(p_filters, array['kind', 'food_kind', 'on_at', 'not_at', 'below_target', 'check_waiting',
                                                            'not_linked', 'local', 'archived', 'ids']);
  v_scope uuid[];
  v_unlinked boolean;
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_k text;
  v_aid uuid;
  v_kind text;
  v_fk text;
  v_on_at uuid := public.stock_co__filter_uuid(v_f, 'on_at');
  v_not_at uuid := public.stock_co__filter_uuid(v_f, 'not_at');
  v_below boolean := coalesce(public.stock_co__filter_bool(v_f, 'below_target'), false);
  v_check boolean := coalesce(public.stock_co__filter_bool(v_f, 'check_waiting'), false);
  v_nolink boolean := coalesce(public.stock_co__filter_bool(v_f, 'not_linked'), false);
  v_local boolean := public.stock_co__filter_bool(v_f, 'local');
  v_arch boolean := coalesce(public.stock_co__filter_bool(v_f, 'archived'), false);
  v_only uuid[];
  v_ids uuid[];
  v_rows jsonb;
  v_total integer;
  v_last record;
begin
  if v_f ? 'kind' and jsonb_typeof(v_f -> 'kind') <> 'null' then
    v_kind := v_f ->> 'kind';
    if v_kind not in ('dish', 'batch', 'prep') then
      raise exception 'The filter "kind" must be one of: dish, batch, prep.' using errcode = '22023';
    end if;
  end if;
  if v_f ? 'food_kind' and jsonb_typeof(v_f -> 'food_kind') <> 'null' then
    v_fk := v_f ->> 'food_kind';
    if v_fk not in ('food', 'drink', 'meal_deal') then
      raise exception 'The filter "food_kind" must be one of: food, drink, meal_deal.' using errcode = '22023';
    end if;
  end if;
  if v_f ? 'ids' and jsonb_typeof(v_f -> 'ids') <> 'null' then
    if jsonb_typeof(v_f -> 'ids') <> 'array' or jsonb_array_length(v_f -> 'ids') > 100
       or exists (select 1 from jsonb_array_elements(v_f -> 'ids') x
                   where jsonb_typeof(x) <> 'string'
                      or (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'The filter "ids" must be a list of up to 100 recipes.' using errcode = '22023';
    end if;
    v_only := array(select lower(x)::uuid from jsonb_array_elements_text(v_f -> 'ids') x);
  end if;
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if v_not_at is not null and not (v_not_at = any(v_scope)) or v_on_at is not null and not (v_on_at = any(v_scope)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_unlinked := p_sites is null and public.stock_level(v_uid, p_org) = 'all';
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;

  with base as (
    select r.id, lower(r.name) as k
      from stock_co_recipes r
     where r.org_id = p_org
       and (v_only is null or r.id = any(v_only))
       and case when v_arch then r.archived_at is not null else r.archived_at is null end
       and (exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope))
            or r.local_location_id = any(v_scope)
            or (v_unlinked and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here)))
       and (v_kind is null or r.kind = v_kind)
       and (v_fk is null or r.food_kind = v_fk)
       and (v_local is null or (r.local_location_id is not null) = v_local)
       and (v_on_at is null or exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.location_id = v_on_at and s.on_here))
       and (v_not_at is null or not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.location_id = v_not_at and s.on_here))
       and (not v_nolink or exists (select 1 from stock_co_recipe_sites s
                                     where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope) and s.site_menu_item_id is null))
       and (not v_check or exists (select 1 from menu_item_stock_facts x
                                    where x.recipe_id = r.id and x.needs_check and x.location_id = any(v_scope::text[])))
       and (not v_below or (r.gp_target_pct is not null and exists (
              select 1 from stock_co_recipe_sites s
               cross join lateral (select c.gp_pct from recipe_cost_daily c
                                    where c.recipe_id = r.id and c.location_id = s.location_id order by c.day desc limit 1) c
               where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope) and c.gp_pct < r.gp_target_pct)))
       and (v_q is null or position(v_q in lower(r.name)) > 0
            or exists (select 1 from stock_co_recipe_sites s
                         join menu_items mi on mi.id = s.site_menu_item_id and mi.location_id = s.location_id::text
                        where s.recipe_id = r.id and s.location_id = any(v_scope) and position(v_q in lower(mi.name)) > 0))
  )
  select array(select b.id from base b
                where v_aid is null or (b.k, b.id) > (v_k, v_aid)
                order by b.k, b.id
                limit v_lim + 1),
         case when v_aid is null then (select count(*) from base)::integer end
    into v_ids, v_total;

  select coalesce(jsonb_agg(z.j order by z.o), '[]'::jsonb) into v_rows
    from (
      select o, jsonb_build_object(
               'id', r.id, 'name', r.name, 'kind', r.kind, 'food_kind', r.food_kind, 'local_location_id', r.local_location_id,
               'archived_at', r.archived_at, 'gp_target_pct', r.gp_target_pct, 'output_item_id', r.output_item_id,
               'output_item_name', (select i.name from stock_co_items i where i.id = r.output_item_id),
               'yield_qty', r.yield_qty, 'yield_unit', r.yield_unit, 'row_version', r.row_version,
               'sold_as', coalesce((select jsonb_agg(n.name order by n.name) from (
                                      select distinct mi.name from stock_co_recipe_sites s
                                        join menu_items mi on mi.id = s.site_menu_item_id and mi.location_id = s.location_id::text
                                       where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope)
                                       order by mi.name limit 3) n), '[]'::jsonb),
               'sites', st.sites, 'sites_on', st.sites_on, 'cost_avg', st.cost_avg, 'price_low', st.price_low, 'price_high', st.price_high,
               'gp_low', st.gp_low, 'gp_high', st.gp_high,
               'below_target', coalesce(r.gp_target_pct is not null and st.gp_low < r.gp_target_pct, false),
               'allergens', coalesce(st.allergens,
                                     (select to_jsonb(f.allergens) from public.stock_co__facts_of_recipe(r.id,
                                        (select s.location_id from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here
                                          order by s.location_id limit 1), '{}'::uuid[]) f
                                       where exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here)),
                                     '[]'::jsonb)) as j
        from unnest(v_ids[1 : v_lim]) with ordinality u(id, o)
        join stock_co_recipes r on r.id = u.id
        cross join lateral (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'location_id', s.location_id, 'on', true, 'menu_item_id', s.site_menu_item_id,
                   'menu_item_name', (select mi.name from menu_items mi where mi.id = s.site_menu_item_id and mi.location_id = s.location_id::text),
                   'how', s.how, 'cost', c.cost, 'cost_per_yield', c.cost_per_yield, 'sale_price', c.sale_price,
                   'sale_price_net', c.sale_price_net, 'gp_pct', c.gp_pct, 'day', c.day,
                   'needs_check', coalesce(fx.needs_check, false), 'allergens', coalesce(to_jsonb(fx.allergens), '[]'::jsonb))
                   order by s.location_id), '[]'::jsonb) as sites,
                 count(*)::integer as sites_on,
                 avg(c.cost) as cost_avg, min(c.sale_price) as price_low, max(c.sale_price) as price_high,
                 min(c.gp_pct) as gp_low, max(c.gp_pct) as gp_high,
                 (select to_jsonb(public.stock_co__allergen_ids(array_agg(a)))
                    from stock_co_recipe_sites s2
                    join menu_item_stock_facts fx2 on fx2.location_id = s2.location_id::text and fx2.menu_item_id = s2.site_menu_item_id
                   cross join unnest(fx2.allergens) a
                   where s2.recipe_id = r.id and s2.on_here and s2.location_id = any(v_scope)
                  having count(*) > 0) as allergens
            from stock_co_recipe_sites s
            left join lateral (select cd.cost, cd.cost_per_yield, cd.sale_price, cd.sale_price_net, cd.gp_pct, cd.day
                                 from recipe_cost_daily cd where cd.recipe_id = r.id and cd.location_id = s.location_id
                                order by cd.day desc limit 1) c on true
            left join menu_item_stock_facts fx on fx.location_id = s.location_id::text and fx.menu_item_id = s.site_menu_item_id
           where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope)
        ) st
    ) z;

  if cardinality(v_ids) > v_lim then
    select lower(r.name) as k, r.id into v_last from stock_co_recipes r where r.id = v_ids[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id), 'sites', to_jsonb(v_scope))
           || case when v_total is not null then jsonb_build_object('total', v_total) else '{}'::jsonb end;
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null, 'sites', to_jsonb(v_scope))
         || case when v_total is not null then jsonb_build_object('total', v_total) else '{}'::jsonb end;
end
$fn$;

-- One company recipe (contract 1.7): the row, lines with names, packs and units, every site in the
-- login's list on or off, option rules with their site resolution, the menu product.
create or replace function public.stock_recipe_detail(p_recipe uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
  v_r stock_co_recipes;
  v_scope uuid[];
  v_cost_site uuid;
  v_tot record;
begin
  perform public.stock_co__signed_in();
  v_id := public.stock_co__company_id('recipe', p_recipe);
  select * into v_r from stock_co_recipes r where r.id = v_id;
  if v_r.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_scope := public.stock_co__read_scope(v_r.org_id, null);
  select s.location_id into v_cost_site from stock_co_recipe_sites s
    join locations l on l.id = s.location_id
   where s.recipe_id = v_id and s.on_here and s.location_id = any(v_scope)
   order by l.name, l.id limit 1;
  if v_cost_site is not null then
    select * into v_tot from public.stock_co__recipe_total(v_id, v_cost_site, null);
  end if;
  return jsonb_build_object(
    'recipe', to_jsonb(v_r), 'row_version', v_r.row_version, 'local', v_r.local_location_id is not null,
    'editors', coalesce((select jsonb_agg(e.name order by e.name) from (
                           select distinct coalesce(p.full_name, p.email) as name from user_profiles p
                            where p.org_id = v_r.org_id and p.role = 'owner' limit 10) e), '[]'::jsonb),
    'cost_site', v_cost_site,
    'cost', case when v_cost_site is not null then jsonb_build_object('total', v_tot.total, 'yield_base', v_tot.yield_base,
                                                                      'per_yield', v_tot.per_yield, 'missing', v_tot.missing) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'component_item_id', l.component_item_id, 'name', i.name, 'base_unit', i.base_unit,
               'kind_at_site', (select ii.kind from stock_co_item_sites si join inventory_items ii on ii.id = si.site_item_id
                                 where si.item_id = l.component_item_id and si.location_id = v_cost_site),
               'qty', l.qty, 'unit', l.unit, 'pack_id', l.pack_id, 'pack_name', (select pk.name from stock_co_packs pk where pk.id = l.pack_id),
               'usable_pct', l.usable_pct, 'order_types', l.order_types, 'note', l.note, 'sort_order', l.sort_order,
               'packs', coalesce((select jsonb_agg(jsonb_build_object('id', pk.id, 'name', pk.name, 'qty_in_base', pk.qty_in_base)
                                                   order by pk.name, pk.id)
                                    from stock_co_packs pk where pk.item_id = l.component_item_id and pk.archived_at is null), '[]'::jsonb),
               'has_recipe', exists (select 1 from stock_co_recipes x join stock_co_recipe_sites xs on xs.recipe_id = x.id
                                      where x.output_item_id = l.component_item_id and x.archived_at is null
                                        and xs.location_id = v_cost_site and xs.on_here))
             order by l.sort_order, l.id)
        from stock_co_recipe_lines l left join stock_co_items i on i.id = l.component_item_id
       where l.recipe_id = v_id), '[]'::jsonb),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'location_id', l.id, 'name', l.name, 'on', coalesce(s.on_here, false),
               'site_recipe_id', case when s.on_here then s.site_recipe_id end,
               'menu_item_id', case when s.on_here then s.site_menu_item_id end,
               'menu_item_name', case when s.on_here then (select mi.name from menu_items mi where mi.id = s.site_menu_item_id and mi.location_id = l.id::text) end,
               'sale_price', case when s.on_here then pr.gross end, 'sale_price_net', case when s.on_here then pr.net end,
               'cost', case when s.on_here then (cr.cj ->> 'cost')::numeric end, 'gp_pct', case when s.on_here then (cr.cj ->> 'gp_pct')::numeric end,
               'price_for_target', case when s.on_here and v_r.gp_target_pct is not null and v_r.gp_target_pct < 100 and (cr.cj ->> 'cost') is not null
                                        then round((cr.cj ->> 'cost')::numeric / (1 - v_r.gp_target_pct / 100.0)
                                                   * case when pr.gross is not null and pr.net is not null and pr.net <> 0 then pr.gross / pr.net else 1 end, 2) end,
               'sold_7d', case when s.on_here then sd.qty end, 'sales_7d_net', case when s.on_here then sd.net end,
               'how', case when s.on_here then coalesce(s.how, (select si.supply_mode from stock_co_item_sites si
                                                                 where si.item_id = v_r.output_item_id and si.location_id = l.id)) end,
               'holds', case when s.on_here and v_r.output_item_id is not null then
                               (select ii.on_hand from stock_co_item_sites si join inventory_items ii on ii.id = si.site_item_id
                                 where si.item_id = v_r.output_item_id and si.location_id = l.id) end,
               'why_on', case when s.on_here then s.why_on end, 'linked_at', case when s.on_here then s.linked_at end,
               'link_row_version', s.row_version,
               'needs_check', coalesce(fx.needs_check, false), 'checked_by_name', fx.checked_by_name, 'checked_at', fx.checked_at)
             order by l.name, l.id)
        from locations l
        left join stock_co_recipe_sites s on s.recipe_id = v_id and s.location_id = l.id
        left join lateral (select public.stock_co__cost_row_of(v_id, l.id) as cj) cr on true
        left join lateral (select * from public.stock_co__menu_price_net(l.id, s.site_menu_item_id) where s.site_menu_item_id is not null) pr on true
        left join lateral (select sum(d.qty) as qty, sum(d.net) as net from sales_day_sums d
                            where s.site_menu_item_id is not null and d.location_id = l.id and d.menu_item_id = s.site_menu_item_id
                              and d.business_day between public.stock_co__today(l.id) - 6 and public.stock_co__today(l.id)) sd on true
        left join menu_item_stock_facts fx on fx.location_id = l.id::text and fx.menu_item_id = s.site_menu_item_id
       where l.id = any(v_scope)), '[]'::jsonb),
    'option_rules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ru.id, 'kind', ru.kind, 'option_name', ru.option_name, 'option_msm_product_id', ru.option_msm_product_id,
               'option_company_item_id', ru.option_company_item_id,
               'option_item_name', (select i.name from stock_co_items i where i.id = ru.option_company_item_id),
               'replaces_item_id', ru.replaces_item_id, 'replaces_item_name', (select i.name from stock_co_items i where i.id = ru.replaces_item_id),
               'removes_item_id', ru.removes_item_id, 'removes_item_name', (select i.name from stock_co_items i where i.id = ru.removes_item_id),
               'archived_at', ru.archived_at, 'row_version', ru.row_version,
               'sites', coalesce((select jsonb_agg(jsonb_build_object('location_id', rs.location_id, 'site_modifier_id', rs.site_modifier_id,
                                                                      'resolved_by', rs.resolved_by) order by rs.location_id)
                                    from stock_co_option_rule_sites rs where rs.rule_id = ru.id and rs.location_id = any(v_scope)), '[]'::jsonb))
             order by ru.option_name, ru.id)
        from stock_co_option_rules ru where ru.recipe_id = v_id), '[]'::jsonb),
    'menu_product', (select jsonb_build_object('id', mp.id, 'name', mp.name, 'menu_name', mm.name)
                       from msm_products mp join msm_menus mm on mm.id = mp.menu_id
                      where mp.id = v_r.msm_product_id and mm.org_id = v_r.org_id));
end
$fn$;

-- The cost of a recipe at each site (the SQL twin of costing.js computeRecipe, contract 1.7). p_sites null
-- = every site in reach where the recipe is on; at most 50.
create or replace function public.stock_recipe_cost(p_recipe uuid, p_sites uuid[] default null, p_order_type text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
  v_org uuid;
  v_scope uuid[];
  v_sites uuid[];
  v_rows jsonb := '[]'::jsonb;
  v_loc uuid;
  t record;
  v_sum numeric := 0;
  v_n integer := 0;
begin
  perform public.stock_co__signed_in();
  if p_sites is not null and cardinality(p_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  v_id := public.stock_co__company_id('recipe', p_recipe);
  select r.org_id into v_org from stock_co_recipes r where r.id = v_id;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_scope := public.stock_co__read_scope(v_org, p_sites);
  v_sites := array(select s.location_id from stock_co_recipe_sites s
                    where s.recipe_id = v_id and s.on_here and s.location_id = any(v_scope) order by s.location_id);
  if cardinality(v_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  foreach v_loc in array v_sites loop
    select * into t from public.stock_co__recipe_total(v_id, v_loc, p_order_type);
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'location_id', v_loc, 'total', t.total, 'yield_base', t.yield_base, 'per_yield', t.per_yield,
      'missing', coalesce((select jsonb_agg(jsonb_build_object('line_id', c.line_id, 'name', i.name, 'why', c.missing) order by c.line_id)
                             from public.stock_co__recipe_cost_at(v_id, v_loc, p_order_type) c
                             left join stock_co_items i on i.id = c.component_item_id
                            where c.missing is not null), '[]'::jsonb),
      'lines', coalesce((select jsonb_agg(jsonb_build_object('line_id', c.line_id, 'component_item_id', c.component_item_id,
                                                             'qty_base', c.qty_base, 'usable_pct', c.usable_pct, 'unit_cost', c.unit_cost,
                                                             'cost', c.cost))
                           from public.stock_co__recipe_cost_at(v_id, v_loc, p_order_type) c), '[]'::jsonb)));
    if t.total is not null and coalesce(t.missing, 0) = 0 then
      v_sum := v_sum + t.total;
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('rows', v_rows, 'avg', case when v_n > 0 then v_sum / v_n end);
end
$fn$;

-- The plate cost of every live till link at a site (useSiteCosts, useRecipeCosts, StockReports Recipe
-- GP): keyset on menu_item_id, at most 1,000 a call.
create or replace function public.stock_plate_costs(p_loc uuid, p_after text default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_rows jsonb;
  v_n integer;
  v_last text;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_loc;
  perform public.stock_co__read_scope(v_org, array[p_loc]);
  with page as (
    select m.menu_item_id, m.recipe_id as site_recipe_id, t.company_ref, m.portion
      from menu_item_recipes m
      join recipes t on t.id = m.recipe_id and t.archived_at is null
     where m.location_id = p_loc and (p_after is null or m.menu_item_id > p_after)
     order by m.menu_item_id
     limit v_lim
  )
  select coalesce(jsonb_agg(jsonb_build_object('menu_item_id', p.menu_item_id, 'site_recipe_id', p.site_recipe_id,
                                               'recipe_id', p.company_ref,
                                               'cost', case when p.company_ref is not null then
                                                         (select x.total * coalesce(p.portion, 1)
                                                            from public.stock_co__recipe_total(p.company_ref, p_loc, null) x) end)
                            order by p.menu_item_id), '[]'::jsonb),
         count(*)::integer, max(p.menu_item_id)
    into v_rows, v_n, v_last
    from page p;
  return jsonb_build_object('rows', v_rows, 'next', case when v_n >= v_lim then v_last end);
end
$fn$;

-- Recipe missing: till products that sold in the last 7 venue days at a scoped site with no live recipe
-- link, from sales_day_sums (never closed_checks), with the suggestion. Never links anything.
create or replace function public.stock_recipe_missing(p_org uuid, p_sites uuid[], p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_scope uuid[];
  v_av numeric;
  v_aloc uuid;
  v_aid text;
  v_rows jsonb;
  v_n integer;
  v_total integer;
  v_days integer;
  v_next jsonb;
begin
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_av := coalesce((p_after ->> 'v')::numeric, 0);
    v_aloc := (p_after ->> 'loc')::uuid;
    v_aid := p_after ->> 'id';
  end if;
  select count(distinct (d.location_id, d.business_day))::integer into v_days
    from unnest(v_scope) sc(loc)
    join sales_day_sums d on d.location_id = sc.loc
     and d.business_day between public.stock_co__today(sc.loc) - 6 and public.stock_co__today(sc.loc);
  with sold as (
    select d.location_id, d.menu_item_id, sum(d.qty) as sold, round(coalesce(sum(d.net), 0), 4) as net, max(d.business_day) as last_day
      from unnest(v_scope) sc(loc)
      cross join lateral (select public.stock_co__today(sc.loc) as today) t
      join sales_day_sums d on d.location_id = sc.loc and d.business_day between t.today - 6 and t.today
     group by d.location_id, d.menu_item_id
    having coalesce(sum(d.qty), 0) > 0
  ), missing as (
    select x.* from sold x
     where not exists (select 1 from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
                        where m.location_id = x.location_id and m.menu_item_id = x.menu_item_id)
       and exists (select 1 from menu_items mi where mi.id = x.menu_item_id and mi.location_id = x.location_id::text
                      and coalesce(mi.archived, false) = false)
  ), page as (
    select x.*, row_number() over (order by x.net desc, x.location_id, x.menu_item_id) as o
      from missing x
     where v_aid is null or x.net < v_av or (x.net = v_av and (x.location_id, x.menu_item_id) > (v_aloc, v_aid))
     order by x.net desc, x.location_id, x.menu_item_id
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', n.location_id, 'site_name', l.name, 'menu_item_id', n.menu_item_id, 'name', mi.name,
           'sold_7d', n.sold, 'sales_7d_net', n.net, 'last_sold_day', n.last_day,
           'suggested', (select jsonb_build_object('recipe_id', mr.recipe_id, 'name', r.name, 'how', mr.how, 'price_diff_pct', mr.price_diff_pct)
                           from public.stock_co__match_recipe(n.location_id, n.menu_item_id) mr
                           join stock_co_recipes r on r.id = mr.recipe_id limit 1))
           order by n.o) filter (where n.o <= v_lim), '[]'::jsonb),
         count(*)::integer,
         (array_agg(jsonb_build_object('v', n.net, 'loc', n.location_id, 'id', n.menu_item_id)) filter (where n.o = v_lim))[1],
         case when v_aid is null then (select count(*) from missing)::integer end
    into v_rows, v_n, v_next, v_total
    from page n
    join locations l on l.id = n.location_id
    left join menu_items mi on mi.id = n.menu_item_id and mi.location_id = n.location_id::text;
  return jsonb_build_object('rows', v_rows, 'days_held', coalesce(v_days, 0),
                            'next', case when v_n > v_lim then v_next end)
         || case when v_total is not null then jsonb_build_object('total', v_total) else '{}'::jsonb end;
end
$fn$;

-- The Allergens and nutrition tab of one recipe, per site (contract 1.7). A site with no till link still
-- gets a row (facts from the recipe, menu_item_id null).
create or replace function public.stock_recipe_facts(p_recipe uuid, p_sites uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
  v_org uuid;
  v_scope uuid[];
  v_rows jsonb := '[]'::jsonb;
  s record;
  f record;
  v_from jsonb;
begin
  perform public.stock_co__signed_in();
  v_id := public.stock_co__company_id('recipe', p_recipe);
  select r.org_id into v_org from stock_co_recipes r where r.id = v_id;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_scope := public.stock_co__read_scope(v_org, p_sites);
  for s in
    select rs.location_id, l.name as site_name, rs.site_menu_item_id
      from stock_co_recipe_sites rs join locations l on l.id = rs.location_id
     where rs.recipe_id = v_id and rs.on_here and rs.location_id = any(v_scope)
     order by l.name, l.id
     limit 50
  loop
    select coalesce(jsonb_agg(jsonb_build_object('item_name', i.name, 'supplier_name', fi.supplier_name, 'allergens', to_jsonb(fi.allergens),
                                                 'may_contain', to_jsonb(fi.may_contain), 'changed_at', fi.changed_at)
                              order by i.name, i.id), '[]'::jsonb)
      into v_from
      from (select distinct l.component_item_id from stock_co_recipe_lines l where l.recipe_id = v_id and l.component_item_id is not null) c
      join stock_co_items i on i.id = c.component_item_id
      cross join lateral public.stock_co__facts_of_item(c.component_item_id, s.location_id) fi;
    if s.site_menu_item_id is not null and exists (select 1 from menu_item_stock_facts x
                                                    where x.location_id = s.location_id::text and x.menu_item_id = s.site_menu_item_id) then
      select coalesce(v_rows, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'location_id', s.location_id, 'site_name', s.site_name, 'menu_item_id', x.menu_item_id,
               'menu_item_name', (select mi.name from menu_items mi where mi.id = x.menu_item_id and mi.location_id = x.location_id),
               'allergens', to_jsonb(x.allergens), 'recipe_allergens', to_jsonb(x.recipe_allergens), 'typed_allergens', to_jsonb(x.typed_allergens),
               'may_contain', to_jsonb(x.may_contain), 'diets', to_jsonb(x.diets), 'kcal', x.kcal, 'kcal_complete', x.kcal_complete,
               'portion_g', x.portion_g, 'nutrition', x.nutrition, 'ingredients_text', x.ingredients_text, 'needs_check', x.needs_check,
               'check_words', x.check_words, 'checked_by_name', x.checked_by_name, 'checked_at', x.checked_at, 'from', v_from))
        into v_rows
        from menu_item_stock_facts x where x.location_id = s.location_id::text and x.menu_item_id = s.site_menu_item_id;
    else
      select * into f from public.stock_co__facts_of_recipe(v_id, s.location_id, '{}'::uuid[]);
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
               'location_id', s.location_id, 'site_name', s.site_name, 'menu_item_id', null, 'menu_item_name', null,
               'allergens', to_jsonb(coalesce(f.allergens, '{}'::text[])), 'recipe_allergens', to_jsonb(coalesce(f.recipe_allergens, '{}'::text[])),
               'typed_allergens', '[]'::jsonb, 'may_contain', to_jsonb(coalesce(f.may_contain, '{}'::text[])),
               'diets', to_jsonb(coalesce(f.diets, '{}'::text[])), 'kcal', f.kcal, 'kcal_complete', coalesce(f.kcal_complete, false),
               'portion_g', f.portion_g, 'nutrition', f.nutrition, 'ingredients_text', f.ingredients_text, 'needs_check', false,
               'check_words', null, 'checked_by_name', null, 'checked_at', null, 'from', v_from));
    end if;
  end loop;
  return jsonb_build_object('rows', v_rows);
end
$fn$;

-- The recipe card for staff: the build and the method, the allergens and calories, never a cost or a
-- price. A signed in login needs the site in reach; an anonymous session only when it is a bound staff
-- device at that site (a pos, kds or handheld devices row, or a claimed active ops_devices row);
-- everything else anonymous is refused. Method and photo are null when the recipe is restricted.
create or replace function public.stock_recipe_card(p_loc uuid, p_menu_item_id text default null, p_recipe uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_r stock_co_recipes;
  v_fx menu_item_stock_facts;
  f record;
  v_menu text := nullif(btrim(coalesce(p_menu_item_id, '')), '');
begin
  if p_loc is null then
    raise exception 'Sign in to see recipe cards.' using errcode = '42501';
  end if;
  if v_uid is null or public.is_anon_session() then
    if v_uid is null or not (
         exists (select 1 from devices d where d.device_uid = v_uid and d.location_id = p_loc and d.type in ('pos', 'kds', 'handheld'))
         or exists (select 1 from ops_devices o where o.device_uid = v_uid and o.location_id = p_loc and o.active and o.claimed_at is not null)) then
      raise exception 'Sign in to see recipe cards.' using errcode = '42501';
    end if;
  else
    select l.org_id into v_org from locations l where l.id = p_loc;
    perform public.stock_co__read_scope(v_org, array[p_loc]);
  end if;
  if p_recipe is not null then
    v_id := public.stock_co__company_id('recipe', p_recipe);
  elsif v_menu is not null then
    select t.company_ref into v_id from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
     where m.location_id = p_loc and m.menu_item_id = v_menu;
  end if;
  select * into v_r from stock_co_recipes r
   where r.id = v_id and r.org_id = (select l.org_id from locations l where l.id = p_loc)
     and exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.location_id = p_loc and s.on_here);
  if v_r.id is null then
    return jsonb_build_object('recipe_id', null, 'name', null, 'build', '[]'::jsonb, 'method', '[]'::jsonb);
  end if;
  if v_menu is null then
    select s.site_menu_item_id into v_menu from stock_co_recipe_sites s where s.recipe_id = v_r.id and s.location_id = p_loc;
  end if;
  select * into v_fx from menu_item_stock_facts x where x.location_id = p_loc::text and x.menu_item_id = v_menu;
  select * into f from public.stock_co__facts_of_recipe(v_r.id, p_loc, '{}'::uuid[]);
  return jsonb_build_object(
    'recipe_id', v_r.id, 'name', v_r.name, 'kind', v_r.kind, 'restricted', v_r.restricted,
    'photo', case when v_r.restricted then null else v_r.photo end,
    'portion_words', case when v_r.portion_weight_g is not null then trim_scale(round(v_r.portion_weight_g, 1))::text || ' g'
                          when v_r.kind = 'dish' and coalesce(v_r.yield_qty, 1) = 1 and coalesce(v_r.yield_unit, 'each') = 'each' then '1 plate'
                          else trim_scale(round(coalesce(v_r.yield_qty, 1), 3))::text || ' ' || coalesce(nullif(v_r.yield_unit, ''), 'each') end,
    'build', coalesce((select jsonb_agg(jsonb_build_object('qty', trim_scale(l.qty),
                                                           'unit', case when l.unit = '@' then (select pk.name from stock_co_packs pk where pk.id = l.pack_id) else l.unit end,
                                                           'name', i.name) order by l.sort_order, l.id)
                         from stock_co_recipe_lines l left join stock_co_items i on i.id = l.component_item_id
                        where l.recipe_id = v_r.id), '[]'::jsonb),
    'method', case when v_r.restricted or nullif(btrim(coalesce(v_r.method, '')), '') is null then '[]'::jsonb
                   else coalesce((select jsonb_agg(btrim(regexp_replace(x, '^\s*[0-9]+[.)]\s*', '')) order by o)
                                    from regexp_split_to_table(v_r.method, '\n\s*\n|\n(?=\s*[0-9]+[.)]\s)') with ordinality t(x, o)
                                   where btrim(x) <> ''), '[]'::jsonb) end,
    'allergens', to_jsonb(coalesce(v_fx.allergens, f.allergens, '{}'::text[])),
    'may_contain', to_jsonb(coalesce(v_fx.may_contain, f.may_contain, '{}'::text[])),
    'kcal', coalesce(v_fx.kcal, f.kcal),
    'use_by_days', v_r.shelf_life_days,
    'ingredients_text', coalesce(v_fx.ingredients_text, f.ingredients_text),
    'signed_off', coalesce(v_fx.checked_at is not null and not v_fx.needs_check, false));
end
$fn$;

-- The Prep list of one site for a venue day: made items the site makes in batches, what to make
-- (expected use minus on hand minus what is scheduled or planned), and the Done ticks.
create or replace function public.stock_prep_list(p_loc uuid, p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_day date;
  v_dow integer;
  v_rows jsonb;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_loc;
  perform public.stock_co__read_scope(v_org, array[p_loc]);
  v_day := coalesce(p_day, public.stock_co__today(p_loc));
  v_dow := extract(dow from v_day)::integer;
  with made as (
    select r.id as recipe_id, s.site_recipe_id, si.site_item_id as output_item_id, r.name, ii.base_unit as unit, ii.on_hand
      from stock_co_recipe_sites s
      join stock_co_recipes r on r.id = s.recipe_id and r.archived_at is null and r.kind in ('batch', 'prep') and r.output_item_id is not null
      join stock_co_item_sites si on si.item_id = r.output_item_id and si.location_id = p_loc and si.supply_mode = 'batches'
      join inventory_items ii on ii.id = si.site_item_id
     where s.location_id = p_loc and s.on_here
     order by lower(r.name), r.id
     limit 1000
  ), use as (
    select u.inventory_item_id, coalesce(u.by_dow[v_dow + 1], 0) as expected
      from public.stock_usage_weekday_page(p_loc, 8, null, null, null) u
     where u.inventory_item_id in (select m.output_item_id from made m)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'recipe_id', m.recipe_id, 'site_recipe_id', m.site_recipe_id, 'output_item_id', m.output_item_id, 'name', m.name,
           'unit', m.unit, 'on_hand', m.on_hand, 'expected', round(coalesce(u.expected, 0), 4),
           'scheduled', sc.qty, 'planned', pl.qty,
           'make', round(greatest(0, coalesce(u.expected, 0) - coalesce(m.on_hand, 0) - coalesce(sc.qty, 0) - coalesce(pl.qty, 0)), 4),
           'done_qty', coalesce(tk.qty, 0), 'ticks', coalesce(tk.ticks, '[]'::jsonb))
           order by lower(m.name), m.recipe_id), '[]'::jsonb)
    into v_rows
    from made m
    left join use u on u.inventory_item_id = m.output_item_id
    left join lateral (select coalesce(sum(p.qty), 0) as qty from prep_schedule p
                        where p.location_id = p_loc and p.active and p.output_item_id = m.output_item_id
                          and (p.days_of_week is null or v_dow = any(p.days_of_week))) sc on true
    left join lateral (select coalesce(sum(b.planned_qty), 0) as qty from production_batches b
                        where b.location_id = p_loc and b.output_item_id = m.output_item_id and b.status = 'PLANNED'
                          and coalesce(b.planned_for, b.created_at::date) = v_day) pl on true
    left join lateral (select sum(t.qty) as qty,
                              jsonb_agg(jsonb_build_object('id', t.id, 'qty', t.qty, 'by_name', t.done_by_name, 'at', t.done_at) order by t.done_at, t.id) as ticks
                         from stock_prep_ticks t
                        where t.location_id = p_loc and t.business_day = v_day and t.recipe_id = m.recipe_id) tk on true;
  return jsonb_build_object('business_day', v_day, 'rows', v_rows);
end
$fn$;

-- Batch and prep recipes by site with each site's how and what it holds (contract 1.7).
create or replace function public.stock_batch_how(p_org uuid, p_sites uuid[], p_search text default null, p_after jsonb default null,
                                                  p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_scope uuid[];
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_k text;
  v_aid uuid;
  v_ids uuid[];
  v_rows jsonb;
  v_last record;
begin
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  v_ids := array(
    select r.id from stock_co_recipes r
     where r.org_id = p_org and r.archived_at is null and r.kind in ('batch', 'prep')
       and (exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.on_here and s.location_id = any(v_scope))
            or r.local_location_id = any(v_scope))
       and (v_q is null or position(v_q in lower(r.name)) > 0)
       and (v_aid is null or (lower(r.name), r.id) > (v_k, v_aid))
     order by lower(r.name), r.id
     limit v_lim + 1);
  select coalesce(jsonb_agg(jsonb_build_object(
           'recipe_id', r.id, 'name', r.name,
           'yield_words', trim_scale(round(coalesce(r.yield_qty, 1), 3))::text || ' ' || coalesce(nullif(r.yield_unit, ''), 'each'),
           'output_item_id', r.output_item_id, 'output_item_name', (select i.name from stock_co_items i where i.id = r.output_item_id),
           'row_version', r.row_version,
           'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                              'location_id', sc.loc, 'on', coalesce(s.on_here, false),
                              'how', case when coalesce(s.on_here, false) then coalesce(s.how, si.supply_mode) end,
                              'holds', case when coalesce(s.on_here, false) then ii.on_hand end, 'unit', ii.base_unit)
                              order by sc.o), '[]'::jsonb)
                       from unnest(v_scope) with ordinality sc(loc, o)
                       left join stock_co_recipe_sites s on s.recipe_id = r.id and s.location_id = sc.loc
                       left join stock_co_item_sites si on si.item_id = r.output_item_id and si.location_id = sc.loc
                       left join inventory_items ii on ii.id = si.site_item_id))
           order by u.o), '[]'::jsonb)
    into v_rows
    from unnest(v_ids[1 : v_lim]) with ordinality u(id, o)
    join stock_co_recipes r on r.id = u.id;
  if cardinality(v_ids) > v_lim then
    select lower(r.name) as k, r.id into v_last from stock_co_recipes r where r.id = v_ids[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null);
end
$fn$;

-- The Menu product picker: menu products of the company's menus. Read only.
create or replace function public.stock_recipe_menu_products(p_org uuid, p_search text default null, p_after jsonb default null,
                                                             p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_k text;
  v_aid uuid;
  v_ids uuid[];
  v_rows jsonb;
  v_last record;
begin
  perform public.stock_co__read_scope(p_org, null);
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  v_ids := array(
    select mp.id from msm_products mp join msm_menus mm on mm.id = mp.menu_id
     where mm.org_id = p_org and not coalesce(mp.archived, false)
       and (v_q is null or position(v_q in lower(mp.name)) > 0)
       and (v_aid is null or (lower(mp.name), mp.id) > (v_k, v_aid))
     order by lower(mp.name), mp.id
     limit v_lim + 1);
  select coalesce(jsonb_agg(jsonb_build_object('id', mp.id, 'name', mp.name, 'menu_name', mm.name,
                                               'sites', (select count(*) from msm_product_sites ps where ps.product_id = mp.id and ps.active))
                            order by u.o), '[]'::jsonb)
    into v_rows
    from unnest(v_ids[1 : v_lim]) with ordinality u(id, o)
    join msm_products mp on mp.id = u.id join msm_menus mm on mm.id = mp.menu_id;
  if cardinality(v_ids) > v_lim then
    select lower(mp.name) as k, mp.id into v_last from msm_products mp where mp.id = v_ids[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null);
end
$fn$;

-- ============================================================================
-- STEP 7. THE SAVES (contract 1.6 and 1.8): recipes, options, sizes, swaps, links, how and site ticks
-- need company; prep ticks and Checked need site_facts
-- ============================================================================

-- How one site gets a batch or prep recipe's made item: bought in, made here in batches, or made to
-- order. Made to order is refused while the site holds the item. Writes stock_co_recipe_sites.how, the
-- item's supply_mode at that site and, through the writer, inventory_items.kind. Owner only.
create or replace function public.stock_co__set_how(p_recipe uuid, p_loc uuid, p_how text, p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r stock_co_recipes;
  v_si stock_co_item_sites;
  v_ii inventory_items;
  v_lname text;
  v_old text;
  v_src text := coalesce(nullif(public.stock_co__d1_source(), ''), 'save');
begin
  if p_how is null or p_how not in ('bought', 'batches', 'to_order') then
    raise exception 'The field "how" must be one of: bought, batches, to_order.' using errcode = '22023';
  end if;
  select * into v_r from stock_co_recipes r where r.id = p_recipe;
  if v_r.kind not in ('batch', 'prep') or v_r.output_item_id is null then
    raise exception 'Only a batch or prep recipe with a made item has a how.' using errcode = '22023';
  end if;
  select * into v_si from stock_co_item_sites s where s.item_id = v_r.output_item_id and s.location_id = p_loc for update;
  if v_si.item_id is null then
    raise exception 'Tick the recipe on at this site first.' using errcode = '55000';
  end if;
  select * into v_ii from inventory_items i where i.id = v_si.site_item_id;
  select l.name into v_lname from locations l where l.id = p_loc;
  if p_how = 'to_order' and coalesce(v_ii.on_hand, 0) > 0 then
    raise exception '% still holds % % of %. Use it up or count it to zero first, then switch to Made to order.',
      v_lname, trim_scale(round(v_ii.on_hand, 3)), v_ii.base_unit, v_ii.name using errcode = '55000';
  end if;
  select s.how into v_old from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
  update stock_co_recipe_sites s set how = p_how, row_version = s.row_version + 1, updated_at = now()
   where s.recipe_id = p_recipe and s.location_id = p_loc and s.how is distinct from p_how;
  if found then
    perform public.stock_co__log(p_org, p_loc, 'recipe_site', p_recipe, 'how', to_jsonb(v_old), to_jsonb(p_how), v_src);
  end if;
  if v_si.supply_mode is distinct from p_how then
    update stock_co_item_sites s set supply_mode = p_how, row_version = s.row_version + 1, updated_at = now()
     where s.item_id = v_si.item_id and s.location_id = p_loc;
    perform public.stock_co__log(p_org, p_loc, 'item_site', v_si.item_id, 'supply_mode', to_jsonb(v_si.supply_mode), to_jsonb(p_how), v_src);
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  perform public.stock_co__sync_site(p_loc, array[v_si.item_id], '{}'::uuid[], true, false);
  return jsonb_build_object('ok', true, 'location_id', p_loc, 'how', p_how);
end
$fn$;

-- Tick a company recipe on and off per site (contract 1.8). Need company with every named site.
create or replace function public.stock_set_recipe_sites(p_recipe uuid, p_changes jsonb, p_version integer, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_r stock_co_recipes;
  v_section text;
  v_g jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_e jsonb;
  v_c jsonb;
  v_locs uuid[] := '{}'::uuid[];
  v_loc uuid;
  v_res jsonb;
  v_sites jsonb := '[]'::jsonb;
  v_ref jsonb := '[]'::jsonb;
  v_queued jsonb := '[]'::jsonb;
  v_first boolean := true;
  v_rv integer;
  v_by text;
  v_q bigint;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'The field "changes" must be a list of sites.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  for v_e in select e.value from jsonb_array_elements(p_changes) e loop
    v_c := public.stock_co__clean('recipe_site_change', v_e);
    if (v_c ->> 'location_id') is null then
      raise exception 'Each site needs its location_id.' using errcode = '22023';
    end if;
    v_changes := v_changes || jsonb_build_array(v_c);
    v_locs := v_locs || (v_c ->> 'location_id')::uuid;
  end loop;
  select * into v_r from stock_co_recipes x where x.id = v_id;
  v_section := public.stock_co__section(p_section,
                 case when v_r.output_item_id is not null then array['produce', 'inventory'] else array['produce'] end);
  v_g := public.stock_co__guard(v_r.org_id, v_section, 'company', v_locs);
  v_by := coalesce(nullif(btrim(coalesce(v_g ->> 'name', '')), ''), 'head office');
  select * into v_r from stock_co_recipes x where x.id = v_id for update;
  perform public.stock_co__need_version('company', p_version);
  if p_version is not null and v_r.row_version is distinct from p_version then
    return public.stock_co__conflict(v_r.org_id, array['recipe', 'recipe_site', 'menu_link'], v_id, v_r.row_version, v_locs[1], v_r.updated_at);
  end if;
  if v_r.archived_at is not null then
    raise exception 'This recipe is archived, so it cannot be linked.' using errcode = '55000';
  end if;
  for v_c in select e.value from jsonb_array_elements(v_changes) e loop
    v_loc := (v_c ->> 'location_id')::uuid;
    v_res := null;
    if v_c ? 'on' and not (v_c ->> 'on')::boolean then
      v_res := public.stock_co__recipe_off_at(v_id, v_loc, v_by);
      v_sites := v_sites || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'on', false, 'site_recipe_id', v_res ->> 'site_recipe_id',
                                                                  'menu_item_id', null, 'items_added', 0));
    elsif (v_c ? 'on' and (v_c ->> 'on')::boolean) or v_c ? 'menu_item_id' then
      if not v_first and clock_timestamp() - v_t0 > interval '1.5 seconds' then
        v_q := public.stock_co__d2_enqueue(v_r.org_id, v_loc, 'set_recipe_sites',
                 jsonb_build_object('recipe_id', v_id, 'menu_item_id', v_c ->> 'menu_item_id', 'why', 'Added by ' || v_by, 'by_name', v_by),
                 array[v_id]);
        v_queued := v_queued || jsonb_build_array(jsonb_build_object('job_id', v_q, 'location_id', v_loc));
      else
        v_res := public.stock_co__recipe_on_at(v_id, v_loc, v_c ->> 'menu_item_id', 'Added by ' || v_by, v_by);
        if coalesce((v_res ->> 'ok')::boolean, false) then
          v_sites := v_sites || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'on', true, 'site_recipe_id', v_res ->> 'site_recipe_id',
                                                                      'menu_item_id', v_res ->> 'menu_item_id',
                                                                      'items_added', coalesce((v_res ->> 'items_added')::integer, 0)));
        else
          v_ref := v_ref || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'error', v_res ->> 'error'));
        end if;
      end if;
      v_first := false;
    end if;
    if v_c ? 'portion' and (v_res is null or coalesce((v_res ->> 'ok')::boolean, false)) then
      update menu_item_recipes m set portion = (v_c ->> 'portion')::numeric
        from stock_co_recipe_sites s
       where s.recipe_id = v_id and s.location_id = v_loc and m.location_id = v_loc and m.recipe_id = s.site_recipe_id
         and m.portion is distinct from (v_c ->> 'portion')::numeric;
    end if;
    if v_c ? 'how' then
      begin
        perform public.stock_co__set_how(v_id, v_loc, v_c ->> 'how', v_r.org_id);
      exception when sqlstate '55000' or sqlstate '22023' then
        v_ref := v_ref || jsonb_build_array(jsonb_build_object('location_id', v_loc, 'error', sqlerrm));
      end;
    end if;
  end loop;
  update stock_co_recipes x set row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where x.id = v_id returning x.row_version into v_rv;
  return jsonb_build_object('ok', true, 'row_version', v_rv, 'sites', v_sites, 'refused', v_ref, 'queued', v_queued);
end
$fn$;

-- Many till links at once (Recipe missing): each recipe switched on at that site when it is not, then
-- linked. At most 200. Need company. Nothing is ever linked without this call.
create or replace function public.stock_recipe_link_products(p_links jsonb, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['produce']);
  v_e jsonb;
  v_c jsonb;
  v_org uuid;
  v_locs uuid[] := '{}'::uuid[];
  v_g jsonb;
  v_by text;
  v_res jsonb;
  v_rid uuid;
  v_linked integer := 0;
  v_ref jsonb := '[]'::jsonb;
  v_list jsonb := '[]'::jsonb;
begin
  perform public.stock_co__signed_in();
  if p_links is null or jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) = 0 then
    raise exception 'The field "links" must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_links) > 200 then
    raise exception 'Link up to 200 products at a time.' using errcode = '22023';
  end if;
  for v_e in select e.value from jsonb_array_elements(p_links) e loop
    v_c := public.stock_co__clean('recipe_link', v_e);
    if (v_c ->> 'location_id') is null or (v_c ->> 'recipe_id') is null or nullif(v_c ->> 'menu_item_id', '') is null then
      raise exception 'Each link needs its site, till product and recipe.' using errcode = '22023';
    end if;
    v_list := v_list || jsonb_build_array(v_c);
    v_locs := v_locs || (v_c ->> 'location_id')::uuid;
  end loop;
  select l.org_id into v_org from locations l where l.id = v_locs[1];
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', v_locs);
  v_by := coalesce(nullif(btrim(coalesce(v_g ->> 'name', '')), ''), 'head office');
  for v_c in select e.value from jsonb_array_elements(v_list) e loop
    v_rid := public.stock_co__company_id('recipe', (v_c ->> 'recipe_id')::uuid);
    if v_rid is null or not exists (select 1 from stock_co_recipes r where r.id = v_rid and r.org_id = v_org) then
      v_ref := v_ref || jsonb_build_array(jsonb_build_object('location_id', v_c ->> 'location_id', 'menu_item_id', v_c ->> 'menu_item_id',
                                                              'error', 'That recipe is not in this company.'));
      continue;
    end if;
    v_res := public.stock_co__recipe_on_at(v_rid, (v_c ->> 'location_id')::uuid, v_c ->> 'menu_item_id',
                                           'Linked under Recipe missing by ' || v_by, v_by);
    if coalesce((v_res ->> 'ok')::boolean, false) then
      update stock_co_recipe_sites s set why_on = 'Linked under Recipe missing by ' || v_by
       where s.recipe_id = v_rid and s.location_id = (v_c ->> 'location_id')::uuid;
      v_linked := v_linked + 1;
    else
      v_ref := v_ref || jsonb_build_array(jsonb_build_object('location_id', v_c ->> 'location_id', 'menu_item_id', v_c ->> 'menu_item_id',
                                                              'error', v_res ->> 'error'));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'linked', v_linked, 'refused', v_ref, 'queued', '[]'::jsonb);
end
$fn$;

-- One how per site for a batch or prep recipe (contract 1.8). Need company. Version = the recipe's.
create or replace function public.stock_batch_set_how(p_recipe uuid, p_loc uuid, p_how text, p_version integer, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_r stock_co_recipes;
  v_g jsonb;
  v_rv integer;
begin
  if v_id is null or p_loc is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_r from stock_co_recipes x where x.id = v_id;
  v_g := public.stock_co__guard(v_r.org_id, public.stock_co__section(p_section, array['produce', 'inventory']), 'company', array[p_loc]);
  select * into v_r from stock_co_recipes x where x.id = v_id for update;
  perform public.stock_co__need_version('company', p_version);
  if p_version is not null and v_r.row_version is distinct from p_version then
    return public.stock_co__conflict(v_r.org_id, array['recipe', 'recipe_site'], v_id, v_r.row_version, p_loc, v_r.updated_at);
  end if;
  perform public.stock_co__set_how(v_id, p_loc, p_how, v_r.org_id);
  update stock_co_recipes x set row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where x.id = v_id returning x.row_version into v_rv;
  return jsonb_build_object('ok', true, 'location_id', p_loc, 'how', p_how, 'row_version', v_rv);
end
$fn$;

-- Create or edit a replace or remove rule of a company dish (contract 1.8). Need company.
create or replace function public.stock_save_option_rule(p_rule jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['produce']);
  v_d jsonb := public.stock_co__clean('option_rule', p_rule);
  v_old stock_co_option_rules;
  v_rid uuid;
  v_r stock_co_recipes;
  v_g jsonb;
  v_kind text;
  v_opt uuid;
  v_rep uuid;
  v_rem uuid;
  v_name text;
  v_id uuid;
  v_rv integer;
  v_sites jsonb;
  v_loc uuid;
  v_bad uuid;
begin
  perform public.stock_co__signed_in();
  if (v_d ->> 'id') is not null then
    select * into v_old from stock_co_option_rules x where x.id = (v_d ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_rid := public.stock_co__company_id('recipe', coalesce((v_d ->> 'recipe_id')::uuid, v_old.recipe_id));
  select * into v_r from stock_co_recipes x where x.id = v_rid;
  if v_r.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_old.id is not null and v_old.recipe_id <> v_r.id then
    raise exception 'A rule stays with its recipe.' using errcode = '22023';
  end if;
  v_loc := coalesce(public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_r.id and s.on_here)
                                                  || v_r.local_location_id),
                    public.stock_co__org_site(v_r.org_id));
  v_g := public.stock_co__guard(v_r.org_id, v_section, 'company', array[v_loc]);
  if v_r.kind <> 'dish' or v_r.archived_at is not null then
    raise exception 'Option rules belong to a live dish.' using errcode = '22023';
  end if;
  v_kind := coalesce(v_d ->> 'kind', v_old.kind);
  v_name := nullif(btrim(coalesce(v_d ->> 'option_name', v_old.option_name, '')), '');
  v_opt := case when v_d ? 'option_company_item_id' then (v_d ->> 'option_company_item_id')::uuid else v_old.option_company_item_id end;
  v_rep := case when v_d ? 'replaces_item_id' then (v_d ->> 'replaces_item_id')::uuid else v_old.replaces_item_id end;
  v_rem := case when v_d ? 'removes_item_id' then (v_d ->> 'removes_item_id')::uuid else v_old.removes_item_id end;
  if v_kind is null or v_name is null then
    raise exception 'Name the option and say if it replaces or removes an item.' using errcode = '22023';
  end if;
  if v_kind = 'replace' then
    v_rem := null;
    if v_opt is null or v_rep is null then
      raise exception 'A replace rule needs the item it adds and the item it replaces.' using errcode = '22023';
    end if;
    if v_opt = v_rep then
      raise exception 'The new item must be different from the one it replaces.' using errcode = '22023';
    end if;
  else
    v_opt := null;
    v_rep := null;
    if v_rem is null then
      raise exception 'A remove rule needs the item it takes off.' using errcode = '22023';
    end if;
  end if;
  select x into v_bad from unnest(array[v_opt, v_rep, v_rem]) x
   where x is not null and not exists (select 1 from stock_co_items i where i.id = x and i.org_id = v_r.org_id) limit 1;
  if v_bad is not null then
    raise exception 'That stock item is not in this company.' using errcode = '22023';
  end if;
  if coalesce(v_rep, v_rem) is not null
     and not exists (select 1 from stock_co_recipe_lines l where l.recipe_id = v_r.id and l.component_item_id = coalesce(v_rep, v_rem)) then
    raise exception 'The recipe does not use %.', (select i.name from stock_co_items i where i.id = coalesce(v_rep, v_rem)) using errcode = '22023';
  end if;
  if (v_d ->> 'option_msm_product_id') is not null
     and not exists (select 1 from msm_products mp join msm_menus mm on mm.id = mp.menu_id
                      where mp.id = (v_d ->> 'option_msm_product_id')::uuid and mm.org_id = v_r.org_id) then
    raise exception 'That menu product is not in this company.' using errcode = '22023';
  end if;
  if v_old.id is null then
    insert into stock_co_option_rules (org_id, recipe_id, kind, option_name, option_msm_product_id, option_company_item_id,
                                       replaces_item_id, removes_item_id, updated_by)
    values (v_r.org_id, v_r.id, v_kind, v_name, (v_d ->> 'option_msm_product_id')::uuid, v_opt, v_rep, v_rem, (v_g ->> 'uid')::uuid)
    returning id, row_version into v_id, v_rv;
    perform public.stock_co__log(v_r.org_id, null, 'option_rule', v_id, 'created', null,
                                 jsonb_build_object('kind', v_kind, 'option_name', v_name), 'save');
  else
    select * into v_old from stock_co_option_rules x where x.id = v_old.id for update;
    perform public.stock_co__need_version('company', p_version);
    if p_version is not null and v_old.row_version is distinct from p_version then
      return public.stock_co__conflict(v_r.org_id, array['option_rule'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
    update stock_co_option_rules x
       set kind = v_kind, option_name = v_name,
           option_msm_product_id = case when v_d ? 'option_msm_product_id' then (v_d ->> 'option_msm_product_id')::uuid else x.option_msm_product_id end,
           option_company_item_id = v_opt, replaces_item_id = v_rep, removes_item_id = v_rem,
           row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
     where x.id = v_old.id
     returning x.id, x.row_version into v_id, v_rv;
    perform public.stock_co__log(v_r.org_id, null, 'option_rule', v_id, 'rule',
                                 jsonb_build_object('kind', v_old.kind, 'option_name', v_old.option_name, 'option_company_item_id', v_old.option_company_item_id,
                                                    'replaces_item_id', v_old.replaces_item_id, 'removes_item_id', v_old.removes_item_id),
                                 jsonb_build_object('kind', v_kind, 'option_name', v_name, 'option_company_item_id', v_opt,
                                                    'replaces_item_id', v_rep, 'removes_item_id', v_rem), 'save');
  end if;
  v_sites := public.stock_co__option_rule_sites(v_id, v_d -> 'site_modifiers');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'sites', v_sites -> 'sites', 'not_found', v_sites -> 'not_found');
end
$fn$;

-- Archives (never deletes) an option rule; the drainer skips archived rules. Need company.
create or replace function public.stock_archive_option_rule(p_id uuid, p_version integer, p_archived boolean default true,
                                                            p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_co_option_rules;
  v_loc uuid;
  v_at timestamptz;
  v_rv integer;
  v_g jsonb;
begin
  perform public.stock_co__signed_in();
  select * into v_old from stock_co_option_rules x where x.id = p_id;
  if v_old.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_loc := coalesce(public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_old.recipe_id and s.on_here)),
                    public.stock_co__org_site(v_old.org_id));
  v_g := public.stock_co__guard(v_old.org_id, public.stock_co__section(p_section, array['produce']), 'company', array[v_loc]);
  select * into v_old from stock_co_option_rules x where x.id = p_id for update;
  perform public.stock_co__need_version('company', p_version);
  if p_version is not null and v_old.row_version is distinct from p_version then
    return public.stock_co__conflict(v_old.org_id, array['option_rule'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
  end if;
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_option_rules x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where x.id = p_id returning x.row_version into v_rv;
  perform public.stock_co__log(v_old.org_id, null, 'option_rule', p_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), 'save');
  return jsonb_build_object('ok', true, 'id', p_id, 'archived_at', v_at, 'row_version', v_rv);
end
$fn$;

-- Swap one ingredient for another, or change its amount, across many recipes (contract 1.8). Preview
-- first; apply inline up to 200 recipes, else queued. Need company.
create or replace function public.stock_swap_ingredient(p_spec jsonb, p_preview boolean default true, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['produce']);
  v_d jsonb := public.stock_co__clean('swap_spec', p_spec);
  v_from stock_co_items;
  v_g jsonb;
  v_plan jsonb;
  v_ids uuid[];
  v_res jsonb;
  v_q bigint;
  v_rows jsonb;
begin
  perform public.stock_co__signed_in();
  select * into v_from from stock_co_items i where i.id = (v_d ->> 'from_item_id')::uuid;
  if v_from.id is null then
    raise exception 'Name the stock item to change.' using errcode = '22023';
  end if;
  if coalesce(v_d ->> 'mode', '') not in ('swap', 'amount') then
    raise exception 'The field "mode" must be swap or amount.' using errcode = '22023';
  end if;
  if v_d ->> 'mode' = 'swap' and ((v_d ->> 'to_item_id') is null
       or not exists (select 1 from stock_co_items i where i.id = (v_d ->> 'to_item_id')::uuid and i.org_id = v_from.org_id and i.archived_at is null)) then
    raise exception 'That stock item is not in this company.' using errcode = '22023';
  end if;
  if v_d ->> 'mode' = 'amount' and (((v_d ->> 'qty') is not null and (v_d ->> 'unit') is not null) = ((v_d ->> 'factor') is not null)) then
    raise exception 'Give a new amount and unit, or a factor to multiply by.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_from.org_id, v_section, 'company',
                                array[coalesce(public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s
                                                                                   where s.item_id = v_from.id and s.on_here)),
                                               public.stock_co__org_site(v_from.org_id))]);
  v_plan := public.stock_co__swap_plan(v_d, null, 200);
  if coalesce(p_preview, true) then
    return jsonb_build_object('ok', true, 'preview', true, 'rows', v_plan -> 'rows', 'total', v_plan -> 'total', 'words', v_plan -> 'words',
                              'changed', 0, 'queued', '[]'::jsonb);
  end if;
  v_ids := array(select r.id from stock_co_recipes r
                  where r.org_id = v_from.org_id and r.archived_at is null
                    and exists (select 1 from stock_co_recipe_lines l where l.recipe_id = r.id and l.component_item_id = v_from.id)
                    and (jsonb_typeof(v_d -> 'recipe_ids') is distinct from 'array'
                         or r.id::text in (select lower(x) from jsonb_array_elements_text(v_d -> 'recipe_ids') x))
                  order by lower(r.name), r.id);
  if cardinality(v_ids) > 200 then
    v_q := public.stock_co__d2_enqueue(v_from.org_id, null, 'swap_ingredient',
             jsonb_build_object('spec', v_d, 'recipe_ids', to_jsonb(v_ids), 'after', null, 'by', v_g), v_ids);
    return jsonb_build_object('ok', true, 'preview', false, 'rows', '[]'::jsonb, 'total', cardinality(v_ids), 'changed', 0,
                              'queued', jsonb_build_array(jsonb_build_object('job_id', v_q)));
  end if;
  v_res := public.stock_co__swap_apply(v_from.org_id, v_d, v_ids, v_g);
  return jsonb_build_object('ok', true, 'preview', false, 'rows', coalesce(v_res -> 'skipped', '[]'::jsonb), 'total', cardinality(v_ids),
                            'changed', coalesce((v_res ->> 'changed')::integer, 0), 'queued', '[]'::jsonb);
end
$fn$;

-- One new company recipe per size, every line scaled by the factor, on at the same sites with no till
-- link. At most 10 sizes. Need company. One transaction, one version check.
create or replace function public.stock_make_sizes(p_recipe uuid, p_sizes jsonb, p_version integer, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_r stock_co_recipes;
  v_g jsonb;
  v_e jsonb;
  v_c jsonb;
  v_list jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_res jsonb;
  v_loc uuid;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_sizes is null or jsonb_typeof(p_sizes) <> 'array' or jsonb_array_length(p_sizes) = 0 then
    raise exception 'Name at least one size.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_sizes) > 10 then
    raise exception 'Make up to 10 sizes at a time.' using errcode = '22023';
  end if;
  for v_e in select e.value from jsonb_array_elements(p_sizes) e loop
    v_c := public.stock_co__clean('size_spec', v_e);
    if nullif(btrim(coalesce(v_c ->> 'name', '')), '') is null or (v_c ->> 'factor') is null then
      raise exception 'Each size needs a name and a factor.' using errcode = '22023';
    end if;
    v_list := v_list || jsonb_build_array(v_c);
  end loop;
  select * into v_r from stock_co_recipes x where x.id = v_id;
  v_loc := coalesce(public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id and s.on_here)
                                                  || v_r.local_location_id),
                    public.stock_co__org_site(v_r.org_id));
  v_g := public.stock_co__guard(v_r.org_id, public.stock_co__section(p_section, array['produce']), 'company',
                                coalesce(nullif(public.stock_co__recipe_sites_of(v_id), '{}'::uuid[]), array[v_loc]));
  select * into v_r from stock_co_recipes x where x.id = v_id for update;
  perform public.stock_co__need_version('company', p_version);
  if p_version is not null and v_r.row_version is distinct from p_version then
    return public.stock_co__conflict(v_r.org_id, array['recipe'], v_id, v_r.row_version, v_loc, v_r.updated_at);
  end if;
  for v_c in select e.value from jsonb_array_elements(v_list) e loop
    v_res := public.stock_co__make_size(v_id, v_c ->> 'name', (v_c ->> 'factor')::numeric, v_g);
    v_out := v_out || jsonb_build_array(v_res);
  end loop;
  return jsonb_build_object('ok', true, 'recipes', v_out);
end
$fn$;

-- A Done tick on the prep list, with who, on the venue business day. Need site_facts. A tick is not a
-- stock number.
create or replace function public.stock_prep_tick(p_loc uuid, p_recipe uuid, p_qty numeric, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_r stock_co_recipes;
  v_day date;
  v_tick uuid;
  v_sid uuid;
  v_out uuid;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, public.stock_co__section(p_section, array['produce', 'inventory']), 'site_facts', array[p_loc]);
  if p_qty is null or p_qty <= 0 then
    raise exception 'The amount must be more than 0.' using errcode = '22023';
  end if;
  select * into v_r from stock_co_recipes x where x.id = v_id and x.org_id = v_org;
  select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = v_id and s.location_id = p_loc and s.on_here;
  if v_r.id is null or v_sid is null then
    raise exception 'That recipe is not on at this site.' using errcode = '55000';
  end if;
  select si.site_item_id into v_out from stock_co_item_sites si where si.item_id = v_r.output_item_id and si.location_id = p_loc;
  v_day := public.stock_co__today(p_loc);
  insert into stock_prep_ticks (org_id, location_id, business_day, recipe_id, site_recipe_id, output_item_id, qty, done_by, done_by_name)
  values (v_org, p_loc, v_day, v_id, v_sid, v_out, p_qty, (v_g ->> 'uid')::uuid, v_g ->> 'name')
  returning id into v_tick;
  return jsonb_build_object('ok', true, 'id', v_tick, 'business_day', v_day,
                            'done_qty', (select sum(t.qty) from stock_prep_ticks t
                                          where t.location_id = p_loc and t.business_day = v_day and t.recipe_id = v_id));
end
$fn$;

-- Takes back one tick of the current venue day. Need site_facts.
create or replace function public.stock_prep_untick(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_prep_ticks;
begin
  perform public.stock_co__signed_in();
  select * into v_t from stock_prep_ticks t where t.id = p_id;
  if v_t.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_t.org_id, public.stock_co__section(null, array['produce', 'inventory']), 'site_facts', array[v_t.location_id]);
  if v_t.business_day <> public.stock_co__today(v_t.location_id) then
    raise exception 'That tick is from an earlier day.' using errcode = '55000';
  end if;
  delete from stock_prep_ticks t where t.id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id,
                            'done_qty', coalesce((select sum(t.qty) from stock_prep_ticks t
                                                   where t.location_id = v_t.location_id and t.business_day = v_t.business_day
                                                     and t.recipe_id = v_t.recipe_id), 0));
end
$fn$;

-- Checked: someone looked at the allergens of a till product at a site. The shown set becomes what was
-- typed union what the recipe says now, the warning clears, who and when are stamped. Need site_facts.
create or replace function public.stock_facts_signoff(p_loc uuid, p_menu_item_id text, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_x menu_item_stock_facts;
  v_typed text[];
  f record;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or nullif(btrim(coalesce(p_menu_item_id, '')), '') is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, public.stock_co__section(p_section, array['produce', 'inventory']), 'site_facts', array[p_loc]);
  perform public.stock_co__facts_rebuild_site(p_loc, array[p_menu_item_id]);
  select * into v_x from menu_item_stock_facts x where x.location_id = p_loc::text and x.menu_item_id = p_menu_item_id for update;
  if v_x.menu_item_id is null then
    raise exception 'That till product has no recipe here yet.' using errcode = '55000';
  end if;
  v_typed := public.stock_co__allergen_ids((select mi.allergens from menu_items mi where mi.id = p_menu_item_id and mi.location_id = p_loc::text));
  if v_x.recipe_id is not null then
    select * into f from public.stock_co__facts_of_recipe(v_x.recipe_id, p_loc, '{}'::uuid[]);
  end if;
  update menu_item_stock_facts x
     set allergens = public.stock_co__allergen_ids(coalesce(v_typed, '{}'::text[]) || coalesce(x.recipe_allergens, '{}'::text[])),
         typed_allergens = coalesce(v_typed, '{}'::text[]), needs_check = false, check_words = null,
         checked_by = (v_g ->> 'uid')::uuid, checked_by_name = v_g ->> 'name', checked_at = now(),
         facts_hash = coalesce(f.facts_hash, x.facts_hash), updated_at = now()
   where x.location_id = p_loc::text and x.menu_item_id = p_menu_item_id
  returning * into v_x;
  return jsonb_build_object('ok', true, 'allergens', to_jsonb(v_x.allergens), 'checked_at', v_x.checked_at, 'checked_by_name', v_x.checked_by_name);
end
$fn$;

-- ============================================================================
-- STEP 8. THE SERVICE ROLE'S JOBS: facts rebuild, the Multi site menu queue, the nightly recipes
-- ============================================================================

create or replace function public.stock_facts_rebuild(p_location uuid, p_menu_item_ids text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_res jsonb;
begin
  if p_location is null or not exists (select 1 from locations l where l.id = p_location) then
    raise exception 'That site was not found.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  v_res := public.stock_co__facts_rebuild_site(p_location, p_menu_item_ids);
  return jsonb_build_object('location_id', p_location, 'rows', v_res -> 'rows', 'needs_check', v_res -> 'needs_check',
                            'ms', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
end
$fn$;

-- Reads at most 50 finished Multi site menu site runs after the cursor and makes one job per new venue
-- product whose menu product has a company recipe ('skipped' with words when it has none). Never writes
-- a menu table; moves the cursor to the last row read.
create or replace function public.stock_msm_recipe_scan()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  c stock_msm_recipe_cursor;
  v record;
  w jsonb;
  v_item text;
  v_prod uuid;
  v_org uuid;
  v_loc uuid;
  v_recipe uuid;
  v_scanned integer := 0;
  v_jobs integer := 0;
  v_skipped integer := 0;
  v_last record;
begin
  select * into c from stock_msm_recipe_cursor where one for update;
  if c.one is null then
    insert into stock_msm_recipe_cursor (one, finished_at, scanned_at) values (true, now(), now()) returning * into c;
  end if;
  for v in
    select vs.version_id, vs.location_id, vs.finished_at, vs.writes
      from msm_version_sites vs
     where vs.status in ('done', 'nothing') and vs.finished_at is not null
       and (vs.finished_at > c.finished_at
            or (vs.finished_at = c.finished_at
                and (vs.version_id, vs.location_id) > (coalesce(c.version_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(c.location_id, ''))))
     order by vs.finished_at, vs.version_id, vs.location_id
     limit 50
  loop
    v_scanned := v_scanned + 1;
    v_last := v;
    if v.location_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      continue;
    end if;
    v_loc := v.location_id::uuid;
    select l.org_id into v_org from locations l where l.id = v_loc;
    continue when v_org is null;
    for w in select e.value from jsonb_array_elements(case when jsonb_typeof(v.writes) = 'array' then v.writes else '[]'::jsonb end) e loop
      continue when coalesce(w ->> 'table', '') <> 'items' or jsonb_typeof(w -> 'before') is distinct from 'null'
                    and (w -> 'before') is not null;
      v_item := nullif(w ->> 'id', '');
      continue when v_item is null;
      select ps.product_id into v_prod from msm_product_sites ps where ps.location_id = v.location_id and ps.venue_item_id = v_item;
      continue when v_prod is null;
      select r.id into v_recipe from stock_co_recipes r
       where r.org_id = v_org and r.msm_product_id = v_prod and r.archived_at is null
       order by r.updated_at desc, r.id limit 1;
      if v_recipe is not null then
        insert into stock_msm_recipe_jobs (org_id, location_id, version_id, menu_item_id, msm_product_id, recipe_id)
        values (v_org, v_loc, v.version_id, v_item, v_prod, v_recipe)
        on conflict (version_id, location_id, menu_item_id) do nothing;
        if found then v_jobs := v_jobs + 1; end if;
      else
        insert into stock_msm_recipe_jobs (org_id, location_id, version_id, menu_item_id, msm_product_id, status, reason, done_at)
        values (v_org, v_loc, v.version_id, v_item, v_prod, 'skipped', 'No company recipe for this menu product.', now())
        on conflict (version_id, location_id, menu_item_id) do nothing;
        if found then v_skipped := v_skipped + 1; end if;
      end if;
    end loop;
  end loop;
  if v_last.finished_at is not null then
    update stock_msm_recipe_cursor x set finished_at = v_last.finished_at, version_id = v_last.version_id,
                                         location_id = v_last.location_id, scanned_at = now()
     where x.one;
  else
    update stock_msm_recipe_cursor x set scanned_at = now() where x.one;
  end if;
  return jsonb_build_object('scanned', v_scanned, 'jobs', v_jobs, 'skipped', v_skipped,
                            'cursor', (select jsonb_build_object('finished_at', x.finished_at, 'version_id', x.version_id, 'location_id', x.location_id)
                                         from stock_msm_recipe_cursor x where x.one));
end
$fn$;

-- Runs the waiting Multi site menu jobs due now: a product that has ever sold at the site is left for
-- Recipe missing (never linked by itself); otherwise the company recipe is switched on there with the
-- till product linked. A refusal in words lands in reason; failed after 5 tries. Never touches a menu.
create or replace function public.stock_msm_recipe_run(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  j stock_msm_recipe_jobs;
  v_res jsonb;
  v_ran integer := 0;
  v_done integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
begin
  for j in
    select * from stock_msm_recipe_jobs x
     where x.status = 'waiting' and x.due_at <= now()
     order by x.due_at, x.id
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  loop
    v_ran := v_ran + 1;
    if exists (select 1 from sales_day_sums d where d.location_id = j.location_id and d.menu_item_id = j.menu_item_id and coalesce(d.qty, 0) > 0) then
      update stock_msm_recipe_jobs x set status = 'skipped', reason = 'Already selling here with no recipe. Link it under Recipe missing.',
                                         attempts = x.attempts + 1, done_at = now()
       where x.id = j.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if exists (select 1 from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
                where m.location_id = j.location_id and m.menu_item_id = j.menu_item_id) then
      update stock_msm_recipe_jobs x set status = 'skipped', reason = 'This till product already has a recipe here.',
                                         attempts = x.attempts + 1, done_at = now()
       where x.id = j.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if j.recipe_id is null or not exists (select 1 from stock_co_recipes r where r.id = j.recipe_id and r.archived_at is null) then
      update stock_msm_recipe_jobs x set status = 'skipped', reason = 'No company recipe for this menu product.',
                                         attempts = x.attempts + 1, done_at = now()
       where x.id = j.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    perform set_config('servos.stock_co_write', txid_current()::text, true);
    begin
      v_res := public.stock_co__recipe_on_at(j.recipe_id, j.location_id, j.menu_item_id, 'Added by the Multi site menu', 'Multi site menu');
    exception when others then
      v_res := jsonb_build_object('ok', false, 'error', sqlerrm);
    end;
    if coalesce((v_res ->> 'ok')::boolean, false) then
      update stock_msm_recipe_jobs x set status = 'done', reason = null, attempts = x.attempts + 1, done_at = now(), last_error = null
       where x.id = j.id;
      v_done := v_done + 1;
    else
      update stock_msm_recipe_jobs x
         set attempts = x.attempts + 1, reason = left(v_res ->> 'error', 400), last_error = left(v_res ->> 'error', 400),
             status = case when x.attempts + 1 >= 5 then 'failed' else 'waiting' end,
             due_at = now() + interval '1 minute',
             done_at = case when x.attempts + 1 >= 5 then now() end
       where x.id = j.id;
      if j.attempts + 1 >= 5 then v_failed := v_failed + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ran', v_ran, 'done', v_done, 'skipped', v_skipped, 'failed', v_failed);
end
$fn$;

-- One site's nightly recipe work: today's cost rows for every live recipe on there, the facts of every
-- linked till product, and two health counts written as plain lines. Under 8 s at 3,000 recipes.
create or replace function public.stock_nightly_recipes(p_location uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_day date;
  v_ids uuid[];
  v_costed integer;
  v_facts jsonb;
  v_bad integer;
  v_arch integer;
  v_lines jsonb;
begin
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'That site was not found.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  v_day := public.stock_co__today(p_location);
  v_ids := array(select s.recipe_id from stock_co_recipe_sites s join stock_co_recipes r on r.id = s.recipe_id and r.archived_at is null
                  where s.location_id = p_location and s.on_here order by s.recipe_id);
  v_costed := case when cardinality(v_ids) > 0 then public.stock_co__cost_rows(v_ids, array[p_location], v_day) else 0 end;
  v_facts := public.stock_co__facts_rebuild_site(p_location, null);
  select count(*)::integer into v_bad
    from recipe_lines rl
    join recipes t on t.id = rl.recipe_id and t.archived_at is null
   where rl.location_id = p_location and left(rl.unit, 1) = '@'
     and not exists (select 1 from item_packaging_formats f
                      where f.id::text = substr(rl.unit, 2) and f.inventory_item_id = rl.component_item_id);
  select count(*)::integer into v_arch
    from stock_co_recipe_lines l
    join stock_co_recipes r on r.id = l.recipe_id and r.archived_at is null
    join stock_co_recipe_sites s on s.recipe_id = r.id and s.location_id = p_location and s.on_here
    left join stock_co_items i on i.id = l.component_item_id
    left join stock_co_packs pk on pk.id = l.pack_id
   where i.archived_at is not null or pk.archived_at is not null;
  v_lines := '[]'::jsonb;
  if v_bad > 0 then
    v_lines := v_lines || to_jsonb(format('%s recipe lines use another site''s pack.', v_bad));
  end if;
  if v_arch > 0 then
    v_lines := v_lines || to_jsonb(format('%s recipe lines use an archived item, pack or unit bridge.', v_arch));
  end if;
  update stock_co_site_health h
     set lines = coalesce((select jsonb_agg(e) from jsonb_array_elements(case when jsonb_typeof(h.lines) = 'array' then h.lines else '[]'::jsonb end) e
                            where (e #>> '{}') not like '% recipe lines use %'), '[]'::jsonb) || v_lines
   where h.location_id = p_location;
  return jsonb_build_object('location_id', p_location, 'business_day', v_day, 'recipes_costed', v_costed,
                            'facts_rows', v_facts -> 'rows', 'needs_check', v_facts -> 'needs_check',
                            'bad_pack_lines', v_bad, 'archived_under_live', v_arch);
end
$fn$;

-- REBUILT (Drop 2): textarray values for allergens and may_contain go through stock_co__allergen_ids
-- (normalised, distinct, at most 40); diets are lower case ids from stock_co__diet_ids (an unknown one is
-- refused in words); object:nutrition is cleaned through the nutrition target. Everything else exactly
-- as Drop 1.
create or replace function public.stock_co__clean(p_target text, p_data jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_allowed jsonb := public.stock_co__allowed(p_target);
  v_out jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  t text;
  s text;
  n numeric;
  d date;
begin
  if v_allowed is null then
    raise exception 'Unknown kind of stock save: %', coalesce(p_target, 'none') using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) = 'null' then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_data) <> 'object' then
    raise exception 'A stock save needs its fields.' using errcode = '22023';
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_data) e loop
    t := v_allowed ->> k;
    if t is null then
      if p_target like '%\_patch' then
        raise exception 'The field "%" cannot be changed here yet.', k using errcode = '22023';
      end if;
      raise exception 'The field "%" cannot be changed here.', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then
      -- a record id sent as null is the same as not sent (a new record)
      if k in ('id', 'location_id', 'item_id', 'supplier_id', 'site_item_id', 'site_supplier_id', 'site_supplier_product_id',
               'site_pack_id', 'site_bridge_id', 'site_recipe_id', 'component_item_id', 'site_component_item_id') then
        continue;
      end if;
      if t = 'bool' or k in ('name', 'base_unit', 'qty_in_base', 'from_qty', 'to_qty', 'from_unit', 'to_unit', 'inner_unit',
                             'pack_qty', 'inner_qty', 'pack_price', 'recipe_type', 'yield_qty', 'currency') then
        raise exception 'The field "%" cannot be empty.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, null);
      continue;
    end if;
    if t like 'object:%' then
      if jsonb_typeof(v) <> 'object' then
        raise exception 'The field "%" must be a group of fields.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, public.stock_co__clean(substr(t, 8), v));
      continue;
    end if;
    if t = 'array' then
      if jsonb_typeof(v) <> 'array' then
        raise exception 'The field "%" must be a list.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, v);
      continue;
    end if;
    if t = 'textarray' then
      if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
        raise exception 'The field "%" must be a list of text.', k using errcode = '22023';
      end if;
      -- Drop 2: allergens and may contain are normalised ids (the kioskAllergens.js twin), at most 40; diets are
      -- the ids ServOS knows
      if k in ('allergens', 'may_contain') then
        if (select count(*) from jsonb_array_elements_text(v) e where btrim(e) <> '') > 40 then
          raise exception 'The field "%" can hold up to 40 values.', k using errcode = '22023';
        end if;
        v_out := v_out || jsonb_build_object(k, to_jsonb(public.stock_co__allergen_ids(array(select e from jsonb_array_elements_text(v) e))));
        continue;
      end if;
      if k = 'diets' then
        if exists (select 1 from jsonb_array_elements_text(v) e
                    where btrim(e) <> '' and not (lower(btrim(e)) = any(public.stock_co__diet_ids()))) then
          raise exception 'The field "diets" has a diet ServOS does not know: %.',
            (select btrim(e) from jsonb_array_elements_text(v) e
              where btrim(e) <> '' and not (lower(btrim(e)) = any(public.stock_co__diet_ids())) limit 1)
            using errcode = '22023';
        end if;
        v_out := v_out || jsonb_build_object(k, (select coalesce(jsonb_agg(distinct lower(btrim(e))), '[]'::jsonb)
                                                    from jsonb_array_elements_text(v) e where btrim(e) <> ''));
        continue;
      end if;
      v_out := v_out || jsonb_build_object(k, (select coalesce(jsonb_agg(btrim(e)), '[]'::jsonb)
                                                  from jsonb_array_elements_text(v) e where btrim(e) <> ''));
      continue;
    end if;
    if jsonb_typeof(v) in ('object', 'array') then
      raise exception 'The field "%" must be a single value.', k using errcode = '22023';
    end if;
    s := btrim(v #>> '{}');
    if t = 'text' then
      if k = 'name' and coalesce(s, '') = '' then
        raise exception 'A name cannot be empty.' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, nullif(s, ''));
    elsif t = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'The field "%" must be yes or no.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, v);
    elsif t = 'uuid' then
      if s !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'The field "%" is not a valid id.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lower(s));
    elsif t = 'unit' then
      if not exists (select 1 from stock_units u where u.code = lower(s)) then
        raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', s using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lower(s));
    elsif t like 'enum:%' then
      if not (s = any(string_to_array(substr(t, 6), '|'))) then
        raise exception 'The field "%" must be one of: %.', k, replace(substr(t, 6), '|', ', ') using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif t = 'currency' then
      if upper(s) !~ '^[A-Z]{3}$' then
        raise exception 'The field "%" must be a three letter currency code such as GBP.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, upper(s));
    elsif t = 'date' then
      -- an empty date box is the same as no date
      if coalesce(s, '') = '' then
        v_out := v_out || jsonb_build_object(k, null);
        continue;
      end if;
      d := null;
      if s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        begin
          d := s::date;
        exception when others then
          d := null;
        end;
      end if;
      if d is null or to_char(d, 'YYYY-MM-DD') <> s then
        raise exception 'The field "%" must be a date such as 2026-11-03.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, s);
    elsif t = 'time' then
      if coalesce(s, '') = '' then
        v_out := v_out || jsonb_build_object(k, null);
        continue;
      end if;
      if s !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'The field "%" must be a time such as 14:00.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lpad(s, 5, '0'));
    elsif t = 'pct' then
      if coalesce(s, '') = '' then
        v_out := v_out || jsonb_build_object(k, null);
        continue;
      end if;
      n := null;
      begin
        n := s::numeric;
      exception when others then
        n := null;
      end;
      if n is null or n < 0 or n > 100 then
        raise exception 'The field "%" must be a percent from 0 to 100.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, to_jsonb(n));
    else
      -- an empty number box is the same as no number
      if coalesce(s, '') = '' then
        if k in ('qty_in_base', 'from_qty', 'to_qty', 'pack_qty', 'inner_qty', 'pack_price', 'yield_qty') then
          raise exception 'The field "%" cannot be empty.', k using errcode = '22023';
        end if;
        v_out := v_out || jsonb_build_object(k, null);
        continue;
      end if;
      begin
        n := s::numeric;
      exception when others then
        raise exception 'The field "%" must be a number.', k using errcode = '22023';
      end;
      if t = 'int' and (n <> trunc(n) or n < 0) then
        raise exception 'The field "%" must be a whole number, 0 or more.', k using errcode = '22023';
      end if;
      if t = 'pos' and n <= 0 then
        raise exception 'The field "%" must be more than 0.', k using errcode = '22023';
      end if;
      if t = 'money' and n < 0 then
        raise exception 'A price cannot be below 0.' using errcode = '22023';
      end if;
      if t = 'nonneg' and n < 0 then
        raise exception 'The field "%" cannot be below 0.', k using errcode = '22023';
      end if;
      if t = 'rate' and (n < 0 or n >= 1) then
        raise exception 'A VAT rate is a fraction such as 0.2 for 20%%.' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, case when t = 'int' then to_jsonb(trunc(n)::integer)
                                                   when t = 'money' then to_jsonb(round(n, 4))
                                                   else to_jsonb(n) end);
    end if;
  end loop;
  return v_out;
end
$fn$;


-- REBUILT (Drop 2): (a) "sites" on create only ([{"location_id", "on", "menu_item_id"}]: a company recipe
-- switched on at every listed site through stock_co__recipe_on_at, need company with every site named; on
-- an existing recipe refused 'Tick sites on the Sites tab.'); (b) the new company keys food_kind,
-- meal_food_pct, portion_weight_g, cooking_yield_pct, shelf_life_days, msm_product_id (a menu product of
-- this company) and updated_by; (c) a kind change from dish to batch or prep needs the made item, from
-- batch to dish clears it ('A dish has no made item.' when sent); (d) after the site steps today's cost
-- rows for every site the recipe is on and the facts of every linked till product; (e) the answer adds
-- "sites" on create and "facts_rows". The version rule, the need and every 0a and Drop 1 word stay.
create or replace function public.stock_save_recipe(p_recipe jsonb, p_lines jsonb, p_version integer default null,
                                                    p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_d jsonb := public.stock_co__clean('recipe', p_recipe);
  v_section text;
  v_id uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_recipes;
  v_new stock_co_recipes;
  v_co jsonb;
  v_out uuid;
  v_site_out uuid;
  v_lines jsonb := '[]'::jsonb;
  v_old_lines jsonb;
  v_line jsonb;
  v_ln jsonb;
  v_comp uuid;
  v_site_comp uuid;
  v_u text;
  v_unit text;
  v_site_unit text;
  v_pack uuid;
  v_n integer := 0;
  v_menu text;
  v_linked boolean := false;
  v_cost jsonb;
  v_c jsonb;
  v_before_cost numeric;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row recipes;
  v_q integer;
  v_sites uuid[];
  v_sites_in jsonb;
  v_e jsonb;
  v_s uuid;
  v_on jsonb;
  v_sites_out jsonb := '[]'::jsonb;
  v_facts integer := 0;
  v_fr jsonb;
  v_kind_new text;
begin
  if (v_d ? 'id' and v_d ? 'site_recipe_id') or (v_d ? 'output_item_id' and v_d ? 'site_output_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array', 'null') then
    raise exception 'The recipe lines must be a list.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_recipe_id')::uuid;
  -- the sites of a new company recipe (Drop 2)
  if v_d ? 'sites' and jsonb_typeof(v_d -> 'sites') <> 'null' then
    v_sites_in := v_d -> 'sites';
    v_d := v_d - 'sites';
    if v_d ? 'id' or v_sid is not null then
      raise exception 'Tick sites on the Sites tab.' using errcode = '22023';
    end if;
    if jsonb_typeof(v_sites_in) <> 'array' then
      raise exception 'The field "sites" must be a list.' using errcode = '22023';
    end if;
    for v_e in select e.value from jsonb_array_elements(v_sites_in) e loop
      if jsonb_typeof(v_e) <> 'object' or coalesce(v_e ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      continue when jsonb_typeof(v_e -> 'on') = 'boolean' and not (v_e ->> 'on')::boolean;
      v_sites := coalesce(v_sites, '{}'::uuid[]) || lower(v_e ->> 'location_id')::uuid;
    end loop;
    if v_sites is null then
      raise exception 'Tick at least one site.' using errcode = '22023';
    end if;
    if v_loc is null then
      v_loc := v_sites[1];
    end if;
    v_sites := array(select distinct x from unnest(v_sites || v_loc) x order by x);
  elsif v_d ? 'sites' then
    v_d := v_d - 'sites';
  end if;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('recipe', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_recipes x where x.id = v_id;
    v_org := v_old.org_id;
    if v_sid is not null then
      select t.row_version into v_srv from recipes t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('recipe', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    elsif v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id)
                                             || v_old.local_location_id);
    end if;
  else
    if v_loc is null then
      raise exception 'A new recipe needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if v_d ? 'output_item_id' or v_d ? 'site_output_item_id' then
    v_out := public.stock_co__company_id('item', coalesce((v_d ->> 'output_item_id')::uuid, (v_d ->> 'site_output_item_id')::uuid));
    if coalesce(v_d ->> 'output_item_id', v_d ->> 'site_output_item_id') is not null
       and (v_out is null or not exists (select 1 from stock_co_items x where x.id = v_out and x.org_id = v_org)) then
      raise exception 'That made item was not found in this company.' using errcode = '22023';
    end if;
  else
    v_out := v_old.output_item_id;
  end if;
  v_section := public.stock_co__section(p_section, case when v_out is not null then array['produce', 'inventory'] else array['produce'] end);
  v_g := public.stock_co__guard(v_org, v_section, 'company', coalesce(v_sites, array[v_loc]));
  if v_id is not null then
    select * into v_old from stock_co_recipes x where x.id = v_id for update;
    perform public.stock_co__need_version('company', p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['recipe', 'recipe_site', 'menu_link'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;

  v_co := v_d - array['id', 'site_recipe_id', 'location_id', 'recipe_type', 'output_item_id', 'site_output_item_id', 'menu_item_id', 'portion'];
  v_co := v_co || jsonb_build_object('output_item_id', v_out);
  if v_d ? 'recipe_type' then
    v_co := v_co || jsonb_build_object('kind', case v_d ->> 'recipe_type' when 'MENU' then 'dish' when 'BATCH' then 'batch' else 'prep' end);
  end if;
  -- Drop 2: the menu product is one of this company's menus; a kind change and its made item
  if (v_co ->> 'msm_product_id') is not null
     and not exists (select 1 from msm_products mp join msm_menus mm on mm.id = mp.menu_id
                      where mp.id = (v_co ->> 'msm_product_id')::uuid and mm.org_id = v_org) then
    raise exception 'That menu product is not in this company.' using errcode = '22023';
  end if;
  v_kind_new := coalesce(v_co ->> 'kind', v_old.kind);
  if v_kind_new = 'dish' and v_out is not null and (v_old.id is null or v_old.kind <> 'dish') then
    if v_d ? 'output_item_id' or v_d ? 'site_output_item_id' then
      raise exception 'A dish has no made item.' using errcode = '22023';
    end if;
    v_out := null;
    v_co := v_co || jsonb_build_object('output_item_id', null);
  end if;
  if v_kind_new in ('batch', 'prep') and v_out is null and v_old.id is not null and v_old.kind = 'dish' then
    raise exception 'A batch or prep recipe needs its made item.' using errcode = '22023';
  end if;

  -- the lines, in the company form
  if jsonb_typeof(p_lines) = 'array' then
    for v_line in select e.value from jsonb_array_elements(p_lines) with ordinality e(value, ord) order by e.ord loop
      v_ln := public.stock_co__clean('recipe_line', v_line);
      if v_ln ? 'component_item_id' and v_ln ? 'site_component_item_id' then
        raise exception 'Send the company id or the site id of a line''s item, not both.' using errcode = '22023';
      end if;
      continue when coalesce(v_ln ->> 'component_item_id', v_ln ->> 'site_component_item_id') is null
                 or coalesce((v_ln ->> 'qty')::numeric, 0) <= 0;
      if (v_ln ->> 'site_component_item_id') is not null then
        v_site_comp := (v_ln ->> 'site_component_item_id')::uuid;
        select s.item_id into v_comp from stock_co_item_sites s where s.site_item_id = v_site_comp and s.location_id = v_loc;
        if v_comp is null then
          raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
        end if;
      else
        v_comp := (v_ln ->> 'component_item_id')::uuid;
        if not exists (select 1 from stock_co_items x where x.id = v_comp and x.org_id = v_org) then
          raise exception 'A line names a stock item that is not in this company.' using errcode = '22023';
        end if;
        select s.site_item_id into v_site_comp from stock_co_item_sites s where s.item_id = v_comp and s.location_id = v_loc;
      end if;
      v_u := btrim(coalesce(v_ln ->> 'unit', ''));
      v_pack := null;
      if v_u like '@_%' then
        if substr(v_u, 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'A line is in a pack ServOS does not know.' using errcode = '22023';
        end if;
        select ps.pack_id into v_pack from stock_co_pack_sites ps
         where ps.site_pack_id = substr(v_u, 2)::uuid and ps.location_id = v_loc;
        v_unit := '@';
        v_site_unit := lower(v_u);
      elsif v_u = '@' then
        v_pack := (v_ln ->> 'pack_id')::uuid;
        v_unit := '@';
        v_site_unit := '@' || (select ps.site_pack_id from stock_co_pack_sites ps where ps.pack_id = v_pack and ps.location_id = v_loc)::text;
      else
        if (v_ln ->> 'pack_id') is not null then
          raise exception 'A line with a pack has the unit "@".' using errcode = '22023';
        end if;
        v_unit := lower(v_u);
        if not exists (select 1 from stock_units su where su.code = v_unit) then
          raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_u using errcode = '22023';
        end if;
        v_site_unit := v_unit;
      end if;
      if v_unit = '@' and (v_pack is null or not exists (select 1 from stock_co_packs x where x.id = v_pack and x.item_id = v_comp)) then
        raise exception 'A line is in a pack that is not one of its item''s packs.' using errcode = '22023';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'component_item_id', v_comp, 'qty', (v_ln ->> 'qty')::numeric, 'unit', v_unit, 'pack_id', v_pack,
        'usable_pct', coalesce((v_ln ->> 'usable_pct')::numeric, 100), 'sort_order', v_n, 'note', v_ln ->> 'note',
        'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' and jsonb_array_length(v_ln -> 'order_types') > 0
                            then v_ln -> 'order_types' end,
        'base_qty', case when v_site_comp is not null and v_site_unit is not null
                         then public.stock_qty_to_base((v_ln ->> 'qty')::numeric, v_site_unit, v_site_comp) end));
      v_n := v_n + 1;
    end loop;
  end if;

  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'kind') is null then
      raise exception 'A new recipe needs a name and its type.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_recipes,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean and v_sites is null then v_loc end,
                                  'yield_qty', 1, 'yield_unit', 'each', 'wastage_pct', 0, 'restricted', false, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now(), 'updated_by', v_g ->> 'uid') || v_co);
    v_new.restricted := coalesce(v_new.restricted, false);
    insert into stock_co_recipes select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    v_new.updated_by := (v_g ->> 'uid')::uuid;
    update stock_co_recipes x
       set (kind, name, yield_qty, yield_unit, output_item_id, wastage_pct, gp_target_pct, method, photo, food_kind, meal_food_pct,
            portion_weight_g, cooking_yield_pct, shelf_life_days, msm_product_id, row_version, updated_at, updated_by)
         = (v_new.kind, v_new.name, v_new.yield_qty, v_new.yield_unit, v_new.output_item_id, v_new.wastage_pct, v_new.gp_target_pct,
            v_new.method, v_new.photo, v_new.food_kind, v_new.meal_food_pct, v_new.portion_weight_g, v_new.cooking_yield_pct,
            v_new.shelf_life_days, v_new.msm_product_id, v_new.row_version, v_new.updated_at, v_new.updated_by)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  if jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('component_item_id', l.component_item_id, 'qty', l.qty, 'unit', l.unit,
                                                 'pack_id', l.pack_id, 'usable_pct', l.usable_pct, 'sort_order', l.sort_order,
                                                 'note', l.note, 'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
      into v_old_lines from stock_co_recipe_lines l where l.recipe_id = v_id;
    delete from stock_co_recipe_lines l where l.recipe_id = v_id;
    insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, pack_id, usable_pct, order_types, note,
                                       sort_order, base_qty)
    select v_org, v_id, x.component_item_id, x.qty, x.unit, x.pack_id, x.usable_pct, x.order_types, x.note, x.sort_order, x.base_qty
      from jsonb_to_recordset(v_lines) as x(component_item_id uuid, qty numeric, unit text, pack_id uuid, usable_pct numeric,
                                            sort_order integer, note text, order_types jsonb, base_qty numeric);
    if v_old_lines is distinct from (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e) then
      v_log := coalesce(public.stock_co__log(v_org, null, 'recipe', v_id, 'lines', v_old_lines,
                                             (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e),
                                             v_src), v_log);
    end if;
  end if;

  -- Drop 2: a new company recipe switched on at every listed site (every ingredient, pack and bridge
  -- ticked there, the till link when given); a refusal in words is listed per site
  if v_sites is not null then
    foreach v_s in array v_sites loop
      v_on := null;
      select e into v_on from jsonb_array_elements(v_sites_in) e where lower(e ->> 'location_id') = v_s::text limit 1;
      v_fr := public.stock_co__recipe_on_at(v_id, v_s, nullif(btrim(coalesce(v_on ->> 'menu_item_id', '')), ''),
                'Added by ' || coalesce(nullif(btrim(coalesce(v_g ->> 'name', '')), ''), 'head office'), v_g ->> 'name');
      v_sites_out := v_sites_out || jsonb_build_array(jsonb_build_object(
                       'location_id', v_s, 'site_recipe_id', v_fr ->> 'site_recipe_id', 'menu_item_id', v_fr ->> 'menu_item_id',
                       'refused', case when coalesce((v_fr ->> 'ok')::boolean, false) then null else v_fr ->> 'error' end));
    end loop;
  end if;

  -- the recipe at the caller's site, and its till product there
  select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = v_id and s.location_id = v_loc;
  if v_sid is null then
    if v_old.id is not null then
      raise exception 'This recipe is not set up at that site.' using errcode = '22023';
    end if;
    v_sid := public.stock_co__new_site_recipe(v_id, v_loc);
  end if;
  v_menu := v_d ->> 'menu_item_id';
  if v_menu is not null and v_new.kind = 'dish' then
    if not exists (select 1 from menu_items m where m.id = v_menu and m.location_id = v_loc::text) then
      raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
    end if;
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.location_id = v_loc and s.site_menu_item_id = v_menu and s.recipe_id <> v_id;
    update stock_co_recipe_sites s set site_menu_item_id = v_menu, row_version = s.row_version + 1, updated_at = now()
     where s.recipe_id = v_id and s.location_id = v_loc and s.site_menu_item_id is distinct from v_menu;
    if found then
      v_log := coalesce(public.stock_co__log(v_org, v_loc, 'menu_link', v_id, 'menu_item_id', null, to_jsonb(v_menu), v_src), v_log);
    end if;
  end if;

  select s.site_item_id into v_site_out from stock_co_item_sites s where s.item_id = v_new.output_item_id and s.location_id = v_loc;
  select t.current_cost into v_before_cost from inventory_items t where t.id = v_site_out;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id),
                                      '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);

  if v_menu is not null and v_new.kind = 'dish' then
    update menu_item_recipes m set portion = coalesce((v_d ->> 'portion')::numeric, 1)
     where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid
       and m.portion is distinct from coalesce((v_d ->> 'portion')::numeric, 1);
    v_linked := exists (select 1 from menu_item_recipes m where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid);
  end if;

  -- the made item's cost at the caller's site, said back the way the screens say it today
  if v_site_out is not null then
    v_cost := public.stock_co__recost(v_loc, array[v_site_out], true);
    select e into v_c from jsonb_array_elements(v_cost -> 'items') e where (e ->> 'item_id')::uuid = v_site_out limit 1;
  end if;

  -- Drop 2: today's cost rows for every site the recipe is on, and the facts of its linked till products
  -- (inline up to 50 sites, else queued per site)
  perform public.stock_co__cost_rows(array[v_id], null, null);
  if (select count(*) from stock_co_recipe_sites s where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null) <= 50 then
    for v_s, v_e in
      select s.location_id, to_jsonb(s.site_menu_item_id) from stock_co_recipe_sites s
       where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null order by s.location_id
    loop
      v_fr := public.stock_co__facts_rebuild_site(v_s, array[v_e #>> '{}']);
      v_facts := v_facts + coalesce((v_fr ->> 'rows')::integer, 0);
    end loop;
  else
    perform public.stock_co__d2_enqueue(v_org, s.location_id, 'facts_rebuild',
                                        jsonb_build_object('menu_item_ids', jsonb_build_array(s.site_menu_item_id)), '{}'::uuid[])
       from stock_co_recipe_sites s where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null;
  end if;

  if (v_d ->> 'site_recipe_id') is not null then
    select t.row_version into v_rv from recipes t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update recipes t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from recipes t where t.id = v_sid;
  select count(*) into v_q from stock_co_recipe_lines l where l.recipe_id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_recipe_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'lines_saved', v_q, 'linked', v_linked,
                            'cost', case when v_site_out is null then null
                                         else jsonb_build_object('item_id', v_site_out, 'ok', coalesce((v_c ->> 'ok')::boolean, false),
                                                                 'before', to_jsonb(v_before_cost), 'after', v_c -> 'after') end,
                            'queued', v_run -> 'queued', 'facts_rows', v_facts)
         || case when v_sites is not null then jsonb_build_object('sites', v_sites_out) else '{}'::jsonb end;
end
$fn$;


-- REBUILT (Drop 2): the facts keys allergens, may_contain, diets, ingredients_text and nutrition are
-- written; a facts change clears facts_checked_by, facts_checked_by_name and facts_checked_at, logs
-- entity supplier_item field facts (before and after), recomputes the item's allergen roll up (carried to
-- every site's inventory_items.allergens by the normal site steps) and rebuilds the facts of every till
-- product whose recipe uses the item at every site (inline up to 1,000 facts rows, else queued per
-- site). The need, the version rule and every Drop 1 word stay.
create or replace function public.stock_save_supplier_item(p_si jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_item', p_si);
  v_site jsonb;
  v_id uuid;
  v_item uuid;
  v_sup uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_cur text;
  v_loc_cur text;
  v_g jsonb;
  v_old stock_co_supplier_items;
  v_new stock_co_supplier_items;
  v_co jsonb;
  v_rate numeric;
  v_here boolean := false;
  v_price numeric;
  v_log bigint;
  v_run jsonb;
  v_site_item uuid;
  v_site_sup uuid;
  v_pref boolean;
  v_pref_changed boolean := false;
  v_tmp boolean;
  v_cost jsonb;
  v_n integer;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row supplier_products;
  v_need text;
  v_facts_change boolean := false;
  v_fb jsonb;
  v_roll jsonb;
  v_nsets integer;
begin
  if (v_d ? 'id' and v_d ? 'site_supplier_product_id') or (v_d ? 'item_id' and v_d ? 'site_item_id')
     or (v_d ? 'supplier_id' and v_d ? 'site_supplier_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if v_d ? 'purchase_tax_rate_id' and v_d ? 'purchase_vat_rate' then
    raise exception 'Send the VAT rate row or the VAT rate, not both.' using errcode = '22023';
  end if;
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_supplier_product_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('supplier_item', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_supplier_items x where x.id = v_id;
    v_item := v_old.item_id;
    v_sup := v_old.supplier_id;
    if v_sid is not null then
      select t.row_version into v_srv from supplier_products t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('supplier_item', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A supplier pack cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_d ? 'supplier_id' or v_d ? 'site_supplier_id' then
    v_sup := public.stock_co__company_id('supplier', coalesce((v_d ->> 'supplier_id')::uuid, (v_d ->> 'site_supplier_id')::uuid));
    if v_sup is null then
      raise exception 'That supplier was not found.' using errcode = '22023';
    end if;
  end if;
  if v_item is null or v_sup is null then
    raise exception 'A supplier pack needs its item and its supplier.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null or not exists (select 1 from stock_co_suppliers m where m.id = v_sup and m.org_id = v_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  v_need := case when v_id is not null then public.stock_co__need_of('supplier_item', v_id, v_loc)
                 when exists (select 1 from stock_co_items x where x.id = v_item and x.local_location_id = v_loc)
                   or exists (select 1 from stock_co_suppliers m where m.id = v_sup and m.local_location_id = v_loc) then 'site_facts'
                 else 'company' end;
  -- a pack moved to another supplier: the need of the NEW supplier counts too (a local supplier's pack
  -- moved to a company supplier would show at every site that supplier is linked at)
  if v_id is not null and v_sup is distinct from v_old.supplier_id then
    v_need := public.stock_co__need_max(v_need,
                case when exists (select 1 from stock_co_items x where x.id = v_item and x.local_location_id = v_loc)
                       or exists (select 1 from stock_co_suppliers m where m.id = v_sup and m.local_location_id = v_loc) then 'site_facts'
                     else 'company' end);
  end if;
  -- the supplier here of a company item (is_preferred changes at this site, or the preferred pack moves to
  -- another supplier): Their sites, full control or head office only, the same as supplier_here on
  -- stock_save_item_site
  if not exists (select 1 from stock_co_items x where x.id = v_item and x.local_location_id = v_loc) then
    v_tmp := coalesce((select t.is_preferred
                         from stock_co_supplier_item_sites x join supplier_products t on t.id = x.site_supplier_product_id
                        where x.supplier_item_id = v_id and x.location_id = v_loc), false);
    if ((v_site ->> 'is_preferred') is not null and (v_site ->> 'is_preferred')::boolean is distinct from v_tmp)
       or (v_tmp and v_id is not null and v_sup is distinct from v_old.supplier_id) then
      v_need := public.stock_co__need_max(v_need, 'site_price');
    end if;
    v_tmp := null;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_supplier_items x where x.id = v_id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['supplier_item', 'supplier_item_site'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  select s.site_item_id into v_site_item from stock_co_item_sites s where s.item_id = v_item and s.location_id = v_loc;
  select s.site_supplier_id into v_site_sup from stock_co_supplier_sites s where s.supplier_id = v_sup and s.location_id = v_loc;
  if v_site_item is null or v_site_sup is null then
    raise exception 'That item or that supplier is not set up at this site.' using errcode = '22023';
  end if;
  select coalesce(l.currency, 'GBP') into v_loc_cur from locations l where l.id = v_loc;
  v_cur := coalesce(v_d ->> 'currency', v_old.currency, v_loc_cur);
  -- Drop 2: a facts change (allergens, may contain, diets, the declaration, nutrition) needs a new check
  v_facts_change := (v_d ? 'allergens' or v_d ? 'may_contain' or v_d ? 'diets' or v_d ? 'ingredients_text' or v_d ? 'nutrition');

  v_co := v_d - array['id', 'site_supplier_product_id', 'location_id', 'item_id', 'site_item_id', 'supplier_id', 'site_supplier_id',
                      'site', 'supplier_sku', 'purchase_tax_rate_id', 'purchase_vat_rate', 'currency', 'pack_price'];
  v_co := v_co || jsonb_build_object('item_id', v_item, 'supplier_id', v_sup, 'currency', v_cur);
  if v_d ? 'supplier_sku' then
    v_co := v_co || jsonb_build_object('sku', v_d -> 'supplier_sku');
  end if;
  if v_d ? 'purchase_tax_rate_id' then
    v_rate := null;
    if (v_d ->> 'purchase_tax_rate_id') is not null then
      select r.rate into v_rate from tax_rates r where r.id = (v_d ->> 'purchase_tax_rate_id')::uuid and r.location_id = v_loc;
      if not found then
        raise exception 'That VAT rate is not one of this venue''s rates.' using errcode = '22023';
      end if;
    end if;
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_rate);
  elsif v_d ? 'purchase_vat_rate' then
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_d -> 'purchase_vat_rate');
  end if;
  -- where a new price goes: this site's own price, or the company price
  if v_d ? 'pack_price' then
    v_price := (v_d ->> 'pack_price')::numeric;
    if v_id is not null
       and (exists (select 1 from stock_co_supplier_item_sites x
                     where x.supplier_item_id = v_id and x.location_id = v_loc and x.price_here is not null)
            or v_loc_cur is distinct from v_cur) then
      v_here := true;
    else
      v_co := v_co || jsonb_build_object('pack_price', v_price);
    end if;
  end if;

  if v_id is null then
    if (v_co ->> 'pack_price') is null or (v_co ->> 'inner_unit') is null then
      raise exception 'A new supplier pack needs a price and a unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_supplier_items,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'pack_qty', 1, 'inner_qty', 1,
                                  'price_includes_tax', false, 'paused', false, 'allergens', '{}'::text[], 'may_contain', '{}'::text[],
                                  'diets', '{}'::text[], 'row_version', 1, 'created_at', now(), 'updated_at', now()) || v_co);
    v_new.pack_qty := coalesce(v_new.pack_qty, 1);
    v_new.inner_qty := coalesce(v_new.inner_qty, 1);
    v_new.price_includes_tax := coalesce(v_new.price_includes_tax, false);
    if v_loc_cur is distinct from v_new.currency then
      raise exception '% pays in %. Give it its own price here.', (select l.name from locations l where l.id = v_loc), v_loc_cur
        using errcode = '55000';
    end if;
    insert into stock_co_supplier_items select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier_item', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.price_includes_tax := coalesce(v_new.price_includes_tax, false);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    if v_facts_change then
      v_new.allergens := coalesce(v_new.allergens, '{}'::text[]);
      v_new.may_contain := coalesce(v_new.may_contain, '{}'::text[]);
      v_new.diets := coalesce(v_new.diets, '{}'::text[]);
      v_new.facts_checked_by := null;
      v_new.facts_checked_by_name := null;
      v_new.facts_checked_at := null;
    end if;
    update stock_co_supplier_items x
       set (supplier_id, supplier_product_name, sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, currency,
            purchase_vat_rate, price_includes_tax, paused, agreed_until, allowed_diff_pct, allergens, may_contain, diets,
            ingredients_text, nutrition, facts_checked_by, facts_checked_by_name, facts_checked_at, row_version, updated_at)
         = (v_new.supplier_id, v_new.supplier_product_name, v_new.sku, v_new.pack_description, v_new.pack_qty, v_new.inner_qty,
            v_new.inner_unit, v_new.pack_price, v_new.currency, v_new.purchase_vat_rate, v_new.price_includes_tax,
            v_new.paused, v_new.agreed_until, v_new.allowed_diff_pct, v_new.allergens, v_new.may_contain, v_new.diets,
            v_new.ingredients_text, v_new.nutrition, v_new.facts_checked_by, v_new.facts_checked_by_name, v_new.facts_checked_at,
            v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier_item', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
    if v_facts_change then
      v_log := coalesce(public.stock_co__log(v_org, null, 'supplier_item', v_id, 'facts',
                 jsonb_build_object('allergens', to_jsonb(v_old.allergens), 'may_contain', to_jsonb(v_old.may_contain), 'diets', to_jsonb(v_old.diets),
                                    'ingredients_text', v_old.ingredients_text, 'nutrition', v_old.nutrition),
                 jsonb_build_object('allergens', to_jsonb(v_new.allergens), 'may_contain', to_jsonb(v_new.may_contain), 'diets', to_jsonb(v_new.diets),
                                    'ingredients_text', v_new.ingredients_text, 'nutrition', v_new.nutrition), v_src), v_log);
    end if;
    if v_here then
      update stock_co_supplier_item_sites x
         set price_here = v_price, row_version = x.row_version + 1, updated_at = now()
       where x.supplier_item_id = v_id and x.location_id = v_loc and x.price_here is distinct from v_price;
      if found then
        v_log := coalesce(public.stock_co__log(v_org, v_loc, 'supplier_item_site', v_id, 'price_here', null, to_jsonb(v_price), v_src), v_log);
      end if;
    end if;
  end if;
  perform public.stock_co__currency_check(v_id);

  -- is_preferred at this site (an existing site row: before the writer, so the cost step sees it)
  v_pref := case when v_site ? 'is_preferred' then (v_site ->> 'is_preferred')::boolean end;
  select x.site_supplier_product_id into v_sid from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = v_loc;
  if v_pref is not null and v_sid is not null then
    v_pref_changed := public.stock_co__set_preferred(v_loc, v_site_item, v_sid, v_pref);
  end if;

  -- Drop 2: the item's allergen roll up (the set its live supplier items share; supplier items that
  -- disagree leave the item as it is, the item page shows the rule), carried to inventory_items.allergens
  -- at every site by the normal site steps below
  if v_facts_change then
    select count(distinct public.stock_co__allergen_ids(si.allergens)) into v_nsets
      from stock_co_supplier_items si where si.item_id = v_item and si.archived_at is null;
    if v_nsets = 1 then
      select to_jsonb(public.stock_co__allergen_ids(si.allergens)) into v_roll
        from stock_co_supplier_items si where si.item_id = v_item and si.archived_at is null order by si.id limit 1;
      update stock_co_items x set allergens = v_roll, facts_source = null
       where x.id = v_item and (x.allergens is distinct from v_roll or x.facts_source is not null);
      if found then
        v_log := coalesce(public.stock_co__log(v_org, null, 'item', v_item, 'allergens', null, v_roll, v_src), v_log);
      end if;
    end if;
  end if;
  v_run := public.stock_co__run_sites(v_org, v_loc,
             array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
             array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  -- Drop 1: a site written now that cannot order from this supplier never offers the pack
  perform public.stock_co__sync_site(x.location_id, array[v_item], '{}'::uuid[], true, false)
     from stock_co_supplier_sites x
    where x.supplier_id = v_sup and not x.can_order
      and not exists (select 1 from jsonb_array_elements(v_run -> 'queued') q where (q ->> 'location_id')::uuid = x.location_id)
      and public.stock_co__cant_order_off(x.location_id, array[v_id]) > 0;

  select x.site_supplier_product_id into v_sid from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = v_loc;
  -- the VAT rate row picked on this site's screen stays the one picked (same rate value, so the writer keeps it)
  if (v_d ->> 'purchase_tax_rate_id') is not null and v_sid is not null then
    update supplier_products t
       set purchase_tax_rate_id = (v_d ->> 'purchase_tax_rate_id')::uuid, row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc and t.purchase_tax_rate_id is distinct from (v_d ->> 'purchase_tax_rate_id')::uuid;
  end if;
  if v_pref is not null and v_sid is not null then
    v_tmp := public.stock_co__set_preferred(v_loc, v_site_item, v_sid, v_pref);
    v_pref_changed := v_pref_changed or v_tmp;
    if v_pref_changed then
      v_cost := public.stock_co__cost_step(v_loc, array[v_site_item], v_log, true);
      v_run := jsonb_set(v_run, '{cost}', (v_run -> 'cost')
                 || coalesce((select jsonb_agg(e || jsonb_build_object('location_id', v_loc))
                                from jsonb_array_elements(v_cost -> 'items') e), '[]'::jsonb));
    end if;
    if v_pref and not (v_g ->> 'multi')::boolean then
      update stock_co_items x set main_supplier_item_id = v_id where x.id = v_item and x.main_supplier_item_id is distinct from v_id;
    end if;
  end if;

  if (v_d ->> 'site_supplier_product_id') is not null then
    select t.row_version into v_rv from supplier_products t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update supplier_products t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  -- Drop 2: the facts of every till product whose recipe uses this item, at every site in the company
  if v_facts_change then
    v_fb := public.stock_co__facts_rebuild_item(v_item);
  end if;
  select * into v_row from supplier_products t where t.id = v_sid;
  v_n := jsonb_array_length(v_run -> 'queued');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_supplier_product_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'cost', v_run -> 'cost',
                            'partial', case when v_n > 0 then format('Saved. %s site(s) catch up within a minute.', v_n) end,
                            'queued', v_run -> 'queued', 'facts_rows', coalesce((v_fb ->> 'rows')::integer, 0),
                            'facts_queued', coalesce((v_fb ->> 'queued')::integer, 0));
end
$fn$;


-- REBUILT (Drop 2): the allergen chips of an item that has a live supplier item are written onto its main
-- supplier item (main_supplier_item_id, else the newest live one), logged entity supplier_item field
-- allergens, and the item's allergens become the roll up; an item with no live supplier item keeps its
-- own with facts_source 'item'. Either way the facts of the till products using it are rebuilt. The
-- answer adds "facts_rows". Everything else exactly as Drop 1.
create or replace function public.stock_save_item(p_item jsonb, p_sites jsonb default null, p_version integer default null,
                                                  p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('item', p_item);
  v_site jsonb;
  v_co jsonb;
  v_loc uuid;
  v_id uuid;
  v_sid uuid;
  v_sloc uuid;
  v_srv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_items;
  v_new stock_co_items;
  v_created boolean := false;
  v_rate numeric;
  v_before_site jsonb;
  v_after_site jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_log bigint;
  v_l2 bigint;
  v_run jsonb;
  v_rv integer;
  v_row inventory_items;
  v_need text;
  v_sites uuid[];
  v_e jsonb;
  v_s uuid;
  v_x uuid;
  v_cat stock_co_categories;
  v_main_si uuid;
  v_alls jsonb;
  v_fb jsonb;
begin
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  if v_d ? 'id' and v_d ? 'site_item_id' then
    raise exception 'Send the item id or the site item id, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_item_id')::uuid;
  v_id := public.stock_co__company_id('item', coalesce((v_d ->> 'id')::uuid, v_sid));
  if (v_d ->> 'id') is not null and v_id is distinct from (v_d ->> 'id')::uuid then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  -- the sites of a new company item (Drop 1)
  if p_sites is not null and jsonb_typeof(p_sites) <> 'null' then
    if v_id is not null or v_sid is not null then
      raise exception 'Tick sites on the Sites tab.' using errcode = '22023';
    end if;
    if jsonb_typeof(p_sites) <> 'array' then
      raise exception 'The field "sites" must be a list.' using errcode = '22023';
    end if;
    for v_e in select e.value from jsonb_array_elements(p_sites) e loop
      if jsonb_typeof(v_e) <> 'object' or coalesce(v_e ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      continue when jsonb_typeof(v_e -> 'on') = 'boolean' and not (v_e ->> 'on')::boolean;
      v_sites := coalesce(v_sites, '{}'::uuid[]) || lower(v_e ->> 'location_id')::uuid;
    end loop;
    if v_sites is null then
      raise exception 'Tick at least one site.' using errcode = '22023';
    end if;
    if v_loc is null then
      v_loc := v_sites[1];
    end if;
    v_sites := array(select distinct x from unnest(v_sites || v_loc) x order by x);
  end if;
  if v_sid is not null then
    if v_loc is null then
      raise exception 'location_id is needed with site_item_id.' using errcode = '22023';
    end if;
    select s.location_id, t.row_version into v_sloc, v_srv
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.site_item_id = v_sid and s.item_id = v_id;
    if v_id is null or v_sloc is null or v_sloc <> v_loc then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if v_id is not null then
    select * into v_old from stock_co_items x where x.id = v_id;
    v_org := v_old.org_id;
    if v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_id)
                                             || v_old.local_location_id);
    end if;
    v_need := public.stock_co__need_of('item', v_id, v_loc);
  else
    if (v_d ->> 'id') is not null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if v_loc is null then
      raise exception 'A new item needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_need := case when v_sites is not null then 'company' else 'site_facts' end;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need, coalesce(v_sites, array[v_loc]));

  if v_id is not null then
    select * into v_old from stock_co_items x where x.id = v_id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null then
      if v_sid is not null then
        select t.row_version into v_srv from inventory_items t where t.id = v_sid;
        if v_srv is distinct from p_version then
          return public.stock_co__conflict(v_org, array['item', 'item_site'], v_id, v_srv, v_loc, v_old.updated_at);
        end if;
      elsif v_old.row_version is distinct from p_version then
        return public.stock_co__conflict(v_org, array['item', 'item_site'], v_id, v_old.row_version, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;

  -- company fields: the VAT rate is stored as its value, from a rate row of this site or as a fraction
  if v_d ? 'purchase_tax_rate_id' and v_d ? 'purchase_vat_rate' then
    raise exception 'Send the VAT rate row or the VAT rate, not both.' using errcode = '22023';
  end if;
  v_co := v_d - array['id', 'site_item_id', 'location_id', 'site', 'purchase_tax_rate_id', 'purchase_vat_rate'];
  if v_d ? 'purchase_tax_rate_id' then
    v_rate := null;
    if (v_d ->> 'purchase_tax_rate_id') is not null then
      select r.rate into v_rate from tax_rates r where r.id = (v_d ->> 'purchase_tax_rate_id')::uuid and r.location_id = v_loc;
      if not found then
        raise exception 'That VAT rate is not one of this venue''s rates.' using errcode = '22023';
      end if;
    end if;
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_rate);
  elsif v_d ? 'purchase_vat_rate' then
    v_co := v_co || jsonb_build_object('purchase_vat_rate', v_d -> 'purchase_vat_rate');
  end if;
  -- the category (Drop 1): a company category, its name kept in the free text; a one site company keeps
  -- today's free text, with its company category kept in step
  if v_d ? 'category_id' then
    if (v_d ->> 'category_id') is not null then
      select * into v_cat from stock_co_categories c
       where c.id = (v_d ->> 'category_id')::uuid and c.org_id = v_org and c.archived_at is null;
      if v_cat.id is null then
        raise exception 'That category is not one of this company''s categories.' using errcode = '22023';
      end if;
      v_co := v_co || jsonb_build_object('category_id', v_cat.id, 'category', v_cat.name);
    else
      v_co := v_co || jsonb_build_object('category_id', null, 'category', null);
    end if;
  elsif v_d ? 'category' then
    if (v_g ->> 'multi')::boolean then
      raise exception 'Pick a category from the list.' using errcode = '22023';
    end if;
    v_co := v_co || jsonb_build_object('category_id', public.stock_co__category_for(v_org, v_d ->> 'category'));
  end if;
  -- the main supplier pack (Drop 1): a live supplier pack of this item, or none
  if (v_d ->> 'main_supplier_item_id') is not null
     and (v_id is null
          or not exists (select 1 from stock_co_supplier_items si
                          where si.id = (v_d ->> 'main_supplier_item_id')::uuid and si.item_id = v_id and si.archived_at is null)) then
    raise exception 'The main supplier pack must be a supplier pack of this stock item.' using errcode = '22023';
  end if;
  -- Drop 2 (map 4.5): the allergen chips of an item that has a live supplier item are written onto its MAIN
  -- supplier item and the item keeps the roll up; an item with no supplier item keeps its own
  -- (facts_source 'item'). The one site screen stays byte for byte the same.
  if v_d ? 'allergens' then
    v_alls := to_jsonb(public.stock_co__allergen_ids(array(select jsonb_array_elements_text(
                case when jsonb_typeof(v_d -> 'allergens') = 'array' then v_d -> 'allergens' else '[]'::jsonb end))));
    v_main_si := null;
    if v_id is not null then
      select si.id into v_main_si from stock_co_supplier_items si
       where si.item_id = v_id and si.archived_at is null
       order by (si.id = coalesce((v_d ->> 'main_supplier_item_id')::uuid, v_old.main_supplier_item_id)) desc, si.created_at desc, si.id
       limit 1;
    end if;
    if v_main_si is not null then
      update stock_co_supplier_items si
         set allergens = array(select jsonb_array_elements_text(v_alls))::text[], updated_at = now()
       where si.id = v_main_si and si.allergens is distinct from array(select jsonb_array_elements_text(v_alls))::text[];
      if found then
        perform public.stock_co__log(v_org, null, 'supplier_item', v_main_si, 'allergens', null, v_alls, v_src);
      end if;
      select to_jsonb(public.stock_co__allergen_ids(array(select unnest(si.allergens) from stock_co_supplier_items si
                                                           where si.item_id = v_id and si.archived_at is null)))
        into v_alls;
      v_co := v_co || jsonb_build_object('allergens', v_alls, 'facts_source', null);
    else
      v_co := v_co || jsonb_build_object('allergens', v_alls, 'facts_source', 'item');
    end if;
  end if;

  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'base_unit') is null then
      raise exception 'A new item needs a name and a base unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_items,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when v_sites is null and (v_g ->> 'multi')::boolean then v_loc end,
                                  'allergens', '[]'::jsonb, 'returns_to_shelf', false, 'exclude_from_gp', false, 'key_item', false,
                                  'row_version', 1, 'created_at', now(), 'updated_at', now(), 'updated_by', v_g ->> 'uid') || v_co);
    insert into stock_co_items select (v_new).*;
    v_id := v_new.id;
    v_created := true;
    if v_sites is null then
      v_sid := public.stock_co__new_site_item(v_id, v_loc,
                 case when v_site ->> 'kind' = 'MADE' then 'batches' else 'bought' end,
                 coalesce((v_site ->> 'is_tracked')::boolean, true));
    else
      foreach v_s in array v_sites loop
        v_x := public.stock_co__new_site_item(v_id, v_s,
                 case when v_site ->> 'kind' = 'MADE' then 'batches' else 'bought' end,
                 coalesce((v_site ->> 'is_tracked')::boolean, true));
        if v_s = v_loc then
          v_sid := v_x;
        end if;
      end loop;
      update stock_co_item_sites s
         set why_on = 'Added by ' || coalesce(nullif(btrim(coalesce(v_g ->> 'name', '')), ''), 'head office')
       where s.item_id = v_id and s.why_on is null;
    end if;
    v_log := public.stock_co__log_diff(v_org, null, 'item', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.allergens := coalesce(v_new.allergens, '[]'::jsonb);
    v_new.returns_to_shelf := coalesce(v_new.returns_to_shelf, false);
    v_new.exclude_from_gp := coalesce(v_new.exclude_from_gp, false);
    v_new.key_item := coalesce(v_new.key_item, false);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    v_new.updated_by := (v_g ->> 'uid')::uuid;
    update stock_co_items x
       set (name, category, accounting_group, type, base_unit, sku, barcode, shelf_life_days, purchase_vat_rate, allergens,
            returns_to_shelf, exclude_from_gp, key_item, notes, category_id, main_supplier_item_id, facts_source, row_version, updated_at,
            updated_by)
         = (v_new.name, v_new.category, v_new.accounting_group, v_new.type, v_new.base_unit, v_new.sku, v_new.barcode,
            v_new.shelf_life_days, v_new.purchase_vat_rate, v_new.allergens, v_new.returns_to_shelf, v_new.exclude_from_gp,
            v_new.key_item, v_new.notes, v_new.category_id, v_new.main_supplier_item_id, v_new.facts_source, v_new.row_version,
            v_new.updated_at, v_new.updated_by)
     where x.id = v_id;
    select s.site_item_id into v_sid from stock_co_item_sites s where s.item_id = v_id and s.location_id = v_loc;
    if v_sid is null then
      raise exception 'This item is not set up at that site.' using errcode = '22023';
    end if;
    v_log := public.stock_co__log_diff(v_org, null, 'item', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;

  -- the site values at location_id: kind and is_tracked through the link, the rest on the site row
  if v_site <> '{}'::jsonb then
    if (v_site ->> 'default_supplier_id') is not null
       and not exists (select 1 from suppliers s where s.id = (v_site ->> 'default_supplier_id')::uuid and s.location_id = v_loc) then
      raise exception 'That supplier is not set up at this site.' using errcode = '22023';
    end if;
    perform 1 from inventory_items t where t.id = v_sid for no key update;
    select jsonb_build_object('supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'is_sellable', t.is_sellable,
                              'cost_method', t.cost_method, 'storage_location', t.storage_location,
                              'default_supplier_id', t.default_supplier_id, 'notes', t.notes)
      into v_before_site
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.item_id = v_id and s.location_id = v_loc;
    update stock_co_item_sites s
       set supply_mode = case when not (v_site ? 'kind') then s.supply_mode
                              when v_site ->> 'kind' = 'MADE' then case when s.supply_mode = 'bought' then 'batches' else s.supply_mode end
                              else 'bought' end,
           counted_here = case when v_site ? 'is_tracked' then (v_site ->> 'is_tracked')::boolean else s.counted_here end,
           row_version = s.row_version + 1, updated_at = now()
     where s.item_id = v_id and s.location_id = v_loc
       and (s.supply_mode, s.counted_here) is distinct from (
             case when not (v_site ? 'kind') then s.supply_mode
                  when v_site ->> 'kind' = 'MADE' then case when s.supply_mode = 'bought' then 'batches' else s.supply_mode end
                  else 'bought' end,
             case when v_site ? 'is_tracked' then (v_site ->> 'is_tracked')::boolean else s.counted_here end);
    update inventory_items t
       set is_sellable = case when v_site ? 'is_sellable' then (v_site ->> 'is_sellable')::boolean else t.is_sellable end,
           cost_method = case when v_site ? 'cost_method' then v_site ->> 'cost_method' else t.cost_method end,
           storage_location = case when v_site ? 'storage_location' then v_site ->> 'storage_location' else t.storage_location end,
           default_supplier_id = case when v_site ? 'default_supplier_id' then (v_site ->> 'default_supplier_id')::uuid else t.default_supplier_id end,
           notes = case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end,
           row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc
       and (t.is_sellable, t.cost_method, t.storage_location, t.default_supplier_id, t.notes) is distinct from (
             case when v_site ? 'is_sellable' then (v_site ->> 'is_sellable')::boolean else t.is_sellable end,
             case when v_site ? 'cost_method' then v_site ->> 'cost_method' else t.cost_method end,
             case when v_site ? 'storage_location' then v_site ->> 'storage_location' else t.storage_location end,
             case when v_site ? 'default_supplier_id' then (v_site ->> 'default_supplier_id')::uuid else t.default_supplier_id end,
             case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end);
    select jsonb_build_object('supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'is_sellable', t.is_sellable,
                              'cost_method', t.cost_method, 'storage_location', t.storage_location,
                              'default_supplier_id', t.default_supplier_id, 'notes', t.notes)
      into v_after_site
      from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id
     where s.item_id = v_id and s.location_id = v_loc;
    if not v_created then
      v_l2 := public.stock_co__log_diff(v_org, v_loc, 'item_site', v_id, v_before_site, v_after_site, v_src);
      v_log := coalesce(v_l2, v_log);
    end if;
  end if;

  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_id),
                                      array[v_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  -- the VAT rate row picked on this site's screen stays the one picked (same rate value, so the writer keeps it)
  if (v_d ->> 'purchase_tax_rate_id') is not null then
    update inventory_items t
       set purchase_tax_rate_id = (v_d ->> 'purchase_tax_rate_id')::uuid, row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc and t.purchase_tax_rate_id is distinct from (v_d ->> 'purchase_tax_rate_id')::uuid;
  end if;
  -- Drop 2: the facts of every till product whose recipe uses this item
  if v_d ? 'allergens' then
    v_fb := public.stock_co__facts_rebuild_item(v_id);
  end if;

  if (v_d ->> 'site_item_id') is not null then
    select t.row_version into v_rv from inventory_items t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update inventory_items t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from inventory_items t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'created', v_created,
                            'local_location_id', v_new.local_location_id, 'site_item_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'sites_written', v_run -> 'sites_written', 'queued', v_run -> 'queued',
                            'facts_rows', coalesce((v_fb ->> 'rows')::integer, 0))
         || case when v_created then jsonb_build_object('sites', to_jsonb(coalesce(v_sites, array[v_loc]))) else '{}'::jsonb end;
end
$fn$;


-- REBUILT (Drop 2): additive keys only. A top level "facts" {allergens, may_contain, diets, needs_check,
-- source (supplier_items or item), from [{supplier_item_id, supplier_name, allergens, sites_on}], differ
-- (two live supplier items with different allergen sets)}; each supplier_items[] gains "facts"
-- {allergens, may_contain, diets, ingredients_text, nutrition, checked_by_name, checked_at}.
create or replace function public.stock_item_detail(p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_item stock_co_items;
  v_reach text[];
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_item from stock_co_items x where x.id = v_id;
  v_reach := array(select public.stock_reach_locations());
  if not exists (select 1 from stock_co_item_sites s where s.item_id = v_id and s.location_id::text = any(v_reach))
     and not coalesce(v_item.local_location_id::text = any(v_reach), false) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'item', to_jsonb(v_item) || jsonb_build_object('category_name',
              (select c.name from stock_co_categories c where c.id = v_item.category_id)),
    'row_version', v_item.row_version,
    'unit_locked', exists (select 1 from stock_co_item_sites s
                            where s.item_id = v_id and public.stock_co__site_item_in_use(s.location_id, s.site_item_id)),
    'count_pack', (select jsonb_build_object('id', p.id, 'name', p.name, 'qty_in_base', p.qty_in_base)
                     from stock_co_packs p where p.item_id = v_id and p.is_count_default and p.archived_at is null
                    order by p.id limit 1),
    'local', v_item.local_location_id is not null,
    'facts', (select jsonb_build_object(
                'allergens', case when v_item.facts_source = 'item' or z.n = 0
                                  then to_jsonb(public.stock_co__allergen_ids(array(select jsonb_array_elements_text(
                                         case when jsonb_typeof(v_item.allergens) = 'array' then v_item.allergens else '[]'::jsonb end))))
                                  else to_jsonb(public.stock_co__allergen_ids(array(select unnest(si2.allergens) from stock_co_supplier_items si2
                                                                                     where si2.item_id = v_id and si2.archived_at is null))) end,
                'may_contain', to_jsonb(public.stock_co__allergen_ids(array(select unnest(si2.may_contain) from stock_co_supplier_items si2
                                                                             where si2.item_id = v_id and si2.archived_at is null))),
                'diets', to_jsonb(coalesce(array(select distinct d from stock_co_supplier_items si2, unnest(si2.diets) d
                                                  where si2.item_id = v_id and si2.archived_at is null order by d), '{}'::text[])),
                'needs_check', exists (select 1 from menu_item_stock_facts f
                                         where f.needs_check
                                           and f.recipe_id in (select l.recipe_id from stock_co_recipe_lines l where l.component_item_id = v_id)),
                'source', case when v_item.facts_source = 'item' or z.n = 0 then 'item' else 'supplier_items' end,
                'from', z.from_rows,
                'differ', z.nsets > 1)
                from (select count(*)::integer as n,
                             count(distinct public.stock_co__allergen_ids(si.allergens))::integer as nsets,
                             coalesce(jsonb_agg(jsonb_build_object('supplier_item_id', si.id, 'supplier_name', m.name,
                                        'allergens', to_jsonb(public.stock_co__allergen_ids(si.allergens)),
                                        'sites_on', (select count(*) from stock_co_supplier_item_sites x where x.supplier_item_id = si.id and not x.off_here))
                                      order by m.name, si.created_at, si.id), '[]'::jsonb) as from_rows
                        from stock_co_supplier_items si
                        join stock_co_suppliers m on m.id = si.supplier_id
                       where si.item_id = v_id and si.archived_at is null) z),
    'catching_up', (select count(*) from stock_save_queue q
                     where q.org_id = v_item.org_id and q.status in ('waiting', 'running') and q.entity_ids @> array[v_id]),
    'packs', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('sites',
                (select coalesce(jsonb_agg(jsonb_build_object('location_id', ps.location_id, 'site_pack_id', ps.site_pack_id)
                                           order by ps.location_id), '[]'::jsonb)
                   from stock_co_pack_sites ps where ps.pack_id = p.id and ps.location_id::text = any(v_reach)))
                order by p.name, p.id), '[]'::jsonb)
                from stock_co_packs p where p.item_id = v_id),
    'bridges', (select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('sites',
                  (select coalesce(jsonb_agg(jsonb_build_object('location_id', bs.location_id, 'site_bridge_id', bs.site_bridge_id)
                                             order by bs.location_id), '[]'::jsonb)
                     from stock_co_bridge_sites bs where bs.bridge_id = b.id and bs.location_id::text = any(v_reach)))
                  order by b.created_at, b.id), '[]'::jsonb)
                  from stock_co_bridges b where b.item_id = v_id),
    'supplier_items', (select coalesce(jsonb_agg(to_jsonb(si) || jsonb_build_object('supplier_name', m.name,
                         'facts', jsonb_build_object('allergens', to_jsonb(si.allergens), 'may_contain', to_jsonb(si.may_contain),
                                                     'diets', to_jsonb(si.diets), 'ingredients_text', si.ingredients_text,
                                                     'nutrition', si.nutrition, 'checked_by_name', si.facts_checked_by_name,
                                                     'checked_at', si.facts_checked_at),
                         'unit_price', public.stock_co__unit_of_price(si.id, null),
                         'next_price', (select jsonb_build_object('price', dp.price, 'from_day', dp.from_day, 'id', dp.id)
                                          from stock_co_dated_prices dp
                                         where dp.supplier_item_id = si.id and dp.location_id is null and dp.status = 'waiting'
                                         order by dp.from_day, dp.id limit 1),
                         'sites',
                         (select coalesce(jsonb_agg(jsonb_build_object('location_id', x.location_id,
                                                                       'site_supplier_product_id', x.site_supplier_product_id,
                                                                       'price_here', x.price_here, 'off_here', x.off_here,
                                                                       'paused', x.paused, 'price', t.pack_price,
                                                                       'unit_price', public.stock_co__unit_of_price(si.id, t.pack_price),
                                                                       'next_price', (select jsonb_build_object('price', dp.price, 'from_day', dp.from_day, 'id', dp.id)
                                                                                        from stock_co_dated_prices dp
                                                                                       where dp.supplier_item_id = si.id and dp.location_id = x.location_id
                                                                                         and dp.status = 'waiting'
                                                                                       order by dp.from_day, dp.id limit 1))
                                                    order by x.location_id), '[]'::jsonb)
                            from stock_co_supplier_item_sites x
                            join supplier_products t on t.id = x.site_supplier_product_id
                           where x.supplier_item_id = si.id and x.location_id::text = any(v_reach)))
                         order by m.name, si.created_at, si.id), '[]'::jsonb)
                         from stock_co_supplier_items si join stock_co_suppliers m on m.id = si.supplier_id
                        where si.item_id = v_id),
    'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                'location_id', s.location_id, 'name', l.name, 'site_item_id', s.site_item_id, 'on_here', s.on_here, 'paused', s.paused,
                'supply_mode', s.supply_mode, 'counted_here', s.counted_here, 'stop_ordering_at', s.stop_ordering_at,
                'is_sellable', t.is_sellable, 'on_hand', t.on_hand, 'current_cost', t.current_cost, 'par_level', pl.par_level, 'reorder_point', pl.reorder_point,
                'min_level', pl.min_level,
                'area_id', ar.area_id,
                'row_version', s.row_version,
                'price_here', sh.price_here,
                'unit_price', case when sh.supplier_item_id is not null then public.stock_co__unit_of_price(sh.supplier_item_id, sh.pack_price) end,
                'supplier_here', case when sh.supplier_item_id is null then null
                                      else jsonb_build_object('supplier_item_id', sh.supplier_item_id, 'supplier_name', sh.supplier_name,
                                                              'site_supplier_product_id', sh.site_supplier_product_id) end,
                'last_paid', (select jsonb_build_object('unit_cost', h.base_unit_cost, 'pack_price', h.pack_price, 'pack_label', h.pack_label,
                                                        'at', h.effective_from, 'source', h.source)
                                from item_cost_history h
                               where h.inventory_item_id = s.site_item_id and h.location_id = s.location_id
                                 and h.source in ('INVOICE', 'PO_RECEIPT')
                               order by h.effective_from desc, h.created_at desc, h.id desc
                               limit 1),
                'why_on', s.why_on, 'paused_from', s.paused_from, 'paused_until', s.paused_until,
                'recipes_here', rh.n, 'recipe_names_here', rh.names,
                'area_name', ar.area_name,
                'can_order_suppliers', (select coalesce(jsonb_agg(jsonb_build_object('supplier_item_id', si.id, 'supplier_name', m.name)
                                                                  order by m.name, si.id), '[]'::jsonb)
                                          from stock_co_supplier_items si
                                          join stock_co_suppliers m on m.id = si.supplier_id
                                          join stock_co_supplier_sites ss on ss.supplier_id = si.supplier_id and ss.location_id = s.location_id
                                         where si.item_id = v_id and si.archived_at is null and m.archived_at is null and ss.can_order))
                order by l.name, l.id), '[]'::jsonb)
                from stock_co_item_sites s
                join locations l on l.id = s.location_id
                join inventory_items t on t.id = s.site_item_id
                left join par_levels pl on pl.location_id = s.location_id and pl.inventory_item_id = s.site_item_id
                left join lateral (select ia.area_id, a.name as area_name
                                     from inventory_item_areas ia left join storage_areas a on a.id = ia.area_id
                                    where ia.inventory_item_id = s.site_item_id and ia.location_id = s.location_id and ia.is_primary
                                    limit 1) ar on true
                left join lateral (select x.supplier_item_id, x.price_here, x.site_supplier_product_id, sp.pack_price, m.name as supplier_name
                                     from supplier_products sp
                                     join stock_co_supplier_item_sites x on x.site_supplier_product_id = sp.id and x.location_id = s.location_id
                                     join stock_co_supplier_items si on si.id = x.supplier_item_id
                                     join stock_co_suppliers m on m.id = si.supplier_id
                                    where sp.location_id = s.location_id and sp.inventory_item_id = s.site_item_id
                                      and sp.is_preferred and sp.archived_at is null
                                    order by sp.id
                                    limit 1) sh on true
                left join lateral (select count(*)::integer as n,
                                          (select coalesce(jsonb_agg(z.name order by z.name), '[]'::jsonb)
                                             from (select distinct r2.name from recipe_lines rl2 join recipes r2 on r2.id = rl2.recipe_id
                                                    where rl2.location_id = s.location_id and rl2.component_item_id = s.site_item_id
                                                      and r2.archived_at is null
                                                    order by r2.name limit 3) z) as names
                                     from recipe_lines rl join recipes r on r.id = rl.recipe_id
                                    where rl.location_id = s.location_id and rl.component_item_id = s.site_item_id
                                      and r.archived_at is null) rh on true
               where s.item_id = v_id and s.location_id::text = any(v_reach)));
end
$fn$;


-- REBUILT (Drop 2): the Drop 2 job kinds (set_recipe_sites, msm_recipe, swap_ingredient, facts_rebuild,
-- make_sizes) through stock_co__d2_step, with the same lock backoff and retry rules as the Drop 1 kinds.
-- Everything else exactly as Drop 1.
create or replace function public.stock_co__run_job(p_job bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  j          stock_save_queue%rowtype;
  v_items    uuid[];
  v_sups     uuid[];
  v_recs     uuid[];
  v_i        integer;
  v_s        integer;
  v_r        integer;
  v_ci       uuid[] := '{}';
  v_cs       uuid[] := '{}';
  v_cr       uuid[] := '{}';
  v_used     integer := 0;
  v_more     integer := 0;
  v_res      jsonb;
  v_writes   integer := 0;
  v_status   text;
  v_tries    integer;
  v_lock_was text := current_setting('lock_timeout');
begin
  select * into j from stock_save_queue q where q.id = p_job for update;
  if not found then
    return null;
  end if;
  if j.status <> 'waiting' then
    return j.status;
  end if;
  -- Drop 1 kinds: one step of at most 300 site rows (stock_co__d1_step), the same busy and error rules
  if j.kind in ('set_sites', 'pause', 'change_prices', 'import_commit', 'copy_site', 'category_rename', 'resync_site') then
    if (j.location_id is null and j.kind not in ('change_prices', 'import_commit', 'category_rename'))
       or (j.location_id is not null and not exists (select 1 from locations l where l.id = j.location_id and l.org_id = j.org_id)) then
      update stock_save_queue
         set status = 'failed', started_at = coalesce(started_at, now()), done_at = clock_timestamp(),
             last_error = 'That site is not in this company any more, so nothing was written there.'
       where id = p_job;
      return 'failed';
    end if;
    begin
      perform set_config('lock_timeout', '200ms', true);
      v_res := public.stock_co__d1_step(p_job);
      v_status := case when v_res ->> 'status' = 'done' then 'done' else 'waiting' end;
      update stock_save_queue
         set status = v_status,
             started_at = coalesce(started_at, now()),
             done_at = case when v_status = 'done' then clock_timestamp() end,
             due_at = case when v_status = 'waiting' then now() else due_at end,
             last_error = null,
             progress = progress || coalesce(v_res -> 'progress', '{}'::jsonb)
                        || jsonb_build_object('chunks', coalesce((progress ->> 'chunks')::integer, 0) + 1)
       where id = p_job;
      perform set_config('lock_timeout', v_lock_was, true);
      return v_status;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        update stock_save_queue
           set status = 'waiting', due_at = now() + interval '1 minute', started_at = coalesce(started_at, now()),
               last_error = 'The site was busy (a sale or a delivery held a stock item), so it gave way. It tries again in a minute.'
         where id = p_job;
        return 'waiting';
      when others then
        v_tries := j.attempts + 1;
        update stock_save_queue
           set attempts = v_tries,
               status = case when v_tries >= 5 then 'failed' else 'waiting' end,
               due_at = case when v_tries >= 5 then due_at else now() + make_interval(mins => v_tries) end,
               done_at = case when v_tries >= 5 then clock_timestamp() end,
               started_at = coalesce(started_at, now()),
               last_error = left(sqlerrm, 400),
               progress = progress || jsonb_build_object('error_code', sqlstate)
         where id = p_job;
        -- an import whose job failed says so on its own row too
        if v_tries >= 5 and j.kind = 'import_commit' then
          update stock_co_import_jobs ij set status = 'failed', row_version = ij.row_version + 1, updated_at = now()
           where ij.id = (j.payload ->> 'job_id')::uuid and ij.status in ('queued', 'running');
        end if;
        return case when v_tries >= 5 then 'failed' else 'waiting' end;
    end;
  end if;
  -- Drop 2 kinds: one step through stock_co__d2_step (one site, 20 recipes or one size a step), the same
  -- busy and error rules
  if j.kind in ('set_recipe_sites', 'msm_recipe', 'swap_ingredient', 'facts_rebuild', 'make_sizes') then
    if (j.location_id is null and j.kind in ('set_recipe_sites', 'facts_rebuild'))
       or (j.location_id is not null and not exists (select 1 from locations l where l.id = j.location_id and l.org_id = j.org_id)) then
      update stock_save_queue
         set status = 'failed', started_at = coalesce(started_at, now()), done_at = clock_timestamp(),
             last_error = 'That site is not in this company any more, so nothing was written there.'
       where id = p_job;
      return 'failed';
    end if;
    begin
      perform set_config('lock_timeout', '200ms', true);
      v_res := public.stock_co__d2_step(p_job);
      v_status := case when v_res ->> 'status' = 'done' then 'done' else 'waiting' end;
      update stock_save_queue
         set status = v_status,
             started_at = coalesce(started_at, now()),
             done_at = case when v_status = 'done' then clock_timestamp() end,
             due_at = case when v_status = 'waiting' then now() else due_at end,
             last_error = null,
             progress = progress || coalesce(v_res -> 'progress', '{}'::jsonb)
                        || jsonb_build_object('chunks', coalesce((progress ->> 'chunks')::integer, 0) + 1)
       where id = p_job;
      perform set_config('lock_timeout', v_lock_was, true);
      return v_status;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        update stock_save_queue
           set status = 'waiting', due_at = now() + interval '1 minute', started_at = coalesce(started_at, now()),
               last_error = 'The site was busy (a sale or a delivery held a stock item), so it gave way. It tries again in a minute.'
         where id = p_job;
        return 'waiting';
      when others then
        v_tries := j.attempts + 1;
        update stock_save_queue
           set attempts = v_tries,
               status = case when v_tries >= 5 then 'failed' else 'waiting' end,
               due_at = case when v_tries >= 5 then due_at else now() + make_interval(mins => v_tries) end,
               done_at = case when v_tries >= 5 then clock_timestamp() end,
               started_at = coalesce(started_at, now()),
               last_error = left(sqlerrm, 400),
               progress = progress || jsonb_build_object('error_code', sqlstate)
         where id = p_job;
        return case when v_tries >= 5 then 'failed' else 'waiting' end;
    end;
  end if;
  if j.kind is distinct from 'site_sync' or j.location_id is null
     or not exists (select 1 from locations l where l.id = j.location_id and l.org_id = j.org_id) then
    update stock_save_queue
       set status = 'failed', started_at = coalesce(started_at, now()), done_at = clock_timestamp(),
           last_error = case when j.kind is distinct from 'site_sync' then 'This database does not know this kind of save job.'
                             else 'That site is not in this company any more, so nothing was written there.' end
     where id = p_job;
    return 'failed';
  end if;

  begin
    perform set_config('lock_timeout', '200ms', true);

    -- the company ids of the job, each once, in the order given (a missing list means none)
    select coalesce(array_agg(x.id order by x.o), '{}') into v_items
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'item_ids') = 'array'
                                                  then j.payload -> 'item_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;
    select coalesce(array_agg(x.id order by x.o), '{}') into v_sups
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'supplier_ids') = 'array'
                                                  then j.payload -> 'supplier_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;
    select coalesce(array_agg(x.id order by x.o), '{}') into v_recs
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'recipe_ids') = 'array'
                                                  then j.payload -> 'recipe_ids' else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;

    -- how far earlier chunks got
    v_i := least(greatest(coalesce((j.progress ->> 'items_done')::integer, 0), 0), cardinality(v_items));
    v_s := least(greatest(coalesce((j.progress ->> 'suppliers_done')::integer, 0), 0), cardinality(v_sups));
    v_r := least(greatest(coalesce((j.progress ->> 'recipes_done')::integer, 0), 0), cardinality(v_recs));

    -- this chunk: items first, then suppliers in the room left, at least one record
    if v_i < cardinality(v_items) then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_ci, v_used
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             1 + (select count(*) from stock_co_packs p where p.org_id = j.org_id and p.item_id = x.id)
                               + (select count(*) from stock_co_bridges b where b.org_id = j.org_id and b.item_id = x.id)
                               + (select count(*) from stock_co_supplier_items s where s.org_id = j.org_id and s.item_id = x.id) as wt
                        from unnest(v_items[v_i + 1 : v_i + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 or c.o = 1;
    end if;
    if v_s < cardinality(v_sups) and v_used < 300 then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_cs, v_more
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             1 + (select count(*) from stock_co_supplier_items s where s.org_id = j.org_id and s.supplier_id = x.id) as wt
                        from unnest(v_sups[v_s + 1 : v_s + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 - v_used or (c.o = 1 and v_used = 0);
      v_used := v_used + v_more;
    end if;
    if cardinality(v_ci) > 0 or cardinality(v_cs) > 0 then
      v_res := public.stock_co__sync_site(j.location_id, v_ci, v_cs, true, false);
      v_writes := v_writes + coalesce((v_res ->> 'writes')::integer, 0);
    end if;
    v_i := v_i + cardinality(v_ci);
    v_s := v_s + cardinality(v_cs);

    -- recipes once every item and supplier of the job is at the site (their lines point at them)
    if v_i >= cardinality(v_items) and v_s >= cardinality(v_sups) and v_r < cardinality(v_recs) and v_used < 300 then
      select coalesce(array_agg(c.id order by c.o), '{}'), coalesce(max(c.cum), 0) into v_cr, v_more
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             2 + (select count(*) from stock_co_recipe_lines l where l.recipe_id = x.id) as wt
                        from unnest(v_recs[v_r + 1 : v_r + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 - v_used or (c.o = 1 and v_used = 0);
      if cardinality(v_cr) > 0 then
        v_res := public.stock_co__sync_recipes(j.location_id, v_cr, true, false);
        v_writes := v_writes + coalesce((v_res ->> 'writes')::integer, 0);
      end if;
      v_r := v_r + cardinality(v_cr);
    end if;

    v_status := case when v_i >= cardinality(v_items) and v_s >= cardinality(v_sups) and v_r >= cardinality(v_recs)
                     then 'done' else 'waiting' end;
    update stock_save_queue
       set status = v_status,
           started_at = coalesce(started_at, now()),
           done_at = case when v_status = 'done' then clock_timestamp() end,
           due_at = case when v_status = 'waiting' then now() else due_at end,
           last_error = null,
           progress = progress || jsonb_build_object(
             'items_done', v_i, 'suppliers_done', v_s, 'recipes_done', v_r,
             'writes', coalesce((progress ->> 'writes')::integer, 0) + v_writes,
             'chunks', coalesce((progress ->> 'chunks')::integer, 0) + 1)
     where id = p_job;
    perform set_config('lock_timeout', v_lock_was, true);
    return v_status;
  exception
    when lock_not_available or deadlock_detected or query_canceled then
      update stock_save_queue
         set status = 'waiting', due_at = now() + interval '1 minute', started_at = coalesce(started_at, now()),
             last_error = 'The site was busy (a sale or a delivery held a stock item), so it gave way. It tries again in a minute.'
       where id = p_job;
      return 'waiting';
    when others then
      v_tries := j.attempts + 1;
      update stock_save_queue
         set attempts = v_tries,
             status = case when v_tries >= 5 then 'failed' else 'waiting' end,
             due_at = case when v_tries >= 5 then due_at else now() + make_interval(mins => v_tries) end,
             done_at = case when v_tries >= 5 then clock_timestamp() end,
             started_at = coalesce(started_at, now()),
             last_error = left(sqlerrm, 400),
             progress = progress || jsonb_build_object('error_code', sqlstate)
       where id = p_job;
      return case when v_tries >= 5 then 'failed' else 'waiting' end;
  end;
end
$fn$;


-- REBUILT (Drop 2): a new last stage 'recipes' after 'rules': every company recipe on at the copied site
-- is switched on at the new site through stock_co__recipe_on_at (no till link), 20 a step; the copy_site
-- go live step is stamped after this stage. Everything else exactly as Drop 1.
create or replace function public.stock_co__copy_site_step(p_from uuid, p_to uuid, p_payload jsonb, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_stage text := coalesce(p_payload ->> 'stage', 'items');
  v_after uuid := nullif(p_payload ->> 'after', '')::uuid;
  v_by text := coalesce(nullif(btrim(coalesce(p_payload ->> 'by_name', '')), ''), 'head office');
  v_lim integer := least(greatest(coalesce(p_limit, 300), 1), 300);
  v_org uuid;
  v_ids uuid[];
  v_res jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_done integer := 0;
  v_x uuid;
  v_sid uuid;
  v_days jsonb;
  v_cut text;
  v_m stock_co_suppliers;
  v_link stock_co_supplier_sites;
  r record;
  v_fname text;
  v_on jsonb;
begin
  select l.org_id into v_org from locations l where l.id = p_to;
  if v_org is null or not exists (select 1 from locations l where l.id = p_from and l.org_id = v_org) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  perform set_config('servos.stock_co_source', 'copy_site', true);
  if v_stage = 'items' then
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_ids
      from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
              from (select i.id,
                           1 + (select count(*) from stock_co_packs p where p.item_id = i.id and p.archived_at is null)
                             + (select count(*) from stock_co_bridges b where b.item_id = i.id and b.archived_at is null)
                             + (select count(*) from stock_co_supplier_items si where si.item_id = i.id and si.archived_at is null) as wt
                      from stock_co_item_sites s
                      join stock_co_items i on i.id = s.item_id
                     where s.location_id = p_from and s.on_here and s.stop_ordering_at is null
                       and i.archived_at is null and i.local_location_id is null
                       and (v_after is null or i.id > v_after)
                     order by i.id
                     limit v_lim) w) c
     where c.cum <= v_lim or c.o = 1;
    if cardinality(v_ids) = 0 then
      v_stage := 'suppliers';
      v_after := null;
    else
      v_res := public.stock_co__set_sites_at(v_ids, p_to, 'add', v_by);
      v_refused := coalesce(v_res -> 'refused', '[]'::jsonb);
      v_after := v_ids[cardinality(v_ids)];
      v_done := cardinality(v_ids);
    end if;
  elsif v_stage = 'suppliers' then
    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_ids
      from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
              from (select m.id, 1 + (select count(*) from stock_co_supplier_items si where si.supplier_id = m.id and si.archived_at is null) as wt
                      from stock_co_supplier_sites ss
                      join stock_co_suppliers m on m.id = ss.supplier_id
                     where ss.location_id = p_from and ss.can_order and m.archived_at is null and m.local_location_id is null
                       and (v_after is null or m.id > v_after)
                     order by m.id
                     limit 50) w) c
     where c.cum <= v_lim or c.o = 1;
    if cardinality(v_ids) = 0 then
      v_stage := 'supplier_packs';
      v_after := null;
    else
      foreach v_x in array v_ids loop
        select * into v_m from stock_co_suppliers m where m.id = v_x;
        select * into v_link from stock_co_supplier_sites ss where ss.supplier_id = v_x and ss.location_id = p_to for update;
        if v_link.supplier_id is null then
          select t.id into v_sid from suppliers t
           where t.company_ref = v_x and t.location_id = p_to
             and not exists (select 1 from stock_co_supplier_sites z where z.site_supplier_id = t.id)
           order by (t.archived_at is null) desc, t.updated_at desc, t.id
           limit 1;
          if v_sid is not null then
            insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id, can_order)
            values (v_x, v_org, p_to, v_sid, true);
            update suppliers t set archived_at = null, row_version = t.row_version + 1, updated_at = now()
             where t.id = v_sid and t.location_id = p_to and t.archived_at is not null;
          else
            v_sid := public.stock_co__new_site_supplier(v_x, p_to);
            -- the order email and account number are the new site's to fill
            update suppliers t
               set email = null, account_number = null,
                   min_order_value = coalesce(t.min_order_value, v_m.min_order_value),
                   delivery_fee = coalesce(t.delivery_fee, v_m.delivery_fee),
                   row_version = t.row_version + 1, updated_at = now()
             where t.id = v_sid and t.location_id = p_to;
          end if;
          perform public.stock_co__log(v_org, p_to, 'supplier_site', v_x, 'can_order', to_jsonb(false), to_jsonb(true), 'copy_site');
        elsif not v_link.can_order then
          update stock_co_supplier_sites ss set can_order = true, row_version = ss.row_version + 1, updated_at = now()
           where ss.supplier_id = v_x and ss.location_id = p_to;
          update stock_co_supplier_item_sites x set off_here = false, row_version = x.row_version + 1, updated_at = now()
           where x.location_id = p_to and x.off_here
             and x.supplier_item_id in (select si.id from stock_co_supplier_items si where si.supplier_id = v_x);
          perform public.stock_co__log(v_org, p_to, 'supplier_site', v_x, 'can_order', to_jsonb(false), to_jsonb(true), 'copy_site');
        end if;
      end loop;
      v_after := v_ids[cardinality(v_ids)];
      v_done := cardinality(v_ids);
    end if;
  elsif v_stage in ('supplier_packs', 'supplier_rows') then
    -- the company suppliers this copy links (can order at p_from) that are set up at p_to
    v_ids := array(select ss.supplier_id
                     from stock_co_supplier_sites ss
                     join stock_co_suppliers m on m.id = ss.supplier_id
                    where ss.location_id = p_from and ss.can_order and m.archived_at is null and m.local_location_id is null
                      and exists (select 1 from stock_co_supplier_sites t where t.supplier_id = ss.supplier_id and t.location_id = p_to)
                    order by ss.supplier_id);
    if v_stage = 'supplier_packs' then
      v_x := public.stock_co__supplier_packs_step(p_to, v_ids, v_after, v_lim);
      if v_x is null then
        v_stage := 'supplier_rows';
      end if;
    else
      v_x := public.stock_co__supplier_rows_step(p_to, v_ids, v_after, v_lim);
      if v_x is null then
        v_stage := 'pars';
      end if;
    end if;
    v_after := v_x;
  elsif v_stage = 'pars' then
    select coalesce(array_agg(z.item_id order by z.item_id), '{}'::uuid[]) into v_ids
      from (select s1.item_id
              from par_levels p
              join stock_co_item_sites s1 on s1.site_item_id = p.inventory_item_id and s1.location_id = p_from
              join stock_co_item_sites s2 on s2.item_id = s1.item_id and s2.location_id = p_to
             where p.location_id = p_from and (v_after is null or s1.item_id > v_after)
             order by s1.item_id
             limit v_lim) z;
    if cardinality(v_ids) = 0 then
      v_stage := 'areas';
      v_after := null;
    else
      insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level, updated_at)
      select p_to, s2.site_item_id, p.par_level, p.reorder_point, p.min_level, now()
        from par_levels p
        join stock_co_item_sites s1 on s1.site_item_id = p.inventory_item_id and s1.location_id = p_from
        join stock_co_item_sites s2 on s2.item_id = s1.item_id and s2.location_id = p_to
       where p.location_id = p_from and s1.item_id = any(v_ids)
      on conflict (location_id, inventory_item_id) do nothing;
      v_after := v_ids[cardinality(v_ids)];
      v_done := cardinality(v_ids);
    end if;
  elsif v_stage = 'areas' then
    insert into storage_areas (location_id, name, kind, sort_order, is_receiving)
    select p_to, a.name, a.kind, a.sort_order, false
      from storage_areas a
     where a.location_id = p_from and a.archived_at is null and a.kind is not null
       and not exists (select 1 from storage_areas b where b.location_id = p_to and b.archived_at is null and b.kind = a.kind)
     order by a.sort_order, a.id
    on conflict do nothing;
    get diagnostics v_done = row_count;
    v_stage := 'rules';
    v_after := null;
  elsif v_stage = 'rules' then
    for r in
      select fs.site_supplier_id as from_sid, ts.site_supplier_id as to_sid, fs.supplier_id
        from stock_co_supplier_sites fs
        join stock_co_supplier_sites ts on ts.supplier_id = fs.supplier_id and ts.location_id = p_to and ts.can_order
       where fs.location_id = p_from
         and exists (select 1 from stock_order_rules o where o.supplier_id = fs.site_supplier_id)
         and not exists (select 1 from stock_order_rules o where o.supplier_id = ts.site_supplier_id)
       order by fs.supplier_id
    loop
      insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
      select v_org, p_to, r.to_sid, r.supplier_id, o.delivery_dow, o.order_by_dow, o.order_by_time
        from stock_order_rules o where o.supplier_id = r.from_sid;
      select z.delivery_days, z.cutoff_time into v_days, v_cut from public.stock_co__derive_days(r.to_sid) z;
      update suppliers t set delivery_days = v_days, cutoff_time = v_cut, row_version = t.row_version + 1, updated_at = now()
       where t.id = r.to_sid and t.location_id = p_to and (t.delivery_days, t.cutoff_time) is distinct from (v_days, v_cut);
      perform public.stock_co__log(v_org, p_to, 'supplier_site', r.supplier_id, 'order_rules', null,
                                   (select jsonb_agg(jsonb_build_object('delivery_dow', o.delivery_dow, 'order_by_dow', o.order_by_dow,
                                                                        'order_by_time', to_char(o.order_by_time, 'HH24:MI')) order by o.delivery_dow)
                                      from stock_order_rules o where o.supplier_id = r.to_sid), 'copy_site');
      v_done := v_done + 1;
    end loop;
    v_stage := 'recipes';
    v_after := null;
  elsif v_stage = 'recipes' then
    -- Drop 2: every company recipe on at p_from, switched on at p_to (its ingredients ticked there, no till
    -- link: the new site's menu is its own), 20 a step; the go live step is stamped after this stage
    select l.name into v_fname from locations l where l.id = p_from;
    v_ids := array(select rs.recipe_id
                     from stock_co_recipe_sites rs
                     join stock_co_recipes c on c.id = rs.recipe_id
                    where rs.location_id = p_from and rs.on_here and c.archived_at is null and c.local_location_id is null
                      and (v_after is null or rs.recipe_id > v_after)
                      and not exists (select 1 from stock_co_recipe_sites t where t.recipe_id = rs.recipe_id and t.location_id = p_to and t.on_here)
                    order by rs.recipe_id
                    limit 20);
    if cardinality(v_ids) = 0 then
      insert into stock_co_golive_steps (org_id, location_id, step, done_at, done_by, done_by_name)
      values (v_org, p_to, 'copy_site', now(), nullif(p_payload ->> 'by', '')::uuid, v_by)
      on conflict (location_id, step) do update
        set done_at = coalesce(stock_co_golive_steps.done_at, excluded.done_at), done_by = coalesce(stock_co_golive_steps.done_by, excluded.done_by),
            done_by_name = coalesce(stock_co_golive_steps.done_by_name, excluded.done_by_name),
            row_version = stock_co_golive_steps.row_version + 1, updated_at = now();
      perform public.stock_co__log(v_org, p_to, 'site', p_to, 'copy_site', null, jsonb_build_object('from', p_from), 'copy_site');
      perform set_config('servos.stock_co_source', '', true);
      return jsonb_build_object('payload', p_payload || jsonb_build_object('stage', 'finished', 'after', null), 'finished', true,
                                'done', v_done, 'refused', v_refused);
    end if;
    foreach v_x in array v_ids loop
      v_on := public.stock_co__recipe_on_at(v_x, p_to, null, 'Copied from ' || coalesce(v_fname, 'another site'), v_by);
      if not coalesce((v_on ->> 'ok')::boolean, false) then
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('recipe_id', v_x, 'location_id', p_to, 'error', v_on ->> 'error'));
      end if;
    end loop;
    v_after := v_ids[cardinality(v_ids)];
    v_done := cardinality(v_ids);
  end if;
  perform set_config('servos.stock_co_source', '', true);
  return jsonb_build_object('payload', p_payload || jsonb_build_object('stage', v_stage, 'after', v_after), 'finished', false,
                            'done', v_done, 'refused', v_refused);
end
$fn$;


-- REBUILT (Drop 2): kind 'recipe' is a real row: data {name, kind (dish, batch or prep), food_kind,
-- yield_qty, yield_unit, output_item, lines [{item, item_sku, qty, unit, usable_pct, order_types}], sites,
-- till_product}; action 'new' when no live company recipe of the company has that name, 'change' when
-- one does and the lines differ, 'same' otherwise; 'problem' when a line names an item not found by name
-- or sku ('Line n: <item> is not a stock item here.'), a unit ServOS does not know, or a made item not
-- found. Everything else exactly as Drop 1.
create or replace function public.stock_co__import_check_row(p_job uuid, p_kind text, p_data jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_name text := nullif(btrim(coalesce(p_data ->> 'name', '')), '');
  v_unit text := lower(nullif(btrim(coalesce(p_data ->> 'base_unit', '')), ''));
  v_id uuid;
  v_n integer;
  v_sup uuid;
  v_item uuid;
  v_loc uuid;
  v_x record;
  v_num text;
  k text;
begin
  select j.org_id into v_org from stock_co_import_jobs j where j.id = p_job;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('action', 'problem', 'problem', 'This row has no fields.');
  end if;
  -- the numbers a row may carry must be numbers, 0 or more
  foreach k in array array['pack_qty', 'inner_qty', 'pack_price', 'par_level', 'reorder_point', 'min_level', 'min_order_value',
                           'shelf_life_days', 'payment_terms_days', 'purchase_vat_rate'] loop
    v_num := nullif(btrim(coalesce(p_data ->> k, '')), '');
    if v_num is not null and v_num !~ '^[0-9]+(\.[0-9]+)?$' then
      return jsonb_build_object('action', 'problem', 'problem', format('"%s" in %s is not a number, 0 or more.', left(v_num, 40), k));
    end if;
  end loop;
  if p_kind = 'recipe' then
    -- Drop 2: a recipe row {name, kind, food_kind, yield_qty, yield_unit, output_item, lines [{item, item_sku,
    -- qty, unit, usable_pct, order_types}], sites, till_product}
    if v_name is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the recipe''s name.');
    end if;
    if coalesce(nullif(p_data ->> 'kind', ''), 'dish') not in ('dish', 'batch', 'prep') then
      return jsonb_build_object('action', 'problem', 'problem', 'Kind must be dish, batch or prep.');
    end if;
    if coalesce(nullif(p_data ->> 'food_kind', ''), 'food') not in ('food', 'drink', 'meal_deal') then
      return jsonb_build_object('action', 'problem', 'problem', 'Type must be food, drink or meal_deal.');
    end if;
    if nullif(btrim(coalesce(p_data ->> 'yield_unit', '')), '') is not null
       and not exists (select 1 from stock_units u where u.code = lower(btrim(p_data ->> 'yield_unit'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(p_data ->> 'yield_unit', 20)));
    end if;
    if jsonb_typeof(p_data -> 'lines') <> 'array' or jsonb_array_length(p_data -> 'lines') = 0 then
      return jsonb_build_object('action', 'problem', 'problem', 'Add at least one ingredient line.');
    end if;
    for v_x in select e.value as ln, e.ord from jsonb_array_elements(p_data -> 'lines') with ordinality e(value, ord) loop
      v_item := null;
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(v_x.ln ->> 'item', '')))
       order by i.created_at, i.id limit 1;
      if v_item is null and nullif(btrim(coalesce(v_x.ln ->> 'item_sku', '')), '') is not null then
        select i.id into v_item from stock_co_items i
         where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(v_x.ln ->> 'item_sku'))
         order by i.created_at, i.id limit 1;
      end if;
      if v_item is null and not exists (select 1 from stock_co_import_rows r
                                         where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                           and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(v_x.ln ->> 'item', '')))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('Line %s: %s is not a stock item here.', v_x.ord, left(coalesce(v_x.ln ->> 'item', v_x.ln ->> 'item_sku', ''), 80)));
      end if;
      if nullif(btrim(coalesce(v_x.ln ->> 'unit', '')), '') is null
         or not exists (select 1 from stock_units u where u.code = lower(btrim(v_x.ln ->> 'unit'))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('Line %s: "%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_x.ord, left(coalesce(v_x.ln ->> 'unit', ''), 20)));
      end if;
      v_num := nullif(btrim(coalesce(v_x.ln ->> 'qty', '')), '');
      if v_num is null or v_num !~ '^[0-9]+(\.[0-9]+)?$' or v_num::numeric <= 0 then
        return jsonb_build_object('action', 'problem', 'problem', format('Line %s: the amount must be a number above 0.', v_x.ord));
      end if;
    end loop;
    if coalesce(nullif(p_data ->> 'kind', ''), 'dish') in ('batch', 'prep') then
      v_item := null;
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'output_item', '')))
       order by i.created_at, i.id limit 1;
      if v_item is null and not exists (select 1 from stock_co_import_rows r
                                         where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                           and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'output_item', '')))) then
        return jsonb_build_object('action', 'problem', 'problem',
          format('%s is not a stock item here.', left(coalesce(nullif(p_data ->> 'output_item', ''), 'The made item'), 80)));
      end if;
    end if;
    select c.id into v_id from stock_co_recipes c
     where c.org_id = v_org and c.archived_at is null and lower(c.name) = lower(v_name)
     order by c.created_at, c.id limit 1;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    if exists ((select lower(btrim(coalesce(x ->> 'item', ''))), nullif(x ->> 'qty', '')::numeric, lower(btrim(coalesce(x ->> 'unit', ''))),
                       coalesce(nullif(x ->> 'usable_pct', '')::numeric, 100)
                  from jsonb_array_elements(p_data -> 'lines') x
                except all
                select lower(i.name), l.qty, l.unit, coalesce(l.usable_pct, 100)
                  from stock_co_recipe_lines l join stock_co_items i on i.id = l.component_item_id where l.recipe_id = v_id)
               union all
               (select lower(i.name), l.qty, l.unit, coalesce(l.usable_pct, 100)
                  from stock_co_recipe_lines l join stock_co_items i on i.id = l.component_item_id where l.recipe_id = v_id
                except all
                select lower(btrim(coalesce(x ->> 'item', ''))), nullif(x ->> 'qty', '')::numeric, lower(btrim(coalesce(x ->> 'unit', ''))),
                       coalesce(nullif(x ->> 'usable_pct', '')::numeric, 100)
                  from jsonb_array_elements(p_data -> 'lines') x)) then
      return jsonb_build_object('target_id', v_id, 'action', 'change');
    end if;
    return jsonb_build_object('target_id', v_id, 'action', 'same');
  elsif p_kind = 'item' then
    if v_name is null or v_unit is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add a name and a base unit.');
    end if;
    if not exists (select 1 from stock_units u where u.code = v_unit) then
      return jsonb_build_object('action', 'problem', 'problem', format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(v_unit, 20)));
    end if;
    if coalesce(p_data ->> 'type', '') <> '' and p_data ->> 'type' not in ('food', 'drink', 'other') then
      return jsonb_build_object('action', 'problem', 'problem', 'Type must be food, drink or other.');
    end if;
    select count(*), min(i.id::text)::uuid into v_n, v_id from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(v_name) and i.base_unit = v_unit;
    if v_n <> 1 then
      v_id := null;
      if nullif(btrim(coalesce(p_data ->> 'sku', '')), '') is not null then
        select count(*), min(i.id::text)::uuid into v_n, v_id from stock_co_items i
         where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'sku'));
        if v_n <> 1 then
          v_id := null;
        end if;
      end if;
    end if;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_items i where i.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (nullif(btrim(coalesce(p_data ->> 'category', '')), '') is not null
                  and lower(btrim(p_data ->> 'category')) is distinct from lower(btrim(coalesce(v_x.category, ''))))
             or (nullif(p_data ->> 'type', '') is not null and p_data ->> 'type' is distinct from v_x.type)
             or (nullif(btrim(coalesce(p_data ->> 'sku', '')), '') is not null and btrim(p_data ->> 'sku') is distinct from v_x.sku)
             or (nullif(btrim(coalesce(p_data ->> 'barcode', '')), '') is not null and btrim(p_data ->> 'barcode') is distinct from v_x.barcode)
             or (nullif(p_data ->> 'shelf_life_days', '') is not null
                 and (p_data ->> 'shelf_life_days')::numeric::integer is distinct from v_x.shelf_life_days)
             or (nullif(p_data ->> 'purchase_vat_rate', '') is not null
                 and (p_data ->> 'purchase_vat_rate')::numeric is distinct from v_x.purchase_vat_rate)
           then 'change' else 'same' end);
  elsif p_kind = 'supplier' then
    if v_name is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the supplier''s name.');
    end if;
    select m.id into v_id from stock_co_suppliers m
     where m.org_id = v_org and m.archived_at is null and lower(m.name) = lower(v_name)
     order by m.created_at, m.id limit 1;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_suppliers m where m.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (nullif(btrim(coalesce(p_data ->> 'email', '')), '') is not null and btrim(p_data ->> 'email') is distinct from v_x.email)
             or (nullif(btrim(coalesce(p_data ->> 'phone', '')), '') is not null and btrim(p_data ->> 'phone') is distinct from v_x.phone)
             or (nullif(btrim(coalesce(p_data ->> 'contact_name', '')), '') is not null
                 and btrim(p_data ->> 'contact_name') is distinct from v_x.contact_name)
           then 'change' else 'same' end);
  elsif p_kind = 'supplier_item' then
    if nullif(btrim(coalesce(p_data ->> 'supplier', '')), '') is null
       or coalesce(nullif(btrim(coalesce(p_data ->> 'item', '')), ''), nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '')) is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the supplier and the stock item.');
    end if;
    if nullif(p_data ->> 'pack_price', '') is null or nullif(p_data ->> 'inner_unit', '') is null then
      return jsonb_build_object('action', 'problem', 'problem', 'Add the pack price and its unit.');
    end if;
    if not exists (select 1 from stock_units u where u.code = lower(btrim(p_data ->> 'inner_unit'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('"%s" is not a unit ServOS knows (g, kg, ml, l, each, ...).', left(p_data ->> 'inner_unit', 20)));
    end if;
    select m.id into v_sup from stock_co_suppliers m
     where m.org_id = v_org and m.archived_at is null and lower(m.name) = lower(btrim(p_data ->> 'supplier'))
     order by m.created_at, m.id limit 1;
    if v_sup is null and not exists (select 1 from stock_co_import_rows r
                                      where r.job_id = p_job and r.kind = 'supplier' and r.action = 'new'
                                        and lower(btrim(r.data ->> 'name')) = lower(btrim(p_data ->> 'supplier'))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No supplier called %s. Add it to the file or the list first.', left(p_data ->> 'supplier', 80)));
    end if;
    -- by name first (the name index), then by the item's sku
    select i.id into v_item from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'item', '')))
     order by i.created_at, i.id limit 1;
    if v_item is null and nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '') is not null then
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'item_sku'))
       order by i.created_at, i.id limit 1;
    end if;
    if v_item is null and not exists (select 1 from stock_co_import_rows r
                                       where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                         and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'item', '')))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No stock item called %s. Add it to the file or the list first.', left(coalesce(p_data ->> 'item', p_data ->> 'item_sku'), 80)));
    end if;
    if v_sup is null or v_item is null then
      return jsonb_build_object('action', 'new');
    end if;
    select si.id into v_id from stock_co_supplier_items si
     where si.org_id = v_org and si.supplier_id = v_sup and si.archived_at is null
       and nullif(btrim(coalesce(p_data ->> 'supplier_sku', '')), '') is not null and lower(si.sku) = lower(btrim(p_data ->> 'supplier_sku'))
     order by si.created_at, si.id limit 1;
    if v_id is null then
      select si.id into v_id from stock_co_supplier_items si
       where si.org_id = v_org and si.supplier_id = v_sup and si.item_id = v_item and si.archived_at is null
         and si.pack_qty = coalesce(nullif(p_data ->> 'pack_qty', '')::numeric, 1)
         and si.inner_qty = coalesce(nullif(p_data ->> 'inner_qty', '')::numeric, 1)
         and si.inner_unit = lower(btrim(p_data ->> 'inner_unit'))
       order by si.created_at, si.id limit 1;
    end if;
    if v_id is null then
      return jsonb_build_object('action', 'new');
    end if;
    select * into v_x from stock_co_supplier_items si where si.id = v_id;
    return jsonb_build_object('target_id', v_id, 'action',
      case when (p_data ->> 'pack_price')::numeric is distinct from v_x.pack_price then 'change' else 'same' end);
  elsif p_kind = 'par' then
    -- by name first (the name index), then by the item's sku
    select i.id into v_item from stock_co_items i
     where i.org_id = v_org and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(p_data ->> 'item', '')))
     order by i.created_at, i.id limit 1;
    if v_item is null and nullif(btrim(coalesce(p_data ->> 'item_sku', '')), '') is not null then
      select i.id into v_item from stock_co_items i
       where i.org_id = v_org and i.archived_at is null and lower(i.sku) = lower(btrim(p_data ->> 'item_sku'))
       order by i.created_at, i.id limit 1;
    end if;
    select l.id into v_loc from locations l where l.org_id = v_org and lower(l.name) = lower(btrim(coalesce(p_data ->> 'site', '')))
     order by l.id limit 1;
    if v_loc is null then
      return jsonb_build_object('action', 'problem', 'problem', format('No site called %s.', left(coalesce(p_data ->> 'site', ''), 80)));
    end if;
    if v_item is null and not exists (select 1 from stock_co_import_rows r
                                       where r.job_id = p_job and r.kind = 'item' and r.action = 'new'
                                         and lower(btrim(r.data ->> 'name')) = lower(btrim(coalesce(p_data ->> 'item', '')))) then
      return jsonb_build_object('action', 'problem', 'problem',
        format('No stock item called %s. Add it to the file or the list first.', left(coalesce(p_data ->> 'item', p_data ->> 'item_sku', ''), 80)));
    end if;
    return jsonb_build_object('action', 'change', 'target_id', v_item);
  end if;
  return jsonb_build_object('action', 'problem', 'problem', 'This kind of row is not known.');
end
$fn$;


-- REBUILT (Drop 2): recipe rows are applied through stock_co__recipe_put (the body of stock_save_recipe
-- without the guard) and switched on at the row's sites (or the job's) through stock_co__recipe_on_at; no
-- till link is made on import (Recipe missing offers it); change log source 'import'. Everything else
-- exactly as Drop 1.
create or replace function public.stock_co__import_apply(p_job uuid, p_after integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_j stock_co_import_jobs;
  v_by text;
  v_weight integer := 0;
  v_rows integer := 0;
  v_last integer := coalesce(p_after, 0);
  v_refused jsonb := '[]'::jsonb;
  v_sites uuid[];
  v_id uuid;
  v_sup uuid;
  v_item uuid;
  v_loc uuid;
  v_site_item uuid;
  v_si stock_co_supplier_items;
  v_new stock_co_items;
  v_x uuid;
  v_s uuid;
  v_days jsonb;
  v_cut text;
  v_tl uuid[] := '{}'::uuid[];
  v_ti uuid[] := '{}'::uuid[];
  v_yl uuid[] := '{}'::uuid[];
  v_yi uuid[] := '{}'::uuid[];
  v_ul uuid[] := '{}'::uuid[];
  v_us uuid[] := '{}'::uuid[];
  r record;
  d jsonb;
  v_lines jsonb;
  v_ln jsonb;
  v_put jsonb;
  v_on jsonb;
begin
  select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
  if v_j.id is null then
    return jsonb_build_object('last_row', v_last, 'rows', 0, 'finished', true, 'refused', '[]'::jsonb);
  end if;
  v_by := coalesce(nullif(btrim(coalesce(v_j.created_by_name, '')), ''), 'import');
  perform set_config('servos.stock_co_source', 'import', true);
  for r in
    select * from stock_co_import_rows x
     where x.job_id = p_job and x.row_no > v_last
     order by x.row_no
     limit 300
  loop
    exit when v_weight >= 300;
    v_last := r.row_no;
    v_rows := v_rows + 1;
    d := r.data;
    v_sites := array(select l.id from locations l
                      where l.org_id = v_j.org_id and l.id = any(coalesce(r.sites, v_j.sites))
                      order by l.id);
    -- a par row needs the items of the rows before it ticked at their sites first
    if r.kind = 'par' and cardinality(v_tl) > 0 then
      perform public.stock_co__import_flush(v_tl, v_ti, v_by, 'tick');
      v_tl := '{}'::uuid[];
      v_ti := '{}'::uuid[];
    end if;
    begin
      if r.done or r.action in ('skip', 'problem') then
        null;
      elsif r.kind = 'recipe' then
        -- Drop 2: a recipe row through stock_co__recipe_put, then on at the row's sites (no till link:
        -- Recipe missing offers it)
        v_lines := '[]'::jsonb;
        for v_ln in select e.value from jsonb_array_elements(case when jsonb_typeof(d -> 'lines') = 'array' then d -> 'lines' else '[]'::jsonb end) e loop
          v_item := null;
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(v_ln ->> 'item', '')))
           order by i.created_at, i.id limit 1;
          if v_item is null and nullif(btrim(coalesce(v_ln ->> 'item_sku', '')), '') is not null then
            select i.id into v_item from stock_co_items i
             where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(v_ln ->> 'item_sku'))
             order by i.created_at, i.id limit 1;
          end if;
          if v_item is null then
            raise exception 'The stock item % of this recipe is not there.', coalesce(v_ln ->> 'item', v_ln ->> 'item_sku', '')
              using errcode = '22023';
          end if;
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'component_item_id', v_item, 'qty', nullif(v_ln ->> 'qty', '')::numeric, 'unit', lower(btrim(coalesce(v_ln ->> 'unit', ''))),
            'usable_pct', nullif(v_ln ->> 'usable_pct', '')::numeric,
            'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' then v_ln -> 'order_types' end));
        end loop;
        v_item := null;
        if coalesce(nullif(d ->> 'kind', ''), 'dish') in ('batch', 'prep') then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'output_item', '')))
           order by i.created_at, i.id limit 1;
          if v_item is null then
            raise exception 'The made item % of this recipe is not there.', coalesce(d ->> 'output_item', '') using errcode = '22023';
          end if;
        end if;
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_recipes c where c.id = v_id and c.archived_at is null) then
          select c.id into v_id from stock_co_recipes c
           where c.org_id = v_j.org_id and c.archived_at is null and lower(c.name) = lower(btrim(d ->> 'name'))
           order by c.created_at, c.id limit 1;
        end if;
        if v_id is null or r.action = 'change' then
          v_put := public.stock_co__recipe_put(v_j.org_id, null,
                     jsonb_build_object('kind', coalesce(nullif(d ->> 'kind', ''), 'dish'), 'name', btrim(d ->> 'name'),
                                        'food_kind', nullif(d ->> 'food_kind', ''),
                                        'yield_qty', coalesce(nullif(d ->> 'yield_qty', '')::numeric, 1),
                                        'yield_unit', coalesce(nullif(lower(btrim(coalesce(d ->> 'yield_unit', ''))), ''), 'each'),
                                        'output_item_id', v_item)
                     || case when v_id is null then '{}'::jsonb else jsonb_build_object('id', v_id) end,
                     public.stock_co__recipe_lines_clean(v_j.org_id, null, v_lines),
                     jsonb_build_object('uid', v_j.created_by, 'name', v_by), 'import');
          v_id := (v_put ->> 'id')::uuid;
        end if;
        foreach v_s in array v_sites loop
          v_on := public.stock_co__recipe_on_at(v_id, v_s, null, 'Added by ' || v_by, v_by);
          if not coalesce((v_on ->> 'ok')::boolean, false) and jsonb_array_length(v_refused) < 50 then
            v_refused := v_refused || jsonb_build_array(jsonb_build_object('row_no', r.row_no, 'location_id', v_s, 'error', left(v_on ->> 'error', 300)));
          end if;
        end loop;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 2 + jsonb_array_length(v_lines) * greatest(cardinality(v_sites), 1);
      elsif r.kind = 'item' then
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_items i where i.id = v_id and i.archived_at is null) then
          -- matched again at commit time: a row earlier in the file may have made it
          select i.id into v_id from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(d ->> 'name'))
             and i.base_unit = lower(btrim(d ->> 'base_unit'))
           order by i.created_at, i.id limit 1;
        end if;
        if v_id is null then
          v_new := jsonb_populate_record(null::stock_co_items, jsonb_build_object(
                     'id', gen_random_uuid(), 'org_id', v_j.org_id, 'name', btrim(d ->> 'name'),
                     'base_unit', lower(btrim(d ->> 'base_unit')), 'type', nullif(d ->> 'type', ''),
                     'sku', nullif(btrim(coalesce(d ->> 'sku', '')), ''), 'barcode', nullif(btrim(coalesce(d ->> 'barcode', '')), ''),
                     'shelf_life_days', nullif(d ->> 'shelf_life_days', '')::numeric::integer,
                     'purchase_vat_rate', nullif(d ->> 'purchase_vat_rate', '')::numeric,
                     'allergens', case when jsonb_typeof(d -> 'allergens') = 'array' then d -> 'allergens' else '[]'::jsonb end,
                     'returns_to_shelf', false, 'exclude_from_gp', false, 'key_item', false,
                     'row_version', 1, 'created_at', now(), 'updated_at', now(), 'updated_by', v_j.created_by));
          v_new.category_id := public.stock_co__category_for(v_j.org_id, d ->> 'category');
          v_new.category := (select c.name from stock_co_categories c where c.id = v_new.category_id);
          insert into stock_co_items select (v_new).*;
          v_id := v_new.id;
          perform public.stock_co__log(v_j.org_id, null, 'item', v_id, 'created', null, to_jsonb(v_new) - array['updated_at', 'row_version', 'created_at', 'updated_by'], 'import');
          if jsonb_typeof(d -> 'count_pack') = 'object' and nullif(d -> 'count_pack' ->> 'name', '') is not null
             and coalesce(nullif(d -> 'count_pack' ->> 'qty_in_base', '')::numeric, 0) > 0 then
            insert into stock_co_packs (org_id, item_id, name, qty_in_base, is_count_default, is_purchase_default)
            values (v_j.org_id, v_id, btrim(d -> 'count_pack' ->> 'name'), (d -> 'count_pack' ->> 'qty_in_base')::numeric, true, false);
          end if;
        else
          update stock_co_items i
             set category_id = case when nullif(btrim(coalesce(d ->> 'category', '')), '') is not null
                                    then public.stock_co__category_for(v_j.org_id, d ->> 'category') else i.category_id end,
                 type = case when nullif(d ->> 'type', '') is not null then d ->> 'type' else i.type end,
                 sku = case when nullif(btrim(coalesce(d ->> 'sku', '')), '') is not null then btrim(d ->> 'sku') else i.sku end,
                 barcode = case when nullif(btrim(coalesce(d ->> 'barcode', '')), '') is not null then btrim(d ->> 'barcode') else i.barcode end,
                 shelf_life_days = case when nullif(d ->> 'shelf_life_days', '') is not null then (d ->> 'shelf_life_days')::numeric::integer
                                        else i.shelf_life_days end,
                 purchase_vat_rate = case when nullif(d ->> 'purchase_vat_rate', '') is not null then (d ->> 'purchase_vat_rate')::numeric
                                          else i.purchase_vat_rate end,
                 row_version = i.row_version + 1, updated_at = now(), updated_by = v_j.created_by
           where i.id = v_id and r.action = 'change';
          update stock_co_items i set category = (select c.name from stock_co_categories c where c.id = i.category_id)
           where i.id = v_id and r.action = 'change' and i.category is distinct from (select c.name from stock_co_categories c where c.id = i.category_id);
          if r.action = 'change' then
            perform public.stock_co__log(v_j.org_id, null, 'item', v_id, 'import', null, d, 'import');
          end if;
        end if;
        -- ticked at its sites (and a changed item written at its sites) once per step, below
        v_tl := v_tl || v_sites;
        v_ti := v_ti || array_fill(v_id, array[cardinality(v_sites)]);
        if r.action = 'change' then
          select v_yl || coalesce(array_agg(s.location_id), '{}'::uuid[]), v_yi || coalesce(array_agg(s.item_id), '{}'::uuid[])
            into v_yl, v_yi
            from stock_co_item_sites s where s.item_id = v_id;
        end if;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + greatest(cardinality(v_sites), (select count(*)::integer from stock_co_item_sites s where s.item_id = v_id));
      elsif r.kind = 'supplier' then
        v_id := r.target_id;
        if v_id is null then
          select m.id into v_id from stock_co_suppliers m
           where m.org_id = v_j.org_id and m.archived_at is null and lower(m.name) = lower(btrim(d ->> 'name'))
           order by m.created_at, m.id limit 1;
        end if;
        if v_id is null then
          insert into stock_co_suppliers (org_id, name, contact_name, phone, email, payment_terms_days, min_order_value, accepts_price_changes, order_method)
          values (v_j.org_id, btrim(d ->> 'name'), nullif(btrim(coalesce(d ->> 'contact_name', '')), ''), nullif(btrim(coalesce(d ->> 'phone', '')), ''),
                  nullif(btrim(coalesce(d ->> 'email', '')), ''), nullif(d ->> 'payment_terms_days', '')::numeric::integer,
                  nullif(d ->> 'min_order_value', '')::numeric, true, 'email')
          returning id into v_id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier', v_id, 'created', null, d, 'import');
        elsif r.action = 'change' then
          update stock_co_suppliers m
             set email = coalesce(nullif(btrim(coalesce(d ->> 'email', '')), ''), m.email),
                 phone = coalesce(nullif(btrim(coalesce(d ->> 'phone', '')), ''), m.phone),
                 contact_name = coalesce(nullif(btrim(coalesce(d ->> 'contact_name', '')), ''), m.contact_name),
                 row_version = m.row_version + 1, updated_at = now()
           where m.id = v_id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier', v_id, 'import', null, d, 'import');
        end if;
        foreach v_s in array v_sites loop
          select ss.site_supplier_id into v_x from stock_co_supplier_sites ss where ss.supplier_id = v_id and ss.location_id = v_s;
          if v_x is null then
            v_x := public.stock_co__new_site_supplier(v_id, v_s);
            perform public.stock_co__log(v_j.org_id, v_s, 'supplier_site', v_id, 'can_order', to_jsonb(false), to_jsonb(true), 'import');
          end if;
          -- the site's own values only where it has none
          update suppliers t
             set account_number = coalesce(t.account_number, nullif(btrim(coalesce(d ->> 'account_number', '')), '')),
                 min_order_value = coalesce(t.min_order_value, nullif(d ->> 'min_order_value', '')::numeric),
                 delivery_days = case when coalesce(jsonb_array_length(case when jsonb_typeof(t.delivery_days) = 'array' then t.delivery_days end), 0) = 0
                                       and jsonb_typeof(d -> 'delivery_days') = 'array' then d -> 'delivery_days' else t.delivery_days end,
                 cutoff_time = coalesce(t.cutoff_time, nullif(btrim(coalesce(d ->> 'cutoff_time', '')), '')),
                 row_version = t.row_version + 1, updated_at = now()
           where t.id = v_x and t.location_id = v_s
             and ((t.account_number is null and nullif(btrim(coalesce(d ->> 'account_number', '')), '') is not null)
                  or (t.min_order_value is null and nullif(d ->> 'min_order_value', '') is not null)
                  or (coalesce(jsonb_array_length(case when jsonb_typeof(t.delivery_days) = 'array' then t.delivery_days end), 0) = 0
                      and jsonb_typeof(d -> 'delivery_days') = 'array' and jsonb_array_length(d -> 'delivery_days') > 0)
                  or (t.cutoff_time is null and nullif(btrim(coalesce(d ->> 'cutoff_time', '')), '') is not null));
          if found then
            perform public.stock_co__seed_order_rules(v_x);
            select z.delivery_days, z.cutoff_time into v_days, v_cut from public.stock_co__derive_days(v_x) z;
            update suppliers t set delivery_days = v_days, cutoff_time = v_cut
             where t.id = v_x and t.location_id = v_s
               and (t.delivery_days, t.cutoff_time) is distinct from (v_days, v_cut);
          end if;
          v_ul := v_ul || v_s;
          v_us := v_us || v_id;
        end loop;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + cardinality(v_sites);
      elsif r.kind = 'supplier_item' then
        select m.id into v_sup from stock_co_suppliers m
         where m.org_id = v_j.org_id and m.archived_at is null and lower(m.name) = lower(btrim(d ->> 'supplier'))
         order by m.created_at, m.id limit 1;
        select i.id into v_item from stock_co_items i
         where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'item', '')))
         order by i.created_at, i.id limit 1;
        if v_item is null and nullif(btrim(coalesce(d ->> 'item_sku', '')), '') is not null then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(d ->> 'item_sku'))
           order by i.created_at, i.id limit 1;
        end if;
        if v_sup is null or v_item is null then
          raise exception 'The supplier or the stock item of this row is not there.' using errcode = '22023';
        end if;
        v_id := r.target_id;
        if v_id is null or not exists (select 1 from stock_co_supplier_items si where si.id = v_id and si.archived_at is null) then
          select si.id into v_id from stock_co_supplier_items si
           where si.org_id = v_j.org_id and si.supplier_id = v_sup and si.item_id = v_item and si.archived_at is null
             and si.pack_qty = coalesce(nullif(d ->> 'pack_qty', '')::numeric, 1)
             and si.inner_qty = coalesce(nullif(d ->> 'inner_qty', '')::numeric, 1)
             and si.inner_unit = lower(btrim(d ->> 'inner_unit'))
           order by si.created_at, si.id limit 1;
        end if;
        select l.id into v_loc from locations l
         where l.org_id = v_j.org_id and nullif(btrim(coalesce(d ->> 'site', '')), '') is not null and lower(l.name) = lower(btrim(d ->> 'site'))
         order by l.id limit 1;
        if v_id is null then
          insert into stock_co_supplier_items (org_id, item_id, supplier_id, supplier_product_name, sku, pack_description, pack_qty, inner_qty,
                                               inner_unit, pack_price, currency, purchase_vat_rate, price_includes_tax)
          values (v_j.org_id, v_item, v_sup, nullif(btrim(coalesce(d ->> 'supplier_product_name', '')), ''),
                  nullif(btrim(coalesce(d ->> 'supplier_sku', '')), ''), nullif(btrim(coalesce(d ->> 'pack_description', '')), ''),
                  coalesce(nullif(d ->> 'pack_qty', '')::numeric, 1), coalesce(nullif(d ->> 'inner_qty', '')::numeric, 1),
                  lower(btrim(d ->> 'inner_unit')), round((d ->> 'pack_price')::numeric, 4),
                  coalesce(nullif(upper(btrim(coalesce(d ->> 'currency', ''))), ''),
                           (select coalesce(l.currency, 'GBP') from locations l where l.org_id = v_j.org_id order by l.created_at, l.id limit 1)),
                  nullif(d ->> 'purchase_vat_rate', '')::numeric, coalesce((d ->> 'price_includes_tax')::boolean, false))
          returning * into v_si;
          v_id := v_si.id;
          perform public.stock_co__log(v_j.org_id, null, 'supplier_item', v_id, 'created', null, d, 'import');
        elsif v_loc is not null then
          perform public.stock_co__price_apply(v_j.org_id, jsonb_build_array(jsonb_build_object('supplier_item_id', v_id, 'item_id', v_item,
                    'location_id', v_loc, 'after', round((d ->> 'pack_price')::numeric, 4))));
        elsif r.action = 'change' then
          perform public.stock_co__price_apply(v_j.org_id, jsonb_build_array(jsonb_build_object('supplier_item_id', v_id, 'item_id', v_item,
                    'location_id', null, 'after', round((d ->> 'pack_price')::numeric, 4))));
        end if;
        select v_yl || coalesce(array_agg(s.location_id), '{}'::uuid[]), v_yi || coalesce(array_agg(s.item_id), '{}'::uuid[])
          into v_yl, v_yi
          from stock_co_item_sites s
          join stock_co_supplier_sites ss on ss.supplier_id = v_sup and ss.location_id = s.location_id
         where s.item_id = v_item;
        update stock_co_import_rows x set target_id = v_id where x.job_id = p_job and x.row_no = r.row_no;
        v_weight := v_weight + 1 + (select count(*)::integer from stock_co_item_sites s where s.item_id = v_item);
      elsif r.kind = 'par' then
        select i.id into v_item from stock_co_items i
         where i.org_id = v_j.org_id and i.archived_at is null and lower(i.name) = lower(btrim(coalesce(d ->> 'item', '')))
         order by i.created_at, i.id limit 1;
        if v_item is null and nullif(btrim(coalesce(d ->> 'item_sku', '')), '') is not null then
          select i.id into v_item from stock_co_items i
           where i.org_id = v_j.org_id and i.archived_at is null and lower(i.sku) = lower(btrim(d ->> 'item_sku'))
           order by i.created_at, i.id limit 1;
        end if;
        select l.id into v_loc from locations l where l.org_id = v_j.org_id and lower(l.name) = lower(btrim(coalesce(d ->> 'site', '')))
         order by l.id limit 1;
        select s.site_item_id into v_site_item from stock_co_item_sites s where s.item_id = v_item and s.location_id = v_loc;
        if v_site_item is null then
          raise exception '% is not on at %. Tick it there first.', coalesce(d ->> 'item', 'This item'), coalesce(d ->> 'site', 'that site')
            using errcode = '22023';
        end if;
        insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level, updated_at)
        values (v_loc, v_site_item, nullif(d ->> 'par_level', '')::numeric, nullif(d ->> 'reorder_point', '')::numeric,
                nullif(d ->> 'min_level', '')::numeric, now())
        on conflict (location_id, inventory_item_id)
          do update set par_level = coalesce(excluded.par_level, par_levels.par_level),
                        reorder_point = coalesce(excluded.reorder_point, par_levels.reorder_point),
                        min_level = coalesce(excluded.min_level, par_levels.min_level), updated_at = now();
        perform public.stock_co__log(v_j.org_id, v_loc, 'item_site', v_item, 'par', null, d, 'import');
        v_weight := v_weight + 1;
      end if;
      update stock_co_import_rows x set done = true where x.job_id = p_job and x.row_no = r.row_no;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        raise;
      when others then
        update stock_co_import_rows x set done = true, problem = left(sqlerrm, 300) where x.job_id = p_job and x.row_no = r.row_no;
        if jsonb_array_length(v_refused) < 50 then
          v_refused := v_refused || jsonb_build_array(jsonb_build_object('row_no', r.row_no, 'error', left(sqlerrm, 300)));
        end if;
    end;
  end loop;
  -- the site writes of this step, once per site: ticks, then suppliers, then items
  perform public.stock_co__import_flush(v_tl, v_ti, v_by, 'tick');
  perform public.stock_co__import_flush(v_ul, v_us, v_by, 'suppliers');
  perform public.stock_co__import_flush(v_yl, v_yi, v_by, 'items');
  perform set_config('servos.stock_co_source', '', true);
  return jsonb_build_object('last_row', v_last, 'rows', v_rows, 'refused', v_refused,
                            'finished', not exists (select 1 from stock_co_import_rows x where x.job_id = p_job and x.row_no > v_last));
end
$fn$;


-- REBUILT (Drop 2): recipe adds food_kind, meal_food_pct, portion_weight_g, cooking_yield_pct,
-- shelf_life_days, msm_product_id and sites (create only); supplier_item adds the facts (allergens,
-- may_contain, diets, ingredients_text, nutrition); new targets nutrition, option_rule,
-- recipe_site_change, swap_spec, size_spec and recipe_link. Everything else exactly as Drop 1.
create or replace function public.stock_co__allowed(p_target text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case p_target
    when 'item' then '{"id":"uuid","site_item_id":"uuid","location_id":"uuid","name":"text","category":"text","accounting_group":"text","base_unit":"unit","sku":"text","barcode":"text","shelf_life_days":"int","allergens":"array","returns_to_shelf":"bool","purchase_tax_rate_id":"uuid","purchase_vat_rate":"rate","type":"enum:food|drink|other","exclude_from_gp":"bool","key_item":"bool","notes":"text","site":"object:item_site","category_id":"uuid","main_supplier_item_id":"uuid"}'::jsonb
    when 'item_site' then '{"kind":"enum:PURCHASED|MADE","is_tracked":"bool","is_sellable":"bool","cost_method":"enum:MOVING_AVG|LAST_COST","storage_location":"text","default_supplier_id":"uuid","notes":"text"}'::jsonb
    when 'item_site_patch' then '{"par_level":"nonneg","reorder_point":"nonneg","min_level":"nonneg","area_id":"uuid","move_holding":"bool","by_name":"text","counted_here":"bool","price_here":"money","supplier_here":"uuid","stop_ordering":"bool","paused":"bool","paused_from":"date","paused_until":"date"}'::jsonb
    when 'pack' then '{"id":"uuid","site_pack_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","name":"text","qty_in_base":"pos","parent_pack_id":"uuid","site_parent_pack_id":"uuid","is_count_default":"bool","is_purchase_default":"bool"}'::jsonb
    when 'bridge' then '{"id":"uuid","site_bridge_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","from_qty":"pos","from_unit":"unit","to_qty":"pos","to_unit":"unit"}'::jsonb
    when 'supplier' then '{"id":"uuid","site_supplier_id":"uuid","location_id":"uuid","name":"text","contact_name":"text","phone":"text","payment_terms_days":"int","email":"text","accepts_price_changes":"bool","max_order_value":"money","order_method":"enum:email|held","notes":"text","site":"object:supplier_site","min_order_value":"money","delivery_fee":"money"}'::jsonb
    when 'supplier_site' then '{"account_number":"text","email":"text","cc_emails":"textarray","min_order_value":"money","delivery_fee":"money","delivery_days":"array","cutoff_time":"text","notes":"text"}'::jsonb
    when 'supplier_site_patch' then '{"account_number":"text","email":"text","cc_emails":"textarray","can_order":"bool","min_order_value":"money","delivery_fee":"money","approval_limit":"money"}'::jsonb
    when 'supplier_item' then '{"id":"uuid","site_supplier_product_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","supplier_id":"uuid","site_supplier_id":"uuid","supplier_sku":"text","supplier_product_name":"text","pack_description":"text","pack_qty":"pos","inner_qty":"pos","inner_unit":"unit","pack_price":"money","currency":"currency","purchase_tax_rate_id":"uuid","purchase_vat_rate":"rate","price_includes_tax":"bool","site":"object:supplier_item_site","paused":"bool","agreed_until":"date","allowed_diff_pct":"pct","allergens":"textarray","may_contain":"textarray","diets":"textarray","ingredients_text":"text","nutrition":"object:nutrition"}'::jsonb
    when 'supplier_item_site' then '{"is_preferred":"bool"}'::jsonb
    when 'supplier_item_site_patch' then '{"price_here":"money","off_here":"bool","paused":"bool"}'::jsonb
    when 'recipe' then '{"id":"uuid","site_recipe_id":"uuid","location_id":"uuid","name":"text","recipe_type":"enum:MENU|BATCH|PREP","output_item_id":"uuid","site_output_item_id":"uuid","yield_qty":"pos","yield_unit":"unit","wastage_pct":"nonneg","gp_target_pct":"num","method":"text","photo":"text","menu_item_id":"text","portion":"pos","food_kind":"enum:food|drink|meal_deal","meal_food_pct":"pct","portion_weight_g":"nonneg","cooking_yield_pct":"pct","shelf_life_days":"int","msm_product_id":"uuid","sites":"array"}'::jsonb
    when 'recipe_line' then '{"component_item_id":"uuid","site_component_item_id":"uuid","qty":"num","unit":"text","pack_id":"uuid","usable_pct":"pos","sort_order":"int","note":"text","order_types":"array"}'::jsonb
    when 'category' then '{"id":"uuid","org_id":"uuid","name":"text","accounting_code":"text","gp_target_pct":"pct","sort_order":"int"}'::jsonb
    when 'settings' then '{"week_start":"int","waste_reasons":"array","usual_areas":"array","invoice_tolerance_pct":"pct","invoice_tolerance_amount":"money","send_unapproved_at_cutoff":"bool","waste_pin_over_value":"money","count_second_approval_over":"money","sites":"array"}'::jsonb
    when 'golive_step' then '{"step":"enum:copy_site|opening_count|train_the_trainer|side_by_side|switch_off","due_day":"date","done":"bool","note":"text"}'::jsonb
    when 'site_group' then '{"id":"uuid","org_id":"uuid","name":"text","location_ids":"array","sort_order":"int","row_version":"int"}'::jsonb
    when 'nutrition' then '{"kcal":"nonneg","fat_g":"nonneg","saturates_g":"nonneg","carbs_g":"nonneg","sugars_g":"nonneg","protein_g":"nonneg","salt_g":"nonneg","fibre_g":"nonneg"}'::jsonb
    when 'option_rule' then '{"id":"uuid","recipe_id":"uuid","kind":"enum:replace|remove","option_name":"text","option_msm_product_id":"uuid","option_company_item_id":"uuid","replaces_item_id":"uuid","removes_item_id":"uuid","site_modifiers":"array"}'::jsonb
    when 'recipe_site_change' then '{"location_id":"uuid","on":"bool","menu_item_id":"text","portion":"pos","how":"enum:bought|batches|to_order","by_hand":"bool"}'::jsonb
    when 'swap_spec' then '{"mode":"enum:swap|amount","from_item_id":"uuid","to_item_id":"uuid","recipe_ids":"array","qty":"pos","unit":"text","factor":"pos"}'::jsonb
    when 'size_spec' then '{"name":"text","factor":"pos"}'::jsonb
    when 'recipe_link' then '{"location_id":"uuid","menu_item_id":"text","recipe_id":"uuid"}'::jsonb
    else null end;
$fn$;


-- REBUILT (Drop 2): after the links are removed, every facts row that pointed at this recipe at any site
-- loses its recipe side (recipe_allergens empty, kcal null) and asks for a check when it showed any
-- allergen ('Check again: this product is no longer linked to a recipe'); never deleted, never fewer
-- shown. recipe_cost_daily rows stay. The answer adds "facts_rows". Everything else exactly as Drop 1.
create or replace function public.stock_archive_recipe(p_recipe uuid, p_version integer default null, p_archived boolean default true,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_id uuid := public.stock_co__company_id('recipe', p_recipe);
  v_old stock_co_recipes;
  v_section text;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_before integer;
  v_after integer;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_facts integer := 0;
  v_fl uuid;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_recipes x where x.id = v_id;
  v_section := public.stock_co__section(p_section,
                 case when v_old.output_item_id is not null then array['produce', 'inventory'] else array['produce'] end);
  if p_recipe <> v_id then
    v_loc := public.stock_co__site_loc('recipe', p_recipe);
    select t.row_version into v_srv from recipes t where t.id = p_recipe;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[v_loc]);
  select * into v_old from stock_co_recipes x where x.id = v_id for update;
  perform public.stock_co__need_version('company', p_version);
  if p_version is not null then
    v_rv := case when p_recipe <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['recipe', 'recipe_site', 'menu_link'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  select count(*) into v_before from menu_item_recipes m
   where m.recipe_id in (select s.site_recipe_id from stock_co_recipe_sites s where s.recipe_id = v_id);
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_recipes x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  if v_at is not null then
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.recipe_id = v_id and s.site_menu_item_id is not null;
  end if;
  v_log := public.stock_co__log(v_old.org_id, null, 'recipe', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id),
                                      '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);
  select count(*) into v_after from menu_item_recipes m
   where m.recipe_id in (select s.site_recipe_id from stock_co_recipe_sites s where s.recipe_id = v_id);
  if p_recipe <> v_id then
    update recipes t set row_version = t.row_version + 1 where t.id = p_recipe and t.row_version = v_srv;
  end if;
  -- Drop 2: every facts row that pointed at this recipe keeps its shown allergens and asks for a check
  if v_at is not null then
    for v_fl in select distinct x.location_id::uuid from menu_item_stock_facts x where x.recipe_id = v_id order by 1 loop
      v_facts := v_facts + public.stock_co__facts_mark(v_fl, null, v_id, 'Check again: this product is no longer linked to a recipe');
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at, 'facts_rows', v_facts,
                            'sites', (select count(*) from stock_co_recipe_sites s where s.recipe_id = v_id),
                            'links_removed', greatest(v_before - v_after, 0), 'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 2): after the link, the facts of that till product are rebuilt and linked_at is stamped;
-- an unlink keeps the facts row and asks for a check, as the archive does. The answer adds "facts_rows".
-- Everything else exactly as Drop 1.
create or replace function public.stock_link_menu_item(p_location uuid, p_menu_item_id text, p_recipe uuid, p_portion numeric default 1,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['produce']);
  v_org uuid;
  v_g jsonb;
  v_cid uuid;
  v_sid uuid;
  v_old text;
  v_src text := 'save_unversioned';
  v_fr jsonb;
  v_n integer;
begin
  if p_location is null or nullif(btrim(coalesce(p_menu_item_id, '')), '') is null then
    raise exception 'Name the venue and the till product.' using errcode = '22023';
  end if;
  if p_portion is not null and p_portion <= 0 then
    raise exception 'The portion must be more than 0.' using errcode = '22023';
  end if;
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[p_location]);
  select m.recipe_id::text into v_old from menu_item_recipes m where m.location_id = p_location and m.menu_item_id = p_menu_item_id;
  if p_recipe is null then
    delete from menu_item_recipes m where m.location_id = p_location and m.menu_item_id = p_menu_item_id;
    select s.recipe_id into v_cid from stock_co_recipe_sites s
     where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id
     order by s.recipe_id limit 1;
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id;
    if v_old is not null then
      perform public.stock_co__log(v_org, p_location, 'menu_link', coalesce(v_cid, v_old::uuid), 'menu_item_id',
                                   to_jsonb(p_menu_item_id), null, v_src);
    end if;
    v_n := public.stock_co__facts_mark(p_location, array[p_menu_item_id], null, 'Check again: this product is no longer linked to a recipe');
    return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', null,
                              'queued', '[]'::jsonb, 'facts_rows', v_n);
  end if;
  if exists (select 1 from stock_co_recipes x where x.id = p_recipe) then
    v_cid := p_recipe;
    select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_location;
  else
    select t.id into v_sid from recipes t where t.id = p_recipe and t.location_id = p_location;
    select s.recipe_id into v_cid from stock_co_recipe_sites s where s.site_recipe_id = v_sid and s.location_id = p_location;
  end if;
  if v_sid is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if exists (select 1 from recipes t where t.id = v_sid and t.archived_at is not null) then
    raise exception 'This recipe is archived, so it cannot be linked.' using errcode = '55000';
  end if;
  if not exists (select 1 from menu_items m where m.id = p_menu_item_id and m.location_id = p_location::text) then
    raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
  end if;
  update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
   where s.location_id = p_location and s.site_menu_item_id = p_menu_item_id and s.site_recipe_id <> v_sid;
  update stock_co_recipe_sites s set site_menu_item_id = p_menu_item_id, row_version = s.row_version + 1, updated_at = now()
   where s.site_recipe_id = v_sid and s.site_menu_item_id is distinct from p_menu_item_id;
  update stock_co_recipe_sites s set linked_at = now() where s.site_recipe_id = v_sid;
  insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
  values (p_location, p_menu_item_id, v_sid, coalesce(p_portion, 1))
  on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id, portion = excluded.portion;
  if v_old is distinct from v_sid::text then
    perform public.stock_co__log(v_org, p_location, 'menu_link', coalesce(v_cid, v_sid), 'menu_item_id', null, to_jsonb(p_menu_item_id), v_src);
  end if;
  v_fr := public.stock_co__facts_rebuild_site(p_location, array[p_menu_item_id]);
  return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', v_sid,
                            'queued', '[]'::jsonb, 'facts_rows', coalesce((v_fr ->> 'rows')::integer, 0));
end
$fn$;


-- REBUILT (Drop 2): p_entity 'recipe' is allowed (a local recipe becomes a company recipe: its
-- local_location_id is cleared, logged). Sections: produce. Everything else exactly as Drop 1.
create or replace function public.stock_make_company_record(p_entity text, p_id uuid, p_version integer, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text;
  v_id uuid;
  v_org uuid;
  v_loc uuid;
  v_rv integer;
  v_at timestamptz;
  v_g jsonb;
begin
  perform public.stock_co__signed_in();
  if p_entity is null or p_entity not in ('item', 'supplier', 'recipe') then
    raise exception 'The field "entity" must be item, supplier or recipe.' using errcode = '22023';
  end if;
  v_section := public.stock_co__section(p_section, case p_entity when 'item' then array['inventory'] when 'recipe' then array['produce']
                                                                 else array['purchasing'] end);
  v_id := public.stock_co__company_id(p_entity, p_id);
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_entity = 'item' then
    select i.org_id, i.local_location_id into v_org, v_loc from stock_co_items i where i.id = v_id;
  elsif p_entity = 'recipe' then
    select r.org_id, r.local_location_id into v_org, v_loc from stock_co_recipes r where r.id = v_id;
  else
    select m.org_id, m.local_location_id into v_org, v_loc from stock_co_suppliers m where m.id = v_id;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[coalesce(v_loc, public.stock_co__org_site(v_org))]);
  if p_entity = 'item' then
    select i.row_version, i.updated_at, i.local_location_id into v_rv, v_at, v_loc from stock_co_items i where i.id = v_id for update;
  elsif p_entity = 'recipe' then
    select r.row_version, r.updated_at, r.local_location_id into v_rv, v_at, v_loc from stock_co_recipes r where r.id = v_id for update;
  else
    select m.row_version, m.updated_at, m.local_location_id into v_rv, v_at, v_loc from stock_co_suppliers m where m.id = v_id for update;
  end if;
  perform public.stock_co__need_version('company', p_version);
  if v_rv is distinct from p_version then
    return public.stock_co__conflict(v_org, array[p_entity], v_id, v_rv, v_loc, v_at);
  end if;
  if v_loc is not null then
    if p_entity = 'item' then
      update stock_co_items i set local_location_id = null, row_version = i.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
       where i.id = v_id returning i.row_version into v_rv;
    elsif p_entity = 'recipe' then
      update stock_co_recipes r set local_location_id = null, row_version = r.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
       where r.id = v_id returning r.row_version into v_rv;
    else
      update stock_co_suppliers m set local_location_id = null, row_version = m.row_version + 1, updated_at = now()
       where m.id = v_id returning m.row_version into v_rv;
    end if;
    perform public.stock_co__log(v_org, null, p_entity, v_id, 'local_location_id', to_jsonb(v_loc), null, 'save');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv);
end
$fn$;


-- REBUILT (Drop 2): after the dated prices and inside the same advisory lock, the Multi site menu scan and
-- run (stock_msm_recipe_scan, stock_msm_recipe_run(20)), each in its own block: a failure is one failed
-- 'msm_recipe' queue row at most once an hour and never stops the jobs. Everything else exactly as Drop 1.
create or replace procedure public.stock_save_queue_run(p_budget_s integer default 45)
language plpgsql
as $proc$
declare
  v_t0     timestamptz := clock_timestamp();
  v_budget integer := greatest(coalesce(p_budget_s, 45), 0);
  v_lock   bigint := hashtext('stock_save_queue_run');
  v_id     bigint;
begin
  -- Drop 1: the dated prices whose day has begun, each minute, before the jobs. A failure is kept as one
  -- failed 'dated_prices' row (at most one an hour) and never stops the jobs.
  if pg_try_advisory_xact_lock(v_lock) then
    begin
      perform public.stock_co__apply_dated_prices(200);
    exception when others then
      insert into public.stock_save_queue (org_id, location_id, kind, payload, status, attempts, last_error, started_at, done_at)
      select d.org_id, null, 'dated_prices', '{}'::jsonb, 'failed', 1, left(sqlerrm, 400), now(), clock_timestamp()
        from public.stock_co_dated_prices d
       where d.status = 'waiting'
         and not exists (select 1 from public.stock_save_queue q
                          where q.kind = 'dated_prices' and q.status = 'failed' and q.done_at > now() - interval '1 hour')
       order by d.from_day, d.id
       limit 1;
    end;
    -- Drop 2: the Multi site menu queue (a recipe ticked on where a menu publish added its product). Each
    -- stage in its own block: a failure is one failed 'msm_recipe' row (at most one an hour) and never
    -- stops the jobs. Nothing here touches a menu table.
    begin
      perform public.stock_msm_recipe_scan();
    exception when others then
      insert into public.stock_save_queue (org_id, location_id, kind, payload, status, attempts, last_error, started_at, done_at)
      select o.id, null, 'msm_recipe', '{"stage":"scan"}'::jsonb, 'failed', 1, left(sqlerrm, 400), now(), clock_timestamp()
        from (select distinct i.org_id as id from public.stock_co_items i order by 1 limit 1) o
       where not exists (select 1 from public.stock_save_queue q
                          where q.kind = 'msm_recipe' and q.status = 'failed' and q.done_at > now() - interval '1 hour');
    end;
    begin
      perform public.stock_msm_recipe_run(20);
    exception when others then
      insert into public.stock_save_queue (org_id, location_id, kind, payload, status, attempts, last_error, started_at, done_at)
      select o.id, null, 'msm_recipe', '{"stage":"run"}'::jsonb, 'failed', 1, left(sqlerrm, 400), now(), clock_timestamp()
        from (select distinct i.org_id as id from public.stock_co_items i order by 1 limit 1) o
       where not exists (select 1 from public.stock_save_queue q
                          where q.kind = 'msm_recipe' and q.status = 'failed' and q.done_at > now() - interval '1 hour');
    end;
    commit;
  end if;
  -- nothing due: return at once, holding nothing for the rest of the minute
  if not exists (select 1 from public.stock_save_queue q where q.status = 'waiting' and q.due_at <= now()) then
    return;
  end if;
  loop
    if not pg_try_advisory_xact_lock(v_lock) then
      exit;
    end if;
    v_id := null;
    select q.id into v_id
      from public.stock_save_queue q
     where q.status = 'waiting' and q.due_at <= now()
     order by q.due_at, q.id
     limit 1
     for update skip locked;
    if v_id is null then
      commit;
      exit;
    end if;
    begin
      perform public.stock_co__run_job(v_id);
    exception when others then
      -- run_job keeps its own errors; this only catches one in its own bookkeeping
      update public.stock_save_queue
         set attempts = attempts + 1,
             status = case when attempts + 1 >= 5 then 'failed' else 'waiting' end,
             due_at = now() + make_interval(mins => attempts + 1),
             done_at = case when attempts + 1 >= 5 then clock_timestamp() end,
             last_error = left(sqlerrm, 400)
       where id = v_id;
    end;
    commit;
    exit when clock_timestamp() - v_t0 > make_interval(secs => v_budget);
  end loop;
end
$proc$;


-- REBUILT (Drop 2): one more arm, last: the facts rows of the venue (menu_item_stock_facts), so a catalogue
-- push follows an allergen or calorie change. Same signature, same grants (service_role).
create or replace function public.hubrise_menu_fingerprint(p_location_id text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select md5(concat_ws('|',
    (select coalesce(string_agg(md5(t::text), ',' order by t.id), '') from public.menu_items t where t.location_id = p_location_id),
    (select coalesce(string_agg(md5(t::text), ',' order by t.id), '') from public.menu_categories t where t.location_id = p_location_id),
    (select coalesce(string_agg(md5(t::text), ',' order by t.id), '') from public.modifier_groups t where t.location_id = p_location_id),
    (select coalesce(string_agg(md5(t::text), ',' order by t.id::text), '') from public.tax_rates t where t.location_id::text = p_location_id),
    (select coalesce(string_agg(md5(t::text), ',' order by t.id), '') from public.menus t where t.location_id = p_location_id),
    (select coalesce(string_agg(l.menu_id || ':' || l.category_id, ',' order by l.menu_id, l.category_id), '')
       from public.menu_category_links l join public.menus m on m.id = l.menu_id where m.location_id = p_location_id),
    (select coalesce(md5((c.snapshot -> 'instructionGroupDefs')::text), '')
       from public.config_pushes c where c.location_id = p_location_id order by c.created_at desc limit 1),
    (select coalesce(array_to_string(h.menu_ids, ','), '') || ':' || coalesce(h.currency, '')
       from public.hubrise_connections h where h.location_id = p_location_id),
    (select coalesce(string_agg(md5(t::text), ',' order by t.menu_item_id), '') from public.menu_item_stock_facts t where t.location_id = p_location_id)
  ));
$function$;


-- ============================================================================
-- STEP 9. THE DATA STEP (company tables and the new tables only; no site row, no menu row)
-- ============================================================================
-- Allergens move onto the supplier items as a union (never fewer): every live supplier item of an item
-- that carries allergens gets the item's values added, without a row_version or updated_at bump, with a
-- change log row (source d2_seed). An item with no live supplier item keeps its own values and is marked
-- facts_source 'item'. The item's own allergens are left exactly as they are (so the writer plans no
-- site write) and the step stops if the roll up over its live supplier items is not the same set of ids.
do $d2_allergens$
declare
  r record;
  s record;
  v_vals text[];
  v_new text[];
  v_roll text[];
  v_moved integer := 0;
begin
  for r in
    select i.id, i.org_id, i.allergens
      from public.stock_co_items i
     where jsonb_typeof(i.allergens) = 'array' and jsonb_array_length(i.allergens) > 0
     order by i.id
  loop
    v_vals := public.stock_co__allergen_ids(array(select jsonb_array_elements_text(r.allergens)));
    if not exists (select 1 from public.stock_co_supplier_items si where si.item_id = r.id and si.archived_at is null) then
      update public.stock_co_items i set facts_source = 'item' where i.id = r.id and i.facts_source is distinct from 'item';
      continue;
    end if;
    for s in
      select si.id, si.allergens from public.stock_co_supplier_items si
       where si.item_id = r.id and si.archived_at is null order by si.id
    loop
      v_new := public.stock_co__allergen_ids(array_cat(coalesce(s.allergens, '{}'::text[]), v_vals));
      if v_new is distinct from s.allergens then
        update public.stock_co_supplier_items si set allergens = v_new where si.id = s.id;
        perform public.stock_co__log(r.org_id, null, 'supplier_item', s.id, 'allergens', to_jsonb(s.allergens), to_jsonb(v_new), 'd2_seed');
      end if;
    end loop;
    v_moved := v_moved + 1;
    insert into _stock_native2_seed (org_id, metric, value) values (r.org_id, 'moved', 1)
    on conflict (org_id, metric) do update set value = _stock_native2_seed.value + 1;
    v_roll := public.stock_co__allergen_ids(array(
                select a from public.stock_co_supplier_items si, unnest(coalesce(si.allergens, '{}'::text[])) a
                 where si.item_id = r.id and si.archived_at is null));
    if array(select x from unnest(v_roll) x order by x) is distinct from array(select x from unnest(v_vals) x order by x) then
      raise exception 'The allergens of stock item % would change when moved onto its supplier items. Nothing was changed. Send this line to Claude.', r.id;
    end if;
  end loop;
end
$d2_allergens$;

-- The first facts build: every till link at every site that holds stock whose recipe has a company
-- record. allergens = typed union recipe; nothing needs a check yet; nothing is checked.
do $d2_facts$
declare
  l record;
begin
  for l in
    select x.id from public.locations x
     where x.org_id in (select distinct i.org_id from public.stock_co_items i)
     order by x.id
  loop
    perform public.stock_co__facts_rebuild_site(l.id, null);
  end loop;
end
$d2_facts$;

-- The Multi site menu cursor: the newest finished site run, so nothing already published is replayed.
insert into public.stock_msm_recipe_cursor (one, finished_at, version_id, location_id, scanned_at)
select true, coalesce(n.finished_at, now()), n.version_id, n.location_id, now()
  from (select 1) z
  left join lateral (select vs.finished_at, vs.version_id, vs.location_id from public.msm_version_sites vs
                      where vs.status in ('done', 'nothing') and vs.finished_at is not null
                      order by vs.finished_at desc, vs.version_id desc, vs.location_id desc limit 1) n on true;

-- ============================================================================
-- STEP 10. GRANTS (contract 1.10): every new function revoked by name, then exactly the grant listed
-- ============================================================================
revoke all on function public.stock_co__d2_org_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d2_cost_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__allergen_ids(text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__diet_ids() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__allergen_label(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__norm_name(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_sites_of(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__menu_price_net(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__unit_cost_js(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_cost_at(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_total(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__cost_rows(uuid[], uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d2_enqueue(uuid, uuid, text, jsonb, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_of_item(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_walk(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_of_recipe(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_rebuild_site(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_mark(uuid, text[], uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__facts_rebuild_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_nested(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_components(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_lines_clean(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_put(uuid, uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_on_at(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_off_at(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__resolve_modifier(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__option_rule_sites(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__match_recipe(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__unit_fits(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__swap_plan(jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__swap_apply(uuid, jsonb, uuid[], jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__make_size(uuid, text, numeric, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d2_step(bigint) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__cost_row_of(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipes_page(uuid, uuid[], text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_detail(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_cost(uuid, uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.stock_plate_costs(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_missing(uuid, uuid[], jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_facts(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_card(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_prep_list(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_batch_how(uuid, uuid[], text, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_menu_products(uuid, text, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__set_how(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_set_recipe_sites(uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_recipe_link_products(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_batch_set_how(uuid, uuid, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_option_rule(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_option_rule(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_swap_ingredient(jsonb, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_make_sizes(uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_prep_tick(uuid, uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_prep_untick(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_facts_signoff(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_facts_rebuild(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_msm_recipe_scan() from public, anon, authenticated, service_role;
revoke all on function public.stock_msm_recipe_run(integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_nightly_recipes(uuid) from public, anon, authenticated, service_role;
grant execute on function public.stock_recipes_page(uuid, uuid[], text, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_recipe_detail(uuid) to authenticated;
grant execute on function public.stock_recipe_cost(uuid, uuid[], text) to authenticated;
grant execute on function public.stock_plate_costs(uuid, text, integer) to authenticated;
grant execute on function public.stock_recipe_missing(uuid, uuid[], jsonb, integer) to authenticated;
grant execute on function public.stock_recipe_facts(uuid, uuid[]) to authenticated;
grant execute on function public.stock_recipe_card(uuid, text, uuid) to anon, authenticated, service_role;
grant execute on function public.stock_prep_list(uuid, date) to authenticated;
grant execute on function public.stock_batch_how(uuid, uuid[], text, jsonb, integer) to authenticated;
grant execute on function public.stock_recipe_menu_products(uuid, text, jsonb, integer) to authenticated;
grant execute on function public.stock_set_recipe_sites(uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_recipe_link_products(jsonb, text) to authenticated;
grant execute on function public.stock_batch_set_how(uuid, uuid, text, integer, text) to authenticated;
grant execute on function public.stock_save_option_rule(jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_option_rule(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_swap_ingredient(jsonb, boolean, text) to authenticated;
grant execute on function public.stock_make_sizes(uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_prep_tick(uuid, uuid, numeric, text) to authenticated;
grant execute on function public.stock_prep_untick(uuid) to authenticated;
grant execute on function public.stock_facts_signoff(uuid, text, text) to authenticated;
grant execute on function public.stock_facts_rebuild(uuid, text[]) to service_role;
grant execute on function public.stock_msm_recipe_scan() to service_role;
grant execute on function public.stock_msm_recipe_run(integer) to service_role;
grant execute on function public.stock_nightly_recipes(uuid) to service_role;

-- every stock_co__ helper closed to the API roles (a revoke, never a drop), then the four that 0a and 0b
-- opened go back
do $d2_internals$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and left(p.proname, 9) = 'stock_co_' and substr(p.proname, 10, 1) = '_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end
$d2_internals$;
grant execute on function public.stock_co__writer_ok() to authenticated, service_role;
grant execute on function public.stock_co__site_lock() to authenticated, service_role;
grant execute on function public.stock_co__site_price_lock() to authenticated, service_role;
grant execute on function public.stock_co__ledger_lock() to authenticated, service_role;

do $d2_acl$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync|swap|prep|facts|batch|recipe_link)_'
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'The anon key could run a stock save: %. Nothing was changed. Send this line to Claude.', v_bad;
  end if;
end
$d2_acl$;

-- ============================================================================
-- STEP 11. THE COMPARE: no site row, login or menu row changed
-- ============================================================================
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

do $d2_compare$
declare
  v_diff text;
begin
  select string_agg(coalesce(a.location_id, b.location_id)::text || ' ' || coalesce(a.metric, b.metric), ', ' order by 1) into v_diff
    from _stock_native2_snap a
    full join _stock_native2_now b on b.location_id = a.location_id and b.metric = a.metric
   where a.metric is null or b.metric is null
      or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_diff is not null then
    raise exception 'A site row, a login or a menu row changed: %. Nothing was changed. Send this line to Claude.', left(v_diff, 600);
  end if;
end
$d2_compare$;

notify pgrst, 'reload schema';

-- ============================================================================
-- THE CHECK ROW (one row per company that holds stock). Paste it back.
-- ============================================================================
select o.org_id,
       (select count(*) filter (where coalesce(l.status, 'active') = 'active') >= 2 or bool_or(s.multi_since is not null)
          from public.locations l left join public.stock_co_settings s on s.org_id = l.org_id where l.org_id = o.org_id) as multi,
       coalesce((select x.value from _stock_native2_seed x where x.org_id = o.org_id and x.metric = 'moved'), 0)::integer as items_allergens_moved,
       (select count(*) from public.stock_co_supplier_items si
         where si.org_id = o.org_id and si.archived_at is null and cardinality(coalesce(si.allergens, '{}'::text[])) > 0)::integer
         as supplier_items_with_allergens,
       (select count(*) from public.stock_co_items i where i.org_id = o.org_id and i.facts_source = 'item')::integer as items_keeping_own_allergens,
       true as rollup_unchanged,
       (select count(*) from public.menu_item_stock_facts f join public.locations l on l.id::text = f.location_id where l.org_id = o.org_id)::integer
         as facts_rows,
       (select count(*) from public.menu_item_stock_facts f join public.locations l on l.id::text = f.location_id
         where l.org_id = o.org_id and f.needs_check)::integer as facts_needs_check,
       (select count(*) from public.menu_item_stock_facts f join public.locations l on l.id::text = f.location_id
         where l.org_id = o.org_id and f.checked_at is not null)::integer as facts_checked,
       (select count(*) from public.recipe_cost_daily c join public.locations l on l.id = c.location_id where l.org_id = o.org_id)::integer
         as recipe_cost_rows,
       (select count(*) = 1 from public.stock_msm_recipe_cursor) as msm_cursor_set,
       (select count(*) from public.stock_msm_recipe_jobs j where j.org_id = o.org_id)::integer as msm_jobs,
       (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd2:')::integer as replaced_functions,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('stock_recipes_page', 'stock_recipe_detail', 'stock_recipe_cost', 'stock_plate_costs', 'stock_recipe_missing', 'stock_recipe_facts', 'stock_recipe_card', 'stock_prep_list', 'stock_batch_how', 'stock_recipe_menu_products', 'stock_set_recipe_sites', 'stock_recipe_link_products', 'stock_batch_set_how', 'stock_save_option_rule', 'stock_archive_option_rule', 'stock_swap_ingredient', 'stock_make_sizes', 'stock_prep_tick', 'stock_prep_untick', 'stock_facts_signoff', 'stock_facts_rebuild', 'stock_msm_recipe_scan', 'stock_msm_recipe_run', 'stock_nightly_recipes'))::integer as new_functions,
       (select count(*) from (values ('menu_item_stock_facts'), ('stock_msm_recipe_jobs'), ('stock_msm_recipe_cursor'), ('recipe_cost_daily'),
                                     ('stock_prep_ticks')) t(n) where to_regclass('public.' || t.n) is not null)::integer as new_tables,
       (to_regclass('public.msm_version_sites_finished') is not null) as msm_index,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and left(p.proname, 9) = 'stock_co_' and substr(p.proname, 10, 1) = '_'
                  and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock')
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync|swap|prep|facts|batch|recipe_link)_'
                  and has_function_privilege('anon', p.oid, 'execute')) as anon_can_save,
       has_table_privilege('anon', 'public.menu_item_stock_facts', 'select') as anon_reads_facts,
       (has_table_privilege('anon', 'public.recipe_cost_daily', 'select')
        or exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'menu_item_stock_facts' and c.column_name ~ 'cost|price')) as anon_reads_cost,
       0 as site_rows_changed,
       false as menu_rows_changed,
       false as logins_changed
  from (select distinct i.org_id from public.stock_co_items i) o
 order by o.org_id;
