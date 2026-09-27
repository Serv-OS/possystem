// Kitchen docket: the guest's DECLARED allergies (26 Sep 2026). Peter: "even if allergies are
// not on products, when allergies are selected it should come up on the KDS and the ticket
// printed". item.allergy is stamped by the till (src/lib/kds/kdsTicket.js ticketAllergy); the
// docket shows it as a red banner up top and a double height red line under the item, whatever
// item.allergens (the product's data) says. Byte identity for a docket with no declared allergy
// is printer.golden.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKitchenTicketDoc, kitchenAllergyBanner, buildTransferNoticeTicketDoc, buildAllergyUpdateTicketDoc, buildFireCourseTicketDoc } from './printDoc.js';

const texts = (doc) => doc.ops.filter(o => o.t === 'text').map(o => o.s);

// The style in force when a text op is emitted, read the way the raster renderer reads the ops
// (printerDialects.js: `normal` resets bold, size, underline and alignment, never the colour).
function styleAt(doc, predicate) {
  let st = { bold: false, size: 'normal', red: false, underline: false, align: 'left' };
  for (const op of doc.ops) {
    if (op.t === 'bold') st = { ...st, bold: op.on };
    else if (op.t === 'size') st = { ...st, size: op.v };
    else if (op.t === 'normal') st = { ...st, bold: false, size: 'normal', underline: false, align: 'left' };
    else if (op.t === 'color') st = { ...st, red: op.v === 'red' };
    else if (op.t === 'underline') st = { ...st, underline: op.on };
    else if (op.t === 'align') st = { ...st, align: op.v };
    else if (op.t === 'text' && predicate(op.s)) return st;
  }
  return null;
}

const ITEMS = [
  // The Coffee Boy case: no product allergen data at all, the guest declared tree nuts and milk.
  { name: 'Flat white', qty: 1, course: 1, fired: true, mods: ['Oat milk'], allergy: 'TREE NUTS · MILK' },
  { name: 'Croissant', qty: 2, course: 1, fired: true },
];

test('kitchenAllergyBanner: each allergy once across the lines, null when nobody declared one', () => {
  assert.equal(kitchenAllergyBanner(ITEMS), 'TREE NUTS · MILK');
  assert.equal(kitchenAllergyBanner([{ allergy: 'milk' }, { allergy: 'TREE NUTS · MILK' }]), 'MILK · TREE NUTS');
  assert.equal(kitchenAllergyBanner([{ name: 'Latte', allergens: ['milk'] }]), null);   // product data is not a declaration
  assert.equal(kitchenAllergyBanner([]), null);
  assert.equal(kitchenAllergyBanner(null), null);
});

test('the docket prints a red banner and a red double height line under the item, with no product allergen data', () => {
  const doc = buildKitchenTicketDoc({ table: 'T7', server: 'Jane', covers: 2, centreName: 'Kitchen', sentAt: 0, items: ITEMS }, { cols: 42 });
  const t = texts(doc);
  assert.ok(t.includes('!! ALLERGY !!'), 'banner header');
  const banner = t.indexOf('TREE NUTS · MILK');
  assert.ok(banner > -1 && banner < t.indexOf('FLAT WHITE'), 'banner list prints before the food');
  const under = t.indexOf('  ALLERGY: TREE NUTS · MILK');
  assert.ok(under > t.indexOf('FLAT WHITE') && under > t.indexOf('  Oat milk') && under < t.indexOf('2x CROISSANT'), 'under its own item, after its mods');
  assert.deepEqual(styleAt(doc, s => s === '!! ALLERGY !!'), { bold: true, size: 'both', red: true, underline: false, align: 'center' });
  assert.deepEqual(styleAt(doc, s => s === 'TREE NUTS · MILK'), { bold: true, size: 'height', red: true, underline: false, align: 'center' });
  assert.deepEqual(styleAt(doc, s => s === '  ALLERGY: TREE NUTS · MILK'), { bold: true, size: 'height', red: true, underline: false, align: 'left' });
  // Back to black before the next line.
  assert.equal(styleAt(doc, s => s === '2x CROISSANT').red, false);
});

test('a docket with no declared allergy has no ALLERGY text at all', () => {
  const plain = ITEMS.map(it => { const copy = { ...it }; delete copy.allergy; return copy; });
  const doc = buildKitchenTicketDoc({ table: 'T7', centreName: 'Kitchen', sentAt: 0, items: plain }, { cols: 42 });
  assert.ok(!texts(doc).some(s => /ALLERGY/.test(s)));
  // The store's printAllergens strip removes "⚠" product mods; a declared allergy is not a mod, so it stays.
  const stripped = ITEMS.map(it => ({ ...it, mods: (it.mods || []).filter(m => !String(m).startsWith('⚠')) }));
  assert.ok(texts(buildKitchenTicketDoc({ table: 'T7', centreName: 'Kitchen', sentAt: 0, items: stripped }, { cols: 42 })).includes('  ALLERGY: TREE NUTS · MILK'));
});

