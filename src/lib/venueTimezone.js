// src/lib/venueTimezone.js
//
// Venue clock for TV surfaces (menu board "Follow timed menus", order screen footer).
// The timezone an operator sets in Location Settings lives on the PLATFORM locations row
// (joined by ops_location_id, anon readable, kept that way on purpose in 20260805c B6);
// the ops locations.timezone column is a legacy default and is only read when the
// platform row cannot be. Never the device clock: a US venue's TV must run on the
// venue's time, not on London's. Returns null when nothing could be read so the caller
// can keep the last good value.
//
// Moved unchanged from src/surfaces/MenuBoardSurface.jsx.

import { supabase, platformSupabase } from './supabase';

export async function fetchVenueTimezone(locId) {
  if (!locId) return null;
  try {
    if (platformSupabase) {
      const { data } = await platformSupabase.from('locations').select('timezone')
        .or(`ops_location_id.eq.${locId},id.eq.${locId}`).limit(1).maybeSingle();
      if (data?.timezone) return data.timezone;
    }
  } catch { /* platform read failed, try the ops column */ }
  try {
    if (supabase) {
      const { data } = await supabase.from('locations').select('timezone').eq('id', locId).maybeSingle();
      if (data?.timezone) return data.timezone;
    }
  } catch { /* ops read failed too, caller keeps the last good tz */ }
  return null;
}
