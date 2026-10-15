-- 20261009b_OPS_tax_rates_public_read.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Safe any time, service included. ONE read policy, nothing else.          #
-- ############################################################################
--
-- WHY (VAT audit, 8 Oct 2026). tax_rates can only be read by a signed in session ("Allow
-- authenticated access", the only live policy). A customer page (online, QR) reads the venue's
-- rates to show the VAT on the bill and to book it on the sale. A first time guest's page read
-- them before its anonymous sign in finished, got an EMPTY list (the policy hides rows, it does
-- not refuse), and Preston QR-4OGI7 (8 Oct, 4.85) was booked with no VAT.
--
-- The app release that goes with this waits for the session and retries (src/lib/customerRates.js),
-- and 20261009a makes the server book the VAT itself. This file closes the last gap: the rates
-- are readable by anyone, as 20260907b_ops_rls_1_fences_and_rpcs.sql:1415-1420 already wrote and
-- never ran. Rate names and percentages are printed on every receipt; there is nothing private in
-- the table (id, venue, name, code, rate, type, applies to, default, active).
--
-- WHAT IT DOES NOT DO. Writes are untouched: the existing policies stay exactly as they are (the
-- "Allow authenticated access" ALL policy and the second step fence). Only a SELECT policy is
-- added. RLS is already on for the table.
--
-- Rollback: 20261009b_OPS_tax_rates_public_read_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.tax_rates') is null or to_regclass('public.closed_checks') is null then
    raise exception 'This is not the Ops database (tax_rates or closed_checks is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

alter table public.tax_rates enable row level security;
drop policy if exists tax_rates_read on public.tax_rates;
create policy tax_rates_read on public.tax_rates
  for select using (true);

-- The table grants a policy needs to mean anything (already the case live; said so the file stands on its own).
grant select on public.tax_rates to anon, authenticated;

-- VISIBLE CHECK: one row per policy on tax_rates; tax_rates_read is SELECT for {public} with qual true,
-- and the two policies that were there before are still there.
select policyname, cmd, roles::text, qual
  from pg_policies
 where schemaname = 'public' and tablename = 'tax_rates'
 order by policyname;
