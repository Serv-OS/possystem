-- 20260721_rls_stage1_low_risk.sql
--
-- RLS hardening — STAGE 1 of 3. Replaces `USING (true)` on tables that are ONLY
-- reached by back-office users and PAIRED POS devices. Nothing an anonymous
-- customer touches is in this file.
--
-- WHY STAGED: Supabase's advisor reports 28 always-true policies and the obvious
-- fix is `pos_can_access(location_id)` everywhere. That would break live service.
-- Kiosk / online / QR sign in with signInAnonymously() and are NOT paired
-- devices, so a device-based predicate locks them out. Worse, a kiosk HAS a row
-- in `devices` but its `device_uid` is NEVER stamped — only claim_device() does
-- that, and KioskSurface never calls it (it keys off `rpos-kiosk-id`, not
-- `rpos-device`). So "it's a registered device" does NOT mean it passes
-- pos_can_access(). Stage 2/3 handle those tables by moving the anonymous write
-- paths behind SECURITY DEFINER RPCs FIRST, then locking.
--
-- Predicate: pos_can_access(loc) — true for a back-office user with access to
-- that location, OR a paired ACTIVE device whose devices.device_uid = auth.uid().
-- Already proven in production on closed_checks. is_super_admin() is OR'd in so
-- platform admins keep cross-tenant visibility.
--
-- DELIBERATELY EXCLUDED, with reasons:
--   order_queue, active_sessions  anonymous kiosk/online/QR/catering WRITE to these
--   eighty_six, closed_checks     anonymous customer surfaces READ/INSERT
--   devices, device_profiles      chicken-and-egg at pairing; kiosks read profiles
--   locations, print_jobs         anonymous online/QR read; LAN print agent is anon
--   activity_events               anonymous insert path
--   stamp_transactions            has a deliberate `anon_read_stamp_tx` policy —
--                                 not assuming that was a mistake
--   item_variants, modifier_options, organisations
--                                 no location_id column; need a parent-join or
--                                 user_accessible_orgs() rule, not this one
--
-- ROLLBACK: each block is `drop policy if exists` + `create policy`. To revert a
-- table, drop the *_tenant policy and recreate `... for all using (true) with
-- check (true)`. Keep this file next to the rollback note in CURRENT_WORK.md.

begin;

-- ── sections (floor-plan sections) — location_id text ───────────────────────
drop policy if exists "allow all" on public.sections;
create policy sections_tenant on public.sections
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── location_features (feature flags) — location_id uuid, BO only ──────────
drop policy if exists "allow all" on public.location_features;
drop policy if exists "Allow authenticated access" on public.location_features;
create policy location_features_tenant on public.location_features
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── pos_nudges (till-to-till nudges) — location_id uuid ─────────────────────
drop policy if exists "allow all" on public.pos_nudges;
create policy pos_nudges_tenant on public.pos_nudges
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── device_heartbeats — location_id text ────────────────────────────────────
drop policy if exists "allow all" on public.device_heartbeats;
create policy device_heartbeats_tenant on public.device_heartbeats
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── challenge_21_checks (age-verification audit) — location_id text ─────────
-- Audit trail: staff record checks on the till, managers read them in BO.
drop policy if exists "allow all on challenge_21_checks" on public.challenge_21_checks;
create policy challenge_21_checks_tenant on public.challenge_21_checks
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── shifts — location_id uuid ───────────────────────────────────────────────
drop policy if exists shifts_all on public.shifts;
create policy shifts_tenant on public.shifts
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── loyalty_transactions — location_id TEXT (uses the text overload) ────────
drop policy if exists "allow all" on public.loyalty_transactions;
create policy loyalty_transactions_tenant on public.loyalty_transactions
  for all using (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ── subscriptions (billing) — location_id uuid ──────────────────────────────
-- Tenancy/billing, never a device concern: BO users and platform admins only.
-- Deliberately NOT granted to paired devices — a till has no business reading
-- the venue's subscription.
drop policy if exists "allow all" on public.subscriptions;
drop policy if exists "Allow authenticated access" on public.subscriptions;
create policy subscriptions_tenant on public.subscriptions
  for all using (location_id::text in (select public.user_accessible_locations()) or is_super_admin())
  with check (location_id::text in (select public.user_accessible_locations()) or is_super_admin());

-- ── staff_auth_events (sign-in audit) — location_id text ───────────────────
-- Had an INSERT policy and NO select policy, so the BO could never read its own
-- audit trail. Scope the insert and add the missing read.
drop policy if exists staff_auth_events_insert on public.staff_auth_events;
create policy staff_auth_events_insert on public.staff_auth_events
  for insert with check (pos_can_access(location_id) or is_super_admin());
drop policy if exists staff_auth_events_read on public.staff_auth_events;
create policy staff_auth_events_read on public.staff_auth_events
  for select using (pos_can_access(location_id) or is_super_admin());

commit;
