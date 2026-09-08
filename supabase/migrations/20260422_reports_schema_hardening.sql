-- v4.6.19 Reports schema hardening
-- Run in Supabase SQL Editor BEFORE deploying v4.6.19 app code to production.
-- Safe to run multiple times (all operations use IF NOT EXISTS).
--
-- Adds two columns to closed_checks so reports can rely on stored values
-- instead of deriving them:
--   1. tax_amount — stored at close time (fixes fragility where tax was derived as
--                   total - subtotal - service - tip; breaks down with complex
--                   service charges or inclusive tax setups)
--   2. staff_id   — FK to staff_members.id. Fixes the tip pool role lookup which
--                   currently matches by staff name (breaks on rename / typo).
--
-- Both columns are NULLABLE. Historical rows stay NULL; app code falls back to
-- the existing derivation when NULL. No data migration required.
--
-- Future migrations (documented for roadmap, NOT executed here):
--   ALTER TABLE staff_members ADD COLUMN hourly_rate numeric(8,2);
--   ALTER TABLE menu_items    ADD COLUMN cost        numeric(10,2);
--   CREATE TABLE shift_sessions (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     staff_id uuid REFERENCES staff_members(id) ON DELETE SET NULL,
--     location_id uuid REFERENCES locations(id)  ON DELETE CASCADE,
--     clock_in  timestamptz NOT NULL,
--     clock_out timestamptz,
--     hours_worked numeric(6,2),
--     created_at timestamptz DEFAULT now()
--   );
--   CREATE TABLE tip_pool_rules (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
--     name text NOT NULL,
--     mode text NOT NULL CHECK (mode IN ('none','tipout','shared')),
--     config jsonb NOT NULL DEFAULT '{}'::jsonb,
--     active boolean NOT NULL DEFAULT true,
--     created_at timestamptz DEFAULT now()
--   );
--   CREATE TABLE user_locations (
--     user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
--     location_id uuid REFERENCES locations(id)  ON DELETE CASCADE,
--     role        text,
--     PRIMARY KEY (user_id, location_id)
--   );

ALTER TABLE closed_checks
  ADD COLUMN IF NOT EXISTS tax_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS staff_id   uuid REFERENCES staff_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_closed_checks_staff_id
  ON closed_checks(staff_id)
  WHERE staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_closed_checks_location_closed_at
  ON closed_checks(location_id, closed_at DESC);

-- Optional backfill for tax_amount using the previous derivation formula.
-- Commented out by default — uncomment and run manually if you want historical
-- rows to have tax_amount populated. Clamped at 0 so negative derivations
-- (from rounding or odd service charge setups) don't write bad data.
--
-- UPDATE closed_checks
--    SET tax_amount = GREATEST(0, COALESCE(total,0) - COALESCE(subtotal,0) - COALESCE(service,0) - COALESCE(tip,0))
--  WHERE tax_amount IS NULL
--    AND status = 'paid';

COMMENT ON COLUMN closed_checks.tax_amount IS 'Tax charged on this check, stored at close time. NULL for pre-v4.6.19 rows; reports fall back to total-subtotal-service-tip derivation.';
COMMENT ON COLUMN closed_checks.staff_id   IS 'FK to staff_members. Populated from v4.6.19. NULL for pre-v4.6.19 rows; tip pool falls back to staff name match.';
