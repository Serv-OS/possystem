-- extra_schema.sql: what 20261019c reads beyond ../stock_phase0/schema.sql, in the live Ops shapes
-- (information_schema and pg_constraint, read only on 19 Oct 2026). Loaded after
-- ../stock_phase0/policies.sql and before the migrations. The Multi site menu helpers the file needs
-- (msm__second_step_ok, msm__require_servos, msm_viewable_org_ids, msm_can_edit) are copied from the
-- REAL 20261017 file by run.mjs at run time, so they can never drift from what Peter ran.

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, name text not null, code text,
  rate numeric not null default 0, type text not null default 'inclusive', applies_to text[] default array['all'],
  is_default boolean default false, active boolean default true, created_at timestamptz default now()
);
create table public.staff_members (
  id uuid primary key default gen_random_uuid(), location_id uuid references public.locations(id) on delete cascade,
  org_id uuid references public.organisations(id) on delete cascade, name text not null, role text default 'Server', pin text not null,
  color text default '#3b82f6', initials text, active boolean default true, created_at timestamptz default now(),
  permissions jsonb not null default '[]'::jsonb, nfc_card_id text, auth_method text not null default 'pin', auth_user_id text
);
create table public.par_levels (
  id uuid primary key default gen_random_uuid(), location_id uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  par_level numeric, reorder_point numeric, min_level numeric,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (location_id, inventory_item_id)
);
alter table public.par_levels enable row level security;
create policy par_levels_rls on public.par_levels for all using ((location_id)::text in (select user_accessible_locations()))
  with check ((location_id)::text in (select user_accessible_locations()));
alter table public.tax_rates enable row level security;
create policy tax_rates_read on public.tax_rates for select using (true);
alter table public.staff_members enable row level security;
