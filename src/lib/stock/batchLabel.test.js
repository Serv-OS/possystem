// Multi site stock Drop 2: the batch label and the PPDS label (src/lib/stock/batchLabel.js).
// Synthetic names only (public repo). Every date is given in words on the venue's clock, so a
// Back Office opened in another time zone prints the kitchen's time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as L from './batchLabel.js';
import { ALLERGENS } from '../../data/seed.js';
import { UK_ALLERGENS } from '../kioskAllergens.js';
import { encodeEscPos, resolvePrinterSpec } from '../printerDialects.js';

const TZ = 'Europe/London';
const MADE = '2026-10-21T13:05:00Z';   // 14:05 London (BST)
const latin = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');

// ── words ──
test('the three fixed lines are the contract words, with no long dash anywhere in the file', () => {
  assert.equal(L.PPDS_NOT_SIGNED_OFF, 'Check the allergens first. The label prints once the recipe is checked.');
  assert.equal(L.NO_LABEL_PRINTER, 'No label printer set up. Add one under Hardware, Printers, with the Label printer role.');
  assert.equal(L.LABEL_ROLE_WORDS, 'Labels print on the Label printer role (Hardware, Printers).');
  const src = fs.readFileSync(new URL('./batchLabel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/, 'no em or en dash');
});

test('allergen labels are the seed labels word for word, and the order is the kiosk sheet order', () => {
  for (const a of ALLERGENS) assert.equal(L.allergenLabel(a.id), a.label, a.id);
  assert.deepEqual([...L.ALLERGEN_ORDER], [...UK_ALLERGENS]);
  assert.equal(Object.keys(L.ALLERGEN_LABELS).length, 14);
  assert.equal(L.allergenLabel('NUTS'), 'Tree nuts');
  assert.equal(L.allergenLabel('paprika'), 'Paprika', 'an id ServOS does not know is shown as typed');
  assert.equal(L.allergenLabel(''), '');
  assert.equal(L.allergenLabel(null), '');
});

test('orderAllergens: once each, the 14 first in order, then others alphabetically', () => {
  assert.deepEqual(L.orderAllergens(['sesame', 'Milk', 'milk', 'zzz', 'gluten', 'abc', '']), ['gluten', 'milk', 'sesame', 'abc', 'zzz']);
  assert.deepEqual(L.orderAllergens(null), []);
  assert.deepEqual(L.orderAllergens([]), []);
});

test('allergenWords: the labels in order, or none', () => {
  assert.equal(L.allergenWords(['milk', 'gluten']), 'Allergens: Gluten, Milk');
  assert.equal(L.allergenWords(['nuts']), 'Allergens: Tree nuts');
  assert.equal(L.allergenWords([]), 'Allergens: none');
  assert.equal(L.allergenWords(undefined), 'Allergens: none');
});

test('madeWords and expiryLine speak the venue clock; nothing gives nothing', () => {
  assert.equal(L.madeWords(MADE, TZ), 'Made 21 Oct 2026 14:05');
  assert.equal(L.madeWords(MADE, 'America/Los_Angeles'), 'Made 21 Oct 2026 06:05');
  assert.equal(L.madeWords(null, TZ), '');
  assert.equal(L.madeWords('not a date', TZ), '');
  assert.equal(L.expiryLine('2026-10-23', TZ), 'Use by 23 Oct 2026');
  assert.equal(L.expiryLine('2026-10-23T23:30:00Z', TZ), 'Use by 24 Oct 2026', 'an instant is the venue day it falls on');
  assert.equal(L.expiryLine('', TZ), '');
  assert.equal(L.expiryLine(null, TZ), '');
});

test('useByFrom: the venue day the batch was made plus the shelf life; none without a shelf life', () => {
  assert.equal(L.useByFrom(MADE, 2, TZ), '2026-10-23');
  assert.equal(L.useByFrom(MADE, 0, TZ), '2026-10-21');
  assert.equal(L.useByFrom(MADE, 2.9, TZ), '2026-10-23', 'whole days only');
  assert.equal(L.useByFrom('2026-10-21T23:30:00Z', 1, TZ), '2026-10-23', 'made after midnight London is the next London day');
  assert.equal(L.useByFrom('2026-10-21T23:30:00Z', 1, 'America/Los_Angeles'), '2026-10-22');
  assert.equal(L.useByFrom(MADE, null, TZ), null);
  assert.equal(L.useByFrom(MADE, '', TZ), null);
  assert.equal(L.useByFrom(MADE, -1, TZ), null);
  assert.equal(L.useByFrom(MADE, 'x', TZ), null);
  assert.equal(L.useByFrom(null, 2, TZ), null);
});

test('labelCols: 58 mm paper is 32 columns, 80 mm is 42, a printer that says its columns wins', () => {
  assert.equal(L.labelCols({ paperWidth: 58 }), 32);
  assert.equal(L.labelCols({ paper_width: 58 }), 32);
  assert.equal(L.labelCols({ paper: 58 }), 32);
  assert.equal(L.labelCols({ paperWidth: 80 }), 42);
  assert.equal(L.labelCols(null), 42);
  assert.equal(L.labelCols({ cols: 48 }), 48);
  assert.equal(L.labelCols({ cols: 3, paperWidth: 58 }), 32, 'a silly column count is ignored');
  assert.equal(L.labelCols({ cols: resolvePrinterSpec({ model: 'sunmi-nt310' }).cols }), 32, 'a 58 mm model through the spec');
});

test('qtyWords: a number and its unit, three decimals at most, nothing for nothing', () => {
  assert.equal(L.qtyWords(2.5, 'L'), '2.5 L');
  assert.equal(L.qtyWords('12', 'each'), '12 each');
  assert.equal(L.qtyWords(0.33333, 'kg'), '0.333 kg');
  assert.equal(L.qtyWords(4, ''), '4');
  assert.equal(L.qtyWords('', 'L'), '');
  assert.equal(L.qtyWords(null, 'L'), '');
  assert.equal(L.qtyWords('abc', 'L'), '');
});

// ── the declaration ──
test('declarationSegments: *word* spans are bold, a lone star is text, same bold merges', () => {
  assert.deepEqual(L.declarationSegments('Flour (*wheat*), water, *milk*, salt'), [
    { s: 'Flour (', bold: false }, { s: 'wheat', bold: true }, { s: '), water, ', bold: false }, { s: 'milk', bold: true }, { s: ', salt', bold: false },
  ]);
  assert.deepEqual(L.declarationSegments('5* rated'), [{ s: '5* rated', bold: false }]);
  assert.deepEqual(L.declarationSegments('a ** b'), [{ s: 'a ** b', bold: false }], 'an empty span is kept as typed');
  assert.deepEqual(L.declarationSegments('*milk*'), [{ s: 'milk', bold: true }]);
  assert.deepEqual(L.declarationSegments(''), []);
  assert.deepEqual(L.declarationSegments(null), []);
});

test('wrapSegments: words wrap at the column count, bold follows each word, long words are cut', () => {
  const lines = L.wrapSegments([{ s: 'Ingredients: ', bold: false }, { s: 'wheat', bold: true }, { s: ' flour, water, ', bold: false }, { s: 'milk', bold: true }], 20);
  const text = lines.map((l) => l.map((s) => s.s).join(''));
  assert.deepEqual(text, ['Ingredients: wheat', 'flour, water, milk']);
  for (const t of text) assert.ok(t.length <= 20, t);
  assert.deepEqual(lines[0], [{ s: 'Ingredients: ', bold: false }, { s: 'wheat', bold: true }]);
  assert.deepEqual(lines[1], [{ s: 'flour, water, ', bold: false }, { s: 'milk', bold: true }]);
  const long = L.wrapSegments([{ s: 'a'.repeat(45), bold: true }], 20).map((l) => l.map((s) => s.s).join(''));
  assert.deepEqual(long, ['a'.repeat(20), 'a'.repeat(20), 'aaaaa']);
  assert.deepEqual(L.wrapSegments([], 20), [[]]);
  assert.deepEqual(L.wrapSegments([{ s: 'one two three', bold: false }], 3).map((l) => l.map((s) => s.s).join('')), ['one two', 'three'], 'the smallest width is 8');
});

test('wrapSegments never leaves a trailing space or a leading space on a wrapped line', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => 'w'.repeat(1 + Math.floor(rnd() * 14)));
    const segs = words.map((w, k) => ({ s: (k ? ' ' : '') + w, bold: rnd() < 0.5 }));
    const cols = 16 + Math.floor(rnd() * 30);
    for (const line of L.wrapSegments(segs, cols)) {
      const t = line.map((s) => s.s).join('');
      assert.ok(t.length <= cols, `${t} fits ${cols}`);
      assert.ok(!/^\s|\s$/.test(t), `no edge space: "${t}"`);
    }
  }
});

