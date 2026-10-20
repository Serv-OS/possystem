-- extra_schema.sql: what the Drop 0 files (20261021a 0a, its revalue file, 20261022a 0b) and the
-- real migrations Peter already ran (20260921u, 20261018a, 20261018c, 20261019, 20261019b,
-- 20261019a, 20261020a) read beyond ../stock_phase0/schema.sql, policies.sql and central_schema.sql,
-- in the live Ops shapes (information_schema, pg_constraint, pg_trigger, read only on 20 Oct 2026).
-- Loaded after ../stock_phase0/central_schema.sql and before any migration. Never run on Supabase.
--
-- Stand ins (not live code, said so where they are): the vault, pg_net, the second sign in step
-- and _public_order_vat / call_edge_fn (only their names are checked by 20261019a and 20261020a).

-- == Phase 1 extras (tax rates, staff PINs, pars), live types =======================================
create table public.tax_rates (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text not null, code text,
  rate numeric(9,6) not null default 0, type text not null default 'inclusive', applies_to text[] default array['all'],
  is_default boolean default false, active boolean default true, created_at timestamptz default now()
);
create table public.staff_members (
  id uuid primary key default gen_random_uuid(), location_id uuid references public.locations(id) on delete cascade,
  org_id uuid references public.organisations(id) on delete cascade, name text not null, role text default 'Server', pin text not null,
  color text default '#3b82f6', initials text, active boolean default true, created_at timestamptz default now(),
  permissions jsonb not null default '[]'::jsonb, nfc_card_id text, auth_method text not null default 'pin', auth_user_id text
);
create table public.par_levels (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  par_level numeric(14,4), reorder_point numeric(14,4), min_level numeric(14,4),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (location_id, inventory_item_id)
);
alter table public.par_levels enable row level security;
create policy par_levels_rls on public.par_levels for all using ((location_id)::text in (select user_accessible_locations()))
  with check ((location_id)::text in (select user_accessible_locations()));
alter table public.tax_rates enable row level security;
create policy tax_rates_read on public.tax_rates for select using (true);
alter table public.staff_members enable row level security;

