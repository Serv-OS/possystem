-- 20260911_OPS_order_status_displays.sql
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- Order screens: a TV shows customers and delivery drivers which orders are
-- received, preparing, ready and collected.
--
-- Adds
--   1. order_status_displays          one layout config per screen design, per venue (Back Office writes)
--   2. menu_board_screens.order_display_id   a paired TV shows EITHER a menu board OR an order screen
--   3. order_status_marks             server stamped status and departure times per order (no client access)
--   4. order_status_pings             one row per venue, published to realtime, no personal data
--   5. trigger on order_queue         keeps marks and pings current, swallows its own errors
--   6. RPCs claim_order_status_screen, set_order_status_screen, order_status_feed, and
--      behaviour compatible replacements of claim_menu_board_screen and set_menu_board_screen
--
-- Safety
--   Idempotent. The web app works before and after this runs.
--   The screen NEVER reads order_queue. order_status_feed resolves the caller's own paired
--   screen by auth.uid() and returns masked minimal fields. Names are shortened HERE, not in JS.
--   Mirrors src/lib/orderScreen/orderScreenStatus.js. Change both together.
--   Order writes never wait on each other here: the shared ping row and old mark cleanup
--   use FOR UPDATE SKIP LOCKED, so a busy row is skipped and the 5 second poll covers it.
--   Online, catering and QR refs show their last 3 characters only, because the full ref is
--   an order tracking lookup key. Two visible rows in one section that share those 3 show 4.
--   NAMES: what a TV shows is only as trustworthy as order_queue. While any order_queue policy
--   lets any caller insert or update rows (the "allow all" policy today), NO names go to a TV,
--   for every source: anyone with the public key could put any words on a customer facing
--   screen. order_status_names_enabled() checks the live policies on every feed call, so names
--   switch on by themselves once the 20260907b order_queue fence (file 3) drops "allow all".
--   After that: kiosk, online, QR and catering names show only after a status change made in
--   a separate request (the fence stops anonymous callers updating rows, so that means staff
--   or a server), and names never carry an @ or any digit.
--
-- Run it in a quiet period. lock_timeout below makes it fail fast (then simply re-run it)
-- instead of queueing every till, kiosk and online order write behind its table locks.
--
-- Rollback (only if needed)
--   drop trigger if exists order_status_marks_trg on public.order_queue;
--   drop trigger if exists order_status_displays_ping on public.order_status_displays;
--   drop function if exists public.order_status_feed(uuid);
--   drop function if exists public.claim_order_status_screen(text, uuid);
--   drop function if exists public.set_order_status_screen(uuid, uuid);
--   drop function if exists public.order_status_names_enabled();
--   drop policy if exists osd_logo_insert_fence on storage.objects;
--   drop policy if exists osd_logo_update_fence on storage.objects;
--   drop policy if exists osd_logo_delete_fence on storage.objects;
--   (then recreate mb_screens_insert without the order_display_id check, before the column drop)
--   alter table public.menu_board_screens drop column if exists order_display_id;
--   drop table if exists public.order_status_pings, public.order_status_marks, public.order_status_displays;

-- Fail fast on a busy table instead of making order writes queue behind this script.
set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.order_queue') is null or to_regclass('public.menu_board_screens') is null then
    raise exception 'Wrong database. Run this on the Ops project.';
  end if;
end $$;

-- 1. Config ------------------------------------------------------------------
create table if not exists public.order_status_displays (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  org_id      uuid,
  name        text not null default 'Order screen',
  is_active   boolean not null default true,
  orientation text not null default 'portrait',
  rotate      integer not null default 0,
  sections    jsonb not null default '[]'::jsonb,
  labels      jsonb not null default '{}'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  theme       jsonb not null default '{}'::jsonb,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  constraint order_status_displays_orientation_chk check (orientation in ('portrait','landscape')),
  constraint order_status_displays_rotate_chk check (rotate in (0, 90, 270)),
  constraint order_status_displays_name_chk check (char_length(name) between 1 and 60),
  constraint order_status_displays_sections_chk check (jsonb_typeof(sections) = 'array' and jsonb_array_length(sections) <= 4)
);
create index if not exists idx_osd_location on public.order_status_displays (location_id);

alter table public.order_status_displays enable row level security;
-- authenticated too: default privileges hand it TRUNCATE (which ignores RLS), REFERENCES and TRIGGER.
revoke all on table public.order_status_displays from public, anon, authenticated;
grant select, insert, update, delete on table public.order_status_displays to authenticated;
grant all on table public.order_status_displays to service_role;

drop policy if exists osd_select on public.order_status_displays;
create policy osd_select on public.order_status_displays for select to authenticated
  using (not public.is_anon_session() and (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin()));
