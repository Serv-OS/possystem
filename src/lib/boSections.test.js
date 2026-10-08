// 8 Oct 2026: Back Office section access. Peter: "from the back office when we can invite someone
// to the back office we need to be able to limit what they can see via each tab. MO is a
// franchisee ... he cannot mess with menus, inventory, produce etc. We only want to give him
// access to workforce, reports, team and customers, nothing else."
//
// The rules are pure (lib/boSections.js and supabase/functions/_shared/boSectionRules.js). The
// rest of this file pins the wiring: one list of keys in three places, the render guard and the
// setter guard in the screen, the fail closed profile read, and create-user holding the
// "never more than its creator" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NAV_IA, SECTIONS, SECTION_KEY_BY_LABEL, BO_SECTION_KEYS, EVERYTHING, FRANCHISEE_SECTIONS, PUSH_TO_POS_SECTIONS,
  allowedKeys, canOpenRoute, firstAllowedRoute, filterNav, guardRoute, capSections, canPushToPos,
  sectionKeyOfRoute, sectionKeyOfRow, routesOfRow, buildRouteSections,
  sectionsToStore, sectionsToTicks, describeSections, canEditSectionsFor,
  checkSections, storedSections, withinSections, sameSections, sectionsFromAnswer, isEverythingRole,
  isSectionsColumnMissing, missingProfileColumn, readProfileRow, sectionsFromProfileRow, PROFILE_COLUMNS,
} from './boSections.js';
import { planLoginSections } from '../../supabase/functions/_shared/boSectionRules.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
// Source without comments, so "the code never does X" reads statements only.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const sqlCode = (src) => src.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');

const KEYS = ['overview', 'menu', 'floorplan', 'inventory', 'produce', 'purchasing', 'operations', 'team',
  'workforce', 'customers', 'channels', 'hardware', 'reports', 'card-payments', 'settings'];
const allRoutes = NAV_IA.flatMap(routesOfRow);

// The people in the story.
const OWNER = { role: 'owner', sections: null };
const SERVOS = { role: 'super_admin', sections: null };
const MANAGER = { role: 'manager', sections: null };                                   // a manager nobody has limited
const MO = { role: 'manager', sections: ['workforce', 'reports', 'team', 'customers'] }; // the franchisee
const NOTHING = { role: 'manager', sections: [] };

// ── the list ────────────────────────────────────────────────────────────────

test('15 sections, the decided keys, in sidebar order', () => {
  assert.deepEqual([...BO_SECTION_KEYS], KEYS);
  assert.equal(NAV_IA.length, 15);
  assert.deepEqual(NAV_IA.map(sectionKeyOfRow), KEYS, 'every sidebar row has its key, in order');
  assert.deepEqual(SECTIONS.map((s) => s.key), KEYS);
  assert.deepEqual(SECTIONS.map((s) => s.label), NAV_IA.map((r) => r.label));
  assert.equal(Object.keys(SECTION_KEY_BY_LABEL).length, 15, 'no label without a row');
  assert.ok(Object.isFrozen(BO_SECTION_KEYS) && Object.isFrozen(SECTIONS));
});

test('the route map is built from the sidebar: every route in exactly one section', () => {
  assert.equal(allRoutes.length, 90);
  assert.equal(new Set(allRoutes).size, allRoutes.length, 'no route listed twice');
  const map = buildRouteSections(NAV_IA);
  assert.equal(map.size, allRoutes.length);
  for (const row of NAV_IA) for (const id of routesOfRow(row)) assert.equal(sectionKeyOfRoute(id), sectionKeyOfRow(row), id);
  // Route ids and section keys share some spellings but are different things.
  assert.equal(sectionKeyOfRoute('staff'), 'team');
  assert.equal(sectionKeyOfRoute('inventory'), 'inventory');
  assert.equal(sectionKeyOfRoute('stock-reports'), 'inventory');
  assert.equal(sectionKeyOfRoute('marketing-reports'), 'customers');
  assert.equal(sectionKeyOfRoute('security'), 'settings');
  assert.equal(sectionKeyOfRoute('team'), null, 'a section key is not a route');
  assert.equal(sectionKeyOfRoute('floor plan'), null);
  assert.equal(sectionKeyOfRoute('admin'), null, 'the in-app Company Admin is in no section');
  assert.equal(sectionKeyOfRoute('wf-anything'), null, 'an unknown wf- route is in no section');
  assert.equal(sectionKeyOfRoute(undefined), null);
  assert.equal(sectionKeyOfRoute(null), null);
  assert.equal(sectionKeyOfRoute('__proto__'), null);
});

test('a sidebar row with no key fails closed: only a login that opens everything is shown it', () => {
  const nav = [...NAV_IA, { label: 'Brand new', icon: 'home', single: 'brand-new' }];
  assert.equal(sectionKeyOfRow(nav[15]), null);
  assert.equal(buildRouteSections(nav).has('brand-new'), false);
  assert.equal(filterNav(nav, OWNER).length, 16);
  assert.equal(filterNav(nav, MANAGER).length, 16);
  assert.equal(filterNav(nav, MO).some((r) => r.label === 'Brand new'), false);
  // Even a list holding all 15 keys is a LIST: a new part is not on it.
  assert.equal(filterNav(nav, { role: 'manager', sections: [...KEYS] }).some((r) => r.label === 'Brand new'), false);
});

// ── who opens what ──────────────────────────────────────────────────────────

test('null is everything; owners and ServOS staff ignore any list', () => {
  assert.equal(allowedKeys(MANAGER), null);
  assert.equal(allowedKeys(OWNER), null);
  assert.equal(allowedKeys(SERVOS), null);
  assert.equal(allowedKeys({ role: 'owner', sections: ['team'] }), null, 'a list on an owner is ignored');
  assert.equal(allowedKeys({ role: 'super_admin', sections: [] }), null);
  assert.equal(allowedKeys({ role: 'Owner', sections: ['team'] }), null);
  assert.equal(allowedKeys(EVERYTHING), null);
  assert.equal(isEverythingRole('manager'), false);
  assert.equal(isEverythingRole(null), false);
  for (const who of [OWNER, SERVOS, MANAGER]) {
    for (const id of allRoutes) assert.equal(canOpenRoute(id, who), true, id);
    assert.equal(canOpenRoute('admin', who), true, 'a route in no section stays open to an unlimited login');
    assert.equal(canOpenRoute('wf-anything', who), true);
    assert.equal(firstAllowedRoute(who), 'overview');
    assert.equal(filterNav(NAV_IA, who), NAV_IA, 'the sidebar as it is');
    assert.equal(guardRoute('menu', who), 'menu');
  }
});

