-- 20261024a_OPS_stock_native_1.sql
-- Multi site stock, Drop 1: the company list (map 8.2). The Stock control levels switch on.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql, its revalue file AND            #
-- #  20261022a_OPS_stock_native_0b.sql live first (the guard refuses           #
-- #  otherwise). One transaction: any error and nothing changes.              #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- WHAT IT IS
--   The company list screens of Drop 1 read and save through the functions made here: one page of
--   stock items with every site packed in (stock_items_page), the supplier list and its prices, ticking
--   items on and off at sites, pause, Change prices (now or from a day), categories, order rules per
--   supplier and site, import, Copy a site, the go live plan, site groups, suggestions, and the nightly
--   set up health with its Fix. The Stock control levels switch on in the save functions (map 5.1 step
--   4): in a multi site company the company list is changed only by owners, ServOS staff and logins with
--   Stock control All sites; prices and the supplier here also by Their sites, full control. A one site
--   company keeps exactly today's rights.
--
-- WHAT IT NEVER DOES
--   It writes no site row (stock items, suppliers, supplier packs, packs, unit bridges, recipes, lines,
--   till links, pars, areas, the ledger) and no login (user_profiles, user_locations). Before the check
--   row it compares every count, version and sum of those per venue with the snapshot it took under
--   the item row locks at the start, and stops (undoing everything) on any difference.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once (one paste is one transaction; no begin
--   or commit in here). The first statement is the guard. Then:
--     set local lock_timeout = '3s';  set local statement_timeout = '300s';
--   It checks that the 35 stock bodies it rebuilds or leans on are still the text it was written
--   against (else: 'A stock function changed since this file was written. Ask Claude for a new file.'),
--   saves the 24 it rebuilds in stock_native_backup (names 'd1:...') for the rollback, takes the item
--   row locks and the snapshot, builds, seeds the categories and the order rules, runs a dry run of the
--   levels as a real manager login (rolled back), compares, and shows the check row last. Paste it back.
--
-- IF IT STOPS
--   Any error means nothing changed. A lock wait or 'deadlock detected': run it again a quiet minute
--   later. Any other words: send them to Claude.
--
-- ROLLBACK
--   20261024a_OPS_stock_native_1_ROLLBACK.sql (puts the 24 Drop 0 bodies back: levels off).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_co_settings') is null or to_regclass('public.stock_save_queue') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql and its revalue file first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_co_lock_upd') then
    raise exception 'Run 20261022a_OPS_stock_native_0b.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_order_rules') is not null
     or exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'stock_co_items' and c.column_name = 'category_id') then
    raise exception 'Drop 1 has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE BODIES THIS FILE REBUILDS OR LEANS ON, STILL AS BUILT
-- ============================================================================
-- The house rule: md5 of the function source with every run of white space made one space. Read live
-- 20 Oct 2026 (the 0a file on main is the live text). The first 24 are rebuilt below from that text,
-- changing only what contract section 1.5 lists; the other 11 are checked only.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
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
      ('public.stock_item_detail(uuid)', '237948f39a88613c62e381d1d843e28a'),
      ('public.stock_site_scope(uuid)', 'e0b54f5aaea4f330e2300248b721141d'),
      ('public.stock_co__sync_site(uuid,uuid[],uuid[],boolean,boolean)', '68980e8bc9d49446950d5389d924d6e8'),
      ('public.stock_co__sync_recipes(uuid,uuid[],boolean,boolean)', '77d43d74e1791813cffdf82254f650ad'),
      ('public.stock_co__new_site_item(uuid,uuid,text,boolean)', '329060038c9d43bad9c2aa9302b4f271'),
      ('public.stock_co__new_site_supplier(uuid,uuid)', '913b98491c7234340131c604108e789b'),
      ('public.stock_co__set_preferred(uuid,uuid,uuid,boolean)', 'a7518aaa97ce5809aafa0854d9056c4d'),
      ('public.stock_co__currency_check(uuid)', 'bee1118bc131abf7c9c83b88a3c85897'),
      ('public.stock_co__run_sites(uuid,uuid,uuid[],uuid[],uuid[],uuid[],bigint,timestamptz)', '7eeb435c8c677730049190e85456fd4a'),
      ('public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'),
      ('public.stock_changes_page(text,uuid,jsonb,integer)', 'eae7ebd02ee5c5681f3a248942fb28e4'),
      ('public.stock_co__org_guard()', '000c0e067df8ab8197dee16872fa79b4')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- The 24 bodies this file rebuilds, as they are tonight (pg_get_functiondef text, replayable), in the
-- existing owner only stock_native_backup, named 'd1:<name>'. The Drop 1 rollback replays exactly these.
insert into public.stock_native_backup (name, body, md5, saved_at)
select 'd1:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))), now()
  from (values
    ('public.stock_co__allowed(text)'), ('public.stock_co__clean(text,jsonb)'), ('public.stock_co__guard(uuid,text,text,uuid[])'),
    ('public.stock_save_item(jsonb,jsonb,integer,text)'), ('public.stock_archive_item(uuid,integer,boolean,text)'),
    ('public.stock_save_item_site(uuid,uuid,jsonb,integer,text)'), ('public.stock_save_pack(jsonb,integer,text)'),
    ('public.stock_archive_pack(uuid,integer,boolean,text)'), ('public.stock_set_pack_default(uuid,text,integer,text)'),
    ('public.stock_save_bridge(jsonb,integer,text)'), ('public.stock_archive_bridge(uuid,integer,boolean,text)'),
    ('public.stock_save_supplier(jsonb,jsonb,integer,text)'), ('public.stock_archive_supplier(uuid,integer,boolean,text)'),
    ('public.stock_save_supplier_site(uuid,uuid,jsonb,integer,text)'), ('public.stock_save_supplier_item(jsonb,integer,text)'),
    ('public.stock_save_supplier_item_site(uuid,uuid,jsonb,integer,text)'), ('public.stock_archive_supplier_item(uuid,integer,boolean,text)'),
    ('public.stock_save_recipe(jsonb,jsonb,integer,text)'), ('public.stock_archive_recipe(uuid,integer,boolean,text)'),
    ('public.stock_link_menu_item(uuid,text,uuid,numeric,text)'), ('public.stock_co__run_job(bigint)'),
    ('public.stock_save_queue_run(integer)'), ('public.stock_nightly_upkeep()'), ('public.stock_item_detail(uuid)')
  ) as s(sig)
  join pg_proc p on p.oid = to_regprocedure(s.sig);

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup b where b.name like 'd1:%') <> 24 then
    raise exception 'The backup of the 24 stock bodies is not complete. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- STEP 0. ROW LOCKS AND THE SNAPSHOT (same transaction)
-- ============================================================================
-- Per venue of every company that holds stock: the count and the sum of row_version of the six site
-- tables with a version, the count of five more, six sums; plus an md5 of every login row (stored with
-- the zero id). Null sums are stored as 0. The compare before the check row raises on ANY difference.
create temp table _stock_native1_snap (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native1_now (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

do $snap$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct l.org_id), '{}'::uuid[]) into v_orgs
    from public.locations l
   where l.org_id is not null
     and (exists (select 1 from public.inventory_items i where i.location_id = l.id)
          or exists (select 1 from public.suppliers s where s.location_id = l.id));

  -- the row lock on every stock item of those companies, in id order (the sales lock order)
  perform 1
     from public.inventory_items i
    where i.location_id in (select l.id from public.locations l where l.org_id = any (v_orgs))
    order by i.id
      for no key update;

  insert into _stock_native1_snap (location_id, metric, value)
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

  insert into _stock_native1_snap (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));
end
$snap$;

-- ============================================================================
-- STEP 1. NEW TABLES (written only by definer functions; no write policy anywhere)
-- ============================================================================

-- When each site gets deliveries from a supplier, and the order by day and time for each (map 8.2).
-- delivery_dow and order_by_dow use the Postgres day numbers: 0 Sunday, 1 Monday ... 6 Saturday (the
-- same numbering as stock_co_settings.week_start). The site's suppliers.delivery_days and cutoff_time
-- are written from these rows (stock_co__derive_days), so today's Order pad readers keep working.
create table public.stock_order_rules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  location_id    uuid not null references public.locations(id) on delete cascade,
  supplier_id    uuid not null references public.suppliers(id) on delete cascade,
  company_ref    uuid references public.stock_co_suppliers(id) on delete set null,
  delivery_dow   smallint not null check (delivery_dow between 0 and 6),
  order_by_dow   smallint check (order_by_dow is null or order_by_dow between 0 and 6),
  order_by_time  time,
  row_version    integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  constraint stock_order_rules_order_by_pair check ((order_by_dow is null) = (order_by_time is null)),
  constraint stock_order_rules_one_per_day unique (supplier_id, delivery_dow)
);
create index stock_order_rules_loc on public.stock_order_rules (location_id, supplier_id);
comment on table public.stock_order_rules is 'Delivery days and order by times of one supplier at one site (multi site stock Drop 1, 20261024a). supplier_id is the SITE suppliers row. Written only by definer functions; the site row''s delivery_days and cutoff_time are derived from these rows.';

-- A price that starts on a day (Change prices with a from day). location_id null is the company price.
create table public.stock_co_dated_prices (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organisations(id) on delete cascade,
  supplier_item_id  uuid not null references public.stock_co_supplier_items(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete cascade,
  price             numeric(12,4) not null check (price >= 0),
  from_day          date not null,
  change_key        uuid not null,
  status            text not null default 'waiting' check (status in ('waiting', 'applied', 'replaced', 'cancelled')),
  applied_at        timestamptz,
  created_by        uuid,
  created_by_name   text,
  created_at        timestamptz not null default now()
);
create unique index stock_co_dated_prices_one_waiting on public.stock_co_dated_prices
  (supplier_item_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), from_day) where status = 'waiting';
create index stock_co_dated_prices_due on public.stock_co_dated_prices (from_day) where status = 'waiting';
create index stock_co_dated_prices_si on public.stock_co_dated_prices (supplier_item_id, status);
comment on table public.stock_co_dated_prices is 'Supplier pack prices that start on a day (multi site stock Drop 1, 20261024a). A site row applies on that site''s own business day; a company row applies once the day has begun at every site that follows the company price. Written only by definer functions and the save queue runner.';

