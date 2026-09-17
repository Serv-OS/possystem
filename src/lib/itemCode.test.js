/**
 * itemCode.test.js - the short code a venue gives one of its products.
 * Run: `npm test`, or `node --test src/lib/itemCode.test.js`.
 *
 * Peter, 17 Sep: "we should be able to give ezCater a SKU or code for each
 * product, but if it is missing it should still be able to receive the order".
 *
 * What is pinned here:
 *   1. the two forms of a code, and why the comparing one forgives less
 *   2. Suggest: readable, upper case, 3 to 16, a number when it is taken
 *   3. the duplicate refusal, including against an ARCHIVED product
 *   4. the two column list the Back Office hands over
 *   5. living without menu_items.item_code, which is every venue until Peter
 *      runs the migration by hand
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ITEM_CODE_MIN, ITEM_CODE_MAX, ITEM_CODE_LIST_HEADER,
  normaliseItemCode, itemCodeKey, itemCodeForSave, codeOf, itemNameOf,
  takenItemCodes, suggestItemCode, checkItemCode,
  itemCodeRows, itemCodesText,
  isMissingItemCodeColumn, isDuplicateItemCodeError, loadItemCodes,
} from './itemCode.js';

// Our menu the way the store holds it, plus the shapes it really arrives in.
const ITEMS = [
  { id: 'm-flat', menuName: 'Flat White', itemCode: 'FLATWHITE' },
  { id: 'm-caesar', name: 'Caesar Salad', item_code: 'CAESARSAL' },
  { id: 'm-cola', menuName: 'Cola', itemCode: null },
  { id: 'm-tea', menuName: 'Tea' },
];

// ── the two forms ───────────────────────────────────────────────────────────

test('normaliseItemCode: upper case, letters and digits, capped', () => {
  assert.equal(normaliseItemCode('flat white'), 'FLATWHITE');
  assert.equal(normaliseItemCode('Flat-White!'), 'FLATWHITE');
  assert.equal(normaliseItemCode('crème'), 'CREME', 'accents fold rather than disappear');
  assert.equal(normaliseItemCode('  cae sar 1 '), 'CAESAR1');
  assert.equal(normaliseItemCode('A'.repeat(40)).length, ITEM_CODE_MAX);
  for (const junk of [null, undefined, '', '!!!', '   ']) assert.equal(normaliseItemCode(junk), '');
});

test('itemCodeKey forgives case and stray spaces and NOTHING else', () => {
  assert.equal(itemCodeKey(' flatwhite '), 'FLATWHITE');
  // If this stripped punctuation, a partner's "M-123" could become our "M123",
  // and a wrong match here sends the wrong food.
  assert.equal(itemCodeKey('M-123'), 'M-123');
  assert.equal(itemCodeKey(null), '');
});

test('itemCodeForSave trims and never writes a blank, and rewrites nothing', () => {
  assert.equal(itemCodeForSave('  FLATWHITE '), 'FLATWHITE');
  for (const blank of ['', '   ', null, undefined]) assert.equal(itemCodeForSave(blank), null);
  // A code set another way is left EXACTLY as it is. Re-normalising it on an
  // unrelated menu save would change what a partner is holding, silently.
  assert.equal(itemCodeForSave('FLAT-WHITE'), 'FLAT-WHITE');
});

test('codeOf and itemNameOf read either spelling, and no code is null', () => {
  assert.equal(codeOf(ITEMS[0]), 'FLATWHITE');
  assert.equal(codeOf(ITEMS[1]), 'CAESARSAL');
  assert.equal(codeOf(ITEMS[2]), null);
  assert.equal(codeOf(ITEMS[3]), null);
  assert.equal(codeOf(null), null);
  assert.equal(codeOf({ item_code: '   ' }), null, 'blank is no code');
  assert.equal(itemNameOf(ITEMS[0]), 'Flat White');
  assert.equal(itemNameOf({ name: 'Caesar\tSalad\n' }), 'Caesar Salad', 'one line, so the two columns stay two');
});

// ── who holds what ──────────────────────────────────────────────────────────

test('takenItemCodes keys on the comparing form and names the holder', () => {
  const taken = takenItemCodes(ITEMS);
  assert.equal(taken.get('FLATWHITE').itemId, 'm-flat');
  assert.equal(taken.get('FLATWHITE').name, 'Flat White');
  assert.equal(taken.get('CAESARSAL').itemId, 'm-caesar');
  assert.equal(taken.size, 2, 'products with no code hold nothing');
});

test('takenItemCodes includes codes read straight from the table', () => {
  // The Back Office reads id -> code for the location, ARCHIVED ROWS INCLUDED,
  // because the database's unique index counts them and the store does not
  // hold them at all.
  const taken = takenItemCodes(ITEMS, new Map([['m-archived', 'OLDCODE']]));
  assert.equal(taken.get('OLDCODE').itemId, 'm-archived');
  assert.equal(taken.size, 3);
  // A plain object works too, which is what a JSON payload gives.
  assert.equal(takenItemCodes(ITEMS, { 'm-x': 'XCODE' }).get('XCODE').itemId, 'm-x');
});

// ── Suggest ─────────────────────────────────────────────────────────────────

test('Suggest builds a readable code from the name', () => {
  const taken = new Map();
  assert.equal(suggestItemCode('Flat White', taken), 'FLATWHITE');
  assert.equal(suggestItemCode('Caesar Salad', taken), 'CAESARSAL');
  assert.equal(suggestItemCode('Mac & Cheese', taken), 'MACCHEESE');
  assert.equal(suggestItemCode('Tea', taken), 'TEA');
});

test('Suggest adds a number when the code is already used', () => {
  const taken = takenItemCodes([{ id: 'm-1', name: 'Flat White', itemCode: 'FLATWHITE' }]);
  assert.equal(suggestItemCode('Flat White', taken), 'FLATWHITE2');
  taken.set('FLATWHITE2', { itemId: 'm-2', code: 'FLATWHITE2', name: 'Other' });
  assert.equal(suggestItemCode('Flat White', taken), 'FLATWHITE3');
});

test('Suggest keeps the product its OWN code rather than numbering it', () => {
  const taken = takenItemCodes(ITEMS);
  assert.equal(suggestItemCode('Flat White', taken, 'm-flat'), 'FLATWHITE');
});

test('Suggest always lands inside 3 to 16 characters, or gives nothing', () => {
  const taken = new Map();
  assert.equal(suggestItemCode('PB', taken), 'PB1');
  assert.equal(suggestItemCode('A', taken), 'A01');
  assert.ok(suggestItemCode('Chocolate Chip Cookies', taken).length <= ITEM_CODE_MAX);
  for (const name of ['', '   ', '!!!', null, undefined]) {
    assert.equal(suggestItemCode(name, taken), '', 'nothing to build from means no suggestion');
  }
  const all = suggestItemCode('Flat White', taken);
  assert.ok(all.length >= ITEM_CODE_MIN && /^[A-Z0-9]+$/.test(all));
});

// ── what a person typed ─────────────────────────────────────────────────────

test('checkItemCode: a clean code comes back normalised', () => {
  const r = checkItemCode(' short-black ', { items: ITEMS, itemId: 'm-new' });
  assert.equal(r.code, 'SHORTBLACK');
  assert.equal(r.error, null);
  // And the same typing on the product that already holds it is not a clash.
  assert.equal(checkItemCode(' flat-white ', { items: ITEMS, itemId: 'm-flat' }).code, 'FLATWHITE');
});

test('checkItemCode: an empty box is a cleared code, never an error', () => {
  for (const blank of ['', '   ', null, undefined, '!!!']) {
    assert.deepEqual(checkItemCode(blank, { items: ITEMS }), { code: null, error: null });
  }
});

test('checkItemCode: too short is refused in plain words', () => {
  const r = checkItemCode('PB', { items: ITEMS });
  assert.equal(r.code, null);
  assert.match(r.error, /at least 3/);
});

test('checkItemCode: a duplicate at this venue is refused, and names the holder', () => {
  const r = checkItemCode('flatwhite', { items: ITEMS, itemId: 'm-tea' });
  assert.equal(r.code, null);
  assert.match(r.error, /Flat White/);
  // The product's own code is not a duplicate of itself.
  assert.equal(checkItemCode('FLATWHITE', { items: ITEMS, itemId: 'm-flat' }).code, 'FLATWHITE');
});

test('checkItemCode: a code held by an ARCHIVED product is still a duplicate', () => {
  // The database's partial unique index does not care about archived, so if
  // this said yes the save would be refused and the code silently lost.
  const r = checkItemCode('OLDCODE', {
    items: ITEMS, itemId: 'm-tea', codesById: { 'm-archived': 'OLDCODE' },
  });
  assert.equal(r.code, null);
  assert.match(r.error, /already uses that code/);
});

// ── handing the codes over ──────────────────────────────────────────────────

test('itemCodeRows: only products with a code, archived left out, by name', () => {
  const rows = itemCodeRows([
    ...ITEMS,
    { id: 'm-gone', menuName: 'Retired Wrap', itemCode: 'WRAP1', archived: true },
    { id: 'm-abc', menuName: 'Americano', itemCode: 'AMERICANO' },
  ]);
  assert.deepEqual(rows, [
    { name: 'Americano', code: 'AMERICANO' },
    { name: 'Caesar Salad', code: 'CAESARSAL' },
    { name: 'Flat White', code: 'FLATWHITE' },
  ]);
});

test('itemCodesText: a header and one tab separated row per product', () => {
  const text = itemCodesText(ITEMS);
  const lines = text.split('\n');
  assert.equal(lines[0], ITEM_CODE_LIST_HEADER.join('\t'));
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'Caesar Salad\tCAESARSAL');
  assert.equal(lines[2], 'Flat White\tFLATWHITE');
  assert.equal(itemCodesText([]), '', 'nothing to hand over is an empty string, not a lonely header');
});

// ── living without the column ───────────────────────────────────────────────

test('isMissingItemCodeColumn knows its own column and no other', () => {
  assert.ok(isMissingItemCodeColumn({ code: 'PGRST204', message: "Could not find the 'item_code' column of 'menu_items' in the schema cache" }));
  assert.ok(isMissingItemCodeColumn({ code: '42703', message: 'column menu_items.item_code does not exist' }));
  assert.ok(!isMissingItemCodeColumn({ code: 'PGRST204', message: "Could not find the 'tax_profile_id' column" }));
  assert.ok(!isMissingItemCodeColumn({ code: '23505', message: 'duplicate key value violates unique constraint "menu_items_item_code_unique"' }));
  assert.ok(!isMissingItemCodeColumn(null));
});

test('isDuplicateItemCodeError knows the unique index', () => {
  assert.ok(isDuplicateItemCodeError({ code: '23505', message: 'duplicate key value violates unique constraint "menu_items_item_code_unique"' }));
  assert.ok(!isDuplicateItemCodeError({ code: '23505', message: 'duplicate key value violates unique constraint "menu_items_pkey"' }));
  assert.ok(!isDuplicateItemCodeError({ code: '42703', message: 'column menu_items.item_code does not exist' }));
  assert.ok(!isDuplicateItemCodeError(null));
});

// A Supabase client small enough to be obvious and honest about what it did.
function fakeSb(answer) {
  const calls = [];
  const b = {
    select(cols) { calls.push(cols); return b; },
    eq() { return b; },
    order() { return b; },
    limit() { return b; },
    then(ok, no) { return Promise.resolve().then(() => answer()).then(ok, no); },
  };
  return { from: () => b, calls };
}

test('loadItemCodes: the codes, archived rows and all', async () => {
  const sb = fakeSb(() => ({
    data: [
      { id: 'm-flat', item_code: 'FLATWHITE' },
      { id: 'm-gone', item_code: 'OLDCODE' },
      { id: 'm-tea', item_code: null },
    ],
    error: null,
  }));
  const r = await loadItemCodes(sb, 'loc-1');
  assert.equal(r.supported, true);
  assert.equal(r.codes.get('m-flat'), 'FLATWHITE');
  assert.equal(r.codes.get('m-gone'), 'OLDCODE');
  assert.equal(r.codes.has('m-tea'), false);
});

test('loadItemCodes: no column means not supported, and no error to stare at', async () => {
  const sb = fakeSb(() => ({ data: null, error: { code: '42703', message: 'column menu_items.item_code does not exist' } }));
  const r = await loadItemCodes(sb, 'loc-1');
  assert.equal(r.supported, false, 'the field is simply not rendered');
  assert.equal(r.codes.size, 0);
});

test('loadItemCodes: any other failure still leaves the field working', async () => {
  const sb = fakeSb(() => ({ data: null, error: { message: 'timeout' } }));
  const r = await loadItemCodes(sb, 'loc-1');
  assert.equal(r.supported, true, 'a timeout is not a missing column');
  assert.equal(r.codes.size, 0);
});

// ── the writers, at the source ──────────────────────────────────────────────
// These two are source assertions on purpose. The behaviour they pin cannot be
// reached from a unit test (one needs Supabase, the other needs a browser), and
// both are the kind of thing a later edit breaks silently.

test('db.js writes item_code only when the item carries it, and never loses a save', () => {
  const db = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  // Touched fields discipline: an item loaded before the column existed carries
  // no field, and its save must leave the column alone rather than null a code.
  assert.ok(/item\.itemCode !== undefined \|\| item\.item_code !== undefined/.test(db),
    'item_code is written unconditionally, which nulls codes from older loads');
  // A RENAME MUST NEVER TOUCH THE CODE: nothing derives it from a name.
  assert.ok(/item_code: itemCodeForSave\(item\.itemCode \?\? item\.item_code\)/.test(db),
    'item_code is built from something other than the code itself');
  assert.ok(!/item_code:\s*_displayName/.test(db));
  // And the item is saved again without the code when the code alone is refused.
  assert.ok(db.includes('isMissingItemCodeColumn(result.error) || isDuplicateItemCodeError(result.error)'),
    'a refused code would take the whole menu save down with it');
  assert.ok(/delete retry\.item_code/.test(db));
});

test('the Back Office field is hidden until the column exists, and writes once', () => {
  const jsx = fs.readFileSync(new URL('../backoffice/sections/MenuManager.jsx', import.meta.url), 'utf8');
  assert.ok(jsx.includes('{codesOn && ('), 'the field is not gated on the column existing');
  assert.ok(jsx.includes('loadItemCodes('), 'nothing detects the column');
  assert.ok(jsx.includes('>Suggest<') || /Suggest\s*\n\s*<\/button>/.test(jsx), 'the Suggest button is gone');
  // One writer. A rename goes through menuName and never near the code.
  assert.equal((jsx.match(/f\('itemCode'/g) || []).length, 1);
});

test('loadItemCodes never throws, whatever it is handed', async () => {
  const thrower = { from: () => { throw new Error('socket hang up'); } };
  const r = await loadItemCodes(thrower, 'loc-1');
  assert.equal(r.codes.size, 0);
  assert.deepEqual((await loadItemCodes(null, 'loc-1')).codes.size, 0);
  assert.deepEqual((await loadItemCodes({}, '')).codes.size, 0);
});
