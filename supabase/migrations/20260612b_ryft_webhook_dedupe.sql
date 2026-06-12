-- 20260612b_ryft_webhook_dedupe.sql  (PLATFORM DB)
--
-- Ryft retries webhooks (0,1,5,10,10,10 min). As handlers start writing records
-- and sending alerts, duplicate deliveries would double-write / double-notify.
-- This is the idempotency guard: insert the event id once; a duplicate is a
-- no-op and the handler returns 200 immediately. Also doubles as an audit log.
-- Service-role only (RLS on, no policies).

create table if not exists public.ryft_webhook_events (
  event_id    text primary key,
  event_type  text,
  account_id  text,
  received_at timestamptz default now()
);

alter table public.ryft_webhook_events enable row level security;
