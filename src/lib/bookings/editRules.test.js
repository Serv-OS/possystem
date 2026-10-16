/**
 * editRules.test.js: editing a booking (16 Oct 2026). Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bookingRefusalWords,
  editRefusal, validateEdit, conflictsFor, paymentAfterEdit,
  snapToSlot, shiftTables, slotTimes, stampEdit, editedLine, hasGuest, describeChanges,
} from './editRules.js';
import { toMin } from './optimiser.js';

const T = (id, covers, label = id.toUpperCase()) => ({ id, label, covers });
const TABLES = [T('t1', 2), T('t2', 2), T('t4', 4), T('t8', 8)];
const RULES = { serviceStart: '17:00', serviceEnd: '23:00', turnBands: { '1-2': 90, '3-4': 105, '5-6': 120, '7+': 150 } };
const bk = (over = {}) => ({
  id: 'bk-1', date: '2026-10-20', startTime: '19:00', covers: 2, tables: ['t1'], primaryTableId: 't1',
  turnMinutes: 90, status: 'confirmed', customer: { name: 'Oliver Pembroke', phone: '07700 900000' }, note: '',
  ...over,
});

test('editRefusal: live bookings edit, seated and finished ones say why not', () => {
  assert.equal(editRefusal(bk()), null);
  assert.equal(editRefusal(bk({ status: 'prepaid' })), null);
  assert.equal(editRefusal(bk({ status: 'pending_payment' })), null);
  assert.match(editRefusal(bk({ status: 'dining' })), /on the till/);
  assert.match(editRefusal(bk({ status: 'departed' })), /left/);
  assert.match(editRefusal(bk({ status: 'cancelled' })), /cancelled/);
  assert.match(editRefusal(bk({ status: 'no_show' })), /no show/);
  assert.match(editRefusal(bk({ status: 'expired' })), /expired/);
  assert.equal(editRefusal(null), 'Booking not found.');
});

test('validateEdit: a plain time change passes and the turn comes from the band', () => {
  const r = validateEdit({ booking: bk(), patch: { startTime: '19:30', covers: 4, tables: ['t4'] }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.next.startTime, '19:30');
  assert.equal(r.next.covers, 4);
  assert.equal(r.next.turnMinutes, 105);
  assert.deepEqual(r.next.tables, ['t4']);
  assert.equal(r.next.primaryTableId, 't4');
});

test('validateEdit: a package turn beats the cover band', () => {
  const r = validateEdit({ booking: bk(), patch: { covers: 6, tables: ['t8'] }, rules: RULES, tables: TABLES, pkg: { turnMinutes: 180 } });
  assert.equal(r.ok, true);
  assert.equal(r.next.turnMinutes, 180);
});

test('validateEdit: refuses a past date, allows today', () => {
  const past = validateEdit({ booking: bk(), patch: { date: '2026-10-10' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(past.ok, false);
  assert.ok(past.errors.some((e) => /date has gone/.test(e)));
  const today = validateEdit({ booking: bk(), patch: { date: '2026-10-16' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(today.ok, true);
});

test('validateEdit: time must sit inside service hours', () => {
  const early = validateEdit({ booking: bk(), patch: { startTime: '16:45' }, rules: RULES, tables: TABLES });
  assert.ok(early.errors.some((e) => /outside service hours \(17:00 to 23:00\)/.test(e)));
  const atClose = validateEdit({ booking: bk(), patch: { startTime: '23:00' }, rules: RULES, tables: TABLES });
  assert.equal(atClose.ok, false);
  const lastSlot = validateEdit({ booking: bk(), patch: { startTime: '22:45' }, rules: RULES, tables: TABLES });
  assert.equal(lastSlot.ok, true);
});

test('validateEdit: covers must fit the tables, joined tables add up', () => {
  const tooBig = validateEdit({ booking: bk(), patch: { covers: 4 }, rules: RULES, tables: TABLES });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.errors.some((e) => e === 'T1 seats 2, this party is 4. Add a table or pick a bigger one.'));
  const joined = validateEdit({ booking: bk(), patch: { covers: 4, tables: ['t1', 't2'] }, rules: RULES, tables: TABLES });
  assert.equal(joined.ok, true);
  assert.equal(joined.next.primaryTableId, 't1');
});

test('validateEdit: no tables, unknown table, bad covers', () => {
  assert.ok(validateEdit({ booking: bk(), patch: { tables: [] }, rules: RULES, tables: TABLES }).errors.some((e) => /at least one table/.test(e)));
  assert.ok(validateEdit({ booking: bk(), patch: { tables: ['nope'] }, rules: RULES, tables: TABLES }).errors.some((e) => /no longer on the floor plan/.test(e)));
  assert.ok(validateEdit({ booking: bk(), patch: { covers: 0 }, rules: RULES, tables: TABLES }).errors.some((e) => /at least 1/.test(e)));
});

test('validateEdit: a booking still being paid cannot change covers (the payment gate)', () => {
  const r = validateEdit({ booking: bk({ status: 'pending_payment' }), patch: { covers: 3, tables: ['t4'] }, rules: RULES, tables: TABLES });
  assert.ok(r.errors.some((e) => /still being paid online/.test(e)));
  const moveOnly = validateEdit({ booking: bk({ status: 'pending_payment' }), patch: { tables: ['t4'] }, rules: RULES, tables: TABLES });
  assert.equal(moveOnly.ok, true);
});

test('validateEdit: a seated booking is refused outright', () => {
  const r = validateEdit({ booking: bk({ status: 'dining' }), patch: { startTime: '20:00' }, rules: RULES, tables: TABLES });
  assert.equal(r.ok, false);
  assert.equal(r.next, null);
});

test('conflictsFor: names the other booking, ignores itself and dead bookings, half open window', () => {
  const me = { ...bk(), tables: ['t4'], startTime: '19:00', turnMinutes: 90 };
  const others = [
    bk(),                                                                    // itself, different table anyway
    bk({ id: 'bk-2', tables: ['t4'], startTime: '20:00', turnMinutes: 90, customer: { name: 'Smith' } }),  // 20:00 start overlaps 19:00 to 20:30
    bk({ id: 'bk-3', tables: ['t4'], startTime: '20:30', turnMinutes: 90, customer: { name: 'Jones' } }),  // starts exactly at my end
    bk({ id: 'bk-4', tables: ['t4'], startTime: '19:00', turnMinutes: 90, status: 'cancelled' }),
    bk({ id: 'bk-5', tables: ['t4'], startTime: '19:00', turnMinutes: 90, status: 'no_show' }),
    bk({ id: 'bk-6', tables: ['t4'], startTime: '19:00', turnMinutes: 90, status: 'expired' }),
    bk({ id: 'bk-7', tables: ['t1'], startTime: '19:00', turnMinutes: 90 }),  // other table
  ];
  const c = conflictsFor({ booking: me, others, tables: TABLES });
  assert.equal(c.length, 1);
  assert.equal(c[0].bookingId, 'bk-2');
  assert.equal(c[0].name, 'Smith');
  assert.equal(c[0].tableLabel, 'T4');
  assert.equal(c[0].text, 'T4 is taken by Smith 20:00 to 21:30');
});

test('conflictsFor: an open till tab block is a conflict too, and says so', () => {
  const me = { ...bk(), tables: ['t4'], startTime: '19:00', turnMinutes: 90 };
  const others = [{ id: 'sess-t4', tables: ['t4'], startMin: toMin('18:30'), turnMinutes: 105, covers: 2, status: 'dining' }];
  const c = conflictsFor({ booking: me, others, tables: TABLES });
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'an open tab on T4');
  assert.match(c[0].text, /open tab until about 20:15/);
});

test('conflictsFor: a party with no name is still named by its size', () => {
  const me = { ...bk(), tables: ['t4'] };
  const others = [bk({ id: 'x', tables: ['t4'], customer: null, covers: 3 })];
  assert.equal(conflictsFor({ booking: me, others, tables: TABLES })[0].name, 'a party of 3');
  const walk = [bk({ id: 'y', tables: ['t4'], customer: null, source: 'walk_in' })];
  assert.equal(conflictsFor({ booking: me, others: walk, tables: TABLES })[0].name, 'a walk in');
});

test('paymentAfterEdit: prepay per cover, more covers means money owed', () => {
  const pkg = { paymentModel: 'prepay', price: 25, priceUnit: 'per_cover' };
  const r = paymentAfterEdit({ pkg, covers: 6, capturedMinor: 10000 });
  assert.equal(r.kind, 'prepay');
  assert.equal(r.dueMinor, 15000);
  assert.equal(r.state, 'owed');
  assert.equal(r.diffMinor, 5000);
});

test('paymentAfterEdit: fewer covers means over paid; equal means settled', () => {
  const pkg = { paymentModel: 'deposit', depositPerCover: 10 };
  const over = paymentAfterEdit({ pkg, covers: 3, capturedMinor: 4000 });
  assert.equal(over.state, 'overpaid');
  assert.equal(over.diffMinor, 1000);
  const same = paymentAfterEdit({ pkg, covers: 4, capturedMinor: 4000 });
  assert.equal(same.state, 'settled');
  assert.equal(same.diffMinor, 0);
});

test('paymentAfterEdit: per booking price does not scale; no package or a hold means nothing; unknown ledger says so', () => {
  const flat = paymentAfterEdit({ pkg: { paymentModel: 'prepay', price: 200, priceUnit: 'per_booking' }, covers: 9, capturedMinor: 20000 });
  assert.equal(flat.state, 'settled');
  assert.equal(paymentAfterEdit({ pkg: null, covers: 4, capturedMinor: 0 }).state, 'none');
  assert.equal(paymentAfterEdit({ pkg: { paymentModel: 'hold' }, covers: 4, capturedMinor: 0 }).state, 'none');
  const unk = paymentAfterEdit({ pkg: { paymentModel: 'prepay', price: 25, priceUnit: 'per_cover' }, covers: 2, capturedMinor: null });
  assert.equal(unk.state, 'unknown');
  assert.equal(unk.dueMinor, 5000);
});

test('snapToSlot rounds to the nearest 15 minutes', () => {
  assert.equal(snapToSlot(toMin('18:07')), toMin('18:00'));
  assert.equal(snapToSlot(toMin('18:08')), toMin('18:15'));
  assert.equal(snapToSlot(toMin('18:22'), 15), toMin('18:15'));
  assert.equal(snapToSlot(toMin('18:23'), 15), toMin('18:30'));
});

test('shiftTables moves every member by the same rows and refuses the edge', () => {
  const rows = TABLES;
  assert.deepEqual(shiftTables(['t1'], rows, 2), ['t4']);
  assert.deepEqual(shiftTables(['t1', 't2'], rows, 1), ['t2', 't4']);
  assert.equal(shiftTables(['t1', 't2'], rows, 3), null);
  assert.equal(shiftTables(['t1'], rows, -1), null);
  assert.deepEqual(shiftTables(['t8'], rows, 0), ['t8']);
  assert.equal(shiftTables(['zz'], rows, 0), null);
});

test('slotTimes walks the service window in steps', () => {
  const s = slotTimes({ serviceStart: '17:00', serviceEnd: '18:00', slotMinutes: 15 });
  assert.deepEqual(s, ['17:00', '17:15', '17:30', '17:45']);
});

test('stampEdit keeps the guest and adds who and when; editedLine reads it back', () => {
  const at = new Date('2026-10-16T17:42:00Z').getTime();
  const c = stampEdit({ name: 'Oliver', phone: '1' }, 'Jane', at);
  assert.equal(c.name, 'Oliver');
  assert.equal(c.edited_by, 'Jane');
  assert.equal(c.edited_at, '2026-10-16T17:42:00.000Z');
  const line = editedLine({ customer: c }, (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`);
  assert.equal(line, 'Edited 17:42 by Jane');
  assert.equal(editedLine({ customer: { name: 'x' } }), null);
  assert.equal(editedLine({ customer: null }), null);
  // a walk in with no guest gets a stamp but still has no guest
  const w = stampEdit(null, 'Jane', at);
  assert.equal(hasGuest(w), false);
  assert.equal(hasGuest(c), true);
});

test('describeChanges lists what moved in words', () => {
  const before = bk();
  const after = { ...before, startTime: '19:30', covers: 4, tables: ['t4'], note: 'window' };
  const words = describeChanges(before, after, TABLES);
  assert.equal(words, 'time 19:00 to 19:30, covers 2 to 4, table T1 to T4, note');
  assert.equal(describeChanges(before, before, TABLES), '');
});

// 16 Oct 2026: the database's refusal codes in words.
test('bookingRefusalWords: every code the guarded writes return reads as a sentence', () => {
  assert.equal(bookingRefusalWords({ error: 'table_taken', tableLabel: 'T5' }), 'T5 was just taken by another booking. Nothing was changed.');
  assert.match(bookingRefusalWords({ error: 'unknown_table', tableLabel: 'T9' }), /^T9 is not on this venue's floor plan/);
  assert.match(bookingRefusalWords({ error: 'too_many_covers', seats: 6 }), /seat 6, fewer than the party/);
  assert.match(bookingRefusalWords({ error: 'awaiting_payment' }), /still being paid online/);
  assert.match(bookingRefusalWords({ error: 'not_editable', status: 'dining' }), /seated/);
  assert.equal(bookingRefusalWords({ error: 'something new' }), 'something new');
  assert.equal(bookingRefusalWords({}), 'The database refused the change.');
  for (const e of ['table_taken', 'unknown_table', 'too_many_covers', 'awaiting_payment', 'not_editable']) {
    assert.ok(!/[–—]/.test(bookingRefusalWords({ error: e })), `${e}: no long dashes`);
  }
});
