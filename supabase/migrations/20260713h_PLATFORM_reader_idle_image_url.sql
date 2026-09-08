-- 20260713h — ⚠ PLATFORM DB (yhzjgyrkyjabvhblqxzu), NOT the ops DB.
-- The idle-screen image was uploaded to Stripe (idle_screen_file_id) but Stripe file objects
-- aren't directly viewable, so the back office could only show "Image uploaded <id>" text — not
-- the actual picture — after reload. Store a viewable URL (Supabase Storage public URL) so the BO
-- previews the real image on load.
alter table public.location_reader_settings add column if not exists idle_screen_image_url text;
