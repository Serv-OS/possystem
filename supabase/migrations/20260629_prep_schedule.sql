-- 20260629_prep_schedule.sql
-- Scheduled batch cooks ("prep schedule") for the ServOS Manager Kitchen tab. Additive + reversible.
--   prep_schedule — the recurring template: what to prep, how much, due by, which days. Edited in
--                   Back Office (Operations → Prep schedule). Read by the Manager app via the
--                   service-role manager-snapshot.
--   prep_log      — the daily completion record, written when a cook taps "Record" in the Manager
--                   Kitchen tab. One row per schedule item per day (partial-unique).
-- RLS: schedule = users with location access (BO). log = BO users OR a claimed ops/manager device
-- (ops_can_write covers both), so the paired device can read + record without an edge function.

create table if not exists prep_schedule (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  name          text not null,
  qty           numeric(12,3),
  unit          text,
  due_time      time,                       -- HH:MM the prep should be done by (venue-local)
  days_of_week  int[],                      -- 0=Sun .. 6=Sat; null/empty = every day
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists prep_schedule_loc_idx on prep_schedule(location_id, sort_order);

create table if not exists prep_log (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  org_id           uuid,
  schedule_id      uuid references prep_schedule(id) on delete set null,
  name             text not null,
  prep_date        date not null,
  actual_qty       numeric(12,3),
  unit             text,
  recorded_by      uuid,
  recorded_by_name text,
  recorded_at      timestamptz not null default now(),
  notes            text
);
-- one completion per scheduled item per day → supports upsert(onConflict). Ad-hoc logs (schedule_id
-- NULL) are unconstrained because NULLs are distinct in a Postgres unique index.
create unique index if not exists prep_log_unique_day on prep_log(location_id, schedule_id, prep_date);
create index if not exists prep_log_loc_date_idx on prep_log(location_id, prep_date desc);

alter table prep_schedule enable row level security;
alter table prep_log      enable row level security;

drop policy if exists prep_schedule_rls on prep_schedule;
create policy prep_schedule_rls on prep_schedule for all
  using (location_id::text in (select user_accessible_locations()))
  with check (location_id::text in (select user_accessible_locations()));

drop policy if exists prep_log_rls on prep_log;
create policy prep_log_rls on prep_log for all
  using (public.ops_can_write(location_id))
  with check (public.ops_can_write(location_id));

grant select, insert, update, delete on prep_schedule to authenticated, anon;
grant select, insert, update, delete on prep_log      to authenticated, anon;