-- == Live columns the base schema leaves out ========================================================
alter table public.organisations add column if not exists slug text;
alter table public.organisations add column if not exists status text default 'active';
alter table public.organisations add column if not exists updated_at timestamptz default now();
alter table public.organisations add column if not exists created_by uuid;
alter table public.locations add column if not exists address text;
alter table public.locations add column if not exists currency text default 'GBP';
alter table public.locations add column if not exists status text default 'active';
alter table public.locations add column if not exists updated_at timestamptz default now();
alter table public.locations add column if not exists created_by uuid;
alter table public.user_profiles add column if not exists bo_sections text[];
alter table public.msm_product_sites add column if not exists channel_prices jsonb;
alter table public.msm_product_sites add column if not exists kept jsonb not null default '{}'::jsonb;
alter table public.msm_product_sites add column if not exists updated_at timestamptz not null default now();
alter table public.msm_product_sites add column if not exists cleared_tax_profile_id uuid;
alter table public.organisations alter column name set not null;
alter table public.locations add column if not exists show_item_images boolean default false;
alter table public.locations add column if not exists quick_screen_ids jsonb default '[]';
alter table public.locations add column if not exists receipt_branding jsonb;
alter table public.locations add column if not exists print_menu_config jsonb;
alter table public.locations add column if not exists pos_settings jsonb not null default '{}';
alter table public.locations add column if not exists quick_screen_mode text not null default 'manual';
alter table public.locations add column if not exists quick_screen_auto jsonb;
alter table public.locations add column if not exists default_tax_profile_id uuid;
alter table public.locations add column if not exists venue_code text;
alter table public.devices add column if not exists pairing_code text;
alter table public.devices add column if not exists paired_at timestamptz;
alter table public.devices add column if not exists profile_id text;
alter table public.devices add column if not exists centre_id text;
alter table public.devices add column if not exists session_token text;
alter table public.devices add column if not exists receipt_printer_id text;
alter table public.devices add column if not exists kds_settings jsonb;
alter table public.devices add column if not exists client_caps text[];
alter table public.devices add column if not exists device_secret_hash text;
alter table public.devices add column if not exists pairing_expires_at timestamptz;
alter table public.devices add column if not exists bound_at timestamptz;
alter table public.devices add column if not exists secret_issued_at timestamptz;
alter table public.devices add column if not exists last_heartbeat_at timestamptz;
alter table public.ops_devices add column if not exists claim_code text;
alter table public.ops_devices add column if not exists claimed_at timestamptz;
alter table public.ops_devices add column if not exists last_seen_at timestamptz;
-- closed_checks: the live columns the central schema leaves out (all but the old card processor's
-- payment id column, which no stock code may ever read: if 0a read it, this harness would fail).
alter table public.closed_checks alter column location_id set not null;
alter table public.closed_checks alter column subtotal type numeric(10,2);
alter table public.closed_checks alter column tax type numeric(10,2);
alter table public.closed_checks alter column total type numeric(10,2);
alter table public.closed_checks alter column tax_amount type numeric(10,2);
alter table public.closed_checks add column if not exists drawer_id uuid;
alter table public.closed_checks add column if not exists shift_id uuid;
alter table public.closed_checks add column if not exists kiosk_id text;
alter table public.closed_checks add column if not exists customer_phone text;
alter table public.closed_checks add column if not exists kiosk_table_number text;
alter table public.closed_checks add column if not exists payment_intents jsonb;
alter table public.closed_checks add column if not exists processor text;
alter table public.closed_checks add column if not exists seated_at timestamptz;
alter table public.stock_units alter column to_canonical type numeric(20,8);
alter table public.stock_units alter column label set not null;
alter table public.msm_menus add column if not exists description text not null default '';
alter table public.msm_menus add column if not exists use_name_everywhere boolean not null default false;
alter table public.msm_menus add column if not exists created_by uuid;
alter table public.msm_menus add column if not exists created_at timestamptz not null default now();
alter table public.msm_menus add column if not exists updated_at timestamptz not null default now();
alter table public.msm_menus add column if not exists last_version_no integer not null default 0;
alter table public.msm_menus add column if not exists last_published_at timestamptz;
alter table public.msm_menus add column if not exists last_published_by text;
alter table public.msm_menus add column if not exists order_types text[];
alter table public.msm_menus add column if not exists refreshed_at timestamptz;
alter table public.msm_products add column if not exists category_id uuid;
alter table public.msm_products add column if not exists extra_category_ids uuid[] not null default '{}';
alter table public.msm_products add column if not exists parent_product_id uuid;
alter table public.msm_products add column if not exists type text not null default 'simple';
alter table public.msm_products add column if not exists menu_name text;
alter table public.msm_products add column if not exists receipt_name text;
alter table public.msm_products add column if not exists kitchen_name text;
alter table public.msm_products add column if not exists description text not null default '';
alter table public.msm_products add column if not exists default_channels jsonb;
alter table public.msm_products add column if not exists tax_rate_name text;
alter table public.msm_products add column if not exists tax_rate_percent numeric(6,3);
alter table public.msm_products add column if not exists allergens text[] not null default '{}';
alter table public.msm_products add column if not exists tags jsonb not null default '[]';
alter table public.msm_products add column if not exists image text;
alter table public.msm_products add column if not exists modifier_groups jsonb not null default '[]';
alter table public.msm_products add column if not exists visibility jsonb;
alter table public.msm_products add column if not exists sold_alone boolean not null default false;
alter table public.msm_products add column if not exists item_code text;
alter table public.msm_products add column if not exists site_only_location_id text;
alter table public.msm_products add column if not exists sort_order integer not null default 0;
alter table public.msm_products add column if not exists family_base text;
alter table public.msm_products add column if not exists updated_at timestamptz not null default now();
alter table public.msm_products add column if not exists tax_by_type jsonb;
alter table public.production_batches add column if not exists lot_code text;
alter table public.production_batches add column if not exists expiry_at timestamptz;
alter table public.production_batches add column if not exists produced_at timestamptz;
alter table public.production_batches add column if not exists produced_by uuid;
alter table public.production_batches add column if not exists notes text;
alter table public.production_batches add column if not exists schedule_id uuid;
alter table public.production_batches add column if not exists planned_for date;
alter table public.production_batches add column if not exists due_time time;

-- auth.users (20260921u's report reads it) and auth.jwt() as Supabase has them
create table if not exists auth.users (id uuid primary key, email text, is_anonymous boolean default false, created_at timestamptz default now());
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- == vault and pg_net stand ins (live signatures: vault.create_secret(text,text,text,uuid),
-- net.http_post(text,jsonb,jsonb,jsonb,integer)) ===================================================
create schema if not exists vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text,
  created_at timestamptz not null default now());
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description, created_at from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create schema if not exists net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_ms integer, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout_ms) values (url, body, headers, timeout_milliseconds) returning id $$;

