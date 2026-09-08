-- 20260806d_review_last_attempt.sql
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi
--
-- review-sync's sync_all batch REQUIRES this column. Without it the queue query fails and the
-- function returns a loud 500 on every pg_cron tick (deliberately loud — the same run used to
-- report `complete: true` having synced nothing, which is worse).
--
-- WHY A SECOND TIMESTAMP RATHER THAN REUSING last_synced_at
-- sync_all processes venues stalest-first, a few per invocation, because each one does a Google
-- OAuth exchange plus a reviews fetch and the whole run has to finish inside the edge function's
-- wall clock. The cursor is the ordering itself — pg_cron carries no state between ticks.
--
-- That only works if the cursor advances on every ATTEMPT. last_synced_at is written after the
-- review loop SUCCEEDS, so a venue that times out or throws keeps its old timestamp, sorts to the
-- front again next tick, and takes the same slot forever. Three consistently slow venues would
-- starve every other venue permanently.
--
-- last_synced_at cannot simply be repurposed: review-admin's get_config does `select('*')` and
-- hands it to the Back Office as the venue's last successful sync. Writing it on a FAILED attempt
-- would tell the operator their reviews are up to date when they are not.
--
-- So: last_attempt_at moves on every try, last_synced_at still means "last time this actually
-- worked". Ordering keys on the attempt; the UI keeps reading the success.

begin;

do $guard$
begin
  if to_regclass('public.review_platform_links') is null then
    raise exception
      'review_platform_links does not exist — this migration is for the OPS DB (tbetcegmszzotrwdtqhi). Aborting.';
  end if;
end
$guard$;

alter table public.review_platform_links
  add column if not exists last_attempt_at timestamptz;

comment on column public.review_platform_links.last_attempt_at is
  'Stamped by review-sync BEFORE each attempt, success or failure. sync_all orders its queue on coalesce(last_attempt_at, last_synced_at) so a failing venue rotates to the back instead of pinning the front of every run. Distinct from last_synced_at, which remains the last SUCCESSFUL sync and is what the Back Office displays.';

-- Left NULL on existing rows on purpose: coalesce(last_attempt_at, last_synced_at, '') sorts NULLs
-- first, so every venue gets one turn before the rotation settles. Backfilling from last_synced_at
-- would work too, but a first pass over everything is the friendlier start.

-- The queue query filters enabled links and orders on the two timestamps.
create index if not exists review_platform_links_sync_queue_idx
  on public.review_platform_links (last_attempt_at nulls first, last_synced_at nulls first)
  where enabled;

commit;


-- ── Verify ────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--    where table_name = 'review_platform_links' and column_name = 'last_attempt_at';   -- 1 row
--
-- Then, after review-sync is redeployed, confirm the cron job stops erroring:
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'review-request-scan' and d.start_time > now() - interval '2 hours'
--    order by d.start_time desc;
