// menuBoardUptime.js
// When a TV refreshes itself (5.12.74, 8 Nov 2026).
//
// Peter: "the menu boards and a few stores keep quitting". A Fire TV stick has 1 to 2 GB of memory
// and a page left up for days grows (video decode buffers, realtime reconnects, image caches).
// Every signage product reloads its page once a night; so does this board, at a quiet hour in
// the venue's own time, at a minute chosen from the screen id so twenty five TVs never reload in
// the same second. The pairing and the board live in localStorage, so a reload shows the same
// board again within a second or two and nothing re-pairs.
//
// Pure: give it the uptime, the local clock and the screen id, it says whether to reload now.

/** A page younger than this is never reloaded, however late the hour. */
export const MIN_UP_MS = 20 * 60 * 60 * 1000;
/** The quiet window, venue time: 03:00 to 05:59. */
export const WINDOW_START_HOUR = 3;
export const WINDOW_HOURS = 3;
/** How often the surface asks. */
export const CHECK_MS = 60 * 1000;

/** 0..179: the minute inside the window this screen reloads at. Same id, same minute. */
export function reloadMinuteOffset(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % (WINDOW_HOURS * 60);
}

/**
 * @param {{ upMs: number, hour: number, minute: number, seed?: string }} a
 * @returns {boolean} reload now
 */
export function nightlyReloadDue({ upMs, hour, minute, seed } = {}) {
  if (!(Number(upMs) >= MIN_UP_MS)) return false;
  const h = Number(hour); const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return false;
  const now = h * 60 + m;
  const start = WINDOW_START_HOUR * 60;
  const slot = start + reloadMinuteOffset(seed);
  return now >= slot && now < start + WINDOW_HOURS * 60;
}

/** Hour and minute on the venue's clock (the device clock when the zone is unknown or bad). */
export function localHourMinute(now = new Date(), timeZone = null) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const pick = (t) => Number(parts.find((p) => p.type === t)?.value);
    const hour = pick('hour') % 24; const minute = pick('minute');
    if (Number.isInteger(hour) && Number.isInteger(minute)) return { hour, minute };
  } catch { /* unknown zone: device clock below */ }
  return { hour: now.getHours(), minute: now.getMinutes() };
}

/**
 * The one place the TV page reloads itself. It is a plain reload: localStorage keeps the pairing
 * and the cached board, so the same board is back within a second or two and nothing re pairs.
 * (menuBoardPairingWiring.test pins that the surface itself never calls window.location.reload,
 * since the 12 Oct 2026 wipe; this is the deliberate exception, behind the rule above.)
 */
export function reloadPage() {
  if (typeof window !== 'undefined' && window.location) window.location.reload();
}
