-- v4.6.22 Multi-location reports — AMENDED for production schema discovery
-- Run in Supabase SQL Editor BEFORE deploying v4.6.22 app code to production.
-- Additive and idempotent — safe to re-run.
--
-- Schema reality discovered while running this in the POSUP prod DB:
--   user_locations.location_id  is uuid  (FK to locations.id)
--   user_profiles.location_id   is uuid
--   BUT: closed_checks.location_id and kds_tickets.location_id are TEXT
--        (same UUID values, stored as strings — pre-existing inconsistency
--        inherited from earlier schema work).
-- The RLS policies below therefore cast BOTH sides to ::text so the IN match
-- works regardless of whether a given deploy has uuid or text location_id
-- columns on the base tables. Casting uuid->text yields the canonical string
-- form, which matches the text-stored copies byte-for-byte.
--
-- Prior version of this file tried to compare uuid to text directly and
-- failed with '42883: operator does not exist: text = uuid'.
--
-- Adds a many-to-many user ↔ location junction so a single user can belong to
-- multiple sites. Preserves backward compatibility: existing user_profiles rows
-- are seeded into the junction as 'manager' role so nothing breaks on day one.

-- ── 1. Junction table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_locations (
  user_id     uuid        NOT NULL,
  location_id uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'manager' CHECK (role IN ('owner','manager','staff','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);

-- If the table was created previously without the role column (POSUP prod
-- case), add it idempotently.
ALTER TABLE user_locations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'manager'
    CHECK (role IN ('owner','manager','staff','viewer'));

CREATE INDEX IF NOT EXISTS idx_user_locations_user     ON user_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_locations_location ON user_locations(location_id);

COMMENT ON TABLE  user_locations IS 'Many-to-many user -> location mapping for multi-site owners. v4.6.22.';
COMMENT ON COLUMN user_locations.role IS 'owner | manager | staff | viewer. Controls report + settings visibility per location.';

-- ── 2. Seed from existing single-location profiles ────────────────────────────
INSERT INTO user_locations (user_id, location_id, role)
SELECT p.id, p.location_id, 'manager'
  FROM user_profiles p
 WHERE p.location_id IS NOT NULL
ON CONFLICT (user_id, location_id) DO NOTHING;

-- ── 3. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE user_locations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY user_locations_select_own
    ON user_locations FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Additive policy on closed_checks. Cast both sides to ::text so this works
-- whether location_id is text (POSUP prod) or uuid (greenfield environments).
DO $$ BEGIN
  CREATE POLICY closed_checks_select_by_user_locations
    ON closed_checks FOR SELECT
    USING (
      location_id::text IN (
        SELECT location_id::text FROM user_locations WHERE user_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY kds_tickets_select_by_user_locations
    ON kds_tickets FOR SELECT
    USING (
      location_id::text IN (
        SELECT location_id::text FROM user_locations WHERE user_id = auth.uid()
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Write policies (INSERT / UPDATE / DELETE) are intentionally NOT changed
-- here — scoped writes land in Wave 7 with the location switcher and role
-- permissions UI.

-- ── 4. Post-migration roadmap ─────────────────────────────────────────────────
-- Wave 7 will add:
--   - Location picker in the BO topbar (switches the "active" location used by
--     single-location reports and the POS itself).
--   - RLS writes scoped to active location with role-based permissions.
--   - user_locations management UI (owner can invite users to additional sites).
