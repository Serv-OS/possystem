-- 20260927d_OPS_tax_rates_seed.sql  (Ops DB, Peter runs; Claude cannot apply DDL)
--
-- Peter, 27 Sep 2026: "for some reason every products tax rate has been removed but they where
-- there earlier I have re applied Tax to all products but thats wrong please chase".
--
-- Every NEW venue gets the UK standard tax rates the moment its locations row is inserted.
-- No creation path did this: Train Station and Barnsley only had rates because someone pressed
-- Seed UK rates, and Leeds, Preston, Headingly and Huddersfield traded for days with none. The app
-- now seeds at creation too (lib/venueTaxRates.js seedVenueTaxRates, both Company admin screens);
-- this is the database's own copy of that rule, so any other way of creating a venue (the
-- provision-location function, the SQL editor) gets them as well.
-- Same rows as the Seed UK rates button: Standard 20% (the default), Reduced 5%, Zero.
-- GBP venues only (US venues set tax up through tax profiles). Never on top of existing rates.
-- It can never stop a venue being created: any error (row level security for a person who cannot
-- reach the new venue yet, for one) is turned into a warning, and the app then seeds it itself.
--
-- The realtime half of the first draft of this file (tax_rates in supabase_realtime) is NOT here:
-- 20260927_OPS_menu_rows_server_time.sql already adds tax_rates to the publication, and a table
-- is published once.
--
-- The app works the same before and after this runs. Safe to run twice. Nothing here changes an
-- existing venue or an existing rate. To undo: 20260927d_OPS_tax_rates_seed_ROLLBACK.sql.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

create or replace function public._seed_uk_tax_rates_for_new_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(new.currency, 'GBP')) = 'GBP'
     and not exists (select 1 from public.tax_rates t where t.location_id = new.id) then
    begin
      insert into public.tax_rates (location_id, name, code, rate, type, applies_to, is_default, active)
      values
        (new.id, 'Standard Rate', 'VAT20', 0.2000, 'inclusive', array['all'], true,  true),
        (new.id, 'Reduced Rate',  'VAT5',  0.0500, 'inclusive', array['all'], false, true),
        (new.id, 'Zero Rate',     'ZERO',  0.0000, 'inclusive', array['all'], false, true);
    exception when others then
      raise warning 'tax rates were not seeded for new venue %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists locations_seed_uk_tax_rates on public.locations;
create trigger locations_seed_uk_tax_rates
  after insert on public.locations
  for each row execute function public._seed_uk_tax_rates_for_new_location();

commit;

-- Check (read only), after running (one row each):
--   select tgname, pg_get_triggerdef(oid) from pg_trigger where tgname = 'locations_seed_uk_tax_rates';
--   select proname from pg_proc where proname = '_seed_uk_tax_rates_for_new_location';
