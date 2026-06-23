-- 20260625_operations_checklists.sql
-- Operations slice 4: task management / checklists. Reuses the ops foundation
-- (corrective_actions / ops_alerts / ops_audit) and the same scheduling model as
-- temperature. Additive. RLS = the correct per-location fence (wf_* form).

-- Template: a named checklist for an area, on a schedule, assigned to a role.
create table if not exists ops_checklists (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  name          text not null,
  area          text not null default 'BOH'
                  check (area in ('BOH','FOH','MOD','opening','closing','cleaning','delivery','other')),
  frequency     text not null default 'daily' check (frequency in ('daily','weekly','monthly')),
  days_of_week  integer[] not null default '{}',     -- 0=Sun..6=Sat; empty = every day
  time_of_day   text,                                -- 'HH:MM' due time (nullable = anytime)
  grace_minutes integer not null default 120,
  assignee_role text,                                -- 'Staff' | 'MOD' | role name
  active        boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ops_checklists_loc_idx on ops_checklists(location_id) where archived_at is null;

-- Template tasks (ordered). type: simple check / value entry / photo. evidence_required
-- forces a photo before close; temp_unit_id deep-links into the matching temperature round.
create table if not exists ops_checklist_tasks (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  checklist_id    uuid not null references ops_checklists(id) on delete cascade,
  label           text not null,
  sort_order      integer not null default 0,
  task_type       text not null default 'check' check (task_type in ('check','value','photo')),
  evidence_required boolean not null default false,
  temp_unit_id    uuid references temp_units(id) on delete set null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists ops_checklist_tasks_cl_idx on ops_checklist_tasks(checklist_id, sort_order);

-- A day's run of a checklist (created lazily when staff open it).
create table if not exists ops_checklist_runs (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid,
  checklist_id  uuid not null references ops_checklists(id) on delete cascade,
  run_date      date not null,
  status        text not null default 'open' check (status in ('open','complete')),
  completed_by  uuid, completed_by_name text, completed_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (location_id, checklist_id, run_date)
);
create index if not exists ops_checklist_runs_loc_idx on ops_checklist_runs(location_id, run_date desc);

-- Per-task completion within a run.
create table if not exists ops_task_completions (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  run_id        uuid not null references ops_checklist_runs(id) on delete cascade,
  task_id       uuid not null references ops_checklist_tasks(id) on delete cascade,
  done          boolean not null default true,
  value_text    text,                                -- value entry / note
  photo_url     text,
  completed_by  uuid, completed_by_name text,
  completed_at  timestamptz not null default now(),
  unique (run_id, task_id)
);
create index if not exists ops_task_compl_run_idx on ops_task_completions(run_id);

alter table ops_checklists        enable row level security;
alter table ops_checklist_tasks   enable row level security;
alter table ops_checklist_runs    enable row level security;
alter table ops_task_completions  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ops_checklists','ops_checklist_tasks','ops_checklist_runs','ops_task_completions'] loop
    execute format('drop policy if exists %I_rls on %I;', t, t);
    execute format($f$
      create policy %I_rls on %I for all
        using (location_id::text in (select user_accessible_locations()))
        with check (location_id::text in (select user_accessible_locations()));
    $f$, t, t);
  end loop;
end $$;
