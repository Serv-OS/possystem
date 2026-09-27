-- 20260927_OPS_menu_rows_server_time.sql  (Ops DB, Peter runs; Claude cannot apply DDL)
--
-- Peter, 27 Sep 2026: "I archived choc babychino but its still on the menu board".
-- Two Back Office windows were open on Coffee Boy Leeds. The one loaded at 13:52 pressed Push to
-- POS at 13:59 and wrote its memory of every product back over the database: archived=false for
-- the Choc Babyccino the other window had archived at 13:56, and no tax rate on 430 products the
-- other window had just given one. The app no longer does that (Back Office writes only the
-- columns a person changed, compare and set on the row's updated_at, and Push to POS writes no
-- menu rows at all). This file makes the database hold up its end:
--
--   1. updated_at is stamped by the DATABASE clock on every update of menu_items,
--      menu_categories, menus and modifier_groups. The app compares on it ("write only if the
--      row still has the updated_at I read"). Today each writer stamps its own device time, and a
--      write that does not stamp (a hand edit in the SQL editor, a bulk update) leaves the old
--      value, so a window holding that value would not know the row had changed.
--   2. modifier_groups gets an updated_at column (it has none), so a group save can compare too.
--   3. menu_items and tax_rates join supabase_realtime, so an open Back Office (and every till)
--      hears a change made elsewhere within a second. Those are the two tables the app already
--      has channels for (src/lib/realtime.js); they have never fired, because the tables were
--      never in the publication.
--      ONLY those two. 20260804b_realtime_prune.sql took modifier_groups OUT on purpose (realtime
--      decoding was the database's biggest load), and nothing listens to menus, menu_categories
--      or modifier_groups: publishing them would be load for no one. Add one when a channel for
--      it exists. Note that an "Apply to all" of about 430 products is about 430 events, each
--      checked against row level security for every till at the venue: people make these writes,
--      not machines on a timer, so it is rare.
--      NOTE: once this runs, a product edit in Back Office reaches the tills live, without a
--      Push to POS (that is what the menu_items channel was written for). The Push still sends
--      the whole menu, and is still how categories, menus and modifier groups reach the tills.
--
-- Safe to run more than once. Nothing here changes any row's data except that the next update of
-- each row takes its updated_at from the database clock.

begin;

-- 1. The database clock on every update ------------------------------------------------------
create or replace function public._menu_rows_stamp_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- clock_timestamp(), not now(): two updates of one row inside one transaction still get
  -- different values, so a compare and set can never match a value it did not read.
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- 2. modifier_groups had no updated_at at all ------------------------------------------------
alter table public.modifier_groups
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists menu_items_stamp_updated_at on public.menu_items;
create trigger menu_items_stamp_updated_at
  before update on public.menu_items
  for each row execute function public._menu_rows_stamp_updated_at();

drop trigger if exists menu_categories_stamp_updated_at on public.menu_categories;
create trigger menu_categories_stamp_updated_at
  before update on public.menu_categories
  for each row execute function public._menu_rows_stamp_updated_at();

drop trigger if exists menus_stamp_updated_at on public.menus;
create trigger menus_stamp_updated_at
  before update on public.menus
  for each row execute function public._menu_rows_stamp_updated_at();

drop trigger if exists modifier_groups_stamp_updated_at on public.modifier_groups;
create trigger modifier_groups_stamp_updated_at
  before update on public.modifier_groups
  for each row execute function public._menu_rows_stamp_updated_at();

-- 3. Realtime for the two menu tables the app listens to ---------------------------------------
do $$
declare t text;
begin
  foreach t in array array['menu_items', 'tax_rates'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

commit;

-- Check (read only), after running:
--   select tgrelid::regclass, tgname from pg_trigger where tgname like '%stamp_updated_at';
--     -> 4 rows: menu_items, menu_categories, menus, modifier_groups
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'modifier_groups' and column_name = 'updated_at';
--     -> 1 row
--   select tablename from pg_publication_tables where pubname = 'supabase_realtime'
--    and tablename in ('menu_items','menu_categories','menus','modifier_groups','tax_rates');
--     -> 2 rows: menu_items, tax_rates (modifier_groups stays out, as 20260804b left it)
--
-- To undo (only if it has to be):
--   drop trigger if exists menu_items_stamp_updated_at on public.menu_items;
--   drop trigger if exists menu_categories_stamp_updated_at on public.menu_categories;
--   drop trigger if exists menus_stamp_updated_at on public.menus;
--   drop trigger if exists modifier_groups_stamp_updated_at on public.modifier_groups;
--   alter publication supabase_realtime drop table public.menu_items, public.tax_rates;
--   (leave modifier_groups.updated_at in place: the app reads it when it is there)
