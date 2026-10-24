// supabase/functions/_shared/payPremiums.js
//
// v5.11.101: PAY PREMIUMS, applied. wf_venue_settings.premiums has existed since the Workforce build
// (20260608: "{weekend,bankHoliday,night}") and Back Office saved it on every settings save, but no
// pay calculation ever read it. This file is the one rule, used by payroll (workforce-compute
// payroll.period / payroll.close) and by the rota's planned cost (src/backoffice WfRota), and
// tested by src/lib/payPremiums.test.js. PURE: imports only the holiday calendar.
//
// THE SETTINGS (Workforce settings, Pay premiums):
//   premiums.weekend      percent extra on hours worked on a Saturday or a Sunday
//   premiums.bankHoliday  percent extra on hours worked on a public holiday (the venue's country)
//   premiums.night        percent extra on hours worked between nightFrom and nightTo
//   premiums.nightFrom    'HH:MM', default '23:00'; premiums.nightTo 'HH:MM', default '06:00'
// A blank or 0 premium is off. Where two apply to the same minute, the HIGHER one is paid, never
// both. Only hourly pay earns a premium (a salaried role's equivalent rate does not), and only
// for a position marked premium eligible (wf_roles.premium_eligible, true unless switched off).
// Breaks: the premium hours are the shift's premium minutes scaled by worked hours over clocked
// hours, so an unpaid break comes off the premium in proportion and the premium hours can never
// exceed the hours paid.
//
// NOTHING CHANGES FOR A VENUE WITH NO PREMIUMS SET (every venue on 24 Oct 2026): premiumFor answers
// 0 hours and 0 pay, and payroll adds nothing.

import { isPublicHoliday } from './publicHolidays.js';

const r2 = (n) => Math.round(n * 100) / 100;
const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 0; };
const toMins = (hhmm, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return dflt;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : dflt;
};

/** The premiums the venue set, cleaned: { weekend, bankHoliday, night, nightFrom, nightTo } (minutes for the window). */
export function cleanPremiums(p) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    weekend: pct(src.weekend),
    bankHoliday: pct(src.bankHoliday),
    night: pct(src.night),
    nightFrom: toMins(src.nightFrom, 23 * 60),
    nightTo: toMins(src.nightTo, 6 * 60),
  };
}

/** Does the venue pay any premium at all? */
export function anyPremium(p) {
  const c = cleanPremiums(p);
  return c.weekend > 0 || c.bankHoliday > 0 || c.night > 0;
}

const inNight = (minOfDay, from, to) => (from === to ? false : from < to ? (minOfDay >= from && minOfDay < to) : (minOfDay >= from || minOfDay < to));

