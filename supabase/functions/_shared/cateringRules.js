// supabase/functions/_shared/cateringRules.js
//
// THE CATERING FIRE TIME, IN ONE PLACE.
//
// Pure functions only: no I/O, no Deno, no Supabase, no clock reads. Imported by the ServOS
// catering checkout (through src/lib/cateringRules.js) and by the ezCater webhook, and unit
// tested from src/lib/cateringRules.test.js under plain node.
//
// Why it exists (Peter, 18 Sep 2026): ezCater orders must "follow the same rules as the rest of
// our catering system where they hit the POS at the right times and parameters set to fire into
// the kitchen as our own catering orders". So an ezCater order is filed as a ServOS catering
// order and its kitchen fire time comes from exactly this code, with the venue's own catering
// prep time (catering_site_settings.prep_time_minutes) and the venue's own timezone.
//
// wallTimeToInstantMs is moved here VERBATIM from CateringCheckout.jsx, and cateringPrepMinutes
// plus cateringFireMs reproduce the checkout's two lines exactly:
//   const prepMin = Math.max(0, Number(cfg?.prep_time_minutes) || 0);
//   const fireMs  = isNaN(eventMs) ? NaN : eventMs - prepMin * 60000;
// A test pins that the checkout gives the same answer it always did.

/** The IANA zone a venue with no timezone set runs on. Same default as src/lib/locationTime.js. */
export const DEFAULT_VENUE_TZ = 'Europe/London';

/**
 * Build the UTC instant for a wall clock time in the VENUE timezone (not the customer's browser,
 * not the machine running this). With no zone the wall clock is read as UTC, as before.
 */
export function wallTimeToInstantMs(dateStr, timeStr, tz) {
  if (!dateStr) return NaN;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '12:00').split(':').map(Number);
  const guess = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0);
  if (!tz) return guess;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; dtf.formatToParts(new Date(guess)).forEach(x => { if (x.type !== 'literal') p[x.type] = +x.value; });
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return guess - (seen - guess);   // shift the guess by the venue's offset at that wall time
  } catch { return guess; }
}

/**
 * An instant to the venue's own calendar date and clock time: { date 'YYYY-MM-DD', time 'HH:MM' }.
 * An unusable zone falls back to the default venue zone, never to the machine running this.
 * null when the instant is not a real time.
 */
export function venueWallClock(instantMs, tz) {
  const ms = typeof instantMs === 'number' ? instantMs : new Date(instantMs).getTime();
  if (!Number.isFinite(ms)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const zones = [tz, DEFAULT_VENUE_TZ].filter((z) => typeof z === 'string' && z.trim());
  for (const z of zones) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', { timeZone: z.trim(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const p = {}; dtf.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = +x.value; });
      if (!p.year) continue;
      const hour = p.hour === 24 ? 0 : p.hour;
      return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(hour)}:${pad(p.minute)}`, timeZone: z.trim() };
    } catch { /* invalid IANA name: try the default */ }
  }
  return null;
}

/** The venue's catering prep time in minutes. Blank, bad or negative reads as 0, exactly as the checkout. */
export function cateringPrepMinutes(settings) {
  return Math.max(0, Number(settings?.prep_time_minutes) || 0);
}

/**
 * THE KITCHEN FIRE TIME for a catering order: the instant the food must be ready, minus the
 * venue's catering prep time. NaN when the ready instant is unknown (the caller decides, the
 * checkout falls back to now).
 */
export function cateringFireMs(readyMs, prepMinutes) {
  if (typeof readyMs !== 'number' || Number.isNaN(readyMs)) return NaN;
  const prep = Math.max(0, Number(prepMinutes) || 0);
  return readyMs - prep * 60000;
}
