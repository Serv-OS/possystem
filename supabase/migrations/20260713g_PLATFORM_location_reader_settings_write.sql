-- 20260713g — ⚠ PLATFORM DB (yhzjgyrkyjabvhblqxzu), NOT the ops DB.
-- BUG: location_reader_settings had ONLY a SELECT policy, so the back-office "Save & sync
-- to readers" UPDATE was silently denied by RLS (0 rows changed, no error) → idle-screen /
-- tipping settings never persisted. Add the write policies the rest of the platform DB
-- already has (cf. locations_anon_update USING(true)). Platform-wide tenant isolation is a
-- separate future cutover (mirrors the ops-core one).
drop policy if exists location_reader_settings_write on public.location_reader_settings;
create policy location_reader_settings_write on public.location_reader_settings for update
  using (true) with check (true);
drop policy if exists location_reader_settings_insert on public.location_reader_settings;
create policy location_reader_settings_insert on public.location_reader_settings for insert
  with check (true);
