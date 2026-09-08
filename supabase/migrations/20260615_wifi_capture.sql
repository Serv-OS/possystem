-- 20260615_wifi_capture.sql
-- WiFi guest data-capture (phase 1 of the marketing/CRM push).
-- Doctrine mirrors review_manager: tenant-fenced reads via user_accessible_locations()
-- (SETOF text), all writes via service-role edge functions, secret tables get NO read
-- policy. location_id is the ops id as TEXT (matching the review_* tables + the helper).
--
-- Decisions baked in: capture-first (authorize-back deferred), SINGLE marketing opt-in,
-- DOB required with an 18+ marketing gate. Unified CRM = EXTEND the existing customers
-- table (do not fork). customers already has: name, birthday(date), email, phone, phone_raw,
-- marketing_opt_in, marketing_opt_in_at, welcome_sent_at, allergens, soft-delete.

-- (A) Extend the unified contact model (additive, backfill-safe). Reuse existing birthday(date) for DOB.
alter table customers add column if not exists first_name text;
alter table customers add column if not exists last_name  text;
alter table customers add column if not exists is_local   boolean;        -- "Are you local?"
alter table customers add column if not exists source     text;           -- first-touch channel
alter table customers add column if not exists sources    text[] not null default '{}';  -- all channels seen

create index if not exists customers_org_email_idx on customers (org_id, lower(email)) where email is not null;
create index if not exists customers_birthday_md_idx on customers ((extract(month from birthday)), (extract(day from birthday))) where birthday is not null;

-- (B) Append-only consent ledger (UK GDPR/PECR evidence). Single marketing opt-in => channel 'both'.
create table if not exists customer_consents (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id) on delete cascade,
  org_id          uuid,
  location_id     text not null,
  company_id      uuid,
  channel         text not null default 'both' check (channel in ('email','sms','both')),
  purpose         text not null default 'marketing',
  consented       boolean not null,                  -- true = opt-in, false = refusal/withdrawal
  source          text not null default 'wifi',
  method          text not null default 'explicit_optin',  -- WiFi is never soft opt-in
  consent_text    text,                              -- exact wording shown
  privacy_version text,
  ip              inet,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists customer_consents_customer_idx on customer_consents (customer_id, created_at desc);
alter table customer_consents enable row level security;
drop policy if exists customer_consents_read on customer_consents;
create policy customer_consents_read on customer_consents for select
  using (location_id in (select public.user_accessible_locations()));

-- (C) Per-location WiFi portal config (brandable/editable like the captive-portal screenshot).
create table if not exists wifi_portal_settings (
  location_id     text primary key,
  company_id      uuid,
  enabled         boolean not null default true,
  headline        text default 'Connect to free WiFi',
  subtext         text,
  bg_image_url    text,
  logo_url        text,
  accent_color    text,
  button_style    text not null default 'dark' check (button_style in ('dark','accent')),
  -- which fields show + which are required (mirrors the editable form). DOB required + 18+ gate.
  fields          jsonb not null default
    '{"email":{"show":true,"required":true},"phone":{"show":true,"required":false},
      "first_name":{"show":true,"required":true},"last_name":{"show":true,"required":false},
      "dob":{"show":true,"required":true},"is_local":{"show":true,"required":false}}'::jsonb,
  age_gate        boolean not null default true,     -- 18+ : under-18 may use WiFi but cannot opt in to marketing
  marketing_copy  text default 'Keep me updated with news, offers and events by email and SMS.',
  success_copy    text default 'You''re connected. Enjoy your visit!',
  redirect_url    text,
  terms_url       text,
  privacy_url     text,
  privacy_version text default 'v1',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table wifi_portal_settings enable row level security;
drop policy if exists wifi_portal_settings_read on wifi_portal_settings;
create policy wifi_portal_settings_read on wifi_portal_settings for select
  using (location_id in (select public.user_accessible_locations()));

-- (D) Per-location UniFi binding (SECRETS: service-role only, NO read policy; mirrors review_google_tokens).
--     auth_method defaults to 'none' — capture ships first; "get online" is configured later.
create table if not exists wifi_unifi_bindings (
  location_id        text primary key,
  company_id         uuid,
  auth_method        text not null default 'none'
                     check (auth_method in ('none','unifi_voucher','unifi_local_api','unifi_legacy','onprem_relay')),
  controller_url     text,
  site_id            text,
  ssid               text,
  api_key_enc        text,        -- SECRET (AES-GCM)
  admin_user_enc     text,        -- SECRET
  admin_pass_enc     text,        -- SECRET
  voucher_pool       jsonb,       -- SECRET: [{code, consumed_at}]
  auth_minutes       integer not null default 1440,
  data_limit_mb      integer,
  down_kbps          integer,
  up_kbps            integer,
  last_authorize_at  timestamptz,
  last_error         text,
  connected_by       uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table wifi_unifi_bindings enable row level security;
-- intentionally NO read policy: only service-role edge functions read secrets.

-- (E) Capture event log (analytics + dedup; non-secret).
create table if not exists wifi_captures (
  id            uuid primary key default gen_random_uuid(),
  location_id   text not null,
  company_id    uuid,
  customer_id   uuid references customers(id) on delete set null,
  client_mac    text,        -- UniFi 'id' param
  ap_mac        text,
  ssid          text,
  is_return     boolean not null default false,
  marketing_opt_in boolean not null default false,
  authorized    boolean not null default false,
  auth_method   text,
  created_at    timestamptz not null default now()
);
create index if not exists wifi_captures_loc_created_idx on wifi_captures (location_id, created_at desc);
create index if not exists wifi_captures_mac_idx on wifi_captures (location_id, client_mac);
alter table wifi_captures enable row level security;
drop policy if exists wifi_captures_read on wifi_captures;
create policy wifi_captures_read on wifi_captures for select
  using (location_id in (select public.user_accessible_locations()));
