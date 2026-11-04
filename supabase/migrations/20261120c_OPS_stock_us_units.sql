-- 20261120c_OPS_stock_us_units.sql
-- OPS DB ONLY. 5.12.57, 3 Nov 2026. US basics batch 7: the US volume units.
--
-- stock_units held only the UK imperial volume units (fl oz 28.41 ml, pint 568 ml, gallon 4546 ml),
-- so a US gallon of milk was booked as 4546 ml. This adds the US ones beside them, under their own
-- codes, so every UK item, pack, count and recipe keeps exactly the unit it has:
--   floz_us  fl oz (US)     29.5735295625 ml
--   cup_us   cup (US)      236.5882365 ml
--   pt_us    pint (US)     473.176473 ml
--   qt_us    quart (US)    946.352946 ml
--   gal_us   gallon (US)  3785.411784 ml
-- The same table is in the app (supabase/functions/_shared/stockUnits.js US_UNITS). Until this is
-- run the screens keep offering the UK units at a US site and say US units need a database update.
--
-- Additive only and safe to run twice: insert ... on conflict do nothing (an existing row is never
-- changed). to_canonical is numeric(20,8), so fl oz is held as 29.57352956.
-- Rollback: 20261120c_OPS_stock_us_units_ROLLBACK.sql (refuses while anything uses the units).

begin;

do $guard$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.stock_units') is null then
    raise exception 'stock_units must exist first (20260621d stock foundation). Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

insert into public.stock_units (code, dimension, to_canonical, label) values
  ('floz_us', 'VOLUME', 29.5735295625, 'fl oz (US)'),
  ('cup_us',  'VOLUME', 236.5882365,   'cup (US)'),
  ('pt_us',   'VOLUME', 473.176473,    'pint (US)'),
  ('qt_us',   'VOLUME', 946.352946,    'quart (US)'),
  ('gal_us',  'VOLUME', 3785.411784,   'gallon (US)')
on conflict (code) do nothing;

-- Self check: all five are there, in millilitres, and the UK units did not move.
do $check$
begin
  if (select count(*) from public.stock_units where code in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us') and dimension = 'VOLUME') <> 5 then
    raise exception 'the US units did not install';
  end if;
  if (select to_canonical from public.stock_units where code = 'gal') <> 4546.09 then
    raise exception 'the UK gallon is not 4546.09 ml';
  end if;
end $check$;

notify pgrst, 'reload schema';

commit;

-- VISIBLE CHECK: five rows, US gallon 3785.41178400, quart 946.35294600, pint 473.17647300,
-- cup 236.58823650, fl oz 29.57352956.
select code, dimension, to_canonical, label
  from public.stock_units
 where code in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us')
 order by to_canonical desc;
