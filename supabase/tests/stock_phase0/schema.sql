-- schema.sql: the live shape of every table 20261019b reads or writes, for a throwaway local
-- Postgres 17. Column types are the live Ops columns read on 18 Oct 2026 (information_schema,
-- read only); constraints and foreign keys as pg_constraint showed them; row level security as
-- pg_policies showed it on the tables the new functions are called against. Roles as Supabase has
-- them: PostgREST logs in as authenticator and switches to anon, authenticated or service_role.
-- No data here: run.mjs seeds it. The 20261016 / 5 Aug function texts and the helpers come from
-- ../stock_function_fences/live/, the same copies the 20261018a proof uses.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end
$roles$;
grant anon, authenticated, service_role to authenticator;
alter role authenticated set statement_timeout = '8s';
alter role anon set statement_timeout = '3s';
alter role authenticator set lock_timeout = '8s';
-- Live (pg_roles, 19 Oct 2026): authenticator also carries statement_timeout = 8s, which binds the
-- service role too (an edge function's calls).
alter role authenticator set statement_timeout = '8s';

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase gives the API roles every table by default privileges; row level security does the fencing.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create table public.organisations (id uuid primary key default gen_random_uuid(), name text, created_at timestamptz default now());
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  name text not null,
  timezone text default 'Europe/London',
  created_at timestamptz default now()
);
create table public.user_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  location_id uuid not null,
  created_at timestamptz default now(),
  role text default 'manager' not null
);
create index idx_user_locations_user on public.user_locations (user_id);
create table public.user_profiles (
  id uuid primary key, org_id uuid, location_id uuid, full_name text, role text default 'owner',
  created_at timestamptz default now(), updated_at timestamptz default now(), email text, bo_access boolean default true
);
create table public.devices (
  id uuid primary key default gen_random_uuid(), location_id uuid, name text not null, type text default 'pos',
  status text default 'unpaired', last_seen timestamptz, created_at timestamptz default now(), device_uid uuid,
  app_version text, bound_via text
);
create index devices_device_uid_idx on public.devices (device_uid) where device_uid is not null;
create table public.ops_devices (
  id uuid primary key default gen_random_uuid(), location_id uuid, org_id uuid, device_uid uuid not null, name text,
  active boolean default true not null, created_at timestamptz default now() not null
);
create index ops_devices_uid_idx on public.ops_devices (device_uid);

create table public.stock_units (code text primary key, dimension text not null, to_canonical numeric(18,8) not null, label text);
insert into public.stock_units values
  ('dozen','COUNT',12,'dozen'),('each','COUNT',1,'each'),('cl','VOLUME',10,'centilitre'),('floz','VOLUME',28.4130625,'fl oz (UK)'),
  ('gal','VOLUME',4546.09,'gallon (UK)'),('l','VOLUME',1000,'litre'),('ml','VOLUME',1,'millilitre'),('pt','VOLUME',568.26125,'pint (UK)'),
  ('g','WEIGHT',1,'gram'),('kg','WEIGHT',1000,'kilogram'),('lb','WEIGHT',453.59237,'pound'),('mg','WEIGHT',0.001,'milligram'),
  ('oz','WEIGHT',28.34952313,'ounce');

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid, name text not null,
  kind text not null default 'PURCHASED' check (kind in ('PURCHASED','MADE')),
  base_unit text not null references public.stock_units(code), accounting_group text, category text,
  is_tracked boolean not null default true, is_sellable boolean not null default false,
  current_cost numeric(12,5), cost_method text not null default 'MOVING_AVG' check (cost_method in ('MOVING_AVG','LAST_COST')),
  on_hand numeric(14,4) not null default 0, allergens jsonb not null default '[]', shelf_life_days integer,
  storage_location text, default_supplier_id uuid, sku text, barcode text, notes text, archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), purchase_tax_rate_id uuid
);
create index inventory_items_loc_idx on public.inventory_items (location_id);
create table public.inventory_item_conversions (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  from_qty numeric(14,4) not null, from_unit text not null, to_qty numeric(14,4) not null, to_unit text not null,
  created_at timestamptz not null default now()
);
create index inv_item_conv_item_idx on public.inventory_item_conversions (inventory_item_id);
create table public.item_packaging_formats (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade, name text not null,
  qty_in_base numeric(14,4) not null, parent_format_id uuid references public.item_packaging_formats(id) on delete set null,
  created_at timestamptz not null default now(), is_count_default boolean not null default false, is_purchase_default boolean not null default false
);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid, name text not null, contact_name text,
  email text, phone text, account_number text, payment_terms_days integer, min_order_value numeric(12,2),
  delivery_days jsonb not null default '[]', cutoff_time text, notes text, archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.supplier_products (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade, supplier_sku text, pack_description text,
  pack_qty numeric(14,4) not null default 1, inner_qty numeric(14,4) not null default 1, inner_unit text not null,
  pack_price numeric(12,4) not null, is_preferred boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  purchase_tax_rate_id uuid, price_includes_tax boolean not null default false
);
create table public.item_cost_history (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  supplier_product_id uuid references public.supplier_products(id) on delete set null, pack_price numeric(12,4),
  base_unit_cost numeric(12,5) not null, moving_avg_cost numeric(12,5), effective_from timestamptz not null default now(),
  effective_to timestamptz, source text not null default 'MANUAL'
    constraint item_cost_history_source_chk check (source in ('INVOICE','MANUAL','CONTRACT','CATALOG','RECIPE_ROLLUP','PO_RECEIPT','TRANSFER')),
  source_doc_id uuid, created_by uuid, created_at timestamptz not null default now()
);
create index item_cost_hist_current_idx on public.item_cost_history (inventory_item_id) where effective_to is null;
create index item_cost_hist_item_idx on public.item_cost_history (inventory_item_id, effective_from desc);

