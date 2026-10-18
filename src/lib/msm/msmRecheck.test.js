// Multi site menu, 17 Oct 2026 recheck: what the last recheck found on the data and planner side.
//   * a site with no Standard price keeps none (kept no_price): the import keeps it, publish never
//     gives it one until someone sets a price there, the screens say "No price at <site>";
//   * a size takes its product's VAT by order type (the four keys), as Menu Manager cascades it;
//   * a turn on never takes over a site's own product (Bring it in links it on purpose);
//   * own_same_name compares full names (a size with its product's name);
//   * one product's VAT change over an old profile copy is one VAT change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, countsWords, lineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, siteDrift, keepVenueChanges, undoChanges, previewSet } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { sizeKeptTax } from '../../../supabase/functions/_shared/msmTax.js';
import { keepsNoPrice, noPriceAt, pricedBySizes, KEPT_COLUMNS } from '../../../supabase/functions/_shared/msmModel.js';
import { siteActiveChange, sitePriceChange, groupValueChange } from './msmEdit.js';
import { bringInChanges } from './msmBringIn.js';
import { indexCentral, cellFor, noPriceWords } from './msmGrid.js';
import { putBackChanges } from './msmDriftView.js';
import { lockedItemPatch, itemLock } from './msmLock.js';
import { A, B, C, ORG, sfx, idGen, venues, importSites } from './msmFixture.js';
import { groupVenues, groupSites, S, ZERO, VAT, PROFILE_A } from './msmGroupFixture.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
function build(v, sites) {
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, JSON.stringify(built.check.problems));
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return { central, built };
}
const planAt = (central, changes, loc, venue) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });
const touchAll = (central, loc, venue) => planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: loc, orgId: ORG, venue });

// ── No price ────────────────────────────────────────────────────────────────

test('the Coffee Boy shape: a product with sizes at one site, an option only sub item elsewhere, no price anywhere: imported whole, zero writes', () => {
  const v = groupVenues();
  // A tea: a product with sizes at A (no Standard price, sizes priced), an option only sub item with
  // no price at B and C (its option carries the price).
  v[A].items.push({ ...v[A].items.find((i) => i.id === 'm-cola'), id: 'm-tea2', name: 'Fruit tea', menu_name: 'Fruit tea', type: 'variants', pricing: { base: null }, tax_profile_id: null, tax_overrides: {} });
  v[A].items.push({ ...v[A].items.find((i) => i.id === 'm-cola'), id: 'm-tea2-r', name: 'Regular', menu_name: 'Regular', parent_id: 'm-tea2', pricing: { base: 2.85 }, tax_profile_id: null, tax_overrides: {} });
  for (const loc of [B, C]) {
    const x = v[loc];
    x.items.push({ ...x.items.find((i) => i.id === S('m-cola', loc)), id: S('m-tea2', loc), name: 'Fruit tea', menu_name: 'Fruit tea', type: 'subitem', sold_alone: false, master_id: 'm-tea2', pricing: { base: null }, tax_overrides: {} });
    const g = x.groups.find((gg) => gg.name === 'Tea choice');
    g.options.push({ id: 'opt-fruit', name: 'Fruit tea', price: 0.2, itemId: S('m-tea2', loc) });
  }
  const sites = groupSites(v);
  const { central, built } = build(v, sites);
  assert.equal(built.check.writes, 0);
  const plain = groupSites(groupVenues());
  assert.equal(built.dropped.length, buildCentral(proposeImport(plain, { idGen: idGen() }), plain, {}, { idGen: idGen('g') }).dropped.length, 'nothing more left out');
  const tea = central.products.find((p) => p.name === 'Fruit tea');
  const at = (loc) => central.productSites.find((r) => r.product_id === tea.id && r.location_id === loc);
  assert.equal(at(A).kept.no_price, undefined, 'the product with sizes needs nothing: publish never writes its own price');
  assert.equal(at(B).kept.no_price, true, 'the option only sub item keeps no price at B');
  assert.equal(at(C).kept.no_price, true);
  // A no op publish of everything plans zero writes at every site.
  for (const s of sites) assert.deepEqual(touchAll(central, s.location_id, s.raw).lines, [], s.name);
  // A group price for it never reaches B or C, and they say nothing (an option only sub item's own price is never charged).
  const up = [{ target: 'product', entity_id: tea.id, op: 'update', after: { default_price: 3 }, before: { default_price: tea.default_price } }];
  for (const loc of [A, B, C]) {
    const p = planAt(central, up, loc, v[loc]);
    assert.equal(p.lines.length, 0, loc);
    assert.ok(!p.problems.some((x) => x.code === 'no_price_kept'), 'never said for an option only sub item or a product with sizes');
  }
});

