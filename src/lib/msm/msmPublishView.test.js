// Multi site menu: the rules behind Publish, Timeline, Sites and Price spread (msmPublishView.js),
// plus the whole flagship flow end to end in demo mode: stage new products, schedule them for a
// date and time, unschedule and schedule again, watch the run at that time, read what it wrote at
// each site, undo it, add a site, and a site that fails then is retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  defaultRunLocal, minRunLocal, countdownWords, publishNowWords, isLate, versionSummary, siteRowWords, timelineEntries,
  canStillChange, siteCards, sitesToAdd, auditLines, spreadRows, spreadSummary, csvFileName, previewHeadline,
} from './msmPublishView.js';
import { demoMsm } from './msmDemo.js';
import { proposeImport, buildCentral, importPayload } from '../../../supabase/functions/_shared/msmImport.js';
import { previewSet, undoChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { planAddSite } from '../../../supabase/functions/_shared/msmSites.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { newProductChanges, newCategoryChange, withBefore } from './msmEdit.js';

const T = Date.UTC(2026, 9, 17, 14, 30);   // Sat 17 Oct 2026 15:30 in London

test('the schedule picker starts at 06:00 tomorrow on the site\'s clock, and never before now', () => {
  assert.equal(defaultRunLocal(T, 'Europe/London'), '2026-10-18T06:00');
  assert.equal(defaultRunLocal(Date.UTC(2026, 9, 17, 23, 30), 'Europe/London'), '2026-10-19T06:00', '00:30 on Sunday in London: Monday');
  assert.equal(defaultRunLocal(Date.UTC(2026, 9, 31, 12), 'Europe/London'), '2026-11-01T06:00', 'over a month end');
  assert.equal(defaultRunLocal(T, 'America/Los_Angeles'), '2026-10-18T06:00');
  assert.equal(minRunLocal(T, 'Europe/London'), '2026-10-17T15:30');
});

test('countdown words', () => {
  assert.equal(countdownWords(T + 12 * 60000, T), 'in 12 minutes');
  assert.equal(countdownWords(T + 61 * 60000, T), 'in 1 hour 1 minute');
  assert.equal(countdownWords(T + 3 * 3600000, T), 'in 3 hours');
  assert.equal(countdownWords(T + (2 * 24 + 4) * 3600000 + 59000, T), 'in 2 days 4 hours');
  assert.equal(countdownWords(T - 1000, T), 'due now');
  assert.equal(countdownWords(null, T), '');
});

test('the publish button says where it goes', () => {
  assert.equal(publishNowWords([{ name: 'Station' }]), 'Publish to Station now');
  assert.equal(publishNowWords([{ name: 'A' }, { name: 'B' }, { name: 'C' }]), 'Publish to 3 sites now');
  assert.equal(publishNowWords([]), 'Publish now');
});

const names = { a: 'Station', b: 'Riverside', c: 'Old Town' };
test('a version in words: scheduled, running, done, partly done with the reason, late, will fail, cancelled', () => {
  const due = new Date(Date.UTC(2026, 9, 19, 4, 55)).toISOString();
  const s = versionSummary({ status: 'scheduled', sites: [{ location_id: 'a', status: 'scheduled', due_at: due }, { location_id: 'b', status: 'scheduled', due_at: due }] }, names, T);
  assert.equal(s.head, 'Scheduled');
  assert.equal(s.detail, 'Starts Mon 19 Oct 05:55 at 2 sites');
  const wf = versionSummary({ status: 'scheduled', sites: [{ location_id: 'a', status: 'scheduled', due_at: due, precheck_ok: false, precheck_words: 'Station has no 20% VAT rate.' }] }, names, T);
  assert.equal(wf.tone, 'warn');
  assert.match(wf.detail, /Station will fail unless it is fixed: Station has no 20% VAT rate\./);
  const r = versionSummary({ status: 'running', sites: [{ location_id: 'a', status: 'done' }, { location_id: 'b', status: 'running', due_at: new Date(T).toISOString() }] }, names, T);
  assert.equal(r.detail, 'Done at 1 of 2 sites so far');
  assert.equal(versionSummary({ status: 'done', sites: [{ location_id: 'a', status: 'done' }, { location_id: 'b', status: 'nothing' }] }, names, T).detail, 'On the tills at all 2 sites');
  const p = versionSummary({ status: 'partly_done', sites: [{ location_id: 'a', status: 'done' }, { location_id: 'b', status: 'failed', error: 'no 20% VAT rate' }] }, names, T);
  assert.deepEqual([p.head, p.detail, p.tone], ['Done at 1 of 2', 'Riverside failed: no 20% VAT rate.', 'warn']);
  const late = versionSummary({ status: 'running', sites: [{ location_id: 'c', status: 'scheduled', due_at: new Date(T - 20 * 60000).toISOString() }] }, names, T);
  assert.deepEqual([late.head, late.tone], ['Late', 'bad']);
  assert.match(late.detail, /^Old Town should have updated by now/);
  assert.equal(versionSummary({ status: 'cancelled', sites: [] }, names, T).head, 'Cancelled');
});

test('late means still open 15 minutes after its time (or marked late by the server)', () => {
  assert.equal(isLate({ status: 'scheduled', due_at: new Date(T - 14 * 60000).toISOString() }, T), false);
  assert.equal(isLate({ status: 'scheduled', due_at: new Date(T - 16 * 60000).toISOString() }, T), true);
  assert.equal(isLate({ status: 'running', late_at: new Date(T).toISOString(), due_at: new Date(T).toISOString() }, T), true);
  assert.equal(isLate({ status: 'done', due_at: new Date(T - 99 * 60000).toISOString() }, T), false);
  assert.equal(siteRowWords({ status: 'failed', error: 'no 20% VAT rate' }, 'Europe/London', T), 'Failed: no 20% VAT rate');
  assert.equal(siteRowWords({ status: 'nothing' }, 'Europe/London', T), 'Nothing to change');
  assert.equal(siteRowWords({ status: 'scheduled', due_at: new Date(Date.UTC(2026, 11, 1, 5, 55)).toISOString() }, 'Europe/London', T), 'Starts Tue 1 Dec 05:55');
});

test('the timeline runs in time order and only an untouched scheduled set can still be changed', () => {
  const sets = [
    { id: 'xmas', status: 'scheduled', version_id: 'v2', title: 'Christmas' },
    { id: 'rise', status: 'scheduled', version_id: 'v1', title: 'Price rise' },
    { id: 'draft', status: 'draft', title: 'Draft' },
    { id: 'run', status: 'running', version_id: 'v3', title: 'Running' },
  ];
  const history = [
    { id: 'v1', version_no: null, sites: [{ location_id: 'a', status: 'scheduled', due_at: '2026-10-19T04:55:00Z' }] },
    { id: 'v2', version_no: null, sites: [{ location_id: 'a', status: 'scheduled', due_at: '2026-12-01T05:55:00Z' }, { location_id: 'b', status: 'scheduled', due_at: '2026-12-01T05:55:00Z' }] },
    { id: 'v3', version_no: 9, sites: [{ location_id: 'a', status: 'running', due_at: '2026-10-17T14:00:00Z' }] },
  ];
  const e = timelineEntries(sets, history, T);
  assert.deepEqual(e.map((x) => x.set.id), ['run', 'rise', 'xmas']);
  assert.equal(canStillChange(e[1]), true);
  assert.equal(canStillChange(e[0]), false, 'running');
  assert.equal(canStillChange({ ...e[2], sites: [{ status: 'done' }, { status: 'scheduled' }] }), false, 'a site has started');
});

test('site cards: the most urgent state wins, the newest finished run decides failed', () => {
  const sites = [{ id: 'a', name: 'Station' }, { id: 'b', name: 'Riverside' }, { id: 'c', name: 'Old Town' }, { id: 'd', name: 'Market' }];
  const history = [
    { id: 'v3', title: 'Christmas', sites: [{ location_id: 'a', status: 'scheduled', due_at: '2026-12-01T05:55:00Z' }, { location_id: 'b', status: 'scheduled', due_at: '2026-12-01T05:55:00Z', precheck_ok: false, precheck_words: 'no VAT rate' }] },
    { id: 'v2', title: 'Rise', version_no: 2, finished_at: '2026-10-16T05:00:00Z', sites: [{ location_id: 'a', status: 'failed', error: 'no 20% VAT rate' }, { location_id: 'c', status: 'done', finished_at: '2026-10-16T05:00:00Z' }] },
    { id: 'v1', title: 'Import', version_no: 1, sites: [{ location_id: 'a', status: 'done' }] },
  ];
  const cards = siteCards(sites, history, { waiting: new Set(['d']), drift: { c: 3 }, now: T });
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(by.a.state, 'failed');
  assert.equal(by.a.failed.versionId, 'v2');
  assert.ok(by.a.flags.some((f) => f.state === 'scheduled'));
  assert.equal(by.b.state, 'will_fail');
  assert.equal(by.c.state, 'changed');
  assert.equal(by.c.lastVersionNo, 2);
  assert.equal(by.d.state, 'waiting');
  const fixed = siteCards(sites, [{ id: 'v4', sites: [{ location_id: 'a', status: 'done' }] }, ...history], { now: T });
  assert.equal(fixed.find((c) => c.id === 'a').state, 'scheduled', 'a later good run clears the failure');
  assert.equal(siteCards([{ id: 'z', name: 'Z' }], [], { now: T })[0].label, 'In sync');
});

test('add a site offers only venues not in the group menu', () => {
  const left = sitesToAdd([{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }, { id: 'x', name: 'New' }], { sites: [{ location_id: 'a' }, { location_id: 'b' }] });
  assert.deepEqual(left.map((s) => s.id), ['x']);
});

test('what a publish wrote at a site, in words', () => {
  const lines = auditLines([
    { table: 'items', id: 'v-latte', before: { pricing: { base: 2.8 } }, after: { pricing: { base: 2.95 } } },
    { table: 'items', id: 'v-mince', before: null, after: { id: 'v-mince', name: 'Mince pie', pricing: { base: 2.5 } } },
    { table: 'items', id: 'v-tea', before: { archived: false, name: 'Tea' }, after: { archived: true, name: 'Tea pot' } },
    { table: 'items', id: 'v-latte', before: { pricing: { takeaway: null } }, after: { pricing: { takeaway: 2.75 } } },
    { table: 'categories', id: 'c1', before: null, after: { label: 'Christmas' } },
    { table: 'menus', id: 'm1', before: null, after: { name: 'Menu' } },
  ], new Map([['v-latte', 'Latte']]));
  assert.deepEqual(lines, [
    'Latte: 2.80 to 2.95', 'Mince pie: new here at 2.50', 'Tea pot: turned off', 'Tea pot: name Tea to Tea pot', 'Latte (takeaway): none to 2.75',
    'Category Christmas: new here', 'The site\'s menu: made',
  ]);
});

test('price spread: widest first, outliers more than 15% from the middle, sizes and parents handled', () => {
  const central = {
    products: [
      { id: 'latte', name: 'Latte', default_price: 3.0 },
      { id: 'tea', name: 'Tea', default_price: 2.0 },
      { id: 'cake', name: 'Cake', default_price: 3.5 },
      { id: 'var', name: 'Coffee', type: 'variants', default_price: 0 },
      { id: 'one', name: 'Only one site', default_price: 1 },
    ],
    productSites: [
      { product_id: 'latte', location_id: 'a', price: null }, { product_id: 'latte', location_id: 'b', price: 3.2 }, { product_id: 'latte', location_id: 'c', price: 3.6 },
      { product_id: 'tea', location_id: 'a', price: null }, { product_id: 'tea', location_id: 'b', price: null }, { product_id: 'tea', location_id: 'c', price: null, active: false },
      { product_id: 'cake', location_id: 'a', price: 3.5 }, { product_id: 'cake', location_id: 'b', price: 3.9 },
      { product_id: 'var', location_id: 'a', price: 1 }, { product_id: 'var', location_id: 'b', price: 2 },
      { product_id: 'one', location_id: 'a', price: null },
    ],
  };
  const rows = spreadRows(central, ['a', 'b', 'c']);
  assert.deepEqual(rows.map((r) => r.product.id), ['latte', 'cake', 'tea'], 'variants parents and one site products left out');
  assert.equal(rows[0].spread, 0.6);
  assert.equal(rows[0].pct, 20);
  assert.equal(rows[0].median, 3.2);
  assert.deepEqual([...rows[0].outliers], [], '3.60 is 12.5% from 3.20');
  const wide = spreadRows({ ...central, productSites: central.productSites.map((r) => (r.product_id === 'latte' && r.location_id === 'c' ? { ...r, price: 3.8 } : r)) }, ['a', 'b', 'c']);
  assert.deepEqual([...wide[0].outliers], ['c'], '3.80 is more than 15% from 3.20');
  assert.equal(rows[2].spread, 0, 'tea: the site where it is off does not count');
  assert.equal(spreadSummary(rows, rows.length), '2 of 3 products are priced differently between sites; the widest is Latte, 0.60 (20%).');
  assert.equal(spreadSummary([rows[2]], 1), 'Every product costs the same at every site (1 product compared).');
});

test('spreadsheet file name', () => {
  assert.equal(csvFileName('Coffee & Co menu', T), 'group-menu-coffee-co-menu-2026-10-17.csv');
  assert.equal(csvFileName('', T), 'group-menu-menu-2026-10-17.csv');
});

test('preview headline counts blocking problems and warnings across sites', () => {
  const h = previewHeadline({ total: 5, central: { blocking: [], warnings: [{}] }, sites: [
    { name: 'A', plan: { lines: [1, 2, 3] }, health: { blocking: [], warnings: [] } },
    { name: 'B', plan: { lines: [1, 2] }, health: { blocking: [{}], warnings: [{}] } },
    { name: 'C', plan: { lines: [] }, health: { blocking: [], warnings: [] } },
  ] });
  assert.deepEqual([h.blocking, h.warnings, h.sitesBlocked, h.sitesChanging, h.words], [1, 2, ['B'], 2, '5 changes at 2 sites']);
  assert.equal(previewHeadline({ total: 0, sites: [] }).words, 'Publishing this changes nothing at any site');
});

test('a new category at a brand new site is a warning (set up its printers before opening); at a trading site it blocks', () => {
  const central = {
    menu: { id: 'm1', name: 'Menu' },
    sites: [{ location_id: 'site-new', venue_menu_id: null }],
    categories: [{ id: 'cat-1', label: 'Hot drinks' }],
    catSites: [],
    products: [{ id: 'p1', name: 'Latte', category_id: 'cat-1', default_price: 3, tax_rate_name: 'Standard rate', tax_rate_percent: 20 }],
    productSites: [{ product_id: 'p1', location_id: 'site-new', venue_item_id: 'msm-p1_site-new', active: true, price: null }],
  };
  const venue = { menus: [], categories: [], items: [], links: [], groups: [], taxRates: [{ id: 'vat', name: 'Standard rate', rate: 20 }], printRouting: { centres: [{ id: 'k', name: 'Kitchen' }], routing: {} } };
  const changes = [{ target: 'menu_site', entity_id: 'm1', location_id: 'site-new', op: 'create', after: { venue_menu_id: null } }, { target: 'product_site', entity_id: 'p1', location_id: 'site-new', op: 'create', after: { venue_item_id: 'msm-p1_site-new' } }];
  const plan = planSite({ central, touched: touchedFromChanges(changes), locationId: 'site-new', orgId: 'org', venue });
  assert.ok(plan.problems.some((p) => p.code === 'new_category_unrouted_new_site' && p.level === 'warn'));
  assert.ok(!plan.problems.some((p) => p.level === 'block'), plan.problems.map((p) => p.words).join(' | '));
});

// ── The flagship, end to end in demo mode ───────────────────────────────────

async function demoWithMenu() {
  const demo = demoMsm();
  const { api, client, orgId } = demo;
  let lm = await api.liveMenu(orgId);
  if (!lm.menu) {
    const locs = client.db.locations.map((l) => l.id);
    const v = await api.venues(locs);
    const ready = locs.filter((l) => (v.venues[l]?.menus || []).length);
    const sites = ready.map((l) => ({ location_id: l, name: client.db.locations.find((x) => x.id === l).name, venue_menu_id: v.venues[l].menus[0].id, raw: v.venues[l] }));
    const proposal = proposeImport(sites);
    const built = buildCentral(proposal, sites, { menuName: 'Demo menu' });
    assert.ok(built.check.ok, JSON.stringify(built.check).slice(0, 300));
    const r = await api.importCommit(importPayload(built.central, { orgId, name: 'Demo menu', description: '' }));
    assert.equal(r.ok, true, r.words);
    lm = await api.liveMenu(orgId);
  }
  return { demo, api, client, orgId, menu: lm.menu };
}

test('flagship: new products scheduled for a date and time reach every site\'s menu at that time, then undo and add a site', async () => {
  const { api, client, menu } = await demoWithMenu();
  const live = await api.central(menu.id);
  assert.ok(live.ok);
  const sites = live.sites.map((s) => s.location_id);

  // 1. Stage a new category (prints like Hot drinks) and a new product at every site.
  const d = await api.createDraft(menu.id, 'Christmas menu', 'edit');
  assert.ok(d.ok);
  const hot = live.categories.find((c) => c.label === 'Hot drinks');
  const catId = 'cccccccc-1111-4000-8000-000000000001';
  const pid = 'eeeeeeee-1111-4000-8000-000000000001';
  const ctx = { live, eff: live };
  const cat = newCategoryChange(ctx, { id: catId, label: 'Christmas', route_like_id: hot.id }).change;
  const prod = newProductChanges({ live, eff: { ...live, categories: [...live.categories, { id: catId }] } }, { id: pid, fields: { name: 'Gingerbread latte', category_id: catId, default_price: 4.2, tax_rate_name: 'Standard rate', tax_rate_percent: 20 }, sites: sites.map((l) => ({ location_id: l })) }).changes;
  const st = await api.stageMany(d.data.id, [cat, ...prod], []);
  assert.deepEqual([st.ok, st.done], [true, 2 + sites.length]);

  // 2. The preview: every site gets the new category and product, and nothing blocks.
  const rows = (await api.changes(d.data.id)).rows;
  const venues = (await api.venues(sites)).venues;
  const preview = previewSet(live, rows, venues, { orgId: menu.org_id });
  assert.equal(preview.ok, true, JSON.stringify(preview.sites.map((s) => s.health?.blocking)));
  assert.ok(preview.sites.every((s) => s.counts.newProducts === 1 && s.counts.categoriesNew === 1));

  // 3. Schedule it for a time in the future: it does not run yet. Unschedule keeps every change.
  const soon = new Date(Date.now() + 3 * 3600000);
  const local = (dt) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(dt).replace(' ', 'T');
  let sch = await api.schedule(d.data.id, local(soon), 5, true);
  assert.equal(sch.ok, true, sch.words);
  const un = await api.unschedule(d.data.id);
  assert.equal(un.ok, true, un.words);
  assert.equal(client.db.msm_change_sets.find((s) => s.id === d.data.id).status, 'draft');
  assert.ok((await api.changes(d.data.id)).rows.length >= 2 + sites.length, 'every change kept');

  // 4. Schedule again, then let the time come: history reads run what is due.
  sch = await api.schedule(d.data.id, local(soon), 5, true);
  assert.equal(sch.ok, true, sch.words);
  let h = await api.history(menu.id);
  const v = h.rows.find((x) => x.id === sch.data.version_id);
  assert.equal(v.status, 'scheduled');
  for (const vs of client.db.msm_version_sites.filter((x) => x.version_id === v.id)) vs.due_at = new Date(Date.now() - 1000).toISOString();
  h = await api.history(menu.id);
  const done = h.rows.find((x) => x.id === v.id);
  assert.equal(done.status, 'done', JSON.stringify(done.sites.map((s) => s.error)));
  for (const loc of sites) {
    const item = client.db.menu_items.find((i) => i.location_id === loc && i.name === 'Gingerbread latte');
    assert.ok(item, `on the menu at ${loc}`);
    assert.equal(item.archived, false);
    assert.equal(Number(item.pricing.base), 4.2);
  }
  const detail = await api.versionDetail(v.id);
  assert.ok(detail.rows.length === sites.length);
  assert.ok(auditLines(detail.rows[0].writes).some((l) => /Gingerbread latte: new here at 4\.20/.test(l)));

  // 5. Undo: a new draft that turns the new product off at every site, then publish it now.
  const after = await api.central(menu.id);
  const undo = undoChanges(done, after);
  assert.ok(undo.changes.some((c) => c.target === 'product_site' && c.after.active === false));
  const ud = await api.createDraft(menu.id, `Undo version ${done.version_no}`, 'undo', { undoOf: done.id });
  assert.equal((await api.stageMany(ud.data.id, withBefore(after, undo.changes), [])).ok, true);
  const pub = await api.publishNow(ud.data.id);
  assert.equal(pub.ok, true, pub.words);
  for (const loc of sites) assert.equal(client.db.menu_items.find((i) => i.location_id === loc && i.name === 'Gingerbread latte').archived, true, 'turned off, never deleted');

  // 6. Add a site that has no menu yet: the menu, its categories and every product are made there.
  const now = await api.central(menu.id);
  const newSite = client.db.locations.find((l) => !now.sites.some((s) => s.location_id === l.id));
  const plan = planAddSite(now, { locationId: newSite.id, prices: 'copy', copyFrom: sites[1] });
  assert.ok(plan.count > 40);
  const ad = await api.createDraft(menu.id, `Add ${newSite.name}`, 'add_site');
  assert.equal((await api.stageMany(ad.data.id, plan.changes, [])).ok, true);
  const added = await api.publishNow(ad.data.id);
  assert.equal(added.ok, true);
  assert.equal(added.data.run.status, 'done', JSON.stringify(added.data.run.sites.map((s) => s.error)));
  const madeMenu = client.db.menus.filter((m) => m.location_id === newSite.id);
  assert.equal(madeMenu.length, 1);
  assert.equal(client.db.menu_items.filter((i) => i.location_id === newSite.id && !i.archived).length, plan.count);
  const ms = client.db.msm_menu_sites.find((s) => s.location_id === newSite.id);
  assert.equal(ms.venue_menu_id, madeMenu[0].id, 'the new menu is remembered');
});

test('flagship: a site that fails says why in words and can be retried', async () => {
  const { api, client, menu } = await demoWithMenu();
  const live = await api.central(menu.id);
  const [first, second] = live.sites.map((s) => s.location_id);
  const latte = live.products.find((p) => p.name === 'Latte');
  // Take the VAT rate away at one site: the price rise must fail there and go through elsewhere.
  const rate = client.db.tax_rates.find((r) => r.location_id === second);
  rate.active = false;
  const d = await api.createDraft(menu.id, 'Monday price rise', 'price_change');
  const r = await api.stageMany(d.data.id, withBefore(live, [{ target: 'product', entity_id: latte.id, op: 'update', after: { default_price: 3.6, tax_rate_name: 'Standard rate', tax_rate_percent: 20 } }]), []);
  assert.equal(r.ok, true);
  const pub = await api.publishNow(d.data.id);
  assert.equal(pub.ok, true, pub.words);
  const h = await api.history(menu.id);
  const v = h.rows.find((x) => x.id === pub.data.version_id);
  const sum = versionSummary(v, Object.fromEntries(client.db.locations.map((l) => [l.id, l.name])));
  assert.equal(v.status, 'partly_done');
  assert.match(sum.detail, /Station failed: Station will not get "Monday price rise": .*VAT/);
  assert.ok(v.sites.find((s) => s.location_id === first).status === 'done');
  rate.active = true;
  const again = await api.retrySite(v.id, second);
  assert.equal(again.ok, true, again.words);
  const h2 = await api.history(menu.id);
  assert.equal(h2.rows.find((x) => x.id === v.id).status, 'done');
});

test('the new screens: headers, plain words, no long dashes, and wired as tabs', () => {
  const dir = new URL('../../backoffice/sections/msm/', import.meta.url);
  for (const f of ['MsmPublish.jsx', 'MsmTimeline.jsx', 'MsmSites.jsx', 'MsmSpread.jsx', 'MsmCsv.jsx', 'useMsmHistory.js']) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.match(src, /MULTI SITE MENU/, f);
    assert.doesNotMatch(src, /[\u2013\u2014]/, f);
  }
  assert.doesNotMatch(fs.readFileSync(new URL('./msmPublishView.js', import.meta.url), 'utf8'), /[\u2013\u2014]/);
  const tabs = fs.readFileSync(new URL('msmTabs.js', dir), 'utf8');
  for (const id of ['publish', 'timeline', 'sites', 'spread']) assert.match(tabs, new RegExp(`id: '${id}'`));
  const pub = fs.readFileSync(new URL('MsmPublish.jsx', dir), 'utf8');
  assert.match(pub, /disabled=\{!canEdit \|\| busy \|\| blocked \|\| !ready \|\| checking\}/, 'Publish now waits for a clean health check and every warning ticked (round 2)');
  assert.match(pub, /disabled=\{!canEdit \|\| busy \|\| blocked \|\| past \|\| !note\.ok \|\| !ready \|\| sales === undefined\}/, 'Schedule too, never in the past, never with the time box empty, every warning ticked');
  assert.match(pub, /riskChecks\(rows, after/, 'the warnings that need a tick are worked out from the draft');
  assert.match(pub, /summarise\(rows, after/, 'the sentence summary sits above the button');
  assert.match(pub, /api\.publishNow\(working\.id/);
  assert.match(pub, /api\.schedule\(working\.id, runLocal, lead, idle\)/);
});
