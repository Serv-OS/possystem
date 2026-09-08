-- 20260612c_ryft_payments_ledger.sql  (PLATFORM DB)
--
-- Server-truth ledger of what Ryft ACTUALLY did with each payment, written by
-- the ryft-webhook handler on PaymentSession.captured / .refunded / .voided.
-- Until now the webhook only stamped last_webhook_at — we trusted the client's
-- closed_checks write. This ledger lets us reconcile:
--   • capture confirmed  → stamp the matching closed_check as server-verified
--   • refund in Ryft dash → reflect it in closed_checks.refunds[] + status
--   • orphan capture      → a captured payment with NO closed_check (money taken,
--                           order not recorded) stays matched_closed_check = null
--                           and is visible for recovery.
-- Service-role only (RLS on, no policies) — same posture as ryft_webhook_events
-- and merchant_ryft_disputes.

create table if not exists public.ryft_payments (
  payment_session_id    text primary key,     -- ps_…
  ryft_account_id       text,
  location_id           uuid,
  amount                integer,              -- minor units, the session amount
  amount_refunded       integer default 0,    -- minor units, total refunded per Ryft
  currency              text,
  status                text,                 -- Captured | Refunded | Voided | …
  channel               text,
  order_ref             text,
  matched_closed_check  text,                 -- closed_checks.id we reconciled to (null = unmatched / orphan)
  captured_at           timestamptz,
  refunded_at           timestamptz,
  raw                   jsonb,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists ryft_payments_account_idx on public.ryft_payments (ryft_account_id);
create index if not exists ryft_payments_unmatched_idx on public.ryft_payments (matched_closed_check) where matched_closed_check is null;

alter table public.ryft_payments enable row level security;
