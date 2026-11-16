-- 20261130a_OPS_head_office_hub.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Head office hub, slice 1 (16 Nov 2026, Mozz Pizza's ask: "a MOZZ Leadership App for my
-- company directors ... a live scorecard that ranks each store on prime cost ... private
-- weekly check ins only I can read ... current and future projects").
--
-- Six tables, all scoped to a company (org_id) and read through the rules Back Office already
-- uses: user_accessible_locations() for a site's rows, user_accessible_orgs() for a company's.
--
--   hq_daily_numbers      one row per site per business day for what the tills cannot know
--                         (cash on hand, open hires, turnover, morale, projected dayparts) and,
--                         for days before ServOS, typed or pasted sales, COGS and labour.
--   hq_projects           Internal projects: department, owner, status, due date, phases.
--   hq_tasks              the project's tasks and sub tasks (parent_task_id), owner, priority.
--   hq_project_updates    the update feed under a project (append only). The newest row is
--                         the card's "latest update".
--   hq_checkin_questions  the company's weekly check in questions (one row per company).
--   hq_checkins           a director's weekly answers. READ BY THE OWNER ROLE AND THE AUTHOR
--                         ONLY, enforced here, not on screen.
--
-- Owner = a login whose user_profiles.role is 'owner' in that company (the role that already
-- sees every site of the company), or a ServOS super admin. Directors are admin or manager
-- logins linked to the company's sites.
--
-- Safe to run twice. Rollback twin: 20261130a_OPS_head_office_hub_ROLLBACK.sql.
--
-- Verify afterwards (expect 6 rows, all true):
--   select relname, relrowsecurity from pg_class
--    where relname like 'hq\_%' and relkind = 'r' order by 1;
-- and (expect true, false for an owner and a manager login respectively):
--   select public.hq_is_company_owner('<org uuid>');

begin;

-- ----------------------------------------------------------------------------
-- 0. Helpers
-- ----------------------------------------------------------------------------
create or replace function public.hq_is_company_owner(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(public.is_super_admin(), false)
      or exists (
        select 1 from public.user_profiles p
         where p.id = auth.uid()
           and p.org_id = p_org
           and p.role = 'owner'
           and coalesce(p.bo_access, true));
$fn$;
revoke all on function public.hq_is_company_owner(uuid) from public;
grant execute on function public.hq_is_company_owner(uuid) to authenticated, service_role;

create or replace function public.hq_touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 1. Daily numbers
-- ----------------------------------------------------------------------------
create table if not exists public.hq_daily_numbers (
  location_id       uuid not null references public.locations(id) on delete cascade,
  business_date     date not null,
  org_id            uuid not null,
  cash_on_hand      numeric(14,2),
  reviews_count     integer check (reviews_count is null or reviews_count >= 0),
  review_rating     numeric(3,2) check (review_rating is null or (review_rating >= 0 and review_rating <= 5)),
  turnover_pct      numeric(6,2) check (turnover_pct is null or (turnover_pct >= 0 and turnover_pct <= 999)),
  morale_score      numeric(4,1) check (morale_score is null or (morale_score >= 0 and morale_score <= 10)),
  hires_needed      integer check (hires_needed is null or hires_needed >= 0),
  projected_lunch   numeric(14,2),
  projected_dinner  numeric(14,2),
  projected_late    numeric(14,2),
  net_sales         numeric(14,2),
  cogs              numeric(14,2),
  labour            numeric(14,2),
  notes             text,
  source            text not null default 'typed' check (source in ('typed', 'csv')),
  created_by        uuid default auth.uid(),
  created_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (location_id, business_date)
);
create index if not exists idx_hq_daily_numbers_org_date on public.hq_daily_numbers (org_id, business_date desc);

drop trigger if exists trg_hq_daily_numbers_touch on public.hq_daily_numbers;
create trigger trg_hq_daily_numbers_touch before update on public.hq_daily_numbers
  for each row execute function public.hq_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Internal projects, tasks, updates
-- ----------------------------------------------------------------------------
create table if not exists public.hq_projects (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid references public.locations(id) on delete set null,   -- null = all sites
  name            text not null check (length(trim(name)) > 0),
  description     text,
  department      text not null default 'operations'
                  check (department in ('operations', 'hr', 'finance', 'marketing', 'store_leadership')),
  status          text not null default 'planning'
                  check (status in ('planning', 'in_progress', 'at_risk', 'blocked', 'done', 'cancelled')),
  owner_id        uuid,
  owner_name      text,
  start_date      date,
  due_date        date,
  phases          jsonb not null default '[]'::jsonb,
  archived_at     timestamptz,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_hq_projects_org on public.hq_projects (org_id, archived_at, status);

drop trigger if exists trg_hq_projects_touch on public.hq_projects;
create trigger trg_hq_projects_touch before update on public.hq_projects
  for each row execute function public.hq_touch_updated_at();

create table if not exists public.hq_tasks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.hq_projects(id) on delete cascade,
  org_id          uuid not null,
  parent_task_id  uuid references public.hq_tasks(id) on delete cascade,
  title           text not null check (length(trim(title)) > 0),
  description     text,
  status          text not null default 'todo'
                  check (status in ('todo', 'in_progress', 'blocked', 'done')),
  priority        text not null default 'P2' check (priority in ('P0', 'P1', 'P2', 'P3')),
  owner_id        uuid,
  owner_name      text,
  phase           text,
  start_date      date,
  due_date        date,
  depends_on_id   uuid references public.hq_tasks(id) on delete set null,
  blocked_reason  text,
  sort_order      integer not null default 0,
  completed_at    timestamptz,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_hq_tasks_project on public.hq_tasks (project_id, parent_task_id, sort_order);
create index if not exists idx_hq_tasks_owner on public.hq_tasks (org_id, owner_id) where status <> 'done';

drop trigger if exists trg_hq_tasks_touch on public.hq_tasks;
create trigger trg_hq_tasks_touch before update on public.hq_tasks
  for each row execute function public.hq_touch_updated_at();

create table if not exists public.hq_project_updates (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.hq_projects(id) on delete cascade,
  task_id     uuid references public.hq_tasks(id) on delete set null,
  org_id      uuid not null,
  kind        text not null default 'update' check (kind in ('update', 'activity')),
  body        text not null check (length(trim(body)) > 0),
  author_id   uuid default auth.uid(),
  author_name text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_hq_project_updates_project on public.hq_project_updates (project_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. Weekly check ins
-- ----------------------------------------------------------------------------
create table if not exists public.hq_checkin_questions (
  org_id      uuid primary key,
  questions   jsonb not null default '[]'::jsonb,
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.hq_checkins (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  week_start  date not null,
  department  text not null
              check (department in ('operations', 'hr', 'finance', 'marketing', 'store_leadership')),
  location_id uuid references public.locations(id) on delete set null,
  author_id   uuid not null default auth.uid(),
  author_name text,
  answers     jsonb not null default '{}'::jsonb,
  score       integer check (score is null or (score >= 1 and score <= 5)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- One check in per person, week, department and site. A resend updates it.
create unique index if not exists uq_hq_checkins_one_per_week
  on public.hq_checkins (author_id, week_start, department, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists idx_hq_checkins_org_week on public.hq_checkins (org_id, week_start desc);

drop trigger if exists trg_hq_checkins_touch on public.hq_checkins;
create trigger trg_hq_checkins_touch before update on public.hq_checkins
  for each row execute function public.hq_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Row level security
-- ----------------------------------------------------------------------------
alter table public.hq_daily_numbers     enable row level security;
alter table public.hq_projects          enable row level security;
alter table public.hq_tasks             enable row level security;
alter table public.hq_project_updates   enable row level security;
alter table public.hq_checkin_questions enable row level security;
alter table public.hq_checkins          enable row level security;

-- Daily numbers: anyone who can manage the site in Back Office.
drop policy if exists hq_daily_numbers_select on public.hq_daily_numbers;
create policy hq_daily_numbers_select on public.hq_daily_numbers for select to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()));
drop policy if exists hq_daily_numbers_insert on public.hq_daily_numbers;
create policy hq_daily_numbers_insert on public.hq_daily_numbers for insert to authenticated
  with check ((location_id)::text in (select public.user_accessible_locations())
              and org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_daily_numbers_update on public.hq_daily_numbers;
create policy hq_daily_numbers_update on public.hq_daily_numbers for update to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()))
  with check ((location_id)::text in (select public.user_accessible_locations()));

-- Projects, tasks, updates: the whole company's leadership reads and writes them.
drop policy if exists hq_projects_all on public.hq_projects;
create policy hq_projects_all on public.hq_projects for all to authenticated
  using (org_id::text in (select public.user_accessible_orgs()))
  with check (org_id::text in (select public.user_accessible_orgs()));

drop policy if exists hq_tasks_all on public.hq_tasks;
create policy hq_tasks_all on public.hq_tasks for all to authenticated
  using (org_id::text in (select public.user_accessible_orgs()))
  with check (org_id::text in (select public.user_accessible_orgs()));

drop policy if exists hq_project_updates_select on public.hq_project_updates;
create policy hq_project_updates_select on public.hq_project_updates for select to authenticated
  using (org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_project_updates_insert on public.hq_project_updates;
create policy hq_project_updates_insert on public.hq_project_updates for insert to authenticated
  with check (org_id::text in (select public.user_accessible_orgs()) and author_id = auth.uid());

-- Questions: the company reads them, the owner writes them.
drop policy if exists hq_checkin_questions_select on public.hq_checkin_questions;
create policy hq_checkin_questions_select on public.hq_checkin_questions for select to authenticated
  using (org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_checkin_questions_write on public.hq_checkin_questions;
create policy hq_checkin_questions_write on public.hq_checkin_questions for all to authenticated
  using (public.hq_is_company_owner(org_id))
  with check (public.hq_is_company_owner(org_id));

-- Check ins: the author and the company owner, nobody else.
drop policy if exists hq_checkins_select on public.hq_checkins;
create policy hq_checkins_select on public.hq_checkins for select to authenticated
  using (author_id = auth.uid() or public.hq_is_company_owner(org_id));
drop policy if exists hq_checkins_insert on public.hq_checkins;
create policy hq_checkins_insert on public.hq_checkins for insert to authenticated
  with check (author_id = auth.uid() and org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_checkins_update on public.hq_checkins;
create policy hq_checkins_update on public.hq_checkins for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- Grants: Back Office logins only (no anon: no till or tablet reads these). Service role for
-- the admin wipe and support.
grant select, insert, update on public.hq_daily_numbers to authenticated;
grant select, insert, update, delete on public.hq_projects to authenticated;
grant select, insert, update, delete on public.hq_tasks to authenticated;
grant select, insert on public.hq_project_updates to authenticated;
grant select, insert, update on public.hq_checkin_questions to authenticated;
grant select, insert, update on public.hq_checkins to authenticated;
grant all on public.hq_daily_numbers, public.hq_projects, public.hq_tasks, public.hq_project_updates,
             public.hq_checkin_questions, public.hq_checkins to service_role;

-- Second step fence (docs/SECOND_STEP.md): a login that has not done its second step reads
-- and writes nothing here, like every other Back Office table since 20260919s.
do $fence$
declare t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    raise notice 'second_step_ok() not found: fence not added (run 20260919s again later to add it).';
    return;
  end if;
  foreach t in array array['hq_daily_numbers', 'hq_projects', 'hq_tasks', 'hq_project_updates',
                           'hq_checkin_questions', 'hq_checkins'] loop
    if not exists (select 1 from pg_policy p
                    where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format(
        'create policy second_step_fence on public.%I as restrictive for all to authenticated '
        'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$fence$;

commit;
