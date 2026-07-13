-- 20260713e_rls_lock_closed_checks_read.sql
--
-- POS-CORE RLS CUTOVER — STAGE 2b: close the sales-READ leak on closed_checks.
--
-- closed_checks (every sale: totals, tender, tips, customer details) was USING(true)
-- allow-all → the browser anon key could read EVERY tenant's sales. Verified: only POS
-- (paired device, filters by location) and back office read it; the public ordering
-- surfaces (online/QR/kiosk) only INSERT paid orders directly as anon, and OrderTracker
-- reads order_queue — NOT closed_checks. So we can scope READ/UPDATE/DELETE to the venue
-- via pos_can_access(location_id) while KEEPING INSERT open so public checkout keeps
-- recording orders. (Hardening INSERT via a service-role edge fn is a later step; the
-- confidentiality leak — reading other tenants' sales — is what this closes.)

-- Some POS-core tables carry location_id as text (e.g. closed_checks), others as uuid
-- (staff_members). Add a text overload of the RLS helper so both work; the existing uuid
-- policies are unaffected. Compares device location as text.
create or replace function public.pos_can_access(p_loc text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_loc is null then return false; end if;
  if p_loc in (select user_accessible_locations()) then return true; end if;
  return exists (
    select 1 from public.devices d
    where d.device_uid = auth.uid() and d.status = 'active' and d.location_id::text = p_loc
  );
end;
$$;
grant execute on function public.pos_can_access(text) to anon, authenticated;

drop policy if exists "allow all" on public.closed_checks;
drop policy if exists "read closed checks" on public.closed_checks;
drop policy if exists "update closed checks" on public.closed_checks;

create policy closed_checks_read on public.closed_checks for select
  using (pos_can_access(location_id));
create policy closed_checks_update on public.closed_checks for update
  using (pos_can_access(location_id)) with check (pos_can_access(location_id));
create policy closed_checks_delete on public.closed_checks for delete
  using (pos_can_access(location_id));

-- "insert closed checks" (INSERT, allow-all) is intentionally LEFT in place so online /
-- QR / kiosk checkout (anonymous, no device link) can still record a paid order.
