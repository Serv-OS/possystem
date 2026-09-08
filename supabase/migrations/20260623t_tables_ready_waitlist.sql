-- 20260623t_tables_ready_waitlist.sql
-- Tables Ready — walk-in waitlist / live table-queue (Ops DB).
-- SECURE by design: every table is location-scoped via waitlist_can_write() = BO access OR a
-- claimed waitlist device (the Operations pattern), NOT the order_queue "allow all" gap. The
-- host stand is an anonymous paired tablet; PINs stay server-side (waitlist_pin_login).
-- Reuses existing customers / floor_tables / sms_messages — links, never duplicates them.
-- Reversible + additive only: create-if-not-exists / add-column-if-not-exists / create-or-replace.

-- ── generic updated_at touch (idempotent) ─────────────────────────────────────
create or replace function public.wl_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ── paired host-stand devices (clone of ops_devices) ──────────────────────────
create table if not exists public.waitlist_devices (
  id           uuid primary key default gen_random_uuid(),
  device_uid   uuid not null default auth.uid(),
  name         text,
  claim_code   text,
  location_id  uuid references public.locations(id),
  org_id       uuid,
  active       boolean not null default true,
  claimed_at   timestamptz,
  last_seen_at timestamptz default now(),
  created_at   timestamptz not null default now()
);
create index if not exists waitlist_devices_uid_idx on public.waitlist_devices (device_uid);
create unique index if not exists waitlist_devices_code_idx on public.waitlist_devices (claim_code) where claim_code is not null;

-- ── per-venue config (estimator rules + bands + zones); code holds defaults ────
create table if not exists public.waitlist_config (
  location_id   uuid primary key references public.locations(id),
  org_id        uuid,
  buffer_min     int not null default 5,
  round_to       int not null default 5,
  max_quote      int not null default 120,
  default_turn   int not null default 60,
  bands          jsonb,   -- [{label,min,max,turn}] — null = use code defaults
  zones          jsonb,   -- [{id,name,color,seat_capacity}] for capacity-only fallback
  sms_enabled    boolean not null default true,
  sms_templates  jsonb,   -- {join,next,ready} editable bodies w/ merge tags {name}{venue}{size}{quote}{position}; null = code defaults
  updated_at     timestamptz not null default now()
);
drop trigger if exists wl_config_touch on public.waitlist_config;
create trigger wl_config_touch before update on public.waitlist_config
  for each row execute function public.wl_touch_updated_at();

-- ── the live queue (links to customers + floor_tables; never duplicates them) ──
create table if not exists public.waitlist_entries (
  id              text primary key,                 -- app-generated 'wl-<ts>'
  location_id     uuid not null references public.locations(id),
  org_id          uuid,
  customer_id     uuid references public.customers(id),  -- CRM link (nullable)
  customer        jsonb,                                  -- linkage snapshot, like order_queue.customer
  party_name      text not null default 'Guest',
  phone           text,                                   -- E.164 (normalisePhone)
  party_size      int not null default 1,
  quoted_wait_min int,
  first_quote_min int,                                    -- quote at join, for accuracy/learning
  quoted_at       timestamptz,
  status          text not null default 'waiting',        -- waiting|notified|ready|seated|completed|no_show|walked_away|cancelled|removed
  section_pref    text,                                   -- soft ref to a zone/section id
  notes           text,
  seated_table_id text,                                   -- soft ref to floor_tables.id
  source          text not null default 'host',           -- host|self
  added_at        timestamptz not null default now(),
  notified_at     timestamptz,
  ready_at        timestamptz,
  seated_at       timestamptz,
  completed_at    timestamptz,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists waitlist_entries_loc_idx on public.waitlist_entries (location_id);
create index if not exists waitlist_entries_loc_status_idx on public.waitlist_entries (location_id, status);
alter table public.waitlist_entries replica identity full;
drop trigger if exists wl_entries_touch on public.waitlist_entries;
create trigger wl_entries_touch before update on public.waitlist_entries
  for each row execute function public.wl_touch_updated_at();

-- ── append-only lifecycle ledger (audit + accuracy source) ────────────────────
create table if not exists public.waitlist_status_events (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations(id),
  waitlist_entry_id text not null,
  from_status       text,
  to_status         text not null,
  actor             text,
  at                timestamptz not null default now()
);
create index if not exists waitlist_events_entry_idx on public.waitlist_status_events (waitlist_entry_id);

-- ── learned turn-time model (seeded once closed_checks.seated_at flows) ────────
create table if not exists public.turn_time_stats (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id),
  section_id   text,
  party_band   text not null,        -- '1-2' | '3-4' | '5-6' | '7+'
  avg_turn_min numeric,
  sample_count int not null default 0,
  daypart      text,
  window_start timestamptz,
  window_end   timestamptz,
  updated_at   timestamptz not null default now()
);
create index if not exists turn_time_stats_loc_idx on public.turn_time_stats (location_id, party_band);

-- ── quoted vs actual (closes the learning loop; powers Insights accuracy) ──────
create table if not exists public.quote_accuracy (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations(id),
  waitlist_entry_id text not null,
  party_band        text,
  quoted_wait_min   int,
  actual_wait_min   int,
  recorded_at       timestamptz not null default now()
);
create index if not exists quote_accuracy_loc_idx on public.quote_accuracy (location_id);

-- ── additive: record when a check was seated so turn time (seat->close) exists ─
-- Highest-leverage line in the build: without it there is ZERO historical dwell data
-- and the estimator can never learn. Written at close by db.insertClosedCheck.
alter table public.closed_checks add column if not exists seated_at timestamptz;

