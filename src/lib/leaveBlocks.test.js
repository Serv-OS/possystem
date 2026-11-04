// src/lib/leaveBlocks.test.js (5.12.61): blocked periods for time off, the one rule both screens and
// the server use. node --test src/lib/leaveBlocks.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveBlocks, blockFor, blockWords, upcomingBlocks, BLOCKED_TYPES } from '../../supabase/functions/_shared/leaveBlocks.js';

const xmas = { leaveBlocks: [{ from: '2026-12-20', to: '2027-01-03', note: 'Christmas' }, { from: '2026-11-27', note: 'Black Friday' }] };

test('the list is cleaned and sorted, a bad row is dropped, a one day block fills in to', () => {
  assert.deepEqual(leaveBlocks(xmas), [
    { from: '2026-11-27', to: '2026-11-27', note: 'Black Friday' },
    { from: '2026-12-20', to: '2027-01-03', note: 'Christmas' },
  ]);
  assert.deepEqual(leaveBlocks({ leaveBlocks: [{ from: 'soon', to: '2026-12-01' }, { from: '2026-12-05', to: '2026-12-01' }] }), []);
  assert.deepEqual(leaveBlocks(null), []);
  assert.deepEqual(leaveBlocks({}), []);
});

test('a holiday request touching any day of a block is caught; outside it is not', () => {
  assert.equal(blockFor(xmas, '2026-12-18', '2026-12-20', 'holiday')?.note, 'Christmas');
  assert.equal(blockFor(xmas, '2027-01-03', '2027-01-10', 'holiday')?.note, 'Christmas');
  assert.equal(blockFor(xmas, '2026-12-25', undefined, 'holiday')?.note, 'Christmas');
  assert.equal(blockFor(xmas, '2026-11-27', '2026-11-27', 'unpaid')?.note, 'Black Friday');
  assert.equal(blockFor(xmas, '2026-12-01', '2026-12-19', 'holiday'), null);
  assert.equal(blockFor(xmas, '2027-01-04', '2027-01-04', 'holiday'), null);
});

test('sick and parental are never blocked', () => {
  assert.deepEqual(BLOCKED_TYPES, ['holiday', 'unpaid']);
  assert.equal(blockFor(xmas, '2026-12-25', '2026-12-25', 'sick'), null);
  assert.equal(blockFor(xmas, '2026-12-25', '2026-12-25', 'parental'), null);
});

test('the words follow the venue: UK holiday and day first, US PTO and month first, no dashes', () => {
  const b = leaveBlocks(xmas)[1];
  assert.equal(blockWords(b, 'holiday', 'GBP'), 'No holiday requests from 20 Dec 2026 to 3 Jan 2027 (Christmas). Talk to your manager.');
  assert.equal(blockWords(b, 'PTO', 'USD'), 'No PTO requests from Dec 20, 2026 to Jan 3, 2027 (Christmas). Talk to your manager.');
  assert.equal(blockWords(leaveBlocks(xmas)[0], 'PTO', { currency: 'USD' }), 'No PTO requests on Nov 27, 2026 (Black Friday). Talk to your manager.');
  assert.equal(blockWords({ from: '2026-12-24', to: '2026-12-26', note: '' }, 'holiday', 'GBP'), 'No holiday requests from 24 Dec 2026 to 26 Dec 2026. Talk to your manager.');
  assert.equal(blockWords(null), '');
  const dash = new RegExp(String.fromCharCode(0x2013) + '|' + String.fromCharCode(0x2014));
  assert.ok(!dash.test(blockWords(b, 'holiday', 'GBP')));
});

test('staff only see blocks that have not finished', () => {
  assert.deepEqual(upcomingBlocks(xmas, '2026-12-01').map((b) => b.note), ['Christmas']);
  assert.deepEqual(upcomingBlocks(xmas, '2027-01-03').map((b) => b.note), ['Christmas']);
  assert.deepEqual(upcomingBlocks(xmas, '2027-01-04'), []);
  assert.equal(upcomingBlocks(xmas, 'nope').length, 2);
});
