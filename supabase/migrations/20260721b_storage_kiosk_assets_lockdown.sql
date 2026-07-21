-- 20260721b_storage_kiosk_assets_lockdown.sql
--
-- SECURITY: the kiosk-assets bucket was WORLD-WRITABLE.
--
--   kiosk_assets_write : FOR ALL TO public USING (bucket_id = 'kiosk-assets')
--                        WITH CHECK (bucket_id = 'kiosk-assets')
--
-- `public` in Postgres means EVERYONE, including unauthenticated callers, and the
-- policy's only condition is which bucket it is. So any anonymous visitor could
-- upload, overwrite or DELETE every venue's kiosk branding and customer-display
-- slideshow images — and use the bucket as free file hosting on our domain.
--
-- Supabase's advisor only reported the read/listing half of this
-- (public_bucket_allows_listing); the write policy was not flagged at all.
--
-- WHAT MUST KEEP WORKING (verified in code before writing this):
--   * getPublicUrl() reads — KioskSettings.jsx:137, DeviceProfiles.jsx:390.
--     A bucket marked public serves objects at /storage/v1/object/public/... and
--     that path does NOT consult storage.objects RLS, so anonymous kiosks and
--     customer displays keep loading images with no SELECT policy at all.
--   * upload() — KioskSettings.jsx:135, DeviceProfiles.jsx:388. Both are BACK
--     OFFICE screens, so an authenticated-only write policy is sufficient.
--   * Nothing calls .list() on this bucket (grepped: only getPublicUrl + upload),
--     so removing the broad SELECT policy breaks nothing and stops one venue
--     enumerating another's uploads.

begin;

-- Writes: authenticated back-office users only (was: anyone at all).
drop policy if exists kiosk_assets_write on storage.objects;
create policy kiosk_assets_write on storage.objects
  for all to authenticated
  using (bucket_id = 'kiosk-assets')
  with check (bucket_id = 'kiosk-assets');

-- Listing: drop the blanket public SELECT. Public URL reads are unaffected
-- (they bypass RLS); this only stops enumeration of the bucket's contents.
drop policy if exists kiosk_assets_read on storage.objects;
create policy kiosk_assets_read on storage.objects
  for select to authenticated
  using (bucket_id = 'kiosk-assets');

commit;
