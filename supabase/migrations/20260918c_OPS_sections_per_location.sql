-- 20260918c_OPS_sections_per_location.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor. Claude cannot
-- apply production DDL by any route.
--
-- Idempotent: safe to run twice (the key is only rebuilt when it is not already (location_id, id),
-- add column if not exists).
--
-- PETER'S CHECKLIST
--   1. Run this file OUTSIDE SERVICE (it locks public.sections briefly; if it says "lock timeout",
--      nothing changed, just run it again).
--   2. Run the three check queries at the bottom. Each must answer as noted.
--   3. After the deploy, reload every Back Office tab.
--   4. In Back Office, Floor plan: rename one section (for example Main dining to Up). It must say
--      it saved. Reload Back Office: it is still Up.
--   5. Press Push to POS once per venue (tills also pick the saved list up by themselves within a
--      few minutes).
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- Peter, 18 Sep 2026: "I change the name of main dining to up", and after a refresh it was Main
-- dining again. Floor plan SECTIONS only ever lived in the app (three built in defaults) and in
-- Push to POS snapshots. public.sections existed but nothing wrote it, because its key was id ALONE:
-- two venues could never both keep a section called 'main'.
--
-- This:
--   1. makes the primary key (location_id, id) instead of id alone. The table has ZERO rows for
--      every venue (checked live, read only, 18 Sep), so nothing can clash.
--   2. adds `hidden` (the Back Office "Hide on POS" switch), so a saved list keeps it.
--   3. drops the 'loc-demo' default on location_id, so a row can never be written without its
--      real venue (the app always sends it).
--
-- The app then saves every section add, rename, colour or icon change, hide, reorder and remove
-- straight away: the venue's WHOLE list, upsert on (location_id, id), sort_order from the order,
-- then deletes that venue's rows that are no longer in the list.
--
-- No updated_at is added: the save compares the whole saved list with the one the tab last read,
-- which is enough for a list this small and this rarely edited.
--
-- BEFORE THIS RUNS the app still works exactly as before (built in defaults or the pushed list),
-- and every section change in Back Office says plainly "Run the sections database update first":
-- the upsert has no unique key on (location_id, id) to use (Postgres 42P10), so nothing is saved
-- and the screen is put back.
-- ----------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- 1. The key: (location_id, id) ------------------------------------------------------------------
do $$
declare
  v_name text;
  v_cols text;
begin
  select c.conname, pg_get_constraintdef(c.oid)
    into v_name, v_cols
    from pg_constraint c
   where c.conrelid = 'public.sections'::regclass and c.contype = 'p';
  if v_cols is distinct from 'PRIMARY KEY (location_id, id)' then
    -- Nothing in the repo references sections(id); if something in the live database does, stop
    -- here with a plain message (nothing changed) rather than drop it with CASCADE.
    if exists (select 1 from pg_constraint f where f.confrelid = 'public.sections'::regclass and f.contype = 'f') then
      raise exception 'sections: another table has a foreign key to public.sections, nothing was changed. Send this message to Claude.';
    end if;
    if v_name is not null then
      execute format('alter table public.sections drop constraint %I', v_name);
    end if;
    alter table public.sections add constraint sections_pkey primary key (location_id, id);
  end if;
end;
$$;

-- 2. hidden (Hide on POS) --------------------------------------------------------------------------
alter table public.sections
  add column if not exists hidden boolean not null default false;

-- 3. No 'loc-demo' default: every row carries its real venue -------------------------------------
alter table public.sections
  alter column location_id drop default;

commit;

-- The three checks:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.sections'::regclass and contype = 'p';   -- PRIMARY KEY (location_id, id)
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'sections' and column_name = 'hidden';   -- hidden
--   select location_id, id, label, sort_order, hidden from public.sections order by location_id, sort_order;
--                                  -- empty until someone changes a section in Back Office
