// Multi site menu, 18 Oct 2026 follow up (the review of the 17 Oct recheck). Each test here failed
// on the branch at 6d15c77a and passes after the fix. Made up sites and products only (the repo is
// public).
//   1. the Review and publish tab badge counts with the one counting rule, like the button;
//   2. Change prices names a site where the product is off and follows the group price (kept in step);
//   3. a kiosk re read that answers after the 2 minute give up counts, so re reads stop;
//   4. a kiosk re read that lands mid order is not shown; the next idle moment reads again;
//   5. a size with no VAT rate of its own never gets its product's order type keys (its eat in VAT
//      would move to the site's standard rate): blocked in words;
//   6. a category the group menu already has takes only "send like" and removed or back (the
//      database guard and the screens), and bringing one back adds no second menu record;
//   7. Add a site copying from a site where a product has no price leaves it out, in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as status from './msmStatus.js';
import * as model from '../../../supabase/functions/_shared/msmModel.js';
import * as tillWatch from './msmTillWatch.js';
import { applyPriceChange, priceChangeWords } from '../../../supabase/functions/_shared/msmPrice.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, mergeStaged } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { planAddSite } from '../../../supabase/functions/_shared/msmSites.js';
import { siteActiveChange } from './msmEdit.js';
import { A, B, C, ORG, sfx, idGen, venues, importSites } from './msmFixture.js';
import { groupVenues, groupSites, S, ZERO } from './msmGroupFixture.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
function build(v, sites) {
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return central;
}
const planAt = (central, changes, loc, venue) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });

