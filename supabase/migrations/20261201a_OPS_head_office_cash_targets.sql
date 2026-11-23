-- 20261201a_OPS_head_office_cash_targets.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Head office hub, slice 2 (16 Nov 2026, Peter: "rather than inputting cash on hand this should
-- be cash drawer totals, build safe management and banking, where do we set targets, add failed
-- checks and missed opening checklists"). Four tables, all additive, safe to run twice. Needs
-- 20261130a (hq_is_company_owner, hq_touch_updated_at) first.
--
--   hq_targets         the red, amber, green bands per metric: one company row (location_id
--                      null) and optional site rows that override it. The owner writes them.
--   hq_safe_movements  the site's safe as a ledger, append only. Cash comes IN from closed till
--                      drawers (drawer_sessions.declared_cash) and till drops to the safe
--                      (cash_movements type cash_drop), goes OUT as floats to a drawer, petty
--                      cash, or a bank deposit. A till event is posted once: (location_id,
--                      ref_kind, ref_id) is unique, so nobody retypes a figure and nothing is
--                      counted twice. The balance is the sum of amount (signed).
--   hq_safe_counts     a physical count of the safe: counted against the ledger's expected at
--                      that moment, the variance stored. Many a day is fine (open and close).
--                      Accepting a variance writes an adjustment movement; the count itself
--                      never moves the balance.
--   hq_bank_deposits   a bag made up for the bank: prepared, then banked, then confirmed (on the
--                      statement). Preparing one writes a bank_out movement (ref_kind deposit).
--
-- Who may see what:
--   targets    read: the company. write: the company's owner logins (hq_is_company_owner).
--   the rest   read and insert: anyone who manages the site in Back Office (the same fence as
--              hq_daily_numbers). Movements and counts are append only (no update, no delete,
--              a mistake is reversed with an adjustment). Deposits update (status moves on).
--
-- Verify: select relname, relrowsecurity from pg_class where relname like 'hq\_%' and relkind='r';
--         (10 rows, all true).
-- Rollback: 20261201a_OPS_head_office_cash_targets_ROLLBACK.sql (drops the four tables and their rows).

begin;

-- ----------------------------------------------------------------------------
-- 1. Targets
-- ----------------------------------------------------------------------------
create table if not exists public.hq_targets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid references public.locations(id) on delete cascade,   -- null = company default
  metric          text not null
                  check (metric in ('prime_cost_pct', 'labour_pct', 'cogs_pct', 'net_sales_day', 'morale_score',
                                    'review_rating', 'checks_pct', 'cash_held', 'unbanked_days', 'safe_variance')),
  green_to        numeric(14,2) not null,
  amber_to        numeric(14,2) not null,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- One row per company (or site) and metric. nulls not distinct: two company rows for one
-- metric are refused, the same as stock_targets.
create unique index if not exists uq_hq_targets_one on public.hq_targets (org_id, location_id, metric) nulls not distinct;

drop trigger if exists trg_hq_targets_touch on public.hq_targets;
create trigger trg_hq_targets_touch before update on public.hq_targets
  for each row execute function public.hq_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2. The safe: ledger, counts, deposits
-- ----------------------------------------------------------------------------
create table if not exists public.hq_safe_movements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid not null references public.locations(id) on delete cascade,
  business_date   date not null,
  kind            text not null
                  check (kind in ('drawer_in', 'drop_in', 'other_in', 'float_out', 'petty_out', 'bank_out', 'adjustment')),
  -- Signed: money into the safe is positive, money out is negative. An adjustment goes either way.
  amount          numeric(14,2) not null,
  ref_kind        text check (ref_kind is null or ref_kind in ('drawer_session', 'drawer_float', 'cash_movement', 'deposit', 'count')),
  ref_id          text,
  drawer_id       text,
  note            text,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  constraint hq_safe_movements_sign check (
       (kind in ('drawer_in', 'drop_in', 'other_in') and amount > 0)
    or (kind in ('float_out', 'petty_out', 'bank_out') and amount < 0)
    or (kind = 'adjustment' and amount <> 0)),
  constraint hq_safe_movements_ref check ((ref_kind is null) = (ref_id is null))
);
-- A till event (a closed drawer, a drop, a deposit) is posted to the safe once.
create unique index if not exists uq_hq_safe_movements_ref
  on public.hq_safe_movements (location_id, ref_kind, ref_id) where ref_id is not null;
create index if not exists idx_hq_safe_movements_site_date on public.hq_safe_movements (location_id, business_date desc, created_at desc);

