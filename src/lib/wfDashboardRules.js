// src/lib/wfDashboardRules.js
//
// 5.12.59 (Peter, 4 Nov 2026: "the workforce dashboard seems basic"): the pure rules behind the
// Workforce Today dashboard. No I/O, no clock, no locale: the screen reads the venue's day and clock
// through lib/venueDates.js and hands the plain values in (todayIso, nowMins, nowMs). Rows are the
// camelCase shapes staff/wfData.js already maps (mapShift, mapTs, mapLeave, mapDoc, mapOnb).
//
//   shift      { id, staffId|null, roleKey, date 'YYYY-MM-DD', start 'HH:MM', finish 'HH:MM', breakMins,
//                status 'draft'|'published'|'no_show', computedHours|null }
//   timesheet  { id, staffId, shiftId, clockIn (instant), clockOut|null, breakTaken (mins), actualHours,
//                day 'YYYY-MM-DD' (the venue day of clockIn, added by the screen) }
//
// A head office person (lib/headOffice.js) is salaried and never clocks in, so they are never late
// and never "not rostered"; the screen passes their ids in headOfficeIds.

import { weekStartYmd } from '../../supabase/functions/_shared/venueDates.js';

/** Rostered start this many minutes ago with no clock in = late or no show. */
export const LATE_AFTER_MINS = 10;
/** A document expiring within this many days (or already expired) needs a look. */
export const DOC_WARN_DAYS = 30;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// staff/labour.js has hoursOf and resolveRate, but it imports the seed with no file extension, so a
// node test cannot load it. The two rules are small and copied here unchanged: a span past midnight
// wraps, and a rate is the staff override, else the position's hourly rate, else the salaried
// hourly figure (salary / 52 / contracted week), else nothing (never a made up figure).
const DEFAULT_CONTRACTED_WEEK = 40;

/** Decimal hours between 'HH:MM' strings, a span past midnight wraps (labour.hoursOf). */
export function spanHours(start, finish) {
  const a = hhmmToMins(start);
  const b = hhmmToMins(finish);
  if (a == null || b == null) return 0;
  let mins = b - a;
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}

/** The hourly rate the rota uses for a person in a position (labour.resolveRate precedence). */
export function rateOf(member, role, contractedWeekFallback) {
  const cw = num(member?.contractedWeek) || num(role?.contractedWeek) || num(contractedWeekFallback) || DEFAULT_CONTRACTED_WEEK;
  if (member && member.rateOverride != null && Number.isFinite(Number(member.rateOverride))) return Number(member.rateOverride);
  if (role && role.rate != null && Number.isFinite(Number(role.rate))) return Number(role.rate);
  if (role && num(role.salary) > 0) return num(role.salary) / 52 / cw;
  return 0;
}

/** 'HH:MM' to minutes since midnight; null when not a time. */
export function hhmmToMins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** A plain date plus n days, 'YYYY-MM-DD' (no clock, no zone). */
export function addDaysYmd(iso, n) {
  if (!YMD.test(String(iso || ''))) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + num(n)));
  return t.toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when toIso is earlier); null when either is not a date. */
export function daysBetweenYmd(fromIso, toIso) {
  if (!YMD.test(String(fromIso || '')) || !YMD.test(String(toIso || ''))) return null;
  const at = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((at(toIso) - at(fromIso)) / 86400000);
}

/** The venue's work week holding todayIso: { startIso, endIso } (startDow 0 = Sunday ... 6 = Saturday). */
export function weekOf(todayIso, startDow = 1) {
  const startIso = weekStartYmd(todayIso, startDow);
  return { startIso, endIso: startIso ? addDaysYmd(startIso, 6) : '' };
}

/** Paid hours a shift plans: the saved figure, else start to finish less the break. Never negative. */
export function shiftHours(shift) {
  if (!shift) return 0;
  if (shift.computedHours != null && Number.isFinite(Number(shift.computedHours))) return Math.max(0, Number(shift.computedHours));
  if (!shift.start || !shift.finish) return 0;
  return Math.max(0, spanHours(shift.start, shift.finish) - num(shift.breakMins) / 60);
}

