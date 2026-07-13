-- 20260713b_ops_evidence_private_bucket.sql
--
-- SECURITY FIX — HACCP checklist evidence photos were stored in the world-readable
-- 'receipt-assets' bucket (any authenticated tenant could read/overwrite/delete another
-- venue's food-safety records). Move them to a PRIVATE, location-fenced 'ops-evidence'
-- bucket. New captures store a bucket PATH (<location_id>/<run_id>/<task_id>.<ext>) and
-- the app mints short-lived signed URLs for display. Legacy public URLs already in
-- ops_task_completions.photo_url keep rendering (passed through by the app).
--
-- Fencing: a paired ops device runs as an ANONYMOUS session, so it cannot use the
-- user_accessible_locations() predicate (that reads user_locations/user_profiles, which
-- an anon device has none of). Instead we key the device policies on an ops_devices
-- claim: the device may only touch objects whose first path segment equals the
-- location_id it is actively claimed to. Back-office users read via
-- user_accessible_locations() as elsewhere.

-- Private bucket (10 MB cap, images only). Idempotent.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ops-evidence', 'ops-evidence', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = excluded.allowed_mime_types;

-- INSERT — a claimed, active ops device may write only under its own location's folder.
drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
  bucket_id = 'ops-evidence'
  and exists (
    select 1 from public.ops_devices d
    where d.device_uid = auth.uid()
      and d.active
      and (storage.foldername(name))[1] = d.location_id::text
  )
);

-- UPDATE — same device fence (upsert overwrites a re-captured photo).
drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
using (
  bucket_id = 'ops-evidence'
  and exists (
    select 1 from public.ops_devices d
    where d.device_uid = auth.uid()
      and d.active
      and (storage.foldername(name))[1] = d.location_id::text
  )
)
with check (
  bucket_id = 'ops-evidence'
  and exists (
    select 1 from public.ops_devices d
    where d.device_uid = auth.uid()
      and d.active
      and (storage.foldername(name))[1] = d.location_id::text
  )
);

-- SELECT — the claimed device (own location) OR a back-office user with access to that
-- location. Needed so createSignedUrl() succeeds for both the tablet and the BO viewer.
drop policy if exists ops_evidence_read on storage.objects;
create policy ops_evidence_read on storage.objects for select to public
using (
  bucket_id = 'ops-evidence'
  and (
    exists (
      select 1 from public.ops_devices d
      where d.device_uid = auth.uid()
        and d.active
        and (storage.foldername(name))[1] = d.location_id::text
    )
    or (storage.foldername(name))[1] in (select user_accessible_locations())
  )
);
