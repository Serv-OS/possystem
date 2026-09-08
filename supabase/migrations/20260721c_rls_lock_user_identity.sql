-- 20260721c_rls_lock_user_identity.sql
-- Ops DB (tbetcegmszzotrwdtqhi) — lock the ROOT of the tenant trust chain.
--
-- Closes two confirmed live privilege-escalation paths reachable by any member
-- of the public via supabase.auth.signInAnonymously():
--   (a) write user_profiles.role = 'super_admin'  -> is_super_admin() = true
--   (b) insert user_locations row                 -> pos_can_access() = true
-- Both defeat every "pos_can_access(location_id) or is_super_admin()" policy
-- in the database.
--
-- DEFENCE IN DEPTH — five independent layers, each catching what the others miss:
--   L0 trigger on auth.users (handle_new_user)  — row-creation escalation
--   L1 table + column privileges                — privilege can't be re-granted by a bad policy
--   L2 RLS policies                             — row scoping
--   L3 BEFORE triggers                          — column-value invariants a policy can't express
--   L4 CHECK constraint + FK                    — data-shape floor
--
-- NOTE ON "anon": a Supabase ANONYMOUS SIGN-IN produces a JWT with
-- role = "authenticated" and is_anonymous = true. It is NOT the `anon` DB role.
-- Revoking `anon` therefore closes the raw-anon-key path only; the anonymous
-- SESSION is fenced by the is_anonymous claim checks in L2/L3.
--
-- Functions use CREATE OR REPLACE, not DROP+CREATE: policies across the whole
-- database depend on is_super_admin()/user_accessible_locations(), so DROP would
-- fail. Every policy, trigger and constraint IS preceded by DROP ... IF EXISTS.

begin;

-- ══════════════════════════════════════════════════════════════════════════
-- L0. Row-creation escalation: handle_new_user honours client meta-data
-- ══════════════════════════════════════════════════════════════════════════
-- raw_user_meta_data is fully client-controlled:
--   signInAnonymously({ options: { data: { role: 'super_admin' } } })
-- and the trigger is SECURITY DEFINER, so it bypasses RLS entirely. No policy
-- change can close this. The role passthrough is removed outright.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
begin
  insert into public.user_profiles (id, email, full_name, role, bo_access)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', new.email),
      -- role is NEVER taken from client-supplied metadata. Elevation is done
      -- afterwards by the create-user edge function (service_role, super_admin
      -- gated) or by an operator in SQL.
      case when new.is_anonymous then 'anon' else 'owner' end,
      case when new.is_anonymous then false else true end
    )
  on conflict (id) do update set email = coalesce(public.user_profiles.email, excluded.email);
  return new;
end;
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- Helpers
-- ══════════════════════════════════════════════════════════════════════════

-- True when the caller's JWT is an anonymous sign-in.
CREATE OR REPLACE FUNCTION public.is_anon_session()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean,
    false
  );
$$;

-- True when the statement is running as a trusted server identity
-- (migration/psql, a SECURITY DEFINER function owned by postgres, or a
-- service_role edge function). Used by the L3 triggers as the escape hatch.
CREATE OR REPLACE FUNCTION public.is_privileged_ctx()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_user IN ('postgres','supabase_admin','supabase_auth_admin','service_role')
      OR coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$$;

-- Unchanged semantics, plus: an anonymous session can never be super_admin,
-- regardless of what its profile row says.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT public.is_anon_session()
     AND COALESCE(
           (SELECT role = 'super_admin' FROM public.user_profiles WHERE id = auth.uid()),
           false
         );
$$;