test('the grid says No price at a site, never 0.00, never a blue dot; "Use the group\'s settings" keeps it; the lock note never lists it', () => {
  const v = venues();
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { base: null };
  const { central } = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const ix = indexCentral(central);
  const cell = cellFor(ix, cola, B);
  assert.deepEqual([cell.noPrice, cell.price, cell.follows, cell.keptCols], [true, null, false, []]);
  assert.equal(cellFor(ix, cola, A).noPrice, false);
  assert.equal(noPriceWords('Leeds'), 'No price at Leeds');
  const ps = central.productSites.find((r) => r.product_id === cola.id && r.location_id === B);
  assert.equal(keepsNoPrice(ps), true);
  assert.equal(noPriceAt(cola, ps), true);
  assert.equal(noPriceAt(cola, ps, 'takeaway'), true, 'takeaway would only fall back to the missing price');
  assert.equal(noPriceAt(cola, { ...ps, channel_prices: { takeaway: 2 } }, 'takeaway'), false, 'its own takeaway price is a price');
  assert.ok(KEPT_COLUMNS.includes('no_price'), 'the database guard knows it (pinned in msmMigration.test.js)');
  // "Use the group price" from the product sheet: on purpose, the group price is written.
  const use = groupValueChange({ live: central, eff: central }, cola.id, B, 'no_price').change;
  assert.deepEqual(use.after, { kept: {} });
  const p = planAt(central, [{ ...use, before: { kept: ps.kept } }], B, v[B]);
  assert.equal(p.writes.items.update[0].pricing.base, Number(cola.default_price));
  // The site's Menu Manager lock never unlocks prices for it and never lists it.
  const lock = itemLock({ ids: new Set([ps.venue_item_id]), kept: new Map([[ps.venue_item_id, ['no_price']]]) }, ps.venue_item_id);
  assert.equal(lock.kept.has('no_price'), false, 'never listed as a setting the site keeps');
  assert.equal(lock.locked('pricing'), true, 'its price stays head office\'s');
  assert.ok(lockedItemPatch({ price: 3 }, { pricing: { base: null } }, ['no_price']).dropped.includes('pricing'));
});

test('drift: a price the venue set on a row with no price is shown in words; Keep the venue\'s keeps it as its own, Put back writes no price again', () => {
  const v = venues();
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { base: null };
  const { central } = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const v2 = clone(v[B]);
  v2.items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { base: 2.75 };
  const d = siteDrift(central, B, v2).filter((x) => x.productId === cola.id);
  assert.equal(d.length, 1);
  assert.equal(d[0].column, 'pricing.base');
  assert.match(d[0].words, /has a price of 2\.75 at the venue now, the group menu has no price for it there/);
  const keep = keepVenueChanges(central, B, d);
  assert.deepEqual(keep[0].after, { price: 2.75, kept: {} }, 'its own price now, and "no price" goes');
  assert.equal(planAt(central, keep, B, v2).lines.length, 0, 'keeping it writes nothing');
  const back = putBackChanges(central, B, d[0]);
  const pb = planAt(central, back, B, v2);
  assert.deepEqual(pb.writes.items.update, [{ id: `m-cola_${sfx(B)}`, set: {}, pricing: { base: null } }], 'no price again at the venue');
  assert.equal(checkSite(pb).blocking.length, 0);
  assert.match(lineWords(pb.lines[0], { [cola.id]: 'Cola' }), /^Cola: back to no price \(was 2\.75\)$/);
  // The venue cleared its own price by hand while the group has one: Keep keeps "no price".
  const v3 = clone(v[A]);
  v3.items.find((i) => i.id === 'm-cola').pricing = { base: null };
  const d3 = siteDrift(central, A, v3).filter((x) => x.productId === cola.id && x.column === 'pricing.base');
  const keep3 = keepVenueChanges(central, A, d3);
  assert.deepEqual(keep3[0].after, { price: null, kept: { no_price: true } });
  assert.equal(planAt(central, keep3, A, v3).lines.length, 0);
});

