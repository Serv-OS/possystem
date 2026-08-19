-- v5.6.99 — ADYEN FEES + SETTLEMENT REPORT INGESTION (PLATFORM DB yhzjgyrkyjabvhblqxzu)
-- ⚠ HAND-APPLY (production DDL is blocked for tooling): pbcopy < this file → SQL editor.
--
-- Phase 2 of the ServOS Payments build: per-payment fees, payouts with
-- drill-down, and the report-ingestion queue. Fees arrive on Adyen's
-- merchant-level Settlement details report (CSV, announced by a
-- REPORT_AVAILABLE webhook), parsed by the new adyen-report-ingest fn.
--
-- Everything here is additive: no defaults change, no constraints tighten,
-- nothing rewrites existing rows. Safe to apply while traffic flows.

begin;

-- ── 1. adyen_payments grows the settlement facts ─────────────────────────────
-- fee_minor       total fees for this payment in minor units (interchange +
--                 scheme fees + commission + markup, summed across every
--                 settlement batch that touched it — a refund's fee lands in a
--                 later batch than the sale's).
-- fee_breakdown   jsonb keyed per settlement batch:
--                 { "settlement:<merchantAccount>:<batch>": { interchange_minor,
--                   scheme_fees_minor, commission_minor, markup_minor,
--                   total_minor, types: ["Settled"], report: "<file>" } }
--                 Re-ingesting a report rewrites its own key only — that is
--                 what makes fee_minor replay-safe.
-- settled_at      when the payment settled (from its Settled report row).
-- payout_id       fk-less text pointer at adyen_payouts.id (uuid as text) —
--                 the batch that PAID OUT this payment. Set only by a Settled
--                 row; a later refund batch never re-points it.
-- gratuity_minor  tip amount from the report's Gratuity column when present
--                 (the webhook does not carry gratuity separately).
alter table public.adyen_payments add column if not exists fee_minor bigint;
alter table public.adyen_payments add column if not exists fee_breakdown jsonb;
alter table public.adyen_payments add column if not exists settled_at timestamptz;
alter table public.adyen_payments add column if not exists payout_id text;
alter table public.adyen_payments add column if not exists gratuity_minor bigint;
create index if not exists idx_adyen_payments_payout
  on public.adyen_payments (payout_id) where payout_id is not null;

-- ── 2. adyen_payouts gaps found designing the report parser ──────────────────
-- The settlement report is per merchant account per batch; the existing table
-- (20260801) had no place for either, and only a single amount_minor.
-- Convention from here on: amount_minor = NET (what lands in the bank),
-- gross_minor = card sales minus refunds before fees, fees_minor = the gap.
alter table public.adyen_payouts add column if not exists merchant_account text;
alter table public.adyen_payouts add column if not exists batch_number integer;
alter table public.adyen_payouts add column if not exists gross_minor bigint;

-- ── 3. adyen_payout_lines gaps ───────────────────────────────────────────────
-- location_id     per-line venue, resolved Store column → merchant_adyen_accounts
--                 .store_id (fallback: the adyen_payments row's location). Lets
--                 one merchant-level batch be sliced per venue.
-- currency        the report's net currency (line amounts are minor units of it).
-- gratuity_minor  tip carried on the line, when the report includes the column.
alter table public.adyen_payout_lines add column if not exists location_id uuid;
alter table public.adyen_payout_lines add column if not exists currency text;
alter table public.adyen_payout_lines add column if not exists gratuity_minor bigint;
create index if not exists idx_adyen_payout_lines_location
  on public.adyen_payout_lines (location_id) where location_id is not null;

-- ── 4. Report queue: every REPORT_AVAILABLE lands here durably ───────────────
-- adyen-webhook inserts a row per announced report (settlement reports as
-- 'pending', anything else 'skipped') then kicks adyen-report-ingest, which
-- moves the row through pending → ingested | failed and records WHY on
-- failure. This is the durable failure ledger the ingest fn writes to AND the
-- status list its manual trigger serves — nothing about report handling lives
-- only in logs. Keyed on report_name: Adyen report file names are unique per
-- batch, so a webhook redelivery is a no-op insert.
create table if not exists public.adyen_reports (
  report_name       text primary key,          -- e.g. settlement_detail_report_batch_7.csv
  url               text,                      -- download URL from the webhook
  report_type       text,                      -- settlement_details | other
  status            text not null default 'pending',  -- pending | ingested | failed | skipped
  error             text,                      -- last failure, human-readable
  rows_parsed       integer,
  payments_updated  integer,
  payouts_upserted  integer,
  payments_missing  integer,                   -- report lines with no ledger row (pre-go-live psps)
  ingested_at       timestamptz,
  raw               jsonb,                     -- the REPORT_AVAILABLE notification item
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.adyen_reports enable row level security;  -- service-role only (no policies)

commit;
