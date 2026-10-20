// Multi site menu: the first import's review fix (20 Oct 2026, v5.11.83). On a company shaped like a
// real chain's menus (msmFixture.js venuesForReview): shared products with sizes, switched off junk
// with repeated names, a product set up separately at several sites, a size only at one site, a
// site's own product joining a shared one by name, and clashes.
//   * every line is a PRODUCT; its sizes are under it and follow it
//   * switched off rows are never listed and never clash; they are counted once
//   * a row that joined by name never sets the shared product's values
//   * whatever is picked, publishing straight after changes 0 things at 0 sites
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, reviewWords } from '../../../supabase/functions/_shared/msmImport.js';
import { newItemId, normName } from '../../../supabase/functions/_shared/msmModel.js';
import * as R from './msmImportReview.js';
import { A, B, C, sfx, venues, importSites, idGen, venuesForReview, withJoinedMaster, withMixedForms, withTwoNamesakes } from './msmFixture.js';

const S = (base, loc) => `${base}_${sfx(loc)}`;
const siteName = (l) => ({ [A]: 'Site A', [B]: 'Site B', [C]: 'Site C' })[l] || 'Site';
const money = (x) => (x == null ? '' : `£${Number(x).toFixed(2)}`);
const o = { siteName, money, siteIds: [A, B, C] };
const setup = (v = venuesForReview()) => { const sites = importSites(v); const p = proposeImport(sites, { idGen: idGen() }); return { v, sites, p, r: p.review }; };
const nm = (x) => String(x?.menu_name || x?.name || '').trim();
const top = (products, name, loc = null, rows = []) => products.find((x) => nm(x) === name && !x.parent_product_id && (!loc || rows.some((s) => s.product_id === x.id && s.location_id === loc)));
const sizesOf = (products, parent) => products.filter((x) => x.parent_product_id === parent.id);
const rowsOf = (c, id) => c.productSites.filter((s) => s.product_id === id);
const locsOf = (c, id) => rowsOf(c, id).map((s) => s.location_id).sort();
const nameEntry = (p, name) => p.review.name.find((e) => nm(p.products.find((x) => x.id === e.productId)) === name);
const decide = (p, choices) => R.toDecisions(p, choices);
const LONG_DASH = /[\u2013\u2014]/;

// What the database refuses, and what the self check proves, for one build.
function invariants(b, sites, label = '') {
  const c = b.central;
  assert.equal(b.check.ok, true, `${label}: ${JSON.stringify(b.check.problems.slice(0, 3))}`);
  assert.equal(b.check.writes, 0, `${label}: zero writes`);
  const ids = new Set(c.products.map((p) => p.id));
  for (const p of c.products) if (p.parent_product_id) assert.ok(ids.has(p.parent_product_id), `${label}: ${p.name} has its product`);
  assert.ok(!c.productSites.some((ps) => ps.kept && Object.prototype.hasOwnProperty.call(ps.kept, 'parent_id')), `${label}: no kept parent_id`);
  const pk = new Set();
  const venueRow = new Set();
  for (const ps of c.productSites) {
    const k1 = `${ps.product_id}|${ps.location_id}`;
    const k2 = `${ps.location_id}|${ps.venue_item_id}`;
    assert.ok(!pk.has(k1), `${label}: one row per product and site (${k1})`);
    assert.ok(!venueRow.has(k2), `${label}: one product per venue row (${k2})`);
    pk.add(k1); venueRow.add(k2);
  }
  const raw = new Map(sites.flatMap((s) => s.raw.items.map((i) => [`${s.location_id}|${i.id}`, i])));
  for (const p of c.products) {
    if (!p.parent_product_id) continue;
    for (const ps of rowsOf(c, p.id)) {
      const parentPs = c.productSites.find((x) => x.product_id === p.parent_product_id && x.location_id === ps.location_id);
      assert.ok(parentPs, `${label}: ${p.name} at a site has its product's row there`);
      assert.equal(raw.get(`${ps.location_id}|${ps.venue_item_id}`)?.parent_id, parentPs.venue_item_id, `${label}: ${p.name} sits under its own product's row`);
    }
  }
  for (const p of c.products) assert.ok(rowsOf(c, p.id).some((ps) => ps.active !== false), `${label}: ${p.name} is on at one site at least`);
}

test('1. no list line is a size: every line is a product', () => {
  const { p, r } = setup();
  for (const e of [...r.family, ...r.name, ...r.onlyOne, ...r.differentNames]) {
    assert.equal(p.products.find((x) => x.id === e.productId).parent_product_id, null, 'a size is never a line of its own');
  }
});

test('2. sizes follow a name matched product: Small at both sites is one size, Large is at Site A', () => {
  const { p } = setup();
  const cookie = top(p.products, 'Cookie');
  const small = sizesOf(p.products, cookie).find((x) => nm(x) === 'Small');
  const large = sizesOf(p.products, cookie).find((x) => nm(x) === 'Large');
  assert.deepEqual(locsOf(p, small.id), [A, B].sort(), 'Small and "Small " are one size');
  assert.deepEqual(locsOf(p, large.id), [A]);
  const l = R.nameLine(p, nameEntry(p, 'Cookie'), o);
  assert.deepEqual(l.notes, [
    'With Same product, sizes with the same name become one size: Small (both sites), Large (Site A only).',
    'Not at Site C.',
  ]);
});

test('3. Keep separate splits the sizes with their product: each site\'s Cookie with its own sizes and price', () => {
  const { p, sites, r } = setup();
  const b = buildCentral(p, sites, { rejectName: r.name.map((e) => e.productId) });
  const c = b.central;
  const cookieA = top(c.products, 'Cookie', A, c.productSites);
  const cookieB = top(c.products, 'Cookie', B, c.productSites);
  assert.ok(cookieA && cookieB && cookieA.id !== cookieB.id, 'two Cookie products');
  assert.deepEqual(sizesOf(c.products, cookieA).map(nm).sort(), ['Large', 'Small']);
  assert.deepEqual(sizesOf(c.products, cookieB).map(nm), ['Small']);
  for (const [cookie, loc] of [[cookieA, A], [cookieB, B]]) {
    assert.deepEqual(locsOf(c, cookie.id), [loc]);
    for (const z of sizesOf(c.products, cookie)) assert.deepEqual(locsOf(c, z.id), [loc], 'each size under the Cookie at its own site');
  }
  assert.equal(cookieA.default_price, 1.5, 'its own row\'s price');
  assert.equal(cookieB.default_price, 1.5);
  assert.equal(sizesOf(c.products, cookieB)[0].default_price, 1.3, 'Site B\'s Small at its own price');
  invariants(b, sites, 'keep separate');
});

