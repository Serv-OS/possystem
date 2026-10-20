-- 20261019c_OPS_stock_company.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261017 (Multi site menu), 20261018c (central stock) and          #
-- #  20261019b (stock Phase 0) first. One transaction: any error and nothing  #
-- #  changes. Safe to run twice. Run OUTSIDE UK service: five stock tables    #
-- #  get a new empty column, 15 lock triggers (3 on each) plus one on         #
-- #  locations, and one small index on packs (lock wait 3 s).                 #
-- ############################################################################
--
-- WHY (multi site stock plan, 18 Oct 2026, section 7 "Phase 1" and "Phase 1b", 4.1 to 4.3, 4.9 to
-- 4.11, 5.1 to 5.3, 6.2 and 6.4, 11.5 Phase 1, Appendices A and B): head office owns the stock
-- DEFINITIONS (items, packs, unit bridges, suppliers, supplier prices); each site keeps its FACTS (on
-- hand, cost, the ledger, pars, areas, counts, orders, invoices, waste, production, preferred
-- supplier). Publish writes the definitions into each site's normal stock rows BY THEIR OWN IDS, so
-- counts, ordering, transfers and reports read them exactly as today.
--
-- PETER'S RULE (19 Oct 2026): "if a site is multi site stock, multi site should be on". There is no
-- separate switch: when ServOS switches Shared stock on for a company, central stock depletion is on
-- at every one of its sites from that moment (stock_central_switch sets central_since), and every
-- site that joins the company later is central from the moment it joins. 20261019 already made every
-- venue central; this file keeps that and ties it to Shared stock too, with no manual step.
--
-- WHAT THIS FILE ADDS (additive: new tables, functions, columns and triggers; NO stock row is updated)
--   Site columns (empty): company_ref on inventory_items, item_packaging_formats,
--     inventory_item_conversions, suppliers, supplier_products; archived_at on the three that have
--     none (packs, unit bridges, supplier packs).
--   The switch and the people: stock_company, msm_stock_members (written only by the super admin
--     functions stock_admin_set_enabled and stock_admin_set_member, with the second step). Shared
--     stock needs the company on the Multi site menu first.
--   Company tables (msm_stock_*, msm_supplier*): items, packs, bridges, suppliers, supplier prices,
--     each with a per site table that keeps that site's own row id FOR EVER.
--   Its own drafts, versions, runner, History and Undo (msm_stock_drafts, msm_stock_changes,
--     msm_stock_versions, msm_stock_version_sites, msm_stock_version_rows,
--     msm_stock_version_company). The menu's msm change sets, runner and guard are NOT touched: no
--     msm menu table, function or trigger is created, replaced or altered here.
--   The planner and writer run INSIDE the database, set based, one site per transaction, driven by
--     pg_cron each minute (job msm-stock-run-due), with a 2 s lock wait (it gives way to sales and
--     tries again next minute). Publish defaults to 05:00 on each site's own clock; Publish now is
--     allowed. Only rows whose company columns changed are written; the busy items table is written
--     last. One before and after row per changed row (Undo).
--   The database lock on company rows at the sites: a site cannot change a company column, delete a
--     company row or forge a company row. The trigger has a WHEN clause on the company columns, so
--     the on hand update of every sale never fires it. Only the publish writer (its owner role in
--     this transaction) or the database itself (SQL editor, pg_cron) gets past it.
--   Start from a site (6.2): one set based call makes a site's rows the company list, with the zero
--     write self check. Link candidates and links (a site's own row joins a company row only when an
--     editor ticks it). CSV import (items, packs, prices) through a staging table in chunks of 2,000.
--   Server pages for the grids (100 items a page, each item's sites packed into one value).
--   Site side: msm_stock_site_status (Managed by head office, the Editors, what changed), the usual
--     six areas from head office, and the manager PIN on count approval (stock_approve_count_pin;
--     approve_stock_count is no longer open to Back Office logins directly; the service role keeps it
--     for the Manager app's manager-approve, which asks for a manager PIN on every count approval).
--   Cost after publish (plan 4.5): for the items whose supplier price a publish added or changed at a
--     site, that site's OWN cost rule runs in the same transaction: price list sites (the default)
--     follow the price; deliveries sites only for an item never received or with no cost. Never 0.
--     Undo puts the cost back while nothing has moved it since.
--
-- NEVER PUBLISHED OVER: on hand, current cost (only the site's own cost rule moves it, above), the
--   ledger, pars, areas (except a new item's first area), counts, orders, invoices, waste,
--   production, preferred supplier (set only when an item first reaches a site), a supplier's account number, order email, delivery days, cut off and
--   minimum order (set only when the supplier first reaches a site). Nothing is ever deleted at a
--   site by publish ("off here" archives); Undo deletes only the rows its own publish inserted and
--   nothing has used since.
--
-- ORDER FOR PETER
--   0. 20261019b (stock Phase 0) runs first: this file stops in words without it.
--   1. Merge v5.11.80 and deploy the app (the count screen asks for the manager PIN through the new
--      call and falls back to the old one while this file has not run). Reload every open Back
--      Office tab: a tab still on 5.11.79 cannot approve counts once this file has run.
--   2. Run this file on Ops, outside service. Read the check row at the bottom.
--   3. Deploy the manager-approve edge function (after 20261019b and this file): the phone's Count
--      stock reads company_ref and archived_at, which this file adds.
--   4. Company Admin: Shared stock on for the demo company, add yourself as stock Editor.
--
-- UNDO: 20261019c_OPS_stock_company_ROLLBACK.sql (drops only what this file made; site rows keep
--   their company_ref values harmlessly if any publish ran, the columns are dropped by the rollback).
--
-- Proof: supabase/tests/stock_company/run.mjs (local Postgres 17 with 20261018a, 20261018c, 20261019
--   and 20261019b applied as Peter ran them; the real roles and live timeouts).
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.msm_company') is null or to_regclass('public.msm_members') is null
     or to_regprocedure('public.msm__second_step_ok()') is null or to_regprocedure('public.msm__require_servos()') is null then
    raise exception 'Run 20261017_OPS_multi_site_menu.sql first (the Multi site menu). Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_central_switch(uuid,text,text)') is null or to_regclass('public.stock_depletion_mode') is null then
    raise exception 'Run 20261018c_OPS_central_stock_depletion.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_phase0_ready()') is null
     or to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)') is null
     or to_regprocedure('public.stock_office_reaches(uuid)') is null
     or to_regprocedure('public.stock_record_waste(uuid,jsonb,jsonb)') is null then
    raise exception 'Run 20261019b_OPS_stock_phase0.sql (v5.11.79) first. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'returns_to_shelf') then
    raise exception 'inventory_items.returns_to_shelf is missing (20261018c). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ============================================================================
-- 1. SITE COLUMNS (empty; no row is updated)
-- ============================================================================
do $cols$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items', 'company_ref', 'uuid', 'The company stock item this row is (multi site stock, 20261019c). Stamped only by publish or Start from a site. Null = the site''s own item.'),
      ('item_packaging_formats', 'company_ref', 'uuid', 'The company pack this row is (20261019c). Null = the site''s own pack.'),
      ('item_packaging_formats', 'archived_at', 'timestamptz', 'Pack switched off here (20261019c). Never deleted by publish; lists hide it.'),
      ('inventory_item_conversions', 'company_ref', 'uuid', 'The company unit bridge this row is (20261019c). Null = the site''s own bridge.'),
      ('inventory_item_conversions', 'archived_at', 'timestamptz', 'Unit bridge switched off here (20261019c). Never deleted by publish.'),
      ('suppliers', 'company_ref', 'uuid', 'The company supplier this row is (20261019c). Null = the site''s own supplier.'),
      ('supplier_products', 'company_ref', 'uuid', 'The company supplier price this row is (20261019c). Null = the site''s own price.'),
      ('supplier_products', 'archived_at', 'timestamptz', 'Supplier pack switched off here (20261019c). Never deleted by publish; lists hide it.')
    ) as t(tbl, col, typ, note)
  loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      execute format('alter table public.%I add column %I %s', r.tbl, r.col, r.typ);
      execute format('comment on column public.%I.%I is %L', r.tbl, r.col, r.note);
    end if;
  end loop;
end
$cols$;

do $idx$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items_company_ref_idx', 'inventory_items'),
      ('item_packaging_formats_company_ref_idx', 'item_packaging_formats'),
      ('inventory_item_conversions_company_ref_idx', 'inventory_item_conversions'),
      ('suppliers_company_ref_idx', 'suppliers'),
      ('supplier_products_company_ref_idx', 'supplier_products')
    ) as t(name, tbl)
  loop
    if to_regclass('public.' || r.name) is null then
      execute format('create index %I on public.%I (location_id, company_ref) where company_ref is not null', r.name, r.tbl);
    end if;
  end loop;
end
$idx$;

-- Indexes on the columns that point at a site's stock rows. Undo removes the rows its publish added
-- (5,000 items, packs and prices a site at the target scale), and each delete checks every table
-- that points at the row: without these, each check reads that whole table (the ledger included), so
-- one site's Undo took 90 s and more. Small tables today (the ledger has about 2,300 rows), so each
-- is made in a moment; a missing table is skipped.
do $fkidx$
declare
  r record;
begin
  for r in
    select * from (values
      ('stock_movements_item_fk_idx', 'stock_movements', 'inventory_item_id', null),
      ('stock_count_lines_item_fk_idx', 'stock_count_lines', 'inventory_item_id', null),
      ('par_levels_item_fk_idx', 'par_levels', 'inventory_item_id', null),
      ('po_lines_item_fk_idx', 'po_lines', 'inventory_item_id', 'inventory_item_id is not null'),
      ('po_lines_sp_fk_idx', 'po_lines', 'supplier_product_id', 'supplier_product_id is not null'),
      ('stock_transfer_lines_item_fk_idx', 'stock_transfer_lines', 'inventory_item_id', null),
      ('stock_transfer_lines_to_item_fk_idx', 'stock_transfer_lines', 'to_inventory_item_id', 'to_inventory_item_id is not null'),
      ('waste_events_item_fk_idx', 'waste_events', 'inventory_item_id', 'inventory_item_id is not null'),
      ('supplier_invoice_lines_item_fk_idx', 'supplier_invoice_lines', 'matched_item_id', 'matched_item_id is not null'),
      ('item_cost_history_sp_fk_idx', 'item_cost_history', 'supplier_product_id', 'supplier_product_id is not null'),
      ('item_pack_fmt_parent_idx', 'item_packaging_formats', 'parent_format_id', 'parent_format_id is not null'),
      ('purchase_orders_supplier_fk_idx', 'purchase_orders', 'supplier_id', 'supplier_id is not null'),
      ('supplier_invoices_supplier_fk_idx', 'supplier_invoices', 'supplier_id', 'supplier_id is not null'),
      ('deliveries_supplier_fk_idx', 'deliveries', 'supplier_id', 'supplier_id is not null'),
      ('recipe_lines_loc_unit_idx', 'recipe_lines', 'location_id, unit', null)
    ) as t(name, tbl, cols, pred)
  loop
    if to_regclass('public.' || r.tbl) is not null and to_regclass('public.' || r.name) is null
       and not exists (select 1 from unnest(string_to_array(replace(r.cols, ' ', ''), ',')) c
                        where not exists (select 1 from information_schema.columns x where x.table_schema = 'public' and x.table_name = r.tbl and x.column_name = c)) then
      execute format('create index %I on public.%I (%s)%s', r.name, r.tbl, r.cols, coalesce(' where ' || r.pred, ''));
    end if;
  end loop;
end
$fkidx$;

-- ============================================================================
-- 2. TABLES
-- ============================================================================

-- The company switch. Not an organisations column (owners can update organisations).
create table if not exists public.stock_company (
  org_id      uuid primary key references public.organisations(id) on delete cascade,
  enabled     boolean not null default false,
  enabled_by  uuid,
  enabled_at  timestamptz,
  updated_at  timestamptz not null default now()
);
comment on table public.stock_company is 'Shared stock (multi site stock, 20261019c): is the company switched on. Written only by stock_admin_set_enabled (ServOS, second step). Needs msm_company on.';

