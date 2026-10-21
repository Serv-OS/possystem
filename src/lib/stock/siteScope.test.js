/**
 * siteScope.test.js: the site picker's rules (v5.11.89, multi site stock Drop 1, map 3 and 9.2).
 * Run: npm test. Synthetic ids and names only (the repo is public).
 *
 * The two promises checked over seeded random scopes: every choice resolves to sites inside this
 * login's list, and a one site company always resolves to the signed in venue with today's rights.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOpenSite, oneSiteScope, scopeFromRpc, companyShape, groupsFor, defaultChoice, resolveChoice, scopeSites,
  oneSiteOf, canEditCompany, canEditSite, choiceKey, bannerKey, readChoice, writeChoice, readBannerDismissed,
  writeBannerDismissed, bannerDue, listWords, editorsWords, sitesText, scopeName, scopeAnswer, firstNameOf,
  agoWords, savedFirstWords, LEVELS,
} from './siteScope.js';

const P = 'a1000000-0000-4000-8000-000000000001';   // the signed in venue
const L2 = 'a1000000-0000-4000-8000-000000000002';
const L3 = 'a1000000-0000-4000-8000-000000000003';
const SHUT = 'a1000000-0000-4000-8000-0000000000c1';
const ORG = 'b1000000-0000-4000-8000-000000000001';
const G1 = 'c1000000-0000-4000-8000-000000000001';

const site = (id, name, status = 'active') => ({ id, name, status, currency: 'GBP', kind: 'restaurant' });
const multiScope = (over = {}) => ({
  ready: true, failed: false, orgId: ORG, homeSite: P, openCount: 3, multiSince: '2026-10-21T08:00:00Z', multi: true,
  level: 'all', sections: null,
  sites: [site(P, 'North Cafe'), site(L2, 'South Cafe'), site(L3, 'Station Kiosk')],
  closedSites: [site(SHUT, 'Old Bakery', 'closed')],
  groups: [{ id: G1, name: 'North', locationIds: [P, L3], sortOrder: 0 }],
  kitchens: [], editors: ['Jane Smith', 'Tom Lee'],
  ...over,
});

// ── seeded random scopes ─────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const idN = (n) => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function randomCase(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const nOpen = 1 + Math.floor(rand() * 7);
  const nClosed = Math.floor(rand() * 3);
  const sites = Array.from({ length: nOpen }, (_, i) => site(idN(i + 1), `Site ${i + 1}`));
  const closedSites = Array.from({ length: nClosed }, (_, i) => site(idN(100 + i), `Closed ${i + 1}`, 'closed'));
  const all = [...sites, ...closedSites];
  const groups = Array.from({ length: Math.floor(rand() * 3) }, (_, g) => ({
    id: idN(500 + g), name: `Group ${g}`, sortOrder: g,
    locationIds: all.filter(() => rand() < 0.5).map((s) => s.id).concat(rand() < 0.2 ? [idN(999)] : []),
  }));
  const multi = rand() < 0.7;
  const scope = {
    ready: true, failed: false, orgId: ORG, homeSite: null, openCount: nOpen, multiSince: null, multi,
    level: pick(LEVELS), sections: rand() < 0.5 ? null : ['inventory'], sites, closedSites, groups, kitchens: [], editors: [],
  };
  const homeId = pick([...all.map((s) => s.id), idN(777), null]);
  scope.homeSite = homeId;
  const choice = pick([
    null, undefined, 'all', { kind: 'all' }, { kind: 'nope' }, { kind: 'group', id: pick([...groups.map((g) => g.id), idN(888)]) },
    { kind: 'site', id: pick([...all.map((s) => s.id), idN(777)]) }, { kind: 'site', id: pick(all).id, closed: rand() < 0.5 },
  ]);
  return { scope, homeId, choice, showClosed: rand() < 0.5 };
}

test('property: every choice resolves to sites inside this login\'s list (2,000 seeded runs)', () => {
  const rand = mulberry32(20261020);
  for (let i = 0; i < 2000; i++) {
    const { scope, homeId, choice, showClosed } = randomCase(rand);
    const open = new Set(scope.sites.map((s) => s.id));
    const closed = new Set(scope.closedSites.map((s) => s.id));
    const c = resolveChoice(scope, choice, homeId, { showClosed });
    assert.ok(['all', 'group', 'site'].includes(c.kind), `run ${i}: a real choice`);
    if (!scope.multi) {
      assert.deepEqual(c, { kind: 'site', id: homeId }, `run ${i}: one site company: the signed in venue`);
      assert.deepEqual(oneSiteOf(scope, choice, homeId, { showClosed }).id, homeId, `run ${i}: one site company works on the signed in venue`);
      continue;
    }
    const list = scopeSites(scope, c, { showClosed, homeId });
    for (const s of list) {
      const ok = open.has(s.id) || (closed.has(s.id) && (showClosed || c.closed === true));
      assert.ok(ok, `run ${i}: ${s.id} is in the login's list`);
    }
    if (c.kind === 'site') assert.ok(open.has(c.id) || closed.has(c.id), `run ${i}: a site choice names a listed site`);
    if (c.kind === 'group') assert.ok(groupsFor(scope).some((g) => g.id === c.id), `run ${i}: a group choice names a group in reach`);
    // resolving twice changes nothing
    assert.deepEqual(resolveChoice(scope, c, homeId, { showClosed }), c, `run ${i}: stable`);
    // the one site, when there is one, is in the list; on All sites with several sites there is none
    const one = oneSiteOf(scope, choice, homeId, { showClosed });
    if (one) assert.ok(open.has(one.id) || closed.has(one.id), `run ${i}: the one site is listed`);
    if (c.kind === 'all' && scope.sites.length > 1) assert.equal(one, null, `run ${i}: All sites is not one site`);
    if (c.kind === 'site') assert.equal(one?.id, c.id, `run ${i}: a site choice is that site`);
    // the default is always a good choice
    const d = defaultChoice(scope, homeId);
    assert.deepEqual(resolveChoice(scope, d, homeId), d, `run ${i}: the default resolves to itself`);
  }
});

test('property: a one site company always gets the signed in venue and today\'s rights (1,000 seeded runs)', () => {
  const rand = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const { scope, homeId, choice, showClosed } = randomCase(rand);
    const one = { ...scope, multi: false };
    const a = scopeAnswer({ scope: one, choice, homeId, access: { role: 'manager', sections: ['inventory'] }, userId: 'u1', showClosed });
    assert.equal(a.multi, false);
    assert.equal(a.oneSite.id, homeId, `run ${i}`);
    assert.equal(a.isAll, false); assert.equal(a.isGroup, false);
    assert.equal(a.canEditCompany('inventory'), true, 'the Back Office section rule');
    assert.equal(a.canEditCompany('produce'), false, 'the Back Office section rule');
    assert.equal(a.canEditSite(homeId, 'site_price'), true);
    assert.equal(a.canEditSite(homeId, 'site_facts'), true);
  }
});

// ── the pieces ───────────────────────────────────────────────────────────────────────────────────
test('isOpenSite: active or no status is open', () => {
  assert.equal(isOpenSite(site(P, 'x')), true);
  assert.equal(isOpenSite({ id: P }), true);
  assert.equal(isOpenSite({ id: P, status: 'ACTIVE' }), true);
  assert.equal(isOpenSite({ id: P, status: 'closed' }), false);
  assert.equal(isOpenSite(null), false);
});

test('oneSiteScope: the signed in venue alone, multi false, failed by default', () => {
  const s = oneSiteScope(P);
  assert.equal(s.ready, true); assert.equal(s.failed, true); assert.equal(s.multi, false);
  assert.deepEqual(s.sites.map((x) => x.id), [P]);
  assert.equal(oneSiteScope(P, { failed: false }).failed, false);
  assert.deepEqual(oneSiteScope(null).sites, []);
});

test('scopeFromRpc: the database answer in camelCase; anything unusable is a failed one site scope', () => {
  const s = scopeFromRpc({
    org_id: ORG, home_site: P, open_count: 2, multi_since: '2026-10-21T08:00:00Z', multi: true, level: 'sites_full', sections: ['inventory', 'purchasing'],
    sites: [{ id: P, name: 'North Cafe', status: 'active', currency: 'GBP', kind: 'restaurant' }, { id: L2, name: 'South Cafe', status: 'active', currency: 'GBP', kind: null }],
    closed_sites: [{ id: SHUT, name: 'Old Bakery', status: 'closed', currency: 'GBP', kind: 'restaurant' }],
    groups: [{ id: G1, name: 'North', location_ids: [P], sort_order: 2 }], kitchens: [], editors: ['Jane Smith', ' '],
  }, P);
  assert.equal(s.failed, false); assert.equal(s.multi, true); assert.equal(s.level, 'sites_full'); assert.equal(s.orgId, ORG);
  assert.equal(s.homeSite, P); assert.equal(s.openCount, 2); assert.deepEqual(s.sections, ['inventory', 'purchasing']);
  assert.deepEqual(s.sites.map((x) => x.name), ['North Cafe', 'South Cafe']);
  assert.deepEqual(s.closedSites.map((x) => x.id), [SHUT]);
  assert.deepEqual(s.groups, [{ id: G1, name: 'North', locationIds: [P], sortOrder: 2 }]);
  assert.deepEqual(s.editors, ['Jane Smith']);
  assert.equal(scopeFromRpc({ ...s, level: 'boss', sites: [{ id: P }] }, P).level, 'sites', 'an unknown level is the lowest');
  assert.equal(scopeFromRpc({ multi: 'yes', sites: [{ id: P }] }, P).multi, false, 'only true is multi');
  for (const bad of [null, undefined, 'x', [], {}, { sites: [] }]) {
    const f = scopeFromRpc(bad, P);
    assert.equal(f.failed, true); assert.equal(f.multi, false); assert.equal(f.homeSite, P);
  }
  assert.deepEqual(companyShape(s), { multi: true, sites: s.sites, closed: s.closedSites });
});

test('defaultChoice: All sites for level all; the signed in venue for others, else their first site', () => {
  assert.deepEqual(defaultChoice(multiScope(), P), { kind: 'all' });
  assert.deepEqual(defaultChoice(multiScope({ level: 'sites' }), L2), { kind: 'site', id: L2 });
  assert.deepEqual(defaultChoice(multiScope({ level: 'sites_full' }), 'elsewhere'), { kind: 'site', id: P });
  assert.deepEqual(defaultChoice(multiScope({ level: 'all', sites: [site(L2, 'South Cafe')] }), P), { kind: 'site', id: L2 }, 'one site in the list');
});

test('resolveChoice: a gone site, a gone group, a closed site not shown, or junk falls back', () => {
  const s = multiScope();
  assert.deepEqual(resolveChoice(s, { kind: 'site', id: L2 }, P), { kind: 'site', id: L2 });
  assert.deepEqual(resolveChoice(s, { kind: 'site', id: 'gone' }, P), { kind: 'all' });
  assert.deepEqual(resolveChoice(s, { kind: 'group', id: G1 }, P), { kind: 'group', id: G1 });
  assert.deepEqual(resolveChoice(s, { kind: 'group', id: 'gone' }, P), { kind: 'all' });
  assert.deepEqual(resolveChoice(s, { kind: 'site', id: SHUT }, P), { kind: 'all' }, 'closed and not shown');
  assert.deepEqual(resolveChoice(s, { kind: 'site', id: SHUT }, P, { showClosed: true }), { kind: 'site', id: SHUT, closed: true });
  assert.deepEqual(resolveChoice(s, { kind: 'site', id: SHUT, closed: true }, P), { kind: 'site', id: SHUT, closed: true }, 'picked from the shown list');
  assert.deepEqual(resolveChoice(s, 'all', P), { kind: 'all' });
  assert.deepEqual(resolveChoice(s, null, P), { kind: 'all' });
  assert.deepEqual(resolveChoice(multiScope({ level: 'sites' }), { kind: 'nope' }, L3), { kind: 'site', id: L3 });
  assert.deepEqual(resolveChoice({ ...s, multi: false }, { kind: 'site', id: L2 }, P), { kind: 'site', id: P }, 'one site company: always the signed in venue');
  assert.deepEqual(resolveChoice(null, { kind: 'all' }, P), { kind: 'site', id: P });
});

test('groupsFor: only groups whose every site is in the list, sorted', () => {
  const s = multiScope({ groups: [
    { id: 'g2', name: 'South', locationIds: [L2], sortOrder: 1 },
    { id: 'g0', name: 'Far', locationIds: [P, 'not-in-reach'], sortOrder: 0 },
    { id: G1, name: 'North', locationIds: [P, L3], sortOrder: 0 },
    { id: 'g9', name: 'Empty', locationIds: [], sortOrder: 0 },
  ] });
  assert.deepEqual(groupsFor(s).map((g) => g.name), ['North', 'South']);
  assert.deepEqual(groupsFor(null), []);
});

test('scopeSites and oneSiteOf: All sites, a group, a site; a one site company is its venue', () => {
  const s = multiScope();
  assert.deepEqual(scopeSites(s, { kind: 'all' }).map((x) => x.id), [P, L2, L3]);
  assert.deepEqual(scopeSites(s, { kind: 'all' }, { showClosed: true }).map((x) => x.id), [P, L2, L3, SHUT]);
  assert.deepEqual(scopeSites(s, { kind: 'group', id: G1 }).map((x) => x.id), [P, L3]);
  assert.deepEqual(scopeSites(s, { kind: 'site', id: L2 }).map((x) => x.id), [L2]);
  assert.equal(oneSiteOf(s, { kind: 'all' }, P), null);
  assert.equal(oneSiteOf(s, { kind: 'group', id: G1 }, P), null);
  assert.equal(oneSiteOf(s, { kind: 'site', id: L2 }, P).name, 'South Cafe');
  assert.equal(oneSiteOf(multiScope({ sites: [site(L2, 'South Cafe')], closedSites: [] }), { kind: 'all' }, P).id, L2, 'a login with one site');
  assert.deepEqual(oneSiteOf(null, { kind: 'all' }, P), { id: P }, 'no scope yet: the signed in venue');
  assert.equal(oneSiteOf({ ...s, multi: false }, { kind: 'site', id: L2 }, P).id, P);
  assert.deepEqual(scopeSites(oneSiteScope(P), { kind: 'all' }, { homeId: P }).map((x) => x.id), [P]);
});

test('canEditCompany: one site company = the section rule; multi = level all and the section', () => {
  const one = oneSiteScope(P);
  assert.equal(canEditCompany(one, 'inventory', { role: 'manager', sections: null }), true);
  assert.equal(canEditCompany(one, 'produce', { role: 'manager', sections: ['inventory'] }), false);
  assert.equal(canEditCompany(one, 'produce', { role: 'owner', sections: ['inventory'] }), true, 'an owner opens everything');
  assert.equal(canEditCompany(one, 'inventory', null), false, 'nobody signed in');
  assert.equal(canEditCompany(multiScope(), 'inventory', { role: 'manager', sections: null }), true);
  assert.equal(canEditCompany(multiScope({ sections: ['purchasing'] }), 'inventory', { role: 'manager' }), false, 'all, Purchasing only: no item edits');
  assert.equal(canEditCompany(multiScope({ sections: ['purchasing'] }), 'purchasing', { role: 'manager' }), true);
  assert.equal(canEditCompany(multiScope({ sections: ['team'] }), 'inventory', { role: 'owner' }), true, 'an owner of this company ignores a stored list (server level all)');
  for (const level of ['sites', 'sites_full']) {
    assert.equal(canEditCompany(multiScope({ level }), 'inventory', { role: 'owner', sections: null }), false, `${level}: an owner of ANOTHER company is not all here`);
  }
});

test('canEditSite: facts at any listed site; price here only at sites_full or all; one site company always', () => {
  assert.equal(canEditSite(multiScope({ level: 'sites' }), P, 'site_facts'), true);
  assert.equal(canEditSite(multiScope({ level: 'sites' }), P, 'site_price'), false);
  assert.equal(canEditSite(multiScope({ level: 'sites_full' }), P, 'site_price'), true);
  assert.equal(canEditSite(multiScope({ level: 'sites_full' }), 'other', 'site_price'), false, 'not their site');
  assert.equal(canEditSite(multiScope({ level: 'all' }), SHUT, 'site_facts'), true, 'a closed site in reach');
  assert.equal(canEditSite(multiScope(), P, 'company'), false, 'unknown what');
  assert.equal(canEditSite(oneSiteScope(P), P, 'site_price'), true);
  assert.equal(canEditSite(null, P, 'site_facts'), true);
});

test('the remembered choice: its own key, never rpos-, shape checked, every touch survives a throwing store', () => {
  assert.equal(choiceKey('u1', ORG), `servos-stock-sites:u1:${ORG}`);
  assert.equal(bannerKey('u1', ORG), `servos-stock-banner:u1:${ORG}`);
  assert.ok(!choiceKey('u1', ORG).startsWith('rpos-') && !bannerKey('u1', ORG).startsWith('rpos-'));
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(readChoice('u1', ORG, store), null);
  assert.equal(writeChoice('u1', ORG, { kind: 'site', id: SHUT, closed: true }, store), true);
  assert.deepEqual(readChoice('u1', ORG, store), { kind: 'site', id: SHUT }, 'the closed flag is never kept');
  writeChoice('u1', ORG, { kind: 'all' }, store);
  assert.deepEqual(readChoice('u1', ORG, store), { kind: 'all' });
  mem.set(choiceKey('u1', ORG), '{"kind":"site"}');
  assert.equal(readChoice('u1', ORG, store), null);
  mem.set(choiceKey('u1', ORG), 'not json');
  assert.equal(readChoice('u1', ORG, store), null);
  assert.equal(writeChoice(null, ORG, { kind: 'all' }, store), false);
  assert.equal(writeChoice('u1', ORG, { kind: 'bad', id: 'x' }, store), false);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readChoice('u1', ORG, broken), null);
  assert.equal(writeChoice('u1', ORG, { kind: 'all' }, broken), false);
  assert.equal(readBannerDismissed('u1', ORG, broken), null);
  assert.equal(writeBannerDismissed('u1', ORG, 'x', broken), false);
  assert.equal(writeBannerDismissed('u1', ORG, '2026-10-22T09:00:00Z', store), true);
  assert.equal(readBannerDismissed('u1', ORG, store), '2026-10-22T09:00:00Z');
});

test('bannerDue: level all in a multi site company, newer than the last dismissal', () => {
  const since = '2026-10-21T08:00:00Z';
  assert.equal(bannerDue({ multi: true, level: 'all', multiSince: since }), true);
  assert.equal(bannerDue({ multi: true, level: 'all', multiSince: since, dismissedAt: '2026-10-22T08:00:00Z' }), false);
  assert.equal(bannerDue({ multi: true, level: 'all', multiSince: since, dismissedAt: '2026-10-20T08:00:00Z' }), true, 'a newer site after the last dismissal');
  assert.equal(bannerDue({ multi: true, level: 'sites', multiSince: since }), false);
  assert.equal(bannerDue({ multi: false, level: 'all', multiSince: since }), false, 'never for a one site company');
  assert.equal(bannerDue({ multi: true, level: 'all', multiSince: null }), false);
});

test('words: editors, lists, the Sites cell, the picker name', () => {
  assert.equal(editorsWords([]), 'head office');
  assert.equal(editorsWords(['Jane Smith']), 'Jane Smith');
  assert.equal(editorsWords(['Jane Smith', 'Tom Lee']), 'Jane Smith or Tom Lee');
  assert.equal(editorsWords(['Jane Smith', 'Tom Lee', 'Sam Ray']), 'Jane Smith, Tom Lee or Sam Ray');
  assert.equal(editorsWords(['Jane Smith', '', null]), 'Jane Smith');
  assert.equal(listWords(['North Cafe', 'South Cafe']), 'North Cafe and South Cafe');
  assert.equal(listWords([]), '');
  const byId = new Map([[P, { name: 'North Cafe' }], [L2, { name: 'South Cafe' }], [L3, { name: 'Station Kiosk' }]]);
  const ids = [P, L2, L3];
  assert.equal(sitesText({ onIds: [P, L2, L3], scopeIds: ids, siteById: byId }), 'All 3');
  assert.equal(sitesText({ onIds: [P, L2], scopeIds: ids, siteById: byId }), '2 of 3');
  assert.equal(sitesText({ onIds: [L2], scopeIds: ids, siteById: byId }), 'South Cafe');
  assert.equal(sitesText({ onIds: [L2], scopeIds: ids, siteById: byId, localId: L2 }), 'Local to South Cafe');
  assert.equal(sitesText({ onIds: [], scopeIds: ids, siteById: byId }), 'None here');
  assert.equal(sitesText({ onIds: ['elsewhere'], scopeIds: ids, siteById: byId }), 'None here', 'only sites in scope count');
  assert.equal(sitesText({ onIds: [P], scopeIds: [P], siteById: { [P]: { name: 'North Cafe' } } }), 'North Cafe', 'one site in scope: its name');
  const s = multiScope();
  assert.equal(scopeName(s, { kind: 'all' }), 'All sites');
  assert.equal(scopeName(s, { kind: 'group', id: G1 }), 'North');
  assert.equal(scopeName(s, { kind: 'site', id: L2 }), 'South Cafe');
  assert.equal(scopeName(s, { kind: 'site', id: SHUT, closed: true }), 'Old Bakery');
});

test('scopeAnswer: what useStockScope hands a screen', () => {
  const loading = scopeAnswer({ scope: null, homeId: P, access: { role: 'manager', sections: null } });
  assert.equal(loading.ready, false); assert.equal(loading.multi, false); assert.equal(loading.oneSite.id, P);
  const noProvider = scopeAnswer({ scope: oneSiteScope(null, { failed: false }) });
  assert.equal(noProvider.ready, true); assert.equal(noProvider.multi, false);
  assert.equal(noProvider.canEditCompany('inventory'), true, 'no provider: everything editable by today\'s rule');
  const a = scopeAnswer({ scope: multiScope(), choice: { kind: 'group', id: G1 }, homeId: P, access: { role: 'manager', sections: null }, userId: 'u1' });
  assert.equal(a.isGroup, true); assert.equal(a.isAll, false); assert.equal(a.oneSite, null);
  assert.equal(a.group.name, 'North'); assert.deepEqual(a.scopeSites.map((x) => x.id), [P, L3]);
  assert.equal(a.siteName(L2), 'South Cafe'); assert.equal(a.siteName(SHUT), 'Old Bakery'); assert.equal(a.siteName('x'), '');
  assert.equal(a.editorsText, 'Jane Smith or Tom Lee');
  assert.equal(a.multiSince, '2026-10-21T08:00:00Z');
  assert.equal(a.canEditCompany('inventory'), true);
  const mgr = scopeAnswer({ scope: multiScope({ level: 'sites', sites: [site(L2, 'South Cafe')], closedSites: [], groups: [] }), homeId: L2, access: { role: 'manager', sections: null } });
  assert.equal(mgr.oneSite.id, L2); assert.equal(mgr.canEditCompany('inventory'), false);
  assert.equal(mgr.canEditSite(L2, 'site_facts'), true); assert.equal(mgr.canEditSite(L2, 'site_price'), false);
  assert.equal(mgr.canEditSite(P, 'site_facts'), false, 'not their site');
});

test('saved first words: the title, the one change, more changes, the first name', () => {
  const now = Date.parse('2026-10-22T14:07:00Z');
  assert.equal(agoWords('2026-10-22T14:05:00Z', now), '2 minutes ago');
  assert.equal(agoWords('2026-10-22T14:06:00Z', now), '1 minute ago');
  assert.equal(agoWords('2026-10-22T14:06:50Z', now), 'just now');
  assert.match(agoWords('2026-10-22T12:05:00Z', now), /^at \d\d:\d\d$/);
  assert.equal(agoWords('not a date', now), 'just now');
  assert.equal(firstNameOf('Tom Lee'), 'Tom'); assert.equal(firstNameOf(''), 'Someone');
  const one = savedFirstWords({ byName: 'Tom Lee', at: '2026-10-22T14:05:00Z', rows: [{ label: 'Shelf life', theirs: '7 days', mine: '10 days' }], nowMs: now });
  assert.equal(one.title, 'Tom Lee changed this 2 minutes ago');
  assert.equal(one.words, 'Tom Lee changed Shelf life from 10 days to 7 days.');
  assert.equal(one.first, 'Tom');
  const two = savedFirstWords({ byName: 'Tom Lee', at: '2026-10-22T14:05:00Z', rows: [{}, {}], nowMs: now });
  assert.equal(two.words, 'Tom Lee changed 2 things.');
  assert.equal(savedFirstWords({ byName: null, rows: [] }).words, 'Someone saved this first.');
});

test('no long dashes in this file\'s words', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./siteScope.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});
