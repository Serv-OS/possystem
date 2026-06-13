-- Menu board screens — pair a physical TV / Android-TV stick to a menu board.
-- One row per screen. A device self-registers an UNCLAIMED row (location_id null)
-- carrying a short human pairing code shown on the screen; the operator then
-- assigns one of their boards from Back Office by typing that code.
--
-- Security model (deliberately tight — multi-tenant):
--   * device_uid defaults to auth.uid() — a device sees ONLY its own row, so
--     pairing codes are never enumerable across tenants.
--   * Back Office sees only its location's PAIRED screens (location_id scoped);
--     it cannot list other venues' unpaired screens. The pairing code is a
--     capability: you must physically read it off the screen to claim it.
--   * NO update policy — every mutation (claim / reassign / unpair / heartbeat)
--     goes through SECURITY DEFINER functions that validate location access, so
--     a device can never write location_id/board_id and a Back Office user can
--     only ever assign boards from their own location. The "resolve real
--     locationId before any write" invariant therefore cannot be violated.

create table if not exists menu_board_screens (
  id           uuid primary key default gen_random_uuid(),
  device_uid   uuid not null default auth.uid(),          -- the (anon) auth user that owns this screen
  location_id  uuid,                                       -- null until paired; set from the assigned board
  org_id       uuid,
  board_id     uuid references menu_boards(id) on delete set null,
  code         text not null,                              -- human pairing code shown on the screen
  name         text,
  status       text not null default 'unpaired',           -- unpaired | paired
  last_seen_at timestamptz,
  paired_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists idx_mb_screens_code     on menu_board_screens (lower(code));
create index        if not exists idx_mb_screens_location on menu_board_screens (location_id);
create index        if not exists idx_mb_screens_board    on menu_board_screens (board_id);
create index        if not exists idx_mb_screens_device   on menu_board_screens (device_uid);

alter table menu_board_screens enable row level security;

-- SELECT: a device reads only its own row; Back Office reads its location's rows.
drop policy if exists mb_screens_select on menu_board_screens;
create policy mb_screens_select on menu_board_screens for select using (
  device_uid = auth.uid()
  or location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- INSERT: a device may create only an UNCLAIMED row that it owns.
drop policy if exists mb_screens_insert on menu_board_screens;
create policy mb_screens_insert on menu_board_screens for insert with check (
  device_uid = auth.uid() and location_id is null and board_id is null and status = 'unpaired'
);

-- DELETE: Back Office may retire its location's screens.
drop policy if exists mb_screens_delete on menu_board_screens;
create policy mb_screens_delete on menu_board_screens for delete to authenticated using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- (no UPDATE policy — all updates flow through the SECURITY DEFINER functions below)

-- helper: does the current caller have access to a location?
create or replace function _mb_user_has_location(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_loc is not null and (
    exists (select 1 from user_locations where user_id = auth.uid() and location_id = p_loc)
    or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
  );
$$;

-- device heartbeat: stamp last_seen_at on the device's OWN row only.
create or replace function mb_screen_heartbeat(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update menu_board_screens set last_seen_at = now(), updated_at = now()
   where id = p_id and device_uid = auth.uid();
$$;

-- Back Office: claim an unpaired screen BY CODE and assign it a board.
create or replace function claim_menu_board_screen(p_code text, p_board_id uuid)
returns menu_board_screens
language plpgsql security definer set search_path = public as $$
declare b record; s record;
begin
  select id, location_id, org_id into b from menu_boards where id = p_board_id;
  if b.id is null then raise exception 'board not found'; end if;
  if not _mb_user_has_location(b.location_id) then raise exception 'no access to this location'; end if;
  select * into s from menu_board_screens where lower(code) = lower(btrim(p_code)) limit 1;
  if s.id is null then raise exception 'pairing code not found'; end if;
  if s.location_id is not null and not _mb_user_has_location(s.location_id)
    then raise exception 'screen belongs to another location'; end if;
  update menu_board_screens
     set board_id = b.id, location_id = b.location_id, org_id = b.org_id,
         status = 'paired', paired_at = now(), updated_at = now()
   where id = s.id;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $$;

-- Back Office: reassign (p_board_id not null) or unpair (null) a screen the caller manages.
create or replace function set_menu_board_screen(p_screen_id uuid, p_board_id uuid)
returns menu_board_screens
language plpgsql security definer set search_path = public as $$
declare b record; s record;
begin
  select * into s from menu_board_screens where id = p_screen_id;
  if s.id is null then raise exception 'screen not found'; end if;
  if not _mb_user_has_location(s.location_id) then raise exception 'no access to this screen'; end if;
  if p_board_id is null then
    update menu_board_screens set board_id = null, status = 'unpaired', paired_at = null, updated_at = now()
     where id = s.id;
  else
    select id, location_id, org_id into b from menu_boards where id = p_board_id;
    if b.id is null then raise exception 'board not found'; end if;
    if b.location_id is distinct from s.location_id then raise exception 'board is at a different location'; end if;
    update menu_board_screens set board_id = b.id, org_id = b.org_id, status = 'paired', paired_at = now(), updated_at = now()
     where id = s.id;
  end if;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $$;

grant execute on function mb_screen_heartbeat(uuid)            to anon, authenticated;
grant execute on function claim_menu_board_screen(text, uuid)  to authenticated;
grant execute on function set_menu_board_screen(uuid, uuid)    to authenticated;

do $$ begin
  alter publication supabase_realtime add table menu_board_screens;
exception when duplicate_object then null; end $$;
