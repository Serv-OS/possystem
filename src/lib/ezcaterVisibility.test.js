// ezcaterVisibility.test.js — ezCater is a US thing; UK venues should not see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ezcaterVisible } from './ezcaterVisibility.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('a UK venue with nothing connected never sees ezCater', () => {
  assert.equal(ezcaterVisible({ currency: 'GBP', connected: false }), false);
  assert.equal(ezcaterVisible({ currency: 'gbp' }), false);
  assert.equal(ezcaterVisible({ currency: 'EUR', connected: false }), false);
  assert.equal(ezcaterVisible({}), false, 'unknown is hidden: the platform default currency is GBP');
});

test('a USD venue sees it, connected or not', () => {
  assert.equal(ezcaterVisible({ currency: 'USD', connected: false }), true);
  assert.equal(ezcaterVisible({ currency: 'usd' }), true);
});

test('a connected venue is never hidden by a wrong currency', () => {
  // 23 Sep 2026: Provo is stored as GBP and is the one venue connected to
  // ezCater. Currency alone would have hidden it from the only customer using it.
  assert.equal(ezcaterVisible({ currency: 'GBP', connected: true }), true);
  assert.equal(ezcaterVisible({ currency: null, connected: true }), true);
});

test('the Back Office page actually asks the rule before rendering ezCater', () => {
  const page = read('../backoffice/sections/HubRise.jsx');
  assert.match(page, /import \{ ezcaterVisible \} from '\.\.\/\.\.\/lib\/ezcaterVisibility'/);
  assert.match(page, /ezcaterVisible\(\{ currency: [^}]*, connected: [^}]*\}\)/);
  assert.match(page, /\{ezShow && \(/, 'the whole ezCater block, header included, is behind the gate');
});
