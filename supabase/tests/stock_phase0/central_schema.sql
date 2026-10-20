-- central_schema.sql: what 20261018c (central stock depletion, v5.11.77) reads beyond schema.sql, so the
-- REAL 20261018c file applies here as Peter ran it on 19 Oct 2026, before 20261019b. Taken from
-- ../central_stock/extra_schema.sql (live column types, Ops information_schema, 18 Oct 2026), minus the
-- stock tables schema.sql already has. Plus production's default ACL: every new function made by
-- postgres in public is granted EXECUTE to anon, authenticated and service_role, the trap each
-- migration must undo by name (loaded before any function, as on Ops).

alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

alter table public.locations add column if not exists is_demo boolean not null default false;

-- pg_cron stand in (the live signatures)
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$
  delete from cron.job where jobid = job_id returning true $$;

create table public.closed_checks (
  id text primary key,
  location_id text default 'loc-demo',
  table_id text, table_label text, staff_name text,
  items jsonb default '[]'::jsonb,
  subtotal numeric default 0, tax numeric default 0, total numeric default 0,
  payment_method text, covers integer default 0,
  closed_at timestamptz default now(),
  voided boolean default false, refunded boolean default false,
  ref text, server text, order_type text, customer jsonb,
  discounts jsonb default '[]'::jsonb, service numeric default 0, tip numeric default 0, method text,
  status text default 'paid', refunds jsonb default '[]'::jsonb,
  tax_breakdown jsonb default '[]'::jsonb, tax_amount numeric,
  staff_id uuid, customer_id uuid, source text default 'pos', loyalty jsonb, tenders jsonb, promo jsonb, gift_card jsonb
);
create index idx_closed_checks_location_closed_at on public.closed_checks (location_id, closed_at desc);
alter table public.closed_checks enable row level security;
-- the live policies: anyone signed in may insert for any venue; reads and updates are fenced
create policy "insert closed checks" on public.closed_checks for insert with check (true);
create policy closed_checks_read on public.closed_checks for select using (location_id in (select public.accessible_location_ids()));
create policy closed_checks_update on public.closed_checks for update using (location_id in (select public.accessible_location_ids()))
  with check (location_id in (select public.accessible_location_ids()));
grant select, insert, update, delete on public.closed_checks to anon, authenticated, service_role;

create table public.payment_proofs (
  id uuid primary key default gen_random_uuid(), processor text, payment_ref text, kind text, location_id text,
  amount_minor bigint, currency text, verified_at timestamptz, verified_by text, used_by_ref text, used_at timestamptz, meta jsonb);
alter table public.payment_proofs enable row level security;
create table public.public_order_tokens (
  location_id text not null, ref text not null, token text, placed_by uuid, paid boolean default false,
  created_at timestamptz default now(), primary key (location_id, ref));
alter table public.public_order_tokens enable row level security;

-- the realtime publication as live: closed_checks is in it, the stock tables are not
create publication supabase_realtime for table public.closed_checks;
