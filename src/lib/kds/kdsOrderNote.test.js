// The kitchen's own note on a ticket (30 Sep 2026): saved on every row of the order, capped, never
// touched by a till. See kdsOrderNote.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KDS_NOTE_MAX, SAME_SEND_WINDOW_MS, cleanKdsNote, kdsNoteOf, metaWithKdsNote, orderKeyOf, isSameOrder, rowsOfSameOrder,
} from './kdsOrderNote.js';
import { buildTicketMeta, ticketMeta } from './kdsTicket.js';

test('cleanKdsNote: tidies lines, drops blanks, caps at 200 characters, empty is null', () => {
  assert.equal(cleanKdsNote('  no   onions \n\n  extra hot  '), 'no onions\nextra hot');
  assert.equal(cleanKdsNote(''), null);
  assert.equal(cleanKdsNote('   \n  '), null);
  assert.equal(cleanKdsNote(null), null);
  assert.equal(cleanKdsNote(undefined), null);
  const long = 'x'.repeat(KDS_NOTE_MAX + 50);
  assert.equal(cleanKdsNote(long).length, KDS_NOTE_MAX);
  assert.equal(KDS_NOTE_MAX, 200);
});

test('kdsNoteOf reads the raw column only, and ignores junk', () => {
  assert.equal(kdsNoteOf({ v: 1, kdsNote: 'plate it up' }), 'plate it up');
  assert.equal(kdsNoteOf({ v: 1 }), null);
  assert.equal(kdsNoteOf({ kdsNote: '   ' }), null);
  assert.equal(kdsNoteOf({ kdsNote: 42 }), null);
  assert.equal(kdsNoteOf(null), null);
  assert.equal(kdsNoteOf([]), null);
  assert.equal(kdsNoteOf('string'), null);
});

test('metaWithKdsNote keeps every other key and removes the note when cleared', () => {
  const raw = { v: 1, channel: 'till', orderNo: '97', ref: 'R32697', note: '15' };
  const withNote = metaWithKdsNote(raw, 'oat milk');
  assert.deepEqual(withNote, { ...raw, kdsNote: 'oat milk' });
  assert.deepEqual(raw, { v: 1, channel: 'till', orderNo: '97', ref: 'R32697', note: '15' }, 'the input is not changed');
  assert.deepEqual(metaWithKdsNote(withNote, null), raw);
  assert.deepEqual(metaWithKdsNote(withNote, '   '), raw);
  // A legacy row with no meta gets just the note: ticketMeta then still reads the row from its label.
  assert.deepEqual(metaWithKdsNote(null, 'x'), { kdsNote: 'x' });
});

test('the kitchen note survives the meta normalisation the board applies (read from raw, never from ticketMeta)', () => {
  const raw = { ...buildTicketMeta({ channel: 'till', orderType: 'takeaway', customerName: 'Sam', orderRef: 'R32697' }), kdsNote: 'no lid' };
  const norm = ticketMeta({ meta: raw });
  assert.equal(norm.ref, 'R32697', 'the full ref rides through ticketMeta');
  assert.equal(norm.orderNo, '97');
  assert.equal(kdsNoteOf(raw), 'no lid');
});

test('orderKeyOf: an order with a ref is matched by ref, a table send by label and time', () => {
  assert.deepEqual(orderKeyOf({ id: 'a', meta: { ref: 'R32697' }, table: 'Takeaway · Sam', sentAt: 1 }), { kind: 'ref', ref: 'R32697' });
  assert.deepEqual(orderKeyOf({ id: 'a', meta: { ref: null }, table: 'T1', sentAt: 1000 }), { kind: 'send', tableLabel: 'T1', sentAt: 1000 });
  assert.equal(orderKeyOf({ id: 'a', meta: {}, table: '', sentAt: 1000 }), null);
  assert.equal(orderKeyOf(null), null);
});

test('isSameOrder: the food and drinks rows of one order match, other orders do not', () => {
  const food = { id: 'kds-1-pc1-aaaa', meta: { ref: 'R32697' }, table: 'Takeaway · Sam', sentAt: 1000 };
  const drinks = { id: 'kds-1-pc2-bbbb', meta: { ref: 'R32697' }, table: 'Takeaway · Sam', sentAt: 1000 };
  const other = { id: 'kds-2-pc1-cccc', meta: { ref: 'R32698' }, table: 'Takeaway · Sam', sentAt: 1000 };
  assert.equal(isSameOrder(food, drinks), true);
  assert.equal(isSameOrder(food, other), false, 'same name and time, different ref: a different order');
  assert.equal(isSameOrder(food, food), true);
  // Table sends: same label within the window is the same send; a later send of the same table is not.
  const t1a = { id: 'x', meta: { ref: null }, table: 'T1', sentAt: 5000 };
  const t1b = { id: 'y', meta: { ref: null }, table: 'T1', sentAt: 5000 + SAME_SEND_WINDOW_MS };
  const t1later = { id: 'z', meta: { ref: null }, table: 'T1', sentAt: 5000 + SAME_SEND_WINDOW_MS + 1 };
  const t2 = { id: 'w', meta: { ref: null }, table: 'T2', sentAt: 5000 };
  assert.equal(isSameOrder(t1a, t1b), true);
  assert.equal(isSameOrder(t1a, t1later), false);
  assert.equal(isSameOrder(t1a, t2), false);
  // A ref order never matches a table send, whatever the label.
  assert.equal(isSameOrder(food, { id: 'q', meta: {}, table: 'Takeaway · Sam', sentAt: 1000 }), false);
});

test('rowsOfSameOrder always includes the ticket itself', () => {
  const t = { id: 'a', meta: { ref: 'R1' }, table: 'x', sentAt: 1 };
  const rows = rowsOfSameOrder(t, [{ id: 'b', meta: { ref: 'R1' } }, { id: 'c', meta: { ref: 'R2' } }]);
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(rowsOfSameOrder(t, []).map(r => r.id), ['a']);
});