test('4. Same product: one Cookie, Small at both sites, Large at Site A', () => {
  const { p, sites, r } = setup();
  const cookie = nameEntry(p, 'Cookie');
  const b = buildCentral(p, sites, { rejectName: r.name.map((e) => e.productId).filter((id) => id !== cookie.productId) });
  const c = b.central;
  const cookies = c.products.filter((x) => nm(x) === 'Cookie');
  assert.equal(cookies.length, 1);
  const kids = sizesOf(c.products, cookies[0]);
  assert.deepEqual(locsOf(c, kids.find((x) => nm(x) === 'Small').id), [A, B].sort());
  assert.deepEqual(locsOf(c, kids.find((x) => nm(x) === 'Large').id), [A]);
  invariants(b, sites, 'same product');
});

test('5. leaving out a product with sizes takes its sizes with it (Latte, and Cookie when linked)', () => {
  const { p, sites, r } = setup();
  const latte = top(p.products, 'Latte');
  const large = sizesOf(p.products, latte)[0];
  const b = buildCentral(p, sites, { rejectName: r.name.map((e) => e.productId), leaveOut: [latte.id] });
  assert.ok(b.dropped.includes(latte.id) && b.dropped.includes(large.id));
  assert.ok(!b.central.products.some((x) => x.id === large.id));
  invariants(b, sites, 'leave Latte out');
  const cookie = top(p.products, 'Cookie');
  const b2 = buildCentral(p, sites, { leaveOut: [cookie.id] });
  for (const z of sizesOf(p.products, cookie)) assert.ok(b2.dropped.includes(z.id), `${nm(z)} goes with Cookie`);
  assert.ok(!b2.central.products.some((x) => nm(x) === 'Cookie' || x.parent_product_id === cookie.id));
  invariants(b2, sites, 'leave the linked Cookie out');
});

test('6. leaving out a one site product with sizes takes them with it', () => {
  const v = venuesForReview();
  const pie = v[C].items.find((i) => i.id === 'l-pie-c');
  v[C].items.push({ ...pie, id: 'l-pie-c-s', name: 'Slice', menu_name: 'Slice', parent_id: 'l-pie-c', pricing: { base: 1.5 } });
  const { p, sites, r } = setup(v);
  const entry = r.onlyOne.find((e) => e.name === 'Pie');
  const slice = p.products.find((x) => nm(x) === 'Slice');
  assert.equal(slice.parent_product_id, entry.productId, 'Slice is under Pie, never a line of its own');
  assert.ok(!r.onlyOne.some((e) => e.productId === slice.id));
  const b = buildCentral(p, sites, { rejectName: r.name.map((e) => e.productId), onlyOne: { [entry.productId]: 'leave' } });
  assert.ok(b.dropped.includes(entry.productId) && b.dropped.includes(slice.id));
  assert.ok(!b.central.products.some((x) => nm(x) === 'Slice'));
  invariants(b, sites, 'Pie left out');
  const l = R.onlyOneLine(p, entry, { ...o, choice: 'leave' });
  assert.equal(l.sizes, 'Sizes: Slice £1.50');
  assert.deepEqual(l.notes, ['Left out with its sizes: it stays Site C\'s own, exactly as today.']);
});

test('7. switched off rows are in no list, never clash, have no row, and are counted once', () => {
  const { p, r } = setup();
  const off = ['l-white-1', 'l-white-2', 'l-cola-old', 'l-newsize-c', 'l-old-b', 'm-latte-old', S('m-latte-l', C)];
  for (const id of off) assert.ok(!p.productSites.some((s) => s.venue_item_id === id), `${id} has no product site row`);
  const listed = [...r.family, ...r.name, ...r.onlyOne].map((e) => nm(p.products.find((x) => x.id === e.productId)));
  for (const n of ['White', 'New size', 'Old special']) assert.ok(!listed.includes(n), `${n} is in no list`);
  for (const c of r.clashes) for (const x of c.copies) assert.ok(!off.includes(x.id), `${x.id} is in no clash`);
  assert.deepEqual(r.switchedOff, { count: 6, sizeCopies: 1, bySite: { [A]: 1, [B]: 4, [C]: 1 } });
  assert.equal(R.switchedOffWords(r), '6 deleted or switched off products at your sites stay as they are, not in the group menu.');
  assert.equal(R.switchedOffWords({ switchedOff: { count: 1 } }), '1 deleted or switched off product at your sites stays as it is, not in the group menu.');
  assert.equal(R.switchedOffWords({ switchedOff: { count: 0 } }), '');
});

test('7b. a switched off copy of a real product rides along off; a size copy that lost its product does not', () => {
  const v = venuesForReview();
  const latteA = v[A].items.find((i) => i.id === 'm-latte');
  // One family: a size under Latte at A, a product of its own at B, a switched off product copy at C.
  v[A].items.push({ ...latteA, id: 'm-shot', name: 'Extra shot', menu_name: 'Extra shot', master_id: null, parent_id: 'm-latte', pricing: { base: 0.5 }, assigned_modifier_groups: [] });
  v[B].items.push({ ...v[B].items.find((i) => i.id === S('m-latte', B)), id: S('m-shot', B), name: 'Extra shot', menu_name: 'Extra shot', master_id: 'm-shot', parent_id: null, pricing: { base: 0.5 }, assigned_modifier_groups: [] });
  v[C].items.push({ ...v[C].items.find((i) => i.id === S('m-latte', C)), id: S('m-shot', C), name: 'Extra shot', menu_name: 'Extra shot', master_id: 'm-shot', parent_id: null, archived: true, pricing: { base: 0.5 } });
  const { p, sites, r } = setup(v);
  const offCopy = p.productSites.find((s) => s.venue_item_id === S('m-shot', C));
  assert.ok(offCopy, 'it has a product site row');
  assert.equal(offCopy.active, false, 'off at that site');
  assert.ok(!p.productSites.some((s) => s.venue_item_id === S('m-latte-l', C)), 'the orphan size copy still does not');
  assert.equal(r.switchedOff.count, 6, 'the count is unchanged');
  invariants(buildCentral(p, sites, R.toDecisions(p, R.initialChoices(p))), sites, 'rides along');
});

