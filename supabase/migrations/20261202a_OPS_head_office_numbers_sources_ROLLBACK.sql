-- Rollback of 20261202a_OPS_head_office_numbers_sources.sql.
-- Rows saved with source 'system' are set back to 'typed' first so the narrower check holds.
begin;
update public.hq_daily_numbers set source = 'typed' where source = 'system';
alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_source_check;
alter table public.hq_daily_numbers add constraint hq_daily_numbers_source_check check (source in ('typed', 'csv'));
alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_sources_object;
alter table public.hq_daily_numbers drop column if exists sources;
alter table public.hq_daily_numbers drop constraint if exists hq_daily_numbers_projected_parts_object;
alter table public.hq_daily_numbers drop column if exists projected_parts;
commit;
