// src/lib/usBreaks.test.js: US state meal break rules (5.12.52).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usBreakRule, usMealBreakMins, usBreakWords, US_STATE_BREAKS } from '../../supabase/functions/_shared/usBreaks.js';
import { breakShortfall, venueBreakPolicy } from '../staff/breaks.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('no state chosen (Utah) means no state meal rule', () => {
  const r = usBreakRule({});
  assert.equal(r.meal, null);
  assert.equal(usMealBreakMins(12, r), 0);
  assert.match(usBreakWords(r), /No state meal break rule for adults/);
});

test('California: 30 minutes past 5 hours, a second past 10', () => {
  const r = usBreakRule({ usBreaks: { state: 'CA' } });
  assert.equal(usMealBreakMins(5, r), 0);
  assert.equal(usMealBreakMins(5.5, r), 30);
  assert.equal(usMealBreakMins(10.5, r), 60);
  assert.match(usBreakWords(r), /30 minute meal break on shifts of more than 5 hours, and a second one past 10 hours\. Plus a paid 10 minute rest break/);
});

test('"at least" states are due at exactly the hours', () => {
  const or = usBreakRule({ usBreaks: { state: 'or' } });
  assert.equal(usMealBreakMins(6, or), 30);
  assert.equal(usMealBreakMins(5.9, or), 0);
  const ny = usBreakRule({ usBreaks: { state: 'NY' } });
  assert.equal(usMealBreakMins(6, ny), 0, 'more than 6');
  assert.equal(usMealBreakMins(6.1, ny), 30);
});

test('a venue can type its own rule; a bad one checks nothing', () => {
  assert.equal(usMealBreakMins(7, usBreakRule({ usBreaks: { state: 'custom', mealAfter: 6, mealMins: 20 } })), 20);
  assert.equal(usBreakRule({ usBreaks: { state: 'custom', mealAfter: 0, mealMins: 20 } }).meal, null);
  assert.equal(usBreakRule({ usBreaks: { state: 'ZZ' } }).meal, null, 'an unknown state is no rule');
});

test('every state in the table has sane numbers', () => {
  for (const [k, v] of Object.entries(US_STATE_BREAKS)) {
    assert.match(k, /^[A-Z]{2}$/);
    assert.ok(v.meal.after >= 4 && v.meal.after <= 8 && v.meal.mins >= 20 && v.meal.mins <= 30, k);
  }
});

test('timesheets: a US venue is checked against its state, a UK venue against the WTR as before', () => {
  const ca = venueBreakPolicy({ usBreaks: { state: 'CA' } }, 'US');
  const ut = venueBreakPolicy({}, 'US');
  const uk = venueBreakPolicy({}, null);
  assert.equal(breakShortfall({ grossHours: 7, breakMins: 0, policy: ca }).statutory, 30);
  assert.equal(breakShortfall({ grossHours: 7, breakMins: 0, policy: ca }).level, 'statutory');
  assert.equal(breakShortfall({ grossHours: 7, breakMins: 0, policy: ut }).statutory, 0, 'Utah: no legal minimum');
  assert.equal(breakShortfall({ grossHours: 7, breakMins: 0, policy: uk }).statutory, 20, 'UK unchanged');
  assert.equal(breakShortfall({ grossHours: 7, breakMins: 0 }).statutory, 20, 'no policy reads as UK, as before');
});

test('US only: the setting, the save and the clock out are gated on the country', () => {
  const s = read('src/backoffice/sections/workforce/WfSettings.jsx');
  assert.match(s, /\{pack\.country === 'US' && \(\s+<div[^>]*>\s+<div>\s+<label style=\{labelStyle\}>State break rules<\/label>/);
  assert.match(s, /\.\.\.\(pack\.country === 'US' \? \{ usBreaks: \{ state: usBreakState \|\| ''/);
  const fn = read('supabase/functions/workforce-clock/index.ts');
  assert.match(fn, /if \(usVenue\) \{\s+statutory = usMealBreakMins\(grossHrs, usBreakRule\(vs\)\);\s+\} else \{\s+statutory = grossHrs > 6 \? 20 : 0;/);
  for (const f of ['src/backoffice/sections/workforce/WfTimesheets.jsx', 'src/backoffice/sections/workforce/WfRota.jsx']) {
    assert.match(read(f), /venueBreakPolicy\(settings\?\.settings, activeCountry\(\)\)/, f);
  }
});