/** A shift that still counts as planned (a marked no show does not). */
const planned = (s) => s && s.status !== 'no_show' && s.status !== 'cancelled';

/** Everyone clocked in right now: a timesheet with a clock in and no clock out, whatever its day. */
export function onShiftNow(timesheets) {
  return (timesheets || []).filter((t) => t && t.clockIn && t.clockOut == null && t.staffId);
}

/** Today's shifts, marked no shows left out. */
export function rosteredToday(shifts, todayIso) {
  if (!todayIso) return [];
  return (shifts || []).filter((s) => planned(s) && s.date === todayIso);
}

/** Planned hours across a list of shifts. */
export function plannedHours(shifts) {
  return (shifts || []).filter(planned).reduce((a, s) => a + shiftHours(s), 0);
}

/**
 * Hours worked so far on the venue day: closed timesheets of the day by their actual hours, open
 * clock ins by the time since the clock in less the break taken. nowMs: the instant now.
 */
export function hoursSoFar(timesheets, { todayIso, nowMs }) {
  if (!todayIso) return 0;
  let total = 0;
  for (const t of timesheets || []) {
    if (!t || !t.clockIn || t.status === 'no_show' || t.status === 'rejected') continue;
    if (t.clockOut == null) {
      const inMs = Date.parse(t.clockIn);
      if (!Number.isFinite(inMs) || !Number.isFinite(nowMs)) continue;
      total += Math.max(0, (nowMs - inMs) / 3600000 - num(t.breakTaken) / 60);
    } else if (t.day === todayIso) {
      total += Math.max(0, num(t.actualHours));
    }
  }
  return total;
}

/** The staff ids with any clock in on the venue day, or still clocked in from before it. */
export function clockedInIds(timesheets, todayIso) {
  const ids = new Set();
  for (const t of timesheets || []) {
    if (!t || !t.clockIn || !t.staffId) continue;
    if (t.clockOut == null || t.day === todayIso) ids.add(String(t.staffId));
  }
  return ids;
}

/**
 * Published shifts today whose start was more than LATE_AFTER_MINS ago with no clock in for that
 * person. nowMins: minutes since midnight on the venue clock. Head office people are never late;
 * an open shift (nobody on it) is no one's. Each row carries lateMins.
 */
export function lateOrNoShow(shifts, timesheets, { todayIso, nowMins, headOfficeIds }) {
  if (!todayIso || !Number.isFinite(Number(nowMins))) return [];
  const ho = headOfficeIds || new Set();
  const inIds = clockedInIds(timesheets, todayIso);
  const out = [];
  for (const s of shifts || []) {
    if (!s || s.date !== todayIso || s.status !== 'published' || !s.staffId) continue;
    if (ho.has(String(s.staffId)) || inIds.has(String(s.staffId))) continue;
    const start = hhmmToMins(s.start);
    if (start == null) continue;
    const lateMins = Number(nowMins) - start;
    if (lateMins > LATE_AFTER_MINS) out.push({ ...s, lateMins });
  }
  return out.sort((a, b) => b.lateMins - a.lateMins);
}

