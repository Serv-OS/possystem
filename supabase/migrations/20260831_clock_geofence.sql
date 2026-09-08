-- 20260831_clock_geofence.sql
-- Geofenced mobile clock in (ServOS staff app).
--
-- DECISION (Peter, 31 Aug 2026): a HARD BLOCK. A staff member outside the venue
-- radius cannot clock in from the phone at all. This is deliberate and is what
-- geofencing means. Two constraints make it enforceable rather than theatre:
--   1. Clocking is exposed ONLY inside the native staff app, never on the website,
--      so the browser devtools location override is not a vector.
--   2. Position comes from the NATIVE bridge (CoreLocation / Android Location),
--      not navigator.geolocation, and Android reports mock providers.
--
-- The server is the only judge. The phone sends a reading; workforce-clock /
-- staff-portal compute the distance against the pin below and allow or refuse.
-- A client that omits or fakes the verdict field changes nothing.
--
-- WHEN GPS GENUINELY FAILS (cellar, steel kitchen) the fallback is the venue
-- TABLET, which is physically inside the building and therefore already proves
-- presence. There is deliberately NO "location unavailable, allow anyway" path
-- on the phone, because that would be the loophole that voids the whole feature.
--
-- Coordinates are stored for the VENUE only. Staff coordinates are never stored:
-- the punch record keeps distance in metres and the verdict, nothing else.
-- Reversible: every statement is additive and guarded.


-- ── 1. The venue pin ────────────────────────────────────────────────────────
-- Deliberately on wf_venue_settings, NOT on locations. `locations` still carries
-- a legacy `USING(true)` policy (the pending Stage 3 lockdown), so anyone holding
-- the public app key could move the fence. wf_venue_settings is fenced properly
-- on all four operations by user_accessible_locations(), verified 31 Aug 2026.
--
-- Its own COLUMN rather than a key inside the existing `settings` jsonb, because
-- saveSettings() in src/staff/wfData.js rewrites that blob wholesale on every
-- save of the Workforce settings screen. A security control must not be able to
-- be blanked by an unrelated form submit.
alter table public.wf_venue_settings
  add column if not exists clock_geofence jsonb not null default '{}'::jsonb;

comment on column public.wf_venue_settings.clock_geofence is
  'Mobile clock-in geofence. Shape: {"enabled":bool,"lat":num,"lng":num,'
  '"radius_m":int,"accuracy_ceiling_m":int,"pinned_at":timestamptz,'
  '"pinned_by":uuid,"attested_at":timestamptz,"attested_by":uuid}. '
  'enabled=false (default) means phone clocking is OFF for this venue and only '
  'an in-venue device may clock. Read server-side with the service role; the '
  'phone never receives it, because the phone is never the judge.';

-- ── 2. Punch provenance on the timesheet ────────────────────────────────────
-- wf_timesheets records nothing today about HOW a punch arrived.
alter table public.wf_timesheets
  add column if not exists clock_in_source   text,
  add column if not exists clock_out_source  text,
  add column if not exists punch_id          uuid,
  add column if not exists times_estimated   boolean not null default false;

comment on column public.wf_timesheets.clock_in_source is
  'How the punch arrived: tablet | phone | manager. NULL = pre-dates this column.';
comment on column public.wf_timesheets.times_estimated is
  'TRUE when a manager supplied a missing clock in/out rather than it being punched. '
  'Stops estimated times being indistinguishable from real ones in a wage dispute.';

-- Retry safety: a flaky phone must never create two open shifts. This is a
-- DATABASE constraint deliberately, not a lookup the app performs.
create unique index if not exists wf_timesheets_punch_id_uniq
  on public.wf_timesheets (punch_id) where punch_id is not null;

-- ── 3. Punch evidence, separate from the append-only audit chain ────────────
-- Deliberately NOT wf_audit: that table is append-only and hash-chained, so
-- location evidence put there could never be corrected or aged out, which
-- breaks retention duties. This table is purgeable by design.
create table if not exists public.wf_clock_events (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations(id) on delete cascade,
  staff_id       uuid,
  timesheet_id   uuid,
  punch_id       uuid,
  kind           text not null,           -- in | out | break_start | break_end
  source         text not null,           -- phone | tablet | manager
  -- Evidence. NO coordinates: distance only, so we never build a record of
  -- where staff live. Peter's call, 31 Aug 2026.
  distance_m     integer,                 -- null = no usable reading
  accuracy_m     integer,
  verdict        text not null,           -- inside | outside | no_fix | mocked | not_enforced
  refused        boolean not null default false,
  platform       text,                    -- ios | android
  app_version    text,
  attested       boolean,                 -- native app integrity check passed
  created_at     timestamptz not null default now()
);

create index if not exists wf_clock_events_loc_time
  on public.wf_clock_events (location_id, created_at desc);
create index if not exists wf_clock_events_staff_time
  on public.wf_clock_events (staff_id, created_at desc);

-- Same tenant fence the rest of the workforce module uses.
alter table public.wf_clock_events enable row level security;

drop policy if exists wf_clock_events_tenant on public.wf_clock_events;
create policy wf_clock_events_tenant on public.wf_clock_events
  for select using (location_id::text in (select user_accessible_locations()));

-- Writes are service-role only (the clock edge functions). No client inserts.
revoke all on public.wf_clock_events from anon, authenticated;
grant select on public.wf_clock_events to authenticated;

-- ── 4. Retention: 90 days ───────────────────────────────────────────────────
-- Location evidence is monitoring data. It is kept only as long as it is useful
-- for resolving a disputed punch, then deleted.
create or replace function public.purge_wf_clock_events()
returns void language sql security definer set search_path to 'public' as $$
  delete from public.wf_clock_events where created_at < now() - interval '90 days';
$$;

comment on function public.purge_wf_clock_events is
  'Deletes clock evidence older than 90 days. Scheduled nightly via pg_cron.';


-- ── 5. Schedule the purge (run separately; pg_cron must be enabled) ─────────
-- select cron.schedule('wf-clock-events-purge', '30 3 * * *',
--                      $$select public.purge_wf_clock_events()$$);
