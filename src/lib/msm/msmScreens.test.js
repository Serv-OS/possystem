// Multi site menu: the screens' wiring (src/backoffice/sections/msm). Pins what a review should
// never have to find again: the screens write only through the data layer (saveHealth, compare and
// set), read back what the database holds after every write, never cap a read at a number, load
// as their own chunk, and keep the made up demo data behind demo mode. Plus a round trip of a new
// product through the data layer to what the grid shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMsmData } from './msmData.js';
import { fakeClient } from './fakeClient.js';
import { newProductChanges, newCategoryChange, sitePriceChange, defaultPriceChange } from './msmEdit.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { buildGridRows, indexCentral, cellFor, priceEditable } from './msmGrid.js';
import { demoMsm } from './msmDemo.js';

const dir = new URL('../../backoffice/sections/msm/', import.meta.url);
const screens = fs.readdirSync(dir).filter((f) => /\.(jsx?|js)$/.test(f));
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the screens exist and say what they are', () => {
  for (const f of ['MultiSiteMenu.jsx', 'MsmGrid.jsx', 'MsmProductSheet.jsx', 'MsmChangePrices.jsx', 'MsmImport.jsx', 'MsmDetails.jsx', 'MsmChangesPanel.jsx', 'msmTabs.js']) {
    assert.ok(screens.includes(f), f);
    assert.match(read(f), /MULTI SITE MENU/, `${f} has its header`);
  }
});

test('no long dashes anywhere in the screens (house rule)', () => {
  for (const f of screens) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f);
  for (const f of ['msmGrid.js', 'msmEdit.js', 'msmImportReview.js', 'msmWords.js', 'msmDemo.js']) assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /[\u2013\u2014]/, f);
});

