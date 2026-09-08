-- v5.5.807 — venue coordinates for the group venue-picker map + distances
-- (/order/<group> and /cater/<group>, src/surfaces/GroupOrderSurface.jsx).
-- PLATFORM DB (yhzjgyrkyjabvhblqxzu). Additive only.
--
-- No coords on a venue = it simply doesn't appear on the picker map and shows
-- no distance — the picker degrades gracefully, nothing breaks.

alter table public.locations
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;

comment on column public.locations.latitude  is 'Venue latitude (WGS84). Used by the group venue-picker map/distance sort; null = venue hidden from the map.';
comment on column public.locations.longitude is 'Venue longitude (WGS84). See latitude.';
