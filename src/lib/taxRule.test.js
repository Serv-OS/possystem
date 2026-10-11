// taxRule.test.js: the one tax rule every channel follows (8 Oct 2026).
// Run: `npm test`, or `node --test src/lib/taxRule.test.js`.
//
// Three shared answers, pinned here on their own so tax.js and taxEngine.js can only agree:
//   1. which Back Office override key a sale's order type reads (collection and drive thru read
//      Takeaway, a bar tab reads Bar, everything else its own key);
//   2. how VAT is rounded: half up to the penny on the TRUE value, once per check;
//   3. what the record of a fallback looks like when a line's rate could not be matched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TAX_ORDER_TYPE_ALIASES, taxOrderTypeKey, taxOverrideFor,
  roundHalfUpMinor, roundVat,
  TAX_FALLBACK_REASONS, TAX_FALLBACK_WORDS, taxFallbackNote, taxFallbacksOf, NOT_IN_MENU,
} from './taxRule.js';

test('the alias table: collection and drive thru read Takeaway, bar tab reads Bar, nothing else is aliased', () => {
  assert.deepEqual(TAX_ORDER_TYPE_ALIASES, { collection: 'takeaway', 'drive-thru': 'takeaway', 'bar-tab': 'bar' });
  assert.ok(Object.isFrozen(TAX_ORDER_TYPE_ALIASES));
  assert.equal(taxOrderTypeKey('collection'), 'takeaway');
  assert.equal(taxOrderTypeKey('drive-thru'), 'takeaway');
  assert.equal(taxOrderTypeKey('bar-tab'), 'bar');
  for (const own of ['dine-in', 'takeaway', 'delivery', 'bar', 'counter', 'catering', 'anything']) assert.equal(taxOrderTypeKey(own), own);
  assert.equal(taxOrderTypeKey(undefined), undefined);
});

test('taxOverrideFor: the sale\'s own key first, then the alias; undefined means no override, null means the venue default', () => {
  const item = { taxRateId: 'std', taxOverrides: { takeaway: 'zero', bar: 'red', 'drive-thru': 'red5' } };
  assert.equal(taxOverrideFor(item, 'takeaway'), 'zero');
  assert.equal(taxOverrideFor(item, 'collection'), 'zero', 'collection reads Takeaway');
  assert.equal(taxOverrideFor(item, 'drive-thru'), 'red5', 'its own key wins over the alias');
  assert.equal(taxOverrideFor(item, 'bar-tab'), 'red', 'a bar tab reads Bar');
  assert.equal(taxOverrideFor(item, 'bar'), 'red');
  assert.equal(taxOverrideFor(item, 'dine-in'), undefined);
  assert.equal(taxOverrideFor(item, 'counter'), undefined);
  assert.equal(taxOverrideFor(item, 'delivery'), undefined);
  // an explicit null (the editor's "Use default" on an override) is a real override, through the alias too
  assert.equal(taxOverrideFor({ taxOverrides: { takeaway: null } }, 'collection'), null);
  assert.equal(taxOverrideFor({ taxOverrides: { takeaway: null } }, 'takeaway'), null);
  // the alias never runs backwards
  assert.equal(taxOverrideFor({ taxOverrides: { collection: 'zero' } }, 'takeaway'), undefined);
  assert.equal(taxOverrideFor({ taxOverrides: { 'bar-tab': 'zero' } }, 'bar'), undefined);
  // shapes with no overrides
  assert.equal(taxOverrideFor({ taxOverrides: null }, 'takeaway'), undefined);
  assert.equal(taxOverrideFor({ taxOverrides: 'x' }, 'takeaway'), undefined);
  assert.equal(taxOverrideFor({}, 'takeaway'), undefined);
  assert.equal(taxOverrideFor(null, 'takeaway'), undefined);
  // the engine's legacy block is the same shape
  assert.equal(taxOverrideFor({ taxRateId: 'std', taxOverrides: { takeaway: 'zero' } }, 'collection'), 'zero');
});

