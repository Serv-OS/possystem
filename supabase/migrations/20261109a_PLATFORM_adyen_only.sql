-- 20261109a_PLATFORM_adyen_only.sql (29 Oct 2026, Drop D). PLATFORM project.
--
-- ServOS works with Adyen only. Every live venue is on Adyen; no venue uses Ryft; the rows
-- still marked stripe are dead venues. This file removes the Stripe and Ryft CONFIGURATION
-- from the Platform database, after copying every row it drops into an archive table, so
-- nothing is lost:
--
--   * merchant_stripe_accounts and merchant_ryft_accounts (the processor account links and
--     per venue markup) are archived to archive_merchant_stripe_accounts /
--     archive_merchant_ryft_accounts (service role only) and dropped.
--   * get_effective_markup(uuid, text) is dropped: it read merchant_stripe_accounts and its
--     last caller (the Stripe gift checkout path) is gone from the code.
--   * platform_settings loses the Ryft rate card: default_ryft_markup_percent,
--     default_ryft_markup_fixed_pence, ryft_cost_percent, ryft_cost_fixed_pence (the four
--     live columns, 000_baseline_platform.sql). The earlier Ryft pricing columns
--     (20260611b, c, d: default_ryft_cardpresent_*, ryft_buy_*, ryft_sell_*, ryft_ic_*,
--     ryft_tier_label, ryft_cost_vmc_percent, ryft_cost_amex_percent) were already dropped by
--     20260611c, d and e; they are named here with IF EXISTS only so a database that drifted
--     ends in the same place.
--   * location_reader_settings loses stripe_configuration_id and stripe_configuration_synced_at.
--   * locations loses stripe_terminal_location_id.
--   * payment_devices loses stripe_reader_id, stripe_account_id, stripe_terminal_location_id
--     and ryft_terminal_id, with their unique constraint and index, and its processor fields
--     check becomes "an Adyen reader names its Adyen terminal".
--
-- KEPT, never touched here (read only history): ryft_payments, merchant_ryft_disputes,
-- gift_card_purchases stripe_session_id / stripe_account_id / ryft_payment_session_id,
-- billing_invoices.stripe_transfer_*, subscriptions.stripe_*, payment_devices.processor
-- (its value check still admits the old names so history rows stay valid).
-- Ops: closed_checks.stripe_payment_intent_id holds Adyen references (a later RENAME, never a
-- drop), closed_checks.processor and bar_tabs.pre_auth_processor stay.
--
-- Column level grants on payment_devices (20260805d, 20260907b) go with their columns; the
-- remaining granted columns keep their grants. Rollback: 20261109a_PLATFORM_adyen_only_ROLLBACK.sql.

begin;

-- ── 1. Archive, then drop, the processor account tables ───────────────────────
create table if not exists public.archive_merchant_stripe_accounts as
  select * from public.merchant_stripe_accounts;
create table if not exists public.archive_merchant_ryft_accounts as
  select * from public.merchant_ryft_accounts;
-- Service role only: RLS on with no policies, and no browser role grant.
alter table public.archive_merchant_stripe_accounts enable row level security;
alter table public.archive_merchant_ryft_accounts   enable row level security;
revoke all on table public.archive_merchant_stripe_accounts from anon, authenticated;
revoke all on table public.archive_merchant_ryft_accounts   from anon, authenticated;
comment on table public.archive_merchant_stripe_accounts is
  'Drop D (29 Oct 2026): copy of merchant_stripe_accounts taken before the table was dropped. Read only history.';
comment on table public.archive_merchant_ryft_accounts is
  'Drop D (29 Oct 2026): copy of merchant_ryft_accounts taken before the table was dropped. Read only history.';

-- get_effective_markup read merchant_stripe_accounts (%rowtype) and has no caller left.
drop function if exists public.get_effective_markup(uuid, text);

drop table if exists public.merchant_stripe_accounts;
drop table if exists public.merchant_ryft_accounts;

