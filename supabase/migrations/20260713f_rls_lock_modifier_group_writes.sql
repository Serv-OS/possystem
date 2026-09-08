-- 20260713f_rls_lock_modifier_group_writes.sql
-- POS-CORE RLS cutover — lock modifier_groups WRITES to the venue (keep the public menu read).
-- modifier_groups is read by the public storefront + POS (menu) but only WRITTEN by back office
-- (MenuManager). The allow-all write/update/delete let any authenticated user tamper with another
-- tenant's modifiers. Keep the anon SELECT ("read modifier groups"); scope writes to pos_can_access.
-- No device-link dependency (reads unchanged); BO writes covered via user_accessible_locations().
drop policy if exists "allow all" on public.modifier_groups;
drop policy if exists "write modifier groups" on public.modifier_groups;
drop policy if exists "update modifier groups" on public.modifier_groups;
drop policy if exists "delete modifier groups" on public.modifier_groups;
create policy modifier_groups_write on public.modifier_groups for insert
  with check (pos_can_access(location_id::text));
create policy modifier_groups_update on public.modifier_groups for update
  using (pos_can_access(location_id::text)) with check (pos_can_access(location_id::text));
create policy modifier_groups_delete on public.modifier_groups for delete
  using (pos_can_access(location_id::text));
