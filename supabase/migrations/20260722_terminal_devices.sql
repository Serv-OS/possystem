-- ─────────────────────────────────────────────────────────────────────────────
-- 20260722_terminal_devices.sql   (OPS DB)
--
-- PaxPay: a PAX A920 Pro card terminal running our own Android app (:paxpay).
-- One row per physical terminal. The terminal self-registers an UNPAIRED row
-- carrying a high-entropy claim code shown on its screen; a manager types that
-- code into Back Office → Card readers to bind it to one venue.
--
-- Spec: docs/PAXPAY_TRANSPORT_SPEC.md § "The data model".
-- Precedent: menu_board_screens (20260614*) — same tight pairing model.
--
-- SECURITY MODEL (this is a PAYMENTS table — read this before changing anything)
--
--   * device_uid is DB-stamped (default auth.uid()). It is NEVER client-supplied.
--   * NO INSERT POLICY. Every anonymous kiosk / QR diner / online-ordering session
--     on the open internet holds a valid auth.uid(). An INSERT policy on this table
--     would therefore be unbounded PUBLIC WRITE ACCESS to a payments table.
--     Registration goes through register_terminal_device() only (20260722c).
--   * NO UPDATE POLICY. Every mutation is a SECURITY DEFINER RPC that re-derives
--     the caller's terminal from auth.uid() and re-resolves location_id server-side.
--   * SELECT is fenced so a terminal reads ONLY the row it owns — claim codes are
--     never enumerable across tenants. Back Office reads only its own locations.
--   * location_id is only ever written by claim_terminal_device(), taken from the
--     manager's validated location — never from the device. ("Always resolve the
--     real locationId before any DB write" — INVARIANTS.md.)
--
-- DO NOT add an INSERT or UPDATE policy to this table.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists terminal_devices (
  id                  uuid primary key default gen_random_uuid(),
  device_uid          uuid not null default auth.uid(),  -- DB-stamped, never client-set
  serial_number       text not null,                     -- STABLE identity: survives reinstall
  location_id         uuid,                              -- NULL until a manager claims it
  org_id              uuid,
  claim_code          text,
  label               text,
  ryft_terminal_id    text,                              -- soft link -> Platform payment_devices
  bound_pos_device_id uuid,
  tip_config          jsonb,                             -- cache only; the job row is authoritative
  status              text not null default 'unpaired',  -- unpaired | paired | retired
  active              boolean not null default true,
  app_version         text,
  -- PIN throttle for terminal_staff_login(). A 4-digit PIN behind an anonymous
  -- bearer token on a device carried round a venue is brute-forceable in seconds
  -- without this. Counters are only ever written by the SECURITY DEFINER RPC.
  pin_fail_count      integer not null default 0,
  pin_locked_until    timestamptz,
  last_seen_at        timestamptz,
  claimed_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- A claim code is a capability read off the physical screen — it must be unique
-- while live, and it is cleared on claim so it cannot be replayed.
create unique index if not exists idx_td_code   on terminal_devices (lower(claim_code)) where claim_code is not null;
-- One PAIRED row per serial. Unpaired rows may collide (a reinstalled terminal
-- registers a fresh pending row alongside the old paired one — see 20260722c).
create unique index if not exists idx_td_serial on terminal_devices (serial_number)     where status = 'paired';
create unique index if not exists idx_td_ryft   on terminal_devices (ryft_terminal_id)  where status = 'paired';
-- RLS filters on device_uid; without this index every policy check is a seq scan.
create        index if not exists idx_td_uid    on terminal_devices (device_uid);
create        index if not exists idx_td_loc    on terminal_devices (location_id);

alter table terminal_devices enable row level security;

-- SELECT — a terminal reads ONLY the row it owns, so pairing codes are never
-- enumerable across tenants. Back Office reads only its own locations.
drop policy if exists td_select on terminal_devices;
create policy td_select on terminal_devices for select using (
  device_uid = auth.uid()
  or location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- NO INSERT POLICY — see the header. Registration is register_terminal_device() only.
-- NO UPDATE POLICY — every mutation is a SECURITY DEFINER RPC in 20260722c.

-- DELETE — retiring a terminal is a Back Office act, scoped to the manager's own
-- locations. `to authenticated` keeps anonymous device sessions out entirely.
drop policy if exists td_delete on terminal_devices;
create policy td_delete on terminal_devices for delete to authenticated using (
  location_id in (select location_id from user_locations where user_id = auth.uid())
  or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
);

-- Realtime: Back Office watches pairing/heartbeat state live.
alter table terminal_devices replica identity full;
do $$ begin alter publication supabase_realtime add table terminal_devices;
exception when duplicate_object then null; end $$;
