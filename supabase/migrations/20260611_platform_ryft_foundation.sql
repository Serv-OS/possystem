-- ============================================================================
-- PLATFORM DB (yhzjgyrkyjabvhblqxzu) — Ryft dual-processor foundation.
-- Additive + non-breaking: every location stays on Stripe until explicitly
-- switched. Nothing reads payment_processor yet.
-- ============================================================================

-- Per-location processor switch.
alter table public.locations
  add column if not exists payment_processor text not null default 'stripe'
    check (payment_processor in ('stripe', 'ryft'));

-- Ryft sub-account per location (mirror of merchant_stripe_accounts).
create table if not exists public.merchant_ryft_accounts (
  id                        uuid primary key default gen_random_uuid(),
  location_id               uuid not null unique,
  company_id                uuid not null,
  ryft_account_id           text not null unique,          -- acc_…
  link_method               text not null default 'hosted',-- hosted | authorized | manual
  charges_enabled           boolean not null default false,
  payouts_enabled           boolean not null default false,
  details_submitted         boolean not null default false,
  default_currency          text,
  country                   text,
  requirements              jsonb,
  cardpresent_markup_percent numeric,
  online_markup_percent      numeric,
  pricing_notes             text,
  linked_by_user_id         uuid,
  linked_at                 timestamptz not null default now(),
  last_webhook_at           timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists idx_mra_location on public.merchant_ryft_accounts(location_id);

alter table public.merchant_ryft_accounts enable row level security;
-- Logged-in users may read (BO merchant-status UI); writes are service-role
-- only (edge functions). Tighter than the legacy Stripe table (no anon read).
do $$ begin
  create policy mra_read_authenticated on public.merchant_ryft_accounts for select to authenticated using (true);
exception when duplicate_object then null; end $$;
