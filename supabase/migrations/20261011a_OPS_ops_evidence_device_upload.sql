-- 20261011a_OPS_ops_evidence_device_upload.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Replaces THREE storage policies on the ops-evidence bucket. No table,    #
-- #  no data, no other policy touched. Safe any time, service included.      #
-- ############################################################################
--
-- WHY (11 Oct 2026, Huddersfield ops tablet, "new row violates row-level security policy"
-- under the Management Opening Checklist). That wording, with no table name, is the Storage
-- API refusing a PHOTO upload: the camera buttons on checklist tasks write to the private
-- ops-evidence bucket. 20260713b and 20260729b wrote the device branch of those policies as
--   exists (select 1 from public.ops_devices d
--           where d.device_uid = auth.uid() and d.active
--             and (storage.foldername(name))[1] = d.location_id::text)
-- Inside that subquery the bare `name` is ops_devices.name ("Ops tablet"), not the file path
-- storage.objects.name. Postgres stored it as storage.foldername(d.name), which is never a
-- folder, so NO paired tablet has ever been allowed to upload a photo (one object in the bucket
-- since July, from a Back Office login). Ticks and sign offs touch tables and were fine.
--
-- FIX: the venue test is public.ops_writable_location_uuids() (the paired tablet's venue, plus
-- every venue a signed in person can reach), the helper the ops-files bucket already uses. The
-- policy then has no FROM of its own, so `name` can only mean the object. One branch replaces
-- the two old ones for devices and Back Office alike.

begin;

drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
  bucket_id = 'ops-evidence'
  and (storage.foldername(name))[1] in (select l::text from public.ops_writable_location_uuids() l)
);

drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
using (
  bucket_id = 'ops-evidence'
  and (storage.foldername(name))[1] in (select l::text from public.ops_writable_location_uuids() l)
)
with check (
  bucket_id = 'ops-evidence'
  and (storage.foldername(name))[1] in (select l::text from public.ops_writable_location_uuids() l)
);

drop policy if exists ops_evidence_read on storage.objects;
create policy ops_evidence_read on storage.objects for select to public
using (
  bucket_id = 'ops-evidence'
  and (storage.foldername(name))[1] in (select l::text from public.ops_writable_location_uuids() l)
);

-- Self check: the three live policies must name the helper, and nothing on storage.objects may
-- still read the device's name. Any failure rolls the whole file back.
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('ops_evidence_device_insert', 'ops_evidence_device_update', 'ops_evidence_read')
     and (coalesce(with_check, '') || coalesce(qual, '')) !~ 'ops_writable_location_uuids';
  if v_bad > 0 then
    raise exception 'ops-evidence policies did not take (% wrong). Nothing was changed.', v_bad;
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname in ('ops_evidence_device_insert', 'ops_evidence_device_update', 'ops_evidence_read')) <> 3 then
    raise exception 'expected three ops-evidence policies. Nothing was changed.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
               and (coalesce(with_check, '') || coalesce(qual, '')) ~ 'foldername\(d\.name\)') then
    raise exception 'a storage policy still reads the device name. Nothing was changed.';
  end if;
end $$;

commit;

-- What you should see: three rows, each rule naming ops_writable_location_uuids.
select policyname, cmd, left(coalesce(with_check, qual), 120) as rule
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'ops_evidence%'
 order by policyname;
