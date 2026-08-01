-- v5.5.966 — ADYEN FOUNDATION (PLATFORM DB yhzjgyrkyjabvhblqxzu)
-- Phase 0 of ADYEN_INTEGRATION_PLAN.md: everything schema-side that needs no API keys.
-- Adyen for Platforms model: per-venue legal entity / account holder / balance account /
-- store; our margin as Commission splits; AMS1 terminals via cloud Terminal API.
begin;

-- ── 1. Three-way processor switch ────────────────────────────────────────────
alter table locations drop constraint if exists locations_payment_processor_check;
alter table locations add constraint locations_payment_processor_check
  check (payment_processor = any (array['stripe'::text, 'ryft'::text, 'adyen'::text]));

-- ── 2. payment_devices grows an Adyen shape ──────────────────────────────────
alter table payment_devices add column if not exists adyen_terminal_id text; -- POIID e.g. AMS1-000168243358252

alter table payment_devices drop constraint if exists payment_devices_processor_check;
alter table payment_devices add constraint payment_devices_processor_check
  check (processor = any (array['stripe'::text, 'ryft'::text, 'adyen'::text]));

alter table payment_devices drop constraint if exists payment_devices_processor_fields_check;
alter table payment_devices add constraint payment_devices_processor_fields_check
  check (
    ((processor = 'stripe'::text) and (stripe_reader_id is not null) and (stripe_account_id is not null)
      and (device_type is not null) and (connection_kind is not null))
    or ((processor = 'ryft'::text) and (ryft_terminal_id is not null))
    or ((processor = 'adyen'::text) and (adyen_terminal_id is not null))
  );

create unique index if not exists uq_payment_devices_adyen_terminal_id
  on payment_devices (adyen_terminal_id) where adyen_terminal_id is not null;

-- ── 3. Per-venue Adyen account map (the AfP anatomy) ─────────────────────────
create table if not exists merchant_adyen_accounts (
  id                         uuid primary key default gen_random_uuid(),
  location_id                uuid not null unique,
  region                     text not null default 'EU' check (region in ('EU','US')),
  legal_entity_id            text,          -- LEM v4
  account_holder_id          text,          -- Balance Platform Config v2
  balance_account_id         text,          -- funds land here
  transfer_instrument_id     text,          -- venue's verified bank account
  business_line_id           text,
  merchant_account           text,          -- Adyen merchant account payments route through
  store_id                   text,          -- Management API store (physical venue)
  split_profile_id           text,          -- automatic split configuration on the store
  receive_payments_ok        boolean not null default false,
  payouts_ok                 boolean not null default false,
  verification_status        jsonb,         -- capability problems / deadlines snapshot
  onboarding_link_url        text,
  onboarding_link_expires_at timestamptz,
  markup_percent             numeric,       -- our margin (falls back to platform_settings defaults)
  markup_fixed_pence         integer,
  last_webhook_at            timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
alter table merchant_adyen_accounts enable row level security; -- service-role only (no policies)

-- ── 4. Webhook dedupe + server-truth payments ledger ─────────────────────────
create table if not exists adyen_webhook_events (
  event_key   text primary key,             -- pspReference:eventCode:success
  received_at timestamptz not null default now(),
  raw         jsonb
);
alter table adyen_webhook_events enable row level security;

create table if not exists adyen_payments (
  psp_reference        text primary key,
  merchant_reference   text,
  original_reference   text,                -- for REFUND/CHARGEBACK rows pointing at the parent
  location_id          uuid,
  merchant_account     text,
  store                text,
  channel              text,                -- 'online' | 'pos' | 'qr' | 'kiosk' | 'gift' | ...
  last_event_code      text,
  success              boolean,
  amount_minor         bigint,
  currency             text,
  amount_refunded_minor bigint not null default 0,
  card                 jsonb,               -- brand/last4/auth code/AID from additionalData
  matched_closed_check text,                -- reconcile: closed_checks id
  matched_terminal_job uuid,                -- reconcile: terminal_jobs id
  raw                  jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_adyen_payments_location on adyen_payments (location_id, created_at desc);
create index if not exists idx_adyen_payments_mref on adyen_payments (merchant_reference);
alter table adyen_payments enable row level security;

-- ── 5. Payouts + settlement lines (fed by report ingestion) ──────────────────
create table if not exists adyen_payouts (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid,
  balance_account_id text,
  payout_date        date,
  amount_minor       bigint,
  currency           text,
  fees_minor         bigint,
  status             text,                  -- initiated | sent | failed (webhook-driven)
  destination_last4  text,
  reference          text unique,           -- Adyen transfer/payout reference
  report_name        text,                  -- settlement report that backed the lines
  raw                jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_adyen_payouts_location on adyen_payouts (location_id, payout_date desc);
alter table adyen_payouts enable row level security;

create table if not exists adyen_payout_lines (
  id            bigserial primary key,
  payout_id     uuid references adyen_payouts(id) on delete cascade,
  psp_reference text,
  line_type     text,                       -- Settled | Refunded | Fee | Chargeback | ...
  gross_minor   bigint,
  fee_minor     bigint,
  net_minor     bigint,
  raw           jsonb
);
create index if not exists idx_adyen_payout_lines_payout on adyen_payout_lines (payout_id);
alter table adyen_payout_lines enable row level security;

-- ── 6. Disputes (deadline-driven queue, same UX model as Ryft's) ─────────────
create table if not exists merchant_adyen_disputes (
  dispute_psp_reference text primary key,
  payment_psp_reference text,
  location_id           uuid,
  status                text,               -- open | defended | accepted | won | lost | info_requested
  reason_code           text,
  reason                text,
  amount_minor          bigint,
  currency              text,
  respond_by            timestamptz,        -- THE deadline (drives the countdown UI)
  outcome               text,
  defense               jsonb,              -- reason picked + documents supplied
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_adyen_disputes_location on merchant_adyen_disputes (location_id, respond_by);
alter table merchant_adyen_disputes enable row level security;

-- ── 7. Platform-wide default margin (per-venue overrides live on the account row)
alter table platform_settings add column if not exists default_adyen_markup_percent numeric;
alter table platform_settings add column if not exists default_adyen_markup_fixed_pence integer;

commit;
