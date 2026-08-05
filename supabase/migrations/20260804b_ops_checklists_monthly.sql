-- v5.5.971 — checklist scheduling honesty: Monthly becomes real.
-- The frequency dropdown offered Monthly since day one but the engine only ever
-- consulted the weekday chips. day_of_month (1-28) is the anchor; the engine
-- now honours daily/weekly/monthly for what they say.
begin;
alter table ops_checklists add column if not exists day_of_month integer
  check (day_of_month is null or (day_of_month between 1 and 28));
commit;
