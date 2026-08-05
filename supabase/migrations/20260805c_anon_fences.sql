-- 20260805c_anon_fences.sql
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠⚠⚠  THIS FILE CONTAINS **TWO** MIGRATIONS FOR **TWO DIFFERENT**    ⚠⚠⚠ ║
-- ║  ⚠⚠⚠  DATABASES.  DO NOT PASTE THE WHOLE FILE INTO ONE SQL EDITOR.   ⚠⚠⚠ ║
-- ║                                                                          ║
-- ║    SECTION A  →  OPS DB        project ref  tbetcegmszzotrwdtqhi         ║
-- ║    SECTION B  →  PLATFORM DB   project ref  yhzjgyrkyjabvhblqxzu         ║
-- ║                                                                          ║
-- ║  Each section opens with a guard that ABORTS if you are connected to     ║
-- ║  the wrong project, and each is wrapped in its own begin;/commit;.       ║
-- ║  Run Section A, confirm, then run Section B.                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHY THIS EXISTS
-- The public anon key ships inside the browser bundle. Everything closed here
-- was reachable by anyone who opened the POS, copied the key out, and used curl.
--
-- THE ONE FACT THAT DRIVES EVERY DESIGN DECISION BELOW
--   A Supabase ANONYMOUS SIGN-IN (supabase.auth.signInAnonymously(), which the
--   kiosk / online / QR surfaces call on boot) produces a JWT whose role claim
--   is **"authenticated"**, with is_anonymous = true. It is NOT the `anon` DB
--   role. So `REVOKE ... FROM anon` closes only the raw-key-with-no-session
--   path. The anonymous SESSION has to be fenced with an is_anonymous claim
--   check or with a column-level GRANT. Both are used below.
--   (Same note as supabase/migrations/20260721c_rls_lock_user_identity.sql,
--   which designed this lockdown but was never applied — verified 5 Aug 2026:
--   none of its policies, triggers or helpers exist on the live Ops DB.)
--
-- Every statement is idempotent. Every statement carries a comment saying what
-- it closes and what it breaks. Statements whose blast radius could not be
-- fully verified are left COMMENTED OUT with the reason — read those before
-- deciding; do not uncomment them casually.
--
-- Verified live against both databases on 5 Aug 2026 (pg_policies, pg_proc,
-- information_schema.role_table_grants, pg_class.relrowsecurity, plus a repo
-- grep of every call site named in the comments).
--
-- Both sections were then EXECUTED against a scratch PostgreSQL 17 seeded with
-- stubs of the real schema, twice each (first run + re-run for idempotency),
-- and the resulting policies were exercised with simulated anon / anonymous-
-- session / back-office JWTs. Two defects were found that way and are fixed
-- here — see A3d and the note on can_claim_location. Neither was visible from
-- reading the SQL.
--
-- If you paste into the Supabase dashboard SQL editor it already opens its own
-- transaction, so the explicit `begin;` will log
-- "WARNING: there is already a transaction in progress". That is expected and
-- harmless; the section still applies atomically.


-- ══════════════════════════════════════════════════════════════════════════
-- ══════════════════════════════════════════════════════════════════════════
--
--   SECTION A  ——  OPS DB ONLY  ——  project ref  tbetcegmszzotrwdtqhi
--
--   Do NOT run this section against the Platform DB.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- Wrong-database guard. Ops has user_locations and no billing_state;
-- Platform is the other way round (verified 5 Aug 2026).
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'SECTION A must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it — aborting.';
  end if;
end
$guard$;

-- ──────────────────────────────────────────────────────────────────────────
-- A0. Precondition: handle_new_user() must still be hardened.
-- ──────────────────────────────────────────────────────────────────────────
-- Everything below assumes a client cannot choose its own role at signup.
-- Verified live 5 Aug 2026: the role argument is the server-side literal
-- 'owner'; raw_user_meta_data is read only for full_name. If someone has
-- reintroduced the metadata passthrough, every fence below is decorative, so
-- this refuses to run rather than giving false assurance.
do $precheck$
declare
  def text;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';

  if def is null then
    raise exception 'handle_new_user() not found on this database — aborting.';
  end if;

  if def like '%raw_user_meta_data->>''role''%'
     or def like '%raw_user_meta_data ->> ''role''%' then
    raise exception
      'handle_new_user() reads raw_user_meta_data->>''role'' again — the signup privilege escalation is BACK. Fix that first (see 20260721d_handle_new_user_no_client_role.sql), then re-run.';
  end if;
end
$precheck$;

-- ──────────────────────────────────────────────────────────────────────────
-- A1. Helpers
-- ──────────────────────────────────────────────────────────────────────────

-- True when the caller's JWT is an anonymous sign-in. This is the only way to
-- tell a kiosk/online visitor apart from a real back-office user: both arrive
-- as the `authenticated` DB role.
create or replace function public.is_anon_session()
returns boolean
language sql
stable
as $fn$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean,
    false
  );
$fn$;

grant execute on function public.is_anon_session() to anon, authenticated, service_role;

