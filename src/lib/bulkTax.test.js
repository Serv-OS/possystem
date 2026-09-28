// bulkTax.test.js: the bulk tax apply saves every row or says exactly what did not save.
// 27 Sep 2026, Peter: "I have re applied Tax to all products but thats wrong please chase".
// Ported from the tax root cause patch (v3) onto the stale tab branch: the writes go through the
// branch's compare and set writer (lib/menuWriters.js over lib/menuRowWrite.js), not the patch's
// own guarded update, so the stale tab cases below run the REAL writers against fakeMenuDb.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planBulkTax, runBulkTax, bulkTaxWords, isSharedCopy, bulkTaxOutcome, bulkTaxSaver, taxRefreshed, saveCopyTaxRates,
} from './bulkTax.js';
import { toStoreRate } from './venueTaxRates.js';
import { createMenuWriters } from './menuWriters.js';
import { readVenueMenu, menuPatchFromRead } from './venueMenuRead.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

const LEEDS = 'leeds';
const std = toStoreRate({ id: 'leeds-std', name: 'Standard Rate', rate: 0.2, type: 'inclusive', is_default: true, location_id: LEEDS });
const red = toStoreRate({ id: 'leeds-red', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', location_id: LEEDS });
const tsStd = toStoreRate({ id: 'ts-std', name: 'Standard Rate', rate: 0.2, type: 'inclusive', is_default: true, location_id: 'ts' });
const rates = [std, red, tsStd];

const items = [
  { id: 'latte', name: 'Latte', taxRateId: null },                                   // local, no rate
  { id: 'latte-l', name: 'Large', parentId: 'latte', taxRateId: null },              // its size
  { id: 'tea', name: 'Tea', taxRateId: 'leeds-red' },                                // already has one of ours
  { id: 'tea-l', name: 'Large', parentId: 'tea', taxRateId: null },                  // size of a product with a rate
  { id: 'mocha', name: 'Mocha', taxRateId: 'ts-std' },                               // Train Station's id (the Leeds case)
  { id: 'flat_5c26956b', name: 'Flat white', masterId: 'flat', scope: 'shared', taxRateId: null },   // a shared COPY
  { id: 'cake_5c26956b', name: 'Cake', masterId: 'cake', scope: 'global', taxRateId: null },         // a copy whose master has no rate
  { id: 'own', name: 'Own shared', masterId: 'own', scope: 'shared', taxRateId: null },              // a master at this venue
  { id: 'gone', name: 'Old', archived: true, taxRateId: null },
];

test('a copy is a row whose master is another row', () => {
  assert.equal(isSharedCopy(items[5]), true);
  assert.equal(isSharedCopy(items[7]), false, 'master_id equal to its own id is the master');
  assert.equal(isSharedCopy(items[0]), false);
});

test('the plan: own products get the chosen rate, sizes follow their product, copies follow their master', () => {
  const copyRates = new Map([
    ['flat_5c26956b', { taxRateId: 'leeds-red', reason: null, ownerName: 'Train Station' }],
    ['cake_5c26956b', { taxRateId: null, reason: 'master-has-no-rate', ownerName: 'Train Station' }],
  ]);
  const { assign, skipped, targets } = planBulkTax({ items, rates, locationId: LEEDS, chosenRateId: 'leeds-std', copyRates });
  const by = Object.fromEntries(assign.map((a) => [a.id, [a.taxRateId, a.via]]));
  assert.deepEqual(by.latte, ['leeds-std', 'chosen']);
  assert.deepEqual(by['latte-l'], ['leeds-std', 'product'], 'a size takes the rate its product is given');
  assert.deepEqual(by['tea-l'], ['leeds-red', 'product'], 'a size of a product that already has a rate takes THAT rate, never a different one');
  assert.deepEqual(by.mocha, ['leeds-std', 'chosen'], 'a product holding another venue\'s rate id is fixed too');
  assert.deepEqual(by.flat_5c26956b, ['leeds-red', 'master'], 'a copy takes its master\'s rate, mapped to this venue');
  assert.deepEqual(by.own, ['leeds-std', 'chosen'], 'a master at this venue is this venue\'s to set');
  assert.equal(by.tea, undefined, 'a product that already has one of ours is untouched');
  assert.equal(by.gone, undefined, 'archived products are not touched');
  assert.deepEqual(skipped.map((s) => [s.item.id, s.reason, s.ownerName]), [['cake_5c26956b', 'master-has-no-rate', 'Train Station']]);
  assert.equal(targets.length, 7);
});

test('a product with no rate whose sizes all carry one of ours takes THAT rate, never the picked one', () => {
  const list = [
    { id: 'milk', name: 'Milk', taxRateId: null },
    { id: 'milk-s', name: 'Small', parentId: 'milk', taxRateId: 'leeds-red' },
    { id: 'milk-l', name: 'Large', parentId: 'milk', taxRateId: 'leeds-red' },
    { id: 'soup', name: 'Soup', taxRateId: null },
    { id: 'soup-s', name: 'Small', parentId: 'soup', taxRateId: 'leeds-red' },
    { id: 'soup-l', name: 'Large', parentId: 'soup', taxRateId: 'leeds-std' },   // sizes disagree: no inference
    { id: 'cake', name: 'Cake', taxRateId: null },
    { id: 'cake-s', name: 'Slice', parentId: 'cake', taxRateId: 'ts-std' },       // another venue's rate is not ours
  ];
  const { assign } = planBulkTax({ items: list, rates, locationId: LEEDS, chosenRateId: 'leeds-std' });
  const by = Object.fromEntries(assign.map((a) => [a.id, [a.taxRateId, a.via]]));
  assert.deepEqual(by.milk, ['leeds-red', 'sizes'], 'the till charges the sizes, so the product agrees with them');
  assert.equal(by['milk-s'], undefined, 'sizes that already have one of ours are untouched');
  assert.deepEqual(by.soup, ['leeds-std', 'chosen']);
  assert.deepEqual(by.cake, ['leeds-std', 'chosen']);
  assert.deepEqual(by['cake-s'], ['leeds-std', 'product'], 'a size on a foreign rate follows its product');
});

test('only this venue\'s own rate can be chosen', () => {
  const r = planBulkTax({ items, rates, locationId: LEEDS, chosenRateId: 'ts-std' });
  assert.equal(r.assign.length, 0, 'Train Station\'s rate is refused at Leeds');
  assert.ok(r.skipped.length > 0);
  assert.equal(planBulkTax({ items, rates, locationId: LEEDS, chosenRateId: '' }).assign.length, 0);
});

test('a copy with no master answer is skipped, never given the chosen rate', () => {
  const { assign, skipped } = planBulkTax({ items, rates, locationId: LEEDS, chosenRateId: 'leeds-std', copyRates: new Map() });
  assert.ok(!assign.some((a) => a.id.endsWith('_5c26956b')));
  assert.deepEqual(skipped.map((s) => s.item.id).sort(), ['cake_5c26956b', 'flat_5c26956b']);
});

test('every save is awaited and counted, failures carry their reason', async () => {
  const assign = [{ id: 'a', taxRateId: 'x', item: { name: 'A' } }, { id: 'b', taxRateId: 'x', item: { name: 'B' } }, { id: 'c', taxRateId: 'x', item: { name: 'C' } }, { id: 'd', taxRateId: 'x', item: { name: 'D' } }];
  const progress = [];
  const result = await runBulkTax({
    assign, concurrency: 2,
    save: async (a) => {
      await new Promise((r) => setTimeout(r, 1));
      if (a.id === 'b') return { error: { message: 'Update matched 0 rows' } };
      if (a.id === 'c') throw new Error('Failed to fetch');
      return { error: null };
    },
    onProgress: (p) => progress.push(p.done),
  });
  assert.deepEqual(result.ok.map((a) => a.id).sort(), ['a', 'd']);
  assert.deepEqual(result.failed.map((f) => [f.id, f.error]).sort(), [['b', 'Update matched 0 rows'], ['c', 'Failed to fetch']]);
  assert.equal(result.total, 4);
  assert.equal(result.notTried, 0);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  const words = bulkTaxWords({ result, rateName: 'Standard Rate' });
  assert.match(words, /saved on 2 of 4 products/);
  assert.match(words, /2 NOT saved: .*B \(Update matched 0 rows\)/);
  assert.doesNotMatch(words, /saved on all/, 'never success words when a row did not save');
});

test('the words when everything saved, and for copies left to the owner', async () => {
  const result = await runBulkTax({ assign: [{ id: 'a' }, { id: 'b' }], save: async () => ({}) });
  assert.equal(bulkTaxWords({ result, rateName: 'Standard Rate' }), 'Standard Rate saved on all 2 products.');
  const withSkips = bulkTaxWords({ result, rateName: 'Standard Rate', skipped: [{ item: { name: 'Cake' }, ownerName: 'Train Station' }] });
  assert.match(withSkips, /1 shared product takes its tax from the master at Train Station: set it there/);
  assert.equal(bulkTaxWords({ result: { ok: [], failed: [], total: 0 } }), 'Nothing needed a tax rate.');
});

test('stopping leaves the rest untried and says so', async () => {
  let n = 0;
  const result = await runBulkTax({ assign: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], concurrency: 1, save: async () => { n += 1; return {}; }, shouldStop: () => n >= 1 });
  assert.equal(result.ok.length, 1);
  assert.equal(result.notTried, 2);
  assert.match(bulkTaxWords({ result }), /2 not tried/);
});

// ── The writes (27 Sep 2026): the compare and set writer, the tax column only ─────────────────
// One Back Office tab over fakeMenuDb, wired the way store/index.js wires menuWriters, with the
// save store.applyBulkTaxRates makes for each assignment (bulkTaxSaver).
const T0 = '2026-09-27T13:52:21.000+00:00';
const dbItem = (id, name, tax, over = {}) => ({
  id, location_id: LEEDS, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '',
  type: 'simple', cat: 'cat-hot', cats: [], parent_id: null, sort_order: 1, pricing: { base: 2 },
  allergens: [], tags: [], assigned_modifier_groups: [], assigned_instruction_groups: [],
  visibility: { pos: true, kiosk: true, online: true }, sold_alone: true, archived: false,
  centre_id: null, tax_rate_id: tax, tax_overrides: {}, tax_profile_id: null, image: null,
  scope: 'local', org_id: null, master_id: null, lock_pricing: false, locked_fields: [],
  updated_at: T0, ...over,
});
const venue = (items) => ({
  menus: [], menu_categories: [], modifier_groups: [], tax_profiles: [], tax_profile_lines: [],
  locations: [{ id: LEEDS, default_tax_profile_id: null }],
  tax_rates: [
    { id: 'leeds-std', location_id: LEEDS, name: 'Standard Rate', rate: 0.2, type: 'inclusive', applies_to: ['all'], is_default: true, active: true },
    { id: 'leeds-red', location_id: LEEDS, name: 'Reduced Rate', rate: 0.05, type: 'inclusive', applies_to: ['all'], is_default: false, active: true },
  ],
  menu_items: items,
});
const SLICE = { items: 'menuItems', categories: 'menuCategories', menus: 'menus' };
function tab(db) {
  const state = { menuItems: [], menuCategories: [], menus: [], modifierGroupDefs: [], taxRates: [] };
  const toasts = [];
  const writers = createMenuWriters({
    getClient: () => db,
    resolveLocation: async () => LEEDS,
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: (kind, id, fn) => { const k = SLICE[kind]; state[k] = state[k].map((r) => (r.id === id ? fn(r) : r)); },
    toast: (msg) => toasts.push(msg),
    wait: async () => {},
  });
  const saved = [];
  return {
    state, toasts, saved,
    async load() {
      const read = await readVenueMenu(db, LEEDS);
      assert.ok(read.ok, `read failed: ${read.failed}`);
      Object.assign(state, menuPatchFromRead(state, read, { locationId: LEEDS }));
    },
    // store.applyBulkTaxRates: bulkTaxSaver over menuWriters.items.edit (quiet, checked against
    // the plan's row: opened), the screen changing only for a row that saved.
    save: bulkTaxSaver({
      getRow: (id) => state.menuItems.find((i) => i.id === id),
      edit: (id, patch, prev, next, opened) => writers.items.edit(id, patch, prev, next, { quiet: true, opened }),
      onSaved: (a) => {
        saved.push(a.id);
        state.menuItems = state.menuItems.map((i) => (i.id === a.id ? { ...i, taxRateId: a.taxRateId, tax_rate_id: a.taxRateId } : i));
      },
    }),
  };
}
const writesOf = (db) => {
  const sent = [];
  db.hooks.beforeWrite = (table, op, q) => { if (table === 'menu_items' && op === 'update') sent.push(Object.keys(q.patch).sort()); };
  return sent;
};

test('a writer result in the words runBulkTax counts', () => {
  for (const o of ['applied', 'merged', 'already', 'noop']) assert.deepEqual(bulkTaxOutcome({ ok: true, outcome: o }), {}, o);
  assert.deepEqual(bulkTaxOutcome({ ok: false, outcome: 'conflict', fresh: { tax_rate_id: 'leeds-red' } }), { changedElsewhere: true, current: 'leeds-red' });
  assert.deepEqual(bulkTaxOutcome({ ok: false, outcome: 'conflict', fresh: { tax_rate_id: null } }), { changedElsewhere: true, current: null });
  assert.match(bulkTaxOutcome({ ok: false, outcome: 'gone', error: new Error('not at this venue any more') }).error.message, /not at this venue/);
  assert.match(bulkTaxOutcome({ ok: false, outcome: 'dropped' }).error.message, /not saved/);
  assert.match(bulkTaxOutcome({ ok: false, outcome: 'error', error: new Error('offline') }).error.message, /offline/);
  assert.ok(bulkTaxOutcome(null).error, 'no answer is never "saved"');
  assert.ok(bulkTaxOutcome({ ok: false, outcome: 'applied' }).error, 'an outcome that says ok false is not saved');
});

test('a fresh read that changed rates is counted for the words', () => {
  const before = [{ id: 'milk', taxRateId: null }, { id: 'latte', taxRateId: 'leeds-std' }, { id: 'gone', taxRateId: null }];
  const after = [{ id: 'milk', tax_rate_id: 'leeds-red' }, { id: 'latte', taxRateId: 'leeds-std' }, { id: 'new', taxRateId: 'x' }];
  assert.equal(taxRefreshed(before, after), 1);
  assert.equal(taxRefreshed(null, after), 0);
  assert.match(bulkTaxWords({ result: { ok: [], failed: [], changed: [], total: 0 }, refreshed: 1 }), /1 product had a different rate saved than this page showed/);
});

for (const trigger of [false, true]) {
  const when = trigger ? 'after the migration (database clock)' : 'before the migration (writer stamps)';

  test(`the apply writes ONLY the tax column, compare and set, and says "saved on all" only when all saved, ${when}`, async () => {
    const db = fakeMenuDb(venue([dbItem('latte', 'Latte', null), dbItem('latte-l', 'Large', null, { parent_id: 'latte' }), dbItem('tea', 'Tea', 'leeds-red')]), { trigger });
    const A = tab(db);
    await A.load();
    const sent = writesOf(db);
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    assert.deepEqual(plan.assign.map((a) => [a.id, a.via]), [['latte', 'chosen'], ['latte-l', 'product']]);
    const result = await runBulkTax({ assign: plan.assign, ownRateIds: plan.ownRateIds, save: A.save });
    assert.deepEqual(result.ok.map((a) => a.id), ['latte', 'latte-l'], 'the product first, then its size');
    assert.equal(db.row('menu_items', 'latte').tax_rate_id, 'leeds-std');
    assert.equal(db.row('menu_items', 'latte-l').tax_rate_id, 'leeds-std');
    assert.equal(db.row('menu_items', 'tea').tax_rate_id, 'leeds-red', 'a product with one of ours is untouched');
    for (const cols of sent) assert.deepEqual(cols, ['tax_rate_id', 'updated_at'], 'no stale name, price or archive rides along');
    assert.equal(db.log.filter((l) => l === 'menu_items.upsert').length, 0, 'never a whole row write');
    assert.equal(bulkTaxWords({ result, rateName: 'Standard Rate' }), 'Standard Rate saved on all 2 products.');
    assert.equal(A.state.menuItems.find((i) => i.id === 'latte').taxRateId, 'leeds-std', 'the screen shows what saved');
  });

  test(`STALE TAB: a rate set elsewhere is never replaced, its size follows it, the words name it, ${when}`, async () => {
    // This tab read the menu while Milk had no rate. Since then another tab set Milk to Leeds
    // Reduced 5% (its size still has none). The plan is made from the stale copy (the race between
    // the fresh read and the writes, or a read that saw an older row).
    const db = fakeMenuDb(venue([dbItem('milk', 'Milk', null), dbItem('milk-l', 'Large', null, { parent_id: 'milk' }), dbItem('latte', 'Latte', null)]), { trigger });
    const A = tab(db);
    await A.load();
    db.touch('menu_items', 'milk', { tax_rate_id: 'leeds-red' });
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    assert.deepEqual(plan.assign.map((a) => [a.id, a.taxRateId, a.expect, a.via]).sort(), [['latte', 'leeds-std', null, 'chosen'], ['milk', 'leeds-std', null, 'chosen'], ['milk-l', 'leeds-std', null, 'product']]);
    const result = await runBulkTax({ assign: plan.assign, ownRateIds: plan.ownRateIds, save: A.save });
    assert.equal(db.row('menu_items', 'milk').tax_rate_id, 'leeds-red', 'Reduced 5% is never turned into Standard 20%');
    assert.equal(db.row('menu_items', 'milk-l').tax_rate_id, 'leeds-red', 'the size follows the rate its product really has, never the picked one');
    assert.equal(db.row('menu_items', 'latte').tax_rate_id, 'leeds-std');
    assert.deepEqual(result.changed.map((c) => [c.id, c.current, c.why]), [['milk', 'leeds-red', 'changed']]);
    assert.deepEqual(result.ok.map((a) => a.id).sort(), ['latte', 'milk-l']);
    assert.equal(result.failed.length, 0);
    assert.equal(result.notTried, 0);
    assert.equal(A.state.menuItems.find((i) => i.id === 'milk').taxRateId, 'leeds-red', 'this tab now shows the database\'s rate');
    assert.deepEqual(A.toasts, [], 'quiet: one summary, not a toast per row');
    const words = bulkTaxWords({ result, rateName: 'Standard Rate', rates });
    assert.match(words, /saved on 2 of 3 products/);
    assert.match(words, /1 changed somewhere else since this page loaded, left as it is: Milk \(now Reduced Rate\)/);
    assert.doesNotMatch(words, /saved on all/);
  });

  test(`a product moved elsewhere to a rate that is not ours leaves its size, and a row already on the picked rate counts as saved, ${when}`, async () => {
    const db = fakeMenuDb(venue([dbItem('soup', 'Soup', null), dbItem('soup-l', 'Large', null, { parent_id: 'soup' }), dbItem('cake', 'Cake', null)]), { trigger });
    const A = tab(db);
    await A.load();
    db.touch('menu_items', 'soup', { tax_rate_id: 'ts-std' });
    db.touch('menu_items', 'cake', { tax_rate_id: 'leeds-std' });
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    const result = await runBulkTax({ assign: plan.assign, ownRateIds: plan.ownRateIds, save: A.save });
    assert.deepEqual(result.ok.map((a) => a.id), ['cake'], 'set elsewhere to the very rate picked: it has it');
    assert.deepEqual(result.changed.map((c) => [c.id, c.why]).sort(), [['soup', 'changed'], ['soup-l', 'product']]);
    assert.equal(db.row('menu_items', 'soup-l').tax_rate_id, null, 'never given a rate its product does not have');
    const words = bulkTaxWords({ result, rateName: 'Standard Rate', rates: [std, red] });
    assert.match(words, /Soup \(now a rate not of this venue\)/, 'the page names only this venue\'s own rates');
    assert.match(words, /Large \(its product was changed\)/);
  });

  test(`STALE PLAN: this page's row refreshed after the plan never lets a rate set elsewhere be replaced or counted as saved, ${when}`, async () => {
    // 27 Sep 2026: the plan is made; then another window sets Milk to Leeds Reduced 5% and THIS
    // page's copy of Milk is refreshed (a realtime update, or the reload on coming back to the
    // tab) while Apply to all runs. Its updated_at now matches the database, so a write checked
    // against this page's row went straight through: Reduced became Standard, counted as saved.
    // Checked against the row the plan saw (a.item), it is changed elsewhere and left.
    const db = fakeMenuDb(venue([dbItem('milk', 'Milk', null), dbItem('latte', 'Latte', null)]), { trigger });
    const A = tab(db);
    await A.load();
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    db.touch('menu_items', 'milk', { tax_rate_id: 'leeds-red' });
    await A.load();
    const shown = A.state.menuItems.find((i) => i.id === 'milk');
    assert.equal(shown.taxRateId, 'leeds-red', 'this page now holds the newer row');
    assert.equal(shown.srvAt, db.row('menu_items', 'milk').updated_at, 'with the database\'s token');
    const result = await runBulkTax({ assign: plan.assign, ownRateIds: plan.ownRateIds, save: A.save });
    assert.equal(db.row('menu_items', 'milk').tax_rate_id, 'leeds-red', 'Reduced 5% is never turned into Standard 20%');
    assert.deepEqual(result.changed.map((c) => [c.id, c.current, c.why]), [['milk', 'leeds-red', 'changed']]);
    assert.deepEqual(result.ok.map((a) => a.id), ['latte'], 'never counted as saved');
    assert.deepEqual(A.saved, ['latte']);
    assert.equal(db.row('menu_items', 'latte').tax_rate_id, 'leeds-std');
    assert.match(bulkTaxWords({ result, rateName: 'Standard Rate', rates }), /saved on 1 of 2 products\. 1 changed somewhere else since this page loaded, left as it is: Milk \(now Reduced Rate\)/);
  });

  test(`a write the database refuses (row level security) is NOT saved, never "changed elsewhere", ${when}`, async () => {
    const db = fakeMenuDb(venue([dbItem('latte', 'Latte', null)]), { trigger });
    const A = tab(db);
    await A.load();
    db.hooks.refuse = (table, op) => table === 'menu_items' && op === 'update';
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    const result = await runBulkTax({ assign: plan.assign, save: A.save });
    assert.equal(result.ok.length, 0);
    assert.equal(result.changed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /row level security/);
    assert.equal(A.state.menuItems.find((i) => i.id === 'latte').taxRateId, null, 'the screen never shows a rate the database does not have');
    assert.match(bulkTaxWords({ result, rateName: 'Standard Rate' }), /saved on 0 of 1 products\. 1 NOT saved: Latte/);
  });

  test(`a product no longer on this screen, or deleted elsewhere, is NOT saved, ${when}`, async () => {
    const db = fakeMenuDb(venue([dbItem('latte', 'Latte', null), dbItem('mocha', 'Mocha', null)]), { trigger });
    const A = tab(db);
    await A.load();
    db.rows('menu_items').splice(db.rows('menu_items').findIndex((r) => r.id === 'mocha'), 1);
    const plan = planBulkTax({ items: A.state.menuItems, rates: A.state.taxRates, locationId: LEEDS, chosenRateId: 'leeds-std' });
    const result = await runBulkTax({ assign: [...plan.assign, { id: 'ghost', taxRateId: 'leeds-std', via: 'chosen', expect: null, item: { name: 'Ghost' } }], save: A.save });
    assert.deepEqual(result.ok.map((a) => a.id), ['latte']);
    assert.deepEqual(result.failed.map((f) => f.id).sort(), ['ghost', 'mocha']);
    assert.match(result.failed.find((f) => f.id === 'ghost').error, /not on this screen/);
  });
}

// ── Shared copies take their master's rate when the venue gains rates (lib/db.js
//    mapCopiesTaxFromMasters, through saveCopyTaxRates) ───────────────────────────────────────
test('copies are mapped through the compare and set writer, the tax column only; a rate set meanwhile is left', async () => {
  const copy = (id, name, tax, over = {}) => dbItem(id, name, tax, { master_id: id.split('_')[0], scope: 'shared', ...over });
  const db = fakeMenuDb(venue([
    copy('flat_5c26956b', 'Flat white', null),
    copy('mocha_5c26956b', 'Mocha', 'ts-std'),          // Train Station's id (the Leeds bulk apply)
    copy('cake_5c26956b', 'Cake', null),                // its master has no rate
    copy('scone_5c26956b', 'Scone', null),              // given a rate by hand meanwhile
  ]), { trigger: true });
  const copies = (await db.from('menu_items').select('*').eq('location_id', LEEDS)).data;
  db.touch('menu_items', 'scone_5c26956b', { tax_rate_id: 'leeds-red' });
  const sent = writesOf(db);
  const answers = new Map([
    ['flat_5c26956b', { taxRateId: 'leeds-red', reason: null, ownerName: 'Train Station' }],
    ['mocha_5c26956b', { taxRateId: 'leeds-std', reason: null, ownerName: 'Train Station' }],
    ['cake_5c26956b', { taxRateId: null, reason: 'the master has no tax rate', ownerName: 'Train Station' }],
    ['scone_5c26956b', { taxRateId: 'leeds-std', reason: null, ownerName: 'Train Station' }],
  ]);
  const r = await saveCopyTaxRates({ client: db, locationId: LEEDS, copies, answers });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapped.map((m) => [m.id, m.taxRateId]).sort(), [['flat_5c26956b', 'leeds-red'], ['mocha_5c26956b', 'leeds-std']]);
  assert.deepEqual(r.unmapped.map((u) => [u.id, u.reason]), [['cake_5c26956b', 'the master has no tax rate']]);
  assert.deepEqual(r.changed.map((c) => [c.id, c.current]), [['scone_5c26956b', 'leeds-red']]);
  assert.equal(db.row('menu_items', 'scone_5c26956b').tax_rate_id, 'leeds-red', 'a rate set meanwhile is never replaced');
  assert.equal(db.row('menu_items', 'mocha_5c26956b').tax_rate_id, 'leeds-std', 'another venue\'s id is replaced by the master\'s rate here');
  assert.equal(db.row('menu_items', 'cake_5c26956b').tax_rate_id, null);
  for (const cols of sent) assert.deepEqual(cols, ['tax_rate_id', 'updated_at']);
  assert.equal(db.log.filter((l) => l === 'menu_items.upsert').length, 0);
});

