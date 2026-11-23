// src/backoffice/sections/headoffice/hqWiring.test.js
//
// 16 Nov 2026, Head office hub. These tests read the source files as text and pin the wiring:
// the seven routes sit under Head office in the sidebar list, BackOfficeApp renders the group for
// every hq- route, the hub's copy carries no en or em dash, and the Owner inbox is shown only
// once isCompanyOwner (the database's own answer) has said true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NAV_IA, routesOfRow, canOpenRoute, filterNav } from '../../../lib/boSections.js';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');
const ROUTES = ['hq-scorecard', 'hq-departments', 'hq-projects', 'hq-checkin', 'hq-numbers', 'hq-safe', 'hq-targets'];
// Built from code points so this file never holds the characters it forbids.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('the seven routes sit under Head office, right after Overview, with no section key of their own', () => {
  const row = NAV_IA.find((r) => r.label === 'Head office');
  assert.ok(row, 'a Head office row');
  assert.equal(NAV_IA.indexOf(row), 1);
  assert.deepEqual(routesOfRow(row), ROUTES);
  assert.deepEqual(row.children.map((c) => c[1]), ['Scorecard', 'Departments', 'Internal projects', 'Weekly check in', 'Daily numbers', 'Safe and banking', 'Targets']);
  // Fail closed: a login with a list of sections never sees the hub; owners and unlimited logins do.
  for (const id of ROUTES) {
    assert.equal(canOpenRoute(id, { role: 'owner', sections: null }), true);
    assert.equal(canOpenRoute(id, { role: 'manager', sections: ['workforce', 'reports', 'team', 'customers'] }), false);
  }
  assert.equal(filterNav(NAV_IA, { role: 'manager', sections: ['reports'] }).some((r) => r.label === 'Head office'), false);
});

test('BackOfficeApp renders HeadOffice for every hq- route and names the seven in its flat list', () => {
  const bo = read('../../BackOfficeApp.jsx');
  assert.match(bo, /import HeadOffice from '\.\/sections\/HeadOffice';/);
  assert.match(bo, /\{section\?\.startsWith\('hq-'\) && <HeadOffice section=\{section\} orgCtx=\{orgCtx\} setSection=\{setSection\} \/>\}/);
  for (const id of ROUTES) assert.match(bo, new RegExp(`\\{ id:'${id}',\\s+label:'[^']+',\\s+icon:'[a-zA-Z]+',\\s+group:'Head office' \\}`), `${id} in NAV with its title`);
  const container = read('../HeadOffice.jsx');
  for (const id of ROUTES) assert.ok(container.includes(`case '${id}'`), `HeadOffice switches on ${id}`);
  assert.match(container, /export default function HeadOffice\(\{ section, orgCtx, setSection \}\)/);
});

test('no en or em dash anywhere under headoffice/, and the hub never touches the till store', () => {
  const files = readdirSync(here('.')).filter((f) => /\.(jsx|js)$/.test(f));
  assert.ok(files.length >= 8, `found ${files.length} files`);
  for (const f of [...files, '../HeadOffice.jsx']) {
    const src = read(f);
    assert.doesNotMatch(src, DASHES, `${f} has no en or em dash`);
    assert.doesNotMatch(src, /from '[./]*\/store'|useStore\(/, `${f} does not read the till store`);
  }
});

test('HqCheckin shows the Owner inbox only when isCompanyOwner answered true', () => {
  const src = read('./HqCheckin.jsx');
  assert.match(src, /import \{[^}]*isCompanyOwner[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/hq\/data\.js';/);
  assert.match(src, /const \[isOwner, setIsOwner\] = useState\(false\);/, 'nobody is an owner until the database says so');
  assert.match(src, /setIsOwner\(owner === true\);/, 'only a strict true opens the inbox');
  assert.match(src, /right=\{isOwner \? <TabRow tabs=\{\[\['write', 'My check in'\], \['inbox', 'Owner inbox'\]\]\}/, 'the inbox tab exists only for an owner');
  assert.match(src, /\{tab === 'inbox' && isOwner && <OwnerInbox/, 'and the inbox renders only for an owner');
  assert.equal((src.match(/<OwnerInbox/g) || []).length, 1, 'one door to the inbox');
  assert.doesNotMatch(src, /ownerRole/, 'the role word on orgCtx is not what opens the inbox');
});

test('every hub screen handles a database without the tables with the one calm card', () => {
  for (const f of ['HqScorecard', 'HqDepartments', 'HqProjects', 'HqCheckin', 'HqNumbers', 'HqSafe', 'HqTargets']) {
    const src = read(`./${f}.jsx`);
    assert.match(src, /<AbsentCard /, `${f} shows the calm card`);
    assert.match(src, /absent/, `${f} reads absent`);
    assert.doesNotMatch(src, /\balert\(/, `${f} never alerts`);
  }
  assert.match(read('./hqUi.jsx'), /Head office is not set up in the database yet/);
  // Two confirms in the hub: the task delete, and cancelling a bank deposit (slice 2).
  const detail = read('./HqProjectDetail.jsx');
  assert.equal((detail.match(/window\.confirm\(/g) || []).length, 1);
  assert.equal((read('./HqSafe.jsx').match(/window\.confirm\(/g) || []).length, 1);
  for (const f of ['HqScorecard', 'HqDepartments', 'HqProjects', 'HqCheckin', 'HqNumbers', 'HqTargets', 'hqUi']) assert.doesNotMatch(read(`./${f}.jsx`), /confirm\(/, `${f} never confirms`);
});