-- Can the caller claim a freshly-created location for themselves?
--
-- This exists for exactly ONE live flow: Back Office → Company Admin → create
-- location, at src/backoffice/sections/CompanyAdmin.jsx:133, which upserts
-- {user_id: <self>, location_id: <the location just created>, role: 'owner'}.
-- That is the new-operator bootstrap, so it must keep working or sign-up
-- breaks.
--
-- SECURITY DEFINER for two reasons: (1) it is called from a policy ON
-- user_locations and itself reads user_locations, which would otherwise
-- recurse; (2) the table is owned by postgres (verified), so the definer
-- context bypasses RLS and the lookup cannot fail-closed.
--
-- The "unclaimed" test excludes the caller's OWN row on purpose. PostgreSQL
-- evaluates an INSERT policy's WITH CHECK against the proposed tuple even when
-- the statement is INSERT ... ON CONFLICT DO UPDATE and the row actually takes
-- the UPDATE path — confirmed by executing it, not by reading the docs. Since
-- CompanyAdmin.jsx:134 is an .upsert(), a strict "no rows at all" test would
-- make every retry of the create-location flow fail once the grant existed.
-- Re-affirming a grant you already hold is a no-op, so allowing it costs
-- nothing; claiming a location somebody ELSE holds is still refused.
create or replace function public.can_claim_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select not public.is_anon_session()
     and not exists (
           select 1 from public.user_locations ul
            where ul.location_id = p_location_id
              and ul.user_id is distinct from auth.uid()
         )
     and exists (
           select 1
             from public.locations l
             join public.user_profiles up on up.id = auth.uid()
            where l.id = p_location_id
              and up.org_id is not null
              and l.org_id = up.org_id
         );
$fn$;

revoke all on function public.can_claim_location(uuid) from public, anon;
grant execute on function public.can_claim_location(uuid) to authenticated, service_role;

-- is_super_admin() gates the admin-portal write paths added in A2. Live
-- definition trusts user_profiles.role unconditionally, and user_profiles is
-- writable by any session (see A3), so an anonymous visitor could set
-- role='super_admin' on their own profile row and pass this gate.
-- CREATE OR REPLACE (not DROP) — policies across the database depend on it.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select not public.is_anon_session()
     and coalesce((select role = 'super_admin' from public.user_profiles where id = auth.uid()), false);
$fn$;

-- ──────────────────────────────────────────────────────────────────────────
-- A2. user_locations — the root of the tenant fence
-- ──────────────────────────────────────────────────────────────────────────
-- user_accessible_locations() is the only fence on 108 of 143 policied tables
-- (directly or via pos_can_access / ops_can_write / waitlist_can_write /
-- user_accessible_orgs). It reads user_locations. Live policy set was:
--
--   user_locations_admin_write   FOR ALL   TO public   USING(true) WITH CHECK(true)
--   user_locations_select_own    SELECT    TO public   USING(auth.uid() = user_id)
--
-- So one INSERT — from the raw anon key, or from a signInAnonymously() session
-- — granted the caller access to any venue, and all 108 tables then opened up
-- legitimately.
--
-- CLOSES: anon/anonymous self-grant of location access.
-- BREAKS:  nothing in the two legitimate write paths (both preserved below);
--          one narrow case is deliberately narrowed — see A2c.

-- Raw anon key (no session at all) keeps read only. SELECT is left in place so
-- PostgREST embeds return an empty array rather than a 403; with
-- user_locations_select_own and auth.uid() = null it can see zero rows anyway.
revoke insert, update, delete, truncate on table public.user_locations from anon;

alter table public.user_locations enable row level security;

-- The vulnerability itself.
drop policy if exists user_locations_admin_write on public.user_locations;

-- This migration's own policies, dropped first so the file is re-runnable.
drop policy if exists ul_select_super_admin on public.user_locations;
drop policy if exists ul_insert_self_claim  on public.user_locations;
drop policy if exists ul_insert_super_admin on public.user_locations;
drop policy if exists ul_update_self        on public.user_locations;
drop policy if exists ul_update_super_admin on public.user_locations;
drop policy if exists ul_delete_self        on public.user_locations;
drop policy if exists ul_delete_super_admin on public.user_locations;

-- A2a. Reads.
-- user_locations_select_own (auth.uid() = user_id) is LEFT IN PLACE untouched —
-- user_accessible_locations() and every policy that subqueries
-- "user_locations where user_id = auth.uid()" (customers, customer_orders,
-- customer_locations, menu_boards, menu_board_screens, terminal_devices,
-- terminal_jobs) resolve through it and are unaffected.
--
-- Cross-user reads are needed by the admin portal only:
-- src/admin/CompanyAdminApp.jsx:132 and :152 embed
-- `user_profiles?select=...,user_locations(location_id)` across all users.
create policy ul_select_super_admin on public.user_locations
  for select using (public.is_super_admin());

