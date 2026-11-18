-- 20261202a_OPS_head_office_numbers_sources.sql
-- Head office slice 3: Daily numbers shows the system's own figure beside every box (the till,
-- Workforce, the stock ledger, the sales forecast, public reviews) and only takes an override.
-- The saved row now carries every figure, system or typed, so:
--   * source          gains 'system' (no box was typed) beside 'typed' and 'csv';
--   * sources jsonb   names where each figure came from, {"net_sales":"till","cogs":"typed",...},
--                     so the scorecard tags a typed figure and only a typed figure;
--   * projected_parts jsonb  the forecast across the venue's OWN service periods (Location settings),
--                     {"<period id>": {"name": "Lunch", "amount": 2400}}. The three older columns
--                     projected_lunch, projected_dinner, projected_late stay, filled from the parts
--                     named lunch, dinner and late, for the CSV import and older rows.
-- Additive and safe to run twice. Dev and live share this database: nothing here changes a row.
-- Rollback: 20261202a_OPS_head_office_numbers_sources_ROLLBACK.sql.

begin;

alter table public.hq_daily_numbers
  add column if not exists sources jsonb not null default '{}'::jsonb;
alter table public.hq_daily_numbers
  add column if not exists projected_parts jsonb not null default '{}'::jsonb;
alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_projected_parts_object;
alter table public.hq_daily_numbers
  add constraint hq_daily_numbers_projected_parts_object check (jsonb_typeof(projected_parts) = 'object');
comment on column public.hq_daily_numbers.projected_parts is
  'The day''s sales forecast across the venue''s own service periods: {"<period id>": {"name": text, "amount": numeric}}. Empty for rows that only carry the three older daypart columns.';

alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_source_check;
alter table public.hq_daily_numbers
  add constraint hq_daily_numbers_source_check check (source in ('typed', 'csv', 'system'));

alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_sources_object;
alter table public.hq_daily_numbers
  add constraint hq_daily_numbers_sources_object check (jsonb_typeof(sources) = 'object');

comment on column public.hq_daily_numbers.sources is
  'Where each figure came from: till, workforce, stock, estimate, forecast, reviews, typed, csv. Empty for rows saved before slice 3 (all typed or csv).';

commit;

-- Verify (expect sources | jsonb, projected_parts | jsonb, and the check with 'system'):
--   select column_name, data_type from information_schema.columns where table_name = 'hq_daily_numbers' and column_name = 'sources';
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'hq_daily_numbers_source_check';