-- One header per import file: the check screen's counts and its owner.
create table public.stock_co_import_jobs (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  source           text not null check (source in ('csv', 'nory', 'marketman')),
  file_name        text,
  status           text not null default 'staging' check (status in ('staging', 'checked', 'queued', 'running', 'done', 'failed', 'cancelled')),
  sites            uuid[] not null default '{}',
  counts           jsonb not null default '{}'::jsonb,
  queue_id         bigint,
  created_by       uuid not null,
  created_by_name  text,
  row_version      integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_co_import_jobs_org on public.stock_co_import_jobs (org_id, created_at desc);
comment on table public.stock_co_import_jobs is 'Import files of the company list (multi site stock Drop 1, 20261024a). Read through stock_import_check only.';

create table public.stock_co_import_rows (
  job_id     uuid not null references public.stock_co_import_jobs(id) on delete cascade,
  row_no     integer not null,
  org_id     uuid not null,
  kind       text not null check (kind in ('item', 'supplier', 'supplier_item', 'par', 'recipe')),
  data       jsonb not null,
  sites      uuid[],
  action     text check (action is null or action in ('new', 'change', 'same', 'skip', 'problem')),
  problem    text,
  target_id  uuid,
  done       boolean not null default false,
  primary key (job_id, row_no)
);
comment on table public.stock_co_import_rows is 'The staged rows of an import file, each with what it will do (multi site stock Drop 1, 20261024a). sites null means the job''s sites.';
-- the new items and suppliers of a file by name: every pack and par row looks there for a name made earlier
-- in the same file (stock_co__import_check_row), so a 5,000 line file stages in seconds, not minutes
create index stock_co_import_rows_new_name on public.stock_co_import_rows (job_id, kind, lower(btrim(data ->> 'name'))) where action = 'new';

-- Company categories (map 8.2, B6). stock_co_items.category stays and always reads the category's name.
create table public.stock_co_categories (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  name             text not null check (btrim(name) <> ''),
  accounting_code  text,
  gp_target_pct    numeric(5,2) check (gp_target_pct is null or (gp_target_pct >= 0 and gp_target_pct <= 100)),
  sort_order       integer not null default 0,
  archived_at      timestamptz,
  row_version      integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
create unique index stock_co_categories_name_uniq on public.stock_co_categories (org_id, lower(name));
comment on table public.stock_co_categories is 'Stock categories of a company with their accounting code and GP target (multi site stock Drop 1, 20261024a). Written only by definer functions.';

-- The go live plan of a new site (map 8.2, A19).
create table public.stock_co_golive_steps (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  location_id   uuid not null references public.locations(id) on delete cascade,
  step          text not null check (step in ('copy_site', 'opening_count', 'train_the_trainer', 'side_by_side', 'switch_off')),
  due_day       date,
  done_at       timestamptz,
  done_by       uuid,
  done_by_name  text,
  note          text,
  row_version   integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stock_co_golive_steps_one unique (location_id, step)
);
comment on table public.stock_co_golive_steps is 'Go live steps of one site: copy a site, opening count, train the trainer, side by side, switch the old system off (multi site stock Drop 1, 20261024a).';

-- Where the nightly drift check of each site lands, for Set up health and its Fix.
create table public.stock_co_site_health (
  location_id            uuid primary key references public.locations(id) on delete cascade,
  org_id                 uuid not null,
  checked_at             timestamptz not null,
  planned_writes         integer not null default 0,
  recipe_planned_writes  integer not null default 0,
  detail                 jsonb not null default '[]'::jsonb,
  lines                  jsonb not null default '[]'::jsonb,
  fix_job_id             bigint,
  fix_asked_at           timestamptz,
  fix_asked_by           uuid
);
comment on table public.stock_co_site_health is 'The nightly set up health of one site: how many site rows differ from the company list (multi site stock Drop 1, 20261024a). Written by stock_nightly_health and stock_resync_site only.';

-- Row level security, grants and the second sign in step. Read rules (Drop 0 contract 1.2): R_LOC is
-- location_id in stock_reach_locations(); R_ORG is org_id in stock_reach_orgs(); R_TWO a site row by
-- site and a company row by company. The import tables have no grant to signed in logins at all.
alter table public.stock_order_rules enable row level security;
alter table public.stock_co_dated_prices enable row level security;
alter table public.stock_co_import_jobs enable row level security;
alter table public.stock_co_import_rows enable row level security;
alter table public.stock_co_categories enable row level security;
alter table public.stock_co_golive_steps enable row level security;
alter table public.stock_co_site_health enable row level security;
revoke all on table public.stock_order_rules from public, anon, authenticated, service_role;
revoke all on table public.stock_co_dated_prices from public, anon, authenticated, service_role;
revoke all on table public.stock_co_import_jobs from public, anon, authenticated, service_role;
revoke all on table public.stock_co_import_rows from public, anon, authenticated, service_role;
revoke all on table public.stock_co_categories from public, anon, authenticated, service_role;
revoke all on table public.stock_co_golive_steps from public, anon, authenticated, service_role;
revoke all on table public.stock_co_site_health from public, anon, authenticated, service_role;
grant select on table public.stock_order_rules to authenticated, service_role;
grant select on table public.stock_co_dated_prices to authenticated, service_role;
grant select on table public.stock_co_import_jobs to service_role;
grant select on table public.stock_co_import_rows to service_role;
grant select on table public.stock_co_categories to authenticated, service_role;
grant select on table public.stock_co_golive_steps to authenticated, service_role;
grant select on table public.stock_co_site_health to authenticated, service_role;
create policy stock_order_rules_read on public.stock_order_rules as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_dated_prices_read on public.stock_co_dated_prices as permissive for select to authenticated
  using ((location_id is not null and location_id::text in (select public.stock_reach_locations()))
      or (location_id is null and org_id::text in (select public.stock_reach_orgs())));
create policy stock_co_categories_read on public.stock_co_categories as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_golive_steps_read on public.stock_co_golive_steps as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_site_health_read on public.stock_co_site_health as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
do $d1_fence$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['stock_order_rules', 'stock_co_dated_prices', 'stock_co_import_jobs', 'stock_co_import_rows',
                           'stock_co_categories', 'stock_co_golive_steps', 'stock_co_site_health'] loop
    execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
      || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
  end loop;
end
$d1_fence$;

-- ============================================================================
-- STEP 2. NEW COLUMNS (constant defaults only: no table rewrite)
-- ============================================================================
alter table public.stock_co_items add column if not exists category_id uuid references public.stock_co_categories(id) on delete set null;
create index if not exists stock_co_items_category on public.stock_co_items (org_id, category_id);
comment on column public.stock_co_items.category_id is 'The company category (stock_co_categories) of this item. The free text category always reads its name. Multi site stock Drop 1, 20261024a.';
alter table public.stock_co_item_sites add column if not exists paused_from date;
alter table public.stock_co_item_sites add column if not exists paused_until date;
comment on column public.stock_co_item_sites.paused_from is 'With paused: paused at this site from this business day (null = from now). Multi site stock Drop 1, 20261024a.';
comment on column public.stock_co_item_sites.paused_until is 'With paused: paused at this site until this business day, included (null = until unpaused). Multi site stock Drop 1, 20261024a.';
do $pause_days$
begin
  if not exists (select 1 from pg_constraint c where c.conname = 'stock_co_item_sites_pause_days'
                    and c.conrelid = 'public.stock_co_item_sites'::regclass) then
    alter table public.stock_co_item_sites add constraint stock_co_item_sites_pause_days
      check (paused_until is null or paused_from is null or paused_until >= paused_from);
  end if;
end
$pause_days$;
alter table public.stock_co_site_groups add column if not exists row_version integer not null default 1;
comment on column public.stock_co_site_groups.row_version is 'Version stamp for "someone saved first" on a group. Multi site stock Drop 1, 20261024a.';

-- ============================================================================
-- STEP 3. THE COMPANY GUARD OF THE NEW ROWS, THE DAY RULE, THE ORDER RULE HELPERS
-- ============================================================================

-- A row of a Drop 1 table stays in its company: its org_id is the company of its site; an order rule's
-- supplier row is at its site; a dated price's supplier item, a category's items and an import row's
-- job are of the same company. The 0a stock_co__org_guard is not touched. Owner only.
create or replace function public.stock_co__d1_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  if tg_table_name = 'stock_co_items' then
    if new.category_id is not null
       and not exists (select 1 from stock_co_categories c where c.id = new.category_id and c.org_id = new.org_id) then
      raise exception 'That record is not in this company.' using errcode = '22023';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'That record is not in this company.' using errcode = '22023';
  end if;
  if tg_table_name = 'stock_co_categories' then
    return new;
  end if;
  if tg_table_name = 'stock_co_import_rows' then
    if not exists (select 1 from stock_co_import_jobs j where j.id = new.job_id and j.org_id = new.org_id) then
      raise exception 'That record is not in this company.' using errcode = '22023';
    end if;
    return new;
  end if;
  if new.location_id is not null then
    select l.org_id into v_org from locations l where l.id = new.location_id;
    if v_org is null or v_org is distinct from new.org_id then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
  end if;
  if tg_table_name = 'stock_order_rules' then
    if not exists (select 1 from suppliers s where s.id = new.supplier_id and s.location_id = new.location_id)
       or (new.company_ref is not null
           and not exists (select 1 from stock_co_suppliers m where m.id = new.company_ref and m.org_id = new.org_id)) then
      raise exception 'That record is not in this company.' using errcode = '22023';
    end if;
  elsif tg_table_name = 'stock_co_dated_prices' then
    if not exists (select 1 from stock_co_supplier_items si where si.id = new.supplier_item_id and si.org_id = new.org_id) then
      raise exception 'That record is not in this company.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

create trigger stock_co_d1_org_guard before insert or update on public.stock_order_rules
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_d1_org_guard before insert or update on public.stock_co_dated_prices
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_d1_org_guard before insert or update on public.stock_co_categories
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_d1_org_guard before insert or update on public.stock_co_golive_steps
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_d1_org_guard before insert or update on public.stock_co_site_health
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_d1_org_guard before insert or update on public.stock_co_import_rows
  for each row execute function public.stock_co__d1_org_guard();
create trigger stock_co_items_category_guard before insert or update of category_id on public.stock_co_items
  for each row execute function public.stock_co__d1_org_guard();

-- One delivery day value as a Postgres day number (0 Sunday ... 6 Saturday), read the way the app
-- reads it (purchasingRules.normDay): case blind, a day name ('mon', 'Thursday') by its first three
-- letters, or a day number (1 Monday ... 6 Saturday, 0 or 7 Sunday). Anything else is null. Owner only.
create or replace function public.stock_co__dow_of(p_v jsonb)
returns smallint
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when p_v is null or jsonb_typeof(p_v) not in ('string', 'number') then null::smallint
           when btrim(p_v #>> '{}') ~ '^[0-9]{1,3}$' then
             case when (btrim(p_v #>> '{}'))::integer in (0, 7) then 0::smallint
                  when (btrim(p_v #>> '{}'))::integer between 1 and 6 then (btrim(p_v #>> '{}'))::smallint
             end
           else (array_position(array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], left(lower(btrim(p_v #>> '{}')), 3)) - 1)::smallint
         end;
$fn$;

-- The site row's delivery days and cut off from its order rules (one rule, the JS twin is
-- src/lib/stock/orderRules.js): delivery_days the day codes in the order mon, tue, wed, thu, fri,
-- sat, sun; cutoff_time the order by time most rules use (ties: the earliest) as HH:MM, or null when no
-- rule has one. p_site_supplier is the SITE suppliers row. Owner only.
create or replace function public.stock_co__derive_days(p_site_supplier uuid)
returns table (delivery_days jsonb, cutoff_time text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((select jsonb_agg(d.code order by d.ord)
                     from (values ('mon', 1, 1), ('tue', 2, 2), ('wed', 3, 3), ('thu', 4, 4), ('fri', 5, 5), ('sat', 6, 6), ('sun', 0, 7)) d(code, dow, ord)
                    where exists (select 1 from stock_order_rules r where r.supplier_id = p_site_supplier and r.delivery_dow = d.dow)),
                  '[]'::jsonb),
         (select to_char(r.order_by_time, 'HH24:MI')
            from stock_order_rules r
           where r.supplier_id = p_site_supplier and r.order_by_time is not null
           group by r.order_by_time
           order by count(*) desc, r.order_by_time
           limit 1);
$fn$;

-- A site row's order rules made again from its own delivery_days and cutoff_time (the seed rule): one
-- rule per delivery day, ordered by the day before at the cut off (both null when there is no cut off
-- of the form HH:MM). Used by the seed and by a one site company's supplier save. Returns how many rules
-- it wrote. Owner only.
create or replace function public.stock_co__seed_order_rules(p_site_supplier uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n integer := 0;
begin
  delete from stock_order_rules r where r.supplier_id = p_site_supplier;
  insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
  select l.org_id, s.location_id, s.id, s.company_ref, d.dow,
         case when coalesce(s.cutoff_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then ((d.dow + 6) % 7)::smallint end,
         case when coalesce(s.cutoff_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then s.cutoff_time::time end
    from suppliers s
    join locations l on l.id = s.location_id
   cross join lateral (select distinct public.stock_co__dow_of(e.value) as dow
                         from jsonb_array_elements(case when jsonb_typeof(s.delivery_days) = 'array' then s.delivery_days
                                                        else '[]'::jsonb end) e) d
   where s.id = p_site_supplier and l.org_id is not null and d.dow is not null;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- ============================================================================
-- STEP 4. SEEDS (company tables and the new tables only; no site row is written)
-- ============================================================================
-- What the seeds found, for the check row.
create temp table _stock_native1_seed (
  org_id  uuid not null,
  metric  text not null,
  value   numeric not null default 0,
  primary key (org_id, metric)
) on commit drop;

-- Categories: one per distinct free text category (lower case, trimmed) of each company's items, named
-- by its most used spelling (ties: the smallest), in name order. Then every item whose category is
-- that text points at it, with no version bump and no change log row (a seed is not an edit).
insert into public.stock_co_categories (org_id, name, sort_order)
select x.org_id, x.name, (row_number() over (partition by x.org_id order by lower(x.name), x.name))::integer
  from (select distinct on (c.org_id, c.k) c.org_id, c.k, c.spelling as name
          from (select i.org_id, lower(btrim(i.category)) as k, btrim(i.category) as spelling, count(*) as n
                  from public.stock_co_items i
                 where nullif(btrim(coalesce(i.category, '')), '') is not null
                 group by i.org_id, lower(btrim(i.category)), btrim(i.category)) c
         order by c.org_id, c.k, c.n desc, c.spelling collate "C") x;

update public.stock_co_items i
   set category_id = c.id
  from public.stock_co_categories c
 where c.org_id = i.org_id
   and lower(c.name) = lower(btrim(i.category))
   and i.category_id is null;

-- Order rules: every site supplier row with a company record (archived ones too) gets one rule per
-- delivery day it holds, ordered by the day before at its cut off.
do $seed_rules$
declare
  r record;
begin
  for r in
    select s.id from public.suppliers s join public.locations l on l.id = s.location_id
     where s.company_ref is not null and l.org_id is not null
     order by s.id
  loop
    perform public.stock_co__seed_order_rules(r.id);
  end loop;
end
$seed_rules$;

-- The round trip, asserted: for every seeded site supplier row whose own values are clean (every
-- delivery day value is a day, and a cut off, when it has one, is HH:MM with at least one delivery day),
-- the derived days are its stored days (as a set) and the derived cut off is its stored cut off. Rows
-- with values that are not clean cannot come back the same; they are counted, never a stop.
do $round_trip$
declare
  r record;
  v_bad text;
begin
  insert into _stock_native1_seed (org_id, metric, value)
  select o.org_id, m.metric, 0
    from (select distinct l.org_id from public.locations l
           where l.org_id is not null
             and (exists (select 1 from public.inventory_items i where i.location_id = l.id)
                  or exists (select 1 from public.suppliers s where s.location_id = l.id))) o
   cross join (values ('bad_days'), ('round_trip_bad'), ('without_cutoff')) m(metric);

  for r in
    select s.id, s.name, l.org_id, s.delivery_days, s.cutoff_time,
           (select coalesce(array_agg(distinct public.stock_co__dow_of(e.value) order by public.stock_co__dow_of(e.value)), '{}'::smallint[])
              from jsonb_array_elements(case when jsonb_typeof(s.delivery_days) = 'array' then s.delivery_days else '[]'::jsonb end) e
             where public.stock_co__dow_of(e.value) is not null) as stored,
           (select count(*) from jsonb_array_elements(case when jsonb_typeof(s.delivery_days) = 'array' then s.delivery_days else '[]'::jsonb end) e
             where public.stock_co__dow_of(e.value) is null) as bad,
           d.delivery_days as d_days, d.cutoff_time as d_cut
      from public.suppliers s
      join public.locations l on l.id = s.location_id
     cross join lateral public.stock_co__derive_days(s.id) d
     where s.company_ref is not null and l.org_id is not null
  loop
    update _stock_native1_seed set value = value + r.bad where org_id = r.org_id and metric = 'bad_days';
    if not (coalesce(r.cutoff_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      update _stock_native1_seed set value = value + 1 where org_id = r.org_id and metric = 'without_cutoff';
    end if;
    if r.stored is distinct from (select coalesce(array_agg(public.stock_co__dow_of(e.value) order by public.stock_co__dow_of(e.value)), '{}'::smallint[])
                                    from jsonb_array_elements(r.d_days) e)
       or nullif(r.cutoff_time, '') is distinct from r.d_cut then
      if r.bad = 0 and (r.cutoff_time is null or (r.cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and cardinality(r.stored) > 0)) then
        v_bad := coalesce(v_bad || ', ', '') || r.name;
      end if;
      update _stock_native1_seed set value = value + 1 where org_id = r.org_id and metric = 'round_trip_bad';
    end if;
  end loop;
  if v_bad is not null then
    raise exception 'The delivery days of % did not come back the same from the order rules. Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$round_trip$;

-- ============================================================================
-- STEP 5. THE LEVEL HELPERS AND THE SMALL HELPERS OF THE SAVES (internal, owner only)
-- ============================================================================

-- The need of an edit of one record named by its company id at the site the caller names: 'site_facts'
-- when the record is LOCAL to that site (decision 3: a site manager edits their own local records
-- freely), else 'company'. A pack or unit bridge is local through its item; a supplier pack through its
-- item or its supplier. Recipes are not local in Drop 1. Owner only.
create or replace function public.stock_co__need_of(p_kind text, p_company_id uuid, p_loc uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when p_loc is null or p_company_id is null then 'company'
              when case p_kind
                     when 'item' then exists (select 1 from stock_co_items x where x.id = p_company_id and x.local_location_id = p_loc)
                     when 'supplier' then exists (select 1 from stock_co_suppliers x where x.id = p_company_id and x.local_location_id = p_loc)
                     when 'pack' then exists (select 1 from stock_co_packs p join stock_co_items x on x.id = p.item_id
                                               where p.id = p_company_id and x.local_location_id = p_loc)
                     when 'bridge' then exists (select 1 from stock_co_bridges b join stock_co_items x on x.id = b.item_id
                                                 where b.id = p_company_id and x.local_location_id = p_loc)
                     when 'supplier_item' then exists (select 1 from stock_co_supplier_items si
                                                         join stock_co_items x on x.id = si.item_id
                                                         join stock_co_suppliers m on m.id = si.supplier_id
                                                        where si.id = p_company_id
                                                          and (x.local_location_id = p_loc or m.local_location_id = p_loc))
                     else false
                   end
              then 'site_facts'
              else 'company' end;
$fn$;

-- The version rule of Drop 1 for an edit of an existing record: a company or price edit must carry the
-- version the screen read; a site facts edit (par, reorder, minimum, area, counted here, account
-- number, order email, copies) keeps Drop 0's rule (no version means no check, logged
-- save_unversioned). Owner only.
create or replace function public.stock_co__need_version(p_need text, p_version integer)
returns void
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_need in ('company', 'site_price') and p_version is null then
    raise exception 'This screen is out of date. Reload it, then save again.' using errcode = '22023';
  end if;
end
$fn$;

-- The stricter of two needs (site_facts, then site_price, then company). Owner only.
create or replace function public.stock_co__need_max(p_a text, p_b text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case when 'company' in (p_a, p_b) then 'company'
              when 'site_price' in (p_a, p_b) then 'site_price'
              else coalesce(p_a, p_b, 'site_facts') end;
$fn$;

-- The venue business day of a site now. Owner only.
create or replace function public.stock_co__today(p_loc uuid)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select v.business_day from public.stock_co__venue_day(p_loc, now()) v;
$fn$;

-- Whether a company item is paused at a site on a business day: {"everywhere": true, "until"} when the
-- company item is paused everywhere then, {"everywhere": false, "until"} when its link there is,
-- else null. p_day null is that site's business day now. Owner only.
create or replace function public.stock_co__paused_now(p_item uuid, p_loc uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when i.paused_from is not null and i.paused_from <= d.day and (i.paused_until is null or d.day <= i.paused_until)
             then jsonb_build_object('everywhere', true, 'until', i.paused_until)
           when s.paused and (s.paused_from is null or s.paused_from <= d.day) and (s.paused_until is null or d.day <= s.paused_until)
             then jsonb_build_object('everywhere', false, 'until', s.paused_until)
         end
    from stock_co_items i
    left join stock_co_item_sites s on s.item_id = i.id and s.location_id = p_loc
   cross join lateral (select coalesce(p_day, public.stock_co__today(p_loc)) as day) d
   where i.id = p_item;
$fn$;

-- A quantity of a company item in its base unit: the same dimension through stock_units, else through
-- ONE live company unit bridge of the item (the oldest first), as stock_convert_qty does at a site.
-- Null when there is no path. Owner only.
create or replace function public.stock_co__qty_in_base(p_item uuid, p_qty numeric, p_unit text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when p_qty is null or p_unit is null then null::numeric
           when lower(btrim(p_unit)) = i.base_unit then p_qty
           when f.code is null then null::numeric
           when f.dimension = t.dimension then p_qty * f.to_canonical / t.to_canonical
           else (select case when uf.dimension = f.dimension and ut.dimension = t.dimension
                               then p_qty * f.to_canonical / uf.to_canonical * (b.to_qty / b.from_qty) * ut.to_canonical / t.to_canonical
                             else p_qty * f.to_canonical / ut.to_canonical * (b.from_qty / b.to_qty) * uf.to_canonical / t.to_canonical end
                   from stock_co_bridges b
                   join stock_units uf on uf.code = lower(btrim(b.from_unit))
                   join stock_units ut on ut.code = lower(btrim(b.to_unit))
                  where b.item_id = i.id and b.archived_at is null and b.from_qty > 0 and b.to_qty > 0
                    and ((uf.dimension = f.dimension and ut.dimension = t.dimension)
                         or (ut.dimension = f.dimension and uf.dimension = t.dimension))
                  order by b.created_at, b.id
                  limit 1)
         end
    from stock_co_items i
    join stock_units t on t.code = i.base_unit
    left join stock_units f on f.code = lower(btrim(p_unit))
   where i.id = p_item;
$fn$;

-- A price of a company supplier pack per base unit of its item, net of VAT when the price includes it.
-- p_price null is the company price. Null when the pack cannot be turned into the base unit. Owner only.
create or replace function public.stock_co__unit_of_price(p_si uuid, p_price numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when q.qb > 0 then round(n.net / q.qb, 8) end
    from stock_co_supplier_items si
   cross join lateral (select case when si.price_includes_tax
                                   then coalesce(p_price, si.pack_price) / (1 + coalesce(si.purchase_vat_rate, 0))
                                   else coalesce(p_price, si.pack_price) end as net) n
   cross join lateral (select public.stock_co__qty_in_base(si.item_id, si.pack_qty * si.inner_qty, si.inner_unit) as qb) q
   where si.id = p_si;
$fn$;

-- The company price of a supplier pack per base unit, net of VAT (contract 1.6). Owner only.
create or replace function public.stock_co__si_unit_cost(p_si uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.stock_co__unit_of_price(p_si, null);
$fn$;

-- The company category for a free text category of a one site company's item (today's screen keeps
-- free text): the live category of that name, made when it is new, so the day the company adds a site
-- nothing needs converting. Null text is no category. Owner only.
create or replace function public.stock_co__category_for(p_org uuid, p_text text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
  v_name text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if v_name is null then
    return null;
  end if;
  select c.id into v_id from stock_co_categories c where c.org_id = p_org and lower(c.name) = lower(v_name);
  if v_id is null then
    insert into stock_co_categories (org_id, name, sort_order)
    values (p_org, v_name, coalesce((select max(c.sort_order) from stock_co_categories c where c.org_id = p_org), 0) + 1)
    on conflict (org_id, lower(name)) do nothing
    returning id into v_id;
    if v_id is null then
      select c.id into v_id from stock_co_categories c where c.org_id = p_org and lower(c.name) = lower(v_name);
    end if;
  elsif exists (select 1 from stock_co_categories c where c.id = v_id and c.archived_at is not null) then
    update stock_co_categories c set archived_at = null, row_version = c.row_version + 1, updated_at = now() where c.id = v_id;
  end if;
  return v_id;
end
$fn$;

-- A site that cannot order from a supplier (its link's can_order is false) never orders its packs: each
-- of those packs there is switched off here (off_here), so the writer archives that site's copy and
-- today's Order pad and Orders screens never offer it. p_si null means every pack of every supplier at
-- that site. Returns how many links changed. Owner only.
create or replace function public.stock_co__cant_order_off(p_loc uuid, p_si uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n integer := 0;
begin
  update stock_co_supplier_item_sites x
     set off_here = true, row_version = x.row_version + 1, updated_at = now()
    from stock_co_supplier_items si
    join stock_co_supplier_sites ss on ss.supplier_id = si.supplier_id
   where x.supplier_item_id = si.id and x.location_id = p_loc and ss.location_id = p_loc
     and not ss.can_order and not x.off_here
     and (p_si is null or x.supplier_item_id = any(p_si));
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- One waiting save queue row of a Drop 1 kind. site_sync stays with stock_co__enqueue (0a). A company
-- job (change_prices, import_commit, category_rename) may have no site. Owner only.
create or replace function public.stock_co__enqueue_job(p_org uuid, p_loc uuid, p_kind text, p_payload jsonb, p_entity_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_kind is null or p_kind not in ('set_sites', 'pause', 'change_prices', 'import_commit', 'copy_site', 'category_rename', 'resync_site') then
    raise exception 'This database does not know the save job kind %.', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if p_org is null
     or (p_loc is null and p_kind not in ('change_prices', 'import_commit', 'category_rename'))
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
-- STEP 6. THE REBUILT BODIES (each from the 0a text on main; only what contract 1.5 lists changes)
-- ============================================================================

-- REBUILT (Drop 1): new keys on item, item_site_patch, supplier and supplier_item; new targets category,
-- settings, golive_step and site_group. Types as Drop 0, plus date, time and pct (stock_co__clean).
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
    when 'supplier_item' then '{"id":"uuid","site_supplier_product_id":"uuid","location_id":"uuid","item_id":"uuid","site_item_id":"uuid","supplier_id":"uuid","site_supplier_id":"uuid","supplier_sku":"text","supplier_product_name":"text","pack_description":"text","pack_qty":"pos","inner_qty":"pos","inner_unit":"unit","pack_price":"money","currency":"currency","purchase_tax_rate_id":"uuid","purchase_vat_rate":"rate","price_includes_tax":"bool","site":"object:supplier_item_site","paused":"bool","agreed_until":"date","allowed_diff_pct":"pct"}'::jsonb
    when 'supplier_item_site' then '{"is_preferred":"bool"}'::jsonb
    when 'supplier_item_site_patch' then '{"price_here":"money","off_here":"bool","paused":"bool"}'::jsonb
    when 'recipe' then '{"id":"uuid","site_recipe_id":"uuid","location_id":"uuid","name":"text","recipe_type":"enum:MENU|BATCH|PREP","output_item_id":"uuid","site_output_item_id":"uuid","yield_qty":"pos","yield_unit":"unit","wastage_pct":"nonneg","gp_target_pct":"num","method":"text","photo":"text","menu_item_id":"text","portion":"pos"}'::jsonb
    when 'recipe_line' then '{"component_item_id":"uuid","site_component_item_id":"uuid","qty":"num","unit":"text","pack_id":"uuid","usable_pct":"pos","sort_order":"int","note":"text","order_types":"array"}'::jsonb
    when 'category' then '{"id":"uuid","org_id":"uuid","name":"text","accounting_code":"text","gp_target_pct":"pct","sort_order":"int"}'::jsonb
    when 'settings' then '{"week_start":"int","waste_reasons":"array","usual_areas":"array","invoice_tolerance_pct":"pct","invoice_tolerance_amount":"money","send_unapproved_at_cutoff":"bool","waste_pin_over_value":"money","count_second_approval_over":"money","sites":"array"}'::jsonb
    when 'golive_step' then '{"step":"enum:copy_site|opening_count|train_the_trainer|side_by_side|switch_off","due_day":"date","done":"bool","note":"text"}'::jsonb
    when 'site_group' then '{"id":"uuid","org_id":"uuid","name":"text","location_ids":"array","sort_order":"int","row_version":"int"}'::jsonb
    else null end;
$fn$;

-- REBUILT (Drop 1): three new types. date: 'YYYY-MM-DD' and a real day; time: 'HH:MM' from 00:00 to
-- 23:59, kept as HH:MM; pct: a number from 0 to 100. Everything else exactly as Drop 0.
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

-- REBUILT (Drop 1): step 4, the Stock control levels switch on (map 5.1 step 4). In a multi site company
-- (2 or more open sites, or multi_since set) a 'company' need is met only by Stock control all (owners of
-- that company and ServOS staff are always all), a 'site_price' need by sites_full or all. A one site
-- company keeps today's rights: reach is enough. Steps 1 to 3, 5 and 6 exactly as Drop 0. Owner only.
create or replace function public.stock_co__guard(p_org uuid, p_section text, p_need text, p_locations uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_reach text[];
  v_prof record;
  v_l record;
  v_owner boolean;
  v_super boolean;
  v_level text;
  v_open integer;
  v_since timestamptz;
  v_multi boolean;
begin
  if p_need is null or p_need not in ('read', 'company', 'site_facts', 'site_price', 'owner') then
    raise exception 'stock_co__guard: unknown need %', coalesce(p_need, 'null') using errcode = '22023';
  end if;
  if p_org is null or p_locations is null or cardinality(p_locations) = 0 then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_reach := array(select public.stock_reach_locations());
  for v_l in
    select u.id as want, l.id, l.name, l.org_id
      from (select distinct x.id from unnest(p_locations) x(id)) u
      left join locations l on l.id = u.id
     order by u.id
  loop
    if v_l.want is null or v_l.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if not (v_l.id::text = any(v_reach)) then
      raise exception 'Not allowed: this login does not reach %.', v_l.name using errcode = '42501';
    end if;
    if v_l.org_id is distinct from p_org then
      raise exception 'Not allowed: % is in another company.', v_l.name using errcode = '42501';
    end if;
  end loop;
  select p.role, p.org_id, p.bo_sections, coalesce(p.full_name, p.email) as name into v_prof
    from user_profiles p where p.id = v_uid;
  v_super := public.is_super_admin();
  v_owner := coalesce(v_prof.role = 'owner' and v_prof.org_id = p_org, false);
  if p_need <> 'read' and p_section is not null and not (v_owner or v_super)
     and v_prof.bo_sections is not null and not (p_section = any(v_prof.bo_sections)) then
    raise exception 'Not allowed: this screen cannot change %.',
      case p_section when 'inventory' then 'stock items' when 'produce' then 'recipes' when 'purchasing' then 'suppliers' else 'stock' end
      using errcode = '42501';
  end if;
  v_level := public.stock_level(v_uid, p_org);
  if p_need = 'owner' and not (v_owner or v_super) then
    raise exception 'Not allowed: only the owner can do this.' using errcode = '42501';
  end if;
  select count(*) filter (where coalesce(l.status, 'active') = 'active') into v_open from locations l where l.org_id = p_org;
  select s.multi_since into v_since from stock_co_settings s where s.org_id = p_org;
  v_multi := (coalesce(v_open, 0) >= 2 or v_since is not null);
  -- step 4 (Drop 1): the levels, in a multi site company only
  if v_multi and p_need = 'company' and v_level is distinct from 'all' then
    raise exception 'Not allowed: this is set by head office.' using errcode = '42501';
  end if;
  if v_multi and p_need = 'site_price' and coalesce(v_level, 'sites') not in ('sites_full', 'all') then
    raise exception 'Not allowed: prices and the supplier here are set by head office.' using errcode = '42501';
  end if;
  if p_need <> 'read' then
    perform set_config('servos.stock_co_write', txid_current()::text, true);
  end if;
  return jsonb_build_object('uid', v_uid, 'name', v_prof.name, 'level', v_level,
                            'multi', v_multi, 'org_id', p_org);
end
$fn$;

-- REBUILT (Drop 1): p_sites on create only ([{"location_id", "on": true}]: a company record ticked at
-- every listed site, need company with every site named); on an existing item p_sites is refused. A
-- new item in a multi site company with no p_sites is a local record of its site (need site_facts). An
-- edit's need is stock_co__need_of('item') with the version rule. New keys category_id (a live category
-- of the company; the free text category becomes its name in the same write; free text alone in a
-- multi site company is refused) and main_supplier_item_id. The answer adds "sites" on create.
-- Sections: inventory.
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
            returns_to_shelf, exclude_from_gp, key_item, notes, category_id, main_supplier_item_id, row_version, updated_at, updated_by)
         = (v_new.name, v_new.category, v_new.accounting_group, v_new.type, v_new.base_unit, v_new.sku, v_new.barcode,
            v_new.shelf_life_days, v_new.purchase_vat_rate, v_new.allergens, v_new.returns_to_shelf, v_new.exclude_from_gp,
            v_new.key_item, v_new.notes, v_new.category_id, v_new.main_supplier_item_id, v_new.row_version, v_new.updated_at,
            v_new.updated_by)
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
                            'sites_written', v_run -> 'sites_written', 'queued', v_run -> 'queued')
         || case when v_created then jsonb_build_object('sites', to_jsonb(coalesce(v_sites, array[v_loc]))) else '{}'::jsonb end;
end
$fn$;

-- REBUILT (Drop 1): the need is stock_co__need_of('item') at the named site, with the version rule.
-- Sections: inventory.
create or replace function public.stock_archive_item(p_item uuid, p_version integer default null, p_archived boolean default true,
                                                     p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_old stock_co_items;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_bad text;
  v_n integer;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_items x where x.id = v_id;
  if p_item <> v_id then
    v_loc := public.stock_co__site_loc('item', p_item);
    select t.row_version into v_srv from inventory_items t where t.id = p_item;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_need := public.stock_co__need_of('item', v_id, v_loc);
  v_g := public.stock_co__guard(v_old.org_id, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_items x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_item <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['item', 'item_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    select format('Count it or write it off first: %s holds %s %s.', l.name, trim_scale(t.on_hand), t.base_unit)
      into v_bad
      from stock_co_item_sites s
      join inventory_items t on t.id = s.site_item_id
      join locations l on l.id = s.location_id
     where s.item_id = v_id and coalesce(t.on_hand, 0) <> 0
     order by l.name
     limit 1;
    if v_bad is not null then
      raise exception '%', v_bad using errcode = '55000';
    end if;
    select count(*) into v_n from (
      select coalesce(r.company_ref, r.id) as rid
        from recipe_lines rl
        join recipes r on r.id = rl.recipe_id
       where rl.component_item_id in (select s.site_item_id from stock_co_item_sites s where s.item_id = v_id)
         and r.archived_at is null
      union
      select l.recipe_id
        from stock_co_recipe_lines l
        join stock_co_recipes r on r.id = l.recipe_id
       where l.component_item_id = v_id and r.archived_at is null) u;
    if v_n > 0 then
      raise exception 'Used in % recipes. Swap it out first.', v_n using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
  else
    v_at := null;
  end if;
  update stock_co_items x
     set archived_at = v_at, row_version = x.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where x.id = v_id
  returning x.row_version into v_rv;
  v_log := public.stock_co__log(v_old.org_id, null, 'item', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_id),
                                      array[v_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_item <> v_id then
    update inventory_items t set row_version = t.row_version + 1 where t.id = p_item and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_item_sites s where s.item_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;

-- REBUILT (Drop 1): new patch keys with a need per key. par_level, reorder_point, min_level, area_id,
-- move_holding, by_name, counted_here: site_facts. price_here (the supplier here pack's own price at
-- this site, null follows the company price), supplier_here (a supplier pack of this item whose
-- supplier can order here: the supplier here, default supplier kept in step), stop_ordering (true:
-- never ordered here again; false: back on), paused, paused_from, paused_until: site_price. A patch that
-- mixes keys needs the strictest. Version rule on the item's site link. Sections: inventory.
create or replace function public.stock_save_item_site(p_item uuid, p_location uuid, p_patch jsonb, p_version integer default null,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('item_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_org uuid;
  v_link stock_co_item_sites;
  v_item inventory_items;
  v_g jsonb;
  v_par record;
  v_pl numeric;
  v_rp numeric;
  v_ml numeric;
  v_old_area uuid;
  v_new_area uuid;
  v_area_row uuid;
  v_moved numeric := 0;
  v_qty numeric;
  v_tr uuid;
  v_ref text;
  v_res jsonb;
  v_by text;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_need text := 'site_facts';
  v_here_si uuid;
  v_here_sp uuid;
  v_new_si uuid;
  v_sup uuid;
  v_sname text;
  v_lname text;
  v_ph_before numeric;
  v_ph_after numeric;
  v_stop timestamptz;
  v_paused boolean;
  v_pf date;
  v_pu date;
  v_sync boolean := false;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_item <> v_id and public.stock_co__site_loc('item', p_item) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_id;
  select * into v_link from stock_co_item_sites s where s.item_id = v_id and s.location_id = p_location;
  if v_link.item_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_d ?| array['price_here', 'supplier_here', 'stop_ordering', 'paused', 'paused_from', 'paused_until'] then
    v_need := 'site_price';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[p_location]);
  select * into v_item from inventory_items t where t.id = v_link.site_item_id for no key update;
  select * into v_link from stock_co_item_sites s where s.item_id = v_id and s.location_id = p_location for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_org, array['item_site', 'item'], v_id, v_link.row_version, p_location, v_link.updated_at);
  end if;
  v_by := coalesce(v_d ->> 'by_name', v_g ->> 'name');
  select l.name into v_lname from locations l where l.id = p_location;
  select par_level, reorder_point, min_level into v_par from par_levels p
   where p.location_id = p_location and p.inventory_item_id = v_item.id;
  select ia.area_id into v_old_area from inventory_item_areas ia
   where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
   limit 1;
  -- the supplier here: the live preferred supplier pack of this item at this site, through its link
  select x.supplier_item_id, x.site_supplier_product_id, x.price_here into v_here_si, v_here_sp, v_ph_before
    from supplier_products t
    join stock_co_supplier_item_sites x on x.site_supplier_product_id = t.id and x.location_id = p_location
   where t.location_id = p_location and t.inventory_item_id = v_item.id and t.is_preferred and t.archived_at is null
   order by t.id
   limit 1;
  v_before := jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point, 'min_level', v_par.min_level,
                                 'area_id', v_old_area, 'counted_here', v_link.counted_here,
                                 'supplier_here', v_here_si, 'price_here', v_ph_before, 'stop_ordering_at', v_link.stop_ordering_at,
                                 'paused', v_link.paused, 'paused_from', v_link.paused_from, 'paused_until', v_link.paused_until);

  -- pars: a key left out keeps its value, an explicit null clears it, all three are always written
  if v_d ? 'par_level' or v_d ? 'reorder_point' or v_d ? 'min_level' then
    v_pl := case when v_d ? 'par_level' then (v_d ->> 'par_level')::numeric else v_par.par_level end;
    v_rp := case when v_d ? 'reorder_point' then (v_d ->> 'reorder_point')::numeric else v_par.reorder_point end;
    v_ml := case when v_d ? 'min_level' then (v_d ->> 'min_level')::numeric else v_par.min_level end;
    insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level, updated_at)
    values (p_location, v_item.id, v_pl, v_rp, v_ml, now())
    on conflict (location_id, inventory_item_id)
      do update set par_level = excluded.par_level, reorder_point = excluded.reorder_point, min_level = excluded.min_level,
                    updated_at = now();
  end if;

  -- the use area; the old area's holding moves with it as a within venue transfer
  if v_d ? 'area_id' then
    v_new_area := (v_d ->> 'area_id')::uuid;
    if v_new_area is not null
       and not exists (select 1 from storage_areas a where a.id = v_new_area and a.location_id = p_location and a.archived_at is null) then
      raise exception 'That area is not one of this venue''s live areas.' using errcode = '22023';
    end if;
    if v_new_area is distinct from v_old_area then
      if v_new_area is null then
        delete from inventory_item_areas ia
         where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary;
      else
        select ia.id into v_area_row from inventory_item_areas ia
         where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
         limit 1;
        if v_area_row is not null then
          update inventory_item_areas ia set area_id = v_new_area where ia.id = v_area_row;
        else
          insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)
          values (p_location, v_item.id, v_new_area, true);
        end if;
        if coalesce((v_d ->> 'move_holding')::boolean, true) and v_old_area is not null then
          select coalesce(s.on_hand, 0) into v_qty from inventory_item_area_stock s
           where s.inventory_item_id = v_item.id and s.area_id = v_old_area;
          if coalesce(v_qty, 0) > 0 then
            v_ref := 'TR-' || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1), '')
                                 from generate_series(1, 6));
            insert into stock_transfers (location_id, to_location_id, from_area_id, to_area_id, status, reference, note, created_by_name)
            values (p_location, null, v_old_area, v_new_area, 'DRAFT', v_ref, 'Area changed', v_by)
            returning id into v_tr;
            insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, name_snapshot, sku_snapshot,
                                              base_unit, qty_base, sort_order)
            values (v_tr, p_location, null, v_item.id, v_item.name, v_item.sku, v_item.base_unit, v_qty, 0);
            v_res := public.post_stock_transfer_leg(v_tr, 'both', v_by);
            if not coalesce((v_res ->> 'ok')::boolean, false) then
              raise exception 'The area was not changed: its stock could not be moved (%).', coalesce(v_res ->> 'error', 'refused')
                using errcode = '55000';
            end if;
            v_moved := v_qty;
          end if;
        end if;
      end if;
    end if;
  end if;

  -- the supplier here (Drop 1): a live supplier pack of this item whose supplier can order here
  if v_d ? 'supplier_here' then
    v_new_si := (v_d ->> 'supplier_here')::uuid;
    select si.supplier_id, m.name into v_sup, v_sname
      from stock_co_supplier_items si join stock_co_suppliers m on m.id = si.supplier_id
     where si.id = v_new_si and si.item_id = v_id and si.archived_at is null;
    if v_new_si is null or v_sup is null then
      raise exception 'Pick one of this item''s supplier packs.' using errcode = '22023';
    end if;
    if not exists (select 1 from stock_co_supplier_sites ss join suppliers t on t.id = ss.site_supplier_id
                    where ss.supplier_id = v_sup and ss.location_id = p_location and ss.can_order and t.archived_at is null) then
      raise exception '% cannot deliver to % yet. Tick % on the supplier''s Sites tab first.', v_sname, v_lname, v_lname
        using errcode = '22023';
    end if;
    select x.site_supplier_product_id into v_here_sp
      from stock_co_supplier_item_sites x join supplier_products t on t.id = x.site_supplier_product_id
     where x.supplier_item_id = v_new_si and x.location_id = p_location and t.archived_at is null;
    if v_here_sp is null then
      -- the writer adds this site's copy of the pack when it is missing
      perform public.stock_co__sync_site(p_location, array[v_id], '{}'::uuid[], true, false);
      select x.site_supplier_product_id into v_here_sp
        from stock_co_supplier_item_sites x join supplier_products t on t.id = x.site_supplier_product_id
       where x.supplier_item_id = v_new_si and x.location_id = p_location and t.archived_at is null;
    end if;
    if v_here_sp is null then
      raise exception '% cannot deliver to % yet. Tick % on the supplier''s Sites tab first.', v_sname, v_lname, v_lname
        using errcode = '22023';
    end if;
    if public.stock_co__set_preferred(p_location, v_item.id, v_here_sp, true) then
      perform public.stock_co__cost_step(p_location, array[v_item.id], null, true);
    end if;
    v_here_si := v_new_si;
    select x.price_here into v_ph_before from stock_co_supplier_item_sites x where x.supplier_item_id = v_here_si and x.location_id = p_location;
  end if;

  -- the price here (Drop 1): the supplier here pack's own price at this site, the currency check, then the writer
  if v_d ? 'price_here' then
    if v_here_si is null then
      raise exception 'This item has no supplier here yet. Pick the supplier here first.' using errcode = '22023';
    end if;
    v_ph_after := (v_d ->> 'price_here')::numeric;
    update stock_co_supplier_item_sites x
       set price_here = v_ph_after, row_version = x.row_version + 1, updated_at = now()
     where x.supplier_item_id = v_here_si and x.location_id = p_location and x.price_here is distinct from v_ph_after;
    if found then
      perform public.stock_co__currency_check(v_here_si);
      perform public.stock_co__log(v_org, p_location, 'supplier_item_site', v_here_si, 'price_here', to_jsonb(v_ph_before),
                                   to_jsonb(v_ph_after), v_src);
      v_sync := true;
    end if;
  end if;

  -- stop ordering and the pause here (Drop 1), on the link
  v_stop := case when not (v_d ? 'stop_ordering') then v_link.stop_ordering_at
                 when (v_d ->> 'stop_ordering')::boolean then coalesce(v_link.stop_ordering_at, now())
                 else null end;
  if v_stop is distinct from v_link.stop_ordering_at then
    v_sync := true;
  end if;
  v_paused := case when v_d ? 'paused' then (v_d ->> 'paused')::boolean else v_link.paused end;
  v_pf := case when v_d ? 'paused_from' then (v_d ->> 'paused_from')::date else v_link.paused_from end;
  v_pu := case when v_d ? 'paused_until' then (v_d ->> 'paused_until')::date else v_link.paused_until end;
  if not v_paused then
    v_pf := null;
    v_pu := null;
  end if;
  if v_pf is not null and v_pu is not null and v_pu < v_pf then
    raise exception 'The pause must end on or after the day it starts.' using errcode = '22023';
  end if;

  -- counted here, stop ordering and the pause: the link, then the writer at this site when the site rows follow
  update stock_co_item_sites s
     set counted_here = case when v_d ? 'counted_here' then (v_d ->> 'counted_here')::boolean else s.counted_here end,
         stop_ordering_at = v_stop, paused = v_paused, paused_from = v_pf, paused_until = v_pu,
         row_version = s.row_version + 1, updated_at = now()
   where s.item_id = v_id and s.location_id = p_location
  returning s.row_version into v_rv;
  if v_sync or (v_d ? 'counted_here' and (v_d ->> 'counted_here')::boolean is distinct from v_link.counted_here) then
    perform public.stock_co__sync_site(p_location, array[v_id], '{}'::uuid[], true, false);
  end if;

  select p.par_level, p.reorder_point, p.min_level into v_par from par_levels p
   where p.location_id = p_location and p.inventory_item_id = v_item.id;
  select ia.area_id into v_new_area from inventory_item_areas ia
   where ia.location_id = p_location and ia.inventory_item_id = v_item.id and ia.is_primary
   limit 1;
  select x.price_here into v_ph_after from stock_co_supplier_item_sites x where x.supplier_item_id = v_here_si and x.location_id = p_location;
  v_after := jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point, 'min_level', v_par.min_level,
                                'area_id', v_new_area,
                                'counted_here', case when v_d ? 'counted_here' then (v_d ->> 'counted_here')::boolean else v_link.counted_here end,
                                'supplier_here', v_here_si, 'price_here', v_ph_after, 'stop_ordering_at', v_stop,
                                'paused', v_paused, 'paused_from', v_pf, 'paused_until', v_pu);
  perform public.stock_co__log_diff(v_org, p_location, 'item_site', v_id, v_before - 'price_here', v_after - 'price_here', v_src);
  return jsonb_build_object('ok', true, 'item_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'par', jsonb_build_object('par_level', v_par.par_level, 'reorder_point', v_par.reorder_point,
                                                      'min_level', v_par.min_level),
                            'area_id', v_new_area, 'moved_qty', v_moved, 'counted_here', v_after -> 'counted_here',
                            'price_here', to_jsonb(v_ph_after), 'supplier_here', to_jsonb(v_here_si), 'stop_ordering_at', to_jsonb(v_stop),
                            'paused', to_jsonb(v_paused), 'paused_from', to_jsonb(v_pf), 'paused_until', to_jsonb(v_pu),
                            'queued', '[]'::jsonb);
end
$fn$;

-- REBUILT (Drop 1): the need is stock_co__need_of (a pack of a local item at its own site is site_facts), with the
-- version rule for an existing pack. Sections: inventory.
create or replace function public.stock_save_pack(p_pack jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('pack', p_pack);
  v_id uuid;
  v_item uuid;
  v_parent uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_packs;
  v_new stock_co_packs;
  v_co jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row item_packaging_formats;
  v_need text;
begin
  if (v_d ? 'id' and v_d ? 'site_pack_id') or (v_d ? 'item_id' and v_d ? 'site_item_id')
     or (v_d ? 'parent_pack_id' and v_d ? 'site_parent_pack_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_pack_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('pack', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_packs x where x.id = v_id;
    v_item := v_old.item_id;
    if v_sid is not null then
      select t.row_version into v_srv from item_packaging_formats t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('pack', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A pack cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_item is null then
    raise exception 'A pack needs its item.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  if not public.stock_co__item_at(v_item, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := case when v_id is not null then public.stock_co__need_of('pack', v_id, v_loc)
                 else public.stock_co__need_of('item', v_item, v_loc) end;
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_packs x where x.id = v_id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  if v_d ? 'parent_pack_id' or v_d ? 'site_parent_pack_id' then
    v_parent := public.stock_co__company_id('pack', coalesce((v_d ->> 'parent_pack_id')::uuid, (v_d ->> 'site_parent_pack_id')::uuid));
    if coalesce((v_d ->> 'parent_pack_id'), (v_d ->> 'site_parent_pack_id')) is not null
       and (v_parent is null or v_parent is not distinct from v_id
            or not exists (select 1 from stock_co_packs x where x.id = v_parent and x.item_id = v_item)) then
      raise exception 'The parent pack must be another pack of the same item.' using errcode = '22023';
    end if;
  end if;
  v_co := v_d - array['id', 'site_pack_id', 'location_id', 'item_id', 'site_item_id', 'parent_pack_id', 'site_parent_pack_id'];
  if v_d ? 'parent_pack_id' or v_d ? 'site_parent_pack_id' then
    v_co := v_co || jsonb_build_object('parent_pack_id', v_parent);
  end if;
  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'qty_in_base') is null then
      raise exception 'A new pack needs a name and its size in the base unit.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_packs,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'item_id', v_item, 'is_count_default', false,
                                  'is_purchase_default', false, 'row_version', 1, 'created_at', now(), 'updated_at', now()) || v_co);
    v_new.is_count_default := coalesce(v_new.is_count_default, false);
    v_new.is_purchase_default := coalesce(v_new.is_purchase_default, false);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
  end if;
  -- one count default and one buy default per item, on the company rows (the writer carries them)
  if v_new.is_count_default then
    update stock_co_packs x set is_count_default = false, row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_item and x.id is distinct from v_new.id and x.is_count_default;
  end if;
  if v_new.is_purchase_default then
    update stock_co_packs x set is_purchase_default = false, row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_item and x.id is distinct from v_new.id and x.is_purchase_default;
  end if;
  if v_id is null then
    insert into stock_co_packs select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'pack', v_id, null, to_jsonb(v_new), v_src);
  else
    update stock_co_packs x
       set (name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default, row_version, updated_at)
         = (v_new.name, v_new.qty_in_base, v_new.parent_pack_id, v_new.is_count_default, v_new.is_purchase_default,
            v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'pack', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
                                      array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  select ps.site_pack_id into v_sid from stock_co_pack_sites ps where ps.pack_id = v_id and ps.location_id = v_loc;
  if (v_d ->> 'site_pack_id') is not null then
    select t.row_version into v_rv from item_packaging_formats t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update item_packaging_formats t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from item_packaging_formats t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_pack_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end, 'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('pack'), with the version rule. Sections: inventory.
create or replace function public.stock_archive_pack(p_pack uuid, p_version integer default null, p_archived boolean default true,
                                                     p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('pack', p_pack);
  v_old stock_co_packs;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_packs x where x.id = v_id;
  v_org := v_old.org_id;
  if p_pack <> v_id then
    v_loc := public.stock_co__site_loc('pack', p_pack);
    select t.row_version into v_srv from item_packaging_formats t where t.id = p_pack;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := public.stock_co__need_of('pack', v_id, v_loc);
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_packs x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_pack <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    if exists (select 1 from stock_co_pack_sites ps
                 join recipe_lines rl on rl.location_id = ps.location_id and rl.unit = '@' || ps.site_pack_id::text
                where ps.pack_id = v_id)
       or exists (select 1 from stock_co_recipe_lines l join stock_co_recipes r on r.id = l.recipe_id
                   where l.pack_id = v_id and r.archived_at is null) then
      raise exception 'This pack is used in a recipe, so it cannot be archived. Change those recipe lines to another unit first.'
        using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
    update stock_co_packs x
       set archived_at = v_at, is_count_default = false, is_purchase_default = false,
           row_version = x.row_version + 1, updated_at = now()
     where x.id = v_id;
  else
    v_at := null;
    update stock_co_packs x set archived_at = null, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  end if;
  v_log := public.stock_co__log(v_org, null, 'pack', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_pack <> v_id then
    update item_packaging_formats t set row_version = t.row_version + 1 where t.id = p_pack and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_pack_sites ps where ps.pack_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('pack'), with the version rule. Sections: inventory.
create or replace function public.stock_set_pack_default(p_pack uuid, p_which text, p_version integer default null,
                                                         p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('pack', p_pack);
  v_old stock_co_packs;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if p_which is null or p_which not in ('count', 'purchase') then
    raise exception 'Say which default: count or purchase.' using errcode = '22023';
  end if;
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_packs x where x.id = v_id;
  v_org := v_old.org_id;
  if p_pack <> v_id then
    v_loc := public.stock_co__site_loc('pack', p_pack);
    select t.row_version into v_srv from item_packaging_formats t where t.id = p_pack;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := public.stock_co__need_of('pack', v_id, v_loc);
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_packs x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_pack <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['pack'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if v_old.archived_at is not null then
    raise exception 'This pack is archived, so it cannot be a default.' using errcode = '55000';
  end if;
  if p_which = 'count' then
    update stock_co_packs x set is_count_default = (x.id = v_id), row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_old.item_id and (x.id = v_id or x.is_count_default);
  else
    update stock_co_packs x set is_purchase_default = (x.id = v_id), row_version = x.row_version + 1, updated_at = now()
     where x.item_id = v_old.item_id and (x.id = v_id or x.is_purchase_default);
  end if;
  v_log := public.stock_co__log(v_org, null, 'pack', v_id, case when p_which = 'count' then 'is_count_default' else 'is_purchase_default' end,
                                to_jsonb(case when p_which = 'count' then v_old.is_count_default else v_old.is_purchase_default end),
                                to_jsonb(true), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_pack <> v_id then
    update item_packaging_formats t set row_version = t.row_version + 1 where t.id = p_pack and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'which', p_which, 'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of (a unit bridge of a local item at its own site is site_facts),
-- with the version rule for an existing bridge. Sections: inventory.
create or replace function public.stock_save_bridge(p_bridge jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('bridge', p_bridge);
  v_id uuid;
  v_item uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_bridges;
  v_new stock_co_bridges;
  v_co jsonb;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row inventory_item_conversions;
  v_n integer;
  v_need text;
begin
  if (v_d ? 'id' and v_d ? 'site_bridge_id') or (v_d ? 'item_id' and v_d ? 'site_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_bridge_id')::uuid;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('bridge', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_bridges x where x.id = v_id;
    v_item := v_old.item_id;
    if v_sid is not null then
      select t.row_version into v_srv from inventory_item_conversions t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('bridge', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_d ? 'item_id' or v_d ? 'site_item_id' then
    if v_item is not null and public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid)) is distinct from v_item then
      raise exception 'A unit bridge cannot move to another item.' using errcode = '22023';
    end if;
    v_item := public.stock_co__company_id('item', coalesce((v_d ->> 'item_id')::uuid, (v_d ->> 'site_item_id')::uuid));
  end if;
  if v_item is null then
    raise exception 'A unit bridge needs its item.' using errcode = '22023';
  end if;
  select x.org_id into v_org from stock_co_items x where x.id = v_item;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_loc is null then
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_item));
  end if;
  if not public.stock_co__item_at(v_item, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := case when v_id is not null then public.stock_co__need_of('bridge', v_id, v_loc)
                 else public.stock_co__need_of('item', v_item, v_loc) end;
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  if v_id is not null then
    select * into v_old from stock_co_bridges x where x.id = v_id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['bridge'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  v_co := v_d - array['id', 'site_bridge_id', 'location_id', 'item_id', 'site_item_id'];
  if v_id is null then
    if (v_co ->> 'from_qty') is null or (v_co ->> 'from_unit') is null or (v_co ->> 'to_qty') is null or (v_co ->> 'to_unit') is null then
      raise exception 'A new unit bridge needs both quantities and both units.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_bridges,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org, 'item_id', v_item, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    insert into stock_co_bridges select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'bridge', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_bridges x
       set (from_qty, from_unit, to_qty, to_unit, row_version, updated_at)
         = (v_new.from_qty, v_new.from_unit, v_new.to_qty, v_new.to_unit, v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'bridge', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_item),
                                      array[v_item], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  select bs.site_bridge_id into v_sid from stock_co_bridge_sites bs where bs.bridge_id = v_id and bs.location_id = v_loc;
  if (v_d ->> 'site_bridge_id') is not null then
    select t.row_version into v_rv from inventory_item_conversions t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update inventory_item_conversions t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from inventory_item_conversions t where t.id = v_sid;
  v_n := jsonb_array_length(v_run -> 'queued');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_bridge_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'cost', jsonb_build_object('changed', (select count(*) from jsonb_array_elements(v_run -> 'cost')),
                                                       'items', v_run -> 'cost'),
                            'partial', case when v_n > 0 then format('Saved. %s site(s) catch up within a minute.', v_n) end,
                            'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('bridge'), with the version rule. Sections: inventory.
create or replace function public.stock_archive_bridge(p_bridge uuid, p_version integer default null, p_archived boolean default true,
                                                       p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_id uuid := public.stock_co__company_id('bridge', p_bridge);
  v_old stock_co_bridges;
  v_org uuid;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_bridges x where x.id = v_id;
  v_org := v_old.org_id;
  if p_bridge <> v_id then
    v_loc := public.stock_co__site_loc('bridge', p_bridge);
    select t.row_version into v_srv from inventory_item_conversions t where t.id = p_bridge;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := public.stock_co__need_of('bridge', v_id, v_loc);
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_bridges x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_bridge <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_org, array['bridge'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce(p_archived, true) then
    if public.stock_co__bridge_needed(v_id) then
      raise exception 'A recipe or a supplier pack needs this conversion.' using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
  else
    v_at := null;
  end if;
  update stock_co_bridges x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  v_log := public.stock_co__log(v_org, null, 'bridge', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_bridge <> v_id then
    update inventory_item_conversions t set row_version = t.row_version + 1 where t.id = p_bridge and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_bridge_sites bs where bs.bridge_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('supplier') (a local supplier at its own site is site_facts),
-- with the version rule. Sections: purchasing.
create or replace function public.stock_archive_supplier(p_supplier uuid, p_version integer default null, p_archived boolean default true,
                                                         p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_old stock_co_suppliers;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_suppliers x where x.id = v_id;
  if p_supplier <> v_id then
    v_loc := public.stock_co__site_loc('supplier', p_supplier);
    select t.row_version into v_srv from suppliers t where t.id = p_supplier;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id)
                                           || v_old.local_location_id);
  end if;
  v_need := public.stock_co__need_of('supplier', v_id, v_loc);
  v_g := public.stock_co__guard(v_old.org_id, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_suppliers x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_supplier <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['supplier', 'supplier_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_suppliers x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  v_log := public.stock_co__log(v_old.org_id, null, 'supplier', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id),
                                      '{}'::uuid[], array[v_id], '{}'::uuid[], v_log, v_t0);
  if p_supplier <> v_id then
    update suppliers t set row_version = t.row_version + 1 where t.id = p_supplier and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_supplier_sites s where s.supplier_id = v_id),
                            'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the version rule (the need stays site_price). Sections: inventory, purchasing.
create or replace function public.stock_save_supplier_item_site(p_si uuid, p_location uuid, p_patch jsonb,
                                                                p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_item_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('supplier_item', p_si);
  v_si stock_co_supplier_items;
  v_link stock_co_supplier_item_sites;
  v_g jsonb;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_r jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row supplier_products;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_si <> v_id and public.stock_co__site_loc('supplier_item', p_si) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_si from stock_co_supplier_items x where x.id = v_id;
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = p_location;
  if v_link.supplier_item_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_si.org_id, v_section, 'site_price', array[p_location]);
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = v_id and x.location_id = p_location for update;
  perform public.stock_co__need_version('site_price', p_version);
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_si.org_id, array['supplier_item_site', 'supplier_item'], v_id, v_link.row_version, p_location,
                                     v_link.updated_at);
  end if;
  v_before := jsonb_build_object('price_here', v_link.price_here, 'off_here', v_link.off_here, 'paused', v_link.paused);
  update stock_co_supplier_item_sites x
     set price_here = case when v_d ? 'price_here' then (v_d ->> 'price_here')::numeric else x.price_here end,
         off_here = case when v_d ? 'off_here' then (v_d ->> 'off_here')::boolean else x.off_here end,
         paused = case when v_d ? 'paused' then (v_d ->> 'paused')::boolean else x.paused end,
         row_version = x.row_version + 1, updated_at = now()
   where x.supplier_item_id = v_id and x.location_id = p_location
  returning x.row_version, jsonb_build_object('price_here', x.price_here, 'off_here', x.off_here, 'paused', x.paused)
       into v_rv, v_after;
  perform public.stock_co__currency_check(v_id);
  perform public.stock_co__log_diff(v_si.org_id, p_location, 'supplier_item_site', v_id, v_before, v_after, v_src);
  v_r := public.stock_co__sync_site(p_location, array[v_si.item_id], '{}'::uuid[], true, false);
  select * into v_row from supplier_products t where t.id = v_link.site_supplier_product_id;
  return jsonb_build_object('ok', true, 'supplier_item_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'site_row', to_jsonb(v_row),
                            'cost', coalesce((select jsonb_agg(e || jsonb_build_object('location_id', p_location))
                                                from jsonb_array_elements(coalesce(v_r -> 'cost' -> 'items', '[]'::jsonb)) e), '[]'::jsonb),
                            'queued', '[]'::jsonb);
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('supplier_item') (a supplier pack of a local item or a local
-- supplier at its own site is site_facts), with the version rule. Sections: inventory, purchasing.
create or replace function public.stock_archive_supplier_item(p_si uuid, p_version integer default null, p_archived boolean default true,
                                                              p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_id uuid := public.stock_co__company_id('supplier_item', p_si);
  v_old stock_co_supplier_items;
  v_loc uuid;
  v_srv integer;
  v_rv integer;
  v_g jsonb;
  v_at timestamptz;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_need text;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_old from stock_co_supplier_items x where x.id = v_id;
  if p_si <> v_id then
    v_loc := public.stock_co__site_loc('supplier_item', p_si);
    select t.row_version into v_srv from supplier_products t where t.id = p_si;
  else
    v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_item_sites s
                                                   join stock_co_supplier_sites ss on ss.location_id = s.location_id
                                                                                  and ss.supplier_id = v_old.supplier_id
                                                  where s.item_id = v_old.item_id));
  end if;
  if not public.stock_co__item_at(v_old.item_id, v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_need := public.stock_co__need_of('supplier_item', v_id, v_loc);
  v_g := public.stock_co__guard(v_old.org_id, v_section, v_need, array[v_loc]);
  select * into v_old from stock_co_supplier_items x where x.id = v_id for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null then
    v_rv := case when p_si <> v_id then v_srv else v_old.row_version end;
    if v_rv is distinct from p_version then
      return public.stock_co__conflict(v_old.org_id, array['supplier_item', 'supplier_item_site'], v_id, v_rv, v_loc, v_old.updated_at);
    end if;
  end if;
  v_at := case when coalesce(p_archived, true) then coalesce(v_old.archived_at, now()) end;
  update stock_co_supplier_items x set archived_at = v_at, row_version = x.row_version + 1, updated_at = now() where x.id = v_id;
  if v_at is not null then
    update stock_co_items x set main_supplier_item_id = null where x.id = v_old.item_id and x.main_supplier_item_id = v_id;
  end if;
  v_log := public.stock_co__log(v_old.org_id, null, 'supplier_item', v_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), v_src);
  v_run := public.stock_co__run_sites(v_old.org_id, v_loc, array(select s.location_id from stock_co_item_sites s where s.item_id = v_old.item_id),
                                      array[v_old.item_id], '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
  if p_si <> v_id then
    update supplier_products t set row_version = t.row_version + 1 where t.id = p_si and t.row_version = v_srv;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_supplier_item_sites x where x.supplier_item_id = v_id),
                            'cost', v_run -> 'cost', 'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the version rule for an existing recipe (the need stays company; the levels now apply to it
-- through the guard). Sections: produce; inventory too when the recipe has a made item.
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
begin
  if (v_d ? 'id' and v_d ? 'site_recipe_id') or (v_d ? 'output_item_id' and v_d ? 'site_output_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array', 'null') then
    raise exception 'The recipe lines must be a list.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_recipe_id')::uuid;
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
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[v_loc]);
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
                                  'local_location_id', case when (v_g ->> 'multi')::boolean then v_loc end,
                                  'yield_qty', 1, 'yield_unit', 'each', 'wastage_pct', 0, 'restricted', false, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    v_new.restricted := coalesce(v_new.restricted, false);
    insert into stock_co_recipes select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_recipes x
       set (kind, name, yield_qty, yield_unit, output_item_id, wastage_pct, gp_target_pct, method, photo, row_version, updated_at)
         = (v_new.kind, v_new.name, v_new.yield_qty, v_new.yield_unit, v_new.output_item_id, v_new.wastage_pct, v_new.gp_target_pct,
            v_new.method, v_new.photo, v_new.row_version, v_new.updated_at)
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
                            'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the version rule (the need stays company). Sections: produce; inventory too when it has a
-- made item.
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
  return jsonb_build_object('ok', true, 'id', v_id, 'archived_at', v_at,
                            'sites', (select count(*) from stock_co_recipe_sites s where s.recipe_id = v_id),
                            'links_removed', greatest(v_before - v_after, 0), 'queued', v_run -> 'queued');
end
$fn$;


-- REBUILT (Drop 1): the need is company (was site_facts; map 5.2): in a multi site company the till link of a
-- company recipe is set by head office. Sections: produce.
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
    return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', null,
                              'queued', '[]'::jsonb);
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
  insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
  values (p_location, p_menu_item_id, v_sid, coalesce(p_portion, 1))
  on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id, portion = excluded.portion;
  if v_old is distinct from v_sid::text then
    perform public.stock_co__log(v_org, p_location, 'menu_link', coalesce(v_cid, v_sid), 'menu_item_id', null, to_jsonb(p_menu_item_id), v_src);
  end if;
  return jsonb_build_object('ok', true, 'location_id', p_location, 'menu_item_id', p_menu_item_id, 'recipe_id', v_sid,
                            'queued', '[]'::jsonb);
end
$fn$;


-- REBUILT (Drop 1): the need is stock_co__need_of('supplier_item') (a supplier pack of a local item or a local
-- supplier at its own site is site_facts), with the version rule; new company keys paused, agreed_until and
-- allowed_diff_pct; a site that cannot order from the supplier gets the pack switched off there
-- (stock_co__cant_order_off). Sections: inventory, purchasing.
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
    update stock_co_supplier_items x
       set (supplier_id, supplier_product_name, sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, currency,
            purchase_vat_rate, price_includes_tax, paused, agreed_until, allowed_diff_pct, row_version, updated_at)
         = (v_new.supplier_id, v_new.supplier_product_name, v_new.sku, v_new.pack_description, v_new.pack_qty, v_new.inner_qty,
            v_new.inner_unit, v_new.pack_price, v_new.currency, v_new.purchase_vat_rate, v_new.price_includes_tax,
            v_new.paused, v_new.agreed_until, v_new.allowed_diff_pct, v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier_item', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
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
  select * into v_row from supplier_products t where t.id = v_sid;
  v_n := jsonb_array_length(v_run -> 'queued');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_supplier_product_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'cost', v_run -> 'cost',
                            'partial', case when v_n > 0 then format('Saved. %s site(s) catch up within a minute.', v_n) end,
                            'queued', v_run -> 'queued');
end
$fn$;

-- REBUILT (Drop 1): new company keys min_order_value and delivery_fee, written to every linked site row
-- whose own value is empty or still the company's value from before this save (the order email the
-- same way), so a site's own value is never overwritten. p_sites [{"location_id", "on": bool}]: on adds
-- the link (its old site row back from the archive when it has one, with its own values); off is
-- cannot order (this supplier's packs there switched off, the link gone, the site row archived, never
-- deleted). A local supplier ticked at another site becomes a company supplier (need company). A new
-- supplier with p_sites is a company supplier (need company); a new one in a
-- multi site company with no p_sites is a local supplier of its site (need site_facts); p_sites alone
-- on an existing supplier needs site_price at each named site; an edit needs stock_co__need_of with the
-- version rule. One site company: every form field at its one site row as Drop 0, and its order rules
-- made again from its delivery days in the same call. Multi site company: delivery days and the cut off
-- are set on the Order rules tab. Sections: purchasing; inventory too when creating (the Stock items
-- quick add).
create or replace function public.stock_save_supplier(p_supplier jsonb, p_sites jsonb default null, p_version integer default null,
                                                      p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_d jsonb := public.stock_co__clean('supplier', p_supplier);
  v_site jsonb;
  v_section text;
  v_id uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_suppliers;
  v_new stock_co_suppliers;
  v_co jsonb;
  v_before jsonb;
  v_after jsonb;
  v_log bigint;
  v_l2 bigint;
  v_run jsonb;
  v_created boolean := false;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row suppliers;
  v_need text;
  v_on uuid[] := '{}'::uuid[];
  v_off uuid[] := '{}'::uuid[];
  v_sites_given boolean := false;
  v_only_sites boolean := false;
  v_e jsonb;
  v_s uuid;
  v_x uuid;
  v_link stock_co_supplier_sites;
  r record;
begin
  -- the sites (Drop 1)
  if p_sites is not null and jsonb_typeof(p_sites) <> 'null' then
    if jsonb_typeof(p_sites) <> 'array' then
      raise exception 'The field "sites" must be a list.' using errcode = '22023';
    end if;
    v_sites_given := true;
    for v_e in select e.value from jsonb_array_elements(p_sites) e loop
      if jsonb_typeof(v_e) <> 'object' or coalesce(v_e ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      if jsonb_typeof(v_e -> 'on') = 'boolean' and not (v_e ->> 'on')::boolean then
        v_off := v_off || lower(v_e ->> 'location_id')::uuid;
      else
        v_on := v_on || lower(v_e ->> 'location_id')::uuid;
      end if;
    end loop;
    if exists (select 1 from unnest(v_on) a join unnest(v_off) b on a = b) then
      raise exception 'A site cannot be ticked and unticked at once.' using errcode = '22023';
    end if;
  end if;
  if v_d ? 'id' and v_d ? 'site_supplier_id' then
    raise exception 'Send the supplier id or the site supplier id, not both.' using errcode = '22023';
  end if;
  v_site := coalesce(v_d -> 'site', '{}'::jsonb);
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_supplier_id')::uuid;
  v_section := public.stock_co__section(p_section,
                 case when v_d ? 'id' or v_sid is not null then array['purchasing'] else array['purchasing', 'inventory'] end);
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('supplier', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_suppliers x where x.id = v_id;
    v_org := v_old.org_id;
    if v_sid is not null then
      select t.row_version into v_srv from suppliers t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('supplier', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    elsif v_loc is null then
      -- a site the record is at, or (Drop 1) a site the call ticks on or off, that this login reaches
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id)
                                             || v_old.local_location_id || v_on || v_off);
    end if;
    v_only_sites := v_sites_given and (v_d - array['id', 'site_supplier_id', 'location_id']) = '{}'::jsonb;
    if v_only_sites then
      v_need := 'site_price';
    else
      v_need := public.stock_co__need_of('supplier', v_id, v_loc);
      if v_sites_given then
        v_need := public.stock_co__need_max(v_need, 'site_price');
      end if;
    end if;
    -- a local supplier ticked at another site becomes a company supplier
    if v_old.local_location_id is not null and exists (select 1 from unnest(v_on) x where x <> v_old.local_location_id) then
      v_need := 'company';
    end if;
  else
    if v_loc is null and cardinality(v_on) > 0 then
      v_loc := v_on[1];
    end if;
    if v_loc is null then
      raise exception 'A new supplier needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_need := case when cardinality(v_on) > 0 then 'company' else 'site_facts' end;
    if cardinality(v_on) > 0 and not (v_loc = any(v_on)) then
      v_on := v_on || v_loc;
    end if;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need,
                                array(select distinct x from unnest(array[v_loc] || v_on || v_off) x where x is not null));
  if (v_g ->> 'multi')::boolean and (v_site ? 'delivery_days' or v_site ? 'cutoff_time') then
    raise exception 'Delivery days are set on the Order rules tab.' using errcode = '22023';
  end if;
  if v_id is not null then
    select * into v_old from stock_co_suppliers x where x.id = v_id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['supplier', 'supplier_site'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;
  v_co := v_d - array['id', 'site_supplier_id', 'location_id', 'site'];
  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' then
      raise exception 'A new supplier needs a name.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_suppliers,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean and cardinality(v_on) = 0 then v_loc end,
                                  'accepts_price_changes', true, 'order_method', 'email', 'row_version', 1,
                                  'created_at', now(), 'updated_at', now()) || v_co);
    v_new.accepts_price_changes := coalesce(v_new.accepts_price_changes, true);
    v_new.order_method := coalesce(v_new.order_method, 'email');
    insert into stock_co_suppliers select (v_new).*;
    v_id := v_new.id;
    v_created := true;
    v_sid := public.stock_co__new_site_supplier(v_id, v_loc);
    v_log := public.stock_co__log_diff(v_org, null, 'supplier', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.accepts_price_changes := coalesce(v_new.accepts_price_changes, true);
    v_new.order_method := coalesce(v_new.order_method, 'email');
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    update stock_co_suppliers x
       set (name, contact_name, phone, email, payment_terms_days, accepts_price_changes, max_order_value, order_method, notes,
            min_order_value, delivery_fee, row_version, updated_at)
         = (v_new.name, v_new.contact_name, v_new.phone, v_new.email, v_new.payment_terms_days, v_new.accepts_price_changes,
            v_new.max_order_value, v_new.order_method, v_new.notes, v_new.min_order_value, v_new.delivery_fee,
            v_new.row_version, v_new.updated_at)
     where x.id = v_id;
    select s.site_supplier_id into v_sid from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_loc;
    if v_sid is null and not v_only_sites then
      raise exception 'This supplier is not set up at that site.' using errcode = '22023';
    end if;
    v_log := public.stock_co__log_diff(v_org, null, 'supplier', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
    -- the company defaults (Drop 1): every linked site row that had no value of its own, or still the
    -- company's value from before this save, takes the new one
    if v_co ? 'email' or v_co ? 'min_order_value' or v_co ? 'delivery_fee' then
      for r in
        with u as (
          update suppliers t
             set email = case when v_co ? 'email' and (t.email is null or t.email is not distinct from v_old.email) then v_new.email else t.email end,
                 min_order_value = case when v_co ? 'min_order_value' and (t.min_order_value is null or t.min_order_value = v_old.min_order_value)
                                        then v_new.min_order_value else t.min_order_value end,
                 delivery_fee = case when v_co ? 'delivery_fee' and (t.delivery_fee is null or t.delivery_fee = v_old.delivery_fee)
                                     then v_new.delivery_fee else t.delivery_fee end,
                 row_version = t.row_version + 1, updated_at = now()
            from stock_co_supplier_sites ss
           where ss.supplier_id = v_id and t.id = ss.site_supplier_id and t.location_id = ss.location_id
             and (t.email, t.min_order_value, t.delivery_fee) is distinct from (
                   case when v_co ? 'email' and (t.email is null or t.email is not distinct from v_old.email) then v_new.email else t.email end,
                   case when v_co ? 'min_order_value' and (t.min_order_value is null or t.min_order_value = v_old.min_order_value)
                        then v_new.min_order_value else t.min_order_value end,
                   case when v_co ? 'delivery_fee' and (t.delivery_fee is null or t.delivery_fee = v_old.delivery_fee)
                        then v_new.delivery_fee else t.delivery_fee end)
          returning t.location_id)
        select distinct u.location_id from u
      loop
        perform public.stock_co__log(v_org, r.location_id, 'supplier_site', v_id, 'company_defaults', null,
                                     jsonb_build_object('email', v_new.email, 'min_order_value', v_new.min_order_value,
                                                        'delivery_fee', v_new.delivery_fee), v_src);
      end loop;
    end if;
  end if;

  -- the site fields at location_id
  if v_site <> '{}'::jsonb and v_sid is not null then
    select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                              'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'delivery_days', t.delivery_days,
                              'cutoff_time', t.cutoff_time, 'notes', t.notes)
      into v_before from suppliers t where t.id = v_sid for no key update;
    update suppliers t
       set account_number = case when v_site ? 'account_number' then v_site ->> 'account_number' else t.account_number end,
           email = case when v_site ? 'email' then v_site ->> 'email' else t.email end,
           cc_emails = case when v_site ? 'cc_emails'
                            then (select array_agg(e) from jsonb_array_elements_text(v_site -> 'cc_emails') e) else t.cc_emails end,
           min_order_value = case when v_site ? 'min_order_value' then (v_site ->> 'min_order_value')::numeric else t.min_order_value end,
           delivery_fee = case when v_site ? 'delivery_fee' then (v_site ->> 'delivery_fee')::numeric else t.delivery_fee end,
           delivery_days = case when v_site ? 'delivery_days' then coalesce(v_site -> 'delivery_days', '[]'::jsonb) else t.delivery_days end,
           cutoff_time = case when v_site ? 'cutoff_time' then v_site ->> 'cutoff_time' else t.cutoff_time end,
           notes = case when v_site ? 'notes' then v_site ->> 'notes' else t.notes end,
           row_version = t.row_version + 1, updated_at = now()
     where t.id = v_sid and t.location_id = v_loc;
    select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                              'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'delivery_days', t.delivery_days,
                              'cutoff_time', t.cutoff_time, 'notes', t.notes)
      into v_after from suppliers t where t.id = v_sid;
    v_l2 := public.stock_co__log_diff(v_org, v_loc, 'supplier_site', v_id, v_before, v_after, v_src);
    v_log := coalesce(v_l2, v_log);
  end if;
  -- a one site company's order rules follow its delivery days and cut off (map 4.4)
  if not (v_g ->> 'multi')::boolean and v_sid is not null and (v_created or v_site ? 'delivery_days' or v_site ? 'cutoff_time') then
    perform public.stock_co__seed_order_rules(v_sid);
  end if;

  -- the sites that can order from it (Drop 1)
  if v_new.local_location_id is not null and exists (select 1 from unnest(v_on) x where x <> v_new.local_location_id) then
    update stock_co_suppliers x set local_location_id = null, row_version = x.row_version + 1, updated_at = now()
     where x.id = v_id and x.local_location_id is not null
    returning x.row_version into v_new.row_version;
    perform public.stock_co__log(v_org, null, 'supplier', v_id, 'local_location_id', to_jsonb(v_new.local_location_id), null, v_src);
    v_new.local_location_id := null;
  end if;
  foreach v_s in array v_on loop
    select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_s for update;
    if v_link.supplier_id is null then
      -- its old site row there comes back (the site keeps its own account number); else a new one
      select t.id into v_x from suppliers t
       where t.company_ref = v_id and t.location_id = v_s
         and not exists (select 1 from stock_co_supplier_sites ss where ss.site_supplier_id = t.id)
       order by (t.archived_at is null) desc, t.updated_at desc, t.id
       limit 1;
      if v_x is not null then
        insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id, can_order)
        values (v_id, v_org, v_s, v_x, true);
        update suppliers t set archived_at = null, row_version = t.row_version + 1, updated_at = now()
         where t.id = v_x and t.location_id = v_s and t.archived_at is not null and v_new.archived_at is null;
      else
        v_x := public.stock_co__new_site_supplier(v_id, v_s);
      end if;
      update suppliers t
         set min_order_value = coalesce(t.min_order_value, v_new.min_order_value),
             delivery_fee = coalesce(t.delivery_fee, v_new.delivery_fee),
             row_version = t.row_version + 1, updated_at = now()
       where t.id = v_x and t.location_id = v_s
         and (t.min_order_value is null and v_new.min_order_value is not null
              or t.delivery_fee is null and v_new.delivery_fee is not null);
      update stock_co_supplier_item_sites x set off_here = false, row_version = x.row_version + 1, updated_at = now()
       where x.location_id = v_s and x.off_here
         and x.supplier_item_id in (select si.id from stock_co_supplier_items si where si.supplier_id = v_id);
      perform public.stock_co__log(v_org, v_s, 'supplier_site', v_id, 'can_order', to_jsonb(false), to_jsonb(true), v_src);
    elsif not v_link.can_order
          or exists (select 1 from suppliers t where t.id = v_link.site_supplier_id and t.archived_at is not null) then
      update stock_co_supplier_sites s set can_order = true, row_version = s.row_version + 1, updated_at = now()
       where s.supplier_id = v_id and s.location_id = v_s;
      update suppliers t set archived_at = null, row_version = t.row_version + 1, updated_at = now()
       where t.id = v_link.site_supplier_id and t.location_id = v_s and t.archived_at is not null and v_new.archived_at is null;
      update stock_co_supplier_item_sites x set off_here = false, row_version = x.row_version + 1, updated_at = now()
       where x.location_id = v_s and x.off_here
         and x.supplier_item_id in (select si.id from stock_co_supplier_items si where si.supplier_id = v_id);
      perform public.stock_co__log(v_org, v_s, 'supplier_site', v_id, 'can_order', to_jsonb(v_link.can_order), to_jsonb(true), v_src);
    end if;
  end loop;
  -- cannot order (Drop 1): this supplier's packs there are switched off and archived by the writer, the link
  -- goes (so no writer run brings the site row back, and no new pack of this supplier is added there),
  -- and the site row is archived, never deleted: a tick on later brings it back with its own values
  foreach v_s in array v_off loop
    select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_s for update;
    if v_link.supplier_id is not null then
      update stock_co_supplier_item_sites x set off_here = true, row_version = x.row_version + 1, updated_at = now()
       where x.location_id = v_s and not x.off_here
         and x.supplier_item_id in (select si.id from stock_co_supplier_items si where si.supplier_id = v_id);
      perform public.stock_co__sync_site(v_s, '{}'::uuid[], array[v_id], true, false);
      delete from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_s;
      update suppliers t set archived_at = coalesce(t.archived_at, now()), row_version = t.row_version + 1, updated_at = now()
       where t.id = v_link.site_supplier_id and t.location_id = v_s and t.archived_at is null;
      perform public.stock_co__log(v_org, v_s, 'supplier_site', v_id, 'can_order', to_jsonb(v_link.can_order), to_jsonb(false), v_src);
    end if;
  end loop;

  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id),
                                      '{}'::uuid[], array[v_id], '{}'::uuid[], v_log, v_t0);
  if v_sid is null then
    select s.site_supplier_id into v_sid from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = v_loc;
  end if;
  if (v_d ->> 'site_supplier_id') is not null then
    select t.row_version into v_rv from suppliers t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update suppliers t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from suppliers t where t.id = v_sid;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_supplier_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end, 'queued', v_run -> 'queued');
end
$fn$;

-- REBUILT (Drop 1): a need per key. account_number, email, cc_emails: site_facts (the site knows its own
-- account); can_order, min_order_value, delivery_fee: site_price; approval_limit: company (a manager never
-- raises their own limit). The strictest key decides. Version rule on the supplier's site link. A site
-- that cannot order has this supplier's packs switched off there (stock_co__cant_order_off); can order
-- again switches them back on. Sections: purchasing.
create or replace function public.stock_save_supplier_site(p_supplier uuid, p_location uuid, p_patch jsonb, p_version integer default null,
                                                           p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_d jsonb := public.stock_co__clean('supplier_site_patch', p_patch);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_org uuid;
  v_link stock_co_supplier_sites;
  v_g jsonb;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row suppliers;
  v_need text := 'site_facts';
  v_n integer := 0;
begin
  if v_id is null or p_location is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_supplier <> v_id and public.stock_co__site_loc('supplier', p_supplier) is distinct from p_location then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_suppliers x where x.id = v_id;
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location;
  if v_link.supplier_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_d ? 'approval_limit' then
    v_need := 'company';
  elsif v_d ?| array['can_order', 'min_order_value', 'delivery_fee'] then
    v_need := 'site_price';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need, array[p_location]);
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location for update;
  perform public.stock_co__need_version(v_need, p_version);
  if p_version is not null and v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_org, array['supplier_site', 'supplier'], v_id, v_link.row_version, p_location, v_link.updated_at);
  end if;
  select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                            'can_order', v_link.can_order, 'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee,
                            'approval_limit', t.approval_limit)
    into v_before from suppliers t where t.id = v_link.site_supplier_id for no key update;
  update suppliers t
     set account_number = case when v_d ? 'account_number' then v_d ->> 'account_number' else t.account_number end,
         email = case when v_d ? 'email' then v_d ->> 'email' else t.email end,
         cc_emails = case when v_d ? 'cc_emails'
                          then (select array_agg(e) from jsonb_array_elements_text(v_d -> 'cc_emails') e) else t.cc_emails end,
         min_order_value = case when v_d ? 'min_order_value' then (v_d ->> 'min_order_value')::numeric else t.min_order_value end,
         delivery_fee = case when v_d ? 'delivery_fee' then (v_d ->> 'delivery_fee')::numeric else t.delivery_fee end,
         approval_limit = case when v_d ? 'approval_limit' then (v_d ->> 'approval_limit')::numeric else t.approval_limit end,
         row_version = t.row_version + 1, updated_at = now()
   where t.id = v_link.site_supplier_id and t.location_id = p_location
     and (v_d ? 'account_number' or v_d ? 'email' or v_d ? 'cc_emails' or v_d ? 'min_order_value' or v_d ? 'delivery_fee'
          or v_d ? 'approval_limit');
  update stock_co_supplier_sites s
     set can_order = case when v_d ? 'can_order' then (v_d ->> 'can_order')::boolean else s.can_order end,
         row_version = s.row_version + 1, updated_at = now()
   where s.supplier_id = v_id and s.location_id = p_location
  returning s.row_version into v_rv;
  -- can order changed (Drop 1): this supplier's packs at this site follow, through the writer
  if v_d ? 'can_order' and (v_d ->> 'can_order')::boolean is distinct from v_link.can_order then
    if (v_d ->> 'can_order')::boolean then
      update stock_co_supplier_item_sites x set off_here = false, row_version = x.row_version + 1, updated_at = now()
       where x.location_id = p_location and x.off_here
         and x.supplier_item_id in (select si.id from stock_co_supplier_items si where si.supplier_id = v_id);
      get diagnostics v_n = row_count;
    else
      v_n := public.stock_co__cant_order_off(p_location, array(select si.id from stock_co_supplier_items si where si.supplier_id = v_id));
    end if;
    if v_n > 0 then
      perform public.stock_co__sync_site(p_location, '{}'::uuid[], array[v_id], true, false);
    end if;
  end if;
  select jsonb_build_object('account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                            'can_order', (select s.can_order from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location),
                            'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'approval_limit', t.approval_limit)
    into v_after from suppliers t where t.id = v_link.site_supplier_id;
  perform public.stock_co__log_diff(v_org, p_location, 'supplier_site', v_id, v_before, v_after, v_src);
  select * into v_row from suppliers t where t.id = v_link.site_supplier_id;
  return jsonb_build_object('ok', true, 'supplier_id', v_id, 'location_id', p_location, 'row_version', v_rv,
                            'site_row', to_jsonb(v_row), 'queued', '[]'::jsonb);
end
$fn$;

-- REBUILT (Drop 1): the new job kinds of contract 1.8 (set_sites, pause, change_prices, import_commit, copy_site,
-- category_rename, resync_site), each run one step at a time by stock_co__d1_step with the 0a rules (lock
-- and deadlock back off one minute; other errors retry up to 5 times, then failed with the database's
-- words). site_sync is unchanged. Owner only.
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

-- REBUILT (Drop 1): before the job loop, the dated prices of the day (stock_co__apply_dated_prices), in a block of
-- their own. Otherwise exactly the 0a runner.
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


-- REBUILT (Drop 1): also deletes import jobs that are done, failed or cancelled and older than 14 days, or still
-- staging after 2 days; the answer adds import_jobs_purged. The per site drift check is stock_nightly_health.
-- Service role only.
create or replace function public.stock_nightly_upkeep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_pins   integer := 0;
  v_sites  integer := 0;
  v_rows   integer := 0;
  v_imports integer := 0;
  r        record;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'This runs from the nightly stock job only.' using errcode = '42501';
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  perform set_config('lock_timeout', '200ms', true);

  delete from stock_pin_tries where tried_at < now() - interval '1 day';
  get diagnostics v_pins = row_count;

  for r in
    select i.id, i.location_id, s.item_id, s.org_id
      from stock_co_item_sites s
      join inventory_items i on i.id = s.site_item_id
     where s.stop_ordering_at is not null and s.stop_ordering_at <= now()
       and i.archived_at is null and i.on_hand = 0
       and not exists (select 1 from recipe_lines rl join recipes rc on rc.id = rl.recipe_id
                        where rl.location_id = i.location_id and rl.component_item_id = i.id and rc.archived_at is null)
       and not exists (select 1 from recipes rc
                        where rc.location_id = i.location_id and rc.output_item_id = i.id and rc.archived_at is null)
     order by i.id
     limit 2000
  loop
    begin
      update inventory_items
         set archived_at = now(), row_version = row_version + 1, updated_at = now()
       where id = r.id and archived_at is null and on_hand = 0;
      if found then
        update stock_co_item_sites
           set on_here = false, row_version = row_version + 1, updated_at = now()
         where item_id = r.item_id and location_id = r.location_id;
        perform public.stock_co__log(r.org_id, r.location_id, 'item_site', r.item_id, 'archived_at', null,
                                     to_jsonb(now()), 'nightly');
        v_sites := v_sites + 1;
      end if;
    exception when lock_not_available or deadlock_detected then
      null;
    end;
  end loop;

  for r in
    select 'stock_co_items'::text as t, 'item'::text as e, c.id, c.org_id
      from stock_co_items c
     where c.archived_at is null and not exists (select 1 from stock_co_item_sites s where s.item_id = c.id)
    union all
    select 'stock_co_suppliers', 'supplier', c.id, c.org_id
      from stock_co_suppliers c
     where c.archived_at is null and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = c.id)
    union all
    select 'stock_co_supplier_items', 'supplier_item', c.id, c.org_id
      from stock_co_supplier_items c
     where c.archived_at is null and not exists (select 1 from stock_co_supplier_item_sites s where s.supplier_item_id = c.id)
    union all
    select 'stock_co_packs', 'pack', c.id, c.org_id
      from stock_co_packs c
     where c.archived_at is null and not exists (select 1 from stock_co_pack_sites s where s.pack_id = c.id)
    union all
    select 'stock_co_bridges', 'bridge', c.id, c.org_id
      from stock_co_bridges c
     where c.archived_at is null and not exists (select 1 from stock_co_bridge_sites s where s.bridge_id = c.id)
    union all
    select 'stock_co_recipes', 'recipe', c.id, c.org_id
      from stock_co_recipes c
     where c.archived_at is null and not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = c.id)
    limit 5000
  loop
    begin
      execute format('update public.%I set archived_at = now(), row_version = row_version + 1, updated_at = now() '
                     || 'where id = $1 and archived_at is null', r.t) using r.id;
      if found then
        perform public.stock_co__log(r.org_id, null, r.e, r.id, 'archived_at', null, to_jsonb(now()), 'nightly');
        v_rows := v_rows + 1;
      end if;
    exception when lock_not_available or deadlock_detected then
      null;
    end;
  end loop;

  -- Drop 1: import files that are done, failed or cancelled and older than 14 days, or still staging after
  -- 2 days (their rows go with them)
  delete from stock_co_import_jobs j
   where (j.status in ('done', 'failed', 'cancelled') and j.updated_at < now() - interval '14 days')
      or (j.status = 'staging' and j.created_at < now() - interval '2 days');
  get diagnostics v_imports = row_count;

  return jsonb_build_object('pin_tries_purged', v_pins, 'site_items_archived', v_sites, 'company_rows_archived', v_rows,
                            'import_jobs_purged', v_imports);
end
$fn$;

-- REBUILT (Drop 1): additive keys only (contract 1.7). item.category_name; count_pack, local, catching_up; per
-- supplier pack next_price and unit_price (and per site next_price and unit_price); per site price_here,
-- unit_price, supplier_here, last_paid, why_on, paused_from, paused_until, recipes_here, recipe_names_here,
-- area_name, can_order_suppliers, is_sellable. p_item is the company id or a site row id.
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

-- ============================================================================
-- STEP 7. THE READS OF THE COMPANY LIST (keyset pages of at most 100, never OFFSET)
-- ============================================================================

-- The sites a read covers: p_sites (null = every open site of the company this login reaches), only the
-- ones in this login's reach and in that company. None left: refused like the guard. Then the guard's
-- read checks (signed in, not anonymous, second step). Owner only.
create or replace function public.stock_co__read_scope(p_org uuid, p_sites uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_reach text[];
  v uuid[];
begin
  perform public.stock_co__signed_in();
  if p_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_reach := array(select public.stock_reach_locations());
  if p_sites is null then
    v := array(select l.id from locations l
                where l.org_id = p_org and coalesce(l.status, 'active') = 'active' and l.id::text = any(v_reach)
                order by l.name, l.id);
  else
    v := array(select l.id from locations l
                where l.id = any(p_sites) and l.org_id = p_org and l.id::text = any(v_reach)
                order by l.name, l.id);
  end if;
  if coalesce(cardinality(v), 0) = 0 then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(p_org, null, 'read', v);
  return v;
end
$fn$;

-- A filter value: a uuid, a yes or no, or one of a list. Owner only.
create or replace function public.stock_co__filter_uuid(p_f jsonb, p_key text)
returns uuid
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not (p_f ? p_key) or jsonb_typeof(p_f -> p_key) = 'null' then
    return null;
  end if;
  if coalesce(p_f ->> p_key, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'The filter "%" is not a valid id.', p_key using errcode = '22023';
  end if;
  return lower(p_f ->> p_key)::uuid;
end
$fn$;

create or replace function public.stock_co__filter_bool(p_f jsonb, p_key text)
returns boolean
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not (p_f ? p_key) or jsonb_typeof(p_f -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_f -> p_key) <> 'boolean' then
    raise exception 'The filter "%" must be yes or no.', p_key using errcode = '22023';
  end if;
  return (p_f ->> p_key)::boolean;
end
$fn$;

create or replace function public.stock_co__filter_keys(p_f jsonb, p_allowed text[])
returns jsonb
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
declare
  k text;
begin
  if p_f is null or jsonb_typeof(p_f) = 'null' then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_f) <> 'object' then
    raise exception 'The filters must be a group of fields.' using errcode = '22023';
  end if;
  for k in select x from jsonb_object_keys(p_f) x loop
    if not (k = any(p_allowed)) then
      raise exception 'The filter "%" is not known.', k using errcode = '22023';
    end if;
  end loop;
  return p_f;
end
$fn$;

-- The item list and the Sites grid (contract 1.7): company items of p_org that are linked at a site in
-- scope, or local to one, or (Stock control all, every site) linked nowhere; one row per item with every
-- linked site in scope packed in. Ordered by lower(name), id; p_after is the previous answer's "next".
-- The 100 ids come first by keyset; the sites are joined for those ids only. The filter "ids" (up to 100
-- company item ids) reads only those rows again, so a screen that saved one cell never reads every page.
create or replace function public.stock_items_page(p_org uuid, p_sites uuid[], p_search text default null, p_filters jsonb default null,
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
  v_f jsonb := public.stock_co__filter_keys(p_filters, array['category_id', 'no_category', 'type', 'supplier_id', 'not_at', 'on_at',
                                                            'paused', 'running_out', 'local', 'low', 'archived', 'ids']);
  v_only uuid[];
  v_scope uuid[];
  v_unlinked boolean;
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_k text;
  v_aid uuid;
  v_cat uuid := public.stock_co__filter_uuid(v_f, 'category_id');
  v_nocat boolean := coalesce(public.stock_co__filter_bool(v_f, 'no_category'), false);
  v_type text;
  v_sup uuid := public.stock_co__filter_uuid(v_f, 'supplier_id');
  v_not_at uuid := public.stock_co__filter_uuid(v_f, 'not_at');
  v_on_at uuid := public.stock_co__filter_uuid(v_f, 'on_at');
  v_paused boolean := coalesce(public.stock_co__filter_bool(v_f, 'paused'), false);
  v_runout boolean := coalesce(public.stock_co__filter_bool(v_f, 'running_out'), false);
  v_local boolean := public.stock_co__filter_bool(v_f, 'local');
  v_low boolean := coalesce(public.stock_co__filter_bool(v_f, 'low'), false);
  v_arch boolean := coalesce(public.stock_co__filter_bool(v_f, 'archived'), false);
  v_days jsonb;
  v_dmin date;
  v_dmax date;
  v_ids uuid[];
  v_rows jsonb;
  v_total integer;
  v_last record;
begin
  if v_f ? 'type' and jsonb_typeof(v_f -> 'type') <> 'null' then
    v_type := v_f ->> 'type';
    if v_type not in ('food', 'drink', 'other') then
      raise exception 'The filter "type" must be one of: food, drink, other.' using errcode = '22023';
    end if;
  end if;
  if v_f ? 'ids' and jsonb_typeof(v_f -> 'ids') <> 'null' then
    if jsonb_typeof(v_f -> 'ids') <> 'array' or jsonb_array_length(v_f -> 'ids') > 100
       or exists (select 1 from jsonb_array_elements(v_f -> 'ids') x
                   where jsonb_typeof(x) <> 'string'
                      or (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'The filter "ids" must be a list of up to 100 items.' using errcode = '22023';
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
  -- each site's business day, once
  select jsonb_object_agg(x.loc, public.stock_co__today(x.loc)), min(public.stock_co__today(x.loc)), max(public.stock_co__today(x.loc))
    into v_days, v_dmin, v_dmax
    from unnest(v_scope) x(loc);

  with base as (
    select i.id, lower(i.name) as k
      from stock_co_items i
     where i.org_id = p_org
       and (v_only is null or i.id = any(v_only))
       and case when v_arch then i.archived_at is not null else i.archived_at is null end
       and (exists (select 1 from stock_co_item_sites s where s.item_id = i.id and s.location_id = any(v_scope))
            or i.local_location_id = any(v_scope)
            or (v_unlinked and not exists (select 1 from stock_co_item_sites s where s.item_id = i.id)))
       and (v_q is null or strpos(lower(i.name), v_q) > 0 or strpos(lower(coalesce(i.sku, '')), v_q) > 0
            or strpos(lower(coalesce(i.barcode, '')), v_q) > 0)
       and (v_cat is null or i.category_id = v_cat)
       and (not v_nocat or i.category_id is null)
       and (v_type is null or i.type = v_type)
       and (v_sup is null or exists (select 1 from stock_co_supplier_items si
                                      where si.item_id = i.id and si.supplier_id = v_sup and si.archived_at is null))
       and (v_not_at is null or not exists (select 1 from stock_co_item_sites s
                                             where s.item_id = i.id and s.location_id = v_not_at and s.on_here))
       and (v_on_at is null or exists (select 1 from stock_co_item_sites s
                                        where s.item_id = i.id and s.location_id = v_on_at and s.on_here))
       and (v_local is null or (i.local_location_id is not null) = v_local)
       and (not v_paused
            or (i.paused_from is not null and i.paused_from <= v_dmax and (i.paused_until is null or v_dmin <= i.paused_until))
            or exists (select 1 from stock_co_item_sites s
                        where s.item_id = i.id and s.location_id = any(v_scope) and s.paused
                          and (s.paused_from is null or s.paused_from <= (v_days ->> s.location_id::text)::date)
                          and (s.paused_until is null or (v_days ->> s.location_id::text)::date <= s.paused_until)))
       and (not v_runout or exists (select 1 from stock_co_item_sites s
                                     where s.item_id = i.id and s.location_id = any(v_scope) and s.stop_ordering_at is not null))
       and (not v_low or (v_on_at is not null
                          and exists (select 1 from stock_co_item_sites s
                                        join inventory_items t on t.id = s.site_item_id
                                        join par_levels pl on pl.location_id = s.location_id and pl.inventory_item_id = t.id
                                       where s.item_id = i.id and s.location_id = v_on_at
                                         and pl.reorder_point is not null and t.on_hand < pl.reorder_point)))
  )
  select array(select b.id from base b
                where v_aid is null or (b.k, b.id) > (v_k, v_aid)
                order by b.k, b.id
                limit v_lim + 1),
         case when v_aid is null then (select count(*)::integer from base) end
    into v_ids, v_total;

  with ids as (
    select x.id, x.o from unnest(v_ids[1:v_lim]) with ordinality x(id, o)
  ),
  links as (
    select s.item_id, s.location_id, s.site_item_id, s.on_here, s.paused, s.paused_from, s.paused_until, s.stop_ordering_at,
           s.row_version, t.on_hand, t.current_cost, pl.par_level, pl.reorder_point, pl.min_level,
           sh.supplier_item_id as here_si, sh.price_here, sh.pack_price as here_price, sh.supplier_name as here_name,
           (s.paused and (s.paused_from is null or s.paused_from <= (v_days ->> s.location_id::text)::date)
                     and (s.paused_until is null or (v_days ->> s.location_id::text)::date <= s.paused_until)) as paused_now
      from ids
      join stock_co_item_sites s on s.item_id = ids.id and s.location_id = any(v_scope)
      join inventory_items t on t.id = s.site_item_id
      left join par_levels pl on pl.location_id = s.location_id and pl.inventory_item_id = s.site_item_id
      left join lateral (select x.supplier_item_id, x.price_here, sp.pack_price, m.name as supplier_name
                           from supplier_products sp
                           join stock_co_supplier_item_sites x on x.site_supplier_product_id = sp.id and x.location_id = s.location_id
                           join stock_co_supplier_items si on si.id = x.supplier_item_id
                           join stock_co_suppliers m on m.id = si.supplier_id
                          where sp.location_id = s.location_id and sp.inventory_item_id = s.site_item_id
                            and sp.is_preferred and sp.archived_at is null
                          order by sp.id
                          limit 1) sh on true
  ),
  mains as (
    select ids.id as item_id,
           (select si.id from stock_co_supplier_items si
             where si.item_id = ids.id and si.archived_at is null
             order by (si.id is not distinct from i.main_supplier_item_id) desc, si.created_at, si.id
             limit 1) as si_id
      from ids join stock_co_items i on i.id = ids.id
  ),
  units as (
    select si.id, public.stock_co__qty_in_base(si.item_id, si.pack_qty * si.inner_qty, si.inner_unit) as qb,
           si.price_includes_tax, coalesce(si.purchase_vat_rate, 0) as vat
      from stock_co_supplier_items si
     where si.id in (select l.here_si from links l where l.here_si is not null union select m.si_id from mains m where m.si_id is not null)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'name', i.name,
           'name_suffix', case when tw.n > 1 and tw.rk > 1 then '(' || tw.rk || ')' end,
           'category', i.category, 'category_id', i.category_id, 'type', i.type, 'base_unit', i.base_unit, 'sku', i.sku,
           'barcode', i.barcode, 'local_location_id', i.local_location_id, 'archived_at', i.archived_at, 'key_item', i.key_item,
           'exclude_from_gp', i.exclude_from_gp, 'row_version', i.row_version,
           'paused', case when i.paused_from is not null and i.paused_from <= v_dmax and (i.paused_until is null or v_dmin <= i.paused_until)
                          then jsonb_build_object('from', i.paused_from, 'until', i.paused_until) end,
           'main', (select jsonb_build_object('supplier_item_id', si.id, 'supplier_id', si.supplier_id, 'supplier_name', m.name,
                                              'pack_description', si.pack_description, 'pack_price', si.pack_price, 'currency', si.currency,
                                              'unit_price', case when u.qb > 0 then round(case when u.price_includes_tax then si.pack_price / (1 + u.vat)
                                                                                               else si.pack_price end / u.qb, 8) end)
                      from mains mm
                      join stock_co_supplier_items si on si.id = mm.si_id
                      join stock_co_suppliers m on m.id = si.supplier_id
                      left join units u on u.id = si.id
                     where mm.item_id = i.id),
           'count_pack', (select jsonb_build_object('id', p.id, 'name', p.name, 'qty_in_base', p.qty_in_base)
                            from stock_co_packs p where p.item_id = i.id and p.is_count_default and p.archived_at is null
                           order by p.id limit 1),
           'sites', coalesce((select jsonb_agg(jsonb_build_object(
                       'location_id', l.location_id, 'site_item_id', l.site_item_id, 'on', l.on_here, 'paused', coalesce(l.paused_now, false),
                       'paused_until', case when l.paused_now then l.paused_until end, 'stop_ordering_at', l.stop_ordering_at,
                       'price_here', l.price_here,
                       'unit_price', case when u.qb > 0 then round(case when u.price_includes_tax then l.here_price / (1 + u.vat)
                                                                        else l.here_price end / u.qb, 8) end,
                       'unit_cost', l.current_cost, 'on_hand', l.on_hand, 'par_level', l.par_level, 'reorder_point', l.reorder_point,
                       'min_level', l.min_level,
                       'supplier_here', case when l.here_si is null then null
                                             else jsonb_build_object('supplier_item_id', l.here_si, 'supplier_name', l.here_name) end,
                       'row_version', l.row_version) order by array_position(v_scope, l.location_id))
                                from links l left join units u on u.id = l.here_si
                               where l.item_id = i.id), '[]'::jsonb),
           'sites_on', (select count(*) from links l where l.item_id = i.id and l.on_here),
           'stock_value', coalesce((select sum(greatest(coalesce(l.on_hand, 0), 0) * coalesce(l.current_cost, 0))
                                      from links l where l.item_id = i.id and l.on_here), 0))
         order by ids.o), '[]'::jsonb)
    into v_rows
    from ids
    join stock_co_items i on i.id = ids.id
   cross join lateral (select count(*) filter (where (j.created_at, j.id) <= (i.created_at, i.id))::integer as rk, count(*)::integer as n
                         from stock_co_items j
                        where j.org_id = i.org_id and lower(j.name) = lower(i.name) and j.base_unit = i.base_unit
                          and j.archived_at is null) tw;

  if cardinality(v_ids) > v_lim then
    select lower(i.name) as k, i.id into v_last from stock_co_items i where i.id = v_ids[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id), 'total', v_total,
                              'sites', to_jsonb(v_scope));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null, 'total', v_total, 'sites', to_jsonb(v_scope));
end
$fn$;

-- The recipes that use one item (company recipes, live), with the sites each is on at in this login's
-- reach. Ordered by lower(name), recipe id; p_after {"k", "id"}.
create or replace function public.stock_item_used_in(p_item uuid, p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_id uuid := public.stock_co__company_id('item', p_item);
  v_item stock_co_items;
  v_reach text[];
  v_k text;
  v_aid uuid;
  v_rows jsonb;
  v_n integer;
  v_last jsonb;
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
  perform public.stock_co__guard(v_item.org_id, null, 'read',
            array(select s.location_id from stock_co_item_sites s where s.item_id = v_id and s.location_id::text = any(v_reach))
            || case when v_item.local_location_id::text = any(v_reach) then array[v_item.local_location_id] else '{}'::uuid[] end);
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  with pg as (
    select r.id, lower(r.name) as k, r.name, r.kind, r.output_item_id, ln.qty, ln.unit, ln.pack_id
      from stock_co_recipes r
     cross join lateral (select l.qty, l.unit, l.pack_id from stock_co_recipe_lines l
                          where l.recipe_id = r.id and l.component_item_id = v_id
                          order by l.sort_order, l.id limit 1) ln
     where r.org_id = v_item.org_id and r.archived_at is null
       and (v_aid is null or (lower(r.name), r.id) > (v_k, v_aid))
     order by lower(r.name), r.id
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'recipe_id', pg.id, 'name', pg.name, 'kind', pg.kind, 'qty', pg.qty, 'unit', pg.unit,
           'pack_name', (select p.name from stock_co_packs p where p.id = pg.pack_id), 'output_item_id', pg.output_item_id,
           'sites', (select coalesce(jsonb_agg(jsonb_build_object('location_id', rs.location_id, 'on_here', rs.on_here) order by rs.location_id), '[]'::jsonb)
                       from stock_co_recipe_sites rs where rs.recipe_id = pg.id and rs.location_id::text = any(v_reach)),
           'k', pg.k) order by pg.k, pg.id), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from pg;
  if v_n > v_lim then
    v_rows := (select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where o <= v_lim);
    v_last := v_rows -> (v_lim - 1);
    return jsonb_build_object('rows', (select jsonb_agg(e - 'k') from jsonb_array_elements(v_rows) e),
                              'next', jsonb_build_object('k', v_last ->> 'k', 'id', v_last ->> 'recipe_id'));
  end if;
  return jsonb_build_object('rows', (select coalesce(jsonb_agg(e - 'k'), '[]'::jsonb) from jsonb_array_elements(v_rows) e), 'next', null);
end
$fn$;

-- The supplier list (contract 1.7): company suppliers of p_org linked at a site in scope, or local to one,
-- or (Stock control all, every site) linked nowhere. Spend this month: orders sent, part received or
-- received at the sites in scope since the start of each site's own business month (one instant per
-- site). Ordered by lower(name), id; p_after {"k", "id"}.
create or replace function public.stock_suppliers_page(p_org uuid, p_sites uuid[], p_search text default null, p_filters jsonb default null,
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
  v_f jsonb := public.stock_co__filter_keys(p_filters, array['local', 'archived', 'can_order_at']);
  v_scope uuid[];
  v_unlinked boolean;
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_local boolean := public.stock_co__filter_bool(v_f, 'local');
  v_arch boolean := coalesce(public.stock_co__filter_bool(v_f, 'archived'), false);
  v_can uuid := public.stock_co__filter_uuid(v_f, 'can_order_at');
  v_k text;
  v_aid uuid;
  v_ids uuid[];
  v_rows jsonb;
  v_starts jsonb;
  v_last record;
begin
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if v_can is not null and not (v_can = any(v_scope)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_unlinked := p_sites is null and public.stock_level(v_uid, p_org) = 'all';
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  -- the start of each site's business month, once per site
  select jsonb_object_agg(x.loc, public.stock_co__day_start_at(date_trunc('month', public.stock_co__today(x.loc))::date, k.day_start, k.timezone))
    into v_starts
    from unnest(v_scope) x(loc)
   cross join lateral public.stock_co__clock_of(x.loc) k;
  v_ids := array(
    select m.id from stock_co_suppliers m
     where m.org_id = p_org
       and case when v_arch then m.archived_at is not null else m.archived_at is null end
       and (exists (select 1 from stock_co_supplier_sites s where s.supplier_id = m.id and s.location_id = any(v_scope))
            or m.local_location_id = any(v_scope)
            or (v_unlinked and not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = m.id)))
       and (v_q is null or strpos(lower(m.name), v_q) > 0 or strpos(lower(coalesce(m.email, '')), v_q) > 0
            or strpos(lower(coalesce(m.contact_name, '')), v_q) > 0)
       and (v_local is null or (m.local_location_id is not null) = v_local)
       and (v_can is null or exists (select 1 from stock_co_supplier_sites s where s.supplier_id = m.id and s.location_id = v_can and s.can_order))
       and (v_aid is null or (lower(m.name), m.id) > (v_k, v_aid))
     order by lower(m.name), m.id
     limit v_lim + 1);
  with ids as (select x.id, x.o from unnest(v_ids[1:v_lim]) with ordinality x(id, o))
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'name', m.name, 'local_location_id', m.local_location_id, 'archived_at', m.archived_at,
           'accepts_price_changes', m.accepts_price_changes, 'order_method', m.order_method,
           'internal_location_id', m.internal_location_id, 'email', m.email, 'phone', m.phone, 'contact_name', m.contact_name,
           'row_version', m.row_version,
           'sites', (select coalesce(jsonb_agg(jsonb_build_object('location_id', s.location_id, 'site_supplier_id', s.site_supplier_id,
                                                                  'can_order', s.can_order) order by array_position(v_scope, s.location_id)), '[]'::jsonb)
                       from stock_co_supplier_sites s where s.supplier_id = m.id and s.location_id = any(v_scope)),
           'can_order_count', (select count(*) from stock_co_supplier_sites s
                                where s.supplier_id = m.id and s.location_id = any(v_scope) and s.can_order),
           'items', (select count(*) from stock_co_supplier_items si where si.supplier_id = m.id and si.archived_at is null),
           'spend_month', (select coalesce(jsonb_agg(jsonb_build_object('currency', z.currency, 'amount', z.amount) order by z.currency), '[]'::jsonb)
                             from (select coalesce(l.currency, 'GBP') as currency, sum(coalesce(po.subtotal, 0)) as amount
                                     from stock_co_supplier_sites s
                                     join locations l on l.id = s.location_id
                                     join purchase_orders po on po.supplier_id = s.site_supplier_id and po.location_id = s.location_id
                                    where s.supplier_id = m.id and s.location_id = any(v_scope)
                                      and po.status in ('SENT', 'PARTIAL', 'RECEIVED')
                                      and po.ordered_at >= (v_starts ->> s.location_id::text)::timestamptz
                                    group by coalesce(l.currency, 'GBP')) z))
         order by ids.o), '[]'::jsonb)
    into v_rows
    from ids join stock_co_suppliers m on m.id = ids.id;
  if cardinality(v_ids) > v_lim then
    select lower(m.name) as k, m.id into v_last from stock_co_suppliers m where m.id = v_ids[v_lim];
    return jsonb_build_object('rows', v_rows, 'next', jsonb_build_object('k', v_last.k, 'id', v_last.id), 'sites', to_jsonb(v_scope));
  end if;
  return jsonb_build_object('rows', v_rows, 'next', null, 'sites', to_jsonb(v_scope));
end
$fn$;

-- One supplier: its company row and the sites in this login's reach it is linked at, each with its own
-- site values and order rules. A site with no link is listed by the screen as "Cannot order from this
-- supplier". p_supplier is the company id or a site row id.
create or replace function public.stock_supplier_detail(p_supplier uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_m stock_co_suppliers;
  v_reach text[];
  v_sites uuid[];
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_m from stock_co_suppliers x where x.id = v_id;
  v_reach := array(select public.stock_reach_locations());
  v_sites := array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id::text = any(v_reach))
             || case when v_m.local_location_id::text = any(v_reach) then array[v_m.local_location_id] else '{}'::uuid[] end;
  -- A company supplier no site can order from yet (or whose last site was unticked): head office
  -- (level all) still opens it, over the company's sites in reach, so a site can be ticked on again.
  if coalesce(cardinality(v_sites), 0) = 0 and v_m.local_location_id is null
     and public.stock_level(v_uid, v_m.org_id) = 'all' then
    v_sites := array(select l.id from locations l where l.org_id = v_m.org_id and l.id::text = any(v_reach) order by l.name, l.id);
  end if;
  if coalesce(cardinality(v_sites), 0) = 0 then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_m.org_id, null, 'read', array(select distinct x from unnest(v_sites) x));
  return jsonb_build_object(
    'supplier', to_jsonb(v_m),
    'row_version', v_m.row_version,
    'local', v_m.local_location_id is not null,
    'sites', (select coalesce(jsonb_agg(jsonb_build_object(
                'location_id', s.location_id, 'name', l.name, 'site_supplier_id', s.site_supplier_id, 'can_order', s.can_order,
                'link_row_version', s.row_version, 'account_number', t.account_number, 'email', t.email, 'cc_emails', to_jsonb(t.cc_emails),
                'min_order_value', t.min_order_value, 'delivery_fee', t.delivery_fee, 'approval_limit', t.approval_limit,
                'delivery_days', t.delivery_days, 'cutoff_time', t.cutoff_time, 'site_row_version', t.row_version,
                'rules', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'delivery_dow', r.delivery_dow, 'order_by_dow', r.order_by_dow,
                                                                       'order_by_time', to_char(r.order_by_time, 'HH24:MI'), 'row_version', r.row_version)
                                                    order by (r.delivery_dow + 6) % 7), '[]'::jsonb)
                            from stock_order_rules r where r.supplier_id = s.site_supplier_id))
                order by l.name, l.id), '[]'::jsonb)
                from stock_co_supplier_sites s
                join locations l on l.id = s.location_id
                join suppliers t on t.id = s.site_supplier_id
               where s.supplier_id = v_id and s.location_id::text = any(v_reach)));
end
$fn$;

-- One supplier's live packs (contract 1.7) with the company price, the next price, each site in reach
-- (on there, price here, the price there, paused, next price) and the spread of prices at the sites it is
-- on at. p_site given: that site's price (null when it is off there). Ordered by lower(item name), id.
create or replace function public.stock_prices_page(p_supplier uuid, p_site uuid default null, p_search text default null,
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
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_m stock_co_suppliers;
  v_reach text[];
  v_sites uuid[];
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_k text;
  v_aid uuid;
  v_rows jsonb;
  v_n integer;
  v_last jsonb;
begin
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_m from stock_co_suppliers x where x.id = v_id;
  v_reach := array(select public.stock_reach_locations());
  v_sites := array(select l.id from locations l where l.org_id = v_m.org_id and l.id::text = any(v_reach) order by l.name, l.id);
  if not exists (select 1 from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = any(v_sites))
     and not coalesce(v_m.local_location_id = any(v_sites), false)
     and not (v_m.local_location_id is null and coalesce(cardinality(v_sites), 0) > 0 and public.stock_level(v_uid, v_m.org_id) = 'all') then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_site is not null and not (p_site = any(v_sites)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_m.org_id, null, 'read', v_sites);
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'id') is not null then
    v_k := coalesce(p_after ->> 'k', '');
    v_aid := (p_after ->> 'id')::uuid;
  end if;
  with pg as (
    select si.*, i.name as item_name, lower(i.name) as k, i.org_id as iorg
      from stock_co_supplier_items si
      join stock_co_items i on i.id = si.item_id
     where si.supplier_id = v_id and si.archived_at is null
       and (v_q is null or strpos(lower(i.name), v_q) > 0 or strpos(lower(coalesce(si.sku, '')), v_q) > 0
            or strpos(lower(coalesce(si.supplier_product_name, '')), v_q) > 0)
       and (v_aid is null or (lower(i.name), si.id) > (v_k, v_aid))
     order by lower(i.name), si.id
     limit v_lim + 1
  ),
  st as (
    select pg.id as si_id, x.location_id, (x.site_supplier_product_id is not null and coalesce(s.on_here, false) and not x.off_here
                                           and t.archived_at is null) as on_here,
           x.price_here, t.pack_price as price, x.paused, x.row_version,
           (select jsonb_build_object('price', dp.price, 'from_day', dp.from_day, 'id', dp.id) from stock_co_dated_prices dp
             where dp.supplier_item_id = pg.id and dp.location_id = x.location_id and dp.status = 'waiting'
             order by dp.from_day, dp.id limit 1) as next_price
      from pg
      join stock_co_supplier_item_sites x on x.supplier_item_id = pg.id and x.location_id = any(v_sites)
      join supplier_products t on t.id = x.site_supplier_product_id
      left join stock_co_item_sites s on s.item_id = pg.item_id and s.location_id = x.location_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'supplier_item_id', pg.id, 'item_id', pg.item_id, 'item_name', pg.item_name, 'supplier_product_name', pg.supplier_product_name,
           'sku', pg.sku, 'pack_description', pg.pack_description, 'pack_qty', pg.pack_qty, 'inner_qty', pg.inner_qty,
           'inner_unit', pg.inner_unit, 'company_price', pg.pack_price, 'currency', pg.currency,
           'purchase_vat_rate', pg.purchase_vat_rate, 'price_includes_tax', pg.price_includes_tax, 'paused', pg.paused,
           'agreed_until', pg.agreed_until, 'allowed_diff_pct', pg.allowed_diff_pct, 'archived_at', pg.archived_at,
           'row_version', pg.row_version, 'unit_price', public.stock_co__unit_of_price(pg.id, null),
           'count_pack', (select jsonb_build_object('id', p.id, 'name', p.name, 'qty_in_base', p.qty_in_base)
                            from stock_co_packs p where p.item_id = pg.item_id and p.is_count_default and p.archived_at is null
                           order by p.id limit 1),
           'next_price', (select jsonb_build_object('price', dp.price, 'from_day', dp.from_day, 'id', dp.id) from stock_co_dated_prices dp
                           where dp.supplier_item_id = pg.id and dp.location_id is null and dp.status = 'waiting'
                           order by dp.from_day, dp.id limit 1),
           'sites', (select coalesce(jsonb_agg(jsonb_build_object('location_id', st.location_id, 'on', st.on_here, 'price_here', st.price_here,
                                                                  'price', st.price, 'paused', st.paused, 'row_version', st.row_version,
                                                                  'next_price', st.next_price)
                                               order by array_position(v_sites, st.location_id)), '[]'::jsonb)
                       from st where st.si_id = pg.id),
           'spread', (select case when count(*) > 0 then jsonb_build_object('low', min(st.price), 'high', max(st.price)) end
                        from st where st.si_id = pg.id and st.on_here),
           'sites_on', (select count(*) from st where st.si_id = pg.id and st.on_here),
           'site_price', case when p_site is null then null
                              else (select st.price from st where st.si_id = pg.id and st.location_id = p_site and st.on_here) end,
           'k', pg.k) order by pg.k, pg.id), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from pg;
  if v_n > v_lim then
    v_rows := (select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where o <= v_lim);
    v_last := v_rows -> (v_lim - 1);
    return jsonb_build_object('rows', (select jsonb_agg(e - 'k') from jsonb_array_elements(v_rows) e),
                              'next', jsonb_build_object('k', v_last ->> 'k', 'id', v_last ->> 'supplier_item_id'));
  end if;
  return jsonb_build_object('rows', (select coalesce(jsonb_agg(e - 'k'), '[]'::jsonb) from jsonb_array_elements(v_rows) e), 'next', null);
end
$fn$;

-- What needs attention at each site in scope (at most 50 sites a call): stock below zero, items on with
-- no live supplier pack, counts ready to approve, orders overdue, stock below its reorder point, failed
-- save jobs in the last 7 days, open go live steps, and the nightly set up health.
create or replace function public.stock_needs_attention(p_org uuid, p_sites uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
begin
  if p_sites is not null and cardinality(p_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if cardinality(v_scope) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  -- one pass per figure over every site in scope (set based, so 50 sites by 5,000 items stays well inside 8 s)
  return jsonb_build_object('rows', (
    with bz as (
      select t.location_id as loc, count(*) as n from inventory_items t
       where t.location_id = any(v_scope) and t.archived_at is null and t.on_hand < 0
       group by 1
    ), np as (
      select s.location_id as loc, count(*) as n
        from stock_co_item_sites s
        join inventory_items t on t.id = s.site_item_id
       where s.location_id = any(v_scope) and s.on_here and s.supply_mode = 'bought' and t.archived_at is null
         and not exists (select 1 from supplier_products sp
                          where sp.location_id = s.location_id and sp.inventory_item_id = t.id and sp.archived_at is null)
       group by 1
    ), cr as (
      select c.location_id as loc, count(*) as n from stock_counts c
       where c.location_id = any(v_scope) and c.status not in ('APPROVED', 'CANCELLED')
         and exists (select 1 from stock_count_areas a where a.count_id = c.id)
         and not exists (select 1 from stock_count_areas a where a.count_id = c.id and a.completed_at is null)
       group by 1
    ), od as (
      select po.location_id as loc, count(*) as n from purchase_orders po
       where po.location_id = any(v_scope) and po.status in ('SENT', 'PARTIAL') and po.expected_date < public.stock_co__today(po.location_id)
       group by 1
    ), br as (
      select pl.location_id as loc, count(*) as n from par_levels pl join inventory_items t on t.id = pl.inventory_item_id
       where pl.location_id = any(v_scope) and t.location_id = pl.location_id and t.archived_at is null
         and pl.reorder_point is not null and t.on_hand < pl.reorder_point
       group by 1
    ), qf as (
      select q.location_id as loc, count(*) as n from stock_save_queue q
       where q.location_id = any(v_scope) and q.status = 'failed' and q.done_at > now() - interval '7 days'
       group by 1
    ), go as (
      select g.location_id as loc, count(*) as n from stock_co_golive_steps g
       where g.location_id = any(v_scope) and g.done_at is null
       group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'location_id', l.id, 'name', l.name,
             'below_zero', coalesce(bz.n, 0), 'no_price', coalesce(np.n, 0), 'counts_ready', coalesce(cr.n, 0),
             'orders_overdue', coalesce(od.n, 0), 'below_reorder', coalesce(br.n, 0), 'queue_failed', coalesce(qf.n, 0),
             'golive_open', coalesce(go.n, 0),
             'health', (select jsonb_build_object('checked_at', h.checked_at, 'planned_writes', h.planned_writes,
                                                  'recipe_planned_writes', h.recipe_planned_writes, 'lines', h.lines)
                          from stock_co_site_health h where h.location_id = l.id))
             order by array_position(v_scope, l.id)), '[]'::jsonb)
      from locations l
      left join bz on bz.loc = l.id
      left join np on np.loc = l.id
      left join cr on cr.loc = l.id
      left join od on od.loc = l.id
      left join br on br.loc = l.id
      left join qf on qf.loc = l.id
      left join go on go.loc = l.id
     where l.id = any(v_scope)));
end
$fn$;

-- The items paused at one site today (the Order pad and manager-approve po.raise refuse them):
-- paused there, or paused everywhere. At most 1,000 rows; "more" says when there are others. For a
-- login, a till or a phone that reaches the site, or the service role.
create or replace function public.stock_paused_items(p_location uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day date;
  v_rows jsonb;
  v_n integer;
begin
  if p_location is null
     or not (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
             or public.stock_caller_reaches(p_location)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_day := public.stock_co__today(p_location);
  with p as (
    select s.site_item_id, s.item_id,
           (i.paused_from is not null and i.paused_from <= v_day and (i.paused_until is null or v_day <= i.paused_until)) as everywhere,
           case when i.paused_from is not null and i.paused_from <= v_day and (i.paused_until is null or v_day <= i.paused_until)
                then i.paused_until else s.paused_until end as until
      from stock_co_item_sites s
      join stock_co_items i on i.id = s.item_id
     where s.location_id = p_location
       and ((i.paused_from is not null and i.paused_from <= v_day and (i.paused_until is null or v_day <= i.paused_until))
            or (s.paused and (s.paused_from is null or s.paused_from <= v_day) and (s.paused_until is null or v_day <= s.paused_until)))
     order by s.site_item_id
     limit 1001
  )
  select coalesce(jsonb_agg(jsonb_build_object('site_item_id', p.site_item_id, 'item_id', p.item_id, 'everywhere', p.everywhere,
                                               'until', p.until) order by p.site_item_id), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from p;
  if v_n > 1000 then
    v_rows := (select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where o <= 1000);
  end if;
  return jsonb_build_object('rows', v_rows, 'more', v_n > 1000);
end
$fn$;

-- The go live plan of one site: its five steps (a step with no row yet has no day and is not done) and
-- the facts that tick the first two by themselves.
create or replace function public.stock_golive_plan(p_location uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, null, 'read', array[p_location]);
  return jsonb_build_object(
    'steps', (select jsonb_agg(jsonb_build_object('step', st.step, 'due_day', g.due_day, 'done_at', g.done_at,
                                                  'done_by_name', g.done_by_name, 'note', g.note, 'row_version', g.row_version)
                               order by st.ord)
                from (values ('copy_site', 1), ('opening_count', 2), ('train_the_trainer', 3), ('side_by_side', 4), ('switch_off', 5)) st(step, ord)
                left join stock_co_golive_steps g on g.location_id = p_location and g.step = st.step),
    'facts', jsonb_build_object(
      'items_on', (select count(*) from stock_co_item_sites s join stock_co_items i on i.id = s.item_id
                    where s.location_id = p_location and s.on_here and i.archived_at is null),
      'approved_counts', (select count(*) from stock_counts c where c.location_id = p_location and c.status = 'APPROVED'),
      'first_approved_count_at', (select min(coalesce(c.approved_at, c.updated_at)) from stock_counts c
                                   where c.location_id = p_location and c.status = 'APPROVED'),
      'orders_sent', (select count(*) from purchase_orders po where po.location_id = p_location and po.status in ('SENT', 'PARTIAL', 'RECEIVED'))));
end
$fn$;

-- An import file and up to 200 of its staged rows, keyset by row number. Only its creator or a company
-- editor of that company.
create or replace function public.stock_import_check(p_job uuid, p_after jsonb default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  v_j stock_co_import_jobs;
  v_after integer;
  v_rows jsonb;
  v_n integer;
begin
  select * into v_j from stock_co_import_jobs j where j.id = p_job;
  if v_j.id is null
     or not (v_j.created_by = v_uid or public.stock_level(v_uid, v_j.org_id) = 'all')
     or not exists (select 1 from locations l where l.org_id = v_j.org_id and l.id::text in (select public.stock_reach_locations())) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_j.org_id, null, 'read',
            array(select l.id from locations l where l.org_id = v_j.org_id and l.id::text in (select public.stock_reach_locations())));
  if p_after is not null and jsonb_typeof(p_after) = 'object' and (p_after ->> 'row_no') ~ '^[0-9]+$' then
    v_after := (p_after ->> 'row_no')::integer;
  end if;
  with pg as (
    select r.* from stock_co_import_rows r
     where r.job_id = p_job and (v_after is null or r.row_no > v_after)
     order by r.row_no
     limit v_lim + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('row_no', pg.row_no, 'kind', pg.kind, 'action', pg.action, 'problem', pg.problem,
                                               'data', pg.data, 'target_id', pg.target_id) order by pg.row_no), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from pg;
  if v_n > v_lim then
    v_rows := (select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where o <= v_lim);
  end if;
  return jsonb_build_object(
    'job', jsonb_build_object('id', v_j.id, 'org_id', v_j.org_id, 'source', v_j.source, 'file_name', v_j.file_name, 'status', v_j.status,
                              'sites', to_jsonb(v_j.sites), 'counts', v_j.counts, 'queue_id', v_j.queue_id),
    'rows', v_rows,
    'next', case when v_n > v_lim then jsonb_build_object('row_no', ((v_rows -> (v_lim - 1)) ->> 'row_no')::integer) end);
end
$fn$;

-- ============================================================================
-- STEP 8. THE BULK HELPERS AND THE SAVE QUEUE STEPS OF DROP 1 (internal, owner only)
-- ============================================================================

-- The change log source of a bulk step: 'import' and 'copy_site' runs say so; everything else is 'save'.
create or replace function public.stock_co__d1_source()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(nullif(current_setting('servos.stock_co_source', true), ''), 'save');
$fn$;

-- Ticks company items on or off at ONE site (contract 1.8). mode 'add': an existing link is on again
-- with stop ordering cleared (the writer brings back that site's supplier packs); a missing one gets its
-- site row at on hand 0 (supply mode: the one most used at the item's other sites, else bought) and
-- "Added by <name>". mode 'runout': stop ordering now (never ordered there again; the nightly step
-- archives it at zero while no live recipe there uses it). mode 'remove': only when that site holds
-- none and no live recipe there uses it (then off: the writer archives the site row); otherwise the
-- pair is listed in "refused" with words. A local item is never taken off its own site (archive it).
-- The writer then writes that site for the items it changed. Never moves on hand, cost or the ledger.
create or replace function public.stock_co__set_sites_at(p_items uuid[], p_loc uuid, p_mode text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_lname text;
  v_src text := public.stock_co__d1_source();
  v_by text := 'Added by ' || coalesce(nullif(btrim(coalesce(p_by, '')), ''), 'head office');
  v_added integer := 0;
  v_run integer := 0;
  v_removed integer := 0;
  v_refused jsonb := '[]'::jsonb;
  v_sync uuid[] := '{}'::uuid[];
  v_mode text;
  v_rec text;
  v_words text;
  r record;
begin
  select l.org_id, l.name into v_org, v_lname from locations l where l.id = p_loc;
  if v_org is null or p_mode is null or p_mode not in ('add', 'runout', 'remove') then
    raise exception 'stock_co__set_sites_at: unknown site or mode' using errcode = '22023';
  end if;
  for r in
    select i.id, i.local_location_id, i.archived_at, s.item_id as linked, s.on_here, s.stop_ordering_at, t.on_hand, t.base_unit,
           t.id as site_item_id
      from (select distinct x from unnest(coalesce(p_items, '{}'::uuid[])) x where x is not null) u(id)
      join stock_co_items i on i.id = u.id and i.org_id = v_org
      left join stock_co_item_sites s on s.item_id = i.id and s.location_id = p_loc
      left join inventory_items t on t.id = s.site_item_id
     order by i.id
  loop
    if p_mode = 'add' then
      if r.archived_at is not null then
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('item_id', r.id, 'location_id', p_loc,
                       'error', 'This item is archived. Bring it back first.'));
        continue;
      end if;
      if r.linked is null then
        select s2.supply_mode into v_mode
          from stock_co_item_sites s2
         where s2.item_id = r.id
         group by s2.supply_mode
         order by count(*) desc, s2.supply_mode
         limit 1;
        perform public.stock_co__new_site_item(r.id, p_loc, coalesce(v_mode, 'bought'), true);
        update stock_co_item_sites s set why_on = v_by
         where s.item_id = r.id and s.location_id = p_loc and s.why_on is null;
        perform public.stock_co__log(v_org, p_loc, 'item_site', r.id, 'on_here', to_jsonb(false), to_jsonb(true), v_src);
        v_added := v_added + 1;
        v_sync := v_sync || r.id;
      elsif not r.on_here or r.stop_ordering_at is not null then
        update stock_co_item_sites s
           set on_here = true, stop_ordering_at = null, why_on = coalesce(s.why_on, v_by),
               row_version = s.row_version + 1, updated_at = now()
         where s.item_id = r.id and s.location_id = p_loc;
        perform public.stock_co__log(v_org, p_loc, 'item_site', r.id, 'on_here',
                                     jsonb_build_object('on', r.on_here, 'stop_ordering_at', r.stop_ordering_at),
                                     jsonb_build_object('on', true, 'stop_ordering_at', null), v_src);
        v_added := v_added + 1;
        v_sync := v_sync || r.id;
      end if;
    else
      continue when r.linked is null or not r.on_here;
      if r.local_location_id = p_loc then
        v_refused := v_refused || jsonb_build_array(jsonb_build_object('item_id', r.id, 'location_id', p_loc,
                       'error', 'This is a local item. Archive it instead.'));
        continue;
      end if;
      if p_mode = 'runout' then
        continue when r.stop_ordering_at is not null;
        update stock_co_item_sites s
           set stop_ordering_at = now(), row_version = s.row_version + 1, updated_at = now()
         where s.item_id = r.id and s.location_id = p_loc;
        perform public.stock_co__log(v_org, p_loc, 'item_site', r.id, 'stop_ordering_at', null, to_jsonb(now()), v_src);
        v_run := v_run + 1;
        v_sync := v_sync || r.id;
      else
        select z.name into v_rec
          from (select rc.name from recipe_lines rl join recipes rc on rc.id = rl.recipe_id
                 where rl.location_id = p_loc and rl.component_item_id = r.site_item_id and rc.archived_at is null
                union
                select rc.name from recipes rc
                 where rc.location_id = p_loc and rc.output_item_id = r.site_item_id and rc.archived_at is null) z
         order by z.name
         limit 1;
        if coalesce(r.on_hand, 0) <> 0 or v_rec is not null then
          v_words := case
            when coalesce(r.on_hand, 0) <> 0 and v_rec is not null
              then format('%s holds %s %s and %s uses it.', v_lname, trim_scale(r.on_hand), r.base_unit, v_rec)
            when coalesce(r.on_hand, 0) <> 0
              then format('%s holds %s %s.', v_lname, trim_scale(r.on_hand), r.base_unit)
            else format('%s uses it at %s.', v_rec, v_lname) end
            || ' Choose Stop ordering, run out, or write it off first.';
          v_refused := v_refused || jsonb_build_array(jsonb_build_object('item_id', r.id, 'location_id', p_loc, 'error', v_words));
          continue;
        end if;
        update stock_co_item_sites s
           set on_here = false, row_version = s.row_version + 1, updated_at = now()
         where s.item_id = r.id and s.location_id = p_loc;
        perform public.stock_co__log(v_org, p_loc, 'item_site', r.id, 'on_here', to_jsonb(true), to_jsonb(false), v_src);
        v_removed := v_removed + 1;
        v_sync := v_sync || r.id;
      end if;
    end if;
  end loop;
  if cardinality(v_sync) > 0 then
    perform public.stock_co__sync_site(p_loc, v_sync, '{}'::uuid[], true, false);
  end if;
  return jsonb_build_object('added', v_added, 'run_out', v_run, 'removed', v_removed, 'refused', v_refused,
                            'written', cardinality(v_sync));
end
$fn$;

-- Pauses (or unpauses) company items at ONE site: the link's paused flag and its days. Pause never
-- touches counts, sales, the drainer or any number (map 4.3: not suggested and cannot be ordered, still
-- counted and still taken off by sales). Returns how many links changed. Owner only.
create or replace function public.stock_co__pause_at(p_items uuid[], p_loc uuid, p_paused boolean, p_from date, p_until date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n integer := 0;
  v_on boolean := coalesce(p_paused, true);
  v_from date := case when coalesce(p_paused, true) then p_from end;
  v_until date := case when coalesce(p_paused, true) then p_until end;
  r record;
begin
  for r in
    with old as (
      select s.item_id, s.org_id, s.paused, s.paused_from, s.paused_until
        from stock_co_item_sites s
       where s.location_id = p_loc and s.item_id = any(coalesce(p_items, '{}'::uuid[]))
         and (s.paused, s.paused_from, s.paused_until) is distinct from (v_on, v_from, v_until)
       order by s.item_id
         for update
    ), upd as (
      update stock_co_item_sites s
         set paused = v_on, paused_from = v_from, paused_until = v_until, row_version = s.row_version + 1, updated_at = now()
        from old
       where s.item_id = old.item_id and s.location_id = p_loc
      returning s.item_id
    )
    select old.* from old join upd on upd.item_id = old.item_id
  loop
    perform public.stock_co__log(r.org_id, p_loc, 'item_site', r.item_id, 'paused',
                                 jsonb_build_object('paused', r.paused, 'from', r.paused_from, 'until', r.paused_until),
                                 jsonb_build_object('paused', v_on, 'from', v_from, 'until', v_until), public.stock_co__d1_source());
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$fn$;

-- Whether a business day has begun at every one of some sites (null sites: every open site of the
-- company). A null day has always begun. Owner only.
create or replace function public.stock_co__day_begun(p_org uuid, p_sites uuid[], p_day date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_day is null
      or not exists (select 1
                       from locations l
                      where l.org_id = p_org
                        and (case when p_sites is null then coalesce(l.status, 'active') = 'active' else l.id = any(p_sites) end)
                        and p_day > public.stock_co__today(l.id));
$fn$;

-- The rows a Change prices spec touches (contract 1.8), in (supplier pack, site) order, after p_after
-- {"si", "loc"}, at most p_limit (null: all). p_spec carries org_id (put there by stock_change_prices),
-- exactly one of supplier_item_ids, item_ids, supplier_id, category_id, then sites (null: the company
-- price; a list: the price here at those sites), how and value. before is the price now (the site's
-- own price, or the price the site pays now when it follows); after is the new price, never rounded
-- below 0 here (the caller refuses a price below 0). Owner only.
create or replace function public.stock_co__price_plan(p_spec jsonb, p_after jsonb, p_limit integer)
returns table (supplier_item_id uuid, item_id uuid, location_id uuid, before numeric, after numeric, currency text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with sp as (
    select (p_spec ->> 'org_id')::uuid as org,
           p_spec ->> 'how' as how,
           (p_spec ->> 'value')::numeric as val,
           case when jsonb_typeof(p_spec -> 'sites') = 'array'
                then array(select e::uuid from jsonb_array_elements_text(p_spec -> 'sites') e) end as sites,
           case when jsonb_typeof(p_spec -> 'supplier_item_ids') = 'array'
                then array(select e::uuid from jsonb_array_elements_text(p_spec -> 'supplier_item_ids') e) end as si_ids,
           case when jsonb_typeof(p_spec -> 'item_ids') = 'array'
                then array(select e::uuid from jsonb_array_elements_text(p_spec -> 'item_ids') e) end as item_ids,
           (p_spec ->> 'supplier_id')::uuid as sup,
           (p_spec ->> 'category_id')::uuid as cat,
           (p_after ->> 'si')::uuid as a_si,
           coalesce((p_after ->> 'loc')::uuid, '00000000-0000-0000-0000-000000000000'::uuid) as a_loc
  ),
  si as (
    select x.id, x.item_id, x.pack_price, x.currency
      from sp
      join stock_co_supplier_items x on x.org_id = sp.org
      join stock_co_items i on i.id = x.item_id
     where x.archived_at is null and i.archived_at is null
       and (sp.si_ids is null or x.id = any(sp.si_ids))
       and (sp.item_ids is null or x.item_id = any(sp.item_ids))
       and (sp.sup is null or x.supplier_id = sp.sup)
       and (sp.cat is null or i.category_id = sp.cat)
  ),
  pr as (
    select si.id as si_id, si.item_id as it, null::uuid as loc, si.pack_price as b, si.currency as cur
      from sp, si
     where sp.sites is null
    union all
    select si.id, si.item_id, x.location_id, coalesce(x.price_here, t.pack_price), coalesce(l.currency, si.currency)
      from sp
      join si on true
      join stock_co_supplier_item_sites x on x.supplier_item_id = si.id
      join supplier_products t on t.id = x.site_supplier_product_id
      join locations l on l.id = x.location_id
     where sp.sites is not null and x.location_id = any(sp.sites)
  )
  select pr.si_id, pr.it, pr.loc, pr.b,
         case sp.how when 'percent' then round(pr.b * (1 + sp.val / 100), 4)
                     when 'amount' then round(pr.b + sp.val, 4)
                     else round(sp.val, 4) end,
         pr.cur
    from sp, pr
   where sp.a_si is null
      or (pr.si_id, coalesce(pr.loc, '00000000-0000-0000-0000-000000000000'::uuid)) > (sp.a_si, sp.a_loc)
   order by pr.si_id, pr.loc nulls first
   limit p_limit;
$fn$;

-- One waiting dated price (a new one for the same supplier pack, site or company, and day replaces the
-- old). Owner only.
create or replace function public.stock_co__dated_put(p_org uuid, p_si uuid, p_loc uuid, p_price numeric, p_day date, p_key uuid,
                                                      p_by uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if p_price is null or p_price < 0 then
    raise exception 'A price cannot be below 0.' using errcode = '22023';
  end if;
  update stock_co_dated_prices d set status = 'replaced'
   where d.supplier_item_id = p_si and d.status = 'waiting' and d.from_day = p_day and d.location_id is not distinct from p_loc;
  insert into stock_co_dated_prices (org_id, supplier_item_id, location_id, price, from_day, change_key, created_by, created_by_name)
  values (p_org, p_si, p_loc, round(p_price, 4), p_day, p_key, p_by,
          (select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from user_profiles p where p.id = p_by))
  returning id into v_id;
  perform public.stock_co__log(p_org, p_loc, 'supplier_item', p_si, 'next_price', null,
                               jsonb_build_object('price', round(p_price, 4), 'from_day', p_day), public.stock_co__d1_source());
  return v_id;
end
$fn$;

-- Applies a set of Change prices rows NOW (live): a company row sets the company price (every site that
-- follows it moves through the writer, after this), a site row sets the price here at that site. The
-- currency check runs per supplier pack. Returns the item ids per site written: {"<loc>": [item ids]}
-- for the site rows and {"company": [supplier pack ids]} for the company rows. Owner only.
create or replace function public.stock_co__price_apply(p_org uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record;
  v_out jsonb := '{}'::jsonb;
  v_old numeric;
  v_src text := public.stock_co__d1_source();
begin
  for r in
    select (e ->> 'supplier_item_id')::uuid as si, (e ->> 'item_id')::uuid as it, (e ->> 'location_id')::uuid as loc,
           (e ->> 'after')::numeric as price
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
     order by 1, 3 nulls first
  loop
    if r.price is null or r.price < 0 then
      raise exception 'A price cannot be below 0.' using errcode = '22023';
    end if;
    if r.loc is null then
      select si.pack_price into v_old from stock_co_supplier_items si where si.id = r.si and si.org_id = p_org for update;
      continue when not found or v_old = r.price;
      update stock_co_supplier_items si set pack_price = r.price, row_version = si.row_version + 1, updated_at = now()
       where si.id = r.si;
      perform public.stock_co__currency_check(r.si);
      perform public.stock_co__log(p_org, null, 'supplier_item', r.si, 'pack_price', to_jsonb(v_old), to_jsonb(r.price), v_src);
      v_out := jsonb_set(v_out, array['company'], coalesce(v_out -> 'company', '[]'::jsonb) || to_jsonb(r.si));
    else
      select x.price_here into v_old from stock_co_supplier_item_sites x
       where x.supplier_item_id = r.si and x.location_id = r.loc for update;
      continue when not found or v_old is not distinct from r.price;
      update stock_co_supplier_item_sites x set price_here = r.price, row_version = x.row_version + 1, updated_at = now()
       where x.supplier_item_id = r.si and x.location_id = r.loc;
      perform public.stock_co__currency_check(r.si);
      perform public.stock_co__log(p_org, r.loc, 'supplier_item_site', r.si, 'price_here', to_jsonb(v_old), to_jsonb(r.price), v_src);
      v_out := jsonb_set(v_out, array[r.loc::text], coalesce(v_out -> r.loc::text, '[]'::jsonb) || to_jsonb(r.it));
    end if;
  end loop;
  return v_out;
end
$fn$;

-- The sites that follow the company price of some supplier packs (on there, not off, no price here),
-- with the items to write at each: [{"location_id", "item_ids"}]. Owner only.
create or replace function public.stock_co__following(p_si uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('location_id', z.loc, 'item_ids', to_jsonb(z.items)) order by z.loc), '[]'::jsonb)
    from (select x.location_id as loc, array_agg(distinct si.item_id) as items
            from stock_co_supplier_item_sites x
            join stock_co_supplier_items si on si.id = x.supplier_item_id
            join stock_co_item_sites s on s.item_id = si.item_id and s.location_id = x.location_id
           where x.supplier_item_id = any(coalesce(p_si, '{}'::uuid[])) and x.price_here is null and not x.off_here and s.on_here
           group by x.location_id) z;
$fn$;

-- The dated prices whose day has begun (the runner calls this each minute, before the jobs). A site row
-- applies when its day has begun at that site (sets the price here); a company row applies when its day
-- has begun at EVERY site that follows the company price (the latest clock wins, so no site gets a new
-- company price before its own day); with no site following, when it has begun at every open site of the
-- company. Each applied row: status applied, a change log row (source dated_price), then one site_sync
-- job per site written. At most p_limit rows a call. Returns how many applied. Owner only.
create or replace function public.stock_co__apply_dated_prices(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_n integer := 0;
  v_locs uuid[] := '{}'::uuid[];
  v_its uuid[] := '{}'::uuid[];
  v_follow jsonb;
  v_old numeric;
  v_items uuid[];
  r record;
  f record;
  k uuid;
begin
  for r in
    select d.id, d.org_id, d.supplier_item_id, d.location_id, d.price, d.from_day, si.item_id
      from stock_co_dated_prices d
      join stock_co_supplier_items si on si.id = d.supplier_item_id
     where d.status = 'waiting' and d.from_day <= (now() at time zone 'UTC')::date + 1
     order by d.from_day, d.id
     limit v_lim * 5
       for update of d skip locked
  loop
    exit when v_n >= v_lim;
    if r.location_id is not null then
      continue when r.from_day > public.stock_co__today(r.location_id);
      select x.price_here into v_old from stock_co_supplier_item_sites x
       where x.supplier_item_id = r.supplier_item_id and x.location_id = r.location_id for update;
      if found and v_old is distinct from r.price then
        update stock_co_supplier_item_sites x set price_here = r.price, row_version = x.row_version + 1, updated_at = now()
         where x.supplier_item_id = r.supplier_item_id and x.location_id = r.location_id;
        perform public.stock_co__log(r.org_id, r.location_id, 'supplier_item', r.supplier_item_id, 'price_here', to_jsonb(v_old),
                                     to_jsonb(r.price), 'dated_price');
        v_locs := v_locs || r.location_id;
        v_its := v_its || r.item_id;
      end if;
    else
      v_follow := public.stock_co__following(array[r.supplier_item_id]);
      continue when exists (select 1 from jsonb_array_elements(v_follow) e
                             where r.from_day > public.stock_co__today((e ->> 'location_id')::uuid));
      continue when jsonb_array_length(v_follow) = 0 and not public.stock_co__day_begun(r.org_id, null, r.from_day);
      select si.pack_price into v_old from stock_co_supplier_items si where si.id = r.supplier_item_id for update;
      if v_old is distinct from r.price then
        update stock_co_supplier_items si set pack_price = r.price, row_version = si.row_version + 1, updated_at = now()
         where si.id = r.supplier_item_id;
        perform public.stock_co__log(r.org_id, null, 'supplier_item', r.supplier_item_id, 'pack_price', to_jsonb(v_old),
                                     to_jsonb(r.price), 'dated_price');
        for f in select (e ->> 'location_id')::uuid as loc from jsonb_array_elements(v_follow) e loop
          v_locs := v_locs || f.loc;
          v_its := v_its || r.item_id;
        end loop;
      end if;
    end if;
    update stock_co_dated_prices d set status = 'applied', applied_at = now() where d.id = r.id;
    v_n := v_n + 1;
  end loop;
  for k in select distinct z.l from unnest(v_locs) z(l) order by 1 loop
    v_items := array(select distinct z.i from unnest(v_locs, v_its) z(l, i) where z.l = k order by 1);
    perform public.stock_co__enqueue((select l.org_id from locations l where l.id = k), k, 'site_sync',
              jsonb_build_object('item_ids', to_jsonb(v_items), 'supplier_ids', '[]'::jsonb, 'recipe_ids', '[]'::jsonb,
                                 'change_log_id', null, 'reason', 'dated_price'),
              v_items);
  end loop;
  return v_n;
end
$fn$;

-- One staged import row checked (contract 1.8): what it will do (new, change, same, skip, problem), the
-- problem in plain words, and the record it matches. Item rows match a live company item by lower(name)
-- and base unit with exactly one match, else by company sku with exactly one, else new; supplier rows by
-- lower(name); supplier pack rows by (supplier, sku), else (supplier, item, pack size); par rows by item
-- and site name. A name only in an earlier row of the same file counts as there. Recipe rows are skipped.
-- Owner only.
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
    return jsonb_build_object('action', 'skip', 'problem', 'Recipes come in with the recipe update.');
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

-- The site writes of one import step, once per site: 'tick' (stock_co__set_sites_at add), 'suppliers' (the writer
-- for those suppliers; when their packs at that site are more than 300, a site_sync job writes them item by
-- item, at most about 300 site rows a step) or 'items' (the writer for those items). p_locs and p_ids are
-- pairs. Owner only.
create or replace function public.stock_co__import_flush(p_locs uuid[], p_ids uuid[], p_by text, p_kind text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  k uuid;
  v uuid[];
  v_n integer;
  v_items uuid[];
begin
  for k in select distinct z.l from unnest(coalesce(p_locs, '{}'::uuid[])) z(l) where z.l is not null order by 1 loop
    v := array(select distinct z.i from unnest(p_locs, p_ids) z(l, i) where z.l = k and z.i is not null order by 1);
    continue when cardinality(v) = 0;
    if p_kind = 'tick' then
      perform public.stock_co__set_sites_at(v, k, 'add', p_by);
    elsif p_kind = 'suppliers' then
      select count(*)::integer into v_n
        from stock_co_item_sites s
        join stock_co_supplier_items si on si.org_id = s.org_id and si.item_id = s.item_id
       where s.location_id = k and si.supplier_id = any(v);
      if v_n <= 300 then
        perform public.stock_co__sync_site(k, '{}'::uuid[], v, true, false);
      else
        v_items := array(select s.item_id from stock_co_item_sites s
                          where s.location_id = k
                            and exists (select 1 from stock_co_supplier_items si
                                         where si.org_id = s.org_id and si.item_id = s.item_id and si.supplier_id = any(v))
                          order by s.item_id);
        perform public.stock_co__enqueue((select l.org_id from locations l where l.id = k), k, 'site_sync',
                  jsonb_build_object('item_ids', to_jsonb(v_items), 'supplier_ids', to_jsonb(v), 'recipe_ids', '[]'::jsonb,
                                     'change_log_id', null, 'reason', 'import'), v_items);
      end if;
    else
      perform public.stock_co__sync_site(k, v, '{}'::uuid[], true, false);
    end if;
  end loop;
end
$fn$;

-- Commits import rows (the import_commit job), in row_no order after p_after, until about 300 site rows
-- are written: items (new: a company item ticked at the row's sites or the job's; change: its company
-- fields; both ticked where missing), suppliers (linked at the sites, their site values only where the
-- site has none), supplier packs (company price, or the price here at the named site), pars (by item and
-- site). Recipe and skipped rows are only marked done. Nothing writes on hand, cost or the ledger except
-- the writer's cost step. Each row: done, change log source import. Returns {"last_row", "rows",
-- "finished", "refused"}. Owner only.
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
      if r.done or r.action in ('skip', 'problem') or r.kind = 'recipe' then
        null;
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

-- One step of writing the supplier packs of the suppliers p_sups at p_loc, item by item (keyset on the
-- company item id after p_cursor), at most about p_limit site rows a step: the items set up at p_loc that have
-- a pack from one of p_sups go through the writer (their packs from every supplier set up there). So a
-- supplier with thousands of packs never holds the stock items of a site for long. Returns the last item
-- written, or null when none is left. Owner only.
create or replace function public.stock_co__supplier_packs_step(p_loc uuid, p_sups uuid[], p_cursor uuid, p_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 300), 1), 300);
  v_ids uuid[];
begin
  if p_loc is null or coalesce(cardinality(p_sups), 0) = 0 then
    return null;
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_ids
    from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
            from (select s.item_id as id,
                         1 + (select count(*) from stock_co_packs p where p.org_id = s.org_id and p.item_id = s.item_id)
                           + (select count(*) from stock_co_bridges b where b.org_id = s.org_id and b.item_id = s.item_id)
                           + (select count(*) from stock_co_supplier_items si where si.org_id = s.org_id and si.item_id = s.item_id) as wt
                    from stock_co_item_sites s
                   where s.location_id = p_loc
                     and (p_cursor is null or s.item_id > p_cursor)
                     and exists (select 1 from stock_co_supplier_items si
                                  where si.org_id = s.org_id and si.item_id = s.item_id and si.supplier_id = any(p_sups))
                   order by s.item_id
                   limit v_lim) w) c
   where c.cum <= v_lim or c.o = 1;
  if cardinality(v_ids) = 0 then
    return null;
  end if;
  perform public.stock_co__sync_site(p_loc, v_ids, '{}'::uuid[], true, false);
  return v_ids[cardinality(v_ids)];
end
$fn$;

-- One step of the supplier rows of p_sups at p_loc (keyset on the company supplier id after p_cursor): the
-- writer for the next suppliers, about p_limit of their packs looked at a step (the packs themselves were
-- written item by item first, so this writes the supplier rows and whatever is left). Returns the last
-- supplier done, or null when none is left. Owner only.
create or replace function public.stock_co__supplier_rows_step(p_loc uuid, p_sups uuid[], p_cursor uuid, p_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 300), 1), 300);
  v_ids uuid[];
begin
  if p_loc is null or coalesce(cardinality(p_sups), 0) = 0 then
    return null;
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_ids
    from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
            from (select m.id,
                         1 + (select count(*) from stock_co_supplier_items si where si.org_id = m.org_id and si.supplier_id = m.id) as wt
                    from stock_co_suppliers m
                   where m.id = any(p_sups) and (p_cursor is null or m.id > p_cursor)
                   order by m.id
                   limit 50) w) c
   where c.cum <= v_lim or c.o = 1;
  if cardinality(v_ids) = 0 then
    return null;
  end if;
  perform public.stock_co__sync_site(p_loc, '{}'::uuid[], v_ids, true, false);
  return v_ids[cardinality(v_ids)];
end
$fn$;

-- One step of Copy a site (the copy_site job): stage items (every live company item on at p_from, not
-- running out there, ticked at p_to at on hand 0), suppliers (every company supplier that can order at
-- p_from linked at p_to; its site row made from the company supplier, the account number and order email
-- left empty for the site to fill), pars (par, reorder and minimum, never over a value p_to already has),
-- areas (storage areas of p_from whose kind p_to lacks), rules (the order rules of those suppliers, with
-- their derived columns), then the copy_site go live step is stamped done. Recipes wait for Drop 2.
-- The packs of the linked suppliers are written item by item (stage supplier_packs), then the supplier rows
-- (stage supplier_rows), so one supplier with thousands of packs is never one long step.
-- At most about p_limit site rows a step. Returns {"payload", "finished", "done", "refused"}. Owner only.
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
  perform set_config('servos.stock_co_source', '', true);
  return jsonb_build_object('payload', p_payload || jsonb_build_object('stage', v_stage, 'after', v_after), 'finished', false,
                            'done', v_done, 'refused', v_refused);
end
$fn$;

-- One step of a category rename (the category_rename job): the free text category of at most p_limit of
-- its company items becomes the category's name; when none is left, one site_sync job per site carries
-- it to the site rows. Returns {"payload", "finished", "done"}. Owner only.
create or replace function public.stock_co__category_rename_step(p_cat uuid, p_payload jsonb, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_c stock_co_categories;
  v_lim integer := least(greatest(coalesce(p_limit, 300), 1), 300);
  v_n integer := 0;
  v_items uuid[];
  r record;
begin
  select * into v_c from stock_co_categories c where c.id = p_cat;
  if v_c.id is null then
    return jsonb_build_object('payload', p_payload, 'finished', true, 'done', 0);
  end if;
  for r in
    with pick as (
      select i.id, i.category from stock_co_items i
       where i.category_id = p_cat and i.category is distinct from v_c.name
       order by i.id
       limit v_lim
         for update
    ), upd as (
      update stock_co_items i set category = v_c.name, row_version = i.row_version + 1, updated_at = now()
        from pick where i.id = pick.id
      returning i.id
    )
    select pick.* from pick join upd on upd.id = pick.id
  loop
    perform public.stock_co__log(v_c.org_id, null, 'item', r.id, 'category', to_jsonb(r.category), to_jsonb(v_c.name), 'save');
    v_n := v_n + 1;
  end loop;
  if v_n < v_lim then
    for r in
      select s.location_id, array_agg(s.item_id order by s.item_id) as items
        from stock_co_item_sites s join stock_co_items i on i.id = s.item_id
       where i.category_id = p_cat
       group by s.location_id
       order by s.location_id
    loop
      perform public.stock_co__enqueue(v_c.org_id, r.location_id, 'site_sync',
                jsonb_build_object('item_ids', to_jsonb(r.items), 'supplier_ids', '[]'::jsonb, 'recipe_ids', '[]'::jsonb,
                                   'change_log_id', null, 'reason', 'category_rename'), r.items);
    end loop;
    return jsonb_build_object('payload', p_payload, 'finished', true, 'done', v_n);
  end if;
  return jsonb_build_object('payload', p_payload, 'finished', false, 'done', v_n);
end
$fn$;

-- One step of a Drop 1 save job (called by stock_co__run_job inside its busy and error rules): at most
-- about 300 site rows, then {"status": "done" | "waiting", "progress": {"done", "total", "refused"}}; a
-- job whose payload moves on (a stage, a cursor) has it written here. Owner only.
create or replace function public.stock_co__d1_step(p_job bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  j stock_save_queue;
  v_items uuid[];
  v_chunk uuid[];
  v_done integer;
  v_total integer;
  v_ref jsonb;
  v_res jsonb;
  v_fin boolean := false;
  v_pl jsonb;
  v_spec jsonb;
  v_rows jsonb;
  v_live boolean;
  v_last record;
  v_n integer;
  v_written jsonb;
  v_next uuid;
  k text;
  r record;
begin
  select * into j from stock_save_queue q where q.id = p_job;
  v_done := coalesce((j.progress ->> 'done')::integer, 0);
  v_total := (j.progress ->> 'total')::integer;
  v_ref := case when jsonb_typeof(j.progress -> 'refused') = 'array' then j.progress -> 'refused' else '[]'::jsonb end;
  v_pl := j.payload;
  if j.kind in ('set_sites', 'pause') then
    select coalesce(array_agg(x.id order by x.o), '{}'::uuid[]) into v_items
      from (select e.v::uuid as id, min(e.o) as o
              from jsonb_array_elements_text(case when jsonb_typeof(j.payload -> 'item_ids') = 'array' then j.payload -> 'item_ids'
                                                  else '[]'::jsonb end) with ordinality e(v, o)
             group by 1) x;
    v_total := cardinality(v_items);
    v_done := least(v_done, v_total);
    if j.kind = 'set_sites' then
      select coalesce(array_agg(c.id order by c.o), '{}'::uuid[]) into v_chunk
        from (select w.id, w.o, sum(w.wt) over (order by w.o) as cum
                from (select x.id, x.o,
                             1 + (select count(*) from stock_co_packs p where p.item_id = x.id)
                               + (select count(*) from stock_co_bridges b where b.item_id = x.id)
                               + (select count(*) from stock_co_supplier_items s where s.item_id = x.id) as wt
                        from unnest(v_items[v_done + 1 : v_done + 300]) with ordinality x(id, o)) w) c
       where c.cum <= 300 or c.o = 1;
      if cardinality(v_chunk) > 0 then
        if (j.payload ->> 'source') in ('import', 'copy_site') then
          perform set_config('servos.stock_co_source', j.payload ->> 'source', true);
        end if;
        v_res := public.stock_co__set_sites_at(v_chunk, j.location_id, coalesce(j.payload ->> 'mode', 'add'), j.payload ->> 'by_name');
        perform set_config('servos.stock_co_source', '', true);
        v_ref := v_ref || coalesce(v_res -> 'refused', '[]'::jsonb);
      end if;
    else
      v_chunk := v_items[v_done + 1 : v_done + 300];
      if cardinality(v_chunk) > 0 then
        perform public.stock_co__pause_at(v_chunk, j.location_id, coalesce((j.payload ->> 'paused')::boolean, true),
                                          nullif(j.payload ->> 'from', '')::date, nullif(j.payload ->> 'until', '')::date);
      end if;
    end if;
    v_done := v_done + coalesce(cardinality(v_chunk), 0);
    v_fin := v_done >= v_total;
  elsif j.kind = 'change_prices' then
    v_spec := j.payload -> 'spec';
    if v_total is null then
      select count(*)::integer into v_total from public.stock_co__price_plan(v_spec, null, null);
    end if;
    select coalesce(jsonb_agg(to_jsonb(p) order by p.supplier_item_id, p.location_id nulls first), '[]'::jsonb), count(*)
      into v_rows, v_n
      from public.stock_co__price_plan(v_spec, j.payload -> 'after', 300) p;
    if v_n > 0 then
      v_live := public.stock_co__day_begun(j.org_id,
                  case when jsonb_typeof(v_spec -> 'sites') = 'array'
                       then array(select e::uuid from jsonb_array_elements_text(v_spec -> 'sites') e) end,
                  nullif(v_spec ->> 'from_day', '')::date);
      if exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'after')::numeric < 0) then
        raise exception 'A price cannot be below 0.' using errcode = '22023';
      end if;
      if v_live then
        v_written := public.stock_co__price_apply(j.org_id, v_rows);
        -- a site job writes its own site now; a company job hands its sites to site_sync when it is done
        if j.location_id is not null and jsonb_typeof(v_written -> j.location_id::text) = 'array' then
          perform public.stock_co__sync_site(j.location_id,
                    array(select e::uuid from jsonb_array_elements_text(v_written -> j.location_id::text) e), '{}'::uuid[], true, false);
        end if;
      else
        perform public.stock_co__dated_put(j.org_id, (e ->> 'supplier_item_id')::uuid, nullif(e ->> 'location_id', '')::uuid,
                                           (e ->> 'after')::numeric, (v_spec ->> 'from_day')::date, (j.payload ->> 'change_key')::uuid,
                                           j.created_by)
           from jsonb_array_elements(v_rows) e;
      end if;
      select (e ->> 'supplier_item_id') as si, (e ->> 'location_id') as loc into v_last
        from jsonb_array_elements(v_rows) with ordinality x(e, o) order by x.o desc limit 1;
      v_pl := v_pl || jsonb_build_object('after', jsonb_build_object('si', v_last.si, 'loc', v_last.loc));
      v_done := v_done + v_n;
    end if;
    v_fin := v_n < 300;
    if v_fin and j.location_id is null
       and public.stock_co__day_begun(j.org_id, null, nullif(v_spec ->> 'from_day', '')::date) then
      for r in
        select (e ->> 'location_id')::uuid as loc, array(select z::uuid from jsonb_array_elements_text(e -> 'item_ids') z) as items
          from jsonb_array_elements(public.stock_co__following(j.entity_ids)) e
      loop
        perform public.stock_co__enqueue(j.org_id, r.loc, 'site_sync',
                  jsonb_build_object('item_ids', to_jsonb(r.items), 'supplier_ids', '[]'::jsonb, 'recipe_ids', '[]'::jsonb,
                                     'change_log_id', null, 'reason', 'change_prices'), r.items);
      end loop;
    end if;
  elsif j.kind = 'import_commit' then
    if v_total is null then
      select count(*)::integer into v_total from stock_co_import_rows x where x.job_id = (j.payload ->> 'job_id')::uuid;
      update stock_co_import_jobs ij set status = 'running', row_version = ij.row_version + 1, updated_at = now()
       where ij.id = (j.payload ->> 'job_id')::uuid and ij.status = 'queued';
    end if;
    v_res := public.stock_co__import_apply((j.payload ->> 'job_id')::uuid, coalesce((j.payload ->> 'after_row')::integer, 0));
    v_pl := v_pl || jsonb_build_object('after_row', (v_res ->> 'last_row')::integer);
    v_done := v_done + coalesce((v_res ->> 'rows')::integer, 0);
    v_ref := v_ref || coalesce(v_res -> 'refused', '[]'::jsonb);
    v_fin := coalesce((v_res ->> 'finished')::boolean, true);
    if v_fin then
      update stock_co_import_jobs ij
         set status = 'done', row_version = ij.row_version + 1, updated_at = now(),
             counts = ij.counts || jsonb_build_object('done', (select count(*) from stock_co_import_rows x where x.job_id = ij.id and x.done),
                                                     'refused', jsonb_array_length(v_ref))
       where ij.id = (j.payload ->> 'job_id')::uuid;
    end if;
  elsif j.kind = 'copy_site' then
    if v_total is null then
      v_total := (select count(*)::integer from stock_co_item_sites s join stock_co_items i on i.id = s.item_id
                   where s.location_id = (j.payload ->> 'from')::uuid and s.on_here and s.stop_ordering_at is null
                     and i.archived_at is null and i.local_location_id is null)
               + (select count(*)::integer from stock_co_supplier_sites ss join stock_co_suppliers m on m.id = ss.supplier_id
                   where ss.location_id = (j.payload ->> 'from')::uuid and ss.can_order and m.archived_at is null and m.local_location_id is null);
    end if;
    v_res := public.stock_co__copy_site_step((j.payload ->> 'from')::uuid, (j.payload ->> 'to')::uuid, j.payload, 300);
    v_pl := coalesce(v_res -> 'payload', v_pl);
    v_done := v_done + case when j.payload ->> 'stage' in ('items', 'suppliers') or j.payload ->> 'stage' is null
                            then coalesce((v_res ->> 'done')::integer, 0) else 0 end;
    v_ref := v_ref || coalesce(v_res -> 'refused', '[]'::jsonb);
    v_fin := coalesce((v_res ->> 'finished')::boolean, false);
  elsif j.kind = 'category_rename' then
    if v_total is null then
      select count(*)::integer into v_total from stock_co_items i where i.category_id = (j.payload ->> 'category_id')::uuid;
    end if;
    v_res := public.stock_co__category_rename_step((j.payload ->> 'category_id')::uuid, j.payload, 300);
    v_done := v_done + coalesce((v_res ->> 'done')::integer, 0);
    v_fin := coalesce((v_res ->> 'finished')::boolean, true);
  elsif j.kind = 'resync_site' then
    if v_total is null then
      v_total := (select count(*)::integer from stock_co_item_sites s where s.location_id = j.location_id)
               + (select count(*)::integer from stock_co_recipe_sites s where s.location_id = j.location_id);
    end if;
    if coalesce(j.payload ->> 'stage', 'items') = 'items' then
      select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_chunk
        from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
                from (select s.item_id as id,
                             1 + (select count(*) from stock_co_packs p where p.item_id = s.item_id)
                               + (select count(*) from stock_co_bridges b where b.item_id = s.item_id)
                               + (select count(*) from stock_co_supplier_items si where si.item_id = s.item_id) as wt
                        from stock_co_item_sites s
                       where s.location_id = j.location_id
                         and (nullif(j.payload ->> 'after', '') is null or s.item_id > (j.payload ->> 'after')::uuid)
                       order by s.item_id
                       limit 300) w) c
       where c.cum <= 300 or c.o = 1;
      if cardinality(v_chunk) > 0 then
        perform public.stock_co__sync_site(j.location_id, v_chunk, '{}'::uuid[], true, false);
        v_pl := v_pl || jsonb_build_object('after', v_chunk[cardinality(v_chunk)]);
        v_done := v_done + cardinality(v_chunk);
      else
        v_pl := v_pl || jsonb_build_object('stage', 'suppliers', 'after', null);
      end if;
    elsif j.payload ->> 'stage' = 'suppliers' then
      -- the supplier rows, a few suppliers a step (their packs were written with the items above)
      v_next := public.stock_co__supplier_rows_step(j.location_id,
                  array(select ss.supplier_id from stock_co_supplier_sites ss where ss.location_id = j.location_id order by ss.supplier_id),
                  nullif(j.payload ->> 'after', '')::uuid, 300);
      if v_next is null then
        v_pl := v_pl || jsonb_build_object('stage', 'recipes', 'after', null);
      else
        v_pl := v_pl || jsonb_build_object('after', v_next);
      end if;
    else
      select coalesce(array_agg(c.id order by c.id), '{}'::uuid[]) into v_chunk
        from (select w.id, sum(w.wt) over (order by w.id) as cum, row_number() over (order by w.id) as o
                from (select s.recipe_id as id, 2 + (select count(*) from stock_co_recipe_lines l where l.recipe_id = s.recipe_id) as wt
                        from stock_co_recipe_sites s
                       where s.location_id = j.location_id
                         and (nullif(j.payload ->> 'after', '') is null or s.recipe_id > (j.payload ->> 'after')::uuid)
                       order by s.recipe_id
                       limit 300) w) c
       where c.cum <= 300 or c.o = 1;
      if cardinality(v_chunk) > 0 then
        perform public.stock_co__sync_recipes(j.location_id, v_chunk, true, false);
        v_pl := v_pl || jsonb_build_object('after', v_chunk[cardinality(v_chunk)]);
        v_done := v_done + cardinality(v_chunk);
      else
        v_fin := true;
      end if;
    end if;
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
-- STEP 9. THE SAVES OF THE COMPANY LIST (contract 1.6 and 1.8)
-- ============================================================================

-- The company items of a list of ids (company ids or site row ids), all of ONE company. Owner only.
create or replace function public.stock_co__items_of(p_items uuid[])
returns table (org_id uuid, ids uuid[])
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ids uuid[];
  v_n integer;
  v_org uuid;
begin
  if p_items is null or cardinality(p_items) = 0 then
    raise exception 'Tick at least one item.' using errcode = '22023';
  end if;
  if cardinality(p_items) > 5000 then
    raise exception 'Pick 5,000 items or fewer.' using errcode = '22023';
  end if;
  v_ids := array(select distinct public.stock_co__company_id('item', x) from unnest(p_items) x where x is not null);
  if cardinality(v_ids) = 0 or array_position(v_ids, null) is not null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select count(distinct i.org_id), min(i.org_id::text)::uuid into v_n, v_org from stock_co_items i where i.id = any(v_ids);
  if v_n <> 1 then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  return query select v_org, array(select x from unnest(v_ids) x order by x);
end
$fn$;

-- A site of the company this login reaches (for a company save that names no site). Owner only.
create or replace function public.stock_co__org_site(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.stock_co__reached_site(array(select l.id from locations l where l.org_id = p_org order by l.id));
$fn$;

-- Tick items on and off at sites (contract 1.8): p_add the sites to add them at; p_remove
-- [{"location_id", "mode": "runout" | "remove"}]. Needs site_price at every named site; a local item
-- added at another site becomes a company item and needs company. Over 200 rows (items x sites) or 5
-- sites, every site goes to the save queue; under that each site is written now (200 ms lock wait, 1.5 s
-- in all), the rest queued. Sections: inventory.
create or replace function public.stock_set_item_sites(p_items uuid[], p_add uuid[], p_remove jsonb, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_org uuid;
  v_ids uuid[];
  v_add uuid[] := array(select distinct x from unnest(coalesce(p_add, '{}'::uuid[])) x where x is not null order by 1);
  v_rm_loc uuid[] := '{}'::uuid[];
  v_rm_mode text[] := '{}'::text[];
  v_named uuid[];
  v_need text := 'site_price';
  v_g jsonb;
  v_by text;
  v_log bigint;
  v_big boolean;
  v_prev text := current_setting('lock_timeout');
  v_res jsonb;
  v_reason text;
  v_job bigint;
  v_added integer := 0;
  v_run integer := 0;
  v_removed integer := 0;
  v_refused jsonb := '[]'::jsonb;
  v_queued jsonb := '[]'::jsonb;
  v_loc uuid;
  e jsonb;
  r record;
begin
  perform public.stock_co__signed_in();
  select x.org_id, x.ids into v_org, v_ids from public.stock_co__items_of(p_items) x;
  if p_remove is not null and jsonb_typeof(p_remove) <> 'null' then
    if jsonb_typeof(p_remove) <> 'array' then
      raise exception 'The field "remove" must be a list.' using errcode = '22023';
    end if;
    for e in select x.value from jsonb_array_elements(p_remove) x loop
      if jsonb_typeof(e) <> 'object'
         or coalesce(e ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      if coalesce(e ->> 'mode', '') not in ('runout', 'remove') then
        raise exception 'The field "mode" must be one of: runout, remove.' using errcode = '22023';
      end if;
      v_loc := lower(e ->> 'location_id')::uuid;
      if v_loc = any(v_rm_loc) or v_loc = any(v_add) then
        raise exception 'A site cannot be ticked and unticked at once.' using errcode = '22023';
      end if;
      v_rm_loc := v_rm_loc || v_loc;
      v_rm_mode := v_rm_mode || (e ->> 'mode');
    end loop;
  end if;
  v_named := array(select distinct x from unnest(v_add || v_rm_loc) x order by 1);
  if cardinality(v_named) = 0 then
    raise exception 'Pick at least one site.' using errcode = '22023';
  end if;
  if exists (select 1 from stock_co_items i
              where i.id = any(v_ids) and i.local_location_id is not null
                and exists (select 1 from unnest(v_add) a where a <> i.local_location_id)) then
    v_need := 'company';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, v_need, v_named);
  v_by := v_g ->> 'name';
  -- a local item ticked at another site becomes a company item
  for r in
    with old as (
      select i.id, i.local_location_id from stock_co_items i
       where i.id = any(v_ids) and i.local_location_id is not null
         and exists (select 1 from unnest(v_add) a where a <> i.local_location_id)
       order by i.id
         for update
    ), upd as (
      update stock_co_items i
         set local_location_id = null, row_version = i.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
        from old where i.id = old.id
      returning i.id
    )
    select old.* from old join upd on upd.id = old.id
  loop
    perform public.stock_co__log(v_org, null, 'item', r.id, 'local_location_id', to_jsonb(r.local_location_id), null, 'save');
  end loop;
  v_log := public.stock_co__log(v_org, null, 'bulk', v_org, 'set_sites', null,
             jsonb_build_object('items', cardinality(v_ids), 'add', to_jsonb(v_add), 'remove', coalesce(p_remove, '[]'::jsonb)), 'save');
  v_big := cardinality(v_ids) * cardinality(v_named) > 200 or cardinality(v_named) > 5;
  for r in
    select z.loc, z.mode
      from (select a as loc, 'add'::text as mode from unnest(v_add) a
            union all
            select x.l, x.m from unnest(v_rm_loc, v_rm_mode) x(l, m)) z
     order by z.loc
  loop
    v_reason := null;
    if v_big then
      v_reason := 'big';
    elsif clock_timestamp() - v_t0 > interval '1500 milliseconds' then
      v_reason := 'budget';
    else
      begin
        perform set_config('lock_timeout', '200ms', true);
        v_res := public.stock_co__set_sites_at(v_ids, r.loc, r.mode, v_by);
        perform set_config('lock_timeout', v_prev, true);
        v_added := v_added + coalesce((v_res ->> 'added')::integer, 0);
        v_run := v_run + coalesce((v_res ->> 'run_out')::integer, 0);
        v_removed := v_removed + coalesce((v_res ->> 'removed')::integer, 0);
        v_refused := v_refused || coalesce(v_res -> 'refused', '[]'::jsonb);
      exception when lock_not_available or deadlock_detected then
        v_reason := 'lock';
      end;
    end if;
    if v_reason is not null then
      v_job := public.stock_co__enqueue_job(v_org, r.loc, 'set_sites',
                 jsonb_build_object('item_ids', to_jsonb(v_ids), 'mode', r.mode, 'by_name', v_by, 'change_log_id', v_log, 'reason', v_reason),
                 v_ids);
      v_queued := v_queued || jsonb_build_array(jsonb_build_object('location_id', r.loc, 'job_id', v_job));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'added', v_added, 'run_out', v_run, 'removed', v_removed, 'refused', v_refused,
                            'queued', v_queued);
end
$fn$;

-- Pause items (contract 1.6): p_sites null is everywhere (the company item's paused days: need company);
-- a list pauses the items at those sites (the link's flag and days: need site_price). p_from null is from
-- now; p_until null is until unpaused; p_paused false clears. Pause never touches counts, sales or any
-- number. Sections: inventory, purchasing.
create or replace function public.stock_pause_items(p_items uuid[], p_sites uuid[], p_from date, p_until date, p_paused boolean default true,
                                                    p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_on boolean := coalesce(p_paused, true);
  v_org uuid;
  v_ids uuid[];
  v_named uuid[];
  v_g jsonb;
  v_from date;
  v_until date;
  v_n integer := 0;
  v_big boolean;
  v_prev text := current_setting('lock_timeout');
  v_reason text;
  v_job bigint;
  v_queued jsonb := '[]'::jsonb;
  r record;
begin
  perform public.stock_co__signed_in();
  select x.org_id, x.ids into v_org, v_ids from public.stock_co__items_of(p_items) x;
  if v_on and p_from is not null and p_until is not null and p_until < p_from then
    raise exception 'The pause must end on or after the day it starts.' using errcode = '22023';
  end if;
  if p_sites is null then
    v_named := array(select distinct z.loc from (
                 select s.location_id as loc from stock_co_item_sites s where s.item_id = any(v_ids)
                 union
                 select i.local_location_id from stock_co_items i where i.id = any(v_ids) and i.local_location_id is not null) z
               where z.loc is not null order by 1);
    if cardinality(v_named) = 0 then
      v_named := array[public.stock_co__org_site(v_org)];
    end if;
    v_g := public.stock_co__guard(v_org, v_section, 'company', v_named);
    v_from := case when v_on then coalesce(p_from, (select min(public.stock_co__today(l.id)) from locations l
                                                      where l.org_id = v_org and coalesce(l.status, 'active') = 'active')) end;
    v_until := case when v_on then p_until end;
    for r in
      with old as (
        select i.id, i.paused_from, i.paused_until from stock_co_items i
         where i.id = any(v_ids) and (i.paused_from, i.paused_until) is distinct from (v_from, v_until)
         order by i.id
           for update
      ), upd as (
        update stock_co_items i
           set paused_from = v_from, paused_until = v_until, row_version = i.row_version + 1, updated_at = now(),
               updated_by = (v_g ->> 'uid')::uuid
          from old where i.id = old.id
        returning i.id
      )
      select old.* from old join upd on upd.id = old.id
    loop
      perform public.stock_co__log(v_org, null, 'item', r.id, 'paused', jsonb_build_object('from', r.paused_from, 'until', r.paused_until),
                                   jsonb_build_object('from', v_from, 'until', v_until), 'save');
      v_n := v_n + 1;
    end loop;
    return jsonb_build_object('ok', true, 'items', cardinality(v_ids), 'sites', cardinality(v_named), 'changed', v_n,
                              'queued', '[]'::jsonb);
  end if;
  v_named := array(select distinct x from unnest(p_sites) x where x is not null order by 1);
  if cardinality(v_named) = 0 then
    raise exception 'Pick at least one site.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'site_price', v_named);
  v_big := cardinality(v_ids) * cardinality(v_named) > 200 or cardinality(v_named) > 5;
  for r in select x as loc from unnest(v_named) x order by 1 loop
    v_reason := null;
    if v_big then
      v_reason := 'big';
    elsif clock_timestamp() - v_t0 > interval '1500 milliseconds' then
      v_reason := 'budget';
    else
      begin
        perform set_config('lock_timeout', '200ms', true);
        v_n := v_n + public.stock_co__pause_at(v_ids, r.loc, v_on, p_from, p_until);
        perform set_config('lock_timeout', v_prev, true);
      exception when lock_not_available or deadlock_detected then
        v_reason := 'lock';
      end;
    end if;
    if v_reason is not null then
      v_job := public.stock_co__enqueue_job(v_org, r.loc, 'pause',
                 jsonb_build_object('item_ids', to_jsonb(v_ids), 'paused', v_on, 'from', p_from, 'until', p_until, 'reason', v_reason), v_ids);
      v_queued := v_queued || jsonb_build_array(jsonb_build_object('location_id', r.loc, 'job_id', v_job));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'items', cardinality(v_ids), 'sites', cardinality(v_named), 'changed', v_n, 'queued', v_queued);
end
$fn$;

-- Change prices (contract 1.8). p_spec: exactly one of supplier_item_ids, item_ids, supplier_id,
-- category_id; sites (null: the company price, so every site following it moves; a list: the price here
-- at those sites); how percent | amount | set; value; from_day (null, or a day not after every affected
-- site's business day today, is now). Preview: the first 200 rows with the price per pack and per base
-- unit before and after and how many recipes use the item, the total and the words. Apply: live changes
-- through the writer (queued when big), dated changes as waiting dated prices (queued over 2,000 rows).
-- Need company for the company price, site_price at every listed site. Sections: inventory, purchasing.
create or replace function public.stock_change_prices(p_spec jsonb, p_preview boolean default true, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_k text;
  v_sel text;
  v_n integer;
  v_list uuid[];
  v_org uuid;
  v_sites uuid[];
  v_how text;
  v_val numeric;
  v_s text;
  v_day date;
  v_spec jsonb;
  v_si uuid[];
  v_follow jsonb := '[]'::jsonb;
  v_named uuid[];
  v_g jsonb;
  v_total integer;
  v_neg integer;
  v_live boolean;
  v_nsites integer;
  v_rows jsonb;
  v_key uuid := gen_random_uuid();
  v_log bigint;
  v_written jsonb;
  v_run jsonb;
  v_changed integer := 0;
  v_dated integer := 0;
  v_queued jsonb := '[]'::jsonb;
  v_big boolean;
  v_prev text := current_setting('lock_timeout');
  v_reason text;
  v_job bigint;
  r record;
begin
  perform public.stock_co__signed_in();
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    raise exception 'Say which prices to change.' using errcode = '22023';
  end if;
  for v_k in select x from jsonb_object_keys(p_spec) x loop
    if v_k not in ('supplier_item_ids', 'item_ids', 'supplier_id', 'category_id', 'sites', 'how', 'value', 'from_day') then
      raise exception 'The field "%" cannot be changed here.', v_k using errcode = '22023';
    end if;
  end loop;
  select count(*), min(x) into v_n, v_sel
    from unnest(array['supplier_item_ids', 'item_ids', 'supplier_id', 'category_id']) x
   where p_spec ? x and jsonb_typeof(p_spec -> x) <> 'null';
  if v_n <> 1 then
    raise exception 'Pick one of: supplier packs, items, a supplier or a category.' using errcode = '22023';
  end if;
  if v_sel in ('supplier_item_ids', 'item_ids') then
    if jsonb_typeof(p_spec -> v_sel) <> 'array' or jsonb_array_length(p_spec -> v_sel) = 0
       or exists (select 1 from jsonb_array_elements(p_spec -> v_sel) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
      raise exception 'The field "%" must be a list of ids.', v_sel using errcode = '22023';
    end if;
    if jsonb_array_length(p_spec -> v_sel) > 5000 then
      raise exception 'Pick 5,000 items or fewer.' using errcode = '22023';
    end if;
    v_list := array(select distinct public.stock_co__company_id(case v_sel when 'item_ids' then 'item' else 'supplier_item' end, lower(e)::uuid)
                      from jsonb_array_elements_text(p_spec -> v_sel) e);
    if array_position(v_list, null) is not null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if v_sel = 'item_ids' then
      select count(distinct i.org_id), min(i.org_id::text)::uuid into v_n, v_org from stock_co_items i where i.id = any(v_list);
    else
      select count(distinct si.org_id), min(si.org_id::text)::uuid into v_n, v_org from stock_co_supplier_items si where si.id = any(v_list);
    end if;
  else
    if coalesce(p_spec ->> v_sel, '') !~* v_uuid then
      raise exception 'The field "%" is not a valid id.', v_sel using errcode = '22023';
    end if;
    if v_sel = 'supplier_id' then
      v_list := array[public.stock_co__company_id('supplier', lower(p_spec ->> v_sel)::uuid)];
      select count(*), min(m.org_id::text)::uuid into v_n, v_org from stock_co_suppliers m where m.id = v_list[1];
    else
      v_list := array[lower(p_spec ->> v_sel)::uuid];
      select count(*), min(c.org_id::text)::uuid into v_n, v_org from stock_co_categories c where c.id = v_list[1];
    end if;
  end if;
  if v_n <> 1 or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_how := p_spec ->> 'how';
  if v_how is null or v_how not in ('percent', 'amount', 'set') then
    raise exception 'The field "how" must be one of: percent, amount, set.' using errcode = '22023';
  end if;
  begin
    v_val := (p_spec ->> 'value')::numeric;
  exception when others then
    v_val := null;
  end;
  if v_val is null or jsonb_typeof(p_spec -> 'value') not in ('number', 'string') then
    raise exception 'The field "value" must be a number.' using errcode = '22023';
  end if;
  if v_how = 'set' and v_val < 0 then
    raise exception 'A price cannot be below 0.' using errcode = '22023';
  end if;
  v_s := nullif(btrim(coalesce(p_spec ->> 'from_day', '')), '');
  if v_s is not null then
    begin
      v_day := case when v_s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then v_s::date end;
    exception when others then
      v_day := null;
    end;
    if v_day is null or to_char(v_day, 'YYYY-MM-DD') <> v_s then
      raise exception 'The field "from_day" must be a date such as 2026-11-03.' using errcode = '22023';
    end if;
  end if;
  if p_spec ? 'sites' and jsonb_typeof(p_spec -> 'sites') <> 'null' then
    if jsonb_typeof(p_spec -> 'sites') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_spec -> 'sites') e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
      raise exception 'The field "sites" must be a list of sites.' using errcode = '22023';
    end if;
    v_sites := array(select distinct lower(e)::uuid from jsonb_array_elements_text(p_spec -> 'sites') e order by 1);
    if cardinality(v_sites) = 0 then
      raise exception 'Pick at least one site.' using errcode = '22023';
    end if;
  end if;
  v_spec := jsonb_build_object('org_id', v_org, v_sel, case when v_sel in ('supplier_item_ids', 'item_ids') then to_jsonb(v_list) else to_jsonb(v_list[1]) end,
                               'sites', to_jsonb(v_sites), 'how', v_how, 'value', v_val, 'from_day', v_day);
  -- the supplier packs it touches, and the sites that follow their company price
  v_si := array(select distinct p.supplier_item_id from public.stock_co__price_plan(v_spec || jsonb_build_object('sites', null), null, null) p order by 1);
  if v_sites is null then
    v_follow := public.stock_co__following(v_si);
    v_named := array(select (e ->> 'location_id')::uuid from jsonb_array_elements(v_follow) e order by 1);
    if cardinality(v_named) = 0 then
      v_named := array[public.stock_co__org_site(v_org)];
    end if;
  else
    v_named := v_sites;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, case when v_sites is null then 'company' else 'site_price' end, v_named);
  select count(*)::integer, count(*) filter (where p.after < 0)::integer into v_total, v_neg
    from public.stock_co__price_plan(v_spec, null, null) p;
  if v_neg > 0 then
    raise exception 'A price cannot be below 0.' using errcode = '22023';
  end if;
  v_live := public.stock_co__day_begun(v_org,
              case when v_sites is not null then v_sites when jsonb_array_length(v_follow) > 0 then v_named end, v_day);
  v_nsites := case when v_sites is not null then cardinality(v_sites) else jsonb_array_length(v_follow) end;
  if coalesce(p_preview, true) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'supplier_item_id', p.supplier_item_id, 'item_id', p.item_id, 'item_name', i.name, 'supplier_name', m.name,
             'location_id', p.location_id, 'before', p.before, 'after', p.after, 'currency', p.currency,
             'unit_before', public.stock_co__unit_of_price(p.supplier_item_id, p.before),
             'unit_after', public.stock_co__unit_of_price(p.supplier_item_id, p.after),
             'used_in', (select count(distinct l.recipe_id) from stock_co_recipe_lines l join stock_co_recipes rc on rc.id = l.recipe_id
                          where l.component_item_id = p.item_id and rc.archived_at is null))
             order by p.o), '[]'::jsonb)
      into v_rows
      from public.stock_co__price_plan(v_spec, null, 200) with ordinality p(supplier_item_id, item_id, location_id, before, after, currency, o)
      join stock_co_items i on i.id = p.item_id
      join stock_co_supplier_items si on si.id = p.supplier_item_id
      join stock_co_suppliers m on m.id = si.supplier_id;
    return jsonb_build_object('ok', true, 'preview', true, 'rows', v_rows, 'total', v_total, 'sites', v_nsites,
                              'from_day', case when v_live then null else v_day end,
                              'words', format('%s %s from %s at %s %s', v_total, case when v_total = 1 then 'price changes' else 'prices change' end,
                                              case when v_live then 'today' else to_char(v_day, 'FMDy FMDD Mon') end,
                                              v_nsites, case when v_nsites = 1 then 'site' else 'sites' end));
  end if;
  v_log := public.stock_co__log(v_org, null, 'bulk', v_org, 'change_prices', null, v_spec - 'org_id', 'save');
  if not v_live then
    if v_total <= 2000 then
      perform public.stock_co__dated_put(v_org, p.supplier_item_id, p.location_id, p.after, v_day, v_key, (v_g ->> 'uid')::uuid)
         from public.stock_co__price_plan(v_spec, null, null) p;
      v_dated := v_total;
    elsif v_sites is null then
      v_job := public.stock_co__enqueue_job(v_org, null, 'change_prices',
                 jsonb_build_object('change_key', v_key, 'spec', v_spec, 'after', null, 'change_log_id', v_log), v_si);
      v_queued := jsonb_build_array(jsonb_build_object('location_id', null, 'job_id', v_job));
    else
      for r in select x as loc from unnest(v_sites) x order by 1 loop
        v_job := public.stock_co__enqueue_job(v_org, r.loc, 'change_prices',
                   jsonb_build_object('change_key', v_key, 'spec', v_spec || jsonb_build_object('sites', jsonb_build_array(r.loc)),
                                      'after', null, 'change_log_id', v_log), v_si);
        v_queued := v_queued || jsonb_build_array(jsonb_build_object('location_id', r.loc, 'job_id', v_job));
      end loop;
    end if;
  elsif v_sites is null then
    if v_total <= 200 and jsonb_array_length(v_follow) <= 5 then
      select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_rows from public.stock_co__price_plan(v_spec, null, null) p;
      v_written := public.stock_co__price_apply(v_org, v_rows);
      v_changed := jsonb_array_length(coalesce(v_written -> 'company', '[]'::jsonb));
      v_run := public.stock_co__run_sites(v_org, null, v_named,
                 array(select distinct si.item_id from stock_co_supplier_items si where si.id = any(v_si)),
                 '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
      v_queued := coalesce(v_run -> 'queued', '[]'::jsonb);
    else
      v_job := public.stock_co__enqueue_job(v_org, null, 'change_prices',
                 jsonb_build_object('change_key', v_key, 'spec', v_spec, 'after', null, 'change_log_id', v_log), v_si);
      v_queued := jsonb_build_array(jsonb_build_object('location_id', null, 'job_id', v_job));
    end if;
  else
    v_big := v_total > 200 or cardinality(v_sites) > 5;
    for r in select x as loc from unnest(v_sites) x order by 1 loop
      v_reason := null;
      if v_big then
        v_reason := 'big';
      elsif clock_timestamp() - v_t0 > interval '1500 milliseconds' then
        v_reason := 'budget';
      else
        begin
          perform set_config('lock_timeout', '200ms', true);
          select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_rows
            from public.stock_co__price_plan(v_spec || jsonb_build_object('sites', jsonb_build_array(r.loc)), null, null) p;
          v_written := public.stock_co__price_apply(v_org, v_rows);
          if jsonb_typeof(v_written -> r.loc::text) = 'array' then
            perform public.stock_co__sync_site(r.loc, array(select e::uuid from jsonb_array_elements_text(v_written -> r.loc::text) e),
                                               '{}'::uuid[], true, false);
            v_changed := v_changed + jsonb_array_length(v_written -> r.loc::text);
          end if;
          perform set_config('lock_timeout', v_prev, true);
        exception when lock_not_available or deadlock_detected then
          v_reason := 'lock';
        end;
      end if;
      if v_reason is not null then
        v_job := public.stock_co__enqueue_job(v_org, r.loc, 'change_prices',
                   jsonb_build_object('change_key', v_key, 'spec', v_spec || jsonb_build_object('sites', jsonb_build_array(r.loc)),
                                      'after', null, 'change_log_id', v_log, 'reason', v_reason), v_si);
        v_queued := v_queued || jsonb_build_array(jsonb_build_object('location_id', r.loc, 'job_id', v_job));
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'changed', v_changed, 'dated', v_dated, 'from_day', case when v_live then null else v_day end,
                            'queued', v_queued);
end
$fn$;

-- A waiting dated price no longer happens. Need company for a company price, site_price for a price here.
-- Sections: inventory, purchasing.
create or replace function public.stock_cancel_dated_price(p_id uuid, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory', 'purchasing']);
  v_d stock_co_dated_prices;
begin
  perform public.stock_co__signed_in();
  select * into v_d from stock_co_dated_prices d where d.id = p_id;
  if v_d.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_d.org_id, v_section, case when v_d.location_id is null then 'company' else 'site_price' end,
                                 array[coalesce(v_d.location_id, public.stock_co__org_site(v_d.org_id))]);
  select * into v_d from stock_co_dated_prices d where d.id = p_id for update;
  if v_d.status <> 'waiting' then
    raise exception 'That price change is not waiting any more.' using errcode = '55000';
  end if;
  update stock_co_dated_prices d set status = 'cancelled' where d.id = p_id;
  perform public.stock_co__log(v_d.org_id, v_d.location_id, 'supplier_item', v_d.supplier_item_id, 'next_price',
                               jsonb_build_object('price', v_d.price, 'from_day', v_d.from_day), null, 'save');
  return jsonb_build_object('ok', true, 'id', p_id, 'status', 'cancelled');
end
$fn$;

-- Stage the rows of an import file (contract 1.6): p_job null makes the job from p_meta {"org_id",
-- "source", "file_name", "sites"}. Up to 2,000 rows a call [{"row_no", "kind", "data", "sites", "skip"}],
-- each checked by stock_co__import_check_row. Need company (section inventory).
create or replace function public.stock_import_stage(p_job uuid, p_rows jsonb, p_meta jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_j stock_co_import_jobs;
  v_org uuid;
  v_sites uuid[];
  v_g jsonb;
  v_chk jsonb;
  v_n integer := 0;
  v_rsites uuid[];
  v_counts jsonb;
  e jsonb;
begin
  if p_job is null then
    if p_meta is null or jsonb_typeof(p_meta) <> 'object' or coalesce(p_meta ->> 'org_id', '') !~* v_uuid then
      raise exception 'A new import needs its company (org_id).' using errcode = '22023';
    end if;
    if coalesce(p_meta ->> 'source', 'csv') not in ('csv', 'nory', 'marketman') then
      raise exception 'The field "source" must be one of: csv, nory, marketman.' using errcode = '22023';
    end if;
    v_org := lower(p_meta ->> 'org_id')::uuid;
    if jsonb_typeof(p_meta -> 'sites') = 'array' then
      if exists (select 1 from jsonb_array_elements(p_meta -> 'sites') x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~* v_uuid) then
        raise exception 'The field "sites" must be a list of sites.' using errcode = '22023';
      end if;
      v_sites := array(select distinct lower(x)::uuid from jsonb_array_elements_text(p_meta -> 'sites') x order by 1);
    end if;
    v_sites := coalesce(v_sites, '{}'::uuid[]);
    v_g := public.stock_co__guard(v_org, 'inventory', 'company',
                                  case when cardinality(v_sites) > 0 then v_sites else array[public.stock_co__org_site(v_org)] end);
    insert into stock_co_import_jobs (org_id, source, file_name, sites, created_by, created_by_name)
    values (v_org, coalesce(p_meta ->> 'source', 'csv'), left(nullif(btrim(coalesce(p_meta ->> 'file_name', '')), ''), 200), v_sites,
            v_uid, v_g ->> 'name')
    returning * into v_j;
  else
    select * into v_j from stock_co_import_jobs j where j.id = p_job;
    if v_j.id is null or not (v_j.created_by = v_uid or public.stock_level(v_uid, v_j.org_id) = 'all') then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    perform public.stock_co__guard(v_j.org_id, 'inventory', 'company',
                                   case when cardinality(v_j.sites) > 0 then v_j.sites else array[public.stock_co__org_site(v_j.org_id)] end);
    select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
    if v_j.status not in ('staging', 'checked') then
      raise exception 'This import has already started.' using errcode = '55000';
    end if;
  end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'null' then
    if jsonb_typeof(p_rows) <> 'array' then
      raise exception 'The field "rows" must be a list.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_rows) > 2000 then
      raise exception 'Send 2,000 rows or fewer at a time.' using errcode = '22023';
    end if;
    for e in
      select x.value from jsonb_array_elements(p_rows) x
       order by case when (x.value ->> 'row_no') ~ '^[0-9]{1,9}$' then (x.value ->> 'row_no')::integer end nulls first
    loop
      if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'row_no', '') !~ '^[0-9]{1,9}$' or (e ->> 'row_no')::integer < 1 then
        raise exception 'Each row needs its row number (row_no).' using errcode = '22023';
      end if;
      if coalesce(e ->> 'kind', '') not in ('item', 'supplier', 'supplier_item', 'par', 'recipe') then
        raise exception 'The field "kind" must be one of: item, supplier, supplier_item, par, recipe.' using errcode = '22023';
      end if;
      if jsonb_typeof(e -> 'data') is distinct from 'object' then
        raise exception 'Row % has no fields.', e ->> 'row_no' using errcode = '22023';
      end if;
      v_rsites := null;
      if jsonb_typeof(e -> 'sites') = 'array' then
        if exists (select 1 from jsonb_array_elements(e -> 'sites') x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~* v_uuid) then
          raise exception 'The field "sites" must be a list of sites.' using errcode = '22023';
        end if;
        v_rsites := array(select distinct lower(x)::uuid from jsonb_array_elements_text(e -> 'sites') x order by 1);
        if exists (select 1 from unnest(v_rsites) s where not exists (select 1 from locations l where l.id = s and l.org_id = v_j.org_id)) then
          raise exception 'That site is not in this company.' using errcode = '22023';
        end if;
      end if;
      v_chk := case when jsonb_typeof(e -> 'skip') = 'boolean' and (e ->> 'skip')::boolean
                    then jsonb_build_object('action', 'skip')
                    else public.stock_co__import_check_row(v_j.id, e ->> 'kind', e -> 'data') end;
      insert into stock_co_import_rows (job_id, row_no, org_id, kind, data, sites, action, problem, target_id)
      values (v_j.id, (e ->> 'row_no')::integer, v_j.org_id, e ->> 'kind', e -> 'data', v_rsites, v_chk ->> 'action', v_chk ->> 'problem',
              nullif(v_chk ->> 'target_id', '')::uuid)
      on conflict (job_id, row_no) do update
        set kind = excluded.kind, data = excluded.data, sites = excluded.sites, action = excluded.action, problem = excluded.problem,
            target_id = excluded.target_id, done = false;
      v_n := v_n + 1;
    end loop;
  end if;
  select jsonb_build_object('rows', count(*), 'new', count(*) filter (where r.action = 'new'),
                            'change', count(*) filter (where r.action = 'change'), 'same', count(*) filter (where r.action = 'same'),
                            'skip', count(*) filter (where r.action = 'skip'), 'problem', count(*) filter (where r.action = 'problem'),
                            'new_items', count(*) filter (where r.action = 'new' and r.kind = 'item'),
                            'price_changes', count(*) filter (where r.action = 'change' and r.kind = 'supplier_item'))
    into v_counts
    from stock_co_import_rows r where r.job_id = v_j.id;
  update stock_co_import_jobs j set counts = v_counts, row_version = j.row_version + 1, updated_at = now() where j.id = v_j.id;
  return jsonb_build_object('ok', true, 'job_id', v_j.id, 'staged', v_n, 'counts', v_counts);
end
$fn$;

-- Commit an import (always through the save queue, kind import_commit). p_sites replaces the job's sites
-- when given. Refused while a row still has a problem (skip it or fix it first). Need company.
create or replace function public.stock_import_commit(p_job uuid, p_sites uuid[] default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_j stock_co_import_jobs;
  v_sites uuid[];
  v_n integer;
  v_q bigint;
begin
  select * into v_j from stock_co_import_jobs j where j.id = p_job;
  if v_j.id is null or not (v_j.created_by = v_uid or public.stock_level(v_uid, v_j.org_id) = 'all') then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_sites := case when p_sites is null then v_j.sites else array(select distinct x from unnest(p_sites) x where x is not null order by 1) end;
  perform public.stock_co__guard(v_j.org_id, 'inventory', 'company',
                                 case when cardinality(v_sites) > 0 then v_sites else array[public.stock_co__org_site(v_j.org_id)] end);
  select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
  if v_j.status not in ('staging', 'checked') then
    raise exception 'This import has already started.' using errcode = '55000';
  end if;
  select count(*) into v_n from stock_co_import_rows r where r.job_id = p_job;
  if v_n = 0 then
    raise exception 'This file has no rows to import.' using errcode = '22023';
  end if;
  select count(*) into v_n from stock_co_import_rows r where r.job_id = p_job and r.action = 'problem';
  if v_n > 0 then
    raise exception 'Fix or skip the % rows with problems first.', v_n using errcode = '22023';
  end if;
  v_q := public.stock_co__enqueue_job(v_j.org_id, null, 'import_commit', jsonb_build_object('job_id', p_job, 'after_row', 0), array[p_job]);
  update stock_co_import_jobs j set sites = v_sites, status = 'queued', queue_id = v_q, row_version = j.row_version + 1, updated_at = now()
   where j.id = p_job;
  perform public.stock_co__log(v_j.org_id, null, 'bulk', v_j.org_id, 'import', null,
                               jsonb_build_object('job_id', p_job, 'file_name', v_j.file_name, 'counts', v_j.counts), 'import');
  return jsonb_build_object('ok', true, 'job_id', p_job, 'queue_id', v_q);
end
$fn$;

-- Cancel an import that has not started (staging or checked). Need company.
create or replace function public.stock_import_cancel(p_job uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_j stock_co_import_jobs;
begin
  select * into v_j from stock_co_import_jobs j where j.id = p_job;
  if v_j.id is null or not (v_j.created_by = v_uid or public.stock_level(v_uid, v_j.org_id) = 'all') then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_j.org_id, 'inventory', 'company',
                                 case when cardinality(v_j.sites) > 0 then v_j.sites else array[public.stock_co__org_site(v_j.org_id)] end);
  select * into v_j from stock_co_import_jobs j where j.id = p_job for update;
  if v_j.status not in ('staging', 'checked') then
    raise exception 'This import has already started.' using errcode = '55000';
  end if;
  update stock_co_import_jobs j set status = 'cancelled', row_version = j.row_version + 1, updated_at = now() where j.id = p_job;
  return jsonb_build_object('ok', true, 'job_id', p_job, 'status', 'cancelled');
end
$fn$;

-- Copy a site (contract 1.8): always through the save queue (kind copy_site, location_id = the new site).
-- Need company with both sites named. A copy already waiting or running for that site is the answer.
-- Sections: inventory.
create or replace function public.stock_copy_site(p_from uuid, p_to uuid, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_org uuid;
  v_g jsonb;
  v_q bigint;
begin
  perform public.stock_co__signed_in();
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'Pick two different sites.' using errcode = '22023';
  end if;
  select l.org_id into v_org from locations l where l.id = p_to;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[p_from, p_to]);
  select q.id into v_q from stock_save_queue q
   where q.location_id = p_to and q.kind = 'copy_site' and q.status in ('waiting', 'running')
   order by q.id limit 1;
  if v_q is null then
    v_q := public.stock_co__enqueue_job(v_org, p_to, 'copy_site',
             jsonb_build_object('from', p_from, 'to', p_to, 'stage', 'items', 'after', null, 'by', v_g ->> 'uid', 'by_name', v_g ->> 'name'),
             '{}'::uuid[]);
    perform public.stock_co__log(v_org, p_to, 'site', p_to, 'copy_site', null, jsonb_build_object('from', p_from, 'job_id', v_q), 'copy_site');
  end if;
  return jsonb_build_object('ok', true, 'queue_id', v_q);
end
$fn$;

-- The order rules given as text, checked: [{"delivery_dow", "order_by_dow", "order_by_time"}], one per
-- day, at most 7. Owner only.
create or replace function public.stock_co__clean_rules(p_rules jsonb)
returns table (delivery_dow smallint, order_by_dow smallint, order_by_time time)
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
declare
  e jsonb;
  v_d smallint;
  v_o smallint;
  v_t text;
  v_seen smallint[] := '{}'::smallint[];
begin
  if p_rules is null or jsonb_typeof(p_rules) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 7 then
    raise exception 'The order rules must be a list of at most 7 days.' using errcode = '22023';
  end if;
  for e in select x.value from jsonb_array_elements(p_rules) x loop
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'delivery_dow', '') !~ '^[0-6]$' then
      raise exception 'The field "delivery_dow" must be a day number from 0 (Sunday) to 6 (Saturday).' using errcode = '22023';
    end if;
    v_d := (e ->> 'delivery_dow')::smallint;
    if v_d = any(v_seen) then
      raise exception 'Each day can have one delivery only.' using errcode = '22023';
    end if;
    v_seen := v_seen || v_d;
    v_o := null;
    if jsonb_typeof(e -> 'order_by_dow') not in ('null') and e ? 'order_by_dow' then
      if coalesce(e ->> 'order_by_dow', '') !~ '^[0-6]$' then
        raise exception 'The field "order_by_dow" must be a day number from 0 (Sunday) to 6 (Saturday).' using errcode = '22023';
      end if;
      v_o := (e ->> 'order_by_dow')::smallint;
    end if;
    v_t := nullif(btrim(coalesce(e ->> 'order_by_time', '')), '');
    if v_t is not null and v_t !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'The field "order_by_time" must be a time such as 14:00.' using errcode = '22023';
    end if;
    if (v_o is null) <> (v_t is null) then
      raise exception 'Give the order by day and time together.' using errcode = '22023';
    end if;
    delivery_dow := v_d;
    order_by_dow := v_o;
    order_by_time := v_t::time;
    return next;
  end loop;
end
$fn$;

-- One site's order rules of one supplier made from a checked list, its delivery days and cut off derived
-- in the same step (so today's Order pad readers keep working). Returns the rules written. Owner only.
create or replace function public.stock_co__put_rules(p_org uuid, p_loc uuid, p_site_supplier uuid, p_company uuid, p_rules jsonb, p_by uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_days jsonb;
  v_cut text;
begin
  delete from stock_order_rules r where r.supplier_id = p_site_supplier;
  insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time, updated_by)
  select p_org, p_loc, p_site_supplier, p_company, c.delivery_dow, c.order_by_dow, c.order_by_time, p_by
    from public.stock_co__clean_rules(p_rules) c;
  select z.delivery_days, z.cutoff_time into v_days, v_cut from public.stock_co__derive_days(p_site_supplier) z;
  update suppliers t
     set delivery_days = v_days, cutoff_time = v_cut, row_version = t.row_version + 1, updated_at = now()
   where t.id = p_site_supplier and t.location_id = p_loc
     and (t.delivery_days, t.cutoff_time) is distinct from (v_days, v_cut);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'delivery_dow', r.delivery_dow, 'order_by_dow', r.order_by_dow,
                                                       'order_by_time', to_char(r.order_by_time, 'HH24:MI'), 'row_version', r.row_version)
                                    order by (r.delivery_dow + 6) % 7), '[]'::jsonb)
            from stock_order_rules r where r.supplier_id = p_site_supplier);
end
$fn$;

-- Replace one site's order rules of a supplier (contract 1.6). Need company. The version is the supplier's
-- site link row_version (bumped). Sections: purchasing.
create or replace function public.stock_save_order_rules(p_supplier uuid, p_location uuid, p_rules jsonb, p_version integer,
                                                         p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_org uuid;
  v_link stock_co_supplier_sites;
  v_g jsonb;
  v_before jsonb;
  v_after jsonb;
  v_rv integer;
  v_row suppliers;
begin
  perform public.stock_co__signed_in();
  if v_id is null or p_location is null
     or (p_supplier <> v_id and public.stock_co__site_loc('supplier', p_supplier) is distinct from p_location) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_suppliers x where x.id = v_id;
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location;
  if v_link.supplier_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[p_location]);
  perform 1 from public.stock_co__clean_rules(p_rules);
  select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_location for update;
  perform public.stock_co__need_version('company', p_version);
  if v_link.row_version is distinct from p_version then
    return public.stock_co__conflict(v_org, array['supplier_site', 'supplier'], v_id, v_link.row_version, p_location, v_link.updated_at);
  end if;
  perform 1 from suppliers t where t.id = v_link.site_supplier_id for no key update;
  select coalesce(jsonb_agg(jsonb_build_object('delivery_dow', r.delivery_dow, 'order_by_dow', r.order_by_dow,
                                               'order_by_time', to_char(r.order_by_time, 'HH24:MI')) order by r.delivery_dow), '[]'::jsonb)
    into v_before from stock_order_rules r where r.supplier_id = v_link.site_supplier_id;
  v_after := public.stock_co__put_rules(v_org, p_location, v_link.site_supplier_id, v_id, p_rules, (v_g ->> 'uid')::uuid);
  update stock_co_supplier_sites s set row_version = s.row_version + 1, updated_at = now()
   where s.supplier_id = v_id and s.location_id = p_location
  returning s.row_version into v_rv;
  perform public.stock_co__log(v_org, p_location, 'supplier_site', v_id, 'order_rules', v_before,
                               (select coalesce(jsonb_agg(e - 'id' - 'row_version' order by (e ->> 'delivery_dow')::integer), '[]'::jsonb)
                                  from jsonb_array_elements(v_after) e), 'save');
  select * into v_row from suppliers t where t.id = v_link.site_supplier_id;
  return jsonb_build_object('ok', true, 'supplier_id', v_id, 'location_id', p_location, 'row_version', v_rv, 'rules', v_after,
                            'delivery_days', v_row.delivery_days, 'cutoff_time', v_row.cutoff_time);
end
$fn$;

-- Copy one supplier's order rules from a site to other sites that can order from it (each site's
-- derived delivery days and cut off written). Need company. Sections: purchasing.
create or replace function public.stock_copy_order_rules(p_supplier uuid, p_from uuid, p_to uuid[], p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_id uuid := public.stock_co__company_id('supplier', p_supplier);
  v_org uuid;
  v_from stock_co_supplier_sites;
  v_to uuid[];
  v_g jsonb;
  v_rules jsonb;
  v_link stock_co_supplier_sites;
  v_copied integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_before jsonb;
  r record;
begin
  perform public.stock_co__signed_in();
  if v_id is null or p_from is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select x.org_id into v_org from stock_co_suppliers x where x.id = v_id;
  select * into v_from from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = p_from;
  if v_from.supplier_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_to := array(select distinct x from unnest(coalesce(p_to, '{}'::uuid[])) x where x is not null and x <> p_from order by 1);
  if cardinality(v_to) = 0 then
    raise exception 'Pick at least one site.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', p_from || v_to);
  select coalesce(jsonb_agg(jsonb_build_object('delivery_dow', o.delivery_dow, 'order_by_dow', o.order_by_dow,
                                               'order_by_time', to_char(o.order_by_time, 'HH24:MI')) order by o.delivery_dow), '[]'::jsonb)
    into v_rules from stock_order_rules o where o.supplier_id = v_from.site_supplier_id;
  for r in select x as loc from unnest(v_to) x order by 1 loop
    select * into v_link from stock_co_supplier_sites s where s.supplier_id = v_id and s.location_id = r.loc for update;
    if v_link.supplier_id is null or not v_link.can_order then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('location_id', r.loc, 'reason', 'Cannot order from this supplier here.'));
      continue;
    end if;
    perform 1 from suppliers t where t.id = v_link.site_supplier_id for no key update;
    select coalesce(jsonb_agg(jsonb_build_object('delivery_dow', o.delivery_dow, 'order_by_dow', o.order_by_dow,
                                                 'order_by_time', to_char(o.order_by_time, 'HH24:MI')) order by o.delivery_dow), '[]'::jsonb)
      into v_before from stock_order_rules o where o.supplier_id = v_link.site_supplier_id;
    perform public.stock_co__put_rules(v_org, r.loc, v_link.site_supplier_id, v_id, v_rules, (v_g ->> 'uid')::uuid);
    update stock_co_supplier_sites s set row_version = s.row_version + 1, updated_at = now()
     where s.supplier_id = v_id and s.location_id = r.loc;
    perform public.stock_co__log(v_org, r.loc, 'supplier_site', v_id, 'order_rules', v_before, v_rules, 'save');
    v_copied := v_copied + 1;
  end loop;
  return jsonb_build_object('ok', true, 'copied', v_copied, 'skipped', v_skipped);
end
$fn$;

-- Create or edit a company category (contract 1.6). A new name rewrites the free text category of its
-- company items and their site rows through the writer (queued over 200 items, kind category_rename).
-- Need company. Sections: inventory.
create or replace function public.stock_save_category(p_cat jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t0 timestamptz := clock_timestamp();
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_d jsonb := public.stock_co__clean('category', p_cat);
  v_old stock_co_categories;
  v_new stock_co_categories;
  v_org uuid;
  v_g jsonb;
  v_items uuid[];
  v_log bigint;
  v_run jsonb;
  v_queued jsonb := '[]'::jsonb;
  v_job bigint;
  r record;
begin
  perform public.stock_co__signed_in();
  if (v_d ->> 'id') is not null then
    select * into v_old from stock_co_categories c where c.id = (v_d ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_org := v_old.org_id;
  else
    v_org := (v_d ->> 'org_id')::uuid;
    if v_org is null then
      raise exception 'A new category needs its company (org_id).' using errcode = '22023';
    end if;
    if coalesce(v_d ->> 'name', '') = '' then
      raise exception 'A new category needs a name.' using errcode = '22023';
    end if;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[public.stock_co__org_site(v_org)]);
  begin
    if v_old.id is not null then
      select * into v_old from stock_co_categories c where c.id = v_old.id for update;
      perform public.stock_co__need_version('company', p_version);
      if v_old.row_version is distinct from p_version then
        return public.stock_co__conflict(v_org, array['category'], v_old.id, v_old.row_version, null, v_old.updated_at);
      end if;
      v_new := jsonb_populate_record(v_old, v_d - array['id', 'org_id']);
      update stock_co_categories c
         set name = v_new.name, accounting_code = v_new.accounting_code, gp_target_pct = v_new.gp_target_pct, sort_order = v_new.sort_order,
             row_version = c.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
       where c.id = v_old.id
      returning * into v_new;
    else
      insert into stock_co_categories (org_id, name, accounting_code, gp_target_pct, sort_order, updated_by)
      values (v_org, btrim(v_d ->> 'name'), v_d ->> 'accounting_code', (v_d ->> 'gp_target_pct')::numeric,
              coalesce((v_d ->> 'sort_order')::integer,
                       (select coalesce(max(c.sort_order), 0) + 1 from stock_co_categories c where c.org_id = v_org)),
              (v_g ->> 'uid')::uuid)
      returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'There is already a category called %.', coalesce(v_d ->> 'name', v_old.name) using errcode = '22023';
  end;
  v_log := public.stock_co__log_diff(v_org, null, 'category', v_new.id, case when v_old.id is null then null else to_jsonb(v_old) end,
                                     to_jsonb(v_new), 'save');
  if v_old.id is not null and v_new.name is distinct from v_old.name then
    v_items := array(select i.id from stock_co_items i where i.category_id = v_new.id order by i.id limit 201);
    if cardinality(v_items) > 200 then
      v_job := public.stock_co__enqueue_job(v_org, null, 'category_rename', jsonb_build_object('category_id', v_new.id, 'after', null),
                                            array[v_new.id]);
      v_queued := jsonb_build_array(jsonb_build_object('location_id', null, 'job_id', v_job));
    elsif cardinality(v_items) > 0 then
      for r in
        with old as (select i.id, i.category from stock_co_items i where i.id = any(v_items) order by i.id for update),
        upd as (update stock_co_items i set category = v_new.name, row_version = i.row_version + 1, updated_at = now()
                  from old where i.id = old.id and i.category is distinct from v_new.name returning i.id)
        select old.* from old join upd on upd.id = old.id
      loop
        perform public.stock_co__log(v_org, null, 'item', r.id, 'category', to_jsonb(r.category), to_jsonb(v_new.name), 'save');
      end loop;
      v_run := public.stock_co__run_sites(v_org, null,
                 array(select distinct s.location_id from stock_co_item_sites s where s.item_id = any(v_items) order by 1),
                 v_items, '{}'::uuid[], '{}'::uuid[], v_log, v_t0);
      v_queued := coalesce(v_run -> 'queued', '[]'::jsonb);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_new.id, 'row_version', v_new.row_version, 'name', v_new.name, 'queued', v_queued);
end
$fn$;

-- Archive (or bring back) a company category. Refused while live items use it. Need company. Sections:
-- inventory.
create or replace function public.stock_archive_category(p_id uuid, p_version integer, p_archived boolean default true,
                                                         p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_section text := public.stock_co__section(p_section, array['inventory']);
  v_old stock_co_categories;
  v_g jsonb;
  v_n integer;
  v_at timestamptz;
  v_rv integer;
begin
  perform public.stock_co__signed_in();
  select * into v_old from stock_co_categories c where c.id = p_id;
  if v_old.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_old.org_id, v_section, 'company', array[public.stock_co__org_site(v_old.org_id)]);
  select * into v_old from stock_co_categories c where c.id = p_id for update;
  perform public.stock_co__need_version('company', p_version);
  if v_old.row_version is distinct from p_version then
    return public.stock_co__conflict(v_old.org_id, array['category'], v_old.id, v_old.row_version, null, v_old.updated_at);
  end if;
  if coalesce(p_archived, true) then
    select count(*) into v_n from stock_co_items i where i.category_id = p_id and i.archived_at is null;
    if v_n > 0 then
      raise exception 'Move the % items in % to another category first.', v_n, v_old.name using errcode = '55000';
    end if;
    v_at := coalesce(v_old.archived_at, now());
  end if;
  update stock_co_categories c set archived_at = v_at, row_version = c.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where c.id = p_id
  returning c.row_version into v_rv;
  perform public.stock_co__log(v_old.org_id, null, 'category', p_id, 'archived_at', to_jsonb(v_old.archived_at), to_jsonb(v_at), 'save');
  return jsonb_build_object('ok', true, 'id', p_id, 'archived_at', v_at, 'row_version', v_rv);
end
$fn$;

-- The company stock settings (stock_co_settings, target settings). "sites" overrides
-- [{"location_id", "waste_pin_over_value", "count_second_approval_over"}] need the owner. Need company.
-- No section check (Overview is open to every login, as stock_save_cost_rule).
create or replace function public.stock_save_settings(p_org uuid, p_patch jsonb, p_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_d jsonb := public.stock_co__clean('settings', p_patch);
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_g jsonb;
  v_old stock_co_settings;
  v_new stock_co_settings;
  v_sites uuid[];
  v_k text;
  v_ss jsonb;
  e jsonb;
begin
  perform public.stock_co__signed_in();
  if p_org is null or not exists (select 1 from organisations o where o.id = p_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(p_org, null, 'company', array[public.stock_co__org_site(p_org)]);
  if v_d ? 'week_start' and ((v_d ->> 'week_start') is null or (v_d ->> 'week_start')::integer > 6) then
    raise exception 'The week starts on a day from 0 (Sunday) to 6 (Saturday).' using errcode = '22023';
  end if;
  foreach v_k in array array['waste_reasons', 'usual_areas'] loop
    if v_d ? v_k and jsonb_typeof(v_d -> v_k) = 'array'
       and exists (select 1 from jsonb_array_elements(v_d -> v_k) x where jsonb_typeof(x) <> 'string') then
      raise exception 'The field "%" must be a list of text.', v_k using errcode = '22023';
    end if;
  end loop;
  if v_d ? 'sites' and jsonb_typeof(v_d -> 'sites') = 'array' then
    for e in select x.value from jsonb_array_elements(v_d -> 'sites') x loop
      if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'location_id', '') !~* v_uuid then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_object_keys(e) k where k not in ('location_id', 'waste_pin_over_value', 'count_second_approval_over')) then
        raise exception 'The field "sites" can hold location_id, waste_pin_over_value and count_second_approval_over only.' using errcode = '22023';
      end if;
      perform public.stock_co__clean('settings', e - 'location_id');
      v_sites := coalesce(v_sites, '{}'::uuid[]) || lower(e ->> 'location_id')::uuid;
    end loop;
    if cardinality(v_sites) > 0 then
      perform public.stock_co__guard(p_org, null, 'owner', v_sites);
    end if;
  end if;
  select * into v_old from stock_co_settings s where s.org_id = p_org for update;
  if v_old.org_id is not null then
    perform public.stock_co__need_version('company', p_version);
    if v_old.row_version is distinct from p_version then
      return public.stock_co__conflict(p_org, array['settings'], p_org, v_old.row_version, null, v_old.updated_at);
    end if;
  else
    insert into stock_co_settings (org_id) values (p_org) on conflict (org_id) do nothing;
    select * into v_old from stock_co_settings s where s.org_id = p_org for update;
  end if;
  v_new := jsonb_populate_record(v_old, v_d - 'sites');
  update stock_co_settings s
     set week_start = coalesce(v_new.week_start, s.week_start), waste_reasons = v_new.waste_reasons, usual_areas = v_new.usual_areas,
         invoice_tolerance_pct = v_new.invoice_tolerance_pct, invoice_tolerance_amount = v_new.invoice_tolerance_amount,
         send_unapproved_at_cutoff = coalesce(v_new.send_unapproved_at_cutoff, s.send_unapproved_at_cutoff),
         waste_pin_over_value = v_new.waste_pin_over_value, count_second_approval_over = v_new.count_second_approval_over,
         row_version = s.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
   where s.org_id = p_org
  returning * into v_new;
  perform public.stock_co__log_diff(p_org, null, 'settings', p_org, to_jsonb(v_old), to_jsonb(v_new), 'save');
  if v_d ? 'sites' and jsonb_typeof(v_d -> 'sites') = 'array' then
    for e in select x.value from jsonb_array_elements(v_d -> 'sites') x loop
      v_ss := public.stock_co__clean('settings', e - 'location_id');
      insert into stock_co_site_settings (location_id, org_id, waste_pin_over_value, count_second_approval_over, updated_by)
      values (lower(e ->> 'location_id')::uuid, p_org, (v_ss ->> 'waste_pin_over_value')::numeric,
              (v_ss ->> 'count_second_approval_over')::numeric, (v_g ->> 'uid')::uuid)
      on conflict (location_id) do update
        set waste_pin_over_value = case when v_ss ? 'waste_pin_over_value' then excluded.waste_pin_over_value
                                        else stock_co_site_settings.waste_pin_over_value end,
            count_second_approval_over = case when v_ss ? 'count_second_approval_over' then excluded.count_second_approval_over
                                              else stock_co_site_settings.count_second_approval_over end,
            row_version = stock_co_site_settings.row_version + 1, updated_at = now(), updated_by = excluded.updated_by;
      perform public.stock_co__log(p_org, lower(e ->> 'location_id')::uuid, 'settings', p_org, 'site_overrides', null, e, 'save');
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'org_id', p_org, 'row_version', v_new.row_version, 'settings', to_jsonb(v_new));
end
$fn$;

