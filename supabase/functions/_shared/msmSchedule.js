// supabase/functions/_shared/msmSchedule.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): when a scheduled change set runs. Pure, tested
// (src/lib/msm/msmSchedule.test.js, London and a US zone, both clock change weekends).
//
// Peter, 17 Oct 2026: "schedule menu push so we can add items then say these items need to be on
// the POS by X date and time".
//
// THE RULES
//   * The time a person picks is read on EACH SITE'S OWN CLOCK (locations.timezone; the venue
//     clock invariant). A UK chain is all Europe/London; a mixed company gets one due time per site.
//   * "On the POS by X": a set starts lead_minutes (default 5) BEFORE X, so it is on every till by
//     X. The screen says "Starts 05:55 so it is on every till by 06:00". Lead 0 is allowed.
//   * The database works out the same due time (public.msm_schedule_set, `at time zone`); this
//     copy is for the screen's words and is pinned to the same answers by test.
//   * A time that does not exist on that clock (the hour the clocks go forward) is read with the
//     offset from before the gap, and a time that happens twice (the clocks go back) as the
//     SECOND of the two (winter time): exactly as Postgres reads `timestamp at time zone`, which
//     is what the database uses for the real due time (proven equal in
//     supabase/tests/multi_site_menu/run.mjs). Nobody schedules a menu at 01:30 on a Sunday.
//   * A pre check runs 60 minutes before the due time (review: the scheduler hears before
//     opening, not after); a site run not done 15 minutes after its time is marked late.

export const DEFAULT_LEAD_MINUTES = 5;
export const PRECHECK_MINUTES = 60;
export const LATE_MINUTES = 15;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

// The offset of `tz` from UTC at the instant `utcMs`, in ms (positive east of Greenwich).
export function tzOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * A wall clock time on a site's clock ("2026-10-20T06:00") as a UTC instant (ms). null when the
 * text is not a date and time.
 */
export function localToUtc(local, tz) {
  const m = LOCAL_RE.exec(String(local || '').trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // The candidates: the offsets a day either side of the wall time. Keep those that read back as
  // the same wall time; for a time that happens twice, the later instant (as Postgres).
  const day = 24 * 3600000;
  const offA = tzOffsetMs(wall - day, tz);       // the offset the day before (before any change)
  const offB = tzOffsetMs(wall + day, tz);       // and the day after
  const offC = tzOffsetMs(wall, tz);
  const cands = [...new Set([wall - offA, wall - offB, wall - offC])].sort((a, b) => a - b);
  const exact = cands.filter((t) => t + tzOffsetMs(t, tz) === wall);
  if (exact.length) return exact[exact.length - 1];
  // In the gap (clocks going forward): Postgres reads it with the offset from before the gap.
  return wall - offA;
}

/** The UTC instant a site run is due: the local time less the lead. */
export function dueAt(local, tz, leadMinutes = DEFAULT_LEAD_MINUTES) {
  const t = localToUtc(local, tz);
  if (t == null) return null;
  const lead = Math.max(0, Math.min(240, Number.isFinite(Number(leadMinutes)) ? Number(leadMinutes) : DEFAULT_LEAD_MINUTES));
  return t - lead * 60000;
}

// "05:55" on the site's clock for a UTC instant.
export function clockText(utcMs, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(utcMs));
}

// "Mon 20 Oct 06:00" on the site's clock.
export function whenText(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(utcMs)).replace(',', '');
}

/** "Starts 05:55 so it is on every till by 06:00" (or "Starts at 06:00" with lead 0). */
export function startsWords(local, tz, leadMinutes = DEFAULT_LEAD_MINUTES) {
  const at = localToUtc(local, tz);
  if (at == null) return '';
  const due = dueAt(local, tz, leadMinutes);
  if (due === at) return `Starts at ${clockText(at, tz)}`;
  return `Starts ${clockText(due, tz)} so it is on every till by ${clockText(at, tz)}`;
}

