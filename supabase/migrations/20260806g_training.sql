-- 20260806g_training.sql — the TRAINING system (TRAINING_MODULE_PLAN.md slice 1).
--
-- A MODULE is a course built in the Back Office: an ordered list of tasks, a
-- deadline in days, and optional auto-assignment (to new starters, filterable
-- by position). An ASSIGNMENT is one module given to one person, with per-task
-- ticks stamped server-side from the staff app (staff-portal fn).
--
-- Why not the ops checklists engine: those are per-LOCATION ("did the kitchen
-- do opening checks"); training is per-PERSON. Why not wf_documents: those are
-- EVIDENCE (a certificate), not activity.

begin;

create table if not exists public.wf_training_modules (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id uuid not null,
  name text not null,
  description text,
  tasks jsonb not null default '[]'::jsonb,       -- [{id, title, detail}]
  due_days int not null default 14,               -- deadline = assigned + due_days
  status text not null default 'active',          -- draft (AI output) | active | archived
  source text not null default 'manual',          -- manual | ai_reviews
  auto_assign boolean not null default false,     -- apply to new starters
  auto_assign_roles text[] not null default '{}', -- empty = every position
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wf_training_modules_status_check check (status in ('draft','active','archived'))
);
create index if not exists idx_wtm_loc on public.wf_training_modules (location_id, status);

create table if not exists public.wf_training_assignments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id uuid not null,
  module_id uuid not null references public.wf_training_modules(id) on delete cascade,
  staff_id uuid not null,
  assigned_at timestamptz not null default now(),
  assigned_by text,                               -- display name; provenance only
  due_date date,
  tasks_done jsonb not null default '[]'::jsonb,  -- [{taskId, at}] stamped SERVER-side
  completed_at timestamptz,
  verified_by uuid,
  status text not null default 'assigned',        -- assigned | complete
  constraint wf_training_assignments_status_check check (status in ('assigned','complete')),
  constraint wf_training_assignments_once unique (module_id, staff_id)
);
create index if not exists idx_wta_staff on public.wf_training_assignments (staff_id, status);
create index if not exists idx_wta_loc on public.wf_training_assignments (location_id, status);

-- Same tenant RLS as every other wf_ table: BO users see their venues; the
-- staff app never touches these directly (staff-portal fn, service_role).
do $$
declare t text;
begin
  foreach t in array array['wf_training_modules','wf_training_assignments'] loop
    execute format('alter table public.%I enable row level security', t);
    begin execute format($p$create policy %1$s_rls_select on %1$s for select using (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_insert on %1$s for insert with check (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_update on %1$s for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_delete on %1$s for delete using (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_super_admin_all on %1$s for all using (public.is_super_admin()) with check (public.is_super_admin())$p$, t); exception when duplicate_object then null; end;
  end loop;
end $$;

commit;