drop policy if exists osd_insert on public.order_status_displays;
create policy osd_insert on public.order_status_displays for insert to authenticated
  with check (not public.is_anon_session() and (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin()));
drop policy if exists osd_update on public.order_status_displays;
create policy osd_update on public.order_status_displays for update to authenticated
  using (not public.is_anon_session() and (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin()))
  with check (not public.is_anon_session() and (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin()));
drop policy if exists osd_delete on public.order_status_displays;
create policy osd_delete on public.order_status_displays for delete to authenticated
  using (not public.is_anon_session() and (location_id::text in (select public.user_accessible_locations()) or public.is_super_admin()));

create or replace function public.tg_order_status_displays_touch() returns trigger
language plpgsql as $$
begin
  if new.location_id is distinct from old.location_id then
    raise exception 'An order screen cannot move to another venue';
  end if;
  new.updated_at := now();
  new.version := coalesce(old.version, 0) + 1;
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists order_status_displays_touch on public.order_status_displays;
create trigger order_status_displays_touch before update on public.order_status_displays
  for each row execute function public.tg_order_status_displays_touch();

-- 2. Screen link ---------------------------------------------------------------
alter table public.menu_board_screens
  add column if not exists order_display_id uuid references public.order_status_displays(id) on delete set null;
create index if not exists idx_mb_screens_order_display on public.menu_board_screens (order_display_id);
-- A TV registers its own unclaimed row. Same check as live (20260614), plus: it cannot give
-- itself an order screen (which would also let it probe whether a display id exists).
drop policy if exists mb_screens_insert on public.menu_board_screens;
create policy mb_screens_insert on public.menu_board_screens for insert to public
  with check (device_uid = auth.uid() and location_id is null and board_id is null
              and order_display_id is null and status = 'unpaired');

-- 3. Marks (server only) ----------------------------------------------------------
create table if not exists public.order_status_marks (
  location_id       text not null,
  ref               text not null,
  status            text,
  status_changed_at timestamptz not null default now(),
  ready_at          timestamptz,
  departed_at       timestamptz,
  departed_from     text,
  source            text,
  type              text,
  snapshot          jsonb,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (location_id, ref)
);
-- When the server first saw this order. A later status change means a second request moved it
-- (staff or a server once the order_queue fence stops anonymous updates; see NAMES above).
alter table public.order_status_marks add column if not exists first_seen_at timestamptz not null default now();
create index if not exists idx_osm_departed on public.order_status_marks (location_id, departed_at) where departed_at is not null;
alter table public.order_status_marks enable row level security;
revoke all on table public.order_status_marks from public, anon, authenticated;
grant all on table public.order_status_marks to service_role;

-- 4. Pings (realtime nudge, no personal data) ------------------------------------
create table if not exists public.order_status_pings (
  location_id text primary key,
  bumped_at   timestamptz not null default now()
);
alter table public.order_status_pings enable row level security;
revoke all on table public.order_status_pings from public, anon, authenticated;
grant select on table public.order_status_pings to authenticated;
grant all on table public.order_status_pings to service_role;

