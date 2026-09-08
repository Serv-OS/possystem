-- 20260528_tenant_integrity_hardening.sql
-- v5.5.305–310 pre-launch tenant integrity hardening.
--
-- Applied directly to the Ops DB (tbetcegmszzotrwdtqhi) via the management API
-- during the fix session; recorded here for version control / reproducibility.
--
-- Context: a multi-tenant setup spans two databases — Ops DB (POS data:
-- organisations, locations, user_profiles) and Platform DB (companies,
-- locations.ops_location_id → company_id, loyalty, gift cards). Several legacy
-- gaps were found and fixed before the first customer.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. handle_new_user trigger
-- ──────────────────────────────────────────────────────────────────────────
-- The trigger that creates a public.user_profiles row on auth.users INSERT
-- previously wrote only (id, full_name, role) — it omitted email (so every
-- profile.email was null) and blanket-assigned role='owner' with the default
-- bo_access=true to EVERY user, including anonymous kiosk/online sessions.
--
-- Fixed to: copy email, and set bo_access=false for anonymous users so a
-- kiosk/online session can never be mistaken for a back-office login.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
begin
  insert into public.user_profiles (id, email, full_name, role, bo_access)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', new.email),
      coalesce(new.raw_user_meta_data->>'role', 'owner'),
      case when new.is_anonymous then false else true end
    )
  on conflict (id) do update set email = coalesce(public.user_profiles.email, excluded.email);
  return new;
end;
$fn$;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Backfills (data fixes for rows created before the above)
-- ──────────────────────────────────────────────────────────────────────────

-- 2a. Populate email on all real (non-anonymous) profiles from auth.users.
UPDATE public.user_profiles up
SET email = au.email
FROM auth.users au
WHERE au.id = up.id AND up.email IS NULL AND au.email IS NOT NULL;

-- 2b. Revoke bo_access on anonymous profiles (defense in depth — the app layer
--     also rejects anonymous sessions in the back office / admin portal).
UPDATE public.user_profiles up
SET bo_access = false
FROM auth.users au
WHERE au.id = up.id AND au.is_anonymous AND up.bo_access IS DISTINCT FROM false;

-- 2c. Backfill org_id from the user's primary location where it was null.
UPDATE public.user_profiles up
SET org_id = l.org_id
FROM public.locations l
WHERE l.id = up.location_id AND up.org_id IS NULL AND up.location_id IS NOT NULL;

-- 2d. Align denormalised org_id where it drifted from the primary location's org.
UPDATE public.user_profiles up
SET org_id = l.org_id
FROM public.locations l
WHERE l.id = up.location_id
  AND up.org_id IS NOT NULL AND l.org_id IS NOT NULL
  AND up.org_id <> l.org_id;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Platform DB note (yhzjgyrkyjabvhblqxzu)
-- ──────────────────────────────────────────────────────────────────────────
-- Every Ops location must have a Platform DB mirror row:
--   platform.locations(company_id, name, address, timezone, ops_location_id)
-- and its org must exist as platform.companies(id = ops org id, name, slug).
-- This is now created automatically by the `provision-location` edge function
-- (wired into both createLocation flows). The pre-existing location
-- "San Mateo 1" (ops da76f84b) + company "neil test org" were backfilled
-- manually. See supabase/functions/provision-location/index.ts.
