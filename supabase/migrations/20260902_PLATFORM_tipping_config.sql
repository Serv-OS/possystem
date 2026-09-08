-- Tipping for ONLINE ORDERING and QR, set on the module.  PLATFORM project.
--
-- Peter's call (2 Sep 2026): the control lives in each module's own settings,
-- not one central screen. Online ordering and QR are both configured on the
-- Online Ordering screen and both read the location row through customerUrl,
-- so they share one column with a key per module. Catering keeps its own
-- table (see 20260902_catering_tip_options.sql). Kiosk already had it.
--
-- SHAPE
--   {
--     "online": { "on": false, "pct": [5,10,12.5,15], "default": null, "custom": true },
--     "qr":     { "on": true,  "pct": [5,10,12.5,15], "default": null, "custom": true }
--   }
--   on       ask for a tip at all
--   pct      the percentage chips offered, in order
--   default  the chip pre-selected. null = "No tip" is pre-selected
--   custom   offer a free-text amount
--
-- WHY THE QR DEFAULT CHANGES
-- QR used to hardcode 10% PRE-SELECTED at every venue with no way to turn it
-- off. A venue with nothing set now gets: QR on, nothing pre-selected. Online
-- ordering never took tips, so it starts off. Operators choose from there.
--
-- This column does NOT drive the physical card reader (location_reader_settings).

alter table public.locations
  add column if not exists tipping_config jsonb;

comment on column public.locations.tipping_config is
  'Per-module tipping: {"online":{...},"qr":{...}} each {on,pct[],default|null,custom}. Null = built-in defaults (online off, qr on with nothing pre-selected). Does not control the card reader.';