create table if not exists public.msm_stock_members (
  org_id    uuid not null references public.organisations(id) on delete cascade,
  user_id   uuid not null,
  role      text not null check (role in ('editor', 'viewer')),
  added_by  uuid,
  added_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
comment on table public.msm_stock_members is 'Shared stock Editors and Viewers, a separate list from the menu people. Written only by stock_admin_set_member. Owners are not added automatically.';

create table if not exists public.msm_stock_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  name               text not null check (btrim(name) <> ''),
  category           text,
  accounting_group   text,
  base_unit          text not null references public.stock_units(code),
  allergens          jsonb not null default '[]'::jsonb,
  sku                text,
  barcode            text,
  shelf_life_days    integer check (shelf_life_days is null or shelf_life_days >= 0),
  purchase_tax_rate  numeric(8,6) check (purchase_tax_rate is null or (purchase_tax_rate >= 0 and purchase_tax_rate < 1)),
  default_area_kind  text,
  returns_to_shelf   boolean not null default false,
  notes              text,
  all_sites          boolean not null default false,
  archived           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
create index if not exists msm_stock_items_org_name on public.msm_stock_items (org_id, lower(name), id);
create index if not exists msm_stock_items_org_sku on public.msm_stock_items (org_id, lower(sku)) where sku is not null;
create index if not exists msm_stock_items_org_barcode on public.msm_stock_items (org_id, barcode) where barcode is not null;

create table if not exists public.msm_stock_item_sites (
  item_id        uuid not null references public.msm_stock_items(id) on delete cascade,
  org_id         uuid not null,
  location_id    uuid not null references public.locations(id) on delete cascade,
  venue_item_id  uuid,
  active         boolean,                       -- null = follows the item's every site switch
  made_here      boolean not null default false,
  kept           jsonb not null default '{}'::jsonb,
  unlinked_at    timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (item_id, location_id)
);
create unique index if not exists msm_stock_item_sites_venue on public.msm_stock_item_sites (location_id, venue_item_id) where venue_item_id is not null;
create index if not exists msm_stock_item_sites_org on public.msm_stock_item_sites (org_id, location_id);

create table if not exists public.msm_stock_packs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  item_id              uuid not null references public.msm_stock_items(id) on delete cascade,
  name                 text not null check (btrim(name) <> ''),
  qty_in_base          numeric(14,4) not null check (qty_in_base > 0),
  parent_pack_id       uuid references public.msm_stock_packs(id) on delete set null,
  is_count_default     boolean not null default false,
  is_purchase_default  boolean not null default false,
  archived             boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists msm_stock_packs_org on public.msm_stock_packs (org_id, item_id);

create table if not exists public.msm_stock_pack_sites (
  pack_id          uuid not null references public.msm_stock_packs(id) on delete cascade,
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  venue_format_id  uuid,
  off              boolean not null default false,
  unlinked_at      timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (pack_id, location_id)
);
create unique index if not exists msm_stock_pack_sites_venue on public.msm_stock_pack_sites (location_id, venue_format_id) where venue_format_id is not null;
create index if not exists msm_stock_pack_sites_org on public.msm_stock_pack_sites (org_id, location_id);

create table if not exists public.msm_stock_bridges (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  item_id    uuid not null references public.msm_stock_items(id) on delete cascade,
  from_qty   numeric(14,4) not null check (from_qty > 0),
  from_unit  text not null references public.stock_units(code),
  to_qty     numeric(14,4) not null check (to_qty > 0),
  to_unit    text not null references public.stock_units(code),
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists msm_stock_bridges_org on public.msm_stock_bridges (org_id, item_id);

create table if not exists public.msm_stock_bridge_sites (
  bridge_id            uuid not null references public.msm_stock_bridges(id) on delete cascade,
  org_id               uuid not null,
  location_id          uuid not null references public.locations(id) on delete cascade,
  venue_conversion_id  uuid,
  off                  boolean not null default false,
  unlinked_at          timestamptz,
  updated_at           timestamptz not null default now(),
  primary key (bridge_id, location_id)
);
create unique index if not exists msm_stock_bridge_sites_venue on public.msm_stock_bridge_sites (location_id, venue_conversion_id) where venue_conversion_id is not null;
create index if not exists msm_stock_bridge_sites_org on public.msm_stock_bridge_sites (org_id, location_id);

create table if not exists public.msm_suppliers (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  name                text not null check (btrim(name) <> ''),
  contact_name        text,
  contact_email       text,
  phone               text,
  payment_terms_days  integer check (payment_terms_days is null or payment_terms_days >= 0),
  notes               text,
  all_sites           boolean not null default false,
  archived            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists msm_suppliers_org_name on public.msm_suppliers (org_id, lower(name), id);

create table if not exists public.msm_supplier_sites (
  supplier_id        uuid not null references public.msm_suppliers(id) on delete cascade,
  org_id             uuid not null,
  location_id        uuid not null references public.locations(id) on delete cascade,
  venue_supplier_id  uuid,
  active             boolean,                   -- null = follows the supplier's every site switch
  account_number     text,
  order_email        text,
  delivery_days      jsonb,
  cutoff_time        text,
  min_order_value    numeric(12,2),
  unlinked_at        timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (supplier_id, location_id)
);
create unique index if not exists msm_supplier_sites_venue on public.msm_supplier_sites (location_id, venue_supplier_id) where venue_supplier_id is not null;
create index if not exists msm_supplier_sites_org on public.msm_supplier_sites (org_id, location_id);

create table if not exists public.msm_supplier_products (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  supplier_id         uuid not null references public.msm_suppliers(id) on delete cascade,
  item_id             uuid not null references public.msm_stock_items(id) on delete cascade,
  supplier_sku        text,
  pack_description    text,
  pack_qty            numeric(14,4) not null default 1 check (pack_qty > 0),
  inner_qty           numeric(14,4) not null default 1 check (inner_qty > 0),
  inner_unit          text not null references public.stock_units(code),
  pack_price          numeric(12,4) not null check (pack_price >= 0),
  price_includes_tax  boolean not null default false,
  purchase_tax_rate   numeric(8,6) check (purchase_tax_rate is null or (purchase_tax_rate >= 0 and purchase_tax_rate < 1)),
  first_choice        boolean not null default false,
  archived            boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists msm_supplier_products_org on public.msm_supplier_products (org_id, supplier_id);
create index if not exists msm_supplier_products_item on public.msm_supplier_products (org_id, item_id);

create table if not exists public.msm_supplier_product_sites (
  sp_id                      uuid not null references public.msm_supplier_products(id) on delete cascade,
  org_id                     uuid not null,
  location_id                uuid not null references public.locations(id) on delete cascade,
  venue_supplier_product_id  uuid,
  off                        boolean not null default false,
  pack_price                 numeric(12,4) check (pack_price is null or pack_price >= 0),
  unlinked_at                timestamptz,
  updated_at                 timestamptz not null default now(),
  primary key (sp_id, location_id)
);
create unique index if not exists msm_supplier_product_sites_venue on public.msm_supplier_product_sites (location_id, venue_supplier_product_id) where venue_supplier_product_id is not null;
create index if not exists msm_supplier_product_sites_org on public.msm_supplier_product_sites (org_id, location_id);

-- Drafts: one open draft per company; changes merge per (target, entity, site).
create table if not exists public.msm_stock_drafts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  status      text not null default 'open' check (status in ('open', 'published', 'discarded')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists msm_stock_drafts_one_open on public.msm_stock_drafts (org_id) where status = 'open';

create table if not exists public.msm_stock_changes (
  id            uuid primary key default gen_random_uuid(),
  draft_id      uuid not null references public.msm_stock_drafts(id) on delete cascade,
  org_id        uuid not null,
  target        text not null check (target in ('item', 'item_site', 'pack', 'pack_site', 'bridge', 'bridge_site',
                                                 'supplier', 'supplier_site', 'sp', 'sp_site')),
  entity_id     uuid not null,
  location_id   uuid,
  location_key  uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  data          jsonb not null default '{}'::jsonb,
  created_by    uuid,
  updated_at    timestamptz not null default now()
);
create unique index if not exists msm_stock_changes_one_row on public.msm_stock_changes (draft_id, target, entity_id, location_key);
create index if not exists msm_stock_changes_org on public.msm_stock_changes (org_id, draft_id);

create table if not exists public.msm_stock_versions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  version_no       integer not null,
  kind             text not null check (kind in ('publish', 'start', 'undo', 'keep')),
  draft_id         uuid,
  undo_of          uuid references public.msm_stock_versions(id) on delete set null,
  status           text not null default 'waiting' check (status in ('waiting', 'done', 'failed', 'undone')),
  run_mode         text not null default 'night' check (run_mode in ('now', 'night')),
  note             text,
  summary          jsonb not null default '{}'::jsonb,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create unique index if not exists msm_stock_versions_no on public.msm_stock_versions (org_id, version_no);

create table if not exists public.msm_stock_version_sites (
  id           bigint generated always as identity primary key,
  version_id   uuid not null references public.msm_stock_versions(id) on delete cascade,
  org_id       uuid not null,
  location_id  uuid not null,
  status       text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'nothing', 'failed', 'cancelled')),
  due_at       timestamptz not null default now(),
  attempts     integer not null default 0,
  writes       integer not null default 0,
  counts       jsonb not null default '{}'::jsonb,
  last_error   text,
  started_at   timestamptz,
  done_at      timestamptz,
  unique (version_id, location_id)
);
create index if not exists msm_stock_version_sites_due on public.msm_stock_version_sites (status, due_at) where status = 'waiting';
create index if not exists msm_stock_version_sites_org on public.msm_stock_version_sites (org_id, location_id, done_at desc);

-- One row per changed site row (11.5 Phase 1 item 3: never one blob per site).
create table if not exists public.msm_stock_version_rows (
  version_id   uuid not null references public.msm_stock_versions(id) on delete cascade,
  location_id  uuid not null,
  tbl          text not null,
  row_id       uuid not null,
  op           text not null check (op in ('insert', 'update', 'link', 'unlink', 'restore', 'delete', 'archive')),
  before       jsonb,
  after        jsonb,
  primary key (version_id, location_id, tbl, row_id)
);

-- Company rows a version changed (Undo restores them exactly).
create table if not exists public.msm_stock_version_company (
  version_id    uuid not null references public.msm_stock_versions(id) on delete cascade,
  tbl           text not null,
  entity_id     uuid not null,
  location_key  uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  op            text not null check (op in ('insert', 'update')),
  before        jsonb,
  primary key (version_id, tbl, entity_id, location_key)
);

-- CSV import staging (chunks of 2,000 rows).
create table if not exists public.msm_stock_import_rows (
  import_id   uuid not null,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  kind        text not null check (kind in ('items', 'packs', 'prices')),
  row_no      integer not null,
  data        jsonb not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (import_id, row_no)
);
create index if not exists msm_stock_import_rows_org on public.msm_stock_import_rows (org_id, import_id);

-- Wrong manager PINs at count approval (5 in 15 minutes and the login waits).
create table if not exists public.stock_pin_tries (
  id           bigint generated always as identity primary key,
  user_id      uuid,
  location_id  uuid not null,
  tried_at     timestamptz not null default now()
);
create index if not exists stock_pin_tries_recent on public.stock_pin_tries (location_id, user_id, tried_at desc);

-- ============================================================================
-- 3. GUARDS ON THE COMPANY TABLES
-- ============================================================================

-- A company row's parent belongs to the same company; a site row's venue belongs to the company.
create or replace function public.msm_stock_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org uuid;
begin
  if tg_table_name in ('msm_stock_packs', 'msm_stock_bridges') then
    select i.org_id into v_org from msm_stock_items i where i.id = new.item_id;
    if v_org is distinct from new.org_id then raise exception 'That stock item is not in this company.' using errcode = '22023'; end if;
    if tg_table_name = 'msm_stock_packs' then
      if new.parent_pack_id is not null
         and not exists (select 1 from msm_stock_packs p where p.id = new.parent_pack_id and p.item_id = new.item_id) then
        raise exception 'A pack can only sit inside a pack of the same item.' using errcode = '22023';
      end if;
    end if;
  elsif tg_table_name = 'msm_supplier_products' then
    if not exists (select 1 from msm_stock_items i where i.id = new.item_id and i.org_id = new.org_id)
       or not exists (select 1 from msm_suppliers s where s.id = new.supplier_id and s.org_id = new.org_id) then
      raise exception 'That item or supplier is not in this company.' using errcode = '22023';
    end if;
  else
    if tg_table_name = 'msm_stock_item_sites' then
      select i.org_id into v_org from msm_stock_items i where i.id = new.item_id;
    elsif tg_table_name = 'msm_stock_pack_sites' then
      select p.org_id into v_org from msm_stock_packs p where p.id = new.pack_id;
    elsif tg_table_name = 'msm_stock_bridge_sites' then
      select b.org_id into v_org from msm_stock_bridges b where b.id = new.bridge_id;
    elsif tg_table_name = 'msm_supplier_sites' then
      select s.org_id into v_org from msm_suppliers s where s.id = new.supplier_id;
    elsif tg_table_name = 'msm_supplier_product_sites' then
      select s.org_id into v_org from msm_supplier_products s where s.id = new.sp_id;
    else
      raise exception 'msm_stock_org_guard: not for table %', tg_table_name;
    end if;
    if v_org is null or v_org is distinct from new.org_id
       or not exists (select 1 from locations l where l.id = new.location_id and l.org_id = v_org) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

do $guards$
declare
  t text;
begin
  foreach t in array array['msm_stock_packs', 'msm_stock_bridges', 'msm_supplier_products', 'msm_stock_item_sites',
                           'msm_stock_pack_sites', 'msm_stock_bridge_sites', 'msm_supplier_sites', 'msm_supplier_product_sites'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'msm_stock_org_guard') then
      execute format('create trigger msm_stock_org_guard before insert or update on public.%I for each row execute function public.msm_stock_org_guard()', t);
    end if;
  end loop;
end
$guards$;

-- Base unit lock. Quantities at a site carry no unit of their own (on hand, the ledger, count lines
-- of any status, pars, open orders and transfers, the site's own packs are all in the base unit), so
-- once a site row is in use its base unit stays. msm_stock__site_item_in_use: one site row;
-- msm_stock__unit_in_use: any linked site row of a company item that is not in p_unit already (p_unit
-- null: any). The company lock, the writer and the health check share it; Undo, or a publish back to
-- a site's own unit, passes while no site row in use would change.
create or replace function public.msm_stock__site_item_in_use(p_loc uuid, p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from inventory_items t where t.id = p_item and t.location_id = p_loc and coalesce(t.on_hand, 0) <> 0)
      or exists (select 1 from stock_movements m where m.location_id = p_loc and m.inventory_item_id = p_item)
      or exists (select 1 from stock_count_lines l where l.location_id = p_loc and l.inventory_item_id = p_item)
      or exists (select 1 from par_levels pl where pl.location_id = p_loc and pl.inventory_item_id = p_item)
      or exists (select 1 from po_lines l where l.inventory_item_id = p_item)
      or exists (select 1 from stock_transfer_lines l where l.inventory_item_id = p_item or l.to_inventory_item_id = p_item)
      or exists (select 1 from item_packaging_formats x where x.inventory_item_id = p_item and x.location_id = p_loc
                  and x.company_ref is null and x.archived_at is null);
$fn$;

create or replace function public.msm_stock__unit_in_use(p_item uuid, p_unit text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from msm_stock_item_sites s
                   join inventory_items t on t.id = s.venue_item_id and t.location_id = s.location_id
                  where s.item_id = p_item and s.venue_item_id is not null and s.unlinked_at is null
                    and t.base_unit is distinct from p_unit
                    and public.msm_stock__site_item_in_use(s.location_id, t.id));
$fn$;

create or replace function public.msm_stock_base_unit_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.base_unit is distinct from old.base_unit and public.msm_stock__unit_in_use(old.id, new.base_unit) then
    raise exception '% has stock, counts, pars or orders in % at a site, so its base unit cannot change to %. Make a new item instead.',
      old.name, old.base_unit, new.base_unit using errcode = '55000';
  end if;
  return new;
end
$fn$;
do $bu$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.msm_stock_items'::regclass and tgname = 'msm_stock_base_unit_lock') then
    create trigger msm_stock_base_unit_lock before update of base_unit on public.msm_stock_items
      for each row execute function public.msm_stock_base_unit_lock();
  end if;
end
$bu$;

-- ============================================================================
-- 4. WHO MAY SEE AND EDIT
-- ============================================================================

create or replace function public.msm_stock_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.role
    from public.msm_stock_members m
    join public.stock_company c on c.org_id = m.org_id and c.enabled
   where m.org_id = p_org and m.user_id = auth.uid() and not public.is_anon_session();
$fn$;

create or replace function public.msm_stock_viewable_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.org_id
    from public.msm_stock_members m
    join public.stock_company c on c.org_id = m.org_id and c.enabled
   where m.user_id = auth.uid() and not public.is_anon_session()
  union
  select c.org_id from public.stock_company c where public.is_super_admin();
$fn$;

create or replace function public.msm_stock_member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.org_id from public.msm_stock_members m where m.user_id = auth.uid() and not public.is_anon_session();
$fn$;

-- The company is on for stock: Shared stock AND the Multi site menu.
create or replace function public.msm_stock__company_on(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((select c.enabled from stock_company c where c.org_id = p_org), false)
     and coalesce((select m.enabled from msm_company m where m.org_id = p_org), false);
$fn$;

create or replace function public.msm_stock__require_viewer(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to use Multi site stock.' using errcode = '42501';
  end if;
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step first.' using errcode = '42501';
  end if;
  if p_org is null or not (p_org in (select public.msm_stock_viewable_org_ids())) then
    raise exception 'Only people ServOS added to Shared stock can open it.' using errcode = '42501';
  end if;
end
$fn$;

create or replace function public.msm_stock__require_editor(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to use Multi site stock.' using errcode = '42501';
  end if;
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step before you can change company stock.' using errcode = '42501';
  end if;
  if coalesce(public.msm_stock_role(p_org), '') <> 'editor' then
    raise exception 'Only people ServOS added as a stock Editor can change company stock.' using errcode = '42501';
  end if;
  if not coalesce((select m.enabled from msm_company m where m.org_id = p_org), false) then
    raise exception 'Shared stock needs the Multi site menu switched on for this company. Nothing was changed.' using errcode = '55000';
  end if;
end
$fn$;

create or replace function public.msm_stock__venue_in_org(p_loc uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from locations l where l.id = p_loc and l.org_id = p_org);
$fn$;

-- Names of the stock Editors of a venue's company (for "ask head office").
create or replace function public.msm_stock__editor_names(p_loc uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select string_agg(coalesce(nullif(btrim(p.full_name), ''), p.email, 'an editor'), ', ' order by coalesce(p.full_name, p.email))
    from locations l
    join stock_company c on c.org_id = l.org_id and c.enabled
    join msm_stock_members m on m.org_id = l.org_id and m.role = 'editor'
    left join user_profiles p on p.id = m.user_id
   where l.id = p_loc
     and (public.stock_caller_reaches(p_loc) or public._stock_caller_is_system());
$fn$;

-- ============================================================================
-- 5. ROW LEVEL SECURITY AND GRANTS
-- ============================================================================
do $rls$
declare
  t text;
begin
  foreach t in array array['stock_company', 'msm_stock_members', 'msm_stock_items', 'msm_stock_item_sites', 'msm_stock_packs',
                           'msm_stock_pack_sites', 'msm_stock_bridges', 'msm_stock_bridge_sites', 'msm_suppliers', 'msm_supplier_sites',
                           'msm_supplier_products', 'msm_supplier_product_sites', 'msm_stock_drafts', 'msm_stock_changes',
                           'msm_stock_versions', 'msm_stock_version_sites', 'msm_stock_version_rows', 'msm_stock_version_company',
                           'msm_stock_import_rows', 'stock_pin_tries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    if t not in ('stock_pin_tries', 'msm_stock_import_rows') then
      execute format('grant select on table public.%I to authenticated, service_role', t);
    end if;
  end loop;
end
$rls$;

drop policy if exists stock_company_read on public.stock_company;
create policy stock_company_read on public.stock_company as permissive for select to authenticated
  using (org_id in (select public.msm_stock_member_org_ids()) or (select public.is_super_admin()));
drop policy if exists msm_stock_members_read on public.msm_stock_members;
create policy msm_stock_members_read on public.msm_stock_members as permissive for select to authenticated
  using (user_id = (select auth.uid()) or org_id in (select public.msm_stock_viewable_org_ids()));

do $read$
declare
  t text;
begin
  foreach t in array array['msm_stock_items', 'msm_stock_item_sites', 'msm_stock_packs', 'msm_stock_pack_sites', 'msm_stock_bridges',
                           'msm_stock_bridge_sites', 'msm_suppliers', 'msm_supplier_sites', 'msm_supplier_products',
                           'msm_supplier_product_sites', 'msm_stock_drafts', 'msm_stock_changes', 'msm_stock_versions',
                           'msm_stock_version_sites', 'msm_stock_version_rows'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    if t = 'msm_stock_version_rows' then
      execute format('create policy %I on public.%I as permissive for select to authenticated using (version_id in (select v.id from public.msm_stock_versions v where v.org_id in (select public.msm_stock_viewable_org_ids())))', t || '_read', t);
    else
      execute format('create policy %I on public.%I as permissive for select to authenticated using (org_id in (select public.msm_stock_viewable_org_ids()))', t || '_read', t);
    end if;
  end loop;
end
$read$;

-- The second sign in step, as on every other table (20260919s). Skipped when that file has not run.
do $second_step$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['stock_company', 'msm_stock_members', 'msm_stock_items', 'msm_stock_item_sites', 'msm_stock_packs',
                           'msm_stock_pack_sites', 'msm_stock_bridges', 'msm_stock_bridge_sites', 'msm_suppliers', 'msm_supplier_sites',
                           'msm_supplier_products', 'msm_supplier_product_sites', 'msm_stock_drafts', 'msm_stock_changes',
                           'msm_stock_versions', 'msm_stock_version_sites', 'msm_stock_version_rows'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$second_step$;

-- ============================================================================
-- 6. THE LOCK ON COMPANY ROWS AT THE SITES
-- ============================================================================
-- Gets past the lock: the publish writer in THIS transaction (it sets servos.stock_publish to the
-- transaction id and runs as the owner role, postgres), or the database itself (SQL editor, pg_cron:
-- no request claims and not logged in through the API). A client can set the setting but cannot be
-- postgres inside the API, and every other definer function of postgres leaves the setting unset.
create or replace function public.msm_stock__writer_ok()
returns boolean
language sql
volatile
set search_path = public
as $fn$
  select (coalesce(current_setting('servos.stock_publish', true), '') = txid_current()::text and current_user = 'postgres')
      or (session_user::text not in ('authenticator', 'anon', 'authenticated', 'service_role')
          and coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = '');
$fn$;

-- INVOKER on purpose: current_user is the caller's role here.
create or replace function public.msm_stock_site_lock()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_loc uuid := case when tg_op = 'DELETE' then old.location_id else new.location_id end;
  v_who text;
begin
  if public.msm_stock__writer_ok() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_who := public.msm_stock__editor_names(v_loc);
  if tg_op = 'INSERT' then
    raise exception 'Only head office publishing can add a company stock row here.' using errcode = '42501';
  end if;
  raise exception 'Managed by head office: % cannot be % here. Ask a stock Editor (%) to change it in Multi site stock. Par, area, notes and the preferred supplier still save here.',
    case tg_table_name when 'inventory_items' then 'this stock item' when 'item_packaging_formats' then 'this pack'
                       when 'inventory_item_conversions' then 'this unit bridge' when 'suppliers' then 'this supplier'
                       else 'this supplier price' end,
    case when tg_op = 'DELETE' then 'deleted' else 'changed' end,
    coalesce(v_who, 'head office')
    using errcode = '42501';
end
$fn$;

do $lock$
begin
  -- inventory_items: the sale's on hand update never fires it (WHEN on company columns only)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'msm_stock_lock_upd') then
    create trigger msm_stock_lock_upd before update on public.inventory_items for each row
      when ((old.company_ref is not null or new.company_ref is not null) and
            (old.company_ref, old.location_id, old.name, old.category, old.accounting_group, old.base_unit, old.allergens, old.sku,
             old.barcode, old.shelf_life_days, old.returns_to_shelf, old.purchase_tax_rate_id, old.archived_at)
            is distinct from
            (new.company_ref, new.location_id, new.name, new.category, new.accounting_group, new.base_unit, new.allergens, new.sku,
             new.barcode, new.shelf_life_days, new.returns_to_shelf, new.purchase_tax_rate_id, new.archived_at))
      execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'msm_stock_lock_ins') then
    create trigger msm_stock_lock_ins before insert on public.inventory_items for each row
      when (new.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'msm_stock_lock_del') then
    create trigger msm_stock_lock_del before delete on public.inventory_items for each row
      when (old.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.item_packaging_formats'::regclass and tgname = 'msm_stock_lock_upd') then
    create trigger msm_stock_lock_upd before update on public.item_packaging_formats for each row
      when ((old.company_ref is not null or new.company_ref is not null) and
            (old.company_ref, old.location_id, old.inventory_item_id, old.name, old.qty_in_base, old.parent_format_id,
             old.is_count_default, old.is_purchase_default, old.archived_at)
            is distinct from
            (new.company_ref, new.location_id, new.inventory_item_id, new.name, new.qty_in_base, new.parent_format_id,
             new.is_count_default, new.is_purchase_default, new.archived_at))
      execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.item_packaging_formats'::regclass and tgname = 'msm_stock_lock_ins') then
    create trigger msm_stock_lock_ins before insert on public.item_packaging_formats for each row
      when (new.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.item_packaging_formats'::regclass and tgname = 'msm_stock_lock_del') then
    create trigger msm_stock_lock_del before delete on public.item_packaging_formats for each row
      when (old.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_item_conversions'::regclass and tgname = 'msm_stock_lock_upd') then
    create trigger msm_stock_lock_upd before update on public.inventory_item_conversions for each row
      when ((old.company_ref is not null or new.company_ref is not null) and
            (old.company_ref, old.location_id, old.inventory_item_id, old.from_qty, old.from_unit, old.to_qty, old.to_unit, old.archived_at)
            is distinct from
            (new.company_ref, new.location_id, new.inventory_item_id, new.from_qty, new.from_unit, new.to_qty, new.to_unit, new.archived_at))
      execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_item_conversions'::regclass and tgname = 'msm_stock_lock_ins') then
    create trigger msm_stock_lock_ins before insert on public.inventory_item_conversions for each row
      when (new.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_item_conversions'::regclass and tgname = 'msm_stock_lock_del') then
    create trigger msm_stock_lock_del before delete on public.inventory_item_conversions for each row
      when (old.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.suppliers'::regclass and tgname = 'msm_stock_lock_upd') then
    create trigger msm_stock_lock_upd before update on public.suppliers for each row
      when ((old.company_ref is not null or new.company_ref is not null) and
            (old.company_ref, old.location_id, old.name, old.contact_name, old.phone, old.payment_terms_days, old.archived_at)
            is distinct from
            (new.company_ref, new.location_id, new.name, new.contact_name, new.phone, new.payment_terms_days, new.archived_at))
      execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.suppliers'::regclass and tgname = 'msm_stock_lock_ins') then
    create trigger msm_stock_lock_ins before insert on public.suppliers for each row
      when (new.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.suppliers'::regclass and tgname = 'msm_stock_lock_del') then
    create trigger msm_stock_lock_del before delete on public.suppliers for each row
      when (old.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.supplier_products'::regclass and tgname = 'msm_stock_lock_upd') then
    create trigger msm_stock_lock_upd before update on public.supplier_products for each row
      when ((old.company_ref is not null or new.company_ref is not null) and
            (old.company_ref, old.location_id, old.supplier_id, old.inventory_item_id, old.supplier_sku, old.pack_description, old.pack_qty,
             old.inner_qty, old.inner_unit, old.pack_price, old.price_includes_tax, old.purchase_tax_rate_id, old.archived_at)
            is distinct from
            (new.company_ref, new.location_id, new.supplier_id, new.inventory_item_id, new.supplier_sku, new.pack_description, new.pack_qty,
             new.inner_qty, new.inner_unit, new.pack_price, new.price_includes_tax, new.purchase_tax_rate_id, new.archived_at))
      execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.supplier_products'::regclass and tgname = 'msm_stock_lock_ins') then
    create trigger msm_stock_lock_ins before insert on public.supplier_products for each row
      when (new.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.supplier_products'::regclass and tgname = 'msm_stock_lock_del') then
    create trigger msm_stock_lock_del before delete on public.supplier_products for each row
      when (old.company_ref is not null) execute function public.msm_stock_site_lock();
  end if;
end
$lock$;

-- The company columns of each site table (before and after images, Undo).
create or replace function public.msm_stock__cols(p_tbl text)
returns text[]
language sql
immutable
as $fn$
  select case p_tbl
    when 'inventory_items' then array['company_ref', 'name', 'category', 'accounting_group', 'base_unit', 'allergens', 'sku', 'barcode',
                                      'shelf_life_days', 'returns_to_shelf', 'purchase_tax_rate_id', 'archived_at', 'updated_at']
    when 'item_packaging_formats' then array['company_ref', 'inventory_item_id', 'name', 'qty_in_base', 'parent_format_id',
                                             'is_count_default', 'is_purchase_default', 'archived_at']
    when 'inventory_item_conversions' then array['company_ref', 'inventory_item_id', 'from_qty', 'from_unit', 'to_qty', 'to_unit', 'archived_at']
    when 'suppliers' then array['company_ref', 'name', 'contact_name', 'phone', 'payment_terms_days', 'archived_at', 'updated_at']
    when 'supplier_products' then array['company_ref', 'supplier_id', 'inventory_item_id', 'supplier_sku', 'pack_description', 'pack_qty',
                                        'inner_qty', 'inner_unit', 'pack_price', 'price_includes_tax', 'purchase_tax_rate_id', 'archived_at', 'updated_at']
    else null end;
$fn$;

create or replace function public.msm_stock__pick(p jsonb, p_keys text[])
returns jsonb
language sql
immutable
as $fn$
  select coalesce(jsonb_object_agg(k, p -> k), '{}'::jsonb) from unnest(p_keys) k where p ? k;
$fn$;

-- ============================================================================
-- 7. SERVOS: THE SWITCH, THE PEOPLE, AND CENTRAL STOCK AT EVERY SITE
-- ============================================================================

create or replace function public.stock_admin_status(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform public.msm__require_servos();
  return jsonb_build_object(
    'org_id', p_org,
    'enabled', coalesce((select c.enabled from stock_company c where c.org_id = p_org), false),
    'enabled_at', (select c.enabled_at from stock_company c where c.org_id = p_org),
    'menu_enabled', coalesce((select m.enabled from msm_company m where m.org_id = p_org), false),
    'sites', (select count(*) from locations l where l.org_id = p_org),
    'sites_central', (select count(*) from locations l join stock_depletion_mode d on d.location_id = l.id
                       where l.org_id = p_org and d.mode = 'central'),
    'sites_paused', (select count(*) from locations l join stock_depletion_mode d on d.location_id = l.id
                      where l.org_id = p_org and d.mode = 'paused'),
    'items', (select count(*) from msm_stock_items i where i.org_id = p_org),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'added_at', m.added_at,
                                                             'email', p.email, 'full_name', p.full_name) order by p.email)
                           from msm_stock_members m left join user_profiles p on p.id = m.user_id
                          where m.org_id = p_org), '[]'::jsonb));
end
$fn$;

-- Central stock at every site of a company with Shared stock on (Peter, 19 Oct 2026). A site on the
-- till path ('browser', a back out by hand, or no row) is switched central; 'paused' (being fixed by
-- ServOS) is left as it is and named on the Admin card. Returns how many were switched.
create or replace function public.msm_stock__central_all(p_org uuid, p_who text)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid;
  n integer := 0;
begin
  for v_loc in
    select l.id from locations l
     where l.org_id = p_org
       and coalesce((select d.mode from stock_depletion_mode d where d.location_id = l.id), 'browser') = 'browser'
     order by l.id
  loop
    perform public.stock_central_switch(v_loc, 'central', p_who);
    n := n + 1;
  end loop;
  return n;
end
$fn$;

create or replace function public.stock_admin_set_enabled(p_org uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_switched integer := 0;
begin
  perform public.msm__require_servos();
  if p_org is null or not exists (select 1 from organisations o where o.id = p_org) then
    raise exception 'No such company.' using errcode = '22023';
  end if;
  if coalesce(p_on, false) and not coalesce((select m.enabled from msm_company m where m.org_id = p_org), false) then
    raise exception 'Switch the Multi site menu on for this company first: Shared stock lives inside it. Nothing was changed.' using errcode = '55000';
  end if;
  insert into stock_company as sc (org_id, enabled, enabled_by, enabled_at, updated_at)
  values (p_org, coalesce(p_on, false), auth.uid(), case when p_on then now() end, now())
  on conflict (org_id) do update
     set enabled = coalesce(p_on, false),
         enabled_by = auth.uid(),
         enabled_at = case when p_on then coalesce(case when sc.enabled then sc.enabled_at end, now()) else sc.enabled_at end,
         updated_at = now();
  if coalesce(p_on, false) then
    v_switched := public.msm_stock__central_all(p_org, 'shared stock on');
  end if;
  return public.stock_admin_status(p_org) || jsonb_build_object('switched_central', v_switched);
end
$fn$;

create or replace function public.stock_admin_set_member(p_org uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.msm__require_servos();
  if p_org is null or not exists (select 1 from organisations o where o.id = p_org) then
    raise exception 'No such company.' using errcode = '22023';
  end if;
  if p_role is not null and p_role not in ('editor', 'viewer') then
    raise exception 'A person is a stock Editor or a stock Viewer.' using errcode = '22023';
  end if;
  perform 1 from user_profiles p where p.id = p_user and nullif(btrim(p.email), '') is not null;
  if not found then
    raise exception 'That login is not a person with an email.' using errcode = '22023';
  end if;
  if p_role is null then
    delete from msm_stock_members m where m.org_id = p_org and m.user_id = p_user;
  else
    insert into msm_stock_members (org_id, user_id, role, added_by) values (p_org, p_user, p_role, auth.uid())
    on conflict (org_id, user_id) do update set role = excluded.role;
  end if;
  return public.stock_admin_status(p_org);
end
$fn$;

-- What this login may do in Shared stock.
create or replace function public.stock_my_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object('installed', true, 'companies', coalesce(jsonb_agg(jsonb_build_object(
           'org_id', m.org_id, 'org_name', o.name, 'role', m.role,
           'enabled', coalesce(c.enabled, false), 'menu_enabled', coalesce(mc.enabled, false)) order by o.name), '[]'::jsonb))
    from msm_stock_members m
    join organisations o on o.id = m.org_id
    left join stock_company c on c.org_id = m.org_id
    left join msm_company mc on mc.org_id = m.org_id
   where m.user_id = auth.uid() and auth.uid() is not null and not public.is_anon_session();
$fn$;

-- A site that joins a company with Shared stock on is central from that moment.
create or replace function public._stock_company_site_joins()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.org_id is not null
     and (tg_op = 'INSERT' or old.org_id is distinct from new.org_id)
     and exists (select 1 from stock_company c where c.org_id = new.org_id and c.enabled)
     and coalesce((select d.mode from stock_depletion_mode d where d.location_id = new.id), 'browser') = 'browser' then
    perform public.stock_central_switch(new.id, 'central', 'shared stock: site joined');
  end if;
  return new;
exception when others then
  raise warning 'central stock was not switched on for venue % joining a Shared stock company (%). Run stock_central_switch for it.', new.id, sqlerrm;
  return new;
end
$fn$;
do $join$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.locations'::regclass and tgname = 'locations_stock_company_join') then
    create trigger locations_stock_company_join after insert or update of org_id on public.locations
      for each row execute function public._stock_company_site_joins();
  end if;
end
$join$;

-- ============================================================================
-- 8. DRAFTS: STAGE, UNSTAGE
-- ============================================================================

-- Allowed keys per change target, with their types. Anything else is refused in words.
create or replace function public.msm_stock__allowed(p_target text)
returns jsonb
language sql
immutable
as $fn$
  select case p_target
    when 'item' then '{"name":"text","category":"text","accounting_group":"text","base_unit":"unit","allergens":"array","sku":"text","barcode":"text","shelf_life_days":"int","purchase_tax_rate":"rate","default_area_kind":"text","returns_to_shelf":"bool","notes":"text","all_sites":"bool","archived":"bool","_new":"bool"}'::jsonb
    when 'item_site' then '{"active":"bool","made_here":"bool","link":"uuid"}'::jsonb
    when 'pack' then '{"item_id":"uuid","name":"text","qty_in_base":"pos","parent_pack_id":"uuid","is_count_default":"bool","is_purchase_default":"bool","archived":"bool","_new":"bool"}'::jsonb
    when 'pack_site' then '{"off":"bool","link":"uuid"}'::jsonb
    when 'bridge' then '{"item_id":"uuid","from_qty":"pos","from_unit":"unit","to_qty":"pos","to_unit":"unit","archived":"bool","_new":"bool"}'::jsonb
    when 'bridge_site' then '{"off":"bool","link":"uuid"}'::jsonb
    when 'supplier' then '{"name":"text","contact_name":"text","contact_email":"text","phone":"text","payment_terms_days":"int","notes":"text","all_sites":"bool","archived":"bool","_new":"bool"}'::jsonb
    when 'supplier_site' then '{"active":"bool","account_number":"text","order_email":"text","delivery_days":"array","cutoff_time":"text","min_order_value":"money","link":"uuid"}'::jsonb
    when 'sp' then '{"supplier_id":"uuid","item_id":"uuid","supplier_sku":"text","pack_description":"text","pack_qty":"pos","inner_qty":"pos","inner_unit":"unit","pack_price":"money","price_includes_tax":"bool","purchase_tax_rate":"rate","first_choice":"bool","archived":"bool","_new":"bool"}'::jsonb
    when 'sp_site' then '{"off":"bool","pack_price":"money","link":"uuid"}'::jsonb
    else null end;
$fn$;

-- Clean one change's data: allowed keys, right types, trimmed text, empty text as null.
create or replace function public.msm_stock__clean(p_target text, p_data jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_allowed jsonb := public.msm_stock__allowed(p_target);
  v_out jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  t text;
  s text;
  n numeric;
begin
  if v_allowed is null then
    raise exception 'Unknown kind of stock change: %', coalesce(p_target, 'none') using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'A stock change needs its fields.' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(p_data) loop
    t := v_allowed ->> k;
    if t is null then
      raise exception 'The field "%" cannot be changed on a % from head office.', k, replace(p_target, '_', ' ') using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then
      if k in ('name', 'base_unit', 'item_id', 'supplier_id', 'qty_in_base', 'from_qty', 'to_qty', 'from_unit', 'to_unit', 'inner_unit', 'pack_qty', 'inner_qty')
         or (t = 'bool' and k <> 'active') then
        raise exception 'The field "%" cannot be empty.', k using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, null);
      continue;
    end if;
    s := btrim(v #>> '{}');
    if t = 'text' then
      if jsonb_typeof(v) not in ('string', 'number') then raise exception 'The field "%" must be text.', k using errcode = '22023'; end if;
      if k = 'name' and coalesce(s, '') = '' then raise exception 'A name cannot be empty.' using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(k, nullif(s, ''));
    elsif t = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'The field "%" must be yes or no.', k using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(k, v);
    elsif t = 'uuid' then
      begin
        v_out := v_out || jsonb_build_object(k, s::uuid);
      exception when others then
        raise exception 'The field "%" is not a valid id.', k using errcode = '22023';
      end;
    elsif t = 'unit' then
      if not exists (select 1 from stock_units u where u.code = lower(s)) then
        raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', s using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(k, lower(s));
    elsif t = 'array' then
      if jsonb_typeof(v) <> 'array' then raise exception 'The field "%" must be a list.', k using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(k, v);
    else
      begin
        n := s::numeric;
      exception when others then
        raise exception 'The field "%" must be a number.', k using errcode = '22023';
      end;
      if t = 'int' and (n <> trunc(n) or n < 0) then raise exception 'The field "%" must be a whole number, 0 or more.', k using errcode = '22023'; end if;
      if t = 'pos' and n <= 0 then raise exception 'The field "%" must be more than 0.', k using errcode = '22023'; end if;
      if t = 'money' and n < 0 then raise exception 'A price cannot be below 0.' using errcode = '22023'; end if;
      if t = 'rate' and (n < 0 or n >= 1) then raise exception 'A VAT rate is a fraction such as 0.2 for 20%%.' using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(k, case when t = 'int' then to_jsonb(trunc(n)::integer) when t = 'money' then to_jsonb(round(n, 4)) else to_jsonb(n) end);
    end if;
  end loop;
  return v_out;
end
$fn$;

-- The open draft of a company (made when missing).
create or replace function public.msm_stock__open_draft(p_org uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  select d.id into v_id from msm_stock_drafts d where d.org_id = p_org and d.status = 'open' for update;
  if v_id is null then
    insert into msm_stock_drafts (org_id, created_by) values (p_org, auth.uid())
    on conflict (org_id) where status = 'open' do nothing
    returning id into v_id;
    if v_id is null then
      select d.id into v_id from msm_stock_drafts d where d.org_id = p_org and d.status = 'open' for update;
    end if;
  end if;
  return v_id;
end
$fn$;

-- Does a company entity of this kind exist (live, or new in this draft)?
create or replace function public.msm_stock__entity_ok(p_org uuid, p_draft uuid, p_kind text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select case p_kind
    when 'item' then exists (select 1 from msm_stock_items i where i.id = p_id and i.org_id = p_org)
    when 'pack' then exists (select 1 from msm_stock_packs i where i.id = p_id and i.org_id = p_org)
    when 'bridge' then exists (select 1 from msm_stock_bridges i where i.id = p_id and i.org_id = p_org)
    when 'supplier' then exists (select 1 from msm_suppliers i where i.id = p_id and i.org_id = p_org)
    when 'sp' then exists (select 1 from msm_supplier_products i where i.id = p_id and i.org_id = p_org)
    else false end
    or exists (select 1 from msm_stock_changes c where c.draft_id = p_draft and c.target = p_kind and c.entity_id = p_id and c.data ? '_new');
$fn$;

-- A draft holds at most 40,000 changes: that publishes well inside the 8 s limit and the Review screen
-- can page through it. Every way into the draft checks this last (the whole call is refused).
create or replace function public.msm_stock__draft_cap(p_draft uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  n integer := (select count(*) from msm_stock_changes c where c.draft_id = p_draft);
begin
  if n > 40000 then
    raise exception 'That would put % changes in the draft, and a draft holds at most 40,000. Pick fewer sites or items, or change the company row instead (one change reaches every site). Nothing was added.',
      to_char(n, 'FM999,999,999') using errcode = '54000';
  end if;
end
$fn$;

-- Stage changes into the company's open draft (merged per target, entity and site).
-- p_changes: [{target, entity_id, location_id?, data, remove?}], at most 2,000 a call.
create or replace function public.msm_stock_stage(p_org uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  c jsonb;
  v_target text;
  v_id uuid;
  v_loc uuid;
  v_data jsonb;
  v_base text;
  n integer := 0;
begin
  perform public.msm_stock__require_editor(p_org);
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'Send the changes as a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 2000 then
    raise exception 'At most 2,000 changes a call; send the rest in another.' using errcode = '22023';
  end if;
  v_draft := public.msm_stock__open_draft(p_org);
  for c in select * from jsonb_array_elements(p_changes) loop
    v_target := c ->> 'target';
    begin
      v_id := (c ->> 'entity_id')::uuid;
      v_loc := nullif(c ->> 'location_id', '')::uuid;
    exception when others then
      raise exception 'A change has an id that is not valid.' using errcode = '22023';
    end;
    if v_id is null then raise exception 'A change needs the id of what it changes.' using errcode = '22023'; end if;
    if coalesce((c ->> 'remove')::boolean, false) then
      delete from msm_stock_changes x where x.draft_id = v_draft and x.target = v_target and x.entity_id = v_id
         and x.location_key = coalesce(v_loc, '00000000-0000-0000-0000-000000000000'::uuid);
      n := n + 1;
      continue;
    end if;
    v_data := public.msm_stock__clean(v_target, c -> 'data');
    v_base := replace(v_target, '_site', '');
    if v_target like '%\_site' escape '\' then
      if v_loc is null or not public.msm_stock__venue_in_org(v_loc, p_org) then
        raise exception 'That site is not in this company.' using errcode = '22023';
      end if;
      if not public.msm_stock__entity_ok(p_org, v_draft, v_base, v_id) then
        raise exception 'That % is not in this company.', v_base using errcode = '22023';
      end if;
    else
      if v_loc is not null then raise exception 'A company change has no site.' using errcode = '22023'; end if;
      if coalesce((v_data ->> '_new')::boolean, false) then
        if exists (select 1 from msm_stock_items x where x.id = v_id) or exists (select 1 from msm_stock_packs x where x.id = v_id)
           or exists (select 1 from msm_stock_bridges x where x.id = v_id) or exists (select 1 from msm_suppliers x where x.id = v_id)
           or exists (select 1 from msm_supplier_products x where x.id = v_id) then
          raise exception 'A new row needs a new id.' using errcode = '22023';
        end if;
      elsif not public.msm_stock__entity_ok(p_org, v_draft, v_target, v_id) then
        raise exception 'That % is not in this company.', v_target using errcode = '22023';
      end if;
      if v_data ? 'item_id' and not public.msm_stock__entity_ok(p_org, v_draft, 'item', (v_data ->> 'item_id')::uuid) then
        raise exception 'That stock item is not in this company.' using errcode = '22023';
      end if;
      if v_data ? 'supplier_id' and not public.msm_stock__entity_ok(p_org, v_draft, 'supplier', (v_data ->> 'supplier_id')::uuid) then
        raise exception 'That supplier is not in this company.' using errcode = '22023';
      end if;
      if v_data ? 'parent_pack_id' and v_data ->> 'parent_pack_id' is not null
         and not public.msm_stock__entity_ok(p_org, v_draft, 'pack', (v_data ->> 'parent_pack_id')::uuid) then
        raise exception 'That pack is not in this company.' using errcode = '22023';
      end if;
    end if;
    insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
    values (v_draft, p_org, v_target, v_id, v_loc, coalesce(v_loc, '00000000-0000-0000-0000-000000000000'::uuid), v_data, auth.uid())
    on conflict (draft_id, target, entity_id, location_key)
      do update set data = x.data || excluded.data, updated_at = now();
    n := n + 1;
  end loop;
  update msm_stock_drafts set updated_at = now() where id = v_draft;
  -- a new row must carry what it needs
  if exists (select 1 from msm_stock_changes x where x.draft_id = v_draft and x.data ? '_new' and (
        (x.target = 'item' and (x.data ->> 'name' is null or x.data ->> 'base_unit' is null))
     or (x.target = 'pack' and (x.data ->> 'item_id' is null or x.data ->> 'name' is null or x.data ->> 'qty_in_base' is null))
     or (x.target = 'bridge' and (x.data ->> 'item_id' is null or x.data ->> 'from_unit' is null or x.data ->> 'to_unit' is null
                                  or x.data ->> 'from_qty' is null or x.data ->> 'to_qty' is null))
     or (x.target = 'supplier' and x.data ->> 'name' is null)
     or (x.target = 'sp' and (x.data ->> 'item_id' is null or x.data ->> 'supplier_id' is null or x.data ->> 'inner_unit' is null
                              or x.data ->> 'pack_price' is null)))) then
    raise exception 'A new stock item needs a name and a base unit; a new pack a name and a size; a new supplier price its item, supplier, unit and price.'
      using errcode = '22023';
  end if;
  perform public.msm_stock__draft_cap(v_draft);
  return jsonb_build_object('draft_id', v_draft, 'staged', n,
                            'changes', (select count(*) from msm_stock_changes x where x.draft_id = v_draft));
end
$fn$;

-- Throw away staged changes: the ids given, or the whole draft.
create or replace function public.msm_stock_unstage(p_org uuid, p_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  select d.id into v_draft from msm_stock_drafts d where d.org_id = p_org and d.status = 'open' for update;
  if v_draft is null then return jsonb_build_object('removed', 0); end if;
  delete from msm_stock_changes x where x.draft_id = v_draft and (p_ids is null or x.id = any(p_ids));
  get diagnostics n = row_count;
  return jsonb_build_object('removed', n, 'changes', (select count(*) from msm_stock_changes x where x.draft_id = v_draft));
end
$fn$;

-- ============================================================================
-- 9. FREEZE: a draft into the company tables (publish; preview inside a rolled back block)
-- ============================================================================
create or replace function public.msm_stock__freeze(p_org uuid, p_draft uuid, p_version uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
  total integer := 0;
  z constant uuid := '00000000-0000-0000-0000-000000000000';
  v_bad text;
begin
  -- 9a. before images (Undo), company rows then site settings
  if p_version is not null then
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, c.target, c.entity_id, c.location_key,
           case when coalesce(i.j, p.j, b.j, s.j, sp.j, isx.j, psx.j, bsx.j, ssx.j, spsx.j) is null then 'insert' else 'update' end,
           coalesce(i.j, p.j, b.j, s.j, sp.j, isx.j, psx.j, bsx.j, ssx.j, spsx.j)
      from msm_stock_changes c
      left join lateral (select to_jsonb(x) j from msm_stock_items x where c.target = 'item' and x.id = c.entity_id) i on true
      left join lateral (select to_jsonb(x) j from msm_stock_packs x where c.target = 'pack' and x.id = c.entity_id) p on true
      left join lateral (select to_jsonb(x) j from msm_stock_bridges x where c.target = 'bridge' and x.id = c.entity_id) b on true
      left join lateral (select to_jsonb(x) j from msm_suppliers x where c.target = 'supplier' and x.id = c.entity_id) s on true
      left join lateral (select to_jsonb(x) j from msm_supplier_products x where c.target = 'sp' and x.id = c.entity_id) sp on true
      left join lateral (select to_jsonb(x) j from msm_stock_item_sites x where c.target = 'item_site' and x.item_id = c.entity_id and x.location_id = c.location_id) isx on true
      left join lateral (select to_jsonb(x) j from msm_stock_pack_sites x where c.target = 'pack_site' and x.pack_id = c.entity_id and x.location_id = c.location_id) psx on true
      left join lateral (select to_jsonb(x) j from msm_stock_bridge_sites x where c.target = 'bridge_site' and x.bridge_id = c.entity_id and x.location_id = c.location_id) bsx on true
      left join lateral (select to_jsonb(x) j from msm_supplier_sites x where c.target = 'supplier_site' and x.supplier_id = c.entity_id and x.location_id = c.location_id) ssx on true
      left join lateral (select to_jsonb(x) j from msm_supplier_product_sites x where c.target = 'sp_site' and x.sp_id = c.entity_id and x.location_id = c.location_id) spsx on true
     where c.draft_id = p_draft
    on conflict do nothing;
  end if;

  -- 9b. company rows: new ones, then changes to existing ones (jsonb_populate_record keeps what the change does not name)
  insert into msm_stock_items
  select (jsonb_populate_record(null::msm_stock_items,
            jsonb_build_object('id', c.entity_id, 'org_id', p_org, 'allergens', '[]'::jsonb, 'returns_to_shelf', false, 'archived', false, 'all_sites', false,
                               'created_at', now(), 'updated_at', now(), 'updated_by', auth.uid()) || (c.data - '_new'))).*
    from msm_stock_changes c where c.draft_id = p_draft and c.target = 'item' and c.data ? '_new';
  get diagnostics n = row_count; total := total + n;
  update msm_stock_items t
     set (name, category, accounting_group, base_unit, allergens, sku, barcode, shelf_life_days, purchase_tax_rate, default_area_kind,
          returns_to_shelf, notes, all_sites, archived, updated_at, updated_by)
       = (select r.name, r.category, r.accounting_group, r.base_unit, coalesce(r.allergens, '[]'::jsonb), r.sku, r.barcode, r.shelf_life_days,
                 r.purchase_tax_rate, r.default_area_kind, coalesce(r.returns_to_shelf, false), r.notes, coalesce(r.all_sites, false),
                 coalesce(r.archived, false), now(), auth.uid()
            from jsonb_populate_record(t, c.data) r)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'item' and c.entity_id = t.id and t.org_id = p_org and not (c.data ? '_new');
  get diagnostics n = row_count; total := total + n;

  insert into msm_suppliers
  select (jsonb_populate_record(null::msm_suppliers,
            jsonb_build_object('id', c.entity_id, 'org_id', p_org, 'archived', false, 'all_sites', false, 'created_at', now(), 'updated_at', now()) || (c.data - '_new'))).*
    from msm_stock_changes c where c.draft_id = p_draft and c.target = 'supplier' and c.data ? '_new';
  get diagnostics n = row_count; total := total + n;
  update msm_suppliers t
     set (name, contact_name, contact_email, phone, payment_terms_days, notes, all_sites, archived, updated_at)
       = (select r.name, r.contact_name, r.contact_email, r.phone, r.payment_terms_days, r.notes, coalesce(r.all_sites, false), coalesce(r.archived, false), now()
            from jsonb_populate_record(t, c.data) r)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'supplier' and c.entity_id = t.id and t.org_id = p_org and not (c.data ? '_new');
  get diagnostics n = row_count; total := total + n;

  -- packs: new ones without their parent first, then the parent is set (a parent can be new too)
  insert into msm_stock_packs
  select (jsonb_populate_record(null::msm_stock_packs,
            jsonb_build_object('id', c.entity_id, 'org_id', p_org, 'is_count_default', false, 'is_purchase_default', false, 'archived', false,
                               'created_at', now(), 'updated_at', now()) || (c.data - '_new' - 'parent_pack_id'))).*
    from msm_stock_changes c where c.draft_id = p_draft and c.target = 'pack' and c.data ? '_new';
  get diagnostics n = row_count; total := total + n;
  update msm_stock_packs t
     set (item_id, name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default, archived, updated_at)
       = (select r.item_id, r.name, r.qty_in_base, r.parent_pack_id, coalesce(r.is_count_default, false), coalesce(r.is_purchase_default, false),
                 coalesce(r.archived, false), now()
            from jsonb_populate_record(t, c.data - '_new') r)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'pack' and c.entity_id = t.id and t.org_id = p_org
     and (not (c.data ? '_new') or c.data ? 'parent_pack_id');
  get diagnostics n = row_count; total := total + n;

  insert into msm_stock_bridges
  select (jsonb_populate_record(null::msm_stock_bridges,
            jsonb_build_object('id', c.entity_id, 'org_id', p_org, 'archived', false, 'created_at', now(), 'updated_at', now()) || (c.data - '_new'))).*
    from msm_stock_changes c where c.draft_id = p_draft and c.target = 'bridge' and c.data ? '_new';
  get diagnostics n = row_count; total := total + n;
  update msm_stock_bridges t
     set (item_id, from_qty, from_unit, to_qty, to_unit, archived, updated_at)
       = (select r.item_id, r.from_qty, r.from_unit, r.to_qty, r.to_unit, coalesce(r.archived, false), now()
            from jsonb_populate_record(t, c.data) r)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'bridge' and c.entity_id = t.id and t.org_id = p_org and not (c.data ? '_new');
  get diagnostics n = row_count; total := total + n;

  insert into msm_supplier_products
  select (jsonb_populate_record(null::msm_supplier_products,
            jsonb_build_object('id', c.entity_id, 'org_id', p_org, 'pack_qty', 1, 'inner_qty', 1, 'price_includes_tax', false,
                               'first_choice', false, 'archived', false, 'created_at', now(), 'updated_at', now()) || (c.data - '_new'))).*
    from msm_stock_changes c where c.draft_id = p_draft and c.target = 'sp' and c.data ? '_new';
  get diagnostics n = row_count; total := total + n;
  update msm_supplier_products t
     set (supplier_id, item_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, price_includes_tax,
          purchase_tax_rate, first_choice, archived, updated_at)
       = (select r.supplier_id, r.item_id, r.supplier_sku, r.pack_description, r.pack_qty, r.inner_qty, r.inner_unit, r.pack_price,
                 coalesce(r.price_includes_tax, false), r.purchase_tax_rate, coalesce(r.first_choice, false), coalesce(r.archived, false), now()
            from jsonb_populate_record(t, c.data) r)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'sp' and c.entity_id = t.id and t.org_id = p_org and not (c.data ? '_new');
  get diagnostics n = row_count; total := total + n;

  -- 9c. links: the site row must be live at that site, not a company row yet, not linked already,
  --     and (items) in the same base unit; packs, bridges and prices must belong to the linked item.
  select string_agg(x.words, '; ') into v_bad from (
    select format('%s at %s: %s', coalesce(i.name, 'an item'), coalesce(l.name, 'a site'),
             case when t.id is null then 'that site item was not found'
                  when t.company_ref is not null then 'that site item is already a company item'
                  when t.archived_at is not null then 'that site item is archived'
                  when t.base_unit <> i.base_unit then format('its unit is %s, the company item''s is %s', t.base_unit, i.base_unit)
                  else 'it is linked to another company item already' end) as words
      from (select c0.*, count(*) over (partition by c0.location_id, c0.data ->> 'link') as same_link
              from msm_stock_changes c0
             where c0.draft_id = p_draft and c0.target = 'item_site' and c0.data ->> 'link' is not null) c
      join msm_stock_items i on i.id = c.entity_id
      join locations l on l.id = c.location_id
      left join inventory_items t on t.id = (c.data ->> 'link')::uuid and t.location_id = c.location_id
     where (t.id is null or t.company_ref is not null or t.archived_at is not null or t.base_unit <> i.base_unit
            or c.same_link > 1
            or exists (select 1 from msm_stock_item_sites s where s.location_id = c.location_id and s.venue_item_id = t.id and s.item_id <> c.entity_id)
            or exists (select 1 from msm_stock_item_sites s where s.location_id = c.location_id and s.item_id = c.entity_id
                        and s.venue_item_id is not null and s.venue_item_id <> t.id))
    union all
    select format('%s at %s: that site supplier cannot be linked (not found, archived, or linked already)', coalesce(m.name, 'a supplier'), coalesce(l.name, 'a site'))
      from (select c0.*, count(*) over (partition by c0.location_id, c0.data ->> 'link') as same_link
              from msm_stock_changes c0
             where c0.draft_id = p_draft and c0.target = 'supplier_site' and c0.data ->> 'link' is not null) c
      join msm_suppliers m on m.id = c.entity_id
      join locations l on l.id = c.location_id
      left join suppliers t on t.id = (c.data ->> 'link')::uuid and t.location_id = c.location_id
     where (t.id is null or t.company_ref is not null or t.archived_at is not null
            or c.same_link > 1
            or exists (select 1 from msm_supplier_sites s where s.location_id = c.location_id and s.venue_supplier_id = t.id and s.supplier_id <> c.entity_id)
            or exists (select 1 from msm_supplier_sites s where s.location_id = c.location_id and s.supplier_id = c.entity_id
                        and s.venue_supplier_id is not null and s.venue_supplier_id <> t.id))
    limit 10) x;
  if v_bad is not null then
    raise exception 'These links cannot be made, so nothing was published: %', v_bad using errcode = '22023';
  end if;

  -- 9d. site settings (the per site tables): new rows, then changes
  insert into msm_stock_item_sites (item_id, org_id, location_id, venue_item_id, active, made_here)
  select c.entity_id, p_org, c.location_id, (c.data ->> 'link')::uuid,
         case when c.data ? 'active' then (c.data ->> 'active')::boolean else true end,
         coalesce((c.data ->> 'made_here')::boolean, false)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'item_site'
     and not exists (select 1 from msm_stock_item_sites s where s.item_id = c.entity_id and s.location_id = c.location_id);
  get diagnostics n = row_count; total := total + n;
  update msm_stock_item_sites s
     set active = case when c.data ? 'active' then (c.data ->> 'active')::boolean else s.active end,
         made_here = coalesce((c.data ->> 'made_here')::boolean, s.made_here),
         venue_item_id = coalesce(s.venue_item_id, (c.data ->> 'link')::uuid),
         unlinked_at = case when c.data ->> 'link' is not null then null else s.unlinked_at end,
         updated_at = now()
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'item_site' and s.item_id = c.entity_id and s.location_id = c.location_id
     and s.org_id = p_org;
  get diagnostics n = row_count; total := total + n;

  insert into msm_supplier_sites (supplier_id, org_id, location_id, venue_supplier_id, active, account_number, order_email, delivery_days, cutoff_time, min_order_value)
  select c.entity_id, p_org, c.location_id, (c.data ->> 'link')::uuid,
         case when c.data ? 'active' then (c.data ->> 'active')::boolean else true end,
         c.data ->> 'account_number', c.data ->> 'order_email', c.data -> 'delivery_days', c.data ->> 'cutoff_time',
         (c.data ->> 'min_order_value')::numeric
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'supplier_site'
     and not exists (select 1 from msm_supplier_sites s where s.supplier_id = c.entity_id and s.location_id = c.location_id);
  get diagnostics n = row_count; total := total + n;
  update msm_supplier_sites s
     set active = case when c.data ? 'active' then (c.data ->> 'active')::boolean else s.active end,
         account_number = case when c.data ? 'account_number' then c.data ->> 'account_number' else s.account_number end,
         order_email = case when c.data ? 'order_email' then c.data ->> 'order_email' else s.order_email end,
         delivery_days = case when c.data ? 'delivery_days' then c.data -> 'delivery_days' else s.delivery_days end,
         cutoff_time = case when c.data ? 'cutoff_time' then c.data ->> 'cutoff_time' else s.cutoff_time end,
         min_order_value = case when c.data ? 'min_order_value' then (c.data ->> 'min_order_value')::numeric else s.min_order_value end,
         venue_supplier_id = coalesce(s.venue_supplier_id, (c.data ->> 'link')::uuid),
         unlinked_at = case when c.data ->> 'link' is not null then null else s.unlinked_at end,
         updated_at = now()
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'supplier_site' and s.supplier_id = c.entity_id and s.location_id = c.location_id
     and s.org_id = p_org;
  get diagnostics n = row_count; total := total + n;

  insert into msm_stock_pack_sites (pack_id, org_id, location_id, venue_format_id, off)
  select c.entity_id, p_org, c.location_id, (c.data ->> 'link')::uuid, coalesce((c.data ->> 'off')::boolean, false)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'pack_site'
     and not exists (select 1 from msm_stock_pack_sites s where s.pack_id = c.entity_id and s.location_id = c.location_id);
  get diagnostics n = row_count; total := total + n;
  update msm_stock_pack_sites s
     set off = coalesce((c.data ->> 'off')::boolean, s.off),
         venue_format_id = coalesce(s.venue_format_id, (c.data ->> 'link')::uuid),
         unlinked_at = case when c.data ->> 'link' is not null then null else s.unlinked_at end, updated_at = now()
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'pack_site' and s.pack_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org;
  get diagnostics n = row_count; total := total + n;

  insert into msm_stock_bridge_sites (bridge_id, org_id, location_id, venue_conversion_id, off)
  select c.entity_id, p_org, c.location_id, (c.data ->> 'link')::uuid, coalesce((c.data ->> 'off')::boolean, false)
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'bridge_site'
     and not exists (select 1 from msm_stock_bridge_sites s where s.bridge_id = c.entity_id and s.location_id = c.location_id);
  get diagnostics n = row_count; total := total + n;
  update msm_stock_bridge_sites s
     set off = coalesce((c.data ->> 'off')::boolean, s.off),
         venue_conversion_id = coalesce(s.venue_conversion_id, (c.data ->> 'link')::uuid),
         unlinked_at = case when c.data ->> 'link' is not null then null else s.unlinked_at end, updated_at = now()
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'bridge_site' and s.bridge_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org;
  get diagnostics n = row_count; total := total + n;

  insert into msm_supplier_product_sites (sp_id, org_id, location_id, venue_supplier_product_id, off, pack_price)
  select c.entity_id, p_org, c.location_id, (c.data ->> 'link')::uuid, coalesce((c.data ->> 'off')::boolean, false),
         (c.data ->> 'pack_price')::numeric
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'sp_site'
     and not exists (select 1 from msm_supplier_product_sites s where s.sp_id = c.entity_id and s.location_id = c.location_id);
  get diagnostics n = row_count; total := total + n;
  update msm_supplier_product_sites s
     set off = coalesce((c.data ->> 'off')::boolean, s.off),
         pack_price = case when c.data ? 'pack_price' then (c.data ->> 'pack_price')::numeric else s.pack_price end,
         venue_supplier_product_id = coalesce(s.venue_supplier_product_id, (c.data ->> 'link')::uuid),
         unlinked_at = case when c.data ->> 'link' is not null then null else s.unlinked_at end, updated_at = now()
    from msm_stock_changes c
   where c.draft_id = p_draft and c.target = 'sp_site' and s.sp_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org;
  get diagnostics n = row_count; total := total + n;

  -- 9e. pack, bridge and price links must sit on the item (and supplier) linked at that site
  select string_agg(x.words, '; ') into v_bad from (
    -- driven by the draft's own link ticks (not by every site row of the company: 50 sites x 5,000)
    select format('a pack link at %s does not belong to that item there', coalesce(l.name, 'a site')) as words
      from msm_stock_changes c
      join msm_stock_pack_sites s on s.pack_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org
      join msm_stock_packs p on p.id = s.pack_id
      join locations l on l.id = s.location_id
      left join msm_stock_item_sites isx on isx.item_id = p.item_id and isx.location_id = s.location_id
      left join item_packaging_formats t on t.id = s.venue_format_id and t.location_id = s.location_id
     where c.draft_id = p_draft and c.target = 'pack_site' and c.data ->> 'link' is not null and s.venue_format_id is not null
       and (t.id is null or t.company_ref is not null or t.inventory_item_id is distinct from isx.venue_item_id)
    union all
    select format('a unit bridge link at %s does not belong to that item there', coalesce(l.name, 'a site'))
      from msm_stock_changes c
      join msm_stock_bridge_sites s on s.bridge_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org
      join msm_stock_bridges b on b.id = s.bridge_id
      join locations l on l.id = s.location_id
      left join msm_stock_item_sites isx on isx.item_id = b.item_id and isx.location_id = s.location_id
      left join inventory_item_conversions t on t.id = s.venue_conversion_id and t.location_id = s.location_id
     where c.draft_id = p_draft and c.target = 'bridge_site' and c.data ->> 'link' is not null and s.venue_conversion_id is not null
       and (t.id is null or t.company_ref is not null or t.inventory_item_id is distinct from isx.venue_item_id)
    union all
    select format('a supplier price link at %s is not for that item and supplier there', coalesce(l.name, 'a site'))
      from msm_stock_changes c
      join msm_supplier_product_sites s on s.sp_id = c.entity_id and s.location_id = c.location_id and s.org_id = p_org
      join msm_supplier_products sp on sp.id = s.sp_id
      join locations l on l.id = s.location_id
      left join msm_stock_item_sites isx on isx.item_id = sp.item_id and isx.location_id = s.location_id
      left join msm_supplier_sites ssx on ssx.supplier_id = sp.supplier_id and ssx.location_id = s.location_id
      left join supplier_products t on t.id = s.venue_supplier_product_id and t.location_id = s.location_id
     where c.draft_id = p_draft and c.target = 'sp_site' and c.data ->> 'link' is not null and s.venue_supplier_product_id is not null
       and (t.id is null or t.company_ref is not null or t.inventory_item_id is distinct from isx.venue_item_id
            or t.supplier_id is distinct from ssx.venue_supplier_id)
    limit 10) x;
  if v_bad is not null then
    raise exception 'These links cannot be made, so nothing was published: %', v_bad using errcode = '22023';
  end if;
  return total;
end
$fn$;

-- ============================================================================
-- 10. THE PLANNER AND WRITER (one site, set based, inside the database)
-- ============================================================================
-- msm_stock__sync_site(company, site, version, write, detail):
--   write false: counts what a publish would write at the site (nothing is written);
--   write true: writes it, one statement per table and kind, the busy items table last, and keeps one
--   before and after row per changed row in msm_stock_version_rows (Undo).
--   detail true (with write false): also the first 200 differing rows side by side (drift review).
-- Never written: on hand, cost_method, pars, movements, counts, orders, invoices, transfers, waste,
-- production, is_preferred and default_supplier_id after insert, supplier site values after insert.
-- current_cost only by the site's own cost rule, for items whose supplier price this write adds or
-- changes (msm_stock__cost_plan). A site row of an item switched off (or archived) is archived, never
-- deleted; an item the site still holds stock of stays live, with its packs and prices (and is
-- listed), and is archived by the next publish after it reaches zero.
-- A VAT rate row as words for the screens ("20%"); null when there is none.
create or replace function public.msm_stock__rate_words(p_rate_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select trim(trailing '.' from trim(trailing '0' from to_char(r.rate * 100, 'FM990.000'))) || '%'
    from tax_rates r where r.id = p_rate_id;
$fn$;

-- Cost here (plan 4.5, one cost rule): the site's own rule over _w_price (the prices the site has, or
-- will have once written) for the items in _w_cost. The preferred live price, else the cheapest; net
-- of VAT only when the price includes VAT; per base unit through the item's units and bridges, as the
-- Back Office price save works it out (data.js recomputeItemCost); never 0. Price list sites follow
-- it; deliveries sites only for an item with no cost yet or never received. Fills _w_newcost with the
-- items whose cost moves. Owner only: msm_stock__sync_site calls it (plan and write).
create or replace function public.msm_stock__cost_plan(p_loc uuid, p_rule text)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  drop table if exists _w_newcost;
  create temp table _w_newcost on commit drop as
  select c.item, c.name, c.prev, c.cost, c.sp_id, c.net, gen_random_uuid() as hist_id
    from (select distinct on (p.item) p.item, wi.name, t.current_cost as prev, p.sp_id, n.net, round(n.net / q.qb, 5) as cost
            from _w_price p
            join _w_items wi on wi.vid = p.item
            left join inventory_items t on t.id = p.item and t.location_id = p_loc
            cross join lateral (select case when p.inc
                                             then p.pack_price / (1 + coalesce((select r.rate from tax_rates r where r.id = coalesce(p.rate_id, wi.purchase_tax_rate_id)), 0))
                                             else p.pack_price end as net) n
            cross join lateral (select public.stock_convert_qty(p.pack_qty * p.inner_qty, p.inner_unit, wi.base_unit, array[p.item]) as qb) q
           where p.item in (select c.item from _w_cost c)
             and q.qb > 0 and n.net > 0 and round(n.net / q.qb, 5) > 0
           order by p.item, p.pref desc, n.net / q.qb, p.sp_id) c
   where c.prev is distinct from c.cost
     and (p_rule = 'price_list' or coalesce(c.prev, 0) = 0
          or not exists (select 1 from stock_movements m where m.location_id = p_loc and m.inventory_item_id = c.item
                          and m.movement_type = 'PURCHASE_RECEIPT'));
  get diagnostics n = row_count;
  return n;
end
$fn$;

create or replace function public.msm_stock__sync_site(p_org uuid, p_loc uuid, p_version uuid, p_write boolean, p_detail boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_now timestamptz := now();
  v_counts jsonb;
  v_detail jsonb := '[]'::jsonb;
  v_writes integer := 0;
  n integer;
  v_bad text;
  v_rule text := coalesce((select s.cost_rule from stock_site_settings s where s.location_id = p_loc), 'price_list');
begin
  if p_write then
    perform set_config('servos.stock_publish', txid_current()::text, true);
    -- The site rows this write may ARCHIVE (switched off here, or archived by head office) or give a
    -- NEW BASE UNIT are locked first, in id order (2 s lock wait, set by the runner: a busy site gives
    -- way). The plan below then reads their stock as it is: an item a delivery or a sale has just moved
    -- is held, never archived with stock, and a row in use in its unit never changes unit.
    drop table if exists _w_site_rows;
    create temp table _w_site_rows on commit drop as
    select s.venue_item_id as vid, i.name, i.base_unit, (coalesce(s.active, i.all_sites) and not i.archived) as alive
      from msm_stock_item_sites s
      cross join lateral (select i.name, i.base_unit, i.all_sites, i.archived from msm_stock_items i
                           where i.id = s.item_id and i.org_id = p_org limit 1) i
     where s.location_id = p_loc and s.unlinked_at is null and s.venue_item_id is not null;
    perform 1 from inventory_items t
      join _w_site_rows x on x.vid = t.id
     where t.location_id = p_loc and t.archived_at is null
       and (t.base_unit is distinct from x.base_unit or not x.alive)
     order by t.id
     for no key update of t;
    select string_agg(format('%s is counted in %s at %s and has stock, counts, pars or orders there, so it cannot change to %s',
                             x.name, x.site_unit, (select l.name from locations l where l.id = p_loc), x.base_unit), '; ')
      into v_bad
      from (with d as materialized (
              select x.name, t.id, t.base_unit as site_unit, x.base_unit
                from _w_site_rows x
                join inventory_items t on t.id = x.vid and t.location_id = p_loc
               where t.base_unit is distinct from x.base_unit)
            select d.* from d where public.msm_stock__site_item_in_use(p_loc, d.id)
             order by d.name limit 5) x;
    if v_bad is not null then
      raise exception 'Not written at this site: %. Undo that version in History (the company row goes back), or make a new item instead.', v_bad
        using errcode = '55000';
    end if;
  end if;

  -- -- items ---------------------------------------------------------------
  drop table if exists _w_items;
  create temp table _w_items on commit drop as
  select i.id as cid, s.venue_item_id as vid, (t.id is null) as is_new, (s.item_id is null) as map_new,
         (coalesce(s.active, i.all_sites) and not i.archived) as alive,
         i.name, i.category, i.accounting_group, i.base_unit, i.allergens, i.sku, i.barcode, i.shelf_life_days, i.returns_to_shelf,
         case when i.purchase_tax_rate is null then null::uuid
              when t.purchase_tax_rate_id is not null
                   and (select r.rate from tax_rates r where r.id = t.purchase_tax_rate_id) = i.purchase_tax_rate then t.purchase_tax_rate_id
              else (select r.id from tax_rates r where r.location_id = p_loc and coalesce(r.active, true) and r.rate = i.purchase_tax_rate
                     order by r.is_default desc nulls last, r.name, r.id limit 1) end as purchase_tax_rate_id,
         case when coalesce(s.active, i.all_sites) and not i.archived then null::timestamptz
              when t.id is null then null::timestamptz
              when t.archived_at is not null then t.archived_at
              when coalesce(t.on_hand, 0) = 0 then v_now
              else null::timestamptz end as archived_at,
         (not (coalesce(s.active, i.all_sites) and not i.archived) and t.id is not null and t.archived_at is null and coalesce(t.on_hand, 0) <> 0) as held,
         coalesce(s.made_here, false) as made_here, i.default_area_kind
    from msm_stock_items i
    left join msm_stock_item_sites s on s.item_id = i.id and s.location_id = p_loc
    left join inventory_items t on t.id = s.venue_item_id and t.location_id = p_loc
   where i.org_id = p_org and s.unlinked_at is null
     and (t.id is not null or (coalesce(s.active, i.all_sites) and not i.archived));
  update _w_items set vid = gen_random_uuid() where vid is null;
  if p_write then
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, 'item_site', w.cid, p_loc, case when w.map_new then 'insert' else 'update' end, to_jsonb(s)
      from _w_items w left join msm_stock_item_sites s on s.item_id = w.cid and s.location_id = p_loc
     where w.map_new or s.venue_item_id is null
    on conflict do nothing;
    insert into msm_stock_item_sites (item_id, org_id, location_id, venue_item_id, active)
    select w.cid, p_org, p_loc, w.vid, null from _w_items w where w.map_new;
    update msm_stock_item_sites s set venue_item_id = w.vid, updated_at = now()
      from _w_items w where s.item_id = w.cid and s.location_id = p_loc and s.venue_item_id is null;
  end if;

  -- -- suppliers ----------------------------------------------------------
  drop table if exists _w_sups;
  create temp table _w_sups on commit drop as
  select m.id as cid, s.venue_supplier_id as vid, (t.id is null) as is_new, (s.supplier_id is null) as map_new,
         (coalesce(s.active, m.all_sites) and not m.archived) as alive,
         m.name, m.contact_name, m.phone, m.payment_terms_days, m.notes,
         case when coalesce(s.active, m.all_sites) and not m.archived then null::timestamptz
              when t.id is null then null::timestamptz
              when t.archived_at is not null then t.archived_at else v_now end as archived_at,
         s.order_email, s.account_number, s.delivery_days, s.cutoff_time, s.min_order_value
    from msm_suppliers m
    left join msm_supplier_sites s on s.supplier_id = m.id and s.location_id = p_loc
    left join suppliers t on t.id = s.venue_supplier_id and t.location_id = p_loc
   where m.org_id = p_org and s.unlinked_at is null
     and (t.id is not null or (coalesce(s.active, m.all_sites) and not m.archived));
  update _w_sups set vid = gen_random_uuid() where vid is null;
  if p_write then
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, 'supplier_site', w.cid, p_loc, case when w.map_new then 'insert' else 'update' end, to_jsonb(s)
      from _w_sups w left join msm_supplier_sites s on s.supplier_id = w.cid and s.location_id = p_loc
     where w.map_new or s.venue_supplier_id is null
    on conflict do nothing;
    insert into msm_supplier_sites (supplier_id, org_id, location_id, venue_supplier_id, active)
    select w.cid, p_org, p_loc, w.vid, null from _w_sups w where w.map_new;
    update msm_supplier_sites s set venue_supplier_id = w.vid, updated_at = now()
      from _w_sups w where s.supplier_id = w.cid and s.location_id = p_loc and s.venue_supplier_id is null;
  end if;

  -- -- packs and unit bridges (follow their item; "off here" or archived archives them) ---------
  drop table if exists _w_packs;
  create temp table _w_packs on commit drop as
  select p.id as cid, ps.venue_format_id as vid, (t.id is null) as is_new, (ps.pack_id is null) as map_new,
         ((wi.alive or wi.held) and not p.archived and not coalesce(ps.off, false)) as alive,
         wi.vid as inventory_item_id, p.name, p.qty_in_base, p.parent_pack_id, null::uuid as parent_format_id,
         p.is_count_default, p.is_purchase_default,
         case when (wi.alive or wi.held) and not p.archived and not coalesce(ps.off, false) then null::timestamptz
              when t.id is null then null::timestamptz
              when t.archived_at is not null then t.archived_at else v_now end as archived_at
    from msm_stock_packs p
    join _w_items wi on wi.cid = p.item_id
    left join msm_stock_pack_sites ps on ps.pack_id = p.id and ps.location_id = p_loc
    left join item_packaging_formats t on t.id = ps.venue_format_id and t.location_id = p_loc
   where p.org_id = p_org and ps.unlinked_at is null
     and (t.id is not null or (wi.alive and not p.archived and not coalesce(ps.off, false)));
  drop table if exists _w_bridges;
  create temp table _w_bridges on commit drop as
  select b.id as cid, bs.venue_conversion_id as vid, (t.id is null) as is_new, (bs.bridge_id is null) as map_new,
         ((wi.alive or wi.held) and not b.archived and not coalesce(bs.off, false)) as alive,
         wi.vid as inventory_item_id, b.from_qty, b.from_unit, b.to_qty, b.to_unit,
         case when (wi.alive or wi.held) and not b.archived and not coalesce(bs.off, false) then null::timestamptz
              when t.id is null then null::timestamptz
              when t.archived_at is not null then t.archived_at else v_now end as archived_at
    from msm_stock_bridges b
    join _w_items wi on wi.cid = b.item_id
    left join msm_stock_bridge_sites bs on bs.bridge_id = b.id and bs.location_id = p_loc
    left join inventory_item_conversions t on t.id = bs.venue_conversion_id and t.location_id = p_loc
   where b.org_id = p_org and bs.unlinked_at is null
     and (t.id is not null or (wi.alive and not b.archived and not coalesce(bs.off, false)));
  update _w_packs set vid = gen_random_uuid() where vid is null;
  update _w_bridges set vid = gen_random_uuid() where vid is null;
  if p_write then
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, 'pack_site', w.cid, p_loc, case when w.map_new then 'insert' else 'update' end, to_jsonb(ps)
      from _w_packs w left join msm_stock_pack_sites ps on ps.pack_id = w.cid and ps.location_id = p_loc
     where w.map_new or ps.venue_format_id is null
    on conflict do nothing;
    insert into msm_stock_pack_sites (pack_id, org_id, location_id, venue_format_id)
    select w.cid, p_org, p_loc, w.vid from _w_packs w where w.map_new;
    update msm_stock_pack_sites s set venue_format_id = w.vid, updated_at = now()
      from _w_packs w where s.pack_id = w.cid and s.location_id = p_loc and s.venue_format_id is null;
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, 'bridge_site', w.cid, p_loc, case when w.map_new then 'insert' else 'update' end, to_jsonb(bs)
      from _w_bridges w left join msm_stock_bridge_sites bs on bs.bridge_id = w.cid and bs.location_id = p_loc
     where w.map_new or bs.venue_conversion_id is null
    on conflict do nothing;
    insert into msm_stock_bridge_sites (bridge_id, org_id, location_id, venue_conversion_id)
    select w.cid, p_org, p_loc, w.vid from _w_bridges w where w.map_new;
    update msm_stock_bridge_sites s set venue_conversion_id = w.vid, updated_at = now()
      from _w_bridges w where s.bridge_id = w.cid and s.location_id = p_loc and s.venue_conversion_id is null;
  end if;
  update _w_packs w set parent_format_id = x.vid from _w_packs x where x.cid = w.parent_pack_id;

  -- -- supplier prices (need the item and the supplier on here) --------------
  drop table if exists _w_sps;
  create temp table _w_sps on commit drop as
  select sp.id as cid, x.venue_supplier_product_id as vid, (t.id is null) as is_new, (x.sp_id is null) as map_new,
         ((wi.alive or wi.held) and ws.alive and not sp.archived and not coalesce(x.off, false)) as alive,
         ws.vid as supplier_id, wi.vid as inventory_item_id, sp.supplier_sku, sp.pack_description, sp.pack_qty, sp.inner_qty, sp.inner_unit,
         coalesce(x.pack_price, sp.pack_price) as pack_price, sp.price_includes_tax,
         case when sp.purchase_tax_rate is null then null::uuid
              when t.purchase_tax_rate_id is not null
                   and (select r.rate from tax_rates r where r.id = t.purchase_tax_rate_id) = sp.purchase_tax_rate then t.purchase_tax_rate_id
              else (select r.id from tax_rates r where r.location_id = p_loc and coalesce(r.active, true) and r.rate = sp.purchase_tax_rate
                     order by r.is_default desc nulls last, r.name, r.id limit 1) end as purchase_tax_rate_id,
         case when (wi.alive or wi.held) and ws.alive and not sp.archived and not coalesce(x.off, false) then null::timestamptz
              when t.id is null then null::timestamptz
              when t.archived_at is not null then t.archived_at else v_now end as archived_at,
         sp.first_choice, sp.created_at, wi.is_new as item_is_new
    from msm_supplier_products sp
    join _w_items wi on wi.cid = sp.item_id
    join _w_sups ws on ws.cid = sp.supplier_id
    left join msm_supplier_product_sites x on x.sp_id = sp.id and x.location_id = p_loc
    left join supplier_products t on t.id = x.venue_supplier_product_id and t.location_id = p_loc
   where sp.org_id = p_org and x.unlinked_at is null
     and (t.id is not null or (wi.alive and ws.alive and not sp.archived and not coalesce(x.off, false)));
  update _w_sps set vid = gen_random_uuid() where vid is null;
  if p_write then
    insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
    select p_version, 'sp_site', w.cid, p_loc, case when w.map_new then 'insert' else 'update' end, to_jsonb(x)
      from _w_sps w left join msm_supplier_product_sites x on x.sp_id = w.cid and x.location_id = p_loc
     where w.map_new or x.venue_supplier_product_id is null
    on conflict do nothing;
    insert into msm_supplier_product_sites (sp_id, org_id, location_id, venue_supplier_product_id)
    select w.cid, p_org, p_loc, w.vid from _w_sps w where w.map_new;
    update msm_supplier_product_sites s set venue_supplier_product_id = w.vid, updated_at = now()
      from _w_sps w where s.sp_id = w.cid and s.location_id = p_loc and s.venue_supplier_product_id is null;
  end if;

  -- -- cost here (plan 4.5): the items whose supplier price this publish adds, changes or switches off
  --    here, and the items new here. Their cost follows the SITE's own rule after the write.
  drop table if exists _w_cost;
  create temp table _w_cost on commit drop as
  select w.inventory_item_id as item
    from _w_sps w left join supplier_products t on t.id = w.vid and t.location_id = p_loc
   where (w.alive and w.is_new)
      or (not w.is_new and ((t.pack_price, t.pack_qty, t.inner_qty, t.inner_unit, coalesce(t.price_includes_tax, false), t.archived_at)
                              is distinct from (w.pack_price, w.pack_qty, w.inner_qty, w.inner_unit, coalesce(w.price_includes_tax, false), w.archived_at)
                            or (coalesce(w.price_includes_tax, false) and t.purchase_tax_rate_id is distinct from w.purchase_tax_rate_id)))
  union
  select w.vid from _w_items w where w.is_new and w.alive;
  drop table if exists _w_price;
  create temp table _w_price (item uuid, sp_id uuid, pack_price numeric, pack_qty numeric, inner_qty numeric, inner_unit text,
                              inc boolean, rate_id uuid, pref boolean) on commit drop;
  if not p_write then
    -- the prices the site will have: the company's as planned (a new one is preferred as the writer
    -- makes it) and the site's own live ones
    insert into _w_price
    select w.inventory_item_id, w.vid, w.pack_price, w.pack_qty, w.inner_qty, w.inner_unit, coalesce(w.price_includes_tax, false), w.purchase_tax_rate_id,
           case when w.is_new then w.rk = 1 and not exists (select 1 from supplier_products e where e.location_id = p_loc and e.inventory_item_id = w.inventory_item_id
                                                             and e.is_preferred and e.archived_at is null)
                else coalesce((select t.is_preferred from supplier_products t where t.id = w.vid and t.location_id = p_loc), false) end
      from (select x.*, case when x.is_new then row_number() over (partition by x.inventory_item_id, x.is_new order by x.first_choice desc, x.created_at, x.cid) end as rk
              from _w_sps x where x.alive) w
     where w.inventory_item_id in (select c.item from _w_cost c);
    insert into _w_price
    select s.inventory_item_id, s.id, s.pack_price, s.pack_qty, s.inner_qty, s.inner_unit, coalesce(s.price_includes_tax, false), s.purchase_tax_rate_id,
           coalesce(s.is_preferred, false)
      from supplier_products s
     where s.location_id = p_loc and s.archived_at is null and s.inventory_item_id in (select c.item from _w_cost c)
       and not exists (select 1 from _w_sps w where w.vid = s.id);
    perform public.msm_stock__cost_plan(p_loc, v_rule);
  end if;

  -- -- what would change ----------------------------------------------------
  select jsonb_build_object(
    'items_new', (select count(*) from _w_items w where w.is_new and w.alive),
    'items_changed', (select count(*) from _w_items w join inventory_items t on t.id = w.vid and t.location_id = p_loc
                       where not w.is_new and (t.company_ref, t.name, t.category, t.accounting_group, t.base_unit, t.allergens, t.sku, t.barcode,
                                              t.shelf_life_days, t.returns_to_shelf, t.purchase_tax_rate_id, t.archived_at)
                                          is distinct from (w.cid, w.name, w.category, w.accounting_group, w.base_unit, w.allergens, w.sku, w.barcode,
                                              w.shelf_life_days, w.returns_to_shelf, w.purchase_tax_rate_id, w.archived_at)),
    'items_off', (select count(*) from _w_items w join inventory_items t on t.id = w.vid and t.location_id = p_loc
                   where not w.is_new and w.archived_at is not null and t.archived_at is null),
    'items_held', (select count(*) from _w_items w where w.held),
    'held_names', (select coalesce(jsonb_agg(w.name order by w.name), '[]'::jsonb) from (select name from _w_items where held order by name limit 10) w),
    'packs_new', (select count(*) from _w_packs w where w.is_new and w.alive),
    'packs_changed', (select count(*) from _w_packs w join item_packaging_formats t on t.id = w.vid and t.location_id = p_loc
                       where not w.is_new and (t.company_ref, t.inventory_item_id, t.name, t.qty_in_base, t.parent_format_id, t.is_count_default,
                                              t.is_purchase_default, t.archived_at)
                                          is distinct from (w.cid, w.inventory_item_id, w.name, w.qty_in_base, w.parent_format_id, w.is_count_default,
                                              w.is_purchase_default, w.archived_at)),
    'bridges_new', (select count(*) from _w_bridges w where w.is_new and w.alive),
    'bridges_changed', (select count(*) from _w_bridges w join inventory_item_conversions t on t.id = w.vid and t.location_id = p_loc
                         where not w.is_new and (t.company_ref, t.inventory_item_id, t.from_qty, t.from_unit, t.to_qty, t.to_unit, t.archived_at)
                                            is distinct from (w.cid, w.inventory_item_id, w.from_qty, w.from_unit, w.to_qty, w.to_unit, w.archived_at)),
    'suppliers_new', (select count(*) from _w_sups w where w.is_new and w.alive),
    'suppliers_changed', (select count(*) from _w_sups w join suppliers t on t.id = w.vid and t.location_id = p_loc
                           where not w.is_new and (t.company_ref, t.name, t.contact_name, t.phone, t.payment_terms_days, t.archived_at)
                                              is distinct from (w.cid, w.name, w.contact_name, w.phone, w.payment_terms_days, w.archived_at)),
    'prices_new', (select count(*) from _w_sps w where w.is_new and w.alive),
    'prices_changed', (select count(*) from _w_sps w join supplier_products t on t.id = w.vid and t.location_id = p_loc
                        where not w.is_new and (t.company_ref, t.supplier_id, t.inventory_item_id, t.supplier_sku, t.pack_description, t.pack_qty,
                                               t.inner_qty, t.inner_unit, t.pack_price, t.price_includes_tax, t.purchase_tax_rate_id, t.archived_at)
                                           is distinct from (w.cid, w.supplier_id, w.inventory_item_id, w.supplier_sku, w.pack_description, w.pack_qty,
                                               w.inner_qty, w.inner_unit, w.pack_price, w.price_includes_tax, w.purchase_tax_rate_id, w.archived_at)),
    'prices_skipped', (select count(*) from msm_supplier_products sp
                         join _w_items wi on wi.cid = sp.item_id and wi.alive
                        where sp.org_id = p_org and not sp.archived
                          and not exists (select 1 from _w_sups ws where ws.cid = sp.supplier_id and ws.alive))
  ) into v_counts;
  if not p_write then
    v_counts := v_counts || jsonb_build_object(
      'cost_rule', v_rule,
      'costs_changed', (select count(*) from _w_newcost),
      'costs', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'before', c.prev, 'after', c.cost, 'new', c.prev is null)
                                          order by c.rk), '[]'::jsonb)
                  from (select x.*, row_number() over (order by (x.prev is null), abs(x.cost - coalesce(x.prev, 0)) / nullif(x.prev, 0) desc nulls last, x.name) as rk
                          from _w_newcost x) c where c.rk <= 10));
  end if;
  v_counts := v_counts || jsonb_build_object('writes',
      (v_counts ->> 'items_new')::int + (v_counts ->> 'items_changed')::int + (v_counts ->> 'packs_new')::int + (v_counts ->> 'packs_changed')::int
    + (v_counts ->> 'bridges_new')::int + (v_counts ->> 'bridges_changed')::int + (v_counts ->> 'suppliers_new')::int
    + (v_counts ->> 'suppliers_changed')::int + (v_counts ->> 'prices_new')::int + (v_counts ->> 'prices_changed')::int);

  if p_detail and not p_write then
    select coalesce(jsonb_agg(d), '[]'::jsonb) into v_detail from (
      select * from (
        select 'item' as kind, w.vid as row_id, w.cid as company_id, w.name as name,
               public.msm_stock__pick(to_jsonb(t), array['name', 'category', 'accounting_group', 'base_unit', 'allergens', 'sku', 'barcode',
                                                         'shelf_life_days', 'returns_to_shelf', 'archived_at'])
                 || jsonb_build_object('vat', public.msm_stock__rate_words(t.purchase_tax_rate_id)) as site,
               jsonb_build_object('name', w.name, 'category', w.category, 'accounting_group', w.accounting_group, 'base_unit', w.base_unit,
                                  'allergens', w.allergens, 'sku', w.sku, 'barcode', w.barcode, 'shelf_life_days', w.shelf_life_days,
                                  'returns_to_shelf', w.returns_to_shelf, 'vat', public.msm_stock__rate_words(w.purchase_tax_rate_id),
                                  'archived_at', w.archived_at) as company,
               (t.company_ref is null) as linking, t.updated_at as site_changed_at
          from _w_items w join inventory_items t on t.id = w.vid and t.location_id = p_loc
         where not w.is_new and (t.company_ref, t.name, t.category, t.accounting_group, t.base_unit, t.allergens, t.sku, t.barcode,
                                t.shelf_life_days, t.returns_to_shelf, t.purchase_tax_rate_id, t.archived_at)
                            is distinct from (w.cid, w.name, w.category, w.accounting_group, w.base_unit, w.allergens, w.sku, w.barcode,
                                w.shelf_life_days, w.returns_to_shelf, w.purchase_tax_rate_id, w.archived_at)
        union all
        select 'supplier', w.vid, w.cid, w.name,
               public.msm_stock__pick(to_jsonb(t), array['name', 'contact_name', 'phone', 'payment_terms_days', 'archived_at']),
               jsonb_build_object('name', w.name, 'contact_name', w.contact_name, 'phone', w.phone, 'payment_terms_days', w.payment_terms_days,
                                  'archived_at', w.archived_at),
               (t.company_ref is null), t.updated_at
          from _w_sups w join suppliers t on t.id = w.vid and t.location_id = p_loc
         where not w.is_new and (t.company_ref, t.name, t.contact_name, t.phone, t.payment_terms_days, t.archived_at)
                            is distinct from (w.cid, w.name, w.contact_name, w.phone, w.payment_terms_days, w.archived_at)
        union all
        select 'price', w.vid, w.cid, coalesce(w.pack_description, w.supplier_sku, 'supplier pack'),
               public.msm_stock__pick(to_jsonb(t), array['supplier_sku', 'pack_description', 'pack_qty', 'inner_qty', 'inner_unit', 'pack_price',
                                                         'price_includes_tax', 'archived_at'])
                 || jsonb_build_object('vat', public.msm_stock__rate_words(t.purchase_tax_rate_id)),
               jsonb_build_object('supplier_sku', w.supplier_sku, 'pack_description', w.pack_description, 'pack_qty', w.pack_qty,
                                  'inner_qty', w.inner_qty, 'inner_unit', w.inner_unit, 'pack_price', w.pack_price,
                                  'price_includes_tax', w.price_includes_tax, 'vat', public.msm_stock__rate_words(w.purchase_tax_rate_id),
                                  'archived_at', w.archived_at),
               (t.company_ref is null), t.updated_at
          from _w_sps w join supplier_products t on t.id = w.vid and t.location_id = p_loc
         where not w.is_new and (t.company_ref, t.supplier_id, t.inventory_item_id, t.supplier_sku, t.pack_description, t.pack_qty,
                                t.inner_qty, t.inner_unit, t.pack_price, t.price_includes_tax, t.purchase_tax_rate_id, t.archived_at)
                            is distinct from (w.cid, w.supplier_id, w.inventory_item_id, w.supplier_sku, w.pack_description, w.pack_qty,
                                w.inner_qty, w.inner_unit, w.pack_price, w.price_includes_tax, w.purchase_tax_rate_id, w.archived_at)
      ) a order by a.kind, a.name limit 200) d;
    v_counts := v_counts || jsonb_build_object('detail', v_detail);
  end if;

  if not p_write then
    return v_counts;
  end if;

  -- -- WRITE. Suppliers, then new items, packs, bridges, prices; the busy items table is updated last.
  -- suppliers
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'suppliers', w.vid, 'insert', null, jsonb_build_object('name', w.name)
    from _w_sups w where w.is_new and w.alive on conflict do nothing;
  insert into suppliers (id, location_id, org_id, name, contact_name, phone, payment_terms_days, archived_at, company_ref,
                         email, account_number, delivery_days, cutoff_time, min_order_value, notes)
  select w.vid, p_loc, p_org, w.name, w.contact_name, w.phone, w.payment_terms_days, null, w.cid,
         w.order_email, w.account_number, coalesce(w.delivery_days, '[]'::jsonb), w.cutoff_time, w.min_order_value, w.notes
    from _w_sups w where w.is_new and w.alive;
  get diagnostics n = row_count; v_writes := v_writes + n;
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'suppliers', t.id, case when t.company_ref is null then 'link' else 'update' end,
         public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('suppliers')),
         jsonb_build_object('company_ref', w.cid, 'name', w.name, 'contact_name', w.contact_name, 'phone', w.phone,
                            'payment_terms_days', w.payment_terms_days, 'archived_at', w.archived_at)
    from _w_sups w join suppliers t on t.id = w.vid and t.location_id = p_loc
   where not w.is_new and (t.company_ref, t.name, t.contact_name, t.phone, t.payment_terms_days, t.archived_at)
                      is distinct from (w.cid, w.name, w.contact_name, w.phone, w.payment_terms_days, w.archived_at)
  on conflict do nothing;
  update suppliers t
     set company_ref = w.cid, name = w.name, contact_name = w.contact_name, phone = w.phone, payment_terms_days = w.payment_terms_days,
         archived_at = w.archived_at, updated_at = now()
    from _w_sups w
   where t.id = w.vid and t.location_id = p_loc and not w.is_new
     and (t.company_ref, t.name, t.contact_name, t.phone, t.payment_terms_days, t.archived_at)
         is distinct from (w.cid, w.name, w.contact_name, w.phone, w.payment_terms_days, w.archived_at);
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- new items (on hand 0, no cost: the site's own cost rule and its opening count set those)
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'inventory_items', w.vid, 'insert', null, jsonb_build_object('name', w.name)
    from _w_items w where w.is_new and w.alive on conflict do nothing;
  insert into inventory_items (id, location_id, org_id, name, kind, base_unit, accounting_group, category, allergens, shelf_life_days,
                               sku, barcode, returns_to_shelf, purchase_tax_rate_id, archived_at, company_ref, on_hand, current_cost)
  select w.vid, p_loc, p_org, w.name, case when w.made_here then 'MADE' else 'PURCHASED' end, w.base_unit, w.accounting_group, w.category,
         coalesce(w.allergens, '[]'::jsonb), w.shelf_life_days, w.sku, w.barcode, coalesce(w.returns_to_shelf, false), w.purchase_tax_rate_id,
         null, w.cid, 0, null
    from _w_items w where w.is_new and w.alive;
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- packs
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'item_packaging_formats', w.vid, 'insert', null, jsonb_build_object('name', w.name)
    from _w_packs w where w.is_new and w.alive on conflict do nothing;
  insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, parent_format_id, is_count_default,
                                      is_purchase_default, archived_at, company_ref)
  select w.vid, p_loc, w.inventory_item_id, w.name, w.qty_in_base, w.parent_format_id, w.is_count_default, w.is_purchase_default, null, w.cid
    from _w_packs w where w.is_new and w.alive;
  get diagnostics n = row_count; v_writes := v_writes + n;
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'item_packaging_formats', t.id, case when t.company_ref is null then 'link' else 'update' end,
         public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('item_packaging_formats')),
         jsonb_build_object('company_ref', w.cid, 'name', w.name, 'qty_in_base', w.qty_in_base, 'archived_at', w.archived_at)
    from _w_packs w join item_packaging_formats t on t.id = w.vid and t.location_id = p_loc
   where not w.is_new and (t.company_ref, t.inventory_item_id, t.name, t.qty_in_base, t.parent_format_id, t.is_count_default,
                          t.is_purchase_default, t.archived_at)
                      is distinct from (w.cid, w.inventory_item_id, w.name, w.qty_in_base, w.parent_format_id, w.is_count_default,
                          w.is_purchase_default, w.archived_at)
  on conflict do nothing;
  update item_packaging_formats t
     set company_ref = w.cid, inventory_item_id = w.inventory_item_id, name = w.name, qty_in_base = w.qty_in_base,
         parent_format_id = w.parent_format_id, is_count_default = w.is_count_default, is_purchase_default = w.is_purchase_default,
         archived_at = w.archived_at
    from _w_packs w
   where t.id = w.vid and t.location_id = p_loc and not w.is_new
     and (t.company_ref, t.inventory_item_id, t.name, t.qty_in_base, t.parent_format_id, t.is_count_default, t.is_purchase_default, t.archived_at)
         is distinct from (w.cid, w.inventory_item_id, w.name, w.qty_in_base, w.parent_format_id, w.is_count_default, w.is_purchase_default, w.archived_at);
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- unit bridges
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'inventory_item_conversions', w.vid, 'insert', null,
         jsonb_build_object('from_qty', w.from_qty, 'from_unit', w.from_unit, 'to_qty', w.to_qty, 'to_unit', w.to_unit)
    from _w_bridges w where w.is_new and w.alive on conflict do nothing;
  insert into inventory_item_conversions (id, location_id, inventory_item_id, from_qty, from_unit, to_qty, to_unit, archived_at, company_ref)
  select w.vid, p_loc, w.inventory_item_id, w.from_qty, w.from_unit, w.to_qty, w.to_unit, null, w.cid
    from _w_bridges w where w.is_new and w.alive;
  get diagnostics n = row_count; v_writes := v_writes + n;
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'inventory_item_conversions', t.id, case when t.company_ref is null then 'link' else 'update' end,
         public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('inventory_item_conversions')),
         jsonb_build_object('company_ref', w.cid, 'from_qty', w.from_qty, 'from_unit', w.from_unit, 'to_qty', w.to_qty, 'to_unit', w.to_unit,
                            'archived_at', w.archived_at)
    from _w_bridges w join inventory_item_conversions t on t.id = w.vid and t.location_id = p_loc
   where not w.is_new and (t.company_ref, t.inventory_item_id, t.from_qty, t.from_unit, t.to_qty, t.to_unit, t.archived_at)
                      is distinct from (w.cid, w.inventory_item_id, w.from_qty, w.from_unit, w.to_qty, w.to_unit, w.archived_at)
  on conflict do nothing;
  update inventory_item_conversions t
     set company_ref = w.cid, inventory_item_id = w.inventory_item_id, from_qty = w.from_qty, from_unit = w.from_unit,
         to_qty = w.to_qty, to_unit = w.to_unit, archived_at = w.archived_at
    from _w_bridges w
   where t.id = w.vid and t.location_id = p_loc and not w.is_new
     and (t.company_ref, t.inventory_item_id, t.from_qty, t.from_unit, t.to_qty, t.to_unit, t.archived_at)
         is distinct from (w.cid, w.inventory_item_id, w.from_qty, w.from_unit, w.to_qty, w.to_unit, w.archived_at);
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- supplier prices; preferred ONLY on insert, and only when the item has no preferred supplier here yet
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'supplier_products', w.vid, 'insert', null, jsonb_build_object('pack_price', w.pack_price)
    from _w_sps w where w.is_new and w.alive on conflict do nothing;
  insert into supplier_products (id, location_id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty, inner_qty,
                                 inner_unit, pack_price, is_preferred, purchase_tax_rate_id, price_includes_tax, archived_at, company_ref)
  select w.vid, p_loc, w.inventory_item_id, w.supplier_id, w.supplier_sku, w.pack_description, w.pack_qty, w.inner_qty, w.inner_unit,
         w.pack_price,
         (w.rk = 1 and not exists (select 1 from supplier_products e where e.location_id = p_loc and e.inventory_item_id = w.inventory_item_id
                                     and e.is_preferred and e.archived_at is null)),
         w.purchase_tax_rate_id, coalesce(w.price_includes_tax, false), null, w.cid
    from (select x.*, row_number() over (partition by x.inventory_item_id order by x.first_choice desc, x.created_at, x.cid) as rk
            from _w_sps x where x.is_new and x.alive) w;
  get diagnostics n = row_count; v_writes := v_writes + n;
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'supplier_products', t.id, case when t.company_ref is null then 'link' else 'update' end,
         public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('supplier_products')),
         jsonb_build_object('company_ref', w.cid, 'pack_price', w.pack_price, 'pack_description', w.pack_description, 'archived_at', w.archived_at)
    from _w_sps w join supplier_products t on t.id = w.vid and t.location_id = p_loc
   where not w.is_new and (t.company_ref, t.supplier_id, t.inventory_item_id, t.supplier_sku, t.pack_description, t.pack_qty, t.inner_qty,
                          t.inner_unit, t.pack_price, t.price_includes_tax, t.purchase_tax_rate_id, t.archived_at)
                      is distinct from (w.cid, w.supplier_id, w.inventory_item_id, w.supplier_sku, w.pack_description, w.pack_qty, w.inner_qty,
                          w.inner_unit, w.pack_price, w.price_includes_tax, w.purchase_tax_rate_id, w.archived_at)
  on conflict do nothing;
  update supplier_products t
     set company_ref = w.cid, supplier_id = w.supplier_id, inventory_item_id = w.inventory_item_id, supplier_sku = w.supplier_sku,
         pack_description = w.pack_description, pack_qty = w.pack_qty, inner_qty = w.inner_qty, inner_unit = w.inner_unit,
         pack_price = w.pack_price, price_includes_tax = coalesce(w.price_includes_tax, false), purchase_tax_rate_id = w.purchase_tax_rate_id,
         archived_at = w.archived_at, updated_at = now()
    from _w_sps w
   where t.id = w.vid and t.location_id = p_loc and not w.is_new
     and (t.company_ref, t.supplier_id, t.inventory_item_id, t.supplier_sku, t.pack_description, t.pack_qty, t.inner_qty, t.inner_unit,
          t.pack_price, t.price_includes_tax, t.purchase_tax_rate_id, t.archived_at)
         is distinct from (w.cid, w.supplier_id, w.inventory_item_id, w.supplier_sku, w.pack_description, w.pack_qty, w.inner_qty, w.inner_unit,
          w.pack_price, w.price_includes_tax, w.purchase_tax_rate_id, w.archived_at);
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- cost here: the site's own rule over the prices as they are now written (applied last, below)
  if exists (select 1 from _w_cost) then
    insert into _w_price
    select s.inventory_item_id, s.id, s.pack_price, s.pack_qty, s.inner_qty, s.inner_unit, coalesce(s.price_includes_tax, false), s.purchase_tax_rate_id,
           coalesce(s.is_preferred, false)
      from supplier_products s
     where s.location_id = p_loc and s.archived_at is null and s.inventory_item_id in (select c.item from _w_cost c);
  end if;
  perform public.msm_stock__cost_plan(p_loc, v_rule);

  -- items new in this run: their preferred supplier (insert only) and their first area (exactly one
  -- live area of the usual kind at the site; otherwise the site picks)
  update inventory_items t
     set default_supplier_id = sp.supplier_id
    from supplier_products sp, _w_items w
   where w.is_new and w.alive and t.id = w.vid and t.location_id = p_loc and t.default_supplier_id is null
     and sp.location_id = p_loc and sp.inventory_item_id = t.id and sp.is_preferred and sp.archived_at is null;
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'inventory_item_areas', gen_random_uuid(), 'insert', null,
         jsonb_build_object('item', w.vid, 'area_id', (select sa.id from storage_areas sa where sa.location_id = p_loc
                                                        and sa.archived_at is null and sa.kind = w.default_area_kind))
    from _w_items w
   where w.is_new and w.alive and w.default_area_kind is not null
     and (select count(*) from storage_areas sa where sa.location_id = p_loc and sa.archived_at is null and sa.kind = w.default_area_kind) = 1
     and not exists (select 1 from inventory_item_areas ia where ia.inventory_item_id = w.vid);
  insert into inventory_item_areas (id, location_id, inventory_item_id, area_id, is_primary)
  select vr.row_id, p_loc, (vr.after ->> 'item')::uuid, (vr.after ->> 'area_id')::uuid, true
    from msm_stock_version_rows vr
   where vr.version_id = p_version and vr.location_id = p_loc and vr.tbl = 'inventory_item_areas' and vr.op = 'insert'
     and not exists (select 1 from inventory_item_areas ia where ia.id = vr.row_id or ia.inventory_item_id = (vr.after ->> 'item')::uuid);

  -- the busy table last: changed company columns of existing items only (2 s lock wait, set by the runner)
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'inventory_items', t.id, case when t.company_ref is null then 'link' else 'update' end,
         public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('inventory_items')),
         jsonb_build_object('company_ref', w.cid, 'name', w.name, 'category', w.category, 'base_unit', w.base_unit, 'sku', w.sku,
                            'archived_at', w.archived_at)
    from _w_items w join inventory_items t on t.id = w.vid and t.location_id = p_loc
   where not w.is_new and (t.company_ref, t.name, t.category, t.accounting_group, t.base_unit, t.allergens, t.sku, t.barcode,
                          t.shelf_life_days, t.returns_to_shelf, t.purchase_tax_rate_id, t.archived_at)
                      is distinct from (w.cid, w.name, w.category, w.accounting_group, w.base_unit, w.allergens, w.sku, w.barcode,
                          w.shelf_life_days, w.returns_to_shelf, w.purchase_tax_rate_id, w.archived_at)
  on conflict do nothing;
  update inventory_items t
     set company_ref = w.cid, name = w.name, category = w.category, accounting_group = w.accounting_group, base_unit = w.base_unit,
         allergens = coalesce(w.allergens, '[]'::jsonb), sku = w.sku, barcode = w.barcode, shelf_life_days = w.shelf_life_days,
         returns_to_shelf = coalesce(w.returns_to_shelf, false), purchase_tax_rate_id = w.purchase_tax_rate_id, archived_at = w.archived_at,
         updated_at = now()
    from _w_items w
   where t.id = w.vid and t.location_id = p_loc and not w.is_new
     and (t.company_ref, t.name, t.category, t.accounting_group, t.base_unit, t.allergens, t.sku, t.barcode, t.shelf_life_days,
          t.returns_to_shelf, t.purchase_tax_rate_id, t.archived_at)
         is distinct from (w.cid, w.name, w.category, w.accounting_group, w.base_unit, w.allergens, w.sku, w.barcode, w.shelf_life_days,
          w.returns_to_shelf, w.purchase_tax_rate_id, w.archived_at)
     and (w.archived_at is null or t.archived_at is not null or coalesce(t.on_hand, 0) = 0);
  get diagnostics n = row_count; v_writes := v_writes + n;

  -- cost here, last: only items whose cost the site's own rule moves (never 0); one row each for
  -- Undo (the cost before, the cost history rows it closed, the one it opened)
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_version, p_loc, 'item_cost', c.item, 'update',
         jsonb_build_object('current_cost', c.prev, 'open_history',
           (select coalesce(jsonb_agg(h.id), '[]'::jsonb) from item_cost_history h
             where h.location_id = p_loc and h.inventory_item_id = c.item and h.effective_to is null)),
         jsonb_build_object('current_cost', c.cost, 'history_id', c.hist_id, 'name', c.name)
    from _w_newcost c
  on conflict do nothing;
  update item_cost_history h set effective_to = v_now
    from _w_newcost c
   where h.location_id = p_loc and h.inventory_item_id = c.item and h.effective_to is null;
  insert into item_cost_history (id, location_id, inventory_item_id, supplier_product_id, pack_price, base_unit_cost, source, effective_from)
  select c.hist_id, p_loc, c.item, c.sp_id, round(c.net, 4), c.cost, 'CATALOG', v_now from _w_newcost c;
  update inventory_items t set current_cost = c.cost
    from _w_newcost c
   where t.id = c.item and t.location_id = p_loc and t.current_cost is distinct from c.cost;
  get diagnostics n = row_count;

  return v_counts || jsonb_build_object('written', v_writes, 'costs_set', n);
end
$fn$;

-- ============================================================================
-- 11. HEALTH CHECK (stops a publish in words) AND PREVIEW
-- ============================================================================
create or replace function public.msm_stock__health(p_org uuid, p_loc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_site text := coalesce((select l.name from locations l where l.id = p_loc), 'this site');
  v_block jsonb := '[]'::jsonb;
  v_warn jsonb := '[]'::jsonb;
  v_new integer;
  r record;
begin
  -- the company items on at this site (their own tick, else the item's every site switch)
  drop table if exists _h_on;
  create temp table _h_on on commit drop as
  select i.id, i.name, i.base_unit, i.purchase_tax_rate, s.venue_item_id
    from msm_stock_items i
    left join msm_stock_item_sites s on s.item_id = i.id and s.location_id = p_loc
   where i.org_id = p_org and not i.archived and coalesce(s.active, i.all_sites) and s.unlinked_at is null;

  -- VAT: an item or a price needs a VAT rate the site has
  for r in
    select x.rate, count(*) as n, string_agg(x.name, ', ' order by x.name) filter (where x.rk <= 3) as names
      from (select h.purchase_tax_rate as rate, h.name, row_number() over (partition by h.purchase_tax_rate order by h.name) as rk
              from _h_on h
             where h.purchase_tax_rate is not null
               and not exists (select 1 from tax_rates tr where tr.location_id = p_loc and coalesce(tr.active, true) and tr.rate = h.purchase_tax_rate)
               and not exists (select 1 from inventory_items t join tax_rates tr on tr.id = t.purchase_tax_rate_id
                                where t.id = h.venue_item_id and t.location_id = p_loc and tr.rate = h.purchase_tax_rate)
            union all
            select sp.purchase_tax_rate, coalesce(sp.pack_description, h.name), row_number() over (partition by sp.purchase_tax_rate order by h.name)
              from msm_supplier_products sp
              join _h_on h on h.id = sp.item_id
             where sp.org_id = p_org and not sp.archived and sp.purchase_tax_rate is not null
               and not exists (select 1 from tax_rates tr where tr.location_id = p_loc and coalesce(tr.active, true) and tr.rate = sp.purchase_tax_rate)) x
     group by x.rate
  loop
    v_block := v_block || jsonb_build_array(jsonb_build_object('code', 'vat_missing', 'words',
      format('%s has no %s%% VAT rate, which %s stock row%s use%s (%s). Add the rate at %s (Back Office, Tax and VAT), then publish again.',
             v_site, trim(trailing '.' from trim(trailing '0' from to_char(r.rate * 100, 'FM990.000'))), r.n, case when r.n = 1 then '' else 's' end,
             case when r.n = 1 then 's' else '' end, r.names, v_site)));
  end loop;

  -- units: a supplier pack whose unit cannot become the item's base unit
  for r in
    select h.name, sp.inner_unit, h.base_unit
      from msm_supplier_products sp
      join _h_on h on h.id = sp.item_id
      join stock_units uf on uf.code = sp.inner_unit
      join stock_units ub on ub.code = h.base_unit
     where sp.org_id = p_org and not sp.archived and uf.dimension <> ub.dimension
       and not exists (select 1 from msm_stock_bridges b
                         join stock_units bf on bf.code = b.from_unit join stock_units bt on bt.code = b.to_unit
                        where b.item_id = h.id and not b.archived
                          and ((bf.dimension = uf.dimension and bt.dimension = ub.dimension) or (bt.dimension = uf.dimension and bf.dimension = ub.dimension)))
     order by h.name limit 5
  loop
    v_block := v_block || jsonb_build_array(jsonb_build_object('code', 'unit_no_path', 'words',
      format('%s is bought in %s but counted in %s, and there is no unit bridge between them. Add one on the item.', r.name, r.inner_unit, r.base_unit)));
  end loop;

  -- base unit: the company's unit differs from the site row's while that row is in use there (its
  -- stock, counts, pars and orders are figures in the site's unit)
  for r in
    with d as materialized (
      select h.name, t.id, t.base_unit as site_unit, h.base_unit
        from _h_on h
        join inventory_items t on t.id = h.venue_item_id and t.location_id = p_loc
       where t.base_unit is distinct from h.base_unit)
    select d.name, d.site_unit, d.base_unit from d
     where public.msm_stock__site_item_in_use(p_loc, d.id)
     order by d.name limit 5
  loop
    v_block := v_block || jsonb_build_array(jsonb_build_object('code', 'unit_in_use', 'words',
      format('%s is counted in %s at %s and has stock, counts, pars or orders there, so it cannot change to %s. Undo that change, or make a new item instead.',
             r.name, r.site_unit, v_site, r.base_unit)));
  end loop;

  -- warnings
  select count(*) into v_new from _h_on h
   where not exists (select 1 from inventory_items t where t.id = h.venue_item_id and t.location_id = p_loc);
  if v_new > 0 then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'new_items', 'count', v_new, 'words',
      format('%s new stock item%s arrive%s at %s with nothing on hand: count %s (an Opening count) before trusting the numbers.',
             v_new, case when v_new = 1 then '' else 's' end, case when v_new = 1 then 's' else '' end, v_site,
             case when v_new = 1 then 'it' else 'them' end)));
  end if;
  for r in
    select h.name from _h_on h
     where h.venue_item_id is null
       and exists (select 1 from inventory_items t where t.location_id = p_loc and t.company_ref is null and t.archived_at is null
                    and lower(btrim(t.name)) = lower(btrim(h.name)) and t.base_unit = h.base_unit)
     order by h.name limit 5
  loop
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'duplicate_name', 'words',
      format('%s already has its own %s: link it (Set up, Link site items) instead of adding a second one.', v_site, r.name)));
  end loop;
  if exists (select 1 from msm_supplier_products sp join _h_on h on h.id = sp.item_id
              join msm_suppliers m on m.id = sp.supplier_id
              left join msm_supplier_sites ss on ss.supplier_id = sp.supplier_id and ss.location_id = p_loc
              where sp.org_id = p_org and not sp.archived
                and not (coalesce(ss.active, m.all_sites) and not m.archived and ss.unlinked_at is null)) then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'supplier_off', 'words',
      format('Some supplier prices do not go to %s because their supplier is not on there.', v_site)));
  end if;
  return jsonb_build_object('block', v_block, 'warn', v_warn);
end
$fn$;

-- Fresh statistics before a big draft is frozen: right after Start from a site or a big staging the
-- planner still thinks these tables are empty, and the freeze then ran past 8 s (1.5 s once analysed).
create or replace function public.msm_stock__fresh_stats(p_draft uuid, p_frozen boolean)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_draft is not null and (select count(*) from msm_stock_changes c where c.draft_id = p_draft) > 2000 then
    if not p_frozen then
      analyze public.msm_stock_changes;
    else
      analyze public.msm_stock_items;
      analyze public.msm_stock_item_sites;
      analyze public.msm_stock_packs;
      analyze public.msm_suppliers;
      analyze public.msm_supplier_sites;
      analyze public.msm_supplier_products;
    end if;
  end if;
end
$fn$;

-- The sites of a company that stock publishing reaches.
create or replace function public.msm_stock__sites(p_org uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $fn$
  -- every site of the company (an item on "every site" reaches a site with no row of its own)
  select l.id from locations l where l.org_id = p_org order by l.name, l.id;
$fn$;

-- Preview: the open draft applied, every site planned and health checked, then all of it rolled
-- back (nothing is written). Sites in pages (p_sites; null = every site the draft reaches, at most 20).
create or replace function public.msm_stock_preview(p_org uuid, p_sites uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  v_out jsonb := '[]'::jsonb;
  v_loc uuid;
  v_changes integer;
  v_err text;
begin
  perform public.msm_stock__require_viewer(p_org);
  select d.id into v_draft from msm_stock_drafts d where d.org_id = p_org and d.status = 'open';
  v_changes := coalesce((select count(*) from msm_stock_changes c where c.draft_id = v_draft), 0);
  perform public.msm_stock__fresh_stats(v_draft, false);
  begin
    if v_draft is not null then
      perform public.msm_stock__freeze(p_org, v_draft, null);
    end if;
    for v_loc in
      select x from unnest(coalesce(p_sites, (select array_agg(s) from (select public.msm_stock__sites(p_org) s limit 20) z))) x
       where public.msm_stock__venue_in_org(x, p_org)
    loop
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'location_id', v_loc, 'name', (select l.name from locations l where l.id = v_loc),
        'plan', public.msm_stock__sync_site(p_org, v_loc, null, false, false),
        'health', public.msm_stock__health(p_org, v_loc)));
    end loop;
    raise exception using errcode = 'P0001', message = 'msm_stock_preview_rollback';
  exception when others then
    if sqlerrm <> 'msm_stock_preview_rollback' then
      v_err := sqlerrm;
    end if;
  end;
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err, 'changes', v_changes);
  end if;
  return jsonb_build_object('ok', true, 'changes', v_changes, 'sites', v_out,
                            'all_sites', (select count(*) from public.msm_stock__sites(p_org) s));
end
$fn$;

-- ============================================================================
-- 12. PUBLISH, RUN NOW, RETRY, UNDO, KEEP THE SITE'S
-- ============================================================================

-- 05:00 next, on the site's own clock (outside trading by default, decision 2 in 11.10).
create or replace function public.msm_stock__next_quiet(p_loc uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $fn$
  select case when (now() at time zone x.tz)::time < time '05:00'
              then ((now() at time zone x.tz)::date + time '05:00') at time zone x.tz
              else (((now() at time zone x.tz)::date + 1) + time '05:00') at time zone x.tz end
    from (select coalesce(nullif(btrim((select l.timezone from locations l where l.id = p_loc)), ''), 'Europe/London') as tz) x;
$fn$;

create or replace function public.msm_stock__new_version(p_org uuid, p_kind text, p_draft uuid, p_undo_of uuid, p_mode text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
begin
  insert into msm_stock_versions (org_id, version_no, kind, draft_id, undo_of, status, run_mode, note, created_by, created_by_name)
  values (p_org, coalesce((select max(v.version_no) from msm_stock_versions v where v.org_id = p_org), 0) + 1, p_kind, p_draft, p_undo_of,
          'waiting', coalesce(p_mode, 'night'), p_note, auth.uid(),
          (select coalesce(nullif(btrim(p.full_name), ''), p.email) from user_profiles p where p.id = auth.uid()))
  returning id into v_id;
  return v_id;
end
$fn$;

-- A version's status from its sites.
create or replace function public.msm_stock__refresh_version(p_version uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
begin
  select case when bool_or(s.status in ('waiting', 'running')) then 'waiting'
              when bool_or(s.status = 'failed') then 'failed'
              else 'done' end
    into v_status
    from msm_stock_version_sites s where s.version_id = p_version;
  update msm_stock_versions v
     set status = case when v.status = 'undone' then 'undone' else coalesce(v_status, 'done') end,
         finished_at = case when coalesce(v_status, 'done') in ('done', 'failed') then coalesce(v.finished_at, now()) else null end,
         summary = (select jsonb_build_object('sites', count(*), 'done', count(*) filter (where s.status in ('done', 'nothing')),
                                              'waiting', count(*) filter (where s.status in ('waiting', 'running')),
                                              'failed', count(*) filter (where s.status = 'failed'), 'writes', coalesce(sum(s.writes), 0))
                      from msm_stock_version_sites s where s.version_id = p_version)
   where v.id = p_version
  returning v.status into v_status;
  return v_status;
end
$fn$;

create or replace function public.msm_stock__busy_words(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select format('Version %s is still waiting at %s (%s). Run it now, or undo it, before publishing again.', v.version_no,
                (select string_agg(l.name, ', ' order by l.name) from msm_stock_version_sites s join locations l on l.id = s.location_id
                  where s.version_id = v.id and s.status in ('waiting', 'running', 'failed')),
                case when v.run_mode = 'night' then '05:00 at each site' else 'now' end)
    from msm_stock_versions v
   where v.org_id = p_org
     and exists (select 1 from msm_stock_version_sites s where s.version_id = v.id and s.status in ('waiting', 'running', 'failed'))
   order by v.version_no desc limit 1;
$fn$;

create or replace function public.msm_stock_publish(p_org uuid, p_when text default 'night', p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  v_version uuid;
  v_busy text;
  v_loc uuid;
  v_h jsonb;
  v_blocks jsonb := '[]'::jsonb;
  v_sites integer := 0;
begin
  perform public.msm_stock__require_editor(p_org);
  if not public.msm_stock__company_on(p_org) then
    raise exception 'Shared stock is switched off for this company, so nothing can be published.' using errcode = '55000';
  end if;
  if p_when not in ('now', 'night') then
    raise exception 'Publish now or tonight (05:00 at each site).' using errcode = '22023';
  end if;
  -- one publish at a time per company
  perform 1 from stock_company c where c.org_id = p_org for update;
  v_busy := public.msm_stock__busy_words(p_org);
  if v_busy is not null then
    raise exception '%', v_busy using errcode = '55000';
  end if;
  select d.id into v_draft from msm_stock_drafts d where d.org_id = p_org and d.status = 'open' for update;
  if v_draft is null or not exists (select 1 from msm_stock_changes c where c.draft_id = v_draft) then
    raise exception 'There is nothing to publish: no changes are staged.' using errcode = '22023';
  end if;
  perform public.msm_stock__fresh_stats(v_draft, false);
  v_version := public.msm_stock__new_version(p_org, 'publish', v_draft, null, p_when, p_note);
  perform public.msm_stock__freeze(p_org, v_draft, v_version);
  perform public.msm_stock__fresh_stats(v_draft, true);
  for v_loc in select public.msm_stock__sites(p_org) loop
    v_h := public.msm_stock__health(p_org, v_loc);
    if jsonb_array_length(v_h -> 'block') > 0 then
      v_blocks := v_blocks || (v_h -> 'block');
    end if;
    insert into msm_stock_version_sites (version_id, org_id, location_id, status, due_at)
    values (v_version, p_org, v_loc, 'waiting', case when p_when = 'now' then now() else public.msm_stock__next_quiet(v_loc) end);
    v_sites := v_sites + 1;
  end loop;
  if jsonb_array_length(v_blocks) > 0 then
    raise exception 'Not published: %', (select string_agg(b ->> 'words', ' ') from (select b from jsonb_array_elements(v_blocks) b limit 6) z)
      using errcode = '22023';
  end if;
  update msm_stock_drafts set status = 'published', updated_at = now() where id = v_draft;
  perform public.msm_stock__refresh_version(v_version);
  return jsonb_build_object('ok', true, 'version_id', v_version,
                            'version_no', (select v.version_no from msm_stock_versions v where v.id = v_version),
                            'sites', v_sites, 'when', p_when);
end
$fn$;

create or replace function public.msm_stock_run_now(p_org uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  update msm_stock_version_sites s set due_at = now(), status = 'waiting', last_error = null
   where s.version_id = p_version and s.org_id = p_org and s.status in ('waiting', 'failed');
  get diagnostics n = row_count;
  update msm_stock_versions set run_mode = 'now' where id = p_version and org_id = p_org;
  perform public.msm_stock__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'sites', n);
end
$fn$;

-- Undo the latest version: company rows back exactly at once; at each site it reached, the rows it
-- changed are put back and the rows it inserted (and nothing has used since) are removed; a row
-- that has been used is archived and becomes the site's own. Sites it had not reached are cancelled.
create or replace function public.msm_stock_undo(p_org uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v record;
  v_undo uuid;
  n integer := 0;
begin
  perform public.msm_stock__require_editor(p_org);
  perform 1 from stock_company c where c.org_id = p_org for update;
  select * into v from msm_stock_versions x where x.id = p_version and x.org_id = p_org for update;
  if not found then raise exception 'That version was not found.' using errcode = '22023'; end if;
  if v.status = 'undone' or v.kind = 'undo' then
    raise exception 'That version has been undone already, or is itself an undo.' using errcode = '55000';
  end if;
  if exists (select 1 from msm_stock_versions x where x.org_id = p_org and x.version_no > v.version_no and x.status <> 'undone' and x.kind <> 'undo') then
    raise exception 'Only the newest version can be undone. Undo the newer ones first.' using errcode = '55000';
  end if;
  if exists (select 1 from msm_stock_version_sites s where s.version_id = p_version and s.status = 'running') then
    raise exception 'That version is being written at a site right now. Try again in a minute.' using errcode = '55000';
  end if;
  v_undo := public.msm_stock__new_version(p_org, 'undo', null, p_version, 'now', format('Undo of version %s', v.version_no));

  -- company rows back (updated rows to their before image; inserted rows deleted, children first)
  update msm_stock_items t set (name, category, accounting_group, base_unit, allergens, sku, barcode, shelf_life_days, purchase_tax_rate,
                                default_area_kind, returns_to_shelf, notes, all_sites, archived, updated_at, updated_by)
    = (select r.name, r.category, r.accounting_group, r.base_unit, r.allergens, r.sku, r.barcode, r.shelf_life_days, r.purchase_tax_rate,
              r.default_area_kind, r.returns_to_shelf, r.notes, r.all_sites, r.archived, r.updated_at, r.updated_by
         from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'item' and c.op = 'update' and c.entity_id = t.id;
  update msm_suppliers t set (name, contact_name, contact_email, phone, payment_terms_days, notes, all_sites, archived, updated_at)
    = (select r.name, r.contact_name, r.contact_email, r.phone, r.payment_terms_days, r.notes, r.all_sites, r.archived, r.updated_at
         from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'supplier' and c.op = 'update' and c.entity_id = t.id;
  update msm_stock_packs t set (item_id, name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default, archived, updated_at)
    = (select r.item_id, r.name, r.qty_in_base, r.parent_pack_id, r.is_count_default, r.is_purchase_default, r.archived, r.updated_at
         from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'pack' and c.op = 'update' and c.entity_id = t.id;
  update msm_stock_bridges t set (item_id, from_qty, from_unit, to_qty, to_unit, archived, updated_at)
    = (select r.item_id, r.from_qty, r.from_unit, r.to_qty, r.to_unit, r.archived, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'bridge' and c.op = 'update' and c.entity_id = t.id;
  update msm_supplier_products t set (supplier_id, item_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price,
                                      price_includes_tax, purchase_tax_rate, first_choice, archived, updated_at)
    = (select r.supplier_id, r.item_id, r.supplier_sku, r.pack_description, r.pack_qty, r.inner_qty, r.inner_unit, r.pack_price,
              r.price_includes_tax, r.purchase_tax_rate, r.first_choice, r.archived, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'sp' and c.op = 'update' and c.entity_id = t.id;
  update msm_stock_item_sites t set (venue_item_id, active, made_here, kept, unlinked_at, updated_at)
    = (select r.venue_item_id, r.active, r.made_here, r.kept, r.unlinked_at, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'item_site' and c.op = 'update'
     and c.entity_id = t.item_id and c.location_key = t.location_id;
  update msm_supplier_sites t set (venue_supplier_id, active, account_number, order_email, delivery_days, cutoff_time, min_order_value, unlinked_at, updated_at)
    = (select r.venue_supplier_id, r.active, r.account_number, r.order_email, r.delivery_days, r.cutoff_time, r.min_order_value, r.unlinked_at, r.updated_at
         from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'supplier_site' and c.op = 'update'
     and c.entity_id = t.supplier_id and c.location_key = t.location_id;
  update msm_stock_pack_sites t set (venue_format_id, off, unlinked_at, updated_at)
    = (select r.venue_format_id, r.off, r.unlinked_at, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'pack_site' and c.op = 'update'
     and c.entity_id = t.pack_id and c.location_key = t.location_id;
  update msm_stock_bridge_sites t set (venue_conversion_id, off, unlinked_at, updated_at)
    = (select r.venue_conversion_id, r.off, r.unlinked_at, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'bridge_site' and c.op = 'update'
     and c.entity_id = t.bridge_id and c.location_key = t.location_id;
  update msm_supplier_product_sites t set (venue_supplier_product_id, off, pack_price, unlinked_at, updated_at)
    = (select r.venue_supplier_product_id, r.off, r.pack_price, r.unlinked_at, r.updated_at from jsonb_populate_record(t, c.before) r)
    from msm_stock_version_company c where c.version_id = p_version and c.tbl = 'sp_site' and c.op = 'update'
     and c.entity_id = t.sp_id and c.location_key = t.location_id;
  delete from msm_supplier_product_sites t using msm_stock_version_company c
   where c.version_id = p_version and c.tbl = 'sp_site' and c.op = 'insert' and c.entity_id = t.sp_id and c.location_key = t.location_id;
  delete from msm_stock_pack_sites t using msm_stock_version_company c
   where c.version_id = p_version and c.tbl = 'pack_site' and c.op = 'insert' and c.entity_id = t.pack_id and c.location_key = t.location_id;
  delete from msm_stock_bridge_sites t using msm_stock_version_company c
   where c.version_id = p_version and c.tbl = 'bridge_site' and c.op = 'insert' and c.entity_id = t.bridge_id and c.location_key = t.location_id;
  delete from msm_supplier_sites t using msm_stock_version_company c
   where c.version_id = p_version and c.tbl = 'supplier_site' and c.op = 'insert' and c.entity_id = t.supplier_id and c.location_key = t.location_id;
  delete from msm_stock_item_sites t using msm_stock_version_company c
   where c.version_id = p_version and c.tbl = 'item_site' and c.op = 'insert' and c.entity_id = t.item_id and c.location_key = t.location_id;
  delete from msm_supplier_products t using msm_stock_version_company c where c.version_id = p_version and c.tbl = 'sp' and c.op = 'insert' and c.entity_id = t.id;
  delete from msm_stock_packs t using msm_stock_version_company c where c.version_id = p_version and c.tbl = 'pack' and c.op = 'insert' and c.entity_id = t.id;
  delete from msm_stock_bridges t using msm_stock_version_company c where c.version_id = p_version and c.tbl = 'bridge' and c.op = 'insert' and c.entity_id = t.id;
  delete from msm_suppliers t using msm_stock_version_company c where c.version_id = p_version and c.tbl = 'supplier' and c.op = 'insert' and c.entity_id = t.id;
  delete from msm_stock_items t using msm_stock_version_company c where c.version_id = p_version and c.tbl = 'item' and c.op = 'insert' and c.entity_id = t.id;

  -- sites: the ones it reached get their rows back now; the ones it had not reached are cancelled
  update msm_stock_version_sites s set status = 'cancelled', last_error = 'Undone before it ran here'
   where s.version_id = p_version and s.status in ('waiting', 'failed');
  insert into msm_stock_version_sites (version_id, org_id, location_id, status, due_at)
  select v_undo, p_org, s.location_id, 'waiting', now()
    from msm_stock_version_sites s
   where s.version_id = p_version and s.status = 'done'
     and exists (select 1 from msm_stock_version_rows r where r.version_id = p_version and r.location_id = s.location_id);
  get diagnostics n = row_count;
  update msm_stock_versions set status = 'undone', finished_at = coalesce(finished_at, now()) where id = p_version;
  perform public.msm_stock__refresh_version(v_undo);
  return jsonb_build_object('ok', true, 'undo_version_id', v_undo,
                            'version_no', (select x.version_no from msm_stock_versions x where x.id = v_undo), 'sites', n);
end
$fn$;

-- One site of an Undo: put back what version p_of changed there. Set based (a first publish to a site
-- added 5,000 items, packs and prices: one statement per table and kind, never one per row).
--   0. cost here: back to what it was where the publish's own cost row is still the open one and
--      the cost is still the publish's (a delivery or a count since decides, and is kept);
--   1. changed rows back to their before image (company columns only; on hand and preferred untouched);
--   2. rows it added: removed when nothing has used them since; otherwise archived and handed to the
--      site (company_ref cleared). A row is used when the ledger, a cost, a count, a par, an order, an
--      invoice, a transfer, waste, a recipe or production points at it, or a row it holds was used.
create or replace function public.msm_stock__undo_site(p_undo uuid, p_of uuid, p_loc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t text;
  n integer := 0;
  m integer;
  k integer;
begin
  perform set_config('servos.stock_publish', txid_current()::text, true);

  -- 0. cost here
  drop table if exists _u_cost;
  create temp table _u_cost on commit drop as
  select vr.row_id as item, (vr.before ->> 'current_cost')::numeric as old_cost, (vr.after ->> 'current_cost')::numeric as new_cost,
         (vr.after ->> 'history_id')::uuid as hist_id,
         array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(vr.before -> 'open_history', '[]'::jsonb)) x) as reopen
    from msm_stock_version_rows vr
    join inventory_items it on it.id = vr.row_id and it.location_id = p_loc
   where vr.version_id = p_of and vr.location_id = p_loc and vr.tbl = 'item_cost'
     and it.current_cost is not distinct from (vr.after ->> 'current_cost')::numeric
     and exists (select 1 from item_cost_history h where h.id = (vr.after ->> 'history_id')::uuid and h.effective_to is null);
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select p_undo, p_loc, 'item_cost', c.item, 'restore', jsonb_build_object('current_cost', c.new_cost), jsonb_build_object('current_cost', c.old_cost)
    from _u_cost c
  on conflict do nothing;
  delete from item_cost_history h using _u_cost c where h.id = c.hist_id and h.location_id = p_loc;
  update item_cost_history h set effective_to = null
    from _u_cost c
   where h.location_id = p_loc and h.inventory_item_id = c.item and h.id = any(c.reopen);
  update inventory_items it set current_cost = c.old_cost
    from _u_cost c
   where it.id = c.item and it.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;

  -- 1. changed rows back to their before image
  foreach t in array array['suppliers', 'item_packaging_formats', 'inventory_item_conversions', 'supplier_products', 'inventory_items'] loop
    execute format(
      'insert into public.msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
       select $1, $2, %1$L, x.id, ''restore'', public.msm_stock__pick(to_jsonb(x), public.msm_stock__cols(%1$L)), vr.before
         from public.%1$I x join public.msm_stock_version_rows vr on vr.row_id = x.id
        where vr.version_id = $3 and vr.location_id = $2 and vr.tbl = %1$L and vr.op in (''update'', ''link'', ''unlink'') and x.location_id = $2
       on conflict do nothing', t) using p_undo, p_loc, p_of;
    execute format(
      'update public.%1$I x set (%2$s) = (select %3$s from jsonb_populate_record(x, vr.before) r)
         from public.msm_stock_version_rows vr
        where vr.version_id = $1 and vr.location_id = $2 and vr.tbl = %1$L and vr.op in (''update'', ''link'', ''unlink'')
          and x.id = vr.row_id and x.location_id = $2',
      t, array_to_string(public.msm_stock__cols(t), ', '),
      (select string_agg('r.' || c, ', ') from unnest(public.msm_stock__cols(t)) c)) using p_of, p_loc;
    get diagnostics m = row_count; n := n + m;
  end loop;

  -- 2. rows it added: which are used
  drop table if exists _u_ins;
  create temp table _u_ins on commit drop as
  select vr.tbl, vr.row_id, true as unused
    from msm_stock_version_rows vr
   where vr.version_id = p_of and vr.location_id = p_loc and vr.op = 'insert'
     and vr.tbl in ('inventory_item_areas', 'supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'inventory_items', 'suppliers');
  create index on _u_ins (row_id);
  analyze _u_ins;

  -- an area row: its stock there, or any movement of the item here
  update _u_ins u set unused = false from inventory_item_areas a
   where u.tbl = 'inventory_item_areas' and a.id = u.row_id and a.location_id = p_loc
     and (exists (select 1 from inventory_item_area_stock st where st.inventory_item_id = a.inventory_item_id and st.area_id = a.area_id and st.on_hand <> 0)
          or exists (select 1 from stock_movements mv where mv.location_id = p_loc and mv.inventory_item_id = a.inventory_item_id));
  -- a supplier price: an order line, a cost row or an invoice line
  update _u_ins u set unused = false where u.tbl = 'supplier_products' and exists (select 1 from po_lines l where l.supplier_product_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'supplier_products' and exists (select 1 from item_cost_history h where h.supplier_product_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'supplier_products'
     and u.row_id in (select l.supplier_product_id from supplier_invoice_lines l where l.location_id = p_loc and l.supplier_product_id is not null);
  -- a pack: a recipe line in that pack
  update _u_ins u set unused = false where u.tbl = 'item_packaging_formats'
     and ('@' || u.row_id::text) in (select l.unit from recipe_lines l where l.location_id = p_loc and l.unit like '@%');
  -- a pack holding a pack the site added
  update _u_ins u set unused = false where u.tbl = 'item_packaging_formats'
     and exists (select 1 from item_packaging_formats x where x.parent_format_id = u.row_id and x.location_id = p_loc
                  and not exists (select 1 from _u_ins v where v.row_id = x.id));
  -- an item
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from stock_movements mv where mv.location_id = p_loc and mv.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from item_cost_history h where h.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from stock_count_lines l where l.location_id = p_loc and l.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from par_levels pl where pl.location_id = p_loc and pl.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from po_lines l where l.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from recipe_lines l where l.component_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from recipes r where r.output_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from stock_transfer_lines l where l.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from stock_transfer_lines l where l.to_inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from waste_events w where w.inventory_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from supplier_invoice_lines l where l.matched_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and exists (select 1 from production_batches b where b.output_item_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'inventory_items'
     and exists (select 1 from inventory_item_area_stock st where st.inventory_item_id = u.row_id and st.on_hand <> 0);
  -- an item with a row of the site's own on it (not one this version added)
  update _u_ins u set unused = false where u.tbl = 'inventory_items'
     and exists (select 1 from item_packaging_formats x where x.inventory_item_id = u.row_id and not exists (select 1 from _u_ins v where v.row_id = x.id));
  update _u_ins u set unused = false where u.tbl = 'inventory_items'
     and exists (select 1 from inventory_item_conversions x where x.inventory_item_id = u.row_id and not exists (select 1 from _u_ins v where v.row_id = x.id));
  update _u_ins u set unused = false where u.tbl = 'inventory_items'
     and exists (select 1 from supplier_products x where x.inventory_item_id = u.row_id and not exists (select 1 from _u_ins v where v.row_id = x.id));
  update _u_ins u set unused = false where u.tbl = 'inventory_items'
     and exists (select 1 from inventory_item_areas x where x.inventory_item_id = u.row_id and not exists (select 1 from _u_ins v where v.row_id = x.id));
  -- a supplier
  update _u_ins u set unused = false where u.tbl = 'suppliers' and exists (select 1 from purchase_orders o where o.supplier_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'suppliers' and exists (select 1 from supplier_invoices i where i.supplier_id = u.row_id);
  update _u_ins u set unused = false where u.tbl = 'suppliers'
     and exists (select 1 from inventory_items i where i.default_supplier_id = u.row_id and i.location_id = p_loc and not exists (select 1 from _u_ins v where v.row_id = i.id));
  update _u_ins u set unused = false where u.tbl = 'suppliers'
     and exists (select 1 from supplier_products x where x.supplier_id = u.row_id and not exists (select 1 from _u_ins v where v.row_id = x.id));
  -- a row kept by the site keeps what it hangs on: a pack inside a kept pack, and the item and supplier
  -- of a kept pack, bridge or price (else removing them would take the kept row with them)
  for k in 1 .. 5 loop
    update _u_ins u set unused = false where u.tbl = 'item_packaging_formats' and u.unused
       and exists (select 1 from item_packaging_formats x join _u_ins c on c.row_id = x.id and not c.unused where x.parent_format_id = u.row_id);
    get diagnostics m = row_count;
    exit when m = 0;
  end loop;
  update _u_ins u set unused = false where u.tbl = 'inventory_items' and u.unused
     and (exists (select 1 from item_packaging_formats x join _u_ins c on c.row_id = x.id and not c.unused where x.inventory_item_id = u.row_id)
       or exists (select 1 from inventory_item_conversions x join _u_ins c on c.row_id = x.id and not c.unused where x.inventory_item_id = u.row_id)
       or exists (select 1 from supplier_products x join _u_ins c on c.row_id = x.id and not c.unused where x.inventory_item_id = u.row_id));
  update _u_ins u set unused = false where u.tbl = 'suppliers' and u.unused
     and exists (select 1 from supplier_products x join _u_ins c on c.row_id = x.id and not c.unused where x.supplier_id = u.row_id);

  -- 2b. remove the unused rows, children first; archive the used ones (area rows that were used stay)
  with d as (
    delete from inventory_item_areas a using _u_ins u
     where u.tbl = 'inventory_item_areas' and u.unused and a.id = u.row_id and a.location_id = p_loc
    returning a.id)
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op)
  select p_undo, p_loc, 'inventory_item_areas', d.id, 'delete' from d on conflict do nothing;
  get diagnostics m = row_count; n := n + m;
  foreach t in array array['supplier_products', 'item_packaging_formats', 'inventory_item_conversions', 'inventory_items', 'suppliers'] loop
    execute format(
      'with d as (delete from public.%1$I x using _u_ins u
                   where u.tbl = %1$L and u.unused and x.id = u.row_id and x.location_id = $1
                  returning x.id)
       insert into public.msm_stock_version_rows (version_id, location_id, tbl, row_id, op)
       select $2, $1, %1$L, d.id, ''delete'' from d on conflict do nothing', t) using p_loc, p_undo;
    get diagnostics m = row_count; n := n + m;
    execute format(
      'with a as (update public.%1$I x set archived_at = coalesce(x.archived_at, now()), company_ref = null
                    from _u_ins u
                   where u.tbl = %1$L and not u.unused and x.id = u.row_id and x.location_id = $1
                  returning x.id)
       insert into public.msm_stock_version_rows (version_id, location_id, tbl, row_id, op)
       select $2, $1, %1$L, a.id, ''archive'' from a on conflict do nothing', t) using p_loc, p_undo;
    get diagnostics m = row_count; n := n + m;
  end loop;
  return jsonb_build_object('written', n);
end
$fn$;

-- "Keep the site's": the site's row stops being a company row (it becomes the site's own, as it is).
-- p_kind: item (with its packs, bridges and prices there), supplier (with its prices there), price.
create or replace function public.msm_stock_keep_site(p_org uuid, p_loc uuid, p_kind text, p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_version uuid;
  n integer := 0;
  m integer;
begin
  perform public.msm_stock__require_editor(p_org);
  if not public.msm_stock__venue_in_org(p_loc, p_org) then raise exception 'That site is not in this company.' using errcode = '22023'; end if;
  if p_kind not in ('item', 'supplier', 'price') then raise exception 'Keep the site''s works on an item, a supplier or a price.' using errcode = '22023'; end if;
  perform set_config('lock_timeout', '2s', true);
  perform set_config('servos.stock_publish', txid_current()::text, true);
  v_version := public.msm_stock__new_version(p_org, 'keep', null, null, 'now', format('Keep the site''s %s', p_kind));

  drop table if exists _keep;
  create temp table _keep (tbl text, ctbl text, cid uuid, row_id uuid) on commit drop;
  if p_kind = 'item' then
    insert into _keep select 'inventory_items', 'item_site', s.item_id, s.venue_item_id from msm_stock_item_sites s
      where s.item_id = p_company_id and s.location_id = p_loc and s.org_id = p_org and s.unlinked_at is null and s.venue_item_id is not null;
    insert into _keep select 'item_packaging_formats', 'pack_site', ps.pack_id, ps.venue_format_id from msm_stock_pack_sites ps
      join msm_stock_packs p on p.id = ps.pack_id where p.item_id = p_company_id and ps.location_id = p_loc and ps.unlinked_at is null and ps.venue_format_id is not null;
    insert into _keep select 'inventory_item_conversions', 'bridge_site', bs.bridge_id, bs.venue_conversion_id from msm_stock_bridge_sites bs
      join msm_stock_bridges b on b.id = bs.bridge_id where b.item_id = p_company_id and bs.location_id = p_loc and bs.unlinked_at is null and bs.venue_conversion_id is not null;
    insert into _keep select 'supplier_products', 'sp_site', x.sp_id, x.venue_supplier_product_id from msm_supplier_product_sites x
      join msm_supplier_products sp on sp.id = x.sp_id where sp.item_id = p_company_id and x.location_id = p_loc and x.unlinked_at is null and x.venue_supplier_product_id is not null;
  elsif p_kind = 'supplier' then
    insert into _keep select 'suppliers', 'supplier_site', s.supplier_id, s.venue_supplier_id from msm_supplier_sites s
      where s.supplier_id = p_company_id and s.location_id = p_loc and s.org_id = p_org and s.unlinked_at is null and s.venue_supplier_id is not null;
    insert into _keep select 'supplier_products', 'sp_site', x.sp_id, x.venue_supplier_product_id from msm_supplier_product_sites x
      join msm_supplier_products sp on sp.id = x.sp_id where sp.supplier_id = p_company_id and x.location_id = p_loc and x.unlinked_at is null and x.venue_supplier_product_id is not null;
  else
    insert into _keep select 'supplier_products', 'sp_site', x.sp_id, x.venue_supplier_product_id from msm_supplier_product_sites x
      where x.sp_id = p_company_id and x.location_id = p_loc and x.org_id = p_org and x.unlinked_at is null and x.venue_supplier_product_id is not null;
  end if;
  if not exists (select 1 from _keep) then
    raise exception 'That row is not a company row at this site.' using errcode = '22023';
  end if;

  insert into msm_stock_version_company (version_id, tbl, entity_id, location_key, op, before)
  select v_version, k.ctbl, k.cid, p_loc, 'update',
         case k.ctbl when 'item_site' then (select to_jsonb(s) from msm_stock_item_sites s where s.item_id = k.cid and s.location_id = p_loc)
                     when 'pack_site' then (select to_jsonb(s) from msm_stock_pack_sites s where s.pack_id = k.cid and s.location_id = p_loc)
                     when 'bridge_site' then (select to_jsonb(s) from msm_stock_bridge_sites s where s.bridge_id = k.cid and s.location_id = p_loc)
                     when 'supplier_site' then (select to_jsonb(s) from msm_supplier_sites s where s.supplier_id = k.cid and s.location_id = p_loc)
                     else (select to_jsonb(s) from msm_supplier_product_sites s where s.sp_id = k.cid and s.location_id = p_loc) end
    from _keep k on conflict do nothing;
  update msm_stock_item_sites s set unlinked_at = now(), updated_at = now() from _keep k where k.ctbl = 'item_site' and s.item_id = k.cid and s.location_id = p_loc;
  update msm_stock_pack_sites s set unlinked_at = now(), updated_at = now() from _keep k where k.ctbl = 'pack_site' and s.pack_id = k.cid and s.location_id = p_loc;
  update msm_stock_bridge_sites s set unlinked_at = now(), updated_at = now() from _keep k where k.ctbl = 'bridge_site' and s.bridge_id = k.cid and s.location_id = p_loc;
  update msm_supplier_sites s set unlinked_at = now(), updated_at = now() from _keep k where k.ctbl = 'supplier_site' and s.supplier_id = k.cid and s.location_id = p_loc;
  update msm_supplier_product_sites s set unlinked_at = now(), updated_at = now() from _keep k where k.ctbl = 'sp_site' and s.sp_id = k.cid and s.location_id = p_loc;

  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select v_version, p_loc, k.tbl, k.row_id, 'unlink', jsonb_build_object('company_ref', k.cid), jsonb_build_object('company_ref', null)
    from _keep k on conflict do nothing;
  update inventory_items x set company_ref = null from _keep k where k.tbl = 'inventory_items' and x.id = k.row_id and x.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;
  update item_packaging_formats x set company_ref = null from _keep k where k.tbl = 'item_packaging_formats' and x.id = k.row_id and x.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;
  update inventory_item_conversions x set company_ref = null from _keep k where k.tbl = 'inventory_item_conversions' and x.id = k.row_id and x.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;
  update suppliers x set company_ref = null from _keep k where k.tbl = 'suppliers' and x.id = k.row_id and x.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;
  update supplier_products x set company_ref = null from _keep k where k.tbl = 'supplier_products' and x.id = k.row_id and x.location_id = p_loc;
  get diagnostics m = row_count; n := n + m;
  insert into msm_stock_version_sites (version_id, org_id, location_id, status, due_at, writes, done_at)
  values (v_version, p_org, p_loc, 'done', now(), n, now());
  perform public.msm_stock__refresh_version(v_version);
  return jsonb_build_object('ok', true, 'version_id', v_version, 'rows', n);
end
$fn$;

-- ============================================================================
-- 13. THE RUNNER (pg_cron, every minute, one site per transaction)
-- ============================================================================
create or replace function public.msm_stock__run_site(p_vs bigint)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s record;
  v record;
  v_res jsonb;
  v_status text;
begin
  select * into s from msm_stock_version_sites x where x.id = p_vs;
  select * into v from msm_stock_versions x where x.id = s.version_id;
  update msm_stock_version_sites set status = 'running', started_at = clock_timestamp(), attempts = attempts + 1 where id = p_vs;
  begin
    perform set_config('lock_timeout', '2s', true);
    if v.kind = 'undo' then
      v_res := public.msm_stock__undo_site(v.id, v.undo_of, s.location_id);
    else
      v_res := public.msm_stock__sync_site(s.org_id, s.location_id, s.version_id, true, false);
    end if;
    v_status := case when coalesce((v_res ->> 'written')::int, 0) = 0 then 'nothing' else 'done' end;
    update msm_stock_version_sites
       set status = v_status, writes = coalesce((v_res ->> 'written')::int, 0), counts = v_res - 'detail', last_error = null, done_at = clock_timestamp()
     where id = p_vs;
  exception
    when lock_not_available or deadlock_detected or query_canceled then
      update msm_stock_version_sites
         set status = 'waiting', due_at = now() + interval '1 minute',
             last_error = 'The site was busy (a sale or a delivery held a stock item), so it gave way. Trying again next minute.'
       where id = p_vs;
      v_status := 'waiting';
    when sqlstate '55000' then
      -- our own refusal, in words (a base unit in use at the site): trying again will not help
      update msm_stock_version_sites
         set status = 'failed', last_error = left(sqlerrm, 400), due_at = now()
       where id = p_vs;
      v_status := 'failed';
    when others then
      -- the screens show words; the database's own text is kept for ServOS in counts.error_detail
      update msm_stock_version_sites
         set status = case when attempts >= 5 then 'failed' else 'waiting' end,
             due_at = now() + interval '1 minute' * least(attempts, 10),
             last_error = case when attempts >= 5
                               then 'This site could not be written, so nothing changed there. Undo the version, or ask ServOS (History keeps the detail).'
                               else 'This site could not be written this time, so nothing changed there. It tries again in a few minutes.' end,
             counts = counts || jsonb_build_object('error_detail', left(sqlerrm, 400), 'error_code', sqlstate)
       where id = p_vs;
      v_status := 'failed';
  end;
  perform public.msm_stock__refresh_version(s.version_id);
  return v_status;
end
$fn$;

-- INVOKER (a procedure that commits cannot be SECURITY DEFINER); only postgres can run it.
create or replace procedure public.msm_stock_run_due(p_seconds integer default 45)
language plpgsql
as $proc$
declare
  v_t0 timestamptz := clock_timestamp();
  v_id bigint;
  v_lock bigint := hashtext('msm_stock_run_due');
begin
  if not exists (select 1 from public.msm_stock_version_sites s where s.status = 'waiting' and s.due_at <= now()) then
    return;
  end if;
  loop
    if not pg_try_advisory_xact_lock(v_lock) then exit; end if;
    select s.id into v_id
      from public.msm_stock_version_sites s
      join public.msm_stock_versions v on v.id = s.version_id
     where s.status = 'waiting' and s.due_at <= now()
       and public.msm_stock__company_on(s.org_id)
     order by v.version_no, s.due_at, s.id
     limit 1
     for update of s skip locked;
    if v_id is null then
      commit;
      exit;
    end if;
    perform public.msm_stock__run_site(v_id);
    commit;
    exit when clock_timestamp() - v_t0 > make_interval(secs => p_seconds);
  end loop;
end
$proc$;

do $cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'msm-stock-run-due' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('msm-stock-run-due', '* * * * *', 'call public.msm_stock_run_due(45);');
end
$cron$;

-- ============================================================================
-- 14. START FROM A SITE, LINKS, SITES ON AND OFF
-- ============================================================================

-- Start from a site (6.2): that site's live rows become the company list, and are linked to it.
-- No quantity, cost or name changes: only company_ref is stamped, and the self check (a publish to
-- that site plans ZERO writes) must pass, or nothing is kept.
create or replace function public.msm_stock_start_from_site(p_org uuid, p_loc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_version uuid;
  v_plan jsonb;
  n_items integer; n_packs integer; n_bridges integer; n_sups integer; n_sps integer;
begin
  perform public.msm_stock__require_editor(p_org);
  if not public.msm_stock__company_on(p_org) then
    raise exception 'Shared stock is switched off for this company.' using errcode = '55000';
  end if;
  if not public.msm_stock__venue_in_org(p_loc, p_org) then raise exception 'That site is not in this company.' using errcode = '22023'; end if;
  perform 1 from stock_company c where c.org_id = p_org for update;
  if exists (select 1 from msm_stock_items i where i.org_id = p_org) or exists (select 1 from msm_suppliers s where s.org_id = p_org) then
    raise exception 'The company list already has stock items or suppliers. Start from a site works once, on an empty list; link the other sites'' rows instead.'
      using errcode = '55000';
  end if;
  if public.msm_stock__busy_words(p_org) is not null then
    raise exception '%', public.msm_stock__busy_words(p_org) using errcode = '55000';
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform set_config('servos.stock_publish', txid_current()::text, true);
  v_version := public.msm_stock__new_version(p_org, 'start', null, null, 'now',
                 format('Start from %s', (select l.name from locations l where l.id = p_loc)));

  drop table if exists _s_items;
  create temp table _s_items on commit drop as
  select gen_random_uuid() as cid, t.* from inventory_items t
   where t.location_id = p_loc and t.archived_at is null and t.company_ref is null;
  insert into msm_stock_items (id, org_id, name, category, accounting_group, base_unit, allergens, sku, barcode, shelf_life_days,
                               purchase_tax_rate, default_area_kind, returns_to_shelf, notes)
  select s.cid, p_org, s.name, s.category, s.accounting_group, s.base_unit, coalesce(s.allergens, '[]'::jsonb), s.sku, s.barcode, s.shelf_life_days,
         (select r.rate from tax_rates r where r.id = s.purchase_tax_rate_id),
         (select a.kind from inventory_item_areas ia join storage_areas a on a.id = ia.area_id where ia.inventory_item_id = s.id and ia.is_primary limit 1),
         coalesce(s.returns_to_shelf, false), s.notes
    from _s_items s;
  get diagnostics n_items = row_count;
  insert into msm_stock_item_sites (item_id, org_id, location_id, venue_item_id, active, made_here)
  select s.cid, p_org, p_loc, s.id, true, s.kind = 'MADE' from _s_items s;

  drop table if exists _s_packs;
  create temp table _s_packs on commit drop as
  select gen_random_uuid() as cid, si.cid as item_cid, t.* from item_packaging_formats t join _s_items si on si.id = t.inventory_item_id
   where t.location_id = p_loc and t.archived_at is null and t.company_ref is null;
  insert into msm_stock_packs (id, org_id, item_id, name, qty_in_base, parent_pack_id, is_count_default, is_purchase_default)
  select p.cid, p_org, p.item_cid, p.name, p.qty_in_base, null, p.is_count_default, p.is_purchase_default from _s_packs p;
  get diagnostics n_packs = row_count;
  update msm_stock_packs cp set parent_pack_id = pp.cid
    from _s_packs p join _s_packs pp on pp.id = p.parent_format_id
   where cp.id = p.cid and pp.item_cid = p.item_cid;
  insert into msm_stock_pack_sites (pack_id, org_id, location_id, venue_format_id) select p.cid, p_org, p_loc, p.id from _s_packs p;

  drop table if exists _s_bridges;
  create temp table _s_bridges on commit drop as
  select gen_random_uuid() as cid, si.cid as item_cid, t.* from inventory_item_conversions t join _s_items si on si.id = t.inventory_item_id
   where t.location_id = p_loc and t.archived_at is null and t.company_ref is null
     and exists (select 1 from stock_units u where u.code = t.from_unit) and exists (select 1 from stock_units u where u.code = t.to_unit)
     and t.from_qty > 0 and t.to_qty > 0;
  insert into msm_stock_bridges (id, org_id, item_id, from_qty, from_unit, to_qty, to_unit)
  select b.cid, p_org, b.item_cid, b.from_qty, b.from_unit, b.to_qty, b.to_unit from _s_bridges b;
  get diagnostics n_bridges = row_count;
  insert into msm_stock_bridge_sites (bridge_id, org_id, location_id, venue_conversion_id) select b.cid, p_org, p_loc, b.id from _s_bridges b;

  drop table if exists _s_sups;
  create temp table _s_sups on commit drop as
  select gen_random_uuid() as cid, t.* from suppliers t where t.location_id = p_loc and t.archived_at is null and t.company_ref is null;
  insert into msm_suppliers (id, org_id, name, contact_name, phone, payment_terms_days, notes)
  select s.cid, p_org, s.name, s.contact_name, s.phone, s.payment_terms_days, s.notes from _s_sups s;
  get diagnostics n_sups = row_count;
  insert into msm_supplier_sites (supplier_id, org_id, location_id, venue_supplier_id, active, account_number, order_email, delivery_days, cutoff_time, min_order_value)
  select s.cid, p_org, p_loc, s.id, true, s.account_number, s.email, s.delivery_days, s.cutoff_time, s.min_order_value from _s_sups s;

  drop table if exists _s_sps;
  create temp table _s_sps on commit drop as
  select gen_random_uuid() as cid, si.cid as item_cid, ss.cid as sup_cid, t.*
    from supplier_products t join _s_items si on si.id = t.inventory_item_id join _s_sups ss on ss.id = t.supplier_id
   where t.location_id = p_loc and t.archived_at is null and t.company_ref is null
     and exists (select 1 from stock_units u where u.code = t.inner_unit);
  insert into msm_supplier_products (id, org_id, supplier_id, item_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price,
                                     price_includes_tax, purchase_tax_rate, first_choice)
  select p.cid, p_org, p.sup_cid, p.item_cid, p.supplier_sku, p.pack_description, p.pack_qty, p.inner_qty, p.inner_unit, p.pack_price,
         coalesce(p.price_includes_tax, false), (select r.rate from tax_rates r where r.id = p.purchase_tax_rate_id), coalesce(p.is_preferred, false)
    from _s_sps p;
  get diagnostics n_sps = row_count;
  insert into msm_supplier_product_sites (sp_id, org_id, location_id, venue_supplier_product_id) select p.cid, p_org, p_loc, p.id from _s_sps p;

  -- company rows made by this version (Undo removes them)
  insert into msm_stock_version_company (version_id, tbl, entity_id, op)
  select v_version, 'item', cid, 'insert' from _s_items
  union all select v_version, 'pack', cid, 'insert' from _s_packs
  union all select v_version, 'bridge', cid, 'insert' from _s_bridges
  union all select v_version, 'supplier', cid, 'insert' from _s_sups
  union all select v_version, 'sp', cid, 'insert' from _s_sps;

  -- the site rows join their company rows: company_ref only (version rows keep the before image)
  insert into msm_stock_version_rows (version_id, location_id, tbl, row_id, op, before, after)
  select v_version, p_loc, 'suppliers', t.id, 'link', public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('suppliers')), jsonb_build_object('company_ref', s.cid)
    from suppliers t join _s_sups s on s.id = t.id
  union all
  select v_version, p_loc, 'item_packaging_formats', t.id, 'link', public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('item_packaging_formats')), jsonb_build_object('company_ref', p.cid)
    from item_packaging_formats t join _s_packs p on p.id = t.id
  union all
  select v_version, p_loc, 'inventory_item_conversions', t.id, 'link', public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('inventory_item_conversions')), jsonb_build_object('company_ref', b.cid)
    from inventory_item_conversions t join _s_bridges b on b.id = t.id
  union all
  select v_version, p_loc, 'supplier_products', t.id, 'link', public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('supplier_products')), jsonb_build_object('company_ref', p.cid)
    from supplier_products t join _s_sps p on p.id = t.id
  union all
  select v_version, p_loc, 'inventory_items', t.id, 'link', public.msm_stock__pick(to_jsonb(t), public.msm_stock__cols('inventory_items')), jsonb_build_object('company_ref', s.cid)
    from inventory_items t join _s_items s on s.id = t.id;
  update suppliers t set company_ref = s.cid from _s_sups s where t.id = s.id and t.location_id = p_loc;
  update item_packaging_formats t set company_ref = p.cid from _s_packs p where t.id = p.id and t.location_id = p_loc;
  update inventory_item_conversions t set company_ref = b.cid from _s_bridges b where t.id = b.id and t.location_id = p_loc;
  update supplier_products t set company_ref = p.cid from _s_sps p where t.id = p.id and t.location_id = p_loc;
  update inventory_items t set company_ref = s.cid from _s_items s where t.id = s.id and t.location_id = p_loc;

  -- THE SELF CHECK: a publish to this site now plans zero writes
  v_plan := public.msm_stock__sync_site(p_org, p_loc, null, false, true);
  if (v_plan ->> 'writes')::int <> 0 then
    raise exception 'Start from a site stopped and kept nothing: a publish to that site would still change % rows (first: %).',
      v_plan ->> 'writes', left(coalesce((v_plan -> 'detail')::text, ''), 300) using errcode = '55000';
  end if;
  insert into msm_stock_version_sites (version_id, org_id, location_id, status, due_at, writes, done_at, counts)
  values (v_version, p_org, p_loc, 'done', now(), n_items + n_packs + n_bridges + n_sups + n_sps, now(),
          jsonb_build_object('items', n_items, 'packs', n_packs, 'bridges', n_bridges, 'suppliers', n_sups, 'prices', n_sps));
  perform public.msm_stock__refresh_version(v_version);
  -- the company tables went from empty to the whole list: fresh statistics for the next publish
  analyze public.msm_stock_items;
  analyze public.msm_stock_item_sites;
  analyze public.msm_stock_packs;
  analyze public.msm_suppliers;
  analyze public.msm_supplier_products;
  return jsonb_build_object('ok', true, 'version_id', v_version, 'items', n_items, 'packs', n_packs, 'bridges', n_bridges,
                            'suppliers', n_sups, 'prices', n_sps, 'self_check_writes', 0);
end
$fn$;

-- Suggested links at a site: its own live rows that look like a company row (nothing links until an
-- editor ticks it). Items by SKU and base unit, then name and base unit (two equality joins, so 5,000
-- items answer in well under a second); suppliers by name; packs, bridges and prices of an item (and
-- supplier) that is linked or suggested with one choice, by name and size. One set, shared by the
-- page below and by "tick every single match". venue_price and company_price: a price's two figures
-- (the site's own price is kept when the link is ticked).
create or replace function public.msm_stock__link_pairs(p_org uuid, p_loc uuid)
returns table (kind text, company_id uuid, company_name text, venue_id uuid, venue_name text, why text,
               choices bigint, venue_choices bigint, venue_price numeric, company_price numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  with free_items as materialized (
    select t.id, t.name, t.base_unit, lower(btrim(t.name)) as nkey, nullif(lower(btrim(t.sku)), '') as skey
      from inventory_items t
     where t.location_id = p_loc and t.archived_at is null and t.company_ref is null
       and not exists (select 1 from msm_stock_item_sites s where s.location_id = p_loc and s.venue_item_id = t.id)
  ), comp_items as materialized (
    select i.id, i.name, i.base_unit, lower(btrim(i.name)) as nkey, nullif(lower(btrim(i.sku)), '') as skey
      from msm_stock_items i
     where i.org_id = p_org and not i.archived
       and not exists (select 1 from msm_stock_item_sites s where s.item_id = i.id and s.location_id = p_loc and s.venue_item_id is not null)
  ), item_m as (
    select i.id as company_id, i.name as company_name, t.id as venue_id, t.name as venue_name, 'Same SKU and unit'::text as why
      from comp_items i join free_items t on t.skey = i.skey and t.base_unit = i.base_unit
    union all
    select i.id, i.name, t.id, t.name, 'Same name and unit'::text
      from comp_items i join free_items t on t.nkey = i.nkey and t.base_unit = i.base_unit
     where not coalesce(t.skey = i.skey, false)
  ), item_c as materialized (
    select m.*, count(*) over (partition by m.company_id) as choices, count(*) over (partition by m.venue_id) as venue_choices from item_m m
  ), item_pairs as materialized (
    select s.item_id as company_id, s.venue_item_id as venue_id from msm_stock_item_sites s
     where s.location_id = p_loc and s.org_id = p_org and s.venue_item_id is not null and s.unlinked_at is null
    union all select c.company_id, c.venue_id from item_c c where c.choices = 1 and c.venue_choices = 1
  ), sup_c as materialized (
    select m.id as company_id, m.name as company_name, t.id as venue_id, t.name as venue_name, 'Same name'::text as why,
           count(*) over (partition by m.id) as choices, count(*) over (partition by t.id) as venue_choices
      from msm_suppliers m
      join suppliers t on t.location_id = p_loc and t.archived_at is null and t.company_ref is null and lower(btrim(t.name)) = lower(btrim(m.name))
     where m.org_id = p_org and not m.archived
       and not exists (select 1 from msm_supplier_sites s where s.supplier_id = m.id and s.location_id = p_loc and s.venue_supplier_id is not null)
       and not exists (select 1 from msm_supplier_sites s where s.location_id = p_loc and s.venue_supplier_id = t.id)
  ), sup_pairs as materialized (
    select s.supplier_id as company_id, s.venue_supplier_id as venue_id from msm_supplier_sites s
     where s.location_id = p_loc and s.org_id = p_org and s.venue_supplier_id is not null and s.unlinked_at is null
    union all select c.company_id, c.venue_id from sup_c c where c.choices = 1 and c.venue_choices = 1
  ), sp_c as (
    select sp.id as company_id, coalesce(sp.pack_description, sp.supplier_sku, 'supplier pack') as company_name, t.id as venue_id,
           coalesce(t.pack_description, t.supplier_sku, 'supplier pack') as venue_name, 'Same item, supplier and pack'::text as why,
           count(*) over (partition by sp.id) as choices, count(*) over (partition by t.id) as venue_choices,
           t.pack_price as venue_price, sp.pack_price as company_price
      from msm_supplier_products sp
      join item_pairs ip on ip.company_id = sp.item_id
      join sup_pairs su on su.company_id = sp.supplier_id
      join supplier_products t on t.location_id = p_loc and t.inventory_item_id = ip.venue_id and t.supplier_id = su.venue_id
                              and t.archived_at is null and t.company_ref is null
                              and t.pack_qty = sp.pack_qty and t.inner_qty = sp.inner_qty and t.inner_unit = sp.inner_unit
     where sp.org_id = p_org and not sp.archived
       and not exists (select 1 from msm_supplier_product_sites x where x.sp_id = sp.id and x.location_id = p_loc and x.venue_supplier_product_id is not null)
       and not exists (select 1 from msm_supplier_product_sites x where x.location_id = p_loc and x.venue_supplier_product_id = t.id)
  ), pack_c as (
    select p.id as company_id, p.name as company_name, t.id as venue_id, t.name as venue_name, 'Same item, name and size'::text as why,
           count(*) over (partition by p.id) as choices, count(*) over (partition by t.id) as venue_choices
      from msm_stock_packs p
      join item_pairs ip on ip.company_id = p.item_id
      join item_packaging_formats t on t.location_id = p_loc and t.inventory_item_id = ip.venue_id and t.archived_at is null and t.company_ref is null
                                   and lower(btrim(t.name)) = lower(btrim(p.name)) and t.qty_in_base = p.qty_in_base
     where p.org_id = p_org and not p.archived
       and not exists (select 1 from msm_stock_pack_sites x where x.pack_id = p.id and x.location_id = p_loc and x.venue_format_id is not null)
       and not exists (select 1 from msm_stock_pack_sites x where x.location_id = p_loc and x.venue_format_id = t.id)
  ), bridge_c as (
    select b.id as company_id, format('%s %s = %s %s', b.from_qty, b.from_unit, b.to_qty, b.to_unit) as company_name, t.id as venue_id,
           format('%s %s = %s %s', t.from_qty, t.from_unit, t.to_qty, t.to_unit) as venue_name, 'Same item and units'::text as why,
           count(*) over (partition by b.id) as choices, count(*) over (partition by t.id) as venue_choices
      from msm_stock_bridges b
      join item_pairs ip on ip.company_id = b.item_id
      join inventory_item_conversions t on t.location_id = p_loc and t.inventory_item_id = ip.venue_id and t.archived_at is null and t.company_ref is null
                                       and t.from_unit = b.from_unit and t.to_unit = b.to_unit and t.from_qty = b.from_qty and t.to_qty = b.to_qty
     where b.org_id = p_org and not b.archived
       and not exists (select 1 from msm_stock_bridge_sites x where x.bridge_id = b.id and x.location_id = p_loc and x.venue_conversion_id is not null)
       and not exists (select 1 from msm_stock_bridge_sites x where x.location_id = p_loc and x.venue_conversion_id = t.id)
  )
  select 'item', c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, null::numeric, null::numeric from item_c c
  union all select 'supplier', c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, null, null from sup_c c
  union all select 'price', c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, c.venue_price, c.company_price from sp_c c
  union all select 'pack', c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, null, null from pack_c c
  union all select 'bridge', c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, null, null from bridge_c c;
$fn$;

-- One page of each kind (at most p_limit each, 500 by default), with each kind's total.
create or replace function public.msm_stock_link_candidates(p_org uuid, p_loc uuid, p_offset integer default 0, p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_out jsonb;
begin
  perform public.msm_stock__require_viewer(p_org);
  if not public.msm_stock__venue_in_org(p_loc, p_org) then raise exception 'That site is not in this company.' using errcode = '22023'; end if;
  with c as materialized (select * from public.msm_stock__link_pairs(p_org, p_loc))
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(to_jsonb(x) order by x.company_name, x.venue_name), '[]'::jsonb)
                from (select c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices from c where c.kind = 'item'
                       order by c.company_name, c.company_id, c.venue_id offset v_off limit v_lim) x),
    'items_total', (select count(*) from c where c.kind = 'item'),
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.company_name), '[]'::jsonb)
                    from (select c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices from c where c.kind = 'supplier'
                           order by c.company_name, c.company_id limit v_lim) x),
    'suppliers_total', (select count(*) from c where c.kind = 'supplier'),
    'packs', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                from (select c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices from c where c.kind = 'pack'
                       order by c.company_name, c.company_id limit v_lim) x),
    'packs_total', (select count(*) from c where c.kind = 'pack'),
    'bridges', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                  from (select c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices from c where c.kind = 'bridge'
                         order by c.company_name, c.company_id limit v_lim) x),
    'bridges_total', (select count(*) from c where c.kind = 'bridge'),
    'prices', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                 from (select c.company_id, c.company_name, c.venue_id, c.venue_name, c.why, c.choices, c.venue_choices, c.venue_price, c.company_price
                         from c where c.kind = 'price' order by c.company_name, c.company_id limit v_lim) x),
    'prices_total', (select count(*) from c where c.kind = 'price'))
  into v_out;
  return v_out;
end
$fn$;

-- Tick every suggested link that has exactly one choice (items, suppliers, packs, bridges, prices),
-- every one of them in one set based statement (not page by page). A price that differs keeps the
-- site's own figure (it becomes that site's price for the company row). Nothing is written at the
-- site until publish.
create or replace function public.msm_stock_stage_links(p_org uuid, p_loc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  if not public.msm_stock__venue_in_org(p_loc, p_org) then raise exception 'That site is not in this company.' using errcode = '22023'; end if;
  v_draft := public.msm_stock__open_draft(p_org);
  insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
  select v_draft, p_org,
         case c.kind when 'item' then 'item_site' when 'supplier' then 'supplier_site' when 'pack' then 'pack_site'
                     when 'bridge' then 'bridge_site' else 'sp_site' end,
         c.company_id, p_loc, p_loc,
         case when c.kind in ('item', 'supplier') then jsonb_build_object('link', c.venue_id, 'active', true)
              when c.kind = 'price' and c.venue_price is distinct from c.company_price
                then jsonb_build_object('link', c.venue_id, 'pack_price', round(c.venue_price, 4))
              else jsonb_build_object('link', c.venue_id) end,
         auth.uid()
    from public.msm_stock__link_pairs(p_org, p_loc) c
   where c.choices = 1 and c.venue_choices = 1
  on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
  get diagnostics n = row_count;
  update msm_stock_drafts set updated_at = now() where id = v_draft;
  perform public.msm_stock__draft_cap(v_draft);
  return jsonb_build_object('staged', n, 'changes', (select count(*) from msm_stock_changes c where c.draft_id = v_draft));
end
$fn$;

-- Switch items (and optionally their suppliers) on or off at sites, in the draft. p_items null = every
-- company item; p_sites null = every site of the company.
create or replace function public.msm_stock_stage_sites(p_org uuid, p_items uuid[], p_sites uuid[], p_on boolean, p_with_suppliers boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  n integer := 0;
  m integer;
  z constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform public.msm_stock__require_editor(p_org);
  v_draft := public.msm_stock__open_draft(p_org);
  -- the items: live company items and the new ones in this draft
  drop table if exists _ss_items;
  create temp table _ss_items on commit drop as
  select i.id from msm_stock_items i where i.org_id = p_org and not i.archived and (p_items is null or i.id = any(p_items))
  union
  select c.entity_id from msm_stock_changes c
   where c.draft_id = v_draft and c.target = 'item' and c.data ? '_new' and not coalesce((c.data ->> 'archived')::boolean, false)
     and (p_items is null or c.entity_id = any(p_items));
  -- their suppliers: the ones with a price for them (live or new in this draft)
  drop table if exists _ss_sups;
  create temp table _ss_sups on commit drop as
  select distinct x.supplier_id as id from (
    select sp.supplier_id, sp.item_id from msm_supplier_products sp where sp.org_id = p_org and not sp.archived
    union all
    select (c.data ->> 'supplier_id')::uuid, (c.data ->> 'item_id')::uuid from msm_stock_changes c
     where c.draft_id = v_draft and c.target = 'sp' and c.data ? '_new') x
   where x.item_id in (select id from _ss_items)
     and (exists (select 1 from msm_suppliers m2 where m2.id = x.supplier_id and m2.org_id = p_org and not m2.archived)
          or exists (select 1 from msm_stock_changes c where c.draft_id = v_draft and c.target = 'supplier' and c.entity_id = x.supplier_id and c.data ? '_new'));
  if p_sites is null then
    -- every site: one change per item (its every site switch), and the sites' own ticks cleared so
    -- they follow it (a 5,000 item company at 50 sites stages 5,000 rows, not 250,000)
    insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_key, data, created_by)
    select v_draft, p_org, 'item', i.id, z, jsonb_build_object('all_sites', coalesce(p_on, false)), auth.uid() from _ss_items i
    on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
    get diagnostics m = row_count; n := n + m;
    insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
    select v_draft, p_org, 'item_site', s.item_id, s.location_id, s.location_id, jsonb_build_object('active', null), auth.uid()
      from msm_stock_item_sites s
     where s.org_id = p_org and s.active is not null and s.item_id in (select id from _ss_items)
    on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
    get diagnostics m = row_count; n := n + m;
    if coalesce(p_on, false) and p_with_suppliers then
      insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_key, data, created_by)
      select v_draft, p_org, 'supplier', u.id, z, jsonb_build_object('all_sites', true), auth.uid() from _ss_sups u
       where not exists (select 1 from msm_suppliers m2 where m2.id = u.id and m2.all_sites)
      on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
      get diagnostics m = row_count; n := n + m;
    end if;
  else
    insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
    select v_draft, p_org, 'item_site', i.id, l.id, l.id, jsonb_build_object('active', coalesce(p_on, false)), auth.uid()
      from _ss_items i cross join locations l
     where l.org_id = p_org and l.id = any(p_sites)
    on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
    get diagnostics m = row_count; n := n + m;
    if coalesce(p_on, false) and p_with_suppliers then
      insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
      select v_draft, p_org, 'supplier_site', u.id, l.id, l.id, jsonb_build_object('active', true), auth.uid()
        from _ss_sups u cross join locations l
       where l.org_id = p_org and l.id = any(p_sites)
         and not exists (select 1 from msm_supplier_sites s join msm_suppliers m2 on m2.id = s.supplier_id
                          where s.supplier_id = u.id and s.location_id = l.id and coalesce(s.active, m2.all_sites))
      on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
      get diagnostics m = row_count; n := n + m;
    end if;
  end if;
  perform public.msm_stock__draft_cap(v_draft);
  return jsonb_build_object('staged', n, 'changes', (select count(*) from msm_stock_changes c where c.draft_id = v_draft));
end
$fn$;

-- "Same as site X": stage site p_to to stock exactly the items and suppliers p_from has on. A row p_to
-- has that p_from has none of goes back to following the company row's every site switch, as p_from
-- does (so p_to has nothing p_from has not).
create or replace function public.msm_stock_copy_sites(p_org uuid, p_from uuid, p_to uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  if not public.msm_stock__venue_in_org(p_from, p_org) or not public.msm_stock__venue_in_org(p_to, p_org) then
    raise exception 'Both sites must be in this company.' using errcode = '22023';
  end if;
  v_draft := public.msm_stock__open_draft(p_org);
  insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
  select v_draft, p_org, 'item_site', s.item_id, p_to, p_to, jsonb_build_object('active', s.active, 'made_here', s.made_here), auth.uid()
    from msm_stock_item_sites s where s.org_id = p_org and s.location_id = p_from and s.unlinked_at is null
  union all
  select v_draft, p_org, 'supplier_site', s.supplier_id, p_to, p_to, jsonb_build_object('active', s.active), auth.uid()
    from msm_supplier_sites s where s.org_id = p_org and s.location_id = p_from and s.unlinked_at is null
  union all
  select v_draft, p_org, 'item_site', s.item_id, p_to, p_to, jsonb_build_object('active', null, 'made_here', false), auth.uid()
    from msm_stock_item_sites s
   where s.org_id = p_org and s.location_id = p_to and s.unlinked_at is null and (s.active is not null or s.made_here)
     and not exists (select 1 from msm_stock_item_sites f where f.item_id = s.item_id and f.location_id = p_from)
  union all
  select v_draft, p_org, 'supplier_site', s.supplier_id, p_to, p_to, jsonb_build_object('active', null), auth.uid()
    from msm_supplier_sites s
   where s.org_id = p_org and s.location_id = p_to and s.unlinked_at is null and s.active is not null
     and not exists (select 1 from msm_supplier_sites f where f.supplier_id = s.supplier_id and f.location_id = p_from)
  on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
  get diagnostics n = row_count;
  perform public.msm_stock__draft_cap(v_draft);
  return jsonb_build_object('staged', n);
end
$fn$;

-- ============================================================================
-- 15. SERVER PAGES FOR THE SCREENS (each answer is one value: never more than 1,000 rows)
-- ============================================================================
create or replace function public.msm_stock_sites_of(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  -- the company's sites by the Reports rule (every venue of the company), never the venue switcher
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'timezone', l.timezone) order by l.name, l.id), '[]'::jsonb)
    from locations l where l.org_id = p_org;
$fn$;

create or replace function public.msm_stock_items_page(p_org uuid, p_search text default null, p_filter text default null,
  p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  v_sites integer := (select count(*) from locations l where l.org_id = p_org);
  v_out jsonb;
begin
  perform public.msm_stock__require_viewer(p_org);
  with base as (
    select i.* from msm_stock_items i
     where i.org_id = p_org
       and (v_q is null or lower(i.name) like '%' || v_q || '%' or lower(coalesce(i.sku, '')) = v_q or coalesce(i.barcode, '') = v_q
            or lower(coalesce(i.category, '')) like v_q || '%')
       and (case coalesce(p_filter, '')
              when 'archived' then i.archived
              when 'not_everywhere' then not i.archived
                   and (not i.all_sites or exists (select 1 from msm_stock_item_sites s where s.item_id = i.id and (s.active is false or s.unlinked_at is not null)))
                   and not (not i.all_sites and (select count(*) from msm_stock_item_sites s where s.item_id = i.id and s.active and s.unlinked_at is null) >= v_sites)
              when 'nowhere' then not i.archived and not i.all_sites
                   and not exists (select 1 from msm_stock_item_sites s where s.item_id = i.id and s.active and s.unlinked_at is null)
              else not i.archived end)
  ), pg as (
    select * from base order by lower(name), id offset greatest(coalesce(p_offset, 0), 0) limit v_lim
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'sites', public.msm_stock_sites_of(p_org),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'base_unit', p.base_unit, 'category', p.category, 'sku', p.sku, 'barcode', p.barcode,
        'purchase_tax_rate', p.purchase_tax_rate, 'archived', p.archived, 'all_sites', p.all_sites, 'updated_at', p.updated_at,
        'sites', coalesce((select jsonb_object_agg(s.location_id, jsonb_build_object(
                   'active', coalesce(s.active, p.all_sites), 'own_tick', s.active, 'linked', s.venue_item_id is not null and t.id is not null, 'unlinked', s.unlinked_at is not null,
                   'on_hand', t.on_hand, 'cost', t.current_cost, 'made_here', s.made_here))
                 from msm_stock_item_sites s
                 left join lateral (select t.id, t.on_hand, t.current_cost from inventory_items t
                                     where t.id = s.venue_item_id and t.location_id = s.location_id limit 1) t on true
                where s.item_id = p.id), '{}'::jsonb))
        order by lower(p.name), p.id) from pg p), '[]'::jsonb))
  into v_out;
  return v_out;
end
$fn$;

create or replace function public.msm_stock_item_detail(p_org uuid, p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform public.msm_stock__require_viewer(p_org);
  return (select jsonb_build_object(
    'item', to_jsonb(i),
    'packs', coalesce((select jsonb_agg(to_jsonb(p) order by p.qty_in_base, p.name) from msm_stock_packs p where p.item_id = i.id), '[]'::jsonb),
    'bridges', coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at) from msm_stock_bridges b where b.item_id = i.id), '[]'::jsonb),
    'prices', coalesce((select jsonb_agg(to_jsonb(sp) || jsonb_build_object('supplier_name', m.name) order by m.name, sp.pack_price)
                          from msm_supplier_products sp join msm_suppliers m on m.id = sp.supplier_id where sp.item_id = i.id), '[]'::jsonb),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'name', l.name, 'active', coalesce(s.active, i.all_sites),
                         'own_tick', s.active,
                         'made_here', coalesce(s.made_here, false), 'linked', t.id is not null, 'unlinked', s.unlinked_at is not null,
                         'venue_item_id', s.venue_item_id, 'on_hand', t.on_hand, 'cost', t.current_cost,
                         'par', (select pl.par_level from par_levels pl where pl.inventory_item_id = t.id and pl.location_id = l.id limit 1))
                         order by l.name)
                         from locations l
                         left join msm_stock_item_sites s on s.item_id = i.id and s.location_id = l.id
                         left join inventory_items t on t.id = s.venue_item_id and t.location_id = l.id
                        where l.org_id = p_org), '[]'::jsonb),
    'unit_locked', public.msm_stock__unit_in_use(i.id, null),
    'used_in', jsonb_build_object(
      'recipes', (select count(distinct rl.recipe_id) from msm_stock_item_sites s join recipe_lines rl on rl.component_item_id = s.venue_item_id and rl.location_id = s.location_id
                   where s.item_id = i.id),
      'sites', (select count(distinct rl.location_id) from msm_stock_item_sites s join recipe_lines rl on rl.component_item_id = s.venue_item_id and rl.location_id = s.location_id
                 where s.item_id = i.id)))
    from msm_stock_items i where i.id = p_item and i.org_id = p_org);
end
$fn$;

create or replace function public.msm_stock_suppliers_page(p_org uuid, p_search text default null, p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
begin
  perform public.msm_stock__require_viewer(p_org);
  return (with base as (
      select m.* from msm_suppliers m where m.org_id = p_org and (v_q is null or lower(m.name) like '%' || v_q || '%')
    ), pg as (select * from base order by archived, lower(name), id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 100), 1), 200))
    select jsonb_build_object(
      'total', (select count(*) from base),
      'sites', public.msm_stock_sites_of(p_org),
      'rows', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
          'prices', (select count(*) from msm_supplier_products sp where sp.supplier_id = p.id and not sp.archived),
          'sites', coalesce((select jsonb_object_agg(s.location_id, jsonb_build_object(
                     'active', coalesce(s.active, p.all_sites), 'own_tick', s.active, 'linked', t.id is not null, 'account_number', coalesce(t.account_number, s.account_number),
                     'order_email', coalesce(t.email, s.order_email), 'delivery_days', coalesce(t.delivery_days, s.delivery_days),
                     'cutoff_time', coalesce(t.cutoff_time, s.cutoff_time), 'min_order_value', coalesce(t.min_order_value, s.min_order_value),
                     'set_at_site', t.id is not null))
                   from msm_supplier_sites s
                   left join lateral (select t.id, t.account_number, t.email, t.delivery_days, t.cutoff_time, t.min_order_value from suppliers t
                                       where t.id = s.venue_supplier_id and t.location_id = s.location_id limit 1) t on true
                  where s.supplier_id = p.id), '{}'::jsonb))
          order by p.archived, lower(p.name), p.id) from pg p), '[]'::jsonb)));
end
$fn$;

create or replace function public.msm_stock_prices_page(p_org uuid, p_supplier uuid default null, p_search text default null,
  p_offset integer default 0, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_q text := nullif(lower(btrim(coalesce(p_search, ''))), '');
begin
  perform public.msm_stock__require_viewer(p_org);
  return (with base as (
      select sp.*, i.name as item_name, i.base_unit, m.name as supplier_name
        from msm_supplier_products sp join msm_stock_items i on i.id = sp.item_id join msm_suppliers m on m.id = sp.supplier_id
       where sp.org_id = p_org and not sp.archived and (p_supplier is null or sp.supplier_id = p_supplier)
         and (v_q is null or lower(i.name) like '%' || v_q || '%' or lower(coalesce(sp.supplier_sku, '')) = v_q or lower(m.name) like '%' || v_q || '%')
    ), pg as (select * from base order by lower(item_name), lower(supplier_name), id offset greatest(coalesce(p_offset, 0), 0)
              limit least(greatest(coalesce(p_limit, 100), 1), 200))
    select jsonb_build_object(
      'total', (select count(*) from base),
      'sites', public.msm_stock_sites_of(p_org),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'item_id', p.item_id, 'item_name', p.item_name, 'base_unit', p.base_unit,
          'supplier_id', p.supplier_id, 'supplier_name', p.supplier_name, 'supplier_sku', p.supplier_sku, 'pack_description', p.pack_description,
          'pack_qty', p.pack_qty, 'inner_qty', p.inner_qty, 'inner_unit', p.inner_unit, 'pack_price', p.pack_price,
          'price_includes_tax', p.price_includes_tax, 'purchase_tax_rate', p.purchase_tax_rate, 'first_choice', p.first_choice,
          'sites', coalesce((select jsonb_object_agg(x.location_id, jsonb_build_object('pack_price', x.pack_price, 'off', x.off,
                     'linked', t.id is not null, 'live_price', t.pack_price))
                   from msm_supplier_product_sites x
                   left join lateral (select t.id, t.pack_price from supplier_products t
                                       where t.id = x.venue_supplier_product_id and t.location_id = x.location_id limit 1) t on true
                  where x.sp_id = p.id), '{}'::jsonb))
          order by lower(p.item_name), lower(p.supplier_name), p.id) from pg p), '[]'::jsonb)));
end
$fn$;

create or replace function public.msm_stock_history(p_org uuid, p_offset integer default 0, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform public.msm_stock__require_viewer(p_org);
  return jsonb_build_object(
    'total', (select count(*) from msm_stock_versions v where v.org_id = p_org),
    'rows', coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object('sites', (
               select coalesce(jsonb_agg(jsonb_build_object('location_id', s.location_id, 'name', l.name, 'status', s.status, 'due_at', s.due_at,
                        'writes', s.writes, 'counts', s.counts, 'last_error', s.last_error, 'done_at', s.done_at) order by l.name), '[]'::jsonb)
                 from msm_stock_version_sites s join locations l on l.id = s.location_id where s.version_id = v.id))
             order by v.version_no desc)
             from (select * from msm_stock_versions x where x.org_id = p_org order by x.version_no desc
                    offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 50), 1), 100)) v), '[]'::jsonb));
