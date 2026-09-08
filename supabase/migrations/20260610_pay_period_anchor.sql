-- ============================================================================
-- Pay periods v2 — anchored fixed-length periods + pay day.
--
-- pay_period_type:      'monthly' | 'weekly' | 'fortnightly' | 'fourweekly'
-- pay_period_start_day: monthly only — day-of-month the period starts (26 → 26th–25th)
-- pay_period_anchor:    fixed-length only — the FIRST period's start date
--                       (e.g. 2026-06-12 → 12–25 Jun, 26 Jun–9 Jul, …)
-- pay_day:              monthly: day-of-month wages are paid (0 = last day);
--                       fixed-length: days after the period ends (1 = next day)
--
-- "Run payroll" resolves the period containing today from these and locks the
-- run to those exact dates, so past periods are reportable like-for-like.
-- ============================================================================

alter table wf_venue_settings add column if not exists pay_period_anchor date;
alter table wf_venue_settings add column if not exists pay_day int;
