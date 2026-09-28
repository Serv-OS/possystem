-- 20260928c_OPS_documents_forms.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- WHAT: Operations Documents and Forms (v5.11.4, 28 Sep 2026). Peter runs this; Claude cannot
-- run DDL on production. The app degrades cleanly before it runs: Documents and Forms say
-- "not set up yet" and nothing else changes.
--
--   1. public.ops_documents          a venue's documents (title, category, the stored file)
--   2. public.ops_forms              a venue's forms (the questions, as a jsonb list)
--   3. public.ops_form_submissions   completed forms (the Accident book), one row each
--   4. the private bucket 'ops-files' (20 MB per file, any file type) and its storage rules
--
-- WHO MAY DO WHAT (the Operations module's existing rule: a paired tablet may ADD a record at
-- its own venue, only a Back Office login changes what is there, like checklist templates):
--
--                        read                         add                      change      delete
--   ops_documents        Back Office + venue tablets  Back Office + tablets    Back Office  nobody (archive)
--   ops_forms            Back Office + venue tablets  Back Office              Back Office  nobody (archive)
--   ops_form_submissions Back Office ONLY             Back Office + tablets    nobody       nobody
--   ops-files documents  Back Office + venue tablets  Back Office + tablets    nobody       nobody
--   ops-files forms      Back Office ONLY (*)         Back Office + tablets    nobody       nobody
--
--   "Back Office" = user_accessible_locations(): logins linked to the venue, and the super admin.
--   "venue tablets" = ops_writable_location_uuids(): the above plus the venue's active, claimed
--   ops_devices (the Operations tablet and the Manager app).
--   Submissions hold personal data (name, contact details, injuries), so reading them is
--   manager only. A tablet adds a submission and can never read one back, not even its own.
--   (*) the uploader may read its own new form file for 15 minutes, so the upload works whether
--   or not the storage server reads the new object back. After that, Back Office only.
--
-- SET FORM (20260927a): every venue check is `col in (select public.<set function>())`, which
-- Postgres works out ONCE per statement. Never fn(location_id) per row.
--   uuid columns:  location_id in (select public.ops_writable_location_uuids())
--   Back Office:   (location_id)::text in (select public.user_accessible_locations())
--   storage paths: (storage.foldername(objects.name))[1] in (select ...)
-- Storage rules name objects.name in full. An unqualified `name` inside a subquery binds to
-- that subquery's own table (ops_devices has a name column); that is exactly how the live
-- ops-evidence device rule came to compare the TABLET'S name with its venue.
--
-- SAFETY: bare statements, no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again). Every
-- statement can run twice. 3 second lock wait. The guard stops before anything if 20260927a
-- (the set helpers) is missing. Adds the second_step_fence to the 3 new tables, the way
-- 20260919s does for every table. Touches no existing table, policy or bucket.
-- If the editor asks "Run and enable RLS", either answer is fine: this file enables row level
-- security on its own tables.
--
-- ROLLBACK: 20260928c_OPS_documents_forms_ROLLBACK.sql (refuses while any document or
-- submission exists, unless told otherwise).
--
-- VERIFY AFTER RUNNING (read only, paste each):
--   V1. The 3 tables with row level security on. Expect 3 rows, all true.
--     select relname, relrowsecurity from pg_class
--      where relnamespace = 'public'::regnamespace
--        and relname in ('ops_documents', 'ops_forms', 'ops_form_submissions');
--   V2. Their policies. Expect 11: 3 on ops_documents, 3 on ops_forms, 2 on ops_form_submissions,
--       plus second_step_fence on each (restrictive). No delete policy anywhere.
--     select tablename, policyname, cmd, permissive from pg_policies
--      where tablename in ('ops_documents', 'ops_forms', 'ops_form_submissions') order by 1, 2;
--   V3. The bucket. Expect ops-files, public false, 20971520, allowed_mime_types null.
--     select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'ops-files';
--   V4. The storage rules. Expect 3: ops_files_documents_read, ops_files_forms_read, ops_files_insert.
--     select policyname, cmd from pg_policies
--      where schemaname = 'storage' and tablename = 'objects' and policyname like 'ops_files_%';
--   V5. Nothing slow. Expect 0 rows.
--     select tablename, policyname from pg_policies
--      where tablename in ('ops_documents', 'ops_forms', 'ops_form_submissions')
--        and concat_ws(' ', qual, with_check) ~ '(pos_can_access|ops_can_write)\(';


-- ============================================================================
-- 0. Guard
-- ============================================================================
set lock_timeout = '3s';

