// src/surfaces/bookings/useVenueClock.js
//
// 16 Oct 2026 (audit item 8): every date and time on the host stand is the
// VENUE's (locationConfig.timezone), never the iPad's. A stand in California
// for a UK venue showed every Late, Due, now line and "Today" 8 hours behind
// the till. Pure maths in lib/bookings/venueClock.js (tested); this hook
// re-renders every 30 seconds and returns primitives, so they can sit in
// effect and memo deps.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { venueNow, VENUE_CLOCK_TICK_MS } from '../../lib/bookings/venueClock.js';

export function useVenueClock(intervalMs = VENUE_CLOCK_TICK_MS) {
  const tz = useStore((s) => s.locationConfig?.timezone) || 'Europe/London';
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  const { ymd, nowMin } = venueNow(tz);
  return { ymd, nowMin, tz };
}
