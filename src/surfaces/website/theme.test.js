// Theme contract (ARCHITECTURE.md section 5): branding drives the palette, body text reads at
// 4.5:1 in every mood for any brand colour, and the SSR :root block carries only our variables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteVars, cssText, fontLinks, contrastRatio, ensureContrast, normaliseTheme, brandColorFor, MOODS, TYPES, BUTTONS, MIN_BODY_CONTRAST } from './theme.js';

const REQUIRED = ['--w-bg', '--w-card', '--w-ink', '--w-muted', '--w-line', '--w-brand', '--w-brand-deep', '--w-warm', '--w-radius', '--w-font-display', '--w-font-body'];
const BRANDS = ['#e2581f', '#15C26A', '#000000', '#ffffff', '#ffeb3b', '#1a237e', '#808080', 'not-a-colour', null];

test('every mood, type and button gives every required variable', () => {
  for (const mood of MOODS) for (const type of TYPES) for (const buttons of BUTTONS) {
    const v = siteVars({ mood, type, buttons }, { brand_color: '#e2581f' });
    for (const k of REQUIRED) assert.ok(typeof v[k] === 'string' && v[k], `${mood}/${type}/${buttons} missing ${k}`);
  }
});

test('body text and muted text read at 4.5:1 or better against the background in every mood for any brand', () => {
  for (const mood of MOODS) for (const brand of BRANDS) {
    const v = siteVars({ mood }, { brand_color: brand });
    assert.ok(contrastRatio(v['--w-ink'], v['--w-bg']) >= MIN_BODY_CONTRAST, `${mood} ${brand} ink ${contrastRatio(v['--w-ink'], v['--w-bg']).toFixed(2)}`);
    assert.ok(contrastRatio(v['--w-muted'], v['--w-bg']) >= MIN_BODY_CONTRAST, `${mood} ${brand} muted ${contrastRatio(v['--w-muted'], v['--w-bg']).toFixed(2)}`);
    assert.ok(contrastRatio(v['--w-on-brand'], v['--w-brand']) >= 3, `${mood} ${brand} button text (3:1 UI floor)`);
  }
});

test('brand colour: theme override wins, else Appearance branding, else the default; bad values fall through', () => {
  assert.equal(brandColorFor({ brand_color: '#123456' }, { brand_color: '#e2581f' }), '#123456');
  assert.equal(brandColorFor({ brand_color: null }, { brand_color: '15C26A' }), '#15C26A');
  assert.equal(brandColorFor({ brand_color: 'red' }, { brand_color: 'blue' }), '#e2581f');
  assert.equal(siteVars({ mood: 'light' }, { brand_color: '#e2581f' })['--w-brand'], '#e2581f', 'a brand that reads on paper is used as is');
  const green = siteVars({ mood: 'light' }, { brand_color: '#15C26A' })['--w-brand'];
  assert.notEqual(green.toLowerCase(), '#15c26a', 'signal green on paper is under 3:1, so the button colour is deepened');
  assert.ok(contrastRatio(green, '#f6f2ec') >= 3);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
  assert.ok(g > r && g > b, 'and it stays green');
});

test('type pairings and button radius', () => {
  assert.match(siteVars({ type: 'warm-serif' })['--w-font-display'], /Fraunces/);
  assert.match(siteVars({ type: 'clean-sans' })['--w-font-body'], /Inter/);
  assert.match(siteVars({ type: 'classic' })['--w-font-display'], /Playfair/);
  assert.equal(siteVars({ buttons: 'pill' })['--w-radius'], '999px');
  assert.equal(siteVars({ buttons: 'square' })['--w-radius'], '2px');
  assert.equal(normaliseTheme({ layout: 'x', type: 'y', buttons: 'z', mood: 'w' }).layout, 'ember');
  assert.equal(normaliseTheme(null).mood, 'light');
});

test('cssText emits one :root block with only --w-* tokens, and fontLinks is a Google css2 href', () => {
  const css = cssText({ '--w-bg': '#fff', '--w-ink': '#000', '--evil': 'x', '--w-bad': 'url(x);}body{', 'color': 'red' });
  assert.equal(css, ':root{--w-bg:#fff;--w-ink:#000}');
  assert.equal(cssText(null), ':root{}');
  const links = fontLinks({ type: 'classic' });
  assert.equal(links.length, 1);
  assert.match(links[0], /^https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display.*display=swap$/);
});

test('ensureContrast moves towards the readable extreme and stops once it passes', () => {
  const fixed = ensureContrast('#777777', '#808080');
  assert.ok(contrastRatio(fixed, '#808080') >= 4.5, 'mid grey: only black gets there, so it goes black');
  assert.equal(ensureContrast('#777777', '#808080', 30), '#000000', 'unreachable: the better extreme');
  assert.equal(ensureContrast('#cccccc', '#f6f2ec'), ensureContrast('#cccccc', '#f6f2ec'));
  assert.equal(ensureContrast('#000000', '#ffffff'), '#000000');
});
