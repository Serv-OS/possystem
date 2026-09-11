/**
 * sheetTheme.test.js — the item sheet theme, shared by the storefront and the
 * guest booking page (10 Sep 2026 review: moved out of OnlineSurface untested).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseColour, isLightBackground, sheetThemeFrom, FALLBACK_ACCENT, FALLBACK_BG, FALLBACK_FG } from './sheetTheme.js';

test('normaliseColour repairs a bare hex and leaves everything else alone', () => {
  assert.equal(normaliseColour('ff0000'), '#ff0000');
  assert.equal(normaliseColour('abc'), '#abc');
  assert.equal(normaliseColour('  #15C26A '), '#15C26A');
  assert.equal(normaliseColour('red'), 'red');
  assert.equal(normaliseColour('rgb(0,0,0)'), 'rgb(0,0,0)');
  assert.equal(normaliseColour('12345'), '12345');
  assert.equal(normaliseColour(''), null);
  assert.equal(normaliseColour(null), null);
});

test('isLightBackground: dark and light backgrounds, unreadable values read as light', () => {
  assert.equal(isLightBackground('#000000'), false);
  assert.equal(isLightBackground('#0F1211'), false);
  assert.equal(isLightBackground('#ffffff'), true);
  assert.equal(isLightBackground('#fff'), true);
  assert.equal(isLightBackground(null), true);
  assert.equal(isLightBackground('#12345'), true);
});

test('sheetThemeFrom prefers brand_color, repairs colours and falls back', () => {
  const t = sheetThemeFrom({ brand_color: '15C26A', accent_color: '#e8743c', background: '0F1211', foreground: '#ffffff' }, 'Provo');
  assert.equal(t.accent, '#15C26A');
  assert.equal(t.bg, '#0F1211');
  assert.equal(t.fg, '#ffffff');
  assert.equal(t.isLight, false);
  assert.equal(t.name, 'Provo');
  assert.equal(sheetThemeFrom({ accent_color: '#e8743c' }).accent, '#e8743c');
  const empty = sheetThemeFrom(null, null);
  assert.equal(empty.accent, FALLBACK_ACCENT);
  assert.equal(empty.bg, FALLBACK_BG);
  assert.equal(empty.fg, FALLBACK_FG);
  assert.equal(empty.isLight, true);
  assert.equal(empty.name, 'Restaurant');
  assert.equal(empty.logoShape, 'rounded');
  assert.equal(empty.headerStyle, 'cinematic');
});