test('8. clashes are only rows on sale: a second Mocha copy and Site C\'s own Cola', () => {
  const { p, r } = setup();
  assert.deepEqual(r.clashes.map((c) => `${c.kind}:${c.name}@${siteName(c.location_id)}`), ['copies:Mocha@Site C', 'shared:Coca Cola@Site C']);
  const mocha = r.clashes[0];
  assert.equal(mocha.copies.find((x) => x.comesIn).id, S('m-mocha', C), 'the copy on the menu comes in');
  assert.ok(!p.productSites.some((s) => s.venue_item_id === 'm-mocha-old'));
  assert.ok(!p.productSites.some((s) => s.venue_item_id === 'l-cola-c2'));
  assert.deepEqual(R.clashLine(mocha, o), {
    title: 'Mocha',
    situation: 'Site C sells 2 copies of the shared Mocha:',
    copies: ['Copy 1: £3.20 · Specials · on the menu · goes in the group menu', 'Copy 2: £3.20 · no category · not on this menu'],
    words: 'The one marked "goes in the group menu" comes in and the other stays Site C\'s own, as it is today; if Site C no longer sells it, switch it off in Site C\'s Menu Manager.',
  });
  assert.deepEqual(R.clashLine(r.clashes[1], o), {
    title: 'Coca Cola',
    situation: 'Site C sells the shared Coca Cola and also its own separate one:',
    copies: ['The shared one: £2.40 · Cold drinks · on the menu · goes in the group menu', 'Site C\'s own one: £2.00 · Specials · on the menu'],
    words: 'The shared one goes in the group menu and Site C\'s own one stays as it is; if it is an old copy, switch it off in Site C\'s Menu Manager.',
  });
});

test('9. joins by name: Same product, Keep separate and Leave out, for Oat milk and for Tea in place of a switched off copy', () => {
  const { p, sites } = setup();
  const oat = nameEntry(p, 'Oat milk');
  const tea = nameEntry(p, 'Tea');
  const at = (b, id, loc) => b.central.productSites.find((s) => s.product_id === id && s.location_id === loc);
  const venueAt = (b, vid) => b.central.productSites.find((s) => s.venue_item_id === vid);
  const run = (choice) => {
    let ch = R.initialChoices(p);
    ch = R.setNameChoice(R.setNameChoice(ch, oat.productId, choice), tea.productId, choice);
    const b = buildCentral(p, sites, decide(p, ch));
    invariants(b, sites, choice);
    return b;
  };
  const same = run('same');
  assert.equal(at(same, oat.productId, C).venue_item_id, 'l-oat-c', 'joins the shared Oat milk');
  assert.equal(at(same, tea.productId, C).venue_item_id, 'l-tea-c');
  assert.equal(at(same, tea.productId, C).active, true);
  const apart = run('apart');
  const ownOat = venueAt(apart, 'l-oat-c');
  assert.notEqual(ownOat.product_id, oat.productId, 'its own product');
  assert.equal(ownOat.active, true);
  assert.equal(at(apart, tea.productId, C).venue_item_id, S('m-tea', C), 'the switched off copy is back');
  assert.equal(at(apart, tea.productId, C).active, false);
  assert.notEqual(venueAt(apart, 'l-tea-c').product_id, tea.productId);
  const leave = run('leave');
  assert.equal(venueAt(leave, 'l-oat-c'), undefined, 'Left out: no row');
  assert.deepEqual(locsOf(leave.central, oat.productId), [A, B].sort(), 'the shared Oat milk as it was');
  assert.equal(at(leave, tea.productId, C).venue_item_id, S('m-tea', C));
  assert.equal(at(leave, tea.productId, C).active, false);
  assert.equal(venueAt(leave, 'l-tea-c'), undefined);
  const view = R.reviewView(p, R.initialChoices(p));
  assert.equal(R.sharedLine(view, tea.productId, o).sub, 'Hot drinks · on sale at Site A and Site B, not on sale at Site C · group price £2.00');
});

test('10. different names: only a real difference, the group name trimmed and one of the choices', () => {
  const { p, r } = setup();
  assert.equal(r.differentNames.length, 1, 'Cheese & Onion and Cheese and Onion are one name');
  const d = r.differentNames[0];
  assert.equal(nm(p.products.find((x) => x.id === d.productId)), 'Cola');
  assert.equal(d.groupName, 'Cola');
  assert.equal(R.namesLine(p, d, null, o).sub, 'On each site\'s own menu today: Cola at Site A and Site B · Coca Cola at Site C');
  const v = venuesForReview();
  const colaA = v[A].items.find((i) => i.id === 'm-cola');
  colaA.name = 'Cola ';
  colaA.menu_name = 'Cola ';
  const t = setup(v);
  const d2 = t.r.differentNames[0];
  assert.equal(d2.groupName, 'Cola', 'trimmed');
  assert.ok(R.namesLine(t.p, d2, null, o).options.includes(d2.groupName), 'the select has it');
});

test('11. One site only is never at another site; a row two shared products are called is never "only at"', () => {
  const check = ({ v, r }) => {
    for (const e of r.onlyOne) {
      if (e.namesakes) continue;
      for (const loc of [A, B, C].filter((l) => l !== e.location_id)) {
        assert.ok(!v[loc].items.some((i) => i.archived !== true && normName(i.menu_name || i.name) === normName(e.name)), `${e.name} is on sale at ${siteName(loc)} too`);
      }
    }
  };
  check(setup());
  const t = setup(withTwoNamesakes(venuesForReview()));
  check(t);
  const toast = t.r.onlyOne.find((e) => e.name === 'Toast');
  assert.equal(toast.location_id, C);
  assert.equal(toast.namesakes, 2);
  const l = R.onlyOneLine(t.p, toast, o);
  assert.ok(l.sub.includes('Site C\'s own'));
  assert.ok(!l.sub.includes('only at'));
  assert.deepEqual(l.notes, ['2 shared products are also called Toast. This one is not joined to either, because it could be either one.']);
  invariants(buildCentral(t.p, t.sites, R.toDecisions(t.p, R.initialChoices(t.p))), t.sites, 'two namesakes');
});