test('Mo: exactly Team, Workforce, Customers and Reports, every screen in them, nothing else', () => {
  assert.deepEqual(allowedKeys(MO), ['team', 'workforce', 'customers', 'reports'], 'sidebar order');
  const rows = filterNav(NAV_IA, MO);
  assert.deepEqual(rows.map((r) => r.label), ['Team', 'Workforce', 'Customers', 'Reports']);
  const mine = rows.flatMap(routesOfRow);
  assert.equal(mine.length, 1 + 13 + 13 + 5);
  for (const id of mine) assert.equal(canOpenRoute(id, MO), true, `Mo opens ${id}`);
  for (const id of allRoutes.filter((r) => !mine.includes(r))) {
    assert.equal(canOpenRoute(id, MO), false, `Mo must not open ${id}`);
    assert.equal(guardRoute(id, MO), 'staff', `${id} lands on Team`);
  }
  // By name, the things Peter said he must not touch, and the ones nobody mentioned.
  for (const id of ['overview', 'menu', 'discounts', 'tax', 'floorplan', 'stock-items', 'inventory', 'stock-reports', 'recipes', 'batches',
    'order-pad', 'suppliers', 'ops-overview', 'online', 'kiosks', 'devices', 'profiles', 'printers', 'card-payments',
    'location', 'security', 'xero', 'ai']) assert.equal(canOpenRoute(id, MO), false, id);
  for (const id of ['staff', 'wf-rota', 'wf-payroll', 'customers', 'loyalty', 'giftcards', 'marketing-reports', 'reports', 'shift', 'eod'])
    assert.equal(canOpenRoute(id, MO), true, id);
  assert.equal(firstAllowedRoute(MO), 'staff', 'he lands on Team, the first of his four in the sidebar');
  assert.equal(guardRoute('overview', MO), 'staff', 'the page Back Office starts on is not his');
  assert.equal(guardRoute('wf-rota', MO), 'wf-rota');
  assert.equal(canPushToPos(MO), false, 'no Push to POS: it sends the menu to the tills');
});

test('fail closed: a route in no section, an unknown route, an unknown key, no profile', () => {
  assert.equal(canOpenRoute('admin', MO), false);
  assert.equal(canOpenRoute('wf-anything', MO), false, 'Workforce renders any wf- id, so an unknown one is refused');
  assert.equal(canOpenRoute('wf-', MO), false);
  for (const bad of ['', 'nope', 'team', 'workforce', 'Staff', 'STAFF', ' staff', null, undefined, 0, {}, [], ['staff']])
    assert.equal(canOpenRoute(bad, MO), false, String(bad));
  // A list holding something this build does not know opens nothing extra.
  const odd = { role: 'manager', sections: ['team', 'payroll-admin', 'admin', null, 7] };
  assert.deepEqual(allowedKeys(odd), ['team']);
  assert.equal(canOpenRoute('admin', odd), false);
  // No profile, or a broken value where the list should be, is NOTHING, never everything.
  for (const who of [null, undefined, {}, { role: 'manager' }, { role: 'manager', sections: undefined },
    { role: 'manager', sections: 'team' }, { role: 'manager', sections: { 0: 'team' } }, { role: null, sections: undefined }, 'owner', 7]) {
    assert.deepEqual(allowedKeys(who), [], JSON.stringify(who));
    assert.equal(canOpenRoute('overview', who), false);
    assert.equal(firstAllowedRoute(who), null);
    assert.equal(guardRoute('staff', who), null);
    assert.deepEqual(filterNav(NAV_IA, who), []);
    assert.equal(canPushToPos(who), false);
  }
});

test('an empty list opens nothing at all', () => {
  assert.deepEqual(allowedKeys(NOTHING), []);
  assert.deepEqual(filterNav(NAV_IA, NOTHING), []);
  assert.equal(firstAllowedRoute(NOTHING), null);
  for (const id of [...allRoutes, 'admin']) {
    assert.equal(canOpenRoute(id, NOTHING), false);
    assert.equal(guardRoute(id, NOTHING), null, 'null is the "no part of Back Office" screen');
  }
});

test('one section each: that section, all of it, and no other', () => {
  for (const row of NAV_IA) {
    const key = sectionKeyOfRow(row);
    const who = { role: 'manager', sections: [key] };
    assert.deepEqual(filterNav(NAV_IA, who).map((r) => r.label), [row.label]);
    assert.equal(firstAllowedRoute(who), routesOfRow(row)[0]);
    for (const id of allRoutes) assert.equal(canOpenRoute(id, who), routesOfRow(row).includes(id), `${key} / ${id}`);
  }
});

test('Push to POS: only a login that may open what a push sends', () => {
  assert.deepEqual([...PUSH_TO_POS_SECTIONS], ['menu', 'floorplan', 'hardware']);
  for (const who of [OWNER, SERVOS, MANAGER]) assert.equal(canPushToPos(who), true);
  assert.equal(canPushToPos({ role: 'manager', sections: ['menu', 'reports'] }), true, 'a menu editor must be able to send it');
  assert.equal(canPushToPos({ role: 'manager', sections: ['floorplan'] }), true);
  assert.equal(canPushToPos({ role: 'manager', sections: ['hardware'] }), true);
  assert.equal(canPushToPos({ role: 'manager', sections: ['reports', 'team', 'inventory', 'settings'] }), false);
  assert.equal(canPushToPos(NOTHING), false);
});

// ── lists ───────────────────────────────────────────────────────────────────

test('checkSections: a wrong key is an error, never dropped quietly', () => {
  assert.deepEqual(checkSections(null), { ok: true, sections: null });
  assert.deepEqual(checkSections(undefined), { ok: true, sections: null });
  assert.deepEqual(checkSections([]), { ok: true, sections: [] });
  assert.deepEqual(checkSections(['reports', 'team', 'reports']), { ok: true, sections: ['team', 'reports'] });
  assert.deepEqual(checkSections(['team', 'menus']), { ok: false, unknown: ['menus'] });
  assert.equal(checkSections(['Team']).ok, false, 'keys are exact');
  assert.equal(checkSections([null]).ok, false);
  assert.equal(checkSections('team').ok, false);
  assert.equal(checkSections({ team: true }).ok, false);
  assert.equal(checkSections([['team']]).ok, false);
});

