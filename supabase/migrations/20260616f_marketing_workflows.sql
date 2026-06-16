-- Marketing & Promotions — Slice 6: drip / workflow builder.
-- Additive. Org-scoped RLS. A workflow has an entry trigger + an ordered list of steps (each with a
-- delay, channel, content and optional offer). Customers are ENROLLED when they hit the entry trigger;
-- the daily engine ADVANCES each enrollment through its steps. Idempotency mirrors slice 4:
--   workflow_enrollments unique (workflow_id, customer_id)  → enrolled at most once.
--   workflow_step_sends  unique (enrollment_id, step_key)   → each step fires at most once per enrollment.

create table if not exists workflows (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  name          text not null,
  description   text,
  status        text not null default 'draft' check (status in ('draft','active','paused','archived')),
  entry_trigger jsonb not null default '{}'::jsonb,   -- { type:'signup'|'segment'|'birthday'|'manual', days_before?, segment_id? }
  segment_id    uuid,                                  -- optional global eligibility filter
  steps         jsonb not null default '[]'::jsonb,    -- [{ key, after_days, channel, subject, email_html, email_blocks, sms_body, offer_id }]
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists workflows_org_idx on workflows (org_id, created_at desc);
create index if not exists workflows_active_idx on workflows (status) where status = 'active';
alter table workflows enable row level security;
drop policy if exists workflows_read on workflows;
create policy workflows_read on workflows for select using (org_id::text in (select public.user_accessible_orgs()));

create table if not exists workflow_enrollments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  workflow_id   uuid not null,
  customer_id   uuid not null,
  status        text not null default 'active' check (status in ('active','completed','cancelled')),
  current_step  integer not null default 0,            -- index of the NEXT step to run
  next_run_at   timestamptz,                           -- when current_step is due
  enrolled_at   timestamptz not null default now(),
  completed_at  timestamptz
);
create unique index if not exists workflow_enrollments_uidx on workflow_enrollments (workflow_id, customer_id);
create index if not exists workflow_enrollments_due_idx on workflow_enrollments (workflow_id, status, next_run_at);
create index if not exists workflow_enrollments_org_idx on workflow_enrollments (org_id);
alter table workflow_enrollments enable row level security;
drop policy if exists workflow_enrollments_read on workflow_enrollments;
create policy workflow_enrollments_read on workflow_enrollments for select using (org_id::text in (select public.user_accessible_orgs()));

create table if not exists workflow_step_sends (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  workflow_id      uuid not null,
  enrollment_id    uuid not null,
  customer_id      uuid not null,
  step_key         text not null,
  channel          text,
  email_message_id uuid,
  sms_message_id   uuid,
  promo_code       text,
  status           text not null default 'pending' check (status in ('pending','sent','partial','skipped','failed')),
  error            text,
  created_at       timestamptz not null default now()
);
create unique index if not exists workflow_step_sends_uidx on workflow_step_sends (enrollment_id, step_key);
create index if not exists workflow_step_sends_org_idx on workflow_step_sends (org_id, created_at desc);
alter table workflow_step_sends enable row level security;
drop policy if exists workflow_step_sends_read on workflow_step_sends;
create policy workflow_step_sends_read on workflow_step_sends for select using (org_id::text in (select public.user_accessible_orgs()));