// ── v2 (26 Sep 2026): the table move docket ─────────────────────────────────────
// Peter asked for the allergy "under the item"; the move docket (TABLE MOVED) lists the moved
// items for the kitchen, so it prints the same red double height line the kitchen docket does.
test('the table move docket prints the declared allergy under its item, and none when nobody declared one', () => {
  const moved = [
    { name: 'Flat white', qty: 1, mods: ['Oat milk'], allergy: 'TREE NUTS · MILK' },
    { name: 'Croissant', qty: 2 },
  ];
  const doc = buildTransferNoticeTicketDoc({ fromTable: 'T2', toTable: 'T7', centreName: 'Kitchen', server: 'Jane', sentAt: 0, items: moved }, { cols: 42 });
  const t = texts(doc);
  const under = t.indexOf('  ALLERGY: TREE NUTS · MILK');
  assert.ok(under > t.indexOf('1 × Flat white') && under > t.indexOf('  · Oat milk') && under < t.indexOf('2 × Croissant'), 'under its own item, after its mods');
  assert.deepEqual(styleAt(doc, s => s === '  ALLERGY: TREE NUTS · MILK'), { bold: true, size: 'height', red: true, underline: false, align: 'left' });
  assert.equal(styleAt(doc, s => s === '2 × Croissant').red, false);   // back to black for the next line
  // A lower case stamp prints in capitals, like the kitchen docket.
  assert.ok(texts(buildTransferNoticeTicketDoc({ fromTable: 'T2', toTable: 'T7', sentAt: 0, items: [{ name: 'Soup', qty: 1, allergy: 'celery' }] }, { cols: 42 })).includes('  ALLERGY: CELERY'));
  // Nobody declared one: no ALLERGY text at all (byte identity is printer.golden.test.js).
  const plain = moved.map(it => { const copy = { ...it }; delete copy.allergy; return copy; });
  assert.ok(!texts(buildTransferNoticeTicketDoc({ fromTable: 'T2', toTable: 'T7', sentAt: 0, items: plain }, { cols: 42 })).some(s => /ALLERGY/.test(s)));
});

// ── v5 (26 Sep 2026): an allergy declared after the kitchen got the order ──────────────
// The review of v4: a guest who mentions an allergy during starters got mains cooked from a
// ticket with none. The store prints an ALLERGY UPDATE docket (tellKitchenAllergy) and the held
// course's fire docket carries the allergy.
test('the ALLERGY UPDATE docket: says it is not a new order, the allergy big and red, the food it applies to', () => {
  const items = [
    { qty: 1, name: 'Soup', course: 1, allergy: 'TREE NUTS' },
    { qty: 2, name: 'Steak', course: 2, allergy: 'TREE NUTS' },
  ];
  const doc = buildAllergyUpdateTicketDoc({ table: 'T7', centreName: 'Kitchen', allergy: 'TREE NUTS', added: 'TREE NUTS', items, server: 'Jane', sentAt: 0 }, { cols: 42 });
  const t = texts(doc);
  assert.ok(t.includes('!! ALLERGY UPDATE !!'));
  assert.ok(t.includes('TABLE T7'));
  assert.ok(t.includes('NOT A NEW ORDER'));
  assert.ok(t.includes('ALLERGY: TREE NUTS'));
  assert.ok(!t.some(s => s.startsWith('NEW: ')), 'no NEW line when everything is new');
  const soup = t.indexOf('1 × Soup');
  assert.ok(soup > -1 && t.indexOf('  ALLERGY: TREE NUTS', soup) > soup && t.indexOf('  ALLERGY: TREE NUTS', soup) < t.indexOf('2 × Steak'));
  assert.deepEqual(styleAt(doc, s => s === '!! ALLERGY UPDATE !!'), { bold: true, size: 'both', red: true, underline: false, align: 'center' });
  assert.deepEqual(styleAt(doc, s => s === 'ALLERGY: TREE NUTS'), { bold: true, size: 'height', red: true, underline: false, align: 'center' });
  assert.deepEqual(styleAt(doc, s => s === '  ALLERGY: TREE NUTS'), { bold: true, size: 'height', red: true, underline: false, align: 'left' });
  assert.equal(styleAt(doc, s => s === '2 × Steak').red, false, 'back to black for the next line');
  // Milk added to a kitchen that already had tree nuts: the NEW line says which.
  const more = texts(buildAllergyUpdateTicketDoc({ table: 'Takeaway · Sam', allergy: 'TREE NUTS · MILK', added: 'MILK', items: [{ qty: 1, name: 'Latte' }], sentAt: 0 }, { cols: 42 }));
  assert.ok(more.includes('Takeaway · Sam'), 'a walk in label prints as is');
  assert.ok(more.includes('NEW: MILK'));
  assert.ok(more.includes('  ALLERGY: TREE NUTS · MILK'), 'a line without its own stamp shows the whole allergy');
});

test('the fire course docket carries the order\'s allergy, and prints as before without one', () => {
  const t = texts(buildFireCourseTicketDoc({ table: 'T7', courseNum: 2, centreName: 'Kitchen', sentAt: 0, allergy: 'tree nuts' }, { cols: 42 }));
  assert.ok(t.indexOf('ALLERGY: TREE NUTS') > t.indexOf('FIRE COURSE 2'));
  const doc = buildFireCourseTicketDoc({ table: 'T7', courseNum: 2, centreName: 'Kitchen', sentAt: 0, allergy: 'TREE NUTS' }, { cols: 42 });
  assert.deepEqual(styleAt(doc, s => s === 'ALLERGY: TREE NUTS'), { bold: true, size: 'height', red: true, underline: false, align: 'center' });
  assert.ok(!texts(buildFireCourseTicketDoc({ table: 'T7', courseNum: 2, centreName: 'Kitchen', sentAt: 0 }, { cols: 42 })).some(s => /ALLERGY/.test(s)));
});