create table public.storage_areas (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text not null, kind text not null default 'other',
  sort_order integer not null default 0, is_receiving boolean not null default false, archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.inventory_item_areas (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id uuid not null references public.storage_areas(id) on delete restrict,
  is_primary boolean not null default true, created_at timestamptz not null default now(),
  constraint inventory_item_areas_item_area_uniq unique (inventory_item_id, area_id)
);
create unique index inventory_item_areas_primary_uniq on public.inventory_item_areas (inventory_item_id) where is_primary;
create table public.inventory_item_area_stock (
  location_id uuid not null, inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id uuid not null references public.storage_areas(id) on delete cascade, on_hand numeric(16,4) not null default 0,
  updated_at timestamptz not null default now(), primary key (inventory_item_id, area_id)
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  qty_base numeric(16,4) not null, unit_cost numeric(12,5), value_delta numeric(16,4),
  movement_type text not null constraint stock_movements_movement_type_check check (movement_type in
    ('OPENING_BALANCE','PURCHASE_RECEIPT','SALE_DEPLETION','WASTE','STOCK_COUNT_ADJ','PRODUCTION_CONSUME','PRODUCTION_OUTPUT','TRANSFER_IN','TRANSFER_OUT','RETURN','MANUAL_ADJ')),
  source_type text, source_id text, occurred_at timestamptz not null default now(), posted_at timestamptz not null default now(),
  created_by uuid, idempotency_key text, reversal_of uuid references public.stock_movements(id) on delete set null, notes text,
  area_id uuid references public.storage_areas(id) on delete set null
);
create unique index stock_mv_idem_uniq on public.stock_movements (location_id, idempotency_key) where idempotency_key is not null;
create index stock_mv_item_area_idx on public.stock_movements (location_id, inventory_item_id, area_id);
create index stock_mv_item_idx on public.stock_movements (location_id, inventory_item_id, occurred_at desc);
create index stock_mv_loc_time_idx on public.stock_movements (location_id, occurred_at desc);

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text,
  count_type text not null default 'FULL' constraint stock_counts_count_type_chk check (count_type in ('FULL','PARTIAL','SPOT','AREA','SUPPLIER')),
  status text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','CANCELLED')), storage_area text,
  started_by uuid, started_at timestamptz not null default now(), submitted_at timestamptz, approved_by uuid, approved_at timestamptz,
  variance_value numeric(14,2), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  supplier_id uuid, approval_note text, started_by_name text, approved_by_name text
);
create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  counted_qty numeric(14,4), expected_qty numeric(14,4), variance_qty numeric(14,4), unit_cost numeric(12,5),
  sort_order integer not null default 0, created_at timestamptz not null default now(),
  area_id uuid references public.storage_areas(id) on delete set null
);
create index stock_count_lines_count_idx on public.stock_count_lines (count_id);
create table public.stock_count_areas (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, count_id uuid not null references public.stock_counts(id) on delete cascade,
  area_id uuid not null references public.storage_areas(id) on delete cascade, status text not null default 'open',
  completed_by_name text, completed_at timestamptz, created_at timestamptz not null default now()
);

create table public.waste_events (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid references public.inventory_items(id) on delete set null, item_name text,
  qty numeric(14,4) not null, unit text not null default 'each', qty_base numeric(14,4), reason text, note text,
  cost_value numeric(14,2), source text not null default 'backoffice', logged_by uuid,
  occurred_at timestamptz not null default now(), created_at timestamptz not null default now(), sale_value numeric(14,2)
);