-- A local item or supplier becomes a company record (its site tick stays). Need company. Sections:
-- inventory (item), purchasing (supplier).
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
  if p_entity is null or p_entity not in ('item', 'supplier') then
    raise exception 'The field "entity" must be item or supplier.' using errcode = '22023';
  end if;
  v_section := public.stock_co__section(p_section, case when p_entity = 'item' then array['inventory'] else array['purchasing'] end);
  v_id := public.stock_co__company_id(p_entity, p_id);
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_entity = 'item' then
    select i.org_id, i.local_location_id into v_org, v_loc from stock_co_items i where i.id = v_id;
  else
    select m.org_id, m.local_location_id into v_org, v_loc from stock_co_suppliers m where m.id = v_id;
  end if;
  v_g := public.stock_co__guard(v_org, v_section, 'company', array[coalesce(v_loc, public.stock_co__org_site(v_org))]);
  if p_entity = 'item' then
    select i.row_version, i.updated_at, i.local_location_id into v_rv, v_at, v_loc from stock_co_items i where i.id = v_id for update;
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
    else
      update stock_co_suppliers m set local_location_id = null, row_version = m.row_version + 1, updated_at = now()
       where m.id = v_id returning m.row_version into v_rv;
    end if;
    perform public.stock_co__log(v_org, null, p_entity, v_id, 'local_location_id', to_jsonb(v_loc), null, 'save');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv);