-- A2b. Super-admin writes — src/admin/CompanyAdminApp.jsx:
--   :364 POST   user_locations                       (grant a user a location)
--   :348 DELETE user_locations?user_id&location_id   (revoke one grant)
--   :271 DELETE user_locations?location_id           (location teardown)
--   :228 DELETE user_locations?user_id               (org teardown)
create policy ul_insert_super_admin on public.user_locations
  for insert with check (public.is_super_admin());

create policy ul_update_super_admin on public.user_locations
  for update using (public.is_super_admin()) with check (public.is_super_admin());

create policy ul_delete_super_admin on public.user_locations
  for delete using (public.is_super_admin());

-- A2c. The ONE legitimate self-grant: a new operator claiming the location
-- they have just created. src/backoffice/sections/CompanyAdmin.jsx:133.
--
-- ⚠ DELIBERATE NARROWING — read before applying:
--   Today ANY authenticated user can add themselves to ANY location. After
--   this, the self-claim only succeeds when the location has no user_locations
--   rows at all AND its org matches the caller's own user_profiles.org_id.
--   The new-operator bootstrap satisfies both (createOrg sets the caller's
--   org_id, then createLocation creates the location in that same org — traced
--   through CompanyAdmin.jsx:60-140), so SIGN-UP IS NOT BROKEN.
--   What IS narrowed: a multi-org user who picks a DIFFERENT org in the
--   Company Admin picker and creates a location there will no longer be
--   auto-linked, and adding a SECOND user to an existing location from the
--   Back Office will fail. Both must go through the admin portal (super_admin)
--   instead. That is the intended behaviour — the un-narrowed version is the
--   vulnerability.
create policy ul_insert_self_claim on public.user_locations
  for insert
  with check (
    user_id = auth.uid()
    and not public.is_anon_session()
    and role = 'owner'
    and public.can_claim_location(location_id)
  );

-- Required because CompanyAdmin.jsx:134 uses .upsert(..., {onConflict:
-- 'user_id,location_id'}) — INSERT ... ON CONFLICT DO UPDATE takes the UPDATE
-- policy path on the second and subsequent calls.
create policy ul_update_self on public.user_locations
  for update
  using      (user_id = auth.uid() and not public.is_anon_session())
  with check (user_id = auth.uid() and not public.is_anon_session());

create policy ul_delete_self on public.user_locations
  for delete using (user_id = auth.uid() and not public.is_anon_session());

-- ──────────────────────────────────────────────────────────────────────────
-- A3. user_profiles — the OTHER half of the same fence
-- ──────────────────────────────────────────────────────────────────────────
-- ⚠ NOT IN THE BRIEF, BUT MANDATORY FOR THE BRIEF'S FIX TO MEAN ANYTHING.
--
-- user_accessible_locations() is a UNION of TWO sources:
--     select location_id from user_locations where user_id = auth.uid()
--   union
--     select location_id from user_profiles  where id = auth.uid()
--
-- and the live policy set on user_profiles was:
--     "allow all"                  FOR ALL TO public  USING(true) WITH CHECK(true)
--     "Allow authenticated access" FOR ALL TO public  USING(auth.role()='authenticated')
--
-- So closing user_locations alone changes nothing: the attacker just UPDATEs
-- their own user_profiles row's location_id instead. Worse, they could set
-- role='super_admin' on it, which then satisfies is_super_admin() and the A2b
-- policies above. Two statements close both.

-- A3a. Raw anon key (no session) loses every write. Nothing legitimate writes
-- user_profiles without a session: the ops client runs persistSession:true and
-- every call site resolves supabase.auth.getUser() first (LocationSwitcher:134,
-- CompanyAdmin:80/131, StaffManager:69/283/408, CompanyAdminApp sbFetch).
revoke insert, update, delete, truncate on table public.user_profiles from anon;

-- A3b. "allow all" is the only thing that let the RAW ANON KEY read all 366
-- user_profiles rows (staff emails, roles, org/location ids) with no login.
-- Dropping it changes NOTHING for anyone holding a session — including kiosk
-- and online anonymous sessions — because "Allow authenticated access"
-- (auth.role() = 'authenticated', which anonymous sign-ins also satisfy) still
-- grants full read/write. It is left in place on purpose.
-- CLOSES: unauthenticated bulk read of the staff/user table.
-- BREAKS:  any read of user_profiles made before a session exists. None found.
drop policy if exists "allow all" on public.user_profiles;

-- A3c. Column-level UPDATE grant. This is the layer that actually stops role
-- escalation, because the anonymous SESSION is the `authenticated` DB role and
-- no policy above fences it out of its own profile row.
--
-- NOTE ON POSTGRES SEMANTICS: a column-level REVOKE does not override a
-- table-level GRANT, so the table-level UPDATE must be revoked first and the
-- allowed columns granted back explicitly.
--
-- The four columns below are the complete set written from the browser
-- (exhaustive repo grep, 5 Aug 2026):
--   location_id — LocationSwitcher.jsx:135, CompanyAdmin.jsx:131,
--                 StaffManager.jsx:69 and :283, CompanyAdminApp.jsx:273/361/370
--   org_id      — CompanyAdmin.jsx:80 and :131
--   bo_access   — StaffManager.jsx:409
--   full_name   — no current writer; granted so a profile-name editor does not
--                 fail mysteriously later
-- Nothing writes role, email or id from a browser. After this, nothing can.
--
-- CLOSES: role='super_admin' self-escalation, and email rewriting.
-- BREAKS:  any future client PATCH of user_profiles that sends a column
--          outside this list — it will fail with "permission denied for
--          column". Add the column here rather than re-granting the table.
revoke update on table public.user_profiles from anon, authenticated;
grant update (location_id, org_id, bo_access, full_name)
  on public.user_profiles to authenticated;

