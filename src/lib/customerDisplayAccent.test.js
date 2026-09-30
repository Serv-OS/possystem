// src/lib/customerDisplayAccent.test.js
//
// The customer display uses the kiosk brand colour only when it can be read on the display
// (30 Sep 2026, Coffee Boy Barnsley: '#000000' on the dark display). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  displayAccent, DISPLAY_ACCENT_DARK, DISPLAY_ACCENT_LIGHT, DISPLAY_BG_DARK, DISPLAY_BG_LIGHT, MIN_ACCENT_CONTRAST,
} from './customerDisplayAccent.js';
import { parseCssColor, contrastRatio } from './kioskTheme.js';

test('Barnsley: the kiosk black on the dark display falls back to the ServOS green', () => {
  assert.equal(displayAccent('#000000', { dark: true, bg: DISPLAY_BG_DARK }), DISPLAY_ACCENT_DARK);
  assert.equal(displayAccent('#000000'), DISPLAY_ACCENT_DARK, 'dark is the default look');
  // Near black and very dark colours too.
  assert.equal(displayAccent('#101418', { dark: true }), DISPLAY_ACCENT_DARK);
  assert.equal(displayAccent('#1a1a2e', { dark: true }), DISPLAY_ACCENT_DARK);
});

test('the same black reads on the light display, so it is kept there', () => {
  assert.equal(displayAccent('#000000', { dark: false, bg: DISPLAY_BG_LIGHT }), '#000000');
});

test('a white or pale brand colour on the light display falls back to the light green', () => {
  assert.equal(displayAccent('#ffffff', { dark: false }), DISPLAY_ACCENT_LIGHT);
  assert.equal(displayAccent('#fff7cc', { dark: false }), DISPLAY_ACCENT_LIGHT);
  // ...and is kept on the dark display, where it reads.
  assert.equal(displayAccent('#fff', { dark: true }), '#ffffff');
});

test('a readable brand colour is kept, as a hex the tints can extend', () => {
  assert.equal(displayAccent('#E11D48', { dark: true }), '#e11d48');
  assert.equal(displayAccent('#f97316', { dark: true }), '#f97316');
  assert.equal(displayAccent('rgb(70, 224, 140)', { dark: true }), '#46e08c');
  assert.match(displayAccent('orange', { dark: true }), /^#[0-9a-f]{6}$/);
  // '<colour>44' stays a valid 8 digit hex (the stamp card borders).
  assert.match(displayAccent('#E11D48') + '44', /^#[0-9a-f]{8}$/);
});

test('no colour, or one that is not a colour, gives the default accent for the look', () => {
  for (const junk of [null, undefined, '', '   ', 'notacolour!', 'url(x)', 42, {}]) {
    assert.equal(displayAccent(junk, { dark: true }), DISPLAY_ACCENT_DARK, String(junk));
    assert.equal(displayAccent(junk, { dark: false }), DISPLAY_ACCENT_LIGHT, String(junk));
  }
});

test('the defaults themselves read on their own backgrounds', () => {
  for (const [accent, bg] of [[DISPLAY_ACCENT_DARK, DISPLAY_BG_DARK], [DISPLAY_ACCENT_LIGHT, DISPLAY_BG_LIGHT]]) {
    assert.ok(contrastRatio(parseCssColor(accent), parseCssColor(bg)) >= MIN_ACCENT_CONTRAST, accent);
  }
});

test('an unreadable background falls back to the look\'s own background', () => {
  assert.equal(displayAccent('#000000', { dark: true, bg: 'nonsense' }), DISPLAY_ACCENT_DARK);
});

test('wiring: the customer display takes its accent through displayAccent', () => {
  const src = fs.readFileSync(new URL('../surfaces/CustomerDisplaySurface.jsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ displayAccent \} from '\.\.\/lib\/customerDisplayAccent';/);
  assert.match(src, /const brand = displayAccent\(profile\?\.kiosk_brand_color, \{ dark: C\.dark, bg: C\.bg \}\);/);
  // The raw kiosk colour is never used as the accent on its own again.
  assert.doesNotMatch(src, /const brand = profile\?\.kiosk_brand_color \|\|/);
});
