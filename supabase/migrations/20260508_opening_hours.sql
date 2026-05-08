-- v5.5.102 — Opening hours infrastructure for kiosk + online ordering.
-- Run this against the PLATFORM DB (yhzjgyrkyjabvhblqxzu).
--
-- Adds an opening_hours jsonb column to platform.locations with the shape:
--   {
--     "weekly": {
--       "mon": [{"open": "09:00", "close": "17:00"}, ...],
--       "tue": [...], ..., "sun": [...]
--     },
--     "closedDates": ["2026-12-25", ...]
--   }
--
-- Multi-window per day supports lunch + dinner with a break.
-- Empty array on a day = closed all day.
-- Overnight windows (close <= open) are valid (e.g. 22:00→02:00 late bar).

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS opening_hours jsonb;

-- Default empty schedule for any existing rows so kiosk/online surfaces don't
-- crash on null.
UPDATE public.locations
SET opening_hours = jsonb_build_object(
  'weekly', jsonb_build_object(
    'sun', '[]'::jsonb, 'mon', '[]'::jsonb, 'tue', '[]'::jsonb,
    'wed', '[]'::jsonb, 'thu', '[]'::jsonb, 'fri', '[]'::jsonb, 'sat', '[]'::jsonb
  ),
  'closedDates', '[]'::jsonb
)
WHERE opening_hours IS NULL;

-- Comment for future maintainers.
COMMENT ON COLUMN public.locations.opening_hours IS
  'Weekly schedule + per-date closures. Drives kiosk + online ordering closed/open state. See src/lib/openingHours.js for shape and helpers.';