-- bo_access stays browser-writable only because moving it needs a client change
-- (StaffManager.jsx:409 → a set_bo_access() RPC) and this migration must not
-- require one. supabase/migrations/20260721c_rls_lock_user_identity.sql:443
-- already contains that RPC if you want to finish the job.

-- A3d. Anonymous sessions must not write profiles at all.
--
-- ⚠ WITHOUT THIS THE WHOLE MIGRATION IS DEFEATED — found by actually executing
--   the policies against a scratch Postgres rather than reading them.
--   location_id has to stay in the A3c grant list (the Back Office writes it),
--   and the surviving "Allow authenticated access" policy tests
--   auth.role() = 'authenticated', which an ANONYMOUS sign-in also satisfies.
--   So a kiosk visitor could still UPDATE their own user_profiles.location_id
--   to any venue and pick up full tenant access through the second arm of
--   user_accessible_locations() — the exact escalation A2 closes on the first
--   arm. Verified reproducible, then verified blocked by the policies below.
--
-- RESTRICTIVE policies only ever subtract, so these cannot widen anything.
-- Scoped to UPDATE and DELETE on purpose: SELECT must keep working for
-- anonymous sessions (getLocationId() at src/lib/supabase.js:76 and
-- src/lib/db.js:860 read the caller's own profile on kiosk/online boot), and
-- INSERT only ever happens inside handle_new_user(), which is SECURITY DEFINER
-- and bypasses RLS.
-- CLOSES: anonymous self-assignment of a location/org.
-- BREAKS:  nothing — no anonymous-session code path writes user_profiles
--          (every writer resolves a real Back Office login first).
drop policy if exists up_no_anon_update on public.user_profiles;
create policy up_no_anon_update on public.user_profiles
  as restrictive for update
  using      (not public.is_anon_session())
  with check (not public.is_anon_session());

drop policy if exists up_no_anon_delete on public.user_profiles;
create policy up_no_anon_delete on public.user_profiles
  as restrictive for delete
  using (not public.is_anon_session());

-- Same belt-and-braces on user_locations. The A2 permissive policies already
-- each carry a not-anonymous test, so this is insurance against a future
-- USING(true) policy being pasted back in from the dashboard — which is
-- exactly how user_locations_admin_write got there.
drop policy if exists ul_no_anon_insert on public.user_locations;
create policy ul_no_anon_insert on public.user_locations
  as restrictive for insert with check (not public.is_anon_session());

drop policy if exists ul_no_anon_update on public.user_locations;
create policy ul_no_anon_update on public.user_locations
  as restrictive for update
  using      (not public.is_anon_session())
  with check (not public.is_anon_session());

drop policy if exists ul_no_anon_delete on public.user_locations;
create policy ul_no_anon_delete on public.user_locations
  as restrictive for delete using (not public.is_anon_session());

-- ──────────────────────────────────────────────────────────────────────────
-- A4. Remediation of access already granted through the hole
-- ──────────────────────────────────────────────────────────────────────────
-- Live counts at the time of writing: 358 anonymous auth users have a
-- user_profiles row; ONE of them (8e44774f-764a-4f5c-8ecd-e7239189e6d8,
-- created 25 May 2026) has location_id = da76f84b-d1dc-47d1-ab98-3f24d887b430
-- and an org_id, which currently gives that anonymous session full tenant
-- access to that venue through user_accessible_locations(). Zero anonymous
-- users hold a user_locations row, and zero are super_admin — so the second
-- statement is a no-op safety net today.
-- An anonymous session must never hold tenant access. No code path sets
-- location_id for an anonymous user (all writers are Back Office, non-anon),
-- so clearing it cannot break a live surface.
update public.user_profiles up
   set location_id = null,
       org_id      = null
  from auth.users au
 where au.id = up.id
   and au.is_anonymous
   and (up.location_id is not null or up.org_id is not null);

delete from public.user_locations ul
 using auth.users au
 where au.id = ul.user_id
   and au.is_anonymous;

commit;

-- ── SECTION A post-apply verification (run separately) ────────────────────
-- select policyname, cmd, roles, qual, with_check
--   from pg_policies where tablename in ('user_locations','user_profiles');
-- select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--  where table_name = 'user_profiles' and grantee in ('anon','authenticated');
-- -- must return 0:
-- select count(*) from public.user_profiles up join auth.users au on au.id = up.id
--  where au.is_anonymous and (up.location_id is not null or up.role = 'super_admin');
--
-- ── SECTION A smoke test (do this before trusting it) ──────────────────────
-- 1. Back Office: log in, switch location, save a staff member, toggle BO access.
-- 2. Company Admin: create an org + location as a user with no location — the
--    user_locations row must appear.
-- 3. Admin portal (super_admin): grant and revoke a user's location.
-- 4. Kiosk / online: place an order end to end (anonymous session path).


-- ══════════════════════════════════════════════════════════════════════════
-- ══════════════════════════════════════════════════════════════════════════
--
--   SECTION B  ——  PLATFORM DB ONLY  ——  project ref  yhzjgyrkyjabvhblqxzu
--
--   Do NOT run this section against the Ops DB.
--
--   CONTEXT FOR EVERYTHING BELOW: the platform browser client is created with
--   `auth: { persistSession: false }` (src/lib/supabase.js:20), so it has NO
--   JWT and every Back Office call to the Platform DB arrives as the `anon` DB
--   role. That is why all these policies were written as USING(true) — there
--   was no identity to fence on. It is also why several of the fixes below
--   cannot be applied without moving the corresponding write behind an edge
--   function first; those are left commented out with the exact breakage.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ══════════════════════════════════════════════════════════════════════════

begin;

-- Wrong-database guard.
do $guard$
begin
  if to_regclass('public.billing_state') is null
     or to_regclass('public.user_locations') is not null then
    raise exception
      'SECTION B must be run against the PLATFORM DB (yhzjgyrkyjabvhblqxzu). This is not it — aborting.';
  end if;
end
$guard$;

-- ──────────────────────────────────────────────────────────────────────────
-- B1. locations_anon_update — rewrite any column of any venue
-- ──────────────────────────────────────────────────────────────────────────
-- Live: FOR UPDATE TO public USING(true) WITH CHECK(true). Any anon-key holder
-- could rewrite challenge_21_enabled (switch off age verification —
-- licensing), qr_service_charge_pct (real customer totals), online_slug /
-- ops_location_id (redirect a venue's public orders into another tenant), or
-- online_enabled=false (kill ordering platform-wide).
--
-- ⚠⚠ THIS BREAKS REAL FEATURES. Every one of these is an UPDATE on platform
--    `locations` from the browser, and every one stops saving:
--      src/backoffice/sections/LocationSettings.jsx:283   timezone, currency,
--                        business_day_start, shifts, opening_hours,
--                        collection_lead_minutes, online_slug, online_enabled, qr_enabled
--      src/backoffice/sections/OnlineOrdering.jsx:248     online menu / lead / delivery
--      src/backoffice/sections/OnlineOrdering.jsx:263     QR core settings
--      src/backoffice/sections/OnlineOrdering.jsx:278     QR tab guardrails
--      src/backoffice/sections/Challenge21.jsx:136        Challenge 21 config
--      src/backoffice/sections/Challenge21.jsx:161        Challenge 21 counter reset
--      src/backoffice/sections/MenuAppearance.jsx:169     online_branding (menu theming)
--      src/backoffice/sections/ReceiptBranding.jsx:149    receipt_branding
--      src/backoffice/sections/MultiLocation.jsx:67       location rename sync
--
-- ⚠⚠ AND TWO OF THEM ARE ON THE LIVE TILL, NOT THE BACK OFFICE, AND FAIL SILENTLY:
--      src/store/index.js:4586                 challenge_21_counter increment,
--          called from triggerChallenge21Check on EVERY closed check containing
--          alcohol. It is wrapped in try/catch, and an RLS-blocked PostgREST
--          UPDATE resolves with 0 rows rather than throwing — so it will not
--          break the sale, it will just stop counting. The Challenge 21 prompt
--          then never fires again at any venue.
--      src/components/Challenge21Modal.jsx:46  counter reset after an ID check.
--
--    Net effect: dropping this policy turns Challenge 21 OFF everywhere, quietly.
--    That is the same outcome as the attack it prevents — except an attacker can
--    also flip challenge_21_enabled itself, which is worse and is not detectable.
--    Applying the drop is still the right call, but read the alternative below
--    first and decide deliberately.
drop policy if exists locations_anon_update on public.locations;

-- Defence in depth: with no UPDATE policy, RLS blocks the write anyway, but
-- removing the privilege means a future permissive policy pasted into the
-- dashboard cannot silently reopen this. `authenticated` is left alone (the
-- platform browser client never holds a JWT; edge functions use service_role).
revoke update on table public.locations from anon;

-- ── ALTERNATIVE to the two statements above — DO NOT APPLY BOTH ────────────
-- Keeps the till's Challenge 21 counter working while closing every dangerous
-- column, using a column-level GRANT (RLS cannot restrict columns; GRANTs can).
-- Back Office location saves still break exactly as listed above; only the two
-- POS counter writes survive. Uncomment this block INSTEAD of the two
-- statements above if you would rather not lose age verification while the
-- edge-function bridge is built.
--
-- revoke update on table public.locations from anon;
-- grant  update (challenge_21_counter) on public.locations to anon;
-- -- policy must stay for the grant to be reachable; the grant is the real fence
-- -- drop policy if exists locations_anon_update on public.locations;   <- do NOT drop it in this variant

-- ──────────────────────────────────────────────────────────────────────────
-- B2. Billing RPCs — anyone can fabricate a merchant's bill
-- ──────────────────────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER with no caller check, and EXECUTE was granted to
-- PUBLIC as well as anon and authenticated (verified: proacl contains
-- "=X/postgres"). Revoking from anon and authenticated alone would leave the
-- PUBLIC grant intact and change nothing — PUBLIC must be named explicitly.
--
-- increment_gmv: promote-only, so an inflated tier cannot be walked back inside
--   the period. The merchant is over-billed.
-- close_billing_period: close your own period early at a low GMV to dodge fees.
--
-- ⚠ THIS BREAKS: src/lib/billing.js:32 calls increment_gmv from the BROWSER,
--   from incrementGmv(), which store/index.js recordClosedCheck invokes after
--   every closed check. After this it returns { error } every time. The
--   function already handles that path — it console.errors and returns null,
--   and the sale is unaffected — so NO TILL FUNCTION IS LOST, but GMV STOPS
--   ACCUMULATING and billing tiers stop advancing until the call is moved
--   server-side (that is a separate task).
-- close_billing_period has NO caller anywhere in the repo — revoking it costs
--   nothing at all.
revoke execute on function public.increment_gmv(uuid, numeric)  from public, anon, authenticated;
revoke execute on function public.close_billing_period(uuid)    from public, anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- B3. Money-column floors on `locations`
-- ──────────────────────────────────────────────────────────────────────────
-- These clamps exist ONLY in the browser today, so anything that reaches the
-- table by another route is unbounded. They hold even while B1's write path is
-- being rebuilt.
--
-- Verified against live data before writing (6 rows):
--   qr_service_charge_pct            all 0.00                  numeric(5,2)
--   qr_tab_left_open_surcharge_pct   0.00 – 10.00              numeric(5,2)
--   qr_tab_left_open_surcharge_fixed all 0.00                  numeric(10,2)
--   qr_tab_pre_auth_amount           50.00 – 100.00            numeric(10,2)
-- Every constraint below passes against all existing rows. All four columns are
-- nullable and CHECK is null-tolerant, so nulls are unaffected.
-- If a constraint were to fail the whole transaction rolls back — safe failure.

-- Matches the client clamp exactly: OnlineOrdering.jsx:266 Math.min(50, ...).
alter table public.locations drop constraint if exists locations_qr_service_charge_pct_chk;
alter table public.locations
  add  constraint locations_qr_service_charge_pct_chk
  check (qr_service_charge_pct >= 0 and qr_service_charge_pct <= 50);

-- Matches the client clamp exactly: OnlineOrdering.jsx:281 Math.min(50, ...).
alter table public.locations drop constraint if exists locations_qr_tab_surcharge_pct_chk;
alter table public.locations
  add  constraint locations_qr_tab_surcharge_pct_chk
  check (qr_tab_left_open_surcharge_pct >= 0 and qr_tab_left_open_surcharge_pct <= 50);

-- OnlineOrdering.jsx:282 clamps this to >= 0 only, with no upper bound. £100 is
-- far above any plausible left-open-tab fee (live max is 0.00). If an operator
-- ever needs more, raise the bound here — the Back Office will surface a raw DB
-- error, not a friendly one.
alter table public.locations drop constraint if exists locations_qr_tab_surcharge_fixed_chk;
alter table public.locations
  add  constraint locations_qr_tab_surcharge_fixed_chk
  check (qr_tab_left_open_surcharge_fixed >= 0 and qr_tab_left_open_surcharge_fixed <= 100);

-- Deliberately generous. This is a pre-authorisation hold, not a surcharge, so
-- the 0–50 bound used above would reject today's live values (50–100).
-- OnlineOrdering.jsx:279 clamps to >= 0 only.
alter table public.locations drop constraint if exists locations_qr_tab_pre_auth_chk;
alter table public.locations
  add  constraint locations_qr_tab_pre_auth_chk
  check (qr_tab_pre_auth_amount >= 0 and qr_tab_pre_auth_amount <= 10000);

-- ──────────────────────────────────────────────────────────────────────────
-- B4. Commercially sensitive tables readable with no login
-- ──────────────────────────────────────────────────────────────────────────
-- RLS is enabled on all five (verified), so dropping the policy really does
-- close the read.

-- B4a. ZERO BREAKAGE — nothing in the repo reads either table from a browser.
--
-- user_access leaks (user_id, email, company_id, location_id, role) for every
-- staff member across every tenant: a ready-made phishing list. No client code
-- references it and no RLS policy on any other table subqueries it (both
-- verified). "anon can read user_access" is its ONLY policy, so this leaves the
-- table readable by service_role only, which is the only thing that uses it.
drop policy if exists "anon can read user_access" on public.user_access;

-- billing_invoices leaks per-period GMV, tier, fee_amount and Stripe transfer
-- ids for every merchant. Written only by close_billing_period() (SECURITY
-- DEFINER) and read by nothing in the repo.
drop policy if exists inv_read_all on public.billing_invoices;

-- B4b. BREAKS THE SUPER-ADMIN PORTAL ONLY — nothing customer-facing, nothing
-- on the till. Applying these is recommended: the data is the most sensitive
-- on the platform and the only consumers are two internal screens.
--
-- billing_state leaks every merchant's gmv_this_month, gmv_last_month,
-- current_plan and current_monthly_fee.
-- merchant_stripe_accounts leaks stripe_account_id plus YOUR OWN
-- cardpresent_markup_percent / online_markup_percent / pricing_notes.
--
-- ⚠ BREAKS:
--   src/admin/sections/AdminBillingManager.jsx:97  merchant_stripe_accounts select('*')
--   src/admin/sections/AdminBillingManager.jsx:99  billing_state select('*')
--   src/admin/sections/AdminStripeTest.jsx:52      merchant_stripe_accounts select
--   Both screens are behind the ?mode=admin super_admin gate. They will render
--   empty until these reads move behind the existing service_role
--   `payments-admin` edge function, which already owns the write side of
--   merchant_stripe_accounts (supabase/functions/payments-admin/index.ts:196).
--   Every other consumer of both tables is already a service_role edge function.
drop policy if exists bs_read_all  on public.billing_state;
drop policy if exists msa_read_all on public.merchant_stripe_accounts;

-- B4c. payment_devices — LEFT IN PLACE ON PURPOSE. DO NOT UNCOMMENT BLIND.
--
-- pd_read_all leaks serial_number, registration_code and stripe_account_id for
-- every terminal on the platform, which is genuinely bad. But the same policy
-- is what lets the TILL find its card reader:
--   src/lib/networkReader.js:62         getAssignedNetworkReader() — POS/kiosk
--                                       boot, the live card-payment path
--   src/components/StatusDrawerCardReaders.jsx:70   POS status drawer
--   src/backoffice/sections/CardReaders.jsx:85      BO reader management
-- Dropping it takes card payments offline. Not worth it.
--
-- The targeted fix is a column-level GRANT: registration_code and
-- stripe_account_id are selected by NO browser call site (verified against all
-- three select lists above), so they can be withheld while reader discovery
-- keeps working. Left commented because a single missing column here fails a
-- POS boot query, and the column list must be re-verified at the moment it is
-- applied rather than trusted from this file.
--
-- revoke select on table public.payment_devices from anon;
-- grant  select (
--   id, location_id, stripe_reader_id, device_type, connection_kind,
--   serial_number, label, bound_pos_device_id, status, battery_level,
--   last_seen_at, created_at, notes, ip_address, firmware_version,
--   last_status_check_at, stripe_terminal_location_id, customer_display_enabled,
--   processor, ryft_terminal_id, adyen_terminal_id
-- ) on public.payment_devices to anon;
-- -- withheld from the browser: registration_code, stripe_account_id,
-- --                            registered_by_user_id
-- -- ⚠ CardReaders.jsx:86 DOES select registration_code today. Applying the
-- --   above breaks that one BO screen until the column is removed from its
-- --   select list (that is a client change and is out of scope here).

-- ──────────────────────────────────────────────────────────────────────────
-- B5. The eight `service_all` / `*_service` policies
-- ──────────────────────────────────────────────────────────────────────────
-- All eight are FOR ALL TO public USING(true) WITH CHECK(true). `public`
-- includes anon, so the raw anon key can DELETE loyalty balances, stamp
-- programmes and gift-card purchase records. The names say the intent was
-- service_role only.
--
-- ⚠ THE HARD PART: the Back Office reaches the Platform DB as `anon` (no JWT),
--   so for six of the eight these policies are ALSO the only thing letting the
--   Back Office read and write its own loyalty configuration. Re-scoping them
--   to service_role is equivalent to dropping them — service_role already
--   bypasses RLS — so those six take Back Office → Loyalty offline. They are
--   written out below but COMMENTED OUT. This is exactly the structural
--   blocker in REMAINING_WORK.md line 53: those writes have to move behind an
--   edge function before the policies can be closed.

-- B5a. SAFE — no browser path exists at all. Verified: the only consumers are
-- service_role edge functions (loyalty-rewards, loyalty-config, loyalty-balance,
-- loyalty-redeem, loyalty-otp, loyalty-member-lookup, loyalty-refund), all of
-- which build their client from PLATFORM_SUPABASE_SERVICE_ROLE_KEY via
-- supabase/functions/_shared/loyalty-utils.ts:33. loyalty_earning_rules has no
-- reader at all yet.
-- CLOSES: anon read/write/DELETE of reward definitions and earning rules.
-- BREAKS: nothing.
drop policy if exists service_all on public.loyalty_rewards;
create policy service_all on public.loyalty_rewards
  for all to service_role using (true) with check (true);

drop policy if exists service_all on public.loyalty_earning_rules;
create policy service_all on public.loyalty_earning_rules
  for all to service_role using (true) with check (true);

-- B5b. NOT SAFE YET — each line names what goes dark. Uncomment a pair only
-- once the corresponding Back Office write is behind an edge function.
--
-- customer_loyalty — every member's points balance, lifetime spend, member_code.
--   Its `service_all` is the ONLY policy on the table, so this kills reads too.
--   Breaks: LoyaltyManager.jsx:1023 (member list), :1331/:1351 (manual points
--   adjustment — a WRITE), Customers.jsx:145 (customer loyalty panel),
--   reports/LoyaltyReport.jsx:45.
-- drop policy if exists service_all on public.customer_loyalty;
-- create policy service_all on public.customer_loyalty
--   for all to service_role using (true) with check (true);
--
-- loyalty_tiers — only policy on the table, so reads die too.
--   Breaks: LoyaltyManager.jsx:1046/:1532/:1538/:1625 (full tier CRUD),
--   Customers.jsx:157, reports/LoyaltyReport.jsx:48.
-- drop policy if exists service_all on public.loyalty_tiers;
-- create policy service_all on public.loyalty_tiers
--   for all to service_role using (true) with check (true);
--
-- loyalty_config — only policy on the table.
--   Breaks: OnlineOrdering.jsx:69 (the loyalty-enabled flag on the online
--   ordering settings screen).
-- drop policy if exists service_all on public.loyalty_config;
-- create policy service_all on public.loyalty_config
--   for all to service_role using (true) with check (true);
--
-- stamp_card_programs — anon_read_stamp_programs (SELECT true) stays, so READS
--   survive; only writes die.
--   Breaks: LoyaltyManager.jsx:1745 (toggle active), :1835/:1838 (create/edit
--   programme), :1857 (delete programme).
-- drop policy if exists service_all_stamp_programs on public.stamp_card_programs;
-- create policy service_all_stamp_programs on public.stamp_card_programs
--   for all to service_role using (true) with check (true);
--
-- customer_stamp_cards — anon_read_stamp_cards (SELECT true) stays, so READS
--   survive; only writes die. This is the one holding customer stamp balances.
--   Breaks: LoyaltyManager.jsx:1855 (cascade delete when a programme is removed).
-- drop policy if exists service_all_stamp_cards on public.customer_stamp_cards;
-- create policy service_all_stamp_cards on public.customer_stamp_cards
--   for all to service_role using (true) with check (true);
--
-- gift_card_purchases — gift_card_purchases_company_read exists but is scoped
--   by user_company_roles/auth.uid(), and the platform browser client has no
--   JWT, so it matches nothing. Reads therefore die with the service policy.
--   Breaks: GiftCards.jsx:1266 (the purchases tab).
-- drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
-- create policy gift_card_purchases_service on public.gift_card_purchases
--   for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────
-- B6. `locations` / `companies` anon SELECT — DELIBERATELY LEFT ALONE
-- ──────────────────────────────────────────────────────────────────────────
-- "anon can read locations" and "anon can read companies" stay. Customer-facing
-- ordering genuinely needs an unauthenticated read: src/lib/customerUrl.js:177
-- resolves a venue from its public slug before any session exists.
--
-- To replace them later with a narrow security_barrier view, these are the
-- exact columns the customer surfaces consume (customerUrl.js:177, :188, :191):
--   locations: id, ops_location_id, name, timezone, currency, online_slug,
--              online_enabled, qr_enabled, opening_hours, online_branding,
--              online_menu_id, online_collection_lead_min,
--              online_delivery_enabled, company_id, qr_payment_mode,
--              qr_table_mode, qr_service_charge_pct, qr_tab_pre_auth_amount,
--              qr_tab_warning_message, qr_tab_left_open_surcharge_pct,
--              qr_tab_left_open_surcharge_fixed, qr_tab_force_close_after_minutes
--   companies: name  (looked up by id only)
-- Note that the Back Office reads far more than this from `locations` on the
-- same anon role, so the view cannot simply replace the policy — the Back
-- Office reads have to move behind an edge function at the same time.

commit;

-- ── SECTION B post-apply verification (run separately) ────────────────────
-- select tablename, policyname, cmd, roles, qual from pg_policies
--  where schemaname = 'public'
--    and tablename in ('locations','user_access','billing_state','billing_invoices',
--                      'merchant_stripe_accounts','payment_devices',
--                      'loyalty_rewards','loyalty_earning_rules')
--  order by tablename, policyname;
-- select proname, proacl from pg_proc
--  where proname in ('increment_gmv','close_billing_period');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.locations'::regclass and contype = 'c';
--
-- ── SECTION B smoke test ───────────────────────────────────────────────────
-- 1. Open a customer ordering link (/online/<slug>) with no session — the venue
--    must still resolve, including QR settings and the company name.
-- 2. POS: take a card payment on a network reader (payment_devices read).
-- 3. POS: close a check — it must still complete. GMV will stop advancing;
--    that is expected (B2) until increment_gmv moves server-side.
-- 4. Back Office → Loyalty must still load (B5b left commented for this reason).
-- 5. Expect Back Office location/QR/Challenge-21/branding saves to FAIL (B1).
