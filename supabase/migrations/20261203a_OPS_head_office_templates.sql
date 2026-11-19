-- 20261203a_OPS_head_office_templates.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Head office hub, slice 6 (18 Nov 2026, Peter: "do the project templates next"). One table and
-- one column, additive, safe to run twice. Needs 20261130a (hq_touch_updated_at, hq_projects).
--
--   hq_project_templates  a reusable internal project: name, department, description, the phases
--                         and a task tree (tasks jsonb, each task with a title, phase, priority,
--                         due_days from the project start and its sub tasks), plus duration_days
--                         for the project's own due date. Applying one creates an hq_projects row
--                         and its hq_tasks rows with real dates (the app does this, two passes:
--                         parents then sub tasks). Editing a template later never changes a project
--                         already made from it (a snapshot, posupject's rule).
--   hq_projects.template_id  which template a project was made from, null for a blank one. Kept
--                         when the template is archived or deleted (on delete set null).
--
-- Who may see what: the company (user_accessible_orgs), read and write, the same fence as
-- hq_projects. Archive by setting archived_at (the list hides it); delete is allowed too.
--
-- Verify: select relname, relrowsecurity from pg_class where relname like 'hq\_%' and relkind='r';
--         (11 rows, all true) and
--         select column_name from information_schema.columns where table_name = 'hq_projects' and column_name = 'template_id';
-- Rollback: 20261203a_OPS_head_office_templates_ROLLBACK.sql (drops the table and the column).

begin;

create table if not exists public.hq_project_templates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  name            text not null check (length(trim(name)) > 0),
  description     text,
  department      text not null default 'operations'
                  check (department in ('operations', 'hr', 'finance', 'marketing', 'store_leadership')),
  phases          jsonb not null default '[]'::jsonb check (jsonb_typeof(phases) = 'array'),
  tasks           jsonb not null default '[]'::jsonb check (jsonb_typeof(tasks) = 'array'),
  duration_days   integer check (duration_days is null or duration_days >= 0),
  archived_at     timestamptz,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.hq_project_templates is
  'Head office: a reusable internal project. tasks is a tree: [{"key","title","description","phase","priority","due_days","children":[...]}]; due_days counts from the project start date.';
create index if not exists idx_hq_project_templates_org on public.hq_project_templates (org_id, archived_at, department);

drop trigger if exists trg_hq_project_templates_touch on public.hq_project_templates;
create trigger trg_hq_project_templates_touch before update on public.hq_project_templates
  for each row execute function public.hq_touch_updated_at();

alter table public.hq_projects
  add column if not exists template_id uuid references public.hq_project_templates(id) on delete set null;
comment on column public.hq_projects.template_id is 'The template this project was made from (a snapshot: later edits to the template do not reach it). Null for a blank project.';

alter table public.hq_project_templates enable row level security;
drop policy if exists hq_project_templates_all on public.hq_project_templates;
create policy hq_project_templates_all on public.hq_project_templates for all to authenticated
  using (org_id::text in (select public.user_accessible_orgs()))
  with check (org_id::text in (select public.user_accessible_orgs()));

grant select, insert, update, delete on public.hq_project_templates to authenticated;
grant all on public.hq_project_templates to service_role;

-- Second step fence (docs/SECOND_STEP.md), as on every hq_ table.
do $fence$
begin
  if to_regprocedure('public.second_step_ok()') is null then
    raise notice 'second_step_ok() not found: fence not added (run 20260919s again later to add it).';
    return;
  end if;
  if not exists (select 1 from pg_policy p
                  where p.polrelid = 'public.hq_project_templates'::regclass and p.polname = 'second_step_fence') then
    create policy second_step_fence on public.hq_project_templates as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence$;

commit;