-- Was SECURITY INVOKER. Every tenant policy in the DB resolves through this,
-- so it must not be able to fail-closed (or recurse) because of a policy on
-- user_locations. Body preserved EXACTLY as observed live (user_locations only
-- — see the migration notes about the repo's UNION variant).
CREATE OR REPLACE FUNCTION public.user_accessible_locations()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT location_id::text FROM public.user_locations WHERE user_id = auth.uid();
$$;

-- Can the caller claim a freshly-created location? (used by the BO
-- "Company Admin -> create location" self-grant). SECURITY DEFINER so the
-- lookup does not recurse into user_locations' own RLS policies.
CREATE OR REPLACE FUNCTION public.can_claim_location(p_location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT public.is_anon_session()
     AND NOT EXISTS (SELECT 1 FROM public.user_locations ul WHERE ul.location_id = p_location_id)
     AND EXISTS (
           SELECT 1
           FROM public.locations l
           JOIN public.user_profiles up ON up.id = auth.uid()
           WHERE l.id = p_location_id
             AND up.org_id IS NOT NULL
             AND l.org_id = up.org_id
         );
$$;

REVOKE ALL ON FUNCTION public.is_anon_session()               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_privileged_ctx()             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_claim_location(uuid)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_anon_session()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_privileged_ctx()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_claim_location(uuid)     TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- L1. Table + column privileges
-- ══════════════════════════════════════════════════════════════════════════
-- A permissive policy can only permit what the GRANT already allows. With
-- UPDATE granted per-column, no policy mistake — however broad — can let a
-- browser session write role / bo_access / email / id.

REVOKE ALL ON TABLE public.user_profiles  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_locations FROM PUBLIC, anon, authenticated;

-- Reads: whole row. `role` MUST stay readable — it is the super_admin gate in
-- CompanyAdminApp and BackOfficeApp, and other tables' policies subquery it.
GRANT SELECT ON public.user_profiles TO authenticated;
-- Writes: three non-privileged columns. No INSERT (rows come from the trigger).
GRANT UPDATE (location_id, org_id, full_name) ON public.user_profiles TO authenticated;
-- Super-admin org teardown deletes profile rows from the browser.
GRANT DELETE ON public.user_profiles TO authenticated;

GRANT SELECT ON public.user_locations TO authenticated;
GRANT INSERT (user_id, location_id, role) ON public.user_locations TO authenticated;
GRANT UPDATE (role) ON public.user_locations TO authenticated;
GRANT DELETE ON public.user_locations TO authenticated;

-- `anon` (raw anon key, no session) keeps nothing on either table.

-- ══════════════════════════════════════════════════════════════════════════
-- L2. RLS policies
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

-- The vulnerability itself.
DROP POLICY IF EXISTS "allow all"                 ON public.user_profiles;
DROP POLICY IF EXISTS "Allow authenticated access" ON public.user_profiles;
DROP POLICY IF EXISTS "user_locations_admin_write" ON public.user_locations;
-- Legacy / partially-applied policies we are replacing.
DROP POLICY IF EXISTS "users read own profile"    ON public.user_profiles;
DROP POLICY IF EXISTS "users update own profile"  ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_super_admin_select_all  ON public.user_profiles;
DROP POLICY IF EXISTS user_locations_select_own             ON public.user_locations;
DROP POLICY IF EXISTS user_locations_super_admin_select_all ON public.user_locations;
DROP POLICY IF EXISTS user_locations_super_admin_insert     ON public.user_locations;
DROP POLICY IF EXISTS user_locations_super_admin_update     ON public.user_locations;
DROP POLICY IF EXISTS user_locations_super_admin_delete     ON public.user_locations;
-- This migration's own policies (idempotent re-run).
DROP POLICY IF EXISTS up_select_self          ON public.user_profiles;
DROP POLICY IF EXISTS up_select_super_admin   ON public.user_profiles;
DROP POLICY IF EXISTS up_update_self          ON public.user_profiles;
DROP POLICY IF EXISTS up_update_super_admin   ON public.user_profiles;
DROP POLICY IF EXISTS up_delete_super_admin   ON public.user_profiles;
DROP POLICY IF EXISTS ul_select_self          ON public.user_locations;
DROP POLICY IF EXISTS ul_select_super_admin   ON public.user_locations;
DROP POLICY IF EXISTS ul_insert_super_admin   ON public.user_locations;
DROP POLICY IF EXISTS ul_insert_self_claim    ON public.user_locations;
DROP POLICY IF EXISTS ul_update_self          ON public.user_locations;
DROP POLICY IF EXISTS ul_update_super_admin   ON public.user_locations;
DROP POLICY IF EXISTS ul_delete_self          ON public.user_locations;
DROP POLICY IF EXISTS ul_delete_super_admin   ON public.user_locations;

-- ── user_profiles ─────────────────────────────────────────────────────────
-- Own row, any session type (incl. anonymous). Required by: BO login,
-- LocationSwitcher, StaffManager, the admin-portal super_admin gate,
-- getLocationId() on kiosk/online/QR, AND by other tables' policies that
-- subquery `select org_id from user_profiles where id = auth.uid()`.
CREATE POLICY up_select_self ON public.user_profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY up_select_super_admin ON public.user_profiles
  FOR SELECT USING (public.is_super_admin());

-- Own row, never anonymous. Columns are already fenced by L1 to
-- (location_id, org_id, full_name).
CREATE POLICY up_update_self ON public.user_profiles
  FOR UPDATE
  USING (id = auth.uid() AND NOT public.is_anon_session())
  WITH CHECK (id = auth.uid() AND NOT public.is_anon_session());

-- Cross-user location_id writes from the admin portal (assign / clear on
-- location teardown).
CREATE POLICY up_update_super_admin ON public.user_profiles
  FOR UPDATE USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

CREATE POLICY up_delete_super_admin ON public.user_profiles
  FOR DELETE USING (public.is_super_admin());

-- No INSERT policy anywhere: rows are created only by handle_new_user.

-- ── user_locations ────────────────────────────────────────────────────────
CREATE POLICY ul_select_self ON public.user_locations
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY ul_select_super_admin ON public.user_locations
  FOR SELECT USING (public.is_super_admin());

-- The ONE legitimate self-grant: BO "create location" claiming a location that
-- belongs to the caller's org and that nobody holds yet.
CREATE POLICY ul_insert_self_claim ON public.user_locations
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND NOT public.is_anon_session()
    AND role = 'owner'
    AND public.can_claim_location(location_id)
  );

CREATE POLICY ul_insert_super_admin ON public.user_locations
  FOR INSERT WITH CHECK (public.is_super_admin());

-- Needed because the client upsert is ON CONFLICT DO UPDATE.
CREATE POLICY ul_update_self ON public.user_locations
  FOR UPDATE
  USING (user_id = auth.uid() AND NOT public.is_anon_session())
  WITH CHECK (user_id = auth.uid() AND NOT public.is_anon_session());

CREATE POLICY ul_update_super_admin ON public.user_locations
  FOR UPDATE USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

CREATE POLICY ul_delete_self ON public.user_locations
  FOR DELETE USING (user_id = auth.uid() AND NOT public.is_anon_session());

CREATE POLICY ul_delete_super_admin ON public.user_locations
  FOR DELETE USING (public.is_super_admin());

-- ══════════════════════════════════════════════════════════════════════════
-- L3. BEFORE triggers — column-value invariants
-- ══════════════════════════════════════════════════════════════════════════
-- These fire regardless of RLS and regardless of GRANTs. They are the layer
-- that survives someone later re-adding a `USING (true)` policy or re-running
-- `GRANT ALL ... TO authenticated` from the dashboard.

CREATE OR REPLACE FUNCTION public.guard_user_profiles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF public.is_privileged_ctx() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Deliberately CLAMPS rather than raises: this path also covers any future
    -- signup trigger. An outage here would stop all kiosk/online sign-ins.
    IF NEW.role = 'super_admin' THEN
      NEW.role := 'owner';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users u WHERE u.id = NEW.id AND u.is_anonymous) THEN
      NEW.role := 'anon';
      NEW.bo_access := false;
    END IF;
    RETURN NEW;
  END IF;

  IF public.is_anon_session() THEN
    RAISE EXCEPTION 'user_profiles: anonymous sessions cannot modify profiles'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'user_profiles: only super_admin may delete profiles'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE. No client, super_admin or not, may move a privileged column.
  -- Elevation happens only via service_role (create-user) or set_bo_access().
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'user_profiles: id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'user_profiles: role can only be changed server-side'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.bo_access IS DISTINCT FROM OLD.bo_access THEN
    RAISE EXCEPTION 'user_profiles: bo_access can only be changed via set_bo_access()'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'user_profiles: email can only be changed server-side'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id AND OLD.org_id IS NOT NULL THEN
    RAISE EXCEPTION 'user_profiles: org_id can only be set once, server-side thereafter'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_user_profiles ON public.user_profiles;
