-- ROLLBACK for 20261126a_OPS_customer_app.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the delete function, the trigger and both tables. Every customer app refresh token and
-- every tenant theme row goes with them: app users sign in again with a code, and the app
-- answers 409 not_ready (sessions, delete) or 404 no_theme until the file runs again. No
-- customers, loyalty or ledger row is touched.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

drop function if exists public.customer_app_delete_account(uuid);
drop trigger if exists trg_tenant_app_config_bump on public.tenant_app_config;
drop function if exists public.tenant_app_config_bump();
drop table if exists public.tenant_app_config;
drop table if exists public.customer_app_sessions;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0 and 0.
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('customer_app_sessions', 'tenant_app_config')) as tables_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('customer_app_delete_account', 'tenant_app_config_bump')) as functions_left;