test('roundHalfUpMinor: half up on the true value, floating point noise never pulls a half penny down', () => {
  // the live cases: 814 sales sat on a half penny and the column rounded the raw float DOWN
  assert.equal(roundHalfUpMinor(10.05 - 10.05 / 1.2), 1.68, '10.05 at 20% is exactly 1.675 (arrives as 1.6749999999999998)');
  assert.equal(roundHalfUpMinor(5.85 - 5.85 / 1.2), 0.98, '5.85 at 20% is exactly 0.975');
  assert.equal(roundHalfUpMinor(3.75 - 3.75 / 1.2), 0.63, '3.75 at 20% is exactly 0.625');
  assert.equal(roundHalfUpMinor(1.005), 1.01, 'Math.round(1.005 * 100) / 100 gives 1');
  assert.equal(roundHalfUpMinor(3 * 0.99 - (3 * 0.99) / 1.2), 0.5, '3 x 0.99 at 20%: 0.495 exactly, up to 0.50 (review ADV6)');
  // ordinary figures
  assert.equal(roundHalfUpMinor(0.9333333333333327), 0.93);
  assert.equal(roundHalfUpMinor(4.189), 4.19);
  assert.equal(roundHalfUpMinor(4.184), 4.18);
  assert.equal(roundHalfUpMinor(12), 12);
  assert.equal(roundHalfUpMinor(0.1), 0.1);
  assert.equal(roundHalfUpMinor(0.004), 0);
  assert.equal(roundHalfUpMinor(1e-9), 0);
  // a real quarter penny below the half stays down (only noise within a millionth is clamped)
  assert.equal(roundHalfUpMinor(0.4549), 0.45);
  assert.equal(roundHalfUpMinor(0.45499), 0.45);
  // symmetric for a refund's negative figure: half away from zero, and never minus zero
  assert.equal(roundHalfUpMinor(-0.625), -0.63);
  assert.equal(roundHalfUpMinor(-(10.05 - 10.05 / 1.2)), -1.68);
  assert.equal(Object.is(roundHalfUpMinor(-0.001), 0), true);
  // other minor units
  assert.equal(roundHalfUpMinor(1.2345, 3), 1.235);
  assert.equal(roundHalfUpMinor(1.5, 0), 2);
  // not a number: 0
  assert.equal(roundHalfUpMinor(NaN), 0);
  assert.equal(roundHalfUpMinor('abc'), 0);
  assert.equal(roundHalfUpMinor(null), 0);
  assert.equal(roundHalfUpMinor(Infinity), 0);
  // a string number is read
  assert.equal(roundHalfUpMinor('4.189'), 4.19);
});

test('roundVat: the stored figure, two decimals; null stays null (not recorded is never 0)', () => {
  assert.equal(roundVat(1.6749999999999998), 1.68);
  assert.equal(roundVat(0.9749999999999996), 0.98);
  assert.equal(roundVat(0), 0);
  assert.equal(roundVat('0.625'), 0.63);
  assert.equal(roundVat(-0.625), -0.63);
  assert.equal(roundVat(null), null);
  assert.equal(roundVat(undefined), null);
  assert.equal(roundVat(''), null);
  assert.equal(roundVat(NaN), null);
  assert.equal(roundVat('abc'), null);
  // every answer is a two decimal number: what numeric(10,2) stores, byte for byte
  for (let p = 1; p <= 3000; p++) {
    const v = roundVat(p / 100 - (p / 100) / 1.2);
    assert.equal(v, Number(v.toFixed(2)), `${p / 100}`);
    assert.ok(Math.abs(v - (p / 100 - (p / 100) / 1.2)) <= 0.005 + 1e-9, `${p / 100} -> ${v} within half a penny`);
  }
});

