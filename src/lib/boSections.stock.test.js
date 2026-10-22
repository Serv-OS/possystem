// boSections.stock.test.js: the Back Office sidebar and titles with the stock site scope
// (v5.11.89, multi site stock Drop 1, map 2.2, 2.4 and 9.2; v5.11.92, Drop 4a, contract 2.2).
//
// Rule 2: a one site company sees EXACTLY today's sidebar and titles, loading or not. A multi site
// company sees one relabel (Batches reads "Batch and prep"); Drop 1 adds no route and no gate.
// v5.11.96 (Drop 3, contract 3.1): six routes join, each gated to a multi site company whose scope is
// read: Due to order, Forecast, Deliveries, Credits, Budgets, and Central kitchen (only with a
// kitchen, for head office or a login that reaches the kitchen).
// Drop 4a adds one route swap for a multi site company: Reports > Stock and GP (stock-gp) opens and
// Inventory > Reports (stock-reports) forwards to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NAV_IA, BETA_ROUTES, MSM_ROUTE, LABEL_WHEN_MULTI, filterNav, routeLabel, stockAccessOf, canOpenRoute, firstAllowedRoute,
  guardRoute, routesOfRow, allowedKeys, STOCK_GP_ROUTE, STOCK_REPORTS_ROUTE, STOCK_REPORTS_ALIAS, routeGateOk,
} from './boSections.js';
import { oneSiteScope } from './stock/siteScope.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const allRoutes = NAV_IA.flatMap(routesOfRow);
const without = (nav, ids) => nav.map((r) => (r.children ? { ...r, children: r.children.filter((c) => !ids.includes(c[0])) } : r));
const STOCK_GATED = ['central-kitchen', 'due-to-order', 'forecast', 'stock-deliveries', 'credits', 'budgets'];
// The Drop 4a pair: Stock and GP opens and Inventory > Reports forwards, for a multi site company only.
const GATED = [STOCK_GP_ROUTE, STOCK_REPORTS_ROUTE];
// What a profile with no multi site stock scope sees: today's sidebar less the Multi site menu, the
// Drop 3 stock routes and Stock and GP; added by name, less only the stock routes.
const NAV_NO_MSM = without(NAV_IA, [MSM_ROUTE, ...STOCK_GATED, STOCK_GP_ROUTE]);
const NAV_NO_STOCK3 = without(NAV_IA, [...STOCK_GATED, STOCK_GP_ROUTE]);
const PURCHASING_MULTI = [['order-pad', 'Order pad'], ['due-to-order', 'Due to order'], ['forecast', 'Forecast'], ['suppliers', 'Suppliers'],
  ['purchase-orders', 'Orders'], ['stock-deliveries', 'Deliveries'], ['invoices', 'Invoices'], ['credits', 'Credits'], ['price-changes', 'Price changes'], ['budgets', 'Budgets']];

const PEOPLE = {
  owner: { role: 'owner', sections: null },
  servos: { role: 'super_admin', sections: null },
  manager: { role: 'manager', sections: null },
  mo: { role: 'manager', sections: ['workforce', 'reports', 'team', 'customers'] },
  produce: { role: 'manager', sections: ['produce', 'inventory'] },
  buyer: { role: 'manager', sections: ['purchasing', 'reports'] },
  nothing: { role: 'manager', sections: [] },
};
const MULTI = { org_id: 'o', multi: true, level: 'all', sites: [{ id: 'a' }, { id: 'b' }], kitchens: [], sections: null };
const MULTI_KITCHEN = { ...MULTI, kitchens: ['k'], sites: [{ id: 'a' }, { id: 'k' }] };
const STOCK = {
  loading: stockAccessOf(null),
  failed: stockAccessOf(oneSiteScope('a')),
  oneSite: stockAccessOf({ ...oneSiteScope('a', { failed: false }), level: 'all' }),
  multi: stockAccessOf(MULTI),
  kitchenAll: stockAccessOf(MULTI_KITCHEN),
  kitchenSiteHere: stockAccessOf({ ...MULTI_KITCHEN, level: 'sites' }),
  kitchenSiteAway: stockAccessOf({ ...MULTI_KITCHEN, level: 'sites', sites: [{ id: 'a' }, { id: 'b' }] }),
};
// Does this login's section list reach stock (Inventory, Produce or Purchasing, or everything)?
const allowsStock = (p) => { const a = allowedKeys(p); return a === null || ['inventory', 'produce', 'purchasing'].some((k) => a.includes(k)); };

