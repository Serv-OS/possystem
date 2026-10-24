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

/**
 * Overtime hours by work week (federal US rule, simple): hours over `weekly` in a Monday to Sunday
 * week. sheets: [{ staff_id, actual_hours, clock_in }] (venue local date of clock_in decides the week).
 * Returns { [staff_id]: { regular, overtime } }. weekly null or 0 = no overtime (the UK).
 */
export function overtimeSplit(sheets, weekly, tz = 'Europe/London') {
  const out = {};
  const byWeek = {};
  for (const t of sheets || []) {
    const hrs = Number(t.actual_hours) || 0;
    const sid = t.staff_id;
    if (!sid) continue;
    const o = out[sid] ?? (out[sid] = { regular: 0, overtime: 0 });
    if (!weekly || !t.clock_in) { o.regular += hrs; continue; }
    const w = wallParts(Date.parse(t.clock_in), tz);
    const d = new Date(`${w.iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = `${sid}|${d.toISOString().slice(0, 10)}`;
    byWeek[key] = (byWeek[key] || 0) + hrs;
  }
  for (const [key, hrs] of Object.entries(byWeek)) {
    const sid = key.split('|')[0];
    const o = out[sid];
    o.regular += Math.min(hrs, weekly);
    o.overtime += Math.max(0, hrs - weekly);
  }
  for (const o of Object.values(out)) { o.regular = r2(o.regular); o.overtime = r2(o.overtime); }
  return out;
}