test('Undo of a price set on a site with no price puts "no price" back at the venue (the version undone exactly)', () => {
  const v = venues();
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { base: null };
  const { central } = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const set = sitePriceChange({ live: central, eff: central }, cola.id, B, 2.6).change;
  const done = planAt(central, [set], B, v[B]);
  const live2 = applyChanges(central, [set]).central;
  const version = { changes: [{ ...set, before: { price: null, kept: { no_price: true } } }] };
  const u = undoChanges(version, live2);
  assert.deepEqual(u.changes[0].after, { price: null, kept: { no_price: true } });
  const vb = clone(v[B]);
  vb.items = done.applied.items;
  const staged = [{ ...u.changes[0], before: { price: 2.6, kept: {} } }];
  const pu = planAt(live2, staged, B, vb);
  assert.equal(pu.applied.items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing.base, null);
  assert.deepEqual(previewSet(live2, staged, { [B]: vb }, { orgId: ORG }).sites[0].health.blocking, []);
});

test('Bring it in keeps no price for a site\'s own row that has none, and writes nothing', () => {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const raw = v[B];
  raw.items.push({ ...raw.items.find((i) => i.id === S('m-mocha', B)), id: 'own-free', name: 'Tap water', menu_name: 'Tap water', pricing: { base: null }, master_id: null, assigned_modifier_groups: [] });
  const r = bringInChanges(central, B, raw, 'own-free', { idGen: idGen('b'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  const ps = r.changes.find((c) => c.target === 'product_site');
  assert.deepEqual([ps.after.price, ps.after.kept.no_price], [null, true]);
  assert.deepEqual(planAt(central, r.changes, B, raw).lines, []);
  assert.match(r.words.join(' '), /"Tap water" has no price at Site B/);
});

// ── A size takes its product's VAT by order type ────────────────────────────

test('sizeKeptTax: a size that equals its product\'s row follows it; a key that differs is kept; other keys are noted', () => {
  assert.equal(sizeKeptTax({ tax_overrides: { takeaway: 'z' } }, { tax_overrides: { takeaway: 'z' } }), null);
  assert.equal(sizeKeptTax({ tax_overrides: {} }, { tax_overrides: {} }), null);
  assert.deepEqual(sizeKeptTax({ tax_overrides: {} }, { tax_overrides: { takeaway: 'z' } }), { takeaway: false });
  assert.deepEqual(sizeKeptTax({ tax_overrides: { takeaway: 'z', counter: 'c' } }, { tax_overrides: {} }), { takeaway: 'z', counter: 'c' });
  assert.deepEqual(sizeKeptTax({ tax_overrides: { takeaway: null } }, { tax_overrides: { takeaway: 'z' } }), { takeaway: null });
  assert.equal(sizeKeptTax({ tax_overrides: { takeaway: null } }, { tax_overrides: { takeaway: null } }), null);
});

test('a takeaway Zero Rate on a product with sizes writes the product and every size at every site and nothing else; Undo restores', () => {
  const v = groupVenues();
  // B and C sell the large size too; B's size has a counter key of its own (it stays).
  v[B].items.find((i) => i.id === S('m-latte-l', B)).tax_overrides = { counter: VAT.B };
  v[C].items.push({ ...v[C].items.find((i) => i.id === S('m-latte', C)), id: S('m-latte-l', C), name: 'Large latte', menu_name: 'Large latte', parent_id: S('m-latte', C), master_id: 'm-latte-l', pricing: { base: 3.7 }, assigned_modifier_groups: [] });
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const latte = central.products.find((p) => p.name === 'Latte');
  const ch = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: latte.tax_by_type ?? null } }];
  const applied = {};
  for (const s of sites) {
    const p = planAt(central, ch, s.location_id, s.raw);
    const ids = p.writes.items.update.map((u) => u.id).sort();
    const want = s.location_id === A ? ['m-latte', 'm-latte-l'] : [S('m-latte', s.location_id), S('m-latte-l', s.location_id)].sort();
    assert.deepEqual(ids, want, `${s.name}: the product and its size`);
    for (const u of p.writes.items.update) {
      assert.deepEqual(Object.keys(u.set), [], 'nothing but VAT by order type');
      assert.equal(u.pricing, undefined);
      assert.deepEqual(u.tax_overrides, { set: { takeaway: ZERO[s.location_id === A ? 'A' : s.location_id === B ? 'B' : 'C'] }, remove: [] });
    }
    assert.equal(p.counts.vat, 2, `${s.name}: one VAT change per row`);
    applied[s.location_id] = p.applied;
  }
  assert.deepEqual(applied[B].items.find((i) => i.id === S('m-latte-l', B)).tax_overrides, { counter: VAT.B, takeaway: ZERO.B }, 'its counter key stays');
  // Undo: every row back exactly as it was.
  const after = applyChanges(central, ch).central;
  const undo = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: latte.tax_by_type ?? null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  for (const s of sites) {
    const venue = { ...s.raw, items: applied[s.location_id].items };
    const u = planAt(after, undo, s.location_id, venue);
    for (const id of u.writes.items.update.map((x) => x.id)) {
      const before = s.raw.items.find((i) => i.id === id);
      assert.deepEqual(u.applied.items.find((i) => i.id === id).tax_overrides || {}, before.tax_overrides || {}, `${s.name} ${id} back exactly`);
    }
  }
});

