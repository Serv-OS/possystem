-- 20260928d_OPS_ops_evidence_device_fix_ROLLBACK.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- WHAT: undoes 20260928d. Puts the 3 'ops-evidence' storage rules back EXACTLY as they were
-- live on 28 Sep 2026 (the 20260729b rules as Postgres stored them). Peter runs this; Claude
-- cannot run DDL on production.
--
-- THIS BRINGS THE BUG BACK, on purpose: a paired Operations tablet with no Back Office login
-- can no longer upload or open checklist photos. The tablet branch below is written with
-- d.name in full because that is what Postgres stored live: the unqualified `name` in
-- 20260713b / 20260729b bound to ops_devices.name (the tablet's name), not the photo's path.
-- Only run this if 20260928d itself causes a problem (for example Back Office photo uploads
-- or thumbnails failing after it).
--
-- SAFETY: bare statements, no begin or commit (one transaction in the SQL editor: any error
-- means NOTHING changed). Can run twice. 3 second lock wait. Does not need 20260927a.
-- Locks storage.objects (every bucket) for well under a second; run it outside service.
--
-- VERIFY AFTER RUNNING (read only). Expect 3 rows, and each qual / with_check shows the
-- ops_devices subquery with storage.foldername(d.name) plus user_accessible_locations():
--   select policyname, cmd, roles, permissive, qual, with_check from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'ops_evidence%'
--    order by policyname;


set lock_timeout = '3s';

do $guard$
begin
  if to_regprocedure('public.user_accessible_locations()') is null
     or to_regclass('public.ops_devices') is null
     or to_regprocedure('storage.foldername(text)') is null then
    raise exception '20260928d rollback stopped, NOTHING changed: user_accessible_locations(), ops_devices or storage.foldername is missing.';
  end if;
end
$guard$;


drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
  objects.bucket_id = 'ops-evidence'
  and (
    exists (
      select 1 from public.ops_devices d
      where d.device_uid = auth.uid()
        and d.active
        and (storage.foldername(d.name))[1] = d.location_id::text
    )
    or (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
  )
);

drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
using (
  objects.bucket_id = 'ops-evidence'
  and (
    exists (
      select 1 from public.ops_devices d
      where d.device_uid = auth.uid()
        and d.active
        and (storage.foldername(d.name))[1] = d.location_id::text
    )
    or (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
  )
)
with check (
  objects.bucket_id = 'ops-evidence'
  and (
    exists (
      select 1 from public.ops_devices d
      where d.device_uid = auth.uid()
        and d.active
        and (storage.foldername(d.name))[1] = d.location_id::text
    )
    or (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
  )
);

drop policy if exists ops_evidence_read on storage.objects;
create policy ops_evidence_read on storage.objects for select to public
using (
  objects.bucket_id = 'ops-evidence'
  and (
    exists (
      select 1 from public.ops_devices d
      where d.device_uid = auth.uid()
        and d.active
        and (storage.foldername(d.name))[1] = d.location_id::text
    )
    or (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
  )
);


do $check$
declare
  v_n int;
begin
  select count(*) into v_n
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('ops_evidence_device_insert', 'ops_evidence_device_update', 'ops_evidence_read');
  if v_n <> 3 then
    raise exception '20260928d rollback stopped, NOTHING changed: expected 3 ops_evidence rules, found %', v_n;
  end if;
end
$check$;
