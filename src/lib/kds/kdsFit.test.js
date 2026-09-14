// KDS narrow card text sizing (v5.8.66): keep today's columns, shrink text so words fit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { gridColumnWidth, cardScale, scaled, breakableWords, fitFontSize, DESIGN_CARD_WIDTH } from './kdsFit.js';

test('column width matches the browser auto-fill grid', () => {
  // 1920 wide, 300 rail + 1px border, 22px padding each side → 1575 grid. The browser
  // measured 6 columns of 247.66px at exactly this size (Playwright, 14 Sep 2026).
  assert.equal(Math.round(gridColumnWidth(1575)), 248);
  assert.equal(Math.round(gridColumnWidth(1575, 360)), 380);
  assert.equal(gridColumnWidth(200), 200);                  // one column narrower than the minimum
  assert.equal(gridColumnWidth(0), DESIGN_CARD_WIDTH);
});

test('scale is exactly 1 at the design card width and never above it', () => {
  assert.equal(cardScale(380), 1);
  assert.equal(cardScale(600), 1);
  assert.equal(cardScale(247), 0.65);
  assert.equal(cardScale(100), 0.62);
  assert.equal(cardScale(undefined), 1);
});

test('scaled sizes keep the 13px floor', () => {
  assert.equal(scaled(25, 1), 25);
  assert.equal(scaled(25, 0.65), 16);
  assert.equal(scaled(15, 0.65), 13);
  assert.equal(scaled(26, 0.65, 18), 18);
});

test('breakable words split on spaces and after hyphens', () => {
  assert.deepEqual(breakableWords('Beatrice Nakamura-Reilly'), ['Beatrice', 'Nakamura-', 'Reilly']);
  assert.deepEqual(breakableWords('  #45 '), ['#45']);
  assert.deepEqual(breakableWords(null), []);
});

test('fitFontSize: only shrinks when the widest word does not fit, to the floor', () => {
  assert.equal(fitFontSize({ maxPx: 25, minPx: 14, available: 200, widestAtMax: 150 }), 25);
  assert.equal(fitFontSize({ maxPx: 25, minPx: 14, available: 133, widestAtMax: 190 }), 17.5);
  assert.equal(fitFontSize({ maxPx: 25, minPx: 14, available: 50, widestAtMax: 300 }), 14);
  assert.equal(fitFontSize({ maxPx: 25, minPx: 14, available: 0, widestAtMax: 300 }), 25);
});
