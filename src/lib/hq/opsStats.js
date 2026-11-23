// src/lib/hq/opsStats.js
//
// The Operations figures the head office scorecard shows per site and day: missed opening and
// closing checklists, missed temperature windows, failed temperature checks by severity, and
// open urgent maintenance. Nothing here is stored; it is worked out from the Operations module's
// own rows (templates, runs, schedules, readings), the way the Operations screens do, with one
// difference: the weekday comes from the business date string, never the browser's clock.
// Pure: no React, no Supabase, so node --test drives it (opsStats.test.js).
//
// Shapes (snake_case rows as the database returns them):
//   checklist   { id, location_id, area, frequency, days_of_week, day_of_month, time_of_day, grace_minutes, active, archived_at }
//   run         { checklist_id, location_id, run_date, status ('open' | 'complete'), completed_at }
//   schedule    { id, temp_unit_id, location_id, frequency, days_of_week, time_of_day, grace_minutes, active }
//   reading     { temp_unit_id, schedule_id, in_range, severity, recorded_at, ymd, minute }  (ymd and
//               minute on the venue clock, stamped by the data layer)
//   maintenance { status, priority }

const DOW_SUN0 = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).getUTCDay();

export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** Is a daily, weekly or monthly schedule due on this business date? (The Operations rule, venue weekday.) */
export function dueOn(row, ymd) {
  if (!row || !ymd) return false;
  if (row.active === false || row.archived_at) return false;
  const days = Array.isArray(row.days_of_week) ? row.days_of_week : [];
  const dow = DOW_SUN0(ymd);
  if (row.frequency === 'monthly') return Number(ymd.slice(8, 10)) === (Number(row.day_of_month) || 1);
  if (row.frequency === 'weekly') return days.length > 0 && days.includes(dow);
  return days.length === 0 || days.includes(dow);
}

/**
 * The state of one scheduled thing on a date.
 *   done      a complete run (or a reading in the window)
 *   missed    past the window plus grace with nothing
 *   due       the window is open now
 *   upcoming  the window has not opened
 *   anytime   no time of day and the day has not ended, so not yet missed
 * nowMin is the venue minute of the day for `today`; a past date is judged at the end of the day.
 */
export function windowState({ timeOfDay, graceMin = 120, satisfied, ymd, today, nowMin }) {
  if (satisfied) return 'done';
  const past = today && ymd < today;
  const future = today && ymd > today;
  if (future) return 'upcoming';
  const wMin = hhmmToMin(timeOfDay);
  if (wMin === null) return past ? 'missed' : 'anytime';
  const now = past ? 1440 + 1 : (Number.isFinite(nowMin) ? nowMin : 1440 + 1);
  if (now < wMin) return 'upcoming';
  if (now <= wMin + (Number(graceMin) || 0)) return 'due';
  return 'missed';
}

const emptyBucket = () => ({ due: 0, done: 0, missed: 0, open: 0 });

/**
 * checklistStats({ checklists, runs, ymd, today, nowMin }) for ONE site and ONE business date.
 * Returns { all, opening, closing } each { due, done, missed, open } where open = due now or anytime,
 * not yet counted either way. Opening and closing go by the template's area.
 */
export function checklistStats({ checklists = [], runs = [], ymd, today, nowMin } = {}) {
  const out = { all: emptyBucket(), opening: emptyBucket(), closing: emptyBucket() };
  const runBy = new Map();
  for (const r of runs || []) if (r?.run_date === ymd) runBy.set(r.checklist_id, r);
  for (const c of checklists || []) {
    if (!dueOn(c, ymd)) continue;
    const run = runBy.get(c.id);
    const state = windowState({ timeOfDay: c.time_of_day, graceMin: c.grace_minutes ?? 120, satisfied: run?.status === 'complete', ymd, today, nowMin });
    const buckets = [out.all];
    if (c.area === 'opening') buckets.push(out.opening);
    if (c.area === 'closing') buckets.push(out.closing);
    for (const b of buckets) {
      b.due += 1;
      if (state === 'done') b.done += 1;
      else if (state === 'missed') b.missed += 1;
      else if (state !== 'upcoming') b.open += 1;
    }
  }
  return out;
}

/**
 * tempStats({ schedules, readings, ymd, today, nowMin }) for one site and date. A window is satisfied
 * by any reading of its unit that day at or after five minutes before the window. Also counts the
 * day's readings out of range by severity.
 * Returns { windows: { due, done, missed, open }, failed: { count, critical, major, minor } }.
 */
