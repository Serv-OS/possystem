-- The kept Adyen setup per environment. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- Incident 8 Sep 2026: the owner moved Provo to live and back to test. The
-- flip with reprovision cleared the test store id, the split, legal entity,
-- account holder, balance account, bank account and business line ids,
-- retired both test reader registry rows and nulled the POIIDs on the paired
-- ops terminal rows. Nothing kept a copy, so the test store id and both
-- reader links were put back by hand with SQL.
--
-- From now on adyen-terminal-admin's flipEnvironment (set_environment and
-- adyen_link) writes the OUTGOING environment's setup here, keyed by the
-- environment it belonged to, on the same upsert as the clear, and a flip
-- INTO an environment that has an entry puts it back: the row ids, the
-- payment_devices rows un-retired (status registered) and the POIIDs back on
-- the paired ops terminal_devices rows that hold none. Shape:
--   { "test": { "store_id", "split_profile_id", "legal_entity_id",
--               "account_holder_id", "balance_account_id",
--               "transfer_instrument_id", "business_line_id",
--               "receive_payments_ok", "payouts_ok", "verification_status",
--               "merchant_account", "region",
--               "readers": [{ "payment_device_id", "label",
--                             "adyen_terminal_id", "terminal_device_id",
--                             "serial_number" }],
--               "stashed_at" },
--     "live": { ... } }
-- The function reads the column on its own and tolerates it being absent
-- (the flip then runs as before, and the answer names this file), so the
-- order of deploy and migration does not matter.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

alter table public.merchant_adyen_accounts
  add column if not exists env_stash jsonb not null default '{}'::jsonb;

comment on column public.merchant_adyen_accounts.env_stash is
  'Adyen setup kept per environment when the venue is switched away from it (test and live keys): store and account ids, the two flags, the verification snapshot, the merchant account, the region and the readers (platform payment_devices id, ops terminal_devices id, POIID). Written and restored by adyen-terminal-admin flipEnvironment (8 Sep 2026). Never read by the payment paths.';
