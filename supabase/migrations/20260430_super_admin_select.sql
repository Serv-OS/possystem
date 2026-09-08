-- ============================================================================
-- v5.5.14 — super_admin SELECT-all on user_profiles (defensive)
-- ============================================================================
--
-- The CompanyAdminApp super-admin UI needs to load every user_profiles row
-- so the location-access picker can grant any user access to any location
-- in any organisation. Pre-v5.5.14 the picker only loaded users whose
-- user_profiles.org_id matched the currently-selected org — meaning a
-- brand-new org with no users yet had nothing to pick from, and even
-- existing super-admins (whose own user_profiles row points at their
-- original org) couldn't be granted to other orgs.
--
-- This migration adds an additive RLS policy: any authenticated user whose
-- own user_profiles.role = 'super_admin' may SELECT every user_profiles
-- row. Standard users (role != 'super_admin') retain whatever existing
-- read access policy applies — no demotion.
--
-- IDEMPOTENT: DO ... EXCEPTION WHEN duplicate_object. Safe to re-run.
--
-- BEFORE RUNNING:
--   1. Take a database snapshot.
--   2. Confirm that user_profiles.role exists as a column with a row
--      for the super-admin where role = 'super_admin'.
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================

-- Helper: check whether the calling user has super_admin role.
-- Cached via stable function so subsequent policy evaluations within the
-- same query don't re-query user_profiles.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role = 'super_admin' FROM user_profiles WHERE id = auth.uid()),
    false
  );
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'v5.5.14: returns true if the calling user has super_admin role. Used by RLS policies that grant platform-wide access. SECURITY DEFINER so the inner read never recurses into the same RLS policy.';

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'GRANT on is_super_admin failed: %', SQLERRM;
END $$;

-- Permissive ADDITIONAL policy on user_profiles for super_admins.
-- Coexists with whatever scoped policy is already there for non-admins.
DO $$ BEGIN
  CREATE POLICY user_profiles_super_admin_select_all
    ON user_profiles FOR SELECT
    USING (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same treatment for user_locations: super_admin can SEE every junction row
-- so they can know who has access to where, AND insert/update/delete to
-- grant or revoke from any user-location pair.
DO $$ BEGIN
  CREATE POLICY user_locations_super_admin_select_all
    ON user_locations FOR SELECT
    USING (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY user_locations_super_admin_insert
    ON user_locations FOR INSERT
    WITH CHECK (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY user_locations_super_admin_update
    ON user_locations FOR UPDATE
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY user_locations_super_admin_delete
    ON user_locations FOR DELETE
    USING (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Same for organisations + locations: super_admin can see every org and
-- every location across the platform.
DO $$ BEGIN
  CREATE POLICY organisations_super_admin_select_all
    ON organisations FOR SELECT
    USING (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY locations_super_admin_select_all
    ON locations FOR SELECT
    USING (public.is_super_admin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- TEST after applying:
--
-- As a user whose user_profiles.role = 'super_admin':
--   SELECT count(*) FROM user_profiles;
--   -- Expect: total platform user count, not just self
--
-- As a regular user:
--   SELECT count(*) FROM user_profiles;
--   -- Expect: same as before this migration (their own row + any other
--   -- rows allowed by the pre-existing policy)
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS user_profiles_super_admin_select_all ON user_profiles;
--   DROP POLICY IF EXISTS user_locations_super_admin_select_all ON user_locations;
--   DROP POLICY IF EXISTS user_locations_super_admin_insert ON user_locations;
--   DROP POLICY IF EXISTS user_locations_super_admin_update ON user_locations;
--   DROP POLICY IF EXISTS user_locations_super_admin_delete ON user_locations;
--   DROP POLICY IF EXISTS organisations_super_admin_select_all ON organisations;
--   DROP POLICY IF EXISTS locations_super_admin_select_all ON locations;
--   DROP FUNCTION IF EXISTS public.is_super_admin();
-- ============================================================================
