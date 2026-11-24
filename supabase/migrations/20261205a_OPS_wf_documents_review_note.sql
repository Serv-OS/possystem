-- 20261205a_OPS_wf_documents_review_note.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Workforce, Compliance (HR feedback, 23 Nov 2026): "resend the Right to Work check" and "say why
-- a document was rejected". Three new columns on wf_documents, all empty to start with:
--
--   review_note    why a manager rejected the upload (shown to the team member in the staff app
--                  and in the email that asks for a new one)
--   requested_at   when a manager last pressed Resend (the staff app asks for the document again
--                  until a new file arrives)
--   requested_by   who pressed it
--
-- Additive only: no existing column, row, policy or grant changes. The table's own row level
-- security already covers the new columns (they are read and written with the row). Safe to run
-- twice. Release 5.12.89 works before this has run (a rejection is still emailed with its reason,
-- and rejected or expired documents are still asked for in the staff app); what waits for it is
-- the reason being KEPT on the row and Resend on a document that is still in date.

set client_min_messages = warning;

alter table public.wf_documents add column if not exists review_note text;
alter table public.wf_documents add column if not exists requested_at timestamptz;
alter table public.wf_documents add column if not exists requested_by uuid;

comment on column public.wf_documents.review_note is 'Why the upload was rejected, typed by the reviewing manager (5.12.89). Cleared when a new file arrives.';
comment on column public.wf_documents.requested_at is 'When a manager last asked for this document again (5.12.89). Cleared when a new file arrives.';
comment on column public.wf_documents.requested_by is 'The Back Office login that asked (auth.users id).';

-- Reload the API so the new columns can be written straight away.
notify pgrst, 'reload schema';

-- Check: three rows, one per new column.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'wf_documents'
  and column_name in ('review_note', 'requested_at', 'requested_by')
order by column_name;
