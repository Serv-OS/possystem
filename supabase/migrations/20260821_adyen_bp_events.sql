-- 20260821_adyen_bp_events.sql — BALANCE PLATFORM webhook landing table (OPS DB tbetcegmszzotrwdtqhi)
-- ⚠ HAND-APPLY (production DDL is blocked for tooling): pbcopy < this file → SQL editor.
--
-- Phase 4 of ServOS Payments: per-venue payout onboarding. Adyen's BALANCE
-- PLATFORM webhooks (account holder verification, balance account changes,
-- sweeps, bank transfers) are a SEPARATE stream from the standard payment
-- webhooks — different Customer Area config, different HMAC scheme (raw-body
-- base64, key ADYEN_BP_HMAC_KEY; the standard stream signs per-item fields).
-- They land here via the new adyen-bp-webhook fn, same philosophy as
-- adyen_events (20260811): durability first, semantics second. Every event is
-- stored RAW before anything interprets it; a missed or misparsed event can be
-- replayed from this table forever.
--
-- If this table is missing, adyen-bp-webhook answers 500 so Adyen keeps
-- retrying — no event is ever silently dropped by deploying the fn early.

begin;

create table if not exists public.adyen_bp_events (
  id                 uuid primary key default gen_random_uuid(),
  event_type         text,                    -- balancePlatform.accountHolder.updated | .transfer.updated | ...
  environment        text,                    -- 'test' | 'live'
  account_holder_id  text,                    -- AH... when the payload carries one
  balance_account_id text,                    -- BA... when the payload carries one
  transfer_id        text,                    -- transfer id for balancePlatform.transfer.* events
  hmac_present       boolean not null default false,
  hmac_valid         boolean,                 -- false = failed verification OR no key configured (fail-closed; row kept for audit)
  raw                jsonb not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz              -- stamped when a consumer handles it
);
create index if not exists idx_adyen_bp_events_unprocessed on public.adyen_bp_events (received_at) where processed_at is null;
create index if not exists idx_adyen_bp_events_ah on public.adyen_bp_events (account_holder_id) where account_holder_id is not null;
create index if not exists idx_adyen_bp_events_ba on public.adyen_bp_events (balance_account_id) where balance_account_id is not null;

alter table public.adyen_bp_events enable row level security;
revoke all on public.adyen_bp_events from anon, authenticated;

commit;
