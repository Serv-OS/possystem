-- OUR OWN Adyen ids, per environment and region. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- Fact confirmed on docs.adyen.com, 8 Sep 2026: the Balance Platform
-- Configuration API has NO filter by reference. Account holders can only be
-- listed under a balance platform id,
--   GET /balancePlatforms/{id}/accountHolders?limit=100&offset=N   (max 100 a page)
--   https://docs.adyen.com/api-explorer/balanceplatform/2/get/balancePlatforms/_id_/accountHolders
-- and GET /accountHolders/{id} answers the holder INCLUDING its balancePlatform
--   https://docs.adyen.com/api-explorer/balanceplatform/2/get/accountHolders/_id_
--
-- So the FIRST venue on an Adyen account has to have its account holder id
-- pasted once. That one read hands us the balance platform id, and from then
-- on every other venue is found by its reference on its own. This table is
-- where that learned id is kept, so the pasting happens once per environment
-- and region instead of once per venue.
--
-- These are IDS, not secrets: a balance platform id (BP...) and the merchant
-- account codes a credential can see. They are kept here rather than in a
-- secret so the admin never has to set one by hand, and the merchant account
-- list lets the go live flow draw its account picker with no live call.
--
-- Keys: environment is 'test' or 'live', region is 'UK' or 'US' (the same two
-- the venue rows use since 20260908_PLATFORM_adyen_region_uk.sql). One row per
-- Adyen account we integrate with.
--
-- Service role only, exactly as merchant_adyen_accounts and the other platform
-- Adyen tables are fenced in 20260801_PLATFORM_adyen_foundation.sql: row level
-- security ON and NO policies, so anon and authenticated can read nothing. The
-- edge function reads and writes it with the platform service role key.
--
-- adyen-terminal-admin tolerates this table being absent (an unknown relation
-- is skipped with a warning naming this file), so the order of deploy and
-- migration does not matter.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

create table if not exists public.adyen_platform_settings (
  environment         text not null,
  region              text not null,
  balance_platform_id text,
  merchant_accounts   jsonb not null default '[]'::jsonb,
  updated_at          timestamptz not null default now(),
  primary key (environment, region)
);

alter table public.adyen_platform_settings enable row level security; -- service-role only (no policies)

comment on table public.adyen_platform_settings is
  'ServOS own Adyen ids per environment (test | live) and region (UK | US), learned from Adyen and never typed: balance_platform_id is the BP... id that GET /balancePlatforms/{id}/accountHolders needs (the Balance Platform API has no filter by reference, so the first venue is linked by pasting its account holder id and every venue after it is found by its reference), merchant_accounts is the list of merchant accounts the credential can see, as [{ id, name, status }], so the go live flow can draw its account picker with no live call. Written by adyen-terminal-admin (adyen_lookup, adyen_link, golive_state, adyen_merchants), 8 Sep 2026. Ids, not secrets. Never read by the payment paths.';

comment on column public.adyen_platform_settings.balance_platform_id is
  'The balance platform id (BP...) for this environment and region, taken from accountHolder.balancePlatform the first time any account holder on this account is read. The only way into GET /balancePlatforms/{id}/accountHolders, which is the only account holder listing Adyen offers.';

comment on column public.adyen_platform_settings.merchant_accounts is
  'Merchant accounts this credential can see, as [{ "id", "name", "status" }], merged as they are seen. Decoration for the admin picker: the charging account for a venue is always merchant_adyen_accounts.merchant_account, never this list.';

-- The balance platform id ON THE VENUE ROW as well, so a venue carries the
-- account it belongs to without a join. Best effort: adyen-terminal-admin
-- writes it on its own statement and tolerates the column being absent.
alter table public.merchant_adyen_accounts
  add column if not exists balance_platform_id text;

comment on column public.merchant_adyen_accounts.balance_platform_id is
  'The Adyen balance platform (BP...) this venue account holder lives on, learned from GET /accountHolders/{id}.balancePlatform. Mirrors adyen_platform_settings.balance_platform_id for the venue environment and region. Never used to pick a key: the environment and region columns do that.';