test('the fallback note: source, reason, the line, the item, its name and the id that could not be matched', () => {
  assert.equal(NOT_IN_MENU, '__not_in_menu__');
  for (const r of Object.values(TAX_FALLBACK_REASONS)) assert.equal(typeof TAX_FALLBACK_WORDS[r], 'string', `${r} has words`);
  const line = { uid: 'u1', id: 'latte', itemId: 'latte', name: 'Latte', price: 3.6 };
  assert.deepEqual(taxFallbackNote('rate-not-found', line, 'ts-std'), { source: 'fallback', reason: 'rate-not-found', lineId: 'u1', itemId: 'latte', name: 'Latte', rateId: 'ts-std' });
  // an engine order line (lineId already picked out), a channel line (id only), a bare line
  assert.deepEqual(taxFallbackNote('item-not-on-menu', { lineId: 'hr-33', itemId: null, name: 'Double Smash Burger' }, NOT_IN_MENU),
    { source: 'fallback', reason: 'item-not-on-menu', lineId: 'hr-33', itemId: null, name: 'Double Smash Burger', rateId: NOT_IN_MENU });
  assert.deepEqual(taxFallbackNote('custom-item', { id: 'c1', itemId: 'custom', name: 'Coffee beans' }),
    { source: 'fallback', reason: 'custom-item', lineId: 'c1', itemId: 'custom', name: 'Coffee beans', rateId: null });
  assert.deepEqual(taxFallbackNote('no-default-rate', {}), { source: 'fallback', reason: 'no-default-rate', lineId: null, itemId: null, name: null, rateId: null });
  assert.equal(taxFallbackNote('made-up', line).reason, 'rate-not-found', 'an unknown reason is recorded as the plain one');
  assert.equal(taxFallbackNote('rate-not-found', null).lineId, null);
  // reading them back off a record
  assert.deepEqual(taxFallbacksOf({ fallbacks: [{ reason: 'x' }, null, 'bad'] }), [{ reason: 'x' }]);
  assert.deepEqual(taxFallbacksOf({}), []);
  assert.deepEqual(taxFallbacksOf(null), []);
  assert.deepEqual(taxFallbacksOf({ fallbacks: {} }), []);
});

test('the rule file imports nothing, and the two engines and every lib close path read the rule from it', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.doesNotMatch(read('./taxRule.js'), /^\s*import /m, 'taxRule.js imports nothing, so anything can import it');
  for (const [file, re] of [
    ['./tax.js', /from '\.\/taxRule\.js'/],
    ['./taxEngine.js', /from '\.\/taxRule\.js'/],
    ['./taxCompute.js', /taxFallbackNote, taxFallbacksOf \} from '\.\/taxRule\.js'/],
    ['./taxShare.js', /import \{ roundVat \} from '\.\/taxRule\.js'/],
    ['./publicCheckTax.js', /import \{ roundVat \} from '\.\/taxRule\.js'/],
    ['./headlessTax.js', /roundVat, TAX_FALLBACK_REASONS \} from '\.\/taxRule\.js'/],
    ['./barTabTax.js', /import \{ roundVat \} from '\.\/taxRule\.js'/],
    ['./channelMoney.js', /import \{ roundVat, NOT_IN_MENU \} from '\.\/taxRule\.js'/],
    ['./closedCheckRow.js', /import \{ roundVat \} from '\.\/taxRule\.js'/],
  ]) assert.match(read(file), re, `${file} reads the one rule`);
  // no lib tax path keeps a rounding rule of its own any more
  for (const file of ['./tax.js', './taxEngine.js', './taxShare.js', './headlessTax.js', './channelMoney.js', './barTabTax.js', './publicCheckTax.js']) {
    assert.doesNotMatch(read(file), /Math\.round\([^;]*\* *100\) *\/ *100/, `${file} has no Math.round(x * 100) / 100 of its own`);
    assert.doesNotMatch(read(file), /totalTax\.toFixed\(2\)/, `${file} does not toFixed the VAT`);
  }
  // the Xero split by rate mirrors the alias table (it cannot import src/lib)
  const groups = read('../../supabase/functions/_shared/accountingGroups.js');
  assert.match(groups, /const TAX_ORDER_TYPE_ALIASES = \{ collection: 'takeaway', 'drive-thru': 'takeaway', 'bar-tab': 'bar' \};/);
  assert.match(groups, /const ov = itemOverrideFor\(item, ot\);/);
  // the item editor says so next to the rows
  const editor = read('../backoffice/sections/MenuManager.jsx');
  assert.match(editor, /takeaway:'Collection and online collection use the Takeaway rate\.'/);
  assert.match(editor, /bar:'Bar tabs use the Bar rate\.'/);
  assert.match(editor, /ORDER_TYPE_TAX_NOTE\[ot\]/);
});
