-- 20260918_OPS_floor_table_tombstones.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: create if not exists, drop policy if exists before create. Safe to run twice.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- Peter, 18 Sep 2026: "if you rename, delete them etc, on refresh they come back
-- and names go back." Tables must never be lost (30+ reports), so every merge on
-- the tills keeps a table the incoming data lacks. That made a DELETE look exactly
-- like a lost table. The fix (src/lib/tablePlan.js) makes a delete an explicit
-- marker: a tombstone with a time. Back Office writes one here when it deletes a
-- table, every till reads them at boot, and a Push to POS carries them too.
--
-- floor_tables itself is unchanged and is still hard deleted, so nothing else
-- that reads it (booking widget, kiosk, QR, manager snapshot, edge functions)
-- has to learn about soft deletes.
--
-- deleted_at is never sent by the app: the default here, and the trigger in
-- 20260918b_OPS_floor_tables_server_time.sql (run it NEXT), set it from the
-- database clock, so no device clock ever orders a delete.
--
-- BEFORE THIS RUNS the app still works: the tombstone read and write report the
-- table as missing and are skipped, and the tombstones travel on the deleting
-- machine and in the next Push to POS instead.
-- ----------------------------------------------------------------------------

begin;

create table if not exists public.floor_table_tombstones (
  location_id text        not null,
  table_id    text        not null,
  label       text,
  deleted_at  timestamptz not null default now(),
  deleted_by  uuid        default auth.uid(),
  primary key (location_id, table_id)
);

create index if not exists floor_table_tombstones_loc_time
  on public.floor_table_tombstones (location_id, deleted_at desc);

alter table public.floor_table_tombstones enable row level security;

-- Same fence as floor_tables writes (20260804c_rls_hardening.sql): paired devices
-- at the location, Back Office users with access, super admins. Reads use the same
-- fence (no anonymous customer ever needs these).
drop policy if exists floor_table_tombstones_read on public.floor_table_tombstones;
create policy floor_table_tombstones_read on public.floor_table_tombstones
  for select
  using (pos_can_access(location_id) or is_super_admin());

drop policy if exists floor_table_tombstones_insert on public.floor_table_tombstones;
create policy floor_table_tombstones_insert on public.floor_table_tombstones
  for insert
  with check (pos_can_access(location_id) or is_super_admin());

drop policy if exists floor_table_tombstones_update on public.floor_table_tombstones;
create policy floor_table_tombstones_update on public.floor_table_tombstones
  for update
  using     (pos_can_access(location_id) or is_super_admin())
  with check (pos_can_access(location_id) or is_super_admin());

-- No DELETE policy: a tombstone is a record of a decision. Old ones are ignored by
-- the app after 90 days; prune them here by hand if the table ever grows.

grant select, insert, update on public.floor_table_tombstones to anon, authenticated;

commit;

-- Check after running:
--   select count(*) from public.floor_table_tombstones;   -- 0 rows, no error
