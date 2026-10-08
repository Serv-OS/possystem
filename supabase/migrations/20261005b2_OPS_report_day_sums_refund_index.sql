-- 20261005b2_OPS_report_day_sums_refund_index.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  OPTIONAL TODAY. Safe any time, service included.                         #
-- #  ONE statement. Paste it ON ITS OWN, with nothing else in the editor.     #
-- ############################################################################
--
-- WHY (Peter, 5 Oct 2026, multi site reports, decision 4: fast money totals from the server)
--   public.report_day_sums (20261005b) puts a refund on the day it was MADE. To find them it
--   looks at every check closed in the 400 days before the range and keeps the ones with a
--   refund. Today that is 7,609 checks and takes a few milliseconds. In a year it is about
--   470,000 checks and adds about 350 ms to every call (measured 5 Oct 2026 on a local copy).
--   This index lists ONLY the checks that carry a refund (47 of 7,609 today), so that look
--   back stays a few milliseconds however much history there is.
--
-- WHY IT IS SAFE DURING SERVICE
--   CONCURRENTLY: it never blocks a sale being written or read while it builds.
--   It is tiny (one entry per refunded check), so a sale costs nothing extra to write:
--   a check only enters it when its first refund is saved.
--   IF NOT EXISTS: running it twice does nothing the second time.
--   It changes no data and no function. The report works the same without it, only slower
--   once there is a lot of history.
--
-- WHY ITS OWN FILE
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction, and the SQL editor runs a
--   paste of several statements as one. So this file holds exactly one statement.
--
-- AFTER IT RUNS, check it (paste this line on its own; it must answer one row, true):
--   select i.indisvalid from pg_index i where i.indexrelid = 'public.idx_closed_checks_refunded'::regclass;
--   If it answers false (a build that was cut short), send Claude this message. The fix is
--   to drop it (20261005b2_OPS_report_day_sums_refund_index_ROLLBACK.sql) and run this again.
--
-- Rollback: 20261005b2_OPS_report_day_sums_refund_index_ROLLBACK.sql

create index concurrently if not exists idx_closed_checks_refunded
  on public.closed_checks (location_id, closed_at)
  where refunds is not null and refunds <> '[]'::jsonb;