test('a copy write that fails is reported, never counted as mapped', async () => {
  const db = fakeMenuDb(venue([dbItem('flat_5c26956b', 'Flat white', null, { master_id: 'flat', scope: 'shared' })]));
  db.hooks.refuse = () => true;
  const copies = (await db.from('menu_items').select('*').eq('location_id', LEEDS)).data;
  const r = await saveCopyTaxRates({ client: db, locationId: LEEDS, copies, answers: new Map([['flat_5c26956b', { taxRateId: 'leeds-red' }]]) });
  assert.equal(r.ok, false);
  assert.equal(r.mapped.length, 0);
  assert.deepEqual(r.failed.map((f) => f.id), ['flat_5c26956b']);
  assert.equal(db.row('menu_items', 'flat_5c26956b').tax_rate_id, null);
});

test('a stop before the sizes leaves them untried, and a failed product still lets its size be tried', async () => {
  const assign = [
    { id: 'p', taxRateId: 'leeds-std', via: 'chosen', expect: null, item: { name: 'P' } },
    { id: 'p-l', taxRateId: 'leeds-std', via: 'product', parentId: 'p', expect: null, item: { name: 'Large' } },
  ];
  let calls = 0;
  const stopped = await runBulkTax({ assign, concurrency: 1, save: async () => { calls += 1; return {}; }, shouldStop: () => calls >= 1 });
  assert.equal(stopped.ok.length, 1);
  assert.equal(stopped.notTried, 1);
  const tried = [];
  const failedParent = await runBulkTax({ assign, save: async (a) => { tried.push(a.id); return a.id === 'p' ? { error: { message: 'offline' } } : {}; } });
  assert.deepEqual(tried, ['p', 'p-l']);
  assert.equal(failedParent.failed.length, 1);
  assert.equal(failedParent.ok.length, 1);
});
