-- v5.5.326: multi-currency support (GBP / USD / EUR per location).
--
-- Platform DB only. Each location trades in one currency; the app reads this at
-- boot (locationTime.getLocationConfig + CustomerBoot) and formats all money +
-- Stripe charges accordingly. Defaults to GBP so existing venues are unchanged.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'GBP';

COMMENT ON COLUMN locations.currency IS
  'ISO currency code for this location (GBP/USD/EUR). Drives money formatting + Stripe charge currency.';