-- 5. Helpers --------------------------------------------------------------------------
create or replace function public._osd_user_has_location(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_loc is not null
     and not public.is_anon_session()
     and (p_loc::text in (select public.user_accessible_locations()) or public.is_super_admin());
$$;

create or replace function public._osd_caller_locations() returns setof text
language sql stable security definer set search_path = public as $$
  select ms.location_id::text
    from public.menu_board_screens ms
   where ms.device_uid = auth.uid()
     and ms.status = 'paired'
     and ms.order_display_id is not null
     and ms.location_id is not null
  union
  select u from public.user_accessible_locations() as u where not public.is_anon_session();
$$;

drop policy if exists osp_select on public.order_status_pings;
create policy osp_select on public.order_status_pings for select to authenticated
  using (location_id in (select public._osd_caller_locations()));

do $$ begin
  alter publication supabase_realtime add table public.order_status_pings;
exception when duplicate_object then null; end $$;

create or replace function public._osd_int(p text, p_default integer, p_min integer, p_max integer) returns integer
language sql immutable as $$
  select least(greatest(case when p ~ '^\s*-?\d{1,4}\s*$' then btrim(p)::int else p_default end, p_min), p_max);
$$;

create or replace function public._osd_type_key(p_type text) returns text
language sql immutable as $$
  select case regexp_replace(lower(coalesce(p_type, '')), '[^a-z]', '', 'g')
    when 'dinein' then 'dine-in'
    when 'eatin' then 'dine-in'
    when 'takeaway' then 'takeaway'
    when 'takeout' then 'takeaway'
    when 'collection' then 'collection'
    when 'pickup' then 'collection'
    when 'delivery' then 'delivery'
    else null
  end;
$$;

create or replace function public._osd_channel_key(p_source text, p_channel text) returns text
language sql immutable as $$
  select case
    when p_source = 'hubrise' then
      case
        when regexp_replace(lower(coalesce(p_channel, '')), '[^a-z]', '', 'g') like '%deliveroo%' then 'deliveroo'
        when regexp_replace(lower(coalesce(p_channel, '')), '[^a-z]', '', 'g') like '%ubereats%' then 'ubereats'
        when regexp_replace(lower(coalesce(p_channel, '')), '[^a-z]', '', 'g') like '%justeat%' then 'justeat'
        else 'other_app'
      end
    when p_source = 'ezcater' then 'ezcater'
    when p_source in ('kiosk', 'online', 'qr', 'catering') then p_source
    else 'till'
  end;
$$;

create or replace function public._osd_name(p_name text, p_format text) returns text
language plpgsql immutable as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  parts text[];
  first_part text;
  last_initial text;
begin
  if coalesce(p_format, 'short') = 'number' or n = '' then return null; end if;
  -- An @ or any digit (a phone number, an email address, a flat or table number) never shows.
  if n ~ '@|\d' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|table\s*\S+)$'
     or n ~ '^[0-9#\s]+$' then
    return null;
  end if;
  -- Letters, spaces, apostrophes and hyphens only, so a web address cannot render.
  n := btrim(regexp_replace(regexp_replace(n, '[^[:alpha:][:space:]''’-]', '', 'g'), '\s+', ' ', 'g'));
  if n !~ '[[:alpha:]]' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|table\s*\S+)$' then
    return null;
  end if;
  if p_format = 'full' then return left(n, 24); end if;
  parts := string_to_array(n, ' ');
  first_part := left(parts[1], 16);
  if array_length(parts, 1) = 1 then return first_part; end if;
  last_initial := upper(left(regexp_replace(parts[array_length(parts, 1)], '[^[:alpha:]]', '', 'g'), 1));
  if coalesce(last_initial, '') = '' then return first_part; end if;
  return first_part || ' ' || last_initial;
end $$;

create or replace function public._osd_number(p_ref text, p_source text, p_cust jsonb, p_courier text) returns text
language plpgsql immutable as $$
declare v text; m text[];
begin
  if p_source = 'hubrise' then
    v := nullif(btrim(coalesce(p_cust->>'collectionCode', '')), '');
    if v is null then return right(coalesce(p_ref, ''), 4); end if;
    if char_length(v) > 10 then return right(v, 6); end if;
    return v;
  elsif p_source = 'ezcater' then
    v := nullif(btrim(coalesce(p_cust->>'ezcater_order_number', '')), '');
    return coalesce(v, right(coalesce(p_ref, ''), 6));
  end if;
  -- Online, catering and QR refs are the lookup key for order tracking: last 3 only.
  if coalesce(p_ref, '') ~ '^(OL|CA|QR)-' then return right(p_ref, 3); end if;
  if p_courier is null then
    m := regexp_match(coalesce(p_ref, ''), '^R(\d+)$');
    if m is not null then return right(m[1], 2); end if;
  end if;
  return p_ref;
end $$;

-- Names on a TV are safe only when nobody outside the venue can write order_queue rows.
-- False while any permissive order_queue policy for an unauthenticated or signed in role
-- allows INSERT or UPDATE with a plain true (the live "allow all" today), or RLS is off.
-- Checked on every feed call, so names switch on by themselves when the 20260907b fence lands.
create or replace function public.order_status_names_enabled() returns boolean
language sql stable set search_path = pg_catalog, public as $$
  select coalesce((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = to_regclass('public.order_queue')), false)
     and not exists (
       select 1 from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename = 'order_queue'
          and p.permissive = 'PERMISSIVE'
          and p.cmd in ('ALL', 'INSERT', 'UPDATE')
          and (btrim(coalesce(p.qual, '')) = 'true' or btrim(coalesce(p.with_check, '')) = 'true')
          and p.roles && array['public', 'anon', 'authenticated']::name[]);
$$;

