-- 20260826_PLATFORM_reseller_invoicing.sql            ⚠ PLATFORM DB (yhzjgyrkyjabvhblqxzu)
--
-- Invoicing FranPOS for our card residuals.
--
-- THE MONEY FLOW THIS EXISTS FOR: we process on FranPOS's Adyen account, so the
-- whole card markup settles to FranPOS, not to us. FranPOS keeps their buy rate
-- (IC + 0.10% + 5 minor units per transaction, per the reseller terms of
-- 26 Aug 2026) and owes us the remainder of every payment's commission. Nothing
-- arrives unless we invoice them, so this table is the ledger of what we billed,
-- when, and whether it was paid.
--
-- The per-payment gross commission is already stamped on adyen_payments
-- (commission_minor, at the venue's tier rate). The residual is therefore
-- computed, never guessed:  net = commission_minor - (amount * buy% + buy fixed).
--
-- Buy rate lives in platform_settings so a renegotiation is a settings change,
-- not a deploy. Follows the ryft_cost_* precedent on the same table.

begin;

-- guard: platform db only (billing_state exists only there)
do $guard$
begin
  if to_regclass('public.billing_state') is null then
    raise exception 'Run this against the PLATFORM DB (yhzjgyrkyjabvhblqxzu), not Ops.';
  end if;
end
$guard$;

alter table public.platform_settings
  add column if not exists adyen_reseller_buy_percent numeric,
  add column if not exists adyen_reseller_buy_fixed_minor integer;

comment on column public.platform_settings.adyen_reseller_buy_percent is
  'The percentage FranPOS keeps per transaction under the reseller terms (0.10 means 0.10%). Applied to the payment amount in its own currency.';
comment on column public.platform_settings.adyen_reseller_buy_fixed_minor is
  'The fixed amount FranPOS keeps per transaction, in the payment currency''s minor units (5 = 5 cents or 5 pence).';

-- Seed the agreed terms. COALESCE so re-running never clobbers a renegotiated rate.
update public.platform_settings
   set adyen_reseller_buy_percent = coalesce(adyen_reseller_buy_percent, 0.10),
       adyen_reseller_buy_fixed_minor = coalesce(adyen_reseller_buy_fixed_minor, 5);

create table if not exists public.reseller_invoices (
  id                      uuid primary key default gen_random_uuid(),
  counterparty            text not null default 'FranPOS',
  period                  text not null,            -- 'YYYY-MM'
  currency                text not null,            -- one invoice per currency per period
  status                  text not null default 'draft'
                            check (status in ('draft','sent','paid','void')),
  invoice_number          text not null,            -- e.g. FP-2026-08-GBP
  payment_count           integer not null default 0,
  volume_minor            bigint  not null default 0,
  gross_commission_minor  bigint  not null default 0,  -- what venues were charged (our stamped commission)
  buy_share_minor         bigint  not null default 0,  -- FranPOS's cut at the buy rate
  net_due_minor           bigint  not null default 0,  -- what FranPOS owes us
  unrated_count           integer not null default 0,  -- payments with no stamped commission: flagged, never invented
  unrated_volume_minor    bigint  not null default 0,
  buy_percent             numeric not null,            -- the rate this invoice was computed at (renegotiations must not rewrite history)
  buy_fixed_minor         integer not null,
  breakdown               jsonb,                       -- per-venue lines as computed at creation
  notes                   text,
  created_at              timestamptz not null default now(),
  created_by              uuid,
  sent_at                 timestamptz,
  paid_at                 timestamptz
);

-- One live invoice per counterparty+period+currency. Voided ones stay for audit.
create unique index if not exists reseller_invoices_live_key
  on public.reseller_invoices (counterparty, period, currency)
  where status <> 'void';

create index if not exists reseller_invoices_period_idx
  on public.reseller_invoices (period desc);

-- Service role only, like the rest of the payments ledger: the admin app talks
-- to it exclusively through the payments-admin function's super_admin fence.
alter table public.reseller_invoices enable row level security;
revoke all on public.reseller_invoices from anon, authenticated;

commit;

-- Rollback:
-- begin;
--   drop table if exists public.reseller_invoices;
--   alter table public.platform_settings
--     drop column if exists adyen_reseller_buy_percent,
--     drop column if exists adyen_reseller_buy_fixed_minor;
-- commit;
