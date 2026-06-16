-- Marketing & Promotions — Slice 1: offers + one-time promo codes + redemption ledger.
-- Additive + reversible. Ops DB. Org-scoped (mirrors `customers`), venue-filtered via venue_ids[].
-- The actual reward is applied at the till through the EXISTING discount slot — these tables are the
-- marketing source-of-truth + audit; redemption is made race-safe by a guarded UPDATE in promo-redeem.

-- (A) Offer definitions ------------------------------------------------------
create table if not exists offers (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  company_id          uuid,
  name                text not null,
  description         text,
  reward_type         text not null default 'fixed'
                      check (reward_type in ('percent','fixed','free_item','free_delivery','points_bonus')),
  reward_value        numeric(10,2) not null default 0,   -- percent:0-100 · fixed:major units · points:points
  reward_item_id      text,                                -- menu item for free_item
  reward_label        text,                                -- display, e.g. "Free dessert"
  min_spend           numeric(10,2),                       -- min basket (major units); null = none
  include_category_ids text[] not null default '{}',
  exclude_category_ids text[] not null default '{}',
  valid_from          timestamptz,
  valid_to            timestamptz,
  venue_ids           text[] not null default '{}',        -- empty = all venues in org
  per_customer_limit  int not null default 1,
  total_cap           int,                                 -- null = unlimited issuance
  issued_count        int not null default 0,
  redeemed_count      int not null default 0,
  code_prefix         text not null default '',            -- e.g. 'BDAY'
  code_length         int not null default 5,              -- random suffix length
  stackable           boolean not null default false,
  active              boolean not null default true,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table offers enable row level security;
drop policy if exists offers_read on offers;
create policy offers_read on offers for select using (org_id::text in (select public.user_accessible_orgs()));
-- writes are service-role only (via the marketing-admin edge fn) — no insert/update policy.

-- (B) Issued codes (one row per code) ---------------------------------------
create table if not exists promo_codes (
  id                  uuid primary key default gen_random_uuid(),
  offer_id            uuid not null references offers(id) on delete cascade,
  org_id              uuid not null,
  company_id          uuid,
  code                text not null,
  customer_id         uuid,                                -- null = shared/anonymous code
  status              text not null default 'issued'
                      check (status in ('issued','delivered','opened','clicked','redeemed','expired','voided')),
  uses_allowed        int not null default 1,
  uses_count          int not null default 0,
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz,
  redeemed_at         timestamptz,
  redeemed_order_id   text,                                -- closed_checks.id
  redeemed_location_id text,
  redeemed_value      numeric(10,2),                       -- discount applied (major units)
  redeemed_staff_id   uuid,
  campaign_id         uuid,                                -- reserved (slice 4)
  message_id          uuid,                                -- reserved (slice 2)
  voided_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- case-insensitive uniqueness is the redemption race anchor.
create unique index if not exists promo_codes_code_uidx on promo_codes (upper(code));
create index if not exists promo_codes_offer_idx on promo_codes (offer_id);
create index if not exists promo_codes_customer_idx on promo_codes (customer_id) where customer_id is not null;
create index if not exists promo_codes_status_idx on promo_codes (org_id, status);
alter table promo_codes enable row level security;
drop policy if exists promo_codes_read on promo_codes;
create policy promo_codes_read on promo_codes for select using (org_id::text in (select public.user_accessible_orgs()));

-- (C) Append-only redemption ledger (supports N-use codes + idempotent retries) ----
create table if not exists promo_redemptions (
  id                  uuid primary key default gen_random_uuid(),
  promo_code_id       uuid not null references promo_codes(id) on delete cascade,
  offer_id            uuid not null,
  org_id              uuid not null,
  code                text not null,
  customer_id         uuid,
  location_id         text not null,
  order_id            text,                                -- closed_checks.id
  staff_id            uuid,
  basket_value        numeric(10,2),
  discount_value      numeric(10,2),
  idempotency_key     text,
  redeemed_at         timestamptz not null default now()
);
create unique index if not exists promo_redemptions_idem_uidx on promo_redemptions (idempotency_key) where idempotency_key is not null;
create index if not exists promo_redemptions_code_idx on promo_redemptions (promo_code_id);
create index if not exists promo_redemptions_offer_idx on promo_redemptions (offer_id, redeemed_at desc);
alter table promo_redemptions enable row level security;
drop policy if exists promo_redemptions_read on promo_redemptions;
create policy promo_redemptions_read on promo_redemptions for select using (org_id::text in (select public.user_accessible_orgs()));