end
$fn$;

create or replace function public.msm_stock_version_rows_page(p_org uuid, p_version uuid, p_loc uuid, p_offset integer default 0, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform public.msm_stock__require_viewer(p_org);
  if not exists (select 1 from msm_stock_versions v where v.id = p_version and v.org_id = p_org) then
    raise exception 'That version was not found.' using errcode = '22023';
  end if;
  -- each row with a name for the screen (the row as it is now, else the name the version kept)
  return jsonb_build_object(
    'total', (select count(*) from msm_stock_version_rows r where r.version_id = p_version and r.location_id = p_loc),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name', coalesce(
        case r.tbl
          when 'inventory_items' then (select t.name from inventory_items t where t.id = r.row_id)
          when 'item_cost' then (select t.name from inventory_items t where t.id = r.row_id)
          when 'suppliers' then (select t.name from suppliers t where t.id = r.row_id)
          when 'item_packaging_formats' then (select i.name || ': ' || t.name from item_packaging_formats t join inventory_items i on i.id = t.inventory_item_id where t.id = r.row_id)
          when 'inventory_item_conversions' then (select i.name || ': ' || t.from_qty::float8 || ' ' || t.from_unit || ' = ' || t.to_qty::float8 || ' ' || t.to_unit
                                                    from inventory_item_conversions t join inventory_items i on i.id = t.inventory_item_id where t.id = r.row_id)
          when 'supplier_products' then (select i.name || ' from ' || su.name from supplier_products t join inventory_items i on i.id = t.inventory_item_id
                                           join suppliers su on su.id = t.supplier_id where t.id = r.row_id)
          when 'inventory_item_areas' then (select i.name || ' in ' || a.name from inventory_items i, storage_areas a
                                              where i.id = (r.after ->> 'item')::uuid and a.id = (r.after ->> 'area_id')::uuid)
        end, r.after ->> 'name', r.before ->> 'name', r.after ->> 'pack_description', r.before ->> 'pack_description'))
        order by r.tbl, r.row_id) from (
        select * from msm_stock_version_rows r where r.version_id = p_version and r.location_id = p_loc
         order by r.tbl, r.row_id offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 200), 1), 500)) r), '[]'::jsonb));
