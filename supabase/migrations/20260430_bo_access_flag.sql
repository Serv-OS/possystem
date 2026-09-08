-- ============================================================================
-- v5.5.15 — bo_access flag on user_profiles
-- ============================================================================
--
-- Adds a boolean 'bo_access' column on user_profiles that gates whether a
-- user can sign in to the back office at all. Pre-v5.5.15 there was no
-- gate — anyone with valid Supabase Auth credentials could reach the BO.
-- The role column described what they WERE (owner / manager / staff /
-- viewer / super_admin) but not what they could ACCESS.
--
-- Behavior:
--   - bo_access = true  → user passes the BackOfficeApp gate
--   - bo_access = false → user sees "no back-office access" page
--   - super_admin always passes regardless of flag (admin gate stays)
--
-- BACKFILL strategy: every existing user gets bo_access = true. Any user
-- created before this migration was already free to access the BO, so
-- preserving that for backwards compat avoids surprise lockouts. New
-- users created via CompanyAdmin can have it explicitly set or unset.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, default true so backfill is implicit.
--
-- BEFORE RUNNING:
--   1. Snapshot.
--   2. Confirm user_profiles exists.
--
-- Project: tbetcegmszzotrwdtqhi (RPOS Ops DB)
-- ============================================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS bo_access boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_profiles.bo_access IS
  'v5.5.15: gates back-office access. super_admin role bypasses this flag. Default true so existing users preserve access; toggle off via CompanyAdmin to revoke.';

-- Optional: backfill explicitly to false for any user whose role is not in
-- the BO-accessing set. Skipped by default — operators can toggle via UI.
-- Uncomment if you want a stricter starting state:
--   UPDATE user_profiles SET bo_access = false
--   WHERE role NOT IN ('owner','manager','super_admin');

-- ============================================================================
-- TEST after applying:
--
--   SELECT id, email, role, bo_access FROM user_profiles ORDER BY email;
--   -- Expect: every existing user has bo_access = true.
--
--   UPDATE user_profiles SET bo_access = false WHERE email = 'test@example.com';
--   SELECT bo_access FROM user_profiles WHERE email = 'test@example.com';
--   -- Expect: false
--
-- ROLLBACK:
--   ALTER TABLE user_profiles DROP COLUMN IF EXISTS bo_access;
-- ============================================================================
