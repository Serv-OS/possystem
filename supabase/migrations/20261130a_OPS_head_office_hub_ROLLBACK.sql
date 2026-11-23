-- Rollback twin of 20261130a_OPS_head_office_hub.sql. Drops the six head office tables and
-- the two helpers. THE ROWS GO WITH THEM: typed daily numbers, internal projects and every
-- check in. Export first if anyone has used the screens.
begin;
drop table if exists public.hq_checkins cascade;
drop table if exists public.hq_checkin_questions cascade;
drop table if exists public.hq_project_updates cascade;
drop table if exists public.hq_tasks cascade;
drop table if exists public.hq_projects cascade;
drop table if exists public.hq_daily_numbers cascade;
drop function if exists public.hq_is_company_owner(uuid);
drop function if exists public.hq_touch_updated_at();
commit;