-- == Stock tables the base schema does not have (live shapes) =======================================
create table public.deliveries (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid,
  po_id uuid references public.purchase_orders(id) on delete set null, supplier_id uuid references public.suppliers(id) on delete set null,
  status text not null default 'pending', temperature_c numeric(6,2), in_range boolean, checked_by uuid, checked_by_name text,
  checked_at timestamptz, rejection_reason text, corrective_action_id uuid, received_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.prep_schedule (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid, name text not null,
  qty numeric(12,3), unit text, due_time time, days_of_week integer[], active boolean not null default true,
  sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  output_item_id uuid, recipe_id uuid
);
alter table public.prep_schedule enable row level security;
create table public.stock_site_settings (
  location_id uuid primary key, cost_rule text not null default 'price_list', updated_at timestamptz not null default now(),
  updated_by_name text
);
alter table public.stock_site_settings enable row level security;

-- == What 20261019a and 20261020a (channel parity) need to apply as Peter ran them ===================
-- (non stock tables, live column lists, read 20 Oct 2026; hubrise_connections and promo_redemptions
-- as they were BEFORE 20261020a, which adds 7 and 2 columns)
create table if not exists public.menus (id text primary key, location_id text not null default 'loc-demo', name text not null,
  description text default '', is_default boolean default false, is_active boolean default true, sort_order integer default 0,
  created_at timestamptz default now(), updated_at timestamptz default now(), schedule jsonb, priority integer not null default 0,
  scope text not null default 'local', org_id uuid);
create table if not exists public.menu_categories (id text primary key, location_id text not null default 'loc-demo', menu_id text,
  parent_id text, label text not null, icon text, color text default '#3b82f6', accounting_group text default '', sort_order integer default 0,
  is_special boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(), default_course integer default 1,
  spacer_slots jsonb default '[]', scope text not null default 'local', org_id uuid, master_id text, lock_pricing boolean not null default false,
  tax_profile_id uuid, image text);
create table if not exists public.menu_category_links (id uuid primary key default gen_random_uuid(), menu_id text not null, category_id text not null,
  sort_order integer not null default 0, created_at timestamptz not null default now());
create table if not exists public.menu_items (id text primary key, location_id text not null default 'loc-demo', name text not null, menu_name text,
  receipt_name text, kitchen_name text, description text default '', type text default 'simple', cat text, cats text[] default '{}', parent_id text,
  sort_order integer default 0, pricing jsonb default '{"base": 0}', allergens text[] default '{}', assigned_modifier_groups jsonb default '[]',
  assigned_instruction_groups jsonb default '[]', visibility jsonb default '{"pos": true, "kiosk": true, "online": true}', sold_alone boolean default false,
  archived boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(), tax_rate_id uuid,
  tax_overrides jsonb default '{}', centre_id text, image text, scope text not null default 'local', org_id uuid, master_id text,
  lock_pricing boolean not null default false, locked_fields jsonb not null default '[]', tags jsonb not null default '[]',
  option_group_order jsonb, tax_profile_id uuid, item_code text);
alter table public.menu_items enable row level security;
create policy menu_items_read on public.menu_items for select using (true);
create table if not exists public.modifier_groups (id text primary key, location_id text not null default 'loc-demo', name text not null,
  min_select integer default 0, max_select integer default 1, sort_order integer default 0, min integer default 0, max integer default 1,
  selection_type text default 'single', options jsonb default '[]', created_at timestamptz default now());
create table if not exists public.config_pushes (id uuid primary key default gen_random_uuid(), location_id text not null default 'loc-demo',
  pushed_by text, snapshot jsonb not null default '{}', change_count integer default 0, created_at timestamptz default now());
create table if not exists public.hubrise_connections (location_id text primary key, company_id uuid, access_token text not null default '',
  scope text, hubrise_account_id text, account_name text, hubrise_location_id text, hubrise_location_name text, hubrise_catalog_id text,
  hubrise_catalog_name text, hubrise_customer_list_id text, currency text not null default 'GBP', status text not null default 'connected',
  active_callback_id text, passive_callback_id text, callbacks_registered_at timestamptz, catalog_pushed_at timestamptz, catalog_push_error text,
  inventory_synced_at timestamptz, inventory_sync_error text, last_event_at timestamptz, last_reconcile_at timestamptz, last_error text,
  auto_accept boolean not null default false, default_prep_minutes integer not null default 20, connected_by uuid,
  connected_at timestamptz not null default now(), updated_at timestamptz not null default now(), menu_ids text[] not null default '{}',
  auto_print_receipt boolean not null default true, catalog_image_ids jsonb not null default '{}', inventory_dirty boolean not null default false,
  inventory_pushed_at timestamptz);
create table if not exists public.device_profiles (id text primary key, location_id uuid, name text not null, color text default '#3b82f6',
  default_surface text default 'tables', enabled_order_types jsonb default '["dine-in"]', table_service_enabled boolean default true,
  menu_id text, sort_order integer default 0, created_at timestamptz default now(),
  service_charge jsonb default '{"rate": 12.5, "applyTo": "all", "enabled": true, "minCovers": 8}', is_master boolean default false,
  kiosk_new_design boolean not null default false, default_order_type text);
create table if not exists public.promo_redemptions (id uuid primary key default gen_random_uuid(), promo_code_id uuid not null, offer_id uuid not null,
  org_id uuid not null, code text not null, customer_id uuid, location_id text not null, order_id text, staff_id uuid, basket_value numeric,
  discount_value numeric, idempotency_key text, redeemed_at timestamptz not null default now());
create table if not exists public.menu_translations (id bigserial primary key, location_id text not null, entity_type text not null,
  entity_id text not null, lang text not null, text jsonb not null default '{}', source text not null default 'auto',
  source_hash text not null default '', model text, updated_at timestamptz not null default now());
create table if not exists public.discounts (id uuid primary key default gen_random_uuid(), location_id text not null default 'loc-demo',
  name text not null, type text not null default 'percent', value numeric not null default 0, scope text not null default 'global',
  category_ids text[] default '{}', requires_manager boolean default false, active boolean default true, sort_order integer default 0,
  created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists public.order_queue (ref text not null, location_id text not null, type text not null default 'dine-in',
  customer jsonb default '{}', items jsonb default '[]', total numeric default 0, status text default 'received', staff text,
  created_at timestamptz default now(), sent_at timestamptz, collection_time text, is_asap boolean default false,
  updated_at timestamptz default now(), source text default 'pos', kitchen_routed_at timestamptz, paid boolean default false,
  payment_method text, event_date date, notify_confirmed_at timestamptz, notify_ready_at timestamptz, placed_via text,
  primary key (location_id, ref));
create table if not exists public.discount_rules (id uuid primary key default gen_random_uuid(), location_id text not null default 'loc-demo',
  name text not null, active boolean default true, trigger_type text not null default 'buy_x', trigger_category_ids text[] default '{}',
  trigger_qty integer not null default 2, reward_type text not null default 'percent', reward_value numeric default 0, reward_qty integer default 1,
  reward_category_ids text[] default '{}', channels jsonb default '{"qr": true, "pos": true, "kiosk": true, "online": true}', schedule jsonb,
  priority integer default 0, sort_order integer default 0, created_at timestamptz default now(), updated_at timestamptz default now(),
  trigger_groups jsonb);
create table if not exists public.offers (id uuid primary key default gen_random_uuid(), org_id uuid not null, company_id uuid, name text not null,
  description text, reward_type text not null default 'fixed', reward_value numeric not null default 0, reward_item_id text, reward_label text,
  min_spend numeric, include_category_ids text[] not null default '{}', exclude_category_ids text[] not null default '{}',
  valid_from timestamptz, valid_to timestamptz, venue_ids text[] not null default '{}', per_customer_limit integer not null default 1,
  total_cap integer, issued_count integer not null default 0, redeemed_count integer not null default 0, code_prefix text not null default '',
  code_length integer not null default 5, stackable boolean not null default false, active boolean not null default true, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.promo_codes (id uuid primary key default gen_random_uuid(), offer_id uuid not null, org_id uuid not null,
  company_id uuid, code text not null, customer_id uuid, status text not null default 'issued', uses_allowed integer not null default 1,
  uses_count integer not null default 0, issued_at timestamptz not null default now(), expires_at timestamptz, redeemed_at timestamptz,
  redeemed_order_id text, redeemed_location_id text, redeemed_value numeric, redeemed_staff_id uuid, campaign_id uuid, message_id uuid,
  voided_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());

-- Stand ins: 20261019a checks that _public_order_vat exists (20261009a, live); menu_translate_cron
-- (20261020a) calls call_edge_fn at run time only. Neither is called by any stock path.
create or replace function public._public_order_vat(p_loc text, p_lines jsonb, p_type text, p_share numeric)
returns jsonb language plpgsql as $$ begin raise exception 'harness stand in for _public_order_vat (20261009a): not used by stock'; end $$;
create or replace function public.call_edge_fn(fn text, body jsonb)
returns void language plpgsql as $$ begin raise exception 'harness stand in for call_edge_fn: not used by stock'; end $$;

-- The second sign in step: the live second_step_ok() reads the second step settings and the token's
-- assurance level. Here, as the multi site menu harness: a signed in person (not anonymous) whose
-- token says aal1 has NOT done the second step; everyone else (aal2 tokens, devices, anonymous
-- sessions, service role, the SQL editor) has. CREATE OR REPLACE over ../stock_phase0's always true.
create or replace function public.second_step_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select not (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated'
              and not coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false)
              and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal2') = 'aal1')
$$;
revoke all on function public.second_step_ok() from public;
grant execute on function public.second_step_ok() to anon, authenticated, service_role;
