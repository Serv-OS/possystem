/**
 * reportLink.test.js: the head office report ids and the share link (v5.11.92, multi site stock
 * Drop 4a, contract 2.1 and 4). Run: npm test.
 *
 * Pinned: the 21 ids and which wait for a later Drop; the function name behind each id; the link
 * keeps the filters and never a site name or a figure; a link that is not Stock and GP is null; a
 * part that cannot be read falls back to its default; sites outside this login's scope fall back
 * to the picker's default choice; Catalog.jsx names every id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STOCK_GP_ROUTE, STOCK_REPORT_IDS, STOCK_LATER, LATER_WORDS, EXPORTABLE_REPORTS,
  isStockReportId, isLiveStockReport, reportFnOf, canExportReport,
  encodeOpts, decodeOpts, writeSitesPart, readSitesPart, writePeriodPart, readPeriodPart,
  writeShareLink, readShareLink, applyShareLink,
} from './reportLink.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const A = 'a1000000-0000-4000-8000-000000000001';
const B = 'a1000000-0000-4000-8000-000000000002';
const C = 'a1000000-0000-4000-8000-000000000003';
const G = 'c1000000-0000-4000-8000-000000000001';

test('21 ids in the mockup order; 7 wait for a later Drop; the function names', () => {
  assert.equal(STOCK_REPORT_IDS.length, 21);
  assert.equal(new Set(STOCK_REPORT_IDS).size, 21);
  assert.equal(STOCK_REPORT_IDS[0], 'stock_home');
  assert.ok(Object.isFrozen(STOCK_REPORT_IDS) && Object.isFrozen(STOCK_LATER) && Object.isFrozen(LATER_WORDS));
  assert.deepEqual(Object.keys(STOCK_LATER).sort(), ['stock_allergens', 'stock_budget', 'stock_count_compliance', 'stock_month_end', 'stock_off_contract', 'stock_recipe_cost', 'stock_transfers']);
  assert.deepEqual(LATER_WORDS, { recipes: 'Comes with the recipes update', purchasing: 'Comes with the purchasing update' });
  assert.equal(STOCK_LATER.stock_recipe_cost, 'recipes');
  assert.equal(STOCK_LATER.stock_allergens, 'recipes');
  for (const id of STOCK_REPORT_IDS) {
    assert.ok(isStockReportId(id), id);
    assert.equal(isLiveStockReport(id), !STOCK_LATER[id], id);
  }
  assert.equal(isStockReportId('summary'), false);
  assert.equal(isStockReportId('stock_'), false);
  assert.equal(isStockReportId(null), false);
  assert.equal(reportFnOf('stock_home'), 'dashboard');
  assert.equal(reportFnOf('stock_gap'), 'gap');
  assert.equal(reportFnOf('stock_product_gp'), 'product_gp');
  assert.equal(reportFnOf('stock_days_on_hand'), 'days_on_hand');
  assert.equal(reportFnOf('stock_recipe_cost'), null, 'a waiting tile makes no call');
  assert.equal(reportFnOf('stock_month_end'), null);
  assert.equal(reportFnOf('nope'), null);
  // every live id but the dashboard is exportable, by the function name the database accepts
  assert.deepEqual([...EXPORTABLE_REPORTS], ['value', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'purchases', 'prices', 'days_on_hand', 'par', 'key_ratios', 'setup_health', 'batches', 'league']);
  for (const id of STOCK_REPORT_IDS) assert.equal(canExportReport(id), isLiveStockReport(id) && id !== 'stock_home', id);
  assert.equal(STOCK_GP_ROUTE, 'stock-gp');
});

test('opts travel as base64url JSON, UTF-8 safe, and anything else reads as null', () => {
  const opts = { level: 'item', category_id: A, sort: 'gap_value', dir: 'asc', words: 'café £' };
  const o = encodeOpts(opts);
  assert.match(o, /^[A-Za-z0-9_-]+$/, 'url safe, no padding');
  assert.deepEqual(decodeOpts(o), opts);
  assert.equal(encodeOpts(null), '');
  assert.equal(encodeOpts({}), '');
  assert.equal(encodeOpts([1]), '');
  assert.equal(decodeOpts(''), null);
  assert.equal(decodeOpts('not base64!'), null);
  assert.equal(decodeOpts(encodeOpts({ a: 1 }).slice(0, 3)), null, 'a cut string is not a link');
  assert.equal(decodeOpts(btoa('[1,2]')), null, 'an array is not opts');
});

test('the sites and period parts, both ways', () => {
  assert.equal(writeSitesPart({ kind: 'all' }), 'all');
  assert.equal(writeSitesPart(null), 'all');
  assert.equal(writeSitesPart({ kind: 'group', id: G }), `g:${G}`);
  assert.equal(writeSitesPart({ kind: 'sites', ids: [A, B] }), `s:${A},${B}`);
  assert.equal(writeSitesPart({ kind: 'sites', ids: ['North Street'] }), 'all', 'never a name: an id that is not one falls to all');
  assert.equal(writeSitesPart({ kind: 'site', id: A }), `s:${A}`);
  assert.deepEqual(readSitesPart('all'), { kind: 'all', ids: [] });
  assert.deepEqual(readSitesPart(null), { kind: 'all', ids: [] });
  assert.deepEqual(readSitesPart(`g:${G}`), { kind: 'group', id: G, ids: [] });
  assert.deepEqual(readSitesPart(`s:${A},${B},${A}`), { kind: 'sites', ids: [A, B] });
  assert.equal(readSitesPart('s:North Street'), null);
  assert.equal(readSitesPart('g:1'), null);
  assert.equal(readSitesPart('x'), null);
  assert.equal(writePeriodPart('last-week'), 'last-week');
  assert.equal(writePeriodPart('between-counts'), 'counts');
  assert.equal(writePeriodPart('custom', { from: '2026-10-01', to: '2026-10-15' }), 'custom:2026-10-01:2026-10-15');
  assert.equal(writePeriodPart('custom', { from: '2026-10-01', to: null }), 'custom');
  assert.equal(writePeriodPart('last-7'), 'this-week', 'not a stock period: the default');
  assert.equal(writePeriodPart('service:today:lunch'), 'this-week');
  assert.deepEqual(readPeriodPart('last-week'), { period: 'last-week', custom: { from: null, to: null } });
  assert.deepEqual(readPeriodPart('counts'), { period: 'between-counts', custom: { from: null, to: null } });
  assert.deepEqual(readPeriodPart('custom:2026-10-01:2026-10-15'), { period: 'custom', custom: { from: '2026-10-01', to: '2026-10-15' } });
  assert.deepEqual(readPeriodPart('custom'), { period: 'custom', custom: { from: null, to: null } });
  assert.equal(readPeriodPart('custom:2026-10-15:2026-10-01'), null, 'start after end');
  assert.equal(readPeriodPart('custom:yesterday:today'), null);
  assert.equal(readPeriodPart('last-30'), null);
  assert.deepEqual(readPeriodPart(null), { period: 'this-week', custom: { from: null, to: null } });
});

test('writeShareLink keeps the filters and nothing else; readShareLink gives them back', () => {
  const state = {
    report: 'stock_gap', sites: { kind: 'sites', ids: [A, B] }, period: 'custom', custom: { from: '2026-10-01', to: '2026-10-15' },
    compare: 'last_year', layout: 'total', at: '2026-10-20', opts: { level: 'item', key_items_only: true },
  };
  const link = writeShareLink(state);
  assert.ok(link.startsWith('?bo=stock-gp&r=stock_gap&sites='), link);
  assert.match(link, /&p=custom%3A2026-10-01%3A2026-10-15&cmp=last_year&layout=total&at=2026-10-20&o=[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(link, /North|£|\$|\d+\.\d\d/, 'never a site name or a figure');
  assert.deepEqual(readShareLink(link), {
    route: 'stock-gp', report: 'stock_gap', sites: { kind: 'sites', ids: [A, B] }, period: 'custom', custom: { from: '2026-10-01', to: '2026-10-15' },
    compare: 'last_year', layout: 'total', at: '2026-10-20', opts: { level: 'item', key_items_only: true },
  });
  // the plain case: all sites, last week, previous period, side by side, nothing else
  const plain = writeShareLink({ report: 'stock_home', sites: { kind: 'all' }, period: 'last-week' });
  assert.equal(plain, '?bo=stock-gp&r=stock_home&sites=all&p=last-week&cmp=prev&layout=side');
  assert.deepEqual(readShareLink(plain), { route: 'stock-gp', report: 'stock_home', sites: { kind: 'all', ids: [] }, period: 'last-week', custom: { from: null, to: null }, compare: 'prev', layout: 'side', at: null, opts: null });
  // a group
  const grp = writeShareLink({ report: 'stock_waste', sites: { kind: 'group', id: G }, period: 'between-counts', compare: 'prev', layout: 'side' });
  assert.equal(readShareLink(grp).sites.kind, 'group');
  assert.equal(readShareLink(grp).sites.id, G);
  assert.equal(readShareLink(grp).period, 'between-counts');
  // not one of the 21: nothing to write
  assert.equal(writeShareLink({ report: 'summary', sites: { kind: 'all' }, period: 'today' }), '');
  assert.equal(writeShareLink(null), '');
});

test('readShareLink: only a Stock and GP link; bad parts fall back to their defaults', () => {
  for (const s of ['', null, undefined, '?section=menu', '?bo=reports&r=stock_gap', '?bo=stock-gp', '?bo=stock-gp&r=summary', '?bo=stock-gp&r=stock_made_up', '?bo=stock-gp&r=gap', 42]) {
    assert.equal(readShareLink(s), null, String(s));
  }
  const loose = readShareLink('bo=stock-gp&r=stock_cogs&sites=s:North&p=last-30&cmp=sideways&layout=up&at=tomorrow&o=!!');
  assert.deepEqual(loose, { route: 'stock-gp', report: 'stock_cogs', sites: { kind: 'all', ids: [] }, period: 'this-week', custom: { from: null, to: null }, compare: null, layout: 'side', at: null, opts: null });
  // works with or without the leading question mark, and ignores extra keys
  assert.equal(readShareLink('?bo=stock-gp&r=stock_par&foo=bar').report, 'stock_par');
  assert.equal(readShareLink('?bo=stock-gp&r=stock_par&foo=bar').compare, 'prev');
});

const SCOPE = {
  ready: true, multi: true, level: 'sites', homeSite: A,
  sites: [{ id: A, name: 'North Street', status: 'active' }, { id: B, name: 'River Side', status: 'active' }],
  closedSites: [{ id: C, name: 'Old Town', status: 'closed' }],
  groups: [{ id: G, name: 'North', locationIds: [A, B], sortOrder: 0 }],
};

test('applyShareLink: sites inside the scope only; anything else is the picker\'s default choice', () => {
  assert.deepEqual(applyShareLink({ sites: { kind: 'all', ids: [] } }, SCOPE), [A, B]);
  assert.deepEqual(applyShareLink({ sites: { kind: 'sites', ids: [B] } }, SCOPE), [B]);
  assert.deepEqual(applyShareLink({ sites: { kind: 'sites', ids: [B, C] } }, SCOPE), [B], 'a closed site is not opened by a link');
  assert.deepEqual(applyShareLink({ sites: { kind: 'group', id: G } }, SCOPE), [A, B]);
  // a site this login does not reach: the default (level sites = the signed in venue)
  assert.deepEqual(applyShareLink({ sites: { kind: 'sites', ids: ['b1000000-0000-4000-8000-000000000009'] } }, SCOPE), [A]);
  assert.deepEqual(applyShareLink({ sites: { kind: 'group', id: 'c1000000-0000-4000-8000-000000000099' } }, SCOPE), [A]);
  // level all: the default is every site
  const all = { ...SCOPE, level: 'all' };
  assert.deepEqual(applyShareLink({ sites: { kind: 'sites', ids: ['b1000000-0000-4000-8000-000000000009'] } }, all), [A, B]);
  assert.deepEqual(applyShareLink(null, all), [A, B]);
  // a one site scope: that site
  const one = { ready: true, multi: false, homeSite: A, sites: [{ id: A, name: 'North Street' }], closedSites: [], groups: [] };
  assert.deepEqual(applyShareLink({ sites: { kind: 'sites', ids: [B] } }, one), [A]);
  assert.deepEqual(applyShareLink({ sites: { kind: 'all' } }, one), [A]);
});

test('Catalog.jsx names every one of the 21 ids, and the later tiles carry their update', () => {
  const cat = read('../../backoffice/sections/reports/Catalog.jsx');
  for (const id of STOCK_REPORT_IDS) assert.ok(cat.includes(`id:'${id}'`) || cat.includes(`id: '${id}'`), `Catalog has ${id}`);
  for (const [id, later] of Object.entries(STOCK_LATER)) {
    const row = cat.slice(cat.indexOf(`id:'${id}'`), cat.indexOf('}', cat.indexOf(`id:'${id}'`)));
    assert.match(row, new RegExp(`later:\\s*'${later}'`), `${id} says ${later}`);
  }
  assert.match(cat, /gate:\s*'stock-gp'/, 'the category is gated on stock-gp');
  assert.match(cat, /import \{ LATER_WORDS \} from '\.\.\/\.\.\/\.\.\/lib\/stock\/reportLink'/, 'the words come from one place');
  assert.match(cat, /const later = r\.later \? LATER_WORDS\[r\.later\] : null;/, 'a later tile shows its line');
  assert.match(cat, /if \(r\?\.later\) return;/, 'and never opens');
});
