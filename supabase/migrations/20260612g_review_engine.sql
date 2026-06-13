-- 20260612g_review_engine.sql  (OPS DB)
--
-- Review Manager: the ask/trigger engine + settings config. Adds trigger config
-- to review_settings and a review_requests log (one ask per source event, the
-- dedup + frequency-cap substrate). Tenant-fenced reads; writes are service-role
-- (the back office edits settings via the review-admin edge fn).

-- ── trigger/ask config on the per-venue settings row ────────────────────────
alter table review_settings add column if not exists ask_enabled        boolean not null default false;
alter table review_settings add column if not exists ask_channel        text not null default 'sms' check (ask_channel in ('sms','email'));
alter table review_settings add column if not exists ask_delay_minutes  integer not null default 45;   -- after table close
alter table review_settings add column if not exists ask_delay_collection_minutes integer not null default 120; -- after collection/delivery
alter table review_settings add column if not exists ask_window_start   smallint not null default 10;  -- local hour, inclusive
alter table review_settings add column if not exists ask_window_end     smallint not null default 20;  -- local hour, exclusive
alter table review_settings add column if not exists ask_frequency_days integer not null default 60;    -- don't re-ask same guest within N days
alter table review_settings add column if not exists ask_message        text;                          -- SMS/email body template ({name},{venue},{link})

-- ── the ask log: one row per (source event) we considered, sent OR suppressed ─
create table if not exists review_requests (
  id               uuid primary key default gen_random_uuid(),
  location_id      text not null,
  company_id       uuid,
  source_kind      text not null check (source_kind in ('closed_check','order_queue','manual')),
  source_ref       text not null,                 -- closed_checks.id / order_queue.ref / manual tag
  customer_name    text,
  customer_phone   text,
  customer_email   text,
  channel          text check (channel in ('sms','email')),
  status           text not null default 'queued' check (status in ('queued','sent','suppressed','failed','opened','clicked','converted')),
  suppressed_reason text,
  link             text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (location_id, source_kind, source_ref)   -- never ask twice for the same event
);
create index if not exists review_requests_loc_created on review_requests(location_id, created_at desc);
create index if not exists review_requests_phone on review_requests(location_id, customer_phone, created_at desc);

alter table review_requests enable row level security;
do $$ begin
  create policy review_requests_read on review_requests for select
    using (location_id in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
