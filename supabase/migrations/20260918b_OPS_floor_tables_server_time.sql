-- 20260918b_OPS_floor_tables_server_time.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor, AFTER
-- 20260918_OPS_floor_table_tombstones.sql. Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, create or replace, drop trigger if exists. Safe to run twice.
-- Run both files back to back, outside service.
--
-- PETER'S CHECKLIST (the same in both files)
--   1. Run 20260918_OPS_floor_table_tombstones.sql, then 20260918b_OPS_floor_tables_server_time.sql,
--      back to back, OUTSIDE SERVICE (both lock floor_tables briefly; if either says "lock timeout",
--      nothing changed, just run it again).
--   2. Run the three check queries at the bottom of this file. Each must answer without an error.
--   3. After the deploy, reload every Back Office tab on every machine.
--   4. Force stop and reopen every Sunmi and Android till; fully reload every iPad and browser.
--   5. Press Push to POS once per venue.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- Review of the table plan fix (Peter, 18 Sep 2026: "if you rename, delete them etc, on refresh
-- they come back and names go back"): the first build ordered edits and deletes with times stamped
-- by each DEVICE's clock. A Sunmi whose clock ran hours ahead then hid tables Back Office added
-- later, kept old names after a pushed rename, and a deleted id that was re-created stayed hidden.
--
-- This gives every table definition and every delete a time set by the DATABASE clock, and makes
-- the database itself refuse to bring a deleted table back:
--   1. floor_tables.updated_at, set by a trigger on EVERY insert and update (the value a client
--      sends is ignored), truncated to milliseconds so the Back Office compare-and-set (update ...
--      where updated_at = the value it last read) matches exactly. Existing rows are backfilled
--      with the time this runs, so every row is stamped later than every tombstone before it.
--   2. floor_table_tombstones.deleted_at, set the same way on every insert and update (the trigger
--      is created by 20260918 too; it is repeated here so it exists whichever version ran). A
--      tombstone removes a table only if deleted_at is later than the row's updated_at.
--   3. THE GUARD against old code. A Back Office tab or a till WebView still on the pre deploy
--      bundle does a blind upsert of the whole table on a drag. For a deleted table that is an
--      INSERT, which (1) would stamp NEWER than the tombstone, putting the table back on every
--      till. floor_tables_guard_tombstone refuses any insert or update of an id whose tombstone is
--      newer than the row's last updated_at (for an insert: the existing row's, or none at all).
--      The refusal is an ordinary error ("floor_table_deleted: ..."), which old code already shows
--      as a failed save. Never a silent resurrection.
--      THE RE-CREATE SIGNAL: the column recreate_deleted. A write that sets it to true passes the
--      guard. The new client sets it only on the INSERT of a table a person has just added in
--      Back Office (insert only, so it can never overwrite a row). The trigger always stores
--      false, so no row read back can ever carry true into a later write, and old code (which
--      does not know the column) can never send it. By hand in the SQL editor, to put a deleted
--      table back on purpose: insert ... (..., recreate_deleted) values (..., true).
--   4. floor_plan_read(p_location_id): the location's rows AND `at`, the highest updated_at among
--      them, in one statement (one snapshot). Why not a clock time: updated_at is stamped by the
--      trigger BEFORE the writer commits, so a row can carry a stamp earlier than any time taken
--      at the read and still commit after the read's snapshot. No database time can prove "absent
--      from this read, so deleted". The app therefore never removes or blocks a table by a server
--      time: it decides absence by its own observation order (a copy it saw before the read was
--      sent was committed before the snapshot) and deletes by tombstones. `at` is a fact about
--      the read, kept for diagnosis.
--
-- Nothing else that reads floor_tables changes (booking widget, kiosk, QR, manager snapshot, edge
-- functions): the new columns are additive and select('*') callers ignore them.
--
-- BEFORE THIS RUNS the app still works: tills order copies by the order they observed them (a
-- counter, never a clock), Back Office compare-and-set compares every column it last read instead
-- of updated_at, the read falls back to a plain select (retried every 10 minutes), and a new table
-- is inserted without the re-create flag.
-- ----------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- 1. floor_tables.updated_at (server time) ------------------------------------------------------
alter table public.floor_tables
  add column if not exists updated_at timestamptz;

