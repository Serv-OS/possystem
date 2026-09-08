-- v5.5.645 — per-device Training Mode.
-- A terminal whose device profile has training_mode = true runs the POS normally
-- but commits NOTHING (no closed_checks / order_queue / active_sessions / kds_tickets
-- rows, no card charge, no stock / 86 / loyalty / gift / promo / CRM mutation, no
-- receipts, no kitchen/receipt prints, no cash-drawer pulse). Used for staff training.
--
-- The flag rides the existing device-profile boot + realtime path (App.jsx reads
-- training_mode into deviceConfig; the store mirrors it into the trainingMode
-- singleton that every commit-path gate checks). Idempotent.

alter table device_profiles
  add column if not exists training_mode boolean not null default false;

comment on column device_profiles.training_mode is
  'When true, terminals on this profile run in Training Mode: the POS behaves normally but no orders, payments, stock, loyalty, prints or receipts are committed. v5.5.645.';
