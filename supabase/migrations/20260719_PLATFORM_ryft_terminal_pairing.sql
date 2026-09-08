-- 20260719_PLATFORM_ryft_terminal_pairing.sql
-- PLATFORM DB (yhzjgyrkyjabvhblqxzu) — Ryft PAX terminal pairing schema.
--
-- Why: supabase/functions/ryft-terminals writes a Ryft-shaped payment_devices row
-- (processor='ryft', ryft_terminal_id, serial_number, bound_pos_device_id, status,
-- registered_by_user_id — upsert onConflict:'ryft_terminal_id') and reads
-- merchant_ryft_accounts.ryft_inperson_location_id. Most of those columns were
-- added to the live DB by hand and never committed; this migration makes the repo
-- self-describing (everything IF NOT EXISTS / guarded, safe to re-run).
--
-- The one LIVE blocker fixed here: payment_devices still had four Stripe-era
-- NOT NULLs (stripe_reader_id, stripe_account_id, device_type, connection_kind)
-- which the Ryft upsert never supplies → every Ryft terminal registration failed
-- at the final local save. They are relaxed to nullable, with a conditional CHECK
-- preserving the old guarantee for Stripe rows (and requiring ryft_terminal_id on
-- Ryft rows). connection_kind stays NULL on Ryft rows on purpose: the client's
-- getAssignedNetworkReader() selects connection_kind='network' Stripe readers, so
-- defaulting it would make a PAX masquerade as a Stripe network reader.

-- 1) Columns the pairing flow reads/writes (no-ops on the live DB, which already has them).
alter table public.payment_devices add column if not exists processor text not null default 'stripe';
alter table public.payment_devices add column if not exists ryft_terminal_id text;
alter table public.payment_devices add column if not exists serial_number text;
alter table public.payment_devices add column if not exists bound_pos_device_id text;
alter table public.payment_devices add column if not exists status text default 'unknown';
alter table public.payment_devices add column if not exists registered_by_user_id uuid;
alter table public.merchant_ryft_accounts add column if not exists ryft_inperson_location_id text;

-- Unique index required by the upsert's onConflict:'ryft_terminal_id' (already live).
create unique index if not exists uq_payment_devices_ryft_terminal_id
  on public.payment_devices (ryft_terminal_id);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_devices_processor_check'
      and conrelid = 'public.payment_devices'::regclass
  ) then
    alter table public.payment_devices
      add constraint payment_devices_processor_check check (processor in ('stripe','ryft'));
  end if;
end $$;

-- 2) Relax the four Stripe-era NOT NULLs so a Ryft row can insert.
--    (DROP NOT NULL is idempotent; the existing connection_kind CHECK
--    IN ('network','tap_to_pay') passes on NULL, so it needs no change.)
alter table public.payment_devices alter column stripe_reader_id drop not null;
alter table public.payment_devices alter column stripe_account_id drop not null;
alter table public.payment_devices alter column device_type drop not null;
alter table public.payment_devices alter column connection_kind drop not null;

-- 3) Keep integrity per processor: Stripe rows still need their Stripe fields;
--    Ryft rows need a terminal id. All pre-existing rows are complete Stripe rows.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_devices_processor_fields_check'
      and conrelid = 'public.payment_devices'::regclass
  ) then
    alter table public.payment_devices
      add constraint payment_devices_processor_fields_check check (
        (processor = 'stripe'
          and stripe_reader_id is not null
          and stripe_account_id is not null
          and device_type is not null
          and connection_kind is not null)
        or
        (processor = 'ryft' and ryft_terminal_id is not null)
      );
  end if;
end $$;