end
$fn$;

-- The Review screen's page of the open draft, each change with the names it is about (the item, the
-- supplier, the pack, the site), from the company rows or from the draft itself for new ones.
create or replace function public.msm_stock_draft_rows(p_org uuid, p_offset integer default 0, p_limit integer default 300)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
begin
  perform public.msm_stock__require_viewer(p_org);
  select d.id into v_draft from msm_stock_drafts d where d.org_id = p_org and d.status = 'open';
  if v_draft is null then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'total', (select count(*) from msm_stock_changes c where c.draft_id = v_draft),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'target', c.target, 'entity_id', c.entity_id, 'location_id', c.location_id,
               'site_name', l.name, 'data', c.data, 'updated_at', c.updated_at,
               'item_name', coalesce((select i.name from msm_stock_items i where i.id = k.item_id),
                                     (select d.data ->> 'name' from msm_stock_changes d where d.draft_id = v_draft and d.target = 'item' and d.entity_id = k.item_id)),
               'supplier_name', coalesce((select m.name from msm_suppliers m where m.id = k.supplier_id),
                                         (select d.data ->> 'name' from msm_stock_changes d where d.draft_id = v_draft and d.target = 'supplier' and d.entity_id = k.supplier_id)),
               'pack_name', case when c.target in ('pack', 'pack_site')
                                 then coalesce((select p.name from msm_stock_packs p where p.id = c.entity_id),
                                               (select d.data ->> 'name' from msm_stock_changes d where d.draft_id = v_draft and d.target = 'pack' and d.entity_id = c.entity_id)) end,
               'parent_pack_name', case when c.data ->> 'parent_pack_id' is not null
                                        then coalesce((select p.name from msm_stock_packs p where p.id = (c.data ->> 'parent_pack_id')::uuid),
                                                      (select d.data ->> 'name' from msm_stock_changes d where d.draft_id = v_draft and d.target = 'pack'
                                                          and d.entity_id = (c.data ->> 'parent_pack_id')::uuid)) end)
             order by c.updated_at, c.id)
        from (select * from msm_stock_changes x where x.draft_id = v_draft order by x.updated_at, x.id
               offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 300), 1), 500)) c
        left join locations l on l.id = c.location_id
        cross join lateral (
          select case when c.target in ('item', 'item_site') then c.entity_id
                      when c.target in ('pack', 'pack_site') then coalesce((select p.item_id from msm_stock_packs p where p.id = c.entity_id),
                        (select (d.data ->> 'item_id')::uuid from msm_stock_changes d where d.draft_id = v_draft and d.target = 'pack' and d.entity_id = c.entity_id))
                      when c.target in ('bridge', 'bridge_site') then coalesce((select b.item_id from msm_stock_bridges b where b.id = c.entity_id),
                        (select (d.data ->> 'item_id')::uuid from msm_stock_changes d where d.draft_id = v_draft and d.target = 'bridge' and d.entity_id = c.entity_id))
                      when c.target in ('sp', 'sp_site') then coalesce((select sp.item_id from msm_supplier_products sp where sp.id = c.entity_id),
                        (select (d.data ->> 'item_id')::uuid from msm_stock_changes d where d.draft_id = v_draft and d.target = 'sp' and d.entity_id = c.entity_id))
                 end as item_id,
                 case when c.target in ('supplier', 'supplier_site') then c.entity_id
                      when c.target in ('sp', 'sp_site') then coalesce((select sp.supplier_id from msm_supplier_products sp where sp.id = c.entity_id),
                        (select (d.data ->> 'supplier_id')::uuid from msm_stock_changes d where d.draft_id = v_draft and d.target = 'sp' and d.entity_id = c.entity_id))
                 end as supplier_id) k), '[]'::jsonb));