-- ── 2. platform_settings: the Ryft rate card ──────────────────────────────────
alter table public.platform_settings
  drop column if exists default_ryft_markup_percent,
  drop column if exists default_ryft_markup_fixed_pence,
  drop column if exists ryft_cost_percent,
  drop column if exists ryft_cost_fixed_pence;
-- Already dropped live by 20260611c, d and e; IF EXISTS makes these no ops unless the
-- database drifted from the migrations.
alter table public.platform_settings
  drop column if exists default_ryft_cardpresent_markup_percent,
  drop column if exists default_ryft_online_markup_percent,
  drop column if exists default_ryft_cardpresent_buy_rate_percent,
  drop column if exists default_ryft_online_buy_rate_percent,
  drop column if exists ryft_tier_label,
  drop column if exists ryft_buy_debit_percent,
  drop column if exists ryft_buy_credit_percent,
  drop column if exists ryft_buy_amex_percent,
  drop column if exists ryft_buy_fixed_pence,
  drop column if exists ryft_cost_vmc_percent,
  drop column if exists ryft_cost_amex_percent,
  drop column if exists ryft_sell_instore_vmc_percent,
  drop column if exists ryft_sell_instore_amex_percent,
  drop column if exists ryft_sell_online_vmc_percent,
  drop column if exists ryft_sell_online_amex_percent,
  drop column if exists ryft_sell_fixed_pence,
  drop column if exists ryft_ic_debit_percent,
  drop column if exists ryft_ic_credit_percent,
  drop column if exists ryft_ic_amex_percent;

-- ── 3. location_reader_settings: the Stripe Terminal configuration link ───────
alter table public.location_reader_settings
  drop column if exists stripe_configuration_id,
  drop column if exists stripe_configuration_synced_at;

-- ── 4. locations: the Stripe Terminal location ────────────────────────────────
alter table public.locations
  drop column if exists stripe_terminal_location_id;

-- ── 5. payment_devices: Stripe reader and Ryft terminal links ─────────────────
alter table public.payment_devices drop constraint if exists payment_devices_processor_fields_check;
alter table public.payment_devices drop constraint if exists payment_devices_stripe_reader_id_key;
drop index if exists public.uq_payment_devices_ryft_terminal_id;
alter table public.payment_devices
  drop column if exists stripe_reader_id,
  drop column if exists stripe_account_id,
  drop column if exists stripe_terminal_location_id,
  drop column if exists ryft_terminal_id;
-- An Adyen reader must name its Adyen terminal. Written so a dead venue's old stripe or ryft
-- row (processor still says so, its link columns are gone) does not fail the migration; the
-- VERIFY below lists those rows for a hand clean up.
alter table public.payment_devices
  add constraint payment_devices_processor_fields_check
  check (processor <> 'adyen' or adyen_terminal_id is not null);

commit;

-- VERIFY (read only):
--   select count(*) from public.archive_merchant_stripe_accounts;   -- = rows the table had
--   select count(*) from public.archive_merchant_ryft_accounts;     -- = rows the table had
--   select table_name from information_schema.tables
--    where table_schema = 'public' and table_name in ('merchant_stripe_accounts','merchant_ryft_accounts');
--                                                                    -- expect 0 rows
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'platform_settings' and column_name like '%ryft%';
--                                                                    -- expect 0 rows
--   select table_name, column_name from information_schema.columns
--    where table_schema = 'public'
--      and ((table_name = 'location_reader_settings' and column_name like 'stripe_%')
--        or (table_name = 'locations' and column_name = 'stripe_terminal_location_id')
--        or (table_name = 'payment_devices' and column_name in
--            ('stripe_reader_id','stripe_account_id','stripe_terminal_location_id','ryft_terminal_id')));
--                                                                    -- expect 0 rows
--   select proname from pg_proc where proname = 'get_effective_markup';   -- expect 0 rows
--   select id, location_id, processor, serial_number, status from public.payment_devices
--    where processor <> 'adyen';                                     -- dead venues' readers, clean by hand
--   select count(*) from public.gift_card_purchases where stripe_session_id is not null
--       or ryft_payment_session_id is not null;                     -- history kept, unchanged
