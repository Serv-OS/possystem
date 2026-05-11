-- v5.5.163 — Challenge 21 (UK alcohol ID check)
--
-- Two SQL blocks. Run the first on the PLATFORM Supabase project
-- (yhzjgyrkyjabvhblqxzu) and the second on the OPS project
-- (tbetcegmszzotrwdtqhi).
--
-- Both are idempotent (use IF NOT EXISTS) so running twice is safe.
--
-- ════════════════════════════════════════════════════════════════════
-- BLOCK 1 — PLATFORM DB (project yhzjgyrkyjabvhblqxzu)
-- ════════════════════════════════════════════════════════════════════

alter table public.locations
  add column if not exists challenge_21_enabled boolean default false,
  add column if not exists challenge_21_alcohol_category_ids text[] default '{}',
  add column if not exists challenge_21_trigger_every integer default 10,
  add column if not exists challenge_21_counter integer default 0;

comment on column public.locations.challenge_21_enabled IS
  'When true, POS shows the ID-check modal every Nth alcohol-containing sale.';
comment on column public.locations.challenge_21_alcohol_category_ids IS
  'Array of menu_categories.id values flagged as alcohol-containing.';
comment on column public.locations.challenge_21_trigger_every IS
  'Modal fires when challenge_21_counter reaches this value. Reset to 0 after each prompt.';
comment on column public.locations.challenge_21_counter IS
  'Live counter incremented on every closed check that contains an alcohol-flagged item.';

-- ════════════════════════════════════════════════════════════════════
-- BLOCK 2 — OPS DB (project tbetcegmszzotrwdtqhi)
-- ════════════════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";

create table if not exists public.challenge_21_checks (
  id uuid default uuid_generate_v4() primary key,
  location_id text not null,
  triggered_at timestamptz default now(),
  trigger_count integer,                    -- which Nth sale fired this check
  staff_id text,
  staff_name text,
  customer_first_name text,
  customer_last_name_initial text,
  id_type text,                             -- passport / driving_license / pass_card / national_id / military_id / other
  id_document_number text,
  cancelled boolean default false,
  cancel_reason text,
  created_at timestamptz default now()
);

create index if not exists idx_challenge_21_checks_location_time
  on public.challenge_21_checks (location_id, triggered_at desc);

alter table public.challenge_21_checks enable row level security;

-- Permissive policy for now — same shape as other ops tables. Tighten with
-- per-location/per-staff policies once we're past the dev phase.
drop policy if exists "allow all on challenge_21_checks" on public.challenge_21_checks;
create policy "allow all on challenge_21_checks"
  on public.challenge_21_checks for all
  using (true) with check (true);