test('storedSections and sectionsFromAnswer: null is everything, a broken value is never everything', () => {
  assert.equal(storedSections(null), null);
  assert.deepEqual(storedSections(['reports', 'x', 'team', 'team']), ['team', 'reports']);
  for (const bad of [undefined, 'team', 7, {}, true]) assert.deepEqual(storedSections(bad), []);
  assert.equal(sectionsFromAnswer(null), null);
  assert.deepEqual(sectionsFromAnswer(['reports', 'team']), ['team', 'reports']);
  for (const bad of [undefined, 'team', 7, {}, true]) assert.equal(sectionsFromAnswer(bad), undefined, 'unknown stays unknown');
});

test('capSections (decision 7): never more than whoever made the login', () => {
  const mo = MO.sections;
  // The creator opens everything: the new login gets what was asked for.
  assert.equal(capSections(null, null), null);
  assert.equal(capSections(undefined, null), null);
  assert.deepEqual(capSections(['reports', 'team'], null), ['team', 'reports']);
  assert.deepEqual(capSections([], null), []);
  // A limited creator who asks for nothing in particular passes on exactly their own list.
  assert.deepEqual(capSections(null, mo), ['team', 'workforce', 'customers', 'reports']);
  assert.deepEqual(capSections(undefined, mo), ['team', 'workforce', 'customers', 'reports']);
  assert.notEqual(capSections(null, mo), mo, 'a copy, not the same array');
  // Asking for more is cut down to what the creator has.
  assert.deepEqual(capSections(['menu', 'team', 'settings', 'reports'], mo), ['team', 'reports']);
  assert.deepEqual(capSections([...KEYS], mo), ['team', 'workforce', 'customers', 'reports']);
  assert.deepEqual(capSections(['menu', 'inventory'], mo), []);
  assert.deepEqual(capSections(['team'], []), []);
  assert.deepEqual(capSections(null, []), []);
  // Only null means "everything" for the creator. A missing or broken value there is nothing.
  for (const broken of [undefined, 'everything', 7, {}]) {
    assert.deepEqual(capSections(null, broken), []);
    assert.deepEqual(capSections(['team'], broken), []);
  }
  // Whatever goes in, the result never opens more than the cap.
  const samples = [null, undefined, [], ['team'], ['menu'], [...KEYS], ['x'], 'team'];
  for (const cap of [mo, ['menu'], []]) for (const req of samples) {
    const out = capSections(req, cap);
    assert.ok(Array.isArray(out) && out.every((k) => cap.includes(k)), `${JSON.stringify(req)} under ${JSON.stringify(cap)}`);
    assert.equal(withinSections(out, cap), true);
  }
});

test('withinSections and sameSections: an unknown value is never "fine"', () => {
  assert.equal(withinSections(null, null), true);
  assert.equal(withinSections(['team'], null), true);
  assert.equal(withinSections(null, ['team']), false, 'everything is not within a list');
  assert.equal(withinSections(['team'], ['team', 'reports']), true);
  assert.equal(withinSections(['team', 'menu'], ['team', 'reports']), false);
  assert.equal(withinSections([], ['team']), true);
  assert.equal(withinSections(undefined, ['team']), false, 'no answer is not "limited"');
  assert.equal(withinSections(undefined, null), false);
  assert.equal(withinSections('team', ['team']), false);
  assert.equal(sameSections(null, null), true);
  assert.equal(sameSections(['reports', 'team'], ['team', 'reports']), true);
  assert.equal(sameSections(['team'], null), false);
  assert.equal(sameSections([], null), false, 'nothing is not everything');
  assert.equal(sameSections(undefined, null), false);
  assert.equal(sameSections(undefined, undefined), false);
});

test('the tick boxes: all ticked is everything (null), and the Franchisee shortcut is his four', () => {
  assert.equal(sectionsToStore([...KEYS]), null);
  assert.equal(sectionsToStore([...KEYS].reverse()), null);
  assert.deepEqual(sectionsToStore(['reports', 'team']), ['team', 'reports']);
  assert.deepEqual(sectionsToStore([]), []);
  assert.deepEqual(sectionsToStore(undefined), []);
  assert.deepEqual(sectionsToTicks(null), KEYS);
  assert.deepEqual(sectionsToTicks(['reports', 'team']), ['team', 'reports']);
  assert.deepEqual([...FRANCHISEE_SECTIONS].sort(), ['customers', 'reports', 'team', 'workforce']);
  assert.deepEqual(sectionsToStore([...FRANCHISEE_SECTIONS]), ['team', 'workforce', 'customers', 'reports']);
  assert.equal(describeSections(null), 'Everything');
  assert.equal(describeSections([...FRANCHISEE_SECTIONS]), 'Team, Workforce, Customers, Reports');
  assert.equal(describeSections(['card-payments', 'floorplan']), 'Floor plan, Card payments');
  assert.equal(describeSections([]), 'Nothing');
});

test('who is offered the tick boxes: an owner or ServOS, never for their own login or an owner', () => {
  const ask = (callerRole, targetRole, same = false) => canEditSectionsFor({ callerRole, callerId: 'a', targetId: same ? 'a' : 'b', targetRole });
  assert.equal(ask('owner', 'manager'), true);
  assert.equal(ask('super_admin', 'manager'), true);
  assert.equal(ask('owner', null), true, 'a login with no role on record is not an owner');
  assert.equal(ask('manager', 'manager'), false, 'a manager sees, never changes');
  assert.equal(ask(null, 'manager'), false);
  assert.equal(ask('owner', 'owner'), false);
  assert.equal(ask('owner', 'super_admin'), false);
  assert.equal(ask('super_admin', 'owner'), false);
  assert.equal(ask('owner', 'manager', true), false, 'never your own');
  assert.equal(ask('super_admin', 'manager', true), false);
  assert.equal(canEditSectionsFor({ callerRole: 'owner', callerId: null, targetId: 'b', targetRole: 'manager' }), false, 'who is asking must be known');
  assert.equal(canEditSectionsFor({ callerRole: 'owner', callerId: 'a', targetId: null, targetRole: 'manager' }), false);
  assert.equal(canEditSectionsFor(), false);
});

// ── the profile read (decision 8) ───────────────────────────────────────────

const missing = (col) => ({ code: '42703', message: `column user_profiles.${col} does not exist` });