do $guard$
begin
  if to_regprocedure('public.ops_writable_location_uuids()') is null
     or to_regprocedure('public.user_accessible_locations()') is null
     or to_regclass('public.ops_devices') is null then
    raise exception '20260928c stopped, NOTHING changed: run 20260927a first (public.ops_writable_location_uuids() is missing).';
  end if;
end
$guard$;


-- ============================================================================
-- 1. ops_documents
-- ============================================================================
create table if not exists public.ops_documents (
  id                    uuid primary key default gen_random_uuid(),   -- minted by the app: it names the file's folder
  location_id           uuid not null,                                -- always resolved by the app, never a default
  org_id                uuid,
  title                 text not null check (char_length(btrim(title)) between 1 and 200),
  category              text not null default 'other'
                          check (category in ('food_safety', 'health_safety', 'certificates', 'policies', 'other')),
  file_path             text not null check (char_length(file_path) between 1 and 600),
  file_name             text not null check (char_length(file_name) between 1 and 300),
  mime_type             text,
  size_bytes            bigint not null default 0 check (size_bytes >= 0 and size_bytes <= 20971520),
  uploaded_by_name      text,                                         -- snapshot of the tablet's staff sign in or the BO user
  uploaded_by_staff_id  uuid,                                         -- staff_members.id when a tablet uploaded it
  source                text not null default 'back_office' check (source in ('back_office', 'tablet')),
  created_at            timestamptz not null default now(),
  archived_at           timestamptz,                                  -- archive, never delete
  archived_by_name      text,
  -- a row can only point at a file in its own venue's documents folder
  constraint ops_documents_path_in_venue
    check (split_part(file_path, '/', 1) = location_id::text and split_part(file_path, '/', 2) = 'documents')
);
create index if not exists ops_documents_loc_idx on public.ops_documents (location_id, created_at desc);


-- ============================================================================
-- 2. ops_forms
-- ============================================================================
create table if not exists public.ops_forms (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  org_id           uuid,
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  description      text,
  fields           jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  template_key     text,                                              -- 'accident_book' when added from the ready made one
  version          integer not null default 1 check (version >= 1),  -- compare and set on every edit
  created_by_name  text,
  updated_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz,                                       -- archive, never delete
  constraint ops_forms_id_location_key unique (id, location_id)      -- target of the submissions' venue safe key
);
create index if not exists ops_forms_loc_idx on public.ops_forms (location_id) where archived_at is null;
-- one live copy of each ready made form per venue
create unique index if not exists ops_forms_template_once
  on public.ops_forms (location_id, template_key) where template_key is not null and archived_at is null;


-- ============================================================================
-- 3. ops_form_submissions (append only: no update, no delete)
-- ============================================================================
create table if not exists public.ops_form_submissions (
  id                     uuid primary key default gen_random_uuid(),  -- minted by the app: a retry never writes twice
  location_id            uuid not null,
  org_id                 uuid,
  form_id                uuid not null,
  form_name              text not null check (char_length(form_name) between 1 and 200),
  form_version           integer not null default 1,
  fields                 jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),   -- the questions as asked
  answers                jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'), -- question id to answer; photos and signatures are ops-files paths
  submitted_by_name      text,
  submitted_by_staff_id  uuid,
  source                 text not null default 'tablet' check (source in ('tablet', 'back_office')),
  submitted_at           timestamptz not null default now(),            -- stamped by the trigger below, never the device clock
  -- the form must be the SAME venue's form (checked by the key, whatever the caller can read)
  constraint ops_form_submissions_form_fk
    foreign key (form_id, location_id) references public.ops_forms (id, location_id) on delete restrict
);
create index if not exists ops_form_submissions_form_idx
  on public.ops_form_submissions (location_id, form_id, submitted_at desc);

create or replace function public.ops_form_submissions_stamp()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.submitted_at := now();
  return new;
end
$fn$;
drop trigger if exists ops_form_submissions_stamp on public.ops_form_submissions;
create trigger ops_form_submissions_stamp
  before insert on public.ops_form_submissions
  for each row execute function public.ops_form_submissions_stamp();


-- ============================================================================
-- 4. Row level security (set form)
-- ============================================================================
alter table public.ops_documents enable row level security;
alter table public.ops_forms enable row level security;
alter table public.ops_form_submissions enable row level security;

-- ops_documents: read and add = Back Office + the venue's tablets; change = Back Office.
drop policy if exists ops_documents_select on public.ops_documents;
create policy ops_documents_select on public.ops_documents
  as permissive for select to public
  using ((location_id in (select public.ops_writable_location_uuids())));