test('12. the words: headline, lines, mixed forms, own size prices, and never a long dash', () => {
  const { p, r } = setup();
  assert.equal(reviewWords(r), '6 products already shared between sites, 3 set up separately at several sites, 1 with different names, 1 only at one site, 2 clashes.');
  assert.equal(reviewWords({ ...r, name: [] }), '6 products already shared between sites, 1 with different names, 1 only at one site, 2 clashes.', 'no "0 set up separately"');
  const view = R.reviewView(p, R.initialChoices(p));
  const latte = top(p.products, 'Latte');
  const ls = R.sharedLine(view, latte.id, o);
  assert.deepEqual(ls, {
    title: 'Latte',
    sub: 'Hot drinks · sold on its own at Site C; sold with sizes at Site A and Site B · group price £3.20 (1 site charges its own)',
    sizes: 'Sizes: Large latte £3.50',
    notes: ['Site B charges its own price for Large latte.'],
    optionsOnly: false,
  });
  assert.deepEqual(R.sizePriceNotes(R.productFacts(view, latte.id), siteName), ['Site B charges its own price for Large latte.'], 'names the site whose size has its own price');
  assert.equal(R.sharedLine(view, top(p.products, 'Oat milk').id, o).sub, 'Milks · option only · on sale at Site A and Site B · group price £0.40');
  assert.ok(R.sharedLine(view, top(p.products, 'Oat milk').id, o).optionsOnly);
  assert.deepEqual(R.sharedLine(view, latte.id, { ...o, leftOut: true }).notes.at(-1), 'Left out with its sizes: each site keeps its own as it is today, outside the group menu.');
  const cookie = R.nameLine(p, nameEntry(p, 'Cookie'), o);
  assert.equal(cookie.lead, 'Cookie was set up separately at 2 sites, not shared.');
  assert.equal(cookie.choices.apart, 'Keep separate: Cookie comes into the group menu as 2 separate products, one for each site, each with its own price and sizes.');
  assert.equal(cookie.choices.leave, 'Leave out: Cookie stays out of the group menu. Each site keeps its own Cookie, exactly as today.');
  assert.deepEqual(cookie.rows, ['Site A: Cold drinks · sizes Small £1.20, Large £1.80', 'Site B: Cold drinks · sizes Small £1.30']);
  assert.equal(cookie.footer, 'Nothing changes at any site whatever you pick.');
  const oat = R.nameLine(p, nameEntry(p, 'Oat milk'), o);
  assert.equal(oat.lead, 'Oat milk is shared at Site A and Site B. Site C set up its own Oat milk separately.');
  assert.deepEqual(oat.rows, ['Shared at Site A and Site B: group price £0.40', 'Site C: Hot drinks · option only · £0.40']);
  assert.deepEqual(R.onlyOneLine(view, r.onlyOne[0], o), { title: 'Pie', sub: 'Specials · only at Site C · £4.50', sizes: '', notes: [] });
  // Every string the words make, on every line.
  const all = [reviewWords(r), R.switchedOffWords(r), ...Object.values(R.REVIEW_WORDS).flatMap((x) => (typeof x === 'string' ? [x] : Object.values(x)))];
  for (const f of r.family) { const l = R.sharedLine(view, f.productId, { ...o, leftOut: true, joinApart: ['Site C'] }); all.push(l.title, l.sub, l.sizes, ...l.notes); }
  for (const e of r.name) { const l = R.nameLine(p, e, { ...o, sharedLeftOut: true }); all.push(l.title, l.lead, ...Object.values(l.choices), ...l.rows, ...l.notes, l.footer); }
  for (const d of r.differentNames) { const l = R.namesLine(p, d, null, o); all.push(l.title, l.sub); }
  for (const e of r.onlyOne) { const l = R.onlyOneLine(view, e, { ...o, choice: 'leave' }); all.push(l.title, l.sub, l.sizes, ...l.notes); }
  for (const c of r.clashes) { const l = R.clashLine(c, o); all.push(l.title, l.situation, ...l.copies, l.words); }
  for (const s of all) assert.doesNotMatch(String(s), LONG_DASH, s);

  // A shared product sold differently by site: every site named by how it sells it.
  const m = setup(withMixedForms(venuesForReview()));
  const herb = top(m.p.products, 'Herbal tea');
  const hv = R.reviewView(m.p, R.initialChoices(m.p));
  const hl = R.sharedLine(hv, herb.id, o);
  assert.ok(hl.sub.includes('sold with sizes at Site B; an option inside other products at Site A and Site C'), hl.sub);
  assert.ok(!hl.sub.includes(' · option only'), 'no option only tag when the forms differ');
  assert.ok(!hl.notes.some((n) => n.includes('only at Site B')), 'no size note repeating the where words');
  assert.equal(hl.optionsOnly, false, 'it sorts with the products sold on their own');
  assert.ok(R.sharedLine(hv, top(m.p.products, 'Oat milk').id, o).optionsOnly, 'Oat milk goes under the options heading');
});

test('13. THE SELF CHECK, whatever is picked: zero writes, and nothing the database would refuse', () => {
  const { p, sites, r } = setup();
  const ids = r.name.map((e) => e.productId);
  const ways = ['same', 'apart', 'leave'];
  let n = 0;
  for (const a of ways) for (const b of ways) for (const c of ways) {
    let ch = R.initialChoices(p);
    [a, b, c].forEach((w, i) => { ch = R.setNameChoice(ch, ids[i], w); });
    invariants(buildCentral(p, sites, decide(p, ch)), sites, `names ${a}/${b}/${c}`);
    n++;
  }
  assert.equal(n, 27);
  for (const f of r.family) {
    const ch = R.setLeaveOut(R.initialChoices(p), f.productId, true);
    invariants(buildCentral(p, sites, decide(p, ch)), sites, `leave ${nm(p.products.find((x) => x.id === f.productId))} out`);
  }
  for (const w of ['extra', 'leave']) invariants(buildCentral(p, sites, decide(p, R.setOnlyOneMany(R.initialChoices(p), p, {}, w).choices)), sites, `one site ${w}`);
  // Forty seeded random choice sets.
  let seed = 20261020;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 40; i++) {
    let ch = R.initialChoices(p);
    for (const id of ids) ch = R.setNameChoice(ch, id, ways[Math.floor(rnd() * 3)]);
    for (const f of r.family) if (rnd() < 0.25) ch = R.setLeaveOut(ch, f.productId, true);
    for (const e of r.onlyOne) ch = R.setOnlyOne(ch, e.productId, rnd() < 0.5 ? 'leave' : 'extra');
    for (const d of r.differentNames) if (rnd() < 0.5) ch = R.setGroupName(ch, d.productId, d.names[Math.floor(rnd() * d.names.length)].name);
    invariants(buildCentral(p, sites, decide(p, ch)), sites, `random set ${i}`);
  }
  for (const [label, v] of [['joined master', withJoinedMaster(venuesForReview())], ['mixed forms', withMixedForms(venuesForReview())], ['two namesakes', withTwoNamesakes(venuesForReview())]]) {
    const t = setup(v);
    for (const w of ways) {
      let ch = R.initialChoices(t.p);
      for (const e of t.r.name) ch = R.setNameChoice(ch, e.productId, w);
      invariants(buildCentral(t.p, t.sites, decide(t.p, ch)), t.sites, `${label} ${w}`);
    }
  }
});

test('14. the counts are products', () => {
  const { p } = setup();
  const n = R.reviewCounts(p, R.initialChoices(p), [A, B, C]);
  assert.deepEqual(
    { family: n.family, name: n.name, nameSame: n.nameSame, nameLeave: n.nameLeave, names: n.names, onlyOne: n.onlyOne, clashes: n.clashes, switchedOff: n.switchedOff },
    { family: 6, name: 3, nameSame: 0, nameLeave: 0, names: 1, onlyOne: { extra: 1, leave: 0 }, clashes: 2, switchedOff: 6 },
  );
});

