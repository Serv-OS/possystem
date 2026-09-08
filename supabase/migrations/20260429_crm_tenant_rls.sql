-- ============================================================================
-- v5.5.6 — CRM TABLES TENANT RLS (extends 20260429_tenant_rls.sql)
-- ============================================================================
--
-- The v5.5.3 RLS migration covered every operational table (floor_tables,
-- active_sessions, closed_checks, kds_tickets, menus, menu_items, etc.) but
-- deliberately skipped the CRM trio (customers, customer_locations,
-- customer_orders) because their scope rules differ:
--
--   - customers          : ORG-scoped (one record per phone per organisation;
--                          dedupes across all locations of the same org)
--   - customer_locations : LOCATION-scoped (one row per customer per location
--                          they've ordered at; tracks visits + spend)
--   - customer_orders    : LOCATION-scoped (one row per closed_check)
--
-- This migration adds the appropriate policies for each table.
--
-- IDEMPOTENT: every CREATE POLICY is wrapped in DO $$ BEGIN ... EXCEPTION
-- WHEN duplicate_object THEN NULL; END $$. Safe to re-run. Builds on (does
-- not replace) 20260429_tenant_rls.sql.
--
-- BEFORE RUNNING:
--   1. Take a database snapshot in Supabase Dashboard → Database → Backups
--   2. Run 20260429_tenant_rls.sql first if you haven't already (this migration
--      depends on the user_accessible_locations() helper from that file)
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================


-- ── HELPER for the org-scoped customers table ────────────────────────────────
-- Customers don't have a location_id column — they belong to an org. The
-- helper below returns the orgs the user can access, derived from the
-- locations they belong to. Same author/grants as user_accessible_locations.

CREATE OR REPLACE FUNCTION public.user_accessible_orgs()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  -- v5.5.6: orgs the user may read/write CRM data for. Computed from the
  -- locations they have access to via user_locations + user_profiles.
  SELECT DISTINCT l.org_id::text
    FROM locations l
   WHERE l.id::text IN (SELECT public.user_accessible_locations());
$$;

COMMENT ON FUNCTION public.user_accessible_orgs() IS
  'v5.5.6: orgs the calling user may read/write CRM data for. Used by RLS on the customers table which is org-scoped.';


-- ── customers (ORG-scoped) ───────────────────────────────────────────────────

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY customers_rls_select ON customers FOR SELECT
    USING (org_id::text IN (SELECT public.user_accessible_orgs()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customers_rls_insert ON customers FOR INSERT
    WITH CHECK (org_id::text IN (SELECT public.user_accessible_orgs()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customers_rls_update ON customers FOR UPDATE
    USING (org_id::text IN (SELECT public.user_accessible_orgs()))
    WITH CHECK (org_id::text IN (SELECT public.user_accessible_orgs()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customers_rls_delete ON customers FOR DELETE
    USING (org_id::text IN (SELECT public.user_accessible_orgs()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── customer_locations (LOCATION-scoped) ─────────────────────────────────────

ALTER TABLE customer_locations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY customer_locations_rls_select ON customer_locations FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customer_locations_rls_insert ON customer_locations FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customer_locations_rls_update ON customer_locations FOR UPDATE
    USING (location_id::text IN (SELECT public.user_accessible_locations()))
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customer_locations_rls_delete ON customer_locations FOR DELETE
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── customer_orders (LOCATION-scoped) ────────────────────────────────────────

ALTER TABLE customer_orders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY customer_orders_rls_select ON customer_orders FOR SELECT
    USING (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY customer_orders_rls_insert ON customer_orders FOR INSERT
    WITH CHECK (location_id::text IN (SELECT public.user_accessible_locations()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── upsert_customer_visit RPC permission grant ───────────────────────────────
-- The atomic RPC has SECURITY DEFINER on it (presumably) so it bypasses RLS,
-- but the EXECUTE grant must include the authenticated role. v5.5.5 added a
-- read-modify-write fallback in app code for environments where the RPC
-- isn't grantable, but we want the RPC working when possible.

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.upsert_customer_visit(uuid, uuid, numeric, timestamptz)
    TO authenticated;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'upsert_customer_visit RPC does not exist with that signature — v5.5.5 fallback path will handle it. If you want the atomic RPC, run the v4.6.62-customer-crm.sql migration that creates it.';
WHEN OTHERS THEN
  RAISE NOTICE 'GRANT on upsert_customer_visit failed: %', SQLERRM;
END $$;


-- ============================================================================
-- TESTING
--
-- From an authenticated user that has access to Loc 1:
--
--   SELECT id, name, phone FROM customers WHERE phone = '+447xxxxx';
--   -- Expect: returns the customer record if it exists in your org
--
--   SELECT * FROM customer_locations WHERE customer_id = '<id>';
--   -- Expect: rows for every location of yours the customer has visited
--
-- From a user that has NO access to that org:
--
--   SELECT id, name, phone FROM customers WHERE phone = '+447xxxxx';
--   -- Expect: zero rows (RLS hides them)
--
--   INSERT INTO customers (org_id, phone, name) VALUES
--     ('<other_org>', '+447xxxxx', 'Hijack');
--   -- Expect: error 'new row violates row-level security policy'

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- DROP POLICY IF EXISTS customers_rls_select ON customers;
-- DROP POLICY IF EXISTS customers_rls_insert ON customers;
-- DROP POLICY IF EXISTS customers_rls_update ON customers;
-- DROP POLICY IF EXISTS customers_rls_delete ON customers;
-- ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
-- (repeat for customer_locations and customer_orders if needed)
--
-- The user_accessible_orgs() helper has no side effects and can stay.
