-- v4.6.0 — Menu architecture foundations
-- Purely additive. All defaults preserve existing behaviour.
-- Read carefully before applying. Run in Supabase SQL editor against this project.
--
-- What this adds:
--   1. menu_items: scope, org_id, master_id, lock_pricing, locked_fields
--   2. menu_categories: scope, org_id, master_id, lock_pricing
--   3. menus: schedule (jsonb), priority (int), scope, org_id
--   4. menu_category_links: join table for "category in many menus" (in addition to existing menu_id)
--
-- Migration safety:
--   - All new columns nullable or have safe defaults
--   - No existing column dropped or renamed
--   - menu_categories.menu_id stays as the PRIMARY menu linkage (back-compat)
--   - menu_category_links is opt-in: if empty, system uses menu_id as today
--   - Existing reads/writes will work unchanged. POS code untouched.
--
-- Rollback: every change is wrapped in IF NOT EXISTS / IF EXISTS so re-running
-- this script is safe. To fully roll back, drop the new columns/tables manually.

BEGIN;

-- ============================================================
-- 1. menu_items: ownership scope
-- ============================================================
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS master_id text REFERENCES menu_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lock_pricing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE menu_items
  DROP CONSTRAINT IF EXISTS menu_items_scope_check;
ALTER TABLE menu_items
  ADD CONSTRAINT menu_items_scope_check
  CHECK (scope IN ('local', 'shared', 'global', 'override'));

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_menu_items_org_id ON menu_items(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_master_id ON menu_items(master_id) WHERE master_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_scope ON menu_items(scope);

COMMENT ON COLUMN menu_items.scope IS 'Ownership: local|shared|global|override. local=this location only. shared=visible to all locations in org, each can override. global=managed centrally, locations cannot override. override=child row pointing at master_id, holds per-location field overrides.';
COMMENT ON COLUMN menu_items.org_id IS 'Required when scope IN (shared, global). Null for local items.';
COMMENT ON COLUMN menu_items.master_id IS 'Required when scope=override. Points at the parent shared/global item this row overrides.';
COMMENT ON COLUMN menu_items.lock_pricing IS 'Master-only flag. If true on a shared/global item, child locations cannot create override rows that change pricing.';
COMMENT ON COLUMN menu_items.locked_fields IS 'Master-only. Array of field names that cannot be overridden, e.g. ["pricing","name"]. Granular alternative to lock_pricing.';

-- ============================================================
-- 2. menu_categories: ownership scope
-- ============================================================
ALTER TABLE menu_categories
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS master_id text REFERENCES menu_categories(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lock_pricing boolean NOT NULL DEFAULT false;

ALTER TABLE menu_categories
  DROP CONSTRAINT IF EXISTS menu_categories_scope_check;
ALTER TABLE menu_categories
  ADD CONSTRAINT menu_categories_scope_check
  CHECK (scope IN ('local', 'shared', 'global', 'override'));

CREATE INDEX IF NOT EXISTS idx_menu_categories_org_id ON menu_categories(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_categories_master_id ON menu_categories(master_id) WHERE master_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_categories_scope ON menu_categories(scope);

-- ============================================================
-- 3. menus: schedule, priority, scope
-- ============================================================
ALTER TABLE menus
  ADD COLUMN IF NOT EXISTS schedule jsonb,
  ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organisations(id) ON DELETE CASCADE;

ALTER TABLE menus
  DROP CONSTRAINT IF EXISTS menus_scope_check;
ALTER TABLE menus
  ADD CONSTRAINT menus_scope_check
  CHECK (scope IN ('local', 'shared', 'global'));

CREATE INDEX IF NOT EXISTS idx_menus_org_id ON menus(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menus_priority ON menus(priority);

COMMENT ON COLUMN menus.schedule IS 'Optional jsonb: { "monday": [{"from":"09:00","to":"22:00"}], "tuesday": [...], ... } 24h local time. Null = always active.';
COMMENT ON COLUMN menus.priority IS 'When two scheduled menus overlap, higher priority wins. Default 0.';

-- ============================================================
-- 4. menu_category_links: many-to-many between menus and categories
-- ============================================================
-- This is the join that lets one category appear in multiple menus
-- without duplication. menu_categories.menu_id stays as the PRIMARY menu
-- (the one this category was originally created in / belongs to natively).
-- This table holds ALL menu memberships including the primary, redundantly,
-- so reads can use a single source of truth.

CREATE TABLE IF NOT EXISTS menu_category_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         text NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  category_id     text NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  sort_order      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_mcl_menu_id ON menu_category_links(menu_id);
CREATE INDEX IF NOT EXISTS idx_mcl_category_id ON menu_category_links(category_id);

COMMENT ON TABLE menu_category_links IS 'Join table: a category can appear in many menus. v4.6.0 adds this; existing menu_categories.menu_id stays as the primary linkage. v4.6.3 will start populating this from the new Menus tab UI.';

-- Backfill: every existing (category, primary menu_id) becomes a link row.
-- This makes the join table the source of truth from day one for categories
-- already linked into a menu via the legacy menu_id column.
INSERT INTO menu_category_links (menu_id, category_id, sort_order)
SELECT menu_id, id, COALESCE(sort_order, 0)
FROM menu_categories
WHERE menu_id IS NOT NULL
ON CONFLICT (menu_id, category_id) DO NOTHING;

-- ============================================================
-- 5. RLS — match existing patterns on these tables
-- ============================================================
-- Existing tables already have RLS enabled. New columns inherit.
-- New table menu_category_links needs explicit RLS to match menu_categories.

ALTER TABLE menu_category_links ENABLE ROW LEVEL SECURITY;

-- Mirror the existing menu_categories / menu_items / menus policy: single
-- "allow all" rule for the public role so the publishable key (anon) can
-- read and write. If the rest of the schema gets locked down later, harden
-- this table at the same time so the model stays consistent.
DROP POLICY IF EXISTS "menu_category_links: read" ON menu_category_links;
DROP POLICY IF EXISTS "menu_category_links: write" ON menu_category_links;
DROP POLICY IF EXISTS "allow all" ON menu_category_links;
CREATE POLICY "allow all"
  ON menu_category_links FOR ALL
  TO public
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_category_links TO anon, authenticated;

COMMIT;

-- ============================================================
-- Post-migration verification queries (run these manually to confirm)
-- ============================================================
-- 1. New columns exist:
--    SELECT column_name, data_type, column_default FROM information_schema.columns
--      WHERE table_name = 'menu_items' AND column_name IN ('scope','org_id','master_id','lock_pricing','locked_fields');
--    Expect 5 rows.
--
-- 2. Existing items defaulted to scope='local':
--    SELECT scope, count(*) FROM menu_items GROUP BY scope;
--    Expect a single row: ('local', <total item count>).
--
-- 3. Backfill worked:
--    SELECT count(*) FROM menu_category_links;
--    Should equal: SELECT count(*) FROM menu_categories WHERE menu_id IS NOT NULL;
--
-- 4. POS still loads cleanly:
--    Open dev.pos-up.com — items, categories, menus all show as before.
--
-- 5. New columns are queryable via REST:
--    GET /rest/v1/menu_items?select=id,scope,org_id&limit=1
--    Should return rows with scope:'local', org_id:null.
