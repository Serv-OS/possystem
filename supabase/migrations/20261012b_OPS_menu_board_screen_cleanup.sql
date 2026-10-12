-- 20261012b_OPS_menu_board_screen_cleanup.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                         #
-- #  Peter runs this by hand. Not run by Claude.                             #
-- #  REMOVES old menu board screen ROWS that no TV uses (the ones the        #
-- #  night of 11 to 12 Oct left behind, and never paired leftovers).         #
-- #  No schema change. Run 20261012a (the PREVIEW) first and read it.        #
-- #  OPTIONAL: the TV fix does not need this file. Safe any time,            #
-- #  service included: it never touches a row a TV is using.                 #
-- ############################################################################
--
-- WHY (12 Oct 2026). On the night of 11 to 12 Oct one bad live update made every Coffee Boy
-- menu board TV but one forget which screen it was. Each TV then made itself a NEW row with a
-- new pairing code, and staff paired the TVs again by hand that morning. The OLD row of each TV
-- is still in the table. Nothing uses it. It shows in Back Office, Channels, Menu boards as a
-- paired screen that was last seen at 02:09 and never comes back. The table also holds rows
-- from first boots and tests that were never paired.
--
-- The cause is fixed in the app (src/lib/menuBoardPairing.js, the same release as this file).
-- THIS FILE IS NOT PART OF THAT FIX. The TVs work the same whether it is run or not.
-- One reason to run it soon after the TVs are on the new build: until the old rows are gone, a
-- TV whose screen you Remove in Back Office finds its old paired row and shows that board again.
--
-- NO SCHEMA CHANGE. No table, column, index, policy or function is touched. Only rows of
-- public.menu_board_screens, and only the ones the rule below lists.
--
-- WHICH ROWS GO. For each TV (device_uid) the row it uses NOW is the one seen most recently.
--   A  an OLDER paired row of a TV whose row in use is ALSO paired, was paired later and was
--      seen later. Silent for over 1 hour. These are the rows 12 Oct left behind.
--   B  a spare row of a TV that is not paired and is not the row in use. Silent for over 1 hour.
--      None today. This is what a TV leaves behind when it finds its own paired row again.
--   C  a row that was never paired (no venue, no board, no order screen) and has been silent
--      for 7 days. Old first boots and tests.
-- WHAT IS KEPT ON PURPOSE.
--   The row each TV uses now.
--   An older paired row of a TV that is sitting on a pairing code now: the new build makes that
--   TV go back to it by itself, so it must stay.
--   Any paired row that is the only row its TV has, however long it has been silent (a TV that
--   is switched off).
-- TWO LOCKS. Nothing is removed when more than 60 rows are listed, or when any listed row was
-- seen in the last hour. The first result row then says STOP and why.
--
-- HOW TO RUN (the same six steps are at the top of both files).
--   1. Open the Ops SQL editor (project tbetcegmszzotrwdtqhi).
--   2. Paste the PREVIEW file (20261012a). Run it. Nothing changes.
--   3. Read the list. The first row says how many rows would go.
--   4. Paste the clean up file (20261012b). Run it once, all of it.
--   5. The first row says what was removed. Copy the "undo" cell and send it to Claude.
--   6. Worst case: a TV shows its pairing code. Pair it again in Back Office.
--
-- WHAT YOU SHOULD SEE. One table.
--   Row 0, column "what":  REMOVED 30 of 58 rows. 28 stay.   (your numbers may differ)
--                          or  STOPPED, nothing removed: ...  with the reason.
--   Row 0, column "undo":  one long insert statement. It holds every removed row in full.
--                          COPY IT before you leave the page.
--   Then one row per screen row that went: why (A, B or C), venue, code, last seen.
--   In Back Office, Channels, Menu boards: the screens last seen in the night of 12 Oct are
--   gone, and every TV that is on still says Online.
--
-- REVIEWED (read only, against the live table, 12 Oct 2026 at 16:45 UTC; the numbers will move):
--   58 rows. 30 listed, 28 stay.
--   A  15 rows: Coffee Boy Preston 5, Barnsley 6, Huddersfield 4 (all last seen 12 Oct 02:09 UTC).
--   B  0 rows.
--   C  15 rows, no venue (last seen 14 Jun to 1 Oct).
--   Leeds and Headingley have nothing listed: each TV there holds one row.
--   STAY: Barnsley 7, Preston 5, Leeds 5, Huddersfield 4, Headingley 4 (all 25 were on at the
--   time, every TV in use) and Provo 3 (off at the time, each the only row of its TV).
--
-- ONE TRANSACTION. This file is ONE statement, and one statement is one transaction: it
-- removes every listed row or, if anything stops it, none. Paste the whole file and run it
-- as it is, never a part of it. There is no begin or commit to type.
-- RUNNING IT AGAIN IS SAFE. It removes only what the rule lists at that moment. Right after a
-- run that is nothing: "REMOVED 0 of 28 rows. 28 stay."
--
-- ROLLBACK. The "undo" cell of row 0 is the rollback: paste that one statement into the SQL
-- editor and run it, and every removed row is back exactly as it was. The steps, and what to
-- do if the cell was lost, are in 20261012b_OPS_menu_board_screen_cleanup_ROLLBACK.sql.
--
-- PROVEN (12 Oct 2026). The list: read only against the live table (above). The removal and
-- the undo: on a throwaway local copy of the 58 rows, not on live. First run "REMOVED 30 of 58
-- rows. 28 stay.", the undo cell put all 30 back with no difference, a second run removed 0.

