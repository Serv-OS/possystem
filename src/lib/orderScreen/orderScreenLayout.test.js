/**
 * orderScreenLayout.test.js: stage rotation, section split, fit, paging, venue clock, chime keys.
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stageSize, splitSectionHeights, layoutSection, pageIndexAt,
  formatVenueTime, venueLocale, readyArrivals,
} from './orderScreenLayout.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ── stageSize ───────────────────────────────────────────────────────────────────

test('stageSize: portrait design turned right on a landscape TV swaps and rotates', () => {
  const s = stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 90 });
  assert.equal(s.w, 1080);
  assert.equal(s.h, 1920);
  assert.equal(s.rotate, 90);
  assert.match(s.transform, /rotate\(90deg\)/);
  const l = stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 270 });
  assert.equal(l.rotate, 270);
  assert.match(l.transform, /rotate\(270deg\)/);
});

test('stageSize: a portrait viewport never rotates', () => {
  const s = stageSize({ vw: 1080, vh: 1920, orientation: 'portrait', rotate: 90 });
  assert.deepEqual([s.w, s.h, s.rotate], [1080, 1920, 0]);
  assert.doesNotMatch(s.transform, /rotate/);
});

test('stageSize: a landscape config never rotates, nor does rotate 0', () => {
  const s = stageSize({ vw: 1920, vh: 1080, orientation: 'landscape', rotate: 90 });
  assert.deepEqual([s.w, s.h, s.rotate], [1920, 1080, 0]);
  const z = stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 0 });
  assert.deepEqual([z.w, z.h, z.rotate], [1920, 1080, 0]);
  const bad = stageSize({ vw: undefined, vh: null, orientation: 'portrait', rotate: 90 });
  assert.deepEqual([bad.w, bad.h, bad.rotate], [0, 0, 0]);
});

// ── splitSectionHeights ────────────────────────────────────────────────────────────

test('splitSectionHeights: sums exactly, keeps the minimum, weights by count', () => {
  const h = splitSectionHeights(1000, [2, 5, 3], 100);
  assert.equal(sum(h), 1000);
  h.forEach((x) => assert.ok(x >= 100));
  assert.ok(h[1] > h[2] && h[2] > h[0]);
  h.forEach((x) => assert.ok(Number.isInteger(x)));

  const odd = splitSectionHeights(1001, [1, 1, 1], 0);
  assert.equal(sum(odd), 1001);
  assert.ok(Math.max(...odd) - Math.min(...odd) <= 1);

  const big = splitSectionHeights(1726, [7, 0, 13], 237);
  assert.equal(sum(big), 1726);
  big.forEach((x) => assert.ok(x >= 237));
  assert.equal(big[1], 237);
});

test('splitSectionHeights: all zero counts share equally; a zero count gets the minimum', () => {
  const h = splitSectionHeights(1000, [0, 0, 0], 100);
  assert.equal(sum(h), 1000);
  assert.ok(Math.max(...h) - Math.min(...h) <= 1);
  assert.deepEqual(splitSectionHeights(1000, [0, 10], 200), [200, 800]);
});

test('splitSectionHeights: too little room still sums exactly; empty gives []', () => {
  const h = splitSectionHeights(250, [1, 9, 1], 100);
  assert.equal(sum(h), 250);
  assert.deepEqual(splitSectionHeights(500, [], 10), []);
  assert.deepEqual(splitSectionHeights(500, null, 10), []);
  assert.deepEqual(splitSectionHeights(500, [3]), [500]);
  assert.equal(sum(splitSectionHeights(1000.7, [1, 2], 10)), 1000);
});

test('splitSectionHeights: per section minimums keep a small section readable', () => {
  const h = splitSectionHeights(1000, [60, 0, 2], [200, 150, 300]);
  assert.equal(sum(h), 1000);
  assert.ok(h[0] >= 200 && h[1] === 150 && h[2] >= 300);
  assert.ok(h[0] > h[2]);
  assert.deepEqual(splitSectionHeights(500, [1, 1], [400, 400]), [250, 250]);
  assert.equal(sum(splitSectionHeights(500, [5, 1], [450, 150])), 500);
});

// ── layoutSection (S = 1000, so the font runs 45 down to 30 px) ─────────────────────────

test('layoutSection: a few rows get 1 column at the biggest font', () => {
  const l = layoutSection({ count: 3, boxW: 1000, listH: 500, S: 1000, maxColumns: 2 });
  assert.ok(near(l.font, 45));
  assert.ok(near(l.rowH, 85.5));
  assert.equal(l.columns, 1);
  assert.equal(l.pages, 1);
  assert.equal(l.perColumn, 5);
});

test('layoutSection: a second column comes before the font shrinks', () => {
  const l = layoutSection({ count: 8, boxW: 1400, listH: 500, S: 1000, maxColumns: 2 });
  assert.ok(near(l.font, 45));
  assert.equal(l.columns, 2);
  assert.equal(l.pages, 1);
});

test('layoutSection: more rows still shrink to the floor font', () => {
  const l = layoutSection({ count: 20, boxW: 1400, listH: 600, S: 1000, maxColumns: 2 });
  assert.ok(near(l.font, 30));
  assert.equal(l.columns, 2);
  assert.equal(l.perColumn, 10);
  assert.equal(l.pages, 1);
});

test('layoutSection: overflow pages with the right perPage', () => {
  const l = layoutSection({ count: 45, boxW: 1400, listH: 600, S: 1000, maxColumns: 2 });
  assert.ok(near(l.font, 30));
  assert.equal(l.columns, 2);
  assert.equal(l.perColumn, 10);
  assert.equal(l.perPage, 20);
  assert.equal(l.pages, 3);
});

test('layoutSection: maxColumns 1 is respected', () => {
  const l = layoutSection({ count: 8, boxW: 1400, listH: 500, S: 1000, maxColumns: 1 });
  assert.equal(l.columns, 1);
  assert.ok(near(l.font, 32.5));
  const o = layoutSection({ count: 45, boxW: 1400, listH: 600, S: 1000, maxColumns: 1 });
  assert.equal(o.columns, 1);
  assert.equal(o.perPage, 10);
  assert.equal(o.pages, 5);
});

test('layoutSection: a column must be at least 14 x font wide', () => {
  // 1000 / 2 = 500 px per column is only wide enough once the font is 35 px or less.
  const l = layoutSection({ count: 8, boxW: 1000, listH: 500, S: 1000, maxColumns: 2 });
  assert.equal(l.columns, 2);
  assert.ok(near(l.font, 35));
});

test('layoutSection: a wider minColumnEm keeps 1 column and pages instead', () => {
  // 1400 / 2 = 700 px per column: fine at 14em, too narrow at 24em even on the floor font (720 px).
  const two = layoutSection({ count: 45, boxW: 1400, listH: 600, S: 1000, maxColumns: 2, minColumnEm: 14 });
  assert.equal(two.columns, 2);
  const one = layoutSection({ count: 45, boxW: 1400, listH: 600, S: 1000, maxColumns: 2, minColumnEm: 24 });
  assert.equal(one.columns, 1);
  assert.equal(one.perPage, 10);
  assert.equal(one.pages, 5);
  // A smaller value never lowers the 14em floor.
  const floor = layoutSection({ count: 8, boxW: 1000, listH: 500, S: 1000, maxColumns: 2, minColumnEm: 5 });
  assert.ok(near(floor.font, 35));
  assert.equal(floor.columns, 2);
});

test('layoutSection: count 0 gives 1 column and 1 page', () => {
  const l = layoutSection({ count: 0, boxW: 1000, listH: 500, S: 1000, maxColumns: 2 });
  assert.equal(l.columns, 1);
  assert.equal(l.pages, 1);
  assert.ok(l.perPage >= 1);
  const tiny = layoutSection({ count: 5, boxW: 10, listH: 10, S: 1000, maxColumns: 2 });
  assert.equal(tiny.columns, 1);
  assert.equal(tiny.perPage, 1);
  assert.equal(tiny.pages, 5);
});

// ── pageIndexAt ────────────────────────────────────────────────────────────────────

test('pageIndexAt: cycles every 8000 ms, single page is always 0', () => {
  assert.equal(pageIndexAt(0, 3), 0);
  assert.equal(pageIndexAt(7999, 3), 0);
  assert.equal(pageIndexAt(8000, 3), 1);
  assert.equal(pageIndexAt(16000, 3), 2);
  assert.equal(pageIndexAt(24000, 3), 0);
  assert.equal(pageIndexAt(123456789, 1), 0);
  assert.equal(pageIndexAt(123456789, 0), 0);
  assert.equal(pageIndexAt(NaN, 3), 0);
  assert.equal(pageIndexAt(10000, 2, 5000), 0);
});

// ── formatVenueTime ─────────────────────────────────────────────────────────────────

test('formatVenueTime: venue zone, never the device zone', () => {
  const t = Date.parse('2026-09-11T12:42:00Z');
  assert.equal(formatVenueTime(t, 'Europe/London'), '13:42');
  assert.equal(formatVenueTime(t, 'America/New_York'), '8:42 AM');
  assert.equal(formatVenueTime(t, 'Europe/London', { date: true }), '11/09/2026, 13:42');
  assert.equal(formatVenueTime(t, 'America/New_York', { date: true }), '09/11/2026, 8:42 AM');
});

test('formatVenueTime: an invalid zone or time does not throw', () => {
  const t = Date.parse('2026-09-11T12:42:00Z');
  assert.doesNotThrow(() => formatVenueTime(t, 'Not/AZone'));
  assert.equal(typeof formatVenueTime(t, 'Not/AZone'), 'string');
  assert.equal(formatVenueTime(t, 'Not/AZone'), '13:42');
  assert.equal(formatVenueTime(NaN, 'Europe/London'), '');
  assert.equal(formatVenueTime(t, null), '13:42');
});

test('venueLocale: US for America and Honolulu only', () => {
  assert.equal(venueLocale('America/Chicago'), 'en-US');
  assert.equal(venueLocale('Pacific/Honolulu'), 'en-US');
  assert.equal(venueLocale('Europe/London'), 'en-GB');
  assert.equal(venueLocale(undefined), 'en-GB');
});

// ── readyArrivals ──────────────────────────────────────────────────────────────────

test('readyArrivals: first load gives none, new ready keys chime once', () => {
  const next = [{ key: 'a', bucket: 'ready' }];
  assert.deepEqual(readyArrivals(null, next), []);
  assert.deepEqual(readyArrivals(undefined, next), []);
  assert.deepEqual(readyArrivals([{ key: 'a', bucket: 'preparing' }], next), ['a']);
  assert.deepEqual(readyArrivals([{ key: 'a', bucket: 'ready' }], next), []);
  assert.deepEqual(readyArrivals([], [{ key: 'b', bucket: 'ready' }, { key: 'c', bucket: 'collected' }]), ['b']);
  assert.deepEqual(readyArrivals([{ key: 'a', bucket: 'ready' }], [{ key: 'a', bucket: 'collected' }]), []);
});
