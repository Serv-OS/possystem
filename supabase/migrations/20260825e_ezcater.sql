-- 20260825e_ezcater.sql. ezCater integration, phase 1 (Ops DB).
--
-- Inbound catering orders from the ezCater Marketplace / ezOrdering.
-- Plan: EZCATER_INTEGRATION_PLAN.md (researched 25 Aug 2026).
--
-- Two things ship here and the ORDER MATTERS.
--
--  1. closed_checks_source_check is widened to accept 'ezcater'. This repo has
--     been burned by that constraint four times (catering, hubrise, terminal,
--     adyen_pay_at_table). The invariant is: a new record.source means widen the
--     constraint, and it must land BEFORE the first sale books or every ezCater
--     check is refused, the closer retries forever and the till reports "sale not
--     recorded". Phase 2 is what actually books these, so this is deliberately
--     ahead of its caller.
--
--  2. Four new tables. Every one of them holds an ezCater API token, a webhook
--     signing secret, dedup state or order linkage, so all four are SERVICE ROLE
--     ONLY: RLS enabled with NO policies, plus an explicit revoke from anon and
--     authenticated. That is exactly the hubrise_connections pattern (see
--     20260620_hubrise.sql) and the adyen_events pattern (20260811_adyen_events.sql).
--     The Back Office reads connection status through the ezcater-connect edge
--     function, never the table, so the token never reaches a browser.
--
-- Shape note: unlike HubRise, the connection is keyed on the ezCater SUBSCRIBER,
-- not on a location. ezCater allows one subscriber per API user covering many
-- caterers, and the webhook URL cannot carry a location the way HubRise's ?loc=
-- does. The location is resolved from the notification's parent_id through
-- ezcater_caterers.

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) closed_checks.source allow-list
-- ────────────────────────────────────────────────────────────────────────────
-- Full value list copied from 20260815_closed_checks_adyen_source.sql (the most
-- recent migration to redefine this constraint) plus 'ezcater'. Do not retype
-- this list from memory: dropping a value silently orphans that channel.
alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array[
    'pos','kiosk','online','mobile','catering','hubrise',
    'pax_table_pay','pos_send_to_terminal','adyen_pay_at_table','ezcater'
  ]::text[]));