-- RULE START (the same text, byte for byte, in the PREVIEW file and the REMOVE file)
with ranked as (
  select s.*,
         coalesce(s.last_seen_at, s.created_at) as seen_at,
         (s.location_id is not null and (s.board_id is not null or s.order_display_id is not null)) as is_paired,
         row_number() over (partition by s.device_uid
                            order by coalesce(s.last_seen_at, s.created_at) desc, s.created_at desc, s.id) as rn
    from public.menu_board_screens s
),
cur as (
  select device_uid, id as cur_id, is_paired as cur_paired, paired_at as cur_paired_at, seen_at as cur_seen
    from ranked where rn = 1
),
pick as (
  select r.id, r.device_uid, r.location_id, r.code, r.status, r.seen_at, r.created_at, r.paired_at,
    case
      when r.rn > 1 and r.is_paired and c.cur_paired
           and c.cur_paired_at is not null and (r.paired_at is null or c.cur_paired_at > r.paired_at)
           and c.cur_seen > r.seen_at and r.seen_at < now() - interval '1 hour'
        then 'A: old paired row. This TV was paired again and uses a newer row.'
      when r.rn > 1 and not r.is_paired and r.seen_at < now() - interval '1 hour'
        then 'B: spare row. This TV uses another row.'
      when r.location_id is null and r.board_id is null and r.order_display_id is null
           and r.status = 'unpaired' and r.seen_at < now() - interval '7 days'
        then 'C: never paired, silent for 7 days.'
    end as why
  from ranked r join cur c using (device_uid)
),
gate as (
  select count(*) filter (where why is not null) as listed,
         count(*) filter (where why is not null and seen_at > now() - interval '1 hour') as listed_live,
         count(*) as total
    from pick
)
-- RULE END
, gone as (
  delete from public.menu_board_screens s
   using pick p, gate g
   where s.id = p.id and p.why is not null
     and g.listed_live = 0 and g.listed <= 60
  returning s.*, p.why
)
select 0 as n,
       case when g.listed_live > 0 then 'STOPPED, nothing removed: ' || g.listed_live || ' listed row(s) were seen in the last hour'
            when g.listed > 60 then 'STOPPED, nothing removed: ' || g.listed || ' rows listed, more than the 60 this file allows'
            else 'REMOVED ' || (select count(*) from gone) || ' of ' || g.total || ' rows. ' || (g.total - (select count(*) from gone)) || ' stay.' end as what,
       null::text as venue, null::text as code, null::text as last_seen,
       (select 'insert into public.menu_board_screens select * from jsonb_populate_recordset(null::public.menu_board_screens, '
               || quote_literal(jsonb_agg(to_jsonb(x) - 'why')::text) || '::jsonb);' from gone x) as undo
  from gate g
union all
select (row_number() over (order by x.why, l.name nulls last, x.last_seen_at))::int, x.why, coalesce(l.name, '(no venue)'), x.code,
       to_char(coalesce(x.last_seen_at, x.created_at) at time zone 'utc', 'DD Mon YYYY HH24:MI') || ' UTC', null
  from gone x left join public.locations l on l.id = x.location_id
 order by n;
