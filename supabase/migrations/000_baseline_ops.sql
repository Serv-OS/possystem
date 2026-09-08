-- ============================================================================
-- 000_baseline_ops.sql
--
-- BASELINE SCHEMA for the OPS database  (Supabase project tbetcegmszzotrwdtqhi)
--
-- WHAT THIS IS
--   A machine-generated reconstruction of everything in schema `public` on the
--   live ops database, read from the system catalogs on 2026-08-05.
--   It exists because neither database has a migration ledger: 25 live tables
--   (staff_members, tax_rates, customers, active_sessions, cash_movements,
--   stamp_transactions, ...) had no CREATE TABLE anywhere in this repo, so the
--   schema could not be rebuilt from source, no test database could be stood
--   up, and constraints existed only in production where nobody could review
--   them. See PRE_STAGE_READINESS.md.
--
--   It was generated from the CATALOGS, not from supabase/migrations/, because
--   that folder is known to be incomplete and in places contradicts the live
--   database. Where this file and an older migration disagree, THIS file
--   describes what is actually running.
--
-- WHAT IT IS NOT
--   *** This is a BASELINE, not a change. It represents state that ALREADY
--   *** EXISTS on ops. Do NOT run it against a database that already has this
--   *** schema expecting it to do something — every statement is idempotent,
--   *** so there it is a no-op (and a slow one). Run it to stand up an EMPTY
--   *** database: a local test instance, a fresh staging project, a scratch
--   *** database for reviewing a proposed schema change.
--
--   It carries NO data. Reference/config rows (tax_rates, locations,
--   organisations, feature flags) are not seeded here.
--
-- PREREQUISITES (things this file deliberately does not create)
--   The ops schema is bound to Supabase platform schemas. A restore target
--   must provide these or the file will fail:
--     * schema `auth`   — auth.uid() (91 uses), auth.role() (20), auth.jwt() (3),
--                         and table auth.users, which public.user_profiles has a
--                         real FOREIGN KEY to. Supplied by Supabase GoTrue.
--     * schema `vault`  — vault.decrypted_secrets / vault.create_secret, read by
--                         4 functions. Supplied by the supabase_vault extension.
--     * schema `net`    — net.http_post, called by 3 functions (pg_net).
--     * roles `anon`, `authenticated`, `service_role` — the grants at the bottom
--                         target these by name. On Supabase they already exist.
--   Only `uuid-ossp` is created below, because 11 tables have a column DEFAULT
--   of uuid_generate_v4() and CREATE TABLE fails outright without it.
--   Target server was PostgreSQL 17.6; the grant lists include the PG17
--   MAINTAIN privilege and will not parse on PG16 or earlier.
--
-- ORDERING
--   All tables and columns first, then constraints, then indexes — so a foreign
--   key can never reference a table that does not exist yet and a dependency
--   cycle cannot break the file. One deliberate departure from a naive
--   tables->constraints->indexes->RLS->functions order: FUNCTIONS ARE EMITTED
--   BEFORE POLICIES, because 236 of the 293 policies call a public function
--   (pos_can_access, is_super_admin, user_accessible_locations, ...) and would
--   fail to create otherwise. `enable row level security` still sits in its
--   usual place, ahead of the functions; only the policies move.
--   check_function_bodies is turned off for the duration so that functions
--   referring to each other are order-independent.
--
-- HOW TO REGENERATE
--   scripts/ has no generator for this yet; it was produced by querying the
--   live catalogs read-only via the Supabase management API:
--     POST https://api.supabase.com/v1/projects/tbetcegmszzotrwdtqhi/database/query
--     headers: Authorization: Bearer $SUPABASE_ACCESS_TOKEN
--              Content-Type: application/json
--              User-Agent: rpos-schema/1.0        <- required, requests 400 without it
--     body:    {"query": "<sql>"}
--   The catalog sources, section by section:
--     tables/columns  pg_class + pg_attribute + format_type() + pg_get_expr(adbin)
--     constraints     pg_constraint + pg_get_constraintdef()
--     indexes         pg_indexes.indexdef, minus any index backing a constraint
--     RLS             pg_class.relrowsecurity / relforcerowsecurity
--     policies        pg_policies
--     functions       pg_get_functiondef()
--     views           pg_get_viewdef()
--     triggers        pg_get_triggerdef()
--     grants          aclexplode() over pg_class.relacl / pg_attribute.attacl /
--                     pg_proc.proacl
--   Page every query (LIMIT/OFFSET) — a large single response is truncated by
--   the API, and for this job a truncated response means silently losing schema.
--   Regenerate after any structural change and commit the diff; that diff is
--   the review artefact this database has never had.
--
-- COVERAGE — emitted here
--    161  tables
--    161  primary keys
--     30  unique constraints
--    137  foreign keys
--    126  check constraints
--    258  indexes (non-constraint-backed)
--    161  tables with row level security enabled (22 of them FORCE)
--     88  functions
--      1  view
--    293  RLS policies
--     23  triggers
--    484  table grants + 4 column grants + 294 function grants
--    162  table + 88 function privilege resets (REVOKE) — see section 10,
--         these are load-bearing, not tidiness
--     46  comments
--
-- VERIFIED, not assumed. This file was applied to an empty PostgreSQL 17
-- database and the result diffed against the live catalogs, signature by
-- signature: 7898 signatures covering every column type/NOT NULL/default,
-- every constraint definition, index, RLS flag, policy, function body hash,
-- trigger, view, grant and comment. The rebuild matches live exactly. The one
-- textual difference is cosmetic: the 11 uuid_generate_v4() defaults render as
-- extensions.uuid_generate_v4() when `extensions` is not on the reader's
-- search_path. Both bind to the same function OID.
--
-- COVERAGE — deliberately NOT emitted (documented gaps, not oversights)
--   * Extensions other than uuid-ossp. Live: pg_cron, pg_net, pg_stat_statements,
--     pgcrypto, supabase_vault, plpgsql. All Supabase-managed; creating them is
--     a platform operation, and pgcrypto/uuid-ossp live in schema `extensions`.
--   * Everything outside schema `public`: auth, storage, vault, net, cron,
--     realtime, graphql. In particular STORAGE BUCKETS AND THEIR POLICIES are
--     not here — several features (workforce documents, checklist photos,
--     ticket attachments) depend on buckets that this file will not create,
--     and storage.objects carries its own RLS.
--   * The 9 pg_cron schedules in cron.job. They are real scheduled work
--     (paxpay sweep, loyalty reconcile, realtime prune) and live in the cron
--     schema; see 20260805_scheduled_automations.sql and 20260805b_edge_cron_bridge.sql.
--   * Row data of every kind, including the reference tables.
--   * Database roles, role memberships, and ALTER DEFAULT PRIVILEGES (27 default
--     ACL entries exist live). Grants below are the explicit per-object ACLs only.
--   * One comment on an index (not a table, view, column or function) was
--     skipped by the extractor.
--   * publications / replication (supabase_realtime), event triggers, and any
--     server or database level settings.
--
-- NOT A SECURITY REVIEW. This file reproduces the live ACLs and policies
-- verbatim, including ones that are almost certainly wrong — e.g. the
-- "allow all" USING(true) policies and the TRUNCATE/anon grants you will see
-- below. Reproducing them is the point: they are now visible in source.
-- ============================================================================

begin;

set local check_function_bodies = off;
set local search_path = public, extensions;

-- --------------------------------------------------------------------------
-- 0. PREREQUISITES
-- uuid_generate_v4() is a column DEFAULT on 11 tables, so uuid-ossp must
-- exist before any CREATE TABLE below. On Supabase both already exist and
-- these are no-ops.
-- --------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- --------------------------------------------------------------------------
-- 1. ENUM TYPES
-- None. The live ops schema has zero enum types, zero domains and zero
-- composite types — every column is a pg_catalog base type. Nothing to
-- emit here; the section is kept so its absence is a stated fact rather
-- than a hole.
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 2. TABLES  (161)
-- Columns only — exact type via format_type() so varchar(n) and
-- numeric(p,s) survive, plus NOT NULL and DEFAULT via pg_get_expr(adbin).
-- Constraints follow in section 3 so no table can reference one that
-- does not exist yet. No identity, generated or non-default-collation
-- columns exist live.
-- --------------------------------------------------------------------------

create table if not exists public.active_sessions (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  table_id text not null,
  session jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now(),
  subtotal_minor bigint,
  total_minor bigint,
  totals_at timestamp with time zone
);

create table if not exists public.activity_events (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  kind text not null,
  severity text default 'info'::text not null,
  title text not null,
  body text,
  ref_type text,
  ref_id text,
  actor_name text,
  acked_at timestamp with time zone,
  acked_by text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.bar_tabs (
  id text not null,
  location_id text not null,
  ref text,
  name text not null,
  seat_id text,
  table_id text,
  opened_by text,
  opened_at timestamp with time zone default now(),
  status text default 'open'::text,
  pre_auth boolean default false,
  pre_auth_amount numeric(10,2) default 0,
  rounds jsonb default '[]'::jsonb,
  note text default ''::text,
  total numeric(10,2) default 0,
  updated_at timestamp with time zone default now(),
  pre_auth_ref text,
  pre_auth_processor text,
  pre_auth_held_minor bigint,
  pre_auth_account text
);

create table if not exists public.campaign_runs (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  campaign_id uuid not null,
  run_key text not null,
  status text default 'running'::text not null,
  candidates integer default 0 not null,
  sent integer default 0 not null,
  skipped integer default 0 not null,
  failed integer default 0 not null,
  error text,
  run_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone
);

create table if not exists public.campaign_sends (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  campaign_id uuid not null,
  run_id uuid,
  customer_id uuid not null,
  dedupe_key text not null,
  channel text,
  email_message_id uuid,
  sms_message_id uuid,
  promo_code text,
  status text default 'pending'::text not null,
  error text,
  created_at timestamp with time zone default now() not null,
  variant_key text
);

create table if not exists public.campaigns (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  name text not null,
  description text,
  type text default 'automation'::text not null,
  status text default 'draft'::text not null,
  channel text default 'email'::text not null,
  segment_id uuid,
  trigger jsonb default '{}'::jsonb not null,
  schedule jsonb default '{}'::jsonb not null,
  subject text,
  email_html text,
  sms_body text,
  from_name text,
  offer_id uuid,
  last_run_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  email_blocks jsonb,
  ephemeral boolean default false not null,
  exclusion_segment_id uuid,
  variants jsonb default '[]'::jsonb not null
);

create table if not exists public.cash_drawers (
  id text not null,
  location_id uuid not null,
  name text not null,
  printer_id text,
  device_id text,
  status text default 'idle'::text,
  current_float numeric default 0,
  opened_at timestamp with time zone,
  opened_by_staff_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.cash_movements (
  id text not null,
  location_id uuid not null,
  "timestamp" timestamp with time zone default now(),
  type text not null,
  amount numeric not null,
  drawer_id text,
  shift_id text,
  from_drawer_id text,
  to_drawer_id text,
  safe_id text,
  reason text,
  note text,
  ref text,
  staff_id uuid,
  staff_name text,
  created_at timestamp with time zone default now(),
  session_id text
);

create table if not exists public.catering_site_settings (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  enabled boolean default false not null,
  currency text default 'gbp'::text not null,
  slug text,
  banner_message text,
  hours jsonb,
  closures date[],
  lead_time_min_days integer,
  lead_time_max_days integer,
  prep_time_minutes integer,
  order_minimum_minor integer,
  tips_enabled boolean default false not null,
  tip_default_pct numeric(5,2),
  takeout_enabled boolean default false not null,
  takeout_dining_option text,
  delivery_enabled boolean default false not null,
  delivery_dining_option text,
  delivery_radius_miles numeric(6,2),
  delivery_fee_minor integer,
  delivery_fee_per_mile_minor integer,
  menu_ids text[],
  item_limits jsonb,
  allow_tax_exempt boolean default false not null,
  allow_promo boolean default false not null,
  allow_pay_later boolean default false not null,
  capacity_mode text,
  capacity_per_day integer,
  capacity_overrides jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  kitchen_fire_time text
);

create table if not exists public.challenge_21_checks (
  id uuid default uuid_generate_v4() not null,
  location_id text not null,
  triggered_at timestamp with time zone default now(),
  trigger_count integer,
  staff_id text,
  staff_name text,
  customer_first_name text,
  customer_last_name_initial text,
  id_type text,
  id_document_number text,
  cancelled boolean default false,
  cancel_reason text,
  created_at timestamp with time zone default now()
);

create table if not exists public.closed_checks (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  table_id text,
  table_label text,
  staff_name text,
  items jsonb default '[]'::jsonb,
  subtotal numeric(10,2) default 0,
  tax numeric(10,2) default 0,
  total numeric(10,2) default 0,
  payment_method text,
  covers integer default 0,
  closed_at timestamp with time zone default now(),
  voided boolean default false,
  refunded boolean default false,
  ref text,
  server text,
  order_type text,
  customer jsonb,
  discounts jsonb default '[]'::jsonb,
  service numeric default 0,
  tip numeric default 0,
  method text,
  status text default 'paid'::text,
  refunds jsonb default '[]'::jsonb,
  tax_breakdown jsonb default '[]'::jsonb,
  tax_amount numeric(10,2),
  staff_id uuid,
  drawer_id text,
  shift_id text,
  customer_id uuid,
  source text default 'pos'::text,
  kiosk_id uuid,
  customer_phone text,
  kiosk_table_number text,
  gift_card jsonb,
  loyalty jsonb,
  stripe_payment_intent_id text,
  payment_intents jsonb,
  processor text default 'stripe'::text,
  seated_at timestamp with time zone,
  promo jsonb
);

create table if not exists public.config_pushes (
  id uuid default uuid_generate_v4() not null,
  location_id text default 'loc-demo'::text not null,
  pushed_by text,
  snapshot jsonb not null,
  change_count integer default 0,
  created_at timestamp with time zone default now()
);

create table if not exists public.corrective_actions (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  source_type text not null,
  source_id uuid not null,
  severity text default 'minor'::text not null,
  action text not null,
  description text,
  photo_url text,
  operator_id uuid,
  operator_name text,
  maintenance_request_id uuid,
  status text default 'closed'::text not null,
  created_at timestamp with time zone default now() not null,
  closed_at timestamp with time zone
);

create table if not exists public.courier_deliveries (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  order_ref text,
  dispatch_backend text default 'uber_api'::text not null,
  uber_delivery_id text,
  hubrise_ref text,
  status text default 'pending'::text not null,
  tracking_url text,
  courier_name text,
  courier_phone text,
  last_lat numeric,
  last_lng numeric,
  eta timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  pickup_eta timestamp with time zone,
  picked_at timestamp with time zone,
  delivered_at timestamp with time zone
);

create table if not exists public.customer_consents (
  id uuid default gen_random_uuid() not null,
  customer_id uuid not null,
  org_id uuid,
  location_id text not null,
  company_id uuid,
  channel text default 'both'::text not null,
  purpose text default 'marketing'::text not null,
  consented boolean not null,
  source text default 'wifi'::text not null,
  method text default 'explicit_optin'::text not null,
  consent_text text,
  privacy_version text,
  ip inet,
  user_agent text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.customer_locations (
  customer_id uuid not null,
  location_id uuid not null,
  first_visit_at timestamp with time zone default now(),
  last_visit_at timestamp with time zone default now(),
  visit_count integer default 0,
  lifetime_revenue numeric default 0,
  notes text
);

create table if not exists public.customer_orders (
  id uuid default gen_random_uuid() not null,
  customer_id uuid not null,
  location_id uuid not null,
  closed_check_id text,
  ordered_at timestamp with time zone default now(),
  total numeric default 0,
  channel text,
  item_summary jsonb,
  created_at timestamp with time zone default now()
);

create table if not exists public.customers (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  phone text,
  phone_raw text,
  email text,
  name text not null,
  notes text,
  marketing_opt_in boolean default false,
  marketing_opt_in_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  deleted_at timestamp with time zone,
  allergens text[] default '{}'::text[],
  birthday date,
  welcome_sent_at timestamp with time zone,
  first_name text,
  last_name text,
  is_local boolean,
  source text,
  sources text[] default '{}'::text[] not null
);

create table if not exists public.deliveries (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  po_id uuid,
  supplier_id uuid,
  status text default 'pending'::text not null,
  temperature_c numeric(6,2),
  in_range boolean,
  checked_by uuid,
  checked_by_name text,
  checked_at timestamp with time zone,
  rejection_reason text,
  corrective_action_id uuid,
  received_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.delivery_costs_actual (
  delivery_id uuid not null,
  location_id text,
  base_minor integer default 0 not null,
  distance_minor integer default 0 not null,
  wait_minutes integer default 0 not null,
  wait_cost_minor integer default 0 not null,
  cancellation_minor integer default 0 not null,
  total_minor integer default 0 not null,
  currency text default 'GBP'::text not null,
  recorded_at timestamp with time zone default now() not null
);

create table if not exists public.delivery_quotes (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  order_ref text,
  quote_id text,
  dropoff_address jsonb,
  dropoff_lat numeric,
  dropoff_lng numeric,
  distance_miles numeric,
  within_radius boolean,
  uber_fee_minor integer,
  currency text default 'GBP'::text not null,
  eta_minutes integer,
  expires_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.delivery_status_events (
  event_id text not null,
  delivery_id uuid,
  location_id text,
  status text,
  payload jsonb,
  received_at timestamp with time zone default now() not null
);

create table if not exists public.delivery_surcharges (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  order_ref text,
  quote_id text,
  customer_fee_minor integer default 0 not null,
  true_cost_minor integer default 0 not null,
  margin_minor integer default 0 not null,
  policy_applied text,
  currency text default 'GBP'::text not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.device_heartbeats (
  device_id text not null,
  location_id text not null,
  device_name text,
  role text default 'child'::text,
  last_seen timestamp with time zone default now(),
  version text,
  open_tables integer default 0,
  ip_hint text
);

create table if not exists public.device_profiles (
  id text not null,
  location_id uuid,
  name text not null,
  color text default '#3b82f6'::text,
  default_surface text default 'tables'::text,
  enabled_order_types jsonb default '["dine-in"]'::jsonb,
  assigned_section text,
  hidden_features jsonb default '[]'::jsonb,
  table_service_enabled boolean default true,
  quick_screen_enabled boolean default true,
  menu_id text,
  sort_order integer default 0,
  created_at timestamp with time zone default now(),
  service_charge jsonb default '{"rate": 12.5, "applyTo": "all", "enabled": true, "minCovers": 8}'::jsonb,
  is_master boolean default false,
  auto_print_receipt_on_close boolean default true not null,
  kiosk_brand_name text,
  kiosk_brand_logo_url text,
  kiosk_brand_color text,
  kiosk_attract_video_url text,
  kiosk_idle_timeout_sec integer default 60,
  kiosk_table_mode text default 'either'::text,
  kiosk_routes_to_pos_id uuid,
  kiosk_tip_presets jsonb default '[10, 12.5, 15]'::jsonb,
  kiosk_loyalty_enabled boolean default true,
  kiosk_sms_enabled boolean default false,
  kiosk_allergen_required boolean default false,
  kiosk_banners jsonb default '[]'::jsonb,
  kiosk_brand_accent_color text,
  kiosk_brand_bg_color text,
  kiosk_avg_wait_minutes integer default 8,
  kiosk_theme_mode text default 'dark'::text,
  kiosk_label_tap_to_order text,
  kiosk_label_place_order text,
  kiosk_label_add_to_order text,
  runner_mode boolean default false,
  payment_mode text default 'tap_to_pay'::text,
  assigned_reader_id uuid,
  customer_display_mode text,
  customer_display_images jsonb,
  customer_display_cart_images jsonb,
  order_notifications boolean default true not null,
  training_mode boolean default false not null,
  signout_idle_seconds integer default 0 not null,
  signout_on_pay boolean default false not null,
  signout_on_send boolean default false not null
);

create table if not exists public.devices (
  id uuid default uuid_generate_v4() not null,
  location_id uuid,
  name text not null,
  type text default 'pos'::text,
  pairing_code text,
  paired_at timestamp with time zone,
  status text default 'unpaired'::text,
  last_seen timestamp with time zone,
  profile_id text,
  created_at timestamp with time zone default now(),
  centre_id text,
  session_token text,
  receipt_printer_id text,
  device_uid uuid,
  app_version text
);

create table if not exists public.discount_rules (
  id uuid default uuid_generate_v4() not null,
  location_id text default 'loc-demo'::text not null,
  name text not null,
  active boolean default true,
  trigger_type text default 'buy_x'::text not null,
  trigger_category_ids text[] default '{}'::text[],
  trigger_qty integer default 2 not null,
  reward_type text default 'percent'::text not null,
  reward_value numeric(10,4) default 0,
  reward_qty integer default 1,
  reward_category_ids text[] default '{}'::text[],
  channels jsonb default '{"qr": true, "pos": true, "kiosk": true, "online": true}'::jsonb,
  schedule jsonb,
  priority integer default 0,
  sort_order integer default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  trigger_groups jsonb
);

create table if not exists public.discounts (
  id uuid default uuid_generate_v4() not null,
  location_id text default 'loc-demo'::text not null,
  name text not null,
  type text default 'percent'::text not null,
  value numeric(10,4) default 0 not null,
  scope text default 'global'::text not null,
  category_ids text[] default '{}'::text[],
  requires_manager boolean default false,
  active boolean default true,
  sort_order integer default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.drawer_sessions (
  id text not null,
  drawer_id text not null,
  shift_id text,
  location_id uuid not null,
  cash_in_at timestamp with time zone default now() not null,
  cash_in_by_staff_id uuid,
  opening_float numeric default 0 not null,
  cash_out_at timestamp with time zone,
  cash_out_by_staff_id uuid,
  declared_cash numeric,
  expected_cash numeric,
  variance numeric,
  denominations jsonb,
  status text default 'open'::text,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.eighty_six (
  id uuid default uuid_generate_v4() not null,
  location_id text default 'loc-demo'::text not null,
  item_id text not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.floor_tables (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  label text not null,
  x numeric default 0,
  y numeric default 0,
  w numeric default 80,
  h numeric default 80,
  shape text default 'rect'::text,
  max_covers integer default 4,
  section text,
  sort_order integer default 0,
  created_at timestamp with time zone default now()
);

create table if not exists public.hubrise_connections (
  location_id text not null,
  company_id uuid,
  access_token text not null,
  scope text,
  hubrise_account_id text,
  account_name text,
  hubrise_location_id text,
  hubrise_location_name text,
  hubrise_catalog_id text,
  hubrise_catalog_name text,
  hubrise_customer_list_id text,
  currency text default 'GBP'::text not null,
  status text default 'connected'::text not null,
  active_callback_id text,
  passive_callback_id text,
  callbacks_registered_at timestamp with time zone,
  catalog_pushed_at timestamp with time zone,
  catalog_push_error text,
  inventory_synced_at timestamp with time zone,
  inventory_sync_error text,
  last_event_at timestamp with time zone,
  last_reconcile_at timestamp with time zone,
  last_error text,
  auto_accept boolean default false not null,
  default_prep_minutes integer default 20 not null,
  connected_by uuid,
  connected_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  menu_ids text[] default '{}'::text[] not null,
  auto_print_receipt boolean default true not null,
  catalog_image_ids jsonb default '{}'::jsonb not null
);

create table if not exists public.hubrise_events (
  event_id text not null,
  location_id text,
  resource_type text,
  event_type text,
  order_id text,
  status text default 'received'::text not null,
  error text,
  received_at timestamp with time zone default now() not null,
  processed_at timestamp with time zone
);

create table if not exists public.hubrise_oauth_pending (
  state text not null,
  location_id text not null,
  company_id uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.hubrise_order_links (
  ref text not null,
  location_id text not null,
  hubrise_order_id text not null,
  hubrise_location_id text,
  channel text,
  service_type text,
  hr_status text,
  pushed_status text,
  push_error text,
  pushed_at timestamp with time zone,
  last_event_created_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.inventory_item_conversions (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  from_qty numeric(14,4) not null,
  from_unit text not null,
  to_qty numeric(14,4) not null,
  to_unit text not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.inventory_items (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text not null,
  kind text default 'PURCHASED'::text not null,
  base_unit text not null,
  accounting_group text,
  category text,
  is_tracked boolean default true not null,
  is_sellable boolean default false not null,
  current_cost numeric(12,5),
  cost_method text default 'MOVING_AVG'::text not null,
  on_hand numeric(14,4) default 0 not null,
  allergens jsonb default '[]'::jsonb not null,
  shelf_life_days integer,
  storage_location text,
  default_supplier_id uuid,
  sku text,
  barcode text,
  notes text,
  archived_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  purchase_tax_rate_id uuid
);

create table if not exists public.item_cost_history (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  supplier_product_id uuid,
  pack_price numeric(12,4),
  base_unit_cost numeric(12,5) not null,
  moving_avg_cost numeric(12,5),
  effective_from timestamp with time zone default now() not null,
  effective_to timestamp with time zone,
  source text default 'MANUAL'::text not null,
  source_doc_id uuid,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.item_packaging_formats (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  name text not null,
  qty_in_base numeric(14,4) not null,
  parent_format_id uuid,
  created_at timestamp with time zone default now() not null,
  is_count_default boolean default false not null,
  is_purchase_default boolean default false not null
);

create table if not exists public.item_variants (
  id text not null,
  item_id text,
  name text not null,
  price numeric(10,2) default 0,
  sort_order integer default 0
);

create table if not exists public.kds_tickets (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  table_id text,
  table_label text,
  items jsonb default '[]'::jsonb,
  course text default 'main'::text,
  status text default 'pending'::text,
  sent_at timestamp with time zone default now(),
  bumped_at timestamp with time zone,
  centre_id text,
  server text,
  covers integer default 1,
  fired_courses integer[] default '{}'::integer[],
  all_courses integer[] default '{}'::integer[]
);

create table if not exists public.location_features (
  id uuid default uuid_generate_v4() not null,
  location_id uuid,
  feature text not null,
  enabled boolean default false,
  price_per_month numeric(8,2) default 0
);

create table if not exists public.locations (
  id uuid default uuid_generate_v4() not null,
  org_id uuid,
  name text not null,
  address text,
  timezone text default 'Europe/London'::text,
  currency text default 'GBP'::text,
  status text default 'active'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  show_item_images boolean default false,
  quick_screen_ids jsonb default '[]'::jsonb,
  receipt_branding jsonb,
  print_menu_config jsonb,
  pos_settings jsonb default '{}'::jsonb not null,
  quick_screen_mode text default 'manual'::text not null,
  quick_screen_auto jsonb
);

create table if not exists public.loyalty_transactions (
  id uuid default gen_random_uuid() not null,
  customer_id uuid not null,
  company_id uuid not null,
  location_id text not null,
  type text not null,
  points integer not null,
  balance_after integer not null,
  source text,
  channel text,
  closed_check_id text,
  reward_id uuid,
  idempotency_key text,
  qualifying_amount_minor integer,
  multiplier_applied numeric(5,2),
  earning_rule_id uuid,
  tier_at_time text,
  staff_id text,
  note text,
  created_at timestamp with time zone default now()
);

create table if not exists public.maintenance_notes (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  request_id uuid not null,
  author_id uuid,
  author_name text,
  note text not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.maintenance_requests (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  title text not null,
  description text,
  asset_type text,
  asset_id uuid,
  priority text default 'normal'::text not null,
  status text default 'open'::text not null,
  reporter_id uuid,
  reporter_name text,
  assignee_id uuid,
  assignee_name text,
  source text default 'manual'::text not null,
  source_ref uuid,
  photo_url text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone
);

create table if not exists public.maintenance_status_history (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  request_id uuid not null,
  from_status text,
  to_status text not null,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamp with time zone default now() not null
);

create table if not exists public.marketing_messages (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  company_id uuid,
  customer_id uuid,
  campaign_id uuid,
  workflow_id uuid,
  template_id uuid,
  channel text not null,
  to_address text not null,
  subject text,
  preview text,
  status text default 'queued'::text not null,
  provider text,
  provider_message_id text,
  error text,
  promo_code text,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  opened_at timestamp with time zone,
  clicked_at timestamp with time zone,
  idempotency_key text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.marketing_suppressions (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  channel text not null,
  address text not null,
  reason text default 'unsubscribe'::text not null,
  source text,
  customer_id uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.menu_board_screens (
  id uuid default gen_random_uuid() not null,
  device_uid uuid default auth.uid() not null,
  location_id uuid,
  org_id uuid,
  board_id uuid,
  code text not null,
  name text,
  status text default 'unpaired'::text not null,
  last_seen_at timestamp with time zone,
  paired_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.menu_boards (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text default 'Menu board'::text not null,
  orientation text default 'landscape'::text not null,
  mode text default 'menu'::text not null,
  layout jsonb default '{}'::jsonb not null,
  display_options jsonb default '{}'::jsonb not null,
  theme jsonb default '{}'::jsonb not null,
  marketing jsonb default '{}'::jsonb not null,
  published_at timestamp with time zone,
  version integer default 1 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.menu_categories (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  menu_id text,
  parent_id text,
  label text not null,
  icon text default '🍽'::text,
  color text default '#3b82f6'::text,
  accounting_group text default ''::text,
  sort_order integer default 0,
  is_special boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  default_course integer default 1,
  spacer_slots jsonb default '[]'::jsonb,
  scope text default 'local'::text not null,
  org_id uuid,
  master_id text,
  lock_pricing boolean default false not null
);

create table if not exists public.menu_category_links (
  id uuid default gen_random_uuid() not null,
  menu_id text not null,
  category_id text not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.menu_item_recipes (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  menu_item_id text not null,
  recipe_id uuid not null,
  portion numeric(10,4) default 1 not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.menu_items (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  name text not null,
  menu_name text,
  receipt_name text,
  kitchen_name text,
  description text default ''::text,
  type text default 'simple'::text,
  cat text,
  cats text[] default '{}'::text[],
  parent_id text,
  sort_order integer default 0,
  pricing jsonb default '{"base": 0}'::jsonb,
  allergens text[] default '{}'::text[],
  assigned_modifier_groups jsonb default '[]'::jsonb,
  assigned_instruction_groups jsonb default '[]'::jsonb,
  visibility jsonb default '{"pos": true, "kiosk": true, "online": true}'::jsonb,
  sold_alone boolean default false,
  archived boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  tax_rate_id uuid,
  tax_overrides jsonb default '{}'::jsonb,
  centre_id text,
  image text,
  scope text default 'local'::text not null,
  org_id uuid,
  master_id text,
  lock_pricing boolean default false not null,
  locked_fields jsonb default '[]'::jsonb not null,
  tags jsonb default '[]'::jsonb not null,
  option_group_order jsonb
);

create table if not exists public.menus (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  name text not null,
  description text default ''::text,
  is_default boolean default false,
  is_active boolean default true,
  sort_order integer default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  schedule jsonb,
  priority integer default 0 not null,
  scope text default 'local'::text not null,
  org_id uuid
);

create table if not exists public.modifier_groups (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  name text not null,
  min_select integer default 0,
  max_select integer default 1,
  sort_order integer default 0,
  min integer default 0,
  max integer default 1,
  selection_type text default 'single'::text,
  options jsonb default '[]'::jsonb,
  created_at timestamp with time zone default now()
);

create table if not exists public.modifier_options (
  id text not null,
  group_id text,
  name text not null,
  price numeric(10,2) default 0,
  sort_order integer default 0
);

create table if not exists public.offers (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  company_id uuid,
  name text not null,
  description text,
  reward_type text default 'fixed'::text not null,
  reward_value numeric(10,2) default 0 not null,
  reward_item_id text,
  reward_label text,
  min_spend numeric(10,2),
  include_category_ids text[] default '{}'::text[] not null,
  exclude_category_ids text[] default '{}'::text[] not null,
  valid_from timestamp with time zone,
  valid_to timestamp with time zone,
  venue_ids text[] default '{}'::text[] not null,
  per_customer_limit integer default 1 not null,
  total_cap integer,
  issued_count integer default 0 not null,
  redeemed_count integer default 0 not null,
  code_prefix text default ''::text not null,
  code_length integer default 5 not null,
  stackable boolean default false not null,
  active boolean default true not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.ops_alerts (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  type text not null,
  severity text default 'major'::text not null,
  title text not null,
  body text,
  source_type text,
  source_id uuid,
  target_role text,
  target_user_id uuid,
  status text default 'sent'::text not null,
  escalation_step integer default 0 not null,
  acknowledged_by uuid,
  acknowledged_by_name text,
  acknowledged_at timestamp with time zone,
  action_taken text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_audit (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  actor_id uuid,
  actor_name text,
  action text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb,
  prev_hash text,
  hash text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_checklist_runs (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  checklist_id uuid not null,
  run_date date not null,
  status text default 'open'::text not null,
  completed_by uuid,
  completed_by_name text,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_checklist_tasks (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  checklist_id uuid not null,
  label text not null,
  sort_order integer default 0 not null,
  task_type text default 'check'::text not null,
  evidence_required boolean default false not null,
  temp_unit_id uuid,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_checklists (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text not null,
  area text default 'BOH'::text not null,
  frequency text default 'daily'::text not null,
  days_of_week integer[] default '{}'::integer[] not null,
  time_of_day text,
  grace_minutes integer default 120 not null,
  assignee_role text,
  active boolean default true not null,
  archived_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  day_of_month integer
);

create table if not exists public.ops_devices (
  id uuid default gen_random_uuid() not null,
  location_id uuid,
  org_id uuid,
  device_uid uuid default auth.uid() not null,
  name text,
  claim_code text,
  claimed_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_notification_rules (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  event_type text not null,
  severity_min text default 'major'::text not null,
  channels jsonb default '["inapp"]'::jsonb not null,
  recipients jsonb default '[]'::jsonb not null,
  escalate_after_min integer default 15 not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.ops_task_completions (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  run_id uuid not null,
  task_id uuid not null,
  done boolean default true not null,
  value_text text,
  photo_url text,
  completed_by uuid,
  completed_by_name text,
  completed_at timestamp with time zone default now() not null
);

create table if not exists public.order_notifications (
  ref text not null,
  event text not null,
  sent_at timestamp with time zone default now() not null
);

create table if not exists public.order_queue (
  ref text not null,
  location_id text not null,
  type text not null,
  customer jsonb default '{}'::jsonb,
  items jsonb default '[]'::jsonb,
  total numeric(10,2) default 0,
  status text default 'received'::text,
  staff text,
  created_at timestamp with time zone default now(),
  sent_at timestamp with time zone,
  collection_time text,
  is_asap boolean default false,
  updated_at timestamp with time zone default now(),
  source text default 'pos'::text,
  kitchen_routed_at timestamp with time zone,
  paid boolean default false,
  payment_method text,
  event_date date,
  notify_confirmed_at timestamp with time zone,
  notify_ready_at timestamp with time zone
);

create table if not exists public.org_sending_domains (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  domain text not null,
  resend_domain_id text,
  region text default 'eu-west-1'::text not null,
  status text default 'not_started'::text not null,
  dns_records jsonb default '[]'::jsonb not null,
  from_name text,
  from_address text,
  reply_to text,
  is_active boolean default false not null,
  last_checked_at timestamp with time zone,
  verified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.organisations (
  id uuid default uuid_generate_v4() not null,
  name text not null,
  slug text,
  status text default 'active'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.par_levels (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  par_level numeric(14,4),
  reorder_point numeric(14,4),
  min_level numeric(14,4),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.po_lines (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  po_id uuid not null,
  inventory_item_id uuid,
  supplier_product_id uuid,
  description text,
  qty_packs numeric(14,4) default 1 not null,
  pack_qty numeric(14,4) default 1 not null,
  inner_qty numeric(14,4) default 1 not null,
  inner_unit text default 'each'::text not null,
  unit_price numeric(12,4) default 0 not null,
  qty_received numeric(14,4) default 0 not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  purchase_tax_rate_id uuid,
  line_tax numeric(14,2)
);

create table if not exists public.pos_nudges (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  table_label text,
  covers integer,
  wait_mins integer,
  by_name text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.prep_log (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  schedule_id uuid,
  name text not null,
  prep_date date not null,
  actual_qty numeric(12,3),
  unit text,
  recorded_by uuid,
  recorded_by_name text,
  recorded_at timestamp with time zone default now() not null,
  notes text
);

create table if not exists public.prep_schedule (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text not null,
  qty numeric(12,3),
  unit text,
  due_time time without time zone,
  days_of_week integer[],
  active boolean default true not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  output_item_id uuid,
  recipe_id uuid
);

create table if not exists public.print_jobs (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  printer_id text not null,
  printer_ip text,
  printer_port integer default 9100,
  job_type text not null,
  payload text not null,
  status text default 'pending'::text not null,
  error text,
  created_at timestamp with time zone default now(),
  printed_at timestamp with time zone,
  agent_id text,
  error_message text,
  processed_at timestamp with time zone,
  idempotency_key text,
  claimed_by text,
  claimed_at timestamp with time zone,
  claim_expires_at timestamp with time zone,
  attempts integer default 0,
  max_attempts integer default 5,
  next_retry_at timestamp with time zone,
  context jsonb,
  metadata jsonb,
  dismissed_at timestamp with time zone,
  kind text default 'print'::text
);

create table if not exists public.print_routing (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  centres jsonb default '[]'::jsonb,
  routing jsonb default '{}'::jsonb,
  updated_at timestamp with time zone default now()
);

create table if not exists public.printer_agents (
  id text not null,
  location_id uuid not null,
  hostname text,
  version text,
  last_seen timestamp with time zone default now(),
  printer_ids text[],
  status text default 'online'::text
);

create table if not exists public.printer_health (
  printer_id text not null,
  location_id uuid not null,
  status text default 'unknown'::text,
  last_job_at timestamp with time zone,
  last_success_at timestamp with time zone,
  last_error_at timestamp with time zone,
  last_error text,
  consecutive_failures integer default 0,
  updated_at timestamp with time zone default now()
);

create table if not exists public.printers (
  id text not null,
  location_id uuid not null,
  name text not null,
  type text default 'escpos'::text,
  connection text default 'network'::text,
  ip text,
  port integer default 9100,
  paper_width integer default 80,
  meta jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.production_batches (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  recipe_id uuid,
  output_item_id uuid,
  output_name text,
  planned_qty numeric(14,4),
  actual_qty numeric(14,4),
  output_unit text default 'each'::text not null,
  status text default 'DRAFT'::text not null,
  theoretical_cost numeric(14,4),
  actual_cost numeric(14,4),
  output_unit_cost numeric(12,5),
  lot_code text,
  expiry_at timestamp with time zone,
  produced_at timestamp with time zone,
  produced_by uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  schedule_id uuid,
  planned_for date,
  due_time time without time zone
);

create table if not exists public.promo_codes (
  id uuid default gen_random_uuid() not null,
  offer_id uuid not null,
  org_id uuid not null,
  company_id uuid,
  code text not null,
  customer_id uuid,
  status text default 'issued'::text not null,
  uses_allowed integer default 1 not null,
  uses_count integer default 0 not null,
  issued_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone,
  redeemed_at timestamp with time zone,
  redeemed_order_id text,
  redeemed_location_id text,
  redeemed_value numeric(10,2),
  redeemed_staff_id uuid,
  campaign_id uuid,
  message_id uuid,
  voided_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.promo_redemptions (
  id uuid default gen_random_uuid() not null,
  promo_code_id uuid not null,
  offer_id uuid not null,
  org_id uuid not null,
  code text not null,
  customer_id uuid,
  location_id text not null,
  order_id text,
  staff_id uuid,
  basket_value numeric(10,2),
  discount_value numeric(10,2),
  idempotency_key text,
  redeemed_at timestamp with time zone default now() not null
);

create table if not exists public.purchase_orders (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  supplier_id uuid,
  reference text,
  status text default 'DRAFT'::text not null,
  expected_date date,
  ordered_at timestamp with time zone,
  received_at timestamp with time zone,
  subtotal numeric(14,2),
  notes text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  tax numeric(14,2)
);

create table if not exists public.quote_accuracy (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  waitlist_entry_id text not null,
  party_band text,
  quoted_wait_min integer,
  actual_wait_min integer,
  recorded_at timestamp with time zone default now() not null
);

create table if not exists public.receipt_emails (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  check_id text,
  to_email text not null,
  subject text,
  status text default 'pending'::text not null,
  provider text,
  provider_message_id text,
  error text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create table if not exists public.recipe_lines (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  recipe_id uuid not null,
  component_item_id uuid not null,
  qty numeric(14,4) not null,
  unit text not null,
  usable_pct numeric(6,3) default 100 not null,
  sort_order integer default 0 not null,
  note text,
  created_at timestamp with time zone default now() not null,
  order_types jsonb
);

create table if not exists public.recipes (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  name text not null,
  recipe_type text default 'MENU'::text not null,
  output_item_id uuid,
  yield_qty numeric(14,4) default 1 not null,
  yield_unit text default 'each'::text not null,
  wastage_pct numeric(6,3) default 0 not null,
  gp_target_pct numeric(6,3),
  method text,
  photo text,
  status text default 'active'::text not null,
  archived_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.review_feedback (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  company_id uuid,
  customer_id uuid,
  customer_name text,
  customer_email text,
  customer_phone text,
  rating smallint not null,
  comment text,
  private_detail text,
  is_public boolean not null,
  origin text default 'card'::text not null,
  channel text,
  source_platform text,
  external_review_id text,
  published_to jsonb default '[]'::jsonb not null,
  status text default 'new'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.review_google_tokens (
  location_id text not null,
  company_id uuid,
  account_name text,
  location_name text,
  location_title text,
  account_email text,
  available jsonb default '[]'::jsonb not null,
  refresh_token text not null,
  scope text,
  connected_by uuid,
  connected_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.review_oauth_pending (
  nonce text not null,
  location_id text not null,
  company_id uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.review_platform_links (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  company_id uuid,
  platform text not null,
  enabled boolean default false not null,
  url text,
  external_place_id text,
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  last_attempt_at timestamp with time zone
);

create table if not exists public.review_replies (
  id uuid default gen_random_uuid() not null,
  feedback_id uuid not null,
  location_id text not null,
  kind text not null,
  ai_draft text,
  edited_text text,
  tone text,
  status text default 'pending'::text not null,
  approved_by uuid,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.review_requests (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  company_id uuid,
  source_kind text not null,
  source_ref text not null,
  customer_name text,
  customer_phone text,
  customer_email text,
  channel text,
  status text default 'queued'::text not null,
  suppressed_reason text,
  link text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.review_settings (
  location_id text not null,
  company_id uuid,
  enabled boolean default true not null,
  threshold smallint default 3 not null,
  page_title text,
  intro_copy text,
  thanks_public_copy text,
  thanks_private_copy text,
  ai_auto_draft boolean default true not null,
  ai_auto_send_hours integer,
  brand_voice text,
  custom_copy jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  ask_enabled boolean default false not null,
  ask_channel text default 'sms'::text not null,
  ask_delay_minutes integer default 45 not null,
  ask_delay_collection_minutes integer default 120 not null,
  ask_window_start smallint default 10 not null,
  ask_window_end smallint default 20 not null,
  ask_frequency_days integer default 60 not null,
  ask_message text,
  hero_image_url text,
  card_button_style text default 'dark'::text not null
);

create table if not exists public.review_themes (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  label text not null,
  count integer default 0 not null,
  sentiment text not null,
  period_start date,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.sections (
  id text not null,
  location_id text default 'loc-demo'::text not null,
  label text not null,
  color text default '#3b82f6'::text,
  icon text default '🍽'::text,
  sort_order integer default 0
);

create table if not exists public.segments (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  name text not null,
  description text,
  kind text default 'dynamic'::text not null,
  prebuilt_key text,
  definition jsonb default '{"match": "all", "rules": []}'::jsonb not null,
  member_count integer,
  last_computed_at timestamp with time zone,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.shifts (
  id text not null,
  location_id uuid not null,
  opened_at timestamp with time zone not null,
  opened_by_staff_id uuid,
  closed_at timestamp with time zone,
  closed_by_staff_id uuid,
  status text default 'open'::text,
  z_report jsonb,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.sms_messages (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  to_number text not null,
  from_number text not null,
  message text not null,
  type text default 'custom'::text not null,
  reference_id text,
  status text default 'pending'::text not null,
  sent_at timestamp with time zone,
  provider_message_id text,
  segments integer,
  error text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.staff_auth_events (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  staff_id text,
  method text not null,
  device_id text,
  approved_by text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.staff_members (
  id uuid default uuid_generate_v4() not null,
  location_id uuid,
  org_id uuid,
  name text not null,
  role text default 'Server'::text,
  pin text not null,
  color text default '#3b82f6'::text,
  initials text,
  active boolean default true,
  created_at timestamp with time zone default now(),
  permissions jsonb default '[]'::jsonb not null,
  nfc_card_id text,
  auth_method text default 'pin'::text not null
);

create table if not exists public.stamp_transactions (
  id uuid default gen_random_uuid() not null,
  customer_id uuid not null,
  program_id uuid not null,
  location_id uuid not null,
  stamps integer default 1,
  trigger_item_name text,
  order_ref text,
  type text default 'earn'::text,
  note text,
  created_at timestamp with time zone default now(),
  idempotency_key text
);

create table if not exists public.stock_count_lines (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  count_id uuid not null,
  inventory_item_id uuid not null,
  counted_qty numeric(14,4),
  expected_qty numeric(14,4),
  variance_qty numeric(14,4),
  unit_cost numeric(12,5),
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.stock_counts (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  name text,
  count_type text default 'FULL'::text not null,
  status text default 'DRAFT'::text not null,
  storage_area text,
  started_by uuid,
  started_at timestamp with time zone default now() not null,
  submitted_at timestamp with time zone,
  approved_by uuid,
  approved_at timestamp with time zone,
  variance_value numeric(14,2),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.stock_levels (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  item_id text not null,
  par integer not null,
  remaining integer default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.stock_movements (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  qty_base numeric(16,4) not null,
  unit_cost numeric(12,5),
  value_delta numeric(16,4),
  movement_type text not null,
  source_type text,
  source_id text,
  occurred_at timestamp with time zone default now() not null,
  posted_at timestamp with time zone default now() not null,
  created_by uuid,
  idempotency_key text,
  reversal_of uuid,
  notes text
);

create table if not exists public.stock_units (
  code text not null,
  dimension text not null,
  to_canonical numeric(20,8) not null,
  label text not null
);

create table if not exists public.subscriptions (
  id uuid default uuid_generate_v4() not null,
  org_id uuid,
  location_id uuid,
  plan text default 'free'::text,
  gmv_this_month numeric(12,2) default 0,
  gmv_last_month numeric(12,2) default 0,
  billing_period_start date,
  monthly_fee numeric(8,2) default 0,
  stripe_subscription_id text,
  stripe_customer_id text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.supplier_invoice_lines (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  invoice_id uuid not null,
  matched_item_id uuid,
  description text,
  qty numeric(14,4) default 0 not null,
  unit text default 'each'::text not null,
  unit_price numeric(12,4) default 0 not null,
  line_total numeric(14,2),
  flags jsonb default '[]'::jsonb not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  purchase_tax_rate_id uuid,
  line_tax numeric(14,2)
);

create table if not exists public.supplier_invoices (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  supplier_id uuid,
  po_id uuid,
  invoice_number text,
  invoice_date date,
  status text default 'REVIEW'::text not null,
  ocr_confidence numeric(5,2),
  subtotal numeric(14,2),
  tax numeric(14,2),
  total numeric(14,2),
  raw_json jsonb,
  posted_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  image_path text
);

create table if not exists public.supplier_products (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid not null,
  supplier_id uuid not null,
  supplier_sku text,
  pack_description text,
  pack_qty numeric(14,4) default 1 not null,
  inner_qty numeric(14,4) default 1 not null,
  inner_unit text not null,
  pack_price numeric(12,4) not null,
  is_preferred boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  purchase_tax_rate_id uuid,
  price_includes_tax boolean default false not null
);

create table if not exists public.suppliers (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text not null,
  contact_name text,
  email text,
  phone text,
  account_number text,
  payment_terms_days integer,
  min_order_value numeric(12,2),
  delivery_days jsonb default '[]'::jsonb not null,
  cutoff_time text,
  notes text,
  archived_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.table_reservations (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  table_id text not null,
  reservation jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.tax_rates (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  name text not null,
  code text,
  rate numeric(6,4) default 0 not null,
  type text default 'inclusive'::text not null,
  applies_to text[] default ARRAY['all'::text],
  is_default boolean default false,
  active boolean default true,
  created_at timestamp with time zone default now()
);

create table if not exists public.temp_check_schedules (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  temp_unit_id uuid not null,
  label text,
  frequency text default 'daily'::text not null,
  days_of_week integer[] default '{}'::integer[] not null,
  time_of_day text not null,
  grace_minutes integer default 60 not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.temp_readings (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  temp_unit_id uuid not null,
  schedule_id uuid,
  reading_c numeric(6,2) not null,
  in_range boolean not null,
  severity text default 'none'::text not null,
  source text default 'manual'::text not null,
  operator_id uuid,
  operator_name text,
  device_id uuid,
  notes text,
  recorded_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.temp_units (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  name text not null,
  type text default 'fridge'::text not null,
  area text,
  target_min_c numeric(6,2),
  target_max_c numeric(6,2),
  display_unit text default 'C'::text not null,
  guidance text,
  sort_order integer default 0 not null,
  active boolean default true not null,
  archived_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.terminal_devices (
  id uuid default gen_random_uuid() not null,
  device_uid uuid default auth.uid() not null,
  serial_number text not null,
  location_id uuid,
  org_id uuid,
  claim_code text,
  label text,
  ryft_terminal_id text,
  bound_pos_device_id uuid,
  tip_config jsonb,
  status text default 'unpaired'::text not null,
  active boolean default true not null,
  app_version text,
  pin_fail_count integer default 0 not null,
  pin_locked_until timestamp with time zone,
  last_seen_at timestamp with time zone,
  claimed_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  modes jsonb,
  idle_screen jsonb,
  adyen_terminal_id text
);

create table if not exists public.terminal_jobs (
  id uuid not null,
  check_key text not null,
  location_id uuid not null,
  target_terminal_id uuid not null,
  pos_device_id uuid,
  training boolean default false not null,
  tip_basis_minor bigint not null,
  due_minor bigint not null,
  tip_minor bigint,
  charge_minor bigint,
  reported_minor bigint,
  currency text default 'GBP'::text not null,
  tip_config jsonb not null,
  closed_check_id text not null,
  check_draft jsonb not null,
  status text default 'pending'::text not null,
  processor text default 'ryft'::text not null,
  transaction_id text,
  auth_code text,
  card jsonb,
  decline_reason text,
  simulated boolean default false not null,
  claimed_by uuid,
  claimed_at timestamp with time zone,
  claim_expires_at timestamp with time zone,
  reconcile_attempts integer default 0 not null,
  needs_human boolean default false not null,
  last_error text,
  created_at timestamp with time zone default now() not null,
  dispatched_at timestamp with time zone,
  charged_at timestamp with time zone,
  settled_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  acknowledged_total_minor bigint,
  payment_session_id text,
  account_id text,
  verified_source text,
  verified_at timestamp with time zone,
  nexo_service_id text
);

create table if not exists public.turn_time_stats (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  section_id text,
  party_band text not null,
  avg_turn_min numeric,
  sample_count integer default 0 not null,
  daypart text,
  window_start timestamp with time zone,
  window_end timestamp with time zone,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.user_locations (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  location_id uuid not null,
  created_at timestamp with time zone default now(),
  role text default 'manager'::text not null
);

create table if not exists public.user_profiles (
  id uuid not null,
  org_id uuid,
  location_id uuid,
  full_name text,
  role text default 'owner'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  email text,
  bo_access boolean default true
);

create table if not exists public.venue_uber_config (
  location_id text not null,
  company_id uuid,
  enabled boolean default false not null,
  uber_customer_id text,
  pickup_address jsonb,
  pickup_contact jsonb,
  radius_miles numeric default 3 not null,
  dispatch_backend text default 'uber_api'::text not null,
  surcharge_policy jsonb default '{"mode": "pass_through"}'::jsonb not null,
  fallback_fee_minor integer,
  sms_tracking boolean default true not null,
  env text default 'sandbox'::text not null,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  delivery_mode text default 'self'::text not null,
  flat_fee_minor integer,
  stuart_client_id text,
  stuart_client_secret text,
  stuart_env text
);

create table if not exists public.waitlist_config (
  location_id uuid not null,
  org_id uuid,
  buffer_min integer default 5 not null,
  round_to integer default 5 not null,
  max_quote integer default 120 not null,
  default_turn integer default 60 not null,
  bands jsonb,
  zones jsonb,
  sms_enabled boolean default true not null,
  sms_templates jsonb,
  updated_at timestamp with time zone default now() not null,
  self_service_enabled boolean default false not null
);

create table if not exists public.waitlist_devices (
  id uuid default gen_random_uuid() not null,
  device_uid uuid default auth.uid() not null,
  name text,
  claim_code text,
  location_id uuid,
  org_id uuid,
  active boolean default true not null,
  claimed_at timestamp with time zone,
  last_seen_at timestamp with time zone default now(),
  created_at timestamp with time zone default now() not null
);

create table if not exists public.waitlist_entries (
  id text not null,
  location_id uuid not null,
  org_id uuid,
  customer_id uuid,
  customer jsonb,
  party_name text default 'Guest'::text not null,
  phone text,
  party_size integer default 1 not null,
  quoted_wait_min integer,
  first_quote_min integer,
  quoted_at timestamp with time zone,
  status text default 'waiting'::text not null,
  section_pref text,
  notes text,
  seated_table_id text,
  source text default 'host'::text not null,
  added_at timestamp with time zone default now() not null,
  notified_at timestamp with time zone,
  ready_at timestamp with time zone,
  seated_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_by text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  confirmed_at timestamp with time zone,
  last_guest_reply text,
  last_reply_at timestamp with time zone,
  public_token text
);

create table if not exists public.waitlist_sms_inbound (
  id uuid default gen_random_uuid() not null,
  location_id uuid,
  org_id uuid,
  waitlist_entry_id text,
  from_number text not null,
  to_number text,
  body text,
  keyword text,
  action text,
  provider_sid text,
  received_at timestamp with time zone default now() not null
);

create table if not exists public.waitlist_status_events (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  waitlist_entry_id text not null,
  from_status text,
  to_status text not null,
  actor text,
  at timestamp with time zone default now() not null
);

create table if not exists public.waste_events (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  inventory_item_id uuid,
  item_name text,
  qty numeric(14,4) not null,
  unit text default 'each'::text not null,
  qty_base numeric(14,4),
  reason text,
  note text,
  cost_value numeric(14,2),
  source text default 'backoffice'::text not null,
  logged_by uuid,
  occurred_at timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  sale_value numeric(14,2)
);

create table if not exists public.wf_announcements (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  author_id uuid,
  author_name text,
  audience jsonb default '{}'::jsonb not null,
  channels jsonb default '[]'::jsonb not null,
  body text not null,
  sent_at timestamp with time zone,
  read_receipts jsonb default '[]'::jsonb not null,
  claims jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.wf_audit (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  actor_id uuid,
  actor_name text,
  action text not null,
  entity text,
  entity_id text,
  amount numeric(12,2),
  currency character(3),
  reason text,
  before jsonb,
  after jsonb,
  prev_hash text,
  row_hash text,
  at timestamp with time zone default now() not null
);

create table if not exists public.wf_availability (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  week_start date,
  recurring boolean default false not null,
  per_day jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_doc_templates (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  kind text not null,
  name text not null,
  body text default ''::text not null,
  contract_type text,
  is_default boolean default false not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_documents (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  type text not null,
  file_url text,
  status text default 'missing'::text not null,
  issued_on date,
  expiry date,
  verified_by uuid,
  verified_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_holiday_accrual (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  kind text default 'accrual'::text not null,
  period_start date,
  accrued_hours numeric(8,2) default 0 not null,
  accrued_pay numeric(12,2),
  accrual_rate numeric(6,5),
  currency character(3) default 'GBP'::bpchar not null,
  source_timesheet_id uuid,
  note text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.wf_onboarding (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  role_key text,
  steps jsonb default '[]'::jsonb not null,
  status text default 'inProgress'::text not null,
  first_shift_date date,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  meta jsonb default '{}'::jsonb not null
);

create table if not exists public.wf_payroll_runs (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  period_start date not null,
  period_end date not null,
  pay_date date,
  status text default 'completed'::text not null,
  totals jsonb default '{}'::jsonb not null,
  lines jsonb default '[]'::jsonb not null,
  policy jsonb default '{}'::jsonb not null,
  timesheet_ids uuid[] default '{}'::uuid[] not null,
  run_by uuid,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.wf_rate_changes (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid,
  target_kind text not null,
  role_key text,
  staff_id uuid,
  new_rate numeric(10,2),
  new_salary_annual numeric(12,2),
  effective_from date not null,
  status text default 'scheduled'::text not null,
  note text,
  created_by text,
  applied_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_roles (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  key text not null,
  label text not null,
  grp text not null,
  pay_type text default 'hourly'::text not null,
  base_rate numeric(10,2),
  salary_annual numeric(12,2),
  contracted_week numeric(5,2) default 40 not null,
  age_bands jsonb default '[]'::jsonb not null,
  tronc_weight numeric(6,2) default 1.0 not null,
  requires_sia boolean default false not null,
  premium_eligible boolean default true not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_sales_forecast (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  forecast_date date not null,
  currency character(3) default 'GBP'::bpchar not null,
  amount numeric(12,2) default 0 not null,
  actual_amount numeric(12,2),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_sections (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  name text not null,
  color text,
  min_coverage integer default 1 not null,
  peak_rules jsonb default '[]'::jsonb not null,
  sort_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_shifts (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  role_key text,
  section_id uuid,
  section text,
  shift_date date not null,
  start_time time without time zone not null,
  finish_time time without time zone not null,
  break_mins integer default 0 not null,
  status text default 'draft'::text not null,
  note text,
  premiums_applied jsonb default '[]'::jsonb not null,
  effective_rate numeric(10,2),
  rate_source text,
  currency character(3) default 'GBP'::bpchar not null,
  computed_hours numeric(6,2),
  computed_cost numeric(10,2),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_staff (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  location_id uuid not null,
  name text not null,
  photo_url text,
  role_key text,
  section_ids uuid[] default '{}'::uuid[] not null,
  primary_venue_id uuid,
  venue_ids uuid[] default '{}'::uuid[] not null,
  contract_type text default 'partTime'::text not null,
  contracted_week numeric(5,2),
  weekly_hours_target numeric(6,2),
  holiday_entitlement_days numeric(5,2),
  rate_override numeric(10,2),
  dob date,
  ni_number text,
  tax_ref text,
  bank_sort_code text,
  bank_account_masked text,
  address text,
  emergency_contact jsonb,
  mobile text,
  email text,
  right_to_work jsonb default '{"status": "missing"}'::jsonb not null,
  start_date date,
  status text default 'active'::text not null,
  leaver_date date,
  pos_user_id uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  bank_account text,
  bank_account_name text
);

create table if not exists public.wf_swap_requests (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  shift_id uuid,
  from_staff_id uuid not null,
  to_staff_id uuid,
  status text default 'open'::text not null,
  coverage_ok boolean,
  eligibility_checks jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_time_off (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  type text not null,
  start_date date not null,
  end_date date not null,
  days numeric(5,2),
  note text,
  status text default 'pending'::text not null,
  decided_by uuid,
  decided_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_timesheets (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  shift_id uuid,
  staff_id uuid not null,
  clock_in timestamp with time zone,
  clock_out timestamp with time zone,
  break_taken integer default 0 not null,
  scheduled_hours numeric(6,2),
  actual_hours numeric(6,2),
  variance numeric(6,2),
  effective_rate numeric(10,2),
  rate_source text,
  currency character(3) default 'GBP'::bpchar not null,
  pay_amount numeric(10,2),
  status text default 'pending'::text not null,
  approved_by uuid,
  approved_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  break_open_at timestamp with time zone,
  breaks jsonb default '[]'::jsonb not null,
  paid_break_mins integer default 0 not null,
  payroll_run_id uuid
);

create table if not exists public.wf_tronc_lines (
  id uuid default gen_random_uuid() not null,
  run_id uuid not null,
  location_id uuid not null,
  org_id uuid not null,
  staff_id uuid not null,
  hours numeric(8,2) default 0 not null,
  points numeric(8,2) default 0 not null,
  units numeric(14,6) default 0 not null,
  share_pct numeric(9,6) default 0 not null,
  payout numeric(12,2) default 0 not null,
  currency character(3) default 'GBP'::bpchar not null,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.wf_tronc_runs (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  week_start date not null,
  currency character(3) default 'GBP'::bpchar not null,
  pool numeric(12,2) default 0 not null,
  units_total numeric(14,6),
  point_value numeric(14,6),
  total_paid numeric(12,2) default 0 not null,
  residual numeric(12,2) default 0 not null,
  status text default 'draft'::text not null,
  lines jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_user_roles (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  org_id uuid not null,
  user_id uuid not null,
  staff_id uuid,
  role text default 'staff'::text not null,
  venue_scope uuid[] default '{}'::uuid[] not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.wf_venue_settings (
  location_id uuid not null,
  org_id uuid not null,
  currency character(3) default 'GBP'::bpchar not null,
  labour_target_pct numeric(5,4) default 0.2800 not null,
  accrual_rate numeric(6,5) default 0.12070 not null,
  premiums jsonb default '{}'::jsonb not null,
  sales_source text default 'pos'::text not null,
  settings jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  pay_period_type text default 'monthly'::text not null,
  pay_period_start_day integer default 1 not null,
  pay_period_anchor date,
  pay_day integer
);

create table if not exists public.wifi_captures (
  id uuid default gen_random_uuid() not null,
  location_id text not null,
  company_id uuid,
  customer_id uuid,
  client_mac text,
  ap_mac text,
  ssid text,
  is_return boolean default false not null,
  marketing_opt_in boolean default false not null,
  authorized boolean default false not null,
  auth_method text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.wifi_portal_settings (
  location_id text not null,
  company_id uuid,
  enabled boolean default true not null,
  headline text default 'Connect to free WiFi'::text,
  subtext text,
  bg_image_url text,
  logo_url text,
  accent_color text,
  button_style text default 'dark'::text not null,
  fields jsonb default '{"dob": {"show": true, "required": true}, "email": {"show": true, "required": true}, "phone": {"show": true, "required": false}, "is_local": {"show": true, "required": false}, "last_name": {"show": true, "required": false}, "first_name": {"show": true, "required": true}}'::jsonb not null,
  age_gate boolean default true not null,
  marketing_copy text default 'Keep me updated with news, offers and events by email and SMS.'::text,
  success_copy text default 'You''re connected. Enjoy your visit!'::text,
  redirect_url text,
  terms_url text,
  privacy_url text,
  privacy_version text default 'v1'::text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  loyalty_offer boolean default false not null,
  loyalty_copy text default 'Join our rewards — earn points and get exclusive offers by email & SMS.'::text,
  marketing_offer boolean default true not null,
  marketing_required boolean default false not null
);

create table if not exists public.wifi_unifi_bindings (
  location_id text not null,
  company_id uuid,
  auth_method text default 'none'::text not null,
  controller_url text,
  site_id text,
  ssid text,
  api_key_enc text,
  admin_user_enc text,
  admin_pass_enc text,
  voucher_pool jsonb,
  auth_minutes integer default 1440 not null,
  data_limit_mb integer,
  down_kbps integer,
  up_kbps integer,
  last_authorize_at timestamp with time zone,
  last_error text,
  connected_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  console_id text,
  totp_secret_enc text
);

create table if not exists public.workflow_enrollments (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  workflow_id uuid not null,
  customer_id uuid not null,
  status text default 'active'::text not null,
  current_step integer default 0 not null,
  next_run_at timestamp with time zone,
  enrolled_at timestamp with time zone default now() not null,
  completed_at timestamp with time zone
);

create table if not exists public.workflow_step_sends (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  workflow_id uuid not null,
  enrollment_id uuid not null,
  customer_id uuid not null,
  step_key text not null,
  channel text,
  email_message_id uuid,
  sms_message_id uuid,
  promo_code text,
  status text default 'pending'::text not null,
  error text,
  created_at timestamp with time zone default now() not null
);

create table if not exists public.workflows (
  id uuid default gen_random_uuid() not null,
  org_id uuid not null,
  name text not null,
  description text,
  status text default 'draft'::text not null,
  entry_trigger jsonb default '{}'::jsonb not null,
  segment_id uuid,
  steps jsonb default '[]'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.xero_config (
  location_id uuid not null,
  sales_account_code text,
  tax_type text,
  clearing_account_code text,
  cash_account_code text,
  post_mode text default 'invoice'::text not null,
  auto_daily boolean default false not null,
  updated_at timestamp with time zone default now() not null,
  detail jsonb,
  mapping jsonb
);

create table if not exists public.xero_connections (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  tenant_id text not null,
  tenant_name text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamp with time zone not null,
  scopes text,
  connected_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.xero_sync_log (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  kind text not null,
  ref_date date,
  ref_id text,
  xero_id text,
  status text default 'ok'::text not null,
  detail jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- --------------------------------------------------------------------------
-- 3a. PRIMARY KEYS  (161)
-- Guarded with IF NOT EXISTS rather than DROP/ADD: dropping a live
-- primary key would cascade to its foreign keys.
-- --------------------------------------------------------------------------

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.active_sessions'::regclass and conname = 'active_sessions_pkey') then
    alter table public.active_sessions add constraint active_sessions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.activity_events'::regclass and conname = 'activity_events_pkey') then
    alter table public.activity_events add constraint activity_events_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.bar_tabs'::regclass and conname = 'bar_tabs_pkey') then
    alter table public.bar_tabs add constraint bar_tabs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaign_runs'::regclass and conname = 'campaign_runs_pkey') then
    alter table public.campaign_runs add constraint campaign_runs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaign_sends'::regclass and conname = 'campaign_sends_pkey') then
    alter table public.campaign_sends add constraint campaign_sends_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_pkey') then
    alter table public.campaigns add constraint campaigns_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_drawers'::regclass and conname = 'cash_drawers_pkey') then
    alter table public.cash_drawers add constraint cash_drawers_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and conname = 'cash_movements_pkey') then
    alter table public.cash_movements add constraint cash_movements_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.catering_site_settings'::regclass and conname = 'catering_site_settings_pkey') then
    alter table public.catering_site_settings add constraint catering_site_settings_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.challenge_21_checks'::regclass and conname = 'challenge_21_checks_pkey') then
    alter table public.challenge_21_checks add constraint challenge_21_checks_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.closed_checks'::regclass and conname = 'closed_checks_pkey') then
    alter table public.closed_checks add constraint closed_checks_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.config_pushes'::regclass and conname = 'config_pushes_pkey') then
    alter table public.config_pushes add constraint config_pushes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.corrective_actions'::regclass and conname = 'corrective_actions_pkey') then
    alter table public.corrective_actions add constraint corrective_actions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.courier_deliveries'::regclass and conname = 'courier_deliveries_pkey') then
    alter table public.courier_deliveries add constraint courier_deliveries_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_consents'::regclass and conname = 'customer_consents_pkey') then
    alter table public.customer_consents add constraint customer_consents_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_locations'::regclass and conname = 'customer_locations_pkey') then
    alter table public.customer_locations add constraint customer_locations_pkey PRIMARY KEY (customer_id, location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_orders'::regclass and conname = 'customer_orders_pkey') then
    alter table public.customer_orders add constraint customer_orders_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customers'::regclass and conname = 'customers_pkey') then
    alter table public.customers add constraint customers_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deliveries'::regclass and conname = 'deliveries_pkey') then
    alter table public.deliveries add constraint deliveries_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.delivery_costs_actual'::regclass and conname = 'delivery_costs_actual_pkey') then
    alter table public.delivery_costs_actual add constraint delivery_costs_actual_pkey PRIMARY KEY (delivery_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.delivery_quotes'::regclass and conname = 'delivery_quotes_pkey') then
    alter table public.delivery_quotes add constraint delivery_quotes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.delivery_status_events'::regclass and conname = 'delivery_status_events_pkey') then
    alter table public.delivery_status_events add constraint delivery_status_events_pkey PRIMARY KEY (event_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.delivery_surcharges'::regclass and conname = 'delivery_surcharges_pkey') then
    alter table public.delivery_surcharges add constraint delivery_surcharges_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.device_heartbeats'::regclass and conname = 'device_heartbeats_pkey') then
    alter table public.device_heartbeats add constraint device_heartbeats_pkey PRIMARY KEY (device_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.device_profiles'::regclass and conname = 'device_profiles_pkey') then
    alter table public.device_profiles add constraint device_profiles_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.devices'::regclass and conname = 'devices_pkey') then
    alter table public.devices add constraint devices_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.discount_rules'::regclass and conname = 'discount_rules_pkey') then
    alter table public.discount_rules add constraint discount_rules_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.discounts'::regclass and conname = 'discounts_pkey') then
    alter table public.discounts add constraint discounts_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.drawer_sessions'::regclass and conname = 'drawer_sessions_pkey') then
    alter table public.drawer_sessions add constraint drawer_sessions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.eighty_six'::regclass and conname = 'eighty_six_pkey') then
    alter table public.eighty_six add constraint eighty_six_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.floor_tables'::regclass and conname = 'floor_tables_pkey') then
    alter table public.floor_tables add constraint floor_tables_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_connections'::regclass and conname = 'hubrise_connections_pkey') then
    alter table public.hubrise_connections add constraint hubrise_connections_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_events'::regclass and conname = 'hubrise_events_pkey') then
    alter table public.hubrise_events add constraint hubrise_events_pkey PRIMARY KEY (event_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_oauth_pending'::regclass and conname = 'hubrise_oauth_pending_pkey') then
    alter table public.hubrise_oauth_pending add constraint hubrise_oauth_pending_pkey PRIMARY KEY (state);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_order_links'::regclass and conname = 'hubrise_order_links_pkey') then
    alter table public.hubrise_order_links add constraint hubrise_order_links_pkey PRIMARY KEY (ref);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_item_conversions'::regclass and conname = 'inventory_item_conversions_pkey') then
    alter table public.inventory_item_conversions add constraint inventory_item_conversions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_pkey') then
    alter table public.inventory_items add constraint inventory_items_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_cost_history'::regclass and conname = 'item_cost_history_pkey') then
    alter table public.item_cost_history add constraint item_cost_history_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_packaging_formats'::regclass and conname = 'item_packaging_formats_pkey') then
    alter table public.item_packaging_formats add constraint item_packaging_formats_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_variants'::regclass and conname = 'item_variants_pkey') then
    alter table public.item_variants add constraint item_variants_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.kds_tickets'::regclass and conname = 'kds_tickets_pkey') then
    alter table public.kds_tickets add constraint kds_tickets_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.location_features'::regclass and conname = 'location_features_pkey') then
    alter table public.location_features add constraint location_features_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations'::regclass and conname = 'locations_pkey') then
    alter table public.locations add constraint locations_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.loyalty_transactions'::regclass and conname = 'loyalty_transactions_pkey') then
    alter table public.loyalty_transactions add constraint loyalty_transactions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_notes'::regclass and conname = 'maintenance_notes_pkey') then
    alter table public.maintenance_notes add constraint maintenance_notes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_requests'::regclass and conname = 'maintenance_requests_pkey') then
    alter table public.maintenance_requests add constraint maintenance_requests_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_status_history'::regclass and conname = 'maintenance_status_history_pkey') then
    alter table public.maintenance_status_history add constraint maintenance_status_history_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_messages'::regclass and conname = 'marketing_messages_pkey') then
    alter table public.marketing_messages add constraint marketing_messages_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_suppressions'::regclass and conname = 'marketing_suppressions_pkey') then
    alter table public.marketing_suppressions add constraint marketing_suppressions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_board_screens'::regclass and conname = 'menu_board_screens_pkey') then
    alter table public.menu_board_screens add constraint menu_board_screens_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_boards'::regclass and conname = 'menu_boards_pkey') then
    alter table public.menu_boards add constraint menu_boards_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_pkey') then
    alter table public.menu_categories add constraint menu_categories_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_category_links'::regclass and conname = 'menu_category_links_pkey') then
    alter table public.menu_category_links add constraint menu_category_links_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_item_recipes'::regclass and conname = 'menu_item_recipes_pkey') then
    alter table public.menu_item_recipes add constraint menu_item_recipes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_pkey') then
    alter table public.menu_items add constraint menu_items_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menus'::regclass and conname = 'menus_pkey') then
    alter table public.menus add constraint menus_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.modifier_groups'::regclass and conname = 'modifier_groups_pkey') then
    alter table public.modifier_groups add constraint modifier_groups_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.modifier_options'::regclass and conname = 'modifier_options_pkey') then
    alter table public.modifier_options add constraint modifier_options_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.offers'::regclass and conname = 'offers_pkey') then
    alter table public.offers add constraint offers_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_alerts'::regclass and conname = 'ops_alerts_pkey') then
    alter table public.ops_alerts add constraint ops_alerts_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_audit'::regclass and conname = 'ops_audit_pkey') then
    alter table public.ops_audit add constraint ops_audit_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_runs'::regclass and conname = 'ops_checklist_runs_pkey') then
    alter table public.ops_checklist_runs add constraint ops_checklist_runs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_tasks'::regclass and conname = 'ops_checklist_tasks_pkey') then
    alter table public.ops_checklist_tasks add constraint ops_checklist_tasks_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklists'::regclass and conname = 'ops_checklists_pkey') then
    alter table public.ops_checklists add constraint ops_checklists_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_devices'::regclass and conname = 'ops_devices_pkey') then
    alter table public.ops_devices add constraint ops_devices_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_notification_rules'::regclass and conname = 'ops_notification_rules_pkey') then
    alter table public.ops_notification_rules add constraint ops_notification_rules_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_task_completions'::regclass and conname = 'ops_task_completions_pkey') then
    alter table public.ops_task_completions add constraint ops_task_completions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.order_notifications'::regclass and conname = 'order_notifications_pkey') then
    alter table public.order_notifications add constraint order_notifications_pkey PRIMARY KEY (ref, event);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.order_queue'::regclass and conname = 'order_queue_pkey') then
    alter table public.order_queue add constraint order_queue_pkey PRIMARY KEY (ref);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_sending_domains'::regclass and conname = 'org_sending_domains_pkey') then
    alter table public.org_sending_domains add constraint org_sending_domains_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organisations'::regclass and conname = 'organisations_pkey') then
    alter table public.organisations add constraint organisations_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.par_levels'::regclass and conname = 'par_levels_pkey') then
    alter table public.par_levels add constraint par_levels_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.po_lines'::regclass and conname = 'po_lines_pkey') then
    alter table public.po_lines add constraint po_lines_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.pos_nudges'::regclass and conname = 'pos_nudges_pkey') then
    alter table public.pos_nudges add constraint pos_nudges_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.prep_log'::regclass and conname = 'prep_log_pkey') then
    alter table public.prep_log add constraint prep_log_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.prep_schedule'::regclass and conname = 'prep_schedule_pkey') then
    alter table public.prep_schedule add constraint prep_schedule_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.print_jobs'::regclass and conname = 'print_jobs_pkey') then
    alter table public.print_jobs add constraint print_jobs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.print_routing'::regclass and conname = 'print_routing_pkey') then
    alter table public.print_routing add constraint print_routing_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.printer_agents'::regclass and conname = 'printer_agents_pkey') then
    alter table public.printer_agents add constraint printer_agents_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.printer_health'::regclass and conname = 'printer_health_pkey') then
    alter table public.printer_health add constraint printer_health_pkey PRIMARY KEY (printer_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.printers'::regclass and conname = 'printers_pkey') then
    alter table public.printers add constraint printers_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.production_batches'::regclass and conname = 'production_batches_pkey') then
    alter table public.production_batches add constraint production_batches_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_pkey') then
    alter table public.promo_codes add constraint promo_codes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.promo_redemptions'::regclass and conname = 'promo_redemptions_pkey') then
    alter table public.promo_redemptions add constraint promo_redemptions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.purchase_orders'::regclass and conname = 'purchase_orders_pkey') then
    alter table public.purchase_orders add constraint purchase_orders_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_accuracy'::regclass and conname = 'quote_accuracy_pkey') then
    alter table public.quote_accuracy add constraint quote_accuracy_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.receipt_emails'::regclass and conname = 'receipt_emails_pkey') then
    alter table public.receipt_emails add constraint receipt_emails_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipe_lines'::regclass and conname = 'recipe_lines_pkey') then
    alter table public.recipe_lines add constraint recipe_lines_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipes'::regclass and conname = 'recipes_pkey') then
    alter table public.recipes add constraint recipes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_pkey') then
    alter table public.review_feedback add constraint review_feedback_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_google_tokens'::regclass and conname = 'review_google_tokens_pkey') then
    alter table public.review_google_tokens add constraint review_google_tokens_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_oauth_pending'::regclass and conname = 'review_oauth_pending_pkey') then
    alter table public.review_oauth_pending add constraint review_oauth_pending_pkey PRIMARY KEY (nonce);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_platform_links'::regclass and conname = 'review_platform_links_pkey') then
    alter table public.review_platform_links add constraint review_platform_links_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_replies'::regclass and conname = 'review_replies_pkey') then
    alter table public.review_replies add constraint review_replies_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_requests'::regclass and conname = 'review_requests_pkey') then
    alter table public.review_requests add constraint review_requests_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_settings'::regclass and conname = 'review_settings_pkey') then
    alter table public.review_settings add constraint review_settings_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_themes'::regclass and conname = 'review_themes_pkey') then
    alter table public.review_themes add constraint review_themes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sections'::regclass and conname = 'sections_pkey') then
    alter table public.sections add constraint sections_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.segments'::regclass and conname = 'segments_pkey') then
    alter table public.segments add constraint segments_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.shifts'::regclass and conname = 'shifts_pkey') then
    alter table public.shifts add constraint shifts_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sms_messages'::regclass and conname = 'sms_messages_pkey') then
    alter table public.sms_messages add constraint sms_messages_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_auth_events'::regclass and conname = 'staff_auth_events_pkey') then
    alter table public.staff_auth_events add constraint staff_auth_events_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_members'::regclass and conname = 'staff_members_pkey') then
    alter table public.staff_members add constraint staff_members_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stamp_transactions'::regclass and conname = 'stamp_transactions_pkey') then
    alter table public.stamp_transactions add constraint stamp_transactions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_count_lines'::regclass and conname = 'stock_count_lines_pkey') then
    alter table public.stock_count_lines add constraint stock_count_lines_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_counts'::regclass and conname = 'stock_counts_pkey') then
    alter table public.stock_counts add constraint stock_counts_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_levels'::regclass and conname = 'stock_levels_pkey') then
    alter table public.stock_levels add constraint stock_levels_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_movements'::regclass and conname = 'stock_movements_pkey') then
    alter table public.stock_movements add constraint stock_movements_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_units'::regclass and conname = 'stock_units_pkey') then
    alter table public.stock_units add constraint stock_units_pkey PRIMARY KEY (code);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_pkey') then
    alter table public.subscriptions add constraint subscriptions_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoice_lines'::regclass and conname = 'supplier_invoice_lines_pkey') then
    alter table public.supplier_invoice_lines add constraint supplier_invoice_lines_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoices'::regclass and conname = 'supplier_invoices_pkey') then
    alter table public.supplier_invoices add constraint supplier_invoices_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_products'::regclass and conname = 'supplier_products_pkey') then
    alter table public.supplier_products add constraint supplier_products_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.suppliers'::regclass and conname = 'suppliers_pkey') then
    alter table public.suppliers add constraint suppliers_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.table_reservations'::regclass and conname = 'table_reservations_pkey') then
    alter table public.table_reservations add constraint table_reservations_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.tax_rates'::regclass and conname = 'tax_rates_pkey') then
    alter table public.tax_rates add constraint tax_rates_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_check_schedules'::regclass and conname = 'temp_check_schedules_pkey') then
    alter table public.temp_check_schedules add constraint temp_check_schedules_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_readings'::regclass and conname = 'temp_readings_pkey') then
    alter table public.temp_readings add constraint temp_readings_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_units'::regclass and conname = 'temp_units_pkey') then
    alter table public.temp_units add constraint temp_units_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_devices'::regclass and conname = 'terminal_devices_pkey') then
    alter table public.terminal_devices add constraint terminal_devices_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_pkey') then
    alter table public.terminal_jobs add constraint terminal_jobs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.turn_time_stats'::regclass and conname = 'turn_time_stats_pkey') then
    alter table public.turn_time_stats add constraint turn_time_stats_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_locations'::regclass and conname = 'user_locations_pkey') then
    alter table public.user_locations add constraint user_locations_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_profiles'::regclass and conname = 'user_profiles_pkey') then
    alter table public.user_profiles add constraint user_profiles_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.venue_uber_config'::regclass and conname = 'venue_uber_config_pkey') then
    alter table public.venue_uber_config add constraint venue_uber_config_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_config'::regclass and conname = 'waitlist_config_pkey') then
    alter table public.waitlist_config add constraint waitlist_config_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_devices'::regclass and conname = 'waitlist_devices_pkey') then
    alter table public.waitlist_devices add constraint waitlist_devices_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_entries'::regclass and conname = 'waitlist_entries_pkey') then
    alter table public.waitlist_entries add constraint waitlist_entries_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_sms_inbound'::regclass and conname = 'waitlist_sms_inbound_pkey') then
    alter table public.waitlist_sms_inbound add constraint waitlist_sms_inbound_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_status_events'::regclass and conname = 'waitlist_status_events_pkey') then
    alter table public.waitlist_status_events add constraint waitlist_status_events_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waste_events'::regclass and conname = 'waste_events_pkey') then
    alter table public.waste_events add constraint waste_events_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_announcements'::regclass and conname = 'wf_announcements_pkey') then
    alter table public.wf_announcements add constraint wf_announcements_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_audit'::regclass and conname = 'wf_audit_pkey') then
    alter table public.wf_audit add constraint wf_audit_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_availability'::regclass and conname = 'wf_availability_pkey') then
    alter table public.wf_availability add constraint wf_availability_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_doc_templates'::regclass and conname = 'wf_doc_templates_pkey') then
    alter table public.wf_doc_templates add constraint wf_doc_templates_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_documents'::regclass and conname = 'wf_documents_pkey') then
    alter table public.wf_documents add constraint wf_documents_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_pkey') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_onboarding'::regclass and conname = 'wf_onboarding_pkey') then
    alter table public.wf_onboarding add constraint wf_onboarding_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_payroll_runs'::regclass and conname = 'wf_payroll_runs_pkey') then
    alter table public.wf_payroll_runs add constraint wf_payroll_runs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_pkey') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_pkey') then
    alter table public.wf_roles add constraint wf_roles_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sales_forecast'::regclass and conname = 'wf_sales_forecast_pkey') then
    alter table public.wf_sales_forecast add constraint wf_sales_forecast_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sections'::regclass and conname = 'wf_sections_pkey') then
    alter table public.wf_sections add constraint wf_sections_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_pkey') then
    alter table public.wf_shifts add constraint wf_shifts_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_pkey') then
    alter table public.wf_staff add constraint wf_staff_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_swap_requests'::regclass and conname = 'wf_swap_requests_pkey') then
    alter table public.wf_swap_requests add constraint wf_swap_requests_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_time_off'::regclass and conname = 'wf_time_off_pkey') then
    alter table public.wf_time_off add constraint wf_time_off_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_pkey') then
    alter table public.wf_timesheets add constraint wf_timesheets_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_pkey') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_runs'::regclass and conname = 'wf_tronc_runs_pkey') then
    alter table public.wf_tronc_runs add constraint wf_tronc_runs_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_user_roles'::regclass and conname = 'wf_user_roles_pkey') then
    alter table public.wf_user_roles add constraint wf_user_roles_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_venue_settings'::regclass and conname = 'wf_venue_settings_pkey') then
    alter table public.wf_venue_settings add constraint wf_venue_settings_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_captures'::regclass and conname = 'wifi_captures_pkey') then
    alter table public.wifi_captures add constraint wifi_captures_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_portal_settings'::regclass and conname = 'wifi_portal_settings_pkey') then
    alter table public.wifi_portal_settings add constraint wifi_portal_settings_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_unifi_bindings'::regclass and conname = 'wifi_unifi_bindings_pkey') then
    alter table public.wifi_unifi_bindings add constraint wifi_unifi_bindings_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflow_enrollments'::regclass and conname = 'workflow_enrollments_pkey') then
    alter table public.workflow_enrollments add constraint workflow_enrollments_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflow_step_sends'::regclass and conname = 'workflow_step_sends_pkey') then
    alter table public.workflow_step_sends add constraint workflow_step_sends_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflows'::regclass and conname = 'workflows_pkey') then
    alter table public.workflows add constraint workflows_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.xero_config'::regclass and conname = 'xero_config_pkey') then
    alter table public.xero_config add constraint xero_config_pkey PRIMARY KEY (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.xero_connections'::regclass and conname = 'xero_connections_pkey') then
    alter table public.xero_connections add constraint xero_connections_pkey PRIMARY KEY (id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.xero_sync_log'::regclass and conname = 'xero_sync_log_pkey') then
    alter table public.xero_sync_log add constraint xero_sync_log_pkey PRIMARY KEY (id);
  end if;
end $do$;

-- --------------------------------------------------------------------------
-- 3b. UNIQUE CONSTRAINTS  (30)
-- These are the ones a reviewer could not verify from source.
-- --------------------------------------------------------------------------

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.active_sessions'::regclass and conname = 'active_sessions_location_id_table_id_key') then
    alter table public.active_sessions add constraint active_sessions_location_id_table_id_key UNIQUE (location_id, table_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_drawers'::regclass and conname = 'cash_drawers_device_id_key') then
    alter table public.cash_drawers add constraint cash_drawers_device_id_key UNIQUE (device_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.catering_site_settings'::regclass and conname = 'catering_site_settings_location_id_key') then
    alter table public.catering_site_settings add constraint catering_site_settings_location_id_key UNIQUE (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.devices'::regclass and conname = 'devices_pairing_code_key') then
    alter table public.devices add constraint devices_pairing_code_key UNIQUE (pairing_code);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.eighty_six'::regclass and conname = 'eighty_six_location_id_item_id_key') then
    alter table public.eighty_six add constraint eighty_six_location_id_item_id_key UNIQUE (location_id, item_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.location_features'::regclass and conname = 'location_features_location_id_feature_key') then
    alter table public.location_features add constraint location_features_location_id_feature_key UNIQUE (location_id, feature);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations'::regclass and conname = 'locations_id_org_uniq') then
    alter table public.locations add constraint locations_id_org_uniq UNIQUE (id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.loyalty_transactions'::regclass and conname = 'loyalty_transactions_idempotency_key_key') then
    alter table public.loyalty_transactions add constraint loyalty_transactions_idempotency_key_key UNIQUE (idempotency_key);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_category_links'::regclass and conname = 'menu_category_links_menu_id_category_id_key') then
    alter table public.menu_category_links add constraint menu_category_links_menu_id_category_id_key UNIQUE (menu_id, category_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_item_recipes'::regclass and conname = 'menu_item_recipes_location_id_menu_item_id_key') then
    alter table public.menu_item_recipes add constraint menu_item_recipes_location_id_menu_item_id_key UNIQUE (location_id, menu_item_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_runs'::regclass and conname = 'ops_checklist_runs_location_id_checklist_id_run_date_key') then
    alter table public.ops_checklist_runs add constraint ops_checklist_runs_location_id_checklist_id_run_date_key UNIQUE (location_id, checklist_id, run_date);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_task_completions'::regclass and conname = 'ops_task_completions_run_id_task_id_key') then
    alter table public.ops_task_completions add constraint ops_task_completions_run_id_task_id_key UNIQUE (run_id, task_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_sending_domains'::regclass and conname = 'org_sending_domains_org_id_domain_key') then
    alter table public.org_sending_domains add constraint org_sending_domains_org_id_domain_key UNIQUE (org_id, domain);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organisations'::regclass and conname = 'organisations_slug_key') then
    alter table public.organisations add constraint organisations_slug_key UNIQUE (slug);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.par_levels'::regclass and conname = 'par_levels_location_id_inventory_item_id_key') then
    alter table public.par_levels add constraint par_levels_location_id_inventory_item_id_key UNIQUE (location_id, inventory_item_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.print_routing'::regclass and conname = 'print_routing_location_id_key') then
    alter table public.print_routing add constraint print_routing_location_id_key UNIQUE (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_platform_links'::regclass and conname = 'review_platform_links_location_id_platform_key') then
    alter table public.review_platform_links add constraint review_platform_links_location_id_platform_key UNIQUE (location_id, platform);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_requests'::regclass and conname = 'review_requests_location_id_source_kind_source_ref_key') then
    alter table public.review_requests add constraint review_requests_location_id_source_kind_source_ref_key UNIQUE (location_id, source_kind, source_ref);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_levels'::regclass and conname = 'stock_levels_location_id_item_id_key') then
    alter table public.stock_levels add constraint stock_levels_location_id_item_id_key UNIQUE (location_id, item_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_location_id_key') then
    alter table public.subscriptions add constraint subscriptions_location_id_key UNIQUE (location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.table_reservations'::regclass and conname = 'table_reservations_location_id_table_id_key') then
    alter table public.table_reservations add constraint table_reservations_location_id_table_id_key UNIQUE (location_id, table_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_locations'::regclass and conname = 'user_locations_user_id_location_id_key') then
    alter table public.user_locations add constraint user_locations_user_id_location_id_key UNIQUE (user_id, location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_payroll_runs'::regclass and conname = 'wf_payroll_runs_location_id_period_start_key') then
    alter table public.wf_payroll_runs add constraint wf_payroll_runs_location_id_period_start_key UNIQUE (location_id, period_start);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sales_forecast'::regclass and conname = 'wf_sales_forecast_location_id_forecast_date_key') then
    alter table public.wf_sales_forecast add constraint wf_sales_forecast_location_id_forecast_date_key UNIQUE (location_id, forecast_date);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sections'::regclass and conname = 'wf_sections_id_org_id_key') then
    alter table public.wf_sections add constraint wf_sections_id_org_id_key UNIQUE (id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_id_org_id_key') then
    alter table public.wf_shifts add constraint wf_shifts_id_org_id_key UNIQUE (id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_id_org_id_key') then
    alter table public.wf_staff add constraint wf_staff_id_org_id_key UNIQUE (id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_id_org_id_key') then
    alter table public.wf_timesheets add constraint wf_timesheets_id_org_id_key UNIQUE (id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_user_roles'::regclass and conname = 'wf_user_roles_user_id_location_id_key') then
    alter table public.wf_user_roles add constraint wf_user_roles_user_id_location_id_key UNIQUE (user_id, location_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.xero_connections'::regclass and conname = 'xero_connections_location_id_key') then
    alter table public.xero_connections add constraint xero_connections_location_id_key UNIQUE (location_id);
  end if;
end $do$;

-- --------------------------------------------------------------------------
-- 3c. FOREIGN KEYS  (137)
-- Verbatim from pg_get_constraintdef(), so ON DELETE / ON UPDATE actions
-- come through exactly (103 of these carry an ON DELETE action).
-- user_profiles_id_fkey references auth.users — see PREREQUISITES.
-- --------------------------------------------------------------------------

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.active_sessions'::regclass and conname = 'active_sessions_location_id_fkey') then
    alter table public.active_sessions add constraint active_sessions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_drawers'::regclass and conname = 'cash_drawers_location_id_fkey') then
    alter table public.cash_drawers add constraint cash_drawers_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_drawers'::regclass and conname = 'cash_drawers_printer_id_fkey') then
    alter table public.cash_drawers add constraint cash_drawers_printer_id_fkey FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and conname = 'cash_movements_drawer_id_fkey') then
    alter table public.cash_movements add constraint cash_movements_drawer_id_fkey FOREIGN KEY (drawer_id) REFERENCES cash_drawers(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and conname = 'cash_movements_location_id_fkey') then
    alter table public.cash_movements add constraint cash_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and conname = 'cash_movements_session_id_fkey') then
    alter table public.cash_movements add constraint cash_movements_session_id_fkey FOREIGN KEY (session_id) REFERENCES drawer_sessions(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.cash_movements'::regclass and conname = 'cash_movements_shift_id_fkey') then
    alter table public.cash_movements add constraint cash_movements_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.closed_checks'::regclass and conname = 'closed_checks_staff_id_fkey') then
    alter table public.closed_checks add constraint closed_checks_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.corrective_actions'::regclass and conname = 'corrective_actions_maintenance_request_id_fkey') then
    alter table public.corrective_actions add constraint corrective_actions_maintenance_request_id_fkey FOREIGN KEY (maintenance_request_id) REFERENCES maintenance_requests(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_consents'::regclass and conname = 'customer_consents_customer_id_fkey') then
    alter table public.customer_consents add constraint customer_consents_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_locations'::regclass and conname = 'customer_locations_customer_id_fkey') then
    alter table public.customer_locations add constraint customer_locations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_orders'::regclass and conname = 'customer_orders_customer_id_fkey') then
    alter table public.customer_orders add constraint customer_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deliveries'::regclass and conname = 'deliveries_corrective_action_id_fkey') then
    alter table public.deliveries add constraint deliveries_corrective_action_id_fkey FOREIGN KEY (corrective_action_id) REFERENCES corrective_actions(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deliveries'::regclass and conname = 'deliveries_po_id_fkey') then
    alter table public.deliveries add constraint deliveries_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deliveries'::regclass and conname = 'deliveries_supplier_id_fkey') then
    alter table public.deliveries add constraint deliveries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.delivery_costs_actual'::regclass and conname = 'delivery_costs_actual_delivery_id_fkey') then
    alter table public.delivery_costs_actual add constraint delivery_costs_actual_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES courier_deliveries(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.device_profiles'::regclass and conname = 'device_profiles_location_id_fkey') then
    alter table public.device_profiles add constraint device_profiles_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.devices'::regclass and conname = 'devices_location_id_fkey') then
    alter table public.devices add constraint devices_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.drawer_sessions'::regclass and conname = 'drawer_sessions_drawer_id_fkey') then
    alter table public.drawer_sessions add constraint drawer_sessions_drawer_id_fkey FOREIGN KEY (drawer_id) REFERENCES cash_drawers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.drawer_sessions'::regclass and conname = 'drawer_sessions_location_id_fkey') then
    alter table public.drawer_sessions add constraint drawer_sessions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.drawer_sessions'::regclass and conname = 'drawer_sessions_shift_id_fkey') then
    alter table public.drawer_sessions add constraint drawer_sessions_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES shifts(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_item_conversions'::regclass and conname = 'inventory_item_conversions_inventory_item_id_fkey') then
    alter table public.inventory_item_conversions add constraint inventory_item_conversions_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_base_unit_fkey') then
    alter table public.inventory_items add constraint inventory_items_base_unit_fkey FOREIGN KEY (base_unit) REFERENCES stock_units(code);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_cost_history'::regclass and conname = 'item_cost_history_inventory_item_id_fkey') then
    alter table public.item_cost_history add constraint item_cost_history_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_cost_history'::regclass and conname = 'item_cost_history_supplier_product_id_fkey') then
    alter table public.item_cost_history add constraint item_cost_history_supplier_product_id_fkey FOREIGN KEY (supplier_product_id) REFERENCES supplier_products(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_packaging_formats'::regclass and conname = 'item_packaging_formats_inventory_item_id_fkey') then
    alter table public.item_packaging_formats add constraint item_packaging_formats_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_packaging_formats'::regclass and conname = 'item_packaging_formats_parent_format_id_fkey') then
    alter table public.item_packaging_formats add constraint item_packaging_formats_parent_format_id_fkey FOREIGN KEY (parent_format_id) REFERENCES item_packaging_formats(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_variants'::regclass and conname = 'item_variants_item_id_fkey') then
    alter table public.item_variants add constraint item_variants_item_id_fkey FOREIGN KEY (item_id) REFERENCES menu_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.location_features'::regclass and conname = 'location_features_location_id_fkey') then
    alter table public.location_features add constraint location_features_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations'::regclass and conname = 'locations_org_id_fkey') then
    alter table public.locations add constraint locations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_notes'::regclass and conname = 'maintenance_notes_request_id_fkey') then
    alter table public.maintenance_notes add constraint maintenance_notes_request_id_fkey FOREIGN KEY (request_id) REFERENCES maintenance_requests(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_status_history'::regclass and conname = 'maintenance_status_history_request_id_fkey') then
    alter table public.maintenance_status_history add constraint maintenance_status_history_request_id_fkey FOREIGN KEY (request_id) REFERENCES maintenance_requests(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_board_screens'::regclass and conname = 'menu_board_screens_board_id_fkey') then
    alter table public.menu_board_screens add constraint menu_board_screens_board_id_fkey FOREIGN KEY (board_id) REFERENCES menu_boards(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_master_id_fkey') then
    alter table public.menu_categories add constraint menu_categories_master_id_fkey FOREIGN KEY (master_id) REFERENCES menu_categories(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_menu_id_fkey') then
    alter table public.menu_categories add constraint menu_categories_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_org_id_fkey') then
    alter table public.menu_categories add constraint menu_categories_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_parent_id_fkey') then
    alter table public.menu_categories add constraint menu_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES menu_categories(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_category_links'::regclass and conname = 'menu_category_links_category_id_fkey') then
    alter table public.menu_category_links add constraint menu_category_links_category_id_fkey FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_category_links'::regclass and conname = 'menu_category_links_menu_id_fkey') then
    alter table public.menu_category_links add constraint menu_category_links_menu_id_fkey FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_item_recipes'::regclass and conname = 'menu_item_recipes_recipe_id_fkey') then
    alter table public.menu_item_recipes add constraint menu_item_recipes_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_master_id_fkey') then
    alter table public.menu_items add constraint menu_items_master_id_fkey FOREIGN KEY (master_id) REFERENCES menu_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_org_id_fkey') then
    alter table public.menu_items add constraint menu_items_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menus'::regclass and conname = 'menus_org_id_fkey') then
    alter table public.menus add constraint menus_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.modifier_options'::regclass and conname = 'modifier_options_group_id_fkey') then
    alter table public.modifier_options add constraint modifier_options_group_id_fkey FOREIGN KEY (group_id) REFERENCES modifier_groups(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_runs'::regclass and conname = 'ops_checklist_runs_checklist_id_fkey') then
    alter table public.ops_checklist_runs add constraint ops_checklist_runs_checklist_id_fkey FOREIGN KEY (checklist_id) REFERENCES ops_checklists(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_tasks'::regclass and conname = 'ops_checklist_tasks_checklist_id_fkey') then
    alter table public.ops_checklist_tasks add constraint ops_checklist_tasks_checklist_id_fkey FOREIGN KEY (checklist_id) REFERENCES ops_checklists(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_tasks'::regclass and conname = 'ops_checklist_tasks_temp_unit_id_fkey') then
    alter table public.ops_checklist_tasks add constraint ops_checklist_tasks_temp_unit_id_fkey FOREIGN KEY (temp_unit_id) REFERENCES temp_units(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_task_completions'::regclass and conname = 'ops_task_completions_run_id_fkey') then
    alter table public.ops_task_completions add constraint ops_task_completions_run_id_fkey FOREIGN KEY (run_id) REFERENCES ops_checklist_runs(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_task_completions'::regclass and conname = 'ops_task_completions_task_id_fkey') then
    alter table public.ops_task_completions add constraint ops_task_completions_task_id_fkey FOREIGN KEY (task_id) REFERENCES ops_checklist_tasks(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.par_levels'::regclass and conname = 'par_levels_inventory_item_id_fkey') then
    alter table public.par_levels add constraint par_levels_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.po_lines'::regclass and conname = 'po_lines_inventory_item_id_fkey') then
    alter table public.po_lines add constraint po_lines_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.po_lines'::regclass and conname = 'po_lines_po_id_fkey') then
    alter table public.po_lines add constraint po_lines_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.po_lines'::regclass and conname = 'po_lines_supplier_product_id_fkey') then
    alter table public.po_lines add constraint po_lines_supplier_product_id_fkey FOREIGN KEY (supplier_product_id) REFERENCES supplier_products(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.prep_log'::regclass and conname = 'prep_log_schedule_id_fkey') then
    alter table public.prep_log add constraint prep_log_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES prep_schedule(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.production_batches'::regclass and conname = 'production_batches_output_item_id_fkey') then
    alter table public.production_batches add constraint production_batches_output_item_id_fkey FOREIGN KEY (output_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.production_batches'::regclass and conname = 'production_batches_recipe_id_fkey') then
    alter table public.production_batches add constraint production_batches_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_offer_id_fkey') then
    alter table public.promo_codes add constraint promo_codes_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.promo_redemptions'::regclass and conname = 'promo_redemptions_promo_code_id_fkey') then
    alter table public.promo_redemptions add constraint promo_redemptions_promo_code_id_fkey FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.purchase_orders'::regclass and conname = 'purchase_orders_supplier_id_fkey') then
    alter table public.purchase_orders add constraint purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_accuracy'::regclass and conname = 'quote_accuracy_location_id_fkey') then
    alter table public.quote_accuracy add constraint quote_accuracy_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipe_lines'::regclass and conname = 'recipe_lines_component_item_id_fkey') then
    alter table public.recipe_lines add constraint recipe_lines_component_item_id_fkey FOREIGN KEY (component_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipe_lines'::regclass and conname = 'recipe_lines_recipe_id_fkey') then
    alter table public.recipe_lines add constraint recipe_lines_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipes'::regclass and conname = 'recipes_output_item_id_fkey') then
    alter table public.recipes add constraint recipes_output_item_id_fkey FOREIGN KEY (output_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_replies'::regclass and conname = 'review_replies_feedback_id_fkey') then
    alter table public.review_replies add constraint review_replies_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES review_feedback(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.shifts'::regclass and conname = 'shifts_location_id_fkey') then
    alter table public.shifts add constraint shifts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sms_messages'::regclass and conname = 'sms_messages_location_id_fkey') then
    alter table public.sms_messages add constraint sms_messages_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_members'::regclass and conname = 'staff_members_location_id_fkey') then
    alter table public.staff_members add constraint staff_members_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_members'::regclass and conname = 'staff_members_org_id_fkey') then
    alter table public.staff_members add constraint staff_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_count_lines'::regclass and conname = 'stock_count_lines_count_id_fkey') then
    alter table public.stock_count_lines add constraint stock_count_lines_count_id_fkey FOREIGN KEY (count_id) REFERENCES stock_counts(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_count_lines'::regclass and conname = 'stock_count_lines_inventory_item_id_fkey') then
    alter table public.stock_count_lines add constraint stock_count_lines_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_movements'::regclass and conname = 'stock_movements_inventory_item_id_fkey') then
    alter table public.stock_movements add constraint stock_movements_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_movements'::regclass and conname = 'stock_movements_reversal_of_fkey') then
    alter table public.stock_movements add constraint stock_movements_reversal_of_fkey FOREIGN KEY (reversal_of) REFERENCES stock_movements(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_location_id_fkey') then
    alter table public.subscriptions add constraint subscriptions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_org_id_fkey') then
    alter table public.subscriptions add constraint subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoice_lines'::regclass and conname = 'supplier_invoice_lines_invoice_id_fkey') then
    alter table public.supplier_invoice_lines add constraint supplier_invoice_lines_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES supplier_invoices(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoice_lines'::regclass and conname = 'supplier_invoice_lines_matched_item_id_fkey') then
    alter table public.supplier_invoice_lines add constraint supplier_invoice_lines_matched_item_id_fkey FOREIGN KEY (matched_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoices'::regclass and conname = 'supplier_invoices_po_id_fkey') then
    alter table public.supplier_invoices add constraint supplier_invoices_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoices'::regclass and conname = 'supplier_invoices_supplier_id_fkey') then
    alter table public.supplier_invoices add constraint supplier_invoices_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_products'::regclass and conname = 'supplier_products_inventory_item_id_fkey') then
    alter table public.supplier_products add constraint supplier_products_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_products'::regclass and conname = 'supplier_products_supplier_id_fkey') then
    alter table public.supplier_products add constraint supplier_products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_check_schedules'::regclass and conname = 'temp_check_schedules_temp_unit_id_fkey') then
    alter table public.temp_check_schedules add constraint temp_check_schedules_temp_unit_id_fkey FOREIGN KEY (temp_unit_id) REFERENCES temp_units(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_readings'::regclass and conname = 'temp_readings_schedule_id_fkey') then
    alter table public.temp_readings add constraint temp_readings_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES temp_check_schedules(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_readings'::regclass and conname = 'temp_readings_temp_unit_id_fkey') then
    alter table public.temp_readings add constraint temp_readings_temp_unit_id_fkey FOREIGN KEY (temp_unit_id) REFERENCES temp_units(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_target_terminal_id_fkey') then
    alter table public.terminal_jobs add constraint terminal_jobs_target_terminal_id_fkey FOREIGN KEY (target_terminal_id) REFERENCES terminal_devices(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.turn_time_stats'::regclass and conname = 'turn_time_stats_location_id_fkey') then
    alter table public.turn_time_stats add constraint turn_time_stats_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_locations'::regclass and conname = 'user_locations_location_id_fkey') then
    alter table public.user_locations add constraint user_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_locations'::regclass and conname = 'user_locations_user_id_fkey') then
    alter table public.user_locations add constraint user_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_profiles'::regclass and conname = 'user_profiles_id_fkey') then
    alter table public.user_profiles add constraint user_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_profiles'::regclass and conname = 'user_profiles_location_id_fkey') then
    alter table public.user_profiles add constraint user_profiles_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_profiles'::regclass and conname = 'user_profiles_org_id_fkey') then
    alter table public.user_profiles add constraint user_profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_config'::regclass and conname = 'waitlist_config_location_id_fkey') then
    alter table public.waitlist_config add constraint waitlist_config_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_devices'::regclass and conname = 'waitlist_devices_location_id_fkey') then
    alter table public.waitlist_devices add constraint waitlist_devices_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_entries'::regclass and conname = 'waitlist_entries_customer_id_fkey') then
    alter table public.waitlist_entries add constraint waitlist_entries_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_entries'::regclass and conname = 'waitlist_entries_location_id_fkey') then
    alter table public.waitlist_entries add constraint waitlist_entries_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_sms_inbound'::regclass and conname = 'waitlist_sms_inbound_location_id_fkey') then
    alter table public.waitlist_sms_inbound add constraint waitlist_sms_inbound_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waitlist_status_events'::regclass and conname = 'waitlist_status_events_location_id_fkey') then
    alter table public.waitlist_status_events add constraint waitlist_status_events_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.waste_events'::regclass and conname = 'waste_events_inventory_item_id_fkey') then
    alter table public.waste_events add constraint waste_events_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_announcements'::regclass and conname = 'wf_announcements_loc_org_fk') then
    alter table public.wf_announcements add constraint wf_announcements_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_audit'::regclass and conname = 'wf_audit_loc_org_fk') then
    alter table public.wf_audit add constraint wf_audit_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_availability'::regclass and conname = 'wf_availability_loc_org_fk') then
    alter table public.wf_availability add constraint wf_availability_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_availability'::regclass and conname = 'wf_availability_staff_id_org_id_fkey') then
    alter table public.wf_availability add constraint wf_availability_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_doc_templates'::regclass and conname = 'wf_doc_templates_loc_org_fk') then
    alter table public.wf_doc_templates add constraint wf_doc_templates_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_documents'::regclass and conname = 'wf_documents_loc_org_fk') then
    alter table public.wf_documents add constraint wf_documents_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_documents'::regclass and conname = 'wf_documents_staff_id_org_id_fkey') then
    alter table public.wf_documents add constraint wf_documents_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_loc_org_fk') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_source_timesheet_id_org_id_fkey') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_source_timesheet_id_org_id_fkey FOREIGN KEY (source_timesheet_id, org_id) REFERENCES wf_timesheets(id, org_id) ON DELETE SET NULL (source_timesheet_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_staff_id_org_id_fkey') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_onboarding'::regclass and conname = 'wf_onboarding_loc_org_fk') then
    alter table public.wf_onboarding add constraint wf_onboarding_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_onboarding'::regclass and conname = 'wf_onboarding_staff_id_org_id_fkey') then
    alter table public.wf_onboarding add constraint wf_onboarding_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_payroll_runs'::regclass and conname = 'wf_payroll_runs_loc_org_fk') then
    alter table public.wf_payroll_runs add constraint wf_payroll_runs_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_loc_org_fk') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_staff_id_fkey') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES wf_staff(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_loc_org_fk') then
    alter table public.wf_roles add constraint wf_roles_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sales_forecast'::regclass and conname = 'wf_sales_forecast_loc_org_fk') then
    alter table public.wf_sales_forecast add constraint wf_sales_forecast_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sections'::regclass and conname = 'wf_sections_loc_org_fk') then
    alter table public.wf_sections add constraint wf_sections_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_loc_org_fk') then
    alter table public.wf_shifts add constraint wf_shifts_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_section_id_org_id_fkey') then
    alter table public.wf_shifts add constraint wf_shifts_section_id_org_id_fkey FOREIGN KEY (section_id, org_id) REFERENCES wf_sections(id, org_id) ON DELETE SET NULL (section_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_staff_id_org_id_fkey') then
    alter table public.wf_shifts add constraint wf_shifts_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_loc_org_fk') then
    alter table public.wf_staff add constraint wf_staff_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_swap_requests'::regclass and conname = 'wf_swap_requests_from_staff_id_org_id_fkey') then
    alter table public.wf_swap_requests add constraint wf_swap_requests_from_staff_id_org_id_fkey FOREIGN KEY (from_staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_swap_requests'::regclass and conname = 'wf_swap_requests_loc_org_fk') then
    alter table public.wf_swap_requests add constraint wf_swap_requests_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_swap_requests'::regclass and conname = 'wf_swap_requests_shift_id_org_id_fkey') then
    alter table public.wf_swap_requests add constraint wf_swap_requests_shift_id_org_id_fkey FOREIGN KEY (shift_id, org_id) REFERENCES wf_shifts(id, org_id) ON DELETE SET NULL (shift_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_swap_requests'::regclass and conname = 'wf_swap_requests_to_staff_id_org_id_fkey') then
    alter table public.wf_swap_requests add constraint wf_swap_requests_to_staff_id_org_id_fkey FOREIGN KEY (to_staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE SET NULL (to_staff_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_time_off'::regclass and conname = 'wf_time_off_loc_org_fk') then
    alter table public.wf_time_off add constraint wf_time_off_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_time_off'::regclass and conname = 'wf_time_off_staff_id_org_id_fkey') then
    alter table public.wf_time_off add constraint wf_time_off_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_loc_org_fk') then
    alter table public.wf_timesheets add constraint wf_timesheets_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_payroll_run_id_fkey') then
    alter table public.wf_timesheets add constraint wf_timesheets_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES wf_payroll_runs(id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_shift_id_org_id_fkey') then
    alter table public.wf_timesheets add constraint wf_timesheets_shift_id_org_id_fkey FOREIGN KEY (shift_id, org_id) REFERENCES wf_shifts(id, org_id) ON DELETE SET NULL (shift_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_staff_id_org_id_fkey') then
    alter table public.wf_timesheets add constraint wf_timesheets_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_loc_org_fk') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_run_id_fkey') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_run_id_fkey FOREIGN KEY (run_id) REFERENCES wf_tronc_runs(id) ON DELETE CASCADE;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_staff_id_org_id_fkey') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE RESTRICT;
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_runs'::regclass and conname = 'wf_tronc_runs_loc_org_fk') then
    alter table public.wf_tronc_runs add constraint wf_tronc_runs_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_user_roles'::regclass and conname = 'wf_user_roles_loc_org_fk') then
    alter table public.wf_user_roles add constraint wf_user_roles_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_user_roles'::regclass and conname = 'wf_user_roles_staff_id_org_id_fkey') then
    alter table public.wf_user_roles add constraint wf_user_roles_staff_id_org_id_fkey FOREIGN KEY (staff_id, org_id) REFERENCES wf_staff(id, org_id) ON DELETE SET NULL (staff_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_venue_settings'::regclass and conname = 'wf_venue_settings_loc_org_fk') then
    alter table public.wf_venue_settings add constraint wf_venue_settings_loc_org_fk FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id);
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_captures'::regclass and conname = 'wifi_captures_customer_id_fkey') then
    alter table public.wifi_captures add constraint wifi_captures_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  end if;
end $do$;

-- --------------------------------------------------------------------------
-- 3d. CHECK CONSTRAINTS  (126)
-- --------------------------------------------------------------------------

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaign_runs'::regclass and conname = 'campaign_runs_status_check') then
    alter table public.campaign_runs add constraint campaign_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'error'::text, 'skipped'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaign_sends'::regclass and conname = 'campaign_sends_status_check') then
    alter table public.campaign_sends add constraint campaign_sends_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'partial'::text, 'skipped'::text, 'failed'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_channel_check') then
    alter table public.campaigns add constraint campaigns_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'both'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_status_check') then
    alter table public.campaigns add constraint campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'active'::text, 'paused'::text, 'archived'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.campaigns'::regclass and conname = 'campaigns_type_check') then
    alter table public.campaigns add constraint campaigns_type_check CHECK ((type = ANY (ARRAY['one_off'::text, 'automation'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.closed_checks'::regclass and conname = 'closed_checks_source_check') then
    alter table public.closed_checks add constraint closed_checks_source_check CHECK ((source = ANY (ARRAY['pos'::text, 'kiosk'::text, 'online'::text, 'mobile'::text, 'catering'::text, 'hubrise'::text, 'pax_table_pay'::text, 'pos_send_to_terminal'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.corrective_actions'::regclass and conname = 'corrective_actions_source_type_check') then
    alter table public.corrective_actions add constraint corrective_actions_source_type_check CHECK ((source_type = ANY (ARRAY['temp_reading'::text, 'checklist'::text, 'delivery'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.corrective_actions'::regclass and conname = 'corrective_actions_status_check') then
    alter table public.corrective_actions add constraint corrective_actions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'closed'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.courier_deliveries'::regclass and conname = 'courier_deliveries_dispatch_backend_check') then
    alter table public.courier_deliveries add constraint courier_deliveries_dispatch_backend_check CHECK ((dispatch_backend = ANY (ARRAY['uber_api'::text, 'hubrise_bridge'::text, 'stuart'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_consents'::regclass and conname = 'customer_consents_channel_check') then
    alter table public.customer_consents add constraint customer_consents_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'both'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deliveries'::regclass and conname = 'deliveries_status_check') then
    alter table public.deliveries add constraint deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.device_profiles'::regclass and conname = 'device_profiles_kiosk_table_mode_check') then
    alter table public.device_profiles add constraint device_profiles_kiosk_table_mode_check CHECK (((kiosk_table_mode IS NULL) OR (kiosk_table_mode = ANY (ARRAY['enter'::text, 'dispense'::text, 'either'::text, 'none'::text]))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.device_profiles'::regclass and conname = 'device_profiles_kiosk_theme_mode_check') then
    alter table public.device_profiles add constraint device_profiles_kiosk_theme_mode_check CHECK (((kiosk_theme_mode IS NULL) OR (kiosk_theme_mode = ANY (ARRAY['dark'::text, 'light'::text]))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_connections'::regclass and conname = 'hubrise_connections_status_check') then
    alter table public.hubrise_connections add constraint hubrise_connections_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'error'::text, 'disconnected'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hubrise_events'::regclass and conname = 'hubrise_events_status_check') then
    alter table public.hubrise_events add constraint hubrise_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'error'::text, 'skipped'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_cost_method_check') then
    alter table public.inventory_items add constraint inventory_items_cost_method_check CHECK ((cost_method = ANY (ARRAY['MOVING_AVG'::text, 'LAST_COST'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_items'::regclass and conname = 'inventory_items_kind_check') then
    alter table public.inventory_items add constraint inventory_items_kind_check CHECK ((kind = ANY (ARRAY['PURCHASED'::text, 'MADE'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.item_cost_history'::regclass and conname = 'item_cost_history_source_check') then
    alter table public.item_cost_history add constraint item_cost_history_source_check CHECK ((source = ANY (ARRAY['INVOICE'::text, 'MANUAL'::text, 'CONTRACT'::text, 'CATALOG'::text, 'RECIPE_ROLLUP'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations'::regclass and conname = 'locations_quick_screen_mode_check') then
    alter table public.locations add constraint locations_quick_screen_mode_check CHECK ((quick_screen_mode = ANY (ARRAY['manual'::text, 'auto'::text, 'hybrid'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_requests'::regclass and conname = 'maintenance_requests_priority_check') then
    alter table public.maintenance_requests add constraint maintenance_requests_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_requests'::regclass and conname = 'maintenance_requests_source_check') then
    alter table public.maintenance_requests add constraint maintenance_requests_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'temp_breach'::text, 'delivery'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.maintenance_requests'::regclass and conname = 'maintenance_requests_status_check') then
    alter table public.maintenance_requests add constraint maintenance_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'assigned'::text, 'in_progress'::text, 'resolved'::text, 'cancelled'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_messages'::regclass and conname = 'marketing_messages_channel_check') then
    alter table public.marketing_messages add constraint marketing_messages_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_messages'::regclass and conname = 'marketing_messages_status_check') then
    alter table public.marketing_messages add constraint marketing_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sandbox'::text, 'sent'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'bounced'::text, 'complained'::text, 'failed'::text, 'suppressed'::text, 'no_consent'::text, 'unreachable'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_suppressions'::regclass and conname = 'marketing_suppressions_channel_check') then
    alter table public.marketing_suppressions add constraint marketing_suppressions_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketing_suppressions'::regclass and conname = 'marketing_suppressions_reason_check') then
    alter table public.marketing_suppressions add constraint marketing_suppressions_reason_check CHECK ((reason = ANY (ARRAY['unsubscribe'::text, 'stop'::text, 'bounce'::text, 'complaint'::text, 'manual'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_categories'::regclass and conname = 'menu_categories_scope_check') then
    alter table public.menu_categories add constraint menu_categories_scope_check CHECK ((scope = ANY (ARRAY['local'::text, 'shared'::text, 'global'::text, 'override'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_scope_check') then
    alter table public.menu_items add constraint menu_items_scope_check CHECK ((scope = ANY (ARRAY['local'::text, 'shared'::text, 'global'::text, 'override'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menus'::regclass and conname = 'menus_scope_check') then
    alter table public.menus add constraint menus_scope_check CHECK ((scope = ANY (ARRAY['local'::text, 'shared'::text, 'global'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.offers'::regclass and conname = 'offers_reward_type_check') then
    alter table public.offers add constraint offers_reward_type_check CHECK ((reward_type = ANY (ARRAY['percent'::text, 'fixed'::text, 'free_item'::text, 'free_delivery'::text, 'points_bonus'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_alerts'::regclass and conname = 'ops_alerts_status_check') then
    alter table public.ops_alerts add constraint ops_alerts_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'acknowledged'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_alerts'::regclass and conname = 'ops_alerts_type_check') then
    alter table public.ops_alerts add constraint ops_alerts_type_check CHECK ((type = ANY (ARRAY['temp_breach'::text, 'missed_check'::text, 'overdue_task'::text, 'maintenance'::text, 'corrective'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_runs'::regclass and conname = 'ops_checklist_runs_status_check') then
    alter table public.ops_checklist_runs add constraint ops_checklist_runs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'complete'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklist_tasks'::regclass and conname = 'ops_checklist_tasks_task_type_check') then
    alter table public.ops_checklist_tasks add constraint ops_checklist_tasks_task_type_check CHECK ((task_type = ANY (ARRAY['check'::text, 'value'::text, 'photo'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklists'::regclass and conname = 'ops_checklists_area_check') then
    alter table public.ops_checklists add constraint ops_checklists_area_check CHECK ((area = ANY (ARRAY['BOH'::text, 'FOH'::text, 'MOD'::text, 'opening'::text, 'closing'::text, 'cleaning'::text, 'delivery'::text, 'other'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklists'::regclass and conname = 'ops_checklists_day_of_month_check') then
    alter table public.ops_checklists add constraint ops_checklists_day_of_month_check CHECK (((day_of_month IS NULL) OR ((day_of_month >= 1) AND (day_of_month <= 28))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ops_checklists'::regclass and conname = 'ops_checklists_frequency_check') then
    alter table public.ops_checklists add constraint ops_checklists_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.org_sending_domains'::regclass and conname = 'org_sending_domains_status_check') then
    alter table public.org_sending_domains add constraint org_sending_domains_status_check CHECK ((status = ANY (ARRAY['not_started'::text, 'pending'::text, 'verified'::text, 'partially_verified'::text, 'partially_failed'::text, 'temporary_failure'::text, 'failed'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.production_batches'::regclass and conname = 'production_batches_status_check') then
    alter table public.production_batches add constraint production_batches_status_check CHECK ((status = ANY (ARRAY['PLANNED'::text, 'DRAFT'::text, 'COMPLETED'::text, 'CANCELLED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_status_check') then
    alter table public.promo_codes add constraint promo_codes_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'redeemed'::text, 'expired'::text, 'voided'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.purchase_orders'::regclass and conname = 'purchase_orders_status_check') then
    alter table public.purchase_orders add constraint purchase_orders_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SENT'::text, 'PARTIAL'::text, 'RECEIVED'::text, 'CANCELLED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.recipes'::regclass and conname = 'recipes_recipe_type_check') then
    alter table public.recipes add constraint recipes_recipe_type_check CHECK ((recipe_type = ANY (ARRAY['MENU'::text, 'PREP'::text, 'BATCH'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_channel_check') then
    alter table public.review_feedback add constraint review_feedback_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'qr'::text, 'wifi'::text, 'web'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_origin_check') then
    alter table public.review_feedback add constraint review_feedback_origin_check CHECK ((origin = ANY (ARRAY['card'::text, 'synced'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_rating_check') then
    alter table public.review_feedback add constraint review_feedback_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_source_platform_check') then
    alter table public.review_feedback add constraint review_feedback_source_platform_check CHECK (((source_platform IS NULL) OR (source_platform = ANY (ARRAY['google'::text, 'thefork'::text, 'trustpilot'::text]))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_feedback'::regclass and conname = 'review_feedback_status_check') then
    alter table public.review_feedback add constraint review_feedback_status_check CHECK ((status = ANY (ARRAY['new'::text, 'drafted'::text, 'approved'::text, 'resolved'::text, 'archived'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_platform_links'::regclass and conname = 'review_platform_links_platform_check') then
    alter table public.review_platform_links add constraint review_platform_links_platform_check CHECK ((platform = ANY (ARRAY['google'::text, 'thefork'::text, 'trustpilot'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_replies'::regclass and conname = 'review_replies_kind_check') then
    alter table public.review_replies add constraint review_replies_kind_check CHECK ((kind = ANY (ARRAY['public_reply'::text, 'private_recovery'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_replies'::regclass and conname = 'review_replies_status_check') then
    alter table public.review_replies add constraint review_replies_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'sent'::text, 'posted'::text, 'skipped'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_requests'::regclass and conname = 'review_requests_channel_check') then
    alter table public.review_requests add constraint review_requests_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_requests'::regclass and conname = 'review_requests_source_kind_check') then
    alter table public.review_requests add constraint review_requests_source_kind_check CHECK ((source_kind = ANY (ARRAY['closed_check'::text, 'order_queue'::text, 'manual'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_requests'::regclass and conname = 'review_requests_status_check') then
    alter table public.review_requests add constraint review_requests_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'suppressed'::text, 'failed'::text, 'opened'::text, 'clicked'::text, 'converted'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_settings'::regclass and conname = 'review_settings_ask_channel_check') then
    alter table public.review_settings add constraint review_settings_ask_channel_check CHECK ((ask_channel = ANY (ARRAY['sms'::text, 'email'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_settings'::regclass and conname = 'review_settings_card_button_style_check') then
    alter table public.review_settings add constraint review_settings_card_button_style_check CHECK ((card_button_style = ANY (ARRAY['dark'::text, 'accent'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_settings'::regclass and conname = 'review_settings_threshold_check') then
    alter table public.review_settings add constraint review_settings_threshold_check CHECK (((threshold >= 1) AND (threshold <= 5)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.review_themes'::regclass and conname = 'review_themes_sentiment_check') then
    alter table public.review_themes add constraint review_themes_sentiment_check CHECK ((sentiment = ANY (ARRAY['positive'::text, 'negative'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.segments'::regclass and conname = 'segments_kind_check') then
    alter table public.segments add constraint segments_kind_check CHECK ((kind = ANY (ARRAY['dynamic'::text, 'prebuilt'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_auth_events'::regclass and conname = 'staff_auth_events_method_check') then
    alter table public.staff_auth_events add constraint staff_auth_events_method_check CHECK ((method = ANY (ARRAY['pin'::text, 'card'::text, 'override'::text, 'fingerprint'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.staff_members'::regclass and conname = 'staff_members_auth_method_check') then
    alter table public.staff_members add constraint staff_members_auth_method_check CHECK ((auth_method = ANY (ARRAY['pin'::text, 'card'::text, 'fingerprint'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_counts'::regclass and conname = 'stock_counts_count_type_check') then
    alter table public.stock_counts add constraint stock_counts_count_type_check CHECK ((count_type = ANY (ARRAY['FULL'::text, 'PARTIAL'::text, 'SPOT'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_counts'::regclass and conname = 'stock_counts_status_check') then
    alter table public.stock_counts add constraint stock_counts_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text, 'CANCELLED'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_levels'::regclass and conname = 'stock_levels_par_check') then
    alter table public.stock_levels add constraint stock_levels_par_check CHECK ((par > 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_movements'::regclass and conname = 'stock_movements_movement_type_check') then
    alter table public.stock_movements add constraint stock_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['OPENING_BALANCE'::text, 'PURCHASE_RECEIPT'::text, 'SALE_DEPLETION'::text, 'WASTE'::text, 'STOCK_COUNT_ADJ'::text, 'PRODUCTION_CONSUME'::text, 'PRODUCTION_OUTPUT'::text, 'TRANSFER_IN'::text, 'TRANSFER_OUT'::text, 'RETURN'::text, 'MANUAL_ADJ'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.stock_units'::regclass and conname = 'stock_units_dimension_check') then
    alter table public.stock_units add constraint stock_units_dimension_check CHECK ((dimension = ANY (ARRAY['COUNT'::text, 'WEIGHT'::text, 'VOLUME'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.supplier_invoices'::regclass and conname = 'supplier_invoices_status_check') then
    alter table public.supplier_invoices add constraint supplier_invoices_status_check CHECK ((status = ANY (ARRAY['REVIEW'::text, 'POSTED'::text, 'VOID'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_check_schedules'::regclass and conname = 'temp_check_schedules_frequency_check') then
    alter table public.temp_check_schedules add constraint temp_check_schedules_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_readings'::regclass and conname = 'temp_readings_severity_check') then
    alter table public.temp_readings add constraint temp_readings_severity_check CHECK ((severity = ANY (ARRAY['none'::text, 'minor'::text, 'major'::text, 'critical'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_readings'::regclass and conname = 'temp_readings_source_check') then
    alter table public.temp_readings add constraint temp_readings_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'delivery'::text, 'probe'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_units'::regclass and conname = 'temp_units_display_unit_check') then
    alter table public.temp_units add constraint temp_units_display_unit_check CHECK ((display_unit = ANY (ARRAY['C'::text, 'F'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.temp_units'::regclass and conname = 'temp_units_type_check') then
    alter table public.temp_units add constraint temp_units_type_check CHECK ((type = ANY (ARRAY['fridge'::text, 'freezer'::text, 'cold_hold'::text, 'hot_hold'::text, 'cooking'::text, 'chill_down'::text, 'delivery'::text, 'probe'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_charge_minor_check') then
    alter table public.terminal_jobs add constraint terminal_jobs_charge_minor_check CHECK ((charge_minor >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_due_minor_check') then
    alter table public.terminal_jobs add constraint terminal_jobs_due_minor_check CHECK ((due_minor > 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_tip_basis_minor_check') then
    alter table public.terminal_jobs add constraint terminal_jobs_tip_basis_minor_check CHECK ((tip_basis_minor >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'terminal_jobs_tip_minor_check') then
    alter table public.terminal_jobs add constraint terminal_jobs_tip_minor_check CHECK ((tip_minor >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.terminal_jobs'::regclass and conname = 'tj_charge_identity') then
    alter table public.terminal_jobs add constraint tj_charge_identity CHECK (((charge_minor IS NULL) OR (tip_minor IS NULL) OR (charge_minor = (due_minor + tip_minor))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_locations'::regclass and conname = 'user_locations_role_check') then
    alter table public.user_locations add constraint user_locations_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'staff'::text, 'viewer'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.venue_uber_config'::regclass and conname = 'venue_uber_config_delivery_mode_check') then
    alter table public.venue_uber_config add constraint venue_uber_config_delivery_mode_check CHECK ((delivery_mode = ANY (ARRAY['self'::text, 'uber'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.venue_uber_config'::regclass and conname = 'venue_uber_config_dispatch_backend_check') then
    alter table public.venue_uber_config add constraint venue_uber_config_dispatch_backend_check CHECK ((dispatch_backend = ANY (ARRAY['uber_api'::text, 'hubrise_bridge'::text, 'stuart'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.venue_uber_config'::regclass and conname = 'venue_uber_config_env_check') then
    alter table public.venue_uber_config add constraint venue_uber_config_env_check CHECK ((env = ANY (ARRAY['sandbox'::text, 'prod'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_doc_templates'::regclass and conname = 'wf_doc_templates_kind_check') then
    alter table public.wf_doc_templates add constraint wf_doc_templates_kind_check CHECK ((kind = ANY (ARRAY['offer'::text, 'contract'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_accrual_rate_check') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_accrual_rate_check CHECK (((accrual_rate IS NULL) OR ((accrual_rate >= (0)::numeric) AND (accrual_rate <= (1)::numeric))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_holiday_accrual'::regclass and conname = 'wf_holiday_accrual_kind_check') then
    alter table public.wf_holiday_accrual add constraint wf_holiday_accrual_kind_check CHECK ((kind = ANY (ARRAY['accrual'::text, 'taken'::text, 'payout'::text, 'adjustment'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_check') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_check CHECK ((((target_kind = 'role'::text) AND (role_key IS NOT NULL)) OR ((target_kind = 'staff'::text) AND (staff_id IS NOT NULL))));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_check1') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_check1 CHECK (((new_rate IS NOT NULL) OR (new_salary_annual IS NOT NULL)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_new_rate_check') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_new_rate_check CHECK (((new_rate IS NULL) OR (new_rate >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_new_salary_annual_check') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_new_salary_annual_check CHECK (((new_salary_annual IS NULL) OR (new_salary_annual >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_status_check') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'applied'::text, 'cancelled'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_rate_changes'::regclass and conname = 'wf_rate_changes_target_kind_check') then
    alter table public.wf_rate_changes add constraint wf_rate_changes_target_kind_check CHECK ((target_kind = ANY (ARRAY['role'::text, 'staff'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_base_rate_check') then
    alter table public.wf_roles add constraint wf_roles_base_rate_check CHECK (((base_rate IS NULL) OR (base_rate >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_contracted_week_check') then
    alter table public.wf_roles add constraint wf_roles_contracted_week_check CHECK ((contracted_week > (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_salary_annual_check') then
    alter table public.wf_roles add constraint wf_roles_salary_annual_check CHECK (((salary_annual IS NULL) OR (salary_annual >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_roles'::regclass and conname = 'wf_roles_tronc_weight_check') then
    alter table public.wf_roles add constraint wf_roles_tronc_weight_check CHECK ((tronc_weight >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sales_forecast'::regclass and conname = 'wf_sales_forecast_actual_amount_check') then
    alter table public.wf_sales_forecast add constraint wf_sales_forecast_actual_amount_check CHECK (((actual_amount IS NULL) OR (actual_amount >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sales_forecast'::regclass and conname = 'wf_sales_forecast_amount_check') then
    alter table public.wf_sales_forecast add constraint wf_sales_forecast_amount_check CHECK ((amount >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_sections'::regclass and conname = 'wf_sections_min_coverage_check') then
    alter table public.wf_sections add constraint wf_sections_min_coverage_check CHECK ((min_coverage >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_break_mins_check') then
    alter table public.wf_shifts add constraint wf_shifts_break_mins_check CHECK ((break_mins >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_computed_cost_check') then
    alter table public.wf_shifts add constraint wf_shifts_computed_cost_check CHECK (((computed_cost IS NULL) OR (computed_cost >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_computed_hours_check') then
    alter table public.wf_shifts add constraint wf_shifts_computed_hours_check CHECK (((computed_hours IS NULL) OR (computed_hours >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_shifts'::regclass and conname = 'wf_shifts_effective_rate_check') then
    alter table public.wf_shifts add constraint wf_shifts_effective_rate_check CHECK (((effective_rate IS NULL) OR (effective_rate >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_bank_account_masked_check') then
    alter table public.wf_staff add constraint wf_staff_bank_account_masked_check CHECK (((bank_account_masked IS NULL) OR (bank_account_masked ~ '^[*xX•]{2,}[0-9]{2,4}$'::text)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_contracted_week_check') then
    alter table public.wf_staff add constraint wf_staff_contracted_week_check CHECK (((contracted_week IS NULL) OR (contracted_week > (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_holiday_entitlement_days_check') then
    alter table public.wf_staff add constraint wf_staff_holiday_entitlement_days_check CHECK (((holiday_entitlement_days IS NULL) OR (holiday_entitlement_days >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_rate_override_check') then
    alter table public.wf_staff add constraint wf_staff_rate_override_check CHECK (((rate_override IS NULL) OR (rate_override >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_staff'::regclass and conname = 'wf_staff_weekly_hours_target_check') then
    alter table public.wf_staff add constraint wf_staff_weekly_hours_target_check CHECK (((weekly_hours_target IS NULL) OR (weekly_hours_target >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_time_off'::regclass and conname = 'wf_time_off_days_check') then
    alter table public.wf_time_off add constraint wf_time_off_days_check CHECK (((days IS NULL) OR (days >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_actual_hours_check') then
    alter table public.wf_timesheets add constraint wf_timesheets_actual_hours_check CHECK (((actual_hours IS NULL) OR (actual_hours >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_break_taken_check') then
    alter table public.wf_timesheets add constraint wf_timesheets_break_taken_check CHECK ((break_taken >= 0));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_effective_rate_check') then
    alter table public.wf_timesheets add constraint wf_timesheets_effective_rate_check CHECK (((effective_rate IS NULL) OR (effective_rate >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_pay_amount_check') then
    alter table public.wf_timesheets add constraint wf_timesheets_pay_amount_check CHECK (((pay_amount IS NULL) OR (pay_amount >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_timesheets'::regclass and conname = 'wf_timesheets_scheduled_hours_check') then
    alter table public.wf_timesheets add constraint wf_timesheets_scheduled_hours_check CHECK (((scheduled_hours IS NULL) OR (scheduled_hours >= (0)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_hours_check') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_hours_check CHECK ((hours >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_payout_check') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_payout_check CHECK ((payout >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_points_check') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_points_check CHECK ((points >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_share_pct_check') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_share_pct_check CHECK ((share_pct >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_lines'::regclass and conname = 'wf_tronc_lines_units_check') then
    alter table public.wf_tronc_lines add constraint wf_tronc_lines_units_check CHECK ((units >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_runs'::regclass and conname = 'wf_tronc_runs_pool_check') then
    alter table public.wf_tronc_runs add constraint wf_tronc_runs_pool_check CHECK ((pool >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_tronc_runs'::regclass and conname = 'wf_tronc_runs_total_paid_check') then
    alter table public.wf_tronc_runs add constraint wf_tronc_runs_total_paid_check CHECK ((total_paid >= (0)::numeric));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_user_roles'::regclass and conname = 'wf_user_roles_role_check') then
    alter table public.wf_user_roles add constraint wf_user_roles_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'venueManager'::text, 'shiftManager'::text, 'staff'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_venue_settings'::regclass and conname = 'wf_venue_settings_accrual_rate_check') then
    alter table public.wf_venue_settings add constraint wf_venue_settings_accrual_rate_check CHECK (((accrual_rate >= (0)::numeric) AND (accrual_rate <= (1)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wf_venue_settings'::regclass and conname = 'wf_venue_settings_labour_target_pct_check') then
    alter table public.wf_venue_settings add constraint wf_venue_settings_labour_target_pct_check CHECK (((labour_target_pct >= (0)::numeric) AND (labour_target_pct <= (1)::numeric)));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_portal_settings'::regclass and conname = 'wifi_portal_settings_button_style_check') then
    alter table public.wifi_portal_settings add constraint wifi_portal_settings_button_style_check CHECK ((button_style = ANY (ARRAY['dark'::text, 'accent'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wifi_unifi_bindings'::regclass and conname = 'wifi_unifi_bindings_auth_method_check') then
    alter table public.wifi_unifi_bindings add constraint wifi_unifi_bindings_auth_method_check CHECK ((auth_method = ANY (ARRAY['none'::text, 'unifi_voucher'::text, 'unifi_local_api'::text, 'unifi_legacy'::text, 'unifi_cloud'::text, 'onprem_relay'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflow_enrollments'::regclass and conname = 'workflow_enrollments_status_check') then
    alter table public.workflow_enrollments add constraint workflow_enrollments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'cancelled'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflow_step_sends'::regclass and conname = 'workflow_step_sends_status_check') then
    alter table public.workflow_step_sends add constraint workflow_step_sends_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'partial'::text, 'skipped'::text, 'failed'::text])));
  end if;
end $do$;

do $do$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workflows'::regclass and conname = 'workflows_status_check') then
    alter table public.workflows add constraint workflows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'archived'::text])));
  end if;
end $do$;

-- --------------------------------------------------------------------------
-- 4. INDEXES  (258)
-- pg_indexes.indexdef verbatim, with IF NOT EXISTS spliced in. Indexes
-- backing a primary key or unique constraint are NOT repeated here —
-- section 3 already created them.
-- --------------------------------------------------------------------------

create index if not exists idx_active_sessions_loc ON public.active_sessions USING btree (location_id);

create index if not exists activity_events_loc_idx ON public.activity_events USING btree (location_id, created_at DESC);

create index if not exists idx_bar_tabs_loc_status ON public.bar_tabs USING btree (location_id, status);

create index if not exists idx_bar_tabs_location ON public.bar_tabs USING btree (location_id);

create index if not exists idx_bar_tabs_status ON public.bar_tabs USING btree (location_id, status);

create index if not exists campaign_runs_org_idx ON public.campaign_runs USING btree (org_id, run_at DESC);

create unique index if not exists campaign_runs_uidx ON public.campaign_runs USING btree (campaign_id, run_key);

create index if not exists campaign_sends_org_idx ON public.campaign_sends USING btree (org_id, created_at DESC);

create index if not exists campaign_sends_run_idx ON public.campaign_sends USING btree (run_id);

create unique index if not exists campaign_sends_uidx ON public.campaign_sends USING btree (campaign_id, customer_id, dedupe_key);

create index if not exists campaign_sends_variant_idx ON public.campaign_sends USING btree (campaign_id, variant_key) WHERE (variant_key IS NOT NULL);

create index if not exists campaigns_active_idx ON public.campaigns USING btree (status, type) WHERE (status = 'active'::text);

create index if not exists campaigns_org_idx ON public.campaigns USING btree (org_id, created_at DESC);

create index if not exists idx_cash_drawers_location ON public.cash_drawers USING btree (location_id);

create index if not exists idx_cash_movements_drawer ON public.cash_movements USING btree (drawer_id, "timestamp" DESC);

create index if not exists idx_cash_movements_session ON public.cash_movements USING btree (session_id);

create index if not exists idx_cash_movements_shift ON public.cash_movements USING btree (shift_id, "timestamp" DESC);

create index if not exists idx_cash_movements_type ON public.cash_movements USING btree (location_id, type, "timestamp" DESC);

create index if not exists idx_challenge_21_checks_location_time ON public.challenge_21_checks USING btree (location_id, triggered_at DESC);

create index if not exists idx_closed_checks_customer_id ON public.closed_checks USING btree (customer_id) WHERE (customer_id IS NOT NULL);

create index if not exists idx_closed_checks_drawer ON public.closed_checks USING btree (drawer_id);

create index if not exists idx_closed_checks_kiosk_id ON public.closed_checks USING btree (kiosk_id) WHERE (kiosk_id IS NOT NULL);

create index if not exists idx_closed_checks_location ON public.closed_checks USING btree (location_id, closed_at DESC);

create index if not exists idx_closed_checks_location_closed_at ON public.closed_checks USING btree (location_id, closed_at DESC);

create index if not exists idx_closed_checks_promo_code ON public.closed_checks USING btree (((promo ->> 'code'::text))) WHERE (promo IS NOT NULL);

create index if not exists idx_closed_checks_shift ON public.closed_checks USING btree (shift_id);

create index if not exists idx_closed_checks_source_loc ON public.closed_checks USING btree (location_id, source) WHERE (source <> 'pos'::text);

create index if not exists idx_closed_checks_staff_id ON public.closed_checks USING btree (staff_id) WHERE (staff_id IS NOT NULL);

create index if not exists idx_config_pushes_location ON public.config_pushes USING btree (location_id, created_at DESC);

create index if not exists corrective_loc_idx ON public.corrective_actions USING btree (location_id, created_at DESC);

create index if not exists corrective_src_idx ON public.corrective_actions USING btree (source_type, source_id);

create index if not exists courier_deliveries_loc_idx ON public.courier_deliveries USING btree (location_id, created_at DESC);

create unique index if not exists courier_deliveries_order_ref_uidx ON public.courier_deliveries USING btree (location_id, order_ref) WHERE (order_ref IS NOT NULL);

create unique index if not exists courier_deliveries_uber_id_idx ON public.courier_deliveries USING btree (uber_delivery_id) WHERE (uber_delivery_id IS NOT NULL);

create index if not exists customer_consents_customer_idx ON public.customer_consents USING btree (customer_id, created_at DESC);

create index if not exists idx_customer_locations_loc ON public.customer_locations USING btree (location_id, last_visit_at DESC);

create index if not exists idx_customer_orders_customer ON public.customer_orders USING btree (customer_id, ordered_at DESC);

create index if not exists idx_customer_orders_loc ON public.customer_orders USING btree (location_id, ordered_at DESC);

create index if not exists customers_birthday_md_idx ON public.customers USING btree (EXTRACT(month FROM birthday), EXTRACT(day FROM birthday)) WHERE (birthday IS NOT NULL);

create index if not exists customers_org_email_idx ON public.customers USING btree (org_id, lower(email)) WHERE (email IS NOT NULL);

create unique index if not exists idx_customers_org_email ON public.customers USING btree (org_id, lower(email)) WHERE ((email IS NOT NULL) AND (deleted_at IS NULL));

create index if not exists idx_customers_org_name ON public.customers USING btree (org_id, lower(name));

create unique index if not exists idx_customers_org_phone ON public.customers USING btree (org_id, phone) WHERE ((phone IS NOT NULL) AND (deleted_at IS NULL));

create index if not exists deliveries_loc_idx ON public.deliveries USING btree (location_id, created_at DESC);

create index if not exists deliveries_po_idx ON public.deliveries USING btree (po_id);

create index if not exists delivery_quotes_loc_idx ON public.delivery_quotes USING btree (location_id, created_at DESC);

create index if not exists delivery_quotes_ref_idx ON public.delivery_quotes USING btree (order_ref);

create index if not exists delivery_surcharges_loc_idx ON public.delivery_surcharges USING btree (location_id, created_at DESC);

create index if not exists delivery_surcharges_ref_idx ON public.delivery_surcharges USING btree (order_ref);

create index if not exists idx_device_hb_loc_role ON public.device_heartbeats USING btree (location_id, role);

create index if not exists devices_device_uid_idx ON public.devices USING btree (device_uid) WHERE (device_uid IS NOT NULL);

create index if not exists idx_discount_rules_location ON public.discount_rules USING btree (location_id);

create index if not exists idx_discounts_location ON public.discounts USING btree (location_id);

create index if not exists idx_drawer_sessions_drawer ON public.drawer_sessions USING btree (drawer_id, cash_in_at DESC);

create unique index if not exists idx_drawer_sessions_one_open ON public.drawer_sessions USING btree (drawer_id) WHERE (status = ANY (ARRAY['open'::text, 'counting'::text]));

create index if not exists idx_drawer_sessions_shift ON public.drawer_sessions USING btree (shift_id);

create index if not exists hubrise_events_loc_idx ON public.hubrise_events USING btree (location_id, received_at DESC);

create unique index if not exists hubrise_order_links_hrid_idx ON public.hubrise_order_links USING btree (hubrise_order_id);

create index if not exists hubrise_order_links_loc_idx ON public.hubrise_order_links USING btree (location_id);

create index if not exists inv_item_conv_item_idx ON public.inventory_item_conversions USING btree (inventory_item_id);

create index if not exists inventory_items_loc_idx ON public.inventory_items USING btree (location_id);

create index if not exists inventory_items_loc_kind_idx ON public.inventory_items USING btree (location_id, kind) WHERE (archived_at IS NULL);

create index if not exists item_cost_hist_current_idx ON public.item_cost_history USING btree (inventory_item_id) WHERE (effective_to IS NULL);

create index if not exists item_cost_hist_item_idx ON public.item_cost_history USING btree (inventory_item_id, effective_from DESC);

create index if not exists item_pack_fmt_item_idx ON public.item_packaging_formats USING btree (inventory_item_id);

create index if not exists idx_kds_tickets_loc_sent ON public.kds_tickets USING btree (location_id, sent_at DESC);

create index if not exists idx_kds_tickets_location ON public.kds_tickets USING btree (location_id, status);

create index if not exists idx_loyalty_tx_check ON public.loyalty_transactions USING btree (closed_check_id);

create index if not exists idx_loyalty_tx_company ON public.loyalty_transactions USING btree (company_id, created_at DESC);

create index if not exists idx_loyalty_tx_customer ON public.loyalty_transactions USING btree (customer_id, created_at DESC);

create index if not exists maint_notes_req_idx ON public.maintenance_notes USING btree (request_id, created_at);

create index if not exists maint_loc_idx ON public.maintenance_requests USING btree (location_id, created_at DESC);

create index if not exists maint_status_idx ON public.maintenance_requests USING btree (location_id, status);

create index if not exists maint_hist_req_idx ON public.maintenance_status_history USING btree (request_id, changed_at);

create index if not exists marketing_messages_campaign_idx ON public.marketing_messages USING btree (campaign_id);

create index if not exists marketing_messages_customer_idx ON public.marketing_messages USING btree (customer_id);

create unique index if not exists marketing_messages_idem_uidx ON public.marketing_messages USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

create index if not exists marketing_messages_org_idx ON public.marketing_messages USING btree (org_id, created_at DESC);

create index if not exists marketing_messages_provider_idx ON public.marketing_messages USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL);

create index if not exists marketing_suppressions_org_idx ON public.marketing_suppressions USING btree (org_id, channel);

create unique index if not exists marketing_suppressions_uidx ON public.marketing_suppressions USING btree (org_id, channel, address);

create index if not exists idx_mb_screens_board ON public.menu_board_screens USING btree (board_id);

create unique index if not exists idx_mb_screens_code ON public.menu_board_screens USING btree (lower(code));

create index if not exists idx_mb_screens_device ON public.menu_board_screens USING btree (device_uid);

create index if not exists idx_mb_screens_location ON public.menu_board_screens USING btree (location_id);

create index if not exists idx_menu_boards_location ON public.menu_boards USING btree (location_id);

create index if not exists idx_menu_categories_location ON public.menu_categories USING btree (location_id);

create index if not exists idx_menu_categories_master_id ON public.menu_categories USING btree (master_id) WHERE (master_id IS NOT NULL);

create index if not exists idx_menu_categories_menu ON public.menu_categories USING btree (menu_id);

create index if not exists idx_menu_categories_org_id ON public.menu_categories USING btree (org_id) WHERE (org_id IS NOT NULL);

create index if not exists idx_menu_categories_scope ON public.menu_categories USING btree (scope);

create index if not exists idx_mcl_category_id ON public.menu_category_links USING btree (category_id);

create index if not exists idx_mcl_menu_id ON public.menu_category_links USING btree (menu_id);

create index if not exists menu_item_recipes_recipe_idx ON public.menu_item_recipes USING btree (recipe_id);

create index if not exists idx_menu_items_location ON public.menu_items USING btree (location_id);

create index if not exists idx_menu_items_master_id ON public.menu_items USING btree (master_id) WHERE (master_id IS NOT NULL);

create index if not exists idx_menu_items_org_id ON public.menu_items USING btree (org_id) WHERE (org_id IS NOT NULL);

create index if not exists idx_menu_items_scope ON public.menu_items USING btree (scope);

create index if not exists idx_menus_location ON public.menus USING btree (location_id);

create index if not exists idx_menus_org_id ON public.menus USING btree (org_id) WHERE (org_id IS NOT NULL);

create index if not exists idx_menus_priority ON public.menus USING btree (priority);

create index if not exists ops_alerts_loc_idx ON public.ops_alerts USING btree (location_id, created_at DESC);

create index if not exists ops_alerts_open_idx ON public.ops_alerts USING btree (location_id) WHERE (status = 'sent'::text);

create index if not exists ops_audit_loc_idx ON public.ops_audit USING btree (location_id, created_at DESC);

create index if not exists ops_checklist_runs_loc_idx ON public.ops_checklist_runs USING btree (location_id, run_date DESC);

create index if not exists ops_checklist_tasks_cl_idx ON public.ops_checklist_tasks USING btree (checklist_id, sort_order);

create index if not exists ops_checklists_loc_idx ON public.ops_checklists USING btree (location_id) WHERE (archived_at IS NULL);

create unique index if not exists ops_devices_code_idx ON public.ops_devices USING btree (claim_code) WHERE (claim_code IS NOT NULL);

create index if not exists ops_devices_loc_idx ON public.ops_devices USING btree (location_id);

create index if not exists ops_devices_uid_idx ON public.ops_devices USING btree (device_uid);

create index if not exists ops_rules_loc_idx ON public.ops_notification_rules USING btree (location_id);

create index if not exists ops_task_compl_run_idx ON public.ops_task_completions USING btree (run_id);

create index if not exists idx_order_queue_catering_due ON public.order_queue USING btree (location_id, sent_at) WHERE ((source = 'catering'::text) AND (kitchen_routed_at IS NULL));

create index if not exists idx_order_queue_loc_status ON public.order_queue USING btree (location_id, status);

create index if not exists order_queue_event_date_idx ON public.order_queue USING btree (location_id, event_date) WHERE (event_date IS NOT NULL);

create unique index if not exists org_sending_domains_one_active ON public.org_sending_domains USING btree (org_id) WHERE is_active;

create index if not exists org_sending_domains_org_idx ON public.org_sending_domains USING btree (org_id);

create index if not exists par_levels_loc_idx ON public.par_levels USING btree (location_id);

create index if not exists po_lines_po_idx ON public.po_lines USING btree (po_id);

create index if not exists pos_nudges_loc_idx ON public.pos_nudges USING btree (location_id, created_at DESC);

create index if not exists prep_log_loc_date_idx ON public.prep_log USING btree (location_id, prep_date DESC);

create unique index if not exists prep_log_unique_day ON public.prep_log USING btree (location_id, schedule_id, prep_date);

create index if not exists prep_schedule_loc_idx ON public.prep_schedule USING btree (location_id, sort_order);

create index if not exists print_jobs_claim_reclaim_idx ON public.print_jobs USING btree (location_id, status, claim_expires_at) WHERE (status = ANY (ARRAY['sending'::text, 'claimed'::text]));

create index if not exists print_jobs_failure_queue_idx ON public.print_jobs USING btree (location_id, status, dismissed_at) WHERE ((status = 'failed_permanent'::text) AND (dismissed_at IS NULL));

create unique index if not exists print_jobs_idempotency_key_uniq ON public.print_jobs USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

create index if not exists print_jobs_pending ON public.print_jobs USING btree (location_id, status, created_at) WHERE (status = 'pending'::text);

create index if not exists print_jobs_retry_poll_idx ON public.print_jobs USING btree (location_id, status, next_retry_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

create index if not exists production_batches_loc_idx ON public.production_batches USING btree (location_id, created_at DESC);

create index if not exists production_batches_output_idx ON public.production_batches USING btree (output_item_id);

create unique index if not exists production_batches_sched_day ON public.production_batches USING btree (location_id, schedule_id, planned_for) WHERE ((schedule_id IS NOT NULL) AND (status <> 'CANCELLED'::text));

create unique index if not exists promo_codes_code_uidx ON public.promo_codes USING btree (upper(code));

create index if not exists promo_codes_customer_idx ON public.promo_codes USING btree (customer_id) WHERE (customer_id IS NOT NULL);

create index if not exists promo_codes_offer_idx ON public.promo_codes USING btree (offer_id);

create index if not exists promo_codes_status_idx ON public.promo_codes USING btree (org_id, status);

create index if not exists promo_redemptions_code_idx ON public.promo_redemptions USING btree (promo_code_id);

create unique index if not exists promo_redemptions_idem_uidx ON public.promo_redemptions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

create index if not exists promo_redemptions_offer_idx ON public.promo_redemptions USING btree (offer_id, redeemed_at DESC);

create index if not exists po_loc_idx ON public.purchase_orders USING btree (location_id, created_at DESC);

create index if not exists quote_accuracy_loc_idx ON public.quote_accuracy USING btree (location_id);

create index if not exists receipt_emails_check_idx ON public.receipt_emails USING btree (check_id) WHERE (check_id IS NOT NULL);

create index if not exists receipt_emails_location_idx ON public.receipt_emails USING btree (location_id);

create index if not exists receipt_emails_status_idx ON public.receipt_emails USING btree (status);

create index if not exists recipe_lines_comp_idx ON public.recipe_lines USING btree (component_item_id);

create index if not exists recipe_lines_recipe_idx ON public.recipe_lines USING btree (recipe_id);

create index if not exists recipes_loc_idx ON public.recipes USING btree (location_id) WHERE (archived_at IS NULL);

create index if not exists recipes_output_idx ON public.recipes USING btree (output_item_id);

create unique index if not exists review_feedback_external_uq ON public.review_feedback USING btree (external_review_id) WHERE (external_review_id IS NOT NULL);

create index if not exists review_feedback_loc_created ON public.review_feedback USING btree (location_id, created_at DESC);

create index if not exists review_feedback_status ON public.review_feedback USING btree (location_id, status);

create index if not exists review_platform_links_sync_queue_idx ON public.review_platform_links USING btree (last_attempt_at NULLS FIRST, last_synced_at NULLS FIRST) WHERE enabled;

create index if not exists review_replies_feedback ON public.review_replies USING btree (feedback_id);

create index if not exists review_replies_status ON public.review_replies USING btree (location_id, status);

create index if not exists review_requests_loc_created ON public.review_requests USING btree (location_id, created_at DESC);

create index if not exists review_requests_phone ON public.review_requests USING btree (location_id, customer_phone, created_at DESC);

create index if not exists review_themes_loc ON public.review_themes USING btree (location_id, sentiment);

create index if not exists segments_org_idx ON public.segments USING btree (org_id, created_at DESC);

create unique index if not exists idx_shifts_one_open_per_location ON public.shifts USING btree (location_id) WHERE (status = 'open'::text);

create index if not exists idx_shifts_opened_at ON public.shifts USING btree (location_id, opened_at DESC);

create index if not exists idx_sms_messages_location ON public.sms_messages USING btree (location_id);

create index if not exists idx_sms_messages_status ON public.sms_messages USING btree (status);

create index if not exists idx_sms_messages_type ON public.sms_messages USING btree (type);

create index if not exists staff_auth_events_loc_idx ON public.staff_auth_events USING btree (location_id, created_at DESC);

create unique index if not exists staff_members_nfc_card_uidx ON public.staff_members USING btree (location_id, nfc_card_id) WHERE (nfc_card_id IS NOT NULL);

create index if not exists idx_stamp_tx_customer ON public.stamp_transactions USING btree (customer_id, program_id);

create index if not exists idx_stamp_tx_location ON public.stamp_transactions USING btree (location_id);

create unique index if not exists idx_stamp_txn_idempotency ON public.stamp_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

create index if not exists stock_count_lines_count_idx ON public.stock_count_lines USING btree (count_id);

create index if not exists stock_counts_loc_idx ON public.stock_counts USING btree (location_id, created_at DESC);

create index if not exists idx_stock_levels_location ON public.stock_levels USING btree (location_id);

create unique index if not exists stock_mv_idem_uniq ON public.stock_movements USING btree (location_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

create index if not exists stock_mv_item_idx ON public.stock_movements USING btree (location_id, inventory_item_id, occurred_at DESC);

create index if not exists stock_mv_loc_time_idx ON public.stock_movements USING btree (location_id, occurred_at DESC);

create index if not exists supplier_invoice_lines_inv_idx ON public.supplier_invoice_lines USING btree (invoice_id);

create index if not exists supplier_invoices_loc_idx ON public.supplier_invoices USING btree (location_id, created_at DESC);

create index if not exists supplier_products_item_idx ON public.supplier_products USING btree (inventory_item_id);

create index if not exists supplier_products_sup_idx ON public.supplier_products USING btree (supplier_id);

create index if not exists suppliers_loc_idx ON public.suppliers USING btree (location_id);

create index if not exists table_reservations_loc_idx ON public.table_reservations USING btree (location_id);

create index if not exists temp_sched_loc_idx ON public.temp_check_schedules USING btree (location_id);

create index if not exists temp_sched_unit_idx ON public.temp_check_schedules USING btree (temp_unit_id);

create index if not exists temp_readings_loc_day_idx ON public.temp_readings USING btree (location_id, recorded_at DESC);

create index if not exists temp_readings_unit_idx ON public.temp_readings USING btree (temp_unit_id, recorded_at DESC);

create index if not exists temp_units_loc_idx ON public.temp_units USING btree (location_id) WHERE (archived_at IS NULL);

create unique index if not exists idx_td_adyen ON public.terminal_devices USING btree (adyen_terminal_id) WHERE ((status = 'paired'::text) AND (adyen_terminal_id IS NOT NULL));

create unique index if not exists idx_td_code ON public.terminal_devices USING btree (lower(claim_code)) WHERE (claim_code IS NOT NULL);

create index if not exists idx_td_loc ON public.terminal_devices USING btree (location_id);

create unique index if not exists idx_td_ryft ON public.terminal_devices USING btree (ryft_terminal_id) WHERE (status = 'paired'::text);

create unique index if not exists idx_td_serial ON public.terminal_devices USING btree (serial_number) WHERE (status = 'paired'::text);

create index if not exists idx_td_uid ON public.terminal_devices USING btree (device_uid);

create index if not exists idx_tj_check ON public.terminal_jobs USING btree (closed_check_id);

create index if not exists idx_tj_human ON public.terminal_jobs USING btree (location_id) WHERE needs_human;

create unique index if not exists idx_tj_nexo_service ON public.terminal_jobs USING btree (nexo_service_id) WHERE (nexo_service_id IS NOT NULL);

create unique index if not exists idx_tj_one_live_per_check ON public.terminal_jobs USING btree (check_key) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'tipping'::text, 'charging_unsent'::text, 'charging'::text, 'unknown'::text]));

create unique index if not exists idx_tj_one_live_per_terminal ON public.terminal_jobs USING btree (target_terminal_id) WHERE (status = ANY (ARRAY['claimed'::text, 'tipping'::text, 'charging_unsent'::text, 'charging'::text]));

create index if not exists idx_tj_paid_guard ON public.terminal_jobs USING btree (check_key) WHERE (status = 'approved'::text);

create unique index if not exists idx_tj_payment_session ON public.terminal_jobs USING btree (payment_session_id) WHERE (payment_session_id IS NOT NULL);

create index if not exists idx_tj_sweep ON public.terminal_jobs USING btree (claim_expires_at) WHERE (status = ANY (ARRAY['claimed'::text, 'tipping'::text, 'charging_unsent'::text, 'charging'::text, 'unknown'::text]));

create index if not exists idx_tj_target ON public.terminal_jobs USING btree (target_terminal_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text, 'tipping'::text, 'charging_unsent'::text, 'charging'::text]));

create index if not exists turn_time_stats_loc_idx ON public.turn_time_stats USING btree (location_id, party_band);

create index if not exists idx_user_locations_location ON public.user_locations USING btree (location_id);

create index if not exists idx_user_locations_user ON public.user_locations USING btree (user_id);

create unique index if not exists waitlist_devices_code_idx ON public.waitlist_devices USING btree (claim_code) WHERE (claim_code IS NOT NULL);

create index if not exists waitlist_devices_uid_idx ON public.waitlist_devices USING btree (device_uid);

create index if not exists waitlist_entries_loc_idx ON public.waitlist_entries USING btree (location_id);

create index if not exists waitlist_entries_loc_status_idx ON public.waitlist_entries USING btree (location_id, status);

create unique index if not exists waitlist_entries_token_idx ON public.waitlist_entries USING btree (public_token) WHERE (public_token IS NOT NULL);

create index if not exists waitlist_sms_inbound_entry_idx ON public.waitlist_sms_inbound USING btree (waitlist_entry_id);

create index if not exists waitlist_sms_inbound_loc_idx ON public.waitlist_sms_inbound USING btree (location_id, received_at DESC);

create unique index if not exists waitlist_sms_inbound_sid_idx ON public.waitlist_sms_inbound USING btree (provider_sid);

create index if not exists waitlist_events_entry_idx ON public.waitlist_status_events USING btree (waitlist_entry_id);

create index if not exists waste_events_loc_idx ON public.waste_events USING btree (location_id, occurred_at DESC);

create index if not exists idx_wf_ann_loc_created ON public.wf_announcements USING btree (location_id, created_at DESC);

create index if not exists idx_wf_announce_loc ON public.wf_announcements USING btree (location_id);

create index if not exists idx_wf_audit_loc_at ON public.wf_audit USING btree (location_id, at);

create index if not exists idx_wf_avail_staff ON public.wf_availability USING btree (staff_id);

create index if not exists idx_wf_tpl_loc ON public.wf_doc_templates USING btree (location_id, kind);

create index if not exists idx_wf_docs_loc ON public.wf_documents USING btree (location_id);

create index if not exists idx_wf_documents_staff ON public.wf_documents USING btree (staff_id);

create index if not exists idx_wf_accrual_loc ON public.wf_holiday_accrual USING btree (location_id);

create index if not exists idx_wf_accrual_staff ON public.wf_holiday_accrual USING btree (staff_id);

create index if not exists idx_wf_onb_token ON public.wf_onboarding USING btree (((meta ->> 'signToken'::text)));

create index if not exists idx_wf_onboarding_staff ON public.wf_onboarding USING btree (staff_id);

create index if not exists idx_wf_payroll_runs_loc ON public.wf_payroll_runs USING btree (location_id, period_start DESC);

create index if not exists idx_wf_rate_changes_loc ON public.wf_rate_changes USING btree (location_id, status, effective_from);

create index if not exists idx_wf_roles_loc ON public.wf_roles USING btree (location_id);

create index if not exists idx_wf_forecast_loc_date ON public.wf_sales_forecast USING btree (location_id, forecast_date);

create index if not exists idx_wf_sections_loc ON public.wf_sections USING btree (location_id);

create index if not exists idx_wf_shifts_loc_date ON public.wf_shifts USING btree (location_id, shift_date);

create index if not exists idx_wf_shifts_org ON public.wf_shifts USING btree (org_id);

create index if not exists idx_wf_shifts_staff ON public.wf_shifts USING btree (staff_id);

create index if not exists idx_wf_staff_loc ON public.wf_staff USING btree (location_id);

create index if not exists idx_wf_staff_org ON public.wf_staff USING btree (org_id);

create index if not exists idx_wf_staff_pos ON public.wf_staff USING btree (pos_user_id);

create index if not exists idx_wf_swap_shift ON public.wf_swap_requests USING btree (shift_id);

create index if not exists idx_wf_timeoff_staff ON public.wf_time_off USING btree (staff_id);

create index if not exists idx_wf_timesheets_loc ON public.wf_timesheets USING btree (location_id);

create index if not exists idx_wf_timesheets_org ON public.wf_timesheets USING btree (org_id);

create index if not exists idx_wf_timesheets_staff ON public.wf_timesheets USING btree (staff_id);

create index if not exists idx_wf_ts_loc_clockin ON public.wf_timesheets USING btree (location_id, clock_in DESC);

create index if not exists idx_wf_ts_loc_status_clockin ON public.wf_timesheets USING btree (location_id, status, clock_in);

create index if not exists idx_wf_ts_payroll_run ON public.wf_timesheets USING btree (payroll_run_id);

create index if not exists idx_wf_tronc_lines_run ON public.wf_tronc_lines USING btree (run_id);

create index if not exists idx_wf_tronc_lines_staff ON public.wf_tronc_lines USING btree (staff_id);

create index if not exists idx_wf_tronc_loc_week ON public.wf_tronc_runs USING btree (location_id, week_start);

create index if not exists idx_wf_user_roles_loc ON public.wf_user_roles USING btree (location_id);

create index if not exists idx_wf_user_roles_user ON public.wf_user_roles USING btree (user_id);

create index if not exists wifi_captures_loc_created_idx ON public.wifi_captures USING btree (location_id, created_at DESC);

create index if not exists wifi_captures_mac_idx ON public.wifi_captures USING btree (location_id, client_mac);

create index if not exists workflow_enrollments_due_idx ON public.workflow_enrollments USING btree (workflow_id, status, next_run_at);

create index if not exists workflow_enrollments_org_idx ON public.workflow_enrollments USING btree (org_id);

create unique index if not exists workflow_enrollments_uidx ON public.workflow_enrollments USING btree (workflow_id, customer_id);

create index if not exists workflow_step_sends_org_idx ON public.workflow_step_sends USING btree (org_id, created_at DESC);

create unique index if not exists workflow_step_sends_uidx ON public.workflow_step_sends USING btree (enrollment_id, step_key);

create index if not exists workflows_active_idx ON public.workflows USING btree (status) WHERE (status = 'active'::text);

create index if not exists workflows_org_idx ON public.workflows USING btree (org_id, created_at DESC);

create unique index if not exists xero_sync_log_daily_uniq ON public.xero_sync_log USING btree (location_id, kind, ref_date) WHERE (ref_date IS NOT NULL);

create unique index if not exists xero_sync_log_ref_uniq ON public.xero_sync_log USING btree (location_id, kind, ref_id) WHERE (ref_id IS NOT NULL);

-- --------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY — ENABLE  (161)
-- Every table in public has RLS enabled live; 22 also FORCE it (so the
-- table owner is not exempt). Policies are in section 8, after the
-- functions they call.
-- --------------------------------------------------------------------------

alter table public.active_sessions enable row level security;

alter table public.activity_events enable row level security;

alter table public.bar_tabs enable row level security;

alter table public.campaign_runs enable row level security;

alter table public.campaign_sends enable row level security;

alter table public.campaigns enable row level security;

alter table public.cash_drawers enable row level security;

alter table public.cash_movements enable row level security;

alter table public.catering_site_settings enable row level security;
alter table public.catering_site_settings force row level security;

alter table public.challenge_21_checks enable row level security;

alter table public.closed_checks enable row level security;

alter table public.config_pushes enable row level security;

alter table public.corrective_actions enable row level security;

alter table public.courier_deliveries enable row level security;

alter table public.customer_consents enable row level security;

alter table public.customer_locations enable row level security;

alter table public.customer_orders enable row level security;

alter table public.customers enable row level security;

alter table public.deliveries enable row level security;

alter table public.delivery_costs_actual enable row level security;

alter table public.delivery_quotes enable row level security;

alter table public.delivery_status_events enable row level security;

alter table public.delivery_surcharges enable row level security;

alter table public.device_heartbeats enable row level security;

alter table public.device_profiles enable row level security;

alter table public.devices enable row level security;

alter table public.discount_rules enable row level security;

alter table public.discounts enable row level security;

alter table public.drawer_sessions enable row level security;

alter table public.eighty_six enable row level security;

alter table public.floor_tables enable row level security;

alter table public.hubrise_connections enable row level security;

alter table public.hubrise_events enable row level security;

alter table public.hubrise_oauth_pending enable row level security;

alter table public.hubrise_order_links enable row level security;

alter table public.inventory_item_conversions enable row level security;

alter table public.inventory_items enable row level security;

alter table public.item_cost_history enable row level security;

alter table public.item_packaging_formats enable row level security;

alter table public.item_variants enable row level security;

alter table public.kds_tickets enable row level security;

alter table public.location_features enable row level security;

alter table public.locations enable row level security;

alter table public.loyalty_transactions enable row level security;

alter table public.maintenance_notes enable row level security;

alter table public.maintenance_requests enable row level security;

alter table public.maintenance_status_history enable row level security;

alter table public.marketing_messages enable row level security;

alter table public.marketing_suppressions enable row level security;

alter table public.menu_board_screens enable row level security;

alter table public.menu_boards enable row level security;

alter table public.menu_categories enable row level security;

alter table public.menu_category_links enable row level security;

alter table public.menu_item_recipes enable row level security;

alter table public.menu_items enable row level security;

alter table public.menus enable row level security;

alter table public.modifier_groups enable row level security;

alter table public.modifier_options enable row level security;

alter table public.offers enable row level security;

alter table public.ops_alerts enable row level security;

alter table public.ops_audit enable row level security;

alter table public.ops_checklist_runs enable row level security;

alter table public.ops_checklist_tasks enable row level security;

alter table public.ops_checklists enable row level security;

alter table public.ops_devices enable row level security;

alter table public.ops_notification_rules enable row level security;

alter table public.ops_task_completions enable row level security;

alter table public.order_notifications enable row level security;

alter table public.order_queue enable row level security;

alter table public.org_sending_domains enable row level security;

alter table public.organisations enable row level security;

alter table public.par_levels enable row level security;

alter table public.po_lines enable row level security;

alter table public.pos_nudges enable row level security;

alter table public.prep_log enable row level security;

alter table public.prep_schedule enable row level security;

alter table public.print_jobs enable row level security;

alter table public.print_routing enable row level security;

alter table public.printer_agents enable row level security;

alter table public.printer_health enable row level security;

alter table public.printers enable row level security;

alter table public.production_batches enable row level security;

alter table public.promo_codes enable row level security;

alter table public.promo_redemptions enable row level security;

alter table public.purchase_orders enable row level security;

alter table public.quote_accuracy enable row level security;

alter table public.receipt_emails enable row level security;

alter table public.recipe_lines enable row level security;

alter table public.recipes enable row level security;

alter table public.review_feedback enable row level security;

alter table public.review_google_tokens enable row level security;

alter table public.review_oauth_pending enable row level security;

alter table public.review_platform_links enable row level security;

alter table public.review_replies enable row level security;

alter table public.review_requests enable row level security;

alter table public.review_settings enable row level security;

alter table public.review_themes enable row level security;

alter table public.sections enable row level security;

alter table public.segments enable row level security;

alter table public.shifts enable row level security;

alter table public.sms_messages enable row level security;

alter table public.staff_auth_events enable row level security;

alter table public.staff_members enable row level security;

alter table public.stamp_transactions enable row level security;

alter table public.stock_count_lines enable row level security;

alter table public.stock_counts enable row level security;

alter table public.stock_levels enable row level security;

alter table public.stock_movements enable row level security;

alter table public.stock_units enable row level security;

alter table public.subscriptions enable row level security;

alter table public.supplier_invoice_lines enable row level security;

alter table public.supplier_invoices enable row level security;

alter table public.supplier_products enable row level security;

alter table public.suppliers enable row level security;

alter table public.table_reservations enable row level security;

alter table public.tax_rates enable row level security;

alter table public.temp_check_schedules enable row level security;

alter table public.temp_readings enable row level security;

alter table public.temp_units enable row level security;

alter table public.terminal_devices enable row level security;

alter table public.terminal_jobs enable row level security;

alter table public.turn_time_stats enable row level security;

alter table public.user_locations enable row level security;

alter table public.user_profiles enable row level security;

alter table public.venue_uber_config enable row level security;

alter table public.waitlist_config enable row level security;

alter table public.waitlist_devices enable row level security;

alter table public.waitlist_entries enable row level security;

alter table public.waitlist_sms_inbound enable row level security;

alter table public.waitlist_status_events enable row level security;

alter table public.waste_events enable row level security;

alter table public.wf_announcements enable row level security;
alter table public.wf_announcements force row level security;

alter table public.wf_audit enable row level security;
alter table public.wf_audit force row level security;

alter table public.wf_availability enable row level security;
alter table public.wf_availability force row level security;

alter table public.wf_doc_templates enable row level security;
alter table public.wf_doc_templates force row level security;

alter table public.wf_documents enable row level security;
alter table public.wf_documents force row level security;

alter table public.wf_holiday_accrual enable row level security;
alter table public.wf_holiday_accrual force row level security;

alter table public.wf_onboarding enable row level security;
alter table public.wf_onboarding force row level security;

alter table public.wf_payroll_runs enable row level security;
alter table public.wf_payroll_runs force row level security;

alter table public.wf_rate_changes enable row level security;
alter table public.wf_rate_changes force row level security;

alter table public.wf_roles enable row level security;
alter table public.wf_roles force row level security;

alter table public.wf_sales_forecast enable row level security;
alter table public.wf_sales_forecast force row level security;

alter table public.wf_sections enable row level security;
alter table public.wf_sections force row level security;

alter table public.wf_shifts enable row level security;
alter table public.wf_shifts force row level security;

alter table public.wf_staff enable row level security;
alter table public.wf_staff force row level security;

alter table public.wf_swap_requests enable row level security;
alter table public.wf_swap_requests force row level security;

alter table public.wf_time_off enable row level security;
alter table public.wf_time_off force row level security;

alter table public.wf_timesheets enable row level security;
alter table public.wf_timesheets force row level security;

alter table public.wf_tronc_lines enable row level security;
alter table public.wf_tronc_lines force row level security;

alter table public.wf_tronc_runs enable row level security;
alter table public.wf_tronc_runs force row level security;

alter table public.wf_user_roles enable row level security;
alter table public.wf_user_roles force row level security;

alter table public.wf_venue_settings enable row level security;
alter table public.wf_venue_settings force row level security;

alter table public.wifi_captures enable row level security;

alter table public.wifi_portal_settings enable row level security;

alter table public.wifi_unifi_bindings enable row level security;

alter table public.workflow_enrollments enable row level security;

alter table public.workflow_step_sends enable row level security;

alter table public.workflows enable row level security;

alter table public.xero_config enable row level security;

alter table public.xero_connections enable row level security;

alter table public.xero_sync_log enable row level security;

-- --------------------------------------------------------------------------
-- 6. FUNCTIONS  (88)
-- pg_get_functiondef() verbatim — already CREATE OR REPLACE, so
-- idempotent as-is. 64 plpgsql, 24 sql. Emitted before policies and
-- triggers because both depend on them, and after tables because three
-- signatures return a table rowtype (_terminal_for_caller,
-- claim_menu_board_screen, set_menu_board_screen).
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mb_user_has_location(p_loc uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_loc is not null and (
    exists (select 1 from user_locations where user_id = auth.uid() and location_id = p_loc)
    or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
  );
$function$;
CREATE OR REPLACE FUNCTION public._terminal_for_caller()
 RETURNS terminal_devices
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into t from terminal_devices
   where device_uid = auth.uid() and status = 'paired' and active
   order by last_seen_at desc nulls last, claimed_at desc nulls last
   limit 1;
  if t.id is null then raise exception 'terminal is not paired'; end if;
  if t.location_id is null then raise exception 'terminal has no location'; end if;
  return t;
end; $function$;
CREATE OR REPLACE FUNCTION public._terminal_gen_code()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$function$;
CREATE OR REPLACE FUNCTION public._terminal_is_service_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role';
$function$;
CREATE OR REPLACE FUNCTION public._terminal_norm_idle_screen(p jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when p is null or jsonb_typeof(p) <> 'object' then null
    when coalesce((p ->> 'enabled')::boolean, false) is not true then jsonb_build_object('enabled', false)
    when nullif(btrim(coalesce(p ->> 'imageUrl', '')), '') is null then jsonb_build_object('enabled', false)
    else jsonb_build_object(
      'enabled',  true,
      'imageUrl', btrim(p ->> 'imageUrl')
    )
  end;
$function$;
CREATE OR REPLACE FUNCTION public._terminal_norm_modes(p jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when p is null or jsonb_typeof(p) <> 'object' then null   -- NULL = all enabled
    else jsonb_build_object(
      'table_pay',    coalesce((p ->> 'table_pay')::boolean, true),
      'manual',       coalesce((p ->> 'manual')::boolean, true),
      'pos_dispatch', coalesce((p ->> 'pos_dispatch')::boolean, true)
    )
  end;
$function$;
CREATE OR REPLACE FUNCTION public._terminal_norm_tip_config(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enabled  boolean;
  v_custom   boolean;
  v_thresh   bigint;
  v_pcts     jsonb := '[]'::jsonb;
  v_el       jsonb;
  v_n        numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    -- Same fail-closed default terminal_start_table_payment uses.
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  v_enabled := coalesce((p ->> 'enabled')::boolean, (p ->> 'tipping_enabled')::boolean, false);
  if not v_enabled then
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  -- Accept any of the three spellings on the way IN; emit two canonical ones OUT.
  for v_el in
    select value from jsonb_array_elements(
      coalesce(
        case when jsonb_typeof(p -> 'percentBands')    = 'array' then p -> 'percentBands'    end,
        case when jsonb_typeof(p -> 'tip_percentages') = 'array' then p -> 'tip_percentages' end,
        case when jsonb_typeof(p -> 'percentages')     = 'array' then p -> 'percentages'     end,
        '[]'::jsonb))
  loop
    -- A non-numeric band is a broken row, not a tip option. Null it and let the
    -- guard below drop it — deliberately NOT `continue` inside the handler, which
    -- is a plpgsql control-flow trap in an exception block.
    begin
      v_n := (v_el #>> '{}')::numeric;
    exception when others then
      v_n := null;
    end;
    -- 0%, a negative, or an absurd band is not a tip option (mirrors fromJobJson).
    if v_n is null or v_n <= 0 or v_n > 100 then continue; end if;
    if jsonb_array_length(v_pcts) >= 5 then exit; end if;   -- 5 buttons is all the screen has
    v_pcts := v_pcts || to_jsonb(v_n);
  end loop;

  -- Tipping on with no usable band is not a state the terminal can render, and
  -- inventing 10/12.5/15 would put percentages in front of a customer that
  -- nobody at the venue agreed to. Off is the honest answer.
  if jsonb_array_length(v_pcts) = 0 then
    return jsonb_build_object('enabled', false, 'tipping_enabled', false);
  end if;

  v_custom := coalesce((p ->> 'allowCustom')::boolean, (p ->> 'allow_custom')::boolean, true);

  begin
    v_thresh := nullif(p ->> 'smartThresholdMinor', '')::bigint;
  exception when others then
    v_thresh := null;
  end;
  if v_thresh is not null and v_thresh < 0 then v_thresh := null; end if;

  return jsonb_build_object(
    'enabled',             true,
    'tipping_enabled',     true,     -- Back Office vocabulary
    'percentBands',        v_pcts,
    'tip_percentages',     v_pcts,   -- Back Office vocabulary
    'allowCustom',         v_custom,
    'allow_custom',        v_custom,
    'smartThresholdMinor', case when v_thresh is null then null else to_jsonb(v_thresh) end,
    -- allowNoTip is NOT configurable and never will be. Trapping a customer on a
    -- tip screen is not a setting; the terminal hard-codes it true regardless.
    'allowNoTip',          true
  );
end; $function$;
CREATE OR REPLACE FUNCTION public._terminal_user_has_location(p_loc uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p_loc is not null and (
    exists (select 1 from user_locations where user_id = auth.uid() and location_id = p_loc)
    or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
  );
$function$;
CREATE OR REPLACE FUNCTION public._touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at = now(); return new; end;
$function$;
CREATE OR REPLACE FUNCTION public._wl_self_open(p_location uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 30-min liveness window: self-service is "open" only while a host stand is actually present
  -- (it heartbeats every ~60s). Closes promptly when the stand walks away — limits the unattended
  -- self-join window (anti-spam) and keeps quotes fresh.
  select coalesce((select self_service_enabled from waitlist_config where location_id = p_location), false)
     and exists (select 1 from waitlist_devices d
                 where d.location_id = p_location and d.active
                   and coalesce(d.last_seen_at, d.claimed_at) > now() - interval '30 minutes');
$function$;
CREATE OR REPLACE FUNCTION public.apply_due_wf_rate_changes()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n integer := 0;
begin
  for r in
    select * from wf_rate_changes
     where status = 'scheduled' and effective_from <= current_date
     order by effective_from, created_at
  loop
    if r.target_kind = 'role' then
      update wf_roles
         set base_rate     = coalesce(r.new_rate, base_rate),
             salary_annual = coalesce(r.new_salary_annual, salary_annual),
             -- a scheduled salary implies salaried pay; a scheduled hourly rate
             -- keeps whatever pay_type the role already has
             pay_type      = case when r.new_salary_annual is not null and r.new_rate is null
                                  then 'salaried' else pay_type end
       where location_id = r.location_id and key = r.role_key;
    else
      update wf_staff set rate_override = r.new_rate where id = r.staff_id;
    end if;
    update wf_rate_changes set status = 'applied', applied_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $function$;
CREATE OR REPLACE FUNCTION public.call_edge_fn(fn text, body jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'net'
AS $function$
declare k text; base text; req bigint;
begin
  if fn is null or fn = '' then raise exception 'call_edge_fn: fn is required'; end if;
  base := public.edge_base_url();

  select decrypted_secret into k from vault.decrypted_secrets where name = 'edge_cron_key' limit 1;
  if k is null or k = '' then
    select decrypted_secret into k from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  end if;
  if k is null or k = '' then
    raise exception 'call_edge_fn: no key in vault (expected edge_cron_key, or xero_cron_key as fallback)';
  end if;

  select net.http_post(
    url                  := base || '/functions/v1/' || fn,
    body                 := coalesce(body, '{}'::jsonb),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k),
    timeout_milliseconds := 25000
  ) into req;

  return req;
end;
$function$;
CREATE OR REPLACE FUNCTION public.can_claim_location(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select not public.is_anon_session()
     and not exists (
           select 1 from public.user_locations ul
            where ul.location_id = p_location_id
              and ul.user_id is distinct from auth.uid()
         )
     and exists (
           select 1
             from public.locations l
             join public.user_profiles up on up.id = auth.uid()
            where l.id = p_location_id
              and up.org_id is not null
              and l.org_id = up.org_id
         );
$function$;
CREATE OR REPLACE FUNCTION public.catering_public_settings(p_location uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (to_jsonb(c) - 'created_at' - 'updated_at')
         || jsonb_build_object('venue_timezone', coalesce(l.timezone, 'Europe/London'))
  from catering_site_settings c
  join locations l on l.id = c.location_id
  where c.location_id = p_location and c.enabled = true;
$function$;
CREATE OR REPLACE FUNCTION public.claim_device(p_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_loc uuid;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'no auth session';
  end if;
  select id, location_id into v_id, v_loc
  from public.devices
  where pairing_code = upper(trim(p_code)) and status <> 'removed'
  limit 1;
  if v_id is null then
    return null;
  end if;
  update public.devices
    set device_uid = auth.uid(), last_seen = now()
    where id = v_id;
  return v_loc;
end;
$function$;
CREATE OR REPLACE FUNCTION public.claim_menu_board_screen(p_code text, p_board_id uuid)
 RETURNS menu_board_screens
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b record; s record;
begin
  select id, location_id, org_id into b from menu_boards where id = p_board_id;
  if b.id is null then raise exception 'board not found'; end if;
  if not _mb_user_has_location(b.location_id) then raise exception 'no access to this location'; end if;
  select * into s from menu_board_screens where lower(code) = lower(btrim(p_code)) limit 1;
  if s.id is null then raise exception 'pairing code not found'; end if;
  if s.location_id is not null and not _mb_user_has_location(s.location_id)
    then raise exception 'screen belongs to another location'; end if;
  -- TTL: only an actively-online (or just-registered) screen may be claimed.
  if coalesce(s.last_seen_at, s.created_at) < now() - interval '30 minutes'
    then raise exception 'pairing code expired — restart the screen to get a new code'; end if;
  update menu_board_screens
     set board_id = b.id, location_id = b.location_id, org_id = b.org_id,
         status = 'paired', paired_at = now(), updated_at = now()
   where id = s.id;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $function$;
CREATE OR REPLACE FUNCTION public.claim_ops_device(p_code text, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v ops_devices; v_org uuid;
begin
  if not (p_location_id::text in (select user_accessible_locations())) then
    raise exception 'not authorized for this location';
  end if;
  select org_id into v_org from locations where id = p_location_id;
  update ops_devices set location_id = p_location_id, org_id = v_org, claimed_at = now()
    where claim_code = p_code and (location_id is null or location_id = p_location_id) returning * into v;
  if not found then raise exception 'code not found'; end if;
  return jsonb_build_object('id', v.id, 'location_id', v.location_id);
end $function$;
CREATE OR REPLACE FUNCTION public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row terminal_devices; v_org uuid; v_prior_ryft text; v_prior_adyen text;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  -- The manager must have access to the location they are pairing INTO. This is
  -- what stops a code from one venue being bound to another venue's terminal.
  if not _terminal_user_has_location(p_location_id) then raise exception 'no access to this location'; end if;

  select * into v_row from terminal_devices
   where lower(claim_code) = lower(btrim(coalesce(p_claim_code, ''))) and status = 'unpaired'
   limit 1;
  if v_row.id is null then raise exception 'pairing code not found'; end if;

  -- TTL — only a terminal that is actually live (or just registered) may be
  -- claimed. Stops abandoned codes being pre-claimed later.
  if coalesce(v_row.last_seen_at, v_row.created_at) < now() - interval '30 minutes' then
    raise exception 'pairing code expired — restart the terminal to get a new code';
  end if;

  select org_id into v_org from locations where id = p_location_id;

  -- Capture the prior paired row's processor links BEFORE retiring it, so a
  -- reinstall / re-pair carries them forward instead of re-NULLing. Scoped to
  -- the same serial and to locations this manager can see (never touch another
  -- tenant's row on a serial collision).
  select ryft_terminal_id into v_prior_ryft
    from terminal_devices
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and ryft_terminal_id is not null
     and _terminal_user_has_location(location_id)
   limit 1;

  select adyen_terminal_id into v_prior_adyen
    from terminal_devices
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and adyen_terminal_id is not null
     and _terminal_user_has_location(location_id)
   limit 1;

  -- Retire any prior PAIRED row for the same physical serial (reinstall / re-pair).
  -- Also frees idx_td_serial, idx_td_ryft AND idx_td_adyen for the new row. Only
  -- rows at a location this manager can see are touched.
  update terminal_devices
     set status = 'retired', active = false, claim_code = null, updated_at = now()
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and _terminal_user_has_location(location_id);

  update terminal_devices
     set location_id = p_location_id,          -- SERVER-validated, never device-supplied
         org_id      = v_org,
         label       = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         status      = 'paired',
         active      = true,
         claim_code  = null,                   -- single use: the code cannot be replayed
         claimed_at  = now(),
         -- Carry the retiring row's processor links forward. coalesce keeps this
         -- row's own ids if it already had them; the retire above freed the
         -- partial unique indexes so no collision.
         ryft_terminal_id  = coalesce(v_prior_ryft, ryft_terminal_id),
         adyen_terminal_id = coalesce(v_prior_adyen, adyen_terminal_id),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $function$;
CREATE OR REPLACE FUNCTION public.claim_waitlist_device(p_code text, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v waitlist_devices; v_org uuid;
begin
  if not (p_location_id::text in (select user_accessible_locations())) then
    raise exception 'not authorized for this location';
  end if;
  select org_id into v_org from locations where id = p_location_id;
  -- 30-min TTL: an unclaimed code only works while the stand is alive (it heartbeats every few
  -- seconds on the pair screen). Prevents brute-force / stale-code binding (menu-board precedent).
  update waitlist_devices set location_id = p_location_id, org_id = v_org, claimed_at = now()
    where claim_code = p_code and (location_id is null or location_id = p_location_id)
      and coalesce(last_seen_at, created_at) > now() - interval '30 minutes' returning * into v;
  if not found then raise exception 'code not found or expired'; end if;
  return jsonb_build_object('id', v.id, 'location_id', v.location_id);
end $function$;
CREATE OR REPLACE FUNCTION public.decrement_stock(p_location_id text, p_item_id text, p_qty integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_new_remaining int;
  v_par int;
BEGIN
  UPDATE public.stock_levels
  SET remaining = GREATEST(0, remaining - p_qty),
      updated_at = now()
  WHERE location_id = p_location_id AND item_id = p_item_id
  RETURNING remaining, par INTO v_new_remaining, v_par;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('tracked', false);
  END IF;

  IF v_new_remaining <= 0 THEN
    INSERT INTO public.eighty_six (location_id, item_id)
    VALUES (p_location_id, p_item_id)
    ON CONFLICT (location_id, item_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'tracked', true,
    'remaining', v_new_remaining,
    'par', v_par
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.edge_base_url()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
declare u text; sysid text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name = 'edge_base_url' limit 1;
  if u is not null and u <> '' then
    return rtrim(u, '/');
  end if;

  select system_identifier::text into sysid from pg_control_system();
  if sysid = '7623125441096521075' then          -- the ops dev cluster, 5 Aug 2026
    return 'https://tbetcegmszzotrwdtqhi.supabase.co';
  end if;

  raise exception
    'edge_base_url is not configured on this database (system_identifier=%). Run: select vault.create_secret(''https://<project-ref>.supabase.co'', ''edge_base_url'', ''pg_cron -> edge functions'');',
    sysid;
end;
$function$;
CREATE OR REPLACE FUNCTION public.get_plan_for_gmv(gmv numeric)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
                                                                                                                    begin
                                                                                                                      if gmv <= 5000 then return 'free';
                                                                                                                        elsif gmv <= 8000 then return 'starter';
                                                                                                                          elsif gmv <= 10000 then return 'growth';
                                                                                                                            elsif gmv <= 20000 then return 'scale';
                                                                                                                              else return 'enterprise';
                                                                                                                                end if;
                                                                                                                                end;
                                                                                                                                $function$;
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  begin
    insert into public.user_profiles (id, email, full_name, role, bo_access)
    values (new.id, new.email,
            coalesce(new.raw_user_meta_data->>'full_name', new.email),
            'owner',  -- SERVER-SIDE LITERAL. Never from raw_user_meta_data.
            case when new.is_anonymous then false else true end)
    on conflict (id) do update set email = coalesce(public.user_profiles.email, excluded.email);
    return new;
  end;
$function$;
CREATE OR REPLACE FUNCTION public.is_anon_session()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean,
    false
  );
$function$;
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select not public.is_anon_session()
     and coalesce((select role = 'super_admin' from public.user_profiles where id = auth.uid()), false);
$function$;
CREATE OR REPLACE FUNCTION public.log_order_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    insert into activity_events (location_id, kind, severity, title, body, ref_type, ref_id)
    values (
      new.location_id, 'order', 'info',
      initcap(coalesce(nullif(new.source, ''), nullif(new.type, ''), 'New')) || ' order',
      nullif(new.ref, ''),
      'order', new.ref
    );
  exception when others then null;  -- the activity feed must never break ordering
  end;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.marketing_ab_report(p_org uuid, p_campaign uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select customer_id, variant_key, email_message_id
    from campaign_sends
    where org_id = p_org and campaign_id = p_campaign and variant_key is not null
  ),
  agg as (
    select s.variant_key,
           count(*)                                            as sent,
           count(*) filter (where mm.opened_at  is not null)   as opened,
           count(*) filter (where mm.clicked_at is not null)   as clicked
    from s left join marketing_messages mm on mm.id = s.email_message_id
    group by s.variant_key
  ),
  red as (
    -- A redemption counts for a variant only if the code was issued by THIS campaign and the
    -- redeeming customer was actually sent that variant.
    select s.variant_key, count(distinct pr.id) as redeemed
    from promo_redemptions pr
    join promo_codes pc on pc.id = pr.promo_code_id and pc.campaign_id = p_campaign
    join s on s.customer_id = pr.customer_id
    where pr.org_id = p_org
    group by s.variant_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'variant',  a.variant_key,
           'sent',     a.sent,
           'opened',   a.opened,
           'clicked',  a.clicked,
           'redeemed', coalesce(r.redeemed, 0)
         ) order by a.variant_key), '[]'::jsonb)
  from agg a left join red r on r.variant_key = a.variant_key;
$function$;
CREATE OR REPLACE FUNCTION public.marketing_period_sales(p_org uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(sum(cc.total), 0)
  from closed_checks cc
  where cc.location_id in (select id::text from locations where org_id = p_org)
    and cc.closed_at >= p_start and cc.closed_at <= p_end;
$function$;
CREATE OR REPLACE FUNCTION public.marketing_report(p_org uuid, p_since timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with msg as (
    select * from marketing_messages where org_id = p_org and created_at >= p_since
  ),
  red as (
    select pr.discount_value, pr.order_id, pr.offer_id, pc.campaign_id
    from promo_redemptions pr
    left join promo_codes pc on pc.id = pr.promo_code_id
    where pr.org_id = p_org and pr.redeemed_at >= p_since
  ),
  rev as (
    select r.*, cc.total as order_total from red r left join closed_checks cc on cc.id = r.order_id
  ),
  wss as (   -- workflow step sends in window that actually dispatched a message
    select workflow_id, email_message_id, promo_code
    from workflow_step_sends
    where org_id = p_org and created_at >= p_since and status in ('sent','partial')
  ),
  wred as (  -- redemptions in window attributed to the workflow whose step issued that code (dedupe on pr.id)
    select distinct pr.id as redemption_id, s.workflow_id, pr.discount_value, cc.total as order_total
    from workflow_step_sends s
    join promo_redemptions pr on pr.org_id = p_org and pr.code = s.promo_code and pr.redeemed_at >= p_since
    left join closed_checks cc on cc.id = pr.order_id
    where s.org_id = p_org and coalesce(s.promo_code, '') <> ''
  )
  select jsonb_build_object(
    'messages', jsonb_build_object(
      'total',     (select count(*) from msg),
      'delivered', (select count(*) from msg where delivered_at is not null),
      'opened',    (select count(*) from msg where opened_at is not null),
      'clicked',   (select count(*) from msg where clicked_at is not null),
      'email',     (select count(*) from msg where channel = 'email'),
      'sms',       (select count(*) from msg where channel = 'sms'),
      'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb) from (select status, count(*) c from msg group by status) s)
    ),
    'redemptions', jsonb_build_object(
      'count',    (select count(*) from red),
      'discount', (select coalesce(sum(discount_value), 0) from red),
      'revenue',  (select coalesce(sum(order_total), 0) from rev)
    ),
    'campaigns', (
      select coalesce(jsonb_agg(x order by (x->>'sent')::int desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'campaign_id', c.id, 'name', c.name, 'status', c.status,
          'sent',     (select count(*) from msg where campaign_id = c.id),
          'opened',   (select count(*) from msg where campaign_id = c.id and opened_at is not null),
          'clicked',  (select count(*) from msg where campaign_id = c.id and clicked_at is not null),
          'redeemed', (select count(*) from red where campaign_id = c.id),
          'discount', (select coalesce(sum(discount_value), 0) from red where campaign_id = c.id),
          'revenue',  (select coalesce(sum(order_total), 0) from rev where campaign_id = c.id)
        ) x
        from campaigns c where c.org_id = p_org
      ) y
    ),
    'offers', (
      select coalesce(jsonb_agg(x order by (x->>'redeemed')::int desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'offer_id', o.id, 'name', o.name,
          'issued',   (select count(*) from promo_codes pc where pc.offer_id = o.id and pc.org_id = p_org),
          'redeemed', (select count(*) from promo_redemptions pr where pr.offer_id = o.id and pr.org_id = p_org),
          'discount', (select coalesce(sum(pr.discount_value), 0) from promo_redemptions pr where pr.offer_id = o.id and pr.org_id = p_org)
        ) x
        from offers o where o.org_id = p_org
      ) y
    ),
    'workflows', (
      select coalesce(jsonb_agg(x order by (x->>'sent')::int desc, x->>'enrolled' desc, x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object(
          'workflow_id', w.id, 'name', w.name, 'status', w.status,
          'enrolled',  (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.enrolled_at  >= p_since),
          'completed', (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.completed_at >= p_since),
          'active',    (select count(*) from workflow_enrollments e where e.org_id = p_org and e.workflow_id = w.id and e.status = 'active'),
          'sent',      (select count(*) from wss where wss.workflow_id = w.id),
          'opened',    (select count(*) from wss join marketing_messages mm on mm.id = wss.email_message_id where wss.workflow_id = w.id and mm.opened_at  is not null),
          'clicked',   (select count(*) from wss join marketing_messages mm on mm.id = wss.email_message_id where wss.workflow_id = w.id and mm.clicked_at is not null),
          'redeemed',  (select count(*) from wred where wred.workflow_id = w.id),
          'discount',  (select coalesce(sum(discount_value), 0) from wred where wred.workflow_id = w.id),
          'revenue',   (select coalesce(sum(order_total), 0) from wred where wred.workflow_id = w.id)
        ) x
        from workflows w where w.org_id = p_org
      ) y
    )
  )
$function$;
CREATE OR REPLACE FUNCTION public.marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit integer DEFAULT NULL::integer)
 RETURNS TABLE(customer_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_match  text := lower(coalesce(p_def->>'match','all'));
  v_join   text := case when v_match = 'any' then ' OR ' else ' AND ' end;
  v_rule   jsonb;
  v_field  text; v_op text; v_val jsonb; v_col text; v_lit text; v_clause text;
  v_elem   jsonb; v_in text[];
  v_clauses text[] := '{}';
  v_sql    text;
begin
  for v_rule in select * from jsonb_array_elements(coalesce(p_def->'rules','[]'::jsonb)) loop
    v_field := v_rule->>'field';
    v_op    := lower(coalesce(v_rule->>'op','eq'));
    v_val   := v_rule->'value';

    v_col := case v_field
      when 'visit_count'      then 'visit_count'
      when 'lifetime_revenue' then 'lifetime_revenue'
      when 'days_since_visit' then 'days_since_visit'
      when 'signed_up_days'   then 'signed_up_days'
      when 'birthday_in_days' then 'birthday_in_days'
      when 'marketing_opt_in' then 'marketing_opt_in'
      when 'has_email'        then 'has_email'
      when 'has_phone'        then 'has_phone'
      when 'is_local'         then 'is_local'
      when 'source'           then 'source'
      when 'never_visited'    then '(last_visit_at is null)'
      when 'has_birthday'     then '(birthday is not null)'
      else null end;
    if v_col is null then continue; end if;   -- unknown field → ignored, never injected

    -- render a single jsonb scalar to a safe SQL literal
    v_lit := case jsonb_typeof(v_val)
      when 'number'  then (v_val#>>'{}')                 -- numeric: its text form is a valid literal
      when 'boolean' then (v_val#>>'{}')
      when 'string'  then quote_literal(v_val#>>'{}')
      else 'null' end;

    v_clause := case v_op
      when 'eq'        then v_col || ' = '  || v_lit
      when 'neq'       then v_col || ' <> ' || v_lit
      when 'gt'        then v_col || ' > '  || v_lit
      when 'gte'       then v_col || ' >= ' || v_lit
      when 'lt'        then v_col || ' < '  || v_lit
      when 'lte'       then v_col || ' <= ' || v_lit
      when 'contains'  then v_col || ' ilike ' || quote_literal('%' || coalesce(v_val#>>'{}','') || '%')
      when 'is_true'   then v_col || ' is true'
      when 'is_false'  then v_col || ' is false'
      when 'is_null'   then v_col || ' is null'
      when 'not_null'  then v_col || ' is not null'
      when 'in' then (
        select case when count(*) = 0 then 'false' else
          v_col || ' in (' || string_agg(
            case jsonb_typeof(e) when 'number' then e#>>'{}' when 'boolean' then e#>>'{}'
                 else quote_literal(e#>>'{}') end, ',') || ')' end
        from jsonb_array_elements(case when jsonb_typeof(v_val)='array' then v_val else '[]'::jsonb end) e)
      else null end;

    if v_clause is not null then v_clauses := array_append(v_clauses, v_clause); end if;
  end loop;

  v_sql := 'select customer_id from customer_rfm where org_id = ' || quote_literal(p_org::text) || '::uuid';
  if array_length(v_clauses, 1) > 0 then
    v_sql := v_sql || ' and (' || array_to_string(v_clauses, v_join) || ')';
  end if;
  if p_limit is not null and p_limit > 0 then v_sql := v_sql || ' limit ' || (p_limit)::text; end if;

  return query execute v_sql;
end $function$;
CREATE OR REPLACE FUNCTION public.marketing_set_active_domain(p_org uuid, p_id uuid, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_active then
    update org_sending_domains set is_active = false, updated_at = now() where org_id = p_org and id <> p_id and is_active;
    update org_sending_domains set is_active = true,  updated_at = now() where id = p_id and org_id = p_org;
  else
    update org_sending_domains set is_active = false, updated_at = now() where id = p_id and org_id = p_org;
  end if;
end $function$;
CREATE OR REPLACE FUNCTION public.mb_screen_heartbeat(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update menu_board_screens set last_seen_at = now(), updated_at = now()
   where id = p_id and device_uid = auth.uid();
$function$;
CREATE OR REPLACE FUNCTION public.ops_ack_alert(p_alert_id uuid, p_action text DEFAULT NULL::text, p_user_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a ops_alerts;
begin
  select * into a from ops_alerts where id = p_alert_id;
  if not found then raise exception 'alert not found'; end if;
  if not public.ops_can_write(a.location_id) then raise exception 'not authorized'; end if;
  update ops_alerts set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_by_name = p_user_name,
    acknowledged_at = now(), action_taken = p_action where id = p_alert_id;
  return jsonb_build_object('ok', true);
end $function$;
CREATE OR REPLACE FUNCTION public.ops_can_write(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (p_location_id::text in (select user_accessible_locations()))
      or exists (select 1 from ops_devices d where d.device_uid = auth.uid() and d.location_id = p_location_id and d.active);
$function$;
CREATE OR REPLACE FUNCTION public.ops_device_heartbeat()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v ops_devices;
begin
  update ops_devices set last_seen_at = now() where device_uid = auth.uid() returning * into v;
  if not found then return jsonb_build_object('claimed', false); end if;
  return jsonb_build_object('claimed', v.location_id is not null, 'location_id', v.location_id, 'name', v.name);
end $function$;
CREATE OR REPLACE FUNCTION public.ops_pin_login(p_location_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record;
begin
  if not public.ops_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select id, name, role, permissions into v from staff_members
    where location_id = p_location_id and pin = p_pin and coalesce(active, true) = true limit 1;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'name', v.name, 'role', v.role, 'permissions', v.permissions);
end $function$;
CREATE OR REPLACE FUNCTION public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid DEFAULT NULL::uuid, p_operator_id uuid DEFAULT NULL::uuid, p_operator_name text DEFAULT NULL::text, p_source text DEFAULT 'manual'::text, p_notes text DEFAULT NULL::text, p_corrective_action text DEFAULT NULL::text, p_corrective_desc text DEFAULT NULL::text, p_delivery_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u temp_units; v_org uuid; v_in_range boolean; v_sev text; v_delta numeric;
  v_reading_id uuid; v_corr_id uuid := null; v_maint_id uuid := null; v_alert_id uuid := null;
begin
  if not public.ops_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select * into u from temp_units where id = p_unit_id and location_id = p_location_id;
  if not found then raise exception 'unknown unit'; end if;
  v_org := u.org_id;

  v_in_range := (u.target_min_c is null or p_reading_c >= u.target_min_c)
            and (u.target_max_c is null or p_reading_c <= u.target_max_c);
  if v_in_range then v_sev := 'none';
  elsif u.type = 'freezer' and p_reading_c > -15 then v_sev := 'critical';
  elsif u.type in ('hot_hold','cooking') and p_reading_c < 63 then v_sev := 'critical';
  else
    v_delta := greatest(
      case when u.target_max_c is not null and p_reading_c > u.target_max_c then p_reading_c - u.target_max_c else 0 end,
      case when u.target_min_c is not null and p_reading_c < u.target_min_c then u.target_min_c - p_reading_c else 0 end);
    v_sev := case when v_delta >= 2 then 'major' else 'minor' end;
  end if;

  -- HARD STOP: a breach cannot be saved without a corrective action.
  if not v_in_range and (p_corrective_action is null or btrim(p_corrective_action) = '') then
    raise exception 'corrective action required for out-of-range reading';
  end if;

  insert into temp_readings (location_id, org_id, temp_unit_id, schedule_id, reading_c, in_range, severity,
      source, operator_id, operator_name, device_id, notes)
    values (p_location_id, v_org, p_unit_id, p_schedule_id, p_reading_c, v_in_range, v_sev,
      coalesce(p_source,'manual'), p_operator_id, p_operator_name, null, p_notes)
    returning id into v_reading_id;

  if not v_in_range then
    insert into corrective_actions (location_id, org_id, source_type, source_id, severity, action, description,
        operator_id, operator_name, status, closed_at)
      values (p_location_id, v_org, case when p_delivery_id is not null then 'delivery' else 'temp_reading' end,
        coalesce(p_delivery_id, v_reading_id), v_sev, p_corrective_action, p_corrective_desc,
        p_operator_id, p_operator_name, 'closed', now())
      returning id into v_corr_id;

    -- every confirmed breach auto-raises a maintenance request (callout 8); severity sets priority.
    insert into maintenance_requests (location_id, org_id, title, description, asset_type, asset_id,
        priority, status, reporter_id, reporter_name, source, source_ref)
      values (p_location_id, v_org, u.name || ' — out of safe range',
        'Auto-raised from a ' || v_sev || ' temperature breach (' || p_reading_c || '°C).',
        'temp_unit', p_unit_id, case when v_sev = 'critical' then 'urgent' when v_sev = 'major' then 'high' else 'normal' end,
        'open', p_operator_id, p_operator_name, 'temp_breach', v_reading_id)
      returning id into v_maint_id;
    update corrective_actions set maintenance_request_id = v_maint_id where id = v_corr_id;

    -- Nothing red passes silently: always alert the duty manager on a breach.
    insert into ops_alerts (location_id, org_id, type, severity, title, body, source_type, source_id, target_role)
      values (p_location_id, v_org, 'temp_breach', v_sev,
        u.name || ' breach · ' || p_reading_c || '°C',
        'Corrective: ' || coalesce(p_corrective_action,'—') || coalesce(' · ' || p_operator_name, ''),
        'temp_reading', v_reading_id, 'MOD')
      returning id into v_alert_id;

    if p_delivery_id is not null then
      update deliveries set corrective_action_id = v_corr_id where id = p_delivery_id and location_id = p_location_id;
    end if;
  end if;

  insert into ops_audit (location_id, actor_id, actor_name, action, entity_type, entity_id, payload)
    values (p_location_id, coalesce(p_operator_id, auth.uid()), p_operator_name, 'temp_reading', 'temp_reading', v_reading_id,
      jsonb_build_object('unit', u.name, 'reading_c', p_reading_c, 'in_range', v_in_range, 'severity', v_sev,
        'corrective', p_corrective_action, 'maintenance_id', v_maint_id));

  return jsonb_build_object('reading_id', v_reading_id, 'in_range', v_in_range, 'severity', v_sev,
    'corrective_id', v_corr_id, 'maintenance_id', v_maint_id, 'alert_id', v_alert_id);
end $function$;
CREATE OR REPLACE FUNCTION public.pos_can_access(p_loc text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_loc is null then return false; end if;
  if p_loc in (select user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
             where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id::text = p_loc)
  then return true; end if;
  return exists (select 1 from public.ops_devices o
                 where o.device_uid = auth.uid() and o.active and o.location_id::text = p_loc);
end $function$;
CREATE OR REPLACE FUNCTION public.pos_can_access(p_loc uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_loc is null then return false; end if;
  if p_loc::text in (select user_accessible_locations()) then return true; end if;
  if exists (select 1 from public.devices d
             where d.device_uid = auth.uid() and d.status in ('active','online') and d.location_id = p_loc)
  then return true; end if;
  return exists (select 1 from public.ops_devices o
                 where o.device_uid = auth.uid() and o.active and o.location_id = p_loc);
end $function$;
CREATE OR REPLACE FUNCTION public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric DEFAULT NULL::numeric, p_source_type text DEFAULT NULL::text, p_source_id text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cost numeric;
  v_existing_id uuid;
  v_id uuid;
  v_onhand numeric;
begin
  if p_idempotency_key is not null then
    select id into v_existing_id from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id), 0);

  insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
      movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes)
    values (p_location_id, p_inventory_item_id, p_qty_base, v_cost, p_qty_base * coalesce(v_cost, 0),
      p_movement_type, p_source_type, p_source_id, coalesce(p_occurred_at, now()), now(),
      p_created_by, p_idempotency_key, p_notes)
    returning id into v_id;

  update inventory_items set on_hand = coalesce(on_hand, 0) + p_qty_base, updated_at = now()
    where id = p_inventory_item_id and location_id = p_location_id
    returning on_hand into v_onhand;

  return jsonb_build_object('id', v_id, 'on_hand', v_onhand, 'duplicate', false);
end $function$;
CREATE OR REPLACE FUNCTION public.promo_redeem_atomic(p_code_id uuid, p_expected_uses integer, p_offer_id uuid, p_org_id uuid, p_code text, p_customer_id uuid, p_location_id text, p_order_id text, p_staff_id uuid, p_basket_value numeric, p_discount_value numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_code   public.promo_codes%rowtype;
  v_new    integer;
  v_red_id uuid;
begin
  -- Serialises every concurrent redemption of THIS code. Everything below runs
  -- with the row locked, so neither the idempotency probe nor the guard can be
  -- overtaken between the read and the write.
  select * into v_code from public.promo_codes where id = p_code_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_idempotency_key is not null
     and exists (select 1 from public.promo_redemptions
                  where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('result', 'idempotent_hit');
  end if;

  if v_code.uses_count is distinct from p_expected_uses
     or v_code.uses_count >= coalesce(v_code.uses_allowed, 1) then
    return jsonb_build_object('result', 'already_used');
  end if;

  v_new := v_code.uses_count + 1;

  insert into public.promo_redemptions (
    promo_code_id, offer_id, org_id, code, customer_id, location_id,
    order_id, staff_id, basket_value, discount_value, idempotency_key
  ) values (
    p_code_id, p_offer_id, p_org_id, p_code, p_customer_id, p_location_id,
    p_order_id, p_staff_id, p_basket_value, p_discount_value, p_idempotency_key
  ) returning id into v_red_id;

  update public.promo_codes set
    uses_count           = v_new,
    status               = case when v_new >= coalesce(uses_allowed, 1) then 'redeemed' else status end,
    redeemed_at          = now(),
    redeemed_order_id    = p_order_id,
    redeemed_location_id = p_location_id,
    redeemed_value       = p_discount_value,
    redeemed_staff_id    = p_staff_id,
    updated_at           = now()
  where id = p_code_id;

  -- Was a separate best-effort call in the edge function. Same database, same
  -- transaction, so it now either happens with the redemption or not at all.
  update public.offers
     set redeemed_count = coalesce(redeemed_count, 0) + 1,
         updated_at     = now()
   where id = p_offer_id;

  return jsonb_build_object('result', 'redeemed', 'redemption_id', v_red_id, 'uses_count', v_new);

exception when unique_violation then
  -- Only reachable if two callers share an idempotency key across DIFFERENT codes
  -- (the row lock serialises same-code callers, and the probe above catches them).
  -- The handler's subtransaction rolls the block back, so no use was consumed here.
  return jsonb_build_object('result', 'idempotent_hit');
end;
$function$;
CREATE OR REPLACE FUNCTION public.register_ops_device(p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v ops_devices; v_code text;
begin
  select * into v from ops_devices where device_uid = auth.uid() limit 1;
  if found then return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id); end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into ops_devices (device_uid, name, claim_code, last_seen_at)
    values (auth.uid(), coalesce(p_name,'Ops tablet'), v_code, now()) returning * into v;
  return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id);
end $function$;
CREATE OR REPLACE FUNCTION public.register_terminal_device(p_serial text, p_app_version text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_serial text := btrim(coalesce(p_serial, ''));
  v_row    terminal_devices;
  v_code   text;
  v_open   integer;
begin
  if v_uid is null then raise exception 'no session'; end if;
  if v_serial = '' then raise exception 'serial required'; end if;
  if length(v_serial) > 64 then raise exception 'serial too long'; end if;

  -- Already paired to THIS device_uid ‚Äî re-adopt (app restart / reboot).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'paired' and active
   limit 1;
  if v_row.id is not null then
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', null, 'status', 'paired',
                              'location_id', v_row.location_id, 'label', v_row.label);
  end if;

  -- Already registered-but-unpaired by THIS device_uid ‚Äî return the SAME code
  -- (idempotent: a retry must not churn the code the operator is reading).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'unpaired'
   order by created_at desc limit 1;
  if v_row.id is not null then
    -- Refresh the TTL clock so a terminal left on the pairing screen stays claimable.
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                              'location_id', null, 'label', v_row.label);
  end if;

  -- Cheap abuse guard: one auth.uid() has no legitimate reason to hold a pile of
  -- pending registrations. (Anonymous sessions are free to mint, so bound them.)
  select count(*) into v_open from terminal_devices where device_uid = v_uid and status = 'unpaired';
  if v_open >= 5 then raise exception 'too many pending registrations for this device'; end if;

  -- Fresh unpaired row. Retry on the (astronomically unlikely) code collision.
  for i in 1..5 loop
    v_code := _terminal_gen_code();
    begin
      insert into terminal_devices (device_uid, serial_number, claim_code, status, app_version, last_seen_at)
      values (v_uid, v_serial, v_code, 'unpaired', p_app_version, now())
      returning * into v_row;
      exit;
    exception when unique_violation then
      v_row := null; -- code clash: try again
    end;
  end loop;
  if v_row.id is null then raise exception 'could not allocate a pairing code'; end if;

  return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                            'location_id', null, 'label', v_row.label);
end; $function$;
CREATE OR REPLACE FUNCTION public.register_waitlist_device(p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v waitlist_devices; v_code text;
begin
  select * into v from waitlist_devices where device_uid = auth.uid() limit 1;
  if found then return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id); end if;
  -- gen_random_uuid() is core pg; gen_random_bytes (pgcrypto) is NOT on this search_path.
  -- 8 hex chars (~32-bit) + the 30-min claim TTL below makes brute-forcing a code infeasible
  -- (mirrors the menu-board hardening; do NOT shrink this back to 6).
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into waitlist_devices (device_uid, name, claim_code, last_seen_at)
    values (auth.uid(), coalesce(p_name, 'Host stand'), v_code, now()) returning * into v;
  return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id);
end $function$;
CREATE OR REPLACE FUNCTION public.release_terminal_jobs(p_terminal_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t terminal_devices;
  v_expired int := 0;
  v_closed  int := 0;
  v_who     text;
begin
  select * into t from terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  v_who := coalesce(auth.uid()::text, 'unknown user');

  -- Leases that ran out and never reached a terminal state. Exactly what the
  -- sweeper does; doing it here too means the operator is never blocked waiting
  -- for a cron tick.
  update terminal_jobs
     set status = 'expired'
   where target_terminal_id = t.id
     and status in ('pending','claimed','tipping')
     and claim_expires_at < now();
  get diagnostics v_expired = row_count;

  -- Quarantined jobs. Stamped with who released them and when.
  update terminal_jobs
     set status         = 'reconciled',
         needs_human    = false,
         decline_reason = concat_ws(' | ', decline_reason,
                            'released by ' || v_who || ' at ' || now()::text
                            || coalesce(': ' || nullif(p_note, ''), ''))
   where target_terminal_id = t.id
     and status = 'unknown';
  get diagnostics v_closed = row_count;

  return jsonb_build_object('ok', true, 'expired', v_expired, 'released', v_closed);
end;
$function$;
CREATE OR REPLACE FUNCTION public.resolve_terminal_job(p_job_id uuid, p_outcome text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  j     terminal_jobs;
  v_out text;
  v_who text;
  v_stamp text;
begin
  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled','acknowledged') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'payment not found'; end if;

  -- Same fence as release_terminal_jobs: the manager must have this venue.
  if not _terminal_user_has_location(j.location_id) then
    raise exception 'no access to this payment';
  end if;

  -- Refuse while the payment is genuinely still running. A manager resolving a
  -- live charge from Back Office while a customer is mid-tap would be deciding
  -- the outcome of something that has not happened yet.
  if j.status in ('claimed','tipping','charging_unsent','charging') then
    return jsonb_build_object('ok', false,
      'reason', 'this payment is still running on the terminal — wait for it to finish');
  end if;

  v_who   := coalesce((select email from user_profiles where id = auth.uid()), auth.uid()::text, 'unknown user');
  v_stamp := concat_ws(' ', v_out, '— confirmed by', v_who, 'at', now()::text,
                       nullif(concat(': ', nullif(btrim(coalesce(p_note,'')), '')), ': '));

  if v_out = 'acknowledged' then
    -- The manager is signing off a discrepancy on an approved payment. Snapshot the
    -- live bill they signed off against (same-occupation match, like terminal-job-status)
    -- so the reconciler's override is scoped to exactly this figure. NULL live session →
    -- the frozen due_minor stands in: acknowledging an unchanged/gone bill still closes.
    update terminal_jobs
       set needs_human = false,
           acknowledged_total_minor = coalesce((
             select s.total_minor from active_sessions s
              where s.location_id = j.location_id
                and s.table_id = j.check_draft ->> 'tableId'
                and s.session ->> 'id' = j.check_draft ->> 'sessionId'
              limit 1), j.due_minor),
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  else
    update terminal_jobs
       set status      = v_out,
           needs_human = false,
           settled_at  = coalesce(settled_at, now()),
           reconcile_attempts = reconcile_attempts + 1,
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  end if;

  return jsonb_build_object('ok', true, 'outcome', v_out, 'by', v_who);
end;
$function$;
CREATE OR REPLACE FUNCTION public.restore_stock(p_location_id text, p_item_id text, p_qty integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_new_remaining int;
  v_par int;
BEGIN
  UPDATE public.stock_levels
  SET remaining = LEAST(par, remaining + p_qty),
      updated_at = now()
  WHERE location_id = p_location_id AND item_id = p_item_id
  RETURNING remaining, par INTO v_new_remaining, v_par;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('tracked', false);
  END IF;

  RETURN jsonb_build_object(
    'tracked', true,
    'remaining', v_new_remaining,
    'par', v_par
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.retire_terminal_device(p_terminal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  select * into t from terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- Refuse while money is genuinely in flight. Retiring mid-charge would strand
  -- a payment nobody is watching. 'unknown' is deliberately NOT in this list —
  -- a quarantined job must never be able to trap a terminal in the estate
  -- forever; release it first (below), which is an audited act.
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging')) then
    raise exception 'this terminal is mid-payment — wait for it to finish, or release it first';
  end if;

  update terminal_devices
     set status              = 'retired',
         active              = false,
         claim_code          = null,        -- cannot be re-claimed with the old code
         bound_pos_device_id = null,        -- frees the till
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'retired', t.id);
end;
$function$;
CREATE OR REPLACE FUNCTION public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cur numeric;
  v_delta numeric;
  v_res jsonb;
begin
  select coalesce(on_hand, 0) into v_cur from inventory_items
    where id = p_inventory_item_id and location_id = p_location_id;
  if not found then return jsonb_build_object('error', 'item not found'); end if;
  v_delta := p_counted_qty - v_cur;
  if v_delta = 0 then return jsonb_build_object('on_hand', v_cur, 'delta', 0); end if;
  v_res := post_stock_movement(p_location_id, p_inventory_item_id, v_delta, 'STOCK_COUNT_ADJ',
    null, 'manual_count', null, null, now(), p_created_by, p_notes);
  return v_res || jsonb_build_object('delta', v_delta);
end $function$;
CREATE OR REPLACE FUNCTION public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid)
 RETURNS menu_board_screens
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b record; s record;
begin
  select * into s from menu_board_screens where id = p_screen_id;
  if s.id is null then raise exception 'screen not found'; end if;
  if not _mb_user_has_location(s.location_id) then raise exception 'no access to this screen'; end if;
  if p_board_id is null then
    update menu_board_screens set board_id = null, status = 'unpaired', paired_at = null, updated_at = now()
     where id = s.id;
  else
    select id, location_id, org_id into b from menu_boards where id = p_board_id;
    if b.id is null then raise exception 'board not found'; end if;
    if b.location_id is distinct from s.location_id then raise exception 'board is at a different location'; end if;
    update menu_board_screens set board_id = b.id, org_id = b.org_id, status = 'paired', paired_at = now(), updated_at = now()
     where id = s.id;
  end if;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $function$;
CREATE OR REPLACE FUNCTION public.set_terminal_bound_device(p_terminal_id uuid, p_bound_pos_device_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_terminal_id is null then raise exception 'terminal required'; end if;

  select * into t from terminal_devices where id = p_terminal_id;
  if t.id is null then raise exception 'terminal not found'; end if;

  -- ── THE FENCE ──────────────────────────────────────────────────────────────
  -- Same as set_terminal_settings: a manager with access to the terminal's OWN
  -- location (read off the row, never from an argument). Binding is a management
  -- decision — the kiosk device itself does not self-assign; a BO user does it
  -- from the kiosk's settings page.
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- ── CROSS-LOCATION + TYPE VALIDATION ───────────────────────────────────────
  -- A terminal bound to a device at another venue is a cross-tenant payment hazard
  -- (a card presented to the wrong customer). Both halves checked: same location
  -- AND a valid dispatch origin — a POS till OR a KIOSK (v5.5.871). NULL unbinds.
  if p_bound_pos_device_id is not null then
    if not exists (
      select 1 from devices d
       where d.id = p_bound_pos_device_id
         and d.location_id = t.location_id
         and d.type in ('pos', 'kiosk')
    ) then
      raise exception 'that device is not a POS or kiosk at this terminal''s venue';
    end if;
  end if;

  update terminal_devices
     set bound_pos_device_id = p_bound_pos_device_id,
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'terminal_id', t.id,
                            'bound_pos_device_id', p_bound_pos_device_id);
end; $function$;
CREATE OR REPLACE FUNCTION public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb DEFAULT NULL::jsonb, p_bound_pos_device_id uuid DEFAULT NULL::uuid, p_modes jsonb DEFAULT NULL::jsonb, p_label text DEFAULT NULL::text, p_idle_screen jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_terminal_id is null then raise exception 'terminal required'; end if;

  select * into t from terminal_devices where id = p_terminal_id;
  if t.id is null then raise exception 'terminal not found'; end if;

  -- ── THE FENCE ──────────────────────────────────────────────────────────────
  -- Identical to claim_terminal_device: the manager must have access to the
  -- location, via user_locations or super_admin. Read off the TERMINAL'S OWN ROW,
  -- never from an argument — the caller does not get to nominate the location
  -- they are allowed to write to. (Rule 3 of 20260722c.)
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- ── CROSS-LOCATION VALIDATION ──────────────────────────────────────────────
  -- A terminal bound to another venue's till is a cross-tenant payment hazard:
  -- terminal_targets_for_pos would hand that till a terminal in a different
  -- building and a card would be presented to the wrong customer. Both halves are
  -- checked — same location AND actually a POS.
  --
  -- devices.location_id and terminal_devices.location_id are both uuid, so this
  -- compares directly. (floor_tables.location_id and closed_checks.location_id
  -- are TEXT in this schema — do not copy this line to those tables without
  -- casting the uuid side DOWN to text; 'loc-demo' is not a valid uuid and ::uuid
  -- throws 22P02.)
  if p_bound_pos_device_id is not null then
    if not exists (
      select 1 from devices d
       where d.id = p_bound_pos_device_id
         and d.location_id = t.location_id
         and d.type in ('pos', 'kiosk')
    ) then
      raise exception 'that device is not a POS till or kiosk at this terminal''s venue';
    end if;
  end if;

  update terminal_devices
     set tip_config          = _terminal_norm_tip_config(p_tip_config),
         bound_pos_device_id = p_bound_pos_device_id,
         modes               = _terminal_norm_modes(p_modes),
         idle_screen         = _terminal_norm_idle_screen(p_idle_screen),
         label               = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'terminal_id', t.id);
end; $function$;
CREATE OR REPLACE FUNCTION public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer DEFAULT 8)
 RETURNS TABLE(inventory_item_id uuid, dow integer, avg_daily_base numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with w as (
    select greatest(p_weeks, 1) as weeks
  ), m as (
    select sm.inventory_item_id,
           extract(dow from sm.occurred_at)::int as dow,
           sum(-sm.qty_base) as total_base
    from public.stock_movements sm, w
    where sm.location_id = p_location_id
      and sm.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
      and sm.qty_base < 0
      and sm.occurred_at >= now() - make_interval(weeks => w.weeks)
    group by sm.inventory_item_id, extract(dow from sm.occurred_at)::int
  )
  select m.inventory_item_id, m.dow, m.total_base / (select weeks from w)::numeric
  from m;
$function$;
CREATE OR REPLACE FUNCTION public.stock_usage_rates(p_location_id uuid, p_days integer DEFAULT 28)
 RETURNS TABLE(inventory_item_id uuid, avg_daily_base numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select inventory_item_id,
         sum(-qty_base) / nullif(p_days, 0)::numeric as avg_daily_base
  from public.stock_movements
  where location_id = p_location_id
    and movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
    and qty_base < 0
    and occurred_at >= now() - make_interval(days => greatest(p_days, 1))
  group by inventory_item_id;
$function$;
CREATE OR REPLACE FUNCTION public.terminal_claim_job(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; v_n integer;
begin
  t := _terminal_for_caller();
  begin
    update terminal_jobs
       set status = 'claimed', claimed_by = t.id, claimed_at = now(),
           claim_expires_at = now() + interval '5 minutes', updated_at = now()
     where id = p_job_id
       and target_terminal_id = t.id      -- only the addressed terminal may claim
       and status = 'pending';
    get diagnostics v_n = row_count;
  exception when unique_violation then
    -- idx_tj_one_live_per_terminal: this PAX already holds a live charge.
    return jsonb_build_object('ok', false, 'reason', 'terminal already has a live job');
  end;
  return jsonb_build_object('ok', v_n = 1);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; j terminal_jobs; v_tip bigint; v_charge bigint;
begin
  t := _terminal_for_caller();

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.training then raise exception 'training job ‚Äî no card may be charged'; end if;
  if j.status not in ('claimed','tipping') then
    raise exception 'job is not awaiting a tip (status %)', j.status;
  end if;

  v_tip    := least(greatest(coalesce(p_tip_minor, 0), 0), greatest(j.tip_basis_minor, 2000));
  v_charge := j.due_minor + v_tip;

  update terminal_jobs
     set tip_minor    = v_tip,
         charge_minor = v_charge,
         charged_at   = now(),         -- stamped BEFORE the controller is launched
         status       = 'charging_unsent',
         updated_at   = now()
   where id = j.id;

  return jsonb_build_object('charge_minor', v_charge);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_heartbeat(p_device_id uuid, p_app_version text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update terminal_devices
     set last_seen_at = now(),
         app_version  = coalesce(p_app_version, app_version),
         updated_at   = now()
   where id = p_device_id and device_uid = auth.uid();
$function$;
CREATE OR REPLACE FUNCTION public.terminal_job_cancel(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j terminal_jobs; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;

  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  if j.charged_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already charging ‚Äî cannot cancel', 'status', j.status);
  end if;
  if j.status not in ('pending','claimed','tipping') then
    return jsonb_build_object('ok', false, 'reason', 'job is no longer cancellable', 'status', j.status);
  end if;

  update terminal_jobs
     set status = 'cancelled', settled_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'cancelled from the POS')
   where id = j.id;

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_out text; v_n integer;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;
  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled','reconciled') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  update terminal_jobs
     set status = v_out, needs_human = false, settled_at = now(), updated_at = now(),
         reconcile_attempts = reconcile_attempts + 1,
         last_error = coalesce(p_note, last_error)
   where id = p_job_id and status = 'unknown';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_job_sent(p_job_id uuid, p_transaction_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; v_n integer; v_status text;
begin
  t := _terminal_for_caller();
  update terminal_jobs
     set status = 'charging',
         transaction_id = coalesce(p_transaction_id, transaction_id),
         updated_at = now()
   where id = p_job_id and target_terminal_id = t.id and status = 'charging_unsent';
  get diagnostics v_n = row_count;
  if v_n = 1 then return jsonb_build_object('ok', true); end if;

  select status into v_status from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id;
  if v_status = 'charging' then
    return jsonb_build_object('ok', true, 'idempotent', true);
  end if;
  return jsonb_build_object('ok', v_n = 1);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_job_settle_from_processor(p_job_id uuid, p_outcome text, p_payment_session_id text DEFAULT NULL::text, p_transaction_id text DEFAULT NULL::text, p_auth_code text DEFAULT NULL::text, p_card jsonb DEFAULT NULL::jsonb, p_decline_reason text DEFAULT NULL::text, p_source text DEFAULT 'session'::text, p_session_amount_minor bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  j       terminal_jobs;
  v_out   text;
  v_human boolean := false;
  v_final_human boolean;
  v_err   text;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;

  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  if coalesce(btrim(p_source), '') = '' then
    raise exception 'p_source required';
  end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;

  -- Idempotent guard: settled rows are immutable. Device replays, late webhooks
  -- and a lost race between verify/webhook/sweeper all land here harmlessly.
  -- Still backfill a missing psId so the ledger stays joinable.
  if j.status in ('approved','declined','cancelled','expired','reconciled') then
    if j.payment_session_id is null and p_payment_session_id is not null then
      update terminal_jobs
         set payment_session_id = p_payment_session_id, updated_at = now()
       where id = j.id;
    end if;
    return jsonb_build_object('ok', true, 'idempotent', true, 'status', j.status);
  end if;

  -- Status gate: only rows that could have reached the processor.
  if j.status not in ('charging_unsent','charging','unknown') then
    return jsonb_build_object('ok', false, 'status', j.status,
      'reason', format('job is %s — a processor outcome is not possible here', j.status));
  end if;

  -- 'cancelled' must be PROVABLY never-initiated (see the transition table).
  if v_out = 'cancelled'
     and not (j.status = 'charging_unsent'
              and j.payment_session_id is null
              and p_payment_session_id is null) then
    return jsonb_build_object('ok', false, 'status', j.status,
      'reason', 'cancelled requires charging_unsent with no payment session — the card may have been charged');
  end if;

  -- A settle citing a DIFFERENT session than the one this job initiated is a
  -- wiring fault, not a verdict conflict to swallow: settle (the processor did
  -- speak) but park it and keep OUR stored psId.
  if j.payment_session_id is not null and p_payment_session_id is not null
     and j.payment_session_id <> p_payment_session_id then
    v_human := true;
    v_err := format('payment session mismatch: job holds %s, settle cited %s',
                    j.payment_session_id, p_payment_session_id);
  end if;

  -- Server computed the money; the processor's captured amount must agree.
  if v_out = 'approved' and p_session_amount_minor is not null
     and j.charge_minor is not null and p_session_amount_minor <> j.charge_minor then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '')
             || format('amount mismatch: processor %s vs server %s',
                       p_session_amount_minor, j.charge_minor);
  end if;

  v_final_human := case when v_human then true
                        when j.status = 'unknown' then false   -- clean recovery clears the quarantine
                        else j.needs_human end;

  update terminal_jobs
     set status             = v_out,
         transaction_id     = coalesce(p_transaction_id, transaction_id),
         auth_code          = coalesce(p_auth_code, auth_code),
         card               = coalesce(p_card, card),
         decline_reason     = coalesce(p_decline_reason, decline_reason),
         payment_session_id = coalesce(payment_session_id, p_payment_session_id),
         verified_source    = p_source,
         verified_at        = now(),
         needs_human        = v_final_human,
         last_error         = coalesce(v_err, last_error),
         settled_at         = now(),
         updated_at         = now()
   where id = j.id;

  return jsonb_build_object('ok', true, 'status', v_out, 'needs_human', v_final_human);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_jobs_sweep(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_expired int := 0; v_cancelled int := 0; v_unknown int := 0;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status in ('pending','claimed','tipping')
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'expired', updated_at = now(),
         last_error = coalesce(j.last_error, 'lease expired before dispatch')
    from due where j.id = due.id;
  get diagnostics v_expired = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging_unsent'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'cancelled', updated_at = now(),
         last_error = coalesce(j.last_error, 'tip taken but request never dispatched')
    from due where j.id = due.id;
  get diagnostics v_cancelled = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'unknown', needs_human = true, updated_at = now(),
         reconcile_attempts = j.reconcile_attempts + 1,
         last_error = coalesce(j.last_error, 'dispatched but no result received ‚Äî outcome not established')
    from due where j.id = due.id;
  get diagnostics v_unknown = row_count;

  return jsonb_build_object('expired', v_expired, 'cancelled', v_cancelled, 'unknown', v_unknown);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_jobs_sweep_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.terminal_jobs_sweep();
end;
$function$;
CREATE OR REPLACE FUNCTION public.terminal_open_tables()
 RETURNS TABLE(table_id text, label text, session_id text, total_minor bigint, server_name text, opened_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare t terminal_devices;
begin
  t := _terminal_for_caller();
  return query
    select a.table_id::text,
           coalesce(f.label, a.table_id)::text,
           (a.session ->> 'id')::text,
           a.total_minor::bigint,
           coalesce(a.session ->> 'server', '')::text,
           case
             when (a.session ->> 'seatedAt') ~ '^[0-9]+$'
               then to_timestamp(((a.session ->> 'seatedAt')::bigint) / 1000.0)
             else a.updated_at
           end
      from active_sessions a
      left join floor_tables f
        -- floor_tables.location_id is TEXT while active_sessions.location_id is
        -- UUID (this schema is genuinely mixed). Cast the UUID side DOWN to text
        -- rather than casting floor_tables up: that column legitimately holds
        -- 'loc-demo', which is not a valid UUID, so ::uuid would throw 22P02.
        on f.id = a.table_id and f.location_id = a.location_id::text
     where a.location_id = t.location_id
       and a.total_minor is not null
       and a.total_minor > 0
       and jsonb_array_length(coalesce(a.session -> 'items', '[]'::jsonb)) > 0
       and not exists (
             select 1 from terminal_jobs j
              where j.check_key = t.location_id::text || ':' || a.table_id || ':' || coalesce(a.session ->> 'id', '-')
                and (
                      j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
                      -- R1 (20260730, refined 20260801): hide a PAID table only for
                      -- the same occupation (seatedAt match) or a recent no-seatedAt
                      -- job — a recurring ORD-N key from a past party must not hide
                      -- a new party's bill.
                   or (j.status = 'approved'
                        and (
                              (j.check_draft ->> 'seatedAt') is not null
                                and j.check_draft ->> 'seatedAt' = a.session ->> 'seatedAt'
                           or (j.check_draft ->> 'seatedAt') is null
                                and j.created_at > now() - interval '2 hours'
                            ))
                    )
           )
     order by 6 asc;
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_pos_close_session(p_location_id uuid, p_table_id text, p_session_id text, p_seated_at bigint, p_closed_check_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_location_id is null or p_table_id is null or p_closed_check_id is null then
    raise exception 'missing args';
  end if;
  -- No occupation identity → refuse (safe direction: never a blind table-scoped delete).
  if p_session_id is null or p_seated_at is null then
    return jsonb_build_object('ok', true, 'deleted', 0, 'skipped', 'no occupation identity');
  end if;

  select (
    _terminal_user_has_location(p_location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = p_location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this location'; end if;

  delete from active_sessions a
   where a.location_id = p_location_id
     and a.table_id    = p_table_id
     and (a.session ->> 'id') = p_session_id
     and (a.session ->> 'seatedAt') ~ '^[0-9]+$'
     and (a.session ->> 'seatedAt')::bigint = p_seated_at
     and exists (select 1 from closed_checks c where c.id = p_closed_check_id);
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'deleted', v_n);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_pos_flag_stale(p_job_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j terminal_jobs; v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  update terminal_jobs
     set needs_human = true,
         last_error  = concat_ws(' | ', last_error, coalesce(p_note, 'bill changed after payment frozen')),
         updated_at  = now()
   where id = j.id and status = 'approved' and needs_human = false;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_pos_mark_reconciled(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j terminal_jobs; v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  update terminal_jobs
     set status = 'reconciled', settled_at = coalesce(settled_at, now()), updated_at = now()
   where id = j.id and status = 'approved' and needs_human = false;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_report_result(p_job_id uuid, p_status text, p_transaction_id text DEFAULT NULL::text, p_auth_code text DEFAULT NULL::text, p_card jsonb DEFAULT NULL::jsonb, p_reported_minor bigint DEFAULT NULL::bigint, p_decline_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; j terminal_jobs; v_status text; v_human boolean := false; v_err text;
begin
  t := _terminal_for_caller();

  v_status := lower(btrim(coalesce(p_status, '')));
  if v_status not in ('approved','declined','cancelled','unknown') then
    raise exception 'invalid result status %', p_status;
  end if;

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.status in ('approved','declined','cancelled','expired','reconciled') then
    return jsonb_build_object('ok', true, 'idempotent', true);   -- already settled
  end if;

  -- A cancel we cannot prove is deterministic becomes an unknown.
  if v_status = 'cancelled' and j.status = 'charging' then
    v_status := 'unknown';
    v_err := 'device reported cancelled after dispatch — outcome not established';
  end if;

  if v_status = 'unknown' then v_human := true; end if;

  -- Server computed the money; the device only reports it. Any disagreement stops
  -- the check closing until a human looks.
  if v_status = 'approved' and p_reported_minor is not null
     and j.charge_minor is not null and p_reported_minor <> j.charge_minor then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || format('amount mismatch: device %s vs server %s',
                                                    p_reported_minor, j.charge_minor);
  end if;

  -- v5.5.846: an approval with NO server charge should be impossible (terminal_commit_tip
  -- is the only path that prices a job). If a device claims approved anyway, money may
  -- have moved for an amount the server never authorised — park it for a human instead
  -- of letting it strand with needs_human=false, invisible to every queue.
  if v_status = 'approved' and j.charge_minor is null then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || 'approved with no server charge amount — investigate before closing';
  end if;

  -- Ryft slice 2: on a REAL job the device's approved/declined is an advisory
  -- CLAIM. Settlement is exclusively processor-verified via
  -- terminal_job_settle_from_processor (verify action / webhook / sweeper) —
  -- status and settled_at are deliberately untouched here. cancelled/unknown
  -- fall through to the old settle path (the processor never sees a
  -- never-initiated sale, and 'unknown' is the sweeper's input), and so do
  -- SIMULATED jobs (no processor exists to verify a bench sale).
  if (not j.simulated) and v_status in ('approved','declined') then
    update terminal_jobs
       set transaction_id = coalesce(p_transaction_id, transaction_id),
           auth_code      = coalesce(p_auth_code, auth_code),
           card           = coalesce(p_card, card),
           reported_minor = coalesce(p_reported_minor, reported_minor),
           decline_reason = coalesce(p_decline_reason, decline_reason),
           needs_human    = needs_human or v_human,
           last_error     = coalesce(v_err, last_error),
           updated_at     = now()
     where id = j.id;
    return jsonb_build_object('ok', true, 'recorded', true);
  end if;

  update terminal_jobs
     set status         = v_status,
         transaction_id = coalesce(p_transaction_id, transaction_id),
         auth_code      = coalesce(p_auth_code, auth_code),
         card           = coalesce(p_card, card),
         reported_minor = coalesce(p_reported_minor, reported_minor),
         decline_reason = coalesce(p_decline_reason, decline_reason),
         needs_human    = needs_human or v_human,
         last_error     = coalesce(v_err, last_error),
         settled_at     = now(),
         updated_at     = now()
   where id = j.id;

  return jsonb_build_object('ok', true);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_staff_login(p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; m record; v_pin text := btrim(coalesce(p_pin, ''));
begin
  t := _terminal_for_caller();

  if t.pin_locked_until is not null and t.pin_locked_until > now() then
    raise exception 'too many incorrect PINs ‚Äî try again in a minute';
  end if;

  if v_pin = '' then return null; end if;

  select s.id, s.name, s.role into m
    from staff_members s
   where s.location_id = t.location_id      -- the fence: this terminal's venue only
     and s.active
     and s.pin is not null
     and s.pin::text = v_pin
   limit 1;

  if m.id is null then
    update terminal_devices
       set pin_fail_count  = pin_fail_count + 1,
           pin_locked_until = case when pin_fail_count + 1 >= 5 then now() + interval '5 minutes' else pin_locked_until end,
           updated_at = now()
     where id = t.id;
    -- Reset the counter once the lock is applied, so the next window starts clean.
    update terminal_devices set pin_fail_count = 0 where id = t.id and pin_locked_until > now();
    return null;
  end if;

  update terminal_devices
     set pin_fail_count = 0, pin_locked_until = null, last_seen_at = now(), updated_at = now()
   where id = t.id;

  -- There is no dedicated "take payment" permission in staff_members today (see
  -- PERM_GROUPS in StaffManager.jsx). Kitchen is the one POS role that never
  -- handles a card; everyone else on the floor does. Narrow this the moment a
  -- real permission exists ‚Äî do not widen it.
  return jsonb_build_object(
    'staff_id',         m.id,
    'name',             m.name,
    'can_take_payment', coalesce(m.role, '') is distinct from 'Kitchen'
  );
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_start_table_payment(p_table_id text, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t          terminal_devices;
  a          active_sessions;
  v_staff    record;
  v_key      text;
  v_bill     bigint;
  v_job      uuid := gen_random_uuid();
  v_ccid     text;
  v_currency text;
  v_tipcfg   jsonb;
  v_draft    jsonb;
begin
  t := _terminal_for_caller();

  -- The staff id came from the client. Re-validate it against THIS venue —
  -- otherwise a payment could be attributed to anyone, including at another site.
  select s.id, s.name, s.role into v_staff
    from staff_members s
   where s.id = p_staff_id and s.location_id = t.location_id and s.active
   limit 1;
  if v_staff.id is null then raise exception 'staff member not valid at this location'; end if;
  if coalesce(v_staff.role, '') = 'Kitchen' then raise exception 'this role cannot take payment'; end if;

  select * into a from active_sessions
   where location_id = t.location_id and table_id = p_table_id
   limit 1;
  if a.table_id is null then raise exception 'table is not open'; end if;

  if a.total_minor is null then
    raise exception 'this table has no server-side total yet — open and re-save it on the POS first';
  end if;
  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  -- Explicit, friendly refusals. The partial unique indexes are the real mutex —
  -- these just turn a 23505 into a sentence a waiter can act on.
  -- R1 (20260730, refined 20260801): refuse a second charge only when the approved
  -- job is the SAME occupation — seatedAt match, or a recent (<2h) job with no
  -- seatedAt (mode-3 drafts). Recurring ORD-N keys from PAST occupations must
  -- never block a new party.
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status = 'approved'
                and (
                      (j.check_draft ->> 'seatedAt') is not null
                        and j.check_draft ->> 'seatedAt' = a.session ->> 'seatedAt'
                   or (j.check_draft ->> 'seatedAt') is null
                        and j.created_at > now() - interval '2 hours'
                    )) then
    raise exception 'this table has already been paid — wait for it to finish closing';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this table already has a payment in progress';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

  select coalesce(l.currency, 'GBP') into v_currency from locations l where l.id = t.location_id;

  -- Frozen at dispatch. The device's cached config is the only tip source available
  -- to Ops SQL (location_reader_settings lives in the Platform DB), and it fails
  -- SAFE: with no cached config the terminal shows no tip prompt rather than a
  -- guessed one. Back Office writes this cache when the terminal is paired.
  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  -- v5.5.846: epoch-ms + 6 hex from a uuid. The ms alone collided when two Table-Pay
  -- starts landed in the same millisecond, silently no-opping the second sale AND
  -- (now) risking one paid table tombstoning another via the reconciler's id-election.
  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  -- Everything recordClosedCheck needs EXCEPT the tip, so the check can be closed
  -- by the POS reconciler even if the till that started it never comes back.
  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from floor_tables f
                              -- same TEXT vs UUID mismatch as terminal_open_tables; cast down, not up
                              where f.id = p_table_id and f.location_id = t.location_id::text), p_table_id),
    'locationId',  t.location_id,
    'sessionId',   a.session ->> 'id',
    'server',      coalesce(v_staff.name, a.session ->> 'server'),
    'staffId',     v_staff.id,
    'covers',      coalesce((a.session ->> 'covers')::int, 1),
    'orderType',   'dine-in',
    'items',       coalesce(a.session -> 'items', '[]'::jsonb),
    'discounts',   coalesce(a.session -> 'discounts', '[]'::jsonb),
    'seatedAt',    a.session ->> 'seatedAt',
    'subtotalMinor', a.subtotal_minor,
    'totalMinor',    a.total_minor,
    'currency',    v_currency,
    'source',      'pax_table_pay'
  );

  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key,
    t.location_id,                 -- SERVER-resolved from the terminal's pairing row
    t.id, null,
    false,                         -- Table Pay is initiated by real hardware; there is
                                   -- no training till in this path. Mode 3 sets this
                                   -- from the dispatching POS device profile.
    v_bill,                        -- tip basis = the BILL (tip % applies to this)
    v_bill,                        -- due = the whole bill (no split, no gift credit here)
    v_currency, v_tipcfg, v_ccid, v_draft,
    'pending', 'ryft',
    now() + interval '15 minutes', -- undispatched jobs expire rather than linger
    now()
  );

  return jsonb_build_object(
    'job_id',          v_job,
    'tip_basis_minor', v_bill,
    'due_minor',       v_bill,
    'currency',        v_currency,
    'tip_config',      v_tipcfg
  );
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_targets_for_pos(p_location_id uuid)
 RETURNS TABLE(id uuid, label text, bound_pos_device_id uuid, last_seen_at timestamp with time zone, tip_config jsonb, modes jsonb, ryft_terminal_id text, adyen_terminal_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_location_id is null then raise exception 'location required'; end if;

  select (
    _terminal_user_has_location(p_location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = p_location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this location'; end if;

  return query
    select td.id, td.label, td.bound_pos_device_id, td.last_seen_at, td.tip_config,
           td.modes, td.ryft_terminal_id, td.adyen_terminal_id
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $function$;
CREATE OR REPLACE FUNCTION public.tg_order_queue_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  evt text;
begin
  if tg_op = 'INSERT' then
    -- Age gate: a "confirmed" for an order placed >6h ago is never right — it is a
    -- stale device replaying its queue, not a customer placing an order.
    if coalesce(new.created_at, now()) < now() - interval '6 hours' then
      return new;
    end if;
    evt := 'confirmed';
  elsif new.status = 'ready' and coalesce(old.status, '') <> 'ready' then
    evt := 'ready';
  else
    return new;
  end if;

  -- Fire-and-forget: a notification failure must never fail the order itself.
  begin
    perform net.http_post(
      url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/order-notify',
      body := jsonb_build_object('ref', new.ref, 'event', evt),
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  exception when others then
    null;
  end;

  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  insert into customer_locations (customer_id, location_id, first_visit_at, last_visit_at, visit_count, lifetime_revenue)
  values (p_customer_id, p_location_id, p_visit_at, p_visit_at, 1, coalesce(p_revenue, 0))
  on conflict (customer_id, location_id) do update set
    last_visit_at = greatest(customer_locations.last_visit_at, p_visit_at),
    visit_count = customer_locations.visit_count + 1,
    lifetime_revenue = customer_locations.lifetime_revenue + coalesce(p_revenue, 0);
end$function$;
CREATE OR REPLACE FUNCTION public.user_accessible_locations()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
AS $function$
  select location_id::text from user_locations where user_id = auth.uid()
  union
  select location_id::text from user_profiles where id = auth.uid() and location_id is not null;
$function$;
CREATE OR REPLACE FUNCTION public.user_accessible_orgs()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
AS $function$
  select distinct l.org_id::text
    from locations l
   where l.id::text in (select public.user_accessible_locations());
$function$;
CREATE OR REPLACE FUNCTION public.waitlist_can_write(p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (p_location_id::text in (select user_accessible_locations()))
      or exists (select 1 from waitlist_devices d
                 where d.device_uid = auth.uid() and d.location_id = p_location_id and d.active);
$function$;
CREATE OR REPLACE FUNCTION public.waitlist_device_heartbeat()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v waitlist_devices;
begin
  update waitlist_devices set last_seen_at = now() where device_uid = auth.uid() returning * into v;
  if not found then return jsonb_build_object('claimed', false); end if;
  return jsonb_build_object('claimed', v.location_id is not null, 'location_id', v.location_id, 'name', v.name);
end $function$;
CREATE OR REPLACE FUNCTION public.waitlist_pin_login(p_location_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record;
begin
  if not public.waitlist_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select id, name, role, permissions into v from staff_members
    where location_id = p_location_id and pin = p_pin and coalesce(active, true) = true limit 1;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'name', v.name, 'role', v.role, 'permissions', v.permissions);
end $function$;
CREATE OR REPLACE FUNCTION public.waitlist_public_config(p_location uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case when public._wl_self_open(p_location)
    then jsonb_build_object('enabled', true, 'zones', coalesce((select zones from waitlist_config where location_id = p_location), '[]'::jsonb))
    else null end;
$function$;
CREATE OR REPLACE FUNCTION public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text DEFAULT NULL::text, p_zone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid; v_phone text; v_id text; v_token text; v_existing record;
begin
  if not public._wl_self_open(p_location) then
    raise exception 'self-service is not available at this venue right now';
  end if;
  v_phone := public.wl_normalise_phone(p_phone);
  if v_phone is null or length(v_phone) < 7 then raise exception 'a valid phone number is required'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name is required'; end if;
  select org_id into v_org from locations where id = p_location;
  if v_org is null then raise exception 'venue not found'; end if;

  -- Anti-spam / SMS toll-fraud guards (this is an anonymous public endpoint):
  --  • per-venue burst cap, and
  --  • per-phone cool-down (a genuine re-show returns the existing token below, before this).
  if (select count(*) from waitlist_entries
        where location_id = p_location and added_at > now() - interval '10 minutes') >= 40 then
    raise exception 'too many sign-ups right now — please see the host';
  end if;
  if exists (select 1 from waitlist_entries
        where location_id = p_location and phone = v_phone and added_at > now() - interval '2 minutes') then
    raise exception 'you just signed up — check your status link';
  end if;

  -- Already on the list? Return their existing token (re-show status; don't create a duplicate).
  select id, public_token into v_existing from waitlist_entries
    where location_id = p_location and phone = v_phone
      and status in ('waiting','notified','ready')
    order by added_at desc limit 1;
  if found then
    if v_existing.public_token is null then
      v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
      update waitlist_entries set public_token = v_token where id = v_existing.id;
    else
      v_token := v_existing.public_token;
    end if;
    return jsonb_build_object('token', v_token, 'already', true);
  end if;

  v_id := 'wl-' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
  v_token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into waitlist_entries (id, location_id, org_id, party_name, phone, party_size, status,
      section_pref, notes, source, public_token, customer, added_at)
    values (v_id, p_location, v_org, btrim(p_name), v_phone, greatest(1, coalesce(p_size,1)), 'waiting',
      nullif(btrim(coalesce(p_zone,'')), ''), nullif(btrim(coalesce(p_notes,'')), ''), 'self', v_token,
      jsonb_build_object('name', btrim(p_name), 'phone', v_phone, 'source', 'self'), now());
  insert into waitlist_status_events (location_id, waitlist_entry_id, from_status, to_status, actor)
    values (p_location, v_id, null, 'waiting', 'self');
  return jsonb_build_object('token', v_token, 'already', false);
end $function$;
CREATE OR REPLACE FUNCTION public.waitlist_self_status(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record; v_pos int; v_quote int;
begin
  if p_token is null or length(p_token) < 16 then return jsonb_build_object('found', false); end if;
  -- Token is valid only for 12h after the guest joined — a leaked/bookmarked link can't read forever.
  select * into v from waitlist_entries where public_token = p_token and added_at > now() - interval '12 hours' limit 1;
  if not found then return jsonb_build_object('found', false); end if;
  -- position = active entries in the same band that arrived before this one.
  select count(*) into v_pos from waitlist_entries w
    where w.location_id = v.location_id
      and w.status in ('waiting','notified','ready')
      and w.added_at < v.added_at
      and public.wl_band_id(w.party_size) = public.wl_band_id(v.party_size);
  -- Quote fallback: until a live host board recomputes, show a sane per-band default (not "— min").
  v_quote := coalesce(v.quoted_wait_min,
    case public.wl_band_id(v.party_size) when 1 then 45 when 2 then 60 when 3 then 75 else 90 end);
  return jsonb_build_object(
    'found', true,
    'status', v.status,
    'party_name', v.party_name,
    'party_size', v.party_size,
    'quoted_wait_min', case when v.status in ('waiting','notified','ready') then v_quote else null end,
    'position', case when v.status in ('waiting','notified','ready') then v_pos + 1 else null end,
    'confirmed_at', v.confirmed_at,
    'added_at', v.added_at
  );
end $function$;
CREATE OR REPLACE FUNCTION public.waitlist_self_update(p_token text, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v record;
begin
  if p_token is null then return jsonb_build_object('ok', false); end if;
  -- 12h token TTL (same as status) — a stale/leaked link can't mutate an old entry.
  select * into v from waitlist_entries where public_token = p_token and added_at > now() - interval '12 hours' limit 1;
  if not found then return jsonb_build_object('ok', false); end if;

  if p_action = 'on_my_way' then
    if v.status in ('waiting','notified','ready') then
      update waitlist_entries set confirmed_at = now(), last_guest_reply = 'on_my_way', last_reply_at = now()
        where id = v.id;
    end if;
    return jsonb_build_object('ok', true, 'status', v.status, 'confirmed', v.status in ('waiting','notified','ready'));
  elsif p_action = 'cancel' then
    if v.status in ('waiting','notified','ready') then
      update waitlist_entries set status = 'cancelled', last_guest_reply = 'cancel', last_reply_at = now()
        where id = v.id;
      insert into waitlist_status_events (location_id, waitlist_entry_id, from_status, to_status, actor)
        values (v.location_id, v.id, v.status, 'cancelled', 'self');
      return jsonb_build_object('ok', true, 'status', 'cancelled');
    end if;
    -- No-op (already seated/cancelled/etc.) — return the TRUE status so the guest UI doesn't lie.
    return jsonb_build_object('ok', true, 'status', v.status);
  end if;
  return jsonb_build_object('ok', false, 'error', 'unknown action');
end $function$;
CREATE OR REPLACE FUNCTION public.wf_block_finalized_tronc_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if old.status is distinct from 'draft' then
    raise exception 'wf_tronc_runs: a % run is immutable and cannot be deleted (supersede via an audited correction instead)', old.status;
  end if;
  return old;
end; $function$;
CREATE OR REPLACE FUNCTION public.wf_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at = now(); return new; end;
$function$;
CREATE OR REPLACE FUNCTION public.wl_band_id(p_size integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when coalesce(p_size,1) <= 2 then 1
              when p_size <= 4 then 2
              when p_size <= 6 then 3
              else 4 end;
$function$;
CREATE OR REPLACE FUNCTION public.wl_normalise_phone(p text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '[^0-9+]', '', 'g');
  if d = '' then return null; end if;
  if left(d, 1) = '+' then return d; end if;
  if left(d, 2) = '07' and length(d) = 11 then return '+44' || substr(d, 2); end if;
  if left(d, 2) = '44' then return '+' || d; end if;
  return d;
end $function$;
CREATE OR REPLACE FUNCTION public.wl_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated_at = now(); return new; end $function$;
CREATE OR REPLACE FUNCTION public.xero_nightly_post()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  loc record;
  key text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  if key is null then return; end if;
  for loc in
    select c.location_id
    from public.xero_connections c
    join public.xero_config g on g.location_id = c.location_id
    where g.auto_daily = true
  loop
    perform net.http_post(
      url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-sales',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
      body    := jsonb_build_object(
        'locationId', loc.location_id,
        'date', to_char((now() at time zone 'utc')::date - 1, 'YYYY-MM-DD'),
        'auto', true
      )
    );
  end loop;
end $function$;

-- --------------------------------------------------------------------------
-- 7. VIEWS  (1)
-- pg_get_viewdef(oid, true). No materialized views exist live.
-- --------------------------------------------------------------------------

create or replace view public.customer_rfm as
 SELECT c.id AS customer_id,
    c.org_id,
    c.first_name,
    c.last_name,
    c.name,
    c.email,
    c.phone,
    c.birthday,
    c.marketing_opt_in,
    c.source,
    c.is_local,
    c.created_at AS signed_up_at,
    CURRENT_DATE - c.created_at::date AS signed_up_days,
    COALESCE(sum(cl.visit_count), 0::bigint) AS visit_count,
    COALESCE(sum(cl.lifetime_revenue), 0::numeric) AS lifetime_revenue,
    max(cl.last_visit_at) AS last_visit_at,
    min(cl.first_visit_at) AS first_visit_at,
    CURRENT_DATE - max(cl.last_visit_at)::date AS days_since_visit,
    c.email IS NOT NULL AND c.email <> ''::text AS has_email,
    c.phone IS NOT NULL AND c.phone <> ''::text AS has_phone,
        CASE
            WHEN c.birthday IS NULL THEN NULL::integer
            WHEN to_date(to_char(CURRENT_DATE::timestamp with time zone, 'YYYY'::text) || to_char(c.birthday::timestamp with time zone, 'MMDD'::text), 'YYYYMMDD'::text) >= CURRENT_DATE THEN to_date(to_char(CURRENT_DATE::timestamp with time zone, 'YYYY'::text) || to_char(c.birthday::timestamp with time zone, 'MMDD'::text), 'YYYYMMDD'::text) - CURRENT_DATE
            ELSE to_date(to_char(CURRENT_DATE + '1 year'::interval, 'YYYY'::text) || to_char(c.birthday::timestamp with time zone, 'MMDD'::text), 'YYYYMMDD'::text) - CURRENT_DATE
        END AS birthday_in_days
   FROM customers c
     LEFT JOIN customer_locations cl ON cl.customer_id = c.id
  WHERE c.deleted_at IS NULL
  GROUP BY c.id;

-- --------------------------------------------------------------------------
-- 8. RLS POLICIES  (293)
-- Rebuilt from pg_policies with exact PERMISSIVE/RESTRICTIVE, command,
-- roles, USING and WITH CHECK. DROP POLICY IF EXISTS first so a rerun
-- converges instead of erroring.
-- Reproduced as-is, including the permissive ones. `to public` means the
-- policy applies to every role, anon included.
-- --------------------------------------------------------------------------

drop policy if exists "allow all" on public.active_sessions;
create policy "allow all" on public.active_sessions
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "allow all" on public.activity_events;
create policy "allow all" on public.activity_events
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists bar_tabs_tenant on public.bar_tabs;
create policy bar_tabs_tenant on public.bar_tabs
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists campaign_runs_read on public.campaign_runs;
create policy campaign_runs_read on public.campaign_runs
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists campaign_sends_read on public.campaign_sends;
create policy campaign_sends_read on public.campaign_sends
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists cash_drawers_tenant on public.cash_drawers;
create policy cash_drawers_tenant on public.cash_drawers
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists cash_movements_tenant on public.cash_movements;
create policy cash_movements_tenant on public.cash_movements
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists css_del on public.catering_site_settings;
create policy css_del on public.catering_site_settings
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists css_ins on public.catering_site_settings;
create policy css_ins on public.catering_site_settings
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists css_sel on public.catering_site_settings;
create policy css_sel on public.catering_site_settings
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists css_upd on public.catering_site_settings;
create policy css_upd on public.catering_site_settings
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists challenge_21_checks_tenant on public.challenge_21_checks;
create policy challenge_21_checks_tenant on public.challenge_21_checks
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists closed_checks_delete on public.closed_checks;
create policy closed_checks_delete on public.closed_checks
  as permissive
  for delete
  to public
  using (pos_can_access(location_id));

drop policy if exists closed_checks_read on public.closed_checks;
create policy closed_checks_read on public.closed_checks
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists closed_checks_update on public.closed_checks;
create policy closed_checks_update on public.closed_checks
  as permissive
  for update
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists "insert closed checks" on public.closed_checks;
create policy "insert closed checks" on public.closed_checks
  as permissive
  for insert
  to public
  with check (true);

drop policy if exists config_pushes_auth_write on public.config_pushes;
create policy config_pushes_auth_write on public.config_pushes
  as permissive
  for all
  to public
  using ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])))
  with check ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])));

drop policy if exists corrective_actions_rls on public.corrective_actions;
create policy corrective_actions_rls on public.corrective_actions
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists customer_consents_read on public.customer_consents;
create policy customer_consents_read on public.customer_consents
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists customer_locations_all on public.customer_locations;
create policy customer_locations_all on public.customer_locations
  as permissive
  for all
  to public
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (auth.uid() IS NULL) OR (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true)))
  with check (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (auth.uid() IS NULL)));

drop policy if exists customer_orders_all on public.customer_orders;
create policy customer_orders_all on public.customer_orders
  as permissive
  for all
  to public
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (auth.uid() IS NULL) OR (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true)))
  with check (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (auth.uid() IS NULL)));

drop policy if exists customers_all on public.customers;
create policy customers_all on public.customers
  as permissive
  for all
  to public
  using (((org_id IN ( SELECT l.org_id
   FROM (locations l
     JOIN user_locations ul ON ((ul.location_id = l.id)))
  WHERE (ul.user_id = auth.uid()))) OR (auth.uid() IS NULL) OR (((auth.jwt() ->> 'is_anonymous'::text))::boolean = true)))
  with check (((org_id IN ( SELECT l.org_id
   FROM (locations l
     JOIN user_locations ul ON ((ul.location_id = l.id)))
  WHERE (ul.user_id = auth.uid()))) OR (auth.uid() IS NULL)));

drop policy if exists deliveries_rls on public.deliveries;
create policy deliveries_rls on public.deliveries
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

drop policy if exists device_heartbeats_tenant on public.device_heartbeats;
create policy device_heartbeats_tenant on public.device_heartbeats
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists "allow all" on public.device_profiles;
create policy "allow all" on public.device_profiles
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "allow all" on public.devices;
create policy "allow all" on public.devices
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "Allow authenticated access" on public.discount_rules;
create policy "Allow authenticated access" on public.discount_rules
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "Allow authenticated access" on public.discounts;
create policy "Allow authenticated access" on public.discounts
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists drawer_sessions_tenant on public.drawer_sessions;
create policy drawer_sessions_tenant on public.drawer_sessions
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists "allow all" on public.eighty_six;
create policy "allow all" on public.eighty_six
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists floor_tables_anon_read on public.floor_tables;
create policy floor_tables_anon_read on public.floor_tables
  as permissive
  for select
  to public
  using (true);

drop policy if exists floor_tables_delete_tenant on public.floor_tables;
create policy floor_tables_delete_tenant on public.floor_tables
  as permissive
  for delete
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists floor_tables_insert_tenant on public.floor_tables;
create policy floor_tables_insert_tenant on public.floor_tables
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists floor_tables_update_tenant on public.floor_tables;
create policy floor_tables_update_tenant on public.floor_tables
  as permissive
  for update
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists inventory_item_conversions_del on public.inventory_item_conversions;
create policy inventory_item_conversions_del on public.inventory_item_conversions
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists inventory_item_conversions_sel on public.inventory_item_conversions;
create policy inventory_item_conversions_sel on public.inventory_item_conversions
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists inventory_item_conversions_upd on public.inventory_item_conversions;
create policy inventory_item_conversions_upd on public.inventory_item_conversions
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists inventory_item_conversions_write on public.inventory_item_conversions;
create policy inventory_item_conversions_write on public.inventory_item_conversions
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists inventory_items_del on public.inventory_items;
create policy inventory_items_del on public.inventory_items
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists inventory_items_sel on public.inventory_items;
create policy inventory_items_sel on public.inventory_items
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists inventory_items_upd on public.inventory_items;
create policy inventory_items_upd on public.inventory_items
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists inventory_items_write on public.inventory_items;
create policy inventory_items_write on public.inventory_items
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists item_cost_history_rls on public.item_cost_history;
create policy item_cost_history_rls on public.item_cost_history
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT item_cost_history.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT item_cost_history.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

drop policy if exists item_packaging_formats_del on public.item_packaging_formats;
create policy item_packaging_formats_del on public.item_packaging_formats
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists item_packaging_formats_sel on public.item_packaging_formats;
create policy item_packaging_formats_sel on public.item_packaging_formats
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists item_packaging_formats_upd on public.item_packaging_formats;
create policy item_packaging_formats_upd on public.item_packaging_formats
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists item_packaging_formats_write on public.item_packaging_formats;
create policy item_packaging_formats_write on public.item_packaging_formats
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists "allow all" on public.item_variants;
create policy "allow all" on public.item_variants
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "allow all" on public.kds_tickets;
create policy "allow all" on public.kds_tickets
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists location_features_tenant on public.location_features;
create policy location_features_tenant on public.location_features
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists "Allow authenticated access" on public.locations;
create policy "Allow authenticated access" on public.locations
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "Users can update own location settings" on public.locations;
create policy "Users can update own location settings" on public.locations
  as permissive
  for update
  to public
  using ((id IN ( SELECT user_profiles.location_id
   FROM user_profiles
  WHERE (user_profiles.id = auth.uid()))))
  with check ((id IN ( SELECT user_profiles.location_id
   FROM user_profiles
  WHERE (user_profiles.id = auth.uid()))));

drop policy if exists "allow all" on public.locations;
create policy "allow all" on public.locations
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists loyalty_transactions_tenant on public.loyalty_transactions;
create policy loyalty_transactions_tenant on public.loyalty_transactions
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists maintenance_notes_rls on public.maintenance_notes;
create policy maintenance_notes_rls on public.maintenance_notes
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists maintenance_requests_rls on public.maintenance_requests;
create policy maintenance_requests_rls on public.maintenance_requests
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

drop policy if exists maintenance_status_history_rls on public.maintenance_status_history;
create policy maintenance_status_history_rls on public.maintenance_status_history
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists marketing_messages_read on public.marketing_messages;
create policy marketing_messages_read on public.marketing_messages
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists marketing_suppressions_read on public.marketing_suppressions;
create policy marketing_suppressions_read on public.marketing_suppressions
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists mb_screens_delete on public.menu_board_screens;
create policy mb_screens_delete on public.menu_board_screens
  as permissive
  for delete
  to authenticated
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists mb_screens_insert on public.menu_board_screens;
create policy mb_screens_insert on public.menu_board_screens
  as permissive
  for insert
  to public
  with check (((device_uid = auth.uid()) AND (location_id IS NULL) AND (board_id IS NULL) AND (status = 'unpaired'::text)));

drop policy if exists mb_screens_select on public.menu_board_screens;
create policy mb_screens_select on public.menu_board_screens
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists menu_boards_delete on public.menu_boards;
create policy menu_boards_delete on public.menu_boards
  as permissive
  for delete
  to authenticated
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists menu_boards_insert on public.menu_boards;
create policy menu_boards_insert on public.menu_boards
  as permissive
  for insert
  to authenticated
  with check (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists menu_boards_read on public.menu_boards;
create policy menu_boards_read on public.menu_boards
  as permissive
  for select
  to public
  using (true);

drop policy if exists menu_boards_update on public.menu_boards;
create policy menu_boards_update on public.menu_boards
  as permissive
  for update
  to authenticated
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))))
  with check (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists menu_categories_anon_read on public.menu_categories;
create policy menu_categories_anon_read on public.menu_categories
  as permissive
  for select
  to public
  using (true);

drop policy if exists menu_categories_auth_write on public.menu_categories;
create policy menu_categories_auth_write on public.menu_categories
  as permissive
  for all
  to public
  using ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])))
  with check ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])));

drop policy if exists menu_category_links_anon_read on public.menu_category_links;
create policy menu_category_links_anon_read on public.menu_category_links
  as permissive
  for select
  to public
  using (true);

drop policy if exists menu_category_links_auth_write on public.menu_category_links;
create policy menu_category_links_auth_write on public.menu_category_links
  as permissive
  for all
  to public
  using ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])))
  with check ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])));

drop policy if exists menu_item_recipes_del on public.menu_item_recipes;
create policy menu_item_recipes_del on public.menu_item_recipes
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists menu_item_recipes_sel on public.menu_item_recipes;
create policy menu_item_recipes_sel on public.menu_item_recipes
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists menu_item_recipes_upd on public.menu_item_recipes;
create policy menu_item_recipes_upd on public.menu_item_recipes
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists menu_item_recipes_write on public.menu_item_recipes;
create policy menu_item_recipes_write on public.menu_item_recipes
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists menu_items_anon_read on public.menu_items;
create policy menu_items_anon_read on public.menu_items
  as permissive
  for select
  to public
  using (true);

drop policy if exists menu_items_write_tenant on public.menu_items;
create policy menu_items_write_tenant on public.menu_items
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists menus_anon_read on public.menus;
create policy menus_anon_read on public.menus
  as permissive
  for select
  to public
  using (true);

drop policy if exists menus_auth_write on public.menus;
create policy menus_auth_write on public.menus
  as permissive
  for all
  to public
  using ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])))
  with check ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])));

drop policy if exists modifier_groups_delete on public.modifier_groups;
create policy modifier_groups_delete on public.modifier_groups
  as permissive
  for delete
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists modifier_groups_update on public.modifier_groups;
create policy modifier_groups_update on public.modifier_groups
  as permissive
  for update
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists modifier_groups_write on public.modifier_groups;
create policy modifier_groups_write on public.modifier_groups
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists "read modifier groups" on public.modifier_groups;
create policy "read modifier groups" on public.modifier_groups
  as permissive
  for select
  to public
  using (true);

drop policy if exists "allow all" on public.modifier_options;
create policy "allow all" on public.modifier_options
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists offers_read on public.offers;
create policy offers_read on public.offers
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists ops_alerts_rls on public.ops_alerts;
create policy ops_alerts_rls on public.ops_alerts
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists ops_audit_ins on public.ops_audit;
create policy ops_audit_ins on public.ops_audit
  as permissive
  for insert
  to public
  with check (ops_can_write(location_id));

drop policy if exists ops_audit_sel on public.ops_audit;
create policy ops_audit_sel on public.ops_audit
  as permissive
  for select
  to public
  using (ops_can_write(location_id));

drop policy if exists ops_checklist_runs_rls on public.ops_checklist_runs;
create policy ops_checklist_runs_rls on public.ops_checklist_runs
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

drop policy if exists ops_checklist_tasks_rls on public.ops_checklist_tasks;
create policy ops_checklist_tasks_rls on public.ops_checklist_tasks
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists ops_checklists_rls on public.ops_checklists;
create policy ops_checklists_rls on public.ops_checklists
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists ops_devices_rls on public.ops_devices;
create policy ops_devices_rls on public.ops_devices
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists ops_notification_rules_rls on public.ops_notification_rules;
create policy ops_notification_rules_rls on public.ops_notification_rules
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists ops_task_completions_rls on public.ops_task_completions;
create policy ops_task_completions_rls on public.ops_task_completions
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

drop policy if exists "allow all" on public.order_queue;
create policy "allow all" on public.order_queue
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists org_sending_domains_read on public.org_sending_domains;
create policy org_sending_domains_read on public.org_sending_domains
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists "Allow authenticated access" on public.organisations;
create policy "Allow authenticated access" on public.organisations
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "allow all" on public.organisations;
create policy "allow all" on public.organisations
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists par_levels_rls on public.par_levels;
create policy par_levels_rls on public.par_levels
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists po_lines_rls on public.po_lines;
create policy po_lines_rls on public.po_lines
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists pos_nudges_tenant on public.pos_nudges;
create policy pos_nudges_tenant on public.pos_nudges
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists prep_log_rls on public.prep_log;
create policy prep_log_rls on public.prep_log
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

drop policy if exists prep_schedule_del on public.prep_schedule;
create policy prep_schedule_del on public.prep_schedule
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists prep_schedule_ins on public.prep_schedule;
create policy prep_schedule_ins on public.prep_schedule
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists prep_schedule_sel on public.prep_schedule;
create policy prep_schedule_sel on public.prep_schedule
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists prep_schedule_upd on public.prep_schedule;
create policy prep_schedule_upd on public.prep_schedule
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists "agent update" on public.print_jobs;
create policy "agent update" on public.print_jobs
  as permissive
  for update
  to public
  using (true);

drop policy if exists "insert print jobs" on public.print_jobs;
create policy "insert print jobs" on public.print_jobs
  as permissive
  for insert
  to public
  with check (true);

drop policy if exists "read print jobs" on public.print_jobs;
create policy "read print jobs" on public.print_jobs
  as permissive
  for select
  to public
  using (true);

drop policy if exists "Allow authenticated access" on public.print_routing;
create policy "Allow authenticated access" on public.print_routing
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "Allow authenticated access" on public.printer_agents;
create policy "Allow authenticated access" on public.printer_agents
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "Allow authenticated access" on public.printer_health;
create policy "Allow authenticated access" on public.printer_health
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists "Allow authenticated access" on public.printers;
create policy "Allow authenticated access" on public.printers
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists production_batches_del on public.production_batches;
create policy production_batches_del on public.production_batches
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists production_batches_ins on public.production_batches;
create policy production_batches_ins on public.production_batches
  as permissive
  for insert
  to public
  with check (pos_can_access(location_id));

drop policy if exists production_batches_sel on public.production_batches;
create policy production_batches_sel on public.production_batches
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists production_batches_upd on public.production_batches;
create policy production_batches_upd on public.production_batches
  as permissive
  for update
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists promo_codes_read on public.promo_codes;
create policy promo_codes_read on public.promo_codes
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists promo_redemptions_read on public.promo_redemptions;
create policy promo_redemptions_read on public.promo_redemptions
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists purchase_orders_rls on public.purchase_orders;
create policy purchase_orders_rls on public.purchase_orders
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists quote_accuracy_rw on public.quote_accuracy;
create policy quote_accuracy_rw on public.quote_accuracy
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

drop policy if exists "allow read all" on public.receipt_emails;
create policy "allow read all" on public.receipt_emails
  as permissive
  for select
  to anon, authenticated
  using (true);

drop policy if exists recipe_lines_del on public.recipe_lines;
create policy recipe_lines_del on public.recipe_lines
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists recipe_lines_sel on public.recipe_lines;
create policy recipe_lines_sel on public.recipe_lines
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists recipe_lines_upd on public.recipe_lines;
create policy recipe_lines_upd on public.recipe_lines
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists recipe_lines_write on public.recipe_lines;
create policy recipe_lines_write on public.recipe_lines
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists recipes_del on public.recipes;
create policy recipes_del on public.recipes
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists recipes_sel on public.recipes;
create policy recipes_sel on public.recipes
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists recipes_upd on public.recipes;
create policy recipes_upd on public.recipes
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists recipes_write on public.recipes;
create policy recipes_write on public.recipes
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_feedback_read on public.review_feedback;
create policy review_feedback_read on public.review_feedback
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_platform_links_read on public.review_platform_links;
create policy review_platform_links_read on public.review_platform_links
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_replies_read on public.review_replies;
create policy review_replies_read on public.review_replies
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_requests_read on public.review_requests;
create policy review_requests_read on public.review_requests
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_settings_read on public.review_settings;
create policy review_settings_read on public.review_settings
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists review_themes_read on public.review_themes;
create policy review_themes_read on public.review_themes
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists sections_tenant on public.sections;
create policy sections_tenant on public.sections
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists segments_read on public.segments;
create policy segments_read on public.segments
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists shifts_tenant on public.shifts;
create policy shifts_tenant on public.shifts
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists staff_auth_events_insert on public.staff_auth_events;
create policy staff_auth_events_insert on public.staff_auth_events
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists staff_auth_events_read on public.staff_auth_events;
create policy staff_auth_events_read on public.staff_auth_events
  as permissive
  for select
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));

drop policy if exists staff_members_tenant on public.staff_members;
create policy staff_members_tenant on public.staff_members
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

drop policy if exists anon_read_stamp_tx on public.stamp_transactions;
create policy anon_read_stamp_tx on public.stamp_transactions
  as permissive
  for select
  to public
  using (true);

drop policy if exists service_all_stamp_tx on public.stamp_transactions;
create policy service_all_stamp_tx on public.stamp_transactions
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists stock_count_lines_rls on public.stock_count_lines;
create policy stock_count_lines_rls on public.stock_count_lines
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT stock_count_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT stock_count_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

drop policy if exists stock_counts_rls on public.stock_counts;
create policy stock_counts_rls on public.stock_counts
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists stock_levels_anon_read on public.stock_levels;
create policy stock_levels_anon_read on public.stock_levels
  as permissive
  for select
  to public
  using (true);

drop policy if exists stock_levels_auth_write on public.stock_levels;
create policy stock_levels_auth_write on public.stock_levels
  as permissive
  for all
  to public
  using ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])))
  with check ((auth.role() = ANY (ARRAY['authenticated'::text, 'anon'::text])));

drop policy if exists stock_movements_read on public.stock_movements;
create policy stock_movements_read on public.stock_movements
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists stock_units_read on public.stock_units;
create policy stock_units_read on public.stock_units
  as permissive
  for select
  to public
  using (true);

drop policy if exists subscriptions_tenant on public.subscriptions;
create policy subscriptions_tenant on public.subscriptions
  as permissive
  for all
  to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin()))
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin()));

drop policy if exists supplier_invoice_lines_rls on public.supplier_invoice_lines;
create policy supplier_invoice_lines_rls on public.supplier_invoice_lines
  as permissive
  for all
  to public
  using ((location_id IN ( SELECT supplier_invoice_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))))
  with check ((location_id IN ( SELECT supplier_invoice_lines.location_id
   FROM user_accessible_locations() user_accessible_locations(user_accessible_locations))));

drop policy if exists supplier_invoices_rls on public.supplier_invoices;
create policy supplier_invoices_rls on public.supplier_invoices
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists supplier_products_del on public.supplier_products;
create policy supplier_products_del on public.supplier_products
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists supplier_products_sel on public.supplier_products;
create policy supplier_products_sel on public.supplier_products
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists supplier_products_upd on public.supplier_products;
create policy supplier_products_upd on public.supplier_products
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists supplier_products_write on public.supplier_products;
create policy supplier_products_write on public.supplier_products
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists suppliers_rls on public.suppliers;
create policy suppliers_rls on public.suppliers
  as permissive
  for all
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists "allow all" on public.table_reservations;
create policy "allow all" on public.table_reservations
  as permissive
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "Allow authenticated access" on public.tax_rates;
create policy "Allow authenticated access" on public.tax_rates
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists temp_check_schedules_rls on public.temp_check_schedules;
create policy temp_check_schedules_rls on public.temp_check_schedules
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists temp_readings_ins on public.temp_readings;
create policy temp_readings_ins on public.temp_readings
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists temp_readings_sel on public.temp_readings;
create policy temp_readings_sel on public.temp_readings
  as permissive
  for select
  to public
  using (ops_can_write(location_id));

drop policy if exists temp_units_rls on public.temp_units;
create policy temp_units_rls on public.temp_units
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists td_select on public.terminal_devices;
create policy td_select on public.terminal_devices
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists tj_select_bo on public.terminal_jobs;
create policy tj_select_bo on public.terminal_jobs
  as permissive
  for select
  to public
  using (((location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

drop policy if exists tj_select_terminal on public.terminal_jobs;
create policy tj_select_terminal on public.terminal_jobs
  as permissive
  for select
  to public
  using ((target_terminal_id IN ( SELECT terminal_devices.id
   FROM terminal_devices
  WHERE ((terminal_devices.device_uid = auth.uid()) AND terminal_devices.active))));

drop policy if exists turn_time_stats_rw on public.turn_time_stats;
create policy turn_time_stats_rw on public.turn_time_stats
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

drop policy if exists ul_delete_self on public.user_locations;
create policy ul_delete_self on public.user_locations
  as permissive
  for delete
  to public
  using (((user_id = auth.uid()) AND (NOT is_anon_session())));

drop policy if exists ul_delete_super_admin on public.user_locations;
create policy ul_delete_super_admin on public.user_locations
  as permissive
  for delete
  to public
  using (is_super_admin());

drop policy if exists ul_insert_self_claim on public.user_locations;
create policy ul_insert_self_claim on public.user_locations
  as permissive
  for insert
  to public
  with check (((user_id = auth.uid()) AND (NOT is_anon_session()) AND (role = 'owner'::text) AND can_claim_location(location_id)));

drop policy if exists ul_insert_super_admin on public.user_locations;
create policy ul_insert_super_admin on public.user_locations
  as permissive
  for insert
  to public
  with check (is_super_admin());

drop policy if exists ul_no_anon_delete on public.user_locations;
create policy ul_no_anon_delete on public.user_locations
  as restrictive
  for delete
  to public
  using ((NOT is_anon_session()));

drop policy if exists ul_no_anon_insert on public.user_locations;
create policy ul_no_anon_insert on public.user_locations
  as restrictive
  for insert
  to public
  with check ((NOT is_anon_session()));

drop policy if exists ul_no_anon_update on public.user_locations;
create policy ul_no_anon_update on public.user_locations
  as restrictive
  for update
  to public
  using ((NOT is_anon_session()))
  with check ((NOT is_anon_session()));

drop policy if exists ul_select_super_admin on public.user_locations;
create policy ul_select_super_admin on public.user_locations
  as permissive
  for select
  to public
  using (is_super_admin());

drop policy if exists ul_update_self on public.user_locations;
create policy ul_update_self on public.user_locations
  as permissive
  for update
  to public
  using (((user_id = auth.uid()) AND (NOT is_anon_session())))
  with check (((user_id = auth.uid()) AND (NOT is_anon_session())));

drop policy if exists ul_update_super_admin on public.user_locations;
create policy ul_update_super_admin on public.user_locations
  as permissive
  for update
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists user_locations_select_own on public.user_locations;
create policy user_locations_select_own on public.user_locations
  as permissive
  for select
  to public
  using ((auth.uid() = user_id));

drop policy if exists "Allow authenticated access" on public.user_profiles;
create policy "Allow authenticated access" on public.user_profiles
  as permissive
  for all
  to public
  using ((auth.role() = 'authenticated'::text));

drop policy if exists up_no_anon_delete on public.user_profiles;
create policy up_no_anon_delete on public.user_profiles
  as restrictive
  for delete
  to public
  using ((NOT is_anon_session()));

drop policy if exists up_no_anon_update on public.user_profiles;
create policy up_no_anon_update on public.user_profiles
  as restrictive
  for update
  to public
  using ((NOT is_anon_session()))
  with check ((NOT is_anon_session()));

drop policy if exists waitlist_config_rw on public.waitlist_config;
create policy waitlist_config_rw on public.waitlist_config
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

drop policy if exists waitlist_devices_sel on public.waitlist_devices;
create policy waitlist_devices_sel on public.waitlist_devices
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR ((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));

drop policy if exists waitlist_entries_rw on public.waitlist_entries;
create policy waitlist_entries_rw on public.waitlist_entries
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

drop policy if exists waitlist_sms_inbound_sel on public.waitlist_sms_inbound;
create policy waitlist_sms_inbound_sel on public.waitlist_sms_inbound
  as permissive
  for select
  to public
  using (waitlist_can_write(location_id));

drop policy if exists waitlist_events_rw on public.waitlist_status_events;
create policy waitlist_events_rw on public.waitlist_status_events
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

drop policy if exists waste_events_del on public.waste_events;
create policy waste_events_del on public.waste_events
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists waste_events_ins on public.waste_events;
create policy waste_events_ins on public.waste_events
  as permissive
  for insert
  to public
  with check (pos_can_access(location_id));

drop policy if exists waste_events_sel on public.waste_events;
create policy waste_events_sel on public.waste_events
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

drop policy if exists waste_events_upd on public.waste_events;
create policy waste_events_upd on public.waste_events
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_announcements_rls_delete on public.wf_announcements;
create policy wf_announcements_rls_delete on public.wf_announcements
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_announcements_rls_insert on public.wf_announcements;
create policy wf_announcements_rls_insert on public.wf_announcements
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_announcements_rls_select on public.wf_announcements;
create policy wf_announcements_rls_select on public.wf_announcements
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_announcements_rls_update on public.wf_announcements;
create policy wf_announcements_rls_update on public.wf_announcements
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_announcements_super_admin_all on public.wf_announcements;
create policy wf_announcements_super_admin_all on public.wf_announcements
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_audit_rls_insert on public.wf_audit;
create policy wf_audit_rls_insert on public.wf_audit
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_audit_rls_select on public.wf_audit;
create policy wf_audit_rls_select on public.wf_audit
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_audit_super_admin_select on public.wf_audit;
create policy wf_audit_super_admin_select on public.wf_audit
  as permissive
  for select
  to public
  using (is_super_admin());

drop policy if exists wf_availability_rls_delete on public.wf_availability;
create policy wf_availability_rls_delete on public.wf_availability
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_availability_rls_insert on public.wf_availability;
create policy wf_availability_rls_insert on public.wf_availability
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_availability_rls_select on public.wf_availability;
create policy wf_availability_rls_select on public.wf_availability
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_availability_rls_update on public.wf_availability;
create policy wf_availability_rls_update on public.wf_availability
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_availability_super_admin_all on public.wf_availability;
create policy wf_availability_super_admin_all on public.wf_availability
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_doc_templates_rls_delete on public.wf_doc_templates;
create policy wf_doc_templates_rls_delete on public.wf_doc_templates
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_doc_templates_rls_insert on public.wf_doc_templates;
create policy wf_doc_templates_rls_insert on public.wf_doc_templates
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_doc_templates_rls_select on public.wf_doc_templates;
create policy wf_doc_templates_rls_select on public.wf_doc_templates
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_doc_templates_rls_update on public.wf_doc_templates;
create policy wf_doc_templates_rls_update on public.wf_doc_templates
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_doc_templates_super_admin_all on public.wf_doc_templates;
create policy wf_doc_templates_super_admin_all on public.wf_doc_templates
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_documents_rls_delete on public.wf_documents;
create policy wf_documents_rls_delete on public.wf_documents
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_documents_rls_insert on public.wf_documents;
create policy wf_documents_rls_insert on public.wf_documents
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_documents_rls_select on public.wf_documents;
create policy wf_documents_rls_select on public.wf_documents
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_documents_rls_update on public.wf_documents;
create policy wf_documents_rls_update on public.wf_documents
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_documents_super_admin_all on public.wf_documents;
create policy wf_documents_super_admin_all on public.wf_documents
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_holiday_accrual_rls_insert on public.wf_holiday_accrual;
create policy wf_holiday_accrual_rls_insert on public.wf_holiday_accrual
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_holiday_accrual_rls_select on public.wf_holiday_accrual;
create policy wf_holiday_accrual_rls_select on public.wf_holiday_accrual
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual;
create policy wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual
  as permissive
  for select
  to public
  using (is_super_admin());

drop policy if exists wf_onboarding_rls_delete on public.wf_onboarding;
create policy wf_onboarding_rls_delete on public.wf_onboarding
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_onboarding_rls_insert on public.wf_onboarding;
create policy wf_onboarding_rls_insert on public.wf_onboarding
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_onboarding_rls_select on public.wf_onboarding;
create policy wf_onboarding_rls_select on public.wf_onboarding
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_onboarding_rls_update on public.wf_onboarding;
create policy wf_onboarding_rls_update on public.wf_onboarding
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_onboarding_super_admin_all on public.wf_onboarding;
create policy wf_onboarding_super_admin_all on public.wf_onboarding
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_payroll_runs_rls_select on public.wf_payroll_runs;
create policy wf_payroll_runs_rls_select on public.wf_payroll_runs
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_payroll_runs_super_admin_all on public.wf_payroll_runs;
create policy wf_payroll_runs_super_admin_all on public.wf_payroll_runs
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_rate_changes_rls_delete on public.wf_rate_changes;
create policy wf_rate_changes_rls_delete on public.wf_rate_changes
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_rate_changes_rls_insert on public.wf_rate_changes;
create policy wf_rate_changes_rls_insert on public.wf_rate_changes
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_rate_changes_rls_select on public.wf_rate_changes;
create policy wf_rate_changes_rls_select on public.wf_rate_changes
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_rate_changes_rls_update on public.wf_rate_changes;
create policy wf_rate_changes_rls_update on public.wf_rate_changes
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_roles_rls_delete on public.wf_roles;
create policy wf_roles_rls_delete on public.wf_roles
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_roles_rls_insert on public.wf_roles;
create policy wf_roles_rls_insert on public.wf_roles
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_roles_rls_select on public.wf_roles;
create policy wf_roles_rls_select on public.wf_roles
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_roles_rls_update on public.wf_roles;
create policy wf_roles_rls_update on public.wf_roles
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_roles_super_admin_all on public.wf_roles;
create policy wf_roles_super_admin_all on public.wf_roles
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_sales_forecast_rls_delete on public.wf_sales_forecast;
create policy wf_sales_forecast_rls_delete on public.wf_sales_forecast
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sales_forecast_rls_insert on public.wf_sales_forecast;
create policy wf_sales_forecast_rls_insert on public.wf_sales_forecast
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sales_forecast_rls_select on public.wf_sales_forecast;
create policy wf_sales_forecast_rls_select on public.wf_sales_forecast
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sales_forecast_rls_update on public.wf_sales_forecast;
create policy wf_sales_forecast_rls_update on public.wf_sales_forecast
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sales_forecast_super_admin_all on public.wf_sales_forecast;
create policy wf_sales_forecast_super_admin_all on public.wf_sales_forecast
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_sections_rls_delete on public.wf_sections;
create policy wf_sections_rls_delete on public.wf_sections
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sections_rls_insert on public.wf_sections;
create policy wf_sections_rls_insert on public.wf_sections
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sections_rls_select on public.wf_sections;
create policy wf_sections_rls_select on public.wf_sections
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sections_rls_update on public.wf_sections;
create policy wf_sections_rls_update on public.wf_sections
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_sections_super_admin_all on public.wf_sections;
create policy wf_sections_super_admin_all on public.wf_sections
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_shifts_rls_delete on public.wf_shifts;
create policy wf_shifts_rls_delete on public.wf_shifts
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_shifts_rls_insert on public.wf_shifts;
create policy wf_shifts_rls_insert on public.wf_shifts
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_shifts_rls_select on public.wf_shifts;
create policy wf_shifts_rls_select on public.wf_shifts
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_shifts_rls_update on public.wf_shifts;
create policy wf_shifts_rls_update on public.wf_shifts
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_shifts_super_admin_all on public.wf_shifts;
create policy wf_shifts_super_admin_all on public.wf_shifts
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_staff_rls_delete on public.wf_staff;
create policy wf_staff_rls_delete on public.wf_staff
  as permissive
  for delete
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists wf_staff_rls_insert on public.wf_staff;
create policy wf_staff_rls_insert on public.wf_staff
  as permissive
  for insert
  to public
  with check (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists wf_staff_rls_select on public.wf_staff;
create policy wf_staff_rls_select on public.wf_staff
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists wf_staff_rls_update on public.wf_staff;
create policy wf_staff_rls_update on public.wf_staff
  as permissive
  for update
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)))
  with check (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists wf_staff_super_admin_all on public.wf_staff;
create policy wf_staff_super_admin_all on public.wf_staff
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_swap_requests_rls_delete on public.wf_swap_requests;
create policy wf_swap_requests_rls_delete on public.wf_swap_requests
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_swap_requests_rls_insert on public.wf_swap_requests;
create policy wf_swap_requests_rls_insert on public.wf_swap_requests
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_swap_requests_rls_select on public.wf_swap_requests;
create policy wf_swap_requests_rls_select on public.wf_swap_requests
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_swap_requests_rls_update on public.wf_swap_requests;
create policy wf_swap_requests_rls_update on public.wf_swap_requests
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_swap_requests_super_admin_all on public.wf_swap_requests;
create policy wf_swap_requests_super_admin_all on public.wf_swap_requests
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_time_off_rls_delete on public.wf_time_off;
create policy wf_time_off_rls_delete on public.wf_time_off
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_time_off_rls_insert on public.wf_time_off;
create policy wf_time_off_rls_insert on public.wf_time_off
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_time_off_rls_select on public.wf_time_off;
create policy wf_time_off_rls_select on public.wf_time_off
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_time_off_rls_update on public.wf_time_off;
create policy wf_time_off_rls_update on public.wf_time_off
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_time_off_super_admin_all on public.wf_time_off;
create policy wf_time_off_super_admin_all on public.wf_time_off
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_timesheets_rls_delete on public.wf_timesheets;
create policy wf_timesheets_rls_delete on public.wf_timesheets
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_timesheets_rls_insert on public.wf_timesheets;
create policy wf_timesheets_rls_insert on public.wf_timesheets
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_timesheets_rls_select on public.wf_timesheets;
create policy wf_timesheets_rls_select on public.wf_timesheets
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_timesheets_rls_update on public.wf_timesheets;
create policy wf_timesheets_rls_update on public.wf_timesheets
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_timesheets_super_admin_all on public.wf_timesheets;
create policy wf_timesheets_super_admin_all on public.wf_timesheets
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_tronc_lines_rls_delete on public.wf_tronc_lines;
create policy wf_tronc_lines_rls_delete on public.wf_tronc_lines
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_lines_rls_insert on public.wf_tronc_lines;
create policy wf_tronc_lines_rls_insert on public.wf_tronc_lines
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_lines_rls_select on public.wf_tronc_lines;
create policy wf_tronc_lines_rls_select on public.wf_tronc_lines
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_lines_rls_update on public.wf_tronc_lines;
create policy wf_tronc_lines_rls_update on public.wf_tronc_lines
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_lines_super_admin_all on public.wf_tronc_lines;
create policy wf_tronc_lines_super_admin_all on public.wf_tronc_lines
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_tronc_runs_rls_delete on public.wf_tronc_runs;
create policy wf_tronc_runs_rls_delete on public.wf_tronc_runs
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_runs_rls_insert on public.wf_tronc_runs;
create policy wf_tronc_runs_rls_insert on public.wf_tronc_runs
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_runs_rls_select on public.wf_tronc_runs;
create policy wf_tronc_runs_rls_select on public.wf_tronc_runs
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_runs_rls_update on public.wf_tronc_runs;
create policy wf_tronc_runs_rls_update on public.wf_tronc_runs
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_tronc_runs_super_admin_all on public.wf_tronc_runs;
create policy wf_tronc_runs_super_admin_all on public.wf_tronc_runs
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_user_roles_rls_delete on public.wf_user_roles;
create policy wf_user_roles_rls_delete on public.wf_user_roles
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_user_roles_rls_insert on public.wf_user_roles;
create policy wf_user_roles_rls_insert on public.wf_user_roles
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_user_roles_rls_select on public.wf_user_roles;
create policy wf_user_roles_rls_select on public.wf_user_roles
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_user_roles_rls_update on public.wf_user_roles;
create policy wf_user_roles_rls_update on public.wf_user_roles
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_user_roles_super_admin_all on public.wf_user_roles;
create policy wf_user_roles_super_admin_all on public.wf_user_roles
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wf_venue_settings_rls_delete on public.wf_venue_settings;
create policy wf_venue_settings_rls_delete on public.wf_venue_settings
  as permissive
  for delete
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_venue_settings_rls_insert on public.wf_venue_settings;
create policy wf_venue_settings_rls_insert on public.wf_venue_settings
  as permissive
  for insert
  to public
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_venue_settings_rls_select on public.wf_venue_settings;
create policy wf_venue_settings_rls_select on public.wf_venue_settings
  as permissive
  for select
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_venue_settings_rls_update on public.wf_venue_settings;
create policy wf_venue_settings_rls_update on public.wf_venue_settings
  as permissive
  for update
  to public
  using (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wf_venue_settings_super_admin_all on public.wf_venue_settings;
create policy wf_venue_settings_super_admin_all on public.wf_venue_settings
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

drop policy if exists wifi_captures_read on public.wifi_captures;
create policy wifi_captures_read on public.wifi_captures
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists wifi_portal_settings_read on public.wifi_portal_settings;
create policy wifi_portal_settings_read on public.wifi_portal_settings
  as permissive
  for select
  to public
  using ((location_id IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

drop policy if exists workflow_enrollments_read on public.workflow_enrollments;
create policy workflow_enrollments_read on public.workflow_enrollments
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists workflow_step_sends_read on public.workflow_step_sends;
create policy workflow_step_sends_read on public.workflow_step_sends
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

drop policy if exists workflows_read on public.workflows;
create policy workflows_read on public.workflows
  as permissive
  for select
  to public
  using (((org_id)::text IN ( SELECT user_accessible_orgs() AS user_accessible_orgs)));

-- --------------------------------------------------------------------------
-- 9. TRIGGERS  (23)
-- pg_get_triggerdef() verbatim, preceded by DROP TRIGGER IF EXISTS.
-- Several money paths depend on these, so they are not optional colour:
-- they are part of the behaviour of the tables above.
-- --------------------------------------------------------------------------

drop trigger if exists trg_bar_tabs_updated_at on public.bar_tabs;
CREATE TRIGGER trg_bar_tabs_updated_at BEFORE UPDATE ON bar_tabs FOR EACH ROW EXECUTE FUNCTION _touch_updated_at();

drop trigger if exists order_queue_activity on public.order_queue;
CREATE TRIGGER order_queue_activity AFTER INSERT ON order_queue FOR EACH ROW EXECUTE FUNCTION log_order_activity();

drop trigger if exists order_queue_notify on public.order_queue;
CREATE TRIGGER order_queue_notify AFTER INSERT OR UPDATE OF status ON order_queue FOR EACH ROW EXECUTE FUNCTION tg_order_queue_notify();

drop trigger if exists trg_order_queue_updated_at on public.order_queue;
CREATE TRIGGER trg_order_queue_updated_at BEFORE UPDATE ON order_queue FOR EACH ROW EXECUTE FUNCTION _touch_updated_at();

drop trigger if exists wl_config_touch on public.waitlist_config;
CREATE TRIGGER wl_config_touch BEFORE UPDATE ON waitlist_config FOR EACH ROW EXECUTE FUNCTION wl_touch_updated_at();

drop trigger if exists wl_entries_touch on public.waitlist_entries;
CREATE TRIGGER wl_entries_touch BEFORE UPDATE ON waitlist_entries FOR EACH ROW EXECUTE FUNCTION wl_touch_updated_at();

drop trigger if exists trg_wf_availability_touch on public.wf_availability;
CREATE TRIGGER trg_wf_availability_touch BEFORE UPDATE ON wf_availability FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_doc_templates_touch on public.wf_doc_templates;
CREATE TRIGGER trg_wf_doc_templates_touch BEFORE UPDATE ON wf_doc_templates FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_documents_touch on public.wf_documents;
CREATE TRIGGER trg_wf_documents_touch BEFORE UPDATE ON wf_documents FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_onboarding_touch on public.wf_onboarding;
CREATE TRIGGER trg_wf_onboarding_touch BEFORE UPDATE ON wf_onboarding FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_rate_changes_touch on public.wf_rate_changes;
CREATE TRIGGER trg_wf_rate_changes_touch BEFORE UPDATE ON wf_rate_changes FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_roles_touch on public.wf_roles;
CREATE TRIGGER trg_wf_roles_touch BEFORE UPDATE ON wf_roles FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_sales_forecast_touch on public.wf_sales_forecast;
CREATE TRIGGER trg_wf_sales_forecast_touch BEFORE UPDATE ON wf_sales_forecast FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_sections_touch on public.wf_sections;
CREATE TRIGGER trg_wf_sections_touch BEFORE UPDATE ON wf_sections FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_shifts_touch on public.wf_shifts;
CREATE TRIGGER trg_wf_shifts_touch BEFORE UPDATE ON wf_shifts FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_staff_touch on public.wf_staff;
CREATE TRIGGER trg_wf_staff_touch BEFORE UPDATE ON wf_staff FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_swap_requests_touch on public.wf_swap_requests;
CREATE TRIGGER trg_wf_swap_requests_touch BEFORE UPDATE ON wf_swap_requests FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_time_off_touch on public.wf_time_off;
CREATE TRIGGER trg_wf_time_off_touch BEFORE UPDATE ON wf_time_off FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_timesheets_touch on public.wf_timesheets;
CREATE TRIGGER trg_wf_timesheets_touch BEFORE UPDATE ON wf_timesheets FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_tronc_no_delete on public.wf_tronc_runs;
CREATE TRIGGER trg_wf_tronc_no_delete BEFORE DELETE ON wf_tronc_runs FOR EACH ROW EXECUTE FUNCTION wf_block_finalized_tronc_delete();

drop trigger if exists trg_wf_tronc_runs_touch on public.wf_tronc_runs;
CREATE TRIGGER trg_wf_tronc_runs_touch BEFORE UPDATE ON wf_tronc_runs FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_user_roles_touch on public.wf_user_roles;
CREATE TRIGGER trg_wf_user_roles_touch BEFORE UPDATE ON wf_user_roles FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

drop trigger if exists trg_wf_venue_settings_touch on public.wf_venue_settings;
CREATE TRIGGER trg_wf_venue_settings_touch BEFORE UPDATE ON wf_venue_settings FOR EACH ROW EXECUTE FUNCTION wf_touch_updated_at();

-- --------------------------------------------------------------------------
-- 10. GRANTS  (484 table, 4 column, 294 function)
-- From aclexplode() over relacl / attacl / proacl, restricted to anon,
-- authenticated, service_role and PUBLIC. These are load-bearing: on
-- several tables the grant, not the policy, is what actually stops or
-- allows an anonymous caller. Owner (postgres) grants are omitted.
--
-- READ THIS BEFORE EDITING THE REVOKE BLOCKS. They are not decoration.
-- Two mechanisms hand out privileges for free, and without an explicit
-- revoke a rebuilt database ends up MORE PERMISSIVE than production:
--   1. CREATE FUNCTION grants EXECUTE to PUBLIC by default. 37 of the 88
--      functions have had that revoked live.
--   2. This project has ALTER DEFAULT PRIVILEGES in schema public granting
--      ALL on tables and EXECUTE on functions to anon, authenticated and
--      service_role. So on a Supabase restore target every new object is
--      wide open before a single GRANT below runs.
-- So: revoke everything from all four principals first, then grant back
-- exactly what production has. This was verified — rebuilding without the
-- revokes reproduced 30 privileges that are deliberately withheld live,
-- including EXECUTE on promo_redeem_atomic (a money path) to anon, all
-- access to the customer_rfm view (customer PII) to anon, and UPDATE and
-- DELETE on wf_audit / wf_holiday_accrual, which are append-only.
--
-- Column-level grants are rare and easy to miss — the four live ones are
-- in 10d and they must stay AFTER 10c, because a table-level grant does
-- not imply them and REVOKE ALL ON TABLE clears them.
-- --------------------------------------------------------------------------

-- 10a. reset table privileges (162 relations) — see note above
revoke all on table public.active_sessions from public, anon, authenticated, service_role;
revoke all on table public.activity_events from public, anon, authenticated, service_role;
revoke all on table public.bar_tabs from public, anon, authenticated, service_role;
revoke all on table public.campaign_runs from public, anon, authenticated, service_role;
revoke all on table public.campaign_sends from public, anon, authenticated, service_role;
revoke all on table public.campaigns from public, anon, authenticated, service_role;
revoke all on table public.cash_drawers from public, anon, authenticated, service_role;
revoke all on table public.cash_movements from public, anon, authenticated, service_role;
revoke all on table public.catering_site_settings from public, anon, authenticated, service_role;
revoke all on table public.challenge_21_checks from public, anon, authenticated, service_role;
revoke all on table public.closed_checks from public, anon, authenticated, service_role;
revoke all on table public.config_pushes from public, anon, authenticated, service_role;
revoke all on table public.corrective_actions from public, anon, authenticated, service_role;
revoke all on table public.courier_deliveries from public, anon, authenticated, service_role;
revoke all on table public.customer_consents from public, anon, authenticated, service_role;
revoke all on table public.customer_locations from public, anon, authenticated, service_role;
revoke all on table public.customer_orders from public, anon, authenticated, service_role;
revoke all on table public.customer_rfm from public, anon, authenticated, service_role;
revoke all on table public.customers from public, anon, authenticated, service_role;
revoke all on table public.deliveries from public, anon, authenticated, service_role;
revoke all on table public.delivery_costs_actual from public, anon, authenticated, service_role;
revoke all on table public.delivery_quotes from public, anon, authenticated, service_role;
revoke all on table public.delivery_status_events from public, anon, authenticated, service_role;
revoke all on table public.delivery_surcharges from public, anon, authenticated, service_role;
revoke all on table public.device_heartbeats from public, anon, authenticated, service_role;
revoke all on table public.device_profiles from public, anon, authenticated, service_role;
revoke all on table public.devices from public, anon, authenticated, service_role;
revoke all on table public.discount_rules from public, anon, authenticated, service_role;
revoke all on table public.discounts from public, anon, authenticated, service_role;
revoke all on table public.drawer_sessions from public, anon, authenticated, service_role;
revoke all on table public.eighty_six from public, anon, authenticated, service_role;
revoke all on table public.floor_tables from public, anon, authenticated, service_role;
revoke all on table public.hubrise_connections from public, anon, authenticated, service_role;
revoke all on table public.hubrise_events from public, anon, authenticated, service_role;
revoke all on table public.hubrise_oauth_pending from public, anon, authenticated, service_role;
revoke all on table public.hubrise_order_links from public, anon, authenticated, service_role;
revoke all on table public.inventory_item_conversions from public, anon, authenticated, service_role;
revoke all on table public.inventory_items from public, anon, authenticated, service_role;
revoke all on table public.item_cost_history from public, anon, authenticated, service_role;
revoke all on table public.item_packaging_formats from public, anon, authenticated, service_role;
revoke all on table public.item_variants from public, anon, authenticated, service_role;
revoke all on table public.kds_tickets from public, anon, authenticated, service_role;
revoke all on table public.location_features from public, anon, authenticated, service_role;
revoke all on table public.locations from public, anon, authenticated, service_role;
revoke all on table public.loyalty_transactions from public, anon, authenticated, service_role;
revoke all on table public.maintenance_notes from public, anon, authenticated, service_role;
revoke all on table public.maintenance_requests from public, anon, authenticated, service_role;
revoke all on table public.maintenance_status_history from public, anon, authenticated, service_role;
revoke all on table public.marketing_messages from public, anon, authenticated, service_role;
revoke all on table public.marketing_suppressions from public, anon, authenticated, service_role;
revoke all on table public.menu_board_screens from public, anon, authenticated, service_role;
revoke all on table public.menu_boards from public, anon, authenticated, service_role;
revoke all on table public.menu_categories from public, anon, authenticated, service_role;
revoke all on table public.menu_category_links from public, anon, authenticated, service_role;
revoke all on table public.menu_item_recipes from public, anon, authenticated, service_role;
revoke all on table public.menu_items from public, anon, authenticated, service_role;
revoke all on table public.menus from public, anon, authenticated, service_role;
revoke all on table public.modifier_groups from public, anon, authenticated, service_role;
revoke all on table public.modifier_options from public, anon, authenticated, service_role;
revoke all on table public.offers from public, anon, authenticated, service_role;
revoke all on table public.ops_alerts from public, anon, authenticated, service_role;
revoke all on table public.ops_audit from public, anon, authenticated, service_role;
revoke all on table public.ops_checklist_runs from public, anon, authenticated, service_role;
revoke all on table public.ops_checklist_tasks from public, anon, authenticated, service_role;
revoke all on table public.ops_checklists from public, anon, authenticated, service_role;
revoke all on table public.ops_devices from public, anon, authenticated, service_role;
revoke all on table public.ops_notification_rules from public, anon, authenticated, service_role;
revoke all on table public.ops_task_completions from public, anon, authenticated, service_role;
revoke all on table public.order_notifications from public, anon, authenticated, service_role;
revoke all on table public.order_queue from public, anon, authenticated, service_role;
revoke all on table public.org_sending_domains from public, anon, authenticated, service_role;
revoke all on table public.organisations from public, anon, authenticated, service_role;
revoke all on table public.par_levels from public, anon, authenticated, service_role;
revoke all on table public.po_lines from public, anon, authenticated, service_role;
revoke all on table public.pos_nudges from public, anon, authenticated, service_role;
revoke all on table public.prep_log from public, anon, authenticated, service_role;
revoke all on table public.prep_schedule from public, anon, authenticated, service_role;
revoke all on table public.print_jobs from public, anon, authenticated, service_role;
revoke all on table public.print_routing from public, anon, authenticated, service_role;
revoke all on table public.printer_agents from public, anon, authenticated, service_role;
revoke all on table public.printer_health from public, anon, authenticated, service_role;
revoke all on table public.printers from public, anon, authenticated, service_role;
revoke all on table public.production_batches from public, anon, authenticated, service_role;
revoke all on table public.promo_codes from public, anon, authenticated, service_role;
revoke all on table public.promo_redemptions from public, anon, authenticated, service_role;
revoke all on table public.purchase_orders from public, anon, authenticated, service_role;
revoke all on table public.quote_accuracy from public, anon, authenticated, service_role;
revoke all on table public.receipt_emails from public, anon, authenticated, service_role;
revoke all on table public.recipe_lines from public, anon, authenticated, service_role;
revoke all on table public.recipes from public, anon, authenticated, service_role;
revoke all on table public.review_feedback from public, anon, authenticated, service_role;
revoke all on table public.review_google_tokens from public, anon, authenticated, service_role;
revoke all on table public.review_oauth_pending from public, anon, authenticated, service_role;
revoke all on table public.review_platform_links from public, anon, authenticated, service_role;
revoke all on table public.review_replies from public, anon, authenticated, service_role;
revoke all on table public.review_requests from public, anon, authenticated, service_role;
revoke all on table public.review_settings from public, anon, authenticated, service_role;
revoke all on table public.review_themes from public, anon, authenticated, service_role;
revoke all on table public.sections from public, anon, authenticated, service_role;
revoke all on table public.segments from public, anon, authenticated, service_role;
revoke all on table public.shifts from public, anon, authenticated, service_role;
revoke all on table public.sms_messages from public, anon, authenticated, service_role;
revoke all on table public.staff_auth_events from public, anon, authenticated, service_role;
revoke all on table public.staff_members from public, anon, authenticated, service_role;
revoke all on table public.stamp_transactions from public, anon, authenticated, service_role;
revoke all on table public.stock_count_lines from public, anon, authenticated, service_role;
revoke all on table public.stock_counts from public, anon, authenticated, service_role;
revoke all on table public.stock_levels from public, anon, authenticated, service_role;
revoke all on table public.stock_movements from public, anon, authenticated, service_role;
revoke all on table public.stock_units from public, anon, authenticated, service_role;
revoke all on table public.subscriptions from public, anon, authenticated, service_role;
revoke all on table public.supplier_invoice_lines from public, anon, authenticated, service_role;
revoke all on table public.supplier_invoices from public, anon, authenticated, service_role;
revoke all on table public.supplier_products from public, anon, authenticated, service_role;
revoke all on table public.suppliers from public, anon, authenticated, service_role;
revoke all on table public.table_reservations from public, anon, authenticated, service_role;
revoke all on table public.tax_rates from public, anon, authenticated, service_role;
revoke all on table public.temp_check_schedules from public, anon, authenticated, service_role;
revoke all on table public.temp_readings from public, anon, authenticated, service_role;
revoke all on table public.temp_units from public, anon, authenticated, service_role;
revoke all on table public.terminal_devices from public, anon, authenticated, service_role;
revoke all on table public.terminal_jobs from public, anon, authenticated, service_role;
revoke all on table public.turn_time_stats from public, anon, authenticated, service_role;
revoke all on table public.user_locations from public, anon, authenticated, service_role;
revoke all on table public.user_profiles from public, anon, authenticated, service_role;
revoke all on table public.venue_uber_config from public, anon, authenticated, service_role;
revoke all on table public.waitlist_config from public, anon, authenticated, service_role;
revoke all on table public.waitlist_devices from public, anon, authenticated, service_role;
revoke all on table public.waitlist_entries from public, anon, authenticated, service_role;
revoke all on table public.waitlist_sms_inbound from public, anon, authenticated, service_role;
revoke all on table public.waitlist_status_events from public, anon, authenticated, service_role;
revoke all on table public.waste_events from public, anon, authenticated, service_role;
revoke all on table public.wf_announcements from public, anon, authenticated, service_role;
revoke all on table public.wf_audit from public, anon, authenticated, service_role;
revoke all on table public.wf_availability from public, anon, authenticated, service_role;
revoke all on table public.wf_doc_templates from public, anon, authenticated, service_role;
revoke all on table public.wf_documents from public, anon, authenticated, service_role;
revoke all on table public.wf_holiday_accrual from public, anon, authenticated, service_role;
revoke all on table public.wf_onboarding from public, anon, authenticated, service_role;
revoke all on table public.wf_payroll_runs from public, anon, authenticated, service_role;
revoke all on table public.wf_rate_changes from public, anon, authenticated, service_role;
revoke all on table public.wf_roles from public, anon, authenticated, service_role;
revoke all on table public.wf_sales_forecast from public, anon, authenticated, service_role;
revoke all on table public.wf_sections from public, anon, authenticated, service_role;
revoke all on table public.wf_shifts from public, anon, authenticated, service_role;
revoke all on table public.wf_staff from public, anon, authenticated, service_role;
revoke all on table public.wf_swap_requests from public, anon, authenticated, service_role;
revoke all on table public.wf_time_off from public, anon, authenticated, service_role;
revoke all on table public.wf_timesheets from public, anon, authenticated, service_role;
revoke all on table public.wf_tronc_lines from public, anon, authenticated, service_role;
revoke all on table public.wf_tronc_runs from public, anon, authenticated, service_role;
revoke all on table public.wf_user_roles from public, anon, authenticated, service_role;
revoke all on table public.wf_venue_settings from public, anon, authenticated, service_role;
revoke all on table public.wifi_captures from public, anon, authenticated, service_role;
revoke all on table public.wifi_portal_settings from public, anon, authenticated, service_role;
revoke all on table public.wifi_unifi_bindings from public, anon, authenticated, service_role;
revoke all on table public.workflow_enrollments from public, anon, authenticated, service_role;
revoke all on table public.workflow_step_sends from public, anon, authenticated, service_role;
revoke all on table public.workflows from public, anon, authenticated, service_role;
revoke all on table public.xero_config from public, anon, authenticated, service_role;
revoke all on table public.xero_connections from public, anon, authenticated, service_role;
revoke all on table public.xero_sync_log from public, anon, authenticated, service_role;

-- 10b. reset function privileges (88 functions) — see note above
revoke all on function public._mb_user_has_location(p_loc uuid) from public, anon, authenticated, service_role;
revoke all on function public._terminal_for_caller() from public, anon, authenticated, service_role;
revoke all on function public._terminal_gen_code() from public, anon, authenticated, service_role;
revoke all on function public._terminal_is_service_role() from public, anon, authenticated, service_role;
revoke all on function public._terminal_norm_idle_screen(p jsonb) from public, anon, authenticated, service_role;
revoke all on function public._terminal_norm_modes(p jsonb) from public, anon, authenticated, service_role;
revoke all on function public._terminal_norm_tip_config(p jsonb) from public, anon, authenticated, service_role;
revoke all on function public._terminal_user_has_location(p_loc uuid) from public, anon, authenticated, service_role;
revoke all on function public._touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function public._wl_self_open(p_location uuid) from public, anon, authenticated, service_role;
revoke all on function public.apply_due_wf_rate_changes() from public, anon, authenticated, service_role;
revoke all on function public.call_edge_fn(fn text, body jsonb) from public, anon, authenticated, service_role;
revoke all on function public.can_claim_location(p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.catering_public_settings(p_location uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_device(p_code text) from public, anon, authenticated, service_role;
revoke all on function public.claim_menu_board_screen(p_code text, p_board_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_ops_device(p_code text, p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text) from public, anon, authenticated, service_role;
revoke all on function public.claim_waitlist_device(p_code text, p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer) from public, anon, authenticated, service_role;
revoke all on function public.edge_base_url() from public, anon, authenticated, service_role;
revoke all on function public.get_plan_for_gmv(gmv numeric) from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.is_anon_session() from public, anon, authenticated, service_role;
revoke all on function public.is_super_admin() from public, anon, authenticated, service_role;
revoke all on function public.log_order_activity() from public, anon, authenticated, service_role;
revoke all on function public.marketing_ab_report(p_org uuid, p_campaign uuid) from public, anon, authenticated, service_role;
revoke all on function public.marketing_period_sales(p_org uuid, p_start timestamp with time zone, p_end timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.marketing_report(p_org uuid, p_since timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit integer) from public, anon, authenticated, service_role;
revoke all on function public.marketing_set_active_domain(p_org uuid, p_id uuid, p_active boolean) from public, anon, authenticated, service_role;
revoke all on function public.mb_screen_heartbeat(p_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.ops_ack_alert(p_alert_id uuid, p_action text, p_user_name text) from public, anon, authenticated, service_role;
revoke all on function public.ops_can_write(p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.ops_device_heartbeat() from public, anon, authenticated, service_role;
revoke all on function public.ops_pin_login(p_location_id uuid, p_pin text) from public, anon, authenticated, service_role;
revoke all on function public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid, p_operator_id uuid, p_operator_name text, p_source text, p_notes text, p_corrective_action text, p_corrective_desc text, p_delivery_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.pos_can_access(p_loc text) from public, anon, authenticated, service_role;
revoke all on function public.pos_can_access(p_loc uuid) from public, anon, authenticated, service_role;
revoke all on function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric, p_source_type text, p_source_id text, p_idempotency_key text, p_occurred_at timestamp with time zone, p_created_by uuid, p_notes text) from public, anon, authenticated, service_role;
revoke all on function public.promo_redeem_atomic(p_code_id uuid, p_expected_uses integer, p_offer_id uuid, p_org_id uuid, p_code text, p_customer_id uuid, p_location_id text, p_order_id text, p_staff_id uuid, p_basket_value numeric, p_discount_value numeric, p_idempotency_key text) from public, anon, authenticated, service_role;
revoke all on function public.register_ops_device(p_name text) from public, anon, authenticated, service_role;
revoke all on function public.register_terminal_device(p_serial text, p_app_version text) from public, anon, authenticated, service_role;
revoke all on function public.register_waitlist_device(p_name text) from public, anon, authenticated, service_role;
revoke all on function public.release_terminal_jobs(p_terminal_id uuid, p_note text) from public, anon, authenticated, service_role;
revoke all on function public.resolve_terminal_job(p_job_id uuid, p_outcome text, p_note text) from public, anon, authenticated, service_role;
revoke all on function public.restore_stock(p_location_id text, p_item_id text, p_qty integer) from public, anon, authenticated, service_role;
revoke all on function public.retire_terminal_device(p_terminal_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid, p_notes text) from public, anon, authenticated, service_role;
revoke all on function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_terminal_bound_device(p_terminal_id uuid, p_bound_pos_device_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb, p_bound_pos_device_id uuid, p_modes jsonb, p_label text, p_idle_screen jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_usage_rates(p_location_id uuid, p_days integer) from public, anon, authenticated, service_role;
revoke all on function public.terminal_claim_job(p_job_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint) from public, anon, authenticated, service_role;
revoke all on function public.terminal_heartbeat(p_device_id uuid, p_app_version text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_job_cancel(p_job_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_job_sent(p_job_id uuid, p_transaction_id text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_job_settle_from_processor(p_job_id uuid, p_outcome text, p_payment_session_id text, p_transaction_id text, p_auth_code text, p_card jsonb, p_decline_reason text, p_source text, p_session_amount_minor bigint) from public, anon, authenticated, service_role;
revoke all on function public.terminal_jobs_sweep(p_limit integer) from public, anon, authenticated, service_role;
revoke all on function public.terminal_jobs_sweep_cron() from public, anon, authenticated, service_role;
revoke all on function public.terminal_open_tables() from public, anon, authenticated, service_role;
revoke all on function public.terminal_pos_close_session(p_location_id uuid, p_table_id text, p_session_id text, p_seated_at bigint, p_closed_check_id text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_pos_flag_stale(p_job_id uuid, p_note text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_pos_mark_reconciled(p_job_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.terminal_report_result(p_job_id uuid, p_status text, p_transaction_id text, p_auth_code text, p_card jsonb, p_reported_minor bigint, p_decline_reason text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_staff_login(p_pin text) from public, anon, authenticated, service_role;
revoke all on function public.terminal_start_table_payment(p_table_id text, p_staff_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.terminal_targets_for_pos(p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.tg_order_queue_notify() from public, anon, authenticated, service_role;
revoke all on function public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone) from public, anon, authenticated, service_role;
revoke all on function public.user_accessible_locations() from public, anon, authenticated, service_role;
revoke all on function public.user_accessible_orgs() from public, anon, authenticated, service_role;
revoke all on function public.waitlist_can_write(p_location_id uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_device_heartbeat() from public, anon, authenticated, service_role;
revoke all on function public.waitlist_pin_login(p_location_id uuid, p_pin text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_public_config(p_location uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text, p_zone text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_self_status(p_token text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_self_update(p_token text, p_action text) from public, anon, authenticated, service_role;
revoke all on function public.wf_block_finalized_tronc_delete() from public, anon, authenticated, service_role;
revoke all on function public.wf_touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.wl_band_id(p_size integer) from public, anon, authenticated, service_role;
revoke all on function public.wl_normalise_phone(p text) from public, anon, authenticated, service_role;
revoke all on function public.wl_touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.xero_nightly_post() from public, anon, authenticated, service_role;

-- 10c. table grants (484)
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.active_sessions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.active_sessions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.active_sessions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.activity_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.activity_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.activity_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.bar_tabs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.bar_tabs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.bar_tabs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_runs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_runs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_sends to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_sends to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaign_sends to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaigns to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaigns to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.campaigns to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_drawers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_drawers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_drawers to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_movements to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_movements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.cash_movements to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.catering_site_settings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.catering_site_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.catering_site_settings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.challenge_21_checks to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.challenge_21_checks to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.challenge_21_checks to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.closed_checks to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.closed_checks to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.closed_checks to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.config_pushes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.config_pushes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.config_pushes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.corrective_actions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.corrective_actions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.corrective_actions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.courier_deliveries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.courier_deliveries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.courier_deliveries to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_consents to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_consents to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_consents to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_locations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_locations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_locations to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_orders to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_orders to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_orders to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customer_rfm to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.customers to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.deliveries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.deliveries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.deliveries to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_costs_actual to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_costs_actual to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_costs_actual to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_quotes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_quotes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_quotes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_status_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_status_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_status_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_surcharges to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_surcharges to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.delivery_surcharges to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_heartbeats to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_heartbeats to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_heartbeats to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_profiles to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.device_profiles to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.devices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.devices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.devices to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discount_rules to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discount_rules to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discount_rules to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discounts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discounts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.discounts to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.drawer_sessions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.drawer_sessions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.drawer_sessions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.eighty_six to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.eighty_six to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.eighty_six to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.floor_tables to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.floor_tables to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.floor_tables to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_connections to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_connections to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_connections to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_oauth_pending to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_oauth_pending to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_oauth_pending to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_order_links to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_order_links to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.hubrise_order_links to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_item_conversions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_item_conversions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_item_conversions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_items to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_items to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.inventory_items to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_cost_history to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_cost_history to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_cost_history to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_packaging_formats to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_packaging_formats to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_packaging_formats to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_variants to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_variants to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.item_variants to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.kds_tickets to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.kds_tickets to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.kds_tickets to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.location_features to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.location_features to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.location_features to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.locations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.locations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.locations to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.loyalty_transactions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.loyalty_transactions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.loyalty_transactions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_notes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_notes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_notes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_requests to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_requests to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_requests to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_status_history to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_status_history to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.maintenance_status_history to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_messages to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_messages to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_messages to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_suppressions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_suppressions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.marketing_suppressions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_board_screens to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_board_screens to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_board_screens to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_boards to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_boards to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_boards to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_categories to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_categories to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_categories to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_category_links to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_category_links to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_category_links to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_item_recipes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_item_recipes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_item_recipes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_items to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_items to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menu_items to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menus to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menus to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.menus to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_groups to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_groups to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_groups to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_options to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_options to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.modifier_options to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.offers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.offers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.offers to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_alerts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_alerts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_alerts to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_audit to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_audit to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_audit to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_runs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_runs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_tasks to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_tasks to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklist_tasks to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklists to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklists to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_checklists to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_devices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_devices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_devices to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_notification_rules to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_notification_rules to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_notification_rules to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_task_completions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_task_completions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.ops_task_completions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_notifications to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_notifications to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_notifications to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_queue to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_queue to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.order_queue to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.org_sending_domains to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.org_sending_domains to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.org_sending_domains to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.organisations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.organisations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.organisations to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.par_levels to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.par_levels to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.par_levels to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.po_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.po_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.po_lines to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.pos_nudges to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.pos_nudges to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.pos_nudges to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_log to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_log to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_log to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_schedule to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_schedule to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.prep_schedule to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_jobs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_jobs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_jobs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_routing to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_routing to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.print_routing to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_agents to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_agents to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_agents to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_health to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_health to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printer_health to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.printers to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.production_batches to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.production_batches to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.production_batches to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_codes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_codes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_codes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_redemptions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_redemptions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.promo_redemptions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.purchase_orders to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.purchase_orders to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.purchase_orders to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.quote_accuracy to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.quote_accuracy to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.quote_accuracy to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.receipt_emails to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.receipt_emails to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.receipt_emails to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipe_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipe_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipe_lines to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.recipes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_feedback to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_feedback to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_feedback to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_google_tokens to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_google_tokens to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_google_tokens to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_oauth_pending to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_oauth_pending to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_oauth_pending to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_platform_links to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_platform_links to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_platform_links to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_replies to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_replies to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_replies to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_requests to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_requests to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_requests to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_settings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_settings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_themes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_themes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.review_themes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sections to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sections to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sections to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.segments to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.segments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.segments to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shifts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shifts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.shifts to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sms_messages to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sms_messages to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.sms_messages to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_auth_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_auth_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_auth_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_members to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_members to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.staff_members to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stamp_transactions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stamp_transactions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stamp_transactions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_count_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_count_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_count_lines to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_counts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_counts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_counts to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_levels to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_levels to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_levels to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_movements to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_movements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_movements to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_units to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_units to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.stock_units to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.subscriptions to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.subscriptions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.subscriptions to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoice_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoice_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoice_lines to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_invoices to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_products to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_products to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.supplier_products to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.suppliers to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.suppliers to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.suppliers to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.table_reservations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.table_reservations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.table_reservations to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.tax_rates to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.tax_rates to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.tax_rates to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_check_schedules to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_check_schedules to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_check_schedules to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_readings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_readings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_readings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_units to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_units to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.temp_units to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_devices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_devices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_devices to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_jobs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_jobs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.terminal_jobs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.turn_time_stats to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.turn_time_stats to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.turn_time_stats to service_role;
grant maintain, references, select, trigger on table public.user_locations to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_locations to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_locations to service_role;
grant maintain, references, select, trigger on table public.user_profiles to anon;
grant delete, insert, maintain, references, select, trigger, truncate on table public.user_profiles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.user_profiles to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.venue_uber_config to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.venue_uber_config to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.venue_uber_config to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_config to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_config to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_config to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_devices to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_devices to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_devices to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_entries to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_entries to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_entries to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_sms_inbound to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_sms_inbound to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_sms_inbound to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_status_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_status_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waitlist_status_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waste_events to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waste_events to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.waste_events to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_announcements to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_announcements to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_announcements to service_role;
grant insert, maintain, references, select, trigger on table public.wf_audit to anon;
grant insert, maintain, references, select, trigger on table public.wf_audit to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_audit to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_availability to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_availability to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_availability to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_doc_templates to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_doc_templates to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_doc_templates to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_documents to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_documents to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_documents to service_role;
grant insert, maintain, references, select, trigger on table public.wf_holiday_accrual to anon;
grant insert, maintain, references, select, trigger on table public.wf_holiday_accrual to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_holiday_accrual to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_onboarding to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_onboarding to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_onboarding to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_payroll_runs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_payroll_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_payroll_runs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_rate_changes to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_rate_changes to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_rate_changes to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_roles to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_roles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_roles to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sales_forecast to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sales_forecast to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sales_forecast to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sections to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sections to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_sections to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_shifts to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_shifts to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_shifts to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_staff to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_staff to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_staff to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_swap_requests to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_swap_requests to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_swap_requests to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_time_off to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_time_off to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_time_off to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_timesheets to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_timesheets to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_timesheets to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_lines to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_lines to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_lines to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_runs to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_runs to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_tronc_runs to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_user_roles to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_user_roles to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_user_roles to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_venue_settings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_venue_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wf_venue_settings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_captures to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_captures to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_captures to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_portal_settings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_portal_settings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_portal_settings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_unifi_bindings to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_unifi_bindings to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.wifi_unifi_bindings to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_enrollments to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_enrollments to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_enrollments to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_step_sends to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_step_sends to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflow_step_sends to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflows to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflows to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.workflows to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_config to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_config to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_config to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_connections to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_connections to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_connections to service_role;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_sync_log to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_sync_log to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.xero_sync_log to service_role;

-- 10d. column grants (4)
grant update (bo_access) on table public.user_profiles to authenticated;
grant update (full_name) on table public.user_profiles to authenticated;
grant update (location_id) on table public.user_profiles to authenticated;
grant update (org_id) on table public.user_profiles to authenticated;

-- 10e. function grants (294)
grant execute on function public._mb_user_has_location(p_loc uuid) to public;
grant execute on function public._mb_user_has_location(p_loc uuid) to anon;
grant execute on function public._mb_user_has_location(p_loc uuid) to authenticated;
grant execute on function public._mb_user_has_location(p_loc uuid) to service_role;
grant execute on function public._terminal_for_caller() to anon;
grant execute on function public._terminal_for_caller() to authenticated;
grant execute on function public._terminal_for_caller() to service_role;
grant execute on function public._terminal_gen_code() to anon;
grant execute on function public._terminal_gen_code() to authenticated;
grant execute on function public._terminal_gen_code() to service_role;
grant execute on function public._terminal_is_service_role() to anon;
grant execute on function public._terminal_is_service_role() to authenticated;
grant execute on function public._terminal_is_service_role() to service_role;
grant execute on function public._terminal_norm_idle_screen(p jsonb) to anon;
grant execute on function public._terminal_norm_idle_screen(p jsonb) to authenticated;
grant execute on function public._terminal_norm_idle_screen(p jsonb) to service_role;
grant execute on function public._terminal_norm_modes(p jsonb) to anon;
grant execute on function public._terminal_norm_modes(p jsonb) to authenticated;
grant execute on function public._terminal_norm_modes(p jsonb) to service_role;
grant execute on function public._terminal_norm_tip_config(p jsonb) to anon;
grant execute on function public._terminal_norm_tip_config(p jsonb) to authenticated;
grant execute on function public._terminal_norm_tip_config(p jsonb) to service_role;
grant execute on function public._terminal_user_has_location(p_loc uuid) to anon;
grant execute on function public._terminal_user_has_location(p_loc uuid) to authenticated;
grant execute on function public._terminal_user_has_location(p_loc uuid) to service_role;
grant execute on function public._touch_updated_at() to public;
grant execute on function public._touch_updated_at() to anon;
grant execute on function public._touch_updated_at() to authenticated;
grant execute on function public._touch_updated_at() to service_role;
grant execute on function public._wl_self_open(p_location uuid) to anon;
grant execute on function public._wl_self_open(p_location uuid) to authenticated;
grant execute on function public._wl_self_open(p_location uuid) to service_role;
grant execute on function public.apply_due_wf_rate_changes() to anon;
grant execute on function public.apply_due_wf_rate_changes() to authenticated;
grant execute on function public.apply_due_wf_rate_changes() to service_role;
grant execute on function public.call_edge_fn(fn text, body jsonb) to service_role;
grant execute on function public.can_claim_location(p_location_id uuid) to authenticated;
grant execute on function public.can_claim_location(p_location_id uuid) to service_role;
grant execute on function public.catering_public_settings(p_location uuid) to public;
grant execute on function public.catering_public_settings(p_location uuid) to anon;
grant execute on function public.catering_public_settings(p_location uuid) to authenticated;
grant execute on function public.catering_public_settings(p_location uuid) to service_role;
grant execute on function public.claim_device(p_code text) to public;
grant execute on function public.claim_device(p_code text) to anon;
grant execute on function public.claim_device(p_code text) to authenticated;
grant execute on function public.claim_device(p_code text) to service_role;
grant execute on function public.claim_menu_board_screen(p_code text, p_board_id uuid) to public;
grant execute on function public.claim_menu_board_screen(p_code text, p_board_id uuid) to anon;
grant execute on function public.claim_menu_board_screen(p_code text, p_board_id uuid) to authenticated;
grant execute on function public.claim_menu_board_screen(p_code text, p_board_id uuid) to service_role;
grant execute on function public.claim_ops_device(p_code text, p_location_id uuid) to public;
grant execute on function public.claim_ops_device(p_code text, p_location_id uuid) to anon;
grant execute on function public.claim_ops_device(p_code text, p_location_id uuid) to authenticated;
grant execute on function public.claim_ops_device(p_code text, p_location_id uuid) to service_role;
grant execute on function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text) to anon;
grant execute on function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text) to authenticated;
grant execute on function public.claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text) to service_role;
grant execute on function public.claim_waitlist_device(p_code text, p_location_id uuid) to public;
grant execute on function public.claim_waitlist_device(p_code text, p_location_id uuid) to anon;
grant execute on function public.claim_waitlist_device(p_code text, p_location_id uuid) to authenticated;
grant execute on function public.claim_waitlist_device(p_code text, p_location_id uuid) to service_role;
grant execute on function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer) to public;
grant execute on function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer) to anon;
grant execute on function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer) to authenticated;
grant execute on function public.decrement_stock(p_location_id text, p_item_id text, p_qty integer) to service_role;
grant execute on function public.edge_base_url() to service_role;
grant execute on function public.get_plan_for_gmv(gmv numeric) to public;
grant execute on function public.get_plan_for_gmv(gmv numeric) to anon;
grant execute on function public.get_plan_for_gmv(gmv numeric) to authenticated;
grant execute on function public.get_plan_for_gmv(gmv numeric) to service_role;
grant execute on function public.handle_new_user() to public;
grant execute on function public.handle_new_user() to anon;
grant execute on function public.handle_new_user() to authenticated;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.is_anon_session() to public;
grant execute on function public.is_anon_session() to anon;
grant execute on function public.is_anon_session() to authenticated;
grant execute on function public.is_anon_session() to service_role;
grant execute on function public.is_super_admin() to public;
grant execute on function public.is_super_admin() to anon;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.is_super_admin() to service_role;
grant execute on function public.log_order_activity() to public;
grant execute on function public.log_order_activity() to anon;
grant execute on function public.log_order_activity() to authenticated;
grant execute on function public.log_order_activity() to service_role;
grant execute on function public.marketing_ab_report(p_org uuid, p_campaign uuid) to public;
grant execute on function public.marketing_ab_report(p_org uuid, p_campaign uuid) to service_role;
grant execute on function public.marketing_period_sales(p_org uuid, p_start timestamp with time zone, p_end timestamp with time zone) to public;
grant execute on function public.marketing_period_sales(p_org uuid, p_start timestamp with time zone, p_end timestamp with time zone) to service_role;
grant execute on function public.marketing_report(p_org uuid, p_since timestamp with time zone) to public;
grant execute on function public.marketing_report(p_org uuid, p_since timestamp with time zone) to service_role;
grant execute on function public.marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit integer) to public;
grant execute on function public.marketing_resolve_segment(p_org uuid, p_def jsonb, p_limit integer) to service_role;
grant execute on function public.marketing_set_active_domain(p_org uuid, p_id uuid, p_active boolean) to public;
grant execute on function public.marketing_set_active_domain(p_org uuid, p_id uuid, p_active boolean) to service_role;
grant execute on function public.mb_screen_heartbeat(p_id uuid) to public;
grant execute on function public.mb_screen_heartbeat(p_id uuid) to anon;
grant execute on function public.mb_screen_heartbeat(p_id uuid) to authenticated;
grant execute on function public.mb_screen_heartbeat(p_id uuid) to service_role;
grant execute on function public.ops_ack_alert(p_alert_id uuid, p_action text, p_user_name text) to public;
grant execute on function public.ops_ack_alert(p_alert_id uuid, p_action text, p_user_name text) to anon;
grant execute on function public.ops_ack_alert(p_alert_id uuid, p_action text, p_user_name text) to authenticated;
grant execute on function public.ops_ack_alert(p_alert_id uuid, p_action text, p_user_name text) to service_role;
grant execute on function public.ops_can_write(p_location_id uuid) to public;
grant execute on function public.ops_can_write(p_location_id uuid) to anon;
grant execute on function public.ops_can_write(p_location_id uuid) to authenticated;
grant execute on function public.ops_can_write(p_location_id uuid) to service_role;
grant execute on function public.ops_device_heartbeat() to public;
grant execute on function public.ops_device_heartbeat() to anon;
grant execute on function public.ops_device_heartbeat() to authenticated;
grant execute on function public.ops_device_heartbeat() to service_role;
grant execute on function public.ops_pin_login(p_location_id uuid, p_pin text) to public;
grant execute on function public.ops_pin_login(p_location_id uuid, p_pin text) to anon;
grant execute on function public.ops_pin_login(p_location_id uuid, p_pin text) to authenticated;
grant execute on function public.ops_pin_login(p_location_id uuid, p_pin text) to service_role;
grant execute on function public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid, p_operator_id uuid, p_operator_name text, p_source text, p_notes text, p_corrective_action text, p_corrective_desc text, p_delivery_id uuid) to public;
grant execute on function public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid, p_operator_id uuid, p_operator_name text, p_source text, p_notes text, p_corrective_action text, p_corrective_desc text, p_delivery_id uuid) to anon;
grant execute on function public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid, p_operator_id uuid, p_operator_name text, p_source text, p_notes text, p_corrective_action text, p_corrective_desc text, p_delivery_id uuid) to authenticated;
grant execute on function public.ops_submit_reading(p_location_id uuid, p_unit_id uuid, p_reading_c numeric, p_schedule_id uuid, p_operator_id uuid, p_operator_name text, p_source text, p_notes text, p_corrective_action text, p_corrective_desc text, p_delivery_id uuid) to service_role;
grant execute on function public.pos_can_access(p_loc text) to public;
grant execute on function public.pos_can_access(p_loc text) to anon;
grant execute on function public.pos_can_access(p_loc text) to authenticated;
grant execute on function public.pos_can_access(p_loc text) to service_role;
grant execute on function public.pos_can_access(p_loc uuid) to public;
grant execute on function public.pos_can_access(p_loc uuid) to anon;
grant execute on function public.pos_can_access(p_loc uuid) to authenticated;
grant execute on function public.pos_can_access(p_loc uuid) to service_role;
grant execute on function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric, p_source_type text, p_source_id text, p_idempotency_key text, p_occurred_at timestamp with time zone, p_created_by uuid, p_notes text) to public;
grant execute on function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric, p_source_type text, p_source_id text, p_idempotency_key text, p_occurred_at timestamp with time zone, p_created_by uuid, p_notes text) to anon;
grant execute on function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric, p_source_type text, p_source_id text, p_idempotency_key text, p_occurred_at timestamp with time zone, p_created_by uuid, p_notes text) to authenticated;
grant execute on function public.post_stock_movement(p_location_id uuid, p_inventory_item_id uuid, p_qty_base numeric, p_movement_type text, p_unit_cost numeric, p_source_type text, p_source_id text, p_idempotency_key text, p_occurred_at timestamp with time zone, p_created_by uuid, p_notes text) to service_role;
grant execute on function public.promo_redeem_atomic(p_code_id uuid, p_expected_uses integer, p_offer_id uuid, p_org_id uuid, p_code text, p_customer_id uuid, p_location_id text, p_order_id text, p_staff_id uuid, p_basket_value numeric, p_discount_value numeric, p_idempotency_key text) to service_role;
grant execute on function public.register_ops_device(p_name text) to public;
grant execute on function public.register_ops_device(p_name text) to anon;
grant execute on function public.register_ops_device(p_name text) to authenticated;
grant execute on function public.register_ops_device(p_name text) to service_role;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to anon;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to authenticated;
grant execute on function public.register_terminal_device(p_serial text, p_app_version text) to service_role;
grant execute on function public.register_waitlist_device(p_name text) to public;
grant execute on function public.register_waitlist_device(p_name text) to anon;
grant execute on function public.register_waitlist_device(p_name text) to authenticated;
grant execute on function public.register_waitlist_device(p_name text) to service_role;
grant execute on function public.release_terminal_jobs(p_terminal_id uuid, p_note text) to anon;
grant execute on function public.release_terminal_jobs(p_terminal_id uuid, p_note text) to authenticated;
grant execute on function public.release_terminal_jobs(p_terminal_id uuid, p_note text) to service_role;
grant execute on function public.resolve_terminal_job(p_job_id uuid, p_outcome text, p_note text) to anon;
grant execute on function public.resolve_terminal_job(p_job_id uuid, p_outcome text, p_note text) to authenticated;
grant execute on function public.resolve_terminal_job(p_job_id uuid, p_outcome text, p_note text) to service_role;
grant execute on function public.restore_stock(p_location_id text, p_item_id text, p_qty integer) to public;
grant execute on function public.restore_stock(p_location_id text, p_item_id text, p_qty integer) to anon;
grant execute on function public.restore_stock(p_location_id text, p_item_id text, p_qty integer) to authenticated;
grant execute on function public.restore_stock(p_location_id text, p_item_id text, p_qty integer) to service_role;
grant execute on function public.retire_terminal_device(p_terminal_id uuid) to anon;
grant execute on function public.retire_terminal_device(p_terminal_id uuid) to authenticated;
grant execute on function public.retire_terminal_device(p_terminal_id uuid) to service_role;
grant execute on function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid, p_notes text) to public;
grant execute on function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid, p_notes text) to anon;
grant execute on function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid, p_notes text) to authenticated;
grant execute on function public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid, p_notes text) to service_role;
grant execute on function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid) to public;
grant execute on function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid) to anon;
grant execute on function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid) to authenticated;
grant execute on function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid) to service_role;
grant execute on function public.set_terminal_bound_device(p_terminal_id uuid, p_bound_pos_device_id uuid) to anon;
grant execute on function public.set_terminal_bound_device(p_terminal_id uuid, p_bound_pos_device_id uuid) to authenticated;
grant execute on function public.set_terminal_bound_device(p_terminal_id uuid, p_bound_pos_device_id uuid) to service_role;
grant execute on function public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb, p_bound_pos_device_id uuid, p_modes jsonb, p_label text, p_idle_screen jsonb) to anon;
grant execute on function public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb, p_bound_pos_device_id uuid, p_modes jsonb, p_label text, p_idle_screen jsonb) to authenticated;
grant execute on function public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb, p_bound_pos_device_id uuid, p_modes jsonb, p_label text, p_idle_screen jsonb) to service_role;
grant execute on function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer) to public;
grant execute on function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer) to anon;
grant execute on function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer) to authenticated;
grant execute on function public.stock_usage_by_weekday(p_location_id uuid, p_weeks integer) to service_role;
grant execute on function public.stock_usage_rates(p_location_id uuid, p_days integer) to public;
grant execute on function public.stock_usage_rates(p_location_id uuid, p_days integer) to anon;
grant execute on function public.stock_usage_rates(p_location_id uuid, p_days integer) to authenticated;
grant execute on function public.stock_usage_rates(p_location_id uuid, p_days integer) to service_role;
grant execute on function public.terminal_claim_job(p_job_id uuid) to anon;
grant execute on function public.terminal_claim_job(p_job_id uuid) to authenticated;
grant execute on function public.terminal_claim_job(p_job_id uuid) to service_role;
grant execute on function public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint) to anon;
grant execute on function public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint) to authenticated;
grant execute on function public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint) to service_role;
grant execute on function public.terminal_heartbeat(p_device_id uuid, p_app_version text) to anon;
grant execute on function public.terminal_heartbeat(p_device_id uuid, p_app_version text) to authenticated;
grant execute on function public.terminal_heartbeat(p_device_id uuid, p_app_version text) to service_role;
grant execute on function public.terminal_job_cancel(p_job_id uuid) to anon;
grant execute on function public.terminal_job_cancel(p_job_id uuid) to authenticated;
grant execute on function public.terminal_job_cancel(p_job_id uuid) to service_role;
grant execute on function public.terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text) to anon;
grant execute on function public.terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text) to authenticated;
grant execute on function public.terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text) to service_role;
grant execute on function public.terminal_job_sent(p_job_id uuid, p_transaction_id text) to anon;
grant execute on function public.terminal_job_sent(p_job_id uuid, p_transaction_id text) to authenticated;
grant execute on function public.terminal_job_sent(p_job_id uuid, p_transaction_id text) to service_role;
grant execute on function public.terminal_job_settle_from_processor(p_job_id uuid, p_outcome text, p_payment_session_id text, p_transaction_id text, p_auth_code text, p_card jsonb, p_decline_reason text, p_source text, p_session_amount_minor bigint) to anon;
grant execute on function public.terminal_job_settle_from_processor(p_job_id uuid, p_outcome text, p_payment_session_id text, p_transaction_id text, p_auth_code text, p_card jsonb, p_decline_reason text, p_source text, p_session_amount_minor bigint) to authenticated;
grant execute on function public.terminal_job_settle_from_processor(p_job_id uuid, p_outcome text, p_payment_session_id text, p_transaction_id text, p_auth_code text, p_card jsonb, p_decline_reason text, p_source text, p_session_amount_minor bigint) to service_role;
grant execute on function public.terminal_jobs_sweep(p_limit integer) to anon;
grant execute on function public.terminal_jobs_sweep(p_limit integer) to authenticated;
grant execute on function public.terminal_jobs_sweep(p_limit integer) to service_role;
grant execute on function public.terminal_jobs_sweep_cron() to service_role;
grant execute on function public.terminal_open_tables() to anon;
grant execute on function public.terminal_open_tables() to authenticated;
grant execute on function public.terminal_open_tables() to service_role;
grant execute on function public.terminal_pos_close_session(p_location_id uuid, p_table_id text, p_session_id text, p_seated_at bigint, p_closed_check_id text) to anon;
grant execute on function public.terminal_pos_close_session(p_location_id uuid, p_table_id text, p_session_id text, p_seated_at bigint, p_closed_check_id text) to authenticated;
grant execute on function public.terminal_pos_close_session(p_location_id uuid, p_table_id text, p_session_id text, p_seated_at bigint, p_closed_check_id text) to service_role;
grant execute on function public.terminal_pos_flag_stale(p_job_id uuid, p_note text) to anon;
grant execute on function public.terminal_pos_flag_stale(p_job_id uuid, p_note text) to authenticated;
grant execute on function public.terminal_pos_flag_stale(p_job_id uuid, p_note text) to service_role;
grant execute on function public.terminal_pos_mark_reconciled(p_job_id uuid) to anon;
grant execute on function public.terminal_pos_mark_reconciled(p_job_id uuid) to authenticated;
grant execute on function public.terminal_pos_mark_reconciled(p_job_id uuid) to service_role;
grant execute on function public.terminal_report_result(p_job_id uuid, p_status text, p_transaction_id text, p_auth_code text, p_card jsonb, p_reported_minor bigint, p_decline_reason text) to anon;
grant execute on function public.terminal_report_result(p_job_id uuid, p_status text, p_transaction_id text, p_auth_code text, p_card jsonb, p_reported_minor bigint, p_decline_reason text) to authenticated;
grant execute on function public.terminal_report_result(p_job_id uuid, p_status text, p_transaction_id text, p_auth_code text, p_card jsonb, p_reported_minor bigint, p_decline_reason text) to service_role;
grant execute on function public.terminal_staff_login(p_pin text) to anon;
grant execute on function public.terminal_staff_login(p_pin text) to authenticated;
grant execute on function public.terminal_staff_login(p_pin text) to service_role;
grant execute on function public.terminal_start_table_payment(p_table_id text, p_staff_id uuid) to anon;
grant execute on function public.terminal_start_table_payment(p_table_id text, p_staff_id uuid) to authenticated;
grant execute on function public.terminal_start_table_payment(p_table_id text, p_staff_id uuid) to service_role;
grant execute on function public.terminal_targets_for_pos(p_location_id uuid) to public;
grant execute on function public.terminal_targets_for_pos(p_location_id uuid) to anon;
grant execute on function public.terminal_targets_for_pos(p_location_id uuid) to authenticated;
grant execute on function public.terminal_targets_for_pos(p_location_id uuid) to service_role;
grant execute on function public.tg_order_queue_notify() to public;
grant execute on function public.tg_order_queue_notify() to anon;
grant execute on function public.tg_order_queue_notify() to authenticated;
grant execute on function public.tg_order_queue_notify() to service_role;
grant execute on function public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone) to public;
grant execute on function public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone) to anon;
grant execute on function public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone) to authenticated;
grant execute on function public.upsert_customer_visit(p_customer_id uuid, p_location_id uuid, p_revenue numeric, p_visit_at timestamp with time zone) to service_role;
grant execute on function public.user_accessible_locations() to public;
grant execute on function public.user_accessible_locations() to anon;
grant execute on function public.user_accessible_locations() to authenticated;
grant execute on function public.user_accessible_locations() to service_role;
grant execute on function public.user_accessible_orgs() to public;
grant execute on function public.user_accessible_orgs() to anon;
grant execute on function public.user_accessible_orgs() to authenticated;
grant execute on function public.user_accessible_orgs() to service_role;
grant execute on function public.waitlist_can_write(p_location_id uuid) to public;
grant execute on function public.waitlist_can_write(p_location_id uuid) to anon;
grant execute on function public.waitlist_can_write(p_location_id uuid) to authenticated;
grant execute on function public.waitlist_can_write(p_location_id uuid) to service_role;
grant execute on function public.waitlist_device_heartbeat() to public;
grant execute on function public.waitlist_device_heartbeat() to anon;
grant execute on function public.waitlist_device_heartbeat() to authenticated;
grant execute on function public.waitlist_device_heartbeat() to service_role;
grant execute on function public.waitlist_pin_login(p_location_id uuid, p_pin text) to public;
grant execute on function public.waitlist_pin_login(p_location_id uuid, p_pin text) to anon;
grant execute on function public.waitlist_pin_login(p_location_id uuid, p_pin text) to authenticated;
grant execute on function public.waitlist_pin_login(p_location_id uuid, p_pin text) to service_role;
grant execute on function public.waitlist_public_config(p_location uuid) to public;
grant execute on function public.waitlist_public_config(p_location uuid) to anon;
grant execute on function public.waitlist_public_config(p_location uuid) to authenticated;
grant execute on function public.waitlist_public_config(p_location uuid) to service_role;
grant execute on function public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text, p_zone text) to public;
grant execute on function public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text, p_zone text) to anon;
grant execute on function public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text, p_zone text) to authenticated;
grant execute on function public.waitlist_self_join(p_location uuid, p_name text, p_phone text, p_size integer, p_notes text, p_zone text) to service_role;
grant execute on function public.waitlist_self_status(p_token text) to public;
grant execute on function public.waitlist_self_status(p_token text) to anon;
grant execute on function public.waitlist_self_status(p_token text) to authenticated;
grant execute on function public.waitlist_self_status(p_token text) to service_role;
grant execute on function public.waitlist_self_update(p_token text, p_action text) to public;
grant execute on function public.waitlist_self_update(p_token text, p_action text) to anon;
grant execute on function public.waitlist_self_update(p_token text, p_action text) to authenticated;
grant execute on function public.waitlist_self_update(p_token text, p_action text) to service_role;
grant execute on function public.wf_block_finalized_tronc_delete() to public;
grant execute on function public.wf_block_finalized_tronc_delete() to anon;
grant execute on function public.wf_block_finalized_tronc_delete() to authenticated;
grant execute on function public.wf_block_finalized_tronc_delete() to service_role;
grant execute on function public.wf_touch_updated_at() to public;
grant execute on function public.wf_touch_updated_at() to anon;
grant execute on function public.wf_touch_updated_at() to authenticated;
grant execute on function public.wf_touch_updated_at() to service_role;
grant execute on function public.wl_band_id(p_size integer) to public;
grant execute on function public.wl_band_id(p_size integer) to anon;
grant execute on function public.wl_band_id(p_size integer) to authenticated;
grant execute on function public.wl_band_id(p_size integer) to service_role;
grant execute on function public.wl_normalise_phone(p text) to public;
grant execute on function public.wl_normalise_phone(p text) to anon;
grant execute on function public.wl_normalise_phone(p text) to authenticated;
grant execute on function public.wl_normalise_phone(p text) to service_role;
grant execute on function public.wl_touch_updated_at() to public;
grant execute on function public.wl_touch_updated_at() to anon;
grant execute on function public.wl_touch_updated_at() to authenticated;
grant execute on function public.wl_touch_updated_at() to service_role;
grant execute on function public.xero_nightly_post() to service_role;

-- --------------------------------------------------------------------------
-- 11. COMMENTS  (46)
-- Table, column and function comments carried over so the intent written
-- into the live database is not lost on a rebuild.
-- --------------------------------------------------------------------------

comment on table public.menu_category_links is 'Join table: a category can appear in many menus. v4.6.0 adds this; existing menu_categories.menu_id stays as the primary linkage. v4.6.3 will start populating this from the new Menus tab UI.';
comment on table public.sms_messages is 'Audit log for all outbound SMS messages sent via Twilio';
comment on table public.stock_levels is 'v5.5.239: per-item stock counts, synced across all devices via realtime';
comment on table public.wf_audit is 'Append-only, tamper-evident audit log. prev_hash/row_hash form a chain; UPDATE/DELETE denied to client roles.';
comment on table public.wf_holiday_accrual is 'Append-only holiday-accrual ledger (12.07% default). Balance = sum of signed accrued_hours; corrections are adjustment rows, never edits.';
comment on column public.closed_checks.customer_phone is 'Captured at kiosk loyalty step. Used for SMS receipt + order-ready notification.';
comment on column public.closed_checks.kiosk_id is 'devices.id of the kiosk that placed the order, when source=kiosk.';
comment on column public.closed_checks.kiosk_table_number is 'Table number entered or dispensed at kiosk. Differs from table_id which is the real table FK.';
comment on column public.closed_checks.payment_intents is 'Array of card PaymentIntents captured for this check: [{id, amountMinor}]. Populated for single-card, bar-tab, and each card portion of a split. Drives auto-refund to original card(s).';
comment on column public.closed_checks.source is 'Where the order originated (pos/kiosk/online/mobile). Used for reporting & kiosk POS toast.';
comment on column public.closed_checks.staff_id is 'FK to staff_members. Populated from v4.6.19. NULL for pre-v4.6.19 rows; tip pool falls back to staff name match.';
comment on column public.closed_checks.tax_amount is 'Tax charged on this check, stored at close time. NULL for pre-v4.6.19 rows; reports fall back to total-subtotal-service-tip derivation.';
comment on column public.courier_deliveries.eta is 'Expected DROPOFF time (Stuart eta.dropoff). pickup_eta holds the expected collection. v5.5.680';
comment on column public.device_profiles.kiosk_avg_wait_minutes is 'Operator-set average wait time. Shown on attract & done.';
comment on column public.device_profiles.kiosk_banners is 'Per-screen banners. Format: [{ screen, imageUrl, durationMs }]';
comment on column public.device_profiles.kiosk_brand_accent_color is 'Secondary brand color for highlights and active states.';
comment on column public.device_profiles.kiosk_brand_bg_color is 'Background base color. Null = default dark.';
comment on column public.device_profiles.kiosk_brand_name is 'Display name on kiosk attract screen. Falls back to location name if null.';
comment on column public.device_profiles.kiosk_label_add_to_order is 'Override for item-detail CTA. Default: Add to order.';
comment on column public.device_profiles.kiosk_label_place_order is 'Override for the loyalty-screen final CTA. Default: Place order.';
comment on column public.device_profiles.kiosk_label_tap_to_order is 'Override for the attract-screen CTA. Default: TAP TO ORDER.';
comment on column public.device_profiles.kiosk_table_mode is 'enter = customer enters table number, dispense = kiosk gives them a number to take, either = customer chooses, none = takeaway only';
comment on column public.device_profiles.kiosk_theme_mode is 'dark or light. Drives kiosk surface foreground/background palette.';
comment on column public.device_profiles.kiosk_tip_presets is 'Array of percentages for tip buttons. e.g. [10, 12.5, 15]';
comment on column public.device_profiles.training_mode is 'When true, terminals on this profile run in Training Mode: POS behaves normally but no orders, payments, stock, loyalty, prints or receipts are committed. v5.5.645.';
comment on column public.menu_items.lock_pricing is 'Master-only flag. If true on a shared/global item, child locations cannot create override rows that change pricing.';
comment on column public.menu_items.locked_fields is 'Master-only. Array of field names that cannot be overridden, e.g. ["pricing","name"]. Granular alternative to lock_pricing.';
comment on column public.menu_items.master_id is 'Required when scope=override. Points at the parent shared/global item this row overrides.';
comment on column public.menu_items.org_id is 'Required when scope IN (shared, global). Null for local items.';
comment on column public.menu_items.scope is 'Ownership: local|shared|global|override. local=this location only. shared=visible to all locations in org, each can override. global=managed centrally, locations cannot override. override=child row pointing at master_id, holds per-location field overrides.';
comment on column public.menus.priority is 'When two scheduled menus overlap, higher priority wins. Default 0.';
comment on column public.menus.schedule is 'Optional jsonb: { "monday": [{"from":"09:00","to":"22:00"}], "tuesday": [...], ... } 24h local time. Null = always active.';
comment on column public.recipe_lines.order_types is 'Order types this line applies to (jsonb array of dine-in|takeaway|collection|delivery). NULL/[] = all order types (shared base recipe).';
comment on column public.review_platform_links.last_attempt_at is 'Stamped by review-sync BEFORE each attempt, success or failure. sync_all orders its queue on coalesce(last_attempt_at, last_synced_at) so a failing venue rotates to the back instead of pinning the front of every run. Distinct from last_synced_at, which remains the last SUCCESSFUL sync and is what the Back Office displays.';
comment on column public.staff_members.auth_method is 'Enforced sign-in method: pin | card | fingerprint. Card-staff are refused PIN (manager override aside). v5.5.688';
comment on column public.staff_members.nfc_card_id is 'NFC card/fob UID (uppercase hex, no separators) for tap-to-sign-in. Non-secret. v5.5.686';
comment on column public.terminal_devices.idle_screen is 'Cached venue screensaver for the PAX home screen: {"enabled":bool,"imageUrl":text}. Source of truth is location_reader_settings in the Platform DB; Back Office mirrors it here because Ops SQL and the terminal cannot reach that project.';
comment on column public.terminal_devices.modes is 'Which home-screen modes this terminal offers: {"table_pay":bool,"manual":bool,"pos_dispatch":bool}. NULL = all enabled.';
comment on column public.venue_uber_config.delivery_mode is 'self = fires to POS, venue delivers (no courier); uber = quote + dispatch a courier. v5.5.652';
comment on column public.venue_uber_config.stuart_client_secret is 'Per-location Stuart API client secret. SERVICE-ROLE ONLY; never returned to the browser by the uber-direct edge fn (get_config returns only stuart_connected). v5.5.669';
comment on column public.venue_uber_config.stuart_env is 'Stuart account environment (sandbox|prod) for THIS venue, independent of the legacy Uber `env`. v5.5.671';
comment on column public.wf_staff.bank_account_masked is 'Masked only (regex-enforced). Full account numbers must never be stored here.';
comment on column public.wf_tronc_runs.residual is 'pool − total_paid. Largest-remainder rounding in compute must drive this to 0.00.';
comment on function public.call_edge_fn(fn text, body jsonb) is 'pg_cron -> edge function bridge. Holds no secrets itself; reads the bearer from vault at call time. Never grant to anon/authenticated.';
comment on function public.edge_base_url() is 'Base URL for pg_cron -> edge function calls. vault(edge_base_url) wins; the hardcoded fallback applies only on the original dev cluster, so a restored/staging DB fails loudly instead of driving production.';
comment on function public.terminal_jobs_sweep_cron() is 'pg_cron entry point for terminal_jobs_sweep(). Sets the service_role claim transaction-locally so the sweep''s own fence passes. Revoked from anon/authenticated ‚Äî this is the only caller permitted to bypass that guard.';

commit;

-- ============================================================================
-- END OF BASELINE
--
-- Verify a restore matched, from any psql session:
--
--   select 'tables' k, count(*) from pg_class c join pg_namespace n
--     on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r'
--   union all select 'policies', count(*) from pg_policies where schemaname='public'
--   union all select 'functions', count(*) from pg_proc p join pg_namespace n
--     on n.oid = p.pronamespace where n.nspname='public'
--   union all select 'triggers', count(*) from pg_trigger t join pg_class c
--     on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname='public' and not t.tgisinternal;
--
-- Expected on ops as of 2026-08-05:
--   tables 161   policies 293   functions 88   triggers 23
-- ============================================================================