test('a new size takes its product\'s keys; giving back a key the product kept at a site reaches its sizes there', () => {
  const v = groupVenues();
  v[A].items.find((i) => i.id === 'm-latte').tax_overrides = { takeaway: ZERO.A };
  v[A].items.find((i) => i.id === 'm-latte-l').tax_overrides = { takeaway: ZERO.A };
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const latte = central.products.find((p) => p.name === 'Latte');
  const size = central.products.find((p) => p.name === 'Large latte');
  // Turn the size on at C (Latte is there, the size is not): the new row carries C's Latte keys.
  v[C].items.find((i) => i.id === S('m-latte', C)).tax_overrides = { takeaway: ZERO.C };
  const on = siteActiveChange({ live: central, eff: central }, size.id, C, true);
  const pc = planAt(central, [on.change, ...(on.extra || [])], C, v[C]);
  const ins = pc.writes.items.insert.find((r) => r.parent_id === S('m-latte', C));
  assert.ok(ins, JSON.stringify(pc.problems));
  assert.deepEqual(ins.tax_overrides, { takeaway: ZERO.C });
  // A keeps its own takeaway on Latte (kept null, the venue default); giving it back writes the
  // group's takeaway to Latte and its size at A.
  const c2 = clone(central);
  c2.products.find((p) => p.id === latte.id).tax_by_type = { takeaway: { name: 'Zero Rate', percent: 0 } };
  const ps = c2.productSites.find((r) => r.product_id === latte.id && r.location_id === A);
  ps.kept = { tax_overrides: { takeaway: null } };
  const va = clone(v[A]);
  va.items.find((i) => i.id === 'm-latte').tax_overrides = { takeaway: null };
  va.items.find((i) => i.id === 'm-latte-l').tax_overrides = { takeaway: null };
  const give = [{ target: 'product_site', entity_id: latte.id, location_id: A, op: 'update', after: { kept: {} }, before: { kept: { tax_overrides: { takeaway: null } } } }];
  const pg = planAt(c2, give, A, va);
  assert.deepEqual(pg.writes.items.update.map((u) => [u.id, u.tax_overrides]).sort(), [['m-latte', { set: { takeaway: ZERO.A }, remove: [] }], ['m-latte-l', { set: { takeaway: ZERO.A }, remove: [] }]]);
});

test('a size with a generated copy profile: cleared with the cascade; Undo puts it back', () => {
  const v = groupVenues();
  v[A].items.find((i) => i.id === 'm-latte-l').tax_profile_id = PROFILE_A;
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const latte = central.products.find((p) => p.name === 'Latte');
  const size = central.products.find((p) => p.name === 'Large latte');
  const ch = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } }, before: { tax_by_type: null } }];
  const p = planAt(central, ch, A, v[A]);
  const su = p.writes.items.update.find((u) => u.id === 'm-latte-l');
  assert.deepEqual(su, { id: 'm-latte-l', set: { tax_profile_id: null }, tax_overrides: { set: { takeaway: ZERO.A }, remove: [] } });
  assert.equal(p.counts.vat, 2, 'Latte and its size: one VAT change each, never two for one row');
  const after = applyChanges(central, ch).central;
  after.productSites.find((r) => r.product_id === size.id && r.location_id === A).cleared_tax_profile_id = PROFILE_A;
  const undo = [{ target: 'product', entity_id: latte.id, op: 'update', after: { tax_by_type: null }, before: { tax_by_type: { takeaway: { name: 'Zero Rate', percent: 0 } } } }];
  const u = planAt(after, undo, A, { ...v[A], items: p.applied.items });
  const back = u.applied.items.find((i) => i.id === 'm-latte-l');
  assert.equal(back.tax_profile_id, PROFILE_A);
  assert.deepEqual(back.tax_overrides, {});
});

