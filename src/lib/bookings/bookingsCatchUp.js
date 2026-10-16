// src/lib/bookings/bookingsCatchUp.js
//
// 16 Oct 2026 (audit item 9): the host stand loaded the diary once at boot and
// then trusted realtime alone. An iPad that slept, or roamed wifi, never saw
// the widget bookings, cancellations and seatings it missed, and a stand left
// on overnight showed yesterday in the morning. This keeps the viewed day
// fresh:
//   - when the tab becomes visible again (iPad woken)
//   - when the network comes back
//   - on a safety timer (60 seconds on the stand)
//   - when the venue's day changes while the diary is on today (midnight)
// (A realtime resubscribe reloads too; realtime.js calls refreshBookingsDay.)
//
// Every trigger goes through one debounced reload, so a wake that fires
// visible and online together costs one read. The environment is injected,
// so the whole thing runs in node tests with fake timers and event targets.

import { venueToday, rolloverTarget, VENUE_CLOCK_TICK_MS } from './venueClock.js';

export const CATCH_UP_EVERY_MS = 60 * 1000;
const DEBOUNCE_MS = 400;

// store: a zustand store (getState). Options:
//   win / doc       event targets for 'online' and 'visibilitychange' (null = skip)
//   everyMs         safety reload timer (0 = none)
//   dayCheckMs      how often the venue day is checked (0 = never)
//   timers          { setInterval, clearInterval, setTimeout, clearTimeout }
//   at              () => Date, for tests
// Returns stop().
export function startBookingsCatchUp({
  store,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
  everyMs = CATCH_UP_EVERY_MS,
  dayCheckMs = VENUE_CLOCK_TICK_MS,
  timers = globalThis,
  at = undefined,
} = {}) {
  if (!store?.getState) return () => {};
  let stopped = false;
  let pending = null;
  const tz = () => store.getState().locationConfig?.timezone;
  const now = () => (typeof at === 'function' ? at() : undefined);
  let lastToday = venueToday(tz(), now());

  const reload = (reason) => {
    if (stopped) return;
    if (pending) timers.clearTimeout(pending);
    pending = timers.setTimeout(() => {
      pending = null;
      if (stopped) return;
      try { store.getState().refreshBookingsDay?.(reason); } catch { /* the next trigger tries again */ }
    }, DEBOUNCE_MS);
  };

  const onVisible = () => { if (!doc || doc.visibilityState === undefined || doc.visibilityState === 'visible') reload('visible'); };
  const onOnline = () => reload('online');
  doc?.addEventListener?.('visibilitychange', onVisible);
  win?.addEventListener?.('online', onOnline);

  const every = everyMs > 0 ? timers.setInterval(() => {
    // A hidden tab does not need the read; the visible event catches it up.
    if (doc && doc.visibilityState === 'hidden') return;
    reload('timer');
  }, everyMs) : null;

  const day = dayCheckMs > 0 ? timers.setInterval(() => {
    const today = venueToday(tz(), now());
    const target = rolloverTarget({ viewing: store.getState().bookingsDate, previousToday: lastToday, today });
    lastToday = today;
    if (target) {
      try { store.getState().setBookingsDate?.(target, { auto: true }); } catch { /* next tick */ }
    }
  }, dayCheckMs) : null;

  return () => {
    stopped = true;
    if (pending) timers.clearTimeout(pending);
    if (every) timers.clearInterval(every);
    if (day) timers.clearInterval(day);
    doc?.removeEventListener?.('visibilitychange', onVisible);
    win?.removeEventListener?.('online', onOnline);
  };
}
