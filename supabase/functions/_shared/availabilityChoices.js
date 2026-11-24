// supabase/functions/_shared/availabilityChoices.js (5.12.91)
//
// What a team member can say about a day, and which weeks they can say it for. One copy for
// staff-portal (which checks every change), the staff app and the Back Office. Pure, no imports:
// node --test (src/staff/availabilityChoices.test.js).
//
// WHY (HR feedback batch 2, 24 Nov 2026; Peter: "yes that seems good").
//   1. PART OF THE DAY. "Preferred" means "I would like to work this day" (the rota builder gives
//      those people shifts first). Staff read it as "I can only do part of the day" and had nowhere
//      to say which part. Preferred keeps its meaning. A fourth choice, Part of the day, carries one
//      of the site's own options ("AM shift", "From 5pm"), set by a manager in the Back Office. For
//      the rota it counts as available, and the manager sees the option when placing the person.
//   2. FUTURE WEEKS. Students know their timetable months ahead. A pattern could only be filed for
//      the next rota period, one at a time. Now a pattern can be filed for any week up to
//      MAX_WEEKS_AHEAD ahead. Each one applies FROM its week until the next week that has one, the
//      same rule the rota already reads (availabilityWhen.js), so nothing else changes.
//
// A day's entry (wf_availability.per_day): { day: 0..6 (Monday 0), state, note? }. note is the
// option, kept only for 'partial'.

export const DAY_STATE_KEYS = ['available', 'preferred', 'partial', 'unavailable'];
export const STATE_WORDS = { available: 'Available', preferred: 'Preferred', partial: 'Part of the day', unavailable: 'Unavailable' };
export const DEFAULT_PART_DAY = ['AM shift', 'PM shift', 'From 12pm', 'From 5pm'];
export const MAX_PART_DAY_OPTIONS = 12;
export const MAX_OPTION_LENGTH = 30;
export const MAX_WEEKS_AHEAD = 26;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** A manager's list of options, tidied: trimmed, no blanks, no repeats, short, at most twelve. */
export function cleanOptions(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION_LENGTH);
    if (s && !out.some((x) => same(x, s))) out.push(s);
    if (out.length >= MAX_PART_DAY_OPTIONS) break;
  }
  return out;
}

/** The site's options (Workforce settings, settings.availabilityOptions), or the defaults when none are set. */
export function partDayOptions(settings) {
  const mine = cleanOptions(settings?.availabilityOptions);
  return mine.length ? mine : [...DEFAULT_PART_DAY];
}

/**
 * A change from the staff app, checked. raw: [{ day, state, note? }]. options: the site's list.
 * Returns { perDay } (sorted, tidy) or { error } in words.
 */
export function cleanPerDay(raw, options = DEFAULT_PART_DAY) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Pick a choice for each day' };
  const seen = new Set();
  const perDay = [];
  for (const d of raw) {
    const day = Number(d?.day);
    const state = String(d?.state || '');
    if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day) || !DAY_STATE_KEYS.includes(state)) return { error: 'Pick a choice for each day' };
    seen.add(day);
    if (state === 'partial') {
      const note = (options || []).find((o) => same(o, d?.note));
      if (!note) return { error: `Pick which part of the day you can work on ${DAY_NAMES[day]}` };
      perDay.push({ day, state, note });
    } else perDay.push({ day, state });
  }
  perDay.sort((a, b) => a.day - b.day);
  return { perDay };
}

/** One day in words: "Unavailable", "Preferred", "Part of the day: AM shift". */
export function dayWords(entry) {
  const state = DAY_STATE_KEYS.includes(entry?.state) ? entry.state : 'available';
  if (state === 'partial') return entry?.note ? `Part of the day: ${entry.note}` : 'Part of the day';
  return STATE_WORDS[state];
}

/** The seven days of a pattern as entries (a day with nothing said is available). */
export function weekOf(perDay) {
  return DAY_NAMES.map((_, i) => {
    const e = (perDay || []).find((x) => Number(x?.day) === i);
    return e && DAY_STATE_KEYS.includes(e.state) ? { day: i, state: e.state, ...(e.state === 'partial' && e.note ? { note: e.note } : {}) } : { day: i, state: 'available' };
  });
}

/** Is every day plain available? */
export function allAvailable(perDay) {
  return weekOf(perDay).every((e) => e.state === 'available');
}

const addDays = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The weeks a pattern can be filed for: the first open week (changesFrom) and the weeks after it. */
export function weekChoices(changesFrom, count = MAX_WEEKS_AHEAD + 1) {
  if (!YMD.test(String(changesFrom || ''))) return [];
  return Array.from({ length: Math.max(1, Math.min(count, MAX_WEEKS_AHEAD + 1)) }, (_, i) => addDays(changesFrom, i * 7));
}

/** Why a pattern cannot be filed for that week, in words, or null. */
export function weekProblem(weekStart, changesFrom) {
  const w = String(weekStart || '');
  if (!YMD.test(w) || !YMD.test(String(changesFrom || ''))) return 'Pick the week it starts from';
  if (w < changesFrom) return 'That week is already on the rota. Pick a later week.';
  if (!weekChoices(changesFrom).includes(w)) {
    return w > addDays(changesFrom, MAX_WEEKS_AHEAD * 7) ? `You can set availability up to ${MAX_WEEKS_AHEAD} weeks ahead.` : 'Pick the week it starts from';
  }
  return null;
}

/**
 * The patterns a person has filed for later weeks, soonest first, for the staff app and the Back
 * Office: [{ from, perDay, locked }]. locked: that week is already on the rota, so it can no longer
 * be changed from the staff app. rows: wf_availability rows (week_start or weekStart).
 */
export function upcomingPatterns(rows, todayYmd, changesFrom) {
  const ws = (r) => String(r?.week_start ?? r?.weekStart ?? '');
  return (rows || []).filter((r) => YMD.test(ws(r)) && ws(r) > String(todayYmd || ''))
    .sort((a, b) => (ws(a) < ws(b) ? -1 : ws(a) > ws(b) ? 1 : 0))
    .map((r) => ({ from: ws(r), perDay: weekOf(r.per_day ?? r.perDay), locked: YMD.test(String(changesFrom || '')) ? ws(r) < changesFrom : false }));
}
