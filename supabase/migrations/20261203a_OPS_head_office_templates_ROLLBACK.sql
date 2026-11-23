-- Rollback of 20261203a_OPS_head_office_templates.sql: drops the templates table and the
-- template_id column. Projects made from a template stay, with no link to it.
begin;
alter table public.hq_projects drop column if exists template_id;
drop table if exists public.hq_project_templates cascade;
commit;
