-- 20260624_operations_foundation.sql
-- ServOS Operations module — slices 1-2 foundation: temperature/HACCP logging with
-- corrective actions, the breach→maintenance→alert backbone, and the deliveries→stock
-- gate. Additive; orders AFTER the stock migrations (20260621*–20260623*).
--
-- Conventions (same as wf_* and stock): location_id uuid NOT NULL on every tenant
-- table (always resolved by the app, never a DB default); numeric (never float) for
-- temperatures/money; RLS via user_accessible_locations(); soft-delete (archived_at);
-- safety records (temp_readings, ops_audit) are append-only.

-- ── Paired operations tablet (claim-code + heartbeat, like menu_board_screens) ──
create table if not exists ops_devices (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid,                                   -- null until claimed to a venue
  org_id        uuid,
  device_uid    uuid not null default auth.uid(),       -- the anon/auth identity of the tablet
  name          text,
  claim_code    text,                                   -- shown on screen for BO to claim
  claimed_at    timestamptz,
  last_seen_at  timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists ops_devices_loc_idx on ops_devices(location_id);
create unique index if not exists ops_devices_code_idx on ops_devices(claim_code) where claim_code is not null;

-- ── Temperature units (the configurable assets/zones; thresholds = source of truth) ──
create table if not exists temp_units (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  name          text not null,
  type          text not null default 'fridge'
                  check (type in ('fridge','freezer','cold_hold','hot_hold','cooking','chill_down','delivery')),
  area          text,                                   -- 'Kitchen' / 'Front' / 'Store'
  target_min_c  numeric(6,2),                           -- in range when min ≤ reading ≤ max (°C)
  target_max_c  numeric(6,2),
  display_unit  text not null default 'C' check (display_unit in ('C','F')),
  guidance      text,                                   -- FSA best-practice tip shown at entry
  sort_order    integer not null default 0,
  active        boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists temp_units_loc_idx on temp_units(location_id) where archived_at is null;

-- ── Schedules: when each unit must be checked (a unit can have several rows: AM+PM) ──
create table if not exists temp_check_schedules (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null,
  temp_unit_id   uuid not null references temp_units(id) on delete cascade,
  label          text,                                  -- 'AM' / 'PM' / 'Close'
  frequency      text not null default 'daily' check (frequency in ('daily','weekly')),
  days_of_week   integer[] not null default '{}',       -- 0=Sun..6=Sat; empty = every day
  time_of_day    text not null,                         -- 'HH:MM' local
  grace_minutes  integer not null default 60,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists temp_sched_loc_idx  on temp_check_schedules(location_id);
create index if not exists temp_sched_unit_idx on temp_check_schedules(temp_unit_id);

-- ── Readings (append-only — corrections add corrective_actions, never overwrite) ──
create table if not exists temp_readings (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  temp_unit_id  uuid not null references temp_units(id) on delete cascade,
  schedule_id   uuid references temp_check_schedules(id) on delete set null,
  reading_c     numeric(6,2) not null,                  -- always stored in °C
  in_range      boolean not null,
  severity      text not null default 'none' check (severity in ('none','minor','major','critical')),
  source        text not null default 'manual' check (source in ('manual','delivery','probe')),
  operator_id   uuid,                                   -- staff_members.id
  operator_name text,                                   -- snapshot
  device_id     uuid,
  notes         text,
  recorded_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists temp_readings_loc_day_idx on temp_readings(location_id, recorded_at desc);
create index if not exists temp_readings_unit_idx    on temp_readings(temp_unit_id, recorded_at desc);

-- ── Maintenance requests (raise → assign → in_progress → resolved); auto-raised on breach ──
create table if not exists maintenance_requests (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  title         text not null,
  description   text,
  asset_type    text,                                   -- 'temp_unit' etc.
  asset_id      uuid,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'open' check (status in ('open','assigned','in_progress','resolved','cancelled')),
  reporter_id   uuid, reporter_name text,
  assignee_id   uuid, assignee_name text,
  source        text not null default 'manual' check (source in ('manual','temp_breach','delivery')),
  source_ref    uuid,                                   -- reading/delivery that spawned it
  photo_url     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists maint_loc_idx on maintenance_requests(location_id, created_at desc);
create index if not exists maint_status_idx on maintenance_requests(location_id, status);

create table if not exists maintenance_notes (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  request_id    uuid not null references maintenance_requests(id) on delete cascade,
  author_id     uuid, author_name text,
  note          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists maint_notes_req_idx on maintenance_notes(request_id, created_at);

create table if not exists maintenance_status_history (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  request_id    uuid not null references maintenance_requests(id) on delete cascade,
  from_status   text, to_status text not null,
  changed_by    uuid, changed_by_name text,
  changed_at    timestamptz not null default now()
);
create index if not exists maint_hist_req_idx on maintenance_status_history(request_id, changed_at);

-- ── Corrective actions (forced on a breach; immutable trigger ref) ──
create table if not exists corrective_actions (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  source_type   text not null check (source_type in ('temp_reading','checklist','delivery')),
  source_id     uuid not null,                          -- the reading/delivery (immutable)
  severity      text not null default 'minor',
  action        text not null,                          -- 'moved_stock'|'adjusted_thermostat'|'discarded'|'called_engineer'|...
  description   text,
  photo_url     text,
  operator_id   uuid, operator_name text,
  maintenance_request_id uuid references maintenance_requests(id) on delete set null,
  status        text not null default 'closed' check (status in ('open','in_progress','closed')),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);
create index if not exists corrective_loc_idx on corrective_actions(location_id, created_at desc);
create index if not exists corrective_src_idx on corrective_actions(source_type, source_id);

-- ── Manager alerts (in-app) + routing/escalation config ──
create table if not exists ops_alerts (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  type          text not null check (type in ('temp_breach','missed_check','overdue_task','maintenance','corrective')),
  severity      text not null default 'major',
  title         text not null,
  body          text,
  source_type   text, source_id uuid,
  target_role   text,                                   -- 'MOD'|'manager'|'admin'
  target_user_id uuid,
  status        text not null default 'sent' check (status in ('sent','acknowledged')),
  escalation_step integer not null default 0,
  acknowledged_by uuid, acknowledged_by_name text, acknowledged_at timestamptz, action_taken text,
  created_at    timestamptz not null default now()
);
create index if not exists ops_alerts_loc_idx on ops_alerts(location_id, created_at desc);
create index if not exists ops_alerts_open_idx on ops_alerts(location_id) where status = 'sent';

create table if not exists ops_notification_rules (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  org_id          uuid,
  event_type      text not null,                        -- 'temp_breach'|'missed_check'|...
  severity_min    text not null default 'major',
  channels        jsonb not null default '["inapp"]'::jsonb,   -- ['inapp','sms','email']
  recipients      jsonb not null default '[]'::jsonb,          -- [{role:'MOD'}|{userId:...}]
  escalate_after_min integer not null default 15,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists ops_rules_loc_idx on ops_notification_rules(location_id);

-- ── Deliveries: the temperature gate in front of PO receiving ──
create table if not exists deliveries (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  po_id         uuid references purchase_orders(id) on delete set null,
  supplier_id   uuid references suppliers(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending','accepted','rejected')),
  temperature_c numeric(6,2),
  in_range      boolean,
  checked_by    uuid, checked_by_name text,
  checked_at    timestamptz,
  rejection_reason text,
  corrective_action_id uuid references corrective_actions(id) on delete set null,
  received_at   timestamptz,                            -- when the PO was received into stock
  created_at    timestamptz not null default now()
);
create index if not exists deliveries_loc_idx on deliveries(location_id, created_at desc);
create index if not exists deliveries_po_idx  on deliveries(po_id);

-- ── Append-only, hash-chained HACCP audit trail (exact wf_audit pattern) ──
create table if not exists ops_audit (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  actor_id      uuid, actor_name text,
  action        text not null,
  entity_type   text, entity_id uuid,
  payload       jsonb,
  prev_hash     text, hash text,
  created_at    timestamptz not null default now()
);
create index if not exists ops_audit_loc_idx on ops_audit(location_id, created_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- Standard location-scoped tables: full CRUD for users with access to the location.
alter table ops_devices                enable row level security;
alter table temp_units                 enable row level security;
alter table temp_check_schedules       enable row level security;
alter table temp_readings              enable row level security;
alter table maintenance_requests       enable row level security;
alter table maintenance_notes          enable row level security;
alter table maintenance_status_history enable row level security;
alter table corrective_actions         enable row level security;
alter table ops_alerts                 enable row level security;
alter table ops_notification_rules     enable row level security;
alter table deliveries                 enable row level security;
alter table ops_audit                  enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'ops_devices','temp_units','temp_check_schedules','maintenance_requests','maintenance_notes',
    'maintenance_status_history','corrective_actions','ops_alerts','ops_notification_rules','deliveries'
  ] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I for all
        using (location_id in (select location_id from user_accessible_locations()))
        with check (location_id in (select location_id from user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;

-- Append-only tables (temp_readings, ops_audit): SELECT + INSERT only — no UPDATE/DELETE
-- policy, so RLS denies edits. Corrections are new corrective_actions rows, not overwrites.
do $$
declare t text;
begin
  foreach t in array array['temp_readings','ops_audit'] loop
    execute format('drop policy if exists %I_sel on %I;', t, t);
    execute format('drop policy if exists %I_ins on %I;', t, t);
    execute format('create policy %I_sel on %I for select using (location_id in (select location_id from user_accessible_locations()));', t, t);
    execute format('create policy %I_ins on %I for insert with check (location_id in (select location_id from user_accessible_locations()));', t, t);
  end loop;
end $$;
