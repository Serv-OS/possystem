/**
 * editRules.test.js: editing a booking (16 Oct 2026). Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  editRefusal, validateEdit, conflictsFor, paymentAfterEdit,
  snapToSlot, shiftTables, slotTimes, stampEdit, editedLine, hasGuest, describeChanges,
  changedFields, dropTarget, MOVE_NON_BLOCKING, preorderWarning,
  bookingRefusalWords, editChangesWindow, sameTables, standTimeRefusal,
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

// ── 16 Oct 2026 review ───────────────────────────────────────────────────────

test('validateEdit: a guest only fix saves even when the slot itself would now be refused', () => {
  // 12:30 is outside today's 17:00 to 23:00, T1 seats 2 for a party of 4, and
  // the turn was 150 when the bands say 105. None of that is being changed.
  const old = bk({ startTime: '12:30', covers: 4, turnMinutes: 150 });
  const r = validateEdit({ booking: old, patch: { customer: { name: 'Olivia Pembroke' }, note: 'window seat' }, rules: RULES, tables: TABLES, today: '2026-10-21' });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.next.turnMinutes, 150);
  assert.equal(r.changed.slot, false);
  assert.equal(r.changed.covers, false);
  // so editBooking skips the conflict check: an open tab on T1 cannot refuse it
  const tab = { id: 'sess-t1', status: 'dining', tables: ['t1'], startTime: '12:00', turnMinutes: 120 };
  assert.equal(conflictsFor({ booking: r.next, others: [tab], tables: TABLES }).length, 1);
});

test('validateEdit: moving the time still checks the hours; changing covers re bands the turn', () => {
  const old = bk({ startTime: '12:30', turnMinutes: 150 });
  assert.equal(validateEdit({ booking: old, patch: { startTime: '12:45' }, rules: RULES, tables: TABLES }).ok, false);
  const moved = validateEdit({ booking: bk({ turnMinutes: 150 }), patch: { startTime: '19:30' }, rules: RULES, tables: TABLES });
  assert.equal(moved.next.turnMinutes, 150);
  assert.equal(moved.changed.slot, true);
  const more = validateEdit({ booking: bk({ turnMinutes: 150 }), patch: { covers: 4, tables: ['t4'] }, rules: RULES, tables: TABLES });
  assert.equal(more.next.turnMinutes, 105);
  assert.equal(more.changed.turn, true);
});

test('validateEdit: a past booking date only refuses when the date is the thing being changed', () => {
  const r = validateEdit({ booking: bk({ date: '2026-10-15' }), patch: { note: 'x' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(r.ok, true);
});

test('conflictsFor: an expired booking counts for the edit (move_booking still sees it) and says so', () => {
  const me = bk({ tables: ['t4'] });
  const exp = bk({ id: 'bk-x', status: 'expired', tables: ['t4'], customer: { name: 'Smith' } });
  assert.equal(conflictsFor({ booking: me, others: [exp], tables: TABLES }).length, 0);
  const c = conflictsFor({ booking: me, others: [exp], tables: TABLES, nonBlocking: MOVE_NON_BLOCKING });
  assert.equal(c.length, 1);
  assert.match(c[0].text, /Smith \(expired unpaid, still holding the table\)/);
});

test('hasGuest: allergens alone are a guest', () => {
  assert.equal(hasGuest({ allergens: ['peanuts'] }), true);
  assert.equal(hasGuest({ allergens: [] }), false);
});

test('changedFields: only what the host changed goes in the patch', () => {
  const snap = bk({ customer: { name: 'Oliver', phone: '1', allergens: ['milk', 'eggs'] }, note: 'n' });
  const form = { date: snap.date, startTime: '19:00', covers: 2, tables: ['t1'], note: 'n', customer: { name: 'Oliver ', phone: '1', email: '', allergens: ['eggs', 'milk'] } };
  assert.deepEqual(changedFields(snap, form), {});
  assert.deepEqual(changedFields(snap, { ...form, customer: { ...form.customer, phone: '2' } }), { customer: { phone: '2' } });
  assert.deepEqual(changedFields(snap, { ...form, tables: ['t4', 't2'] }), { tables: ['t4', 't2'], primaryTableId: 't4' });
  assert.deepEqual(changedFields(snap, { ...form, startTime: '19:30', covers: 3 }), { startTime: '19:30', covers: 3 });
});

const ROWS = [{ id: 't1', label: 'T1', maxCovers: 2 }, { id: 't2', label: 'T2', maxCovers: 2 }, { id: 't4', label: 'T4', maxCovers: 4 }];
const DT = { slotW: 24, rowH: 44, rows: ROWS, startMin: toMin('17:00'), endMin: toMin('23:00') };

test('dropTarget: a table drag with sideways drift keeps the time', () => {
  const r = dropTarget({ ...DT, booking: bk(), dx: 15, dy: 44 });
  assert.equal(r.startMin, toMin('19:00'));
  assert.deepEqual(r.tables, ['t2']);
  assert.equal(r.timeChanged, false);
  assert.equal(r.ok, true);
  const drift = dropTarget({ ...DT, booking: bk(), dx: 16, dy: 0 });
  assert.equal(drift.unchanged, true);
});

test('dropTarget: a time drag keeps the table; a drop past the end clamps to the last slot', () => {
  const r = dropTarget({ ...DT, booking: bk(), dx: 48, dy: 20 });
  assert.equal(r.startMin, toMin('19:30'));
  assert.deepEqual(r.tables, ['t1']);
  const far = dropTarget({ ...DT, booking: bk(), dx: 24 * 40, dy: 0 });
  assert.equal(far.startMin, toMin('22:45'));
});

test('dropTarget: off the floor plan, too small, taken and no move', () => {
  const off = dropTarget({ ...DT, booking: bk({ tables: ['t2', 't4'], covers: 4 }), dx: 0, dy: 44 });
  assert.equal(off.ok, false);
  assert.match(off.reason, /off the floor plan/);
  const small = dropTarget({ ...DT, booking: bk({ tables: ['t4'], covers: 4 }), dx: 0, dy: -44 });
  assert.equal(small.reason, 'T2 seats 2, this party is 4.');
  const taken = dropTarget({ ...DT, booking: bk(), dx: 0, dy: 44, others: [bk({ id: 'bk-2', tables: ['t2'], startTime: '18:30', customer: { name: 'Smith' } })] });
  assert.match(taken.reason, /T2 is taken by Smith 18:30 to 20:00/);
  assert.equal(dropTarget({ ...DT, booking: bk(), dx: 3, dy: 5 }).unchanged, true);
});

test('preorderWarning: names the seats past the new covers', () => {
  const rows = [{ seat: 1 }, { seat: 2 }, { seat: 3 }, { seat: 4 }, { seat: 4 }];
  assert.equal(preorderWarning(rows, 4), null);
  assert.equal(preorderWarning(rows, 3), 'Seat 4 has pre-orders. They will still go to the kitchen. Remove them in Pre-orders.');
  assert.equal(preorderWarning(rows, 2), 'Seats 3 and 4 have pre-orders. They will still go to the kitchen. Remove them in Pre-orders.');
  assert.equal(preorderWarning([], 1), null);
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
    assert.ok(!/[\u2013\u2014]/.test(bookingRefusalWords({ error: e })), `${e}: no long dashes`);
  }
});

// ── 16 Oct 2026: a note or phone edit never moves the window ──────────────────
test('editChangesWindow: date, time, tables or more covers move it; note, guest or fewer covers do not', () => {
  const b = bk({ covers: 4, tables: ['t4'], primaryTableId: 't4' });
  assert.equal(editChangesWindow(b, { ...b, note: 'window seat' }), false);
  assert.equal(editChangesWindow(b, { ...b, customer: { name: 'X', phone: '1' } }), false);
  assert.equal(editChangesWindow(b, { ...b, covers: 3 }), false);
  assert.equal(editChangesWindow(b, { ...b, startTime: '19:00:00' }), false);
  assert.equal(editChangesWindow(b, { ...b, covers: 5 }), true);
  assert.equal(editChangesWindow(b, { ...b, startTime: '19:15' }), true);
  assert.equal(editChangesWindow(b, { ...b, date: '2026-10-21' }), true);
  assert.equal(editChangesWindow(b, { ...b, tables: ['t8'], primaryTableId: 't8' }), true);
  assert.equal(sameTables(b, { tables: ['t4'], primaryTableId: 't4' }), true);
});

test('validateEdit: a note or time edit keeps the booking turn, even when the band would be longer', () => {
  const b = bk({ covers: 4, tables: ['t4'], primaryTableId: 't4', turnMinutes: 90 });
  const r = validateEdit({ booking: b, patch: { note: 'birthday' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.equal(r.next.turnMinutes, 90);
  // 5.11.68 rule: the turn stays the booking's own unless the covers change.
  const moved = validateEdit({ booking: b, patch: { startTime: '19:30' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(moved.next.turnMinutes, 90);
  const grown = validateEdit({ booking: b, patch: { covers: 3 }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(grown.next.turnMinutes, 105);
});

test('validateEdit: a booking already over its tables can still have its note or time changed', () => {
  const over = bk({ covers: 4, tables: ['t1'], primaryTableId: 't1' });
  const note = validateEdit({ booking: over, patch: { note: 'late' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(note.ok, true, note.errors.join(' | '));
  const time = validateEdit({ booking: over, patch: { startTime: '20:00' }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(time.ok, true, time.errors.join(' | '));
  const grow = validateEdit({ booking: over, patch: { covers: 5 }, rules: RULES, tables: TABLES, today: '2026-10-16' });
  assert.equal(grow.ok, false);
});

test('bookingRefusalWords: no access reads as a sentence', () => {
  assert.match(bookingRefusalWords({ error: 'no access' }), /not allowed to change bookings/);
});

// 16 Oct 2026 (bookings audit section 3 item 6): service periods in the Edit sheet and the drag.
const PERIODS = {
  ...RULES,
  servicePeriods: [
    { id: 'l', name: 'Lunch', days: [1, 2, 3, 4, 5, 6, 7], start: '12:00', end: '15:00', lastSeating: '13:30' },
    { id: 'd', name: 'Dinner', days: [1, 2, 3, 4, 5, 6, 7], start: '17:00', end: '22:30', lastSeating: '21:00' },
  ],
  closedWeekdays: [1],
  dateBlocks: [{ id: 'x', from: '2026-12-25', to: '2026-12-25', label: 'Christmas' }],
};

test('validateEdit with service periods: lunch is fine, the gap and a closed day are refused in words', () => {
  // 2026-10-20 is a Tuesday, 2026-10-26 a Monday
  assert.equal(validateEdit({ booking: bk(), patch: { startTime: '12:30' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' }).ok, true);
  const gap = validateEdit({ booking: bk(), patch: { startTime: '16:00' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' });
  assert.equal(gap.ok, false);
  assert.match(gap.errors[0], /16:00 is outside service hours\. Open 12:00 to 15:00/);
  const late = validateEdit({ booking: bk(), patch: { startTime: '21:30' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' });
  assert.match(late.errors[0], /last seating 21:00/);
  const mon = validateEdit({ booking: bk(), patch: { date: '2026-10-26' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' });
  assert.equal(mon.ok, false);
  assert.match(mon.errors[0], /closed on Mondays/);
  const xmas = validateEdit({ booking: bk(), patch: { date: '2026-12-25' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' });
  assert.match(xmas.errors[0], /Christmas/);
});

test('validateEdit with service periods: a note or covers fix never trips the hours', () => {
  const offHours = bk({ startTime: '16:00' });
  assert.equal(validateEdit({ booking: offHours, patch: { note: 'window seat' }, rules: PERIODS, tables: TABLES, today: '2026-10-16' }).ok, true);
  assert.equal(validateEdit({ booking: offHours, patch: { covers: 1 }, rules: PERIODS, tables: TABLES, today: '2026-10-16' }).ok, true);
});

test('slotTimes follows the day\'s periods when a date is given', () => {
  const tue = slotTimes({ ...PERIODS, slotMinutes: 30 }, '2026-10-20');
  assert.deepEqual(tue.slice(0, 4), ['12:00', '12:30', '13:00', '13:30']);
  assert.equal(tue[4], '17:00');
  assert.deepEqual(slotTimes(PERIODS, '2026-10-26'), []);
  // without periods the old window, date or not
  assert.equal(slotTimes(RULES, '2026-10-20')[0], '17:00');
});

test('bookingRefusalWords: the database words for service periods come through', () => {
  assert.equal(bookingRefusalWords({ error: 'closed_day', message: 'The venue is closed on Mondays. Pick another day.' }), 'The venue is closed on Mondays. Pick another day.');
  assert.match(bookingRefusalWords({ error: 'outside_service' }), /outside service hours/);
  assert.match(bookingRefusalWords({ error: 'blocked' }), /closed for bookings/);
});

test('dropTarget: a drag into the closed gap between lunch and dinner is refused before Move', () => {
  const DTP = { ...DT, startMin: toMin('12:00'), endMin: toMin('22:30'), rules: PERIODS, date: '2026-10-20' };
  const b = bk({ startTime: '13:00' });
  const gap = dropTarget({ ...DTP, booking: b, dx: 12 * 24, dy: 0 });
  assert.equal(gap.startMin, toMin('16:00'));
  assert.equal(gap.ok, false);
  assert.match(gap.reason, /16:00 is outside service hours/);
  const dinner = dropTarget({ ...DTP, booking: b, dx: 20 * 24, dy: 0 });
  assert.equal(dinner.startMin, toMin('18:00'));
  assert.equal(dinner.ok, true);
  // a table move that keeps the time is never held to the periods
  const across = dropTarget({ ...DTP, booking: bk({ startTime: '16:00' }), dx: 0, dy: 44 });
  assert.equal(across.ok, true);
  // without rules (an older caller) it behaves as before
  assert.equal(dropTarget({ ...DTP, rules: null, booking: b, dx: 12 * 24, dy: 0 }).ok, true);
});

test('standTimeRefusal: walk ins and seated parties are never refused, a host booking is', () => {
  const mon = '2026-10-19';
  assert.equal(standTimeRefusal({ date: mon, startTime: '19:00', source: 'walk_in' }, PERIODS), null);
  assert.equal(standTimeRefusal({ date: mon, startTime: '19:00', source: 'host', status: 'dining' }, PERIODS), null);
  assert.equal(standTimeRefusal({ date: mon, startTime: '19:00', source: 'host', status: 'confirmed' }, PERIODS).code, 'closed_day');
  assert.equal(standTimeRefusal({ date: mon, startTime: '19:00', source: 'pos' }, PERIODS).code, 'closed_day');
  assert.equal(standTimeRefusal({ date: '2026-10-20', startTime: '16:00', source: 'host' }, PERIODS).code, 'outside_service');
  assert.equal(standTimeRefusal({ date: '2026-10-20', startTime: '19:00', source: 'host' }, PERIODS), null);
  // no periods set: the old window is not enforced on a new booking, as before
  assert.equal(standTimeRefusal({ date: mon, startTime: '11:00', source: 'host' }, RULES), null);
});