-- 6. Trigger on order_queue (never waits on another order write) ---------------------------
-- Row locks: each order only upserts its OWN mark row. The shared per venue ping row and the
-- cleanup of old marks use FOR UPDATE SKIP LOCKED, so a second writer skips a busy row instead
-- of queueing behind it (and two statement transactions cannot deadlock on it).
create or replace function public.tg_order_status_marks() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc text;
begin
  begin
    if tg_op = 'DELETE' then v_loc := old.location_id; else v_loc := new.location_id; end if;
    -- Only real venues. A junk location_id never grows marks or pings.
    if v_loc is null
       or v_loc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.locations l where l.id = v_loc::uuid) then
      return null;
    end if;
    if tg_op = 'INSERT' then
      insert into public.order_status_marks as m
        (location_id, ref, status, status_changed_at, ready_at, departed_at, departed_from, source, type, snapshot, first_seen_at, updated_at)
      values (new.location_id, new.ref, new.status, now(), case when new.status = 'ready' then now() end,
              null, null, new.source, new.type, null, now(), now())
      on conflict (location_id, ref) do update set
        status = excluded.status,
        status_changed_at = case when m.departed_at is not null or m.status is distinct from excluded.status then now() else m.status_changed_at end,
        ready_at = case when excluded.status = 'ready' and (m.status is distinct from 'ready' or m.departed_at is not null) then now() else m.ready_at end,
        first_seen_at = case when m.departed_at is not null then now() else m.first_seen_at end,
        departed_at = null, departed_from = null, snapshot = null,
        source = excluded.source, type = excluded.type, updated_at = now();
    elsif tg_op = 'UPDATE' then
      if new.status is not distinct from old.status then
        return null;
      end if;
      insert into public.order_status_marks as m
        (location_id, ref, status, status_changed_at, ready_at, departed_at, departed_from, source, type, snapshot, updated_at)
      values (new.location_id, new.ref, new.status, now(), case when new.status = 'ready' then now() end,
              null, null, new.source, new.type, null, now())
      on conflict (location_id, ref) do update set
        status = excluded.status,
        status_changed_at = now(),
        ready_at = case when excluded.status = 'ready' then now() else m.ready_at end,
        departed_at = null, departed_from = null, snapshot = null,
        source = excluded.source, type = excluded.type, updated_at = now();
    else
      insert into public.order_status_marks as m
        (location_id, ref, status, status_changed_at, departed_at, departed_from, source, type, snapshot, updated_at)
      values (old.location_id, old.ref, old.status, now(), now(), old.status, old.source, old.type,
              jsonb_build_object('name', old.customer->>'name', 'channel', old.customer->>'channel',
                                 'collectionCode', old.customer->>'collectionCode',
                                 'ezcater_order_number', old.customer->>'ezcater_order_number'),
              now())
      on conflict (location_id, ref) do update set
        status = excluded.status, departed_at = now(), departed_from = excluded.departed_from,
        snapshot = excluded.snapshot, source = excluded.source, type = excluded.type, updated_at = now();
      delete from public.order_status_marks d
       where (d.location_id, d.ref) in (
         select x.location_id, x.ref from public.order_status_marks x
          where x.location_id = old.location_id and x.departed_at < now() - interval '1 day'
          limit 50
          for update skip locked);
    end if;
    -- Realtime nudge, at most about once a second per venue. The row is seeded per venue by
    -- the backfill and by tg_order_status_displays_ping, so no insert (and no wait) here.
    perform 1 from public.order_status_pings p
     where p.location_id = v_loc and p.bumped_at < now() - interval '1 second'
       for update skip locked;
    if found then
      update public.order_status_pings set bumped_at = now() where location_id = v_loc;
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;
-- CREATE OR REPLACE TRIGGER (Postgres 14+, live is 17): a SHARE ROW EXCLUSIVE lock, so readers
-- of order_queue (Orders Hub, reports, realtime) never wait on this script. DROP TRIGGER would
-- take ACCESS EXCLUSIVE and hold it to the end of the transaction.
create or replace trigger order_status_marks_trg after insert or update of status or delete on public.order_queue
  for each row execute function public.tg_order_status_marks();

create or replace function public.tg_order_status_displays_ping() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc text;
begin
  begin
    if tg_op = 'DELETE' then v_loc := old.location_id::text; else v_loc := new.location_id::text; end if;
    -- Seed the venue's ping row only when it is missing. A plain select never waits, but
    -- INSERT ... ON CONFLICT DO NOTHING does wait on a row an open order write has updated,
    -- so the insert only runs for a venue with no row yet. Then bump it unless an order
    -- write holds it, in which case that write's own bump nudges the TVs.
    if not exists (select 1 from public.order_status_pings p0 where p0.location_id = v_loc) then
      insert into public.order_status_pings (location_id, bumped_at) values (v_loc, now())
        on conflict (location_id) do nothing;
    end if;
    perform 1 from public.order_status_pings p where p.location_id = v_loc for update skip locked;
    if found then
      update public.order_status_pings set bumped_at = now() where location_id = v_loc;
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;
drop trigger if exists order_status_displays_ping on public.order_status_displays;
create trigger order_status_displays_ping after insert or update or delete on public.order_status_displays
  for each row execute function public.tg_order_status_displays_ping();

