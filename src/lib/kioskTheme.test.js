// New kiosk design look (lib/kioskTheme.js): the design green is the default, a venue
// colour still wins, and text on buttons stays readable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DESIGN_GREEN,
  DESIGN_TOKENS,
  kioskPrimary,
  kioskPalette,
  kioskThemeVars,
  kioskBackground,
  kioskBackgroundTooDark,
  kioskAccent,
  OLD_DEFAULT_ACCENT,
  OLD_DEFAULT_BG,
  photoBlock,
  parseCssColor,
  contrastWithWhite,
  contrastRatio,
} from './kioskTheme.js';

test('kioskPrimary gives the design green when no real colour was chosen', () => {
  for (const c of [undefined, null, '', '   ', '#f97316', '#F97316', 'junk', 'url(x)', 'expression(alert(1))', 42]) {
    assert.equal(kioskPrimary({ kiosk_brand_color: c }), DESIGN_GREEN, String(c));
  }
  assert.equal(kioskPrimary(null), DESIGN_GREEN);
  assert.equal(kioskPrimary({ kiosk_brand_color: '#4e7b27' }), DESIGN_GREEN);
});

test('kioskPrimary keeps a venue colour', () => {
  assert.equal(kioskPrimary({ kiosk_brand_color: '#0F5F52' }), '#0f5f52');
  assert.equal(kioskPrimary({ kiosk_brand_color: 'red' }), 'red');
  assert.equal(kioskPrimary({ kiosk_brand_color: 'rgb(21,194,106)' }), 'rgb(21,194,106)');
  assert.equal(kioskPrimary({ kiosk_brand_color: '#abc' }), '#aabbcc');
});

test('the design green palette is exactly the README tokens', () => {
  assert.deepEqual(kioskPalette(DESIGN_GREEN), {
    primary: '#4E7B27', primaryDeep: '#3E6320', primaryTint: '#EDF3E6', onPrimary: '#FFFFFF',
    primaryInk: '#4E7B27', primaryLine: '#4E7B27', onInkEdge: 'none',
  });
  assert.deepEqual(kioskPalette('#4e7b27'), kioskPalette(DESIGN_GREEN));
  assert.deepEqual(kioskPalette('not a colour'), kioskPalette(DESIGN_GREEN));
});

