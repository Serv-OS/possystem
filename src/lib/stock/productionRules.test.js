/** productionRules.test.js: the batch row, the schedule units, no guessing. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchRow, resolveBatchOutput, scheduleUnitOptions } from './productionRules.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

const soupItem = { name: 'Soup of the Day', baseUnit: 'l', formats: [{ id: 'f1', name: 'Tub', qtyInBase: 2 }] };
const soupRecipe = { yieldQty: 10, yieldUnit: 'l' };
const pattyItem = { name: 'Beef Patty', baseUnit: 'each', formats: [] };

test('batchRow carries planned and actual quantity as real columns', () => {
  const row = batchRow({ locationId: 'L', recipeId: 'R', outputItemId: 'I', outputName: 'Soup of the Day', plannedQty: 10, actualQty: 9.5, outputUnit: 'l',
    plan: { totalCost: 6.86, outputUnitCost: 0.7221 }, lotCode: 'A1', expiryAt: '2026-10-18', notes: null, producedAt: '2026-10-15T10:00:00.000Z' });
  assert.equal(row.planned_qty, 10);
  assert.equal(row.actual_qty, 9.5);
  assert.equal(row.output_name, 'Soup of the Day');
  assert.equal(row.output_unit, 'l');
  assert.equal(row.status, 'DRAFT');
  assert.equal(row.theoretical_cost, 6.86);
  assert.equal(row.output_unit_cost, 0.7221);
  assert.equal(row.lot_code, 'A1');
  assert.equal(row.expiry_at, '2026-10-18');
  assert.equal(row.notes, null);
  // no yield known: planned is null, never NaN
  assert.equal(batchRow({ locationId: 'L', recipeId: 'R', outputItemId: 'I', plannedQty: undefined, actualQty: 3, outputUnit: 'each', plan: {} }).planned_qty, null);
  assert.equal(batchRow({ locationId: 'L', recipeId: 'R', outputItemId: 'I', plannedQty: '', actualQty: 3, outputUnit: 'each', plan: {} }).planned_qty, null);
});

test('resolveBatchOutput: batch means yield times n, a pack name means its size', () => {
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'batch', actualQty: 2, recipe: soupRecipe, item: soupItem }), { qty: 20, unit: 'l' });
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'Tub', actualQty: 3, recipe: soupRecipe, item: soupItem }), { qty: 6, unit: 'l' });
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'L', actualQty: 9.5, recipe: soupRecipe, item: soupItem }), { qty: 9.5, unit: 'l' });
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'ml', actualQty: 500, recipe: soupRecipe, item: soupItem }), { qty: 500, unit: 'ml' });
  assert.deepEqual(resolveBatchOutput({ outputUnit: '', actualQty: 4, recipe: soupRecipe, item: soupItem }), { qty: 4, unit: 'l' });
  // counted words are fine on an item counted in each
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'portions', actualQty: 40, recipe: { yieldQty: 20, yieldUnit: 'each' }, item: pattyItem }), { qty: 40, unit: 'each' });
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'ea', actualQty: 38, recipe: { yieldQty: 20, yieldUnit: 'each' }, item: pattyItem }), { qty: 38, unit: 'each' });
});

test('resolveBatchOutput refuses rather than guesses', () => {
  // 10 portions of soup is NOT 10 litres
  assert.throws(() => resolveBatchOutput({ outputUnit: 'portions', actualQty: 10, recipe: soupRecipe, item: soupItem }), /not a unit Soup of the Day is measured in \(its unit is l\)/);
  assert.throws(() => resolveBatchOutput({ outputUnit: 'trays', actualQty: 2, recipe: soupRecipe, item: soupItem }), /trays/);
  assert.throws(() => resolveBatchOutput({ outputUnit: 'bucket', actualQty: 1, recipe: soupRecipe, item: soupItem }), /"bucket" is not a unit Soup of the Day understands/);
  assert.throws(() => resolveBatchOutput({ outputUnit: 'l', actualQty: 0, recipe: soupRecipe, item: soupItem }), /more than zero/);
  assert.throws(() => resolveBatchOutput({ outputUnit: 'l', actualQty: 'x', recipe: soupRecipe, item: soupItem }), /more than zero/);
  // a pack with no size is a setup fault, said as one
  assert.throws(() => resolveBatchOutput({ outputUnit: 'Tub', actualQty: 1, recipe: soupRecipe, item: { ...soupItem, formats: [{ id: 'f1', name: 'Tub', qtyInBase: 0 }] } }), /has no size/);
  // v5.11.65: a KNOWN unit of another dimension is refused in words, not by the engine at Done
  assert.throws(() => resolveBatchOutput({ outputUnit: 'kg', actualQty: 2, recipe: soupRecipe, item: soupItem }), /"kg" is not a unit Soup of the Day is measured in \(its unit is l\)/);
  assert.throws(() => resolveBatchOutput({ outputUnit: 'L', actualQty: 20, recipe: { yieldQty: 20, yieldUnit: 'each' }, item: pattyItem }), /measured in/);
  // the same dimension still passes as typed
  assert.deepEqual(resolveBatchOutput({ outputUnit: 'ml', actualQty: 500, recipe: soupRecipe, item: soupItem }), { qty: 500, unit: 'ml' });
});

test('scheduleUnitOptions: the item\'s own units plus batch, a stale unit shown as stale', () => {
  const opts = scheduleUnitOptions(soupItem);
  assert.deepEqual(opts.map((o) => o.value), ['l', 'Tub', 'batch']);
  assert.equal(opts[1].label, 'Tub (2 l)');
  const withStale = scheduleUnitOptions(soupItem, 'portions');
  assert.equal(withStale.at(-1).value, 'portions');
  assert.equal(withStale.at(-1).stale, true);
  assert.match(withStale.at(-1).label, /not a unit this item understands/);
  // a known same dimension unit already saved is kept and not called stale
  const ml = scheduleUnitOptions(soupItem, 'ml');
  assert.equal(ml.at(-1).value, 'ml');
  assert.equal(ml.at(-1).stale, false);
  // a known unit of the WRONG dimension (the editor's old default 'L' on an each item) is stale
  assert.equal(scheduleUnitOptions(pattyItem, 'L').at(-1).stale, true);
  assert.equal(scheduleUnitOptions(soupItem, 'kg').at(-1).stale, true);
  assert.match(scheduleUnitOptions(pattyItem, 'L').at(-1).label, /not a unit this item understands/);
  // the editor's item shape (packaging) is read too
  assert.deepEqual(scheduleUnitOptions({ baseUnit: 'each', packaging: [{ name: 'Tray', qtyInBase: 12 }] }).map((o) => o.value), ['each', 'Tray', 'batch']);
  assert.deepEqual(scheduleUnitOptions(null), []);
});

test('production.js builds the batch row from the rule and resolves the unit before planning', () => {
  const src = readFileSync(resolve(here, './production.js'), 'utf8');
  assert.match(src, /import \{ batchRow, resolveBatchOutput \} from '\.\/productionRules\.js';/);
  assert.match(src, /\.insert\(batchRow\(\{/, 'produceBatch inserts the tested row');
  assert.doesNotMatch(src, /output_name: [^\n]*planned_qty:/, 'planned_qty never sits inside a comment again');
  assert.match(src, /resolveBatchOutput\(\{ outputUnit: b\.output_unit/, 'completePlannedBatch resolves the schedule unit');
  assert.doesNotMatch(src, /\[norm\(b\.output_unit\), rec\.yield_unit, 'each'\]/, 'no fallback walk');
  assert.match(src, /toBase\(Number\(l\.qty\), l\.unit, comp\)/, 'recipe lines in a pack unit convert like costing does');
});
