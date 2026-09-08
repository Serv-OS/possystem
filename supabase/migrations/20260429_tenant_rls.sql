-- ============================================================================
-- v5.5.3 — DATABASE-LEVEL TENANT FENCE (RLS POLICIES)
-- ============================================================================
--
-- This migration locks down every location-scoped table so the database itself
-- refuses cross-tenant reads and writes. Even if application code is buggy or
-- a stale localStorage cache leaks data, postgres will not return Loc A's rows
-- to a Loc B user, and will not let a Loc B user write a Loc A row.
--
-- Builds on 20260422_multi_location.sql which added the user_locations junction
-- and SELECT-only policies for closed_checks + kds_tickets. This migration:
--   1. Ensures every location-scoped table has RLS ENABLED
--   2. Adds USING + WITH CHECK policies for SELECT, INSERT, UPDATE, DELETE
--   3. Scopes via user_locations (preferred) and user_profiles.location_id (fallback)
--   4. Casts both sides to ::text so it works whether location_id is uuid or text
--      (POSUP prod has text on closed_checks/kds_tickets, others are uuid)
--
-- IDEMPOTENT: every CREATE POLICY is wrapped in DO $$ BEGIN ... EXCEPTION
-- WHEN duplicate_object THEN NULL; END $$. Safe to re-run.
--
-- BEFORE RUNNING:
--   1. Take a database snapshot in Supabase Dashboard → Database → Backups
--   2. Verify the user running the migration has the postgres role (Supabase
--      SQL editor uses postgres by default — service-role JWT bypass is
--      independent of these policies)
--   3. Read the "TESTING AFTER MIGRATION" section at the bottom and run those
--      queries from a real authenticated session before declaring success
--
-- Project: tbetcegmszzotrwdtqhi  (RPOS Ops DB)
-- ============================================================================


-- ── HELPER: a single function returning the locations the current user may access
-- Inlining this in every policy is a maintenance burden, and PostgREST is fine
-- with policy-side function calls.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_accessible_locations()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  -- v5.5.3: Returns every location_id (as text for type compatibility) that
  -- the calling user can read/write. Both sources combined so legacy users
  -- who never got into user_locations still work.
  SELECT location_id::text FROM user_locations WHERE user_id = auth.uid()
  UNION
  SELECT location_id::text FROM user_profiles
    WHERE id = auth.uid() AND location_id IS NOT NULL;
$$;

COMMENT ON FUNCTION public.user_accessible_locations() IS
  'v5.5.3: locations the calling user may read/write. Used by RLS policies on every location-scoped table.';


-- ============================================================================
-- POLICIES
--
-- For each location-scoped table, four policies are added:
--   <table>_rls_select   USING ...
--   <table>_rls_insert   WITH CHECK ...
--   <table>_rls_update   USING ... WITH CHECK ...
--   <table>_rls_delete   USING ...
--
-- The USING clause filters which rows a user can see/touch.
-- The WITH CHECK clause enforces which location_id values they can write.
-- ============================================================================


-- ── floor_tables ─────────────────────────────────────────────────────────────

ALTER TABLE floor_tables ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY floor_tables_rls_select ON floor_tables FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY floor_tables_rls_insert ON floor_tables FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY floor_tables_rls_update ON floor_tables FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY floor_tables_rls_delete ON floor_tables FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── sections ─────────────────────────────────────────────────────────────────