CREATE TRIGGER trg_guard_user_profiles
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_profiles();

CREATE OR REPLACE FUNCTION public.guard_user_locations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF public.is_privileged_ctx() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF public.is_anon_session() THEN
    RAISE EXCEPTION 'user_locations: anonymous sessions cannot be granted location access'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'user_locations: cannot grant access to another user'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.user_id = auth.uid()
       AND NOT public.is_super_admin()
       AND NOT public.can_claim_location(NEW.location_id) THEN
      RAISE EXCEPTION 'user_locations: location is already claimed or not in your org'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.user_id, NEW.location_id) IS DISTINCT FROM (OLD.user_id, OLD.location_id) THEN
      RAISE EXCEPTION 'user_locations: user_id/location_id are immutable'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
      RAISE EXCEPTION 'user_locations: cannot modify another user''s access'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'user_locations: cannot revoke another user''s access'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_user_locations ON public.user_locations;
CREATE TRIGGER trg_guard_user_locations
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_locations
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_locations();

-- ══════════════════════════════════════════════════════════════════════════
-- L4. Data-shape floor
-- ══════════════════════════════════════════════════════════════════════════
-- user_profiles.role had NO constraint at all. NOT VALID so legacy rows with
-- unexpected values cannot block the migration; validate separately once
-- `select distinct role from user_profiles` is clean.
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_chk;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_role_chk
  CHECK (role IN ('super_admin','owner','manager','staff','anon')) NOT VALID;