end
$fn$;

-- One go live step of a site (target golive_step): due day, note, done (true stamps who and when, false
-- clears them). Need company. The version is required when the step row exists.
create or replace function public.stock_save_golive_step(p_loc uuid, p_step jsonb, p_version integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_d jsonb := public.stock_co__clean('golive_step', p_step);
  v_org uuid;
  v_g jsonb;
  v_old stock_co_golive_steps;
  v_new stock_co_golive_steps;
begin
  perform public.stock_co__signed_in();
  if (v_d ->> 'step') is null then
    raise exception 'Say which go live step.' using errcode = '22023';
  end if;
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, null, 'company', array[p_loc]);
  select * into v_old from stock_co_golive_steps g where g.location_id = p_loc and g.step = v_d ->> 'step' for update;
  if v_old.id is not null then
    perform public.stock_co__need_version('company', p_version);
    if v_old.row_version is distinct from p_version then
      return public.stock_co__conflict(v_org, array['golive_step'], v_old.id, v_old.row_version, p_loc, v_old.updated_at);
    end if;
    update stock_co_golive_steps g
       set due_day = case when v_d ? 'due_day' then (v_d ->> 'due_day')::date else g.due_day end,
           note = case when v_d ? 'note' then v_d ->> 'note' else g.note end,
           done_at = case when not (v_d ? 'done') then g.done_at when (v_d ->> 'done')::boolean then coalesce(g.done_at, now()) end,
           done_by = case when not (v_d ? 'done') then g.done_by when (v_d ->> 'done')::boolean then coalesce(g.done_by, (v_g ->> 'uid')::uuid) end,
           done_by_name = case when not (v_d ? 'done') then g.done_by_name
                               when (v_d ->> 'done')::boolean then coalesce(g.done_by_name, v_g ->> 'name') end,
           row_version = g.row_version + 1, updated_at = now()
     where g.id = v_old.id
    returning * into v_new;
  else
    insert into stock_co_golive_steps (org_id, location_id, step, due_day, note, done_at, done_by, done_by_name)
    values (v_org, p_loc, v_d ->> 'step', (v_d ->> 'due_day')::date, v_d ->> 'note',
            case when coalesce((v_d ->> 'done')::boolean, false) then now() end,
            case when coalesce((v_d ->> 'done')::boolean, false) then (v_g ->> 'uid')::uuid end,
            case when coalesce((v_d ->> 'done')::boolean, false) then v_g ->> 'name' end)
    returning * into v_new;
  end if;
  perform public.stock_co__log_diff(v_org, p_loc, 'golive_step', v_new.id, case when v_old.id is null then null else to_jsonb(v_old) end,
                                    to_jsonb(v_new), 'save');
  return jsonb_build_object('ok', true, 'step', jsonb_build_object('step', v_new.step, 'due_day', v_new.due_day, 'done_at', v_new.done_at,
                                                                   'done_by_name', v_new.done_by_name, 'note', v_new.note,
                                                                   'row_version', v_new.row_version));
