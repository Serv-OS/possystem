-- 20260918_OPS_floor_table_tombstones.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: create if not exists, drop policy if exists before create. Safe to run twice.
-- Run both files back to back, outside service.
--
-- PETER'S CHECKLIST (the same in both files)
--   1. Run 20260918_OPS_floor_table_tombstones.sql, then 20260918b_OPS_floor_tables_server_time.sql,
--      back to back, OUTSIDE SERVICE (both lock floor_tables briefly; if either says "lock timeout",
--      nothing changed, just run it again).
--   2. Run the three check queries at the bottom of 20260918b. Each must answer without an error.
--   3. After the deploy, reload every Back Office tab on every machine.
--   4. Force stop and reopen every Sunmi and Android till; fully reload every iPad and browser.
--   5. Press Push to POS once per venue.
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
-- deleted_at is never sent by the app: the default and the trigger here set it from
-- the database clock on every insert AND every update, so no device clock ever
-- orders a delete and a repeat delete of the same id (the app's upsert) moves
-- deleted_at forward even if 20260918b has not run yet.
--
-- BEFORE THIS RUNS the app still works: the tombstone read and write report the
-- table as missing and are skipped, and the tombstones travel on the deleting
-- machine and in the next Push to POS instead.
-- ----------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

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

-- No DELETE policy: a tombstone is a record of a decision. The app reads the newest
-- 2000 per venue (no date cut off, that would need a device clock); prune old ones
-- here by hand if the table ever grows past that.

grant select, insert, update on public.floor_table_tombstones to anon, authenticated;

-- deleted_at from the database clock on every insert and update (the value a client
-- sends is ignored). Milliseconds, like floor_tables.updated_at in 20260918b.
create or replace function public.floor_table_tombstones_stamp_deleted_at()
returns trigger
language plpgsql
as $$
begin
  new.deleted_at := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$$;

drop trigger if exists floor_table_tombstones_stamp_deleted_at on public.floor_table_tombstones;
create trigger floor_table_tombstones_stamp_deleted_at
  before insert or update on public.floor_table_tombstones
  for each row execute function public.floor_table_tombstones_stamp_deleted_at();

commit;

-- Check after running (then run 20260918b straight away):
--   select count(*) from public.floor_table_tombstones;   -- a number, no error