test('stockAccessOf: null while loading (ready false, multi false); the scope\'s facts once read', () => {
  assert.deepEqual(STOCK.loading, { ready: false, multi: false, level: 'sites', hasKitchen: false, reachesKitchen: false, sections: null });
  assert.equal(STOCK.failed.ready, true); assert.equal(STOCK.failed.multi, false);
  assert.deepEqual(stockAccessOf({ multi: true, level: 'sites_full', kitchens: ['k1'], sites: [{ id: 'k1' }], sections: ['inventory'] }),
    { ready: true, multi: true, level: 'sites_full', hasKitchen: true, reachesKitchen: true, sections: ['inventory'] });
  // Drop 3: reachesKitchen is a kitchen among the login's own sites, not any kitchen in the company
  assert.deepEqual(stockAccessOf({ multi: true, level: 'sites', kitchens: ['k1'], sites: [{ id: 'a' }], sections: null }),
    { ready: true, multi: true, level: 'sites', hasKitchen: true, reachesKitchen: false, sections: null });
  assert.equal(stockAccessOf({ multi: true, kitchens: ['k1'] }).reachesKitchen, false, 'no sites: reaches no kitchen');
});

test('one site company (and while the scope loads or fails): the filtered sidebar is today\'s, row for row', () => {
  for (const [who, profile] of Object.entries(PEOPLE)) {
    const today = filterNav(NAV_IA, profile);
    for (const [state, stock] of [['loading', STOCK.loading], ['failed', STOCK.failed], ['one site', STOCK.oneSite]]) {
      const withStock = { ...profile, stock };
      assert.deepEqual(filterNav(NAV_IA, withStock), today, `${who}, ${state}`);
      assert.equal(firstAllowedRoute(withStock), firstAllowedRoute(profile), `${who}, ${state}: the same landing page`);
      for (const id of allRoutes) assert.equal(canOpenRoute(id, withStock), canOpenRoute(id, profile), `${who}, ${state}: ${id}`);
      assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, withStock), STOCK_REPORTS_ROUTE, `${who}, ${state}: Inventory > Reports stays itself`);
    }
  }
  // the owner's sidebar is NAV_IA less the Multi site menu, the Drop 3 stock routes and Stock and GP;
  // added by name, less only the stock routes (Stock and GP still hidden)
  assert.deepEqual(filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.oneSite }), NAV_NO_MSM);
  const named = { ...PEOPLE.owner, multiSiteMenu: { canOpen: true }, stock: STOCK.oneSite };
  assert.deepEqual(filterNav(NAV_IA, named), NAV_NO_STOCK3, 'added by name: today\'s sidebar, Stock and GP still hidden');
  for (const id of STOCK_GATED) for (const stock of [STOCK.loading, STOCK.failed, STOCK.oneSite]) assert.equal(canOpenRoute(id, { ...PEOPLE.owner, stock }), false, id);
  // a multi site company whose scope is not ready yet: still no
  for (const id of STOCK_GATED) assert.equal(canOpenRoute(id, { ...PEOPLE.owner, stock: { ...STOCK.kitchenAll, ready: false } }), false, `${id} while loading`);
  // Purchasing stays today's five
  const purchasing = filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.oneSite }).find((r) => r.label === 'Purchasing');
  assert.deepEqual(purchasing.children, [['order-pad', 'Order pad'], ['suppliers', 'Suppliers'], ['purchase-orders', 'Orders'], ['invoices', 'Invoices'], ['price-changes', 'Price changes']]);
  // and the labels stay today's
  const produce = filterNav(NAV_IA, { ...PEOPLE.owner, stock: STOCK.oneSite }).find((r) => r.label === 'Produce');
  assert.deepEqual(produce.children, [['recipes', 'Recipes'], ['batches', 'Batches']]);
  // a one site company never sees Stock and GP and keeps Inventory > Reports
  assert.equal(canOpenRoute(STOCK_GP_ROUTE, { ...PEOPLE.owner, stock: STOCK.oneSite }), false);
  assert.equal(canOpenRoute(STOCK_REPORTS_ROUTE, { ...PEOPLE.owner, stock: STOCK.oneSite }), true);
});

