-- v5.7.3 — SERVOS PAYMENTS TIERED RATE CARD (PLATFORM DB yhzjgyrkyjabvhblqxzu)
-- ⚠ HAND-APPLY (production DDL is blocked for tooling): pbcopy < this file → SQL editor.
--
-- Replaces the flat v5.7.0 markup with the four-tier pricing model every
-- competitor uses (Peter, 19 Aug): one fee for card-present credit AND debit,
-- another for card-not-present (online orders), another for American Express
-- and business/commercial cards, another for manually keyed (MOTO) payments.
--
-- Everything here is additive: no defaults change, no constraints tighten,
-- nothing rewrites existing rows. Safe to apply while traffic flows. Every
-- function that touches the new columns retries without them, so deploy order
-- does not matter.

begin;

-- ── 1. Per-venue rate card ───────────────────────────────────────────────────
-- Shape: { "card_present":     { "percent": 1.4,  "fixed_pence": 5 },
--          "card_not_present": { "percent": 1.9,  "fixed_pence": 10 },
--          "amex":             { "percent": 2.5,  "fixed_pence": 10 },
--          "keyed":            { "percent": 2.9,  "fixed_pence": 15 } }
-- Any tier (or field) may be null = fall back to the platform default card.
-- The old flat markup_percent / markup_fixed_pence columns are KEPT and read
-- as the legacy fallback: they count as the card_present tier until a rate
-- card exists, so every rate entered under v5.7.0 keeps working unchanged.
alter table public.merchant_adyen_accounts
  add column if not exists rate_card jsonb;

-- ── 2. Platform default rate card (same shape) ──────────────────────────────
-- Per-tier fallback for venues without their own entry. The old flat
-- default_adyen_markup_percent / _fixed_pence columns are kept as the legacy
-- card_present fallback beneath it.
alter table public.platform_settings
  add column if not exists default_adyen_rate_card jsonb;

-- ── 3. Payment classification + commission stamp ────────────────────────────
-- rate_category    which of the four tiers this payment falls into, stamped by
--                  adyen-webhook when the AUTHORISATION arrives (and re-stamped
--                  by the ?backfill=1 replay): 'card_present' |
--                  'card_not_present' | 'amex' | 'keyed'. Null = written before
--                  this migration and not yet backfilled.
-- commission_minor what ServOS earns on this payment in minor units: the
--                  venue's resolved tier rate applied to amount_minor (round
--                  half up), computed at classify time. RECOMPUTED (never
--                  incremented) on every AUTHORISATION re-apply, so the
--                  backfill is idempotent. Null = no rate was configured for
--                  the tier when the payment was classified, or a declined
--                  payment.
alter table public.adyen_payments
  add column if not exists rate_category text;
alter table public.adyen_payments
  add column if not exists commission_minor bigint;

commit;
