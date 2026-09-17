-- 20260917_OPS_ezcater_item_links.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: create table if not exists, create index if not exists, and a
-- drop/add for each constraint. Safe to run twice.
--
-- THE APP WORKS BEFORE THIS FILE RUNS. Nothing in this commit reads the table
-- yet. When a reader is added it must treat a missing table (Postgres 42P01) as
-- "no links saved", which is the same answer as an empty table, and the pure
-- rules in src/lib/ezcaterMatch.js already behave correctly on an empty list:
-- lines keep itemId = null and land as a plain text ticket, exactly as today.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THIS TABLE EXISTS
-- ────────────────────────────────────────────────────────────────────────────
-- ezCater gave us the Orders API but NOT the Menus API. The venue builds its
-- ezCater menu by hand in their Partner Portal, so an order line arrives with
-- posItemId = null. itemId is what KDS station routing, 86, stock depletion and
-- product reporting all key on, so today an ezCater order is a plain text
-- ticket: no station, no stock, no product mix.
--
-- This table is the venue's answer to "which of our products is that?", made
-- once and reused on every later order.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THE KEY IS A NORMALISED NAME, AND NOT AN ID
-- ────────────────────────────────────────────────────────────────────────────
-- Nothing else on an ezCater line can carry a link:
--
--   posItemId        stable, but ONLY ever set when somebody pushed a menu
--                    through the Menus API menuCreate, which we do not have.
--                    On a Partner Portal menu it is null. When it IS set it
--                    already names our item and needs no row here at all.
--   orderItems.uuid  the ORDER LINE, not the product. New on every order.
--   menuItemSizeId   ezCater's own menu side id. Every id of this shape in
--                    their docs is written "ezcater-menu-version-...", and
--                    publishing a menu returns a new menuUuid, so it looks
--                    scoped to a menu VERSION. ezCater nowhere promises it
--                    survives a republish. Keying on it would silently drop
--                    every link the day the venue edits their ezCater menu.
--
-- So ez_key is the NORMALISED NAME (and, for an option, the normalised group
-- name in front of it). The rule lives in src/lib/ezcaterMatch.js, mirrored in
-- supabase/functions/_shared/ezcaterMatch.ts, held together by
-- src/lib/ezcaterMatchParity.test.js: lower case, no punctuation, no bracketed
-- suffix, no catering noise ("per person", "serves 10"), no trailing size or
-- container word ("Large", "Half Pan", "Full Tray"). So
-- "Caesar Salad (Serves 10)" and "CAESAR SALAD, half pan" are ONE key.
--
-- The cost is honest and visible: if the venue RENAMES the item on ezCater, the
-- key changes and the match must be made again. That is why ez_name and
-- ez_group hold the venue's own spelling verbatim, so a screen can always show
-- what was actually seen rather than the flattened key.
--
-- ────────────────────────────────────────────────────────────────────────────
-- ACCESS
-- ────────────────────────────────────────────────────────────────────────────
-- Service role only, the same shape as ezcater_order_links in 20260825e: RLS on
-- with NO policies, plus an explicit revoke from anon and authenticated. These
-- rows decide where food is routed and what stock is taken, so a paired till or
-- an anonymous kiosk session must never be able to write one. Back Office reads
-- and writes them through an ezCater edge function, the same way it already
-- reads connection status, never straight off the table.
--
-- There is deliberately NO foreign key onto menu_items: ids there are text and
-- include locally generated 'm-' values, and a deleted item must not cascade a
-- venue's matching work away. A link pointing at an item that no longer exists
-- is caught at read time by autoLinkDecision, which refuses to reuse it and
-- suggests again instead.

-- Never sit behind a long running lock on a live venue.
set lock_timeout = '3s';

-- Fail fast in the wrong database rather than creating a stray table there.
do $$
begin
  if to_regclass('public.ezcater_order_links') is null then
    raise exception 'wrong database: ezcater_order_links is missing. Run 20260825e_ezcater.sql on the OPS project (tbetcegmszzotrwdtqhi) first.';
  end if;
end $$;

begin;

create table if not exists public.ezcater_item_links (
  location_id   text not null,
  kind          text not null,          -- 'item' (an order line) or 'option' (a customization)
  ez_key        text not null,          -- normalised name; for an option '<group>|<name>'
  ez_name       text not null,          -- the venue's own spelling, verbatim
  ez_group      text,                   -- ezCater customizationTypeName, verbatim, options only
  menu_item_id  text,                   -- our menu_items.id
  option_id     text,                   -- our modifier option id, options only
  source        text not null,          -- 'auto' (we matched it) or 'manual' (a person did)
  matched_by    text,                   -- who or what made it: a user id, or 'name', 'posItemId'
  seen_count    integer not null default 0,   -- how many ezCater lines have used this link
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (location_id, kind, ez_key)
);

-- Constraints are dropped and re-added so a re-run repairs a half applied file.
alter table public.ezcater_item_links drop constraint if exists ezcater_item_links_kind_check;
alter table public.ezcater_item_links add constraint ezcater_item_links_kind_check
  check (kind in ('item', 'option'));

alter table public.ezcater_item_links drop constraint if exists ezcater_item_links_source_check;
alter table public.ezcater_item_links add constraint ezcater_item_links_source_check
  check (source in ('auto', 'manual'));

-- An empty key would collapse every unnamed line onto one row and link them all
-- to the same product. The matcher returns '' for a name it cannot normalise
-- and the caller is supposed to skip it; this is the backstop.
alter table public.ezcater_item_links drop constraint if exists ezcater_item_links_key_check;
alter table public.ezcater_item_links add constraint ezcater_item_links_key_check
  check (length(btrim(ez_key)) > 0 and length(btrim(ez_name)) > 0);

-- A link must actually name something of ours, or it is a row that looks like a
-- match and routes nothing.
alter table public.ezcater_item_links drop constraint if exists ezcater_item_links_target_check;
alter table public.ezcater_item_links add constraint ezcater_item_links_target_check
  check (
    (kind = 'item'   and menu_item_id is not null and option_id is null)
    or
    (kind = 'option' and (option_id is not null or menu_item_id is not null))
  );

-- By location, newest seen first: the Back Office list of what ezCater has been
-- sending. The primary key already covers lookups by (location_id) and
-- (location_id, kind, ez_key), so this one exists for the ordering.
create index if not exists ezcater_item_links_loc_idx
  on public.ezcater_item_links (location_id, last_seen_at desc nulls last);

-- "What is linked to this product of ours", and the sweep to run when an item
-- is deleted or merged.
create index if not exists ezcater_item_links_item_idx
  on public.ezcater_item_links (location_id, menu_item_id)
  where menu_item_id is not null;

alter table public.ezcater_item_links enable row level security;
revoke all on public.ezcater_item_links from anon, authenticated;
-- (no policies, service role only)

commit;

-- A brand new table is invisible to PostgREST until it reloads its schema
-- cache, so without this the edge function gets "relation does not exist" for
-- as long as the cache is stale.
notify pgrst, 'reload schema';

-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- begin;
-- drop table if exists public.ezcater_item_links;
-- commit;
--
-- WARNING: dropping this table throws away every match the venue has made by
-- hand. There is no way to rebuild it from ezCater, because ezCater holds none
-- of it. Export the rows first.
