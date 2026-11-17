// src/backoffice/sections/headoffice/hqSlice2Wiring.test.js
//
// Head office hub, slice 2 (safe and banking, targets, Operations figures). These tests read the
// source files as text, the hqWiring.test.js way, and pin the wiring: the two new routes sit in the
// sidebar list and the flat NAV, HeadOffice renders both, the safe screen posts the till's own
// events through the ledger rules and never writes a cash figure, Daily numbers no longer takes
// cash by hand, and no file of the slice carries an en or em dash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NAV_IA, routesOfRow, canOpenRoute } from '../../../lib/boSections.js';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');
const NEW_ROUTES = ['hq-safe', 'hq-targets'];
// Built from code points so this file never holds the characters it forbids.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('Safe and banking and Targets sit under Head office, last, and fail closed like the rest', () => {
  const row = NAV_IA.find((r) => r.label === 'Head office');
  assert.ok(row, 'a Head office row');
  const routes = routesOfRow(row);
  assert.deepEqual(routes.slice(-2), NEW_ROUTES);
  assert.equal(routes.length, 7);
  assert.deepEqual(row.children.slice(-2).map((c) => c[1]), ['Safe and banking', 'Targets']);
  for (const id of NEW_ROUTES) {
    assert.equal(canOpenRoute(id, { role: 'owner', sections: null }), true);
    assert.equal(canOpenRoute(id, { role: 'manager', sections: ['workforce', 'reports'] }), false, `${id} refused to a login with a list`);
  }
});

test('BackOfficeApp names both in its flat NAV and HeadOffice routes both to their screens', () => {
  const bo = read('../../BackOfficeApp.jsx');
  assert.match(bo, /\{ id:'hq-safe',\s+label:'Safe and banking',\s+icon:'lock',\s+group:'Head office' \}/);
  assert.match(bo, /\{ id:'hq-targets',\s+label:'Targets',\s+icon:'target',\s+group:'Head office' \}/);
  const icons = read('../../../components/ServOSIcons.jsx');
  for (const name of ['lock', 'target']) assert.match(icons, new RegExp(`^  ${name}: `, 'm'), `icon ${name} exists`);
  const container = read('../HeadOffice.jsx');
  assert.match(container, /import HqSafe from '\.\/headoffice\/HqSafe';/);
  assert.match(container, /import HqTargets from '\.\/headoffice\/HqTargets';/);
  assert.match(container, /case 'hq-safe': return <HqSafe hq=\{hq\} go=\{go\} \/>;/);
  assert.match(container, /case 'hq-targets': return <HqTargets hq=\{hq\} go=\{go\} \/>;/);
  assert.match(container, /Seven screens live in/);
});

test('HqSafe is fed by the till through the ledger rules and never writes a cash figure by hand', () => {
  const src = read('./HqSafe.jsx');
  assert.match(src, /import \{[^}]*\bwaitingItems\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/hq\/safeLedger\.js';/s, 'waitingItems comes from the lib');
  assert.match(src, /\bwaitingItems\(\{/, 'the waiting list is the lib\'s');
  assert.match(src, /\bmovementsFromItems\(picked, \{/, 'the ticked rows become ledger rows through the lib');
  assert.match(src, /businessDateOf: \(i\) => businessDateFor\(i\.at, clock\)/, 'each row is dated on the site\'s business day');
  assert.match(src, /addSafeMovements\(movementsFromItems\(/, 'and posted through the data layer');
  assert.doesNotMatch(src, /cash_on_hand/, 'the safe never writes the typed cash column');
  assert.doesNotMatch(src, /saveDailyNumbers/, 'nor goes near Daily numbers');
  assert.match(src, /\bcountOutcome\(/);
  assert.match(src, /\bdenominationsTotal\(/);
  assert.match(src, /\bsuggestedDeposit\(balance, keepBack\)/);
  assert.match(src, /\bdepositNextStatus\(/);
  assert.match(src, /setDepositStatus\(d, 'cancelled'/);
  assert.equal((src.match(/window\.confirm\(/g) || []).length, 1, 'one confirm: cancelling a deposit');
  assert.match(src, /<AbsentCard /);
  assert.match(src, /Nothing waiting/);
  assert.match(src, /Every cash up and drop is in the safe\./);
  assert.match(src, /ragOf\('cash_held'/);
  assert.match(src, /ragOf\('unbanked_days'/);
  assert.match(src, /ragOf\('safe_variance', Math\.abs\(lastVar\)/);
});

test('HqTargets saves through the lib rule and reads only for a non owner', () => {
  const src = read('./HqTargets.jsx');
  assert.match(src, /\bbandProblem\(metric\.key, g, a\)/, 'every save runs the band rule');
  assert.match(src, /\bbandWords\(m\.key, resolved\[m\.key\]/, 'the colours are explained per row');
  assert.match(src, /isCompanyOwner\(hq\.orgId\)/);
  assert.match(src, /isOwner: owner === true/, 'only a strict true may edit');
  assert.match(src, /Only a company owner can change targets\./);
  assert.match(src, /saveTarget\(\{ location_id: locationId, metric: metric\.key, green_to: Number\(g\), amber_to: Number\(a\) \}/);
  assert.match(src, /deleteTarget\(row\.id\)/);
  assert.match(src, /<AbsentCard /);
});

test('Daily numbers no longer takes cash by hand; the scorecard reads the safe', () => {
  const numbers = read('./HqNumbers.jsx');
  assert.doesNotMatch(numbers, /cash_on_hand/, 'no cash_on_hand box, column or key');
  assert.match(numbers, /Cash comes from the safe now: see Safe and banking\./);
  assert.match(numbers, /export const NUMBER_KEYS = \[/);
  assert.match(numbers, /export function rowFromForm\(/);
  const score = read('./HqScorecard.jsx');
  assert.match(score, /\bcashSummary\(/);
  assert.match(score, /\bopsSiteStats\(/);
  assert.match(score, /\bresolveTargets\(targets, s\.id\)/);
  assert.match(score, /ragOf\('prime_cost_pct', row\.prime, band\.prime_cost_pct\)/);
  assert.doesNotMatch(score, /PRIME_COST_TARGET/, 'the fixed 60 is gone from the scorecard');
  assert.match(score, /dates: \[cal\]/, 'Operations today is the site\'s calendar day');
  const deps = read('./HqDepartments.jsx');
  assert.match(deps, /Missed opening checks/);
  assert.match(deps, /Missed closing checks/);
  assert.match(deps, /Urgent repairs/);
  assert.match(deps, /go\('hq-safe'\)/);
  assert.match(deps, /go\('hq-scorecard'\)/);
  assert.doesNotMatch(deps, /PRIME_COST_TARGET/);
});

test('no en or em dash in any headoffice file or the four slice 2 lib files', () => {
  const files = readdirSync(here('.')).filter((f) => /\.(jsx|js)$/.test(f));
  assert.ok(files.includes('HqSafe.jsx') && files.includes('HqTargets.jsx'));
  for (const f of [...files, '../HeadOffice.jsx', '../../../lib/hq/targets.js', '../../../lib/hq/safeLedger.js', '../../../lib/hq/opsStats.js', '../../../lib/hq/data.js']) {
    assert.doesNotMatch(read(f), DASHES, `${f} has no en or em dash`);
  }
});
