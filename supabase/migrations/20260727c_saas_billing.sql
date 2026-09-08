-- 20260727c_saas_billing.sql
--
-- ⚠ PLATFORM DB (yhzjgyrkyjabvhblqxzu) — gtv/billing live alongside companies + merchant accounts.
--
-- USAGE-TRIGGERED SaaS BILLING. Per LOCATION (Ryft sub-accounts are per location, so that is the
-- only scope with a balance to collect from):
--
--   Free    £0      GTV 0        – 8,000     2 devices
--   Growth  £149    GTV 8,001    – 15,000    5 devices
--   Scale   £299    GTV 15,001   +          10 devices
--
-- GTV = GROSS takings INCLUDING VAT, ALL tenders and channels (owner's decision, 27 Jul 2026).
-- Note this is deliberately NOT the same as Ryft card volume: a venue can cross the threshold on
-- cash and still hold a small Ryft balance. The collector must cope with a short balance.
--
-- ── WHY THIS MIGRATION EXISTS AT ALL ────────────────────────────────────────────────────────
-- A billing schema was written months ago as a loose root-level file (supabase-billing-schema-v2)
-- applied by hand, and its counter `billing_state.gmv_this_month` HAS NEVER BEEN INCREMENTED —
-- `incrementGmv()` in src/lib/billing.js has zero call sites, so every venue reads £0 and always
-- has. Any threshold check against it would silently never fire. This migration supersedes that
-- with a real, versioned schema, and the counter is wired in the same release.
--
-- ── THE INVARIANT THAT MATTERS ──────────────────────────────────────────────────────────────
-- A location can be charged AT MOST ONCE per billing period. That is enforced by a UNIQUE INDEX,
-- not by application logic, because a billing run that double-charges a venue is a commercial
-- incident and app-level guards die with the process that holds them.

begin;

-- ── Plans ───────────────────────────────────────────────────────────────────────────────────
create table if not exists billing_plans (
  code            text primary key,           -- 'free' | 'growth' | 'scale'
  name            text not null,
  gtv_from_minor  bigint not null,            -- inclusive lower bound, in pence
  gtv_to_minor    bigint,                     -- inclusive upper bound; NULL = unbounded
  price_minor     bigint not null,            -- monthly fee in pence, ex-VAT
  device_allowance int not null,
  sort_order      int not null default 0
);

insert into billing_plans (code, name, gtv_from_minor, gtv_to_minor, price_minor, device_allowance, sort_order)
values
  ('free',   'Free',        0,        800000,  0,     2,  1),
  ('growth', 'Growth',  800001,      1500000,  14900, 5,  2),
  ('scale',  'Scale',  1500001,         null,  29900, 10, 3)
on conflict (code) do update set
  name = excluded.name, gtv_from_minor = excluded.gtv_from_minor, gtv_to_minor = excluded.gtv_to_minor,
  price_minor = excluded.price_minor, device_allowance = excluded.device_allowance,
  sort_order = excluded.sort_order;

-- ── Per-location, per-month usage ───────────────────────────────────────────────────────────
-- One row per location per period. `period_start` is the FIRST DAY OF THE MONTH in the venue's
-- own timezone, resolved by the caller — never by the browser, or a late-night sale bills to the
-- wrong month for a venue in another timezone.
create table if not exists billing_usage (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null,
  company_id     uuid,
  period_start   date not null,
  gtv_minor      bigint not null default 0,   -- gross inc VAT, all tenders
  check_count    int not null default 0,
  last_check_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (location_id, period_start)
);
create index if not exists idx_billing_usage_period on billing_usage (period_start);

-- ── The charge ledger ───────────────────────────────────────────────────────────────────────
-- Append-only in spirit: a row is created once and only moves forward through status.
create table if not exists billing_charges (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  company_id      uuid,
  period_start    date not null,
  plan_code       text not null references billing_plans(code),
  gtv_minor       bigint not null,            -- the GTV this decision was made on — frozen
  amount_minor    bigint not null,            -- what we intend to take, ex-VAT
  vat_minor       bigint not null default 0,
  total_minor     bigint not null,
  currency        text not null default 'GBP',
  -- pending  : decided, not yet collected
  -- simulated: DRY RUN — proves the maths with no money moving
  -- collected: money actually taken
  -- failed   : attempted and refused (see last_error); retryable
  -- waived   : manually written off
  status          text not null default 'pending'
                  check (status in ('pending','simulated','collected','failed','waived')),
  collection_route text,                      -- 'ryft_balance_debit' | 'card_on_file' | ...
  processor_ref   text,                       -- Ryft transfer/debit id once collected
  attempts        int not null default 0,
  last_error      text,
  decided_at      timestamptz not null default now(),
  collected_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- THE anti-double-charge guarantee. A location gets at most ONE real charge row per period.
-- Simulated rows are excluded so a dry run can be repeated freely without blocking the real one.
create unique index if not exists uniq_billing_charge_real_per_period
  on billing_charges (location_id, period_start)
  where status <> 'simulated';

create index if not exists idx_billing_charges_status on billing_charges (status, period_start);

-- ── GTV accrual ─────────────────────────────────────────────────────────────────────────────
-- Called once per closed check. Idempotency is the CALLER's job via p_check_id: the same check
-- must never be counted twice, so we record which checks we have seen.
create table if not exists billing_usage_seen (
  location_id  uuid not null,
  check_id     text not null,
  period_start date not null,
  seen_at      timestamptz not null default now(),
  primary key (location_id, check_id)
);

create or replace function accrue_gtv(
  p_location_id  uuid,
  p_company_id   uuid,
  p_period_start date,
  p_check_id     text,
  p_gross_minor  bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_new bigint;
begin
  if p_location_id is null or p_check_id is null then
    return jsonb_build_object('ok', false, 'reason', 'location_id and check_id required');
  end if;
  if coalesce(p_gross_minor, 0) = 0 then
    return jsonb_build_object('ok', true, 'skipped', 'zero');
  end if;

  -- Claim the check FIRST. If it is already there this is a replay (offline queue flush, a retry,
  -- two devices racing the same close) and must not move the counter.
  begin
    insert into billing_usage_seen (location_id, check_id, period_start)
    values (p_location_id, p_check_id, p_period_start);
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end;

  insert into billing_usage (location_id, company_id, period_start, gtv_minor, check_count, last_check_at)
  values (p_location_id, p_company_id, p_period_start, p_gross_minor, 1, now())
  on conflict (location_id, period_start) do update
    set gtv_minor     = billing_usage.gtv_minor + excluded.gtv_minor,
        check_count   = billing_usage.check_count + 1,
        last_check_at = now(),
        company_id    = coalesce(billing_usage.company_id, excluded.company_id),
        updated_at    = now()
  returning gtv_minor into v_new;

  return jsonb_build_object('ok', true, 'gtv_minor', v_new);
end $$;

grant execute on function accrue_gtv(uuid, uuid, date, text, bigint) to anon, authenticated, service_role;

-- ── Plan resolution ─────────────────────────────────────────────────────────────────────────
create or replace function plan_for_gtv(p_gtv_minor bigint)
returns billing_plans
language sql stable as $$
  select * from billing_plans
  where p_gtv_minor >= gtv_from_minor
    and (gtv_to_minor is null or p_gtv_minor <= gtv_to_minor)
  order by sort_order
  limit 1;
$$;

grant execute on function plan_for_gtv(bigint) to anon, authenticated, service_role;

commit;

-- After applying, reload PostgREST so the new tables/RPCs are visible:
--   notify pgrst, 'reload schema';
