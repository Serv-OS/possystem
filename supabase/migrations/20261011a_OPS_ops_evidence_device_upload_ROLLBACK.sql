-- 20261011a_OPS_ops_evidence_device_upload_ROLLBACK.sql
-- Puts the three ops-evidence policies back exactly as 20260729b wrote them (with the bare
-- `name` inside the device subquery, which Postgres resolves to ops_devices.name). Only run
-- this if 20261011a must be undone; it brings the tablet photo refusal back.
begin;
drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
  bucket_id = 'ops-evidence'
  and (
    exists (select 1 from public.ops_devices d where d.device_uid = auth.uid() and d.active and (storage.foldername(name))[1] = d.location_id::text)
    or (storage.foldername(name))[1] in (select user_accessible_locations())
  )
);
drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
using (
  bucket_id = 'ops-evidence'
  and (
    exists (select 1 from public.ops_devices d where d.device_uid = auth.uid() and d.active and (storage.foldername(name))[1] = d.location_id::text)
    or (storage.foldername(name))[1] in (select user_accessible_locations())
  )
)
with check (
  bucket_id = 'ops-evidence'
  and (
    exists (select 1 from public.ops_devices d where d.device_uid = auth.uid() and d.active and (storage.foldername(name))[1] = d.location_id::text)
    or (storage.foldername(name))[1] in (select user_accessible_locations())
  )
);
drop policy if exists ops_evidence_read on storage.objects;
create policy ops_evidence_read on storage.objects for select to public
using (
  bucket_id = 'ops-evidence'
  and (
    exists (select 1 from public.ops_devices d where d.device_uid = auth.uid() and d.active and (storage.foldername(name))[1] = d.location_id::text)
    or (storage.foldername(name))[1] in (select user_accessible_locations())
  )
);
commit;
