// src/lib/scheduleCtx.js — buildScheduleCtx, extracted VERBATIM from
// locationTime.js in v5.7.31. WHY THE MOVE: it is a pure Intl read with no
// dependencies, but locationTime.js imports the supabase client, which Node's
// ESM loader cannot load — and checkTotals.js (which needs buildScheduleCtx for
// auto-discount gating) now runs under `npm test` (checkTotals.test.js, the UK
// golden lock). locationTime.js re-exports it, so every existing import path
// (`from './locationTime'`) still works — do NOT import supabase/anything with
// side effects into this file.

/**
 * Build the LOCATION-LOCAL time context the auto-discount engine needs to gate a
 * rule's schedule (day-of-week + time window + start/expiry). Returns:
 *   { nowMinutes: 0..1439, isoDay: 1..7 (Mon..Sun), ymd: 'YYYY-MM-DD' }
 * all expressed in the given timezone. Pure read of the current clock — pass the
 * result to discountEngine.evaluateAutoDiscounts(items, rules, channel, ctx).
 */
export function buildScheduleCtx(timezone = 'Europe/London') {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Europe/London',
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const y = get('year'), mo = get('month'), d = get('day');
    let hh = parseInt(get('hour'), 10); const mm = parseInt(get('minute'), 10);
    if (hh === 24) hh = 0; // some runtimes emit "24" at midnight
    const wkMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const isoDay = wkMap[get('weekday')] || null;
    return { nowMinutes: hh * 60 + mm, isoDay, ymd: `${y}-${mo}-${d}` };
  } catch {
    const now = new Date();
    const isoDay = ((now.getDay() + 6) % 7) + 1; // JS 0=Sun → ISO 7=Sun
    return {
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
      isoDay,
      ymd: now.toISOString().slice(0, 10),
    };
  }
}
