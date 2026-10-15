-- 20261015_PLATFORM_adyen_rates_cutover.sql
-- PLATFORM project. Peter runs this in the Supabase SQL editor (DDL is his, never Claude's).
-- Safe to run twice: every statement is IF NOT EXISTS.
--
-- WHY. Adyen charges the venue from the split profile on its store; our ledger stamps
-- adyen_payments.commission_minor. The two were built apart and drifted, so the bank and Back
-- Office disagreed by a few pounds per settlement. From v5.11.63 ONE rule module builds the
-- profile Adyen is sent and stamps the ledger from the rules read back from Adyen. These columns
-- hold that: what Adyen holds (adyen_rules), from when (rates_live_at), what it took before
-- (legacy_charge), and on each payment which rule stamped it and under which refund rule.
--
-- ORDER. 1. this file  2. deploy adyen-webhook, adyen-terminal-admin, adyen-financial, payments-admin,
-- xero-sales, then the app  3. Write the rates to Adyen from the Card rates box (sets rates_live_at)
-- 4. supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql (the past, made to match the bank).
-- Nothing changes for anyone when this file alone has run: every new column is null, and the code
-- stamps the old way until a venue has rates_live_at.

alter table public.merchant_adyen_accounts
  add column if not exists rates_live_at timestamptz,
  add column if not exists adyen_rules jsonb,
  add column if not exists legacy_charge jsonb;

comment on column public.merchant_adyen_accounts.rates_live_at is
  'Payments authorised from this instant are stamped from adyen_rules. Set by adyen-terminal-admin set_split from the server clock the moment the store PATCH succeeds; never typed by hand; never moved by a later write.';
comment on column public.merchant_adyen_accounts.adyen_rules is
  'A list of { from, profile_id, refund_policy, rules } entries, appended on every successful write to Adyen and never replaced. rules are the split configuration rules as Adyen returned them (ruleIds included) with servos_tier beside each one. The entry with the latest from at or before a payment''s authorised_at governs it.';
comment on column public.merchant_adyen_accounts.legacy_charge is
  'What Adyen took before the cutover, from the profile the store carried: { "percent_bp": 85, "fixed_minor": 0, "refund": "none" }. Set by set_split from the previous profile''s catch all rule when null; Peter may overwrite it. The restatement and the webhook backfill both apply it to payments authorised before rates_live_at.';

alter table public.adyen_payments
  add column if not exists fee_rule text,
  add column if not exists fee_refund_policy text;

comment on column public.adyen_payments.fee_rule is
  'Which rule stamped commission_minor: legacy_flat (the flat charge Adyen took before the cutover), adyen_rules:<profile id> (the rules read back from Adyen), adyen_rules:<profile id>:unmatched (no rule matched, commission_minor null and visible). Null means nobody has stamped this row under the new scheme; the restatement sets it and skips any row that has one.';
comment on column public.adyen_payments.fee_refund_policy is
  'The refund rule the fee was booked under: none (the venue keeps paying the full fee on a refund, what the bank has shown since go live) or ratio (the fee comes back in proportion). A null reads as none.';

-- The restatement and the webhook backfill look rows up by venue and instant.
create index if not exists adyen_payments_location_authorised_idx
  on public.adyen_payments (location_id, authorised_at);
