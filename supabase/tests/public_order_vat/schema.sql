-- schema.sql: a throwaway local shape of the Ops tables and helpers 20261009a touches.
-- Local PostgreSQL 17 only (run.mjs). Never run against Supabase.
-- Columns follow the live Ops database (information_schema, read only, 8 Oct 2026); only the
-- columns the functions under test read or write are typed exactly, the rest is omitted.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema if not exists auth;
-- auth.uid() as PostgREST provides it: the caller set by the test (a session var), null otherwise.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table public.locations (
  id uuid primary key,
  name text,
  status text default 'active',
  default_tax_profile_id uuid
);

create table public.tax_rates (
  id uuid primary key,
  location_id uuid,
  name text,
  code text,
  rate numeric,
  type text,
  applies_to text[],
  is_default boolean,
  active boolean,
  created_at timestamptz default now()
);

create table public.tax_profiles (
  id uuid primary key default gen_random_uuid(),
  location_id uuid,
  name text
);

create table public.menu_categories (
  id text primary key,
  location_id text,
  tax_profile_id uuid
);

create table public.menu_items (
  id text primary key,
  location_id text not null default 'loc-demo',
  name text,
  menu_name text,
  type text default 'simple',
  parent_id text,
  pricing jsonb default '{"base": 0}'::jsonb,
  archived boolean default false,
  sold_alone boolean default false,
  tax_rate_id uuid,
  tax_overrides jsonb default '{}'::jsonb,
  tax_profile_id uuid
);

create table public.closed_checks (
  id text primary key,
  location_id text,
  table_id text,
  table_label text,
  staff_name text,
  items jsonb,
  subtotal numeric,
  tax numeric,
  total numeric,
  payment_method text,
  covers integer,
  closed_at timestamptz,
  voided boolean,
  refunded boolean,
  ref text,
  server text,
  order_type text,
  customer jsonb,
  discounts jsonb,
  service numeric,
  tip numeric,
  method text,
  status text,
  refunds jsonb,
  tax_breakdown jsonb,
  tax_amount numeric(10,2),
  staff_id uuid,
  drawer_id text,
  shift_id text,
  customer_id uuid,
  source text,
  kiosk_id uuid,
  customer_phone text,
  kiosk_table_number text,
  gift_card jsonb,
  loyalty jsonb,
  stripe_payment_intent_id text,
  payment_intents jsonb,
  processor text,
  seated_at timestamptz,
  promo jsonb,
  tenders jsonb
);

create table public.order_queue (
  id bigserial primary key,
  ref text,
  location_id text,
  type text,
  customer jsonb default '{}'::jsonb,
  items jsonb default '[]'::jsonb,
  total numeric,
  status text,
  staff text,
  sent_at timestamptz,
  collection_time text,
  is_asap boolean,
  source text,
  paid boolean,
  payment_method text,
  event_date date,
  created_at timestamptz default now()
);

create table public.payment_proofs (
  id uuid primary key default gen_random_uuid(),
  location_id text,
  kind text,
  payment_ref text,
  amount_minor bigint,
  used_by_ref text,
  used_at timestamptz,
  meta jsonb default '{}'::jsonb,
  verified_at timestamptz default now()
);

-- Stubs of the helpers settle_qr_tab calls that are not under test here.
create or replace function public._qr_tab_is_member(p_loc text, p_pi text, p_uid uuid) returns boolean language sql stable as $$ select true $$;
create or replace function public.pos_can_access(p_loc text) returns boolean language sql stable as $$ select false $$;
create or replace function public.is_super_admin() returns boolean language sql stable as $$ select false $$;
-- The valuer, reduced to what settle_qr_tab reads from it: the goods at the prices the rounds carry.
create or replace function public._public_order_value(p_loc text, p_source text, p_type text, p_items jsonb, p_menu_id text default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(p_items, '[]'::jsonb), 'lines', '[]'::jsonb,
           'goods_minor', coalesce((select sum(round((public._fence_num(x ->> 'price')
                                        + coalesce((select sum(public._fence_num(m ->> 'price')) from jsonb_array_elements(case when jsonb_typeof(x -> 'mods') = 'array' then x -> 'mods' else '[]'::jsonb end) m), 0))
                                        * (case when public._fence_num(x ->> 'qty') >= 1 then public._fence_num(x ->> 'qty') else 1 end) * 100))
                                     from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) x
                                    where jsonb_typeof(x) = 'object'), 0)::bigint,
           'unknown_lines', 0, 'max_unit_minor', 0)
$$;