test('the screens never write the database themselves: every write goes through the data layer', () => {
  for (const f of screens) {
    const c = code(read(f));
    // Every table the screen touches is read: .from('x') is always followed by .select(.
    for (const m of c.matchAll(/\.from\(([^)]*)\)\s*\.(\w+)\(/g)) assert.equal(m[2], 'select', `${f} does ${m[2]} on ${m[1]}`);
    assert.doesNotMatch(c, /\.(insert|upsert)\(/, `${f} writes directly`);
    assert.doesNotMatch(c, /\.rpc\(/, `${f} calls a database function directly`);
    assert.doesNotMatch(c, /\.limit\(/, `${f} caps a read (1,000 rows is the most the API sends)`);
  }
});

test('every edit is read back from the database before it shows as staged', () => {
  const src = code(read('MultiSiteMenu.jsx'));
  const stage = src.slice(src.indexOf('const stage = useCallback'), src.indexOf('const unstage = useCallback'));
  assert.match(stage, /api\.stageMany\(/);
  assert.match(stage, /await readRows\(setId\)/, 'the draft is read back after the write');
  assert.ok(stage.indexOf('api.stageMany(') < stage.indexOf('await readRows(setId)'));
  assert.doesNotMatch(src, /showToast/, 'no toast before the write lands');
});

test('demo data only in demo mode; the Back Office loads the access check and the screen lazily', () => {
  const src = read('MultiSiteMenu.jsx');
  assert.match(src, /const demo = isMock \? demoMsm\(\) : null;/);
  const bo = fs.readFileSync(new URL('../../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(bo, /^import .*msm/m, 'no Multi site menu code in the Back Office chunk itself');
  assert.match(bo, /import\('\.\.\/lib\/msm\/msmApi'\)/);
  assert.match(bo, /readAccess\(msmOrgId\)/);
  assert.match(bo, /if \(live && a && !a\.stale\) setMsmAccess\(a\)/, 'a late or stale answer never opens it');
});

test('never window.confirm: it shows nothing in the iPad apps, so the button would silently do nothing', () => {
  for (const f of screens) assert.doesNotMatch(code(read(f)), /window\.confirm\(|\bconfirm\(`/, f);
  // The four places that ask first use the in app dialog.
  for (const f of ['MsmPublish.jsx', 'MsmTimeline.jsx', 'MsmChangesPanel.jsx']) assert.match(read(f), /useConfirm\(\)/, f);
});

test('a variants parent is priced by its sizes: no price change is staged on it from the grid or a paste', () => {
  const live = {
    menu: { id: 'm' }, sites: [{ location_id: 's1' }], categories: [],
    products: [{ id: 'meal', name: 'Meal deal', type: 'variants', default_price: 0 }],
    productSites: [{ product_id: 'meal', location_id: 's1', venue_item_id: 'v', price: null, active: true }],
  };
  const ctx = { live, eff: live };
  assert.match(sitePriceChange(ctx, 'meal', 's1', 3).words, /priced by its sizes/);
  assert.match(defaultPriceChange(ctx, 'meal', 3).words, /priced by its sizes/);
  assert.equal(priceEditable(live.products[0]), false);
  assert.equal(priceEditable({ id: 'x', type: 'simple' }), true);
  // 17 Oct verification: on a variants row the keys stop before any price edit, and say why (Space
  // still turns it on or off with its sizes, above this line).
  assert.match(code(read('MsmGrid.jsx')), /if \(!priceEditable\(p\)\) \{\n\s*if \(e\.key === 'Enter' \|\| e\.key === 'F2' \|\| \/\^\[0-9\.\]\$\/\.test\(e\.key\) \|\| e\.key === 'Delete' \|\| e\.key === 'Backspace'\) \{ e\.preventDefault\(\); setNote\?\.\(\{ tone: 'warn', text: 'This product is priced by its sizes\. Change the price on each size\.' \}\); \}\n\s*return;\n\s*\}/, 'the grid keys stop on a variants row');
});

test('round trip: a new category and product staged through the data layer show in the grid as the draft', async () => {
  const live = {
    menu: { id: 'menu-1', name: 'Menu' },
    sites: [{ location_id: 'site-1' }, { location_id: 'site-2' }],
    categories: [{ id: 'hot', label: 'Hot', sort_order: 1 }],
    products: [{ id: 'latte', name: 'Latte', category_id: 'hot', default_price: 3, tax_rate_percent: 20 }],
    productSites: [{ product_id: 'latte', location_id: 'site-1', venue_item_id: 'v1', price: null, active: true }],
  };
  const client = fakeClient({ msm_changes: [] }, { stamp: true });
  const reports = [];
  const api = createMsmData({ client, report: (e, err) => reports.push([e, err]) });
  const ctx = { live, eff: live };
  const catId = 'cccccccc-0000-4000-8000-000000000001';
  const pid = 'pppppppp-0000-4000-8000-000000000001';
  const cat = newCategoryChange(ctx, { id: catId, label: 'Christmas', route_like_id: 'hot' }).change;
  const prod = newProductChanges({ live, eff: { ...live, categories: [...live.categories, { id: catId }] } }, { id: pid, fields: { name: 'Gingerbread latte', category_id: catId, default_price: 4.2, tax_rate_percent: 20 }, sites: [{ location_id: 'site-1' }, { location_id: 'site-2', price: 4.5 }] }).changes;
  const r = await api.stageMany('set-1', [cat, ...prod], []);
  assert.deepEqual([r.ok, r.done], [true, 4]);
  assert.deepEqual(client.db.msm_changes.map((c) => c.target), ['category', 'product', 'product_site', 'product_site'], 'parents before the rows that point at them');
  assert.ok(reports.length >= 4 && reports.every(([, e]) => e === null), 'every write reported to saveHealth');
  const back = await api.changes('set-1');
  const eff = applyChanges(live, back.rows).central;
  const { rows } = buildGridRows(eff, { siteIds: ['site-1', 'site-2'] });
  assert.deepEqual(rows.map((x) => (x.kind === 'cat' ? `#${x.label}` : x.product.name)), ['#Hot', 'Latte', '#Christmas', 'Gingerbread latte']);
  const ix = indexCentral(eff);
  assert.equal(cellFor(ix, ix.products.get(pid), 'site-2').price, 4.5);
  assert.equal(cellFor(ix, ix.products.get(pid), 'site-1').follows, true);
});

test('demo mode: the made up company imports and opens with no database', async () => {
  const demo = demoMsm();
  const sites = demo.sites();
  assert.equal(sites.length, 5, 'four trading sites and one opening soon (for Add a site)');
  const v = await demo.api.venues(sites.map((s) => s.id));
  assert.equal(v.failed.length, 0);
  const lm = await demo.api.liveMenu(demo.orgId);
  assert.equal(lm.menu, null, 'starts with nothing set up');
  const access = await demo.api.readAccess(demo.orgId);
  assert.equal(access.canEdit, true);
});
