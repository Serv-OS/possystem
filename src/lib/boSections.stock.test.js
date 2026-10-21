// boSections.stock.test.js: the Back Office sidebar and titles with the stock site scope
// (v5.11.89, multi site stock Drop 1, map 2.2, 2.4 and 9.2).
//
// Rule 2: a one site company sees EXACTLY today's sidebar and titles, loading or not. A multi site
// company sees one relabel (Batches reads "Batch and prep"); Drop 1 adds no route and no gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NAV_IA, BETA_ROUTES, MSM_ROUTE, LABEL_WHEN_MULTI, filterNav, routeLabel, stockAccessOf, canOpenRoute, firstAllowedRoute,
  guardRoute, routesOfRow,
} from './boSections.js';
import { oneSiteScope } from './stock/siteScope.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const allRoutes = NAV_IA.flatMap(routesOfRow);
const NAV_NO_MSM = NAV_IA.map((r) => (r.children ? { ...r, children: r.children.filter((c) => c[0] !== MSM_ROUTE) } : r));

const PEOPLE = {
  owner: { role: 'owner', sections: null },
  servos: { role: 'super_admin', sections: null },
  manager: { role: 'manager', sections: null },
  mo: { role: 'manager', sections: ['workforce', 'reports', 'team', 'customers'] },
  produce: { role: 'manager', sections: ['produce', 'inventory'] },
  nothing: { role: 'manager', sections: [] },
};
const MULTI = { org_id: 'o', multi: true, level: 'all', sites: [{ id: 'a' }, { id: 'b' }], kitchens: [], sections: null };
const STOCK = {
  loading: stockAccessOf(null),
  failed: stockAccessOf(oneSiteScope('a')),
  oneSite: stockAccessOf({ ...oneSiteScope('a', { failed: false }), level: 'all' }),
  multi: stockAccessOf(MULTI),
};

test('stockAccessOf: null while loading (ready false, multi false); the scope\'s facts once read', () => {
  assert.deepEqual(STOCK.loading, { ready: false, multi: false, level: 'sites', hasKitchen: false, reachesKitchen: false, sections: null });
  assert.equal(STOCK.failed.ready, true); assert.equal(STOCK.failed.multi, false);
  assert.deepEqual(stockAccessOf({ multi: true, level: 'sites_full', kitchens: ['k1'], sections: ['inventory'] }),
    { ready: true, multi: true, level: 'sites_full', hasKitchen: true, reachesKitchen: true, sections: ['inventory'] });
});

test('one site company (and while the scope loads or fails): the filtered sidebar is today\'s, row for row', () => {
  for (const [who, profile] of Object.entries(PEOPLE)) {
    const today = filterNav(NAV_IA, profile);
    for (const [state, stock] of [['loading', STOCK.loading], ['failed', STOCK.failed], ['one site', STOCK.oneSite]]) {
      const withStock = { ...profile, stock };
      assert.deepEqual(filterNav(NAV_IA, withStock), today, `${who}, ${state}`);
      assert.equal(firstAllowedRoute(withStock), firstAllowedRoute(profile), `${who}, ${state}: the same landing page`);
      for (const id of allRoutes) assert.equal(canOpenRoute(id, withStock), canOpenRoute(id, profile), `${who}, ${state}: ${id}`);
    }
  }
  // the owner's sidebar is NAV_IA less the Multi site menu, as before; added by name, the very same array
  assert.deepEqual(filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.oneSite }), NAV_NO_MSM);
  const named = { ...PEOPLE.owner, multiSiteMenu: { canOpen: true }, stock: STOCK.oneSite };
  assert.equal(filterNav(NAV_IA, named), NAV_IA, 'nothing changed: the same array comes back');
  // and the labels stay today's
  const produce = filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.oneSite }).find((r) => r.label === 'Produce');
  assert.deepEqual(produce.children, [['recipes', 'Recipes'], ['batches', 'Batches']]);
});

