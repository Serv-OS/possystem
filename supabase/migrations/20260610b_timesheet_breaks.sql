-- ============================================================================
-- Timesheet breaks v2 — segment detail + paid breaks.
--
-- breaks:          jsonb array of break segments [{ "start": iso, "end": iso }]
--                  recorded by the Time Clock (break_taken stays as the total
--                  minutes; segments give "when it started / when it ended").
-- paid_break_mins: minutes of break PAID on top of net worked hours. UK law
--                  (Working Time Regulations 1998 reg 12) entitles 18+ workers
--                  to a 20-min uninterrupted break when working > 6h (>4.5h →
--                  30 min for under-18s); the law does NOT require it to be
--                  paid — paying it is a venue policy, so it's per-timesheet
--                  with a venue default in wf_venue_settings.settings.
-- ============================================================================

alter table wf_timesheets add column if not exists breaks jsonb not null default '[]'::jsonb;
alter table wf_timesheets add column if not exists paid_break_mins int not null default 0;
