-- 20261205a_OPS_wf_documents_review_note_ROLLBACK.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Undoes 20261205a: drops the three columns it added to wf_documents. Rejection reasons and
-- Resend stamps typed since then are lost with them (they live nowhere else). Release 5.12.89
-- keeps working without the columns, as it did before the file was run.

set client_min_messages = warning;

alter table public.wf_documents drop column if exists review_note;
alter table public.wf_documents drop column if exists requested_at;
alter table public.wf_documents drop column if exists requested_by;

notify pgrst, 'reload schema';

-- Check: no rows.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'wf_documents'
  and column_name in ('review_note', 'requested_at', 'requested_by');
