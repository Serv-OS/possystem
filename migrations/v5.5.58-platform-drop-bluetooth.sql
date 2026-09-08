-- v5.5.58 — WiFi-only payment terminals
-- Platform DB: yhzjgyrkyjabvhblqxzu
-- Drops Bluetooth reader rows and any BT-specific RLS policy. Network reader
-- support is unchanged. Run this in the Platform DB SQL editor.

-- Remove Bluetooth-tier rows
delete from payment_devices where connection_kind = 'bluetooth';

-- Drop any BT-specific anon-insert policy that may have been added out-of-band.
-- (Names guessed from prior conversations — drop is no-op if they don't exist.)
drop policy if exists pd_anon_bt_insert on payment_devices;
drop policy if exists pd_bt_insert     on payment_devices;
drop policy if exists pd_insert_bt     on payment_devices;

-- Tighten the connection_kind check to remove the bluetooth option.
-- (Existing rows have already been deleted above so the constraint will hold.)
alter table payment_devices drop constraint if exists payment_devices_connection_kind_check;
alter table payment_devices add  constraint payment_devices_connection_kind_check
  check (connection_kind in ('network','tap_to_pay'));