-- Backfill BEFORE the triggers exist, one time for every row (now() is this transaction's time).
update public.floor_tables
   set updated_at = date_trunc('milliseconds', now())
 where updated_at is null;

alter table public.floor_tables
  alter column updated_at set default date_trunc('milliseconds', now()),
  alter column updated_at set not null;

create or replace function public.floor_tables_stamp_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := date_trunc('milliseconds', clock_timestamp());
  return new;
end;
$$;

drop trigger if exists floor_tables_stamp_updated_at on public.floor_tables;
create trigger floor_tables_stamp_updated_at
  before insert or update on public.floor_tables
  for each row execute function public.floor_tables_stamp_updated_at();

-- 2. floor_table_tombstones.deleted_at (server time) ---------------------------------------------
-- (the table and this trigger are created by 20260918_OPS_floor_table_tombstones.sql; run that first)
alter table public.floor_table_tombstones
  alter column deleted_at set default date_trunc('milliseconds', now());

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

-- 3. The guard: a deleted id comes back only through the re-create signal ------------------------
alter table public.floor_tables
  add column if not exists recreate_deleted boolean not null default false;

-- SECURITY DEFINER so it can always see the tombstone and the existing row (it returns nothing to
-- the caller but the row being written, or an error). Fires before the updated_at stamp (trigger
-- names run in alphabetical order: guard < stamp); it compares with OLD, so the order is not
-- load bearing. For an upsert (insert ... on conflict) the insert check runs on the proposed row
-- and the update check again on the existing one.
create or replace function public.floor_tables_guard_tombstone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted timestamptz;
  v_last    timestamptz;
begin
  if coalesce(new.recreate_deleted, false) then
    new.recreate_deleted := false;          -- never stored true
    return new;
  end if;
  new.recreate_deleted := false;
  select t.deleted_at into v_deleted
    from public.floor_table_tombstones t
   where t.location_id = new.location_id and t.table_id = new.id;
  if v_deleted is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_last := old.updated_at;
  else
    select f.updated_at into v_last from public.floor_tables f where f.id = new.id;
  end if;
  if v_last is not null and v_last >= v_deleted then
    return new;                             -- re-created after the delete: an ordinary edit
  end if;
  raise exception using
    errcode = 'P0001',
    message = format('floor_table_deleted: table %s was deleted from the floor plan, reload Back Office', new.id),
    hint    = 'An out of date screen tried to save a deleted table. To bring it back on purpose, insert it with recreate_deleted = true.';
end;
$$;

drop trigger if exists floor_tables_guard_tombstone on public.floor_tables;
create trigger floor_tables_guard_tombstone
  before insert or update on public.floor_tables
  for each row execute function public.floor_tables_guard_tombstone();

-- 4. floor_plan_read: rows plus the highest updated_at among them, in one statement ---------------
-- SECURITY INVOKER: the caller's own RLS applies (floor_tables is readable at its location, as
-- before). One statement, so the rows and `at` come from the same snapshot. See 4 above for why
-- `at` is not a clock reading and why the app never removes a table by it.
create or replace function public.floor_plan_read(p_location_id text)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with t as (
    select * from public.floor_tables where location_id = p_location_id
  )
  select json_build_object(
    'at', coalesce((select floor(extract(epoch from max(t.updated_at)) * 1000)::bigint from t), 0),
    'tables', coalesce((select json_agg(t order by t.sort_order, t.id) from t), '[]'::json)
  );
$$;

grant execute on function public.floor_plan_read(text) to anon, authenticated;

commit;

-- The three checks (each must answer without an error):
--   select count(*) filter (where updated_at is null) as unstamped from public.floor_tables;   -- 0
--   select public.floor_plan_read('<a location id>');       -- { "at": ..., "tables": [...] }
--   select tgname from pg_trigger where tgrelid = 'public.floor_tables'::regclass and not tgisinternal;
--                                  -- floor_tables_guard_tombstone and floor_tables_stamp_updated_at
