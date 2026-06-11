-- 20260611b_platform_ryft_pricing.sql  (PLATFORM DB: yhzjgyrkyjabvhblqxzu)
--
-- Ryft pricing on the admin portal (AdminBillingManager), mirroring the Stripe
-- model but adding a "buy rate" alongside the markup. The markup is the platform
-- fee charged on top (drives Ryft platformFee, same role as Stripe markup); the
-- buy rate is what WE pay Ryft and is recorded for MARGIN VISIBILITY ONLY — it
-- does not change any payment math.
--
-- Scope (per user): Ryft only for now — the Stripe side is left untouched.

-- Per-location Ryft buy rate (margin-only). Markup columns already exist on this
-- table from 20260611_platform_ryft_foundation.
alter table public.merchant_ryft_accounts
  add column if not exists cardpresent_buy_rate_percent numeric,
  add column if not exists online_buy_rate_percent      numeric;

-- Platform-wide Ryft defaults: the buy rate (our cost from Ryft, deal-wide) and
-- the default markup used when a location has no per-merchant override. Kept
-- separate from the Stripe defaults so the two processors price independently.
alter table public.platform_settings
  add column if not exists default_ryft_cardpresent_markup_percent numeric default 1.0,
  add column if not exists default_ryft_online_markup_percent      numeric default 0.5,
  add column if not exists default_ryft_cardpresent_buy_rate_percent numeric,
  add column if not exists default_ryft_online_buy_rate_percent      numeric;

comment on column public.merchant_ryft_accounts.cardpresent_buy_rate_percent is 'What we pay Ryft for card-present on this location (margin visibility only; not used in fee math).';
comment on column public.merchant_ryft_accounts.online_buy_rate_percent      is 'What we pay Ryft for online on this location (margin visibility only; not used in fee math).';
comment on column public.platform_settings.default_ryft_cardpresent_buy_rate_percent is 'Deal-wide Ryft card-present buy rate (our cost); per-location override on merchant_ryft_accounts.';
comment on column public.platform_settings.default_ryft_online_buy_rate_percent      is 'Deal-wide Ryft online buy rate (our cost); per-location override on merchant_ryft_accounts.';