test('15. a row that joined by name never sets the shared product\'s values', () => {
  const { p, sites } = setup(withJoinedMaster(venues()));
  const entry = nameEntry(p, 'Tea');
  assert.ok(entry && entry.joined, 'Site C\'s own Tea joins the shared one by name');
  const newSite = 'dddddddd-0000-4000-8000-0000000d0004';
  for (const choice of ['same', 'apart']) {
    const b = buildCentral(p, sites, decide(p, R.setNameChoice(R.initialChoices(p), entry.productId, choice)));
    const c = b.central;
    const tea = c.products.find((x) => x.id === entry.productId);
    assert.equal(tea.family_base, 'm-tea', `${choice}: the family`);
    assert.equal(tea.default_price, 2, `${choice}: Site A's price (a tie with Site B, the master's wins)`);
    assert.equal(tea.image, null, `${choice}: Site A's photo, never Site C's own`);
    assert.equal(c.categories.find((x) => x.id === tea.category_id)?.label, 'Hot drinks');
    assert.equal(tea.tax_rate_name, 'VAT');
    assert.deepEqual(tea.modifier_groups, []);
    assert.equal(newItemId(tea, newSite), `m-tea_${sfx(newSite)}`, 'a later turn on makes the family\'s id');
    const small = sizesOf(c.products, tea).find((x) => nm(x) === 'Small');
    assert.equal(small.family_base, 'm-tea-s');
    assert.equal(small.default_price, 0.3);
    if (choice === 'same') {
      assert.equal(c.productSites.find((s) => s.venue_item_id === 'l-tea-c').price, 2.2, 'Site C keeps its own price');
      assert.equal(c.productSites.find((s) => s.venue_item_id === 'l-tea-c-s').price, 0.4);
    }
    invariants(b, sites, `joined master ${choice}`);
  }
});

test('16. the price reach words are true', () => {
  const crossCheck = (p, id, words) => {
    const { follow, own } = R.priceReach(p, id);
    const f = R.productFacts(p, id);
    for (const loc of follow) {
      const sized = f.sizes.map((z) => z.sites.find((s) => s.location_id === loc && s.on)).filter(Boolean);
      for (const row of sized.length ? sized : [f.sites.find((s) => s.location_id === loc)]) assert.equal(row.own, false, `${siteName(loc)} follows`);
      assert.ok(!words.includes(`${siteName(loc)} charge`), words);
    }
    for (const x of own) {
      const sized = f.sizes.map((z) => z.sites.find((s) => s.location_id === x.loc && s.on)).filter(Boolean);
      assert.ok((sized.length ? sized : [f.sites.find((s) => s.location_id === x.loc)]).some((row) => row.own), `${siteName(x.loc)} charges its own`);
      assert.ok(words.includes(siteName(x.loc)), words);
    }
  };
  const { p } = setup();
  const e = nameEntry(p, 'Cookie');
  const same = R.nameLine(p, e, o).choices.same;
  assert.equal(same, 'Same product: one Cookie in the group menu. A group price change reaches Site A. Site B charges its own size prices and keeps them until you change them there.');
  crossCheck(p, e.productId, same);
  const v = venuesForReview();
  v[B].items.find((i) => i.id === 'l-cookie-b-s').pricing = { base: 1.2 };
  const t = setup(v);
  const s2 = R.nameLine(t.p, nameEntry(t.p, 'Cookie'), o).choices.same;
  assert.equal(s2, 'Same product: one Cookie in the group menu. A group price change reaches both sites.');
  crossCheck(t.p, nameEntry(t.p, 'Cookie').productId, s2);
  const v3 = venues();
  v3[B].items.find((i) => i.id === 'l-cookie-b').pricing = { base: 1.7 };
  const t3 = setup(v3);
  const s3 = R.nameLine(t3.p, nameEntry(t3.p, 'Cookie'), o).choices.same;
  assert.equal(s3, 'Same product: one Cookie in the group menu. A group price change reaches Site A. Site B charges its own £1.70 and keeps it until you change it there.');
  crossCheck(t3.p, nameEntry(t3.p, 'Cookie').productId, s3);
  const tea = nameEntry(p, 'Tea');
  const ts = R.nameLine(p, tea, o).choices.same;
  assert.equal(ts, 'Same product: Site C\'s Tea joins the shared one. A group price change reaches Site A and Site B. Site C charges its own £2.10 and keeps it until you change it there.');
  crossCheck(p, tea.productId, ts);
});

test('17. the three way choice: Same product, Keep separate, Leave out', () => {
  const { p, sites } = setup();
  const cookie = nameEntry(p, 'Cookie');
  let ch = R.initialChoices(p);
  assert.equal(R.nameChoiceOf(ch, cookie.productId), 'apart', 'Keep separate by default');
  ch = R.setNameChoice(ch, cookie.productId, 'same');
  assert.deepEqual([ch.tickName, ch.leaveName], [[cookie.productId], []]);
  assert.equal(R.nameChoiceOf(ch, cookie.productId), 'same');
  ch = R.setNameChoice(ch, cookie.productId, 'leave');
  assert.deepEqual([ch.tickName, ch.leaveName], [[], [cookie.productId]]);
  assert.equal(R.nameChoiceOf(ch, cookie.productId), 'leave');
  assert.deepEqual(R.toDecisions(p, ch).leaveName, [cookie.productId]);
  assert.deepEqual(R.setNameTick(ch, cookie.productId, true).leaveName, [], 'ticking takes it out of Leave out');
  assert.deepEqual(R.tickAllNames(ch, p, false).leaveName, [], 'All separate clears Leave out');
  const b = buildCentral(p, sites, R.toDecisions(p, ch));
  assert.ok(!b.central.products.some((x) => nm(x) === 'Cookie'), 'no Cookie product');
  for (const id of ['l-cookie-a', 'l-cookie-b', 'l-cookie-a-s', 'l-cookie-a-l', 'l-cookie-b-s']) assert.ok(!b.central.productSites.some((s) => s.venue_item_id === id), `${id}: each site keeps its own`);
  for (const z of sizesOf(p.products, p.products.find((x) => x.id === cookie.productId))) assert.ok(b.dropped.includes(z.id), `${nm(z)} is in dropped`);
  invariants(b, sites, 'Cookie left out');
  assert.equal(R.reviewCounts(p, ch, [A, B, C]).nameLeave, 1);
  assert.equal(R.footerWords(R.reviewCounts(p, ch, [A, B, C]), ch), '1 one site product brought in, 1 left out.');
  // A shared product left out while its join is Kept separate: the site's own one still comes in.
  const oat = nameEntry(p, 'Oat milk');
  const ch2 = R.setLeaveOut(R.initialChoices(p), oat.productId, true);
  const b2 = buildCentral(p, sites, R.toDecisions(p, ch2));
  const own = b2.central.productSites.find((s) => s.venue_item_id === 'l-oat-c');
  assert.ok(own && own.product_id !== oat.productId && own.active, 'the apart Oat milk comes in');
  invariants(b2, sites, 'Oat milk left out, its join kept separate');
  const line = R.sharedLine(R.reviewView(p, ch2), oat.productId, { ...o, leftOut: true, joinApart: ['Site C'] });
  assert.equal(line.notes.at(-1), 'Site C\'s own Oat milk is under Set up separately: it still comes in as its own product unless you leave it out there too.');
  const nl = R.nameLine(p, oat, { ...o, sharedLeftOut: true });
  assert.equal(nl.notes.at(-1), 'The shared Oat milk is left out under Already shared, so Same product leaves Site C\'s Oat milk out too.');
});

