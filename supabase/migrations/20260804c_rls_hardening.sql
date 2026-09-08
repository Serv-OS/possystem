-- ============================================================================
-- 20260804c_rls_hardening.sql
-- RLS hardening: close confirmed CRITICAL/HIGH cross-tenant data-bleed
-- findings that can be fixed WITHOUT breaking any verified legitimate path.
--
-- Verified against live ops DB (tbetcegmszzotrwdtqhi) on 2026-08-04:
--   * bar_tabs        : single "allow all" policy (ALL, qual=true)      -> CLOSED here
--   * menu_items      : menu_items_auth_write (ALL, role-only qual)     -> write vector CLOSED here
--                       menu_items_anon_read (SELECT, qual=true)        -> KEPT (deliberate, see below)
--   * floor_tables    : floor_tables_auth_write (ALL, role-only qual)   -> write/tamper vector CLOSED here
--                       anon SELECT                                     -> KEPT (required by QR flow, see below)
--   * customers, active_sessions, order_queue                           -> DEFERRED (see bottom block)
--
-- Helper functions used (both exist live, SECURITY DEFINER):
--   pos_can_access(text) / pos_can_access(uuid)
--     true if caller is a paired POS device (devices.device_uid = auth.uid()
--     AND status='active' AND location match) OR a back-office user with the
--     location in user_accessible_locations().
--   is_super_admin()
--     console/super-admin check.
--
-- This exact qual pattern is already live in production on ~15 POS-core
-- tables (staff_members, cash_drawers, shifts, drawer_sessions,
-- closed_checks, device_heartbeats, ... via 20260713d/e), exercised daily
-- by the same anonymous paired devices — so the device branch is proven.
--
-- Edge functions use service_role and BYPASS RLS: nothing here affects them.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1) bar_tabs  (finding: HIGH — single "allow all" policy; any holder of the
--    public anon key could SELECT/INSERT/UPDATE/DELETE every venue's bar tabs:
--    customer name, running total, card pre-auth references)
--
-- WHY safe: verifier found NO breaking path.
--   * Paired POS devices (QueueSync.js stamps rows with resolved _locationId)
--     pass via the devices branch of pos_can_access — same predicate already
--     live on the 15 tables those devices write constantly.
--   * Back-office owners pass via user_accessible_locations(); console via
--     is_super_admin(); edge fns bypass RLS.
--   * Kiosk/QR never touch bar_tabs (standing rule: QR open-tabs use
--     order_queue.customer, never bar_tabs).
-- ----------------------------------------------------------------------------

drop policy if exists "allow all" on public.bar_tabs;

-- Tenant fence: paired device at the tab's location, BO user with access,
-- or super admin. Closes the platform-wide bar-tab read/write bleed.
create policy bar_tabs_tenant on public.bar_tabs
  for all
  using     (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ----------------------------------------------------------------------------
-- 2) menu_items  (finding: HIGH — menu_items_auth_write was FOR ALL with
--    qual = auth.role() IN ('authenticated','anon') and NO location filter:
--    any anon-key holder could UPDATE/DELETE any venue's menu cross-tenant.
--    That write/tamper vector is what carried the HIGH severity.)
--
-- WHY safe: verifier confirmed the write swap breaks nothing —
--   * No public surface (kiosk/online/catering/QR) writes menu_items; they
--     only SELECT. Writes come from BO users and paired POS devices, both
--     covered by pos_can_access / is_super_admin.
--
-- DELIBERATELY KEPT: menu_items_anon_read (SELECT, qual=true).
--   The menu is public storefront content and menu_items has NO cost/margin
--   columns today (cost_price is still deferred per the stock-system backlog),
--   so the read exposure is low-impact. The finding's suggested read-scoping
--   referenced a locations.published column that DOES NOT EXIST — applying it
--   would have broken anonymous menu reads for kiosk/online/catering.
--   Revisit read scoping when cost_price lands.
-- ----------------------------------------------------------------------------

drop policy if exists menu_items_auth_write on public.menu_items;

-- Tenant fence on writes (and tenant-scoped ALL for devices/BO). Anonymous
-- storefront reads continue to flow through menu_items_anon_read (permissive
-- policies OR together), so kiosk/online/catering menus keep working.
create policy menu_items_write_tenant on public.menu_items
  for all
  using     (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- ----------------------------------------------------------------------------
-- 3) floor_tables  (finding: HIGH — floor_tables_auth_write was FOR ALL with
--    qual = auth.role() IN ('authenticated','anon') and NO location predicate:
--    any anon session could UPDATE/DELETE every venue's floor plan. Given the
--    "tables must never be lost" invariant and that active_sessions key off
--    floor_tables.id, cross-tenant DELETE is operationally destructive.)
--
-- Fix shape: SPLIT read from write.
--   * Writes -> tenant-fenced (closes the destructive cross-tenant
--     UPDATE/DELETE/INSERT vector, the core of the HIGH finding).
--   * SELECT -> kept open to anon. This is REQUIRED, not optional: the
--     verifier confirmed src/lib/qrTableSession.js:31 (syncQrTableSession,
--     called from QrCheckout.jsx) SELECTs floor_tables as an anonymous
--     CUSTOMER session to resolve a QR-carried table label ("T2") to the
--     canonical floor_tables.id. Locking SELECT would silently return 0 rows
--     and resurrect the documented orphaned-active_sessions bug (QR tabs not
--     appearing on the POS floor plan).
--   Floor layout (labels/seats/positions) is low-sensitivity; scope the read
--   later via a SECURITY DEFINER label->id RPC for qrTableSession (deferred).
--
-- WHY writes are safe to fence: verifier — "Everything else survives":
--   paired POS devices (SyncBridge/db.js fetchFloorPlan+upsertFloorTable,
--   MasterSync, waitlistSlice) pass via pos_can_access's device branch,
--   already proven live on staff/cash/closed-checks tables; BO cross-location
--   owners via user_accessible_locations(); CompanyAdminApp deletes run as
--   real admin users; edge fns bypass RLS. Kiosk code never writes
--   floor_tables. Residual (pre-existing, accepted by the staged-RLS
--   programme): a device that never successfully ran claim_device would lose
--   floor-plan WRITE sync until re-paired — such a device also cannot reach
--   staff_members/shifts today, so the POS is non-functional pre-pairing
--   regardless (no new breakage class).
-- ----------------------------------------------------------------------------

