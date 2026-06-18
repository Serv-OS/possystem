-- Catering Online Ordering (Module 1) — single per-location settings record.
-- Operator completes all setup fields (no baked-in defaults, per owner); the catering site stays
-- OFF (enabled=false) until configured. Money in integer minor units; currency per location (£/$).
-- RLS = the workforce good pattern (user_accessible_locations()), NOT the POS-core allow-all.

create table if not exists catering_site_settings (
  id                       uuid primary key default gen_random_uuid(),
  location_id              uuid not null unique,
  enabled                  boolean not null default false,
  currency                 text not null default 'gbp',      -- gbp | usd | eur (per-location market)
  slug                     text,                              -- public catering URL slug
  banner_message           text,
  -- setup (operator-completed; nullable until set — NO defaults)
  hours                    jsonb,                             -- { mon:{open,close,closed}, ... } catering hours
  closures                 date[],                            -- closed dates
  lead_time_min_days       integer,
  lead_time_max_days       integer,
  prep_time_minutes        integer,
  order_minimum_minor      integer,
  tips_enabled             boolean not null default false,
  tip_default_pct          numeric(5,2),
  -- fulfilment
  takeout_enabled          boolean not null default false,
  takeout_dining_option    text,
  delivery_enabled         boolean not null default false,
  delivery_dining_option   text,
  delivery_radius_miles    numeric(6,2),
  delivery_fee_minor       integer,
  delivery_fee_per_mile_minor integer,
  -- menus shown on the catering site + per-item qty limits (max 0 = 86'd)
  -- NB: menu/item ids in this system are TEXT (app-generated, e.g. 'menu-1776196849535'), NOT uuid.
  menu_ids                 text[],
  item_limits              jsonb,                             -- { "<item_id>": { "min": n, "max": n } }
  -- checkout
  allow_tax_exempt         boolean not null default false,
  allow_promo              boolean not null default false,
  allow_pay_later          boolean not null default false,
  -- capacity (per day)
  capacity_mode            text,                              -- 'count' | 'value'
  capacity_per_day         integer,                           -- count, or value in minor units
  capacity_overrides       jsonb,                             -- { "YYYY-MM-DD": limit }
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table catering_site_settings enable row level security;
alter table catering_site_settings force row level security;

-- BO users see/manage only their accessible locations; service-role (public catering site edge fn) bypasses.
create policy css_sel on catering_site_settings for select using (location_id::text in (select public.user_accessible_locations()));
create policy css_ins on catering_site_settings for insert with check (location_id::text in (select public.user_accessible_locations()));
create policy css_upd on catering_site_settings for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()));
create policy css_del on catering_site_settings for delete using (location_id::text in (select public.user_accessible_locations()));