end
$fn$;

-- Site cards: "Stock in step" or what waits, for every site of the company.
create or replace function public.msm_stock_site_cards(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  perform public.msm_stock__require_viewer(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'location_id', l.id, 'name', l.name, 'timezone', l.timezone,
      'items', (select count(*) from msm_stock_items i left join msm_stock_item_sites s on s.item_id = i.id and s.location_id = l.id
                 where i.org_id = p_org and not i.archived and coalesce(s.active, i.all_sites) and s.unlinked_at is null),
      'waiting', (select jsonb_build_object('version_no', v.version_no, 'due_at', s.due_at, 'status', s.status, 'last_error', s.last_error)
                    from msm_stock_version_sites s join msm_stock_versions v on v.id = s.version_id
                   where s.location_id = l.id and s.org_id = p_org and s.status in ('waiting', 'running', 'failed')
                   order by v.version_no desc limit 1),
      'last', (select jsonb_build_object('version_no', v.version_no, 'done_at', s.done_at, 'writes', s.writes)
                 from msm_stock_version_sites s join msm_stock_versions v on v.id = s.version_id
                where s.location_id = l.id and s.org_id = p_org and s.status in ('done', 'nothing')
                order by s.done_at desc nulls last limit 1),
      'central', coalesce((select d.mode from stock_depletion_mode d where d.location_id = l.id), 'browser'))
      order by l.name) from locations l where l.org_id = p_org), '[]'::jsonb);