// ── A turn on never takes over a site's own product ─────────────────────────

test('turn on over the site\'s own copy in THIS menu: blocked in words, nothing written; Bring it in links it on purpose', () => {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const cola = central.products.find((p) => p.name === 'Cola');
  // Site B has its own Cola at 2.90 (the family id), in its main menu, with no group menu row.
  central.productSites = central.productSites.filter((r) => !(r.product_id === cola.id && r.location_id === B));
  const own = v[B].items.find((i) => i.id === S('m-cola', B));
  own.pricing = { base: 2.9 };
  const r = siteActiveChange({ live: central, eff: central }, cola.id, B, true);
  assert.equal(r.change.after.venue_item_id, own.id);
  const p = planAt(central, [r.change, ...(r.extra || [])], B, v[B]);
  const h = checkSite(p);
  assert.ok(h.blocking.some((x) => x.code === 'own_copy_takeover' && /already sells its own "Cola"/.test(x.words) && /bring it in from the Sites tab/.test(x.words)), JSON.stringify(h.blocking));
  assert.ok(!p.lines.some((l) => l.id === own.id), 'its 2.90 is never rewritten');
  // Bring it in, linked to Cola: its own price kept, nothing written, never blocked.
  const b = bringInChanges(central, B, v[B], own.id, { linkTo: cola.id, idGen: idGen('l'), siteName: 'Site B' });
  assert.ok(b.ok, b.problems.join(' | '));
  const pb = planAt(central, b.changes, B, v[B]);
  assert.deepEqual(pb.lines, []);
  assert.equal(checkSite(pb).blocking.length, 0);
});

// ── own_same_name compares full names ───────────────────────────────────────

test('own_same_name: a new size called Large never matches the site\'s own size called Large of another product', () => {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = build(v, sites);
  const latte = central.products.find((p) => p.name === 'Latte');
  // C has its own Pie with a size called Large (not in the group menu).
  v[C].items.push({ ...v[C].items.find((i) => i.id === 'l-pie-c'), id: 'l-pie-c-l', name: 'Large', menu_name: 'Large', parent_id: 'l-pie-c' });
  // The group's Latte gets a new size called Large at C.
  const NEWS = 'f1000000-0000-4000-8000-00000000abcd';
  const ch = [
    { target: 'product', entity_id: NEWS, op: 'create', after: { name: 'Large', menu_name: 'Large', parent_product_id: latte.id, category_id: latte.category_id, default_price: 3.9, tax_rate_name: latte.tax_rate_name, tax_rate_percent: latte.tax_rate_percent, type: 'simple', sold_alone: true } },
    { target: 'product_site', entity_id: NEWS, location_id: C, op: 'create', after: { venue_item_id: `msm-f10000000000_${sfx(C)}`, active: true, price: null, channel_prices: null } },
  ];
  const p = planAt(central, ch, C, v[C]);
  assert.ok(p.writes.items.insert.length === 1, JSON.stringify(p.problems));
  assert.ok(!checkSite(p).warnings.some((w) => w.code === 'own_same_name'), JSON.stringify(checkSite(p).warnings));
  // The site's own "Latte, Large" would match: said, by its full name.
  v[C].items.push({ ...v[C].items.find((i) => i.id === 'l-pie-c'), id: 'l-latte2-c', name: 'Latte', menu_name: 'Latte', cat: 'cat-c-own' });
  v[C].items.push({ ...v[C].items.find((i) => i.id === 'l-pie-c'), id: 'l-latte2-c-l', name: 'Large', menu_name: 'Large', parent_id: 'l-latte2-c', cat: 'cat-c-own' });
  const p2 = planAt(central, ch, C, v[C]);
  const w = checkSite(p2).warnings.find((x) => x.code === 'own_same_name');
  assert.ok(w, JSON.stringify(checkSite(p2).warnings));
  assert.match(w.words, /its own "Latte, Large"/);
});