// ── the batch label ──
const BATCH = { name: 'Test sauce', madeAt: MADE, useBy: '2026-10-23', allergens: ['milk', 'mustard'], madeBy: 'Jane Tester', lot: 'A12', qty: 2.5, unit: 'L', venueTz: TZ };

test('batchLabelDoc: the lines of the words table, in order, with a cut', () => {
  const doc = L.batchLabelDoc(BATCH, { cols: 32 });
  assert.equal(doc.cols, 32);
  assert.deepEqual(L.labelText(doc), [
    'Test sauce', 'Made 21 Oct 2026 14:05', 'Use by 23 Oct 2026', 'Allergens: Milk, Mustard', 'Made by Jane Tester', 'Lot A12', '2.5 L',
  ]);
  assert.equal(doc.ops.filter((o) => o.t === 'cut').length, 1);
  const lines = L.labelLines(doc);
  assert.deepEqual(lines[0].segs, [{ s: 'Test sauce', bold: true, big: true }], 'the name is bold and double height');
  assert.deepEqual(lines[2].segs, [{ s: 'Use by 23 Oct 2026', bold: true, big: false }], 'the use by day is bold');
  assert.deepEqual(lines[1].segs, [{ s: 'Made 21 Oct 2026 14:05', bold: false, big: false }]);
  assert.ok(!JSON.stringify(doc).match(/cost|price|£/i), 'never cost or a price');
});