end
$fn$;

-- Create or edit a site group (target site_group; row_version inside p_group is required on edit). Every
-- site of the group is named to the guard. Need company.
create or replace function public.stock_save_site_group(p_group jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_d jsonb := public.stock_co__clean('site_group', p_group);
  v_uuid text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_old stock_co_site_groups;
  v_new stock_co_site_groups;
  v_org uuid;
  v_locs uuid[];
  v_g jsonb;
begin
  perform public.stock_co__signed_in();
  if (v_d ->> 'id') is not null then
    select * into v_old from stock_co_site_groups g where g.id = (v_d ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_org := v_old.org_id;
  else
    v_org := (v_d ->> 'org_id')::uuid;
    if v_org is null then
      raise exception 'A new group needs its company (org_id).' using errcode = '22023';
    end if;
    if coalesce(v_d ->> 'name', '') = '' then
      raise exception 'A new group needs a name.' using errcode = '22023';
    end if;
  end if;
  if v_d ? 'location_ids' then
    if exists (select 1 from jsonb_array_elements(v_d -> 'location_ids') x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~* v_uuid) then
      raise exception 'The field "location_ids" must be a list of sites.' using errcode = '22023';
    end if;
    v_locs := array(select distinct lower(x)::uuid from jsonb_array_elements_text(v_d -> 'location_ids') x order by 1);
    if cardinality(v_locs) = 0 then
      raise exception 'Pick at least one site.' using errcode = '22023';
    end if;
  elsif v_old.id is null then
    raise exception 'Pick at least one site.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_org, null, 'company',
                                array(select distinct x from unnest(coalesce(v_locs, v_old.location_ids)) x order by 1));
  begin
    if v_old.id is not null then
      select * into v_old from stock_co_site_groups g where g.id = v_old.id for update;
      perform public.stock_co__need_version('company', (v_d ->> 'row_version')::integer);
      if v_old.row_version is distinct from (v_d ->> 'row_version')::integer then
        return public.stock_co__conflict(v_org, array['site_group'], v_old.id, v_old.row_version, null, v_old.updated_at);
      end if;
      update stock_co_site_groups g
         set name = case when v_d ? 'name' then btrim(v_d ->> 'name') else g.name end,
             location_ids = coalesce(v_locs, g.location_ids),
             sort_order = coalesce((v_d ->> 'sort_order')::integer, g.sort_order),
             row_version = g.row_version + 1, updated_at = now()
       where g.id = v_old.id
      returning * into v_new;
    else
      insert into stock_co_site_groups (org_id, name, location_ids, sort_order)
      values (v_org, btrim(v_d ->> 'name'), v_locs,
              coalesce((v_d ->> 'sort_order')::integer, (select coalesce(max(g.sort_order), 0) + 1 from stock_co_site_groups g where g.org_id = v_org)))
      returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'There is already a group called %.', coalesce(v_d ->> 'name', v_old.name) using errcode = '22023';
  end;
  perform public.stock_co__log_diff(v_org, null, 'site_group', v_new.id, case when v_old.id is null then null else to_jsonb(v_old) end,
                                    to_jsonb(v_new), 'save');
  return jsonb_build_object('ok', true, 'id', v_new.id, 'row_version', v_new.row_version);
end
$fn$;

-- Delete a site group (the sites are not touched). Need company.
create or replace function public.stock_delete_site_group(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_co_site_groups;
begin
  perform public.stock_co__signed_in();
  select * into v_old from stock_co_site_groups g where g.id = p_id;
  if v_old.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_old.org_id, null, 'company', array[public.stock_co__org_site(v_old.org_id)]);
  delete from stock_co_site_groups g where g.id = p_id;
  perform public.stock_co__log(v_old.org_id, null, 'site_group', p_id, 'deleted', to_jsonb(v_old) - array['updated_at', 'created_at'], null, 'save');
  return jsonb_build_object('ok', true, 'id', p_id);
end
$fn$;

-- Suggest a change to a company item, supplier or recipe (a login that can only read it): an activity
-- feed row at the caller's site of that record and a change log row. At most 30 a day per login. Need
-- read at a site of the record in reach.
create or replace function public.stock_suggest_change(p_entity text, p_id uuid, p_text text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.stock_co__signed_in();
  v_id uuid;
  v_org uuid;
  v_name text;
  v_sites uuid[];
  v_home uuid;
  v_g jsonb;
  v_text text := btrim(coalesce(p_text, ''));
  v_n integer;
begin
  if p_entity is null or p_entity not in ('item', 'supplier', 'recipe') then
    raise exception 'The field "entity" must be item, supplier or recipe.' using errcode = '22023';
  end if;
  v_id := public.stock_co__company_id(p_entity, p_id);
  if v_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_entity = 'item' then
    select i.org_id, i.name into v_org, v_name from stock_co_items i where i.id = v_id;
    v_sites := array(select s.location_id from stock_co_item_sites s where s.item_id = v_id
                     union select i.local_location_id from stock_co_items i where i.id = v_id and i.local_location_id is not null);
  elsif p_entity = 'supplier' then
    select m.org_id, m.name into v_org, v_name from stock_co_suppliers m where m.id = v_id;
    v_sites := array(select s.location_id from stock_co_supplier_sites s where s.supplier_id = v_id
                     union select m.local_location_id from stock_co_suppliers m where m.id = v_id and m.local_location_id is not null);
  else
    select r.org_id, r.name into v_org, v_name from stock_co_recipes r where r.id = v_id;
    v_sites := array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id
                     union select r.local_location_id from stock_co_recipes r where r.id = v_id and r.local_location_id is not null);
  end if;
  v_home := public.stock_co__site_loc(p_entity, p_id);
  if v_home is null or not (v_home::text in (select public.stock_reach_locations())) then
    v_home := public.stock_co__reached_site(v_sites);
  end if;
  v_g := public.stock_co__guard(v_org, null, 'read', array[v_home]);
  if v_text = '' or length(v_text) > 500 then
    raise exception 'Write what should change, up to 500 letters.' using errcode = '22023';
  end if;
  select count(*) into v_n from stock_change_log c
   where c.org_id = v_org and c.who = v_uid and c.source = 'suggest' and c.at > now() - interval '24 hours';
  if v_n >= 30 then
    raise exception 'That is 30 suggestions today. Try again tomorrow.' using errcode = '55000';
  end if;
  insert into activity_events (location_id, kind, severity, title, body, ref_type, ref_id, actor_name)
  values (v_home, 'stock_suggestion', 'info', 'Suggested change: ' || coalesce(v_name, 'a stock record'), v_text, 'stock_' || p_entity,
          v_id::text, v_g ->> 'name');
  perform public.stock_co__log(v_org, v_home, p_entity, v_id, 'suggestion', null, to_jsonb(v_text), 'suggest');
  return jsonb_build_object('ok', true);
end
$fn$;

-- Fix a site's set up: the writer again for every company item, supplier and recipe of one site (kind
-- resync_site), unless one is already waiting or running. Stamps the site's health row. Need company.
create or replace function public.stock_resync_site(p_loc uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_q bigint;
begin
  perform public.stock_co__signed_in();
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, null, 'company', array[p_loc]);
  select q.id into v_q from stock_save_queue q
   where q.location_id = p_loc and q.kind = 'resync_site' and q.status in ('waiting', 'running')
   order by q.id limit 1;
  if v_q is null then
    v_q := public.stock_co__enqueue_job(v_org, p_loc, 'resync_site', jsonb_build_object('stage', 'items', 'after', null), '{}'::uuid[]);
    perform public.stock_co__log(v_org, p_loc, 'site', p_loc, 'resync', null, jsonb_build_object('job_id', v_q), 'save');
  end if;
  insert into stock_co_site_health (location_id, org_id, checked_at, fix_job_id, fix_asked_at, fix_asked_by)
  values (p_loc, v_org, now(), v_q, now(), (v_g ->> 'uid')::uuid)
  on conflict (location_id) do update
    set fix_job_id = excluded.fix_job_id, fix_asked_at = excluded.fix_asked_at, fix_asked_by = excluded.fix_asked_by;
  return jsonb_build_object('ok', true, 'queue_id', v_q);
