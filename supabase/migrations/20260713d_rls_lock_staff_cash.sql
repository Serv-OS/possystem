-- 20260713d_rls_lock_staff_cash.sql
--
-- POS-CORE RLS CUTOVER — STAGE 2: lock the crown-jewel tables to the venue.
--
-- staff_members (incl. PINs), cash_drawers, cash_movements, drawer_sessions were all
-- USING(true) allow-all → the browser anon key could read every tenant's staff PINs and
-- cash. These tables are touched ONLY by paired POS devices + back-office users (NO public
-- ordering path), so we can scope them now. Replace allow-all with pos_can_access(location_id)
-- = back-office access (user_accessible_locations) OR the claimed active device for that
-- location (devices.device_uid = auth.uid()).
--
-- A device must be LINKED to read/write (Stage 1 boot-claim / pairing). Verified: the live
-- Sunmi till is linked; other TEST devices auto-link on their next reload. Service-role edge
-- fns (ops_pin_login etc.) bypass RLS and are unaffected. Fully reversible.

drop policy if exists "allow all" on public.staff_members;
create policy staff_members_tenant on public.staff_members for all
  using (pos_can_access(location_id)) with check (pos_can_access(location_id));

drop policy if exists cash_drawers_all on public.cash_drawers;
create policy cash_drawers_tenant on public.cash_drawers for all
  using (pos_can_access(location_id)) with check (pos_can_access(location_id));

drop policy if exists cash_movements_all on public.cash_movements;
create policy cash_movements_tenant on public.cash_movements for all
  using (pos_can_access(location_id)) with check (pos_can_access(location_id));

drop policy if exists drawer_sessions_all on public.drawer_sessions;
create policy drawer_sessions_tenant on public.drawer_sessions for all
  using (pos_can_access(location_id)) with check (pos_can_access(location_id));
