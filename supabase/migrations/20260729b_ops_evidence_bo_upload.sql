-- 20260729b_ops_evidence_bo_upload.sql
--
-- FIX — a BACK-OFFICE USER could not upload checklist evidence photos.
--
-- 20260713b fenced the private ops-evidence bucket, and its SELECT policy covers both
-- identities (paired device OR user_accessible_locations()) — but INSERT and UPDATE
-- covered ONLY the paired device. A manager signed in with a Back Office account (the
-- Manager app shares the 'rpos-auth' session, so this is common) passed every TABLE
-- policy (ops_can_write includes user_accessible_locations) and then hit storage,
-- where their identity had no upload branch at all. The kit refused with the raw
-- "new row violates row-level security policy" — under a checklist that otherwise
-- worked, because ticks touch tables, photos touch storage.
--
-- Fix: give INSERT/UPDATE the same second branch SELECT has had all along.

drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
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

drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
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
)
with check (
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
