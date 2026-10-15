// src/lib/customerDisplayAccent.test.js
//
// The customer display uses the brand colour (its own, else the kiosk's) only when it can be read
// on the display (30 Sep 2026, Coffee Boy Barnsley: '#000000' on the dark display). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  displayAccent, accentUnreadable, inkOnAccent, INK_ON_ACCENT_DARK, INK_ON_ACCENT_LIGHT,
  DISPLAY_ACCENT_DARK, DISPLAY_ACCENT_LIGHT, DISPLAY_BG_DARK, DISPLAY_BG_LIGHT, MIN_ACCENT_CONTRAST,
} from './customerDisplayAccent.js';
import { parseCssColor, contrastRatio } from './kioskTheme.js';
import { resolveDisplayBrand, DISPLAY_BRAND_COLUMN } from './customerDisplayBrand.js';

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
  assert.match(src, /import \{ displayAccent, inkOnAccent \} from '\.\.\/lib\/customerDisplayAccent';/);
  // 2 Oct 2026: the brand comes from the display's own branding resolver (customerDisplayBrand.js),
  // and its colour goes through the contrast rule against the background the display really has.
  assert.match(src, /const brand = displayAccent\(look\.color, \{ dark: look\.dark, bg: C\.bg, text: C\.text \}\);/);
  // Neither the raw kiosk colour nor the resolver's colour is the accent on its own.
  assert.doesNotMatch(src, /const brand = profile\?\.kiosk_brand_color \|\|/);
  assert.doesNotMatch(src, /const brand = look\.color;/);
  // The background handed to the rule is the resolved one (own background over the palette's).
  const look = src.indexOf('const look = resolveDisplayBrand(profile, {');
  const ground = src.indexOf('const C = look.bgColor ? { ...basePalette, bg: look.bgColor } : basePalette;');
  const accent = src.indexOf('const brand = displayAccent(look.color,');
  assert.ok(look > 0 && ground > look && accent > ground, 'resolver, then the background, then the accent');
});

// The display as CustomerDisplaySurface builds it: the resolver, the palette, then the accent.
const TEXT = { dark: '#E9ECEA', light: '#16191C' };
function shown(profile, theme = 'dark') {
  const look = resolveDisplayBrand(profile, { theme, placeName: 'Barnsley' });
  const bg = look.bgColor || (look.dark ? DISPLAY_BG_DARK : DISPLAY_BG_LIGHT);
  const text = look.dark ? TEXT.dark : TEXT.light;
  return { look, bg, accent: displayAccent(look.color, { dark: look.dark, bg, text }) };
}
const reads = (accent, bg) => contrastRatio(parseCssColor(accent), parseCssColor(bg)) >= MIN_ACCENT_CONTRAST;

test('with the own branding resolver: Barnsley\'s black kiosk colour still falls back to the green', () => {
  // No own branding: the resolver hands the kiosk colour through exactly as stored.
  const kiosk = { kiosk_brand_color: '#000000', kiosk_brand_name: 'Coffee Boy' };
  const s = shown(kiosk, 'dark');
  assert.equal(s.look.source, 'kiosk');
  assert.equal(s.look.color, '#000000', 'the resolver does not judge the colour');
  assert.equal(s.accent, DISPLAY_ACCENT_DARK);
  // On a light till the same black reads, so it is kept.
  assert.equal(shown(kiosk, 'light').accent, '#000000');
});

test('with the own branding resolver: an own accent is judged against the own background', () => {
  // Own navy accent on an own cream background: reads, kept.
  assert.equal(shown({ [DISPLAY_BRAND_COLUMN]: { color: '#101a3a', bgColor: '#F4F0E6' } }).accent, '#101a3a');
  // The same navy with no own background, on a dark till: does not read, the green.
  assert.equal(shown({ [DISPLAY_BRAND_COLUMN]: { color: '#101a3a' } }, 'dark').accent, DISPLAY_ACCENT_DARK);
  // Own accent the same as the own background: the default accent for that background's look.
  const same = shown({ [DISPLAY_BRAND_COLUMN]: { color: '#101a3a', bgColor: '#101a3a' } });
  assert.equal(same.accent, DISPLAY_ACCENT_DARK);
  // Own white accent on an own cream background (a light look): the light green.
  assert.equal(shown({ [DISPLAY_BRAND_COLUMN]: { color: '#ffffff', bgColor: '#F4F0E6' } }).accent, DISPLAY_ACCENT_LIGHT);
  // Own branding set, kiosk black ignored: the standard green comes from the resolver and is kept.
  const own = shown({ kiosk_brand_color: '#000000', [DISPLAY_BRAND_COLUMN]: { name: 'Coffee Boy' } });
  assert.equal(own.look.source, 'own');
  assert.equal(own.accent.toLowerCase(), DISPLAY_ACCENT_DARK.toLowerCase());
});

