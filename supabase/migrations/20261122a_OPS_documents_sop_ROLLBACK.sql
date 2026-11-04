-- ROLLBACK for 20261122a_OPS_documents_sop.sql. Removes the tills' SOP read rule, the index and the
-- three columns (the SOP text is lost; the files in the bucket are untouched). ASCII only.
begin;
set local lock_timeout = '3s';

drop policy if exists ops_documents_select_sop on public.ops_documents;
drop function if exists public.ops_sop_reader_location_ids();
drop index if exists public.ops_documents_sop_idx;
alter table public.ops_documents
  drop column if exists sop_text_at,
  drop column if exists sop_text,
  drop column if exists is_sop;

commit;
