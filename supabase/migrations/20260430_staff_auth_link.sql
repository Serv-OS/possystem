-- ============================================================================
-- v5.5.17 — link staff_members → auth users + add bo_access flag (combined)
-- ============================================================================
--
-- Two related changes; bundled because they're both needed for the
-- 'add a back-office user' flow that lives on BO Staff & Access.
--
-- (1) staff_members.auth_user_id (text, nullable, unique)
--     References user_profiles.id (which is the same as auth.users.id).
--     Lets a single business person — a staff member at a location —
--     also have BO sign-in credentials. Optional: many staff stay
--     POS-PIN-only; only the operator/manager-tier ones need BO.
--
-- (2) user_profiles.bo_access (boolean, NOT NULL, default true)
--     Originally introduced in v5.5.15 (which placed the toggle UI on
--     the wrong page — the admin/super-admin area). Reverted from the
--     UI in v5.5.17 and re-homed in BO Staff & Access. The COLUMN
--     itself is unchanged from v5.5.15. If you've already run the
--     v5.5.15 migration this section is a no-op.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS for both. Safe to re-run.
-- Defaults preserve the pre-migration behaviour for existing rows.
--
-- BEFORE RUNNING:
--   1. Snapshot.
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================

-- (1) staff_members.auth_user_id
ALTER TABLE public.staff_members
  ADD COLUMN IF NOT EXISTS auth_user_id text;

-- Unique partial index — one staff_member can be linked to at most one auth
-- user, but most rows have NULL (POS-only staff, no BO access). Partial so
-- multiple NULLs are allowed.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS staff_members_auth_user_id_unique
    ON public.staff_members (auth_user_id)
    WHERE auth_user_id IS NOT NULL;
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

COMMENT ON COLUMN public.staff_members.auth_user_id IS
  'v5.5.17: links a POS staff member to a Supabase Auth user (user_profiles.id) so the same person can have both a POS PIN and back-office sign-in credentials. Optional — most rows stay NULL (POS-only).';

-- (2) user_profiles.bo_access — same as v5.5.15 migration; re-stated here
-- so this single file is sufficient if v5.5.15 was never applied.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS bo_access boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.bo_access IS
  'v5.5.15/v5.5.17: gates back-office access. super_admin role bypasses this flag. Default true so existing users preserve access; toggled per-user from BO Staff & Access (v5.5.17) or admin (super_admin only).';

-- ============================================================================
-- TEST after applying:
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'staff_members' AND column_name = 'auth_user_id';
--   -- Expect: text, YES (nullable), NULL default
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'user_profiles' AND column_name = 'bo_access';
--   -- Expect: boolean, NO (not nullable), true default
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS staff_members_auth_user_id_unique;
--   ALTER TABLE staff_members DROP COLUMN IF EXISTS auth_user_id;
--   ALTER TABLE user_profiles DROP COLUMN IF EXISTS bo_access;
-- ============================================================================
