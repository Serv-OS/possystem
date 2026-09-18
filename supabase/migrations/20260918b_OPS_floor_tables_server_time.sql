-- 20260918b_OPS_floor_tables_server_time.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor, AFTER
-- 20260918_OPS_floor_table_tombstones.sql. Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, create or replace, drop trigger if exists. Safe to run twice.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- Review of the table plan fix (Peter, 18 Sep 2026: "if you rename, delete them etc, on refresh
-- they come back and names go back"): the first build ordered edits and deletes with times stamped
-- by each DEVICE's clock. A Sunmi whose clock ran hours ahead then hid tables Back Office added
-- later, kept old names after a pushed rename, and a deleted id that was re-created stayed hidden.
--
-- This gives every table definition and every delete a time set by the DATABASE clock, so the
-- tills compare like with like (src/lib/tablePlan.js):
--   1. floor_tables.updated_at, set by a trigger on EVERY insert and update (the value a client
--      sends is ignored), truncated to milliseconds so the Back Office compare-and-set (update ...
--      where updated_at = the value it last read) matches exactly. Existing rows are backfilled.
--   2. floor_table_tombstones.deleted_at, set the same way on every insert and update (a re-delete
--      of the same id moves it forward). A tombstone removes a table only if deleted_at is later
--      than the row's updated_at, so re-creating an id clears it.
--   3. floor_plan_read(p_location_id): the location's rows AND the database time of the read in
--      one statement, so a till can tell "deleted since" from "created after my read" without
--      trusting its own clock.
--
-- Nothing else that reads floor_tables changes (booking widget, kiosk, QR, manager snapshot, edge
-- functions): the new column is additive and select('*') callers ignore it.
--
-- BEFORE THIS RUNS the app still works: tills order copies by the order they observed them (a
-- counter, never a clock), Back Office compare-and-set compares every column it last read instead
-- of updated_at, and the read falls back to a plain select.
-- ----------------------------------------------------------------------------

begin;

-- 1. floor_tables.updated_at (server time) ------------------------------------------------------
alter table public.floor_tables
  add column if not exists updated_at timestamptz;

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
-- (the table is created by 20260918_OPS_floor_table_tombstones.sql; run that first)
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

-- 3. floor_plan_read: rows plus the database time of the read, in one statement ------------------
-- SECURITY INVOKER: the caller's own RLS applies (floor_tables is readable at its location, as
-- before). `at` is now() of this statement's transaction, which is no later than the snapshot the
-- rows come from: a row updated after `at` may or may not be in the result, and the app keeps it
-- either way (never removes on doubt).
create or replace function public.floor_plan_read(p_location_id text)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'at', floor(extract(epoch from now()) * 1000)::bigint,
    'tables', coalesce(
      (select json_agg(t order by t.sort_order, t.id)
         from public.floor_tables t
        where t.location_id = p_location_id),
      '[]'::json)
  );
$$;

grant execute on function public.floor_plan_read(text) to anon, authenticated;

commit;

-- Check after running:
--   select id, updated_at from public.floor_tables limit 5;          -- every row has a time
--   select public.floor_plan_read('<a location id>');                  -- { "at": ..., "tables": [...] }
--   update public.floor_tables set label = label where id = '<id>';    -- updated_at moves forward
