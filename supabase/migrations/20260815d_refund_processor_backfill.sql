-- 20260815d — repair closed checks that name the WRONG payment processor.
--
-- ⚠️ HAND-APPLY ONLY. Do not run this from a script. Read it, run the SELECT at
-- the bottom first to see what it would touch, then run the UPDATE.
--
-- NO SCHEMA CHANGE. This is a data repair: it corrects existing rows and adds
-- nothing. The refund rebuild (v5.6.79, tasks #107 + #108) needs no new columns —
-- the per-refund tip/service/tax split and the per-leg reversal outcomes ride in
-- the existing `closed_checks.refunds` jsonb.
--
-- ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
-- `PaxTerminal.jsx` hardcoded `processor: 'ryft'` in its onComplete. So a card
-- sale taken on an ADYEN reader and finished ON THE TILL booked
-- `closed_checks.processor = 'ryft'`, while the very same sale closed by the
-- reconciler (`closeApprovedTerminalJob`, which reads `job.processor`) booked
-- 'adyen'. Two closers, two answers, one sale.
--
-- Refunds route by `closed_checks.processor`, so every mislabelled row would send
-- its reversal to Ryft — a processor that has never heard of the transaction.
-- The code is fixed from v5.6.79 forward; this repairs the rows already written.
--
-- ── WHY terminal_jobs IS THE AUTHORITY ──────────────────────────────────────
-- `terminal_jobs.processor` is set server-side by terminal-job-create from the
-- terminal's own record, never by the till. It is the same field the till already
-- trusts to decide whether to kick adyen-terminal-charge. `closed_check_id` is
-- pre-minted at dispatch and is the single-closer election key, so the join is
-- exact and one-to-one — not a heuristic.
--
-- Only SETTLED jobs are trusted (a pending job's processor is still the default),
-- and only rows that actually disagree are touched, so this is idempotent and
-- re-runnable.

begin;

-- ── 1. Look before you leap. Run this on its own first. ─────────────────────
-- Expect a small number of rows, all 'ryft' -> 'adyen', all at Adyen venues.
--
--   select c.id, c.ref, c.closed_at, c.processor as booked, j.processor as actual,
--          c.total, c.location_id
--     from public.closed_checks c
--     join public.terminal_jobs j on j.closed_check_id = c.id
--    where j.status in ('approved', 'reconciled')
--      and j.processor is not null
--      and c.processor is distinct from j.processor
--    order by c.closed_at desc;

-- ── 2. The repair ───────────────────────────────────────────────────────────
update public.closed_checks c
   set processor = j.processor
  from public.terminal_jobs j
 where j.closed_check_id = c.id
   and j.status in ('approved', 'reconciled')
   and j.processor is not null
   and c.processor is distinct from j.processor;

-- ── 3. Verify — this must return zero rows afterwards. ──────────────────────
--
--   select count(*) from public.closed_checks c
--     join public.terminal_jobs j on j.closed_check_id = c.id
--    where j.status in ('approved','reconciled')
--      and j.processor is not null
--      and c.processor is distinct from j.processor;

commit;

-- ── NOT REPAIRED, ON PURPOSE ────────────────────────────────────────────────
-- A mislabelled check with NO terminal_jobs row cannot be proven either way, and
-- guessing a processor on a money path is worse than leaving it alone. Those
-- refund attempts now fail LOUDLY at the processor (v5.6.79 records the failure
-- on the refund and leaves it retryable) instead of silently doing nothing, which
-- is the outcome we want when the answer is genuinely unknown.
