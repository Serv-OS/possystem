-- 20260811_adyen_events.sql — Adyen webhook landing table (programme slice 0).
--
-- EVERY event Adyen ever sends us lands here RAW before anything interprets
-- it — the Ryft lesson: webhook durability first, semantics second. A missed
-- or misparsed event can be replayed from this table forever.

begin;

create table if not exists public.adyen_events (
  id uuid primary key default gen_random_uuid(),
  live boolean,                       -- Adyen's live flag ("true"/"false" in payload)
  event_code text,                    -- AUTHORISATION | CAPTURE | REFUND | ...
  psp_reference text,
  merchant_account text,
  merchant_reference text,
  success boolean,
  hmac_present boolean not null default false,
  hmac_valid boolean,                 -- null until verification is armed
  raw jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz            -- stamped when a consumer handles it
);
create index if not exists idx_adyen_events_psp on public.adyen_events (psp_reference);
create index if not exists idx_adyen_events_unprocessed on public.adyen_events (received_at) where processed_at is null;

alter table public.adyen_events enable row level security;
revoke all on public.adyen_events from anon, authenticated;

commit;