test('18. clash sentences never advise switching off a copy an option uses, nor a step that cannot be done', () => {
  const v = venuesForReview();
  // An option group at C that uses the second Mocha copy.
  v[C].groups.push({ id: 'mgd-extra-c', location_id: C, name: 'Coffee extras', min: 0, max: 1, selection_type: 'single', sort_order: 2, options: [{ id: 'opt-mocha-old', name: 'Mocha shot', price: 0.5, itemId: 'm-mocha-old' }] });
  v[C].items.find((i) => i.id === S('m-latte', C)).assigned_modifier_groups = [{ groupId: 'mgd-extra-c' }];
  // Two live sizes called Small under Pie at C, and two option only Syrups at C.
  const pie = v[C].items.find((i) => i.id === 'l-pie-c');
  v[C].items.push({ ...pie, id: 'l-pie-s1', name: 'Small', menu_name: 'Small', parent_id: 'l-pie-c', pricing: { base: 4 } });
  v[C].items.push({ ...pie, id: 'l-pie-s2', name: 'Small', menu_name: 'Small', parent_id: 'l-pie-c', pricing: { base: 4.2 } });
  v[C].items.push({ ...pie, id: 'l-syrup-1', name: 'Syrup', menu_name: 'Syrup', type: 'subitem', sold_alone: false, pricing: { base: 0.3 } });
  v[C].items.push({ ...pie, id: 'l-syrup-2', name: 'Syrup', menu_name: 'Syrup', type: 'subitem', sold_alone: false, pricing: { base: 0.4 } });
  const { p, sites, r } = setup(v);
  const mocha = R.clashLine(r.clashes.find((c) => c.kind === 'copies'), o);
  assert.ok(mocha.copies.some((x) => x.includes(' · used in "Coffee extras"')), mocha.copies.join(' | '));
  assert.ok(mocha.words.includes('so keep it on'), mocha.words);
  assert.ok(!mocha.words.includes('switch it off'), mocha.words);
  const size = r.clashes.find((c) => c.level === 'size');
  const sl = R.clashLine(size, o);
  assert.equal(sl.title, 'Small (a size of Pie)');
  assert.equal(sl.words, 'Neither goes in the group menu, so both stay as they are at Site C. If one is an old copy that no option uses, switch it off in Site C\'s Menu Manager, then start this set up again: the other one then comes in with Pie.');
  assert.ok(!sl.words.includes('Sites tab'));
  const syrup = R.clashLine(r.clashes.find((c) => c.name === 'Syrup'), o);
  assert.ok(syrup.words.includes('start this set up again'), syrup.words);
  assert.ok(!syrup.words.includes('Sites tab'));
  const cola = R.clashLine(r.clashes.find((c) => c.kind === 'shared'), o);
  assert.equal(cola.words, 'The shared one goes in the group menu and Site C\'s own one stays as it is; if it is an old copy, switch it off in Site C\'s Menu Manager.', 'a copy no option uses keeps its sentence');
  const plain = { kind: 'name', level: 'product', location_id: C, name: 'Scone', parentName: null, copies: [{ id: 'x1', price: 2, category: 'Cakes', optionOnly: false, onMenu: true, comesIn: false, usedBy: [] }, { id: 'x2', price: 2, category: 'Cakes', optionOnly: false, onMenu: true, comesIn: false, usedBy: [] }] };
  assert.ok(R.clashLine(plain, o).words.endsWith('then bring the other in from the Sites tab once the group menu is made.'));
  const bothUsed = { ...plain, copies: plain.copies.map((x) => ({ ...x, usedBy: ['Extras'] })) };
  assert.equal(R.clashLine(bothUsed, o).words, 'Neither goes in the group menu, so both stay as they are at Site C. Both are used in options there, so keep them on.');
  invariants(buildCentral(p, sites, R.toDecisions(p, R.initialChoices(p))), sites, 'clash cases');
});

test('19. a one site option says which groups use it; Clashes never says "Needs you"', () => {
  const v = venuesForReview();
  const pie = v[C].items.find((i) => i.id === 'l-pie-c');
  v[C].items.push({ ...pie, id: 'l-sauce-c', name: 'Brown sauce', menu_name: 'Brown sauce', type: 'subitem', sold_alone: false, pricing: { base: 0.2 } });
  v[C].groups.push({ id: 'mgd-sauce-c', location_id: C, name: 'Add sauce', min: 0, max: 1, selection_type: 'single', sort_order: 3, options: [{ id: 'opt-sauce', name: 'Brown sauce', price: 0.2, itemId: 'l-sauce-c' }] });
  pie.assigned_modifier_groups = [{ groupId: 'mgd-sauce-c' }];
  const { p, sites, r } = setup(v);
  const sauce = r.onlyOne.find((e) => e.name === 'Brown sauce');
  assert.equal(R.onlyOneLine(p, sauce, o).sub, 'Specials · option only · used in "Add sauce" · only at Site C · £0.20');
  const needs = R.needsOf(R.reviewCounts(p, R.initialChoices(p), [A, B, C]));
  assert.deepEqual(Object.keys(needs).sort(), ['name', 'names', 'onlyOne']);
  assert.equal('clashes' in needs, false);
  invariants(buildCentral(p, sites, R.toDecisions(p, R.initialChoices(p))), sites, 'sauce');
});

