-- 20260918_OPS_ezcater_menu_sync.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, create table if not exists, create index if not
-- exists, unschedule then schedule. Safe to run twice.
--
-- "SYNC ezCater MENU" (18 Sep 2026). The connected ezCater token can read the caterer's menus
-- (proven live, read only, with Peter's yes). Every item, size and option on the current menus
-- is written to ezcater_item_links BEFORE any order and matched to our menu by name at sync time,
-- so staff see matched, needs a decision and not on our menu before a single order arrives.
-- Peter: "we cant have it that we match products after an order has been placed".
--
-- WHAT THIS FILE ADDS
--   ezcater_item_links, six columns (all nullable or defaulted, nothing existing changes):
--     ez_ids           text[]  the PUBLISHED ezCater ids on the menu right now (a size id for an
--                              item, a customization value id for an option). An order line's
--                              menuItemSizeId / customizationId is one of these, so the line
--                              lands on this row. They change on every republish.
--     ez_original_ids  text[]  the original...Id of each: very likely stable across a republish,
--                              used only to carry a saved match across, never alone.
--     ez_size_name     text    the size, on a row for one size of an item with several
--     ez_category      text    the ezCater category, for the screen
--     ez_menu          text    the ezCater menu name, for the screen
--     synced_at        timestamptz  when a menu sync last changed this row's ezCater facts
--   ezcater_menu_syncs: one row per venue, the last sync (time, counts, menus, error).
--   pg_cron 'ezcater-menu-sync-hourly': calls ezcater-connect 'menu_sync_due' every hour; the
--   function syncs each venue whose last sync is a day old. Nothing is due, nothing happens.
--
-- THE APP WORKS BEFORE THIS FILE RUNS. Orders match by name exactly as before; the Item matching
-- screen lists what it always listed; "Sync menu" says this file has to be run first.
--
-- ORDER OF OPERATIONS
--   1. Deploy ezcater-connect and ezcater-webhook FIRST (edge functions do not deploy with the
--      web app):
--        npx supabase functions deploy ezcater-connect --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--        npx supabase functions deploy ezcater-webhook --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      A schedule pointing at a function that does not know 'menu_sync_due' logs a 400 an hour.
--   2. Run this file.

set lock_timeout = '3s';

do $$
begin
  if to_regclass('public.ezcater_item_links') is null then
    raise exception 'wrong database, or 20260917_OPS_ezcater_item_links.sql has not run: ezcater_item_links is missing. Run that first, on the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

begin;

alter table public.ezcater_item_links add column if not exists ez_ids text[] not null default '{}';
alter table public.ezcater_item_links add column if not exists ez_original_ids text[] not null default '{}';
alter table public.ezcater_item_links add column if not exists ez_size_name text;
alter table public.ezcater_item_links add column if not exists ez_category text;
alter table public.ezcater_item_links add column if not exists ez_menu text;
alter table public.ezcater_item_links add column if not exists synced_at timestamptz;

-- "Which row holds this published id", for anyone looking by hand. The functions read a venue's
-- rows whole and index them in memory, so this is for support queries, not the hot path.
create index if not exists ezcater_item_links_ez_ids_idx
  on public.ezcater_item_links using gin (ez_ids);

create table if not exists public.ezcater_menu_syncs (
  location_id      text primary key,
  status           text,             -- 'running' | 'ok' | 'partial' | 'error'
  reason           text,             -- 'staff' | 'daily' | 'republish'
  last_attempt_at  timestamptz,
  last_synced_at   timestamptz,
  counts           jsonb,
  menus            jsonb,
  error            text,
  updated_at       timestamptz not null default now()
);

-- Service role only, the same fence as ezcater_item_links: Back Office reads it through
-- ezcater-connect, never straight off the table.
alter table public.ezcater_menu_syncs enable row level security;
revoke all on public.ezcater_menu_syncs from anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- ── The daily re-sync ───────────────────────────────────────────────────────
-- Same bridge and idiom as 20260909_edge_cron_adyen_unsent_sweep.sql: public.call_edge_fn
-- (20260805b_edge_cron_bridge.sql) with its vault held service role bearer. A database without
-- the bridge or pg_cron gets a warning and no schedule, never a failed file: staff can still
-- press "Sync menu", and an order with ids we have not seen still re-syncs.
do $$
declare j record;
begin
  if to_regprocedure('public.call_edge_fn(text, jsonb)') is null then
    raise warning 'public.call_edge_fn(text, jsonb) is missing - the daily ezCater menu sync was NOT scheduled. Apply 20260805b_edge_cron_bridge.sql, then run this file again.';
    return;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database - the daily ezCater menu sync was NOT scheduled.';
    return;
  end if;
  for j in
    select * from (values
      ('ezcater-menu-sync-hourly', '17 * * * *', $q$select public.call_edge_fn('ezcater-connect', '{"action":"menu_sync_due"}'::jsonb)$q$)
    ) as t(nm, sch, cmd)
  loop
    if exists (select 1 from cron.job where jobname = j.nm) then
      perform cron.unschedule(j.nm);
    end if;
    perform cron.schedule(j.nm, j.sch, j.cmd);
  end loop;
end;
$$;

-- ── Verify after applying ───────────────────────────────────────────────────
--   select column_name from information_schema.columns
--    where table_name = 'ezcater_item_links' and column_name in ('ez_ids','ez_original_ids','ez_size_name','ez_category','ez_menu','synced_at');
--   select jobname, schedule, active from cron.job where jobname = 'ezcater-menu-sync-hourly';
--   select location_id, status, reason, last_synced_at, counts from public.ezcater_menu_syncs;
--
-- ── Rollback (run manually to reverse) ──────────────────────────────────────
-- select cron.unschedule('ezcater-menu-sync-hourly');
-- begin;
-- drop table if exists public.ezcater_menu_syncs;
-- drop index if exists public.ezcater_item_links_ez_ids_idx;
-- alter table public.ezcater_item_links drop column if exists synced_at, drop column if exists ez_menu,
--   drop column if exists ez_category, drop column if exists ez_size_name,
--   drop column if exists ez_original_ids, drop column if exists ez_ids;
-- commit;
-- Rows a sync inserted stay (they are ordinary unmatched or matched rows); only the ezCater ids
-- on them go, and orders fall back to name matching exactly as before this file.