-- 7. Pairing ------------------------------------------------------------------------------
create or replace function public.claim_order_status_screen(p_code text, p_display_id uuid)
returns public.menu_board_screens
language plpgsql security definer set search_path = public as $$
declare d record; s record;
begin
  if auth.uid() is null or public.is_anon_session() then raise exception 'Sign in to Back Office to pair a screen'; end if;
  select id, location_id, org_id into d from public.order_status_displays where id = p_display_id;
  if d.id is null then raise exception 'Order screen not found'; end if;
  if not public._osd_user_has_location(d.location_id) then raise exception 'No access to this venue'; end if;
  select * into s from public.menu_board_screens where lower(code) = lower(btrim(p_code)) limit 1;
  if s.id is null then raise exception 'Pairing code not found'; end if;
  if s.location_id is not null and not public._osd_user_has_location(s.location_id)
    then raise exception 'Screen belongs to another venue'; end if;
  if coalesce(s.last_seen_at, s.created_at) < now() - interval '30 minutes'
    then raise exception 'Pairing code expired. Restart the screen to get a new code.'; end if;
  update public.menu_board_screens
     set order_display_id = d.id, board_id = null, location_id = d.location_id, org_id = d.org_id,
         status = 'paired', paired_at = now(), updated_at = now()
   where id = s.id;
  select * into s from public.menu_board_screens where id = s.id;
  return s;
end $$;

create or replace function public.set_order_status_screen(p_screen_id uuid, p_display_id uuid)
returns public.menu_board_screens
language plpgsql security definer set search_path = public as $$
declare d record; s record;
begin
  if auth.uid() is null or public.is_anon_session() then raise exception 'Sign in to Back Office to change a screen'; end if;
  select * into s from public.menu_board_screens where id = p_screen_id;
  if s.id is null then raise exception 'Screen not found'; end if;
  if not public._osd_user_has_location(s.location_id) then raise exception 'No access to this screen'; end if;
  if p_display_id is null then
    -- Unpair clears both, like set_menu_board_screen(null), so a row never says unpaired
    -- while its TV still shows a menu board.
    update public.menu_board_screens
       set order_display_id = null, board_id = null, status = 'unpaired', paired_at = null, updated_at = now()
     where id = s.id;
  else
    select id, location_id, org_id into d from public.order_status_displays where id = p_display_id;
    if d.id is null then raise exception 'Order screen not found'; end if;
    if d.location_id is distinct from s.location_id then raise exception 'That order screen is at a different venue'; end if;
    update public.menu_board_screens
       set order_display_id = d.id, board_id = null, org_id = d.org_id,
           status = 'paired', paired_at = now(), updated_at = now()
     where id = s.id;
  end if;
  select * into s from public.menu_board_screens where id = s.id;
  return s;
end $$;

-- Same signatures and behaviour as 20260614 and 20260614b, plus: assigning a board clears order_display_id.
-- Error texts are byte for byte the live ones (Menu boards shows them raw). The expired text
-- carries an em dash, built from its UTF8 bytes so this file stays free of dash characters
-- (convert_from, not chr(8212), which errors on a database that is not UTF8).
create or replace function public.claim_menu_board_screen(p_code text, p_board_id uuid)
returns public.menu_board_screens
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
  if coalesce(s.last_seen_at, s.created_at) < now() - interval '30 minutes'
    then raise exception '%', 'pairing code expired ' || convert_from('\xe28094'::bytea, 'UTF8') || ' restart the screen to get a new code'; end if;
  update menu_board_screens
     set board_id = b.id, order_display_id = null, location_id = b.location_id, org_id = b.org_id,
         status = 'paired', paired_at = now(), updated_at = now()
   where id = s.id;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $$;

create or replace function public.set_menu_board_screen(p_screen_id uuid, p_board_id uuid)
returns public.menu_board_screens
language plpgsql security definer set search_path = public as $$
declare b record; s record;
begin
  select * into s from menu_board_screens where id = p_screen_id;
  if s.id is null then raise exception 'screen not found'; end if;
  if not _mb_user_has_location(s.location_id) then raise exception 'no access to this screen'; end if;
  if p_board_id is null then
    update menu_board_screens set board_id = null, order_display_id = null, status = 'unpaired', paired_at = null, updated_at = now()
     where id = s.id;
  else
    select id, location_id, org_id into b from menu_boards where id = p_board_id;
    if b.id is null then raise exception 'board not found'; end if;
    if b.location_id is distinct from s.location_id then raise exception 'board is at a different location'; end if;
    update menu_board_screens set board_id = b.id, order_display_id = null, org_id = b.org_id, status = 'paired', paired_at = now(), updated_at = now()
     where id = s.id;
  end if;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $$;

