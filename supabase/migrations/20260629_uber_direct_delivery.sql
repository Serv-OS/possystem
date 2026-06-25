-- 20260629_uber_direct_delivery.sql — ServOS ⇄ Uber Direct delivery (Ops DB)
-- Address-based delivery quoting + surcharging + dispatch/tracking + reconciliation.
--
-- Posture (mirrors hubrise_*): every table is SERVICE-ROLE ONLY — RLS enabled with
-- NO policies, so no anon/authenticated client reads them directly. The POS/online/BO
-- reach this data through the `uber-direct` edge function (service role), which holds
-- the Uber OAuth creds in env and never returns secrets to the browser. venue_uber_config
-- holds NO secret (client_id/secret + webhook key are env vars) — only non-secret per-venue
-- policy/config, still gated behind the edge fn for a single authoritative path.
--
-- Reversible: a paired DROP block at the bottom (commented) documents the rollback.

-- 1) Per-venue Uber Direct config (non-secret). Creds live in edge-fn env.
create table if not exists venue_uber_config (
  location_id        text primary key,                 -- ops location id
  company_id         uuid,
  enabled            boolean not null default false,    -- master switch for this venue
  uber_customer_id   text,                              -- Uber org UUID (path-scoping; not a secret)
  pickup_address     jsonb,                             -- { line1, line2, city, postcode, country, lat, lng }
  pickup_contact     jsonb,                             -- { name, phone, instructions }
  radius_miles       numeric not null default 3,
  dispatch_backend   text not null default 'uber_api'
                       check (dispatch_backend in ('uber_api','hubrise_bridge')),
  surcharge_policy   jsonb not null default '{"mode":"pass_through"}'::jsonb,
  fallback_fee_minor integer,                            -- optional estimated fee if Uber is unreachable (flagged)
  sms_tracking       boolean not null default true,      -- text the customer a tracking link
  env                text not null default 'sandbox'
                       check (env in ('sandbox','prod')),
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);
alter table venue_uber_config enable row level security;
-- (no policies → service role only)

-- 2) Every quote we fetch (for surcharge source + reconciliation). order_ref is set once
--    the quote is attached to a confirmed order; null while still a pre-order estimate.
create table if not exists delivery_quotes (
  id               uuid primary key default gen_random_uuid(),
  location_id      text not null,
  order_ref        text,
  quote_id         text,                                 -- Uber estimate_id / quote id
  dropoff_address  jsonb,
  dropoff_lat      numeric,
  dropoff_lng      numeric,
  distance_miles   numeric,
  within_radius    boolean,
  uber_fee_minor   integer,                              -- true cost (pennies)
  currency         text not null default 'GBP',
  eta_minutes      integer,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);
alter table delivery_quotes enable row level security;
create index if not exists delivery_quotes_loc_idx on delivery_quotes (location_id, created_at desc);
create index if not exists delivery_quotes_ref_idx on delivery_quotes (order_ref);

-- 3) What the customer was charged vs what it actually cost (honest margin).
create table if not exists delivery_surcharges (
  id                 uuid primary key default gen_random_uuid(),
  location_id        text not null,
  order_ref          text,
  quote_id           text,
  customer_fee_minor integer not null default 0,         -- what the customer paid
  true_cost_minor    integer not null default 0,         -- what Uber charges the merchant
  margin_minor       integer not null default 0,         -- customer_fee - true_cost (can be negative)
  policy_applied     text,
  currency           text not null default 'GBP',
  created_at         timestamptz not null default now()
);
alter table delivery_surcharges enable row level security;
create index if not exists delivery_surcharges_loc_idx on delivery_surcharges (location_id, created_at desc);
create index if not exists delivery_surcharges_ref_idx on delivery_surcharges (order_ref);

-- 4) Dispatched deliveries + live tracking state.
create table if not exists deliveries (
  id                uuid primary key default gen_random_uuid(),
  location_id       text not null,
  order_ref         text,
  dispatch_backend  text not null default 'uber_api'
                      check (dispatch_backend in ('uber_api','hubrise_bridge')),
  uber_delivery_id  text,                                -- Uber order/delivery id
  hubrise_ref       text,                                -- when dispatched via the HubRise Bridge
  status            text not null default 'pending',     -- pending|pickup|dropoff|delivered|canceled|returned (ServOS lifecycle)
  tracking_url      text,
  courier_name      text,
  courier_phone     text,
  last_lat          numeric,
  last_lng          numeric,
  eta               timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table deliveries enable row level security;
create index if not exists deliveries_loc_idx on deliveries (location_id, created_at desc);
create unique index if not exists deliveries_uber_id_idx on deliveries (uber_delivery_id) where uber_delivery_id is not null;

-- 5) Webhook audit + idempotency. event_id UNIQUE is what makes at-least-once safe.
create table if not exists delivery_status_events (
  event_id     text primary key,
  delivery_id  uuid,
  location_id  text,
  status       text,
  payload      jsonb,
  received_at  timestamptz not null default now()
);
alter table delivery_status_events enable row level security;

-- 6) Actual Uber charges per delivery (reconciliation vs surcharged).
create table if not exists delivery_costs_actual (
  delivery_id      uuid primary key references deliveries(id) on delete cascade,
  location_id      text,
  base_minor       integer not null default 0,
  distance_minor   integer not null default 0,
  wait_minutes     integer not null default 0,
  wait_cost_minor  integer not null default 0,
  cancellation_minor integer not null default 0,
  total_minor      integer not null default 0,
  currency         text not null default 'GBP',
  recorded_at      timestamptz not null default now()
);
alter table delivery_costs_actual enable row level security;

-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- drop table if exists delivery_costs_actual;
-- drop table if exists delivery_status_events;
-- drop table if exists deliveries;
-- drop table if exists delivery_surcharges;
-- drop table if exists delivery_quotes;
-- drop table if exists venue_uber_config;