test('multi site company: "Batch and prep", the 10 Purchasing screens in order, Central kitchen only with a kitchen; Stock and GP opens and Inventory > Reports forwards', () => {
  assert.deepEqual({ ...LABEL_WHEN_MULTI }, { batches: 'Batch and prep' });
  assert.ok(Object.isFrozen(LABEL_WHEN_MULTI));
  const want = (label, kitchen, profile) => NAV_IA.find((r) => r.label === label).children
    .filter((c) => c[0] !== MSM_ROUTE && (kitchen || c[0] !== 'central-kitchen'))
    // Drop 4a: Inventory > Reports forwards; Stock and GP shows for a login whose sections reach stock
    .filter((c) => c[0] !== STOCK_REPORTS_ROUTE && (c[0] !== STOCK_GP_ROUTE || allowsStock(profile)))
    .map(([id, l]) => [id, LABEL_WHEN_MULTI[id] || l]);
  for (const [who, profile] of Object.entries(PEOPLE)) {
    const today = filterNav(NAV_IA, profile);
    for (const [state, stock, kitchen] of [['multi', STOCK.multi, false], ['kitchen', STOCK.kitchenAll, true]]) {
      const withStock = { ...profile, stock };
      const multi = filterNav(NAV_IA, withStock);
      assert.deepEqual(multi.map((r) => r.label), today.map((r) => r.label), `${who}, ${state}: the same groups`);
      for (const row of multi) if (row.children) assert.deepEqual(row.children, want(row.label, kitchen, profile), `${who}, ${state}: ${row.label}`);
      for (const id of allRoutes) {
        // a gated stock route opens exactly when its section's first screen does (and Central kitchen needs a kitchen);
        // Stock and GP opens for a login with Reports and a stock section; Inventory > Reports closes (it forwards)
        const expected = id === 'central-kitchen' ? kitchen && canOpenRoute('recipes', profile)
          : STOCK_GATED.includes(id) ? canOpenRoute('order-pad', profile)
          : id === STOCK_GP_ROUTE ? canOpenRoute('reports', profile) && allowsStock(profile)
          : id === STOCK_REPORTS_ROUTE ? false
          : canOpenRoute(id, profile);
        assert.equal(canOpenRoute(id, withStock), expected, `${who}, ${state}: ${id}`);
      }
      assert.ok(GATED.every((id) => allRoutes.includes(id)));
      assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, withStock), STOCK_GP_ROUTE, `${who}, ${state}: the alias`);
      assert.equal(guardRoute('batches', withStock), guardRoute('batches', profile));
    }
  }
  const owner = (stock) => filterNav(NAV_IA, { ...PEOPLE.owner, stock });
  assert.deepEqual(owner(STOCK.multi).find((r) => r.label === 'Purchasing').children, PURCHASING_MULTI);
  assert.deepEqual(owner(STOCK.multi).find((r) => r.label === 'Produce').children, [['recipes', 'Recipes'], ['batches', 'Batch and prep']]);
  assert.deepEqual(owner(STOCK.kitchenAll).find((r) => r.label === 'Produce').children, [['recipes', 'Recipes'], ['batches', 'Batch and prep'], ['central-kitchen', 'Central kitchen']]);
  // a site level login sees Central kitchen only when one of its own sites is the kitchen
  assert.deepEqual(owner(STOCK.kitchenSiteHere).find((r) => r.label === 'Produce').children.map((c) => c[0]), ['recipes', 'batches', 'central-kitchen']);
  assert.deepEqual(owner(STOCK.kitchenSiteAway).find((r) => r.label === 'Produce').children.map((c) => c[0]), ['recipes', 'batches']);
  assert.equal(canOpenRoute('central-kitchen', { ...PEOPLE.owner, stock: STOCK.kitchenSiteAway }), false);
  // NAV_IA itself is never changed
  assert.deepEqual(NAV_IA.find((r) => r.label === 'Produce').children, [['recipes', 'Recipes'], ['batches', 'Batches'], ['central-kitchen', 'Central kitchen']]);
  assert.deepEqual(NAV_IA.find((r) => r.label === 'Reports').children[1], [STOCK_GP_ROUTE, 'Stock and GP'], 'second under Reports, after All reports');
  assert.deepEqual(NAV_IA.find((r) => r.label === 'Inventory').children.at(-1), [STOCK_REPORTS_ROUTE, 'Reports'], 'Inventory > Reports is still a sidebar route');
});

test('routeLabel: the multi site name only for a multi site company, else the caller\'s own title', () => {
  assert.equal(routeLabel('batches', 'Batches', { role: 'owner', stock: STOCK.multi }), 'Batch and prep');
  for (const stock of [STOCK.loading, STOCK.failed, STOCK.oneSite, undefined]) assert.equal(routeLabel('batches', 'Batches', { role: 'owner', stock }), 'Batches');
  assert.equal(routeLabel('batches', 'Batches', null), 'Batches');
  assert.equal(routeLabel('recipes', 'Recipes', { stock: STOCK.multi }), 'Recipes');
  assert.equal(routeLabel('wf-rota', 'Workforce', { stock: STOCK.multi }), 'Workforce');
  assert.equal(routeLabel(STOCK_GP_ROUTE, 'Stock and GP', { stock: STOCK.multi }), 'Stock and GP', 'the new route keeps its own title');
  assert.equal(routeLabel(null, '', { stock: STOCK.multi }), '');
});