-- 8. Feed -------------------------------------------------------------------------------------
create or replace function public.order_status_feed(p_screen_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  s record;
  d record;
  v_venue record;
  v_loc text;
  v_linger integer;
  v_max_age integer;
  v_unaccepted boolean;
  v_names boolean;
  v_rows jsonb;
  v_count integer;
begin
  if v_uid is null then
    return jsonb_build_object('paired', false, 'reason', 'no_session', 'server_now', v_now);
  end if;
  select ms.id, ms.location_id, ms.order_display_id, ms.status into s
    from public.menu_board_screens ms
   where ms.id = p_screen_id and ms.device_uid = v_uid;
  if s.id is null then
    return jsonb_build_object('paired', false, 'reason', 'no_screen', 'server_now', v_now);
  end if;
  if s.status is distinct from 'paired' or s.order_display_id is null or s.location_id is null then
    return jsonb_build_object('paired', false, 'reason', 'not_assigned', 'server_now', v_now);
  end if;
  select * into d from public.order_status_displays od
   where od.id = s.order_display_id and od.location_id = s.location_id;
  if d.id is null then
    return jsonb_build_object('paired', false, 'reason', 'not_assigned', 'server_now', v_now);
  end if;

  select l.name, l.timezone into v_venue from public.locations l where l.id = s.location_id;
  v_loc := s.location_id::text;
  v_linger := public._osd_int(d.settings->>'lingerMinutes', 2, 0, 30);
  v_max_age := public._osd_int(d.settings->>'maxAgeHours', 6, 1, 24);
  v_unaccepted := coalesce(d.settings->>'showUnacceptedPlatform', 'false') = 'true';
  v_names := coalesce(public.order_status_names_enabled(), false);

  if not d.is_active then
    v_rows := '[]'::jsonb; v_count := 0;
  else
    with sec as (
      select (e.ord - 1)::int as idx, e.val as sec
        from jsonb_array_elements(d.sections) with ordinality as e(val, ord)
       where e.ord <= 4 and jsonb_typeof(e.val) = 'object'
    ),
    src as (
      select q.ref, q.source, q.type, q.status, q.sent_at, q.created_at,
             jsonb_build_object('name', q.customer->>'name', 'channel', q.customer->>'channel',
                                'collectionCode', q.customer->>'collectionCode',
                                'ezcater_order_number', q.customer->>'ezcater_order_number') as cust,
             m.status_changed_at, m.first_seen_at, null::timestamptz as departed_at, false as departed
        from public.order_queue q
        left join public.order_status_marks m on m.location_id = q.location_id and m.ref = q.ref
       where q.location_id = v_loc
         and q.status in ('received','scheduled','prep','ready','collected')
      union all
      select m.ref, m.source, m.type, m.departed_from, null::timestamptz, null::timestamptz,
             coalesce(m.snapshot, '{}'::jsonb), m.status_changed_at, m.first_seen_at, m.departed_at, true
        from public.order_status_marks m
       where m.location_id = v_loc
         and v_linger > 0
         and m.departed_at is not null
         and m.departed_at > v_now - make_interval(mins => v_linger)
         and m.departed_from in ('ready','collected')
         and not exists (select 1 from public.order_queue q2 where q2.location_id = v_loc and q2.ref = m.ref)
    ),
    enriched as (
      select x.*,
             public._osd_channel_key(x.source, x.cust->>'channel') as ch,
             public._osd_type_key(x.type) as tk,
             c.dispatch_backend as courier_backend, c.status as courier_status,
             c.picked_at as courier_picked_at, c.updated_at as courier_updated_at,
             h.hr_status, h.updated_at as hr_updated_at
        from src x
        left join lateral (
          select cd.dispatch_backend, cd.status, cd.picked_at, cd.updated_at
            from public.courier_deliveries cd
           where cd.location_id = v_loc and cd.order_ref = x.ref
             and cd.status not in ('canceled','returned','failed')
           order by cd.created_at desc
           limit 1
        ) c on true
        left join public.hubrise_order_links h
          on x.source = 'hubrise' and h.ref = x.ref and h.location_id = v_loc
    ),
    placed as (
      select e.*, s1.idx as sec_idx, s1.sec as sec
        from enriched e
        left join lateral (
          select sec.idx, sec.sec from sec
           where e.ch is not null and e.tk is not null
             and coalesce(sec.sec->'channels', '[]'::jsonb) ? e.ch
             and coalesce(sec.sec->'orderTypes', '[]'::jsonb) ? e.tk
           order by sec.idx
           limit 1
        ) s1 on true
    ),
    judged as (
      select p.*,
        case
          -- A deleted row lingers from its EARLIEST collection signal, so an order a courier
          -- or the platform already finished never comes back when staff clear it later.
          when p.departed then least(
            p.departed_at,
            case when p.courier_backend is not null and (p.courier_picked_at is not null or p.courier_status in ('dropoff','delivered'))
                 then coalesce(p.courier_picked_at, p.courier_updated_at) end,
            case when p.hr_status = 'completed' then p.hr_updated_at end)
          when p.status = 'collected' then p.status_changed_at
          when p.courier_backend is not null and (p.courier_picked_at is not null or p.courier_status in ('dropoff','delivered'))
            then coalesce(p.courier_picked_at, p.courier_updated_at)
          when p.hr_status = 'completed' then p.hr_updated_at
          else null
        end as collected_at
      from placed p
    ),
    bucketed as (
      select j.*,
        case
          when j.collected_at is not null then 'collected'
          when j.departed or j.status = 'collected' then null
          when j.status in ('received','scheduled') then
            case when j.source in ('hubrise','ezcater') and not v_unaccepted then null else 'received' end
          when j.status = 'prep' then 'preparing'
          when j.status = 'ready' then 'ready'
          else null
        end as bucket
      from judged j
    ),
    visible as (
      select b.* from bucketed b
       where b.sec_idx is not null
         and b.bucket is not null
         and (
           (b.bucket = 'collected' and v_linger > 0 and b.collected_at > v_now - make_interval(mins => v_linger))
           or
           (b.bucket <> 'collected'
            -- A till pre order waits as scheduled with no fire time. It shows once the till fires it.
            and not (b.status = 'scheduled' and b.sent_at is null)
            and (b.sent_at is null
                 or b.sent_at <= v_now + case when b.source = 'ezcater' then interval '60 minutes' else interval '0 minutes' end)
            and coalesce(case when b.sent_at is not null then least(b.sent_at, v_now) end, b.created_at, v_now)
                >= v_now - make_interval(hours => v_max_age)
            and coalesce(b.sec->'statuses', '[]'::jsonb) ? b.bucket)
         )
    ),
    ranked as (
      select v.*,
             case v.bucket when 'ready' then 0 when 'preparing' then 1 when 'received' then 2 else 3 end as rnk,
             coalesce(v.status_changed_at, v.sent_at, v.created_at, v_now) as since_at,
             public._osd_number(v.ref, v.source, v.cust, v.courier_backend) as num_base,
             count(*) over () as total_rows
        from visible v
    ),
    limited as (
      select r.*,
             row_number() over (order by r.sec_idx, r.rnk, r.since_at, r.ref) as rn,
             -- Two rows in one section with the same 3 character online, catering or QR code
             -- would look identical, so those rows show 4 characters instead.
             case when r.ref ~ '^(OL|CA|QR)-' and count(*) over (partition by r.sec_idx, r.num_base) > 1
                  then right(r.ref, 4) else r.num_base end as num
        from ranked r
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'key', left(md5(v_loc || ':' || l.ref), 12),
             'section_id', l.sec->>'id',
             'section_index', l.sec_idx,
             'bucket', l.bucket,
             'number', l.num,
             -- No names at all while order_queue is open to any writer (see NAMES at the top).
             -- Customer typed names (kiosk, online, QR, catering) then show only after a status
             -- change made in a separate request. That alone does NOT stop an attacker while
             -- anyone can update order_queue; only the fence does, which is why v_names gates it.
             'name', case
               when not v_names then null
               when l.source in ('kiosk','online','qr','catering')
                and not coalesce(l.status_changed_at > l.first_seen_at, false) then null
               else public._osd_name(l.cust->>'name', l.sec->>'nameFormat')
             end,
             'channel', l.ch,
             'channel_name', case when l.ch = 'other_app' then left(nullif(btrim(l.cust->>'channel'), ''), 20) end,
             'courier', l.courier_backend,
             'order_type', l.tk,
             'since', l.since_at,
             'expires_at', case when l.bucket = 'collected' then l.collected_at + make_interval(mins => v_linger) end
           ) order by l.rn), '[]'::jsonb),
           coalesce(max(l.total_rows), 0)
      into v_rows, v_count
      from limited l
     where l.rn <= 200;
  end if;

  return jsonb_build_object(
    'paired', true, 'active', d.is_active, 'server_now', v_now, 'location_key', v_loc,
    'names_enabled', v_names,
    -- timezone here is the LEGACY ops column. The TV prefers the platform venue zone
    -- (fetchVenueTimezone) and uses this only as a last resort.
    'venue', jsonb_build_object('name', v_venue.name, 'timezone', v_venue.timezone),
    'display', jsonb_build_object('id', d.id, 'version', d.version, 'name', d.name,
       'orientation', d.orientation, 'rotate', d.rotate, 'sections', d.sections,
       'labels', d.labels, 'settings', d.settings, 'theme', d.theme),
    'rows', v_rows, 'truncated', v_count > 200);
