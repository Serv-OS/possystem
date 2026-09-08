-- ═══════════════════════════════════════════════════════════════════════════
-- Restaurant OS — Stripe Connect & Billing Schema (Platform DB)
-- v2 — written against ACTUAL Platform DB schema (not the stale doc).
--
-- Tables this migration assumes already exist:
--   companies (id uuid PK, name, slug, plan, created_at)
--   locations (id uuid PK, company_id uuid, name, ops_db_url, ops_location_id,
--              timezone, business_day_start, ...)
--   platform_users (id uuid PK = auth.users.id, email, full_name, ...)
--   user_company_roles (user_id, company_id, role)
--   user_access (user_id, company_id, location_id, role, email)
--
-- Architecture:
--   - Customer payments: DIRECT charges on connected account.
--     Merchant is merchant of record. Platform takes NO application_fee.
--   - SaaS fees: Option 2 — calculate per location at period close, fire a
--     Transfer from connected balance to platform balance before payout.
--   - GMV definition: total processed value (cash + card + giftcard + tips),
--     NOT netted of refunds.
--   - Tiers: highest reached during period bills for full month. New
--     accounts start 'free'. No first-month proration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Merchant Stripe accounts ─────────────────────────────────────────────
-- One row per location that has a connected Stripe account. Supports both
-- express_onboarding (account_links flow) and admin_manual (paste acct_).
create table if not exists merchant_stripe_accounts (
  id uuid default gen_random_uuid() primary key,
  location_id uuid not null unique references locations(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,

  stripe_account_id text not null unique,
  link_method text not null check (link_method in ('express_onboarding','admin_manual')),

  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  default_currency text,                            -- 'gbp' | 'usd'
  country text,                                      -- 'GB' | 'US'
  capabilities jsonb not null default '{}'::jsonb,
  requirements jsonb,
  debit_negative_balances boolean not null default false,

  linked_by_user_id uuid references platform_users(id),
  linked_at timestamptz not null default now(),
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_msa_company on merchant_stripe_accounts(company_id);
create index if not exists idx_msa_stripe  on merchant_stripe_accounts(stripe_account_id);

-- ── Billing state per location (rolling GMV, current plan) ────────────────
-- New table since subscriptions doesn't exist in this Platform DB.
create table if not exists billing_state (
  id uuid default gen_random_uuid() primary key,
  location_id uuid not null unique references locations(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,

  current_period_start date not null default date_trunc('month', now())::date,
  current_period_currency text not null default 'gbp' check (current_period_currency in ('gbp','usd')),
  gmv_this_month numeric(12,2) not null default 0,
  gmv_last_month numeric(12,2) not null default 0,
  current_plan text not null default 'free' check (current_plan in ('free','starter','growth','scale','enterprise')),
  current_monthly_fee numeric(8,2) not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_billing_state_company on billing_state(company_id);

-- ── Billing invoices (historical per-period invoices) ────────────────────
create table if not exists billing_invoices (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,

  period_start date not null,
  period_end date not null,
  billing_currency text not null check (billing_currency in ('gbp','usd')),

  gmv_total numeric(12,2) not null,
  tier text not null check (tier in ('free','starter','growth','scale','enterprise')),
  fee_amount numeric(8,2) not null,

  status text not null default 'draft'
    check (status in ('draft','approved','skim_pending','skim_complete','skim_failed','manual_paid','void')),

  override_tier text,
  override_reason text,
  override_by_user_id uuid references platform_users(id),

  -- Stripe Transfer record (Option 2 skim)
  stripe_transfer_id text,
  stripe_transfer_amount bigint,
  stripe_transfer_currency text,
  skim_attempted_at timestamptz,
  skim_completed_at timestamptz,
  skim_failure_code text,
  skim_failure_message text,
  skim_attempts integer not null default 0,

  fallback_method text check (fallback_method in ('manual','card_on_file','direct_invoice') or fallback_method is null),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, period_start)
);

create index if not exists idx_billing_invoices_status   on billing_invoices(status);
create index if not exists idx_billing_invoices_location on billing_invoices(location_id);
create index if not exists idx_billing_invoices_company  on billing_invoices(company_id);

-- ── Stripe webhook event log (idempotency + audit) ────────────────────────
create table if not exists stripe_webhook_events (
  id text primary key,                               -- evt_...
  type text not null,
  livemode boolean not null,
  account_id text,                                   -- connected acct id, if applicable
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text
);

create index if not exists idx_swe_type     on stripe_webhook_events(type);
create index if not exists idx_swe_received on stripe_webhook_events(received_at desc);
create index if not exists idx_swe_account  on stripe_webhook_events(account_id);

-- ── get_plan_and_fee_for_gmv: tier + fee for a given GMV ──────────────────
create or replace function get_plan_and_fee_for_gmv(gmv numeric, currency text default 'gbp')
returns table (tier text, fee numeric) as $$
begin
  if gmv <= 5000 then
    tier := 'free';
    fee  := 0;
  elsif gmv <= 8000 then
    tier := 'starter';
    fee  := case when currency = 'usd' then null::numeric else 99 end;
  elsif gmv <= 10000 then
    tier := 'growth';
    fee  := case when currency = 'usd' then null::numeric else 149 end;
  elsif gmv <= 20000 then
    tier := 'scale';
    fee  := case when currency = 'usd' then null::numeric else 199 end;
  else
    tier := 'enterprise';
    fee  := case when currency = 'usd' then null::numeric else 249 end;
  end if;
  return next;
end;
$$ language plpgsql immutable;

-- ── increment_gmv RPC: atomic GMV bump on billing_state ───────────────────
-- Called from app code (Ops DB side) after every closed_check finalize.
-- Auto-creates the billing_state row on first call. Auto-promotes plan if
-- a tier boundary is crossed (highest tier wins for the period).
create or replace function increment_gmv(
  p_location_id uuid,
  p_amount numeric                                   -- major units (£12.34, not pence)
) returns jsonb as $$
declare
  v_state billing_state%rowtype;
  v_new_gmv numeric;
  v_new_plan text;
  v_new_fee numeric;
  v_currency text;
  v_company_id uuid;
begin
  select * into v_state from billing_state where location_id = p_location_id for update;

  if not found then
    -- Resolve company + currency from locations
    select l.company_id, coalesce(lower(l.timezone), 'gbp') into v_company_id, v_currency
      from locations l where l.id = p_location_id;
    -- Note: locations doesn't have a `currency` column in this schema; default to gbp.
    -- TODO: if you add locations.currency, replace the line above.
    v_currency := 'gbp';

    insert into billing_state (location_id, company_id, current_period_currency)
    values (p_location_id, v_company_id, v_currency)
    returning * into v_state;
  end if;

  v_currency := v_state.current_period_currency;
  v_new_gmv  := v_state.gmv_this_month + coalesce(p_amount, 0);

  select tier, fee into v_new_plan, v_new_fee
    from get_plan_and_fee_for_gmv(v_new_gmv, v_currency);

  -- Highest-tier wins: only PROMOTE within a period
  if v_state.current_plan = 'enterprise'
     or (v_state.current_plan = 'scale'   and v_new_plan in ('free','starter','growth'))
     or (v_state.current_plan = 'growth'  and v_new_plan in ('free','starter'))
     or (v_state.current_plan = 'starter' and v_new_plan = 'free') then
    v_new_plan := v_state.current_plan;
    v_new_fee  := v_state.current_monthly_fee;
  end if;

  update billing_state
     set gmv_this_month = v_new_gmv,
         current_plan = v_new_plan,
         current_monthly_fee = coalesce(v_new_fee, 0),
         updated_at = now()
   where id = v_state.id;

  return jsonb_build_object(
    'billing_state_id', v_state.id,
    'gmv_this_month', v_new_gmv,
    'current_plan', v_new_plan,
    'current_monthly_fee', coalesce(v_new_fee, 0)
  );
end;
$$ language plpgsql security definer;

grant execute on function increment_gmv(uuid, numeric) to authenticated, anon, service_role;

-- ── close_billing_period RPC: snapshot → invoice, reset rolling ───────────
-- Monthly cron will call this for each location. Creates a billing_invoices
-- row and resets the billing_state for the new period.
create or replace function close_billing_period(p_location_id uuid)
returns jsonb as $$
declare
  v_state billing_state%rowtype;
  v_invoice_id uuid;
  v_period_end date;
begin
  select * into v_state from billing_state where location_id = p_location_id for update;
  if not found then return jsonb_build_object('error','no_billing_state'); end if;

  v_period_end := (v_state.current_period_start + interval '1 month')::date;

  insert into billing_invoices (
    company_id, location_id, period_start, period_end, billing_currency,
    gmv_total, tier, fee_amount, status
  ) values (
    v_state.company_id, p_location_id, v_state.current_period_start, v_period_end,
    v_state.current_period_currency,
    v_state.gmv_this_month, v_state.current_plan, v_state.current_monthly_fee,
    'draft'
  )
  on conflict (location_id, period_start) do nothing
  returning id into v_invoice_id;

  update billing_state
     set gmv_last_month = gmv_this_month,
         gmv_this_month = 0,
         current_plan = 'free',
         current_monthly_fee = 0,
         current_period_start = v_period_end,
         updated_at = now()
   where id = v_state.id;

  return jsonb_build_object('invoice_id', v_invoice_id, 'billing_state_id', v_state.id);
end;
$$ language plpgsql security definer;

grant execute on function close_billing_period(uuid) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Permissive read for authed users. Writes via service role only (Edge fns
-- do their own caller verification).
alter table merchant_stripe_accounts enable row level security;
alter table billing_state            enable row level security;
alter table billing_invoices         enable row level security;
alter table stripe_webhook_events    enable row level security;

-- Authed users can read merchant accounts for companies they belong to
create policy msa_read on merchant_stripe_accounts for select to authenticated
  using (
    company_id in (
      select company_id from user_company_roles where user_id = auth.uid()
      union
      select company_id from user_access where user_id = auth.uid()
    )
  );

create policy bs_read on billing_state for select to authenticated
  using (
    company_id in (
      select company_id from user_company_roles where user_id = auth.uid()
      union
      select company_id from user_access where user_id = auth.uid()
    )
  );

create policy inv_read on billing_invoices for select to authenticated
  using (
    company_id in (
      select company_id from user_company_roles where user_id = auth.uid()
      union
      select company_id from user_access where user_id = auth.uid()
    )
  );

-- Webhook events: service role only (no public read needed)
-- (no policy = no access by default for non-service-role; service_role bypasses RLS)

-- ── updated_at triggers ──────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_msa_updated on merchant_stripe_accounts;
create trigger trg_msa_updated before update on merchant_stripe_accounts
  for each row execute function set_updated_at();

drop trigger if exists trg_bs_updated on billing_state;
create trigger trg_bs_updated before update on billing_state
  for each row execute function set_updated_at();

drop trigger if exists trg_inv_updated on billing_invoices;
create trigger trg_inv_updated before update on billing_invoices
  for each row execute function set_updated_at();

-- pgcrypto for gen_random_uuid (Supabase: enabled by default)
create extension if not exists pgcrypto;