drop policy if exists floor_tables_auth_write on public.floor_tables;

-- Open read: preserves the anonymous QR-customer table-label lookup
-- (qrTableSession.js). Layout data only; tighten via RPC in a later stage.
create policy floor_tables_anon_read on public.floor_tables
  for select
  using (true);

-- Tenant-fenced INSERT: only paired devices at the location, BO users with
-- access, or super admins may create tables. Closes cross-tenant insert spam.
create policy floor_tables_insert_tenant on public.floor_tables
  for insert
  with check (pos_can_access(location_id) or is_super_admin());

-- Tenant-fenced UPDATE: closes cross-tenant floor-plan tampering.
create policy floor_tables_update_tenant on public.floor_tables
  for update
  using     (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- Tenant-fenced DELETE: closes the destructive cross-tenant table-delete
-- vector (the "tables must never be lost" killer).
create policy floor_tables_delete_tenant on public.floor_tables
  for delete
  using (pos_can_access(location_id) or is_super_admin());

commit;

-- ============================================================================
-- DEFERRED (needs owner) — findings NOT touched by this migration because a
-- verified legitimate production path would break. Each needs SECURITY DEFINER
-- RPCs (and client call-site migration) to ship FIRST, then a follow-up
-- policy-swap migration.
--
-- 1) customers (CRITICAL — anon carve-out in customers_all exposes ALL
--    customers' PII cross-ORG to any anonymous session)
--    BREAKS IF LOCKED NOW: POS, kiosk, online and QR ALL run as
--    signInAnonymously() sessions with no user_locations rows, so a
--    tenant-scoped policy resolves false for every one of them. Would break:
--    kiosk/customer-display loyalty phone lookup (fetchCustomerByPhone /
--    captureLoyaltyByPhone), online order customer attribution
--    (attributeOnlineOrder), and POS customer search/save
--    (searchCustomersLive, upsertCustomer, addToHistory).
--    PREREQ: device/venue-fenced SECURITY DEFINER RPCs for the anon lookup +
--    upsert paths, then migrate all call sites, THEN drop the anon branch.
--
-- 2) active_sessions (CRITICAL — single "allow all"; any anon session can
--    read/update/delete every venue's live open tables/checks; also in the
--    supabase_realtime publication)
--    BREAKS IF LOCKED NOW: (a) QR customer flow — qrTableSession.js
--    select/upsert/delete from the customer's browser (never passes
--    pos_can_access); (b) any POS device with an unstamped device_uid would
--    have session writes silently rejected — the exact "tables vanishing"
--    regression that forced the original revert of 20260429_tenant_rls.
--    PREREQ: SECURITY DEFINER upsert/delete RPCs for the QR path + a
--    device_uid stamp audit/backfill for all live devices, THEN fence.
--
-- 3) order_queue (CRITICAL — single "allow all"; order stream incl.
--    order_queue.customer PII readable/writable platform-wide by anon)
--    BREAKS IF LOCKED NOW: anonymous order INSERT from kiosk/online/QR/
--    catering checkouts (online inserts AFTER payment — breakage = charged-
--    but-lost orders); OrderTracker.jsx anonymous SELECT + realtime UPDATE
--    subscription; QR tab resume/join (TabResumeScreen UPDATE,
--    qrTableSession SELECT, JoinTabScreen tab_join_code validation).
--    PREREQ: SECURITY DEFINER submit RPC (stamps location_id server-side)
--    AND per-order token-scoped read/update paths (tracker + QR tabs), THEN
--    fence. The RPC-for-INSERT alone is NOT sufficient.
--
-- Out of scope for this migration (MEDIUM severity, also break-risky):
--    devices (world-writable trust anchor of pos_can_access — needs a write
--    fence that still allows device heartbeat self-writes + non-super-admin
--    BO provisioning) and device_profiles (kiosk pre-pairing profile reads).
--    Note: until devices is fenced, a determined attacker can still forge a
--    devices row to satisfy pos_can_access — the policies above raise the
--    bar and stop casual anon-key reads/writes, but the devices fence is the
--    load-bearing follow-up for full tenant isolation.
-- ============================================================================