-- ────────────────────────────────────────────────────────────────────────────
-- 2) ezcater_connections, one row per ezCater API user / subscriber
-- ────────────────────────────────────────────────────────────────────────────
-- api_token is the static bearer issued once in the Partner Portal. ezCater
-- CANNOT re-issue it, so it is never deleted on error, only on an explicit
-- disconnect. signing_secret is the HMAC key for X-Ezcater-Signature.
create table if not exists public.ezcater_connections (
  id                 uuid primary key default gen_random_uuid(),
  subscriber_id      text unique,                 -- ezCater subscriber uuid (null until createSubscriber succeeds)
  company_id         uuid,
  label              text,                        -- operator-facing name for this API user
  api_token          text not null,               -- SECRET (service role only)
  signing_secret     text,                        -- SECRET, webhook HMAC key
  webhook_url        text,
  subscribed_events  text[] not null default '{}',
  status             text not null default 'connected'
                       check (status in ('connected','error','disconnected')),
  -- Order accept / reject is feature gated per brand by ezCater and cannot be
  -- unlocked by building. null means we have not been told either way yet.
  accept_enabled     boolean,
  menus_enabled      boolean,                     -- menuCreate permission, same story
  last_event_at      timestamptz,
  last_reconcile_at  timestamptz,
  last_error         text,
  connected_by       uuid,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.ezcater_connections enable row level security;
revoke all on public.ezcater_connections from anon, authenticated;
-- (no policies, service role only)

-- ────────────────────────────────────────────────────────────────────────────
-- 3) ezcater_caterers, caterer uuid to ServOS location
-- ────────────────────────────────────────────────────────────────────────────
-- THE routing table. A webhook notification carries parent_id (the caterer) and
-- nothing else that identifies the venue, so an unmapped caterer means an order
-- we cannot place. Rows are created either by the operator mapping a caterer in
-- the Back Office, or by the webhook recording a caterer it has never seen
-- (location_id null) so the mapping screen can offer it.
create table if not exists public.ezcater_caterers (
  caterer_uuid   text primary key,              -- notification parent_id
  connection_id  uuid references public.ezcater_connections(id) on delete cascade,
  location_id    text,                          -- ops location id; null = seen but unmapped
  caterer_name   text,
  brand_name     text,
  currency       text not null default 'USD',
  auto_accept    boolean not null default false,
  active         boolean not null default true,
  first_seen_at  timestamptz not null default now(),
  mapped_at      timestamptz,
  mapped_by      uuid,
  updated_at     timestamptz not null default now()
);
create index if not exists ezcater_caterers_loc_idx on public.ezcater_caterers (location_id);
create index if not exists ezcater_caterers_conn_idx on public.ezcater_caterers (connection_id);
alter table public.ezcater_caterers enable row level security;
revoke all on public.ezcater_caterers from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) ezcater_events, dedup key AND the raw replay log
-- ────────────────────────────────────────────────────────────────────────────
-- ezCater notifications carry "payload": null. The order body only exists if we
-- call back with a GraphQL order(id:) query, so ingest is a two legged
-- operation and the second leg can fail on its own. The raw notification is
-- therefore written HERE FIRST, before the fetch is attempted, so a failed
-- fetch is replayable forever. ezCater's retry policy is undocumented, which is
-- exactly why we do not depend on it.
create table if not exists public.ezcater_events (
  notification_id text primary key,              -- ezCater notification id == dedup key
  connection_id   uuid,
  caterer_uuid    text,                          -- notification parent_id
  location_id     text,                          -- resolved from ezcater_caterers, null if unknown
  event_key       text,                          -- accepted | submitted | cancelled | relish_finalized | ...
  entity_id       text,                          -- the ezCater order uuid
  status          text not null default 'received'
                    check (status in ('received','processed','error','skipped')),
  attempts        integer not null default 0,
  error           text,
  raw             jsonb not null,                -- the FULL notification, verbatim
  signature_valid boolean,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index if not exists ezcater_events_replay_idx
  on public.ezcater_events (received_at) where status <> 'processed';
create index if not exists ezcater_events_entity_idx on public.ezcater_events (entity_id);
create index if not exists ezcater_events_loc_idx on public.ezcater_events (location_id, received_at desc);
alter table public.ezcater_events enable row level security;
revoke all on public.ezcater_events from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) ezcater_order_links, order_queue.ref to ezCater order
-- ────────────────────────────────────────────────────────────────────────────
-- Keyed (location_id, ref) to match order_queue's primary key since 20260806k.
--
-- accepted_count exists because ezCater has NO modified event: a modification
-- arrives as a SECOND accepted notification for the same order id. Seeing
-- accepted_count go above 1 is the only signal that the order changed.
--
-- fire_at is the event time. It is what the phase 3 reconciler keys on when it
-- re-queries an order shortly before it goes to the kitchen, which ezCater
-- explicitly advises because catering orders get edited for days.
--
-- The tax columns are a VERBATIM record of what ezCater charged and what
-- ezCater says it remitted. They are never recomputed. See ezcater-map.ts.
create table if not exists public.ezcater_order_links (
  ref                  text not null,            -- order_queue.ref, 'EZ-<order uuid>'
  location_id          text not null,
  ez_order_id          text not null,            -- order.uuid
  caterer_uuid         text,
  order_number         text,
  order_type           text,                     -- TAKEOUT | DELIVERY | THIRD_PARTY_DELIVERY
  ez_lifecycle         text,                     -- last lifecycle value seen FROM ezCater
  accepted_count       integer not null default 0,
  modification_seen_at timestamptz,
  pushed_status        text,                     -- last status we pushed TO ezCater (accept / reject)
  push_error           text,
  pushed_at            timestamptz,
  event_at             timestamptz,              -- notification time, monotonic guard
  fire_at              timestamptz,              -- ezCater event time (when the food is needed)
  requeried_at         timestamptz,
  sales_tax            numeric(12,2),            -- ezCater's salesTax, verbatim
  sales_tax_remitted   numeric(12,2),            -- ezCater's salesTaxRemittance, verbatim
  taxable_state        text,                     -- state from taxableAddress, drives the facilitator split
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (location_id, ref)
);
create unique index if not exists ezcater_order_links_ez_idx on public.ezcater_order_links (ez_order_id);
create index if not exists ezcater_order_links_fire_idx on public.ezcater_order_links (fire_at);
alter table public.ezcater_order_links enable row level security;
revoke all on public.ezcater_order_links from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) order_queue.source
-- ────────────────────────────────────────────────────────────────────────────
-- ezCater orders insert with source='ezcater'. order_queue was created outside
-- the migrations and has no source CHECK; this DROP IF EXISTS is a defensive
-- no-op that guarantees 'ezcater' is accepted even if an environment added one.
-- We deliberately do NOT add a restrictive CHECK, that risks rejecting existing rows.
alter table public.order_queue drop constraint if exists order_queue_source_check;

commit;

-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- begin;
-- drop table if exists public.ezcater_order_links;
-- drop table if exists public.ezcater_events;
-- drop table if exists public.ezcater_caterers;
-- drop table if exists public.ezcater_connections;
-- alter table public.closed_checks drop constraint if exists closed_checks_source_check;
-- alter table public.closed_checks add constraint closed_checks_source_check
--   check (source = any (array[
--     'pos','kiosk','online','mobile','catering','hubrise',
--     'pax_table_pay','pos_send_to_terminal','adyen_pay_at_table'
--   ]::text[]));
-- commit;
--
-- WARNING: reverting the constraint fails if any ezCater check has already
-- booked. Void or delete those rows first, or the ALTER will be rejected.
