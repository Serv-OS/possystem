-- 20260928c_OPS_documents_forms_ROLLBACK.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- Undoes 20260928c_OPS_documents_forms.sql. Drafted 28 Sep 2026 with it. Peter runs it; Claude
-- cannot run DDL on production.
--
-- WHAT IT DOES
--   1. Removes the 3 storage rules on 'ops-files', so no one can reach its files any more.
--   2. Drops ops_form_submissions, ops_forms and ops_documents, and the submitted time trigger.
--   The 'ops-files' bucket itself is left in place: remove it from the dashboard (Storage) once
--   it is empty, if it is not wanted.
--
-- IT REFUSES while any document or form submission exists: those are the venue's records (the
-- Accident book above all). Export them first (Back Office, Operations, Forms, Export CSV).
-- To drop them anyway, change v_force to true below, knowing the rows are gone for good.
--
-- The app needs nothing: once the tables are gone, Documents and Forms say "not set up yet".
-- Bare statements, no begin or commit; safe to run twice.

set lock_timeout = '3s';

do $guard$
declare
  v_force boolean := false;   -- true drops the tables even when they hold records
  v_docs  bigint := 0;
  v_subs  bigint := 0;
begin
  if to_regclass('public.ops_documents') is not null then
    execute 'select count(*) from public.ops_documents' into v_docs;
  end if;
  if to_regclass('public.ops_form_submissions') is not null then
    execute 'select count(*) from public.ops_form_submissions' into v_subs;
  end if;
  if (v_docs > 0 or v_subs > 0) and not v_force then
    raise exception 'Rollback stopped, NOTHING changed: % document(s) and % form submission(s) exist. Export them, then set v_force to true to drop them.', v_docs, v_subs;
  end if;
end
$guard$;

drop policy if exists ops_files_documents_read on storage.objects;
drop policy if exists ops_files_forms_read on storage.objects;
drop policy if exists ops_files_insert on storage.objects;

drop table if exists public.ops_form_submissions;
drop table if exists public.ops_forms;
drop table if exists public.ops_documents;
drop function if exists public.ops_form_submissions_stamp();

reset lock_timeout;

notify pgrst, 'reload schema';
