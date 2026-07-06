-- v5.5.731 — per-device-profile auto sign-out policy.
-- How a POS logs the current operator out (beyond manual card-tap / user-icon logout):
--   signout_idle_seconds : auto sign-out after N seconds of no activity (0 = off; UI uses 15s steps)
--   signout_on_pay       : sign out after taking payment (cashing off a check)
--   signout_on_send      : sign out after sending an order to the kitchen
alter table public.device_profiles
  add column if not exists signout_idle_seconds integer not null default 0,
  add column if not exists signout_on_pay boolean not null default false,
  add column if not exists signout_on_send boolean not null default false;
