// 12 Oct 2026, Coffee Boy Barnsley (K4): a list answer older than 15 s was thrown away, and one
// answered while any write started or finished was thrown away too. On the slow link nothing new
// showed for minutes, then everything at once. Now every list answer is used, and what the screen
// learned AFTER that read was sent is laid on top, so a late list can never undo something newer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_KEEP_MS, noteEvent, pruneEvents, upsertRow, removeRow, mergeList } from './kdsBoardRows.js';

const row = (id, extra = {}) => ({ id, status: 'pending', ...extra });
const ids = (rows) => rows.map((r) => r.id);

test('events are kept two minutes: longer than any list read lives (45 s)', () => {
  assert.equal(EVENT_KEEP_MS, 120000);
  let events = noteEvent(new Map(), { id: 'A', kind: 'row', row: row('A'), at: 1000 });
  events = noteEvent(events, { id: 'B', kind: 'gone', at: 60000 });
  assert.deepEqual([...pruneEvents(events, { now: 121000 }).keys()], ['A', 'B'], 'exactly two minutes old is still kept');
  assert.deepEqual([...pruneEvents(events, { now: 121001 }).keys()], ['B']);
  assert.deepEqual([...pruneEvents(events, { now: 60000 + 500, keepMs: 100 }).keys()], []);
  assert.deepEqual([...pruneEvents(null, { now: 5 }).keys()], []);
});

test('noteEvent: the newest thing learned about a ticket replaces the older one, and nothing is changed in place', () => {
  const first = noteEvent(new Map(), { id: 'A', kind: 'row', row: row('A'), at: 1000 });
  const second = noteEvent(first, { id: 'A', kind: 'gone', row: row('A'), at: 2000 });
  assert.deepEqual(first.get('A'), { kind: 'row', row: row('A'), at: 1000 });
  assert.deepEqual(second.get('A'), { kind: 'gone', row: null, at: 2000 }, 'a ticket that left carries no row');
  assert.equal(noteEvent(first, { kind: 'gone', at: 5 }), first, 'no id: nothing');
  assert.equal(noteEvent(null, { id: 'Z', kind: 'row', row: row('Z'), at: 5 }).size, 1);
});

test('upsertRow and removeRow', () => {
  const rows = [row('A'), row('B')];
  assert.deepEqual(ids(upsertRow(rows, row('C'))), ['A', 'B', 'C']);
  const changed = upsertRow(rows, row('A', { status: 'held' }));
  assert.deepEqual(changed.map((r) => r.status), ['held', 'pending']);
  assert.deepEqual(rows.map((r) => r.status), ['pending', 'pending'], 'the old list is untouched');
  assert.deepEqual(ids(upsertRow(null, row('A'))), ['A']);
  assert.deepEqual(ids(removeRow(rows, 'A')), ['B']);
  assert.deepEqual(ids(removeRow(null, 'A')), []);
});

test('mergeList: a live add newer than the read is not wiped by the older list', () => {
  // The read left at 1000 and came back with A only. N arrived on the live channel at 1500.
  const events = noteEvent(new Map(), { id: 'N', kind: 'row', row: row('N'), at: 1500 });
  assert.deepEqual(ids(mergeList({ rows: [row('A')], readStartedAt: 1000, events })), ['A', 'N']);
});

test('mergeList: a live removal and an own save newer than the read win over the list', () => {
  // The list still holds A and B as waiting. A was bumped on another screen at 1200 (live), and
  // this screen's own bump of B was answered at 1300.
  let events = noteEvent(new Map(), { id: 'A', kind: 'gone', at: 1200 });
  events = noteEvent(events, { id: 'B', kind: 'gone', at: 1300 });
  // This screen's hold of C was answered at 1400: the list's older "pending" must not undo it.
  events = noteEvent(events, { id: 'C', kind: 'row', row: row('C', { status: 'held' }), at: 1400 });
  const out = mergeList({ rows: [row('A'), row('B'), row('C'), row('D')], readStartedAt: 1000, events });
  assert.deepEqual(ids(out), ['C', 'D']);
  assert.equal(out[0].status, 'held');
});

test('mergeList: something learned BEFORE the read was sent does not win (the list is newer)', () => {
  let events = noteEvent(new Map(), { id: 'A', kind: 'gone', at: 900 });
  events = noteEvent(events, { id: 'N', kind: 'row', row: row('N'), at: 999 });
  events = noteEvent(events, { id: 'C', kind: 'row', row: row('C', { status: 'held' }), at: 500 });
  const out = mergeList({ rows: [row('A'), row('C')], readStartedAt: 1000, events });
  assert.deepEqual(ids(out), ['A', 'C'], 'A was recalled since, N was bumped since: the list says so');
  assert.equal(out[1].status, 'pending');
  // Learned in the same millisecond the read left: the event wins (the read cannot have seen it).
  const same = noteEvent(new Map(), { id: 'A', kind: 'gone', at: 1000 });
  assert.deepEqual(ids(mergeList({ rows: [row('A')], readStartedAt: 1000, events: same })), []);
});

test('mergeList: no events, no rows', () => {
  const rows = [row('A')];
  const out = mergeList({ rows, readStartedAt: 0, events: null });
  assert.deepEqual(out, rows);
  assert.notEqual(out, rows, 'a new array: the answer is never changed in place');
  assert.deepEqual(mergeList({ rows: null, readStartedAt: 0, events: new Map() }), []);
});
