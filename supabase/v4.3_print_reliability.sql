-- Restaurant OS v4.3.0 — Print Reliability migration
-- Run ONCE in Supabase SQL editor:
--   https://supabase.com/dashboard/project/tbetcegmszzotrwdtqhi/sql
--
-- Safe to run multiple times (all statements are idempotent via IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Extend print_jobs with retry + claim + idempotency columns
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS claimed_by      TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts    INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_retry_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS context         JSONB,
  ADD COLUMN IF NOT EXISTS metadata        JSONB,
  ADD COLUMN IF NOT EXISTS processed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_id        TEXT,
  ADD COLUMN IF NOT EXISTS dismissed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kind            TEXT DEFAULT 'print';

-- Also normalise error column name (code uses both 'error' and 'error_message')
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 2. Unique index on idempotency_key so same job can never double-insert
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_idempotency_key_uniq
  ON print_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Dispatcher poll index — fast lookup for pending/failed jobs ready to retry
CREATE INDEX IF NOT EXISTS print_jobs_retry_poll_idx
  ON print_jobs (location_id, status, next_retry_at)
  WHERE status IN ('pending', 'failed');

-- 4. Claim-timeout index — fast lookup for jobs stuck in 'sending' or 'claimed'
CREATE INDEX IF NOT EXISTS print_jobs_claim_reclaim_idx
  ON print_jobs (location_id, status, claim_expires_at)
  WHERE status IN ('sending', 'claimed');

-- 5. Failure-queue index — fast lookup for the "Action required" panel
CREATE INDEX IF NOT EXISTS print_jobs_failure_queue_idx
  ON print_jobs (location_id, status, dismissed_at)
  WHERE status = 'failed_permanent' AND dismissed_at IS NULL;

-- 6. Ensure realtime publication includes print_jobs (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'print_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE print_jobs;
  END IF;
END $$;

-- 7. REPLICA IDENTITY FULL so UPDATE events carry all fields for realtime subscribers
ALTER TABLE print_jobs REPLICA IDENTITY FULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- Status value semantics (all TEXT, no enum):
--   pending           — queued, waiting to be claimed/dispatched
--   claimed           — a worker (master POS or agent) has claimed it
--   sending           — actively being transmitted to printer
--   printed           — confirmed printed (was 'done' in v4.2; both still accepted)
--   failed            — last attempt failed, retry pending (next_retry_at)
--   failed_permanent  — exhausted all retries, needs manual action (retry/dismiss)
--   dismissed         — operator chose to discard, hidden from failure UI
--   no-printer        — no printer mapped for this centre — KDS-only job
-- ──────────────────────────────────────────────────────────────────────────────
-- Retry schedule (enforced in PrintOrchestrator.js):
--   Attempt  1:   0s (immediate)
--   Attempt  2:   2s
--   Attempt  3:  10s
--   Attempt  4:  30s
--   Attempt  5: 120s
--   After attempt 5 → status='failed_permanent' (operator must retry/dismiss)
-- ──────────────────────────────────────────────────────────────────────────────
-- Kind values:
--   'print'      — dispatch to ESC/POS printer (hardware)
--   'cash_drawer' — pop cash drawer via attached printer
--   'kds'        — tracks a failed kds_tickets insert for unified failure UI
-- ──────────────────────────────────────────────────────────────────────────────
