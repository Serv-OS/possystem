// supabase/functions/_shared/availabilityWhen.js (5.12.61, Peter 4 Nov 2026: "you cannot change
// availability for that week, you are changing availability for the next rota period")
//
// A person's weekly availability (wf_availability.per_day) is versioned by week_start:
//   week_start null         the pattern in effect from the start
//   week_start 'YYYY-MM-DD' a pattern that takes over from that week
// For any date, the row in effect is the one with the greatest week_start on or before the date
// (null counts as the earliest). A change from the staff app never lands on a week that is already
// on the rota: it is filed with week_start = the week after the later of today's week and the last
// published week at the person's sites. The rota, clash warnings, open shift claims and the AI
// builder all read the row in effect for the date they are looking at. A manager in Back Office
// edits the pattern in effect now (their rota, their call).

import { weekStartYmd, dayText } from './venueDates.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ws = (r) => (r && YMD.test(String(r.weekStart ?? r.week_start ?? '')) ? String(r.weekStart ?? r.week_start) : '');
const perDayOf = (r) => (Array.isArray(r?.perDay) ? r.perDay : Array.isArray(r?.per_day) ? r.per_day : []);

/** This person's rows only (rows may carry staffId or staff_id; rows without either are kept). */
export function availabilityRowsOf(rows, staffId) {
  return (rows || []).filter((r) => { const id = r?.staffId ?? r?.staff_id; return id == null || String(id) === String(staffId); });
}

/** The row in effect on a date (or today when no date): greatest week_start on or before it, null earliest. null = no pattern. */
export function availabilityInEffect(rows, dateIso) {
  const day = YMD.test(String(dateIso || '')) ? String(dateIso) : '9999-12-31';
  let best = null;
  for (const r of rows || []) {
    const w = ws(r);
    if (w && w > day) continue;
    if (!best || w > ws(best) || (w === ws(best) && String(r.updated_at || '') > String(best.updated_at || ''))) best = r;
  }
  return best ? { ...best, perDay: perDayOf(best) } : null;
}

/** Rows that take over after a date, soonest first. */
export function pendingAvailability(rows, dateIso) {
  const day = YMD.test(String(dateIso || '')) ? String(dateIso) : '';
  return (rows || []).filter((r) => ws(r) && ws(r) > day).map((r) => ({ ...r, perDay: perDayOf(r) }))
    .sort((a, b) => (ws(a) < ws(b) ? -1 : ws(a) > ws(b) ? 1 : 0));
}

/**
 * The first week a staff app change may touch: the week after the later of today's week and the
 * last published week. todayYmd and lastPublishedYmd are plain days; workweekStart 0 to 6 (Monday 1).
 */
export function availabilityChangesFrom({ todayYmd, lastPublishedYmd, workweekStart = 1 } = {}) {
  const today = YMD.test(String(todayYmd || '')) ? String(todayYmd) : '';
  if (!today) return '';
  const last = YMD.test(String(lastPublishedYmd || '')) ? String(lastPublishedYmd) : '';
  const base = last > today ? last : today;
  const start = weekStartYmd(base, workweekStart);
  if (!YMD.test(start)) return '';
  const [y, mo, d] = start.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 7)).toISOString().slice(0, 10);
}

/** The words the staff app shows above the editor. venue = currency code or venue facts. */
export function changesFromWords(ymd, venue = 'GBP') {
  if (!YMD.test(String(ymd || ''))) return '';
  const cur = venue && typeof venue === 'object' ? venue.currency : venue;
  return `Changes apply from ${dayText(ymd, { venue: cur, weekday: true })}, the next rota period. Weeks already on the rota keep your current availability.`;
}