create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, to_location_id uuid,
  from_area_id uuid references public.storage_areas(id) on delete set null, to_area_id uuid references public.storage_areas(id) on delete set null,
  status text not null default 'DRAFT' constraint stock_transfers_status_chk check (status in ('DRAFT','SENT','RECEIVED','CANCELLED','DONE')),
  reference text, note text, created_by_name text, sent_by_name text, sent_at timestamptz, received_by_name text, received_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), cancelled_by_name text, cancelled_at timestamptz
);
create table public.stock_transfer_lines (
  id uuid primary key default gen_random_uuid(), transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  location_id uuid not null, to_location_id uuid,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  to_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  name_snapshot text, sku_snapshot text, base_unit text, qty_base numeric(16,4) not null, unit_cost numeric(12,5),
  qty_received_base numeric(16,4), dropped boolean not null default false, sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  supplier_id uuid references public.suppliers(id) on delete set null, reference text,
  status text not null default 'DRAFT' check (status in ('DRAFT','SENT','PARTIAL','RECEIVED','CANCELLED')),
  expected_date date, ordered_at timestamptz, received_at timestamptz, subtotal numeric(14,2), notes text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), tax numeric(14,2)
);
create table public.po_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  supplier_product_id uuid references public.supplier_products(id) on delete set null, description text,
  qty_packs numeric(14,4) not null default 1, pack_qty numeric(14,4) not null default 1, inner_qty numeric(14,4) not null default 1,
  inner_unit text not null default 'each', unit_price numeric(12,4) not null default 0, qty_received numeric(14,4) not null default 0,
  sort_order integer not null default 0, created_at timestamptz not null default now(), purchase_tax_rate_id uuid, line_tax numeric(14,2)
);
create table public.supplier_invoices (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  supplier_id uuid references public.suppliers(id) on delete set null, po_id uuid references public.purchase_orders(id) on delete set null,
  invoice_number text, invoice_date date,
  status text not null default 'REVIEW' check (status in ('REVIEW','POSTED','VOID')), ocr_confidence numeric(5,2),
  subtotal numeric(14,2), tax numeric(14,2), total numeric(14,2), raw_json jsonb, posted_at timestamptz, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), image_path text
);
create table public.supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  invoice_id uuid not null references public.supplier_invoices(id) on delete cascade,
  matched_item_id uuid references public.inventory_items(id) on delete set null, description text,
  qty numeric(14,4) not null default 0, unit text not null default 'each', unit_price numeric(12,4) not null default 0,
  line_total numeric(14,2), flags jsonb not null default '[]', sort_order integer not null default 0,
  created_at timestamptz not null default now(), purchase_tax_rate_id uuid, line_tax numeric(14,2)
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text not null,
  recipe_type text not null default 'MENU' check (recipe_type in ('MENU','PREP','BATCH')),
  output_item_id uuid references public.inventory_items(id) on delete set null, yield_qty numeric(14,4) not null default 1,
  yield_unit text not null default 'each', wastage_pct numeric(6,3) not null default 0, gp_target_pct numeric(6,3), method text,
  photo text, status text not null default 'active', archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.recipe_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  component_item_id uuid not null references public.inventory_items(id) on delete restrict,
  qty numeric(14,4) not null, unit text not null, usable_pct numeric(6,3) not null default 100, sort_order integer not null default 0,
  note text, created_at timestamptz not null default now(), order_types jsonb
);
create table public.menu_item_recipes (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, menu_item_id text not null,
  recipe_id uuid not null references public.recipes(id) on delete cascade, portion numeric(10,4) not null default 1,
  created_at timestamptz not null default now(), unique (location_id, menu_item_id)
);
create table public.production_batches (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, recipe_id uuid, output_item_id uuid,
  output_name text, planned_qty numeric(14,4), actual_qty numeric(14,4), output_unit text not null default 'each',
  status text not null default 'DRAFT', theoretical_cost numeric(14,4), actual_cost numeric(14,4), output_unit_cost numeric(12,5),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Multi site menu: the tables and the access rule the recipe warning reads (20261017 columns used).
create table public.msm_company (org_id uuid primary key references public.organisations(id) on delete cascade,
  enabled boolean not null default false, enabled_by uuid, enabled_at timestamptz, updated_at timestamptz not null default now());
create table public.msm_members (org_id uuid not null references public.organisations(id) on delete cascade, user_id uuid not null,
  role text not null check (role in ('editor','viewer')), added_by uuid, added_at timestamptz not null default now(), primary key (org_id, user_id));
create table public.msm_menus (id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organisations(id) on delete cascade,
  name text not null, status text not null default 'live');
create table public.msm_products (id uuid primary key, menu_id uuid not null references public.msm_menus(id) on delete cascade,
  name text not null, archived boolean not null default false, default_price numeric(10,2) not null default 0);
create table public.msm_product_sites (product_id uuid not null references public.msm_products(id) on delete cascade,
  location_id text not null, venue_item_id text not null, active boolean not null default true, price numeric(10,2),
  primary key (product_id, location_id), constraint msm_product_sites_one_venue_row unique (location_id, venue_item_id));

-- The restrictive second sign in step policy (20260919s) is on every stock table live; here it always passes.
create or replace function public.second_step_ok() returns boolean language sql stable as $$ select true $$;
grant execute on function public.second_step_ok() to anon, authenticated, service_role;
