-- 20260729g_planned_batches.sql — OPS DB
--
-- A SCHEDULE BUILDS THE BATCHES. The owner's words: "when a schedule exists it builds
-- the batches to prep and has a to-complete status." Until now the schedule and the
-- batch history only met at the moment of recording — nothing showed the work TO DO.
--
-- production_batches gains a PLANNED state plus the links that let a schedule
-- materialise one row per scheduled day, idempotently:
--   schedule_id + planned_for carry a UNIQUE index, so however many screens ask
--   "ensure today's planned batches exist" at once, each cook-day yields exactly ONE row.
-- Completing a planned batch (actual qty entered) is what consumes ingredients and
-- stocks the output — the same idempotent movement keys as before, keyed on the batch id.

begin;

alter table production_batches
  add column if not exists schedule_id uuid,
  add column if not exists planned_for date,
  add column if not exists due_time time;

alter table production_batches drop constraint if exists production_batches_status_check;
alter table production_batches add constraint production_batches_status_check
  check (status in ('PLANNED','DRAFT','COMPLETED','CANCELLED'));

create unique index if not exists production_batches_sched_day
  on production_batches (location_id, schedule_id, planned_for)
  where schedule_id is not null and status <> 'CANCELLED';

commit;