/** The venue's wall clock parts of an instant: { iso:'YYYY-MM-DD', dow:0..6 (Sun 0), min } */
const _fmt = new Map();
function wallParts(ms, tz) {
  const zone = tz || 'Europe/London';
  let f = _fmt.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }); _fmt.set(zone, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, dow, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * The premium on one stretch of work.
 * @param {object} a
 * @param {number|string} a.startMs   clock in (ms or ISO)
 * @param {number|string} a.endMs     clock out (ms or ISO)
 * @param {number} a.workedHours      hours paid (after unpaid breaks); defaults to the clocked span
 * @param {number} a.rate             the hourly rate snapshotted on the sheet
 * @param {object} a.premiums         wf_venue_settings.premiums
 * @param {string} [a.tz]             the venue's timezone
 * @param {string} [a.country]        'UK' | 'US' | 'IE' (whose public holidays)
 * @param {boolean} [a.eligible=true] the position earns premiums
 * @param {boolean} [a.hourly=true]   false for a salaried equivalent rate
 * @returns {{ hours:number, pay:number, byKind:{weekend:number, bankHoliday:number, night:number} }}
 */
export function premiumFor(a) {
  const none = { hours: 0, pay: 0, byKind: { weekend: 0, bankHoliday: 0, night: 0 } };
  const p = cleanPremiums(a?.premiums);
  if (!(p.weekend || p.bankHoliday || p.night)) return none;
  if (a.eligible === false || a.hourly === false) return none;
  const rate = Number(a.rate) || 0;
  const s = typeof a.startMs === 'number' ? a.startMs : Date.parse(a.startMs);
  const e = typeof a.endMs === 'number' ? a.endMs : Date.parse(a.endMs);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || rate <= 0) return none;
  const spanMins = Math.round((e - s) / 60000);
  const worked = a.workedHours != null ? Math.max(0, Number(a.workedHours) || 0) : spanMins / 60;
  const scale = spanMins > 0 ? Math.min(1, (worked * 60) / spanMins) : 0;

  // Walk the shift a minute at a time in the venue's clock (a 16 hour shift is under 1,000 steps;
  // the wall clock handles the clocks going forward or back on its own).
  const mins = { weekend: 0, bankHoliday: 0, night: 0 };
  let money = 0;
  let lastIso = null, holiday = false;
  // The venue clock is read again on every whole and half UTC hour (when clocks change) and at
  // midnight; between those it moves one minute a step.
  let w = null;
  for (let t = s; t < e; t += 60000) {
    if (!w || new Date(t).getUTCMinutes() % 30 === 0 || w.min + 1 >= 1440) w = wallParts(t, a.tz);
    else w = { ...w, min: w.min + 1 };
    if (w.iso !== lastIso) { lastIso = w.iso; holiday = p.bankHoliday > 0 && isPublicHoliday(a.country || 'UK', w.iso); }
    const cands = [];
    if (p.weekend && (w.dow === 0 || w.dow === 6)) cands.push(['weekend', p.weekend]);
    if (holiday) cands.push(['bankHoliday', p.bankHoliday]);
    if (p.night && inNight(w.min, p.nightFrom, p.nightTo)) cands.push(['night', p.night]);
    if (!cands.length) continue;
    const [kind, best] = cands.reduce((x, y) => (y[1] > x[1] ? y : x));
    mins[kind] += 1;
    money += best;
  }
  const total = mins.weekend + mins.bankHoliday + mins.night;
  if (!total) return none;
  // money is the sum of percents over premium minutes: pay = rate x (sum of pct / 100) / 60 x scale.
  return {
    hours: r2((total / 60) * scale),
    pay: r2((rate * money * scale) / 100 / 60),
    byKind: { weekend: r2((mins.weekend / 60) * scale), bankHoliday: r2((mins.bankHoliday / 60) * scale), night: r2((mins.night / 60) * scale) },
  };
}

/**
 * A planned shift's premium (the rota's cost), from its date and wall clock times.
 * @param {{date:string,start:string,finish:string,breakMins?:number}} shift
 */
export function plannedPremium(shift, rate, premiums, { country = 'UK', eligible = true, hourly = true } = {}) {
  if (!anyPremium(premiums) || !shift?.date || !shift.start || !shift.finish) return { hours: 0, pay: 0, byKind: { weekend: 0, bankHoliday: 0, night: 0 } };
  // Planned shifts are wall clock times; walk them as UTC with tz 'UTC' so the wall clock is exact.
  const s = Date.parse(`${shift.date}T${shift.start}:00Z`);
  let e = Date.parse(`${shift.date}T${shift.finish}:00Z`);
  if (e <= s) e += 86400000;
  const worked = Math.max(0, (e - s) / 3600000 - (Number(shift.breakMins) || 0) / 60);
  return premiumFor({ startMs: s, endMs: e, workedHours: worked, rate, premiums, tz: 'UTC', country, eligible, hourly });
}

/** The venue's calendar day of an instant ('YYYY-MM-DD'). */
export function venueDay(instant, tz = 'Europe/London') {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  return Number.isFinite(ms) ? wallParts(ms, tz).iso : null;
}

/** The instant (ISO, UTC) the venue's day `dateIso` begins: its local midnight, clock changes included. */
export function venueMidnightIso(dateIso, tz = 'Europe/London') {
  const guess = Date.parse(`${dateIso}T00:00:00Z`);
  const offsetAt = (ms) => {
    const w = wallParts(ms, tz);
    const wallMs = Date.parse(`${w.iso}T00:00:00Z`) + w.min * 60000;
    return wallMs - Math.floor(ms / 60000) * 60000;   // venue wall clock minus UTC, at that instant
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);                              // once more: the offset at the answer itself
  return new Date(t).toISOString();
}

