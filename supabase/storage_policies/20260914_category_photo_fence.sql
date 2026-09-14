-- 20260914_category_photo_fence.sql
-- OPS project (tbetcegmszzotrwdtqhi). NOT a migration: run by hand, as a role that owns storage.objects.
--
-- Why this file exists
--   20260914_OPS_category_photos.sql tries to add these policies, but on Ops the SQL editor role
--   (postgres) does not own storage.objects, so that step is skipped with only a WARNING.
--   Its last query, cat_photo_policies, shows 0 when that happened.
--
-- What it does
--   Three RESTRICTIVE policies on storage.objects. Writes to product-images/<loc>/categories/
--   are then allowed only for signed in (not anonymous) users of that venue, or a super admin,
--   and only for jpg, png or webp file names. Every other bucket and path is unchanged.
--
-- How to run it (not yet proven on Ops, try in this order)
--   A. Supabase support, or any session running as supabase_storage_admin: run this whole file.
--   B. If only the dashboard Storage policy editor is available: it makes PERMISSIVE policies, which
--      cannot fence on their own. Instead edit the existing product-images INSERT, UPDATE and DELETE
--      policies and AND this condition into each (the with check one for INSERT and UPDATE):
--        (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
--        or (not public.is_anon_session()
--        and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())
--        and lower(storage.extension(name)) in ('jpg', 'png', 'webp')))
--
-- Also set in the dashboard (Storage, product-images, bucket settings): Allowed MIME types
--   image/jpeg, image/png, image/webp (plus any other type item photos really use). The server then
--   refuses SVG or HTML files for every path. Check item photo uploads still work afterwards.
--
-- Check: select polname from pg_policy where polrelid = 'storage.objects'::regclass and polname like 'cat_photo%';   (3 rows)
-- Rollback: drop policy if exists cat_photo_insert_fence on storage.objects; (and the update and delete ones)

begin;

drop policy if exists cat_photo_insert_fence on storage.objects;
drop policy if exists cat_photo_update_fence on storage.objects;
drop policy if exists cat_photo_delete_fence on storage.objects;

create policy cat_photo_insert_fence on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())
          and lower(storage.extension(name)) in ('jpg', 'png', 'webp')));

create policy cat_photo_update_fence on storage.objects as restrictive for update to authenticated
    using (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())))
    with check (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())
          and lower(storage.extension(name)) in ('jpg', 'png', 'webp')));

create policy cat_photo_delete_fence on storage.objects as restrictive for delete to authenticated
    using (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())));

commit;

select count(*) as cat_photo_policies
from pg_policy
where polrelid = 'storage.objects'::regclass and polname like 'cat_photo%';
