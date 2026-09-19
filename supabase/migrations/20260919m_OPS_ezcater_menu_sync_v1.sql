-- 20260919m_OPS_ezcater_menu_sync_v1.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, create table if not exists, create or replace function,
-- alter column set default, unschedule then schedule. Safe to run twice. Nothing is removed, and
-- no row is edited; the one change to an existing column is a default on `source`.
--
-- "SYNC ezCater MENU", the conservative version (feat/ezcater-menu-sync-v1, 18 Sep 2026).
-- The connected ezCater token can read the caterer's menus (proven live, read only). A sync
-- writes every item, every size of a multi size item and every option value into
-- ezcater_item_links BEFORE any order, with the ids ezCater published them under, and auto links
-- only plain item names that match exactly (every automatic row is decided again on every sync).
-- Options, and names with symbols or emoji, are left for staff on the Item matching card.
--
-- EXACT BY CONSTRUCTION (review round 4). A synced row's ez_key is 'exact:' plus the EXACT full
-- name of one ezCater product (the item plus its size, or the option's group and value; only
-- case, accents and punctuation folded), so two products whose names differ by any word never
-- share a row, its ids or a decision. Rows saved before the sync (keys without 'exact:') are
-- never written by a sync and are never used by an order once this file has run; a staff
-- decision on one is copied to the synced row of the same product when the sync first writes it.
-- No new column is needed for that: ez_key is text.
--
-- REVIEW ROUND 5. The exact form keeps every letter and number in any script, number fractions
-- and every symbol or emoji ("Ziti ½ Pan" is not "Ziti ¼ Pan", "Pho 大" is not "Pho"), and an
-- option row is scoped to its ITEM: 'exact:<item>|<group>|<value>', so one staff match on
-- "Size: Large" never routes Size: Large on another item. ez_item_name (added below) is that
-- item's name, for the Item matching card. A copy of this file run before round 5 lacks it:
-- run this file again (idempotent) before the next sync, or the sync's writes fail and say so.
--
-- REVIEW ROUND 6. No schema change: only the text of new keys. A plain name (letters, digits,
-- spaces, . , ' & ( ) - / and accents) is keyed folded by case, Latin accents and whitespace only;
-- any other name is keyed by its text as ezCater wrote it. An option key holds its item, group and
-- value as a JSON array ('exact:["<item>","<group>","<value>"]'), and decided_as of an option holds
-- them as a JSON object. Rows written under round 4 or 5 keys stay, are never written again, and
-- never route; their staff decisions are carried to the new rows.
--
-- ONCE THIS FILE HAS RUN, ORDERS ONLY USE MATCHES MADE BEFORE THE ORDER, AND ONLY FOR THE EXACT
-- NAME THEY WERE MADE FOR: an order line matches only when its exact full name (its name plus its
-- size name) is a synced row's, its published size id is on that row, and the row holds a staff
-- match or an exact auto link from a sync. There is no name guessing at order time at all; every
-- other line prints by name.
--
-- WHAT THIS FILE ADDS
--   ezcater_item_links, seven columns (all nullable or defaulted), and a default of 'auto' on
--   source so the refresh upsert (which never names source) is accepted, see below:
--     ez_ids        text[]       the PUBLISHED ezCater ids (a size id on an item row, a value
--                                id on an option row). They change on every republish; each
--                                sync ADDS the new ones and keeps the old ones (a synced row's
--                                exact full name never changes, so every id on it was published
--                                for the same product), so an order placed before a republish
--                                still matches when it is changed.
--                                (The order's menuItemSizeId IS the menu's sizes.id, proven on
--                                HKX77V; the order's item id is never matched.)
--     ez_size_name  text         set only on a row for ONE size of an item with several sizes,
--                                part of its exact full name ('exact:<item> <size>'). An order
--                                line uses a synced row only when its own name and size name are
--                                that exact full name, its published size id is on the row, and
--                                the row holds a staff match or an exact auto link (matched_by
--                                'exact').
--     ez_only_size  text         the ONE size name of a single size item, shown on the Item
--                                matching card and part of its exact full name.
--     ez_category   text         the ezCater category, for the screen
--     synced_at     timestamptz  when a sync last wrote this row's ezCater facts
--     decided_as    text         the full ezCater name (item and its size, or group and value)
--                                a person saw when they last saved this row, or, for a decision
--                                a sync carried over from a row saved before it, what that row
--                                showed. When it is not the row's exact full name the Item
--                                matching card asks staff to look at it again, and orders do not
--                                use the decision until they have.
--     ez_item_name  text         set only on an OPTION row: the ezCater item it customizes,
--                                part of its exact full name (the first part of its key).
--   ezcater_menu_syncs: one row per venue, the last sync, and the ONE SYNC PER VENUE lock.
--   ezcater_menu_sync_claim(): takes that lock in one statement (service role only).
--   pg_cron 'ezcater-menu-sync-hourly': asks ezcater-connect for the venues that are due (no
--     good sync for 20 hours), so each venue syncs about once a day.
--
-- THE APP WORKS BEFORE THIS FILE RUNS. Orders match by name exactly as main does, the Item
-- matching card lists what it always listed, and "Sync ezCater menu" says this file has to be
-- run first.
--
-- RUN ORDER (docs/EZCATER_V1_RELEASE.md, "Menu sync, a later release")
--   1. Deploy ezcater-connect, then ezcater-webhook (edge functions do not deploy with the web
--      app). Both work before this file runs: they prove the columns are missing and keep the
--      old rules.
--   2. Run this file, outside service. From then on orders only use matches made before the
--      order: until the first sync, every ezCater line prints by name.
--   3. Straight away, press "Sync ezCater menu" on Item matching, so lines have rows to match.
--   Needs 20260917_OPS_ezcater_item_links.sql first (checked below).

set lock_timeout = '3s';

do $$
begin
  if to_regclass('public.ezcater_item_links') is null then
    raise exception 'wrong database, or 20260917_OPS_ezcater_item_links.sql has not run: ezcater_item_links is missing. Run that first, on the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

begin;

alter table public.ezcater_item_links add column if not exists ez_ids text[] not null default '{}';
alter table public.ezcater_item_links add column if not exists ez_size_name text;
alter table public.ezcater_item_links add column if not exists ez_category text;
alter table public.ezcater_item_links add column if not exists synced_at timestamptz;
alter table public.ezcater_item_links add column if not exists ez_only_size text;
alter table public.ezcater_item_links add column if not exists decided_as text;
alter table public.ezcater_item_links add column if not exists ez_item_name text;

-- THE REFRESH NEEDS THIS. A sync refreshes an existing row with an upsert that names ONLY the
-- ezCater fact columns (names, ids, size, category, synced_at), never `source`, so a staff match keeps
-- source 'manual'. But Postgres builds the full INSERT tuple before ON CONFLICT DO UPDATE runs,
-- and `source` is NOT NULL: with no default that tuple is rejected, every refresh of an existing
-- row fails, and after a republish new size ids never arrive. With a default the tuple is
-- accepted and DO UPDATE sets only the columns the upsert named, so each row keeps its own
-- source. 'auto' is also what every automatic insert already writes. Idempotent.
alter table public.ezcater_item_links alter column source set default 'auto';

-- "Which row holds this published id", for support queries. The functions read a venue's rows
-- whole (paged) and index them in memory.
create index if not exists ezcater_item_links_ez_ids_idx
  on public.ezcater_item_links using gin (ez_ids);

create table if not exists public.ezcater_menu_syncs (
  location_id  text primary key,
  status       text,            -- running | ok | partial | error | not_ready
  claim_id     uuid,            -- the running sync's claim; finishing is fenced on it
  reason       text,            -- staff | daily
  started_at   timestamptz,
  finished_at  timestamptz,
  last_ok_at   timestamptz,
  counts       jsonb,
  error        text,
  updated_at   timestamptz not null default now()
);

-- Service role only, the same fence as ezcater_item_links: Back Office reads it through
-- ezcater-connect, never straight off the table.
alter table public.ezcater_menu_syncs enable row level security;
revoke all on public.ezcater_menu_syncs from anon, authenticated;

-- ONE SYNC PER VENUE. A single conditional upsert, so two presses (or a press and the daily run)
-- cannot both start: the second one waits on the row the first wrote, sees status 'running' and
-- gets null back. A claim older than p_stale_seconds (a sync killed by the edge wall clock) can
-- be taken over.
create or replace function public.ezcater_menu_sync_claim(
  p_location_id text, p_reason text default 'staff', p_stale_seconds integer default 600
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim uuid := gen_random_uuid();
  v_got uuid;
begin
  if p_location_id is null or btrim(p_location_id) = '' then
    raise exception 'ezcater_menu_sync_claim: location required';
  end if;
  insert into public.ezcater_menu_syncs as s (location_id, status, claim_id, reason, started_at, error, updated_at)
  values (p_location_id, 'running', v_claim, p_reason, now(), null, now())
  on conflict (location_id) do update
    set status = 'running', claim_id = excluded.claim_id, reason = excluded.reason,
        started_at = now(), error = null, updated_at = now()
    where s.status is distinct from 'running'
       or s.started_at is null
       or s.started_at < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 600), 60))
  returning s.claim_id into v_got;
  return v_got;   -- null: another sync of this venue is running
