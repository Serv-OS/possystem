// usBreaks.js: US state meal break rules for adult staff (5.12.52).
//
// Federal law has no meal or rest break rule. Some states do. Workforce settings (US venues only) picks
// the venue's state; Timesheets, the Manager app and the clock out auto deduct then check the MEAL
// break against that state instead of the UK rule they used before. A state with no adult rule (Utah,
// Texas, Florida and most others) checks nothing beyond the venue's own default break.
//
// The table is the common adult rule for each state, plainly simplified: some states differ for minors,
// some industries are exempt, some allow waivers or on duty meals by agreement. Rest breaks (10 minutes
// paid for every 4 hours, where a state has them) are shown as a reminder only: they are paid and not
// clocked, so a timesheet cannot show them. Custom lets a venue type its own numbers. Check the current
// law for your state; this is not legal advice.
//
// PURE: no imports; runs under node --test and in Deno.

// meal: minutes due once the shift (time on shift, break included) passes `after` hours;
// atLeast: due at exactly `after` hours too. second: a second meal past that many hours (California).
export const US_STATE_BREAKS = {
  CA: { label: 'California', meal: { after: 5, mins: 30, second: 10 }, rest: { every: 4, mins: 10 } },
  CO: { label: 'Colorado', meal: { after: 5, mins: 30 }, rest: { every: 4, mins: 10 } },
  CT: { label: 'Connecticut', meal: { after: 7.5, mins: 30, atLeast: true } },
  DE: { label: 'Delaware', meal: { after: 7.5, mins: 30, atLeast: true } },
  IL: { label: 'Illinois', meal: { after: 7.5, mins: 20, atLeast: true } },
  MA: { label: 'Massachusetts', meal: { after: 6, mins: 30 } },
  ME: { label: 'Maine', meal: { after: 6, mins: 30, atLeast: true } },
  ND: { label: 'North Dakota', meal: { after: 5, mins: 30 } },
  NH: { label: 'New Hampshire', meal: { after: 5, mins: 30 } },
  NV: { label: 'Nevada', meal: { after: 8, mins: 30, atLeast: true }, rest: { every: 4, mins: 10 } },
  NY: { label: 'New York', meal: { after: 6, mins: 30 } },
  OR: { label: 'Oregon', meal: { after: 6, mins: 30, atLeast: true }, rest: { every: 4, mins: 10 } },
  RI: { label: 'Rhode Island', meal: { after: 6, mins: 20, atLeast: true } },
  TN: { label: 'Tennessee', meal: { after: 6, mins: 30, atLeast: true } },
  WA: { label: 'Washington', meal: { after: 5, mins: 30 }, rest: { every: 4, mins: 10 } },
  WV: { label: 'West Virginia', meal: { after: 6, mins: 20, atLeast: true } },
};

/**
 * The venue's rule from Workforce settings: settings.usBreaks = { state, mealAfter, mealMins }.
 * state '' (or missing) = no state rule; 'custom' = the venue's own numbers. Returns
 * { state, label, meal: {after, mins, atLeast?, second?} | null, rest: {every, mins} | null }.
 */
export function usBreakRule(settings = null) {
  const b = (settings && settings.usBreaks) || {};
  const st = String(b.state || '').toUpperCase();
  if (st === 'CUSTOM') {
    const after = Number(b.mealAfter), mins = Number(b.mealMins);
    const ok = after > 0 && after <= 24 && mins > 0 && mins <= 120;
    return { state: 'custom', label: 'Your own rule', meal: ok ? { after, mins } : null, rest: null };
  }
  const s = US_STATE_BREAKS[st];
  if (!s) return { state: '', label: 'No state rule (federal)', meal: null, rest: null };
  return { state: st, label: s.label, meal: s.meal, rest: s.rest || null };
}

/** Meal break minutes due for a stretch on shift of `grossHours` under `rule` (0 when none is due). */
export function usMealBreakMins(grossHours, rule) {
  const h = Number(grossHours) || 0;
  const m = rule && rule.meal;
  if (!m) return 0;
  const due = (after) => (m.atLeast ? h >= after : h > after);
  if (!due(m.after)) return 0;
  return m.second && h > m.second ? m.mins * 2 : m.mins;
}

/** One line for screens: what the rule asks, in words. */
export function usBreakWords(rule) {
  if (!rule || !rule.meal) return 'No state meal break rule for adults (federal law has none). Your own default break still applies.';
  const m = rule.meal;
  const when = `${m.atLeast ? 'at least' : 'more than'} ${m.after} hours`;
  let s = `A ${m.mins} minute meal break on shifts of ${when}`;
  if (m.second) s += `, and a second one past ${m.second} hours`;
  s += '.';
  if (rule.rest) s += ` Plus a paid ${rule.rest.mins} minute rest break for every ${rule.rest.every} hours (not clocked).`;
  return s;
}
