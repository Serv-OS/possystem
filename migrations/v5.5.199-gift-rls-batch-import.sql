-- v5.5.199 — Gift Cards: RLS fix, batch/import support, branding
--
-- Run on: Platform DB (yhzjgyrkyjabvhblqxzu)
--
-- Fixes:
--   1. gift_brand_config only had SELECT for authenticated users — BO couldn't
--      toggle enabled or save settings. Adds INSERT/UPDATE policies.
--   2. gift_cards needs batch_id and source columns for bulk create + import.

-- ── 1. Fix RLS on gift_brand_config ─────────────────────────────────────────
-- Allow authenticated users in the same company to INSERT (first-time setup)
CREATE POLICY gift_brand_config_insert ON gift_brand_config
  FOR INSERT TO authenticated
  WITH CHECK (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ));

-- Allow authenticated users in the same company to UPDATE
CREATE POLICY gift_brand_config_update ON gift_brand_config
  FOR UPDATE TO authenticated
  USING (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ))
  WITH CHECK (company_id IN (
    SELECT company_id FROM user_company_roles WHERE user_id = auth.uid()
  ));

-- ── 2. Batch/import columns on gift_cards ───────────────────────────────────
-- batch_id groups cards created together (bulk create or import)
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS batch_name text;
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual'
  CHECK (source IN ('manual', 'online', 'bulk', 'import'));

CREATE INDEX IF NOT EXISTS idx_gift_cards_batch
  ON gift_cards (batch_id) WHERE batch_id IS NOT NULL;

-- ── 3. Add gift-specific branding to gift_brand_config ──────────────────────
-- Per-feature branding (independent of online_branding on locations)
ALTER TABLE gift_brand_config ADD COLUMN IF NOT EXISTS branding jsonb;

COMMENT ON COLUMN gift_brand_config.branding IS
  'Per-feature branding for gift card pages: { logo_url, hero_url, accent_color, background, foreground }. Falls back to location.online_branding if null.';

COMMENT ON COLUMN gift_cards.batch_id IS 'Groups cards from the same bulk-create or import operation';
COMMENT ON COLUMN gift_cards.batch_name IS 'User-defined label for the batch (e.g. "Christmas 2026 promo")';
COMMENT ON COLUMN gift_cards.source IS 'How the card was created: manual (BO issue), online (customer purchase), bulk (batch create), import (CSV/external)';
