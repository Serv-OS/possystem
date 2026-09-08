-- 20260804b_realtime_prune.sql — cut realtime broadcast load (scale hardening)
--
-- pg_stat_statements showed realtime WAL decoding as the #1 database load (4.4M calls):
-- every write to every published table is decoded + fanned out to subscribers. These five
-- tables have ZERO client subscriptions (verified by grep across src/ + print-agent.js on
-- 24 Jul 2026), yet two of them are the chattiest writers in the system:
--   terminal_jobs    — lease/status updates on every poll cycle (JobPoller polls by design)
--   terminal_devices — PAX heartbeat last_seen updates (REPLICA IDENTITY FULL row images!)
--   pos_nudges       — dead since nudges moved to activity_events
--   modifier_groups / print_routing — config tables, read at boot/config-push only
-- Dropping them from the publication stops the decode+broadcast work; the tables and all
-- reads/writes are completely unaffected. (printers / printer_health / printer_agents STAY —
-- the print agent and registry use realtime there.)

begin;

alter publication supabase_realtime drop table pos_nudges;
alter publication supabase_realtime drop table modifier_groups;
alter publication supabase_realtime drop table print_routing;
alter publication supabase_realtime drop table terminal_devices;
alter publication supabase_realtime drop table terminal_jobs;

commit;
