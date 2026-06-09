-- ============================================================================
-- Workforce (staff management) schema — Ops DB (tbetcegmszzotrwdtqhi)
-- ----------------------------------------------------------------------------
-- LIVE FINANCIALS. This schema underpins pay, tronc (UK Tipping Act), holiday
-- accrual and right-to-work compliance. Hard rules encoded here:
--
--   * Money is numeric with explicit scale — never float. Amounts carry an
--     ISO-4217 currency code so each stored value is self-describing.
--   * Tenant fence is enforced IN THE DATABASE via the project's established
--     RLS helpers (user_accessible_locations / user_accessible_orgs from
--     20260429_tenant_rls.sql + 20260429_crm_tenant_rls.sql). Anonymous
--     kiosk/online/QR sessions authenticate as the `authenticated` role with
--     no user_locations rows, so these helpers return EMPTY for them → they
--     can never read payroll or employee PII. The previous "allow all (true)"
--     policy is GONE.
--   * Pay/compliance history is never silently destroyed: staff are
--     soft-deleted (status='leaver'); FKs onto staff are ON DELETE RESTRICT.
--   * The effective pay rate, its source, the contracted-week divisor and the
--     currency are SNAPSHOTTED onto each pay row so historical pay is
--     independently reproducible (cost = rate × hours) and auditable.
--   * Tronc payouts are reconciled to the penny (largest-remainder in the
--     compute layer) and stored as typed rows (wf_tronc_lines) with a
--     run-level total_paid + residual.
--   * Holiday accrual (12.07% statutory default, configurable per venue) is
--     captured in an append-only ledger (wf_holiday_accrual).
--   * wf_audit is append-only + tamper-evident (prev_hash/row_hash chain),
--     with typed amount/currency/reason.
--
-- Pay-critical WRITES go through service-role edge functions (server-side
-- compute, decided with the operator); service_role bypasses RLS by design.
--
-- STORAGE NOTE (load-bearing, enforced outside this file): the bucket(s)
-- backing wf_staff.photo_url and wf_documents.file_url MUST be PRIVATE with
-- per-tenant/path-scoped Storage RLS and served via short-lived signed URLs.
-- Never store public URLs to RTW / passport / payroll documents.
--
-- Idempotent: safe to re-run.
--
-- SELF-SUFFICIENT: this Ops DB did not yet have the tenant-RLS helper functions
-- (user_accessible_locations / user_accessible_orgs / is_super_admin), so they
-- are (re)created below VERBATIM from 20260429_tenant_rls.sql /
-- 20260429_crm_tenant_rls.sql / 20260430_super_admin_select.sql. CREATE OR
-- REPLACE means this is a no-op if those migrations are later applied — no drift.
-- Their backing tables (user_locations, user_profiles, locations.org_id) are
-- confirmed present on this DB.
-- ============================================================================

-- ── Tenant-RLS helper functions (idempotent; identical to the repo definitions) ──
create or replace function public.user_accessible_locations()
returns setof text language sql stable security invoker as $$
  select location_id::text from user_locations where user_id = auth.uid()
  union
  select location_id::text from user_profiles where id = auth.uid() and location_id is not null;
$$;

create or replace function public.user_accessible_orgs()
returns setof text language sql stable security invoker as $$
  select distinct l.org_id::text
    from locations l
   where l.id::text in (select public.user_accessible_locations());
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'super_admin' from user_profiles where id = auth.uid()), false);
$$;
do $$ begin grant execute on function public.is_super_admin() to authenticated; exception when others then null; end $$;

-- ── Tenant integrity: allow (location_id, org_id) composite FKs onto locations ──
-- id is already the PK so (id, org_id) is trivially unique; the constraint just
-- lets wf_* tables reference the pair, guaranteeing each row's location belongs
-- to its org (eliminates org/location mismatch as a class of bug).
do $$ begin
  alter table locations add constraint locations_id_org_uniq unique (id, org_id);
exception when duplicate_object then null; when duplicate_table then null; end $$;

