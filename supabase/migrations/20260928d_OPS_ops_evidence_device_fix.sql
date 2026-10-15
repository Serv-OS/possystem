-- 20260928d_OPS_ops_evidence_device_fix.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- WHAT: a paired Operations tablet can upload and open checklist evidence photos again.
-- Peter runs this; Claude cannot run DDL on production and never writes to it. No app change:
-- the tablet starts working the moment this has run.
--
-- THE BUG (read from the LIVE pg_policies text on 28 Sep 2026, read only)
--   The 3 storage rules on the private 'ops-evidence' bucket, ops_evidence_device_insert,
--   ops_evidence_device_update and ops_evidence_read (20260713b, then 20260729b), have a
--   tablet branch written as
--     exists (select 1 from public.ops_devices d
--              where d.device_uid = auth.uid() and d.active
--                and (storage.foldername(name))[1] = d.location_id::text)
--   ops_devices has its own `name` column (the tablet's name). Inside that subquery an
--   unqualified `name` binds to the nearest table, d, so Postgres stored
--     storage.foldername(d.name)
--   The tablet branch compares the TABLET'S NAME with its venue id, so it never matches.
--   A paired tablet (?mode=ops, and the Manager app's Ops tab) with no Back Office login
--   therefore cannot upload a photo (uploadChecklistPhoto) or open one (signCompletions)
--   in src/lib/ops/checklists.js. Only the Back Office branch, user_accessible_locations(),
--   works today.
--   A SECOND fault sits behind the first: that subquery runs as the caller, and ops_devices
--   has its own rule (ops_devices_rls: Back Office logins only; 000_baseline_ops.sql, and
--   20260627 left it that way on purpose), so a tablet cannot even see its own ops_devices
--   row there. Qualifying the name inside the old subquery would still refuse every tablet.
--   ops_writable_location_uuids() is SECURITY DEFINER, so it reads the tablet's row itself.
--   Both faults were reproduced on a local Postgres 17 stand-in (see the PR).
--
-- THE FIX
--   Drop and recreate the same 3 rules, naming objects.name in full, in the SET form of
--   20260927a (worked out once per statement, never once per row):
--     objects.bucket_id = 'ops-evidence'
--     and (storage.foldername(objects.name))[1]
--           in (select l::text from public.ops_writable_location_uuids() as l)
--
-- WHO MAY DO WHAT: IDENTICAL to what 20260713b + 20260729b meant
--   ops_writable_location_uuids() (20260927a) is exactly the union of the two old branches:
--     user_accessible_locations()                        the Back Office branch (unchanged)
--     active ops_devices rows with device_uid = auth.uid() the tablet branch (now working)
--   Every id in user_accessible_locations() is a uuid column cast to text
--   (user_locations.location_id, locations.id), so the helper's uuid filter drops nothing and
--   l::text gives back the same lowercase text. A tablet with no venue matches nothing.
--   Same 3 names, same commands (insert, update, select), same role (public), still
--   permissive, same bucket. No delete rule (there never was one). Other buckets untouched.
--   The one change in access: an active tablet reaches ITS OWN venue's folder, as intended.
--
-- SAFETY: bare statements, no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again). Every
-- statement can run twice. 3 second lock wait. The guard stops before anything if 20260927a
-- (the set helpers) has not run. The check at the end stops, and so undoes everything, if any
-- of the 3 rules is missing, still looks up ops_devices itself, or does not use the helper.
-- Changing a storage rule locks storage.objects (every bucket: logos, menu photos) for well
-- under a second; run it outside UK service hours like every other migration.
--
-- ROLLBACK: 20260928d_OPS_ops_evidence_device_fix_ROLLBACK.sql puts back the exact live rules
-- of 28 Sep, broken tablet branch included.
--
-- VERIFY (read only, paste each on its own):
--   V0. BEFORE or after: why fixing only the name was not enough. Expect ops_devices_rls,
--       whose qual is user_accessible_locations() (Back Office only), plus second_step_fence
--       (RESTRICTIVE, from 20260919s). Expect no qual that mentions device_uid: nothing lets a
--       tablet read its own row directly.
--     select policyname, permissive, cmd, qual from pg_policies
--      where schemaname = 'public' and tablename = 'ops_devices';
--   V1. The 3 rules. Expect 3 rows: ops_evidence_device_insert INSERT, ops_evidence_device_update
--       UPDATE, ops_evidence_read SELECT; roles {public}; PERMISSIVE. Each qual / with_check
--       names ops_writable_location_uuids and has no ops_devices subquery. Postgres prints the
--       photo's own column as plain `name` there; that is right, because it now sits OUTSIDE
--       any subquery, so it can only mean the photo's path.
--     select policyname, cmd, roles, permissive, qual, with_check from pg_policies
--      where schemaname = 'storage' and tablename = 'objects' and policyname like 'ops_evidence%'
--      order by policyname;
--   V2. The tablet name compare is gone. Expect 0 rows.
--     select policyname from pg_policies
--      where schemaname = 'storage' and tablename = 'objects' and policyname like 'ops_evidence%'
--        and concat_ws(' ', qual, with_check) ~ '(ops_devices|foldername\(d\.name\))';
--   V3. The same trap anywhere else in storage. Expect 0 rows. A row here is another bucket
--       with the same bug (not changed by this file): tell Claude.
--     select policyname from pg_policies
--      where schemaname = 'storage' and tablename = 'objects'
--        and concat_ws(' ', qual, with_check) ~ 'foldername\((?!objects\.)\w+\.name\)';
--   V4. Act as the most recently seen paired tablet (read only, ends in rollback). The first
--       select must return 1 row (no row = no paired tablet to test with). Then expect:
--       its_venue_allowed true, other_venue_allowed false, and
--       photos_tablet_can_see = photos_in_its_venue (before this file it was 0).
--     begin;
--     select d.tablet, d.location_id, d.photos_in_its_venue,
--            set_config('request.jwt.claims',
--                       json_build_object('sub', d.device_uid, 'role', 'authenticated',
--                                         'is_anonymous', true)::text, true) is not null as acting,
--            set_config('verify.venue', d.location_id::text, true) is not null as venue_set,
--            set_config('verify.other', coalesce((select l.id::text from public.locations l
--                                                  where l.id <> d.location_id limit 1), ''), true) is not null as other_set
--       from (select o.device_uid, o.name as tablet, o.location_id,
--                    (select count(*) from storage.objects s
--                      where s.bucket_id = 'ops-evidence'
--                        and (storage.foldername(s.name))[1] = o.location_id::text) as photos_in_its_venue
--               from public.ops_devices o
--              where o.active and o.location_id is not null
--              order by o.last_seen_at desc nulls last
--              limit 1) d;
--     set local role authenticated;
--     select current_setting('verify.venue', true) in (select l::text from public.ops_writable_location_uuids() as l) as its_venue_allowed,
--            current_setting('verify.other', true) in (select l::text from public.ops_writable_location_uuids() as l) as other_venue_allowed,
--            (select count(*) from storage.objects where bucket_id = 'ops-evidence') as photos_tablet_can_see;
--     rollback;


-- ============================================================================
-- 0. Guard: 20260927a must have run
-- ============================================================================
set lock_timeout = '3s';

do $guard$
declare
  v_src text;
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure('public.ops_writable_location_uuids()');
  if v_src is null then
    raise exception '20260928d stopped, NOTHING changed: run 20260927a first (public.ops_writable_location_uuids() is missing).';
  end if;
  -- the helper must still be "Back Office plus the caller's active tablets", or the
  -- "who may do what is identical" promise above no longer holds
  if v_src !~ 'user_accessible_locations\(\)' or v_src !~ 'ops_devices' or v_src !~ 'device_uid\s*=\s*auth\.uid\(\)' then
    raise exception '20260928d stopped, NOTHING changed: public.ops_writable_location_uuids() is no longer the 20260927a helper (Back Office plus the caller''s active ops_devices).';
  end if;
  if to_regprocedure('public.user_accessible_locations()') is null
     or to_regclass('public.ops_devices') is null
     or to_regprocedure('storage.foldername(text)') is null then
    raise exception '20260928d stopped, NOTHING changed: user_accessible_locations(), ops_devices or storage.foldername is missing.';
  end if;
end
$guard$;


-- ============================================================================
-- 1. INSERT: a new photo goes only into a venue folder the caller may write
-- ============================================================================
drop policy if exists ops_evidence_device_insert on storage.objects;
create policy ops_evidence_device_insert on storage.objects for insert to public
with check (
  objects.bucket_id = 'ops-evidence'
  and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
);


-- ============================================================================
-- 2. UPDATE: a re-captured photo (upload with upsert) overwrites in the same folder
-- ============================================================================
drop policy if exists ops_evidence_device_update on storage.objects;
create policy ops_evidence_device_update on storage.objects for update to public
using (
  objects.bucket_id = 'ops-evidence'
  and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
)
with check (
  objects.bucket_id = 'ops-evidence'
  and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
);


-- ============================================================================
-- 3. SELECT: signed URLs for the tablet and for Back Office
-- ============================================================================
drop policy if exists ops_evidence_read on storage.objects;
create policy ops_evidence_read on storage.objects for select to public
using (
  objects.bucket_id = 'ops-evidence'
  and (storage.foldername(objects.name))[1] in (select l::text from public.ops_writable_location_uuids() as l)
);


-- ============================================================================
-- 4. Check: all 3 rules came out right, or NOTHING is kept
-- ============================================================================
do $check$
declare
  v_bad text;
begin
  select string_agg(w.pol, ', ' order by w.pol) into v_bad
    from (values ('ops_evidence_device_insert', 'INSERT'),
                 ('ops_evidence_device_update', 'UPDATE'),
                 ('ops_evidence_read',          'SELECT')) as w(pol, cmd)
    left join pg_policies p
      on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = w.pol
   where p.policyname is null
      or p.cmd <> w.cmd
      or p.permissive <> 'PERMISSIVE'
      or p.roles <> array['public']::name[]
      or (w.cmd in ('SELECT', 'UPDATE') and p.qual is null)
      or (w.cmd in ('INSERT', 'UPDATE') and p.with_check is null)
      or concat_ws(' ', p.qual, p.with_check) !~ 'ops_writable_location_uuids'
      or concat_ws(' ', p.qual, p.with_check) !~ 'ops-evidence'
      or concat_ws(' ', p.qual, p.with_check) ~ 'ops_devices'
      or concat_ws(' ', p.qual, p.with_check) ~ 'foldername\((?!objects\.)\w+\.name\)';
  if v_bad is not null then
    raise exception '20260928d stopped, NOTHING changed: these rules did not come out right: %', v_bad;
  end if;
end
$check$;