ALTER TABLE sections ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY sections_rls_select ON sections FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY sections_rls_insert ON sections FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY sections_rls_update ON sections FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY sections_rls_delete ON sections FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── active_sessions (the open-orders leak) ───────────────────────────────────

ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY active_sessions_rls_select ON active_sessions FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY active_sessions_rls_insert ON active_sessions FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY active_sessions_rls_update ON active_sessions FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY active_sessions_rls_delete ON active_sessions FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── closed_checks (extending v4.6.22's SELECT-only policy with writes) ───────
-- The existing closed_checks_select_by_user_locations policy from
-- 20260422_multi_location.sql stays. We add INSERT / UPDATE / DELETE with the
-- same scoping so writes can no longer drop into the wrong location.

DO $$ BEGIN
  CREATE POLICY closed_checks_rls_insert ON closed_checks FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY closed_checks_rls_update ON closed_checks FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY closed_checks_rls_delete ON closed_checks FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── kds_tickets (extending v4.6.22 with writes) ──────────────────────────────

DO $$ BEGIN
  CREATE POLICY kds_tickets_rls_insert ON kds_tickets FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY kds_tickets_rls_update ON kds_tickets FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY kds_tickets_rls_delete ON kds_tickets FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── menus ────────────────────────────────────────────────────────────────────

ALTER TABLE menus ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY menus_rls_select ON menus FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menus_rls_insert ON menus FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menus_rls_update ON menus FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menus_rls_delete ON menus FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── menu_categories ──────────────────────────────────────────────────────────

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY menu_categories_rls_select ON menu_categories FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_categories_rls_insert ON menu_categories FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_categories_rls_update ON menu_categories FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_categories_rls_delete ON menu_categories FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── menu_items ───────────────────────────────────────────────────────────────

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY menu_items_rls_select ON menu_items FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_items_rls_insert ON menu_items FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_items_rls_update ON menu_items FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY menu_items_rls_delete ON menu_items FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── modifier_groups ──────────────────────────────────────────────────────────

ALTER TABLE modifier_groups ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY modifier_groups_rls_select ON modifier_groups FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY modifier_groups_rls_insert ON modifier_groups FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY modifier_groups_rls_update ON modifier_groups FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY modifier_groups_rls_delete ON modifier_groups FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── eighty_six ───────────────────────────────────────────────────────────────

ALTER TABLE eighty_six ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY eighty_six_rls_select ON eighty_six FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY eighty_six_rls_insert ON eighty_six FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY eighty_six_rls_update ON eighty_six FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY eighty_six_rls_delete ON eighty_six FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── config_pushes ────────────────────────────────────────────────────────────

ALTER TABLE config_pushes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY config_pushes_rls_select ON config_pushes FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY config_pushes_rls_insert ON config_pushes FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── printers ─────────────────────────────────────────────────────────────────

ALTER TABLE printers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY printers_rls_select ON printers FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY printers_rls_insert ON printers FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY printers_rls_update ON printers FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY printers_rls_delete ON printers FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── tax_rates ────────────────────────────────────────────────────────────────

ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tax_rates_rls_select ON tax_rates FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tax_rates_rls_insert ON tax_rates FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tax_rates_rls_update ON tax_rates FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY tax_rates_rls_delete ON tax_rates FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── device_profiles ──────────────────────────────────────────────────────────

ALTER TABLE device_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY device_profiles_rls_select ON device_profiles FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY device_profiles_rls_insert ON device_profiles FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY device_profiles_rls_update ON device_profiles FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY device_profiles_rls_delete ON device_profiles FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── devices ──────────────────────────────────────────────────────────────────
-- Note: the pairing flow (PairingScreen.handlePair) reads `devices` with the
-- pairing_code as the only filter. Pairing happens BEFORE the user is
-- authenticated to a specific location, so we keep SELECT permissive but
-- enforce WRITE scoping.

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY devices_rls_select_authed ON devices FOR SELECT
    USING (
      -- Once authenticated, only see devices at locations you have access to.
      -- Pre-auth pairing-code lookup is handled by the anonymous role bypass
      -- when the request comes from the pairing flow with no JWT subject.
      auth.uid() IS NULL OR
      location_id::text IN (SELECT public.user_accessible_locations())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY devices_rls_insert ON devices FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY devices_rls_update ON devices FOR UPDATE
    USING (
      auth.uid() IS NULL OR
      location_id::text IN (SELECT public.user_accessible_locations())
    )
    WITH CHECK (
      auth.uid() IS NULL OR
      location_id::text IN (SELECT public.user_accessible_locations())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY devices_rls_delete ON devices FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ============================================================================
-- TESTING AFTER MIGRATION (run from a real authenticated session, NOT the
-- service-role JWT — service role bypasses RLS by design).
-- ============================================================================

-- Test 1: positive — a user who has access to Loc 1 should see Loc 1's tables
-- Replace <user_id> + <loc_1_id> with real values.
--
-- SET request.jwt.claims = '{"sub":"<user_id>","role":"authenticated"}';
-- SELECT id, location_id, label FROM floor_tables LIMIT 10;
-- -- Expect: only Loc 1 rows
--
-- Test 2: negative — that same user should NOT see Loc 2's tables
--
-- SELECT id, label FROM floor_tables WHERE location_id = '<loc_2_id>';
-- -- Expect: zero rows (RLS hides them)
--
-- Test 3: write rejection — that same user attempting to write a Loc 2 row
-- should fail
--
-- INSERT INTO floor_tables (id, location_id, label, x, y) VALUES
--   ('test-rls', '<loc_2_id>', 'Test', 0, 0);
-- -- Expect: error "new row violates row-level security policy"
--
-- Test 4: cross-location upsert — the bug v5.5.2 fixed in app code is now also
-- structurally impossible. With the user authed for Loc 2, attempting to upsert
-- on a Loc 1 row's id will fail at the WITH CHECK level.
--
-- INSERT INTO floor_tables (id, location_id, label, x, y) VALUES
--   ('<existing-loc-1-id>', '<loc_2_id>', 'Hijack', 0, 0)
-- ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id;
-- -- Expect: error from the UPDATE side of WITH CHECK rejecting the move

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- If something breaks production, you can drop a specific table's policies
-- without touching the function:
--
-- DROP POLICY IF EXISTS floor_tables_rls_select ON floor_tables;
-- DROP POLICY IF EXISTS floor_tables_rls_insert ON floor_tables;
-- DROP POLICY IF EXISTS floor_tables_rls_update ON floor_tables;
-- DROP POLICY IF EXISTS floor_tables_rls_delete ON floor_tables;
-- ALTER TABLE floor_tables DISABLE ROW LEVEL SECURITY;
--
-- The function user_accessible_locations() is read-only and has no side
-- effects. It can stay regardless.