test('only "the column does not exist" means not installed', () => {
  assert.equal(isSectionsColumnMissing(missing('bo_sections')), true);
  assert.equal(isSectionsColumnMissing({ code: 'PGRST204', message: "Could not find the 'bo_sections' column of 'user_profiles' in the schema cache" }), true);
  assert.equal(isSectionsColumnMissing(missing('bo_access')), false, 'another column is another problem');
  assert.equal(isSectionsColumnMissing({ code: '42501', message: 'permission denied for table user_profiles' }), false);
  assert.equal(isSectionsColumnMissing({ message: 'TypeError: Failed to fetch' }), false);
  assert.equal(isSectionsColumnMissing({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }), false);
  assert.equal(isSectionsColumnMissing({ code: '42501', message: 'second_step_required', details: 'bo_sections' }), false);
  assert.equal(isSectionsColumnMissing(null), false);
  assert.equal(missingProfileColumn(missing('bo_sections')), 'bo_sections');
  assert.equal(missingProfileColumn(missing('bo_access')), 'bo_access');
  assert.equal(missingProfileColumn(missing('bo_sections'), ['bo_sections']), null, 'not dropped twice');
  assert.equal(missingProfileColumn(missing('role')), null, 'a column the read cannot go without');
  assert.equal(missingProfileColumn({ message: 'Failed to fetch' }), null);
});

test('readProfileRow: reads the list; not installed = everyone opens everything', async () => {
  const asked = [];
  const ok = await readProfileRow(async (cols) => { asked.push(cols); return { data: { role: 'manager', org_id: 'o', location_id: 'l', bo_access: true, bo_sections: ['team'] }, error: null }; });
  assert.deepEqual(asked, [PROFILE_COLUMNS.join(', ')]);
  assert.equal(asked[0], 'role, org_id, location_id, bo_access, bo_sections');
  assert.equal(ok.ok, true);
  assert.equal(ok.sectionsInstalled, true);
  assert.deepEqual(sectionsFromProfileRow(ok.row, ok.sectionsInstalled), ['team']);

  // The column is not there yet: one more read without it, and nobody is limited.
  const asked2 = [];
  const old = await readProfileRow(async (cols) => {
    asked2.push(cols);
    return cols.includes('bo_sections') ? { data: null, error: missing('bo_sections') } : { data: { role: 'manager', org_id: 'o', location_id: 'l', bo_access: true }, error: null };
  });
  assert.deepEqual(asked2, ['role, org_id, location_id, bo_access, bo_sections', 'role, org_id, location_id, bo_access']);
  assert.equal(old.ok, true);
  assert.equal(old.sectionsInstalled, false);
  assert.equal(sectionsFromProfileRow(old.row, old.sectionsInstalled), null, 'everything, as before 8 Oct 2026');

  // An older database still: both optional columns missing, three reads, then it stops.
  const asked3 = [];
  const older = await readProfileRow(async (cols) => {
    asked3.push(cols);
    if (cols.includes('bo_access')) return { data: null, error: missing('bo_access') };
    if (cols.includes('bo_sections')) return { data: null, error: missing('bo_sections') };
    return { data: { role: 'owner', org_id: 'o', location_id: 'l' }, error: null };
  });
  assert.equal(asked3.length, 3);
  assert.equal(asked3[2], 'role, org_id, location_id');
  assert.equal(older.ok, true);
  assert.equal(older.sectionsInstalled, false);
});

test('readProfileRow fails closed: any other failure is "could not load", never a retry that widens', async () => {
  const failures = [
    { data: null, error: { message: 'TypeError: Failed to fetch' } },
    { data: null, error: { code: '42501', message: 'permission denied for table user_profiles' } },
    { data: null, error: { code: '42501', message: 'second_step_required' } },
    { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },   // no profile row
    { data: null, error: { code: '42703', message: 'column user_profiles.role does not exist' } },
    { data: null, error: null },                                                                                     // no row, no error
    undefined,
  ];
  for (const answer of failures) {
    let reads = 0;
    const res = await readProfileRow(async () => { reads += 1; return answer; });
    assert.equal(res.ok, false, JSON.stringify(answer));
    assert.equal(reads, 1, 'no second read with fewer columns');
    assert.equal(res.row, undefined);
  }
  const thrown = await readProfileRow(async () => { throw new Error('offline'); });
  assert.equal(thrown.ok, false);
  // A missing column THEN a real failure is still a failure.
  let n = 0;
  const later = await readProfileRow(async () => { n += 1; return n === 1 ? { data: null, error: missing('bo_sections') } : { data: null, error: { message: 'Failed to fetch' } }; });
  assert.equal(later.ok, false);
  assert.equal(n, 2);
  // It can never loop: the same missing column twice ends as a failure.
  let m = 0;
  const loop = await readProfileRow(async () => { m += 1; return { data: null, error: missing('bo_sections') }; });
  assert.equal(loop.ok, false);
  assert.equal(m, 2);
});

test('sectionsFromProfileRow: installed is read strictly', () => {
  assert.equal(sectionsFromProfileRow({ bo_sections: null }, true), null);
  assert.deepEqual(sectionsFromProfileRow({ bo_sections: ['reports', 'team'] }, true), ['team', 'reports']);
  assert.deepEqual(sectionsFromProfileRow({ bo_sections: [] }, true), []);
  assert.deepEqual(sectionsFromProfileRow({}, true), [], 'installed but the value is not there: nothing, never everything');
  assert.deepEqual(sectionsFromProfileRow(null, true), []);
  assert.deepEqual(sectionsFromProfileRow({ bo_sections: 'team' }, true), []);
  assert.equal(sectionsFromProfileRow({ bo_sections: ['team'] }, false), null, 'not installed: everything');
});

// ── create-user's plan (decision 7 on the server) ───────────────────────────

