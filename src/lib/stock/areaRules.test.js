/** areaRules.test.js: stock areas (16 Oct 2026). The pure rules, and the pins on the wiring. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AREA_KINDS, USUAL_SIX, COUNT_TYPES, RECEIVING_HELP, COLLAPSE_OVER, RENDER_STEP, INSERT_CHUNK, POST_IN_FLIGHT,
  normaliseAreaName, kindFromName, kindLabel, legacyAreaFor, legacyAreasFromItems,
  areaHoldings, holdingsInvariant, areasBelowZero, holdingOf, strandedHoldings,
  transferPlan, matchTransferLines, canReceive,
  resolveCountScope, defaultAreaFor, groupLinesByArea, areaSubtotal, rollUpLinesPerItem, adjustmentKey,
  approvalGate, otherAreaWarnings, countNameFor, countStatusText,
  filterItems, filterLines, categoriesOf, chunkArray, visibleRows, postingText, bulkAssignText, archiveRefusal, transferReference,
  stockByAreaRows,
} from './areaRules.js';
import { countApprovalPlan } from './countRules.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const sqlCode = (src) => src.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');
const noDashes = (text, what) => assert.doesNotMatch(text, /[–—]/, `${what}: no long dashes`);

const CELLAR = 'a-cellar', FRIDGE = 'a-fridge', FREEZER = 'a-freezer', DRY = 'a-dry', BAR = 'a-bar';
const areas = [
  { id: CELLAR, name: 'Cellar', kind: 'cellar', sortOrder: 10, isReceiving: true },
  { id: FRIDGE, name: 'Walk in fridge', kind: 'walk_in', sortOrder: 20 },
  { id: FREEZER, name: 'Freezer', kind: 'freezer', sortOrder: 30 },
  { id: DRY, name: 'Dry store', kind: 'dry_store', sortOrder: 40 },
  { id: BAR, name: 'Bar', kind: 'bar', sortOrder: 50, archivedAt: '2026-10-01' },
];

// ── 9. legacy mapping ─────────────────────────────────────────────────────────

test('normaliseAreaName: "Walk-in fridge" equals "Walk in fridge"; "Main Fridge " is its own area', () => {
  assert.equal(normaliseAreaName('Walk-in fridge'), 'walk in fridge');
  assert.equal(normaliseAreaName('Walk in fridge'), 'walk in fridge');
  assert.equal(normaliseAreaName('  walk_in   FRIDGE '), 'walk in fridge');
  assert.equal(normaliseAreaName('Main Fridge '), 'main fridge');
  assert.equal(normaliseAreaName('The Cellar'), 'cellar');
  assert.equal(normaliseAreaName('Theatre'), 'theatre', 'only a whole word "the"');
  assert.equal(normaliseAreaName(null), '');
  assert.equal(normaliseAreaName(''), '');
  assert.notEqual(normaliseAreaName('Fridge'), normaliseAreaName('Main Fridge'));
});

test('kindFromName: the words decide, freezer before walk in, Back bar is bar', () => {
  assert.equal(kindFromName('Freezer'), 'freezer');
  assert.equal(kindFromName('Walk in freezer'), 'freezer');
  assert.equal(kindFromName('Walk-in fridge'), 'walk_in');
  assert.equal(kindFromName('Main Fridge '), 'fridge');
  assert.equal(kindFromName('Chiller 2'), 'fridge');
  assert.equal(kindFromName('Cellar'), 'cellar');
  assert.equal(kindFromName('Dry store'), 'dry_store');
  assert.equal(kindFromName('Pantry'), 'dry_store');
  assert.equal(kindFromName('Back bar'), 'bar');
  assert.equal(kindFromName('Kitchen'), 'kitchen');
  assert.equal(kindFromName('Prep room'), 'kitchen');
  assert.equal(kindFromName('Office'), 'other');
  assert.equal(kindFromName(''), 'other');
  for (const k of AREA_KINDS) assert.equal(kindLabel(k.id), k.label);
  assert.equal(kindLabel('nope'), 'Other');
  assert.deepEqual(USUAL_SIX.map((s) => s.name), ['Cellar', 'Walk in fridge', 'Freezer', 'Dry store', 'Bar', 'Kitchen']);
  for (const s of USUAL_SIX) assert.equal(kindFromName(s.name), s.kind, s.name);
  assert.deepEqual(COUNT_TYPES.map((t) => t.id), ['FULL', 'AREA', 'SUPPLIER', 'SPOT']);
  noDashes(RECEIVING_HELP, 'receiving help');
  for (const t of COUNT_TYPES) noDashes(t.desc, t.id);
});

test('legacyAreasFromItems: the Provo and Location 2 texts map to 7 and 6 areas, first spelling kept', () => {
  const t = (name, storageLocation, createdAt, archivedAt = null) => ({ id: name, name, storageLocation, createdAt, archivedAt });
  const provo = [
    ...Array.from({ length: 20 }, (_, i) => t(`dry${i}`, 'Dry store', `2026-01-${String(i + 1).padStart(2, '0')}`)),
    ...Array.from({ length: 13 }, (_, i) => t(`wif${i}`, 'Walk-in fridge', `2026-02-${String(i + 1).padStart(2, '0')}`)),
    ...Array.from({ length: 5 }, (_, i) => t(`fr${i}`, 'Fridge', `2026-03-0${i + 1}`)),
    t('syr1', 'Back bar', '2026-04-01'), t('syr2', 'Back bar', '2026-04-02'), t('syr3', 'Back bar', '2026-04-03'),
    t('patty', 'Main Fridge ', '2026-05-01'), t('water', 'Cellar', '2026-05-02'), t('croissant', 'Freezer', '2026-05-03'),
    t('old', 'Fridge 14', '2025-01-01', '2026-01-01'), t('oldkeg', 'Cellar', '2025-01-02', '2026-01-01'), t('none', null, '2026-06-01'),
  ];
  const got = legacyAreasFromItems(provo);
  assert.equal(got.length, 7);
  assert.deepEqual(got.map((a) => a.name).sort(), ['Back bar', 'Cellar', 'Dry store', 'Freezer', 'Fridge', 'Main Fridge', 'Walk-in fridge']);
  assert.equal(got.find((a) => a.name === 'Main Fridge').kind, 'fridge', 'trimmed, its own area, a fridge');
  assert.equal(got.find((a) => a.name === 'Back bar').kind, 'bar');
  assert.equal(got.find((a) => a.name === 'Walk-in fridge').kind, 'walk_in');
  assert.ok(!got.some((a) => a.name === 'Fridge 14'), 'an archived item makes no area');
  const loc2 = [t('a', 'Dry store', '2026-01-01'), t('b', 'Walk-in fridge', '2026-01-02'), t('c', 'Fridge', '2026-01-03'),
    t('d', 'Back bar', '2026-01-04'), t('e', 'Freezer', '2026-01-05'), t('f', 'Cellar', '2026-01-06')];
  assert.equal(legacyAreasFromItems(loc2).length, 6);
  // first spelling seen wins
  const spell = legacyAreasFromItems([t('x', 'walk in fridge', '2026-01-02'), t('y', 'Walk-in fridge', '2026-01-01')]);
  assert.deepEqual(spell, [{ name: 'Walk-in fridge', kind: 'walk_in' }]);
  assert.deepEqual(legacyAreasFromItems([]), []);
  assert.deepEqual(legacyAreasFromItems(null), []);
});

test('legacyAreaFor: a text finds its live area or nothing', () => {
  assert.equal(legacyAreaFor('walk-in fridge', areas).id, FRIDGE);
  assert.equal(legacyAreaFor('WALK IN FRIDGE ', areas).id, FRIDGE);
  assert.equal(legacyAreaFor('Bar', areas), null, 'archived areas never match');
  assert.equal(legacyAreaFor('Main Fridge', areas), null);
  assert.equal(legacyAreaFor('', areas), null);
  assert.equal(legacyAreaFor('Cellar', null), null);
});

// ── 1. holdings and the invariant ─────────────────────────────────────────────

test('areaHoldings rolls movements per item and area; holdingsInvariant finds nothing when on hand agrees', () => {
  const moves = [
    { inventoryItemId: 'milk', areaId: CELLAR, qtyBase: 24 }, { inventoryItemId: 'milk', areaId: CELLAR, qtyBase: -12 },
    { inventoryItemId: 'milk', areaId: FRIDGE, qtyBase: 12 }, { inventoryItemId: 'milk', areaId: FRIDGE, qtyBase: -6.5 },
    { inventoryItemId: 'flour', areaId: null, qtyBase: 50 }, { inventoryItemId: 'flour', areaId: DRY, qtyBase: -3 },
    null, { inventoryItemId: null, qtyBase: 9 },
  ];
  const h = areaHoldings(moves);
  assert.deepEqual(h.milk, { areas: { [CELLAR]: 12, [FRIDGE]: 5.5 }, unassigned: 0, total: 17.5 });
  assert.deepEqual(h.flour, { areas: { [DRY]: -3 }, unassigned: 50, total: 47 });
  assert.deepEqual(holdingsInvariant([{ id: 'milk', name: 'Milk', onHand: 17.5 }, { id: 'flour', name: 'Flour', onHand: 47 }, { id: 'none', name: 'None', onHand: 0 }], h), []);
  const bad = holdingsInvariant([{ id: 'milk', name: 'Milk', onHand: 18 }], h);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].sum, 17.5);
  assert.deepEqual(areaHoldings([]), {});
  // the simple map the screens use
  const simple = { milk: { [CELLAR]: 12, [FRIDGE]: -6 }, flour: { [DRY]: 3 } };
  assert.deepEqual(areasBelowZero(simple), [{ itemId: 'milk', areaId: FRIDGE, qty: -6 }]);
  assert.equal(holdingOf(simple, 'milk', CELLAR), 12);
  assert.equal(holdingOf(simple, 'milk', DRY), 0);
  assert.equal(holdingOf(null, 'milk', DRY), 0);
});

test('strandedHoldings (16 Oct review): an item WITH a use area whose on hand is not the sum of its areas is flagged; no area or archived is not', () => {
  // flour: on hand 7, all of it posted before it had an area (no area holding), then given DRY: a ghost of 7
  // milk: 17 across two areas, on hand 17: fine. cups: no area yet, 500 in no area: not this list (Unassigned line on a count)
  const items = [
    { id: 'flour', name: 'Flour', onHand: 7, areaId: DRY }, { id: 'milk', name: 'Milk', onHand: 17, areaId: FRIDGE },
    { id: 'cups', name: 'Cups', onHand: 500, areaId: null }, { id: 'old', name: 'Old', onHand: 3, areaId: DRY, archivedAt: '2026-01-01' },
    { id: 'peas', name: 'Peas', onHand: 4, areaId: FREEZER },
  ];
  const simple = { milk: { [CELLAR]: 12, [FRIDGE]: 5 }, peas: { [FREEZER]: 4 } };
  assert.deepEqual(strandedHoldings(items, simple), [{ itemId: 'flour', name: 'Flour', areaId: DRY, qty: 7 }]);
  assert.deepEqual(strandedHoldings(items, { ...simple, flour: { [DRY]: 7 } }), [], 'once the database re homed it, nothing is stranded');
  assert.deepEqual(strandedHoldings([], {}), []);
  assert.deepEqual(strandedHoldings(null, null), []);
});

// ── 2 and 3. transfers ───────────────────────────────────────────────────────

test('transferPlan: OUT and IN pairs, same key family, opposite sign, item total unchanged', () => {
  const plan = transferPlan([{ id: 'l1', itemId: 'milk', qtyBase: 12 }, { id: 'l2', itemId: 'beer', qtyBase: 0 }, { id: 'l3', itemId: 'flour', qtyBase: 2.5 }], CELLAR, FRIDGE, { milk: 1.2, flour: 0.8 }, 'T1');
  assert.equal(plan.movements.length, 4);
  const [out, inn] = plan.movements;
  assert.deepEqual(out, { itemId: 'milk', areaId: CELLAR, qtyBase: -12, movementType: 'TRANSFER_OUT', unitCost: 1.2, idempotencyKey: 'transfer:T1:l1:out' });
  assert.deepEqual(inn, { itemId: 'milk', areaId: FRIDGE, qtyBase: 12, movementType: 'TRANSFER_IN', unitCost: 1.2, idempotencyKey: 'transfer:T1:l1:in' });
  assert.deepEqual(plan.netByItem, { milk: 0, flour: 0 });
  assert.equal(plan.movements.some((m) => m.itemId === 'beer'), false, 'a zero line posts nothing');
});

test('matchTransferLines: SKU first, then name, never archived; canReceive needs every line matched or dropped', () => {
  const receiver = [
    { id: 'r-milk', name: 'Whole Milk 2L', sku: 'MILK2' }, { id: 'r-flour', name: 'Plain Flour 16kg', sku: null },
    { id: 'r-old', name: 'Oat Milk 1L', sku: 'OAT', archivedAt: '2026-01-01' }, { id: 'r-eggs', name: 'Free Range Eggs', sku: 'milk2' },
  ];
  const lines = [
    { id: 'l1', skuSnapshot: ' milk2 ', nameSnapshot: 'Whole milk 2l' },
    { id: 'l2', skuSnapshot: 'XX', nameSnapshot: 'plain  flour 16kg' },
    { id: 'l3', skuSnapshot: 'OAT', nameSnapshot: 'Oat Milk 1L' },
    { id: 'l4', skuSnapshot: null, nameSnapshot: 'Nothing like it', dropped: true },
    { id: 'l5', skuSnapshot: null, nameSnapshot: 'Also nothing' },
    { id: 'l6', skuSnapshot: 'ZZ', nameSnapshot: 'zz', toInventoryItemId: 'r-flour' },
  ];
  const { lines: got, unmatched } = matchTransferLines(lines, receiver);
  assert.equal(got[0].toInventoryItemId, 'r-milk'); assert.equal(got[0].matchedBy, 'sku', 'the first item with that SKU');
  assert.equal(got[1].toInventoryItemId, 'r-flour'); assert.equal(got[1].matchedBy, 'name');
  assert.equal(got[2].toInventoryItemId, null, 'archived items never match');
  assert.equal(got[3].dropped, true);
  assert.equal(got[5].matchedBy, 'kept', 'a match made by hand stays');
  assert.deepEqual(unmatched, ['l3', 'l5']);
  assert.equal(canReceive(got), false);
  got[2].toInventoryItemId = 'r-milk'; got[4].dropped = true;
  assert.equal(canReceive(got), true);
  assert.equal(canReceive([]), false);
});

// ── 5. scope ─────────────────────────────────────────────────────────────────

const items = [
  { id: 'milk', name: 'Milk', onHand: 17, currentCost: 1.2 },
  { id: 'flour', name: 'Flour', onHand: 50, currentCost: 0.8 },
  { id: 'peas', name: 'Peas', onHand: 4, currentCost: 2 },
  { id: 'gin', name: 'Gin', onHand: 3, currentCost: 15, isTracked: false },
  { id: 'old', name: 'Old', onHand: 1, currentCost: 1, archivedAt: '2026-01-01' },
  { id: 'cups', name: 'Cups', onHand: 500, currentCost: 0.05 },
];
const itemAreas = { milk: FRIDGE, flour: DRY, peas: FREEZER, gin: BAR, cups: null };
const holdings = { milk: { [CELLAR]: 12, [FRIDGE]: 5 }, flour: { [DRY]: 50 }, peas: { [FREEZER]: 4 } };
const supplierProducts = [{ inventoryItemId: 'milk', supplierId: 's-dairy' }, { inventoryItemId: 'flour', supplierId: 's-bake' }, { inventoryItemId: 'old', supplierId: 's-dairy' }];
const ctx = { items, itemAreas, holdings, supplierProducts, areas };

test('resolveCountScope FULL: every live tracked item, one line per area it sits in, Unassigned for none, expected is the area holding', () => {
  const r = resolveCountScope({ type: 'FULL' }, ctx);
  assert.deepEqual(r.lines.map((l) => [l.itemId, l.areaId, l.expectedQty]), [
    ['milk', CELLAR, 12], ['milk', FRIDGE, 5], ['peas', FREEZER, 4], ['flour', DRY, 50], ['cups', null, 500],
  ], 'area sort order, then item name; Unassigned last; the archived item and the untracked item are out');
  assert.deepEqual(r.lines.map((l) => l.sortOrder), [0, 1, 2, 3, 4]);
  assert.deepEqual(r.areaIds, [CELLAR, FRIDGE, FREEZER, DRY]);
  assert.deepEqual(r.itemIds, ['milk', 'peas', 'flour', 'cups']);
  assert.equal(r.lines[0].unitCost, 1.2);
});

test('resolveCountScope AREA: assigned items plus items with a holding there, only the ticked areas', () => {
  const r = resolveCountScope({ type: 'AREA', areaIds: [CELLAR] }, ctx);
  assert.deepEqual(r.lines.map((l) => [l.itemId, l.areaId, l.expectedQty]), [['milk', CELLAR, 12]], 'milk lives in the fridge but 12 sit in the Cellar');
  const two = resolveCountScope({ type: 'AREA', areaIds: [FRIDGE, DRY, BAR] }, ctx);
  assert.deepEqual(two.lines.map((l) => [l.itemId, l.areaId]), [['milk', FRIDGE], ['flour', DRY]], 'an archived area is ignored');
  assert.deepEqual(resolveCountScope({ type: 'AREA', areaIds: [] }, ctx).lines, []);
});

test('resolveCountScope SUPPLIER and SPOT and PARTIAL', () => {
  const sup = resolveCountScope({ type: 'SUPPLIER', supplierId: 's-dairy' }, ctx);
  assert.deepEqual(sup.lines.map((l) => [l.itemId, l.areaId]), [['milk', CELLAR], ['milk', FRIDGE]], 'exactly the supplier items, in every area they sit in');
  const spot = resolveCountScope({ type: 'SPOT', itemIds: ['cups', 'peas', 'gin'] }, ctx);
  assert.deepEqual(spot.lines.map((l) => [l.itemId, l.areaId]), [['peas', FREEZER], ['cups', null]], 'an untracked item is not counted');
  const partial = resolveCountScope({ type: 'PARTIAL', itemIds: ['gin'] }, ctx);
  assert.deepEqual(partial.lines.map((l) => [l.itemId, l.areaId, l.expectedQty]), [['gin', null, 3]], 'PARTIAL keeps every live item (the 15 Oct behaviour) and the Bar is archived');
  // no areas at all: one Unassigned line per item, expected = on hand
  const bare = resolveCountScope({ type: 'FULL' }, { items, itemAreas: {}, holdings: {}, areas: [] });
  assert.ok(bare.lines.every((l) => l.areaId === null));
  assert.deepEqual(bare.areaIds, []);
  assert.equal(bare.lines.find((l) => l.itemId === 'milk').expectedQty, 17);
});

test('defaultAreaFor: a delivery lands in the receiving area, everything else in the use area', () => {
  assert.equal(defaultAreaFor('PURCHASE_RECEIPT', 'milk', { itemAreas, receivingAreaId: CELLAR }), CELLAR);
  assert.equal(defaultAreaFor('PURCHASE_RECEIPT', 'milk', { itemAreas, receivingAreaId: null }), FRIDGE);
  assert.equal(defaultAreaFor('SALE_DEPLETION', 'milk', { itemAreas, receivingAreaId: CELLAR }), FRIDGE);
  assert.equal(defaultAreaFor('WASTE', 'cups', { itemAreas, receivingAreaId: CELLAR }), null);
});

// ── 4. the sheet ──────────────────────────────────────────────────────────────

const sheet = [
  { id: 'L1', inventoryItemId: 'milk', areaId: CELLAR, expectedQty: 12, countedQty: 0, unitCost: 1.2 },
  { id: 'L2', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 12, unitCost: 1.2 },
  { id: 'L3', inventoryItemId: 'flour', areaId: DRY, expectedQty: 50, countedQty: 48, unitCost: 0.8 },
  { id: 'L4', inventoryItemId: 'peas', areaId: FREEZER, expectedQty: 4, countedQty: null, unitCost: 2 },
  { id: 'L5', inventoryItemId: 'cups', areaId: null, expectedQty: 500, countedQty: null, unitCost: 0.05 },
  { id: 'L6', inventoryItemId: 'gone', areaId: 'a-deleted', expectedQty: 1, countedQty: null, unitCost: 1 },
];

test('groupLinesByArea: area order, Unassigned last, an unknown area counts as Unassigned', () => {
  const g = groupLinesByArea(sheet, areas);
  assert.deepEqual(g.map((x) => [x.name, x.lines.map((l) => l.id)]), [
    ['Cellar', ['L1']], ['Walk in fridge', ['L2']], ['Freezer', ['L4']], ['Dry store', ['L3']], ['Unassigned', ['L5', 'L6']],
  ]);
  assert.equal(g[4].areaId, null);
  assert.deepEqual(groupLinesByArea(sheet.slice(4, 5), []).map((x) => x.name), ['Unassigned'], 'a venue with no areas: one group');
  assert.deepEqual(groupLinesByArea([], areas), []);
});

test('areaSubtotal and rollUpLinesPerItem: counted of total, variance value, "moved between areas"', () => {
  assert.deepEqual(areaSubtotal(sheet.slice(0, 3)), { counted: 3, total: 3, varianceValue: -12 * 1.2 + 12 * 1.2 - 2 * 0.8 });
  assert.deepEqual(areaSubtotal([sheet[3], sheet[4]]), { counted: 0, total: 2, varianceValue: 0 });
  // the screen's typed figures win over the saved ones
  const typed = { L4: 3 };
  assert.deepEqual(areaSubtotal([sheet[3]], (l) => typed[l.id] ?? l.countedQty), { counted: 1, total: 1, varianceValue: -2 });
  const roll = rollUpLinesPerItem(sheet);
  assert.equal(roll.milk.counted, 12); assert.equal(roll.milk.expected, 12);
  assert.equal(roll.milk.movedBetweenAreas, true, 'Cellar 0 and fridge 12 against Cellar 12 and fridge 0: a transfer nobody wrote down');
  assert.equal(roll.milk.allCounted, true);
  assert.equal(roll.flour.movedBetweenAreas, false, 'one area cannot be a move');
  assert.equal(roll.peas.allCounted, false); assert.equal(roll.peas.anyCounted, false);
  assert.deepEqual(roll.milk.pieces.map((p) => [p.areaId, p.counted, p.expected]), [[CELLAR, 0, 12], [FRIDGE, 12, 0]]);
});

test('adjustmentKey: one shape per count, item and area; the old shape for a line with no area', () => {
  assert.equal(adjustmentKey('C1', 'milk', FRIDGE), 'count:C1:milk:a-fridge');
  assert.equal(adjustmentKey('C1', 'milk', null), 'count:C1:milk');
  assert.equal(adjustmentKey('C1', 'milk'), 'count:C1:milk');
});

// ── 7. the plan with areas ───────────────────────────────────────────────────

test('countApprovalPlan with areas: delta per (item, area) against that area; area null against on hand; the pair nets to zero', () => {
  const rows = [
    { id: 'L1', inventory_item_id: 'milk', area_id: CELLAR, expected_qty: 12, counted_qty: 0 },
    { id: 'L2', inventory_item_id: 'milk', area_id: FRIDGE, expected_qty: 0, counted_qty: 12 },
    { id: 'L3', inventory_item_id: 'cups', area_id: null, expected_qty: 500, counted_qty: 490 },
    { id: 'L4', inventory_item_id: 'flour', area_id: DRY, expected_qty: 50, counted_qty: 47 },
  ];
  // since the count started: 2 l of milk sold from the fridge (fridge now -2), 1 kg flour used (49)
  const areaOnHand = { [`milk:${CELLAR}`]: 12, [`milk:${FRIDGE}`]: -2, [`flour:${DRY}`]: 49 };
  const plan = countApprovalPlan(rows, { milk: 10, cups: 500, flour: 49 }, { milk: 1.2, cups: 0.05, flour: 0.8 }, areaOnHand);
  assert.deepEqual(plan.adjustments.map((a) => [a.itemId, a.areaId, a.delta, a.varQty]), [
    ['milk', CELLAR, -12, -12], ['milk', FRIDGE, 14, 12], ['cups', null, -10, -10], ['flour', DRY, -2, -3],
  ]);
  assert.equal(plan.adjustments[0].delta + plan.adjustments[1].delta, 2, 'milk total moves by the 2 sold since the start, not by the move between areas');
  assert.ok(Math.abs(plan.varianceValue - (-12 * 1.2 + 12 * 1.2 - 10 * 0.05 - 3 * 0.8)) < 1e-9, 'variance value nets the move to 0');
  // the old call (no area map): every line against the item's on hand, as before 16 Oct
  const old = countApprovalPlan(rows.slice(2, 3), { cups: 500 }, { cups: 0.05 });
  assert.deepEqual(old.adjustments.map((a) => [a.areaId, a.delta]), [[null, -10]]);
  const legacyLines = countApprovalPlan([{ id: 'x', inventory_item_id: 'milk', area_id: FRIDGE, counted_qty: 5, expected_qty: 5 }], { milk: 7 }, {}, null);
  assert.equal(legacyLines.adjustments[0].delta, -2, 'no area map handed in: against on hand');
});

// ── 6. the gate ───────────────────────────────────────────────────────────────

test('approvalGate: ok only when all complete or confirmed; names the incomplete areas; no long dashes', () => {
  const rows = [{ areaId: CELLAR, name: 'Cellar', status: 'complete' }, { areaId: FREEZER, name: 'Freezer', status: 'open' }, { areaId: BAR, name: 'Bar', status: 'open' }];
  const g = approvalGate(rows);
  assert.equal(g.ok, false);
  assert.deepEqual(g.incomplete, ['Freezer', 'Bar']);
  assert.equal(g.confirmText, 'Freezer and Bar are not marked complete. Approve anyway? Their uncounted lines will be left as the system has them.');
  assert.equal(g.note, 'Approved with Freezer, Bar not marked complete');
  noDashes(g.confirmText, 'confirm'); noDashes(g.note, 'note');
  assert.equal(approvalGate(rows, { confirmIncomplete: true }).ok, true);
  const one = approvalGate([rows[1]]);
  assert.equal(one.confirmText, 'Freezer is not marked complete. Approve anyway? Its uncounted lines will be left as the system has them.');
  const three = approvalGate([{ name: 'A', status: 'open' }, { name: 'B', status: 'open' }, { name: 'C', status: 'open' }]);
  assert.match(three.confirmText, /^A, B and C are not marked complete/);
  assert.deepEqual(approvalGate([rows[0]]), { ok: true, incomplete: [], confirmText: null, note: null });
  assert.deepEqual(approvalGate([]), { ok: true, incomplete: [], confirmText: null, note: null }, 'a count with no areas has no gate');
  assert.equal(approvalGate(null).ok, true);
});

test('otherAreaWarnings (review finding 1c): the fridge counted 24 while the Cellar still holds 24', () => {
  const lines = [
    { id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 24 },
    { id: 'L2', inventoryItemId: 'flour', areaId: DRY, expectedQty: 50, countedQty: 48 },
    { id: 'L3', inventoryItemId: 'peas', areaId: FREEZER, expectedQty: 4, countedQty: null },
    { id: 'L4', inventoryItemId: 'cups', areaId: null, expectedQty: 500, countedQty: 400 },
  ];
  const h = { milk: { [CELLAR]: 24, [FRIDGE]: -6 }, flour: { [DRY]: 50 }, peas: { [FREEZER]: 4, [CELLAR]: 2 } };
  const w = otherAreaWarnings(lines, h, areas, CELLAR);
  assert.equal(w.length, 1, 'flour has one area, peas is uncounted, cups has no area');
  // fridge -6 and 24 counted means 30 came in, but the Cellar only holds 24: listed, no move offered
  assert.deepEqual(w[0], {
    lineId: 'L1', itemId: 'milk', areaId: FRIDGE, counted: 24, areaHolding: -6,
    others: [{ areaId: CELLAR, name: 'Cellar', qty: 24 }], totalAfter: 48, moveFrom: null,
  });
  // the Tuesday case: 24 delivered to the Cellar, 6 sold from the fridge, the counter finds 18
  const tue = otherAreaWarnings([{ id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 18 }], h, areas, CELLAR);
  assert.deepEqual(tue[0].moveFrom, { areaId: CELLAR, name: 'Cellar', qty: 24 }, 'move the 24 from the Cellar and the fridge reads 18 with no count adjustment');
  assert.equal(tue[0].totalAfter, 42);
  // the counted figure is NOT within the receiving area's holding: no move offer
  const w2 = otherAreaWarnings([{ id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 40 }], { milk: { [CELLAR]: 24, [FRIDGE]: 0 } }, areas, CELLAR);
  assert.equal(w2[0].moveFrom, null);
  assert.equal(w2[0].totalAfter, 64);
  // no receiving area: the one other area is offered; two other areas: nothing is guessed
  const w3 = otherAreaWarnings([{ id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 10 }], { milk: { [DRY]: 24 } }, areas, null);
  assert.deepEqual(w3[0].moveFrom, { areaId: DRY, name: 'Dry store', qty: 10 });
  const w4 = otherAreaWarnings([{ id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 0, countedQty: 10 }], { milk: { [DRY]: 24, [CELLAR]: 5 } }, areas, null);
  assert.equal(w4[0].moveFrom, null);
  // counting DOWN never offers a move
  const w5 = otherAreaWarnings([{ id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 10, countedQty: 8 }], { milk: { [FRIDGE]: 10, [CELLAR]: 5 } }, areas, CELLAR);
  assert.equal(w5[0].moveFrom, null);
  assert.deepEqual(otherAreaWarnings([], h, areas, CELLAR), []);
});

// ── 8. names and words ───────────────────────────────────────────────────────

test('countNameFor: the six shapes on the venue clock', () => {
  const ts = '2026-10-16T23:30:00Z';   // 16 Oct in California, 17 Oct in London
  const la = 'America/Los_Angeles';
  assert.equal(countNameFor({ ts, tz: la, type: 'AREA', areaNames: ['Walk in fridge'] }), 'Count 16 Oct 2026 · Walk in fridge');
  assert.equal(countNameFor({ ts, tz: la, type: 'AREA', areaNames: ['Cellar', 'Freezer'] }), 'Count 16 Oct 2026 · Cellar, Freezer');
  assert.equal(countNameFor({ ts, tz: la, type: 'AREA', areaNames: ['Cellar', 'Freezer', 'Bar'] }), 'Count 16 Oct 2026 · 3 areas');
  assert.equal(countNameFor({ ts, tz: la, type: 'SUPPLIER', supplierName: 'Hartley Fresh Foods' }), 'Count 16 Oct 2026 · Hartley Fresh Foods');
  assert.equal(countNameFor({ ts, tz: la, type: 'SPOT' }), 'Count 16 Oct 2026 · Spot check');
  assert.equal(countNameFor({ ts, tz: la, type: 'FULL' }), 'Count 16 Oct 2026 · Full');
  assert.equal(countNameFor({ ts, tz: 'Europe/London', type: 'FULL' }), 'Count 17 Oct 2026 · Full', 'the venue clock');
  assert.equal(countNameFor({ ts, tz: la, type: 'AREA', areaNames: [] }), 'Count 16 Oct 2026 · By area');
  assert.equal(countNameFor({ ts, tz: la, type: 'SUPPLIER' }), 'Count 16 Oct 2026 · By supplier');
  assert.equal(countNameFor({ ts, tz: la, type: 'PARTIAL' }), 'Count 16 Oct 2026 · Partial');
});

test('countStatusText: "2 of 4 areas complete", then "All 4 areas complete · ready to approve"', () => {
  const rows = (done, total) => Array.from({ length: total }, (_, i) => ({ status: i < done ? 'complete' : 'open' }));
  assert.deepEqual(countStatusText(rows(2, 4)), { text: '2 of 4 areas complete', ready: false });
  assert.deepEqual(countStatusText(rows(4, 4)), { text: 'All 4 areas complete · ready to approve', ready: true });
  assert.deepEqual(countStatusText(rows(1, 1)), { text: 'Area complete · ready to approve', ready: true });
  assert.deepEqual(countStatusText(rows(0, 1)), { text: '0 of 1 area complete', ready: false });
  assert.deepEqual(countStatusText([]), { text: '', ready: false });
  assert.deepEqual(countStatusText(null), { text: '', ready: false });
});

test('the small words: posting progress, bulk assign toast, archive refusal, the reference', () => {
  assert.equal(postingText(240, 1100), 'Posting 240 of 1,100');
  assert.equal(postingText(0, 3), 'Posting 0 of 3');
  assert.equal(bulkAssignText({ moved: 38, holdings: 12, failed: 0, areaName: 'Dry store' }), '38 items moved to Dry store, 12 holdings moved', 'no "0 failed" in a success toast');
  assert.equal(bulkAssignText({ moved: 1, holdings: 1, failed: 2, areaName: 'Bar' }), '1 item moved to Bar, 1 holding moved, 2 failed');
  assert.equal(bulkAssignText({ moved: 3, areaName: 'No area' }), '3 items moved to No area, 0 holdings moved');
  assert.equal(archiveRefusal(12, 3), 'Move 12 items and 3 holdings out first');
  assert.equal(archiveRefusal(1, 0), 'Move 1 item out first');
  assert.equal(archiveRefusal(0, 1), 'Move 1 holding out first');
  assert.equal(archiveRefusal(0, 0), null);
  const ref = transferReference(() => 0);
  assert.equal(ref, 'TR-AAAAAA');
  assert.match(transferReference(), /^TR-[A-HJ-NP-Z2-9]{6}$/);
  for (const t of [postingText(1, 2), bulkAssignText({}), archiveRefusal(1, 1)]) noDashes(t, t);
});

// ── 8a. search, filters, paging ──────────────────────────────────────────────

const pickerItems = [
  { id: 'milk', name: 'Whole Milk 2L', sku: 'MILK2', category: 'Dairy', areaId: FRIDGE, supplierProducts: [{ supplierId: 's-dairy', supplierSku: 'HF-0021' }] },
  { id: 'oat', name: 'Oat Milk 1L', sku: 'OAT1', category: 'Dairy', areaId: FRIDGE, supplierProducts: [] },
  { id: 'flour', name: 'Plain Flour 16kg', sku: 'FLR16', category: 'Dry goods', areaId: DRY, supplierProducts: [{ supplierId: 's-bake', supplierSku: 'BK-77' }] },
  { id: 'cups', name: '8oz Takeaway Cups', sku: null, category: 'Packaging', areaId: null, supplierProducts: [] },
  { id: 'old', name: 'Old Milk', sku: 'OLD', category: 'Dairy', areaId: null, archivedAt: '2026-01-01', supplierProducts: [] },
];

test('filterItems: name, SKU, supplier code, area, category, supplier, No area only; archived out unless asked', () => {
  const ids = (list) => list.map((i) => i.id);
  assert.deepEqual(ids(filterItems(pickerItems)), ['milk', 'oat', 'flour', 'cups']);
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'milk' })), ['milk', 'oat']);
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'MILK2' })), ['milk'], 'our SKU');
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'hf-0021' })), ['milk'], 'the supplier code on the item');
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'bk-77' }, { supplierProducts: [{ inventoryItemId: 'flour', supplierId: 's-bake', supplierSku: 'BK-77' }] })), ['flour'], 'or handed in');
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'milk 2l' })), ['milk'], 'every word must match');
  assert.deepEqual(ids(filterItems(pickerItems, { areaId: FRIDGE })), ['milk', 'oat']);
  assert.deepEqual(ids(filterItems(pickerItems, { areaId: 'none' })), ['cups']);
  assert.deepEqual(ids(filterItems(pickerItems, { areaId: 'any' })), ['milk', 'oat', 'flour', 'cups']);
  assert.deepEqual(ids(filterItems(pickerItems, { areaId: DRY }, { itemAreas: { cups: DRY } })), ['flour', 'cups'], 'a handed in area map wins over the item');
  assert.deepEqual(ids(filterItems(pickerItems, { category: 'Dairy' })), ['milk', 'oat']);
  assert.deepEqual(ids(filterItems(pickerItems, { supplierId: 's-dairy' })), ['milk']);
  assert.deepEqual(ids(filterItems(pickerItems, { noAreaOnly: true })), ['cups']);
  assert.deepEqual(ids(filterItems(pickerItems, { includeArchived: true, q: 'old' })), ['old']);
  assert.deepEqual(ids(filterItems(pickerItems, { q: 'nothing here' })), []);
  assert.deepEqual(filterItems(null), []);
  assert.deepEqual(categoriesOf(pickerItems), ['Dairy', 'Dry goods', 'Packaging']);
});

test('filterLines: area, category, Uncounted only, Variance only, search by the item', () => {
  const itemsById = {}; pickerItems.forEach((i) => { itemsById[i.id] = i; });
  const lines = [
    { id: 'L1', inventoryItemId: 'milk', areaId: FRIDGE, expectedQty: 10, countedQty: 10 },
    { id: 'L2', inventoryItemId: 'oat', areaId: FRIDGE, expectedQty: 4, countedQty: null },
    { id: 'L3', inventoryItemId: 'flour', areaId: DRY, expectedQty: 50, countedQty: 48 },
    { id: 'L4', inventoryItemId: 'cups', areaId: null, expectedQty: 500, countedQty: null },
  ];
  const ids = (list) => list.map((l) => l.id);
  assert.deepEqual(ids(filterLines(lines, {}, { itemsById })), ['L1', 'L2', 'L3', 'L4']);
  assert.deepEqual(ids(filterLines(lines, { areaId: FRIDGE }, { itemsById })), ['L1', 'L2']);
  assert.deepEqual(ids(filterLines(lines, { areaId: 'none' }, { itemsById })), ['L4']);
  assert.deepEqual(ids(filterLines(lines, { category: 'Dairy' }, { itemsById })), ['L1', 'L2']);
  assert.deepEqual(ids(filterLines(lines, { uncountedOnly: true }, { itemsById })), ['L2', 'L4']);
  assert.deepEqual(ids(filterLines(lines, { varianceOnly: true }, { itemsById })), ['L3']);
  assert.deepEqual(ids(filterLines(lines, { q: 'flr16' }, { itemsById })), ['L3'], 'SKU');
  assert.deepEqual(ids(filterLines(lines, { q: 'hf-0021' }, { itemsById })), ['L1'], 'supplier code');
  // the typed figure (not yet saved) counts
  const typed = { L2: 5 };
  assert.deepEqual(ids(filterLines(lines, { uncountedOnly: true }, { itemsById, countedOf: (l) => typed[l.id] ?? l.countedQty })), ['L4']);
  assert.deepEqual(ids(filterLines(lines, { varianceOnly: true }, { itemsById, countedOf: (l) => typed[l.id] ?? l.countedQty })), ['L2', 'L3']);
});

test('chunkArray and visibleRows: 1,000 items is never 1,000 rows at once, lines insert 200 a request', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 200), []);
  assert.equal(chunkArray(Array.from({ length: 1001 }), 200).length, 6);
  assert.equal(chunkArray([1, 2], 0).length, 2, 'a bad size is one a chunk');
  assert.equal(visibleRows(1000), 50);
  assert.equal(visibleRows(1000, 3), 150);
  assert.equal(visibleRows(120, 3), 120);
  assert.equal(visibleRows(0, 5), 0);
  assert.equal(visibleRows(10, 0, 50), 10);
  assert.equal(INSERT_CHUNK, 200); assert.equal(RENDER_STEP, 50); assert.equal(COLLAPSE_OVER, 300); assert.equal(POST_IN_FLIGHT, 3);
});

// ── 10. source pins (the house style) ────────────────────────────────────────

const migration = read('../../../supabase/migrations/20261016_OPS_stock_areas.sql');
const rollback = read('../../../supabase/migrations/20261016_OPS_stock_areas_ROLLBACK.sql');
const mig = sqlCode(migration);

test('the migration drops the 11 argument signature before creating the 12 argument one, re grants, and reloads the API cache', () => {
  const drop = mig.indexOf('drop function if exists public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text);');
  const create = mig.indexOf('create or replace function public.post_stock_movement(');
  const grant = mig.indexOf('grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, anon, service_role;');
  assert.ok(drop > 0 && create > drop && grant > create, 'drop, then create, then grant');
  assert.match(mig, /p_notes\s+text default null,\s+p_area_id\s+uuid default null\s*\) returns jsonb/);
  // the area is worked out when the caller does not say: the receiving area for a delivery, else the use area
  assert.match(mig, /if v_area is null and p_movement_type = 'PURCHASE_RECEIPT' then/);
  assert.match(mig, /where ia\.inventory_item_id = p_inventory_item_id and ia\.is_primary and a\.archived_at is null/);
  // the cache moves in the same statement as the ledger row
  assert.match(mig, /insert into inventory_item_area_stock \(location_id, inventory_item_id, area_id, on_hand, updated_at\)\s+values \(p_location_id, p_inventory_item_id, v_area, p_qty_base, now\(\)\)\s+on conflict \(inventory_item_id, area_id\) do update/);
  // the transfer function: authenticated and service_role, never anon
  assert.match(mig, /revoke all on function public\.post_stock_transfer_leg\(uuid, text, text\) from public, anon;\s+grant execute on function public\.post_stock_transfer_leg\(uuid, text, text\) to authenticated, service_role;/);
  // the receiving flag is NEVER set by the backfill (review finding 1b)
  const backfill = mig.slice(mig.indexOf('insert into storage_areas (location_id, name, kind, sort_order)'), mig.indexOf("notify pgrst, 'reload schema';"));
  assert.doesNotMatch(backfill, /is_receiving\s*=\s*true|is_receiving\)/, 'nothing flagged receiving');
  assert.match(backfill, /and m\.area_id is null;/, 'the movement backfill only touches rows with no area');
  // the cache reload comes after the function change and after the backfill
  const notify = mig.lastIndexOf("notify pgrst, 'reload schema';");
  assert.ok(notify > grant && notify > mig.indexOf('delete from inventory_item_area_stock;'));
  assert.match(sqlCode(rollback), /notify pgrst, 'reload schema';/);
  // the rollback restores the 11 argument function and drops the new one first
  const rb = sqlCode(rollback);
  assert.ok(rb.indexOf('drop function if exists public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid);') < rb.indexOf('create or replace function public.post_stock_movement('));
  assert.match(rb, /grant execute on function public\.post_stock_movement\(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text\) to authenticated, anon, service_role;/);
  for (const t of ['storage_areas', 'inventory_item_areas', 'inventory_item_area_stock', 'stock_count_areas', 'stock_transfers', 'stock_transfer_lines']) {
    assert.match(mig, new RegExp(`create table if not exists public\\.${t} \\(`), t);
    assert.match(rb, new RegExp(`drop table if exists public\\.${t};`), t);
  }
  // the RLS text is the live stock_counts one, and the transfer tables fence on either end
  assert.match(mig, /using \(\(location_id\)::text in \(select user_accessible_locations\(\)\)\)\s+with check \(\(location_id\)::text in \(select user_accessible_locations\(\)\)\);/);
  assert.match(mig, /or \(to_location_id\)::text in \(select user_accessible_locations\(\)\)\)/);
  assert.match(migration, /OPS DB ONLY\s+project ref\s+tbetcegmszzotrwdtqhi/);
  assert.match(migration, /RUN OUTSIDE SERVICE/);
  // stock_counts.area_ids is NOT added (review nit: scope lives in stock_count_areas)
  assert.doesNotMatch(mig, /area_ids/);
  noDashes(migration, 'migration'); noDashes(rollback, 'rollback');
});

test('the migration (16 Oct review fixes): first area re homes unassigned stock, cost source check widened, in leg checks before it posts, RLS split per command, re run safe backfill', () => {
  // 4b: the trigger re homes null area movements and rebuilds the cache row, and exists before the backfill writes item areas
  assert.match(mig, /create or replace function public\.inventory_item_areas_rehome\(\)/);
  assert.match(mig, /if new\.is_primary then\s+update stock_movements set area_id = new\.area_id\s+where location_id = new\.location_id and inventory_item_id = new\.inventory_item_id and area_id is null;/);
  assert.match(mig, /on conflict \(inventory_item_id, area_id\) do update set on_hand = excluded\.on_hand, updated_at = now\(\);/);
  assert.match(mig, /create trigger inventory_item_areas_rehome_trg\s+after insert or update of area_id on public\.inventory_item_areas\s+for each row execute function public\.inventory_item_areas_rehome\(\);/);
  assert.ok(mig.indexOf('create trigger inventory_item_areas_rehome_trg') < mig.indexOf('insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)'), 'the trigger is there before 8b writes item areas');
  assert.match(sqlCode(rollback), /drop function if exists public\.inventory_item_areas_rehome\(\) cascade;/);
  // 5b: the live item_cost_history check learns TRANSFER (and PO_RECEIPT) before the receiving leg writes it
  assert.match(mig, /c\.conrelid = 'public\.item_cost_history'::regclass and c\.contype = 'c'/);
  assert.match(mig, /add constraint item_cost_history_source_chk\s+check \(source in \('INVOICE','MANUAL','CONTRACT','CATALOG','RECIPE_ROLLUP','PO_RECEIPT','TRANSFER'\)\);/);
  assert.ok(mig.indexOf('item_cost_history_source_chk') < mig.indexOf('create or replace function public.post_stock_transfer_leg'), 'widened before the function that needs it');
  assert.doesNotMatch(sqlCode(rollback), /item_cost_history_source_check/, 'the rollback leaves the wider check in place');
  // the in leg: every matched item checked BEFORE the loop; the chosen area must be a live area of the receiving venue
  const inLeg = mig.slice(mig.indexOf("and not dropped and to_inventory_item_id is null) then"), mig.indexOf("set status = 'RECEIVED'"));
  assert.ok(inLeg.length > 0 && inLeg.length < 6000, 'the in leg slice is the in leg');
  const guard = inLeg.indexOf("return jsonb_build_object('ok', false, 'error', 'A matched item is not at the receiving venue');");
  const loop = inLeg.indexOf('for v_l in');
  assert.ok(guard > 0 && loop > guard, 'the refusal comes before anything posts');
  assert.match(inLeg, /raise exception 'post_stock_transfer_leg: matched item % is not at venue %'/, 'inside the loop a raise rolls the whole leg back');
  assert.match(inLeg, /if v_area is not null and not exists \(select 1 from storage_areas a\s+where a\.id = v_area and a\.location_id = v_t\.to_location_id and a\.archived_at is null\) then\s+v_area := null;/);
  // the receiver's cost: the carried cost stands alone only when on hand plus received is zero or below (movingAverageCost)
  assert.match(inLeg, /= 'LAST_COST' or v_before \+ v_qty <= 0 then/);
  assert.doesNotMatch(inLeg, /or v_before <= 0 then/);
  // RLS: only the sending venue inserts or deletes; both ends read and update; the API updates only its own columns
  assert.match(mig, /create policy %I_insert on public\.%I\s+for insert\s+with check \(\(location_id\)::text in \(select user_accessible_locations\(\)\)\);/);
  assert.match(mig, /create policy %I_delete on public\.%I\s+for delete\s+using \(\(location_id\)::text in \(select user_accessible_locations\(\)\)\);/);
  assert.match(mig, /revoke update on public\.stock_transfers from authenticated, anon;\s+grant update \(to_area_id, note, updated_at\) on public\.stock_transfers to authenticated;/);
  assert.match(mig, /revoke update on public\.stock_transfer_lines from authenticated, anon;\s+grant update \(to_inventory_item_id, qty_received_base, dropped\) on public\.stock_transfer_lines to authenticated;/);
  // backfill: 8a compares normalised names and only looks at items with no area; 8b is one area per item
  const eightA = mig.slice(mig.indexOf('with texts as ('), mig.indexOf('insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)'));
  assert.match(eightA, /and not exists \(select 1 from inventory_item_areas ia where ia\.inventory_item_id = i\.id and ia\.is_primary\)\s+group by i\.location_id, btrim\(i\.storage_location\)/);
  assert.match(eightA, /and regexp_replace\(lower\(regexp_replace\(regexp_replace\(btrim\(a\.name\), '\[-_\]', ' ', 'g'\), '\\s\+', ' ', 'g'\)\), '\^the ', ''\) = p\.norm/);
  assert.doesNotMatch(eightA, /lower\(btrim\(a\.name\)\) = lower\(p\.shown\)/);
  assert.match(mig, /select distinct on \(i\.id\) i\.location_id, i\.id, a\.id, true/);
  assert.match(mig, /order by i\.id, a\.sort_order, a\.created_at\s+on conflict \(inventory_item_id, area_id\) do nothing;/);
  // the live name index uses the same normalised text, so the screen cannot make two walk in fridges either
  assert.match(mig, /create unique index if not exists storage_areas_name_uniq\s+on public\.storage_areas \(location_id, regexp_replace\(lower\(/);
  // areas.js: the usual six are compared by the same rule
  const areasSrc = code(read('./areas.js'));
  assert.match(areasSrc, /const have = new Set\(\(existing \|\| \[\]\)\.map\(\(a\) => normaliseAreaName\(a\.name\)\)\);/);
  assert.match(areasSrc, /could not be moved: \$\{mv\.error\.message/, 'the refusal still names the cause');
  assert.match(areasSrc, /its \$\{qtyWords\(qty, item\)\} could not be moved/, 'the moved figure is said in the item\'s unit');
});

test('data.js: fetchInventoryItems reads in pages, postStockMovement sends p_area_id only when the areas are known to be ready', () => {
  const src = code(read('./data.js'));
  assert.match(src, /import \{ areasReady, areasReadySync, fetchItemAreas \} from '\.\/areas\.js';/);
  assert.match(src, /if \(m\.areaId && areasReadySync\(\) === true\) args\.p_area_id = m\.areaId;/);
  assert.equal((src.match(/p_area_id/g) || []).length, 1, 'one place decides');
  assert.match(src, /page\('stock items', 'inventory_items', \['name', 'id'\]\)/);
  assert.match(src, /page\('supplier packs', 'supplier_products', \['created_at', 'id'\]\)/);
  assert.match(src, /it\.areaId = itemAreas\[r\.id\] \|\| null;/);
  const fetchBody = src.slice(src.indexOf('export const fetchInventoryItems'), src.indexOf('export const upsertInventoryItem'));
  assert.doesNotMatch(fetchBody, /\.select\('\*'\)\.eq\('location_id', locationId\)\.order\('name'\)/, 'no unpaged items read left');
});

test('counts.js: lines carry their area, keys use both shapes, posts go through a pool of 3, APPROVED after the posts', () => {
  const src = code(read('./counts.js'));
  assert.match(src, /import \{ resolveCountScope, adjustmentKey, chunkArray, INSERT_CHUNK, POST_IN_FLIGHT, countNameFor \} from '\.\/areaRules\.js';/);
  assert.match(src, /idempotencyKey: adjustmentKey\(countId, a\.itemId, ready \? a\.areaId : null\),/);
  assert.match(src, /areaId: ready \? a\.areaId : null,/, 'the area is sent only once the migration has run');
  assert.match(src, /const plan = countApprovalPlan\(lines, onHand, cost, areaOnHand\);/);
  assert.match(src, /const gate = limiter\(POST_IN_FLIGHT\);/);
  assert.match(src, /await Promise\.all\(plan\.adjustments\.map\(\(a\) => gate\(\(\) => postOne\(a\)\)\)\);/);
  assert.match(src, /if \(failure\) return;/, 'the first failure stops new posts');
  const posts = src.indexOf('await Promise.all(plan.adjustments.map');
  const approved = src.indexOf("status: 'APPROVED'");
  assert.ok(posts > 0 && approved > posts, 'APPROVED is written after the adjustments, never before');
  assert.match(src, /for \(const chunk of chunkArray\(lines, INSERT_CHUNK\)\) \{\s+const \{ data: ins, error: lineErr \} = await supabase\.from\('stock_count_lines'\)\.insert\(chunk\)\.select\('id'\);/, 'lines insert 200 a request and every insert is checked');
  assert.match(src, /export const markAreaComplete = async/);
  assert.match(src, /readAllPagesResult\('count lines'/, 'the lines read is paged');
  // the old Full count keeps working on a database without the migration
  assert.match(src, /if \(!ready \|\| \(type !== 'AREA' && type !== 'SUPPLIER' && type !== 'SPOT' && type !== 'FULL'\)\) \{/);
});

test('areas.js: the probe reads one row and treats only a missing relation as not ready; every write asks for its rows back', () => {
  const src = code(read('./areas.js'));
  assert.match(src, /supabase\.from\('storage_areas'\)\.select\('id'\)\.limit\(1\)/);
  assert.match(src, /_ready = isMissingRelationError\(error\) \? false : null;/, 'any other failure is "unknown", never "ready"');
  assert.match(src, /export function areasReadySync\(\) \{ return _ready; \}/);
  for (const w of ['Archive area', 'Set receiving area', 'Reorder areas', 'Item area change', 'Item area save', 'Clear item area', 'Add the usual six'])
    assert.ok(src.includes(`zeroRows('${w}'`), w);
  assert.match(src, /supabase\.rpc\('post_stock_transfer_leg', \{ p_transfer_id: head\.id, p_leg: 'both', p_by_name: byName \|\| null \}\)/, 'a within venue move is one transfer, both legs, one transaction');
  assert.match(src, /readAllPagesResult\('item areas'/); assert.match(src, /readAllPagesResult\('area holdings'/);
});

test('no long dashes in the words this change added', () => {
  for (const f of ['./areaRules.js', './areas.js', './counts.js']) noDashes(read(f).replace(/\/\/.*$/gm, ''), f);
  const sections = ['../../backoffice/sections/StockAreas.jsx', '../../backoffice/sections/StockCounts.jsx', '../../components/StockItemPicker.jsx', '../../backoffice/sections/StockTransfers.jsx'];
  for (const f of sections) noDashes(read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), f);
});

// ── Stock by area (builder B) ─────────────────────────────────────────────────

test('stockByAreaRows: a holding per area in order, Unassigned only when the total differs, value floored per area, red below zero, filters', () => {
  const items = [
    { id: 'milk', name: 'Milk', sku: 'M1', category: 'Dairy', onHand: 10, currentCost: 1, areaId: FRIDGE },
    { id: 'beans', name: 'Beans', sku: 'B1', category: 'Dry', onHand: 5, currentCost: 10, areaId: DRY },
    { id: 'cups', name: 'Cups', sku: 'C1', category: 'Packaging', onHand: 100, currentCost: 0.05, areaId: null },
    { id: 'old', name: 'Old', onHand: 3, currentCost: 1, archivedAt: '2026-01-01' },
  ];
  // milk: 12 in the cellar, minus 2 in the fridge (sold from the fridge, never transferred): total 10
  // beans: 5 in the dry store. cups: nothing in any area: all 100 Unassigned.
  const holdings = { milk: { [CELLAR]: 12, [FRIDGE]: -2 }, beans: { [DRY]: 5 } };
  const all = stockByAreaRows(items, areas, holdings);
  assert.deepEqual(all.rows.map((r) => r.name), ['Beans', 'Cups', 'Milk']);
  const milk = all.rows.find((r) => r.id === 'milk');
  assert.equal(milk.perArea[CELLAR], 12); assert.equal(milk.perArea[FRIDGE], -2); assert.equal(milk.perArea[FREEZER], 0);
  assert.equal(milk.unassigned, 0); assert.equal(milk.total, 10); assert.equal(milk.below, true);
  assert.equal(milk.value, 12, 'the fridge below zero counts for nothing, the cellar counts in full');
  const cups = all.rows.find((r) => r.id === 'cups');
  assert.equal(cups.unassigned, 100); assert.equal(cups.value, 5); assert.equal(cups.below, false);
  assert.equal(all.showUnassigned, true);
  assert.equal(all.belowCount, 1);
  assert.deepEqual(all.totals.perArea, { [CELLAR]: 12, [FRIDGE]: -2, [FREEZER]: 0, [DRY]: 5 });
  assert.equal(all.totals.unassigned, 100); assert.equal(all.totals.total, 115); assert.equal(all.totals.value, 67);
  assert.ok(!(BAR in all.totals.perArea), 'an archived area has no column');
  // filters: the fridge shows milk (a holding there), the dry store shows beans (assigned and held)
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { areaId: FRIDGE }).rows.map((r) => r.id), ['milk']);
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { areaId: DRY }).rows.map((r) => r.id), ['beans']);
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { areaId: FREEZER }).rows, []);
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { belowOnly: true }).rows.map((r) => r.id), ['milk']);
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { q: 'pack' }).rows.map((r) => r.id), ['cups']);
  assert.deepEqual(stockByAreaRows(items, areas, holdings, { q: 'b1' }).rows.map((r) => r.id), ['beans']);
  const none = stockByAreaRows(items, areas, { milk: { [FRIDGE]: 10 }, beans: { [DRY]: 5 }, cups: { [DRY]: 100 } });
  assert.equal(none.showUnassigned, false, 'no Unassigned column when every item adds up');
});
