// src/staff/breaks.js
//
// The ONE break rule. Extracted from labour.js in v5.5.990 because there were
// three different answers to "was that break long enough" living in three
// places, and none of them answered the question a manager actually asks:
//
//   Back Office     statutoryBreakMins(NET worked hours, dob)   → WTR only
//   workforce-clock the same rule re-inlined against GROSS hours → disagreed at 6h
//   Manager app     a hardcoded 360 minutes, blind to age       → third answer
//
// None compared the break against what the shift was ROSTERED with, so "took
// 10 minutes of a planned 30" was invisible on every screen.
//
// Deliberately dependency-free (labour.js pulls in ./seed, which Node's test
// runner can't resolve) so this can be unit-tested directly. See
// breakShortfall.test.js.

/**
 * UK statutory rest break due for a worked stretch (Working Time Regulations
 * 1998, reg 12): adults get a 20-min uninterrupted break when working MORE
 * than 6 hours; under-18s (young workers) get 30 mins when working more than
 * 4.5 hours. The break need not be paid — that's venue policy.
 *
 * `hours` is the length of the WORKING PERIOD, i.e. gross time on shift
 * including the break, because that is what reg 12 turns on.
 * `dob` optional ISO date; absent means we cannot know they are under 18 and
 * the adult rule applies. Returns the minutes due (0 if none).
 */
export function statutoryBreakMins(hours, dob) {
  const hrs = Number(hours) || 0;
  if (dob) {
    const age = (Date.now() - new Date(dob + 'T00:00:00').getTime()) / (365.25 * 86400000);
    if (age < 18 && hrs > 4.5) return 30;
  }
  return hrs > 6 ? 20 : 0;
}

/** Venue break policy fallback. The Settings form shows 30 when nothing is
 *  saved, and the rota has always used 30, so this is what "unset" has always
 *  meant in practice — named once here instead of being re-guessed with a
 *  different number at each call site (the rota said 30, manual timesheets
 *  said 0, for the same unconfigured venue). */
export const DEFAULT_BREAK_MINS = 30;
/** Shift length above which the venue's default break is expected, when the
 *  venue hasn't set its own threshold. Matches the clock-out auto-deduct. */
export const DEFAULT_BREAK_THRESHOLD_HRS = 6;

/** The venue's break policy, resolved once so every screen agrees. Pass the
 *  `settings` jsonb bag (i.e. `settings.settings`), not the whole row. */
export function venueBreakPolicy(bag) {
  const s = bag || {};
  return {
    defaultMins: s.defaultBreakMins == null ? DEFAULT_BREAK_MINS : Math.max(0, Number(s.defaultBreakMins) || 0),
    thresholdHrs: s.autoBreakHours == null ? DEFAULT_BREAK_THRESHOLD_HRS : Math.max(1, Number(s.autoBreakHours) || DEFAULT_BREAK_THRESHOLD_HRS),
    autoDeduct: s.autoBreak === true,
    paid: s.paidBreaks === true,
    isSet: s.defaultBreakMins != null,   // false = nothing saved, we're on the fallback
  };
}

/**
 * Was the break shorter than it should have been, and by how much?
 *
 * TWO expectations, reported apart because they mean different things:
 *
 *   STATUTORY — the WTR legal minimum. Falling short is a compliance matter
 *     and no venue setting makes it acceptable.
 *   EXPECTED  — the break the shift was ROSTERED with, or failing that the
 *     venue's own default on a long enough shift. Falling short means someone
 *     worked through time you planned as a break. A management matter.
 *
 * `grossHours` must be the FULL time on shift INCLUDING the break. Passing net
 * worked hours understates it, which is exactly why the Back Office badge and
 * the clock-out rule disagreed at the 6h boundary before v5.5.990.
 */
export function breakShortfall({
  grossHours = 0,
  breakMins = 0,
  dob = null,
  plannedBreakMins = null,
  policy = null,
} = {}) {
  const gross = Number(grossHours) || 0;
  const taken = Math.max(0, Number(breakMins) || 0);
  const statutory = statutoryBreakMins(gross, dob);

  // What this shift was meant to get: the roster's own number wins, because a
  // manager set it deliberately for this shift. Otherwise the venue default,
  // but only once the shift is long enough to warrant one.
  let expected = 0;
  let expectedFrom = 'none';
  if (plannedBreakMins != null) {
    expected = Math.max(0, Number(plannedBreakMins) || 0);
    expectedFrom = 'shift';
  } else if (policy && gross > policy.thresholdHrs) {
    expected = policy.defaultMins;
    expectedFrom = 'venue';
  }

  const shortStatutory = Math.max(0, statutory - taken);
  const shortExpected = Math.max(0, expected - taken);
  return {
    statutory, expected, expectedFrom, taken,
    shortStatutory, shortExpected,
    // Worst problem first — the badge colour keys off this.
    level: shortStatutory > 0 ? 'statutory' : shortExpected > 0 ? 'policy' : 'none',
  };
}

/** Gross time on shift from a net worked figure plus the break taken. The DB
 *  stores actual_hours already NET of break, so this reconstitutes the working
 *  period that the statutory test needs. */
export function grossFromNet(netHours, breakMins) {
  return (Number(netHours) || 0) + Math.max(0, Number(breakMins) || 0) / 60;
}