end $$;

-- 9. Grants (default privileges hand EXECUTE to anon, so name anon every time) ----------------
revoke all on function public._osd_user_has_location(uuid) from public, anon;
grant execute on function public._osd_user_has_location(uuid) to authenticated;
revoke all on function public._osd_caller_locations() from public, anon;
grant execute on function public._osd_caller_locations() to authenticated;
revoke all on function public._osd_int(text, integer, integer, integer) from public, anon;
revoke all on function public._osd_type_key(text) from public, anon;
revoke all on function public._osd_channel_key(text, text) from public, anon;
revoke all on function public._osd_name(text, text) from public, anon;
revoke all on function public._osd_number(text, text, jsonb, text) from public, anon;
revoke all on function public.tg_order_status_marks() from public, anon, authenticated;
revoke all on function public.tg_order_status_displays_ping() from public, anon, authenticated;
revoke all on function public.tg_order_status_displays_touch() from public, anon, authenticated;
revoke all on function public.claim_order_status_screen(text, uuid) from public, anon;
grant execute on function public.claim_order_status_screen(text, uuid) to authenticated;
revoke all on function public.set_order_status_screen(uuid, uuid) from public, anon;
grant execute on function public.set_order_status_screen(uuid, uuid) to authenticated;
revoke all on function public.order_status_feed(uuid) from public, anon;
grant execute on function public.order_status_feed(uuid) to authenticated;
revoke all on function public.order_status_names_enabled() from public, anon;
grant execute on function public.order_status_names_enabled() to authenticated;

