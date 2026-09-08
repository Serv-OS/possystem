-- ============================================================================
-- v5.5.2 — Floor plan corruption recovery queries
-- ============================================================================
--
-- The bug: BackOfficeApp.jsx was loading floor plan data scoped to
-- user_profiles.location_id while every WRITE path used the rpos-bo-location
-- localStorage override. When those disagreed, upsertFloorTable silently
-- rewrote a row's location_id from A to B (because PK is id alone, and
-- onConflict:'id' allows location_id to be overwritten).
--
-- These queries help identify potential damage. They are READ-ONLY — run them
-- in the Supabase SQL editor and inspect the output before doing anything.
--
-- Project: tbetcegmszzotrwdtqhi  (RPOS Ops DB)
-- ============================================================================


-- 1. INVENTORY: how many tables per location? Sanity check the totals against
--    what each operator expects. If Loc 1 expected 12 tables and shows 8,
--    you've lost ~4 to Loc 2.
-- ----------------------------------------------------------------------------

select
  l.id          as location_id,
  l.name        as location_name,
  count(ft.id)  as table_count,
  string_agg(ft.label, ', ' order by ft.label) as labels
from locations l
left join floor_tables ft on ft.location_id = l.id
group by l.id, l.name
order by l.name;


-- 2. SUSPICIOUS LABELS: tables with the SAME label appearing under different
--    locations. Common labels (T1, B5, Bar 3) WILL legitimately exist in
--    multiple locations, so this isn't proof of corruption — it's a starting
--    point for review. Look at the `id` column: if two locations share a
--    label AND one was recently modified (`updated_at` close to a known
--    incident time), the surviving row may have started life at the other
--    location.
-- ----------------------------------------------------------------------------

select
  ft.label,
  count(distinct ft.location_id) as locations_with_label,
  array_agg(distinct l.name order by l.name) as location_names,
  array_agg(ft.id) as table_ids
from floor_tables ft
join locations l on l.id = ft.location_id
group by ft.label
having count(distinct ft.location_id) > 1
order by ft.label;


-- 3. RECENTLY-WRITTEN TABLES: rows whose `updated_at` (if your floor_tables
--    schema has one) is more recent than `created_at` by a meaningful margin.
--    A row that was last touched RIGHT around when an operator was working at
--    a different location is the prime candidate for being moved.
-- ----------------------------------------------------------------------------
-- Skip if floor_tables doesn't have updated_at — many older schemas only
-- track created_at. The bug doesn't preserve a paper trail itself; you'd need
-- the audit log or RLS read history to confirm.

select
  ft.id, ft.label, ft.location_id, l.name as location_name,
  ft.created_at,
  ft.updated_at,
  age(ft.updated_at, ft.created_at) as time_between_create_and_last_edit
from floor_tables ft
join locations l on l.id = ft.location_id
where ft.updated_at is not null
  and ft.updated_at > ft.created_at + interval '1 minute'
order by ft.updated_at desc
limit 100;


-- 4. CONFIG_PUSHES JSON ARCHEOLOGY: the snapshot pushed by the BO contains
--    a `tables` array. If a table currently sits under Loc B but was present
--    in the snapshot of Loc A's most recent push BEFORE the incident, that's
--    strong evidence it was moved.
--
--    Pull the most recent 5 snapshots per location. Inspect the snapshot's
--    tables array for any id that no longer lives at this location:
-- ----------------------------------------------------------------------------

with latest_pushes as (
  select
    cp.location_id,
    cp.snapshot,
    cp.created_at,
    row_number() over (partition by cp.location_id order by cp.created_at desc) as rn
  from config_pushes cp
)
select
  l.name as location_name,
  lp.location_id,
  lp.created_at as pushed_at,
  jsonb_array_length(lp.snapshot -> 'tables') as tables_in_snapshot,
  -- For each table in the snapshot, check whether it currently lives at this same location
  (
    select array_agg(jsonb_build_object(
      'snapshot_id', t->>'id',
      'snapshot_label', t->>'label',
      'currently_at', (select location_id from floor_tables where id = t->>'id')
    ))
    from jsonb_array_elements(lp.snapshot -> 'tables') t
    where (select location_id from floor_tables where id = t->>'id') is distinct from lp.location_id
  ) as tables_that_moved_or_were_deleted
from latest_pushes lp
join locations l on l.id = lp.location_id
where lp.rn <= 5
order by l.name, lp.created_at desc;


-- 5. SECTIONS COUNT BY LOCATION: not the floor plan corruption per se, but
--    if sections leaked across locations they'll show wrong counts too.
-- ----------------------------------------------------------------------------

select
  l.id   as location_id,
  l.name as location_name,
  count(s.id) as section_count,
  array_agg(s.label order by s.sort_order) as section_labels
from locations l
left join sections s on s.location_id = l.id
group by l.id, l.name
order by l.name;


-- ============================================================================
-- RESTORATION (DO NOT RUN AS-IS — copy, edit, then run on a single row)
-- ============================================================================
--
-- Once query 4 identifies a specific table id that should belong to Location A
-- but currently lives at Location B, restore it with a targeted update:
--
--   update floor_tables
--     set location_id = '<correct-location-uuid>'
--     where id = '<specific-table-id>';
--
-- Take a backup first:
--
--   create table floor_tables_backup_v552 as select * from floor_tables;
--
-- Then run each restoration as its own statement so you can verify the row
-- count is exactly 1 for each one before continuing. If a query returns
-- count > 1, abort and investigate — id is meant to be unique.
-- ============================================================================
