// src/lib/cateringRules.js
//
// The catering fire time rules live in supabase/functions/_shared/cateringRules.js so the
// ezCater webhook and the ServOS catering checkout run the SAME code. This file only re-exports
// them for the app.
export {
  DEFAULT_VENUE_TZ, wallTimeToInstantMs, venueWallClock, cateringPrepMinutes, cateringFireMs,
} from '../../supabase/functions/_shared/cateringRules.js';
