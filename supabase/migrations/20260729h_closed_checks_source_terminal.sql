-- ─────────────────────────────────────────────────────────────────────────────
-- 20260729h_closed_checks_source_terminal.sql   (OPS DB — APPLIED LIVE 29 Jul 2026)
--
-- closed_checks.source only allowed pos/kiosk/online/mobile/catering/hubrise.
-- v5.5.862 started stamping reconciler-booked checks with 'pax_table_pay' /
-- 'pos_send_to_terminal' — with NO accompanying migration — so EVERY check the
-- terminal-jobs reconciler tried to book was rejected by this constraint with
-- 23514, silently (the client mapped it to ok:false and, pre-v5.5.944, never
-- retried thanks to its own local tombstone).
--
-- Live case that found it: 29 Jul, B2, £57.55 Table-Pay on the A50 — card
-- captured (webhook-verified), sale visible only in the till's local History,
-- closed_checks row refused for 2 hours. The till's OfflineQueue replay landed
-- the row (ref R97) within seconds of this constraint being widened.
--
-- Lesson encoded: adding a NEW value to record.source in the client REQUIRES
-- widening this constraint in the same change.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table closed_checks drop constraint closed_checks_source_check;
alter table closed_checks add constraint closed_checks_source_check
  check (source = any (array[
    'pos'::text, 'kiosk'::text, 'online'::text, 'mobile'::text,
    'catering'::text, 'hubrise'::text,
    'pax_table_pay'::text, 'pos_send_to_terminal'::text
  ]));

commit;
