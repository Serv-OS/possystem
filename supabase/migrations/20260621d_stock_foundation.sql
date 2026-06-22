-- v5.5.562 — Stock & Production Management: slice 1 (domain + costing core)
--
-- Greenfield stock system. Stock ITEMS are modelled separately from menu_items
-- (POS sellables) and linked later by recipes. This migration adds ONLY the
-- costing-core tables (item types, units, packaging, supplier pack→unit cost,
-- effective-dated cost history). The append-only movements ledger, recipes,
-- counts, waste, production, purchasing and reporting land in later slices.
--
-- Conventions followed: location_id on every tenant table; snake_case columns;
-- numeric money (never float); real RLS via user_accessible_locations(); additive
-- and reversible (no destructive change to existing POS/menu/stock tables).
-- The existing stock_levels / eighty_six daily-count system is left untouched and
-- will become a derived cache of the movements ledger in slice 2.

-- ─────────────────────────────────────────────────────────────────────────────
-- Global units of measure (shared reference; mirror of src/lib/stock/units.js)
-- Cross-dimension conversions are NOT here — they are per item (see below).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists stock_units (
  code               text primary key,           -- 'g','kg','ml','l','each',…
  dimension          text not null check (dimension in ('COUNT','WEIGHT','VOLUME')),
  to_canonical       numeric(20,8) not null,      -- canonical units per 1 of this unit
  label              text not null
);

