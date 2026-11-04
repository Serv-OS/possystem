-- ROLLBACK for 20261120c_OPS_stock_us_units.sql. Removes the five US volume units. OPS DB ONLY.
-- It refuses (and changes nothing) while any stock item has one as its base unit: delete or change
-- those items first. Packs, recipe lines and counts that name a US unit by code would no longer
-- convert, so check them too. ASCII only.

begin;

do $guard$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if exists (select 1 from public.inventory_items where base_unit in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us')) then
    raise exception 'Some stock items count in a US unit. Change them first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_co_items') is not null
     and exists (select 1 from public.stock_co_items where base_unit in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us')) then
    raise exception 'Some company stock items count in a US unit. Change them first. Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

delete from public.stock_units where code in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us');

notify pgrst, 'reload schema';

commit;

-- VISIBLE CHECK: zero rows.
select code from public.stock_units where code in ('floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us');
