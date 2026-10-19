-- extra_schema.sql: the live tables 20261018c reads beyond the stock fences harness schema, with
-- the live column types (Ops information_schema, read 18 Oct 2026), trimmed to the columns used.
-- Plus: the schema's default ACL as production has it (every new function is granted EXECUTE to
-- anon, authenticated and service_role: the trap the migration must undo by name), a pg_cron stand
-- in with the live signatures, and is_demo on locations (20261013a).

-- Production's default privileges for functions made by postgres in public.
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

alter table public.locations add column if not exists is_demo boolean not null default false;

-- pg_cron stand in (same signatures as live).
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$
  delete from cron.job where jobid = job_id returning true $$;

create table public.closed_checks (
  id text primary key,
  location_id text default 'loc-demo',
  table_id text, table_label text, staff_name text,
  items jsonb default '[]'::jsonb,
  subtotal numeric default 0, tax numeric default 0, total numeric default 0,
  payment_method text, covers integer default 0,
  closed_at timestamptz default now(),
  voided boolean default false, refunded boolean default false,
  ref text, server text, order_type text, customer jsonb,
  discounts jsonb default '[]'::jsonb, service numeric default 0, tip numeric default 0, method text,
  status text default 'paid', refunds jsonb default '[]'::jsonb,
  tax_breakdown jsonb default '[]'::jsonb, tax_amount numeric,
  staff_id uuid, customer_id uuid, source text default 'pos', loyalty jsonb, tenders jsonb, promo jsonb, gift_card jsonb
);
create index idx_closed_checks_location_closed_at on public.closed_checks (location_id, closed_at desc);
alter table public.closed_checks enable row level security;
-- the live policies: anyone signed in may insert for any venue; reads and updates are fenced
create policy "insert closed checks" on public.closed_checks for insert with check (true);
create policy closed_checks_read on public.closed_checks for select using (location_id in (select public.accessible_location_ids()));
create policy closed_checks_update on public.closed_checks for update using (location_id in (select public.accessible_location_ids()))
  with check (location_id in (select public.accessible_location_ids()));
grant select, insert, update, delete on public.closed_checks to anon, authenticated, service_role;

create table public.stock_units (code text primary key, dimension text not null, to_canonical numeric(18,8) not null, label text);
insert into public.stock_units values
 ('cl','VOLUME',10,'centilitre'),('dozen','COUNT',12,'dozen'),('each','COUNT',1,'each'),('floz','VOLUME',28.4130625,'fl oz (UK)'),
 ('g','WEIGHT',1,'gram'),('gal','VOLUME',4546.09,'gallon (UK)'),('kg','WEIGHT',1000,'kilogram'),('l','VOLUME',1000,'litre'),
 ('lb','WEIGHT',453.59237,'pound'),('mg','WEIGHT',0.001,'milligram'),('ml','VOLUME',1,'millilitre'),('oz','WEIGHT',28.34952313,'ounce'),
 ('pt','VOLUME',568.26125,'pint (UK)');

create table public.inventory_item_conversions (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, inventory_item_id uuid not null,
  from_qty numeric, from_unit text, to_qty numeric, to_unit text, created_at timestamptz default now());
create index inv_item_conv_item_idx on public.inventory_item_conversions (inventory_item_id);
create table public.item_packaging_formats (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, inventory_item_id uuid not null,
  name text, qty_in_base numeric, parent_format_id uuid, created_at timestamptz default now(),
  is_count_default boolean default false, is_purchase_default boolean default false);
create index item_pack_fmt_item_idx on public.item_packaging_formats (inventory_item_id);
create table public.recipes (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text,
  recipe_type text default 'MENU', output_item_id uuid, yield_qty numeric default 1, yield_unit text, wastage_pct numeric default 0,
  gp_target_pct numeric, status text, archived_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.recipe_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, recipe_id uuid not null,
  component_item_id uuid, qty numeric, unit text, usable_pct numeric default 100, sort_order integer default 0,
  note text, order_types jsonb, created_at timestamptz default now());
create index recipe_lines_recipe_idx on public.recipe_lines (recipe_id);
create table public.menu_item_recipes (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, menu_item_id text not null,
  recipe_id uuid not null, portion numeric default 1, created_at timestamptz default now(),
  unique (location_id, menu_item_id));
create table public.stock_counts (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text, count_type text, status text,
  storage_area text, approved_by uuid, approved_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create index stock_counts_loc_idx on public.stock_counts (location_id, created_at desc);
create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, count_id uuid not null,
  inventory_item_id uuid not null, counted_qty numeric, expected_qty numeric, variance_qty numeric, unit_cost numeric, area_id uuid);
create index stock_count_lines_count_idx on public.stock_count_lines (count_id);
create table public.waste_events (
  id uuid primary key default gen_random_uuid(), location_id uuid, inventory_item_id uuid, item_name text,
  qty numeric, unit text default 'each', qty_base numeric, reason text, note text, cost_value numeric,
  source text default 'backoffice', logged_by uuid, occurred_at timestamptz default now(), created_at timestamptz default now(),
  sale_value numeric);
create table public.payment_proofs (
  id uuid primary key default gen_random_uuid(), processor text, payment_ref text, kind text, location_id text,
  amount_minor bigint, currency text, verified_at timestamptz, verified_by text, used_by_ref text, used_at timestamptz, meta jsonb);
alter table public.payment_proofs enable row level security;
create table public.public_order_tokens (
  location_id text not null, ref text not null, token text, placed_by uuid, paid boolean default false,
  created_at timestamptz default now(), primary key (location_id, ref));
alter table public.public_order_tokens enable row level security;

-- the realtime publication as live: closed_checks is in it, the stock tables are not
create publication supabase_realtime for table public.closed_checks;