test('20. Keep separate never leaves a size switched off at every site', () => {
  for (const familyLink of [false, true]) {
    const v = withJoinedMaster(venuesForReview());
    for (const [loc, id] of [[A, 'm-tea-s'], [B, S('m-tea-s', B)]]) v[loc].items.find((i) => i.id === id).archived = true;
    // With the family link, Site C's own Small is a copy of the shared size: the size group's only
    // row on sale is the joined site's.
    if (familyLink) v[C].items.find((i) => i.id === 'l-tea-c-s').master_id = 'm-tea-s';
    const { p, sites } = setup(v);
    const tea = nameEntry(p, 'Tea');
    const b = buildCentral(p, sites, decide(p, R.setNameChoice(R.initialChoices(p), tea.productId, 'apart')));
    const c = b.central;
    const teaP = c.products.find((x) => x.id === tea.productId);
    assert.deepEqual(sizesOf(c.products, teaP), [], `${familyLink}: no size of the shared Tea is left with every row off`);
    for (const id of ['m-tea-s', S('m-tea-s', B)]) assert.ok(!c.productSites.some((s) => s.venue_item_id === id), `${familyLink}: ${id} stays as it is`);
    assert.ok(c.productSites.some((s) => s.venue_item_id === 'l-tea-c-s' && s.active), `${familyLink}: Site C's own Small comes in under its own Tea`);
    invariants(b, sites, `size all off ${familyLink}`);
  }
});

test('21. productFacts through the index equals a plain filter, on every product', () => {
  const { p } = setup(withMixedForms(venuesForReview()));
  const view = R.reviewView(p, R.initialChoices(p));
  const direct = (id) => {
    const x = view.products.find((y) => y.id === id);
    const forms = view.review.rowForms;
    const sitesOf = (z) => view.productSites.filter((ps) => ps.product_id === z.id).map((ps) => ({ location_id: ps.location_id, venue_item_id: ps.venue_item_id, on: ps.active !== false, price: ps.price ?? z.default_price ?? null, own: ps.price != null }));
    const sizes = view.products.filter((z) => z.parent_product_id === x.id).map((z) => ({ id: z.id, name: nm(z), groupPrice: z.default_price ?? null, sites: sitesOf(z) }));
    const sized = new Set(sizes.flatMap((z) => z.sites.filter((s) => s.on).map((s) => s.location_id)));
    const opt = x.type === 'subitem' && x.sold_alone !== true;
    return {
      id: x.id, name: nm(x), category: view.categories.find((c) => c.id === x.category_id)?.label || null, optionOnly: opt, pricedBySize: x.type === 'variants', groupPrice: x.default_price ?? null,
      sites: sitesOf(x).map((s) => { const rf = forms[`${s.location_id}|${s.venue_item_id}`]; const option = rf ? rf.optionOnly === true : opt; return { location_id: s.location_id, on: s.on, price: s.price, own: s.own, form: option ? 'option' : sized.has(s.location_id) ? 'sized' : 'plain', usedBy: rf?.usedBy || [] }; }),
      sizes,
    };
  };
  for (const x of view.products) assert.deepEqual(R.productFacts(view, x.id), direct(x.id), nm(x));
  assert.equal(R.indexView(view), R.indexView(view), 'built once per view');
});

// Review round 2 (20 Oct 2026): a row with no price of its own for a channel (dine in, say) must
// make that channel's group default empty, or the planner would write the default into it. Every
// row that can get a site row in the product counts: its own rows, rows that joined by name, the
// switched off copy put back, and sizes that join by name with no choice to make.
test('22. channel prices: a joined, put back or auto joined size row with no channel price keeps the check at zero writes', () => {
  const teaCase = (variant) => {
    const v = venuesForReview();
    const at = (loc, id) => v[loc].items.find((i) => i.id === id);
    const tA = at(A, 'm-tea'), tB = at(B, S('m-tea', B)), off = at(C, S('m-tea', C)), own = at(C, 'l-tea-c');
    tA.pricing = { ...tA.pricing, dineIn: 2.5 };
    tB.pricing = { ...tB.pricing, dineIn: 2.5 };
    off.pricing = { ...off.pricing, dineIn: variant === 'put back has none' ? null : 2.5 };
    own.pricing = { ...own.pricing, dineIn: variant === 'joined has none' ? null : 2.5 };
    return setup(v);
  };
  for (const variant of ['put back has none', 'joined has none', 'every row agrees']) {
    const { p, sites } = teaCase(variant);
    const tea = nameEntry(p, 'Tea');
    assert.ok(tea && tea.joined, `${variant}: Site C's own Tea joins the shared Tea by name`);
    const teaP = p.products.find((x) => x.id === tea.productId);
    assert.equal(teaP.default_channels.dineIn, variant === 'every row agrees' ? 2.5 : null, `${variant}: a channel default only where every row agrees`);
    for (const pick of ['same', 'apart', 'leave']) {
      invariants(buildCentral(p, sites, decide(p, R.setNameChoice(R.initialChoices(p), tea.productId, pick))), sites, `${variant} / ${pick}`);
    }
  }
  // A joined row never SETS a channel default: the shared rows have none, the joined row has one.
  {
    const v = venuesForReview();
    v[C].items.find((i) => i.id === 'l-tea-c').pricing = { base: 2.1, dineIn: 3 };
    const { p, sites } = setup(v);
    const tea = nameEntry(p, 'Tea');
    assert.equal(p.products.find((x) => x.id === tea.productId).default_channels.dineIn, null);
    for (const pick of ['same', 'apart', 'leave']) invariants(buildCentral(p, sites, decide(p, R.setNameChoice(R.initialChoices(p), tea.productId, pick))), sites, `joined sets none / ${pick}`);
  }
  // A size that joins by name on its own (Site C's own Large latte under the shared Latte), with no
  // dine in price where the shared size has one: the DEFAULT choices pass.
  {
    const v = venues();
    for (const [loc, id] of [[A, 'm-latte-l'], [B, S('m-latte-l', B)]]) { const z = v[loc].items.find((i) => i.id === id); z.pricing = { ...z.pricing, dineIn: 4 }; }
    const latteC = v[C].items.find((i) => i.id === S('m-latte', C));
    v[C].items.push({ ...latteC, id: 'l-large-c', name: 'Large latte', menu_name: 'Large latte', master_id: null, parent_id: latteC.id, pricing: { base: 3.9, dineIn: null }, scope: 'local' });
    const sites = importSites(v);
    const p = proposeImport(sites, { idGen: idGen() });
    const large = p.productSites.find((s) => s.venue_item_id === 'l-large-c');
    assert.ok(large, 'the size comes in under the shared Latte');
    const size = p.products.find((x) => x.id === large.product_id);
    assert.ok(size.parent_product_id, 'as a size');
    assert.equal(size.default_channels.dineIn, null, 'no dine in default: Site C has none');
    invariants(buildCentral(p, sites, R.toDecisions(p, R.initialChoices(p))), sites, 'size joined with no channel price');
  }
});