test('an own background the green does not read on either: the accent is the text colour', () => {
  // A mid red background: dark look, the dark green is under 3:1 on it.
  const red = shown({ [DISPLAY_BRAND_COLUMN]: { color: '#E11D48', bgColor: '#E11D48' } });
  assert.equal(red.look.dark, true);
  assert.equal(reads(DISPLAY_ACCENT_DARK, red.bg), false, 'the case this covers');
  assert.equal(red.accent, TEXT.dark.toLowerCase());
  // The ServOS green as the background (a light look) with no accent set: the light green does not read on it.
  const green = shown({ [DISPLAY_BRAND_COLUMN]: { bgColor: '#46E08C' } });
  assert.equal(green.look.dark, false);
  assert.equal(green.accent, TEXT.light.toLowerCase());
  // Without a text colour offered the default accent is still the end, as before.
  assert.equal(displayAccent('#E11D48', { dark: true, bg: '#E11D48' }), DISPLAY_ACCENT_DARK);
});

test('whatever is set, the accent the display draws reads on its background', () => {
  const colours = ['', '#000000', '#ffffff', '#46E08C', '#0E9E55', '#E11D48', '#f97316', '#101a3a', '#808080', '#F4F0E6', '#0F1211', '#7a7a7a', '#3b82f6', '#fde047'];
  for (const theme of ['dark', 'light']) {
    for (const color of colours) {
      for (const bgColor of colours) {
        // Own branding (a name keeps it "own" when both colours are empty)...
        const own = shown({ kiosk_brand_color: '#000000', [DISPLAY_BRAND_COLUMN]: { name: 'x', color, bgColor } }, theme);
        assert.ok(reads(own.accent, own.bg), `own ${color || 'none'} on ${bgColor || 'none'} (${theme}): ${own.accent}`);
        assert.match(own.accent, /^#[0-9a-fA-F]{6}$/);
        // The keypad button is drawn in that accent; its label reads on it.
        assert.ok(reads(inkOnAccent(own.accent), own.accent), `label on ${own.accent}: own ${color || 'none'} on ${bgColor || 'none'} (${theme})`);
      }
      // ...and the kiosk colour while nothing of its own is set.
      const kiosk = shown({ kiosk_brand_color: color }, theme);
      assert.ok(reads(kiosk.accent, kiosk.bg), `kiosk ${color || 'none'} (${theme}): ${kiosk.accent}`);
      assert.ok(reads(inkOnAccent(kiosk.accent), kiosk.accent), `label on ${kiosk.accent}: kiosk ${color || 'none'} (${theme})`);
    }
  }
});

test('the label on the keypad button reads on whatever accent the button is drawn in', () => {
  // The standard looks and bright accents keep the near black label they always had.
  for (const accent of [DISPLAY_ACCENT_DARK, DISPLAY_ACCENT_LIGHT, '#46e08c', '#0e9e55', '#E11D48', '#f97316', '#fde047', '#ffffff', '#e9ecea']) {
    assert.equal(inkOnAccent(accent), INK_ON_ACCENT_DARK, accent);
  }
  assert.equal(INK_ON_ACCENT_DARK, '#0b0c10', 'the label colour the button had before');
  // A dark accent gets a white label: the display's light look text colour, black, navy.
  for (const accent of ['#16191c', '#16191C', '#000000', '#101a3a', '#0F1211']) {
    assert.equal(inkOnAccent(accent), INK_ON_ACCENT_LIGHT, accent);
  }
  // Not a colour: the near black, as before.
  for (const junk of [null, undefined, '', 'notacolour!']) assert.equal(inkOnAccent(junk), INK_ON_ACCENT_DARK, String(junk));
  // One of the two always reads, on every grey from black to white and a spread of hues.
  const hex = (n) => n.toString(16).padStart(2, '0');
  for (let v = 0; v <= 255; v++) {
    const grey = `#${hex(v)}${hex(v)}${hex(v)}`;
    assert.ok(reads(inkOnAccent(grey), grey), grey);
  }
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const c = `#${hex(r)}${hex(g)}${hex(b)}`;
    assert.ok(reads(inkOnAccent(c), c), c);
  }
});

