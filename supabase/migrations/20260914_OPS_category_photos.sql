-- 20260914_OPS_category_photos.sql
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- Category photos: the Back Office uploads one photo per category, and each kiosk profile
-- has a switch to show those photos on the kiosk category tiles.
--
-- Adds
--   1. menu_categories.image                 public URL of the tile photo (product-images/<loc>/categories/...)
--   2. menu_categories_image_shape           the URL must be a product-images category photo URL
--                                            (same pattern as CATEGORY_PHOTO_URL_PATTERN in src/lib/categoryPhoto.js)
--   3. device_profiles.kiosk_category_photos per kiosk profile switch, default on
--   4. cat_photo_*_fence (ATTEMPT ONLY)      RESTRICTIVE storage policies on product-images/<loc>/categories/
--
-- READ THIS ABOUT STEP 4. On Ops, storage.objects is owned by supabase_storage_admin and the
-- SQL editor role (postgres) is not a member. The same fence for order screen logos
-- (osd_logo_*_fence, 20260911) was SKIPPED on live with only a WARNING. Expect the same here.
-- The LAST query of this file shows cat_photo_policies. If it says 0, category photo files
-- are NOT protected yet: follow supabase/storage_policies/20260914_category_photo_fence.sql.
-- Until then any anonymous kiosk, TV or online session can upload, overwrite or delete files
-- in product-images, including category photos (that was already true for item photos).
--
-- Safety
--   Idempotent. The web app works before and after this runs.
--   Before it runs: no photo upload shows, the kiosk switch is hidden, category saves and
--   kiosk settings saves still work, and every kiosk keeps today's text tiles.
--   The storage fence only covers product-images paths whose second segment is 'categories'.
--   Item photo paths (<loc>/<item>.<ext>) and the four existing product-images policies are
--   left exactly as they are.
--
-- Run it in a quiet period. lock_timeout below makes it fail fast (then simply re-run it).
--
-- Rollback (only if needed)
--   drop policy if exists cat_photo_insert_fence on storage.objects;
--   drop policy if exists cat_photo_update_fence on storage.objects;
--   drop policy if exists cat_photo_delete_fence on storage.objects;
--   alter table public.menu_categories drop constraint if exists menu_categories_image_shape;
--   alter table public.menu_categories drop column if exists image;
--   alter table public.device_profiles drop column if exists kiosk_category_photos;
--   Then refresh every open Back Office tab straight after, so no tab keeps sending photo URLs.

-- Fail fast on a busy table instead of making menu and kiosk writes queue behind this script.
set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.menu_categories') is null or to_regclass('public.device_profiles') is null then
    raise exception 'Wrong database. Run this on the Ops project.';
  end if;
end $$;

-- 1. Category photo column -------------------------------------------------------------------------
alter table public.menu_categories add column if not exists image text;
comment on column public.menu_categories.image is
  'Kiosk category tile photo (public URL, product-images/<loc>/categories/...). Written only when present; cleared only by the Back Office remove action.';

-- 2. URL shape check ----------------------------------------------------------------------------------
-- menu_categories is still writable by anonymous sessions on live, so the pointer itself is pinned to
-- a product-images category photo. Pointers to other hosts or to unfenced item photo paths are refused.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_categories_image_shape') then
    alter table public.menu_categories add constraint menu_categories_image_shape
      check (image is null or (char_length(image) <= 2048
        and image ~ '^https://[^/?#]+/storage/v1/object/public/product-images/[^/?#]+/categories/[A-Za-z0-9_-]+-[0-9]+\.(jpg|png|webp)$'));
  end if;
end $$;

-- 3. Kiosk profile switch -----------------------------------------------------------------------------
alter table public.device_profiles add column if not exists kiosk_category_photos boolean not null default true;
comment on column public.device_profiles.kiosk_category_photos is
  'Kiosk: show category photos on the category tiles. Photos only show when at least one category has one.';

-- 4. Storage fence for category photos (ATTEMPT; expected to be skipped on Ops, see the header) ----
-- Category photos upload to product-images at <loc>/categories/<file>. That bucket's live policies
-- only check auth.role() = 'authenticated', which every anonymous sign in (kiosk, TV, online) also
-- has. These RESTRICTIVE policies narrow writes under that one folder to signed in Back Office users
-- of that venue, and only jpg, png or webp names. Every other bucket and path passes the first two
-- tests, so nothing else changes. Identical to supabase/storage_policies/20260914_category_photo_fence.sql.
do $$ begin
  execute 'drop policy if exists cat_photo_insert_fence on storage.objects';
  execute 'drop policy if exists cat_photo_update_fence on storage.objects';
  execute 'drop policy if exists cat_photo_delete_fence on storage.objects';
  execute $p$create policy cat_photo_insert_fence on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())
          and lower(storage.extension(name)) in ('jpg', 'png', 'webp')))$p$;
  execute $p$create policy cat_photo_update_fence on storage.objects as restrictive for update to authenticated
    using (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())))
    with check (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())
          and lower(storage.extension(name)) in ('jpg', 'png', 'webp')))$p$;
  execute $p$create policy cat_photo_delete_fence on storage.objects as restrictive for delete to authenticated
    using (bucket_id is distinct from 'product-images' or split_part(name, '/', 2) <> 'categories'
      or (not public.is_anon_session()
          and (split_part(name, '/', 1) in (select public.user_accessible_locations()) or public.is_super_admin())))$p$;
exception when insufficient_privilege or undefined_table or undefined_function or invalid_schema_name then
  raise warning 'Category photo protection was NOT added (%). Run supabase/storage_policies/20260914_category_photo_fence.sql as the storage owner.', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- Checks after running:
--   select column_name from information_schema.columns where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'image';   (1 row)
--   select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'device_profiles' and column_name = 'kiosk_category_photos';   (1 row, default true)
--   select conname from pg_constraint where conname = 'menu_categories_image_shape';   (1 row)

-- VISIBLE CHECK (the SQL editor shows this last result). 3 means the storage fence is on.
-- 0 means it was skipped: category photo files are NOT protected until the storage_policies file is run.
select count(*) as cat_photo_policies
from pg_policy
where polrelid = 'storage.objects'::regclass and polname like 'cat_photo%';