drop policy if exists ops_documents_insert on public.ops_documents;
create policy ops_documents_insert on public.ops_documents
  as permissive for insert to public
  with check ((location_id in (select public.ops_writable_location_uuids())));
drop policy if exists ops_documents_update on public.ops_documents;
create policy ops_documents_update on public.ops_documents
  as permissive for update to public
  using (((location_id)::text in (select public.user_accessible_locations())))
  with check (((location_id)::text in (select public.user_accessible_locations())));

-- ops_forms: read = Back Office + the venue's tablets; add and change = Back Office.
drop policy if exists ops_forms_select on public.ops_forms;
create policy ops_forms_select on public.ops_forms
  as permissive for select to public
  using ((location_id in (select public.ops_writable_location_uuids())));
drop policy if exists ops_forms_insert on public.ops_forms;
create policy ops_forms_insert on public.ops_forms
  as permissive for insert to public
  with check (((location_id)::text in (select public.user_accessible_locations())));
drop policy if exists ops_forms_update on public.ops_forms;
create policy ops_forms_update on public.ops_forms
  as permissive for update to public
  using (((location_id)::text in (select public.user_accessible_locations())))
  with check (((location_id)::text in (select public.user_accessible_locations())));

-- ops_form_submissions: read = Back Office ONLY (personal data); add = Back Office + tablets.
drop policy if exists ops_form_submissions_select on public.ops_form_submissions;
create policy ops_form_submissions_select on public.ops_form_submissions
  as permissive for select to public
  using (((location_id)::text in (select public.user_accessible_locations())));
drop policy if exists ops_form_submissions_insert on public.ops_form_submissions;
create policy ops_form_submissions_insert on public.ops_form_submissions
  as permissive for insert to public
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- Table rights: what the policies above allow, and no delete or truncate for anyone but the
-- service role (row level security does not cover TRUNCATE).
grant select, insert, update on public.ops_documents to anon, authenticated;
grant select, insert, update on public.ops_forms to anon, authenticated;
grant select, insert on public.ops_form_submissions to anon, authenticated;
revoke delete, truncate on public.ops_documents from anon, authenticated;
revoke delete, truncate on public.ops_forms from anon, authenticated;
revoke update, delete, truncate on public.ops_form_submissions from anon, authenticated;
grant all on public.ops_documents, public.ops_forms, public.ops_form_submissions to service_role;

-- The Back Office second sign in step (20260919s): the same restrictive fence every table has.
do $fence$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    raise notice 'second_step_ok() not found: fence not added (run 20260919s again later to add it).';
    return;
  end if;
  foreach t in array array['ops_documents', 'ops_forms', 'ops_form_submissions'] loop
    if not exists (select 1 from pg_policy p
                    where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format(
        'create policy second_step_fence on public.%I as restrictive for all to authenticated '
        'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$fence$;


-- ============================================================================
-- 5. The private bucket 'ops-files' and its storage rules
-- ============================================================================
-- Paths (the app builds them; the first two folders are what the rules check):
--   <location_id>/documents/<document_id>/<file name>
--   <location_id>/forms/<submission_id>/<question id>-<tag>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ops-files', 'ops-files', false, 20971520, null)
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = null;

-- READ documents: Back Office + the venue's tablets.
drop policy if exists ops_files_documents_read on storage.objects;
create policy ops_files_documents_read on storage.objects
  as permissive for select to public
  using (
    bucket_id = 'ops-files'
    and (storage.foldername(objects.name))[2] = 'documents'
    and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
  );

-- READ form photos and signatures: Back Office only (plus the uploader, for 15 minutes).
drop policy if exists ops_files_forms_read on storage.objects;
create policy ops_files_forms_read on storage.objects
  as permissive for select to public
  using (
    bucket_id = 'ops-files'
    and (storage.foldername(objects.name))[2] = 'forms'
    and (
      (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
      or (
        -- the storage server stamps the uploader in owner (uuid) and owner_id (text)
        (objects.owner = (select auth.uid()) or objects.owner_id = ((select auth.uid())::text))
        and objects.created_at > now() - interval '15 minutes'
        and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
      )
    )
  );

-- ADD: Back Office + the venue's tablets, only into the venue's documents or forms folder.
-- No update rule (no overwrite) and no delete rule (nothing is removed).
drop policy if exists ops_files_insert on storage.objects;
create policy ops_files_insert on storage.objects
  as permissive for insert to public
  with check (
    bucket_id = 'ops-files'
    and (storage.foldername(objects.name))[2] in ('documents', 'forms')
    and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
  );

reset lock_timeout;

-- The Data API sees the new tables straight away.
notify pgrst, 'reload schema';
