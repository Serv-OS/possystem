-- 20260611f_platform_ryft_cost.sql  (PLATFORM DB)
--
-- The whole model in three numbers:
--   OUR COST   = one blended figure (what Ryft charges us)         [platform-wide]
--   WE ADD     = our markup                                        [per location]
--   CUSTOMER PAYS = cost + markup (the single rate the venue sees)
--
-- Cost is a single blended % + pence (NOT the per-card/interchange breakdown we
-- tried before). It feeds the customer-facing "you pay" number and our margin
-- view; the markup is still the actual Ryft platformFee we take.

alter table public.platform_settings
  add column if not exists ryft_cost_percent     numeric default 0.80,
  add column if not exists ryft_cost_fixed_pence integer default 8;

comment on column public.platform_settings.ryft_cost_percent is 'Blended % Ryft charges us (our cost) — feeds the customer-facing rate (cost + markup) and margin view. One number, editable.';
comment on column public.platform_settings.ryft_cost_fixed_pence is 'Fixed pence Ryft charges us per transaction (our cost).';
