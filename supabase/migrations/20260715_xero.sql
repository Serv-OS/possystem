-- Xero accounting integration — Phase 1 (connection + sales sync scaffolding).
-- Each venue (location) connects its OWN Xero organisation via OAuth. Tokens are held
-- ONLY here and touched ONLY by the service-role edge functions — no anon/authenticated
-- policies exist, so the token columns are unreadable from the client. The back office
-- reads connection status through the xero-status edge function, never the raw table.

create table if not exists public.xero_connections (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null,
  tenant_id      text not null,               -- Xero organisation (tenantId)
  tenant_name    text,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,        -- access-token expiry (~30 min out)
  scopes         text,
  connected_by   uuid,                         -- BO user who linked it
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (location_id)                          -- one Xero org per venue for now
);
alter table public.xero_connections enable row level security;
-- Intentionally NO policies → only the service_role (edge functions) can read/write.

-- Idempotency + audit for what we've pushed to Xero. The unique key stops us from
-- double-posting the same day's takings if a sync is retried.
create table if not exists public.xero_sync_log (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null,
  kind         text not null,                  -- 'daily_sales' | 'bill' | 'payout' ...
  ref_date     date,                            -- business date (for daily_sales)
  ref_id       text,                            -- source id (e.g. bill id) when not date-keyed
  xero_id      text,                            -- resulting Xero Invoice/Journal/Txn id
  status       text not null default 'ok',      -- 'ok' | 'error'
  detail       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.xero_sync_log enable row level security;
create unique index if not exists xero_sync_log_daily_uniq
  on public.xero_sync_log (location_id, kind, ref_date) where ref_date is not null;
create unique index if not exists xero_sync_log_ref_uniq
  on public.xero_sync_log (location_id, kind, ref_id) where ref_id is not null;

-- Per-venue account/tax mapping for how takings post into Xero (sane defaults for the
-- UK chart; editable later in the back office once connected).
create table if not exists public.xero_config (
  location_id           uuid primary key,
  sales_account_code    text,                   -- e.g. '200' Sales
  tax_type              text,                   -- e.g. 'OUTPUT2' (20% VAT on income, UK)
  clearing_account_code text,                   -- holding account payouts land in
  cash_account_code     text,
  post_mode             text not null default 'invoice',  -- 'invoice' | 'manual_journal'
  auto_daily            boolean not null default false,   -- nightly auto-post
  updated_at            timestamptz not null default now()
);
alter table public.xero_config enable row level security;
-- service-role only; back office edits via edge function.