test('planLoginSections: what a new login gets', () => {
  const mo = MO.sections;
  // An owner making a login: what was ticked, or everything.
  assert.deepEqual(planLoginSections({ asked: undefined, callerSections: null, role: 'manager' }), { ok: true, sections: null });
  assert.deepEqual(planLoginSections({ asked: null, callerSections: null, role: 'manager' }), { ok: true, sections: null });
  assert.deepEqual(planLoginSections({ asked: ['workforce', 'reports', 'team', 'customers'], callerSections: null, role: 'manager' }),
    { ok: true, sections: ['team', 'workforce', 'customers', 'reports'] });
  // Mo making a login: never more than Mo.
  assert.deepEqual(planLoginSections({ asked: undefined, callerSections: mo, role: 'manager' }), { ok: true, sections: ['team', 'workforce', 'customers', 'reports'] });
  assert.deepEqual(planLoginSections({ asked: null, callerSections: mo, role: 'manager' }), { ok: true, sections: ['team', 'workforce', 'customers', 'reports'] }, 'asking for everything gets his own list');
  assert.deepEqual(planLoginSections({ asked: [...KEYS], callerSections: mo, role: 'manager' }), { ok: true, sections: ['team', 'workforce', 'customers', 'reports'] });
  assert.deepEqual(planLoginSections({ asked: ['team', 'menu'], callerSections: mo, role: 'manager' }), { ok: true, sections: ['team'] });
  const refused = planLoginSections({ asked: ['menu', 'settings'], callerSections: mo, role: 'manager' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  // A wrong key is refused whoever asks, before anything is made.
  const bad = planLoginSections({ asked: ['team', 'menus'], callerSections: null, role: 'manager' });
  assert.deepEqual(bad, { ok: false, status: 400, error: 'Unknown part of Back Office: menus' });
  assert.equal(planLoginSections({ asked: 'team', callerSections: null, role: 'manager' }).ok, false);
  // An owner always opens everything: a list is never put on one.
  assert.deepEqual(planLoginSections({ asked: ['team'], callerSections: null, role: 'owner' }), { ok: true, sections: null });
  assert.deepEqual(planLoginSections({ asked: ['team'], callerSections: null, role: 'super_admin' }), { ok: true, sections: null });
});

// ── one list of keys, three places ──────────────────────────────────────────

const sql = read('../../supabase/migrations/20261008a_OPS_bo_sections.sql');
const rollback = read('../../supabase/migrations/20261008a_OPS_bo_sections_ROLLBACK.sql');
const stmts = sqlCode(sql);
const keyList = (text) => [...text.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

test('the keys in the database CHECK, in set_bo_sections and in the shared rules are one list', () => {
  const check = stmts.match(/add constraint user_profiles_bo_sections_known\s+check \(bo_sections is null\s+or \(bo_sections <@ array\[([^\]]+)\]::text\[\]/);
  assert.ok(check, 'the CHECK on user_profiles.bo_sections');
  assert.deepEqual(keyList(check[1]), KEYS, 'CHECK list');
  const fn = stmts.match(/v_keys\s+constant text\[\] := array\[([^\]]+)\];/);
  assert.ok(fn, 'the list inside set_bo_sections');
  assert.deepEqual(keyList(fn[1]), KEYS, 'function list');
  assert.deepEqual(keyList(check[1]), [...BO_SECTION_KEYS]);
  // The header lists them for the person running the file, too.
  const said = sql.match(/-- THE 15 KEYS[\s\S]*?\n--\s+(overview,[\s\S]*?settings)\n/);
  assert.ok(said, 'the header names the keys');
  assert.deepEqual(said[1].replace(/--/g, '').split(',').map((k) => k.trim()), KEYS);
  // create-user has NO list of its own: it reads the shared file, the same one this lib does.
  const fnSrc = read('../../supabase/functions/create-user/index.ts');
  assert.match(fnSrc, /import \{[^}]*planLoginSections[^}]*\} from '\.\.\/_shared\/boSectionRules\.js';/);
  assert.doesNotMatch(code(fnSrc), /'card-payments'|'floorplan'/, 'no second copy of the keys in the function');
  const lib = read('./boSections.js');
  assert.match(lib, /from '\.\.\/\.\.\/supabase\/functions\/_shared\/boSectionRules\.js';/);
  assert.doesNotMatch(code(lib).replace(/export const SECTION_KEY_BY_LABEL[\s\S]*?\}\);/, '').replace(/export const (FRANCHISEE_SECTIONS|PUSH_TO_POS_SECTIONS)[^\n]*\n/g, ''),
    /\['overview', 'menu'/, 'the lib does not type the key list out again');
});

test('the migration: null by default, no browser write, the function is the only way', () => {
  assert.match(stmts, /alter table public\.user_profiles add column if not exists bo_sections text\[\];/, 'null by default, no rewrite');
  assert.doesNotMatch(stmts, /grant\s+update[^;]*bo_sections/i, 'no update grant on the column, ever');
  assert.doesNotMatch(stmts, /grant\s+(all|update)\s+on\s+(table\s+)?public\.user_profiles/i);
  assert.match(stmts, /revoke update \(bo_sections\) on table public\.user_profiles from public, anon, authenticated;/);
  assert.match(stmts, /create or replace function public\.set_bo_sections\(p_user uuid, p_sections text\[\]\)\s+returns jsonb\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp/);
  assert.match(stmts, /if v_uid is null or public\.is_anon_session\(\) then/, 'nobody, and no anonymous session');
  assert.match(stmts, /if p_user = v_uid then/, 'never your own');
  assert.match(stmts, /if not v_super and \(v_me_role is distinct from 'owner' or v_me_org is null\) then/, 'an owner');
  assert.match(stmts, /if not found or \(not v_super and v_org is distinct from v_me_org\) then/, 'of the same company');
  assert.match(stmts, /if lower\(coalesce\(v_role, ''\)\) in \('owner', 'super_admin'\) then/, 'never on an owner');
  assert.match(stmts, /revoke all on function public\.set_bo_sections\(uuid, text\[\]\) from public, anon, service_role;\s+grant execute on function public\.set_bo_sections\(uuid, text\[\]\) to authenticated;/);
  // The second lock, and the pass that only the function holds.
  assert.match(stmts, /create trigger user_profiles_bo_sections_guard\s+before insert or update on public\.user_profiles/);
  assert.match(stmts, /if new\.bo_sections is distinct from old\.bo_sections\s+and coalesce\(current_setting\('servos\.bo_sections_write', true\), ''\) <> 'on' then/);
  const body = stmts.slice(stmts.indexOf('create or replace function public.set_bo_sections'));
  const on = body.indexOf("set_config('servos.bo_sections_write', 'on', true)");
  const upd = body.indexOf('update public.user_profiles set bo_sections = v_clean where id = p_user;');
  const off = body.indexOf("set_config('servos.bo_sections_write', 'off', true)");
  assert.ok(on > 0 && on < upd && upd < off, 'the pass opens for the one update and shuts straight after');
  // The older guards and the read and update rules are not touched by this file.
  assert.doesNotMatch(stmts, /user_profiles_fence_guard|user_profiles_role_guard|up_update_scoped|up_select_scoped|fence_bypass/);
  assert.doesNotMatch(stmts, /\bdrop policy\b|\bcreate policy\b|disable row level security/i);
  assert.match(stmts, /notify pgrst, 'reload schema';/);
  // It says what it is.
  assert.match(sql, /THIS IS A SCREEN LOCK, NOT A DATABASE LOCK/);
  assert.match(sql, /OPS DB ONLY\s+project ref\s+tbetcegmszzotrwdtqhi/);
  // The rollback takes out exactly what went in, in an order that works.
  const rb = sqlCode(rollback);
  for (const line of ['drop function if exists public.set_bo_sections(uuid, text[]);',
    'drop trigger if exists user_profiles_bo_sections_guard on public.user_profiles;',
    'drop function if exists public.user_profiles_bo_sections_guard();',
    'alter table public.user_profiles drop constraint if exists user_profiles_bo_sections_known;',
    'alter table public.user_profiles drop column if exists bo_sections;']) assert.ok(rb.includes(line), line);
  assert.ok(rb.indexOf('drop trigger if exists user_profiles_bo_sections_guard') < rb.indexOf('drop function if exists public.user_profiles_bo_sections_guard'));
  assert.doesNotMatch(rb, /user_profiles_fence_guard|user_profiles_role_guard|drop policy/);
});

