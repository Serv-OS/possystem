-- ROLLBACK for 20261009b_OPS_tax_rates_public_read.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the public read policy on tax_rates. After this a customer page can read the venue's
-- rates only with a session again (the "Allow authenticated access" policy, untouched by
-- 20261009b). The app release that goes with 20261009b waits for the session before it reads, and
-- 20261009a books the VAT on the server, so nothing else needs rolling back.
--
-- Bare statements, no begin or commit. Safe to run twice.

do $guard$
begin
  if to_regclass('public.tax_rates') is null then
    raise exception 'This is not the Ops database (tax_rates is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

drop policy if exists tax_rates_read on public.tax_rates;

-- VISIBLE CHECK: tax_rates_read is gone; the policies that were there before remain.
select policyname, cmd, roles::text, qual
  from pg_policies
 where schemaname = 'public' and tablename = 'tax_rates'
 order by policyname;
