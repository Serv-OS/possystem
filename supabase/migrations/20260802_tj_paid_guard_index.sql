-- 20260802_tj_paid_guard_index.sql   (OPS DB)
--
-- Index for the occupation-aware paid-table guard (20260801). Its
-- status='approved' EXISTS on check_key runs once per Table-Pay start and once
-- PER OPEN TABLE per terminal_open_tables poll, and the only check_key index
-- (idx_tj_one_live_per_check) is partial over live statuses only — so the guard
-- seq-scanned terminal_jobs, an append-only table with no retention. Fine today,
-- linearly worse forever. Additive, no uniqueness semantics.

create index if not exists idx_tj_paid_guard on terminal_jobs (check_key)
  where status = 'approved';