// ── the screen: the render guard and the setter guard ───────────────────────

const bo = read('../backoffice/BackOfficeApp.jsx');
const boCode = code(bo);

test('BackOfficeApp: one list, and every way in goes through the guard', () => {
  assert.match(bo, /import \{ NAV_IA, EVERYTHING, canOpenRoute, guardRoute, filterNav, canPushToPos, readProfileRow, sectionsFromProfileRow \} from '\.\.\/lib\/boSections';/);
  assert.doesNotMatch(boCode, /const NAV_IA\s*=/, 'the sidebar list is not copied into the screen');
  // RENDER GUARD: what shows is `section`, and `section` is only ever a route the login may open.
  assert.match(boCode, /const \[askedSection, setAskedSection\] = useState\('overview'\);/);
  assert.match(boCode, /const section = guardRoute\(askedSection, access\);/);
  assert.equal((boCode.match(/askedSection/g) || []).length, 2, 'the asked route is read in ONE place: the guard');
  // SETTER GUARD: the raw setter is called in ONE place, behind canOpenRoute.
  assert.equal((boCode.match(/setAskedSection\(/g) || []).length, 1, 'one call to the raw setter');
  assert.match(boCode, /const setSection = \(next\) => \{\s+if \(!canOpenRoute\(next, access\)\) \{[\s\S]{0,220}?return;\s+\}\s+setAskedSection\(next\);\s+\};/);
  // Who is signed in: nobody until the profile has loaded, and nobody when it failed to load.
  assert.match(boCode, /\(\) => \(isMock \? EVERYTHING : \(orgCtx && !orgCtx\.loadFailed \? \{ role: orgCtx\.role, sections: orgCtx\.boSections \} : null\)\)/);
  // Every screen in the page is chosen by `section` (never by the asked route, never unguarded).
  const shell = boCode.slice(boCode.indexOf('<div className="bo-page-shell">'), boCode.indexOf('{showLocationSwitcher &&'));
  const lines = shell.split('\n').filter((l) => /&& </.test(l));
  assert.ok(lines.length >= 78, `found ${lines.length} screens`);
  for (const l of lines) assert.match(l, /^\s*\{section(\?\.startsWith\('wf-'\)| === '[a-z0-9-]+')\s*&& </, l.trim());
  // Every route the page can render is one the rules know, except the in-app Company Admin,
  // which is in no section on purpose (decision 4).
  const rendered = [...shell.matchAll(/section === '([a-z0-9-]+)'/g)].map((m) => m[1]);
  const unknown = rendered.filter((id) => sectionKeyOfRoute(id) === null);
  assert.deepEqual(unknown, ['admin'], 'a screen that is in no sidebar section');
  // And every sidebar route that is not a wf- route has a screen.
  for (const id of allRoutes.filter((r) => !r.startsWith('wf-'))) assert.ok(rendered.includes(id), `no screen for ${id}`);
  // The sidebar lists only what the login may open.
  assert.match(boCode, /const navRows = filterNav\(NAV_IA, access\);/);
  assert.match(boCode, /\{navRows\.map\(sec => \{/);
  assert.doesNotMatch(boCode, /\{NAV_IA\.map\(/);
  // Nothing in this file remembers a route or takes one from the address bar.
  assert.doesNotMatch(boCode, /localStorage\.(get|set)Item\('rpos-bo-section/);
  assert.doesNotMatch(boCode, /searchParams\.get\('section'\)|location\.hash/);
});

test('BackOfficeApp: the two things in the top bar that belong to no section', () => {
  assert.match(boCode, /\{canPushToPos\(access\) && \(\s+<PushToPOSButton nameCandidates=/, 'Push to POS only for a login that may open what it sends');
  assert.match(boCode, /<WeakPasswordBanner onFix=\{canOpen\('security'\) \? \(\) => setSection\('security'\) : null\} \/>/, 'no dead button to Sign in security');
  assert.match(boCode, /\{onFix && \(\s+<button onClick=\{onFix\}/);
});

test('BackOfficeApp: the profile read fails closed, and the two plain screens', () => {
  assert.match(boCode, /const read = await readProfileRow\(\(columns\) => supabase\s+\.from\('user_profiles'\)\s+\.select\(columns\)\s+\.eq\('id', authUser\.id\)\s+\.single\(\)\);/);
  assert.match(boCode, /if \(!read\.ok\) \{[\s\S]{0,200}?setOrgCtx\(\{ loadFailed: true, role: null, boAccess: false, boSections: \[\], sectionsInstalled: false,/);
  assert.doesNotMatch(boCode, /boAccess: true/, 'the old "carry on with everything" fallback is gone');
  assert.doesNotMatch(boCode, /retrying without bo_access/);
  assert.match(boCode, /boSections: sectionsFromProfileRow\(profile, read\.sectionsInstalled\),\s+sectionsInstalled: read\.sectionsInstalled,/);
  // Could not load: before the "no access" screen, with a retry that reads again.
  const failed = boCode.indexOf('orgCtx && orgCtx.loadFailed) return (');
  const denied = boCode.indexOf('orgCtx && !orgCtx.boAccess) return (');
  const none = boCode.indexOf('if (!isMock && section === null) return (');
  const page = boCode.indexOf('const navRows = filterNav(NAV_IA, access);');
  assert.ok(failed > 0 && failed < denied && denied < none && none < page, 'load failed, then switched off, then nothing to open, then the page');
  assert.ok(bo.includes('Could not load your access. Try again.'));
  assert.match(boCode, /onClick=\{\(\) => \{ setOrgCtx\(null\); setProfileTry\(n => n \+ 1\); \}\}/);
  assert.match(boCode, /\}, \[authUser, secondStepOk, profileTry\]\);/, 'the retry runs the read again');
  assert.ok(bo.includes('You do not have access to any part of Back Office. Ask the owner.'));
});

test('BackOfficeApp: links on Overview and in Reports to a part the login is not shown are left out', () => {
  assert.match(boCode, /\{section === 'overview'\s+&& <BOOverview setSection=\{setSection\} canOpen=\{canOpen\} orgCtx=\{orgCtx\} \/>\}/);
  assert.match(boCode, /\]\.filter\(a => canOpen\(a\.target\)\);/, 'quick actions');
  assert.match(boCode, /const toReports = canOpen\('reports'\) \? \(\) => setSection\('reports'\) : undefined;/);
  assert.doesNotMatch(boCode, /onClick=\{\(\) => setSection\('reports'\)\}/);
  assert.match(boCode, /\{canOpen\('admin'\)\s+\? <>Go to <button onClick=\{\(\) => setSection\('admin'\)\}/);
  assert.match(boCode, /\{section === 'reports'\s+&& <BOReports setSection=\{setSection\} canOpen=\{canOpen\} \/>\}/);
  const catalog = code(read('../backoffice/sections/reports/Catalog.jsx'));
  assert.match(catalog, /const shown = \(r\) => !r\.section \|\| !canOpen \|\| canOpen\(r\.section\);/);
  const inside = catalog.slice(catalog.indexOf('export default function Catalog('));
  const afterMemo = inside.slice(inside.indexOf('}, [canOpen]);'));
  assert.doesNotMatch(afterMemo, /\bALL_REPORTS\b|\bCATEGORIES\.|\bREPORT_BY_ID\b/, 'the catalog renders the filtered lists only');
  // The screens handed the setter get the guarded one (the only setSection in BackOfficeApp's scope).
  const shell = boCode.slice(boCode.indexOf('<div className="bo-page-shell">'), boCode.indexOf('{showLocationSwitcher &&'));
  assert.equal((shell.match(/setSection=\{setSection\}/g) || []).length, 6);
});

// ── the Team screen ─────────────────────────────────────────────────────────

const team = read('../backoffice/sections/StaffManager.jsx');
const teamCode = code(team);

test('Team: tick boxes for an owner, plain words for everybody, the database function to save', () => {
  assert.match(boCode, /\{section === 'staff'\s+&& <StaffManager orgCtx=\{orgCtx\} \/>\}/);
  assert.ok(team.includes('What can they open?'));
  assert.match(teamCode, /SECTIONS\.map\(\(\{ key, label \}\) =>/, 'one tick box per section, from the one list');
  assert.match(teamCode, /onClick=\{\(\) => onChange\(\[\.\.\.BO_SECTION_KEYS\]\)\}[^>]*>Everything<\/button>/);
  assert.match(teamCode, /onClick=\{\(\) => onChange\(\[\.\.\.FRANCHISEE_SECTIONS\]\)\}[^>]*>Franchisee<\/button>/);
  // Saving an existing login: the function, and the screen believes its answer.
  assert.match(teamCode, /supabase\.rpc\('set_bo_sections', \{ p_user: link\.authUserId, p_sections: toStore \}\)/);
  assert.match(teamCode, /if \(!sameSections\(landed, toStore\)\) \{ showToast\('Not saved\./);
  assert.doesNotMatch(teamCode, /\.update\(\{[^}]*bo_sections/, 'never a direct write of the column from the browser');
  // Who is offered it: decided by the one rule, and never without knowing what is stored.
  assert.match(teamCode, /const editable = sectionsInstalled && link\.sections !== undefined\s+&& canEditSectionsFor\(\{ callerRole: myRole, callerId: myId, targetId: link\.authUserId, targetRole: link\.role \}\);/);
  for (const line of ['An owner always opens everything.', 'This is your own login. You cannot change it.', 'Only the owner can change this.',
    'Choosing what a login can open needs a database update.']) assert.ok(team.includes(line), line);
  // The teammate read: bo_sections has its own fallback step, so it never takes bo_access with it.
  assert.match(teamCode, /let \{ data, error \} = await read\('id, email, role, bo_access, bo_sections'\);\s+if \(error && isSectionsColumnMissing\(error\)\) \{\s+hasSections = false;\s+\(\{ data, error \} = await read\('id, email, role, bo_access'\)\);/);
  assert.match(teamCode, /sections: hasSections \? sectionsFromAnswer\(p\.bo_sections\) : null,/);
  // No screen text with a long dash in what this change added.
  for (const line of team.split('\n').filter((l) => /What can they open|Franchisee is|limit was NOT saved|Back Office login made|It applies the next time/.test(l)))
    assert.doesNotMatch(line.replace(/\/\/.*$/, ''), /[–—]/, line.trim());
});

test('Team: a new login passes its list to create-user, and a limit that did not land fails closed', () => {
  assert.match(teamCode, /const wanted = \(iSetSections && sectionsInstalled\) \? sectionsToStore\(grantTicks\) : undefined;/);
  assert.match(teamCode, /\.\.\.\(wanted !== undefined \? \{ sections: wanted \} : \{\}\),/);
  // What must hold: the ticked list, or a limited person's own list.
  assert.match(teamCode, /const expected = wanted !== undefined \? wanted : mySections;/);
  assert.match(teamCode, /let landed = sectionsFromAnswer\(result\.sections\);\s+let limitSaved = expected === null \|\| withinSections\(landed, expected\);/,
    'an answer without sections (the older function) is never treated as limited');
  // Not saved: the owner's own route, then the new login is switched off. Never an existing one.
  assert.match(teamCode, /if \(!limitSaved && iSetSections\) \{[\s\S]{0,260}?supabase\.rpc\('set_bo_sections', \{ p_user: newUserId, p_sections: expected \}\)/);
  assert.match(teamCode, /if \(!limitSaved && !result\.alreadyExisted\) \{\s+const \{ data: off, error: offErr \} = await supabase\.from\('user_profiles'\)\.update\(\{ bo_access: false \}\)\.eq\('id', newUserId\)\.select\('id'\);/);
  assert.ok(team.includes('This login can open EVERYTHING in Back Office.'), 'and it is said plainly when it could not be switched off');
});

// ── create-user ─────────────────────────────────────────────────────────────

test('create-user: the caller\'s own list is read by the server, and a limited caller is held to it', () => {
  const fn = read('../../supabase/functions/create-user/index.ts');
  const fnCode = code(fn);
  // Read with the service role, tolerant of a database without the column, closed on anything else.
  assert.match(fnCode, /let callerRead: any = await supabaseAdmin\.from\('user_profiles'\)\.select\('role, org_id, bo_sections'\)\.eq\('id', caller\.id\)\.single\(\);\s+if \(callerRead\.error && isSectionsColumnMissing\(callerRead\.error\)\) \{\s+sectionsInstalled = false;/);
  assert.match(fnCode, /if \(callerRead\.error \|\| !callerRead\.data\) \{\s+return new Response\(JSON\.stringify\(\{ error: 'Could not check your access\. Try again\.' \}\), \{ status: 403/);
  assert.match(fnCode, /const callerSections = sectionsInstalled \? allowedKeys\(\{ role: profile\.role, sections: profile\.bo_sections \}\) : null;/);
  assert.doesNotMatch(fnCode, /callerSections\s*=\s*[^;]*\b(body|req)\b/, 'never from the request');
  // A limited caller only ever makes a manager.
  assert.match(fnCode, /if \(callerLimited\) role = 'manager';/);
  // The plan (validation and the cap) is decided before the login is created.
  const plan = fnCode.indexOf('const plan = planLoginSections({ asked: askedSections, callerSections, role: loginRole });');
  const create = fnCode.indexOf('supabaseAdmin.auth.admin.createUser(');
  assert.ok(plan > 0 && plan < create, 'a wrong key stops before anything is made');
  assert.match(fnCode, /if \(!plan\.ok\) return new Response\(JSON\.stringify\(\{ error: plan\.error \}\), \{ status: plan\.status/);
  // An email that already has a login: never linked by a limited caller, and never linked
  // "limited" unless the limit was really written first.
  const existing = fnCode.slice(fnCode.indexOf('if (alreadyExisted && !isSuper) {'), fnCode.indexOf('const { data: savedProfile, error: profileErr }'));
  assert.match(existing, /if \(callerLimited\) \{\s+return new Response\(JSON\.stringify\(\{ error: 'That email already has a login\. Ask the owner to add it to this venue\.' \}\), \{ status: 403/);
  const limited = existing.indexOf('if (wantSections !== null) {');
  const link = existing.indexOf("await supabaseAdmin.from('user_locations')");
  assert.ok(existing.indexOf('if (callerLimited)') < link && limited > 0 && limited < link, 'both checks come before the venue link');
  assert.match(existing, /const canLimit = sectionsInstalled && callerIsOwner && !!target && target\.org_id === orgId && !isEverythingRole\(target\.role\);\s+if \(!canLimit\) \{\s+return new Response/);
  // A new login: the role write is checked (a new profile starts as 'owner', who opens everything).
  assert.match(fnCode, /\}\)\.eq\('id', userId\)\.select\('id, role'\);\s+if \(profileErr \|\| !savedProfile\?\.length \|\| savedProfile\[0\]\.role !== loginRole\) \{\s+return new Response/);
  // The list has its own write; a missing column does not stop the login, any other failure does,
  // and both come before the venue link.
  const tail = fnCode.slice(fnCode.indexOf('const { data: savedProfile, error: profileErr }'));
  assert.match(tail, /update\(\{ bo_sections: wantSections \}\)\.eq\('id', userId\);\s+if \(sectionsErr && isSectionsColumnMissing\(sectionsErr\)\) \{\s+sectionsInstalled = false;\s+\} else if \(sectionsErr\) \{\s+return new Response/);
  assert.match(tail, /if \(sectionsInstalled && wantSections !== null && !sameSections\(nowSections, wantSections\)\) \{\s+return new Response/);
  assert.ok(tail.indexOf('update({ bo_sections: wantSections })') < tail.indexOf("from('user_locations')"), 'the list is saved before the venue link');
  // The answer says what is stored, so an old function (no such field) can be told apart.
  assert.equal((fnCode.match(/sectionsApplied: sameSections\(nowSections, wantSections\), sections: nowSections, sectionsInstalled/g) || []).length, 2);
  // Still the first thing after CORS (secondStepWiring.test.js pins the exact lines).
  assert.match(fn, /import \{ secondStepRefusal \} from '\.\.\/_shared\/second-step\.ts';/);
});

test('it is described as a screen lock wherever the rule lives', () => {
  for (const f of ['./boSections.js', '../../supabase/functions/_shared/boSectionRules.js', '../../supabase/migrations/20261008a_OPS_bo_sections.sql'])
    assert.match(read(f), /SCREEN LOCK, NOT A DATABASE LOCK/, f);
  assert.match(bo, /A SCREEN lock, not a database lock/);
});

test('Inventory overview and Online ordering: a button to another part the login is not shown is left out', () => {
  assert.match(boCode, /\{section === 'stock-overview' && <StockOverview setSection=\{setSection\} canOpen=\{canOpen\} \/>\}/);
  assert.match(boCode, /\{section === 'online'\s+&& <OnlineOrdering setSection=\{setSection\} canOpen=\{canOpen\} \/>\}/);
  const stock = code(read('../backoffice/sections/StockOverview.jsx'));
  assert.match(stock, /export default function StockOverview\(\{ setSection, canOpen = \(\) => true \}\)/);
  assert.match(stock, /const can = \(s\) => !!setSection && canOpen\(s\);/);
  // Produce and Purchasing are other sections: every button to them asks first.
  for (const l of stock.split('\n').filter((l) => /go\('recipes'\)|go\('suppliers'\)/.test(l))) assert.match(l, /can\('(recipes|suppliers)'\) \? \(\) => go\('(recipes|suppliers)'\) : null/, l.trim());
  assert.match(stock, /\{can\(s\.to\) && <button onClick=\{\(\) => go\(s\.to\)\}/, 'the setup checklist');
  assert.match(stock, /\{onClick && <button onClick=\{onClick\}/, 'Attn draws no button when there is nowhere to go');
  const online = code(read('../backoffice/sections/OnlineOrdering.jsx'));
  assert.match(online, /export default function OnlineOrdering\(\{ setSection, canOpen = \(\) => true \}\)/);
  assert.match(online, /const can = \(s\) => !!setSection && canOpen\(s\);/);
  // Settings and Menu are other sections: a link to them is plain words for a login not shown them.
  for (const l of online.split('\n').filter((l) => /setSection\('location'\)/.test(l))) assert.match(l, /can\('location'\)/, l.trim());
  for (const l of online.split('\n').filter((l) => /setSection\('menu'\)/.test(l))) assert.match(l, /can\('menu'\)/, l.trim());
  assert.ok(online.includes('Ask the owner to check Location settings.'));
  assert.ok(online.includes('Ask the owner to define menus first.'));
});