// ── One VAT change per product row ──────────────────────────────────────────

test('a new VAT rate over an old profile copy reads as 1 VAT change, not 2', () => {
  const v = groupVenues();
  const { central } = build(v, groupSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const ch = [{ target: 'product', entity_id: cola.id, location_id: null, op: 'update', after: { tax_rate_name: 'Zero Rate', tax_rate_percent: 0 }, before: { tax_rate_name: cola.tax_rate_name, tax_rate_percent: cola.tax_rate_percent } }];
  const p = planAt(central, ch, A, v[A]);
  assert.deepEqual(p.lines.filter((l) => l.id === 'm-cola').map((l) => l.column).sort(), ['tax_profile_id', 'tax_rate_id']);
  assert.equal(p.counts.vat, 1);
  assert.equal(countsWords(p.counts), '1 VAT change');
});

test('pricedBySizes: typed variants, or live sizes under it', () => {
  assert.equal(pricedBySizes({ id: 'a', type: 'variants' }, []), true);
  assert.equal(pricedBySizes({ id: 'a', type: 'simple' }, [{ id: 'b', parent_product_id: 'a' }]), true);
  assert.equal(pricedBySizes({ id: 'a', type: 'simple' }, [{ id: 'b', parent_product_id: 'a', archived: true }]), false);
  assert.equal(pricedBySizes({ id: 'a', type: 'simple' }, null), false);
});

test('no price in the words people read: the summary, the ticks and the spreadsheet', async () => {
  const { summarise } = await import('./msmSummary.js');
  const { riskChecks } = await import('./msmRisk.js');
  const { exportCsv, readCsvChanges, parseCsv } = await import('../../../supabase/functions/_shared/msmCsv.js');
  const v = venues();
  v[B].items.find((i) => i.id === `m-cola_${sfx(B)}`).pricing = { base: null };
  const { central } = build(v, importSites(v));
  const cola = central.products.find((p) => p.name === 'Cola');
  const siteNames = new Map([[A, 'Site A'], [B, 'Site B'], [C, 'Site C']]);
  const set = sitePriceChange({ live: central, eff: central }, cola.id, B, 2.6).change;
  const words = summarise([set], central, { siteNames }).join(' ');
  assert.match(words, /Cola gets a price at Site B: 2\.60 \(it had no price there\)/);
  assert.doesNotMatch(words, /go(es)? up|keeps its own|uses the group's no price/);
  assert.ok(!riskChecks([set], central, null, null, { siteNames }).some((r) => r.code === 'big_price'), 'nothing to go up from');
  const free = sitePriceChange({ live: central, eff: central }, cola.id, B, 0).change;
  assert.ok(riskChecks([free], central, null, null, { siteNames }).some((r) => r.code === 'zero_price'), 'free still needs a tick');
  const back = { target: 'product_site', entity_id: cola.id, location_id: B, op: 'update', after: { price: null, kept: { no_price: true } }, before: { price: 2.6, kept: {} } };
  assert.match(summarise([back], central, { siteNames }).join(' '), /Cola has no price at Site B again/);
  // The spreadsheet: blank out, blank in leaves it with no price; a price typed there sets it on purpose.
  const sites = [{ location_id: A, name: 'Site A' }, { location_id: B, name: 'Site B' }, { location_id: C, name: 'Site C' }];
  const csv = exportCsv(central, sites);
  const row = parseCsv(csv).find((r) => r[0] === cola.id);
  assert.equal(row[7], '', 'exported blank, never 0.00');
  assert.deepEqual(readCsvChanges(csv, central, sites).changes, [], 'a round trip changes nothing');
  const lines = csv.split('\r\n');
  const i = lines.findIndex((l) => l.startsWith(cola.id));
  const cells = parseCsv(lines[i])[0];
  cells[7] = '2.65';
  lines[i] = cells.join(',');
  const ch = readCsvChanges(lines.join('\r\n'), central, sites).changes.find((c) => c.location_id === B);
  assert.deepEqual(ch.after, { price: 2.65, kept: {} });
});
