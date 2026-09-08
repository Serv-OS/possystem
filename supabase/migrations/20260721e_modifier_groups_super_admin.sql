-- 20260721e_modifier_groups_super_admin.sql
--
-- Adds the missing is_super_admin() escape hatch to the modifier_groups write
-- policies created by 20260713f_rls_lock_modifier_group_writes.sql.
--
-- WHY: 20260713f gates INSERT/UPDATE/DELETE on pos_can_access(location_id) with
-- NO super-admin OR, which every other locked table in this codebase carries
-- (see 20260721_rls_stage1_low_risk.sql). pos_can_access() is true for a
-- back-office user with a user_locations row for that venue, or a paired ACTIVE
-- device. A platform/back-office user working through the `rpos-bo-location`
-- override may legitimately have NO user_locations row for the venue they are
-- editing — so once v5.5.834 moves the modifier-group writers onto the
-- authenticated client, those writes would authenticate correctly and STILL be
-- refused. This restores parity with the rest of the locked tables.
--
-- SELECT is deliberately untouched: "read modifier groups" is USING (true) and
-- the public storefront / kiosk / QR menus depend on it.
--
-- ROLLBACK: each block is `drop policy if exists` + `create policy`. To revert,
-- drop the three policies below and recreate them exactly as 20260713f had them
-- (the same predicates without `or is_super_admin()`).

begin;

-- ── modifier_groups INSERT ──────────────────────────────────────────────────
drop policy if exists modifier_groups_write on public.modifier_groups;
create policy modifier_groups_write on public.modifier_groups for insert
  with check (pos_can_access(location_id::text) or is_super_admin());

-- ── modifier_groups UPDATE ──────────────────────────────────────────────────
drop policy if exists modifier_groups_update on public.modifier_groups;
create policy modifier_groups_update on public.modifier_groups for update
  using (pos_can_access(location_id::text) or is_super_admin())
  with check (pos_can_access(location_id::text) or is_super_admin());

-- ── modifier_groups DELETE ──────────────────────────────────────────────────
drop policy if exists modifier_groups_delete on public.modifier_groups;
create policy modifier_groups_delete on public.modifier_groups for delete
  using (pos_can_access(location_id::text) or is_super_admin());

commit;