test('23. clash words follow the choices: a copy left out never says it goes in the group menu', () => {
  const { p, sites, r } = setup();
  const cola = r.clashes.find((c) => c.kind === 'shared');
  const mocha = r.clashes.find((c) => c.kind === 'copies');
  const colaP = top(p.products, 'Cola');
  const mochaP = top(p.products, 'Mocha');
  const def = R.rowsComingIn(p, R.initialChoices(p));
  assert.equal(R.clashLeftOut(cola, def), false);
  assert.equal(R.clashLeftOut(mocha, def), false);
  assert.ok(R.clashLine(cola, { ...o, leftOut: R.clashLeftOut(cola, def) }).words.startsWith('The shared one goes in the group menu'));
  const ch = R.setLeaveOut(R.setLeaveOut(R.initialChoices(p), colaP.id, true), mochaP.id, true);
  const gone = R.rowsComingIn(p, ch);
  assert.equal(R.clashLeftOut(cola, gone), true);
  assert.equal(R.clashLeftOut(mocha, gone), true);
  assert.deepEqual(R.clashLine(cola, { ...o, leftOut: true }), {
    title: 'Coca Cola',
    situation: 'Site C sells the shared Coca Cola and also its own separate one:',
    copies: ['The shared one: £2.40 · Cold drinks · on the menu · left out of the group menu', 'Site C\'s own one: £2.00 · Specials · on the menu'],
    words: 'You left the shared Coca Cola out, so neither goes in the group menu: both stay as they are at Site C.',
  });
  const ml = R.clashLine(mocha, { ...o, leftOut: true });
  assert.equal(ml.words, 'You left Mocha out, so neither copy goes in the group menu: both stay as they are at Site C.');
  assert.ok(!ml.copies.some((x) => x.includes('goes in the group menu')), ml.copies.join(' | '));
  // A size copy left out with its product names the product.
  const sizeClash = { kind: 'copies', level: 'size', location_id: C, name: 'Large', parentName: 'Latte', copies: [{ id: 'z1', price: 3.5, category: null, optionOnly: false, onMenu: true, comesIn: true, usedBy: [] }, { id: 'z2', price: 3.5, category: null, optionOnly: false, onMenu: true, comesIn: false, usedBy: [] }] };
  assert.equal(R.clashLine(sizeClash, { ...o, leftOut: true }).words, 'You left Latte out, so neither copy goes in the group menu: both stay as they are at Site C.');
  // leftOut on a clash with no copy coming in changes nothing.
  const plain = { kind: 'name', level: 'product', location_id: C, name: 'Scone', parentName: null, copies: [{ id: 'x1', price: 2, category: 'Cakes', optionOnly: false, onMenu: true, comesIn: false, usedBy: [] }, { id: 'x2', price: 2, category: 'Cakes', optionOnly: false, onMenu: true, comesIn: false, usedBy: [] }] };
  assert.deepEqual(R.clashLine(plain, { ...o, leftOut: true }), R.clashLine(plain, o));
  assert.equal(R.clashLeftOut(plain, gone), false);
  // rowsComingIn is exactly the venue rows buildCentral brings in, for every set of choices.
  const keys = (b) => new Set(b.central.productSites.map((ps) => `${ps.location_id}|${ps.venue_item_id}`));
  const ids = r.name.map((e) => e.productId);
  const ways = ['same', 'apart', 'leave'];
  const sets = [];
  for (const a of ways) for (const b of ways) for (const c of ways) {
    let x = R.initialChoices(p);
    [a, b, c].forEach((w, i) => { x = R.setNameChoice(x, ids[i], w); });
    sets.push(x, R.setLeaveOut(x, colaP.id, true), R.setLeaveOut(x, top(p.products, 'Tea').id, true));
  }
  for (const f of r.family) sets.push(R.setLeaveOut(R.initialChoices(p), f.productId, true));
  for (const e of r.onlyOne) sets.push(R.setOnlyOne(R.initialChoices(p), e.productId, 'leave'));
  for (const x of sets) assert.deepEqual(R.rowsComingIn(p, x), keys(buildCentral(p, sites, decide(p, x))), JSON.stringify(x));
});

test('24. "sites charge their own" counts only the sites where it is on sale', () => {
  const v = venuesForReview();
  v[C].items.find((i) => i.id === S('m-tea', C)).pricing = { base: 2.4 };   // the switched off copy put back
  const { p } = setup(v);
  const tea = top(p.products, 'Tea');
  const view = R.reviewView(p, R.initialChoices(p));
  const f = R.productFacts(view, tea.id);
  assert.ok(f.sites.some((s) => !s.on && s.own), 'Site C has its own price on a copy that is not on sale');
  assert.equal(R.sharedLine(view, tea.id, o).sub, 'Hot drinks · on sale at Site A and Site B, not on sale at Site C · group price £2.00');
  v[B].items.find((i) => i.id === S('m-tea', B)).pricing = { base: 2.2 };   // on sale with its own price
  const q = setup(v).p;
  const qv = R.reviewView(q, R.initialChoices(q));
  assert.equal(R.sharedLine(qv, top(q.products, 'Tea').id, o).sub, 'Hot drinks · on sale at Site A and Site B, not on sale at Site C · group price £2.00 (1 site charges its own)');
});

test('25. with every product left out there is nothing to make', () => {
  const { p, sites, r } = setup();
  let ch = R.initialChoices(p);
  for (const f of r.family) ch = R.setLeaveOut(ch, f.productId, true);
  for (const e of r.name) ch = R.setNameChoice(ch, e.productId, 'leave');
  ch = R.setOnlyOneMany(ch, p, {}, 'leave').choices;
  const b = buildCentral(p, sites, decide(p, ch));
  assert.equal(b.check.ok, true);
  assert.equal(R.nothingToMake(b.central), true);
  assert.equal(R.canMakeGroupMenu(b.central, b.check), false, 'Make the group menu cannot be pressed');
  assert.equal(R.importSummaryWords(b.central, b.check), 'Every product is left out, so there is nothing to make. Go back to the matches and bring in at least one product.');
  const d = buildCentral(p, sites, decide(p, R.initialChoices(p)));
  assert.equal(R.nothingToMake(d.central), false);
  assert.equal(R.canMakeGroupMenu(d.central, d.check), true);
  assert.equal(R.canMakeGroupMenu(d.central, { ...d.check, ok: false }), false, 'never when the check fails');
  // Sizes alone are not a menu.
  assert.equal(R.nothingToMake({ products: [{ id: 's', parent_product_id: 'gone' }] }), true);
});
