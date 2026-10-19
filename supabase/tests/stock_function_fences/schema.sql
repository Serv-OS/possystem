-- schema.sql: the live shape the stock functions read and write, for a throwaway local Postgres.
-- Column types from 000_baseline_ops.sql, 20260919a1 (devices.bound_via) and 20261016 (areas,
-- transfers). Roles as Supabase has them: PostgREST logs in as authenticator and switches to
-- anon, authenticated or service_role for each request. No data here: run.mjs seeds it.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end
$roles$;
grant anon, authenticated, service_role to authenticator;
-- The live per role timeouts (PostgREST applies them in each request; run.mjs sets them the same way).
alter role authenticated set statement_timeout = '8s';
alter role anon set statement_timeout = '3s';

create schema if not exists auth;
-- Supabase's auth.uid(): the sub claim of the request.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  name text not null,
  created_at timestamptz default now()
);
create table public.user_locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  location_id uuid not null,
  created_at timestamptz default now(),
  role text default 'manager' not null
);
create index idx_user_locations_location on public.user_locations (location_id);
create index idx_user_locations_user on public.user_locations (user_id);
create table public.user_profiles (
  id uuid primary key,
  org_id uuid,
  location_id uuid,
  full_name text,
  role text default 'owner',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  email text,
  bo_access boolean default true
);
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  location_id uuid,
  name text not null,
  type text default 'pos',
  status text default 'unpaired',
  last_seen timestamptz,
  created_at timestamptz default now(),
  device_uid uuid,
  app_version text,
  bound_via text
);
create index devices_device_uid_idx on public.devices (device_uid) where device_uid is not null;
create table public.ops_devices (
  id uuid primary key default gen_random_uuid(),
  location_id uuid,
  org_id uuid,
  device_uid uuid not null,
  name text,
  active boolean default true not null,
  created_at timestamptz default now() not null
);
create index ops_devices_uid_idx on public.ops_devices (device_uid);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id uuid,
  name text not null,
  kind text default 'PURCHASED' not null,
  base_unit text not null default 'each',
  current_cost numeric(12,5),
  cost_method text default 'MOVING_AVG' not null,
  on_hand numeric(14,4) default 0 not null,
  sku text,
  archived_at timestamptz,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
create index inventory_items_loc_idx on public.inventory_items (location_id);
create table public.item_cost_history (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  inventory_item_id uuid not null,
  base_unit_cost numeric(12,5) not null,
  effective_from timestamptz default now() not null,
  effective_to timestamptz,
  source text default 'MANUAL' not null
    constraint item_cost_history_source_chk check (source in ('INVOICE','MANUAL','CONTRACT','CATALOG','RECIPE_ROLLUP','PO_RECEIPT','TRANSFER')),
  created_at timestamptz default now() not null
);
create table public.storage_areas (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  name text not null,
  kind text not null default 'other',
  sort_order integer not null default 0,
  is_receiving boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.inventory_item_areas (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id uuid not null references public.storage_areas(id) on delete restrict,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  constraint inventory_item_areas_item_area_uniq unique (inventory_item_id, area_id)
);
create unique index inventory_item_areas_primary_uniq on public.inventory_item_areas (inventory_item_id) where is_primary;
create table public.inventory_item_area_stock (
  location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id uuid not null references public.storage_areas(id) on delete cascade,
  on_hand numeric(16,4) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (inventory_item_id, area_id)
);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  qty_base numeric(16,4) not null,
  unit_cost numeric(12,5),
  value_delta numeric(16,4),
  movement_type text not null
    constraint stock_movements_movement_type_check check (movement_type in ('OPENING_BALANCE','PURCHASE_RECEIPT','SALE_DEPLETION','WASTE','STOCK_COUNT_ADJ','PRODUCTION_CONSUME','PRODUCTION_OUTPUT','TRANSFER_IN','TRANSFER_OUT','RETURN','MANUAL_ADJ')),
  source_type text,
  source_id text,
  occurred_at timestamptz default now() not null,
  posted_at timestamptz default now() not null,
  created_by uuid,
  idempotency_key text,
  reversal_of uuid,
  notes text,
  area_id uuid
);
create unique index stock_mv_idem_uniq on public.stock_movements (location_id, idempotency_key) where idempotency_key is not null;
create index stock_mv_item_idx on public.stock_movements (location_id, inventory_item_id, occurred_at desc);
create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  to_location_id uuid,
  from_area_id uuid references public.storage_areas(id) on delete set null,
  to_area_id uuid references public.storage_areas(id) on delete set null,
  status text not null default 'DRAFT' check (status in ('DRAFT','SENT','RECEIVED','CANCELLED','DONE')),
  reference text,
  note text,
  created_by_name text,
  sent_by_name text,
  sent_at timestamptz,
  received_by_name text,
  received_at timestamptz,
  cancelled_by_name text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  location_id uuid not null,
  to_location_id uuid,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  to_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  name_snapshot text,
  qty_base numeric(16,4) not null,
  unit_cost numeric(12,5),
  qty_received_base numeric(16,4),
  dropped boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- The live grants of the helpers (20260805c, 20260921u, 20260927a).