export function tempStats({ schedules = [], readings = [], ymd, today, nowMin } = {}) {
  const windows = emptyBucket();
  const dayReads = (readings || []).filter((r) => r?.ymd === ymd);
  for (const s of schedules || []) {
    if (!dueOn(s, ymd)) continue;
    const wMin = hhmmToMin(s.time_of_day);
    const satisfied = dayReads.some((r) => r.temp_unit_id === s.temp_unit_id && (r.schedule_id === s.id || wMin === null || (Number.isFinite(r.minute) && r.minute >= wMin - 5)));
    const state = windowState({ timeOfDay: s.time_of_day, graceMin: s.grace_minutes ?? 60, satisfied, ymd, today, nowMin });
    windows.due += 1;
    if (state === 'done') windows.done += 1;
    else if (state === 'missed') windows.missed += 1;
    else if (state !== 'upcoming') windows.open += 1;
  }
  const failed = { count: 0, critical: 0, major: 0, minor: 0 };
  for (const r of dayReads) {
    if (r.in_range !== false) continue;
    failed.count += 1;
    if (r.severity === 'critical') failed.critical += 1;
    else if (r.severity === 'major') failed.major += 1;
    else failed.minor += 1;
  }
  return { windows, failed };
}

/** Open maintenance: { open, urgent } where urgent = high or urgent priority still open. */
export function maintenanceStats(rows = []) {
  const live = (rows || []).filter((m) => m && ['open', 'assigned', 'in_progress'].includes(m.status));
  return { open: live.length, urgent: live.filter((m) => m.priority === 'urgent' || m.priority === 'high').length };
}

/** Done out of what was required (done + missed). 100 when nothing was required yet. Null with no schedules at all. */
export function checksPct(...buckets) {
  let done = 0; let required = 0; let due = 0;
  for (const b of buckets) { if (!b) continue; done += b.done || 0; required += (b.done || 0) + (b.missed || 0); due += b.due || 0; }
  if (due === 0) return null;
  if (required === 0) return 100;
  return Math.round((done / required) * 1000) / 10;
}

const addB = (a, b) => ({ due: a.due + b.due, done: a.done + b.done, missed: a.missed + b.missed, open: a.open + b.open });

/**
 * opsSiteStats({ checklists, runs, schedules, readings, maintenance, dates, today, nowMin }): one site
 * over a run of business dates (today alone, or the week). Sums the day buckets and gives:
 *   { checklists: { all, opening, closing }, temps: { windows, failed }, maintenance: { open, urgent },
 *     checksPct, days }
 */
export function opsSiteStats({ checklists = [], runs = [], schedules = [], readings = [], maintenance = [], dates = [], today, nowMin } = {}) {
  const sum = { all: emptyBucket(), opening: emptyBucket(), closing: emptyBucket() };
  const temps = { windows: emptyBucket(), failed: { count: 0, critical: 0, major: 0, minor: 0 } };
  for (const ymd of dates || []) {
    const c = checklistStats({ checklists, runs, ymd, today, nowMin });
    sum.all = addB(sum.all, c.all); sum.opening = addB(sum.opening, c.opening); sum.closing = addB(sum.closing, c.closing);
    const t = tempStats({ schedules, readings, ymd, today, nowMin });
    temps.windows = addB(temps.windows, t.windows);
    for (const k of Object.keys(temps.failed)) temps.failed[k] += t.failed[k];
  }
  return {
    checklists: sum, temps, maintenance: maintenanceStats(maintenance),
    checksPct: checksPct(sum.all, temps.windows), days: (dates || []).length,
  };
}

/** The business dates from `from` to `to` inclusive ('YYYY-MM-DD'). */
export function dateRange(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let d = new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)));
  const end = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  while (d.getTime() <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

/** Short words for the scorecard's Checks cell: "2 missed, 1 failed temp" or "All done". */
export function checksWords(stats) {
  if (!stats) return null;
  const parts = [];
  const missed = (stats.checklists?.all?.missed || 0) + (stats.temps?.windows?.missed || 0);
  if (missed) parts.push(`${missed} missed`);
  const failed = stats.temps?.failed?.count || 0;
  if (failed) parts.push(`${failed} failed temp${failed === 1 ? '' : 's'}`);
  if (stats.maintenance?.urgent) parts.push(`${stats.maintenance.urgent} urgent repair${stats.maintenance.urgent === 1 ? '' : 's'}`);
  if (parts.length) return parts.join(', ');
  const due = (stats.checklists?.all?.due || 0) + (stats.temps?.windows?.due || 0);
  return due ? 'All done' : 'Nothing scheduled';
}
