-- 20260805d_payment_devices_columns.sql
--
-- ⚠ PLATFORM DB ONLY — project ref yhzjgyrkyjabvhblqxzu
--   (a guard below aborts if you run it against the Ops DB)
--
-- Finishes the one hole 20260805c deliberately left open.
--
-- WHY IT WAS LEFT OPEN
-- payment_devices carries `pd_read_all` — SELECT, granted to anon, USING(true) — which leaks
-- serial_number, registration_code and stripe_account_id for every terminal on the platform to
-- anyone holding the public anon key (it ships in the browser bundle). But that same policy is
-- what lets a till FIND ITS CARD READER:
--     src/lib/networkReader.js:62                  POS/kiosk boot — the live card-payment path
--     src/components/StatusDrawerCardReaders.jsx:70  POS status drawer
--     src/backoffice/sections/CardReaders.jsx:85     Back Office reader management
-- Dropping the policy takes card payments offline, so 20260805c left it and wrote this fix as a
-- commented-out draft, with the instruction to re-verify the column list at the moment of applying
-- rather than trust the file. That verification has now been done — see below.
--
-- WHAT THIS DOES INSTEAD
-- RLS cannot restrict columns; GRANTs can. So the table-level SELECT is revoked and granted back
-- for every column EXCEPT the three that no longer need to be readable from a browser. Reader
-- discovery keeps working untouched; the secrets stop being readable.
--
-- VERIFIED LIVE 5 Aug 2026 against yhzjgyrkyjabvhblqxzu (24 columns) and against every browser
-- call site (all three use explicit column lists, none of them uses SELECT *):
--   stripe_account_id       — read by NO call site on THIS table. The hits elsewhere in src/ are
--                             on merchant_stripe_accounts, a different table.
--   registered_by_user_id   — read by nothing anywhere in src/.
--   registration_code       — was read by CardReaders.jsx only, for one "Pairing code" diagnostic
--                             row. Removed in v5.5.978 (this migration's companion commit). It is
--                             WRITTEN by the service-role stripe-register-network-reader edge
--                             function, never by the browser, so withholding SELECT does not
--                             affect pairing. Column-level SELECT and INSERT are separate
--                             privileges; the function uses service_role and bypasses both.
--
-- ⚠ IF YOU ADD A COLUMN to payment_devices later, it is NOT granted by this statement and any
--   browser query selecting it will fail. Add it to the grant list below, or the POS boot query
--   breaks. That is the trade-off of a column-level grant and it is why 20260805c would not apply
--   this blind.

begin;

do $$
begin
  if to_regclass('public.payment_devices') is null then
    raise exception
      'payment_devices does not exist — this migration is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu). Aborting.';
  end if;
end $$;

-- A column-level REVOKE cannot override a table-level GRANT, so the table-level privilege must go
-- first and the permitted columns be granted back explicitly.
revoke select on table public.payment_devices from anon;

grant select (
  id,
  location_id,
  stripe_reader_id,
  device_type,
  connection_kind,
  serial_number,
  label,
  bound_pos_device_id,
  status,
  battery_level,
  last_seen_at,
  created_at,
  notes,
  ip_address,
  firmware_version,
  last_status_check_at,
  stripe_terminal_location_id,
  customer_display_enabled,
  processor,
  ryft_terminal_id,
  adyen_terminal_id
) on public.payment_devices to anon;

-- Withheld from the browser: registration_code, stripe_account_id, registered_by_user_id.

commit;


-- ── Post-apply verification (run separately) ──────────────────────────────
-- Expect exactly the three withheld names, and nothing else:
--
--   select column_name
--     from information_schema.columns c
--    where c.table_schema = 'public' and c.table_name = 'payment_devices'
--      and not has_column_privilege('anon', 'public.payment_devices', c.column_name, 'SELECT')
--    order by column_name;
--
-- Expect 21 rows granted:
--
--   select count(*)
--     from information_schema.columns c
--    where c.table_schema = 'public' and c.table_name = 'payment_devices'
--      and has_column_privilege('anon', 'public.payment_devices', c.column_name, 'SELECT');
--
-- ── Smoke test ────────────────────────────────────────────────────────────
-- 1. POS boot on a till with a network reader → the reader is still found and card payments work.
-- 2. POS status drawer → readers still listed with status and last-seen.
-- 3. Back Office → Card readers → list loads; the diagnostics panel no longer shows a Pairing code.
-- 4. Register a NEW network reader by code → still works (service-role edge function, unaffected).
