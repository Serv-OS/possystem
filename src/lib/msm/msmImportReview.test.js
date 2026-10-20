// Multi site menu: the first import's review step (msmImportReview.js) on the coffee chain shaped
// fixture. Switched off one site rows are in no list (20 Oct review fix), bulk choices per site,
// name matches are linked only when picked as Same product, and whatever is chosen the self check
// still proves zero writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialChoices, setNameTick, tickAllNames, setOnlyOne, setOnlyOneMany, filterOnlyOne, setGroupName, setLeaveOut,
  toDecisions, reviewCounts, importSummaryWords, venueMenuChoices,
} from './msmImportReview.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { A, B, C, importSites, idGen, venues } from './msmFixture.js';

const propose = () => proposeImport(importSites(), { idGen: idGen() });
const nameOf = (p, id) => p.products.find((x) => x.id === id)?.name;

test('starting choices: switched off one site rows are not listed, the rest are brought in', () => {
  const p = propose();
  const ch = initialChoices(p);
  const byName = Object.fromEntries(p.review.onlyOne.map((o) => [o.name, ch.onlyOne[o.productId]]));
  assert.equal(byName['Old special'], undefined, 'switched off: in no list');
  assert.equal(byName.Pie, 'extra');
  assert.deepEqual(ch.tickName, [], 'nothing linked by name until picked');
  assert.deepEqual(ch.leaveName, [], 'and nothing left out by name');
});

test('bulk: every one site row at one site, or every row a search finds, in one go', () => {
  const p = propose();
  let ch = initialChoices(p);
  const atC = filterOnlyOne(p, { location_id: C });
  assert.ok(atC.length >= 1);
  const r = setOnlyOneMany(ch, p, { location_id: C }, 'leave');
  assert.equal(r.count, atC.length);
  ch = r.choices;
  for (const o of atC) assert.equal(ch.onlyOne[o.productId], 'leave');
  assert.deepEqual(filterOnlyOne(p, { location_id: B }), [], 'nothing on sale at B alone');
  const pie = filterOnlyOne(p, { search: 'pie' });
  assert.equal(pie.length, 1);
  ch = setOnlyOneMany(ch, p, { search: 'pie' }, 'extra').choices;
  assert.equal(ch.onlyOne[pie[0].productId], 'extra');
  ch = setOnlyOne(ch, pie[0].productId, 'leave');
  assert.equal(ch.onlyOne[pie[0].productId], 'leave');
});

test('name matches: unticked ones are rejected (each site keeps its own), ticked ones are linked', () => {
  const p = propose();
  const ch = initialChoices(p);
  assert.deepEqual(toDecisions(p, ch).rejectName, p.review.name.map((n) => n.productId));
  const ticked = setNameTick(ch, p.review.name[0].productId, true);
  assert.deepEqual(toDecisions(p, ticked).rejectName, []);
  assert.deepEqual(tickAllNames(ch, p, true).tickName, p.review.name.map((n) => n.productId));
  assert.deepEqual(tickAllNames(ticked, p, false).tickName, []);
  assert.deepEqual(setNameTick(ticked, p.review.name[0].productId, false).tickName, []);
});

test('decisions build a group menu that passes the zero writes check, whatever is chosen', () => {
  const p = propose();
  let ch = initialChoices(p);
  ch = setNameTick(ch, p.review.name[0].productId, true);
  const mocha = p.products.find((x) => x.name === 'Mocha');
  ch = setLeaveOut(ch, mocha.id, true);
  if (p.review.differentNames[0]) ch = setGroupName(ch, p.review.differentNames[0].productId, ' Caffe latte ');
  ch = setOnlyOneMany(ch, p, {}, 'extra').choices;
  const d = toDecisions(p, ch, { menuName: ' Coffee menu ', menuDescription: 'All sites' });
  assert.equal(d.menuName, 'Coffee menu');
  assert.deepEqual(d.leaveOut, [mocha.id]);
  const built = buildCentral(p, importSites(), d, { idGen: idGen('g') });
  assert.equal(built.check.ok, true, JSON.stringify(built.check.problems.slice(0, 3)));
  assert.equal(built.central.products.some((x) => x.name === 'Mocha'), false, 'left out: each site keeps its own');
  assert.equal(built.central.menu.name, 'Coffee menu');
  assert.match(importSummaryWords(built.central, built.check), /Publishing now would change 0 things at 0 sites\.$/);
  assert.equal(toDecisions(p, ch).menuName, 'Group menu', 'a blank name gets one');
  // A product left out takes its sizes with it (20 Oct review fix).
  const latte = p.products.find((x) => x.name === 'Latte');
  const large = p.products.find((x) => x.name === 'Large latte');
  const noLatte = buildCentral(p, importSites(), toDecisions(p, setLeaveOut(ch, latte.id, true)), { idGen: idGen('g') });
  assert.ok(noLatte.dropped.includes(latte.id) && noLatte.dropped.includes(large.id), 'Latte and its size are both left out');
  assert.equal(noLatte.central.products.some((x) => x.name === 'Large latte'), false);
  assert.equal(noLatte.check.ok, true, JSON.stringify(noLatte.check.problems.slice(0, 3)));
  void nameOf;
});

