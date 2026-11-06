-- ROLLBACK for 20261125a_OPS_admin_wipe.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the three wipe functions. Company Admin's Delete then answers "needs a database update"
-- and deletes nothing. No data is touched.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

drop function if exists public.admin_wipe_organisation(uuid, text, boolean);
drop function if exists public.admin_wipe_locations(uuid[], boolean);
drop function if exists public.admin_wipe_tables(text[], text[], text[], jsonb, boolean);

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select count(*) as functions_left
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('admin_wipe_tables', 'admin_wipe_locations', 'admin_wipe_organisation');
