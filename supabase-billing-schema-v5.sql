-- supabase-billing-schema-v5.sql
-- Per-location reader settings: tipping configuration + idle screen content.
-- Apply on the Platform DB (yhzjgyrkyjabvhblqxzu).

create table if not exists location_reader_settings (
  location_id              uuid primary key references locations(id) on delete cascade,

  -- Tipping (applied to the reader's Terminal Configuration when changed)
  tipping_enabled          boolean       not null default true,
  tip_percentages          int[]         not null default array[15, 18, 20]::int[],
  allow_custom_tip         boolean       not null default true,
  smart_tip_threshold_minor int                                   ,    -- amounts below this use fixed-amount tip presets

  -- Idle screen / splashscreen on BBPOS WisePOS E
  idle_screen_enabled      boolean       not null default false,
  idle_screen_file_id      text          ,                              -- Stripe Files API file_xxx — uploaded with purpose=terminal_reader_splashscreen
  idle_screen_mime         text          ,                              -- 'image/png' | 'image/jpeg' | 'image/gif'
  idle_screen_uploaded_at  timestamptz   ,
  idle_screen_uploaded_by  uuid          ,                              -- audit only — no FK so cross-DB users don't break

  -- Stripe Terminal Configuration object (one per location, drives both tipping
  -- and splashscreen). We track the id so we can update it instead of creating
  -- duplicates.
  stripe_configuration_id  text          ,
  stripe_configuration_synced_at timestamptz,

  created_at               timestamptz   not null default now(),
  updated_at               timestamptz   not null default now()
);

-- Allow the back-office UI (anon role with a logged-in JWT for the merchant
-- admin) to read its own location's settings. Writes go through edge functions
-- so service_role does the actual update — the UI can read its own row.
alter table location_reader_settings enable row level security;

drop policy if exists location_reader_settings_read on location_reader_settings;
create policy location_reader_settings_read on location_reader_settings
  for select using (true);

-- Touch updated_at on row update
create or replace function _touch_location_reader_settings_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_lrs_updated_at on location_reader_settings;
create trigger trg_lrs_updated_at before update on location_reader_settings
  for each row execute function _touch_location_reader_settings_updated_at();

-- Backfill defaults for every location currently in the system so the BO
-- has something to render before the user touches the settings.
insert into location_reader_settings (location_id)
select id from locations
on conflict (location_id) do nothing;
