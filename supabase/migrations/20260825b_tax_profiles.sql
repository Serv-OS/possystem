-- 20260825b_tax_profiles.sql  (ops DB - hand-apply via the SQL editor)
--
-- TAX PROFILES, slice 1: schema only. A profile is a named stack of tax lines
-- (rate or per-unit, inclusive or exclusive, compounding, order-type scoped)
-- attached to a location, assignable per item / per category / as the venue
-- default. NOTHING reads these tables yet - the engine (src/lib/taxEngine.js)
-- lands dark in the same release and no consumer is switched. Applying this
-- migration changes zero behaviour on any till or customer page.
--
-- Re-runnable: every statement is IF NOT EXISTS / drop-then-create.

begin;

-- ── tax_profiles ─────────────────────────────────────────────────────────────
create table if not exists public.tax_profiles (
  id                     uuid primary key default gen_random_uuid(),
  location_id            uuid not null,
  name                   text not null,
  description            text,
  -- rounding: {"mode":"half_up","level":"invoice"} - level 'invoice' rounds each
  -- tax line once across the whole order; 'item' rounds per order-line then sums.
  rounding               jsonb default '{"mode":"half_up","level":"invoice"}',
  active                 boolean default true,
  sort_order             integer default 0,
  -- set when this profile was synthesised from a legacy tax_rates row
  generated_from_rate_id uuid,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- ── tax_profile_lines ────────────────────────────────────────────────────────
create table if not exists public.tax_profile_lines (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.tax_profiles(id) on delete cascade,
  location_id  uuid not null,
  name         text not null,
  jurisdiction text,                                   -- e.g. 'City of Chicago', 'HMRC'
  line_type    text default 'rate' check (line_type in ('rate','per_unit')),
  rate         numeric(9,6) default 0 not null,        -- decimal fraction: 0.0625 = 6.25%
  flat_amount  numeric(10,4) default 0 not null,       -- per_unit lines: amount per unit
  mode         text default 'exclusive' check (mode in ('inclusive','exclusive')),
  compound     boolean default false not null,         -- taxes base + prior taxable lines
  taxable      boolean default false not null,         -- this line's amount joins later compound bases
  tax_basis    text default 'pre_discount' check (tax_basis in ('pre_discount','post_discount')),
  order_types  text[] default array['all'] not null,   -- ['all'] or explicit order types
  sort_order   integer default 0,                      -- processing order (compounding depends on it)
  active       boolean default true,
  created_at   timestamptz default now()
);

-- ── assignment columns ───────────────────────────────────────────────────────
alter table public.menu_items      add column if not exists tax_profile_id uuid;
alter table public.menu_categories add column if not exists tax_profile_id uuid;
alter table public.locations       add column if not exists default_tax_profile_id uuid;

-- ── indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_tax_profile_lines_profile on public.tax_profile_lines (profile_id);
create index if not exists idx_tax_profiles_location     on public.tax_profiles (location_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Reads: tills (anon-signed-in devices) and customer pages need the profiles to
-- compute tax, so SELECT is open to anon + authenticated. Writes: Back Office
-- only (authenticated). NO anon write grants anywhere. service_role bypasses
-- RLS and gets full table grants for edge functions.

alter table public.tax_profiles      enable row level security;
alter table public.tax_profile_lines enable row level security;

drop policy if exists "tax_profiles read"   on public.tax_profiles;
create policy "tax_profiles read" on public.tax_profiles
  for select to anon, authenticated using (true);

drop policy if exists "tax_profiles insert" on public.tax_profiles;
create policy "tax_profiles insert" on public.tax_profiles
  for insert to authenticated with check (true);

drop policy if exists "tax_profiles update" on public.tax_profiles;
create policy "tax_profiles update" on public.tax_profiles
  for update to authenticated using (true) with check (true);

drop policy if exists "tax_profiles delete" on public.tax_profiles;
create policy "tax_profiles delete" on public.tax_profiles
  for delete to authenticated using (true);

drop policy if exists "tax_profile_lines read"   on public.tax_profile_lines;
create policy "tax_profile_lines read" on public.tax_profile_lines
  for select to anon, authenticated using (true);

drop policy if exists "tax_profile_lines insert" on public.tax_profile_lines;
create policy "tax_profile_lines insert" on public.tax_profile_lines
  for insert to authenticated with check (true);

drop policy if exists "tax_profile_lines update" on public.tax_profile_lines;
create policy "tax_profile_lines update" on public.tax_profile_lines
  for update to authenticated using (true) with check (true);

drop policy if exists "tax_profile_lines delete" on public.tax_profile_lines;
create policy "tax_profile_lines delete" on public.tax_profile_lines
  for delete to authenticated using (true);

-- Table grants: anon may ONLY select; authenticated read+write; service_role full.
-- This project's default privileges auto-grant ALL to anon on new tables;
-- revoke first so the grants layer matches the policy layer (belt + braces,
-- RLS already blocks anon writes).
revoke all on public.tax_profiles, public.tax_profile_lines from anon;
grant select on public.tax_profiles, public.tax_profile_lines to anon;
grant select, insert, update, delete on public.tax_profiles, public.tax_profile_lines to authenticated;
grant all on public.tax_profiles, public.tax_profile_lines to service_role;

commit;

-- Verify after applying:
--   select polname, polroles::regrole[] from pg_policy
--   where polrelid in ('public.tax_profiles'::regclass, 'public.tax_profile_lines'::regclass);
