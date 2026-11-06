-- ROLLBACK for 20261126b_PLATFORM_customer_app.sql (Platform, yhzjgyrkyjabvhblqxzu).
--
-- Drops the one function. Delete my account in the customer app then answers 409 not_ready and
-- changes nothing. No data is touched.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

drop function if exists public.customer_app_end_loyalty(uuid);

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select count(*) as functions_left
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'customer_app_end_loyalty';
