-- ═══════════════════════════════════════════════════════════════════════════
-- Restaurant OS — Supabase Schema
-- Run this in Supabase → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════════════════════

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── Menus ──────────────────────────────────────────────────────────────────
create table if not exists menus (
  id text primary key,
  location_id text not null default 'loc-demo',
  name text not null,
  description text default '',
  is_default boolean default false,
  is_active boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Menu Categories ────────────────────────────────────────────────────────
create table if not exists menu_categories (
  id text primary key,
  location_id text not null default 'loc-demo',
  menu_id text references menus(id) on delete set null,
  parent_id text references menu_categories(id) on delete cascade,
  label text not null,
  icon text default '🍽',
  color text default '#3b82f6',
  accounting_group text default '',
  sort_order integer default 0,
  is_special boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Menu Items ─────────────────────────────────────────────────────────────
create table if not exists menu_items (
  id text primary key,
  location_id text not null default 'loc-demo',
  name text not null,
  menu_name text,
  receipt_name text,
  kitchen_name text,
  description text default '',
  type text default 'simple',
  cat text,
  cats text[] default '{}',
  parent_id text,
  sort_order integer default 0,
  pricing jsonb default '{"base": 0}',
  allergens text[] default '{}',
  assigned_modifier_groups jsonb default '[]',
  assigned_instruction_groups text[] default '{}',
  visibility jsonb default '{"pos": true, "kiosk": true, "online": true}',
  sold_alone boolean default false,
  archived boolean default false,
  centre_id text,
  tax_rate_id uuid,
  tax_overrides jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Config Snapshots (Push to POS) ────────────────────────────────────────
create table if not exists config_pushes (
  id uuid default uuid_generate_v4() primary key,
  location_id text not null default 'loc-demo',
  pushed_by text,
  snapshot jsonb not null,
  change_count integer default 0,
  created_at timestamptz default now()
);

-- ── Closed Checks (Order History) ─────────────────────────────────────────
create table if not exists closed_checks (
  id text primary key,
  location_id text not null default 'loc-demo',
  table_id text,
  table_label text,
  staff_name text,
  items jsonb default '[]',
  subtotal numeric(10,2) default 0,
  tax numeric(10,2) default 0,
  total numeric(10,2) default 0,
  payment_method text,
  covers integer default 0,
  closed_at timestamptz default now(),
  voided boolean default false,
  refunded boolean default false,
  gift_card jsonb default null          -- v5.5.217: gift card payment data for auto-reversal on refund
);

-- ── KDS Tickets ────────────────────────────────────────────────────────────
create table if not exists kds_tickets (
  id text primary key,
  location_id text not null default 'loc-demo',
  table_id text,
  table_label text,
  items jsonb default '[]',
  course text default 'main',
  status text default 'pending',
  sent_at timestamptz default now(),
  bumped_at timestamptz
);

-- ── 86 List ────────────────────────────────────────────────────────────────
create table if not exists eighty_six (
  id uuid default uuid_generate_v4() primary key,
  location_id text not null default 'loc-demo',
  item_id text not null,
  created_at timestamptz default now(),
  unique(location_id, item_id)
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_menus_location on menus(location_id);
create index if not exists idx_menu_categories_location on menu_categories(location_id);
create index if not exists idx_menu_categories_menu on menu_categories(menu_id);
create index if not exists idx_menu_items_location on menu_items(location_id);
create index if not exists idx_menu_items_cat on menu_items(cat);
create index if not exists idx_config_pushes_location on config_pushes(location_id, created_at desc);
create index if not exists idx_closed_checks_location on closed_checks(location_id, closed_at desc);
create index if not exists idx_kds_tickets_location on kds_tickets(location_id, status);

-- ── Row Level Security ─────────────────────────────────────────────────────
-- For now use permissive policies (tighten when you add auth)
alter table menus enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table config_pushes enable row level security;
alter table closed_checks enable row level security;
alter table kds_tickets enable row level security;
alter table eighty_six enable row level security;

-- Allow all operations from anon key (tighten later with location-based RLS)
create policy "allow all" on menus for all using (true) with check (true);
create policy "allow all" on menu_categories for all using (true) with check (true);
create policy "allow all" on menu_items for all using (true) with check (true);
create policy "allow all" on config_pushes for all using (true) with check (true);
create policy "allow all" on closed_checks for all using (true) with check (true);
create policy "allow all" on kds_tickets for all using (true) with check (true);
create policy "allow all" on eighty_six for all using (true) with check (true);

-- ── Realtime ───────────────────────────────────────────────────────────────
-- Enable realtime for live sync across terminals
alter publication supabase_realtime add table kds_tickets;
alter publication supabase_realtime add table eighty_six;
alter publication supabase_realtime add table config_pushes;