end
$fn$;

-- The nightly set up health of one site (service role only, from stock-nightly): the writer in check mode
-- for its items, suppliers and recipes, the first 50 differing rows and plain lines kept in
-- stock_co_site_health. Writes no site row. Answers {"location_id", "planned_writes",
-- "recipe_planned_writes"}.
create or replace function public.stock_nightly_health(p_location uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_a jsonb;
  v_b jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_detail jsonb;
  v_w integer;
  v_rw integer;
  k record;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'This runs from the nightly stock job only.' using errcode = '42501';
  end if;
  select l.org_id into v_org from locations l where l.id = p_location;
  if v_org is null then
    return jsonb_build_object('location_id', p_location, 'planned_writes', 0, 'recipe_planned_writes', 0);
  end if;
  v_a := public.stock_co__sync_site(p_location, null, null, false, true);
  v_b := public.stock_co__sync_recipes(p_location, null, false, true);
  v_w := coalesce((v_a ->> 'writes')::integer, 0);
  v_rw := coalesce((v_b ->> 'writes')::integer, 0);
  for k in
    select * from (values
      ('items_changed', v_a, 'stock items differ from the company list'),
      ('packs_new', v_a, 'packs are missing here'),
      ('packs_changed', v_a, 'packs differ from the company list'),
      ('bridges_new', v_a, 'unit bridges are missing here'),
      ('bridges_changed', v_a, 'unit bridges differ from the company list'),
      ('suppliers_changed', v_a, 'suppliers differ from the company list'),
      ('prices_new', v_a, 'supplier packs are missing here'),
      ('prices_changed', v_a, 'supplier packs or prices differ from the company list'),
      ('recipes_changed', v_b, 'recipes differ from the company list'),
      ('lines_changed', v_b, 'recipes have different lines here'),
      ('links_changed', v_b, 'till links differ from the company list'),
      ('recipes_blocked', v_b, 'recipes cannot be set up here yet')) x(key, src, words)
  loop
    if coalesce((k.src ->> k.key)::integer, 0) > 0 then
      v_lines := v_lines || to_jsonb(format('%s %s.', (k.src ->> k.key)::integer, k.words));
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    v_lines := jsonb_build_array('Everything matches the company list.');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind', d ->> 'kind', 'name', d ->> 'name', 'company', d -> 'company', 'site', d -> 'site')
                            order by o), '[]'::jsonb)
    into v_detail
    from (select d, o from jsonb_array_elements(coalesce(v_a -> 'detail', '[]'::jsonb) || coalesce(v_b -> 'detail', '[]'::jsonb))
                           with ordinality x(d, o)
           order by o limit 50) z;
  insert into stock_co_site_health (location_id, org_id, checked_at, planned_writes, recipe_planned_writes, detail, lines)
  values (p_location, v_org, now(), v_w, v_rw, v_detail, v_lines)
  on conflict (location_id) do update
    set org_id = excluded.org_id, checked_at = excluded.checked_at, planned_writes = excluded.planned_writes,
        recipe_planned_writes = excluded.recipe_planned_writes, detail = excluded.detail, lines = excluded.lines;
  return jsonb_build_object('location_id', p_location, 'planned_writes', v_w, 'recipe_planned_writes', v_rw);