-- ── Roles (rate card config) ────────────────────────────────────────────────
create table if not exists wf_roles (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  org_id          uuid not null,
  key             text not null,                         -- machine key e.g. 'bartender'
  label           text not null,
  grp             text not null,                         -- bar|floor|kitchen|mgmt|door
  pay_type        text not null default 'hourly',        -- hourly|ageBanded|salaried
  base_rate       numeric(10,2) check (base_rate is null or base_rate >= 0),
  salary_annual   numeric(12,2) check (salary_annual is null or salary_annual >= 0),
  contracted_week numeric(5,2)  not null default 40 check (contracted_week > 0),  -- salaried hourly-equiv divisor
  age_bands       jsonb not null default '[]'::jsonb,    -- [{minAge,maxAge,rate}] (rates validated app-side to 2dp/>=0)
  tronc_weight    numeric(6,2) not null default 1.0 check (tronc_weight >= 0),
  requires_sia    boolean not null default false,
  premium_eligible boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── Sections (coverage config) ──────────────────────────────────────────────
create table if not exists wf_sections (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null,
  org_id       uuid not null,
  name         text not null,
  color        text,
  min_coverage int not null default 1 check (min_coverage >= 0),
  peak_rules   jsonb not null default '[]'::jsonb,       -- [{days[],after,minCoverage}]
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, org_id)                                    -- enables composite tenant-match FKs
);