create table if not exists public.hq_safe_counts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid not null references public.locations(id) on delete cascade,
  business_date   date not null,
  counted_total   numeric(14,2) not null check (counted_total >= 0),
  expected_total  numeric(14,2) not null,
  variance        numeric(14,2) generated always as (counted_total - expected_total) stored,
  denominations   jsonb,            -- { "50": 2, "20": 10, ... } when they counted by note, else null
  note            text,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_hq_safe_counts_site_date on public.hq_safe_counts (location_id, business_date desc, created_at desc);

create table if not exists public.hq_bank_deposits (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  location_id       uuid not null references public.locations(id) on delete cascade,
  business_date     date not null,
  amount            numeric(14,2) not null check (amount > 0),
  bag_reference     text,
  bank_label        text,
  status            text not null default 'prepared' check (status in ('prepared', 'banked', 'confirmed', 'cancelled')),
  prepared_at       timestamptz not null default now(),
  banked_at         timestamptz,
  confirmed_at      timestamptz,
  confirmed_by_name text,
  note              text,
  created_by        uuid default auth.uid(),
  created_by_name   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_hq_bank_deposits_site_status on public.hq_bank_deposits (location_id, status, business_date desc);

drop trigger if exists trg_hq_bank_deposits_touch on public.hq_bank_deposits;
create trigger trg_hq_bank_deposits_touch before update on public.hq_bank_deposits
  for each row execute function public.hq_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Row level security
-- ----------------------------------------------------------------------------
alter table public.hq_targets        enable row level security;
alter table public.hq_safe_movements enable row level security;
alter table public.hq_safe_counts    enable row level security;
alter table public.hq_bank_deposits  enable row level security;

-- Targets: the company reads, the owner writes (a site row needs the site too).
drop policy if exists hq_targets_select on public.hq_targets;
create policy hq_targets_select on public.hq_targets for select to authenticated
  using (org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_targets_write on public.hq_targets;
create policy hq_targets_write on public.hq_targets for all to authenticated
  using (public.hq_is_company_owner(org_id))
  with check (public.hq_is_company_owner(org_id)
              and (location_id is null or (location_id)::text in (select public.user_accessible_locations())));

-- Safe movements: the site's managers read and append. No update or delete policy: append only.
drop policy if exists hq_safe_movements_select on public.hq_safe_movements;
create policy hq_safe_movements_select on public.hq_safe_movements for select to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()));
drop policy if exists hq_safe_movements_insert on public.hq_safe_movements;
create policy hq_safe_movements_insert on public.hq_safe_movements for insert to authenticated
  with check ((location_id)::text in (select public.user_accessible_locations())
              and org_id::text in (select public.user_accessible_orgs()));

-- Safe counts: the same, append only.
drop policy if exists hq_safe_counts_select on public.hq_safe_counts;
create policy hq_safe_counts_select on public.hq_safe_counts for select to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()));
drop policy if exists hq_safe_counts_insert on public.hq_safe_counts;
create policy hq_safe_counts_insert on public.hq_safe_counts for insert to authenticated
  with check ((location_id)::text in (select public.user_accessible_locations())
              and org_id::text in (select public.user_accessible_orgs()));

-- Deposits: read, insert, and update (the status moves prepared, banked, confirmed).
drop policy if exists hq_bank_deposits_select on public.hq_bank_deposits;
create policy hq_bank_deposits_select on public.hq_bank_deposits for select to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()));
drop policy if exists hq_bank_deposits_insert on public.hq_bank_deposits;
create policy hq_bank_deposits_insert on public.hq_bank_deposits for insert to authenticated
  with check ((location_id)::text in (select public.user_accessible_locations())
              and org_id::text in (select public.user_accessible_orgs()));
drop policy if exists hq_bank_deposits_update on public.hq_bank_deposits;
create policy hq_bank_deposits_update on public.hq_bank_deposits for update to authenticated
  using ((location_id)::text in (select public.user_accessible_locations()))
  with check ((location_id)::text in (select public.user_accessible_locations()));

-- Grants: Back Office logins and the service role. Never anon.
revoke all on public.hq_targets, public.hq_safe_movements, public.hq_safe_counts, public.hq_bank_deposits from anon;
grant select, insert, update, delete on public.hq_targets to authenticated;
grant select, insert on public.hq_safe_movements to authenticated;
grant select, insert on public.hq_safe_counts to authenticated;
grant select, insert, update on public.hq_bank_deposits to authenticated;
grant all on public.hq_targets, public.hq_safe_movements, public.hq_safe_counts, public.hq_bank_deposits to service_role;

-- The second step fence (20260919s): a Back Office login that has not passed its second step
-- sees and writes nothing here, like every other Ops table.
do $fence$
declare t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then return; end if;
  foreach t in array array['hq_targets', 'hq_safe_movements', 'hq_safe_counts', 'hq_bank_deposits'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
        'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$fence$;

commit;
