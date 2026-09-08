-- PER VENUE Adyen environment. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- Owner decision 7 Sep 2026: dev and live share ONE Supabase project pair, so
-- the Adyen environment is a setting on the venue's merchant_adyen_accounts
-- row, not a project wide secret. The edge functions read it per request and
-- pick the matching secret set (test: ADYEN_*, live: ADYEN_LIVE_*). The
-- default is 'test', so nothing changes for an existing venue until its row
-- is flipped. A venue flipped to 'live' without ADYEN_LIVE_API_KEY and
-- ADYEN_LIVE_PREFIX set fails closed; it never falls back to the test keys.
--
-- The `live` columns are stamped from the notification's top level live flag
-- ('true' | 'false') so test and live rows can be told apart in reports and
-- a test payment can never be matched to a live payout.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

alter table public.merchant_adyen_accounts
  add column if not exists environment text not null default 'test';

alter table public.merchant_adyen_accounts
  drop constraint if exists merchant_adyen_accounts_environment_check;

alter table public.merchant_adyen_accounts
  add constraint merchant_adyen_accounts_environment_check
  check (environment in ('test', 'live'));

create index if not exists idx_merchant_adyen_accounts_environment
  on public.merchant_adyen_accounts (environment);

comment on column public.merchant_adyen_accounts.environment is
  'Adyen environment for this venue: test (default) or live. Picks the secret set the edge functions use (ADYEN_* vs ADYEN_LIVE_*). Flip to live only once the live keys and ADYEN_LIVE_PREFIX are set; a live venue without them fails closed.';

alter table public.adyen_payments
  add column if not exists live boolean;

comment on column public.adyen_payments.live is
  'Stamped from the standard webhook notification top level live flag: true = Adyen live environment, false = test. Null on rows written before the per venue environment (7 Sep 2026).';

alter table public.adyen_payouts
  add column if not exists live boolean;

comment on column public.adyen_payouts.live is
  'True when the payout came from the Adyen live environment, false for test, null when the source (balance platform webhook or report) did not say.';

alter table public.merchant_adyen_disputes
  add column if not exists live boolean;

comment on column public.merchant_adyen_disputes.live is
  'Stamped from the dispute notification top level live flag: true = Adyen live environment, false = test. Null on rows written before 7 Sep 2026.';
