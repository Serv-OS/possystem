-- ============================================================================
-- Workforce documents — PRIVATE storage bucket + tenant-scoped Storage RLS
-- ----------------------------------------------------------------------------
-- Right-to-work, contracts and other staff PII are uploaded here (NOT public).
-- Path convention: <location_id>/<staff_id>/<type>-<timestamp>.<ext>.
-- Access is fenced to the caller's locations via user_accessible_locations()
-- (the first path folder = location_id). Files are served to the client via
-- short-lived signed URLs (createSignedUrl). Already applied to the Ops DB;
-- kept here as the source of truth. Idempotent.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('wf-documents', 'wf-documents', false)
on conflict (id) do nothing;

do $$ begin
  create policy wf_docs_select on storage.objects for select to authenticated
    using (bucket_id = 'wf-documents' and (storage.foldername(name))[1] in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy wf_docs_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'wf-documents' and (storage.foldername(name))[1] in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy wf_docs_update on storage.objects for update to authenticated
    using (bucket_id = 'wf-documents' and (storage.foldername(name))[1] in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy wf_docs_delete on storage.objects for delete to authenticated
    using (bucket_id = 'wf-documents' and (storage.foldername(name))[1] in (select public.user_accessible_locations()));
exception when duplicate_object then null; end $$;
