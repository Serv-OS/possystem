-- 20260611d_platform_ryft_sell_rates.sql  (PLATFORM DB: yhzjgyrkyjabvhblqxzu)
--
-- Ryft pricing, final model (supersedes 20260611b/c — no live Ryft pricing data).
-- The merchant is on IC+: they pay INTERCHANGE (pass-through) + OUR RATE. Since
-- interchange passes straight through (merchant → us → Ryft) it nets to zero in
-- our margin, so everything below is EX-INTERCHANGE.
--
--   OUR RATE (sell, what we charge) — by channel × card class, set as a standard
--     rate card (platform) with optional per-location override (admin).
--   OUR COST = Ryft's IC+ scheme fee, ex-interchange (Visa/MC 0.40%, Amex 2.00%,
--     +8p). Margin-visibility for us.
--   OUR MARGIN = our rate − Ryft scheme fee.  The platform fee taken on each Ryft
--     payment = our rate.
--
-- Card class: Visa/Mastercard (debit + credit share the same Ryft scheme fee;
-- they differ only in interchange, which passes through) vs Amex.

-- ── platform_settings: cost card + standard sell rates + interchange (display) ──
alter table public.platform_settings
  drop column if exists ryft_buy_debit_percent,
  drop column if exists ryft_buy_credit_percent,
  drop column if exists ryft_buy_amex_percent,
  drop column if exists ryft_buy_fixed_pence,
  drop column if exists default_ryft_markup_percent,
  drop column if exists default_ryft_markup_fixed_pence,
  -- our cost (Ryft IC+ scheme, ex-interchange)
  add column if not exists ryft_cost_vmc_percent          numeric default 0.40,
  add column if not exists ryft_cost_amex_percent         numeric default 2.00,
  add column if not exists ryft_cost_fixed_pence          integer default 8,
  -- our standard sell rate (ex-interchange), by channel × card class
  add column if not exists ryft_sell_instore_vmc_percent  numeric default 2.00,
  add column if not exists ryft_sell_instore_amex_percent numeric default 2.75,
  add column if not exists ryft_sell_online_vmc_percent   numeric default 2.80,
  add column if not exists ryft_sell_online_amex_percent  numeric default 2.75,
  add column if not exists ryft_sell_fixed_pence          integer default 8,
  -- interchange (pass-through) — illustrative, shown to merchants as "+ interchange"
  add column if not exists ryft_ic_debit_percent          numeric default 0.20,
  add column if not exists ryft_ic_credit_percent         numeric default 0.30,
  add column if not exists ryft_ic_amex_percent           numeric default 0.30;

comment on column public.platform_settings.ryft_cost_vmc_percent  is 'Ryft IC+ scheme fee (ex-interchange) for Visa/Mastercard — our cost. Tier 1 = 0.40%.';
comment on column public.platform_settings.ryft_cost_amex_percent is 'Ryft IC+ scheme fee (ex-interchange) for Amex — our cost. Tier 1 = 2.00%.';
comment on column public.platform_settings.ryft_sell_instore_vmc_percent is 'Standard in-store rate we charge merchants for Visa/MC (ex-interchange).';
comment on column public.platform_settings.ryft_sell_online_vmc_percent  is 'Standard online rate we charge merchants for Visa/MC (ex-interchange).';

-- ── merchant_ryft_accounts: per-location sell-rate override (null = standard) ──
alter table public.merchant_ryft_accounts
  drop column if exists markup_percent,
  drop column if exists markup_fixed_pence,
  add column if not exists sell_instore_vmc_percent  numeric,
  add column if not exists sell_instore_amex_percent numeric,
  add column if not exists sell_online_vmc_percent   numeric,
  add column if not exists sell_online_amex_percent  numeric,
  add column if not exists sell_fixed_pence          integer;

comment on column public.merchant_ryft_accounts.sell_instore_vmc_percent is 'Per-location override of the in-store Visa/MC rate we charge this merchant (ex-interchange). Null = platform standard.';
