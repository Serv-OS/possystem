// Multi site menu: the first import (supabase/functions/_shared/msmImport.js) on a company shaped
// like the live estate (msmFixture.js). It must write nothing at any venue, and prove it: the
// planner, with every managed field touched, plans ZERO writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, importPayload, reviewWords, settleKept } from '../../../supabase/functions/_shared/msmImport.js';
import { A, B, C, sfx, ORG, importSites, idGen, venues } from './msmFixture.js';

const byName = (central, name) => central.products.find((p) => p.name === name);
const siteOf = (central, name, loc) => central.productSites.find((s) => s.product_id === byName(central, name).id && s.location_id === loc);

test('matches by family first: masters, suffixed copies, a demoted master, master_id equal to its own id', () => {
  const p = proposeImport(importSites(), { idGen: idGen() });
  assert.equal(p.masterSite, A, 'the site holding most masters sets the central values');
  const fam = p.review.family.map((f) => p.products.find((x) => x.id === f.productId).name).sort();
  assert.deepEqual(fam, ['Cola', 'Large latte', 'Latte', 'Mocha', 'Oat milk', 'Tea']);
  const mocha = p.products.find((x) => x.name === 'Mocha');
  assert.equal(p.productSites.filter((s) => s.product_id === mocha.id).length, 3, 'the demoted master still matches its copies by suffix');
  assert.equal(mocha.family_base, 'm-mocha');
});

test('a same name product outside any family is only proposed, and must be ticked', () => {
  const p = proposeImport(importSites(), { idGen: idGen() });
  assert.equal(p.review.name.length, 1);
  assert.deepEqual(p.review.name[0].names.map((n) => n.name), ['Cookie', 'Cookie']);
  const sites = importSites();
  const built = buildCentral(p, sites, { rejectName: [p.review.name[0].productId] }, { idGen: idGen('g') });
  const cookies = built.central.products.filter((x) => x.name === 'Cookie');
  assert.equal(cookies.length, 2, 'not ticked: each site keeps its own as a site only extra');
  assert.ok(cookies.every((c) => c.site_only_location_id));
  assert.ok(built.check.ok);
});

test('only at one site: a site only extra, archived ones left out by default', () => {
  const p = proposeImport(importSites(), { idGen: idGen() });
  const old = p.review.onlyOne.find((o) => o.name === 'Old special');
  const pie = p.review.onlyOne.find((o) => o.name === 'Pie');
  assert.equal(old.defaultChoice, 'leave');
  assert.equal(pie.defaultChoice, 'extra');
  const built = buildCentral(p, importSites(), {}, { idGen: idGen('g') });
  assert.equal(byName(built.central, 'Old special'), undefined, 'left out: stays the venue\'s own');
  assert.equal(byName(built.central, 'Pie').site_only_location_id, C);
  assert.ok(built.dropped.includes(old.productId));
  assert.match(reviewWords(p.review), /6 matched by family, 1 matched by name only/);
});

test('default price is the most common across sites; every other site gets an override', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  assert.equal(byName(built.central, 'Latte').default_price, 3.2);
  assert.equal(siteOf(built.central, 'Latte', A).price, 3, 'site A charges its own 3.00');
  assert.equal(siteOf(built.central, 'Latte', B).price, null, 'site B follows the default');
  assert.equal(siteOf(built.central, 'Cola', C).price, 2.4);
});

test('what a venue keeps as its own is stored as kept (review blocker 3), never refused', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  assert.deepEqual(siteOf(built.central, 'Tea', B).kept, { cat: null }, 'a copy with no category keeps "no category"');
  assert.deepEqual(siteOf(built.central, 'Mocha', C).kept, { cat: 'cat-c-own' }, 'a copy in a different category keeps it');
  assert.equal(siteOf(built.central, 'Tea', C).active, false, 'archived at one site only = off at that site');
  assert.equal(siteOf(built.central, 'Tea', A).active, true);
});

test('THE SELF CHECK: publishing straight after import would change 0 things at 0 sites', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  assert.equal(built.check.ok, true, JSON.stringify(built.check.problems));
  assert.equal(built.check.writes, 0);
});

test('tax is mapped by percent where the names differ (Standard Rate at B, VAT elsewhere)', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  const latte = byName(built.central, 'Latte');
  assert.equal(latte.tax_rate_name, 'VAT');
  assert.equal(latte.tax_rate_percent, 20);
  assert.equal(siteOf(built.central, 'Latte', B).kept.tax_rate_id, undefined, 'mapped, nothing kept');
});

