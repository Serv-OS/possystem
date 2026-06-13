-- Digital Menu Board — one row per "screen" (a screen's worth of menu content + style).
-- Public SELECT: display config is no more sensitive than the public menu it shows
-- (menu_items is already anon-readable for kiosk/online). Writes: authed + location access.

create table if not exists menu_boards (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null,
  org_id          uuid,
  name            text not null default 'Menu board',
  orientation     text not null default 'landscape',   -- landscape | portrait
  mode            text not null default 'menu',         -- menu | marketing
  layout          jsonb not null default '{}'::jsonb,   -- { columns:'auto'|2|3|4, blocks:[{categoryId,col,order,span}] }
  display_options jsonb not null default '{}'::jsonb,   -- { showDescription, showAllergens, showPrices, showImages, soldOut }
  theme           jsonb not null default '{}'::jsonb,   -- { bgImageUrl, bgColor, textColor, accent, font, footerNote, logoUrl, themeMode }
  marketing       jsonb not null default '{}'::jsonb,   -- { mediaUrl, mediaType, fit }
  published_at    timestamptz,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_menu_boards_location on menu_boards(location_id);

alter table menu_boards enable row level security;

drop policy if exists menu_boards_read on menu_boards;
create policy menu_boards_read on menu_boards for select using (true);

drop policy if exists menu_boards_insert on menu_boards;
create policy menu_boards_insert on menu_boards for insert to authenticated with check (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

drop policy if exists menu_boards_update on menu_boards;
create policy menu_boards_update on menu_boards for update to authenticated using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
) with check (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

drop policy if exists menu_boards_delete on menu_boards;
create policy menu_boards_delete on menu_boards for delete to authenticated using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

do $$ begin
  alter publication supabase_realtime add table menu_boards;
exception when duplicate_object then null; end $$;
