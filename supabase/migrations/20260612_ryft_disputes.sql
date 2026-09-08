-- 20260612_ryft_disputes.sql  (PLATFORM DB)
--
-- Chargeback / dispute tracking. A dispute has a hard respondBy deadline — miss
-- it and it auto-Expires: the merchant loses the funds + a non-reclaimable fee.
-- So we capture every Dispute.* webhook here and surface it with a countdown.
-- Service-role only (RLS on, no policies) — the back office reads via the
-- location-scoped ryft-disputes edge fn.

create table if not exists public.merchant_ryft_disputes (
  id                   uuid primary key default gen_random_uuid(),
  dispute_id           text not null unique,         -- dsp_...
  ryft_account_id      text,                          -- ac_...  (the merchant sub-account)
  location_id          uuid,                          -- platform locations.id
  payment_session_id   text,                          -- ps_...  (links to the original payment)
  amount               integer,                       -- minor units, the amount at stake
  currency             text,
  status               text,                          -- Open | Cancelled | Accepted | Challenged | Lost | Won | Expired
  category             text,                          -- Fraudulent | Authorization | ProcessingError | CardholderDispute | General
  reason_code          text,
  reason_description   text,
  respond_by           timestamptz,                   -- DEADLINE
  recommended_evidence jsonb,                          -- string[] of evidence types Ryft suggests
  evidence             jsonb,                          -- what we've attached
  raw                  jsonb,                          -- full dispute payload (audit / forward-compat)
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  last_event_at        timestamptz
);

create index if not exists idx_ryft_disputes_location on public.merchant_ryft_disputes(location_id);
create index if not exists idx_ryft_disputes_status   on public.merchant_ryft_disputes(status);
create index if not exists idx_ryft_disputes_account  on public.merchant_ryft_disputes(ryft_account_id);

alter table public.merchant_ryft_disputes enable row level security;
-- No policies: only the service role (edge functions) may read/write. Clients
-- never touch this table directly.
