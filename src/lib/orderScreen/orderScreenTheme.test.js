/**
 * orderScreenTheme.test.js: colours the owner cannot edit stay readable on their page colours.
 * Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mixHex, deriveBoardTheme } from './orderScreenLayout.js';
import { DEFAULT_THEME } from './orderScreenStatus.js';

// WCAG relative luminance contrast, enough to prove readability.
const lum = (hex) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('mixHex blends and always returns 6 digit hex', () => {
  assert.equal(mixHex('#FFFFFF', '#000000', 1), '#FFFFFF');
  assert.equal(mixHex('#FFFFFF', '#000000', 0), '#000000');
  assert.equal(mixHex('#FFFFFF', '#000000', 0.5), '#808080');
  assert.match(mixHex('#0F1211', '#FFFFFF', 0.62), /^#[0-9A-F]{6}$/);
  assert.equal(mixHex('red', '#000000', 0.5), '#000000');
});

test('the default theme is left exactly as it is', () => {
  assert.deepEqual(deriveBoardTheme({ ...DEFAULT_THEME }, DEFAULT_THEME), DEFAULT_THEME);
  assert.deepEqual(deriveBoardTheme({ ...DEFAULT_THEME, bg: '#0f1211' }, DEFAULT_THEME), { ...DEFAULT_THEME, bg: '#0f1211' });
});

test('a white page with ink text gets readable muted and pill colours', () => {
  const t = deriveBoardTheme({ ...DEFAULT_THEME, bg: '#FFFFFF', text: '#0F1211' }, DEFAULT_THEME);
  assert.equal(t.pillText, '#0F1211');
  assert.ok(contrast(t.muted, t.bg) >= 4.5, `muted contrast ${contrast(t.muted, t.bg)}`);
  assert.ok(contrast(t.pillText, t.pillBg) >= 4.5, `pill contrast ${contrast(t.pillText, t.pillBg)}`);
  assert.ok(contrast(DEFAULT_THEME.muted, '#FFFFFF') < 3, 'the old grey really was unreadable');
  // Hex stays 6 digits, because OrderBoard appends alpha like `${theme.muted}33`.
  for (const k of ['muted', 'pillBg', 'pillText']) assert.match(t[k], /^#[0-9A-Fa-f]{6}$/, k);
});

test('bad colours are never mixed', () => {
  const t = deriveBoardTheme({ ...DEFAULT_THEME, bg: 'white' }, DEFAULT_THEME);
  assert.equal(t.muted, DEFAULT_THEME.muted);
  assert.deepEqual(deriveBoardTheme(null, DEFAULT_THEME), {});
});
