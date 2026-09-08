-- ═══════════════════════════════════════════════════════════════════════════
-- Stripe Connect — payment device registry (v4)
-- Run on: yhzjgyrkyjabvhblqxzu (RPOS Platform)
--
-- Two reader categories:
--   1. Bluetooth readers (Stripe Reader M2): physically tied to ONE POS device
--      via Bluetooth pairing. Pairing happens at the POS terminal itself
--      (Status drawer). Persistence is in the POS device's localStorage —
--      no DB row needed; we only need to know "this POS has a reader paired"
--      for status visibility, which is reflected via pos_device_reader_link.
--
--   2. Network readers (S700, WisePOS E in WiFi mode): registered centrally
--      in the BO at the location level. Multiple POS terminals at that
--      location can connect to the same network reader. Registration uses
--      Stripe's pairing-code flow (sticker on the back of the device).
--
-- Both kinds expose a Stripe `reader.id` (rdr_…) once registered with the
-- connected account.
-- ═══════════════════════════════════════════════════════════════════════════

-- Master table: every payment-accepting reader we know about, of any kind.
create table if not exists payment_devices (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  -- Stripe identifiers
  stripe_reader_id text not null unique,                            -- rdr_…
  stripe_account_id text not null,                                  -- the connected account
  -- Reader characteristics
  device_type text not null,                                        -- 'bbpos_chipper2x','stripe_m2','verifone_p400','wisepos_e','etap_to_pay',…
  connection_kind text not null check (connection_kind in ('bluetooth','network','tap_to_pay')),
  serial_number text,
  label text,
  -- For network readers — pairing was done with this code (audit only)
  registration_code text,
  -- Bluetooth-only: which POS device owns this reader (null for network)
  bound_pos_device_id text,
  -- Status snapshot — updated by the bridge / by polling Stripe
  status text default 'unknown',                                    -- 'online','offline','needs_update','unknown'
  battery_level numeric(5,2),
  last_seen_at timestamptz,
  -- Audit
  created_at timestamptz not null default now(),
  registered_by_user_id uuid references platform_users(id),
  notes text
);

create index if not exists payment_devices_location_idx on payment_devices(location_id);
create index if not exists payment_devices_pos_device_idx on payment_devices(bound_pos_device_id) where bound_pos_device_id is not null;

comment on table  payment_devices is 'All Stripe Terminal readers registered to a location. Bluetooth readers are bound to a single POS device; network readers serve all POS at the location.';
comment on column payment_devices.bound_pos_device_id is 'Set for Bluetooth readers — the rpos-device.id of the POS that paired the reader. Null for network/tap-to-pay readers.';

alter table payment_devices enable row level security;

-- Permissive read for the admin BO + POS status drawer (anon client uses these)
drop policy if exists pd_read_all on payment_devices;
create policy pd_read_all on payment_devices for select to anon, authenticated using (true);

-- Writes go through the new register/unregister edge functions (service role).

-- Verification
select 'payment_devices_table' as check_kind, count(*)::text as result
  from information_schema.tables where table_schema='public' and table_name='payment_devices'
union all
select 'payment_devices_columns',
       count(*)::text from information_schema.columns
 where table_schema='public' and table_name='payment_devices';