-- 9b. Order screen logos ------------------------------------------------------------------------
-- Logos upload to receipt-assets at locations/<venue>/orderscreen/<file>. That bucket's live
-- policies (r1 to r4) only check auth.role() = 'authenticated', which every anonymous sign in
-- (kiosk, TV, online) also has, so any of them could overwrite a logo shown on a customer
-- facing TV. These RESTRICTIVE policies narrow writes under that one folder to signed in Back
-- Office users of that venue. Every other bucket and path passes the first two tests, so
-- nothing else changes. Only role authenticated: role anon cannot write receipt-assets at all.
do $$ begin
  execute 'drop policy if exists osd_logo_insert_fence on storage.objects';
  execute 'drop policy if exists osd_logo_update_fence on storage.objects';
  execute 'drop policy if exists osd_logo_delete_fence on storage.objects';
  execute $p$create policy osd_logo_insert_fence on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'receipt-assets' or name not like 'locations/%/orderscreen/%'
      or (not public.is_anon_session()
          and (split_part(name, '/', 2) in (select public.user_accessible_locations()) or public.is_super_admin())))$p$;
  execute $p$create policy osd_logo_update_fence on storage.objects as restrictive for update to authenticated
    using (bucket_id is distinct from 'receipt-assets' or name not like 'locations/%/orderscreen/%'
      or (not public.is_anon_session()
          and (split_part(name, '/', 2) in (select public.user_accessible_locations()) or public.is_super_admin())))
    with check (bucket_id is distinct from 'receipt-assets' or name not like 'locations/%/orderscreen/%'
      or (not public.is_anon_session()
          and (split_part(name, '/', 2) in (select public.user_accessible_locations()) or public.is_super_admin())))$p$;
  execute $p$create policy osd_logo_delete_fence on storage.objects as restrictive for delete to authenticated
    using (bucket_id is distinct from 'receipt-assets' or name not like 'locations/%/orderscreen/%'
      or (not public.is_anon_session()
          and (split_part(name, '/', 2) in (select public.user_accessible_locations()) or public.is_super_admin())))$p$;
exception when insufficient_privilege or undefined_table or invalid_schema_name then
  raise warning 'Order screen logo protection was NOT added (%). Add the three osd_logo policies on storage.objects from the dashboard.', sqlerrm;
end $$;

-- 10. Backfill marks for rows already in the queue ------------------------------------------------
-- status_changed_at = first_seen_at, so an existing kiosk, online, QR or catering row keeps its
-- name hidden until a real status change fires the trigger. updated_at is not a status change
-- (a paid flag or trg_order_queue_updated_at moves it too).
insert into public.order_status_marks (location_id, ref, status, status_changed_at, ready_at, source, type, first_seen_at, updated_at)
select q.location_id, q.ref, q.status, coalesce(q.created_at, now()),
       case when q.status = 'ready' then coalesce(q.updated_at, now()) end, q.source, q.type,
       coalesce(q.created_at, now()), now()
  from public.order_queue q
on conflict (location_id, ref) do nothing;

-- One ping row per venue, so the order_queue trigger only ever updates (never inserts) it.
insert into public.order_status_pings (location_id, bumped_at)
select l.id::text, now() from public.locations l
on conflict (location_id) do nothing;

notify pgrst, 'reload schema';

-- Checks after running:
--   select tgname from pg_trigger where tgrelid = 'public.order_queue'::regclass and not tgisinternal;
--   select polname from pg_policy where polrelid = 'storage.objects'::regclass and polname like 'osd_logo%';   (3 rows)
--   select public.order_status_names_enabled();   (false until the 20260907b order_queue fence is applied)
--   select count(*) from public.order_status_marks;
--   select pubname, tablename from pg_publication_tables where tablename = 'order_status_pings';