test('a venue with two VAT rates at the same percent keeps its own rate id (never a guess)', () => {
  const v = venues();
  v[B].taxRates.push({ id: 'tr-b2', location_id: B, name: 'Other', rate: 20, active: true });
  const sites = importSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.equal(siteOf(built.central, 'Latte', B).kept.tax_rate_id, 'tr-b', 'kept: publish never writes tax there unless told');
  assert.ok(built.check.ok);
});

test('options point at central products; sizes at their central parent', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  const g = built.central.groups.find((x) => x.name === 'Milk');
  assert.equal(g.options[0].productId, byName(built.central, 'Oat milk').id);
  assert.equal(g.options[0].itemId, undefined);
  assert.equal(byName(built.central, 'Large latte').parent_product_id, byName(built.central, 'Latte').id);
  assert.equal(built.central.groupSites.length, 2);
});

test('the payload carries every site row for msm_import_commit, and nothing for a left out product', () => {
  const built = buildCentral(proposeImport(importSites(), { idGen: idGen() }), importSites(), {}, { idGen: idGen('g') });
  const pl = importPayload(built.central, { orgId: ORG, name: 'Group menu', description: '' });
  assert.equal(pl.org_id, ORG);
  assert.equal(pl.sites.length, 3);
  const latte = pl.products.find((p) => p.name === 'Latte');
  assert.deepEqual(latte.sites.map((s) => s.venue_item_id).sort(), ['m-latte', `m-latte_${sfx(B)}`, `m-latte_${sfx(C)}`].sort());
  assert.ok(pl.categories.every((c) => c.sites.length >= 1));
  assert.ok(!pl.products.some((p) => p.name === 'Old special'));
});

test('a difference the planner sees is never left unexplained: settleKept reaches zero from a bare start', () => {
  const sites = importSites();
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  for (const ps of built.central.productSites) { ps.kept = {}; }
  const again = settleKept(built.central, sites);
  assert.equal(again.ok, true);
});

// ── 17 Oct review ────────────────────────────────────────────────────────────
test('a venue\'s second menu (catering) is never pulled in: only the chosen menu\'s products', () => {
  const v = venues();
  const a = v[A];
  a.menus.push({ id: 'menu-cater', location_id: A, name: 'Catering', is_default: false, is_active: true, sort_order: 1 });
  a.categories.push({ ...a.categories[0], id: 'cat-platters', label: 'Platters', menu_id: 'menu-cater' });
  a.links.push({ menu_id: 'menu-cater', category_id: 'cat-platters', sort_order: 1 });
  a.items.push({ ...a.items[0], id: 'm-platter', name: 'Sandwich platter', menu_name: 'Sandwich platter', cat: 'cat-platters', assigned_modifier_groups: [] });
  const p = proposeImport(importSites(v), { idGen: idGen() });
  assert.ok(!p.products.some((x) => x.name === 'Sandwich platter'), 'the catering product is not proposed');
  assert.ok(!p.productSites.some((s) => s.venue_item_id === 'm-platter'));
  assert.ok(p.products.some((x) => x.name === 'Oat milk'), 'a sub item used as an option still matches');
});

test('a family clash matches the copy on sale, never an archived duplicate', () => {
  const v = venues();
  const b = v[B];
  const copy = b.items.find((i) => i.id === `m-latte_${sfx(B)}`);
  // An archived duplicate of the same family that sorts FIRST at site B.
  b.items.unshift({ ...copy, id: 'm-latte-old', archived: true, master_id: 'm-latte', sort_order: -1 });
  const p = proposeImport(importSites(v), { idGen: idGen() });
  const latte = p.products.find((x) => x.name === 'Latte');
  const atB = p.productSites.find((s) => s.product_id === latte.id && s.location_id === B);
  assert.equal(atB.venue_item_id, `m-latte_${sfx(B)}`, 'the copy on sale is matched');
  const clash = p.review.clashes.find((c) => c.location_id === B);
  assert.equal(clash.matchedId, `m-latte_${sfx(B)}`);
});

test('a legacy row with no base price is named in words by the self check', () => {
  const v = venues();
  const row = v[B].items.find((i) => i.id === `m-latte_${sfx(B)}`);
  row.pricing = { dineIn: null };
  const sites = importSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.equal(built.check.ok, false);
  assert.ok(built.check.problems.some((x) => /has no base price/.test(x.words)), JSON.stringify(built.check.problems));
});