/** People clocked in now with no shift of theirs today (head office left out). */
export function notRostered(timesheets, shifts, { todayIso, headOfficeIds }) {
  const ho = headOfficeIds || new Set();
  const rostered = new Set(rosteredToday(shifts, todayIso).map((s) => String(s.staffId)).filter((id) => id && id !== 'null'));
  const seen = new Set();
  return onShiftNow(timesheets).filter((t) => {
    const id = String(t.staffId);
    if (ho.has(id) || rostered.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Planned wage cost of a list of shifts: hours times the rate the rota uses (staff override, else the
 * position rate, else the salaried hourly figure; rateOf, as labour.resolveRate). rates: { [staffId]: override }
 * from the rates door; a staff member with no override reads the position rate. An open shift (no
 * staff) costs its position's rate.
 */
export function plannedCost(shifts, { staffById = {}, rolesMap = {}, rates = {}, contractedWeek } = {}) {
  let total = 0;
  for (const s of (shifts || []).filter(planned)) {
    const hrs = shiftHours(s);
    if (!hrs) continue;
    const member = s.staffId ? staffById[String(s.staffId)] || null : null;
    const role = rolesMap[s.roleKey] || (member ? rolesMap[member.role] : null) || null;
    const override = s.staffId && rates[String(s.staffId)] != null ? Number(rates[String(s.staffId)]) : null;
    const who = member ? { ...member, rateOverride: override != null ? override : (member.rateOverride != null ? member.rateOverride : null) } : null;
    total += hrs * rateOf(who, role, contractedWeek);
  }
  return total;
}

/** Time off requests still waiting for a decision. */
export function pendingTimeOff(rows) {
  return (rows || []).filter((r) => r && r.status === 'pending');
}

/** Onboarding cases not yet complete. */
export function onboardingOpen(rows) {
  return (rows || []).filter((r) => r && r.status !== 'complete' && r.status !== 'cancelled');
}

/**
 * Documents already expired or expiring within DOC_WARN_DAYS of todayIso (a document waiting for
 * review or rejected is not an expiry; a document with no expiry never is). { expired, expiring, rows }.
 */
export function docsDue(docs, todayIso) {
  const out = { expired: [], expiring: [], rows: [] };
  if (!todayIso) return out;
  for (const d of docs || []) {
    if (!d || !d.expiry || d.status === 'pending' || d.status === 'rejected') continue;
    const days = daysBetweenYmd(todayIso, String(d.expiry).slice(0, 10));
    if (days == null || days > DOC_WARN_DAYS) continue;
    const row = { ...d, days };
    (days < 0 ? out.expired : out.expiring).push(row);
    out.rows.push(row);
  }
  return out;
}

/** Open shifts (nobody on them) from fromIso to toIso that still need cover. */
export function openShifts(shifts, { fromIso, toIso }) {
  if (!fromIso || !toIso) return [];
  return (shifts || []).filter((s) => planned(s) && !s.staffId && s.date >= fromIso && s.date <= toIso);
}

/** The whole picture for the screen, from the rows the loaders give. */
export function dashboardFrom({ shifts, timesheets, timeOff, onboarding, docs, staff, rolesMap, rates, settings, todayIso, nowMins, nowMs, headOfficeIds, week }) {
  const staffById = {};
  for (const m of staff || []) if (m && m.id) staffById[String(m.id)] = m;
  const todays = rosteredToday(shifts, todayIso);
  const wk = week || { startIso: '', endIso: '' };
  const weekShifts = (shifts || []).filter((s) => planned(s) && wk.startIso && s.date >= wk.startIso && s.date <= wk.endIso);
  const costOpts = { staffById, rolesMap: rolesMap || {}, rates: rates || {}, contractedWeek: settings?.contractedWeek };
  return {
    onNow: onShiftNow(timesheets),
    rostered: todays,
    plannedHoursToday: plannedHours(todays),
    hoursSoFar: hoursSoFar(timesheets, { todayIso, nowMs }),
    late: lateOrNoShow(shifts, timesheets, { todayIso, nowMins, headOfficeIds }),
    unrostered: notRostered(timesheets, shifts, { todayIso, headOfficeIds }),
    costToday: plannedCost(todays, costOpts),
    waiting: {
      timeOff: pendingTimeOff(timeOff).length,
      onboarding: onboardingOpen(onboarding).length,
      docs: docsDue(docs, todayIso),
      openShifts: openShifts(shifts, { fromIso: todayIso, toIso: wk.endIso }).length,
    },
    week: { ...wk, hours: plannedHours(weekShifts), cost: plannedCost(weekShifts, costOpts), shifts: weekShifts.length },
    staffCount: (staff || []).filter((m) => m && m.status !== 'leaver').length,
  };
}