test('a light own background with no accent set: the button is the text colour and its label is white', () => {
  // Yellow, sky blue, grey, beige, pink: light looks the light green does not read on, so the
  // accent is the display's dark text colour. The fixed near black label on it was 1.1:1.
  for (const bgColor of ['#FFD966', '#87CEEB', '#D9D9D9', '#E8DCC8', '#F5C6CB']) {
    const s = shown({ [DISPLAY_BRAND_COLUMN]: { bgColor } });
    assert.equal(s.look.dark, false, bgColor);
    assert.equal(s.accent, TEXT.light.toLowerCase(), bgColor);
    assert.equal(reads(INK_ON_ACCENT_DARK, s.accent), false, 'the case this covers');
    assert.equal(inkOnAccent(s.accent), INK_ON_ACCENT_LIGHT, bgColor);
  }
  // The kiosk's black on a light till (kept there, it reads on the background): white label too.
  assert.equal(inkOnAccent(shown({ kiosk_brand_color: '#000000' }, 'light').accent), INK_ON_ACCENT_LIGHT);
  // The standard dark and light displays: the green button with the near black label, unchanged.
  assert.equal(inkOnAccent(shown({}, 'dark').accent), INK_ON_ACCENT_DARK);
  assert.equal(inkOnAccent(shown({}, 'light').accent), INK_ON_ACCENT_DARK);
});

test('wiring: the keypad button picks its label through inkOnAccent, not a fixed colour', () => {
  const src = fs.readFileSync(new URL('../surfaces/CustomerDisplaySurface.jsx', import.meta.url), 'utf8');
  assert.match(src, /background: ready \? brand : C\.surface, color: ready \? inkOnAccent\(brand\) : C\.faint,/);
  assert.doesNotMatch(src, /color: ready \? '#0b0c10'/);
});

test('wiring: the Back Office preview draws the accent the display draws, and says when it is swapped', () => {
  const bo = fs.readFileSync(new URL('../backoffice/sections/DeviceProfiles.jsx', import.meta.url), 'utf8');
  assert.match(bo, /import \{ displayAccent, accentUnreadable \} from '\.\.\/\.\.\/lib\/customerDisplayAccent';/);
  assert.match(bo, /const previewBg = look\.bgColor \|\| DISPLAY_DARK_BG;/);
  assert.match(bo, /const accent = displayAccent\(look\.color, \{ dark: look\.dark, bg: previewBg, text: ink \}\);/);
  assert.match(bo, /const accentSwapped = look\.from\.color !== 'default' && accentUnreadable\(look\.color, \{ dark: look\.dark, bg: previewBg \}\);/);
  assert.match(bo, /borderLeft:`4px solid \$\{accent\}`/);
  assert.match(bo, /color: accent \}\}>\{money\(12\.5\)\}/);
  assert.doesNotMatch(bo, /color: look\.color \}\}/, 'the preview never draws the raw colour');
  assert.match(bo, /This accent colour is too close to the dark background to read\. A display in the dark look shows the standard green instead\./);
});

test('accentUnreadable: true only for a real colour that does not read on the background', () => {
  assert.equal(accentUnreadable('#000000', { dark: true }), true);
  assert.equal(accentUnreadable('#000000', { dark: false }), false);
  assert.equal(accentUnreadable('#E11D48', { dark: true, bg: '#E11D48' }), true);
  assert.equal(accentUnreadable('red', { dark: true }), false, 'a named colour that reads is not swapped');
  for (const junk of [null, '', 'notacolour!']) assert.equal(accentUnreadable(junk, { dark: true }), false);
  // It agrees with displayAccent: unreadable exactly when the colour is not the one handed back.
  for (const c of ['#000000', '#ffffff', '#E11D48', '#101a3a', '#808080']) {
    for (const dark of [true, false]) {
      assert.equal(accentUnreadable(c, { dark }), displayAccent(c, { dark }) !== c.toLowerCase(), `${c} ${dark}`);
    }
  }
});