test('counts for the headline and per site', () => {
  const p = propose();
  const ch = initialChoices(p);
  const n = reviewCounts(p, ch, [A, B, C]);
  assert.equal(n.family, p.review.family.length);
  assert.equal(n.family, 5, 'products, never sizes');
  assert.equal(n.name, p.review.name.length);
  assert.equal(n.name, 1);
  assert.equal(n.nameSame, 0);
  assert.equal(n.nameLeave, 0);
  assert.equal(n.switchedOff, 1);
  assert.equal(n.onlyOne.extra + n.onlyOne.leave, p.review.onlyOne.length);
  assert.deepEqual(n.perSite[B], { onlyOne: 0, extra: 0, leave: 0 });
  assert.equal(n.perSite[C].onlyOne, 1);
  assert.equal(n.perSite[A].onlyOne, 0);
});

// 20 Oct review fix: products and their sizes are counted apart; what is kept is counted per product.
test('summary words: products, sizes, sites, products keeping details and the proof (or what is left to settle)', () => {
  const central = { products: [{ id: 'a' }, { id: 'b' }, { id: 's', parent_product_id: 'a' }], sites: [{}, {}], productSites: [{ product_id: 's', kept: { cat: 'x' } }, { product_id: 'b', kept: {} }] };
  assert.equal(importSummaryWords(central, { ok: true }), '2 products with 1 size, at 2 sites. 1 of them keeps some details of its own at one or more sites. Publishing now would change 0 things at 0 sites.');
  assert.match(importSummaryWords(central, { ok: false, writes: 3 }), /found 3 differences/);
  assert.equal(importSummaryWords({ products: [{ id: 'a' }, { id: 'b' }], sites: [{}, {}], productSites: [] }, { ok: true }), '2 products at 2 sites. Publishing now would change 0 things at 0 sites.');
});

test('the menus a site could be imported from: active ones, the default first, with their product counts', () => {
  const v = venues();
  const raw = { ...v[A], menus: [...v[A].menus, { id: 'menu-lunch', name: 'Lunch', is_default: false, is_active: true }, { id: 'menu-old', name: 'Old', is_active: false }] };
  const before = venueMenuChoices(raw);
  assert.deepEqual(before.map((m) => m.id), ['menu-a', 'menu-lunch']);
  assert.equal(before[0].isDefault, true);
  assert.ok(before[0].products > 0);
  assert.equal(before[1].products, 0);
  assert.deepEqual(venueMenuChoices(null), []);
  // 20 Oct review fix: a size is counted as a size, never as a product.
  const oldTotal = before[0].products + before[0].sizes;
  const withSize = { ...raw, items: [...raw.items, { ...raw.items.find((i) => i.id === 'm-latte'), id: 'm-latte-xl', name: 'XL latte', menu_name: 'XL latte', parent_id: 'm-latte' }] };
  const list = venueMenuChoices(withSize);
  assert.deepEqual(list.map((m) => m.id), ['menu-a', 'menu-lunch'], 'the order is as before');
  assert.equal(list[0].sizes, before[0].sizes + 1);
  assert.equal(list[0].products, oldTotal + 1 - list[0].sizes, 'one less product than the old total');
  assert.equal(list[0].products, before[0].products);
});

test('the menus a site could be imported from: the menu picked by default never moves when sizes are counted apart', () => {
  // Two menus, neither the default: Big has fewer products but more rows in all once its sizes count.
  const item = (id, cat, parent = null) => ({ id, cat, cats: [], parent_id: parent, archived: false });
  const raw = {
    menus: [{ id: 'm-big', name: 'Big', is_default: false, is_active: true }, { id: 'm-small', name: 'Small', is_default: false, is_active: true }],
    categories: [{ id: 'c-big', menu_id: 'm-big' }, { id: 'c-small', menu_id: 'm-small' }],
    links: [],
    items: [item('p1', 'c-big'), item('p1-a', 'c-big', 'p1'), item('p1-b', 'c-big', 'p1'), item('p1-c', 'c-big', 'p1'), item('q1', 'c-small'), item('q2', 'c-small'), item('q3', 'c-small')],
  };
  const list = venueMenuChoices(raw);
  assert.deepEqual(list.map((m) => [m.id, m.products, m.sizes]), [['m-big', 1, 3], ['m-small', 3, 0]], 'sorted by the old total (4 then 3), as before');
});
