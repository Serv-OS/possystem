-- v5.5.323: auto-refund to original card(s) for split payments and bar tabs
--
-- closed_checks previously stored a SINGLE stripe_payment_intent_id, which only
-- covered the one-card POS flow. Split payments can have multiple card portions
-- (each its own PaymentIntent), and bar tabs never stored one at all — so their
-- refunds fell back to a "refund manually in Stripe" warning.
--
-- This adds an additive, nullable jsonb array holding every card PaymentIntent
-- captured for the check: [{ id, amountMinor }]. The refund path normalises the
-- legacy single id + this array into one list and refunds across all of them.
-- Old rows (null) keep working via the single-id fallback.

ALTER TABLE closed_checks
  ADD COLUMN IF NOT EXISTS payment_intents jsonb;

COMMENT ON COLUMN closed_checks.payment_intents IS
  'Array of card PaymentIntents captured for this check: [{id, amountMinor}]. Populated for single-card, bar-tab, and each card portion of a split. Drives auto-refund to original card(s).';
