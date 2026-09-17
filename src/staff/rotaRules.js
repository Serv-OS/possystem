// src/staff/rotaRules.js
//
// The rota rules engine (v5.8.94). Pure: no imports, no Supabase, tested by rotaRules.test.js.
//
// WHY: "Build with AI" used to insert whatever the model returned. It never saw opening hours,
// standard shifts or time off, and nothing checked the answer, so it put people on seven days
// in a row and outside trading hours (Peter, 17 Sep 2026). Now the model only PROPOSES. Every
// proposed shift goes through checkProposed(), and fillCoverage() then tops the week up to each
// section's minimum cover from the venue's standard shifts. If the model is down or returns
// rubbish the rota is still built, and it is still valid.
//
// HARD RULES (a shift that breaks one is rejected, with the reason):
//   known person and a date in the week · venue open that day · inside opening hours (with a
//   setup and close down grace) · not on approved leave · not marked unavailable that weekday ·
//   no overlap with another shift · minimum rest between working days · max days in a row ·
//   contracted or target weekly hours not exceeded.
// Standard shifts: when the venue has any, a proposed shift is snapped to the closest one.

export const DEFAULT_RULES = { maxDaysInRow: 5, minRestHours: 11, openGraceMins: 60 };

const toMins = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const spanOf = (start, finish) => { const s = toMins(start); let f = toMins(finish); if (f <= s) f += 1440; return [s, f]; };
const fmt = (mins) => { const m = ((Math.round(mins) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const ordinal = (iso) => { const [y, mo, d] = String(iso).split('-').map(Number); return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1) / 86400000); };
const dayIdx = (iso) => (new Date(iso + 'T00:00:00').getDay() + 6) % 7;            // Mon=0 … Sun=6 (wf_availability)
const OPEN_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const norm = (s) => String(s || '').trim().toLowerCase();

export const shiftHours = (s) => { const [a, b] = spanOf(s.start, s.finish); return Math.max(0, (b - a - (Number(s.breakMins) || 0)) / 60); };

/**
 * Opening windows for a date as [[openMin, closeMin], …]. null = the venue has no opening
 * hours set up (unknown: nothing is rejected for it). [] = closed that day.
 */
export function openWindowsOn(openingHours, dateIso) {
  const weekly = openingHours?.weekly;
  if (!weekly || !OPEN_KEYS.some(k => (weekly[k] || []).length)) return null;
  if ((openingHours.closedDates || []).includes(dateIso)) return [];
  return (weekly[OPEN_KEYS[dayIdx(dateIso)]] || []).filter(w => w?.open && w?.close).map(w => spanOf(w.open, w.close));
}

function withinOpening(start, finish, windows, grace) {
  if (windows === null) return true;
  if (!windows.length) return false;
  const [s, f] = spanOf(start, finish);
  const lo = Math.min(...windows.map(w => w[0])) - grace;
  const hi = Math.max(...windows.map(w => w[1])) + grace;
  return s >= lo && f <= hi;
}

/** Snap a proposed shift to the venue's closest standard shift (same section preferred). */
export function snapToTemplate(p, templates) {
  const list = (templates || []).filter(t => t?.start && t?.finish);
  if (!list.length) return p;
  const [ps, pf] = spanOf(p.start, p.finish);
  const sameSection = list.filter(t => t.section && norm(t.section) === norm(p.section));
  const pool = sameSection.length ? sameSection : list;
  let best = null, bestD = Infinity;
  for (const t of pool) { const [ts, tf] = spanOf(t.start, t.finish); const d = Math.abs(ts - ps) + Math.abs(tf - pf); if (d < bestD) { bestD = d; best = t; } }
  return { ...p, start: best.start, finish: best.finish, breakMins: best.breakMins != null ? Number(best.breakMins) : p.breakMins, template: best.name || null };
}

const approvedLeaveOn = (timeOff, staffId, iso) => (timeOff || []).find(l => l.staffId === staffId && l.status === 'approved' && l.startDate && l.endDate && l.startDate <= iso && iso <= l.endDate) || null;
const availabilityOn = (availability, staffId, iso) => { const row = (availability || []).find(a => a.staffId === staffId); return row?.perDay?.find(x => x.day === dayIdx(iso))?.state || 'available'; };

/** Why this shift cannot be placed, or null when it can. `placed` = existing + already accepted. */
export function whyNot(p, placed, ctx) {
  const rules = { ...DEFAULT_RULES, ...(ctx.rules || {}) };
  const person = (ctx.staff || []).find(s => s.staffId === p.staffId);
  if (!person) return 'unknown person';
  if (!p.date || !(ctx.dates || []).includes(p.date)) return 'date outside the week';
  if (!p.start || !p.finish) return 'no times';
  const windows = openWindowsOn(ctx.openingHours, p.date);
  if (windows !== null && !windows.length) return 'venue closed that day';
  if (!withinOpening(p.start, p.finish, windows, rules.openGraceMins)) return 'outside opening hours';
  if (approvedLeaveOn(ctx.timeOff, p.staffId, p.date)) return 'on approved leave';
  if (availabilityOn(ctx.availability, p.staffId, p.date) === 'unavailable') return 'marked unavailable that day';
  const mine = placed.filter(x => x.staffId === p.staffId);
  const [s, f] = spanOf(p.start, p.finish);
  const a0 = ordinal(p.date) * 1440 + s, a1 = ordinal(p.date) * 1440 + f;
  for (const o of mine) {
    const [os, of] = spanOf(o.start, o.finish);
    const b0 = ordinal(o.date) * 1440 + os, b1 = ordinal(o.date) * 1440 + of;
    if (a0 < b1 && b0 < a1) return 'overlaps another shift';
    if (o.date !== p.date) { const gap = Math.max(a0 - b1, b0 - a1); if (gap < rules.minRestHours * 60) return `less than ${rules.minRestHours}h rest between shifts`; }
  }
  const worked = new Set(mine.map(o => ordinal(o.date))); const d0 = ordinal(p.date);
  if (!worked.has(d0)) {
    let run = 1; for (let d = d0 - 1; worked.has(d); d--) run++; for (let d = d0 + 1; worked.has(d); d++) run++;
    if (run > rules.maxDaysInRow) return `more than ${rules.maxDaysInRow} days in a row`;
  }
  const cap = Number(person.maxWeeklyHours) || 0;
  if (cap > 0) { const hrs = mine.filter(o => (ctx.dates || []).includes(o.date)).reduce((t, o) => t + shiftHours(o), 0) + shiftHours(p); if (hrs > cap + 0.01) return `over ${cap} weekly hours`; }
  return null;
}

/** Run every proposed shift through the rules. Returns { accepted, rejected:[{…shift, reason}] }. */
export function checkProposed({ proposed = [], existing = [], ...ctx }) {
  const accepted = [], rejected = [];
  const placed = [...existing];
  for (const raw of proposed) {
    if (!raw || typeof raw !== 'object') continue;
    const p = snapToTemplate({ ...raw, breakMins: Number(raw.breakMins) || 0 }, ctx.templates);
    const reason = whyNot(p, placed, ctx);
    if (reason) { rejected.push({ ...p, reason }); continue; }
    accepted.push(p); placed.push(p);
  }
  return { accepted, rejected };
}

/**
 * Top the week up to each section's minimum cover, from standard shifts, with people of that
 * section, fewest hours first (preferred days first). Returns { added, gaps:[{date, section, short}] }.
 */
export function fillCoverage({ existing = [], accepted = [], sections = [], ...ctx }) {
  const placed = [...existing, ...accepted];
  const added = [], gaps = [];
  const hoursOf = (id) => placed.filter(x => x.staffId === id).reduce((t, o) => t + shiftHours(o), 0);
  for (const date of (ctx.dates || [])) {
    const windows = openWindowsOn(ctx.openingHours, date);
    if (windows !== null && !windows.length) continue;   // closed
    for (const sec of sections) {
      const need = Number(sec.minCoverage) || 0;
      if (need <= 0) continue;
      const have = () => new Set(placed.filter(x => x.date === date && norm(x.section) === norm(sec.name)).map(x => x.staffId)).size;
      const tpl = (ctx.templates || []).find(t => t.section && norm(t.section) === norm(sec.name)) || (ctx.templates || [])[0]
        || (windows && windows.length ? { start: fmt(windows[0][0]), finish: fmt(Math.min(windows[0][0] + 480, Math.max(...windows.map(w => w[1])))), breakMins: 30 } : { start: '09:00', finish: '17:00', breakMins: 30 });
      const pool = (ctx.staff || []).filter(s => norm(s.section) === norm(sec.name))
        .sort((a, b) => (availabilityOn(ctx.availability, b.staffId, date) === 'preferred') - (availabilityOn(ctx.availability, a.staffId, date) === 'preferred') || hoursOf(a.staffId) - hoursOf(b.staffId));
      for (const person of pool) {
        if (have() >= need) break;
        if (placed.some(x => x.staffId === person.staffId && x.date === date)) continue;
        const p = { staffId: person.staffId, date, start: tpl.start, finish: tpl.finish, breakMins: Number(tpl.breakMins) || 0, section: sec.name, template: tpl.name || null, filled: true };
        if (whyNot(p, placed, ctx)) continue;
        added.push(p); placed.push(p);
      }
      if (have() < need) gaps.push({ date, section: sec.name, short: need - have() });
    }
  }
  return { added, gaps };
}

/**
 * Learned sales forecast: for each target date, the recency weighted average of the same
 * weekday over the history (days with no sales are closed days and are ignored), nudged by
 * the recent trend (last 4 weeks against the 4 before, clamped). Rounded to the nearest 10.
 * Returns { iso: { amount, samples } }; a date with no history is absent.
 */
export function suggestForecast(history = {}, targetIsos = [], { decay = 0.85 } = {}) {
  const days = Object.keys(history).filter(k => Number(history[k]) > 0).sort();
  if (!days.length) return {};
  const last = ordinal(days[days.length - 1]);
  const sumBetween = (from, to) => days.reduce((t, k) => { const o = ordinal(k); return o > from && o <= to ? t + Number(history[k]) : t; }, 0);
  const recent = sumBetween(last - 28, last), before = sumBetween(last - 56, last - 28);
  const trend = before > 0 && recent > 0 ? Math.min(1.15, Math.max(0.85, recent / before)) : 1;
  const out = {};
  for (const iso of targetIsos) {
    const wd = dayIdx(iso);
    const same = days.filter(k => dayIdx(k) === wd && ordinal(k) < ordinal(iso)).reverse();   // newest first
    if (!same.length) continue;
    let num = 0, den = 0;
    same.forEach((k, i) => { const w = Math.pow(decay, i); num += w * Number(history[k]); den += w; });
    out[iso] = { amount: Math.round((num / den) * trend / 10) * 10, samples: same.length };
  }
  return out;
}
