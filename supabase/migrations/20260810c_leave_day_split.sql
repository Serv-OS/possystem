-- 20260810c_leave_day_split.sql — WHICH days of a request are annual leave.
--
-- A 7-day request from a Mon-Fri full-timer is 5 days of holiday + 2 ordinary
-- days off (Peter, 10 Aug). The approver sees a proposed split (rota >
-- availability > worked-weekday history > contract) and can override any day;
-- only the marked days deduct. The chosen dates are stored here so the payslip
-- and any dispute can see exactly which days were valued.

alter table public.wf_time_off
  add column if not exists leave_days jsonb;   -- ['2026-08-03', ...] the ANNUAL LEAVE subset