// ── 1. The Review and publish tab badge ─────────────────────────────────────
test('follow up 1: the Review and publish tab badge is the button\'s count (products changed), never the rows held', () => {
  assert.equal(typeof status.publishBadge, 'function', 'msmStatus.publishBadge');
  const v = groupVenues();
  const central = build(v, groupSites(v));
  const draft = { status: 'draft', title: 'x' };
  // A new size of Latte at every site: one product and its site rows (4 rows).
  const latte = central.products.find((p) => p.name === 'Latte');
  const sizeId = 'eeeeeeee-0000-4000-8000-00000000f001';
  const rows = [{ target: 'product', entity_id: sizeId, location_id: null, op: 'create', after: { name: 'Small latte', parent_product_id: latte.id, category_id: latte.category_id, default_price: 2.6, tax_rate_name: latte.tax_rate_name, tax_rate_percent: latte.tax_rate_percent } }];
  for (const s of central.sites) rows.push({ target: 'product_site', entity_id: sizeId, location_id: s.location_id, op: 'create', after: { venue_item_id: `m-small_${sfx(s.location_id)}`, active: true, price: null } });
  const eff = applyChanges(central, rows).central;
  assert.equal(rows.length, 4);
  assert.equal(status.draftCount(rows, eff).total, 1);
  assert.equal(status.publishBadge({ working: draft, rows, eff }), 1, 'a new size at every site is 1, as the button says');
  // One price at every site for Cola: 3 rows, 1 product changed.
  const cola = central.products.find((p) => p.name === 'Cola');
  const prices = central.sites.map((s) => ({ target: 'product_site', entity_id: cola.id, location_id: s.location_id, op: 'update', after: { price: 2.5 } }));
  assert.equal(status.publishBadge({ working: draft, rows: prices, eff: applyChanges(central, prices).central }), 1);
  // The count the screen has already worked out is used as it is.
  assert.equal(status.publishBadge({ working: draft, rows, counted: { total: 7 } }), 7);
  // No badge on the live menu or a scheduled push.
  assert.equal(status.publishBadge({ working: null, rows }), 0);
  assert.equal(status.publishBadge({ working: { status: 'scheduled' }, rows }), 0);
  // The tab uses it, and the screen hands it the count it shows on the button.
  const tabs = read('../../backoffice/sections/msm/msmTabs.js');
  assert.doesNotMatch(tabs, /s\.rows\.length/, 'the tab badge still counts rows');
  assert.match(tabs, /badge: publishBadge/);
  assert.match(read('../../backoffice/sections/msm/MultiSiteMenu.jsx'), /const shared = \{\n\s+counted, /);
});

// ── 2. Change prices: a site where the product is off and follows the group price ──
const one = (product, sites) => ({
  sites: sites.map((s) => ({ location_id: s.location_id })),
  categories: [],
  products: [{ id: 'p', name: 'P', category_id: null, ...product }],
  productSites: sites.map((s) => ({ product_id: 'p', active: true, price: null, ...s })),
});

test('follow up 2: Change prices names a site where the product is off and follows the group price (kept in step at publish)', () => {
  const c = one({ default_price: 2.2 }, [{ location_id: 'site-1' }, { location_id: 'site-2', active: false }, { location_id: 'site-3' }]);
  const out = applyPriceChange(c, { scope: { all: true }, change: { direction: 'up', mode: 'percent', value: 10 }, sites: 'all' });
  const off = out.rows.find((r) => r.locationId === 'site-2');
  assert.ok(off, 'a row for the site where it is off');
  assert.equal(off.off, true);
  assert.equal(off.follows, true);
  assert.equal(off.staged, false, 'nothing staged there: publish keeps its row in step with the group price');
  assert.equal(off.changed, true);
  assert.equal(off.before, 2.2);
  assert.equal(off.after, 2.42);
  assert.equal(out.summary.offSites, 1);
  assert.equal(out.summary.prices, 2, 'the till prices: the two sites where it is on');
  assert.equal(out.summary.sites, 2);
  assert.equal(priceChangeWords(out.summary), '2 prices change at 2 sites, also keeps 1 site where it is off in step');
  assert.deepEqual(out.changes.map((x) => x.target), ['product'], 'only the group price is staged');
  // A Set to that leaves the price as it is: nothing to keep in step.
  const same = applyPriceChange(c, { scope: { all: true }, change: { mode: 'set', value: 2.2 }, sites: 'all' });
  assert.equal(same.summary.offSites, 0);
  // The screen counts such a site too (its row is not staged, but its price moves at publish).
  const screen = read('../../backoffice/sections/msm/MsmChangePrices.jsx');
  assert.match(screen, /offSites: new Set\(kept\.filter\(\(r\) => r\.off && \(r\.staged \|\| r\.changed\)\)/);
});

// ── 3 and 4. The kiosk's re read ─────────────────────────────────────────────
function fakeTimers() {
  let now = 0, seq = 0;
  const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { jobs.delete(id); },
    pending: () => jobs.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        jobs.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

test('follow up 3: a kiosk re read that answers after the 2 minute give up counts: no more re reads', () => {
  const timers = fakeTimers();
  let reads = 0;
  const ctl = tillWatch.createKioskRefresh({ isIdle: () => true, reload: () => { reads++; }, timers });
  ctl.heard();
  assert.equal(reads, 1);
  // The link is slow: the read is given up at 2 minutes, then answers 30 s later (before the retry).
  timers.advance(tillWatch.KIOSK_READ_GIVE_UP_MS);
  assert.equal(ctl.state().reading, false);
  timers.advance(3000);
  ctl.readDone(true);
  assert.equal(ctl.state().have, ctl.state().wanted, 'the late answer covers the update');
  assert.equal(ctl.state().failures, 0);
  timers.advance(60 * 60 * 1000);
  assert.equal(reads, 1, 'it stopped (the old code read again about every 7 minutes for as long as the link was slow)');
  assert.equal(timers.pending(), 0);
  // A late FAILED answer changes nothing: the retry still runs.
  const t2 = fakeTimers();
  let r2 = 0;
  const c2 = tillWatch.createKioskRefresh({ isIdle: () => true, reload: () => { r2++; }, timers: t2 });
  c2.heard();
  t2.advance(tillWatch.KIOSK_READ_GIVE_UP_MS);
  c2.readDone(false);
  t2.advance(tillWatch.KIOSK_RETRY_FIRST_MS);
  assert.equal(r2, 2);
  // An update heard after the read started still gets one more read once the late answer lands.
  const t3 = fakeTimers();
  let r3 = 0;
  const c3 = tillWatch.createKioskRefresh({ isIdle: () => true, reload: () => { r3++; }, timers: t3 });
  c3.heard();
  t3.advance(tillWatch.KIOSK_READ_GIVE_UP_MS);
  c3.heard();
  assert.equal(r3, 1, 'the retry waits its turn');
  c3.readDone(true);
  assert.equal(r3, 2, 'the newer update is read');
  c3.readDone(true);
  assert.equal(c3.state().have, c3.state().wanted);
  for (const c of [ctl, c2, c3]) c.stop();
});

test('follow up 4: a kiosk re read that lands mid order is not shown; the next idle moment reads again, no failure counted', () => {
  const timers = fakeTimers();
  let idle = true, reads = 0;
  const ctl = tillWatch.createKioskRefresh({ isIdle: () => idle, reload: () => { reads++; }, timers });
  ctl.heard();
  assert.equal(reads, 1);
  // A customer starts an order while the read is out; it lands mid order: the hook does not show it.
  idle = false;
  ctl.readDone('busy');
  assert.equal(ctl.state().reading, false);
  assert.equal(ctl.state().failures, 0, 'not a failure');
  assert.equal(ctl.state().have, 0, 'not shown, so not counted');
  timers.advance(60000);
  assert.equal(reads, 1, 'never mid order');
  idle = true;
  timers.advance(tillWatch.IDLE_CHECK_MS);
  assert.equal(reads, 2, 'read again at the next idle moment');
  ctl.readDone(true);
  assert.equal(ctl.state().have, ctl.state().wanted);
  timers.advance(60 * 60 * 1000);
  assert.equal(reads, 2);
  assert.equal(timers.pending(), 0);
  ctl.stop();
  // The kiosk wiring: the read checks idle when it LANDS, before it swaps the menu, and says busy.
  const kiosk = read('../../surfaces/KioskApp.jsx');
  const menu = kiosk.slice(kiosk.indexOf('function useKioskMenu'), kiosk.indexOf('// Resolve active menu'));
  assert.match(menu, /const busy = !failed && !mayApply\(\);\n\s+if \(!failed && !busy\) setData\(\(prev\) => kioskMenuAfterRead\(prev, res, opts\)\.data\);\n\s+setReloadDone\(\{ key: reloadKey, failed, busy \}\);/);
  assert.match(menu, /const mayApply = \(\) => \{ const now = idleRef\?\.current; return now \? kioskMayRefresh\(\{ pending: true, \.\.\.now \}\) : true; \};/);
  const hook = kiosk.slice(kiosk.indexOf('function useMsmKioskRefresh'), kiosk.indexOf('// PRICING'));
  assert.match(hook, /ctlRef\.current\?\.readDone\(done\.busy \? 'busy' : !done\.failed\)/);
  assert.match(kiosk, /useKioskMenu\(profile, locationId, kioskTz, msmReload, msmIdleRef\)/);
  assert.match(kiosk, /useEffect\(\(\) => \{ msmIdleRef\.current = \{ screen, cartCount: cart\.length \}; \}, \[screen, cart\.length\]\);\n\s+useMsmKioskRefresh\(/);
});

// ── 5. A size with no VAT rate of its own ────────────────────────────────────
function noRateSizes() {
  const v = groupVenues();
  for (const id of ['m-latte-l', S('m-latte-l', B)]) {
    const loc = id === 'm-latte-l' ? A : B;
    const it = v[loc].items.find((i) => i.id === id);
    it.tax_rate_id = null;
    it.tax_overrides = {};
  }
  const sites = groupSites(v);
  return { v, sites, central: build(v, sites) };
}

test('follow up 5: a size with no VAT rate of its own never gets its product\'s order type keys (blocked in words, nothing written)', () => {
  const { sites, central } = noRateSizes();
  const latte = central.products.find((p) => p.name === 'Latte');
  const size = central.products.find((p) => p.name === 'Large latte');
  assert.equal(size.tax_rate_name ?? null, null, 'the import kept the size without a rate');
  const ch = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: latte.tax_by_type ?? null } }];
  for (const s of sites) {
    const p = planAt(central, ch, s.location_id, s.raw);
    const h = checkSite(p);
    if (s.location_id === C) { assert.ok(h.ok, 'C sells no size'); continue; }
    const sizeRow = s.location_id === A ? 'm-latte-l' : S('m-latte-l', B);
    const block = h.blocking.find((x) => x.code === 'size_no_rate');
    assert.ok(block, `${s.name}: ${JSON.stringify(p.problems)}`);
    assert.match(block.words, /The size "Large latte" has no VAT rate of its own at this site/);
    assert.match(block.words, /Nothing was changed\.$/);
    assert.ok(!p.lines.some((l) => l.id === sizeRow && /^tax_overrides\./.test(l.column)), 'no key written on the size');
  }
  // A size that has its own rate takes the keys as before (17 Oct recheck).
  const v2 = groupVenues();
  const c2 = build(v2, groupSites(v2));
  const l2 = c2.products.find((p) => p.name === 'Latte');
  const p2 = planAt(c2, [{ ...ch[0], entity_id: l2.id }], A, v2[A]);
  assert.ok(checkSite(p2).ok, JSON.stringify(p2.problems));
  assert.deepEqual(p2.writes.items.update.find((u) => u.id === 'm-latte-l').tax_overrides, { set: { takeaway: ZERO.A }, remove: [] });
});

test('follow up 5: a size with no VAT rate turned on where its product has order type keys is blocked; with none it goes in with none', () => {
  const { v, central } = noRateSizes();
  const size = central.products.find((p) => p.name === 'Large latte');
  // C sells Latte with a takeaway Zero Rate key of its own: the new size row would carry it and no rate.
  const vc = JSON.parse(JSON.stringify(v[C]));
  vc.items.find((i) => i.id === S('m-latte', C)).tax_overrides = { takeaway: ZERO.C };
  const on = siteActiveChange({ live: central, eff: central }, size.id, C, true);
  const changes = [on.change, ...(on.extra || [])];
  const blocked = planAt(central, changes, C, vc);
  assert.ok(checkSite(blocked).blocking.some((x) => x.code === 'size_no_rate'), JSON.stringify(blocked.problems));
  // Latte at C with no keys: the size goes in with none, so the till charges it Latte's rate.
  const fine = planAt(central, changes, C, v[C]);
  assert.ok(checkSite(fine).ok, JSON.stringify(fine.problems));
  const ins = fine.writes.items.insert.find((r) => r.parent_id === S('m-latte', C));
  assert.ok(ins);
  assert.deepEqual(ins.tax_overrides, {});
});

// ── 6. A category the group menu already has ────────────────────────────────
test('follow up 6: a category the group menu already has takes only "send like" and removed or back; a new one takes everything', () => {
  assert.deepEqual([...(model.CATEGORY_UPDATE_FIELDS || [])], ['archived', 'route_like_id']);
  const k = 'aaaaaaaa-0000-4000-8000-00000000c001';
  const refused = mergeStaged(null, { target: 'category', entity_id: k, location_id: null, op: 'update', after: { label: 'Hot', color: '#000000' } });
  assert.equal(refused.action, 'none');
  assert.match(refused.words, /A category's name, place and colour stay as each site has them/);
  assert.equal(mergeStaged(null, { target: 'category', entity_id: k, location_id: null, op: 'update', after: { route_like_id: k } }).action, 'insert');
  assert.equal(mergeStaged(null, { target: 'category', entity_id: k, location_id: null, op: 'update', after: { archived: true } }).action, 'insert');
  assert.equal(mergeStaged(null, { target: 'category', entity_id: k, location_id: null, op: 'remove', after: { label: 'x' } }).action, 'none');
  // A new category takes every field, also when it is edited again before publishing.
  const created = mergeStaged(null, { target: 'category', entity_id: k, location_id: null, op: 'create', after: { label: 'Soups', sort_order: 4 } });
  assert.equal(created.action, 'insert');
  const again = mergeStaged({ ...created.row, id: 'row-1' }, { target: 'category', entity_id: k, location_id: null, op: 'update', after: { label: 'Soup', color: '#111111' } });
  assert.equal(again.action, 'update');
  assert.equal(again.row.op, 'create');
  assert.equal(again.row.after.label, 'Soup');
  // The database says the same: 20261018, its own trigger after msm_changes_guard (18 Oct recheck:
  // 20261017c had already run on Ops, so the rule is a new step; msmRunOnOps.test.js).
  const sql = read('../../../supabase/migrations/20261018_OPS_multi_site_menu_category_fields.sql');
  const guard = sql.slice(sql.indexOf('create or replace function public.msm_changes_category_fields('), sql.indexOf('$fn$;', sql.indexOf('create or replace function public.msm_changes_category_fields(')));
  assert.match(guard, /if new\.target = 'category' and new\.op <> 'create' and jsonb_typeof\(new\.after\) = 'object'\s+and exists \(select 1 from jsonb_object_keys\(new\.after\) k where k <> all \(array\['archived', 'route_like_id'\]\)\) then/);
  assert.match(sql, /\) as category_fields_ok,/);
});

test('follow up 6: bringing a category back adds no second menu record where it is already on the menu; Undo of a removal still puts both back', () => {
  const v = venues();
  const sites = importSites(v);
  const central = build(v, sites);
  const cold = central.categories.find((c) => c.label === 'Cold drinks');
  // Site A has Cold drinks on its menu by its menu id, with no link row (as some live categories are).
  const va = JSON.parse(JSON.stringify(v[A]));
  va.links = va.links.filter((l) => l.category_id !== 'cat-cold');
  const back = planAt(central, [{ target: 'category', entity_id: cold.id, location_id: null, op: 'update', after: { archived: false } }], A, va);
  assert.deepEqual(back.writes.links.insert, [], 'already on the menu: no link added');
  assert.equal(back.empty, true);
  // Removed, then brought back: its menu id and its link both come back, as before.
  const removed = [{ target: 'category', entity_id: cold.id, location_id: null, op: 'remove', after: {} }];
  const off = planAt(central, removed, A, v[A]);
  const venueOff = { ...v[A], categories: off.applied.categories, links: off.applied.links };
  const again = planAt(applyChanges(central, removed).central, [{ target: 'category', entity_id: cold.id, location_id: null, op: 'update', after: { archived: false } }], A, venueOff);
  assert.deepEqual(again.writes.categories.update, [{ id: 'cat-cold', set: { menu_id: 'menu-a' } }]);
  assert.equal(again.writes.links.insert.length, 1);
});

// ── 7. Add a site, copying from a site with no price ─────────────────────────
test('follow up 7: Add a site copying from a site where a product has no price leaves it out, in words; option only sub items still go', () => {
  const v = venues();
  // At B: Cola has no price at all; Mocha has a takeaway price but no Standard price; Oat milk (an
  // option only sub item) has none either.
  v[B].items.find((i) => i.id === S('m-cola', B)).pricing = { base: null };
  v[B].items.find((i) => i.id === S('m-mocha', B)).pricing = { base: null, takeaway: 3.1 };
  v[B].items.find((i) => i.id === S('m-oat', B)).pricing = { base: null };
  const central = build(v, importSites(v));
  const P = (n) => central.products.find((p) => p.name === n);
  const at = (n) => central.productSites.find((r) => r.product_id === P(n).id && r.location_id === B);
  assert.equal(at('Cola').kept.no_price, true);
  assert.equal(at('Mocha').kept.no_price, true);
  const D = 'dddddddd-0000-4000-8000-0000000d0004';
  const add = planAddSite(central, { locationId: D, prices: 'copy', copyFrom: B });
  const staged = (n) => add.changes.find((c) => c.target === 'product_site' && c.entity_id === P(n).id);
  assert.equal(staged('Cola'), undefined, 'Cola has no price at B: left out (it never takes the group price by accident)');
  assert.ok(staged('Oat milk'), 'an option only sub item is never left out (its options point at it)');
  assert.ok(staged('Mocha'), 'Mocha has a takeaway price at B: it goes');
  assert.deepEqual(staged('Mocha').after.channel_prices, at('Mocha').channel_prices);
  assert.ok(staged('Latte'));
  assert.ok(add.changes.every((c) => !(c.after && 'kept' in c.after)), 'never a kept value on Add a site (that is the Bring in sign)');
  assert.equal(add.leftOut.length, 1);
  assert.match(add.words, /1 product has no price at the site you copy from, so it is left out: Cola/);
  assert.match(add.words, /Mocha has no Standard price there, so at the new site it takes the group price$/);
  // Default prices: nothing is left out.
  const plain = planAddSite(central, { locationId: D, prices: 'default' });
  assert.ok(plain.changes.some((c) => c.target === 'product_site' && c.entity_id === P('Cola').id));
  assert.equal(plain.leftOut.length, 0);
  assert.doesNotMatch(plain.words, /left out/);
});

// ── A. The harness counts the README states (17 Oct claim: "22 in round2.mjs" was 21 there plus 1
// in run.mjs). Each check is one expect() call in the files, none in a loop. ──
test('follow up A: the README counts each round\'s checks as the harness files hold them', () => {
  const round2 = read('../../../supabase/tests/multi_site_menu/round2.mjs');
  const runner = read('../../../supabase/tests/multi_site_menu/run.mjs');
  const readme = read('../../../supabase/tests/multi_site_menu/README.md');
  const count = (src, name) => (src.match(new RegExp(`expect\\('${name}`, 'g')) || []).length;
  assert.equal(count(round2, 'RECHECK'), 21);
  assert.equal(count(round2, 'BUILDER B'), 12);
  assert.equal(count(round2, 'FOLLOW UP'), 8);
  assert.equal(count(runner, 'round 2 check row \\(17 Oct recheck\\)'), 1);
  assert.equal(count(runner, 'round 2 check row \\(18 Oct recheck\\)'), 1);
  assert.equal(count(runner, '20261018'), 4);
  assert.equal(count(runner, 'the 20261018 roll back'), 2);
  // 248 + 21 + 1 = 270; + 12 = 282; + 7 + 1 = 290; 18 Oct recheck (20261018): + 1 + 4 + 2 = 297 (the
  // 18 Oct check row check now says 20261017c is as Ops ran it).
  assert.match(readme, /## 17 Oct 2026 recheck \(270 of 270[^\n]*\n\n22 more checks: 21 in `round2\.mjs` \(named RECHECK\) and 1 in `run\.mjs`/);
  assert.match(readme, /## 17 Oct 2026 recheck, screens and drafts \(282 of 282[^\n]*\n\n12 more checks, all in `round2\.mjs` \(named BUILDER B\)/);
  assert.match(readme, /## 18 Oct 2026 follow up \(290 of 290[^\n]*\n\n8 more checks: 7 in `round2\.mjs` \(named FOLLOW UP\) and 1 in `run\.mjs`/);
  assert.match(readme, /## 18 Oct 2026 recheck, the category rule as its own step \(297 of 297[^\n]*\n\n7 more checks: 1 in `round2\.mjs` \(named FOLLOW UP\) and 6 in `run\.mjs`/);
});
