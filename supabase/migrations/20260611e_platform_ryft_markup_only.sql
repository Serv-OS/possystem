-- 20260611e_platform_ryft_markup_only.sql  (PLATFORM DB)
--
-- Radical simplification (supersedes 20260611d). Ryft charges all card-network /
-- processing fees automatically and reports the actuals via its API
-- (/balance-transactions = fees paid, /platform-fees = what we collected). So we
-- stop maintaining ANY cost / interchange / sell-rate card and keep ONE thing:
-- our MARKUP (what we add on top), which is the Ryft platformFee. The merchant
-- pays Ryft's real cost + our markup; live margin is read back from Ryft.

alter table public.platform_settings
  drop column if exists ryft_tier_label,
  drop column if exists ryft_cost_vmc_percent,
  drop column if exists ryft_cost_amex_percent,
  drop column if exists ryft_cost_fixed_pence,
  drop column if exists ryft_sell_instore_vmc_percent,
  drop column if exists ryft_sell_instore_amex_percent,
  drop column if exists ryft_sell_online_vmc_percent,
  drop column if exists ryft_sell_online_amex_percent,
  drop column if exists ryft_sell_fixed_pence,
  drop column if exists ryft_ic_debit_percent,
  drop column if exists ryft_ic_credit_percent,
  drop column if exists ryft_ic_amex_percent,
  add column if not exists default_ryft_markup_percent     numeric default 1.50,
  add column if not exists default_ryft_markup_fixed_pence integer default 0;

alter table public.merchant_ryft_accounts
  drop column if exists sell_instore_vmc_percent,
  drop column if exists sell_instore_amex_percent,
  drop column if exists sell_online_vmc_percent,
  drop column if exists sell_online_amex_percent,
  drop column if exists sell_fixed_pence,
  add column if not exists markup_percent     numeric,
  add column if not exists markup_fixed_pence integer;

comment on column public.platform_settings.default_ryft_markup_percent is 'Our standard markup % added on top of Ryft cost (the platformFee). Per-location override on merchant_ryft_accounts.markup_percent.';
comment on column public.merchant_ryft_accounts.markup_percent is 'What we add on top of Ryft cost for this merchant (the platformFee %). Null = platform default.';