end;
$$;

revoke all on function public.ezcater_menu_sync_claim(text, text, integer) from public, anon, authenticated;
grant execute on function public.ezcater_menu_sync_claim(text, text, integer) to service_role;

commit;

notify pgrst, 'reload schema';

-- ── The daily sync ───────────────────────────────────────────────────────────
-- Same bridge and idiom as 20260805b_edge_cron_bridge.sql. A database without the bridge or
-- pg_cron gets a warning and no schedule, never a failed file: staff can still press the button.
do $$
begin
  if to_regprocedure('public.call_edge_fn(text, jsonb)') is null then
    raise warning 'public.call_edge_fn(text, jsonb) is missing: the daily ezCater menu sync was NOT scheduled. Apply 20260805b_edge_cron_bridge.sql, then run this file again.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed: the daily ezCater menu sync was NOT scheduled.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'ezcater-menu-sync-hourly') then
    perform cron.unschedule('ezcater-menu-sync-hourly');
  end if;
  perform cron.schedule('ezcater-menu-sync-hourly', '23 * * * *',
    $q$select public.call_edge_fn('ezcater-connect', '{"action":"menu_sync_due"}'::jsonb)$q$);
end;
$$;

-- ── Verify after applying ───────────────────────────────────────────────────
--   seven rows expected:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'ezcater_item_links'
--      and column_name in ('ez_ids','ez_size_name','ez_only_size','ez_category','synced_at','decided_as','ez_item_name');
--   'auto'::text expected:
--   select column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'ezcater_item_links' and column_name = 'source';
--   select to_regprocedure('public.ezcater_menu_sync_claim(text, text, integer)');
--   select jobname, schedule, active from cron.job where jobname = 'ezcater-menu-sync-hourly';
--   select location_id, status, reason, last_ok_at, counts, error from public.ezcater_menu_syncs;
--
-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- select cron.unschedule('ezcater-menu-sync-hourly');
-- begin;
-- drop function if exists public.ezcater_menu_sync_claim(text, text, integer);
-- drop table if exists public.ezcater_menu_syncs;
-- drop index if exists public.ezcater_item_links_ez_ids_idx;
-- alter table public.ezcater_item_links alter column source drop default;
-- alter table public.ezcater_item_links drop column if exists ez_item_name, drop column if exists decided_as,
--   drop column if exists synced_at,
--   drop column if exists ez_category, drop column if exists ez_only_size,
--   drop column if exists ez_size_name, drop column if exists ez_ids;
-- commit;
-- Rows a sync inserted stay. Their keys start with 'exact:', which no order looks up before this
-- file, so they can be deleted by hand (the rows saved before the sync are untouched by it):
--   delete from public.ezcater_item_links where ez_key like 'exact:%';
