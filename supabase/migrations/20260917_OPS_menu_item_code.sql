-- 20260917_OPS_menu_item_code.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL
-- editor. Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, create index if not exists, and a
-- drop/add for the check constraint. Safe to run twice.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS
-- ────────────────────────────────────────────────────────────────────────────
-- A SHORT CODE PER PRODUCT, the thing we give ezCater (and any other partner)
-- so their order line says which of our products it is. On an ezCater order it
-- comes back as posItemId, which the matcher then treats as certain.
--
-- We already match ezCater lines by name (20260917_OPS_ezcater_item_links.sql).
-- A name is the only key their Partner Portal menu carries, and it breaks the
-- day somebody retypes it. A code we own is better: it is short, it is stable,
-- and it survives a rename on either side.
--
-- HOW A CODE REACHES EZCATER IS NOT SETTLED. The only documented writer of
-- posItemId is the Menus API menuCreate, which we do not have permission for;
-- whether a venue can type one into the Partner Portal is documented nowhere.
-- Only ezCater can answer that. This column costs nothing while that is open:
-- it is our own id for our own product, and the Back Office can hand the list
-- over the moment there is somewhere to put it.
--
-- WHY A NEW COLUMN AND NOT menu_items.id
-- menu_items.id is text, but it holds long generated values ('m-1726587411234',
-- and uuids on other rows). Nobody is typing that into a portal field by hand,
-- and a venue that mistypes one character gets silence. item_code is 3 to 16
-- letters and digits, written by a person, readable on a screen: FLATWHITE,
-- CAESARSAL.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE APP WORKS FULLY BEFORE THIS FILE RUNS
-- ────────────────────────────────────────────────────────────────────────────
-- Nothing depends on the column existing:
--   src/lib/itemCode.js          isMissingItemCodeColumn() is the single test.
--   Back Office item editor      reads id + item_code once when it opens. If
--                                the column is missing the field is simply not
--                                rendered. No error, no red banner.
--   src/lib/db.js upsertMenuItem writes item_code only when the item carries
--                                the field, and if the write is refused for a
--                                missing column it SAVES THE ITEM AGAIN without
--                                it. A menu save is never lost over this.
--   ezCater Item matching screen selects item_code and, if that select is
--                                refused, selects again without it: the "Copy
--                                item codes" button is then hidden.
--   ezCater ingest               reads the menu with item_code and falls back to
--                                without. A missing column means no code rule,
--                                which is exactly today's behaviour: the order
--                                still arrives and still matches by name.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THE UNIQUE INDEX IS ON upper(btrim(item_code))
-- ────────────────────────────────────────────────────────────────────────────
-- Matching a partner's id against a code is case insensitive and trimmed, so
-- 'flatwhite ' and 'FLATWHITE' are the same code to the matcher. If the table
-- allowed both at one venue, one ezCater line would have two right answers and
-- the food would go to whichever row was read first. So the database refuses
-- the second one: two products at one venue can never share a code.
--
-- It is PARTIAL (item_code is not null) so the thousands of products with no
-- code do not collide with each other, and it is per LOCATION so two venues can
-- each have their own FLATWHITE.

-- Never sit behind a long running lock on a live venue.
set lock_timeout = '3s';

-- Fail fast in the wrong database rather than creating a stray column there.
do $$
begin
  if to_regclass('public.menu_items') is null then
    raise exception 'wrong database: public.menu_items is missing. This file is for the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

begin;

alter table public.menu_items add column if not exists item_code text;

comment on column public.menu_items.item_code is
  'Short code we give a partner for this product (ezCater POS id). 3 to 16 letters and digits, upper case, unique per location, case insensitive. Null means the product has none, which is allowed everywhere.';

-- Dropped and re-added so a re-run repairs a half applied file.
-- Deliberately LOOSE: the app enforces 3 to 16 upper case letters and digits.
-- The database only refuses the two values that would break the index or the
-- screens, a blank string and something far too long to be a code.
alter table public.menu_items drop constraint if exists menu_items_item_code_check;
alter table public.menu_items add constraint menu_items_item_code_check
  check (item_code is null or (length(btrim(item_code)) between 1 and 32));

-- Two products at one venue can never share a code.
create unique index if not exists menu_items_item_code_unique
  on public.menu_items (location_id, upper(btrim(item_code)))
  where item_code is not null;

-- "Which product is this code?", the lookup the ezCater matcher does on every
-- order line that carries a posItemId.
create index if not exists menu_items_item_code_idx
  on public.menu_items (location_id, item_code)
  where item_code is not null;

commit;

-- A new column is invisible to PostgREST until it reloads its schema cache, so
-- without this the app keeps getting PGRST204 for the column that now exists.
notify pgrst, 'reload schema';

-- ── If the unique index REFUSES to build ────────────────────────────────────
-- Only possible if codes were written straight into the table by hand before
-- this ran. Find the clashes first, fix them, then run this file again:
--
--   select location_id, upper(btrim(item_code)) as code, count(*), array_agg(id)
--   from public.menu_items
--   where item_code is not null
--   group by 1, 2 having count(*) > 1;

-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- begin;
-- drop index if exists public.menu_items_item_code_unique;
-- drop index if exists public.menu_items_item_code_idx;
-- alter table public.menu_items drop constraint if exists menu_items_item_code_check;
-- alter table public.menu_items drop column if exists item_code;
-- commit;
-- notify pgrst, 'reload schema';
--
-- WARNING: dropping the column throws away every code the venue typed, and the
-- ezCater portal still holds them on their side. Export the rows first:
--   select id, name, item_code from public.menu_items where item_code is not null;
