-- 20261122a_OPS_documents_sop.sql   (Ops DB tbetcegmszzotrwdtqhi)   5.12.62, 4 Nov 2026. ASCII only.
--
-- WHAT: SOPs (Peter: "be able to upload documents like we have, mark as SOPs, then anywhere there is
-- an AI chat it can read those SOPs so a staff can ask on the POS what is our SOP for this and it
-- tells them exactly"). Peter runs this; Claude cannot run DDL on production. Before it runs the
-- app degrades cleanly: the SOP box is refused in words and the assistant says no SOPs are set up.
--
--   1. ops_documents.is_sop       this document is a standard operating procedure
--   2. ops_documents.sop_text     the document's words as plain text (read out of a PDF or photo by
--                                 the model at upload, or the file itself when it is a text file);
--                                 this is what the assistant reads and quotes
--   3. ops_documents.sop_text_at  when the text was read
--   4. a read rule for the tills: a till's own device session may read SOP rows at its venue (and
--                                 only those: every other document reads as before, Back Office and
--                                 the venue's Operations tablets). Never a kiosk, kitchen screen or
--                                 time clock (the venue_messages reader rule, 20261005a). The FILE
--                                 in the bucket stays as before; the till reads the text column only.
--
-- WHO MAY DO WHAT: unchanged for adding and changing (a tablet or a Back Office login adds, a Back
-- Office login changes, so only a Back Office login can mark an existing document as an SOP).
--
-- VERIFY after running:
--   V1. select column_name from information_schema.columns
--        where table_name = 'ops_documents' and column_name in ('is_sop', 'sop_text', 'sop_text_at');
--       Expect 3 rows.
--   V2. select policyname, cmd from pg_policies where tablename = 'ops_documents';
--       Expect ops_documents_select, ops_documents_select_sop, ops_documents_insert, ops_documents_update
--       (plus the restrictive second step fence if the venue has one).
--   V3. select proname from pg_proc where proname = 'ops_sop_reader_location_ids';   Expect 1 row.

begin;
set local lock_timeout = '3s';

do $g$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the Platform database. Run 20261122a in Ops (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.ops_documents') is null then
    raise exception 'Run 20260928c first (public.ops_documents is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.ops_writable_location_uuids()') is null then
    raise exception 'Run 20260927a first (public.ops_writable_location_uuids() is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.venue_message_reader_location_ids()') is null then
    raise exception 'Run 20261005a first (public.venue_message_reader_location_ids() is missing). Nothing was changed.';
  end if;
end
$g$;

alter table public.ops_documents
  add column if not exists is_sop      boolean     not null default false,
  add column if not exists sop_text    text        check (sop_text is null or char_length(sop_text) <= 200000),
  add column if not exists sop_text_at timestamptz;

-- The assistant's read: the venue's live SOPs, newest first.
create index if not exists ops_documents_sop_idx
  on public.ops_documents (location_id, created_at desc) where is_sop and archived_at is null;

-- Who reads SOPs: a Back Office login's venues, the venue of a paired till (never a kiosk, kitchen
-- screen or time clock: venue_message_reader_location_ids, 20261005a) and the venue of a paired
-- Operations tablet (ops_writable_location_uuids). One helper call per statement (set form, 20260927a).
create or replace function public.ops_sop_reader_location_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select l from public.venue_message_reader_location_ids() as l
  union
  select l from public.ops_writable_location_uuids() as l;
$fn$;
comment on function public.ops_sop_reader_location_ids() is
  'Venues whose SOPs the caller may read (5.12.62): a Back Office login''s venues, the venue of a paired till, or of a paired Operations tablet. Never a kiosk, kitchen screen or time clock. Used only by the SOP read rule on ops_documents.';
revoke all on function public.ops_sop_reader_location_ids() from public, anon;
grant execute on function public.ops_sop_reader_location_ids() to authenticated, service_role;

-- Permissive, so it adds to ops_documents_select and takes nothing away.
drop policy if exists ops_documents_select_sop on public.ops_documents;
create policy ops_documents_select_sop on public.ops_documents
  as permissive for select to authenticated
  using (is_sop and archived_at is null and location_id in (select public.ops_sop_reader_location_ids()));

commit;