-- ── Per-venue (= location) workforce settings ───────────────────────────────
create table if not exists wf_venue_settings (
  location_id       uuid primary key,
  org_id            uuid not null,
  currency          char(3) not null default 'GBP',
  labour_target_pct numeric(5,4) not null default 0.2800
                      check (labour_target_pct >= 0 and labour_target_pct <= 1),  -- 0..1 fraction
  accrual_rate      numeric(6,5) not null default 0.12070
                      check (accrual_rate >= 0 and accrual_rate <= 1),            -- 12.07% statutory default
  premiums          jsonb not null default '{}'::jsonb,    -- {weekend,bankHoliday,night}
  sales_source      text not null default 'pos',           -- pos|manual
  settings          jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

-- ── Staff (HR records — ORG-scoped PII; may span venues) ─────────────────────
create table if not exists wf_staff (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  location_id         uuid not null,                     -- home/primary venue (for indexing + default scope)
  name                text not null,
  photo_url           text,                              -- PRIVATE bucket + signed URL only
  role_key            text,
  section_ids         uuid[] not null default '{}',
  primary_venue_id    uuid,                              -- a location id
  venue_ids           uuid[] not null default '{}',      -- all venues this person may be rota'd at
  contract_type       text not null default 'partTime',  -- zeroHours|partTime|fullTime|salaried
  contracted_week     numeric(5,2) check (contracted_week is null or contracted_week > 0), -- overrides role divisor for salaried
  weekly_hours_target numeric(6,2) check (weekly_hours_target is null or weekly_hours_target >= 0),
  holiday_entitlement_days numeric(5,2) check (holiday_entitlement_days is null or holiday_entitlement_days >= 0), -- salaried fixed entitlement (null = accrual model)
  rate_override       numeric(10,2) check (rate_override is null or rate_override >= 0),
  dob                 date,
  ni_number           text,
  tax_ref             text,
  bank_sort_code      text,
  -- Must be stored MASKED only (never a full account number). Enforced:
  bank_account_masked text check (bank_account_masked is null or bank_account_masked ~ '^[*xX•]{2,}[0-9]{2,4}$'),
  address             text,
  emergency_contact   jsonb,
  mobile              text,                              -- E.164 for SMS
  email               text,
  right_to_work       jsonb not null default '{"status":"missing"}'::jsonb,
  start_date          date,
  status              text not null default 'active',    -- onboarding|active|onHold|leaver
  leaver_date         date,
  pos_user_id         uuid,                              -- staff_members.id when "set as POS user"
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- composite unique so child FKs can enforce same-org linking (no cross-tenant FK):
  unique (id, org_id)
);

-- ── Shifts (scheduled) ──────────────────────────────────────────────────────
create table if not exists wf_shifts (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  org_id          uuid not null,
  staff_id        uuid not null,
  role_key        text,
  section_id      uuid,
  section         text,                                  -- denormalized label for history
  shift_date      date not null,
  start_time      time not null,
  finish_time     time not null,
  break_mins      int not null default 0 check (break_mins >= 0),
  status          text not null default 'draft',         -- draft|published
  note            text,
  premiums_applied jsonb not null default '[]'::jsonb,
  -- pay snapshot (so cost is independently re-derivable):
  effective_rate  numeric(10,2) check (effective_rate is null or effective_rate >= 0),
  rate_source     text,                                  -- override|ageBand|base|salaried
  currency        char(3) not null default 'GBP',
  computed_hours  numeric(6,2) check (computed_hours is null or computed_hours >= 0),
  computed_cost   numeric(10,2) check (computed_cost is null or computed_cost >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, org_id),                                   -- enables composite tenant-match FKs
  -- staff cannot be hard-deleted while shifts exist (history preserved); same-org only:
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict,
  -- section must belong to the same org; nulled (not org_id) if the section is removed:
  foreign key (section_id, org_id) references wf_sections (id, org_id) on delete set null (section_id)
);

-- ── Timesheets (clock vs scheduled) ─────────────────────────────────────────
create table if not exists wf_timesheets (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  org_id          uuid not null,
  shift_id        uuid,
  staff_id        uuid not null,
  clock_in        timestamptz,
  clock_out       timestamptz,
  break_taken     int not null default 0 check (break_taken >= 0),
  scheduled_hours numeric(6,2) check (scheduled_hours is null or scheduled_hours >= 0),
  actual_hours    numeric(6,2) check (actual_hours is null or actual_hours >= 0),
  variance        numeric(6,2),
  -- pay snapshot (reproducible: pay = rate × actual_hours):
  effective_rate  numeric(10,2) check (effective_rate is null or effective_rate >= 0),
  rate_source     text,                                  -- override|ageBand|base|salaried
  currency        char(3) not null default 'GBP',
  pay_amount      numeric(10,2) check (pay_amount is null or pay_amount >= 0),
  status          text not null default 'pending',       -- pending|approved|missing|disputed
  approved_by     uuid,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (id, org_id),                                   -- enables composite tenant-match FKs
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict,
  foreign key (shift_id, org_id) references wf_shifts (id, org_id) on delete set null (shift_id)
);

-- ── Holiday accrual ledger (APPEND-ONLY; 12.07% statutory default) ───────────
-- Balance is DERIVED by summing the ledger; corrections are new rows, never edits.
create table if not exists wf_holiday_accrual (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null,
  org_id             uuid not null,
  staff_id           uuid not null,
  kind               text not null default 'accrual'     -- accrual|taken|payout|adjustment
                       check (kind in ('accrual','taken','payout','adjustment')),
  period_start       date,
  accrued_hours      numeric(8,2) not null default 0,    -- +accrual / -taken / -payout (signed)
  accrued_pay        numeric(12,2),
  accrual_rate       numeric(6,5) check (accrual_rate is null or (accrual_rate >= 0 and accrual_rate <= 1)),
  currency           char(3) not null default 'GBP',
  source_timesheet_id uuid,
  note               text,
  created_at         timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict,
  foreign key (source_timesheet_id, org_id) references wf_timesheets (id, org_id) on delete set null (source_timesheet_id)
);

-- ── Time off / leave ────────────────────────────────────────────────────────
create table if not exists wf_time_off (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  staff_id    uuid not null,
  type        text not null,                            -- holiday|sick|unpaid|parental
  start_date  date not null,
  end_date    date not null,
  days        numeric(5,2) check (days is null or days >= 0),
  note        text,
  status      text not null default 'pending',          -- pending|approved|denied
  decided_by  uuid,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict
);

-- ── Availability ────────────────────────────────────────────────────────────
create table if not exists wf_availability (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  staff_id    uuid not null,
  week_start  date,
  recurring   boolean not null default false,
  per_day     jsonb not null default '[]'::jsonb,       -- [{day,state,from,to}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict
);

-- ── Tronc runs (header) ─────────────────────────────────────────────────────
create table if not exists wf_tronc_runs (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  week_start  date not null,
  currency    char(3) not null default 'GBP',
  pool        numeric(12,2) not null default 0 check (pool >= 0),
  units_total numeric(14,6),
  point_value numeric(14,6),                            -- pool ÷ units (high precision)
  total_paid  numeric(12,2) not null default 0 check (total_paid >= 0),  -- Σ rounded payouts
  residual    numeric(12,2) not null default 0,         -- pool − total_paid (must be ~0 after reconcile)
  status      text not null default 'draft',            -- draft|run|exported
  lines       jsonb not null default '[]'::jsonb,       -- snapshot (typed source of truth = wf_tronc_lines)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Tronc lines (typed, per-participant) ────────────────────────────────────
create table if not exists wf_tronc_lines (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references wf_tronc_runs(id) on delete cascade,
  location_id uuid not null,
  org_id      uuid not null,
  staff_id    uuid not null,
  hours       numeric(8,2) not null default 0 check (hours >= 0),
  points      numeric(8,2) not null default 0 check (points >= 0),
  units       numeric(14,6) not null default 0 check (units >= 0),
  share_pct   numeric(9,6) not null default 0 check (share_pct >= 0),
  payout      numeric(12,2) not null default 0 check (payout >= 0),
  currency    char(3) not null default 'GBP',
  created_at  timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict
);

-- ── Documents (compliance vault — PII; file_url MUST be a signed/private URL) ─
create table if not exists wf_documents (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  staff_id    uuid not null,
  type        text not null,                            -- RTW|foodHygieneL2|...|SIA|other
  file_url    text,
  status      text not null default 'missing',          -- valid|expiring|expired|missing
  issued_on   date,
  expiry      date,
  verified_by uuid,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict
);

-- ── Sales forecast (drives live labour % on the rota) ───────────────────────
create table if not exists wf_sales_forecast (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid not null,
  forecast_date date not null,
  currency      char(3) not null default 'GBP',
  amount        numeric(12,2) not null default 0 check (amount >= 0),     -- forecast
  actual_amount numeric(12,2) check (actual_amount is null or actual_amount >= 0), -- mirrored POS/manual actuals
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (location_id, forecast_date)
);

-- ── App roles / access scope (owner|venueManager|shiftManager|staff) ─────────
create table if not exists wf_user_roles (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  user_id     uuid not null,                            -- auth.uid()
  staff_id    uuid,                                     -- optional link to HR record
  role        text not null default 'staff'
                check (role in ('owner','venueManager','shiftManager','staff')),
  venue_scope uuid[] not null default '{}',             -- venues this assignment covers
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, location_id),
  -- null only the staff link on staff delete (keep org_id, which is NOT NULL); PG15+ column-list syntax:
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete set null (staff_id)
);

-- ── Audit log (APPEND-ONLY, tamper-evident; money/compliance actions) ────────
create table if not exists wf_audit (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null,
  org_id      uuid not null,
  actor_id    uuid,
  actor_name  text,
  action      text not null,                            -- rota.publish|timesheet.approve|tronc.run|...
  entity      text,
  entity_id   text,
  amount      numeric(12,2),                            -- typed money for financial actions
  currency    char(3),
  reason      text,
  before      jsonb,
  after       jsonb,
  prev_hash   text,                                     -- hash of the previous audit row (chain)
  row_hash    text,                                     -- hash of this row's canonical content
  at          timestamptz not null default now()
);

-- ── Shift swaps ─────────────────────────────────────────────────────────────
create table if not exists wf_swap_requests (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid not null,
  shift_id      uuid,
  from_staff_id uuid not null,
  to_staff_id   uuid,                                   -- null = open offer
  status        text not null default 'open',           -- open|claimed|approved|denied
  coverage_ok   boolean,
  eligibility_checks jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (from_staff_id, org_id) references wf_staff (id, org_id) on delete restrict,
  -- claim reverts to an open offer if the claimer is removed (null to_staff_id only; keep org_id):
  foreign key (to_staff_id,   org_id) references wf_staff (id, org_id) on delete set null (to_staff_id),
  -- swap survives shift deletion for audit (shift link nulled, not the row); same-org only:
  foreign key (shift_id, org_id) references wf_shifts (id, org_id) on delete set null (shift_id)
);

-- ── Onboarding cases (7-step pipeline) ──────────────────────────────────────
create table if not exists wf_onboarding (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  org_id           uuid not null,
  staff_id         uuid not null,
  role_key         text,
  steps            jsonb not null default '[]'::jsonb, -- [{key,status,completedAt}]
  status           text not null default 'inProgress', -- inProgress|complete
  first_shift_date date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (staff_id, org_id) references wf_staff (id, org_id) on delete restrict
);

-- ── Announcements ───────────────────────────────────────────────────────────
create table if not exists wf_announcements (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid not null,
  author_id     uuid,
  author_name   text,
  audience      jsonb not null default '{}'::jsonb,    -- {scope,venueId,roleId}
  channels      jsonb not null default '[]'::jsonb,    -- ["inApp","sms"]
  body          text not null,
  sent_at       timestamptz,
  read_receipts jsonb not null default '[]'::jsonb,
  claims        jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- ── Indexes (hot paths) ─────────────────────────────────────────────────────
create index if not exists idx_wf_staff_org         on wf_staff(org_id);
create index if not exists idx_wf_staff_loc         on wf_staff(location_id);
create index if not exists idx_wf_staff_pos         on wf_staff(pos_user_id);
create index if not exists idx_wf_shifts_loc_date   on wf_shifts(location_id, shift_date);
create index if not exists idx_wf_shifts_org        on wf_shifts(org_id);
create index if not exists idx_wf_shifts_staff      on wf_shifts(staff_id);
create index if not exists idx_wf_timesheets_loc    on wf_timesheets(location_id);
create index if not exists idx_wf_timesheets_org    on wf_timesheets(org_id);
create index if not exists idx_wf_timesheets_staff  on wf_timesheets(staff_id);
create index if not exists idx_wf_accrual_staff     on wf_holiday_accrual(staff_id);
create index if not exists idx_wf_accrual_loc       on wf_holiday_accrual(location_id);
create index if not exists idx_wf_timeoff_staff     on wf_time_off(staff_id);
create index if not exists idx_wf_avail_staff       on wf_availability(staff_id);
create index if not exists idx_wf_tronc_loc_week    on wf_tronc_runs(location_id, week_start);
create index if not exists idx_wf_tronc_lines_run   on wf_tronc_lines(run_id);
create index if not exists idx_wf_tronc_lines_staff on wf_tronc_lines(staff_id);
create index if not exists idx_wf_documents_staff   on wf_documents(staff_id);
create index if not exists idx_wf_forecast_loc_date on wf_sales_forecast(location_id, forecast_date);
create index if not exists idx_wf_user_roles_user   on wf_user_roles(user_id);
create index if not exists idx_wf_user_roles_loc    on wf_user_roles(location_id);
create index if not exists idx_wf_roles_loc         on wf_roles(location_id);
create index if not exists idx_wf_sections_loc      on wf_sections(location_id);
create index if not exists idx_wf_swap_shift        on wf_swap_requests(shift_id);
create index if not exists idx_wf_onboarding_staff  on wf_onboarding(staff_id);
create index if not exists idx_wf_audit_loc_at      on wf_audit(location_id, at);
create index if not exists idx_wf_announce_loc      on wf_announcements(location_id);

-- ── updated_at trigger (mutable tables only; append-only tables excluded) ────
create or replace function wf_touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'wf_roles','wf_sections','wf_venue_settings','wf_staff','wf_shifts',
    'wf_timesheets','wf_time_off','wf_availability','wf_tronc_runs',
    'wf_documents','wf_sales_forecast','wf_user_roles','wf_swap_requests',
    'wf_onboarding'
  ] loop
    execute format('drop trigger if exists trg_%1$s_touch on %1$s', t);
    execute format('create trigger trg_%1$s_touch before update on %1$s for each row execute function wf_touch_updated_at()', t);
  end loop;
end $$;

-- ── Tenant integrity: every wf_* row's (location_id, org_id) must be a real, ──
-- ── consistent pair from locations (eliminates org/location mismatch). ───────
do $$
declare t text;
begin
  foreach t in array array[
    'wf_roles','wf_sections','wf_venue_settings','wf_staff','wf_shifts',
    'wf_timesheets','wf_holiday_accrual','wf_time_off','wf_availability',
    'wf_tronc_runs','wf_tronc_lines','wf_documents','wf_sales_forecast',
    'wf_user_roles','wf_audit','wf_swap_requests','wf_onboarding','wf_announcements'
  ] loop
    begin
      execute format('alter table %1$s add constraint %1$s_loc_org_fk foreign key (location_id, org_id) references locations (id, org_id)', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- ── Tronc runs are immutable once finalized (draft runs may be discarded) ────
create or replace function wf_block_finalized_tronc_delete() returns trigger as $$
begin
  if old.status is distinct from 'draft' then
    raise exception 'wf_tronc_runs: a % run is immutable and cannot be deleted (supersede via an audited correction instead)', old.status;
  end if;
  return old;
end; $$ language plpgsql;
drop trigger if exists trg_wf_tronc_no_delete on wf_tronc_runs;
create trigger trg_wf_tronc_no_delete before delete on wf_tronc_runs for each row execute function wf_block_finalized_tronc_delete();

-- ============================================================================
-- RLS — real tenant fence (NO "allow all"). Mirrors 20260429_tenant_rls.sql.
--   * Location-scoped tables: location_id::text IN user_accessible_locations()
--   * Org-scoped PII (wf_staff): org_id::text IN user_accessible_orgs()
--   * Append-only (wf_audit, wf_holiday_accrual): SELECT + INSERT only
--   * super_admin: additive full access on operational tables; SELECT-only on
--     append-only tables (audit/accrual stay immutable even for platform admin)
--   * Anonymous kiosk/online sessions get EMPTY from the helpers → no access.
-- service_role (edge functions) bypasses RLS entirely — that is the pay path.
-- ============================================================================

-- Location-scoped, full CRUD ------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'wf_roles','wf_sections','wf_venue_settings','wf_shifts','wf_timesheets',
    'wf_time_off','wf_availability','wf_tronc_runs','wf_tronc_lines',
    'wf_documents','wf_sales_forecast','wf_user_roles','wf_swap_requests',
    'wf_onboarding','wf_announcements'
  ] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('drop policy if exists "allow all" on %s', t);
    begin execute format($p$create policy %1$s_rls_select on %1$s for select using (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_insert on %1$s for insert with check (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_update on %1$s for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_delete on %1$s for delete using (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    -- additive super_admin full access
    begin execute format($p$create policy %1$s_super_admin_all on %1$s for all using (public.is_super_admin()) with check (public.is_super_admin())$p$, t); exception when duplicate_object then null; end;
  end loop;
end $$;

-- Org-scoped PII (wf_staff) --------------------------------------------------
do $$
begin
  execute 'alter table wf_staff enable row level security';
  execute 'alter table wf_staff force row level security';
  execute 'drop policy if exists "allow all" on wf_staff';
  begin execute 'create policy wf_staff_rls_select on wf_staff for select using (org_id::text in (select public.user_accessible_orgs()))'; exception when duplicate_object then null; end;
  begin execute 'create policy wf_staff_rls_insert on wf_staff for insert with check (org_id::text in (select public.user_accessible_orgs()))'; exception when duplicate_object then null; end;
  begin execute 'create policy wf_staff_rls_update on wf_staff for update using (org_id::text in (select public.user_accessible_orgs())) with check (org_id::text in (select public.user_accessible_orgs()))'; exception when duplicate_object then null; end;
  begin execute 'create policy wf_staff_rls_delete on wf_staff for delete using (org_id::text in (select public.user_accessible_orgs()))'; exception when duplicate_object then null; end;
  begin execute 'create policy wf_staff_super_admin_all on wf_staff for all using (public.is_super_admin()) with check (public.is_super_admin())'; exception when duplicate_object then null; end;
end $$;

-- Append-only tables (audit + accrual ledger): SELECT + INSERT only ----------
-- No UPDATE/DELETE policy → with RLS forced, those ops are denied for everyone
-- except service_role (which bypasses RLS). Belt-and-braces REVOKE below.
do $$
declare t text;
begin
  foreach t in array array['wf_audit','wf_holiday_accrual'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('drop policy if exists "allow all" on %s', t);
    begin execute format($p$create policy %1$s_rls_select on %1$s for select using (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    begin execute format($p$create policy %1$s_rls_insert on %1$s for insert with check (location_id::text in (select public.user_accessible_locations()))$p$, t); exception when duplicate_object then null; end;
    -- super_admin may read (NOT mutate) the immutable ledgers
    begin execute format($p$create policy %1$s_super_admin_select on %1$s for select using (public.is_super_admin())$p$, t); exception when duplicate_object then null; end;
    -- defense-in-depth: strip UPDATE/DELETE/TRUNCATE from client roles (TRUNCATE
    -- bypasses RLS and would wipe an immutable ledger); service_role keeps them.
    begin execute format('revoke update, delete, truncate on %s from authenticated, anon', t); exception when others then raise notice 'revoke on % skipped: %', t, sqlerrm; end;
  end loop;
end $$;

-- ── Documentation comments ──────────────────────────────────────────────────
comment on table  wf_holiday_accrual is 'Append-only holiday-accrual ledger (12.07% default). Balance = sum of signed accrued_hours; corrections are adjustment rows, never edits.';
comment on table  wf_audit           is 'Append-only, tamper-evident audit log. prev_hash/row_hash form a chain; UPDATE/DELETE denied to client roles.';
comment on column wf_tronc_runs.residual is 'pool − total_paid. Largest-remainder rounding in compute must drive this to 0.00.';
comment on column wf_staff.bank_account_masked is 'Masked only (regex-enforced). Full account numbers must never be stored here.';
