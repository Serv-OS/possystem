import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingForEstimate, waitState, fittingFreeTables, seatSuggestions, estimate, tablesHeldByBookings, bandFor } from './waitlist.js';

const NOW = Date.parse('2026-10-16T19:00:00Z');
const minsAgo = (m) => NOW - m * 60000;

test('waitingForEstimate: one list for board and drawer, stale parties out, addedAt kept', () => {
  const list = [
    { id: 'a', size: 2, status: 'waiting', quoted: 10, addedAt: minsAgo(5) },
    { id: 'b', size: 4, status: 'notified', quoted: 5, addedAt: minsAgo(20) },
    { id: 'c', size: 2, status: 'waiting', quoted: 5, addedAt: minsAgo(7 * 60) }, // stale
    { id: 'd', size: 2, status: 'seated', addedAt: minsAgo(30) },
  ];
  const w = waitingForEstimate(list, NOW);
  assert.deepEqual(w.map((x) => x.size), [2, 4]);
  assert.equal(w[0].addedAt, minsAgo(5));
  // the drawer and the board now quote the same
  const tables = [{ cap: 2, status: 'seated' }, { cap: 4, status: 'seated' }];
  assert.equal(estimate({ size: 2, tables, waiting: w, now: NOW }), estimate({ size: 2, tables, waiting: waitingForEstimate(list, NOW), now: NOW }));
});

test('waitState: under, approaching, over in amber then red, re quoted', () => {
  assert.equal(waitState({ addedAt: minsAgo(3), firstQuote: 20, quoted: 15 }, NOW).tone, 'green');
  const near = waitState({ addedAt: minsAgo(17), firstQuote: 20, quoted: 5 }, NOW);
  assert.equal(near.tone, 'amber');
  assert.equal(near.text, '~3m left');
  const over = waitState({ addedAt: minsAgo(26), firstQuote: 20, quoted: 10 }, NOW);
  assert.equal(over.tone, 'amber');
  assert.equal(over.text, 'Over by 6 min');
  assert.equal(over.requote, 36);
  const late = waitState({ addedAt: minsAgo(142), firstQuote: 5, quoted: 5 }, NOW);
  assert.equal(late.tone, 'red');
  assert.equal(late.text, 'Over by 137 min');
  assert.equal(late.requote, 147);
  // what the host says now: about 5 more minutes, not 147
  assert.equal(late.more, 5);
});

test('waitState: the minute the quote is reached reads Due now, not Over by 0 min', () => {
  const s = waitState({ addedAt: minsAgo(5), firstQuote: 5, quoted: 3 }, NOW);
  assert.equal(s.over, 0);
  assert.equal(s.left, 0);
  assert.equal(s.text, 'Due now');
  assert.equal(s.tone, 'amber');
  assert.equal(s.requote, null);
  assert.equal(s.more, null);
});

test('waitState: the first quote is the promise, not the live estimate', () => {
  // the live estimate dropped to 5 when a table freed; the guest was told 25
  const s = waitState({ addedAt: minsAgo(10), firstQuote: 25, quoted: 5 }, NOW);
  assert.equal(s.tone, 'green');
  assert.equal(s.over, 0);
  // no first quote (older rows): the live quote stands in
  assert.equal(waitState({ addedAt: minsAgo(10), quoted: 5 }, NOW).text, 'Over by 5 min');
  assert.equal(waitState({ addedAt: minsAgo(10) }, NOW).promised, null);
});

const floor = [
  { id: 'T2', label: 'T2', maxCovers: 2, status: 'available', section: 'Bar' },
  { id: 'T4', label: 'T4', maxCovers: 4, status: 'available', section: 'Main' },
  { id: 'T6', label: 'T6', maxCovers: 6, status: 'occupied', section: 'Main' },
  { id: 'T8', label: 'T8', maxCovers: 8, status: 'available', section: 'Main' },
  { id: 'T4-2', label: 'T4.2', maxCovers: 4, status: 'available', parentId: 'T4' },
];

test('fittingFreeTables: free, fits, best fit, section first, no split children', () => {
  assert.deepEqual(fittingFreeTables(floor, { size: 3 }).map((t) => t.id), ['T4', 'T8']);
  assert.deepEqual(fittingFreeTables(floor, { size: 2, sectionPref: 'Main' }).map((t) => t.id), ['T4', 'T8', 'T2']);
  assert.deepEqual(fittingFreeTables(floor, { size: 9 }), []);
});

test('seatSuggestions: queue order, one table per party', () => {
  const q = [
    { id: 'a', size: 4, status: 'waiting' },
    { id: 'b', size: 4, status: 'notified' },
    { id: 'c', size: 6, status: 'waiting' },
    { id: 'd', size: 2, status: 'seated' },
  ];
  const s = seatSuggestions(q, floor);
  assert.equal(s.a.id, 'T4');
  assert.equal(s.b.id, 'T8');
  assert.equal(s.c, undefined);
  assert.equal(s.d, undefined);
});

test('a free 4 top with a booking 10 minutes from now is not offered to a walk in', () => {
  const today = '2026-10-16';
  const nowMin = 17 * 60 + 50;
  const bookings = [
    { id: 'bk-1', date: today, startTime: '18:00', turnMinutes: 90, tables: ['T4'], primaryTableId: 'T4', status: 'confirmed' },
    { id: 'bk-2', date: today, startTime: '21:00', turnMinutes: 90, tables: ['T8'], primaryTableId: 'T8', status: 'confirmed' },
    { id: 'bk-3', date: today, startTime: '17:30', turnMinutes: 90, tables: [], primaryTableId: 'T2', status: 'cancelled' },
    { id: 'bk-4', date: '2026-10-17', startTime: '18:00', turnMinutes: 90, tables: ['T2'], status: 'confirmed' },
  ];
  const held = tablesHeldByBookings(bookings, { today, nowMin, turn: bandFor(4).turn });
  assert.deepEqual([...held], ['T4']);
  assert.deepEqual(fittingFreeTables(floor, { size: 3, blocked: held }).map((t) => t.id), ['T8']);
  const s = seatSuggestions([{ id: 'a', size: 4, status: 'waiting' }], floor, {
    blockedFor: (size) => tablesHeldByBookings(bookings, { today, nowMin, turn: bandFor(size).turn }),
  });
  assert.equal(s.a.id, 'T8');
});

test('a booking already over, or a party already dining, does not hold the table', () => {
  const today = '2026-10-16';
  const held = tablesHeldByBookings([
    { date: today, startTime: '12:00', turnMinutes: 90, tables: ['T4'], status: 'confirmed' },
    { date: today, startTime: '17:30', turnMinutes: 90, tables: ['T8'], status: 'dining' },
    { date: today, startTime: '17:30', turnMinutes: 90, tables: [], primaryTableId: 'T2', status: 'prepaid' },
  ], { today, nowMin: 18 * 60, turn: 60 });
  assert.deepEqual([...held], ['T2']);
});
