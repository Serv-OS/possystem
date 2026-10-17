// Multi site menu: the first import's review step (msmImportReview.js) on the coffee chain shaped
// fixture. Archived one site rows start as Leave out, bulk choices per site, name matches are
// linked only when ticked, and whatever is chosen the self check still proves zero writes.
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

test('starting choices: archived one site rows are left out, the rest become site only extras', () => {
  const p = propose();
  const ch = initialChoices(p);
  const byName = Object.fromEntries(p.review.onlyOne.map((o) => [o.name, ch.onlyOne[o.productId]]));
  assert.equal(byName['Old special'], 'leave');
  assert.equal(byName.Pie, 'extra');
  assert.deepEqual(ch.tickName, [], 'nothing linked by name until ticked');
});

test('bulk: every one site row at one site, or only the archived ones, in one go', () => {
  const p = propose();
  let ch = initialChoices(p);
  const atC = filterOnlyOne(p, { location_id: C });
  assert.ok(atC.length >= 1);
  const r = setOnlyOneMany(ch, p, { location_id: C }, 'leave');
  assert.equal(r.count, atC.length);
  ch = r.choices;
  for (const o of atC) assert.equal(ch.onlyOne[o.productId], 'leave');
  const archivedB = filterOnlyOne(p, { location_id: B, archived: true });
  assert.deepEqual(archivedB.map((o) => o.name), ['Old special']);
  ch = setOnlyOneMany(ch, p, { archived: true }, 'extra').choices;
  assert.equal(ch.onlyOne[archivedB[0].productId], 'extra');
  assert.equal(filterOnlyOne(p, { search: 'pie' }).length, 1);
  ch = setOnlyOne(ch, archivedB[0].productId, 'leave');
  assert.equal(ch.onlyOne[archivedB[0].productId], 'leave');
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
  void nameOf;
});

test('counts for the headline and per site', () => {
  const p = propose();
  const ch = initialChoices(p);
  const n = reviewCounts(p, ch, [A, B, C]);
  assert.equal(n.family, p.review.family.length);
  assert.equal(n.name, p.review.name.length);
  assert.equal(n.nameTicked, 0);
  assert.equal(n.onlyOne.extra + n.onlyOne.leave, p.review.onlyOne.length);
  assert.equal(n.perSite[B].archived, 1);
  assert.equal(n.perSite[A].onlyOne, 0);
});

test('summary words: products, sites, extras, kept values and the proof (or what is left to settle)', () => {
  const central = { products: [{ id: 'a' }, { id: 'b', site_only_location_id: 'x' }], sites: [{}, {}], productSites: [{ kept: { cat: 'x' } }, { kept: {} }] };
  assert.equal(importSummaryWords(central, { ok: true }), '2 products at 2 sites, 1 of them site only extras. 1 site keeps some values of its own. Publishing now would change 0 things at 0 sites.');
  assert.match(importSummaryWords(central, { ok: false, writes: 3 }), /found 3 differences/);
});

test('the menus a site could be imported from: active ones, the default first, with their product counts', () => {
  const v = venues();
  const raw = { ...v[A], menus: [...v[A].menus, { id: 'menu-lunch', name: 'Lunch', is_default: false, is_active: true }, { id: 'menu-old', name: 'Old', is_active: false }] };
  const list = venueMenuChoices(raw);
  assert.deepEqual(list.map((m) => m.id), ['menu-a', 'menu-lunch']);
  assert.equal(list[0].isDefault, true);
  assert.ok(list[0].products > 0);
  assert.equal(list[1].products, 0);
  assert.deepEqual(venueMenuChoices(null), []);
});
