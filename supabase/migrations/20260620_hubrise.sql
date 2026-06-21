-- 20260620_hubrise.sql — HubRise integration (Ops DB)
-- Inbound channel orders + catalog push + inventory/86 sync.
--
-- Every table here holds an operator's HubRise access token, callback dedup
-- state, or order linkage. All are SERVICE-ROLE ONLY: RLS is enabled with NO
-- policies, so no authenticated/anon client can read them — exactly the pattern
-- used by review_google_tokens. The Back Office reads connection STATUS through
-- the hubrise-connect edge function (service role), never the table directly, so
-- the access_token never reaches the browser.

-- 1) Per-location connection: the access token + the bound HubRise resource ids.
create table if not exists hubrise_connections (
  location_id              text primary key,            -- ops location id
  company_id               uuid,
  access_token             text not null,               -- SECRET (service role only)
  scope                    text,
  hubrise_account_id       text,
  account_name             text,
  hubrise_location_id      text,
  hubrise_location_name    text,
  hubrise_catalog_id       text,
  hubrise_catalog_name     text,
  hubrise_customer_list_id text,
  currency                 text not null default 'GBP',
  status                   text not null default 'connected'
                             check (status in ('connected','error','disconnected')),
  active_callback_id       text,
  passive_callback_id      text,
  callbacks_registered_at  timestamptz,
  catalog_pushed_at        timestamptz,
  catalog_push_error       text,
  inventory_synced_at      timestamptz,
  inventory_sync_error     text,
  last_event_at            timestamptz,
  last_reconcile_at        timestamptz,
  last_error               text,
  auto_accept              boolean not null default false,
  default_prep_minutes     integer not null default 20,
  connected_by             uuid,
  connected_at             timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table hubrise_connections enable row level security;
-- (no policies → service role only)

-- 2) OAuth CSRF state (short-lived; deleted on callback). Mirrors review_oauth_pending.
create table if not exists hubrise_oauth_pending (
  state       text primary key,
  location_id text not null,
  company_id  uuid,
  created_at  timestamptz not null default now()
);
alter table hubrise_oauth_pending enable row level security;

-- 3) Inbound callback dedup / idempotency. event_id is the HubRise event id and
-- the PK — the unique constraint is what makes at-least-once delivery safe under
-- concurrent + duplicate webhook deliveries. Also used to record passive-replay.
create table if not exists hubrise_events (
  event_id      text primary key,            -- HubRise event id == dedup key
  location_id   text,
  resource_type text,
  event_type    text,
  order_id      text,
  status        text not null default 'received'
                  check (status in ('received','processed','error','skipped')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists hubrise_events_loc_idx on hubrise_events (location_id, received_at desc);
alter table hubrise_events enable row level security;

-- 4) Order linkage: ServOS order_queue.ref <-> HubRise order. Authoritative
-- source for status push-back + reconcile. hr_status = last status seen FROM
-- HubRise; pushed_status = last status we pushed TO HubRise; last_event_created_at
-- is the monotonic guard so a stale retried event can't regress current state.
create table if not exists hubrise_order_links (
  ref                   text primary key,             -- order_queue.ref (our internal ref)
  location_id           text not null,
  hubrise_order_id      text not null,
  hubrise_location_id   text,
  channel               text,                          -- created_by / channel (Deliveroo, etc.)
  service_type          text,                          -- delivery | collection | eat_in
  hr_status             text,
  pushed_status         text,
  push_error            text,
  pushed_at             timestamptz,
  last_event_created_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists hubrise_order_links_hrid_idx on hubrise_order_links (hubrise_order_id);
create index if not exists hubrise_order_links_loc_idx on hubrise_order_links (location_id);
alter table hubrise_order_links enable row level security;

-- 5) order_queue.source: HubRise orders are inserted with source='hubrise'. The
-- order_queue table was created outside the migrations and has no source CHECK
-- constraint; this DROP IF EXISTS is a defensive no-op that guarantees 'hubrise'
-- is accepted even if some environment added one. (We deliberately do NOT add a
-- restrictive CHECK — that would risk rejecting pre-existing rows.)
alter table order_queue drop constraint if exists order_queue_source_check;
