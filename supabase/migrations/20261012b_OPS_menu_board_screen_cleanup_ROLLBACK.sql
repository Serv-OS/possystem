-- 20261012b_OPS_menu_board_screen_cleanup_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                         #
-- #  Peter runs this by hand. Not run by Claude.                             #
-- #  HOW TO UNDO 20261012b. This file is a NOTE. It changes nothing          #
-- #  and puts nothing back by itself. The statement below only counts.       #
-- ############################################################################
--
-- WHY THERE IS NO FIXED ROLLBACK SQL (12 Oct 2026). 20261012b removes the rows its rule lists at
-- the moment it runs, so which rows went is only known then. It hands them back to you: the
-- first result row has a cell called "undo". That cell is the rollback, written for that run.
--
-- TO PUT THE ROWS BACK.
--   1. Open the Ops SQL editor (project tbetcegmszzotrwdtqhi).
--   2. Paste the text of the "undo" cell. It starts with
--        insert into public.menu_board_screens select * from jsonb_populate_recordset(
--      and it is one statement.
--   3. Run it. Every removed row is back, with its id, code, venue, board and dates.
--   4. Run the statement at the bottom of this file. The total is back to what it was.
--   If it says a row already exists (duplicate key): the rows are already back. Do nothing.
--
-- IF THE "undo" CELL WAS LOST. Nothing a TV uses was removed, so there is nothing to repair.
--   The worst case is one TV on its pairing code: in Back Office, Channels, Menu boards, type
--   the code and pick the board. Tell Claude, so the removed rows can be looked at.
--
-- WHEN YOU WOULD WANT TO UNDO. Only if a TV that was showing its board went to its pairing code
-- right after 20261012b ran. The rule cannot list a row a TV is using (and stops if a listed
-- row was seen in the last hour), so this is not expected.
--
-- WHAT YOU SHOULD SEE from the statement below (read only): one row per venue with how many
-- screen rows it has now, and how many were seen in the last 10 minutes (the TVs that are on).

select coalesce(l.name, '(no venue)') as venue,
       count(*) as screen_rows,
       count(*) filter (where s.last_seen_at > now() - interval '10 minutes') as on_now
  from public.menu_board_screens s
  left join public.locations l on l.id = s.location_id
 group by 1
 order by 1;