end
$fn$;

-- ============================================================================
-- STEP 10. GRANTS (every new function revoked from public and anon by name, then exactly these grants)
-- ============================================================================
revoke all on function public.stock_items_page(uuid, uuid[], text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_item_used_in(uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_suppliers_page(uuid, uuid[], text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_supplier_detail(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_prices_page(uuid, uuid, text, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_needs_attention(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_paused_items(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_golive_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_import_check(uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_set_item_sites(uuid[], uuid[], jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_pause_items(uuid[], uuid[], date, date, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_change_prices(jsonb, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_cancel_dated_price(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_import_stage(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_import_commit(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_import_cancel(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_copy_site(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_order_rules(uuid, uuid, jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_copy_order_rules(uuid, uuid, uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_category(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_archive_category(uuid, integer, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_settings(uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_make_company_record(text, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_golive_step(uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_site_group(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_delete_site_group(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_suggest_change(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_resync_site(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_nightly_health(uuid) from public, anon, authenticated, service_role;
-- the internal helpers this file adds (owner only), by name
revoke all on function public.stock_co__d1_org_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__dow_of(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__derive_days(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__seed_order_rules(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__need_of(text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__need_version(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__need_max(text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__today(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__paused_now(uuid, uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__qty_in_base(uuid, numeric, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__unit_of_price(uuid, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__si_unit_cost(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__category_for(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__cant_order_off(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__enqueue_job(uuid, uuid, text, jsonb, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__read_scope(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__filter_uuid(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__filter_bool(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__filter_keys(jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d1_source() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__set_sites_at(uuid[], uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__pause_at(uuid[], uuid, boolean, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__day_begun(uuid, uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__price_plan(jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__dated_put(uuid, uuid, uuid, numeric, date, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__price_apply(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__following(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__apply_dated_prices(integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__import_check_row(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__import_apply(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__import_flush(uuid[], uuid[], text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__copy_site_step(uuid, uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__supplier_packs_step(uuid, uuid[], uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__supplier_rows_step(uuid, uuid[], uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__category_rename_step(uuid, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d1_step(bigint) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__items_of(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__org_site(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__clean_rules(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__put_rules(uuid, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- Every internal helper (the stock_co__ prefix, matched as a regular expression): revoked from every API
-- role. A revoke, never a drop. Then exactly the grants 0a and 0b gave back: stock_co__writer_ok (the 0b
-- lock triggers call it as the caller) and the three 0b lock trigger functions, to signed in logins and
-- the service role.
do $internals$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as sig, p.prokind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname ~ '^stock_co__'
     order by p.oid
  loop
    execute format('revoke all on %s %s from public, anon, authenticated, service_role',
                   case when v_fn.prokind = 'p' then 'procedure' else 'function' end, v_fn.sig);
  end loop;
end
$internals$;
grant execute on function public.stock_co__writer_ok() to authenticated, service_role;
grant execute on function public.stock_co__site_lock() to authenticated, service_role;
grant execute on function public.stock_co__site_price_lock() to authenticated, service_role;
grant execute on function public.stock_co__ledger_lock() to authenticated, service_role;

-- Signed in Back Office logins (each function checks who is asking and what they may change):
grant execute on function public.stock_items_page(uuid, uuid[], text, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_item_used_in(uuid, jsonb, integer) to authenticated;
grant execute on function public.stock_suppliers_page(uuid, uuid[], text, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_supplier_detail(uuid) to authenticated;
grant execute on function public.stock_prices_page(uuid, uuid, text, jsonb, integer) to authenticated;
grant execute on function public.stock_needs_attention(uuid, uuid[]) to authenticated;
grant execute on function public.stock_paused_items(uuid) to authenticated, service_role;
grant execute on function public.stock_golive_plan(uuid) to authenticated;
grant execute on function public.stock_import_check(uuid, jsonb, integer) to authenticated;
grant execute on function public.stock_set_item_sites(uuid[], uuid[], jsonb, text) to authenticated;
grant execute on function public.stock_pause_items(uuid[], uuid[], date, date, boolean, text) to authenticated;
grant execute on function public.stock_change_prices(jsonb, boolean, text) to authenticated;
grant execute on function public.stock_cancel_dated_price(uuid, text) to authenticated;
grant execute on function public.stock_import_stage(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.stock_import_commit(uuid, uuid[]) to authenticated;
grant execute on function public.stock_import_cancel(uuid) to authenticated;
grant execute on function public.stock_copy_site(uuid, uuid, text) to authenticated;
grant execute on function public.stock_save_order_rules(uuid, uuid, jsonb, integer, text) to authenticated;
grant execute on function public.stock_copy_order_rules(uuid, uuid, uuid[], text) to authenticated;
grant execute on function public.stock_save_category(jsonb, integer, text) to authenticated;
grant execute on function public.stock_archive_category(uuid, integer, boolean, text) to authenticated;
grant execute on function public.stock_save_settings(uuid, jsonb, integer) to authenticated;
grant execute on function public.stock_make_company_record(text, uuid, integer, text) to authenticated;
grant execute on function public.stock_save_golive_step(uuid, jsonb, integer) to authenticated;
grant execute on function public.stock_save_site_group(jsonb) to authenticated;
grant execute on function public.stock_delete_site_group(uuid) to authenticated;
grant execute on function public.stock_suggest_change(text, uuid, text) to authenticated;
grant execute on function public.stock_resync_site(uuid) to authenticated;
-- The service role only (the nightly run):
grant execute on function public.stock_nightly_health(uuid) to service_role;

-- The rebuilt bodies kept their live grants (create or replace keeps them); nothing that saves is open
-- to the anon key.
do $acl_check$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync|nightly)_'
          or p.proname ~ '^stock_co__')
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'The anon key can still run %. Nothing was changed. Send this line to Claude.', v_bad;
  end if;
end
$acl_check$;

notify pgrst, 'reload schema';

-- ============================================================================
-- STEP 11. THE LEVELS, PROVED (a dry run as a real manager login, rolled back)
-- ============================================================================
-- A live manager of a multi site company with Stock control null (Their sites) and a link to one of its
-- sites: renaming a company item there must be refused ('Not allowed: this is set by head office.') and
-- a par save at that site must pass. Both run inside a block that is always undone.
create temp table _stock_native1_dry (
  check_name  text primary key,
  outcome     text,
  sql_state   text,
  words       text,
  login_id    uuid,
  item_id     uuid
) on commit drop;

do $dry$
declare
  v_login uuid;
  v_loc uuid;
  v_item uuid;
  v_name text;
  v_rv integer;
  v_par numeric;
  v_state text;
  v_words text;
  v_detail text;
  v_state2 text;
  v_words2 text;
  v_detail2 text;
  v_res jsonb;
  v_out text;
begin
  select ul.user_id, ul.location_id, i.id, i.name, i.row_version, pl.par_level
    into v_login, v_loc, v_item, v_name, v_rv, v_par
    from public.user_locations ul
    join public.user_profiles p on p.id = ul.user_id
    join public.locations l on l.id = ul.location_id
    join public.stock_co_item_sites s on s.location_id = ul.location_id and s.on_here
    join public.stock_co_items i on i.id = s.item_id and i.archived_at is null and i.local_location_id is null
    left join public.par_levels pl on pl.location_id = s.location_id and pl.inventory_item_id = s.site_item_id
   where p.stock_control is null
     and coalesce(p.role, '') not in ('owner', 'super_admin')
     and p.org_id = l.org_id
     and (p.bo_sections is null or 'inventory' = any(p.bo_sections))
     and coalesce(l.status, 'active') = 'active'
     and ((select count(*) from public.locations l2 where l2.org_id = l.org_id and coalesce(l2.status, 'active') = 'active') >= 2
          or exists (select 1 from public.stock_co_settings cs where cs.org_id = l.org_id and cs.multi_since is not null))
   order by (ul.role = 'manager') desc nulls last, (p.role = 'manager') desc nulls last, ul.location_id, i.id, ul.user_id
   limit 1;
  if v_login is null then
    insert into _stock_native1_dry values ('levels', 'skipped (no such manager)', null, null, null, null);
    return;
  end if;

  -- 1. a company rename by that manager
  begin
    perform set_config('request.jwt.claims',
                       jsonb_build_object('role', 'authenticated', 'sub', v_login, 'aal', 'aal2', 'is_anonymous', false,
                                          'aud', 'authenticated')::text, true);
    set local role authenticated;
    perform public.stock_save_item(jsonb_build_object('id', v_item, 'location_id', v_loc, 'name', v_name || ' x'), null, v_rv, 'inventory');
    raise exception 'stock_native1 dry run reached its end' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_words = message_text;
  end;
  if v_state = 'P0001' and v_words = 'stock_native1 dry run reached its end' then
    raise exception 'The levels did NOT refuse a company change by a Their sites manager (item %, login %). Nothing was changed. Ask Claude.',
      v_item, v_login;
  end if;

  -- 2. a par save at that manager's own site
  begin
    perform set_config('request.jwt.claims',
                       jsonb_build_object('role', 'authenticated', 'sub', v_login, 'aal', 'aal2', 'is_anonymous', false,
                                          'aud', 'authenticated')::text, true);
    set local role authenticated;
    v_res := public.stock_save_item_site(v_item, v_loc, jsonb_build_object('par_level', v_par), null, 'inventory');
    raise exception 'stock_native1 dry run reached its end' using errcode = 'P0001', detail = coalesce(v_res ->> 'ok', 'no answer');
  exception when others then
    get stacked diagnostics v_state2 = returned_sqlstate, v_words2 = message_text, v_detail2 = pg_exception_detail;
  end;

  v_out := case
    when v_state = '42501' and v_words = 'Not allowed: this is set by head office.'
         and v_state2 = 'P0001' and v_words2 = 'stock_native1 dry run reached its end' and v_detail2 = 'true'
      then 'refused, par ok'
    else 'unclear: rename ' || coalesce(v_state, '') || ' ' || coalesce(v_words, '') || '; par ' || coalesce(v_state2, '') || ' '
         || coalesce(nullif(v_words2, 'stock_native1 dry run reached its end'), coalesce(v_detail2, '')) end;
  insert into _stock_native1_dry values ('levels', v_out, v_state, v_words, v_login, v_item);
end
$dry$;

-- ============================================================================
-- STEP 12. THE COMPARE: no site row and no login changed
-- ============================================================================
do $compare$
declare
  v_orgs uuid[];
  v_bad text;
begin
  select coalesce(array_agg(distinct s.location_id), '{}'::uuid[]) into v_orgs from _stock_native1_snap s;
  insert into _stock_native1_now (location_id, metric, value)
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
   where l.id = any (v_orgs) and l.id <> '00000000-0000-0000-0000-000000000000';
  insert into _stock_native1_now (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));
  select string_agg(coalesce(b.metric, a.metric) || ' at ' || coalesce(b.location_id, a.location_id)::text, ', ')
    into v_bad
    from _stock_native1_snap b
    full join _stock_native1_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.metric is null or b.metric is null
      or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_bad is not null then
    raise exception 'Drop 1 changed a site row or a login (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare$;

-- ============================================================================
-- VISIBLE CHECK (the SQL editor shows this last result; paste it back to Claude). One row per company that
-- holds stock. Expected live: a59a6d97 multi true, 12, 51, 4, 47, 10, 5, 0, 0; fcbddcfd multi false, 1, 1,
-- 0, 0, 0, 1, 0, 0; every row replaced_functions 24, new_functions 29, internals_open_to_api false,
-- anon_can_save false, levels_on 'refused, par ok', site_rows_changed 0, logins_changed false.
-- ============================================================================
select o.org_id,
       (select count(*) filter (where coalesce(l.status, 'active') = 'active') >= 2
               or exists (select 1 from public.stock_co_settings cs where cs.org_id = o.org_id and cs.multi_since is not null)
          from public.locations l where l.org_id = o.org_id) as multi,
       (select count(*) from public.stock_co_categories c where c.org_id = o.org_id) as categories_seeded,
       (select count(*) from public.stock_co_items i where i.org_id = o.org_id and i.category_id is not null) as items_with_category,
       (select count(*) from public.stock_co_items i where i.org_id = o.org_id and i.category_id is null) as items_without_category,
       (select count(*) from public.stock_order_rules r where r.org_id = o.org_id) as order_rules_seeded,
       (select count(*) from public.stock_order_rules r where r.org_id = o.org_id and r.order_by_time is null) as order_rules_without_order_by,
       (select s.value::integer from _stock_native1_seed s where s.org_id = o.org_id and s.metric = 'without_cutoff') as suppliers_without_cutoff,
       (select s.value::integer from _stock_native1_seed s where s.org_id = o.org_id and s.metric = 'bad_days') as bad_delivery_day_values,
       (select s.value::integer from _stock_native1_seed s where s.org_id = o.org_id and s.metric = 'round_trip_bad') as order_rules_round_trip_bad,
       (select count(*)::integer from public.stock_native_backup b
         where b.name like 'd1:%'
           and md5(btrim(regexp_replace((select p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace
                                          and p.proname = substr(b.name, 4) limit 1), '\s+', ' ', 'g'))) is distinct from b.md5) as replaced_functions,
       (select count(*)::integer from (values
          ('public.stock_items_page(uuid,uuid[],text,jsonb,jsonb,integer)'), ('public.stock_item_used_in(uuid,jsonb,integer)'),
          ('public.stock_suppliers_page(uuid,uuid[],text,jsonb,jsonb,integer)'), ('public.stock_supplier_detail(uuid)'),
          ('public.stock_prices_page(uuid,uuid,text,jsonb,integer)'), ('public.stock_needs_attention(uuid,uuid[])'),
          ('public.stock_paused_items(uuid)'), ('public.stock_golive_plan(uuid)'), ('public.stock_import_check(uuid,jsonb,integer)'),
          ('public.stock_set_item_sites(uuid[],uuid[],jsonb,text)'), ('public.stock_pause_items(uuid[],uuid[],date,date,boolean,text)'),
          ('public.stock_change_prices(jsonb,boolean,text)'), ('public.stock_cancel_dated_price(uuid,text)'),
          ('public.stock_import_stage(uuid,jsonb,jsonb)'), ('public.stock_import_commit(uuid,uuid[])'), ('public.stock_import_cancel(uuid)'),
          ('public.stock_copy_site(uuid,uuid,text)'), ('public.stock_save_order_rules(uuid,uuid,jsonb,integer,text)'),
          ('public.stock_copy_order_rules(uuid,uuid,uuid[],text)'), ('public.stock_save_category(jsonb,integer,text)'),
          ('public.stock_archive_category(uuid,integer,boolean,text)'), ('public.stock_save_settings(uuid,jsonb,integer)'),
          ('public.stock_make_company_record(text,uuid,integer,text)'), ('public.stock_save_golive_step(uuid,jsonb,integer)'),
          ('public.stock_save_site_group(jsonb)'), ('public.stock_delete_site_group(uuid)'), ('public.stock_suggest_change(text,uuid,text)'),
          ('public.stock_resync_site(uuid)'), ('public.stock_nightly_health(uuid)')) f(sig)
         where to_regprocedure(f.sig) is not null) as new_functions,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.proname ~ '^stock_co__'
                  and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock')
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync)_'
                  and has_function_privilege('anon', p.oid, 'execute')) as anon_can_save,
       (select d.outcome from _stock_native1_dry d where d.check_name = 'levels') as levels_on,
       (select count(*)::integer from _stock_native1_snap b join _stock_native1_now a on a.location_id = b.location_id and a.metric = b.metric
         where (a.value is distinct from b.value or a.txt is distinct from b.txt) and b.metric not like 'md5:%') as site_rows_changed,
       exists (select 1 from _stock_native1_snap b join _stock_native1_now a on a.location_id = b.location_id and a.metric = b.metric
                where b.metric like 'md5:%' and a.txt is distinct from b.txt) as logins_changed
  from (select distinct s.org_id from _stock_native1_seed s) o
 order by o.org_id;