test('multi site company: the Produce row reads "Batch and prep"; nothing else in the sidebar moves', () => {
  assert.deepEqual({ ...LABEL_WHEN_MULTI }, { batches: 'Batch and prep' });
  assert.ok(Object.isFrozen(LABEL_WHEN_MULTI));
  for (const [who, profile] of Object.entries(PEOPLE)) {
    const today = filterNav(NAV_IA, profile);
    const multi = filterNav(NAV_IA, { ...profile, stock: STOCK.multi });
    assert.deepEqual(multi.map((r) => r.label), today.map((r) => r.label), `${who}: the same groups`);
    for (let i = 0; i < today.length; i++) {
      const want = today[i].children ? today[i].children.map(([id, label]) => [id, LABEL_WHEN_MULTI[id] || label]) : undefined;
      assert.deepEqual(multi[i].children, want, `${who}: ${today[i].label}`);
    }
    for (const id of allRoutes) assert.equal(canOpenRoute(id, { ...profile, stock: STOCK.multi }), canOpenRoute(id, profile), `${who}: no new gate on ${id}`);
    assert.equal(guardRoute('batches', { ...profile, stock: STOCK.multi }), guardRoute('batches', profile));
  }
  const produce = filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.multi }).find((r) => r.label === 'Produce');
  assert.deepEqual(produce.children, [['recipes', 'Recipes'], ['batches', 'Batch and prep']]);
  // NAV_IA itself is never changed
  assert.deepEqual(NAV_IA.find((r) => r.label === 'Produce').children, [['recipes', 'Recipes'], ['batches', 'Batches']]);
});

test('routeLabel: the multi site name only for a multi site company, else the caller\'s own title', () => {
  assert.equal(routeLabel('batches', 'Batches', { role: 'owner', stock: STOCK.multi }), 'Batch and prep');
  for (const stock of [STOCK.loading, STOCK.failed, STOCK.oneSite, undefined]) assert.equal(routeLabel('batches', 'Batches', { role: 'owner', stock }), 'Batches');
  assert.equal(routeLabel('batches', 'Batches', null), 'Batches');
  assert.equal(routeLabel('recipes', 'Recipes', { stock: STOCK.multi }), 'Recipes');
  assert.equal(routeLabel('wf-rota', 'Workforce', { stock: STOCK.multi }), 'Workforce');
  assert.equal(routeLabel(null, '', { stock: STOCK.multi }), '');
});

test('Drop 1 adds no route: no multi-site-stock, the BETA list is exactly the Multi site menu', () => {
  assert.ok(!allRoutes.includes('multi-site-stock'), 'Menu > Multi site stock never comes back');
  assert.deepEqual([...BETA_ROUTES], [MSM_ROUTE]);
  assert.equal(allRoutes.length, 93, 'the same 93 routes as v5.11.84');
  assert.doesNotMatch(read('./boSections.js'), /multi-site-stock/);
});

test('every stock route has a title row in BackOfficeApp NAV; the routes with none are exactly today\'s', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  const nav = bo.slice(bo.indexOf('const NAV = ['), bo.indexOf('];', bo.indexOf('const NAV = [')));
  const titled = new Set([...nav.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'\s*,\s*label:\s*'[^']+'/g)].map((m) => m[1]));
  const stockRows = NAV_IA.filter((r) => ['Inventory', 'Produce', 'Purchasing'].includes(r.label));
  for (const id of stockRows.flatMap(routesOfRow)) assert.ok(titled.has(id), `no top bar title for ${id}`);
  // Not every sidebar route had a top bar title on v5.11.84 (main, 20 Oct): these 15 show a blank
  // title today. Drop 1 adds no route and changes none of them (Rule 2: today's screens).
  const untitled = allRoutes.filter((id) => !id.startsWith('wf-') && !titled.has(id));
  assert.deepEqual(untitled, ['catering', 'catering-orders', 'hubrise', 'uber-direct', 'deliveries-live', 'waitlist', 'table-bookings',
    'packages', 'menu-appearance', 'menuboards', 'order-screens', 'print-menu', 'waitlist-insights', 'sending-domain', 'xero']);
  // the top bar reads the multi site label through routeLabel, after today's NAV title
  assert.match(bo, /\{routeLabel\(section, NAV\.find\(n => n\.id === section\)\?\.label \|\| \(section\?\.startsWith\('wf-'\) \? 'Workforce' : ''\), access\)\}/);
});
