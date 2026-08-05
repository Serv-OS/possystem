-- v5.5.972 — 'probe' joins the temperature unit types.
-- Probe calibration is the textbook weekly HACCP check, and the customer asked
-- for exactly that — but you could not CREATE the unit to link a checklist task
-- to, because the type catalogue had no probe. Ice-water test is the default
-- (0°C ±1); a venue wanting the boiling test edits the range to 99–101 on the unit.
begin;
alter table temp_units drop constraint if exists temp_units_type_check;
alter table temp_units add constraint temp_units_type_check
  check (type = any (array['fridge','freezer','cold_hold','hot_hold','cooking','chill_down','delivery','probe']));
commit;