test('batchLabelDoc leaves off a line with nothing to say, and says Allergens: none', () => {
  const doc = L.batchLabelDoc({ name: 'Test stock', madeAt: MADE, venueTz: TZ }, { cols: 32 });
  assert.deepEqual(L.labelText(doc), ['Test stock', 'Made 21 Oct 2026 14:05', 'Allergens: none']);
  assert.deepEqual(L.labelText(L.batchLabelDoc({}, { cols: 32 })), ['Batch', 'Allergens: none']);
});

test('batchLabelDoc wraps a long name at the printer columns and prints on a 58 mm ESC/POS printer', () => {
  const doc = L.batchLabelDoc({ ...BATCH, name: 'Test slow cooked sauce with roasted peppers and herbs' }, { cols: 32 });
  const text = L.labelText(doc);
  assert.equal(text[0], 'Test slow cooked sauce with');
  assert.equal(text[1], 'roasted peppers and herbs');
  for (const t of text) assert.ok(t.length <= 32, t);
  const bytes = encodeEscPos(doc, resolvePrinterSpec({ model: 'sunmi-nt310' }));
  const out = latin(bytes);
  assert.ok(out.includes('Made 21 Oct 2026 14:05\n'));
  assert.ok(out.includes('Lot A12\n'));
  assert.ok(out.includes('\x1bV') || out.includes('\x1dV'), 'ends with a cut');
});

test('batchLabelDoc at 42 columns keeps the same words, wider lines', () => {
  const doc = L.batchLabelDoc({ ...BATCH, name: 'Test slow cooked sauce with roast peppers' }, { cols: 42 });
  assert.equal(doc.cols, 42);
  assert.equal(L.labelText(doc)[0], 'Test slow cooked sauce with roast peppers');
});

// ── the PPDS label ──
const PPDS = { name: 'Test chicken sandwich', ingredientsText: 'Bread (*wheat* flour, water, yeast, salt), chicken (34%), mayonnaise (*egg*), lettuce', allergens: ['gluten', 'eggs'], madeAt: MADE, useBy: '2026-10-22', venueTz: TZ, signedOff: true };

test('ppdsLabelDoc refuses with the contract words until the facts are checked at the site', () => {
  assert.deepEqual(L.ppdsLabelDoc({ ...PPDS, signedOff: false }, { cols: 32 }), { error: L.PPDS_NOT_SIGNED_OFF });
  assert.deepEqual(L.ppdsLabelDoc({ ...PPDS, signedOff: undefined }, { cols: 32 }), { error: L.PPDS_NOT_SIGNED_OFF });
  assert.deepEqual(L.ppdsLabelDoc({ ...PPDS, signedOff: 'yes' }, { cols: 32 }), { error: L.PPDS_NOT_SIGNED_OFF }, 'only true is signed off');
  assert.deepEqual(L.ppdsLabelDoc(undefined, { cols: 32 }), { error: L.PPDS_NOT_SIGNED_OFF });
});