insert into stock_units (code, dimension, to_canonical, label) values
  ('each',  'COUNT',  1,            'each'),
  ('dozen', 'COUNT',  12,           'dozen'),
  ('mg',    'WEIGHT', 0.001,        'milligram'),
  ('g',     'WEIGHT', 1,            'gram'),
  ('kg',    'WEIGHT', 1000,         'kilogram'),
  ('oz',    'WEIGHT', 28.349523125, 'ounce'),
  ('lb',    'WEIGHT', 453.59237,    'pound'),
  ('ml',    'VOLUME', 1,            'millilitre'),
  ('cl',    'VOLUME', 10,           'centilitre'),
  ('l',     'VOLUME', 1000,         'litre'),
  ('floz',  'VOLUME', 28.4130625,   'fl oz (UK)'),
  ('pt',    'VOLUME', 568.26125,    'pint (UK)'),
  ('gal',   'VOLUME', 4546.09,      'gallon (UK)')
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Inventory items — the thing you hold / buy / make (distinct from menu_items)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists inventory_items (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  org_id             uuid,
  name               text not null,
  kind               text not null default 'PURCHASED' check (kind in ('PURCHASED','MADE')),
  base_unit          text not null references stock_units(code),  -- costing/stocking atom
  accounting_group   text,
  category           text,
  is_tracked         boolean not null default true,   -- count it / deplete it?
  is_sellable        boolean not null default false,
  current_cost       numeric(12,5),                   -- £ per base unit (PURCHASED: invoice/avg; MADE: roll-up)
  cost_method        text not null default 'MOVING_AVG' check (cost_method in ('MOVING_AVG','LAST_COST')),
  on_hand            numeric(14,4) not null default 0, -- cache; authoritative value = ledger sum (slice 2)
  allergens          jsonb not null default '[]'::jsonb,
  shelf_life_days    integer,
  storage_location   text,
  default_supplier_id uuid,
  sku                text,
  barcode            text,
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists inventory_items_loc_idx     on inventory_items(location_id);
create index if not exists inventory_items_loc_kind_idx on inventory_items(location_id, kind) where archived_at is null;

-- Item-specific CROSS-dimension conversion bridges (volume↔weight↔count / density).
-- e.g. "1 each onion = 110 g", "1 l oil = 920 g".
create table if not exists inventory_item_conversions (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  inventory_item_id  uuid not null references inventory_items(id) on delete cascade,
  from_qty           numeric(14,4) not null,
  from_unit          text not null,
  to_qty             numeric(14,4) not null,
  to_unit            text not null,
  created_at         timestamptz not null default now()
);
create index if not exists inv_item_conv_item_idx on inventory_item_conversions(inventory_item_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Suppliers + per-supplier purchase products (the pack→base-unit cost source)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists suppliers (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  org_id             uuid,
  name               text not null,
  contact_name       text,
  email              text,
  phone              text,
  account_number     text,
  payment_terms_days integer,
  min_order_value    numeric(12,2),
  delivery_days      jsonb not null default '[]'::jsonb,   -- ['mon','wed','fri']
  cutoff_time        text,                                  -- 'HH:MM' local
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists suppliers_loc_idx on suppliers(location_id);

-- A purchasing product = how a supplier sells an item, in PACKS, at a pack price.
-- base_unit_cost is DERIVED (pack_price ÷ base content) — see costing.js — never
-- the sole source of truth, so a pack-size change recomputes correctly.
create table if not exists supplier_products (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  inventory_item_id  uuid not null references inventory_items(id) on delete cascade,
  supplier_id        uuid not null references suppliers(id) on delete cascade,
  supplier_sku       text,
  pack_description    text,                       -- 'case of 6 × 2.5 kg'
  pack_qty           numeric(14,4) not null default 1,   -- packs of inner (6)
  inner_qty          numeric(14,4) not null default 1,   -- inner content (2.5)
  inner_unit         text not null,                      -- inner content unit (kg)
  pack_price         numeric(12,4) not null,             -- £ paid for the pack
  is_preferred       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists supplier_products_item_idx on supplier_products(inventory_item_id);
create index if not exists supplier_products_sup_idx  on supplier_products(supplier_id);

-- Pack-of-packs (1 box = 4 sleeves = 24 units): resolved qty_in_base, optionally
-- nested via parent_format_id.
create table if not exists item_packaging_formats (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  inventory_item_id  uuid not null references inventory_items(id) on delete cascade,
  name               text not null,              -- 'Box','Sleeve','Unit'
  qty_in_base        numeric(14,4) not null,     -- how many base units this format holds
  parent_format_id   uuid references item_packaging_formats(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists item_pack_fmt_item_idx on item_packaging_formats(inventory_item_id);

-- Effective-dated cost history — append a row on every price change; close the
-- prior row's effective_to. Valuation reads the row effective at the movement date,
-- so historical reports stay accurate after a price change.
create table if not exists item_cost_history (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null,
  inventory_item_id   uuid not null references inventory_items(id) on delete cascade,
  supplier_product_id uuid references supplier_products(id) on delete set null,
  pack_price          numeric(12,4),
  base_unit_cost      numeric(12,5) not null,    -- derived snapshot at this effective date
  moving_avg_cost     numeric(12,5),
  effective_from      timestamptz not null default now(),
  effective_to        timestamptz,               -- null = current
  source              text not null default 'MANUAL'
                        check (source in ('INVOICE','MANUAL','CONTRACT','CATALOG','RECIPE_ROLLUP')),
  source_doc_id       uuid,
  created_by          uuid,
  created_at          timestamptz not null default now()
);
create index if not exists item_cost_hist_item_idx on item_cost_history(inventory_item_id, effective_from desc);
create index if not exists item_cost_hist_current_idx on item_cost_history(inventory_item_id) where effective_to is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — global units readable by all; tenant tables fenced to accessible
-- locations. Writes from the app go through authenticated BO users; edge functions
-- use the service role (which bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────────────
alter table stock_units                 enable row level security;
alter table inventory_items             enable row level security;
alter table inventory_item_conversions  enable row level security;
alter table suppliers                   enable row level security;
alter table supplier_products           enable row level security;
alter table item_packaging_formats      enable row level security;
alter table item_cost_history           enable row level security;

drop policy if exists stock_units_read on stock_units;
create policy stock_units_read on stock_units for select using (true);

do $$
declare t text;
begin
  foreach t in array array[
    'inventory_items','inventory_item_conversions','suppliers',
    'supplier_products','item_packaging_formats','item_cost_history'
  ] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I
        for all
        using (location_id in (select location_id from user_accessible_locations()))
        with check (location_id in (select location_id from user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;
