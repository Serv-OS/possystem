-- v5.5.60 — MPOS device profile fields
-- Ops DB: tbetcegmszzotrwdtqhi
-- Adds the MPOS-specific configuration columns to device_profiles. The
-- 'mpos' value for default_surface is enum-free text, so no constraint to
-- update — admins create an MPOS profile in BO and pair phones to it.

alter table device_profiles add column if not exists runner_mode boolean default false;
alter table device_profiles add column if not exists payment_mode text default 'tap_to_pay';
-- payment_mode in ('tap_to_pay', 'assigned_reader', 'pay_at_counter_only')
alter table device_profiles add column if not exists assigned_reader_id uuid;

comment on column device_profiles.runner_mode is 'MPOS-only: restricts UI to delivery/handoff flow (no order taking).';
comment on column device_profiles.payment_mode is 'MPOS-only: tap_to_pay | assigned_reader | pay_at_counter_only.';
comment on column device_profiles.assigned_reader_id is 'MPOS-only: optional fixed Stripe reader id (uses payment_devices.id).';
