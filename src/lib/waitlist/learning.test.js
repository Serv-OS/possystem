/**
 * learning.test.js — Tables Ready learning loop (turn-time learning + quote accuracy).
 * Run: `npm test` (node:test). PURE module; no store/Supabase needed.
 * Covers: turnMinutes outlier-filtering, computeTurnStats banding + minSamples gate,
 * mergeLearnedBands override, quoteAccuracy withinPct + mae.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  turnMinutes, computeTurnStats, mergeLearnedBands, quoteAccuracy,
  MIN_TURN_MIN, MAX_TURN_MIN,
} from './learning.js';
import { DEFAULT_BANDS } from './waitlist.js';

const MIN = 60000; // ms per minute
// A closed check that sat for `mins` minutes with `covers` people.
const check = (mins, covers) => ({ seatedAt: 0, closedAt: mins * MIN, covers });

// ── turnMinutes ──────────────────────────────────────────────────────────────
test('turnMinutes: seated->closed delta in minutes', () => {
  assert.equal(turnMinutes(check(45, 2)), 45);
  assert.equal(turnMinutes({ seatedAt: 1_000_000, closedAt: 1_000_000 + 30 * MIN, covers: 4 }), 30);
});

test('turnMinutes: drops short outliers (< 5 min)', () => {
  assert.equal(turnMinutes(check(4, 2)), null);
  assert.equal(turnMinutes(check(0, 2)), null);
  assert.equal(turnMinutes(check(MIN_TURN_MIN, 2)), MIN_TURN_MIN); // boundary kept
});

test('turnMinutes: drops long outliers (> 360 min)', () => {
  assert.equal(turnMinutes(check(361, 2)), null);
  assert.equal(turnMinutes(check(MAX_TURN_MIN, 2)), MAX_TURN_MIN); // boundary kept
});

test('turnMinutes: null/invalid timestamps -> null', () => {
  assert.equal(turnMinutes(null), null);
  assert.equal(turnMinutes({ covers: 2 }), null);
  assert.equal(turnMinutes({ seatedAt: 0, closedAt: null, covers: 2 }), null);
  assert.equal(turnMinutes({ seatedAt: 'x', closedAt: 'y', covers: 2 }), null);
  // negative (closed before seated) is below MIN -> dropped
  assert.equal(turnMinutes({ seatedAt: 10 * MIN, closedAt: 0, covers: 2 }), null);
});

// ── computeTurnStats ─────────────────────────────────────────────────────────
test('computeTurnStats: bands by covers, averages dwell, gates on minSamples', () => {
  const checks = [
    // band '1-2' (covers 2): five clean samples averaging 50
    check(40, 2), check(50, 2), check(60, 2), check(50, 2), check(50, 2),
    // band '3-4' (covers 4): only four samples -> gated out at default minSamples=5
    check(70, 4), check(70, 4), check(70, 4), check(70, 4),
  ];
  const stats = computeTurnStats(checks, { bands: DEFAULT_BANDS });
  assert.deepEqual(stats['1-2'], { avgTurn: 50, n: 5 });
  assert.equal(stats['3-4'], undefined); // below minSamples gate
});

test('computeTurnStats: outliers excluded from average and count', () => {
  const checks = [
    check(2, 2),    // too short -> dropped
    check(400, 2),  // too long -> dropped
    check(60, 2), check(60, 2), check(60, 2), check(60, 2), check(60, 2),
  ];
  const stats = computeTurnStats(checks, { bands: DEFAULT_BANDS });
  assert.deepEqual(stats['1-2'], { avgTurn: 60, n: 5 });
});

test('computeTurnStats: minSamples override lets a thin band through', () => {
  const checks = [check(30, 4), check(50, 4)]; // band '3-4', n=2, avg 40
  const stats = computeTurnStats(checks, { bands: DEFAULT_BANDS, minSamples: 2 });
  assert.deepEqual(stats['3-4'], { avgTurn: 40, n: 2 });
});

test('computeTurnStats: empty / no clean samples -> {}', () => {
  assert.deepEqual(computeTurnStats([], {}), {});
  assert.deepEqual(computeTurnStats(null, {}), {});
  assert.deepEqual(computeTurnStats([check(1, 2), check(999, 2)], {}), {});
});

// ── mergeLearnedBands ────────────────────────────────────────────────────────
test('mergeLearnedBands: learned avgTurn overrides seed turn + tags sample', () => {
  const stats = { '1-2': { avgTurn: 38, n: 7 } };
  const merged = mergeLearnedBands(DEFAULT_BANDS, stats);
  const b12 = merged.find((b) => b.label === '1-2');
  assert.equal(b12.turn, 38);          // overridden
  assert.equal(b12.learned, true);
  assert.equal(b12.sample, 7);
  const b34 = merged.find((b) => b.label === '3-4');
  assert.equal(b34.turn, 60);          // untouched seed
  assert.equal(b34.learned, false);
});

test('mergeLearnedBands: null/empty stats -> bands unchanged (learned:false)', () => {
  const merged = mergeLearnedBands(DEFAULT_BANDS, null);
  assert.equal(merged.length, DEFAULT_BANDS.length);
  merged.forEach((b, i) => {
    assert.equal(b.turn, DEFAULT_BANDS[i].turn);
    assert.equal(b.learned, false);
  });
  // does not mutate the source bands
  assert.equal(DEFAULT_BANDS[0].learned, undefined);
});

test('mergeLearnedBands: ignores zero/non-finite learned values', () => {
  const merged = mergeLearnedBands(DEFAULT_BANDS, { '1-2': { avgTurn: 0, n: 9 }, '3-4': { avgTurn: NaN, n: 9 } });
  assert.equal(merged.find((b) => b.label === '1-2').turn, 45); // seed kept
  assert.equal(merged.find((b) => b.label === '1-2').learned, false);
  assert.equal(merged.find((b) => b.label === '3-4').turn, 60);
});

// ── quoteAccuracy ────────────────────────────────────────────────────────────
test('quoteAccuracy: withinPct + mae over rows', () => {
  const rows = [
    { quoted: 30, actual: 32 }, // err 2  within
    { quoted: 30, actual: 35 }, // err 5  within (boundary)
    { quoted: 30, actual: 40 }, // err 10 outside
    { quoted: 20, actual: 20 }, // err 0  within
  ];
  const r = quoteAccuracy(rows, { toleranceMin: 5 });
  assert.equal(r.n, 4);
  assert.equal(r.withinPct, 75);                 // 3 of 4
  assert.equal(r.mae, Math.round((2 + 5 + 10 + 0) / 4 * 10) / 10); // 4.3
});

test('quoteAccuracy: skips rows missing a number', () => {
  const rows = [
    { quoted: 30, actual: 30 },
    { quoted: null, actual: 30 },
    { quoted: 30, actual: undefined },
    { actual: 30 },
  ];
  const r = quoteAccuracy(rows);
  assert.equal(r.n, 1);
  assert.equal(r.withinPct, 100);
  assert.equal(r.mae, 0);
});

test('quoteAccuracy: empty -> zeros, never NaN', () => {
  assert.deepEqual(quoteAccuracy([]), { withinPct: 0, mae: 0, n: 0 });
  assert.deepEqual(quoteAccuracy(null), { withinPct: 0, mae: 0, n: 0 });
});

test('quoteAccuracy: custom tolerance widens the within band', () => {
  const rows = [{ quoted: 30, actual: 40 }, { quoted: 30, actual: 41 }];
  assert.equal(quoteAccuracy(rows, { toleranceMin: 10 }).withinPct, 50); // only the err=10 passes
});
