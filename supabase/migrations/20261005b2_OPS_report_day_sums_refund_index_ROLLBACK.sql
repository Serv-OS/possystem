-- ROLLBACK for 20261005b2_OPS_report_day_sums_refund_index.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the small index that lists checks with a refund. Nothing else changes: no data, no
-- function. public.report_day_sums keeps working, its refund look back is only slower once
-- there is a lot of history.
--
-- ONE statement. Paste it ON ITS OWN (DROP INDEX CONCURRENTLY cannot run inside a
-- transaction). Safe during service: it never blocks a sale. Safe to run twice.

drop index concurrently if exists public.idx_closed_checks_refunded;
