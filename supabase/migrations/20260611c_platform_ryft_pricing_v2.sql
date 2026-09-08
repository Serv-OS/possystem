-- 20260611c_platform_ryft_pricing_v2.sql  (PLATFORM DB: yhzjgyrkyjabvhblqxzu)
--
-- Supersedes the per-channel Ryft pricing shape from 20260611b. Ryft is IC+:
--   BUY RATE (our cost) = a PLATFORM-WIDE rate card, all-in PER CARD TYPE
--     (debit / credit / amex) + a fixed pence, by GMV tier (Tier 1 ≤ £500k/mo).
--     Recorded for MARGIN VISIBILITY ONLY — not used in fee math.
--   MARKUP (our margin / the Ryft platformFee) = a single % + a per-transaction
--     fixed pence, set per merchant (platform default fallback). This DRIVES the
--     platformFee taken on each Ryft payment.
--
-- merchant_ryft_accounts had no Ryft pricing data yet (no live Ryft venues), so
-- replacing the 20260611b columns is non-destructive.

-- Per-merchant: buy rate no longer lives here (it's platform-wide). Markup is a
-- single % + a per-transaction fixed pence.
alter table public.merchant_ryft_accounts
  drop column if exists cardpresent_buy_rate_percent,
  drop column if exists online_buy_rate_percent,
  add column if not exists markup_percent     numeric,
  add column if not exists markup_fixed_pence integer;

comment on column public.merchant_ryft_accounts.markup_percent     is 'Our margin on top of the Ryft buy rate — the platform fee %. Single rate across card types.';
comment on column public.merchant_ryft_accounts.markup_fixed_pence is 'Per-transaction fixed-fee markup (pence), added to the platform fee.';

-- Platform-wide: the Ryft IC+ buy-rate card (Tier 1 prefilled) + default markup.
alter table public.platform_settings
  drop column if exists default_ryft_cardpresent_markup_percent,
  drop column if exists default_ryft_online_markup_percent,
  drop column if exists default_ryft_cardpresent_buy_rate_percent,
  drop column if exists default_ryft_online_buy_rate_percent,
  add column if not exists ryft_tier_label               text    default 'Tier 1 (up to £500k/mo GMV)',
  add column if not exists ryft_buy_debit_percent         numeric default 0.60,   -- interchange 0.20 + IC+ 0.40
  add column if not exists ryft_buy_credit_percent        numeric default 0.70,   -- interchange 0.30 + IC+ 0.40
  add column if not exists ryft_buy_amex_percent          numeric default 2.30,   -- interchange 0.30 + Amex 2.00
  add column if not exists ryft_buy_fixed_pence           integer default 8,      -- + 8p per transaction
  add column if not exists default_ryft_markup_percent    numeric default 0,
  add column if not exists default_ryft_markup_fixed_pence integer default 0;

comment on column public.platform_settings.ryft_buy_debit_percent  is 'All-in Ryft cost for debit (interchange 0.20% + IC+ 0.40%) — Tier 1.';
comment on column public.platform_settings.ryft_buy_credit_percent is 'All-in Ryft cost for credit (interchange 0.30% + IC+ 0.40%) — Tier 1.';
comment on column public.platform_settings.ryft_buy_amex_percent   is 'All-in Ryft cost for Amex (interchange 0.30% + 2.00%) — Tier 1.';
comment on column public.platform_settings.ryft_buy_fixed_pence    is 'Fixed pence per transaction on the Ryft buy rate (8p Tier 1).';