/**
 * The words under the time box, and whether the time can be scheduled.
 *   { ok: false, words: 'Pick a date and time.' }                 the box is empty (Safari's Clear)
 *   { ok: false, past: true, words: 'That time has already passed' }
 *   { ok: true, words: 'Starts straight away so it is on every till by 11:00' }   the lead is already past
 *   { ok: true, words: startsWords(...) }
 */
export function scheduleNote(local, tz, leadMinutes = DEFAULT_LEAD_MINUTES, now = Date.now()) {
  if (!local) return { ok: false, past: false, words: 'Pick a date and time.' };
  const at = localToUtc(local, tz);
  if (at == null) return { ok: false, past: false, words: 'Pick a date and time.' };
  if (at <= now) return { ok: false, past: true, words: 'That time has already passed' };
  const due = dueAt(local, tz, leadMinutes);
  if (due <= now) return { ok: true, past: false, words: `Starts straight away so it is on every till by ${clockText(at, tz)}` };
  return { ok: true, past: false, words: startsWords(local, tz, leadMinutes) };
}

/** The publish button's words: "Schedule for Mon 20 Oct 06:00 (starts 05:55)". */
export function scheduleButtonWords(local, tz, leadMinutes = DEFAULT_LEAD_MINUTES) {
  const at = localToUtc(local, tz);
  if (at == null) return 'Schedule';
  const due = dueAt(local, tz, leadMinutes);
  return `Schedule for ${whenText(at, tz)}${due !== at ? ` (starts ${clockText(due, tz)})` : ''}`;
}

/**
 * Per site due times for a set: [{ location_id, due_at (ms), tz }].
 *   sites  [{ location_id, timezone }]
 */
export function siteDueTimes(local, sites, leadMinutes = DEFAULT_LEAD_MINUTES) {
  return (sites || []).map((s) => ({ location_id: s.location_id, tz: s.timezone || 'Europe/London', due_at: dueAt(local, s.timezone || 'Europe/London', leadMinutes) }));
}

/** Is a local time in the past on that clock (cannot be scheduled)? */
export const isPast = (local, tz, now = Date.now()) => {
  const t = localToUtc(local, tz);
  return t == null || t <= now;
};

/**
 * Scheduled sets in the order they run, and the overlaps between them in words.
 *   sets     [{ id, title, due_at (ms, earliest site), changes: [{ target, entity_id, location_id, after }] }]
 *   names    { entityId: name, locationId: site name }
 *   tz       the clock for the words
 * Returns { order: [ids], overlaps: [{ a, b, words }] }.
 * "Price rise (Mon 20 Oct 06:00) also changes Latte at Site B. Christmas (Mon 1 Dec 06:00) runs later and wins."
 */
export function overlaps(sets, names = {}, tz = 'Europe/London') {
  const list = [...(sets || [])].filter((s) => s && s.due_at != null).sort((a, b) => a.due_at - b.due_at || String(a.id).localeCompare(String(b.id)));
  const out = [];
  const keyOf = (c) => `${c.target === 'product_site' ? 'product' : c.target}|${c.entity_id}|${c.location_id || '*'}`;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const bKeys = new Map();
      for (const c of b.changes || []) for (const f of Object.keys(c.after || {})) bKeys.set(`${keyOf(c)}|${f}`, c);
      const hits = [];
      for (const c of a.changes || []) {
        for (const f of Object.keys(c.after || {})) {
          const k = `${keyOf(c)}|${f}`;
          if (bKeys.has(k)) hits.push(c);
        }
      }
      if (!hits.length) continue;
      const first = hits[0];
      const what = names[first.entity_id] || 'a product';
      const where = first.location_id ? ` at ${names[first.location_id] || 'one site'}` : '';
      const more = hits.length > 1 ? ` and ${hits.length - 1} more` : '';
      out.push({
        a: a.id, b: b.id,
        words: `${a.title || 'One update'} (${whenText(a.due_at, tz)}) also changes ${what}${where}${more}. ${b.title || 'The other'} (${whenText(b.due_at, tz)}) runs later and wins.`,
      });
    }
  }
  return { order: list.map((s) => s.id), overlaps: out };
}
