// Customer pages never zoom into a box on a phone.
//
// 20 Nov 2026, Peter on Coffee Boy Headingley opened from the app: "it zooms in when you click in a
// box, no way to pinch and zoom back out", then "scrolling stops working". iPhone zooms the page
// into any input whose text is under 16px; the checkout boxes were 14px, and inside the app's
// browser the zoomed page sits in a fixed scroller that then ignores touch. globals.css gives every
// input on a customer page 16px on a touch screen, and CustomerBoot marks the page as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('globals.css: customer page inputs are 16px on a touch screen', () => {
  const css = read('src/styles/globals.css');
  const block = css.match(/@media \(pointer: coarse\) \{[^}]*customer-surface[^}]*\}\s*\}/);
  assert.ok(block, 'the pointer coarse rule for customer pages is there');
  assert.match(block[0], /html\.customer-surface input/);
  assert.match(block[0], /html\.customer-surface select/);
  assert.match(block[0], /html\.customer-surface textarea/);
  assert.match(block[0], /font-size: 16px !important/, 'important, because the boxes set their size inline');
  assert.match(block[0], /:not\(\[type="checkbox"\]\)/, 'ticks keep their size');
});

test('CustomerBoot marks the page as a customer page and unmarks it on the way out', () => {
  const src = read('src/surfaces/CustomerBoot.jsx');
  assert.match(src, /document\.documentElement\.classList\.add\('customer-surface'\)/);
  assert.match(src, /return \(\) => document\.documentElement\.classList\.remove\('customer-surface'\)/);
});

test('the rule never reaches the tills: it is scoped to the customer class, not to #root', () => {
  const css = read('src/styles/globals.css');
  assert.doesNotMatch(css, /@media \(pointer: coarse\) \{\s*input/, 'no bare input rule for touch screens');
});
