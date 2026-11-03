-- ROLLBACK for 20261119a_OPS_wf_head_office.sql. Only after 5.12.56 is reverted (the app reads the
-- columns when they exist and reads without them when they do not). Drops every head office tick and
-- salary. ASCII only.
begin;
alter table public.wf_staff drop constraint if exists wf_staff_salary_annual_range;
alter table public.wf_staff drop column if exists salary_annual;
alter table public.wf_staff drop column if exists head_office;
commit;