-- ── authorisation helper: BO access OR a claimed waitlist device ───────────────
create or replace function public.waitlist_can_write(p_location_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (p_location_id::text in (select user_accessible_locations()))
      or exists (select 1 from waitlist_devices d
                 where d.device_uid = auth.uid() and d.location_id = p_location_id and d.active);
$$;

-- ── paired-tablet lifecycle (cloned from the Operations RPCs) ─────────────────
create or replace function public.register_waitlist_device(p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v waitlist_devices; v_code text;
begin
  select * into v from waitlist_devices where device_uid = auth.uid() limit 1;
  if found then return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id); end if;
  -- gen_random_uuid() is core pg; gen_random_bytes (pgcrypto) is NOT on this search_path.
  -- 8 hex chars (~32-bit) + the 30-min claim TTL below makes brute-forcing a code infeasible
  -- (mirrors the menu-board hardening; do NOT shrink this back to 6).
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into waitlist_devices (device_uid, name, claim_code, last_seen_at)
    values (auth.uid(), coalesce(p_name, 'Host stand'), v_code, now()) returning * into v;
  return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id);
end $$;

create or replace function public.claim_waitlist_device(p_code text, p_location_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v waitlist_devices; v_org uuid;
begin
  if not (p_location_id::text in (select user_accessible_locations())) then
    raise exception 'not authorized for this location';
  end if;
  select org_id into v_org from locations where id = p_location_id;
  -- 30-min TTL: an unclaimed code only works while the stand is alive (it heartbeats every few
  -- seconds on the pair screen). Prevents brute-force / stale-code binding (menu-board precedent).
  update waitlist_devices set location_id = p_location_id, org_id = v_org, claimed_at = now()
    where claim_code = p_code and (location_id is null or location_id = p_location_id)
      and coalesce(last_seen_at, created_at) > now() - interval '30 minutes' returning * into v;
  if not found then raise exception 'code not found or expired'; end if;
  return jsonb_build_object('id', v.id, 'location_id', v.location_id);
end $$;

create or replace function public.waitlist_device_heartbeat()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v waitlist_devices;
begin
  update waitlist_devices set last_seen_at = now() where device_uid = auth.uid() returning * into v;
  if not found then return jsonb_build_object('claimed', false); end if;
  return jsonb_build_object('claimed', v.location_id is not null, 'location_id', v.location_id, 'name', v.name);
end $$;

-- staff PIN -> identity (PIN never reaches the client); fenced to the claimed location.
create or replace function public.waitlist_pin_login(p_location_id uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if not public.waitlist_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select id, name, role, permissions into v from staff_members
    where location_id = p_location_id and pin = p_pin and coalesce(active, true) = true limit 1;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'name', v.name, 'role', v.role, 'permissions', v.permissions);
end $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.waitlist_devices       enable row level security;
alter table public.waitlist_config        enable row level security;
alter table public.waitlist_entries       enable row level security;
alter table public.waitlist_status_events enable row level security;
alter table public.turn_time_stats        enable row level security;
alter table public.quote_accuracy         enable row level security;

-- devices: a device sees only its own row; BO sees its venues' rows. All writes go via the
-- SECURITY DEFINER RPCs above, so direct writes are closed (insert/update through RPC only).
drop policy if exists waitlist_devices_sel on public.waitlist_devices;
create policy waitlist_devices_sel on public.waitlist_devices for select using (
  device_uid = auth.uid() or (location_id::text in (select user_accessible_locations()))
);

-- entries / events / stats / accuracy / config: read+write for BO OR the claimed device.
drop policy if exists waitlist_entries_rw on public.waitlist_entries;
create policy waitlist_entries_rw on public.waitlist_entries
  using (public.waitlist_can_write(location_id)) with check (public.waitlist_can_write(location_id));

drop policy if exists waitlist_events_rw on public.waitlist_status_events;
create policy waitlist_events_rw on public.waitlist_status_events
  using (public.waitlist_can_write(location_id)) with check (public.waitlist_can_write(location_id));

drop policy if exists turn_time_stats_rw on public.turn_time_stats;
create policy turn_time_stats_rw on public.turn_time_stats
  using (public.waitlist_can_write(location_id)) with check (public.waitlist_can_write(location_id));

drop policy if exists quote_accuracy_rw on public.quote_accuracy;
create policy quote_accuracy_rw on public.quote_accuracy
  using (public.waitlist_can_write(location_id)) with check (public.waitlist_can_write(location_id));

drop policy if exists waitlist_config_rw on public.waitlist_config;
create policy waitlist_config_rw on public.waitlist_config
  using (public.waitlist_can_write(location_id)) with check (public.waitlist_can_write(location_id));

-- ── realtime: the live board listens on waitlist_entries across devices ────────
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'waitlist_entries') then
    alter publication supabase_realtime add table public.waitlist_entries;
  end if;
end $$;

-- ── grants (anon + authenticated paired devices call the RPCs) ─────────────────
grant execute on function public.register_waitlist_device(text)        to anon, authenticated;
grant execute on function public.claim_waitlist_device(text, uuid)     to anon, authenticated;
grant execute on function public.waitlist_device_heartbeat()           to anon, authenticated;
grant execute on function public.waitlist_pin_login(uuid, text)        to anon, authenticated;
grant execute on function public.waitlist_can_write(uuid)              to anon, authenticated;
