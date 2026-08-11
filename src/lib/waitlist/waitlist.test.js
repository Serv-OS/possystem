/**
 * waitlist.test.js — Tables Ready estimation engine + lifecycle + mappers.
 * Run: `npm test` (node:test). Covers the brief's REQUIRED worked scenario plus
 * cold-start, clamping, never-negative, banding, lifecycle and mapper round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimate, bandFor, roundUpTo, clamp, canTransition, isActive,
  isStaleActive, freshActives, STALE_ACTIVE_MS,
  currentAverageWait, perBandStrip, rowToWaitlist, waitlistToRow, actualWaitMin,
  DEFAULT_BANDS, DEFAULT_QUOTE_RULES, STATUS,
} from './waitlist.js';

// Helper: build N suitable tables of a capacity, all with the given status.
const tablesOf = (n, cap, status) => Array.from({ length: n }, () => ({ cap, status }));
const waitingOf = (n, size, status = STATUS.WAITING) => Array.from({ length: n }, () => ({ size, status }));

test('THE worked scenario: 3 parties of 2 ahead, two 2-tops, 0 open -> ~80m', () => {
  // two 2-tops both occupied (status seated), 3 parties of 2 already waiting.
  const tables = tablesOf(2, 2, 'seated');
  const waiting = waitingOf(3, 2);
  // ahead=3, open=0, total=2 -> waves=ceil((3-0+1)/2)=2 -> 2*45*0.6=54 +18 +5 =77 -> round up 5 -> 80
  assert.equal(estimate({ size: 2, tables, waiting }), 80);
});

test('a suitable table is free -> quote is just the buffer (rounded)', () => {
  const tables = [{ cap: 2, status: 'open' }, { cap: 2, status: 'seated' }];
  const waiting = []; // ahead(0) < open(1)
  assert.equal(estimate({ size: 2, tables, waiting }), DEFAULT_QUOTE_RULES.roundTo); // buffer 5 rounds to 5
});

test('open tables absorb the parties ahead before any wait accrues', () => {
  // 2 open 2-tops, 1 party of 2 ahead -> ahead(1) < open(2) -> buffer only
  const tables = tablesOf(2, 2, 'open');
  assert.equal(estimate({ size: 2, tables, waiting: waitingOf(1, 2) }), 5);
});

test('cold-start uses the configured default turn when a band has none', () => {
  const bands = [{ label: 'all', min: 1, max: 999 }]; // no `turn` -> falls back to rules.defaultTurn (60)
  const tables = tablesOf(1, 4, 'seated');
  const waiting = waitingOf(2, 4);
  // ahead=2, open=0, total=1 -> waves=ceil((2-0+1)/1)=3 -> 3*60*0.6=108 + 24 + 5 = 137 -> cap 120
  assert.equal(estimate({ size: 4, tables, waiting, bands }), 120);
});

test('quote is clamped to maxQuote and is never negative / nonsensical', () => {
  const tables = tablesOf(1, 2, 'seated');
  const huge = estimate({ size: 2, tables, waiting: waitingOf(50, 2), rules: { ...DEFAULT_QUOTE_RULES, maxQuote: 90 } });
  assert.equal(huge, 90);
  const q = estimate({ size: 2, tables: tablesOf(2, 2, 'seated'), waiting: waitingOf(3, 2) });
  assert.ok(q > 0 && Number.isFinite(q), 'finite positive quote');
});

test('no table in the building fits the party -> honest max quote', () => {
  // party of 10, only 2-tops and 4-tops exist
  const tables = [...tablesOf(3, 2, 'open'), ...tablesOf(2, 4, 'open')];
  assert.equal(estimate({ size: 10, tables, waiting: [] }), DEFAULT_QUOTE_RULES.maxQuote);
});

test('section preference narrows the suitable set', () => {
  const tables = [
    { cap: 2, status: 'open', section: 'bar' },
    { cap: 2, status: 'open', section: 'terrace' },
  ];
  // want terrace, 0 ahead, 1 open terrace -> buffer
  assert.equal(estimate({ size: 2, sectionPref: 'terrace', tables, waiting: [] }), 5);
  // want a zone with no suitable table -> max quote
  assert.equal(estimate({ size: 2, sectionPref: 'private', tables, waiting: [] }), DEFAULT_QUOTE_RULES.maxQuote);
});

test('only same-band parties count as "ahead"', () => {
  // new party of 2; ahead are all 6-tops (different band) -> they don't block a 2-top
  const tables = tablesOf(2, 2, 'seated');
  const waiting = waitingOf(4, 6);
  // ahead(2-band)=0, open=0, total=2 -> waves=ceil((0-0+1)/2)=1 -> 1*45*0.6=27 +18 +5 =50
  assert.equal(estimate({ size: 2, tables, waiting }), 50);
});

test('bandFor maps sizes to the right band and clamps to the last band', () => {
  assert.equal(bandFor(1).label, '1-2');
  assert.equal(bandFor(2).label, '1-2');
  assert.equal(bandFor(4).label, '3-4');
  assert.equal(bandFor(6).label, '5-6');
  assert.equal(bandFor(12).label, '7+');
  assert.equal(bandFor(0).label, '1-2'); // floored to >=1
});

test('roundUpTo and clamp behave', () => {
  assert.equal(roundUpTo(77, 5), 80);
  assert.equal(roundUpTo(80, 5), 80);
  assert.equal(roundUpTo(1, 5), 5);
  assert.equal(clamp(150, 5, 120), 120);
  assert.equal(clamp(-3, 5, 120), 5);
});

test('lifecycle transitions are gated correctly', () => {
  assert.ok(canTransition('waiting', 'notified'));
  assert.ok(canTransition('notified', 'ready'));
  assert.ok(canTransition('ready', 'seated'));
  assert.ok(canTransition('seated', 'completed'));
  assert.ok(canTransition('no_show', 'waiting'));   // re-add
  assert.ok(!canTransition('completed', 'waiting')); // terminal
  assert.ok(!canTransition('waiting', 'completed')); // must be seated first
  assert.ok(isActive('waiting') && isActive('notified') && isActive('ready'));
  assert.ok(!isActive('seated') && !isActive('no_show'));
});

test('THE 11 AUG BUG: currentAverageWait is ELAPSED time, not the quotes', () => {
  // Every party quoted 5m but they have actually waited 10/20/30 minutes.
  // The old quote-averaging read "5" forever — the number must track the clock.
  const now = 1_000_000_000_000;
  const w = [
    { status: 'waiting',  quoted: 5, addedAt: now - 10 * 60000 },
    { status: 'notified', quoted: 5, addedAt: now - 20 * 60000 },
    { status: 'seated',   quoted: 5, addedAt: now - 99 * 60000 }, // excluded: not active
    { status: 'waiting',  quoted: 5, addedAt: now - 30 * 60000 },
  ];
  assert.equal(currentAverageWait(w, now), 20); // (10+20+30)/3 — NOT 5
  assert.equal(currentAverageWait([], now), 0);
});

test('currentAverageWait falls back to the quote only when addedAt is missing', () => {
  const now = 1_000_000_000_000;
  assert.equal(currentAverageWait([{ status: 'waiting', quoted: 25 }], now), 25);
});

test('stale actives (>6h) are invisible: stat, freshActives, and estimate "ahead"', () => {
  const now = 1_000_000_000_000;
  const stale = { status: 'waiting', size: 2, quoted: 5, addedAt: now - STALE_ACTIVE_MS - 60000 };
  const fresh = { status: 'waiting', size: 2, quoted: 5, addedAt: now - 10 * 60000 };
  assert.ok(isStaleActive(stale, now));
  assert.ok(!isStaleActive(fresh, now));
  assert.ok(!isStaleActive({ ...stale, status: 'seated' }, now), 'terminal rows are never "stale active"');
  assert.deepEqual(freshActives([stale, fresh], now), [fresh]);
  // The header stat ignores the abandoned party entirely.
  assert.equal(currentAverageWait([stale, fresh], now), 10);
  // And the estimator does not count it as a party ahead: one open 2-top,
  // only the stale party "ahead" -> ahead(0) < open(1) -> buffer-only quote.
  const q = estimate({ size: 2, tables: [{ cap: 2, status: 'open' }], waiting: [stale], now });
  assert.equal(q, 5);
});

test('perBandStrip returns a quote + open-table count per band', () => {
  const tables = [{ cap: 2, status: 'open' }, { cap: 4, status: 'seated' }];
  const strip = perBandStrip({ tables, waiting: [] });
  assert.equal(strip.length, DEFAULT_BANDS.length);
  assert.equal(strip[0].label, '1-2');
  assert.equal(strip[0].openTables, 1);          // the open 2-top
  assert.ok(Number.isFinite(strip[0].quote));
});

test('row mappers round-trip', () => {
  const entry = {
    id: 'wl-1', customerId: 'cust-9', name: 'Sam', phone: '+447700900333', size: 2,
    quoted: 25, firstQuote: 25, status: 'waiting', sectionPref: 'terrace', notes: 'window',
    seatedTableId: null, source: 'host', addedAt: 1750000000000, notifiedAt: null,
    readyAt: null, seatedAt: null,
  };
  const row = waitlistToRow(entry, 'loc-1', 'org-1');
  assert.equal(row.location_id, 'loc-1');
  assert.equal(row.party_name, 'Sam');
  assert.equal(row.party_size, 2);
  assert.equal(row.added_at, new Date(1750000000000).toISOString());
  const back = rowToWaitlist(row);
  assert.equal(back.name, 'Sam');
  assert.equal(back.size, 2);
  assert.equal(back.sectionPref, 'terrace');
  assert.equal(back.returning, true);
  assert.equal(back.addedAt, 1750000000000);
});

test('actualWaitMin computes seated-minus-added minutes', () => {
  assert.equal(actualWaitMin({ addedAt: 1_000_000, seatedAt: 1_000_000 + 30 * 60000 }), 30);
  assert.equal(actualWaitMin({ addedAt: null, seatedAt: 5 }), null);
});