/** 'YYYY-MM-DD' plus n days. */
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The first day of the work week holding `dateIso` (weekStartDow: 0 Sunday ... 6 Saturday; 1 Monday). */
export function workweekStart(dateIso, weekStartDow = 1) {
  const dow = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return plusDays(dateIso, -((dow - weekStartDow + 7) % 7));
}

/**
 * The days to read so every work week touching the period [from, to] is whole: from the first day
 * of the week holding `from` to the last day of the week holding `to` (venue days).
 */
export function workweekSpan(from, to, weekStartDow = 1) {
  return { from: workweekStart(from, weekStartDow), to: plusDays(workweekStart(to, weekStartDow), 6) };
}

/**
 * Overtime hours by work week (federal US rule, simple): in each work week, the hours worked after the
 * first `weekly` (40) are overtime, in the order they were worked. sheets: [{ staff_id, actual_hours,
 * clock_in }]; the VENUE day of clock_in decides the week and the period. Pass every sheet of the
 * whole work weeks touching the period (workweekSpan) and the period { from, to }: a week split by the
 * period's edge is counted whole, and each period keeps only its own sheets' share (a week of 48 hours,
 * 40 before the 15th and 8 after, puts 8 overtime hours in the second period, not 0 in each).
 * Returns { [staff_id]: { regular, overtime } } for the period. weekly null or 0 = no overtime.
 */
export function overtimeSplit(sheets, weekly, tz = 'Europe/London', { weekStartDow = 1, from = null, to = null } = {}) {
  const out = {};
  const inPeriod = (iso) => (!from || iso >= from) && (!to || iso <= to);
  const rows = (sheets || [])
    .filter((t) => t && t.staff_id)
    .map((t) => ({ t, ms: Date.parse(t.clock_in), day: t.clock_in ? venueDay(t.clock_in, tz) : null }))
    .sort((a, b) => (a.ms || 0) - (b.ms || 0));
  const running = {};
  for (const { t, day } of rows) {
    const hrs = Number(t.actual_hours) || 0;
    if (day && !inPeriod(day) && !weekly) continue;
    const take = !day || inPeriod(day);
    const o = take ? (out[t.staff_id] ?? (out[t.staff_id] = { regular: 0, overtime: 0 })) : null;
    if (!weekly || !day) { if (o) o.regular += hrs; continue; }
    const key = `${t.staff_id}|${workweekStart(day, weekStartDow)}`;
    const before = running[key] || 0;
    const after = before + hrs;
    running[key] = after;
    const ot = Math.max(0, after - weekly) - Math.max(0, before - weekly);
    if (o) { o.regular += hrs - ot; o.overtime += ot; }
  }
  for (const o of Object.values(out)) { o.regular = r2(o.regular); o.overtime = r2(o.overtime); }
  return out;
}

/**
 * ONE PAY RULE for a timesheet (v5.11.101), used by everything that writes wf_timesheets.pay_amount
 * (workforce-clock at clock out, manager-approve when a manager edits and approves, Back Office
 * Timesheets) and by payroll (workforce-compute: base pay plus the premium line). Every report's
 * labour reads pay_amount (Daily trading, Stock and GP, the Owner and Manager apps), so reports and
 * payroll agree on premiums.
 *   base    = (worked hours + paid break minutes / 60) x rate, to the penny (exactly as before)
 *   premium = premiumFor(...) on the worked hours (0 with no premiums set)
 *   pay     = base + premium
 * With no premiums set, pay is exactly the old figure.
 */
export function sheetPay({ clockIn, clockOut, actualHours, paidBreakMins = 0, rate, rateSource = null, premiums, tz, country, eligible = true }) {
  const r = Number(rate) || 0;
  const base = r2(Math.max(0, (Number(actualHours) || 0) + (Number(paidBreakMins) || 0) / 60) * r);
  const prem = clockIn && clockOut
    ? premiumFor({ startMs: clockIn, endMs: clockOut, workedHours: Number(actualHours) || 0, rate: r, premiums, tz, country, eligible, hourly: rateSource !== 'salaried' })
    : { hours: 0, pay: 0 };
  return { base, premium: prem.pay, premiumHours: prem.hours, pay: r2(base + prem.pay) };
}