test('the alias opens Stock and GP only when the company is multi site AND the scope is ready', () => {
  const owner = PEOPLE.owner;
  for (const stock of [STOCK.loading, STOCK.failed, STOCK.oneSite, undefined, null]) {
    assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, { ...owner, stock }), STOCK_REPORTS_ROUTE, JSON.stringify(stock));
    assert.equal(routeGateOk(STOCK_GP_ROUTE, { ...owner, stock }), false, JSON.stringify(stock));
    assert.equal(routeGateOk(STOCK_REPORTS_ROUTE, { ...owner, stock }), true, JSON.stringify(stock));
  }
  assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, { ...owner, stock: STOCK.multi }), STOCK_GP_ROUTE);
  assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, { ...owner, stock: { ...STOCK.multi, ready: false } }), STOCK_REPORTS_ROUTE, 'multi but not ready: as asked');
  assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, null), STOCK_REPORTS_ROUTE);
  assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, undefined), STOCK_REPORTS_ROUTE);
  for (const other of ['reports', 'stock-gp', 'menu', 'stock-items', '', null, undefined]) {
    assert.equal(STOCK_REPORTS_ALIAS(other, { ...owner, stock: STOCK.multi }), other, String(other));
  }
  // the alias names a route; canOpenRoute still decides (a login without Reports is refused there)
  const noReports = { role: 'manager', sections: ['inventory'], stock: STOCK.multi };
  assert.equal(STOCK_REPORTS_ALIAS(STOCK_REPORTS_ROUTE, noReports), STOCK_GP_ROUTE);
  assert.equal(canOpenRoute(STOCK_GP_ROUTE, noReports), false);
  assert.equal(canOpenRoute(STOCK_REPORTS_ROUTE, noReports), false, 'and the old route is closed too: the screen says so');
});

test('Drop 3 adds exactly six routes and Drop 4a exactly stock-gp: no multi-site-stock, the BETA list is exactly the Multi site menu', () => {
  assert.ok(!allRoutes.includes('multi-site-stock'), 'Menu > Multi site stock never comes back');
  assert.ok(allRoutes.includes(STOCK_GP_ROUTE));
  assert.deepEqual([...BETA_ROUTES], [MSM_ROUTE]);
  assert.equal(allRoutes.length, 100, 'the 93 routes of v5.11.84 plus the 6 of Drop 3 plus stock-gp');
  for (const id of STOCK_GATED) assert.ok(allRoutes.includes(id), id);
  assert.doesNotMatch(read('./boSections.js'), /multi-site-stock/);
  assert.equal(STOCK_GP_ROUTE, 'stock-gp');
  assert.equal(STOCK_REPORTS_ROUTE, 'stock-reports');
});

test('every stock route has a title row in BackOfficeApp NAV; the routes with none are exactly today\'s', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  const nav = bo.slice(bo.indexOf('const NAV = ['), bo.indexOf('];', bo.indexOf('const NAV = [')));
  const titled = new Set([...nav.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'\s*,\s*label:\s*'[^']+'/g)].map((m) => m[1]));
  const stockRows = NAV_IA.filter((r) => ['Inventory', 'Produce', 'Purchasing'].includes(r.label));
  for (const id of stockRows.flatMap(routesOfRow)) assert.ok(titled.has(id), `no top bar title for ${id}`);
  assert.ok(titled.has(STOCK_GP_ROUTE), 'Stock and GP has a top bar title');
  assert.match(nav, /\{ id:'stock-gp', label:'Stock and GP', icon:'📊', group:'Analytics' \}/);
  // Not every sidebar route had a top bar title on v5.11.84 (main, 20 Oct): these 15 show a blank
  // title today. Drop 1 and Drop 4a add no title to them and change none of them (Rule 2: today's screens).
  const untitled = allRoutes.filter((id) => !id.startsWith('wf-') && !titled.has(id));
  assert.deepEqual(untitled, ['catering', 'catering-orders', 'hubrise', 'uber-direct', 'deliveries-live', 'waitlist', 'table-bookings',
    'packages', 'menu-appearance', 'menuboards', 'order-screens', 'print-menu', 'waitlist-insights', 'sending-domain', 'xero']);
  // the top bar reads the multi site label through routeLabel, after today's NAV title
  assert.match(bo, /\{routeLabel\(section, NAV\.find\(n => n\.id === section\)\?\.label \|\| \(section\?\.startsWith\('wf-'\) \? 'Workforce' : ''\), access\)\}/);
});