test('other colours: deeper shade, light tint, white text on dark and ink on light', () => {
  const teal = kioskPalette('#0f5f52');
  assert.equal(teal.primary, '#0f5f52');
  assert.equal(teal.onPrimary, '#FFFFFF');
  assert.match(teal.primaryDeep, /^#[0-9a-f]{6}$/);
  assert.match(teal.primaryTint, /^#[0-9a-f]{6}$/);
  // 12% colour on white: red channel 0x0f*0.12 + 255*0.88 = 226.2
  assert.equal(teal.primaryTint.slice(1, 3), 'e2');

  const red = kioskPalette('red');
  assert.equal(red.primaryDeep, '#cc0000');   // HSL lightness 50% becomes 40%
  assert.equal(red.onPrimary, '#FFFFFF');

  assert.equal(kioskPalette('yellow').onPrimary, '#14110F');
  assert.equal(kioskPalette('rgb(21,194,106)').onPrimary, '#14110F');   // bright green: ink reads better
  assert.equal(kioskPalette('#1e3a8a').onPrimary, '#FFFFFF');

  // The old orange default, if passed straight in, needs ink text (white is under 3:1).
  const orange = kioskPalette('#f97316');
  assert.equal(orange.onPrimary, '#14110F');
  assert.ok(contrastWithWhite(parseCssColor('#f97316')) < 3);
  assert.ok(contrastWithWhite(parseCssColor(DESIGN_GREEN)) >= 3);
});

test('parseCssColor reads hex, names, rgb and hsl', () => {
  assert.deepEqual(parseCssColor('#ff8000'), [255, 128, 0]);
  assert.deepEqual(parseCssColor('teal'), [0, 128, 128]);
  assert.deepEqual(parseCssColor('rgb(21, 194, 106)'), [21, 194, 106]);
  assert.deepEqual(parseCssColor('rgba(100%, 0%, 0%, .5)'), [255, 0, 0]);
  assert.deepEqual(parseCssColor('hsl(0, 100%, 50%)'), [255, 0, 0]);
  assert.equal(parseCssColor('bogus'), null);
  assert.equal(parseCssColor(''), null);
});

test('kioskThemeVars sets the four venue variables and the shared --kBrand', () => {
  assert.deepEqual(kioskThemeVars({}), {
    '--k2Primary': '#4E7B27', '--k2PrimaryDeep': '#3E6320', '--k2PrimaryTint': '#EDF3E6', '--k2OnPrimary': '#FFFFFF',
    '--k2PrimaryInk': '#4E7B27', '--k2PrimaryLine': '#4E7B27', '--k2PrimaryOnInkEdge': 'none', '--k2AccentInk': '#4E7B27', '--kBrand': '#4E7B27',
  });
  const v = kioskThemeVars({ kiosk_brand_color: 'yellow' });
  assert.equal(v['--k2Primary'], 'yellow');
  assert.equal(v['--kBrand'], 'yellow');
  assert.equal(v['--k2OnPrimary'], '#14110F');
});

test('photoBlock is a colour gradient, and never lets junk into a style', () => {
  assert.equal(photoBlock('#4E7B27'), 'linear-gradient(135deg, #4e7b27, #4e7b2788)');
  assert.equal(photoBlock('#4E7B27', '99'), 'linear-gradient(135deg, #4e7b27, #4e7b2799)');
  assert.equal(photoBlock('red'), 'linear-gradient(135deg, #ff0000, #ff000088)');
  assert.equal(photoBlock('#123456', 'zz'), 'linear-gradient(135deg, #123456, #12345688)');
  assert.equal(photoBlock('url(evil)'), 'linear-gradient(135deg, #4e7b27, #4e7b2788)');
});

test('DESIGN_TOKENS match the [data-kiosk-theme="design"] block in globals.css', () => {
  const css = fs.readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
  const block = /\[data-kiosk-theme="design"\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'design theme block missing from globals.css');
  const norm = (v) => v.replace(/\s+/g, '').toLowerCase();
  for (const [name, value] of Object.entries(DESIGN_TOKENS)) {
    const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(block[1]);
    assert.ok(m, `${name} missing from globals.css`);
    assert.equal(norm(m[1]), norm(value), name);
  }
  // Both animations the design allows exist.
  assert.match(css, /@keyframes kfade\s*\{/);
  assert.match(css, /@keyframes kpulse\s*\{/);
});

test('a light or very dark venue colour still gives readable text, borders and an order bar edge', () => {
  const WHITE = [255, 255, 255];
  const GROUND = [0xEF, 0xE4, 0xD9];
  const INK = [0x14, 0x11, 0x0F];
  for (const c of ['#15C26A', '#E9C84D', '#9DD3C4', '#ffffff', '#1e90ff', '#000000', '#0F5F52']) {
    const p = kioskPalette(c);
    const ink = parseCssColor(p.primaryInk);
    const line = parseCssColor(p.primaryLine);
    const tint = parseCssColor(p.primaryTint);
    assert.ok(contrastRatio(ink, WHITE) >= 4.5, `${c} ink on white`);
    assert.ok(contrastRatio(ink, tint) >= 3, `${c} ink on tint`);
    assert.ok(contrastRatio(line, WHITE) >= 3, `${c} line on white`);
    assert.ok(contrastRatio(line, GROUND) >= 3, `${c} line on the ground`);
    const needsEdge = contrastRatio(parseCssColor(p.primary), INK) < 3;
    assert.equal(p.onInkEdge !== 'none', needsEdge, `${c} order bar edge`);
  }
  assert.notEqual(kioskPalette('#000000').onInkEdge, 'none');
  assert.equal(kioskPalette('#ffffff').onInkEdge, 'none');
  // A colour that already reads keeps its own value.
  assert.equal(kioskPalette('#0F5F52').primaryInk, '#0f5f52');
  const v = kioskThemeVars({ kiosk_brand_color: '#E9C84D' });
  assert.notEqual(v['--k2PrimaryInk'], '#e9c84d');
});

// v5.8.78 (Peter, 15 Sep 2026: all the old colour settings on the new design; dark theme next).
test('background colour: a light colour replaces the cream; the old default, dark or junk colours do not', () => {
  // Every profile ever saved in Back Office carries the old defaults: they mean "not chosen".
  assert.equal(OLD_DEFAULT_BG, '#0e0e10');
  assert.equal(OLD_DEFAULT_ACCENT, '#fbbf24');
  for (const c of [undefined, null, '', '#0e0e10', 'junk', 'url(x)']) assert.equal(kioskBackground({ kiosk_brand_bg_color: c }), null, String(c));
  const light = kioskBackground({ kiosk_brand_bg_color: '#F4F7FB' });
  assert.equal(light.ground.toLowerCase(), '#f4f7fb');
  assert.ok(contrastRatio(parseCssColor(light.groundDeep), parseCssColor('#14110F')) < contrastRatio(parseCssColor('#F4F7FB'), parseCssColor('#14110F')));
  // Too dark for the light look: not used, and Back Office can say so.
  assert.equal(kioskBackground({ kiosk_brand_bg_color: '#1a1a2e' }), null);
  assert.equal(kioskBackgroundTooDark({ kiosk_brand_bg_color: '#1a1a2e' }), true);
  assert.equal(kioskBackgroundTooDark({ kiosk_brand_bg_color: '#0e0e10' }), false);
  assert.equal(kioskBackgroundTooDark({ kiosk_brand_bg_color: '#F4F7FB' }), false);
  // The shell gets the ground, and the main colour's border still reads on it.
  const v = kioskThemeVars({ kiosk_brand_bg_color: '#FFE9A8', kiosk_brand_color: '#F2C200' });
  assert.equal(v['--k2Ground'].toLowerCase(), '#ffe9a8');
  assert.equal(v['--kSurfaceShell'].toLowerCase(), '#ffe9a8');
  assert.ok(contrastRatio(parseCssColor(v['--k2PrimaryLine']), parseCssColor('#FFE9A8')) >= 3);
  assert.equal(kioskThemeVars({})['--k2Ground'], undefined, 'no background chosen: the cream from globals.css');
});

test('accent colour: highlight text in the accent, always readable on white; none chosen uses the main colour', () => {
  for (const c of [undefined, null, '', '#fbbf24', 'junk']) assert.equal(kioskAccent({ kiosk_brand_accent_color: c }), null, String(c));
  assert.equal(kioskAccent({ kiosk_brand_accent_color: '#C0392B' }), '#c0392b');
  const v = kioskThemeVars({ kiosk_brand_accent_color: '#FFD000' });
  assert.ok(contrastRatio(parseCssColor(v['--k2AccentInk']), [255, 255, 255]) >= 4.5, 'a yellow accent is darkened until it reads');
  assert.equal(kioskThemeVars({ kiosk_brand_color: '#1E6FD9' })['--k2AccentInk'], kioskThemeVars({ kiosk_brand_color: '#1E6FD9' })['--k2PrimaryInk']);
  // The screens use it for the highlight text, with the main colour as the fallback.
  for (const rel of ['KioskItemSheet.jsx', 'KioskItemCard.jsx', 'KioskTotalsCard.jsx', 'KioskLoyaltyRows.jsx', 'KioskCodeCard.jsx']) {
    const src = fs.readFileSync(new URL('../surfaces/kiosk/' + rel, import.meta.url), 'utf8');
    assert.ok(src.includes("var(--k2AccentInk, var(--k2PrimaryInk))"), rel);
  }
});