test('ppdsLabelDoc: the name, Ingredients with the allergens in bold, Allergens, Use by, Made', () => {
  const doc = L.ppdsLabelDoc(PPDS, { cols: 32 });
  const text = L.labelText(doc);
  assert.equal(text[0], 'Test chicken sandwich');
  assert.ok(text[1].startsWith('Ingredients: Bread (wheat'), text[1]);
  for (const t of text) assert.ok(t.length <= 32, t);
  const joined = text.join(' ');
  assert.ok(joined.includes('Bread (wheat flour, water, yeast, salt), chicken (34%), mayonnaise (egg), lettuce'));
  assert.ok(!joined.includes('*'), 'the stars are gone');
  assert.ok(text.includes('Allergens: Gluten, Eggs'));
  assert.ok(text.includes('Use by 22 Oct 2026'));
  assert.ok(text.includes('Made 21 Oct 2026 14:05'));
  const bolds = L.labelLines(doc).flatMap((l) => l.segs.filter((s) => s.bold && !s.big).map((s) => s.s.trim()));
  assert.ok(bolds.includes('wheat') && bolds.includes('egg'), `the allergen words are bold: ${bolds.join('|')}`);
  assert.ok(bolds.includes('Use by 22 Oct 2026'));
  assert.ok(!bolds.some((s) => /Bread|lettuce|chicken/.test(s)), 'the other words are not');
  assert.equal(doc.ops.filter((o) => o.t === 'cut').length, 1);
  assert.ok(!JSON.stringify(doc).match(/cost|price|method/i));
});

test('ppdsLabelDoc with no declaration says none listed, and the ESC/POS bytes toggle bold mid line', () => {
  const doc = L.ppdsLabelDoc({ ...PPDS, ingredientsText: '' }, { cols: 32 });
  assert.equal(L.labelText(doc)[1], 'Ingredients: none listed');
  const full = L.ppdsLabelDoc(PPDS, { cols: 32 });
  const out = latin(encodeEscPos(full, resolvePrinterSpec({ model: 'sunmi-nt310' })));
  assert.ok(out.includes('Bread (\x1bE\x01wheat\x1bE\x00 flour'), 'bold on before wheat and off after it, in the same line');
});

// ── copies and the preview ──
test('repeatDoc: one job with the label n times (1 to 50), a refused doc stays refused', () => {
  const one = L.batchLabelDoc(BATCH, { cols: 32 });
  const three = L.repeatDoc(one, 3);
  assert.equal(three.ops.length, one.ops.length * 3);
  assert.equal(three.ops.filter((o) => o.t === 'cut').length, 3);
  assert.equal(three.cols, 32);
  assert.notEqual(three.ops[0], one.ops[0], 'copies, not the same op objects');
  assert.equal(L.repeatDoc(one, 0).ops.length, one.ops.length);
  assert.equal(L.repeatDoc(one, 'x').ops.length, one.ops.length);
  assert.equal(L.repeatDoc(one, 500).ops.length, one.ops.length * 50);
  assert.deepEqual(L.repeatDoc({ error: 'no' }, 3), { error: 'no' });
  assert.equal(L.repeatDoc(null, 3), null);
});

test('labelLines and labelText: blank lines kept inside, trailing feeds dropped, nothing for nothing', () => {
  const doc = { ops: [{ t: 'init' }, { t: 'bold', on: true }, { t: 'text', s: 'A' }, { t: 'bold', on: false }, { t: 'text', s: 'b' }, { t: 'lf', n: 2 }, { t: 'text', s: 'c' }, { t: 'lf', n: 1 }, { t: 'lf', n: 3 }, { t: 'cut' }], cols: 32 };
  assert.deepEqual(L.labelLines(doc), [
    { segs: [{ s: 'A', bold: true, big: false }, { s: 'b', bold: false, big: false }] },
    { segs: [] },
    { segs: [{ s: 'c', bold: false, big: false }] },
  ]);
  assert.deepEqual(L.labelText(doc), ['Ab', '', 'c']);
  assert.deepEqual(L.labelLines(null), []);
  assert.deepEqual(L.labelLines({ error: 'x' }), []);
  assert.deepEqual(L.labelText({ ops: [{ t: 'text', s: 'tail' }] }), ['tail'], 'text with no feed still shows');
});