end
$fn$;

-- Side by side: what a publish would change at one site right now (the first 200 rows).
create or replace function public.msm_stock_site_drift(p_org uuid, p_loc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.msm_stock__require_viewer(p_org);
  if not public.msm_stock__venue_in_org(p_loc, p_org) then raise exception 'That site is not in this company.' using errcode = '22023'; end if;
  return public.msm_stock__sync_site(p_org, p_loc, null, false, true);
end
$fn$;

-- ============================================================================
-- 16. CHANGE PRICES AND CSV IMPORT
-- ============================================================================

-- Change prices by a percent and/or an amount, for chosen prices (or one supplier's, or all), at the
-- company price (p_sites null) or as each chosen site's own price. p_preview true: the first 200 rows
-- before and after and the totals, nothing staged.
create or replace function public.msm_stock_change_prices(p_org uuid, p_sp_ids uuid[] default null, p_supplier uuid default null,
  p_pct numeric default null, p_amount numeric default null, p_sites uuid[] default null, p_preview boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_draft uuid;
  v_rows jsonb;
  v_n integer;
begin
  if p_preview then perform public.msm_stock__require_viewer(p_org); else perform public.msm_stock__require_editor(p_org); end if;
  if coalesce(p_pct, 0) = 0 and coalesce(p_amount, 0) = 0 then
    raise exception 'Give a percent or an amount.' using errcode = '22023';
  end if;
  drop table if exists _pc;
  create temp table _pc on commit drop as
  select sp.id as sp_id, l.id as location_id, i.name as item_name, m.name as supplier_name,
         case when l.id is null then sp.pack_price else coalesce(x.pack_price, sp.pack_price) end as old_price,
         greatest(round((case when l.id is null then sp.pack_price else coalesce(x.pack_price, sp.pack_price) end) * (1 + coalesce(p_pct, 0) / 100.0)
                        + coalesce(p_amount, 0), 4), 0) as new_price
    from msm_supplier_products sp
    join msm_stock_items i on i.id = sp.item_id
    join msm_suppliers m on m.id = sp.supplier_id
    left join locations l on p_sites is not null and l.org_id = p_org and l.id = any(p_sites)
    left join msm_supplier_product_sites x on x.sp_id = sp.id and x.location_id = l.id
   where sp.org_id = p_org and not sp.archived
     and (p_sp_ids is null or sp.id = any(p_sp_ids)) and (p_supplier is null or sp.supplier_id = p_supplier)
     and (p_sites is null or l.id is not null);
  select count(*) into v_n from _pc;
  -- one row per price per chosen site: 5,000 prices at 50 sites would be 250,000 rows, more than a
  -- draft can publish or the Review screen can show. Refused in words, at preview already.
  if v_n > 40000 then
    raise exception 'That is % prices at % sites, more than the 40,000 one draft can hold. Pick fewer sites or prices, or change the company price instead (one change reaches every site).',
      to_char((select count(distinct c.sp_id) from _pc c), 'FM999,999,999'), coalesce(array_length(p_sites, 1), 1) using errcode = '54000';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_rows from (select * from _pc order by item_name, supplier_name limit 200) r;
  if p_preview then
    return jsonb_build_object('rows', v_rows, 'total', v_n, 'staged', 0);
  end if;
  v_draft := public.msm_stock__open_draft(p_org);
  insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_id, location_key, data, created_by)
  select v_draft, p_org, case when c.location_id is null then 'sp' else 'sp_site' end, c.sp_id, c.location_id,
         coalesce(c.location_id, '00000000-0000-0000-0000-000000000000'::uuid), jsonb_build_object('pack_price', c.new_price), auth.uid()
    from _pc c
  on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
  perform public.msm_stock__draft_cap(v_draft);
  return jsonb_build_object('rows', v_rows, 'total', v_n, 'staged', v_n);
end
$fn$;

-- CSV import, step 1: rows in chunks of at most 2,000 (the screen parses the file).
create or replace function public.msm_stock_import_stage(p_org uuid, p_import uuid, p_kind text, p_first_row integer, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  if p_kind not in ('items', 'packs', 'prices') then raise exception 'Import items, packs or prices.' using errcode = '22023'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Send at most 2,000 rows a call.' using errcode = '22023';
  end if;
  if exists (select 1 from msm_stock_import_rows r where r.import_id = p_import and (r.org_id <> p_org or r.kind <> p_kind)) then
    raise exception 'That import belongs to something else.' using errcode = '22023';
  end if;
  insert into msm_stock_import_rows (import_id, org_id, kind, row_no, data, created_by)
  select p_import, p_org, p_kind, coalesce(p_first_row, 1) + (e.ord - 1)::int, e.val, auth.uid()
    from jsonb_array_elements(p_rows) with ordinality e(val, ord)
  on conflict (import_id, row_no) do update set data = excluded.data;
  get diagnostics n = row_count;
  return jsonb_build_object('staged', n, 'rows', (select count(*) from msm_stock_import_rows r where r.import_id = p_import));
end
$fn$;

-- CSV import, step 2: check every row (set based); with no errors and p_preview false, the rows go into
-- the draft (items and packs matched by SKU, then name; prices by supplier, item and supplier SKU or pack).
create or replace function public.msm_stock_import_commit(p_org uuid, p_import uuid, p_preview boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_kind text;
  v_errors jsonb;
  v_n integer;
  v_changes jsonb;
  v_draft uuid;
begin
  perform public.msm_stock__require_editor(p_org);
  select r.kind into v_kind from msm_stock_import_rows r where r.import_id = p_import and r.org_id = p_org limit 1;
  if v_kind is null then raise exception 'That import has no rows.' using errcode = '22023'; end if;
  select count(*) into v_n from msm_stock_import_rows r where r.import_id = p_import;

  drop table if exists _imp_draft;
  create temp table _imp_draft on commit drop as
  select c.entity_id as id, nullif(lower(btrim(c.data ->> 'sku')), '') as sku, lower(btrim(c.data ->> 'name')) as name, c.data ->> 'base_unit' as base_unit,
         c.updated_at as at
    from msm_stock_changes c join msm_stock_drafts d on d.id = c.draft_id and d.org_id = p_org and d.status = 'open'
   where c.target = 'item' and c.data ? '_new' and v_kind in ('packs', 'prices');
  drop table if exists _imp;
  create temp table _imp on commit drop as
  select r.row_no, r.data, nullif(btrim(r.data ->> 'name'), '') as name, nullif(btrim(r.data ->> 'sku'), '') as sku,
         lower(nullif(btrim(r.data ->> 'base_unit'), '')) as base_unit, nullif(btrim(r.data ->> 'item'), '') as item_ref,
         nullif(btrim(r.data ->> 'supplier'), '') as supplier_name,
         null::uuid as item_id, null::uuid as supplier_id, null::uuid as match_id, null::text as error
    from msm_stock_import_rows r where r.import_id = p_import;

  if v_kind = 'items' then
    update _imp x set match_id = coalesce(
        (select i.id from msm_stock_items i where i.org_id = p_org and x.sku is not null and lower(i.sku) = lower(x.sku) order by i.created_at, i.id limit 1),
        (select i.id from msm_stock_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(x.name) order by i.created_at, i.id limit 1))
     where true;
    update _imp x set error = case
        when x.name is null then 'name is empty'
        when x.match_id is null and x.base_unit is null then 'base_unit is empty (g, kg, ml, l, each)'
        when x.base_unit is not null and not exists (select 1 from stock_units u where u.code = x.base_unit) then format('base_unit "%s" is not a unit', x.base_unit)
        when x.match_id is not null and x.base_unit is not null and x.base_unit <> (select i.base_unit from msm_stock_items i where i.id = x.match_id)
             then 'base_unit differs from the company item (a base unit cannot change here)'
        when nullif(btrim(x.data ->> 'purchase_vat'), '') is not null and (nullif(btrim(x.data ->> 'purchase_vat'), '') !~ '^[0-9]+(\.[0-9]+)?$'
             or (x.data ->> 'purchase_vat')::numeric >= 100) then 'purchase_vat must be a percent such as 20'
        when nullif(btrim(x.data ->> 'shelf_life_days'), '') is not null and nullif(btrim(x.data ->> 'shelf_life_days'), '') !~ '^[0-9]+$' then 'shelf_life_days must be a whole number'
        else null end
     where true;
    update _imp x set error = 'the same item is twice in the file (same SKU, or same name with no SKU)'
      from (select y.row_no, row_number() over (partition by case when y.sku is not null then 's:' || lower(y.sku) else 'n:' || lower(y.name) end
                                                order by y.row_no) as rn
              from _imp y where y.error is null) d
     where x.row_no = d.row_no and d.rn > 1;
  elsif v_kind = 'packs' then
    update _imp x set item_id = coalesce(
        (select i.id from msm_stock_items i where i.org_id = p_org and lower(i.sku) = lower(x.item_ref) limit 1),
        (select i.id from msm_stock_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(x.item_ref) order by i.created_at, i.id limit 1),
        (select n.id from _imp_draft n where n.sku = lower(x.item_ref) order by n.at, n.id limit 1),
        (select n.id from _imp_draft n where n.name = lower(x.item_ref) order by n.at, n.id limit 1))
     where true;
    update _imp x set match_id = (select p.id from msm_stock_packs p where p.item_id = x.item_id and lower(btrim(p.name)) = lower(x.name) limit 1)
     where true;
    update _imp x set error = case
        when x.item_id is null then format('item "%s" is not a company stock item (use its SKU or exact name)', coalesce(x.item_ref, ''))
        when x.name is null then 'name is empty'
        when nullif(btrim(x.data ->> 'qty_in_base'), '') is null or btrim(x.data ->> 'qty_in_base') !~ '^[0-9]+(\.[0-9]+)?$'
             or (x.data ->> 'qty_in_base')::numeric <= 0 then 'qty_in_base must be a number above 0'
        else null end
     where true;
  else
    update _imp x set item_id = coalesce(
        (select i.id from msm_stock_items i where i.org_id = p_org and lower(i.sku) = lower(x.item_ref) limit 1),
        (select i.id from msm_stock_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(x.item_ref) order by i.created_at, i.id limit 1),
        (select n.id from _imp_draft n where n.sku = lower(x.item_ref) order by n.at, n.id limit 1),
        (select n.id from _imp_draft n where n.name = lower(x.item_ref) order by n.at, n.id limit 1)),
      supplier_id = coalesce(
        (select m.id from msm_suppliers m where m.org_id = p_org and lower(btrim(m.name)) = lower(x.supplier_name) order by m.created_at, m.id limit 1),
        (select c.entity_id from msm_stock_changes c join msm_stock_drafts d on d.id = c.draft_id and d.org_id = p_org and d.status = 'open'
          where c.target = 'supplier' and c.data ? '_new' and lower(btrim(c.data ->> 'name')) = lower(x.supplier_name) order by c.updated_at, c.entity_id limit 1))
     where true;
    update _imp x set match_id = (select sp.id from msm_supplier_products sp where sp.item_id = x.item_id and sp.supplier_id = x.supplier_id
                                     and ((nullif(btrim(x.data ->> 'supplier_sku'), '') is not null and lower(sp.supplier_sku) = lower(btrim(x.data ->> 'supplier_sku')))
                                       or (nullif(btrim(x.data ->> 'supplier_sku'), '') is null and lower(coalesce(sp.pack_description, '')) = lower(coalesce(btrim(x.data ->> 'pack_description'), ''))))
                                   order by sp.created_at, sp.id limit 1)
     where x.item_id is not null and x.supplier_id is not null;
    update _imp x set base_unit = coalesce((select i.base_unit from msm_stock_items i where i.id = x.item_id),
                                           (select n.base_unit from _imp_draft n where n.id = x.item_id))
     where x.item_id is not null;
    update _imp x set error = case
        when x.item_id is null then format('item "%s" is not a company stock item (use its SKU or exact name)', coalesce(x.item_ref, ''))
        when x.supplier_name is null then 'supplier is empty'
        when nullif(btrim(x.data ->> 'pack_price'), '') is null or btrim(x.data ->> 'pack_price') !~ '^[0-9]+(\.[0-9]+)?$' then 'pack_price must be a number'
        when nullif(btrim(x.data ->> 'inner_unit'), '') is not null and not exists (select 1 from stock_units u where u.code = lower(btrim(x.data ->> 'inner_unit')))
             then format('inner_unit "%s" is not a unit', x.data ->> 'inner_unit')
        when coalesce(nullif(btrim(x.data ->> 'pack_qty'), ''), '1') !~ '^[0-9]+(\.[0-9]+)?$' or coalesce(nullif(btrim(x.data ->> 'inner_qty'), ''), '1') !~ '^[0-9]+(\.[0-9]+)?$'
             then 'pack_qty and inner_qty must be numbers'
        else null end
     where true;
  end if;

  update _imp x set error = format('this row and row %s change the same company row', d.first_row)
    from (select y.row_no, first_value(y.row_no) over (partition by y.match_id order by y.row_no) as first_row,
                 row_number() over (partition by y.match_id order by y.row_no) as rn
            from _imp y where y.error is null and y.match_id is not null) d
   where x.row_no = d.row_no and d.rn > 1;
  select coalesce(jsonb_agg(jsonb_build_object('row', x.row_no, 'error', x.error) order by x.row_no), '[]'::jsonb) into v_errors
    from (select * from _imp where error is not null order by row_no limit 200) x;
  if p_preview or jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('rows', v_n, 'errors', v_errors, 'error_count', (select count(*) from _imp where error is not null),
                              'new', (select count(*) from _imp where error is null and match_id is null),
                              'updates', (select count(*) from _imp where error is null and match_id is not null), 'staged', 0);
  end if;

  if v_kind = 'items' then
    update _imp set match_id = coalesce(match_id, gen_random_uuid()) where true;
    drop table if exists _imp_new;
    create temp table _imp_new on commit drop as select match_id from _imp x where not exists (select 1 from msm_stock_items i where i.id = x.match_id);
    v_changes := (select jsonb_agg(jsonb_build_object('target', 'item', 'entity_id', x.match_id, 'data',
        jsonb_strip_nulls(jsonb_build_object('name', x.name, 'sku', x.sku, 'base_unit', x.base_unit,
          'barcode', nullif(btrim(x.data ->> 'barcode'), ''), 'category', nullif(btrim(x.data ->> 'category'), ''),
          'accounting_group', nullif(btrim(x.data ->> 'accounting_group'), ''),
          'shelf_life_days', (nullif(btrim(x.data ->> 'shelf_life_days'), ''))::int,
          'purchase_tax_rate', round((nullif(btrim(x.data ->> 'purchase_vat'), ''))::numeric / 100, 6),
          'default_area_kind', nullif(btrim(x.data ->> 'area_kind'), ''),
          'allergens', case when nullif(btrim(x.data ->> 'allergens'), '') is null then null
                            else to_jsonb(array(select btrim(a) from unnest(string_to_array(x.data ->> 'allergens', ';')) a where btrim(a) <> '')) end))
        || case when exists (select 1 from _imp_new n where n.match_id = x.match_id) then '{"_new": true}'::jsonb else '{}'::jsonb end))
      from _imp x);
  elsif v_kind = 'packs' then
    v_changes := (select jsonb_agg(jsonb_build_object('target', 'pack', 'entity_id', coalesce(x.match_id, gen_random_uuid()), 'data',
        jsonb_build_object('item_id', x.item_id, 'name', x.name, 'qty_in_base', (x.data ->> 'qty_in_base')::numeric)
        || case when lower(coalesce(x.data ->> 'count_default', '')) in ('yes', 'true', '1', 'y') then '{"is_count_default": true}'::jsonb else '{}'::jsonb end
        || case when lower(coalesce(x.data ->> 'buy_default', '')) in ('yes', 'true', '1', 'y') then '{"is_purchase_default": true}'::jsonb else '{}'::jsonb end
        || case when x.match_id is null then '{"_new": true}'::jsonb else '{}'::jsonb end))
      from _imp x);
  else
    -- suppliers named in the file that the company does not have yet are added
    drop table if exists _imp_sup;
    create temp table _imp_sup on commit drop as
    select distinct on (lower(x.supplier_name)) gen_random_uuid() as id, x.supplier_name as name
      from _imp x where x.supplier_id is null order by lower(x.supplier_name), x.row_no;
    update _imp x set supplier_id = s.id from _imp_sup s where x.supplier_id is null and lower(s.name) = lower(x.supplier_name);
    v_changes := coalesce((select jsonb_agg(jsonb_build_object('target', 'supplier', 'entity_id', s.id, 'data', jsonb_build_object('name', s.name, '_new', true)))
                             from _imp_sup s), '[]'::jsonb)
      || (select jsonb_agg(jsonb_build_object('target', 'sp', 'entity_id', coalesce(x.match_id, gen_random_uuid()), 'data',
        jsonb_strip_nulls(jsonb_build_object('item_id', x.item_id, 'supplier_id', x.supplier_id,
          'supplier_sku', nullif(btrim(x.data ->> 'supplier_sku'), ''), 'pack_description', nullif(btrim(x.data ->> 'pack_description'), ''),
          'pack_qty', case when x.match_id is null then coalesce((nullif(btrim(x.data ->> 'pack_qty'), ''))::numeric, 1)
                           else (nullif(btrim(x.data ->> 'pack_qty'), ''))::numeric end,
          'inner_qty', case when x.match_id is null then coalesce((nullif(btrim(x.data ->> 'inner_qty'), ''))::numeric, 1)
                            else (nullif(btrim(x.data ->> 'inner_qty'), ''))::numeric end,
          'inner_unit', case when x.match_id is null then coalesce(lower(nullif(btrim(x.data ->> 'inner_unit'), '')), x.base_unit)
                             else lower(nullif(btrim(x.data ->> 'inner_unit'), '')) end,
          'pack_price', (x.data ->> 'pack_price')::numeric,
          'price_includes_tax', case when nullif(btrim(x.data ->> 'includes_vat'), '') is null then case when x.match_id is null then false end
                                     else lower(btrim(x.data ->> 'includes_vat')) in ('yes', 'true', '1', 'y') end))
        || case when x.match_id is null then '{"_new": true}'::jsonb else '{}'::jsonb end))
      from _imp x);
  end if;
  -- into the draft in one set based statement (every row was checked above, types included)
  v_draft := public.msm_stock__open_draft(p_org);
  insert into msm_stock_changes as x (draft_id, org_id, target, entity_id, location_key, data, created_by)
  select v_draft, p_org, e ->> 'target', (e ->> 'entity_id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid, e -> 'data', auth.uid()
    from jsonb_array_elements(coalesce(v_changes, '[]'::jsonb)) e
  on conflict (draft_id, target, entity_id, location_key) do update set data = x.data || excluded.data, updated_at = now();
  update msm_stock_drafts set updated_at = now() where id = v_draft;
  perform public.msm_stock__draft_cap(v_draft);
  delete from msm_stock_import_rows r where r.import_id = p_import;
  return jsonb_build_object('rows', v_n, 'errors', '[]'::jsonb, 'error_count', 0, 'staged', jsonb_array_length(coalesce(v_changes, '[]'::jsonb)),
                            'changes', (select count(*) from msm_stock_changes c where c.draft_id = v_draft));
end
$fn$;

-- ============================================================================
-- 17. SITE SIDE: STATUS, THE USUAL SIX AREAS, THE MANAGER PIN ON COUNT APPROVAL
-- ============================================================================

-- For a site's own Back Office screens: is this site's stock shared, who the Editors are, and what
-- head office changed here in the last 14 days. Any login that reaches the site may ask.
create or replace function public.msm_stock_site_status(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org uuid := (select l.org_id from locations l where l.id = p_location_id);
begin
  if not public.stock_caller_reaches(p_location_id) then
    return jsonb_build_object('shared', false);
  end if;
  return jsonb_build_object(
    'shared', coalesce((select c.enabled from stock_company c where c.org_id = v_org), false),
    'editors', public.msm_stock__editor_names(p_location_id),
    'managed_items', (select count(*) from inventory_items t where t.location_id = p_location_id and t.company_ref is not null),
    'news', (select jsonb_build_object(
               'since', now() - interval '14 days',
               'items_added', count(*) filter (where r.tbl = 'inventory_items' and r.op = 'insert'),
               'items_changed', count(*) filter (where r.tbl = 'inventory_items' and r.op in ('update', 'link')),
               'suppliers_added', count(*) filter (where r.tbl = 'suppliers' and r.op = 'insert'),
               'prices_changed', count(*) filter (where r.tbl = 'supplier_products'),
               'last_at', max(s.done_at),
               'names', (select coalesce(jsonb_agg(z.n), '[]'::jsonb) from (
                          select distinct coalesce(r2.after ->> 'name', '') as n
                            from msm_stock_version_rows r2 join msm_stock_version_sites s2 on s2.version_id = r2.version_id and s2.location_id = r2.location_id
                           where r2.location_id = p_location_id and r2.tbl = 'inventory_items' and s2.done_at > now() - interval '14 days'
                             and coalesce(r2.after ->> 'name', '') <> '' order by 1 limit 20) z))
               from msm_stock_version_rows r
               join msm_stock_version_sites s on s.version_id = r.version_id and s.location_id = r.location_id
              where r.location_id = p_location_id and s.done_at > now() - interval '14 days' and s.status in ('done', 'nothing')));
end
$fn$;

-- Head office adds the usual six areas at sites (the go live order: areas before items).
create or replace function public.msm_stock_add_areas(p_org uuid, p_sites uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  perform public.msm_stock__require_editor(p_org);
  insert into storage_areas (location_id, name, kind, sort_order)
  select l.id, u.name, u.kind,
         (select coalesce(max(a.sort_order), 0) from storage_areas a where a.location_id = l.id) + u.ord * 10
    from locations l
    cross join (values (1, 'Cellar', 'cellar'), (2, 'Walk in fridge', 'walk_in'), (3, 'Freezer', 'freezer'),
                       (4, 'Dry store', 'dry_store'), (5, 'Bar', 'bar'), (6, 'Kitchen', 'kitchen')) as u(ord, name, kind)
   where l.org_id = p_org and (p_sites is null or l.id = any(p_sites))
     and not exists (select 1 from storage_areas a where a.location_id = l.id and a.archived_at is null
                      and (a.kind = u.kind or lower(regexp_replace(btrim(a.name), '[\s_-]+', ' ', 'g')) = lower(u.name)));
  get diagnostics n = row_count;
  return jsonb_build_object('added', n);
end
$fn$;

-- Costs for an opening count (plan 4.6: "the site's cost if known, else the company price, else a
-- price entered on the count"). For each counted item at the count's site that has no cost yet: its
-- preferred live supplier price there (else the cheapest), per base unit, net of VAT when the price
-- includes it; with no price there, the average cost here of the same company item at the company's
-- other sites (in the same base unit). { item id: cost }, never 0. approve_stock_count still puts the
-- site's own cost first and a typed cost over these. The Manager app (service role) and the PIN call
-- below use it; logins cannot call it.
create or replace function public.msm_stock_opening_costs(p_count_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with c as (
    select s.location_id from stock_counts s where s.id = p_count_id
  ), it as (
    select distinct t.id, t.base_unit, t.purchase_tax_rate_id, t.company_ref
      from stock_count_lines l
      join c on c.location_id = l.location_id
      join inventory_items t on t.id = l.inventory_item_id and t.location_id = c.location_id
     where l.count_id = p_count_id and l.counted_qty is not null and coalesce(t.current_cost, 0) = 0
  ), price as (
    select distinct on (i.id) i.id, round(n.net / q.qb, 5) as cost
      from it i
      join c on true
      join supplier_products sp on sp.location_id = c.location_id and sp.inventory_item_id = i.id and sp.archived_at is null
      cross join lateral (select case when coalesce(sp.price_includes_tax, false)
                                      then sp.pack_price / (1 + coalesce((select r.rate from tax_rates r where r.id = coalesce(sp.purchase_tax_rate_id, i.purchase_tax_rate_id)), 0))
                                      else sp.pack_price end as net) n
      cross join lateral (select public.stock_convert_qty(sp.pack_qty * sp.inner_qty, sp.inner_unit, i.base_unit, array[i.id]) as qb) q
     where q.qb > 0 and n.net > 0 and round(n.net / q.qb, 5) > 0
     order by i.id, sp.is_preferred desc nulls last, n.net / q.qb, sp.id
  ), company_avg as (
    select i.id, round(avg(o.current_cost), 5) as cost
      from it i
      join inventory_items o on o.company_ref = i.company_ref and o.id <> i.id and o.base_unit = i.base_unit and o.current_cost > 0
     where i.company_ref is not null and not exists (select 1 from price p where p.id = i.id)
     group by i.id
  )
  select coalesce(jsonb_object_agg(x.id, x.cost), '{}'::jsonb)
    from (select p.id, p.cost from price p union all select a.id, a.cost from company_avg a where a.cost > 0) x;
$fn$;

-- Count approval with a manager PIN (4.6, Phase 1). The Back Office login must reach the venue; the
-- PIN must be an active Manager or Owner at that venue (or have manager_approvals). Five wrong PINs in
-- 15 minutes and the login waits; an empty PIN is not a try. Preview needs no PIN. An opening count
-- is costed by msm_stock_opening_costs, a cost typed on the screen wins.
create or replace function public.stock_approve_count_pin(p_count_id uuid, p_pin text, p_approved_by_name text default null,
  p_approval_note text default null, p_costs jsonb default null, p_preview boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_loc uuid := (select c.location_id from stock_counts c where c.id = p_count_id);
  v_staff record;
  v_res jsonb;
  v_costs jsonb;
begin
  if v_loc is null or not public.stock_office_reaches(v_loc) then
    raise exception 'That count was not found, or this login cannot approve counts at its venue.' using errcode = '42501';
  end if;
  v_costs := public.msm_stock_opening_costs(p_count_id)
             || case when jsonb_typeof(p_costs) = 'object' then p_costs else '{}'::jsonb end;
  if p_preview then
    return public.approve_stock_count(p_count_id, p_approved_by_name, p_approval_note, v_costs, true);
  end if;
  if btrim(coalesce(p_pin, '')) = '' then
    return jsonb_build_object('ok', false, 'error', 'Type the manager PIN first.', 'pin', 'missing');
  end if;
  if (select count(*) from stock_pin_tries t where t.location_id = v_loc and t.user_id is not distinct from auth.uid()
        and t.tried_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Wait 15 minutes, then try again.', 'pin', 'locked');
  end if;
  select s.id, s.name into v_staff from staff_members s
   where s.location_id = v_loc and s.pin = btrim(coalesce(p_pin, '')) and coalesce(s.active, true)
     and (lower(coalesce(s.role, '')) in ('manager', 'owner') or coalesce(s.permissions, '[]'::jsonb) ? 'manager_approvals')
   order by s.created_at limit 1;
  if v_staff.id is null then
    insert into stock_pin_tries (user_id, location_id) values (auth.uid(), v_loc);
    return jsonb_build_object('ok', false, 'error', 'That PIN is not a manager at this venue.', 'pin', 'wrong');
  end if;
  v_res := public.approve_stock_count(p_count_id, coalesce(nullif(btrim(p_approved_by_name), ''), v_staff.name), p_approval_note, v_costs, false);
  return v_res || jsonb_build_object('approved_by_pin', v_staff.name);
end
$fn$;

-- ============================================================================
-- 18. WHO MAY CALL WHAT (production gives every new function to anon: take it back by name)
-- ============================================================================
do $grants$
declare
  f text;
begin
  -- internal: owner only
  foreach f in array array[
    'public.msm_stock_org_guard()', 'public.msm_stock_base_unit_lock()', 'public.msm_stock__company_on(uuid)',
    'public.msm_stock__venue_in_org(uuid,uuid)', 'public.msm_stock__editor_names(uuid)', 'public.msm_stock__writer_ok()',
    'public.msm_stock__cols(text)', 'public.msm_stock__pick(jsonb,text[])', 'public.msm_stock__central_all(uuid,text)',
    'public._stock_company_site_joins()', 'public.msm_stock__allowed(text)', 'public.msm_stock__clean(text,jsonb)',
    'public.msm_stock__open_draft(uuid)', 'public.msm_stock__entity_ok(uuid,uuid,text,uuid)', 'public.msm_stock__freeze(uuid,uuid,uuid)',
    'public.msm_stock__sync_site(uuid,uuid,uuid,boolean,boolean)', 'public.msm_stock__health(uuid,uuid)', 'public.msm_stock__sites(uuid)',
    'public.msm_stock__next_quiet(uuid)', 'public.msm_stock__new_version(uuid,text,uuid,uuid,text,text)', 'public.msm_stock__refresh_version(uuid)',
    'public.msm_stock__busy_words(uuid)', 'public.msm_stock__undo_site(uuid,uuid,uuid)',
    'public.msm_stock__run_site(bigint)', 'public.msm_stock__require_viewer(uuid)', 'public.msm_stock__require_editor(uuid)',
    'public.msm_stock__site_item_in_use(uuid,uuid)', 'public.msm_stock__unit_in_use(uuid,text)', 'public.msm_stock__draft_cap(uuid)',
    'public.msm_stock__rate_words(uuid)', 'public.msm_stock__cost_plan(uuid,text)', 'public.msm_stock__fresh_stats(uuid,boolean)',
    'public.msm_stock__link_pairs(uuid,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  -- the trigger helper runs as the caller (INVOKER): the API roles keep EXECUTE on these two only
  revoke all on function public.msm_stock_site_lock() from public, anon;
  grant execute on function public.msm_stock_site_lock() to authenticated, service_role;
  grant execute on function public.msm_stock__writer_ok() to authenticated, service_role;
  grant execute on function public.msm_stock__editor_names(uuid) to authenticated, service_role;
  revoke all on procedure public.msm_stock_run_due(integer) from public, anon, authenticated, service_role;
  -- signed in people (each function checks who is asking itself)
  foreach f in array array[
    'public.msm_stock_role(uuid)', 'public.msm_stock_viewable_org_ids()', 'public.msm_stock_member_org_ids()',
    'public.stock_admin_status(uuid)', 'public.stock_admin_set_enabled(uuid,boolean)', 'public.stock_admin_set_member(uuid,uuid,text)',
    'public.stock_my_access()', 'public.msm_stock_stage(uuid,jsonb)', 'public.msm_stock_unstage(uuid,uuid[])',
    'public.msm_stock_preview(uuid,uuid[])', 'public.msm_stock_publish(uuid,text,text)', 'public.msm_stock_run_now(uuid,uuid)',
    'public.msm_stock_undo(uuid,uuid)', 'public.msm_stock_keep_site(uuid,uuid,text,uuid)', 'public.msm_stock_start_from_site(uuid,uuid)',
    'public.msm_stock_link_candidates(uuid,uuid,integer,integer)', 'public.msm_stock_stage_links(uuid,uuid)',
    'public.msm_stock_stage_sites(uuid,uuid[],uuid[],boolean,boolean)', 'public.msm_stock_copy_sites(uuid,uuid,uuid)',
    'public.msm_stock_sites_of(uuid)', 'public.msm_stock_items_page(uuid,text,text,integer,integer)', 'public.msm_stock_item_detail(uuid,uuid)',
    'public.msm_stock_suppliers_page(uuid,text,integer,integer)', 'public.msm_stock_prices_page(uuid,uuid,text,integer,integer)',
    'public.msm_stock_history(uuid,integer,integer)', 'public.msm_stock_version_rows_page(uuid,uuid,uuid,integer,integer)',
    'public.msm_stock_site_cards(uuid)', 'public.msm_stock_site_drift(uuid,uuid)',
    'public.msm_stock_change_prices(uuid,uuid[],uuid,numeric,numeric,uuid[],boolean)',
    'public.msm_stock_import_stage(uuid,uuid,text,integer,jsonb)', 'public.msm_stock_import_commit(uuid,uuid,boolean)',
    'public.msm_stock_add_areas(uuid,uuid[])', 'public.stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)',
    'public.msm_stock_draft_rows(uuid,integer,integer)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- msm_stock_sites_of answers to anyone signed in only through the pages (it names a company's sites)
  revoke all on function public.msm_stock_sites_of(uuid) from authenticated;
  -- the site screens (Back Office and the Manager app's service role) ask this one
  revoke all on function public.msm_stock_site_status(uuid) from public, anon;
  grant execute on function public.msm_stock_site_status(uuid) to authenticated, service_role;
  -- opening count costs: the Manager app (service role) asks before it approves; logins get them
  -- inside stock_approve_count_pin
  revoke all on function public.msm_stock_opening_costs(uuid) from public, anon, authenticated;
  grant execute on function public.msm_stock_opening_costs(uuid) to service_role;
  -- count approval: Back Office logins now go through the PIN; the service role (the Manager app,
  -- which asks for a manager PIN itself) keeps the direct call
  revoke all on function public.approve_stock_count(uuid, text, text, jsonb, boolean) from public, anon, authenticated;
  grant execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) to service_role;
end
$grants$;

comment on function public.msm_stock__sync_site(uuid, uuid, uuid, boolean, boolean) is
  'Multi site stock planner and writer (20261019c): one site, set based, only changed company columns, busy table last, version rows for Undo. Never writes on hand, cost, ledger, pars, counts, orders, invoices, waste, production.';
comment on procedure public.msm_stock_run_due(integer) is
  'Multi site stock runner (20261019c): pg_cron every minute, one site per transaction, 2 s lock wait (gives way to sales).';

notify pgrst, 'reload schema';

-- ============================================================================
-- 19. VISIBLE CHECK (the SQL editor shows this last result). Expected on Ops:
--   tables 20 | functions 71 | lock_triggers 15 | cron_job 1 | internals_open_to_api 0 |
--   approve_open_to_logins 0 | companies_on 0 | company_rows 0 | stock_sums (per venue: unchanged by this file)
-- ============================================================================
select
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in (
     'stock_company', 'msm_stock_members', 'msm_stock_items', 'msm_stock_item_sites', 'msm_stock_packs', 'msm_stock_pack_sites',
     'msm_stock_bridges', 'msm_stock_bridge_sites', 'msm_suppliers', 'msm_supplier_sites', 'msm_supplier_products',
     'msm_supplier_product_sites', 'msm_stock_drafts', 'msm_stock_changes', 'msm_stock_versions', 'msm_stock_version_sites',
     'msm_stock_version_rows', 'msm_stock_version_company', 'msm_stock_import_rows', 'stock_pin_tries')) as tables,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like 'msm\_stock\_%' or p.proname in ('stock_admin_status', 'stock_admin_set_enabled', 'stock_admin_set_member',
          'stock_my_access', 'stock_approve_count_pin', '_stock_company_site_joins'))
     and p.proname <> 'msm_stock_recipe_gaps') as functions,
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname like 'msm\_stock\_lock\_%') as lock_triggers,
  (select count(*) from cron.job j where j.jobname = 'msm-stock-run-due') as cron_job,
  (select count(*) from pg_proc p cross join unnest(array['anon', 'authenticated', 'service_role']) r(name)
    where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and (p.proname like 'msm\_stock\_\_%' or p.proname in ('_stock_company_site_joins', 'msm_stock_org_guard', 'msm_stock_base_unit_lock'))
      and p.proname not in ('msm_stock__writer_ok', 'msm_stock__editor_names')
      and has_function_privilege(r.name, p.oid, 'execute')) as internals_open_to_api,
  (select count(*) from unnest(array['anon', 'authenticated']) r(name)
    where has_function_privilege(r.name, 'public.approve_stock_count(uuid,text,text,jsonb,boolean)'::regprocedure, 'execute')) as approve_open_to_logins,
  (select count(*) from public.stock_company c where c.enabled) as companies_on,
  (select count(*) from public.msm_stock_items) as company_rows,
  (select coalesce(jsonb_agg(jsonb_build_object('venue', s.location_id, 'items', s.items, 'on_hand', s.on_hand, 'cost', s.cost,
                                                'movements', s.movements, 'qty', s.qty, 'value', s.value) order by s.location_id), '[]'::jsonb)
     from (select i.location_id, count(*) as items, sum(i.on_hand) as on_hand, sum(i.current_cost) as cost,
                  (select count(*) from public.stock_movements m where m.location_id = i.location_id) as movements,
                  (select sum(m.qty_base) from public.stock_movements m where m.location_id = i.location_id) as qty,
                  (select sum(m.value_delta) from public.stock_movements m where m.location_id = i.location_id) as value
             from public.inventory_items i group by i.location_id) s) as stock_sums;