-- user_locations.user_id has no FK, so orphan/forged rows are possible.
-- Target user_profiles(id), NOT auth.users(id): PostgREST's
-- `user_profiles?select=...,user_locations(location_id)` embed depends on a
-- relationship between these two tables.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_locations'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.user_locations'::regclass
                            AND attname = 'user_id')]::smallint[]
  ) THEN
    ALTER TABLE public.user_locations
      ADD CONSTRAINT user_locations_user_fk
      FOREIGN KEY (user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Replacement for the one legitimate flow the lockdown breaks
-- ══════════════════════════════════════════════════════════════════════════
-- StaffManager.jsx:356 PATCHes ANOTHER user's bo_access with no client-side
-- role check. bo_access is a privileged column, so it is no longer writable
-- from a browser session; this SECURITY DEFINER RPC re-implements the flow with
-- a real server-side gate (same-org, non-super_admin target).
--   Client change: replace
--     supabase.from('user_profiles').update({ bo_access: next }).eq('id', link.authUserId)
--   with
--     supabase.rpc('set_bo_access', { p_user_id: link.authUserId, p_value: next })
DROP FUNCTION IF EXISTS public.set_bo_access(uuid, boolean);
CREATE FUNCTION public.set_bo_access(p_user_id uuid, p_value boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  caller_role text; caller_org uuid; target_role text; target_org uuid;
BEGIN
  IF public.is_anon_session() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT role, org_id INTO caller_role, caller_org FROM public.user_profiles WHERE id = auth.uid();
  SELECT role, org_id INTO target_role, target_org FROM public.user_profiles WHERE id = p_user_id;
  IF caller_role IS NULL OR target_role IS NULL THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF caller_role <> 'super_admin' THEN
    IF caller_role NOT IN ('owner','manager')
       OR caller_org IS NULL
       OR caller_org IS DISTINCT FROM target_org
       OR target_role = 'super_admin' THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE public.user_profiles SET bo_access = p_value WHERE id = p_user_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_bo_access(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bo_access(uuid, boolean) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- Data remediation: anything already escalated by the live hole
-- ══════════════════════════════════════════════════════════════════════════
-- Demote every super_admin that is an anonymous auth user, and drop every
-- location grant held by an anonymous user. Review the SELECTs before running
-- if you want an audit trail first.
UPDATE public.user_profiles up
SET role = 'anon', bo_access = false
FROM auth.users au
WHERE au.id = up.id AND au.is_anonymous
  AND (up.role IS DISTINCT FROM 'anon' OR up.bo_access IS DISTINCT FROM false);

DELETE FROM public.user_locations ul
USING auth.users au
WHERE au.id = ul.user_id AND au.is_anonymous;

commit;

-- ── Post-apply verification (run separately) ──────────────────────────────
-- select policyname, cmd, roles, qual, with_check
--   from pg_policies where tablename in ('user_profiles','user_locations');
-- select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--   where table_name in ('user_profiles','user_locations') and grantee in ('anon','authenticated');
-- -- any OTHER policy in the DB that reads these tables for rows that are not
-- -- the caller's own will now see fewer rows — check before trusting this:
-- select schemaname, tablename, policyname from pg_policies
--   where qual like '%user_profiles%' or with_check like '%user_profiles%'
--      or qual like '%user_locations%' or with_check like '%user_locations%';
