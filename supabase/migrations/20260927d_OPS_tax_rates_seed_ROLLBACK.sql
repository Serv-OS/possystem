-- ROLLBACK for 20260927d_OPS_tax_rates_seed.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Removes the trigger that gives a new UK venue its standard tax rates, and its function. Rates
-- it already added stay (they are the venue's own rates now; delete them in Back Office, Tax &
-- VAT, if they must go). The app still seeds new venues itself (lib/venueTaxRates.js), so a venue
-- created after this rollback still gets its rates from the Company admin screens.
-- One transaction; safe to run twice.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

drop trigger if exists locations_seed_uk_tax_rates on public.locations;
drop function if exists public._seed_uk_tax_rates_for_new_location();

commit;

-- Check (read only), after running (no rows):
--   select tgname from pg_trigger where tgname = 'locations_seed_uk_tax_rates';
