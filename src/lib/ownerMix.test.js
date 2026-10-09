/**
 * ownerMix.test.js: the Owner app's side of the Sales mix (src/lib/ownerMix.js).
 * Run: `npm test`, or `node --test src/lib/ownerMix.test.js`.
 *
 * 8 Oct 2026, Peter: "what is Food/drink/other split ... in hospitality a valued piece of data".
 * The function sends the mix (src/lib/ownerSnapshot.test.js proves the fields); this file turns a
 * block into the bar on a card and the rows of the Sales mix card, and the screens draw them
 * without working out a single percent of their own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_OTHER_HINT, toneVar, cardBar, allOtherByCurrency, detailRows, noteFor } from './ownerMix.js';
import { canMix } from './ownerDetail.js';
import { makeMixResolver, newMix, addCheckToMix, mixView, mixRollup } from '../../supabase/functions/_shared/salesMix.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// ── fixtures: real blocks through the shared maths, never hand written shapes ─
const CATS = [
  { id: 'c-food', parent_id: null, label: 'Food', accounting_group: 'Food', master_id: null },
  { id: 'c-cakes', parent_id: 'c-food', label: 'Cakes', accounting_group: '', master_id: null },
  { id: 'c-drinks', parent_id: null, label: 'Drinks', accounting_group: 'Drinks', master_id: null },
  { id: 'c-retail', parent_id: null, label: 'Retail', accounting_group: 'Retail', master_id: null },
  { id: 'c-misc', parent_id: null, label: 'Misc', accounting_group: '', master_id: null },
];
const resolver = makeMixResolver({}, CATS);
const line = (cat, price, name = 'x') => ({ name, itemId: `m-${name}`, cat, price, qty: 1 });
const mixOf = (lines) => { const m = newMix(); addCheckToMix(m, { status: 'paid', items: lines }, resolver); return m; };
// Food 62, Drinks 31, Retail 4 and Misc 3 (no group): the fold holds two groups, so it is "Other".
// The comparison was Food 59, Drinks 34, Retail 4, Misc 3: Food up 3 points, Drinks down 3.
const NOW_LINES = [line('c-food', 50, 'pie'), line('c-cakes', 12, 'cake'), line('c-drinks', 31, 'tea'), line('c-retail', 4, 'beans'), line('c-misc', 3, 'odd')];
const THEN_LINES = [line('c-food', 59, 'pie'), line('c-drinks', 34, 'tea'), line('c-retail', 4, 'beans'), line('c-misc', 3, 'odd')];
const BLOCK = mixView(mixOf(NOW_LINES), mixOf(THEN_LINES), resolver);
const NO_CMP = mixView(mixOf(NOW_LINES), null, resolver);
const ALL_OTHER = mixView(mixOf([line('c-misc', 10, 'odd'), line(null, 5, 'loose')]), mixOf([line('c-misc', 8, 'odd')]), resolver);
const EMPTY = mixView(newMix(), null, resolver);

test('canMix: only a function that names the mix', () => {
  assert.equal(canMix({ features: ['period', 'business_day', 'compare', 'by_currency', 'detail', 'mix'] }), true);
  assert.equal(canMix({ features: ['period', 'business_day', 'compare', 'by_currency', 'detail'] }), false);
  assert.equal(canMix({}), false);
  assert.equal(canMix(null), false);
});

test('the card bar: nothing for a missing block or no item sales', () => {
  assert.equal(cardBar(null), null);
  assert.equal(cardBar(undefined), null);
  assert.equal(cardBar(EMPTY), null);
  assert.equal(cardBar({ total: 0, groups: [] }), null);
});

test('the card bar: the top two named groups, one fold, the words and the points', () => {
  const bar = cardBar(BLOCK);
  assert.equal(bar.words, 'Food 62%  Drinks 31%  Other 7%');
  assert.equal(bar.allOther, false);
  assert.equal(bar.hint, null);
  assert.deepEqual(bar.segments.map((s) => [s.key, s.name, s.share, s.pts, s.ptsText, s.color]), [
    ['food', 'Food', 62, 3, '+3 pts', 'var(--acc)'],
    ['drinks', 'Drinks', 31, -3, '-3 pts', 'var(--blu)'],
    ['rest', 'Other', 7, 0, '0 pts', 'var(--t3)'],   // nothing moved: "0 pts", never silence
  ]);
  assert.equal(bar.segments.reduce((s, x) => s + x.share, 0), 100);
  // No comparison: the shares alone, no points words at all.
  const quietBar = cardBar(NO_CMP);
  assert.equal(quietBar.words, 'Food 62%  Drinks 31%  Other 7%');
  assert.deepEqual(quietBar.segments.map((s) => [s.pts, s.ptsText]), [[null, ''], [null, ''], [null, '']]);
  // One named group and Other sales: the fold is Other sales itself, in its own grey.
  const two = cardBar(mixView(mixOf([line('c-food', 80, 'pie'), line('c-misc', 20, 'odd')]), null, resolver));
  assert.deepEqual(two.segments.map((s) => [s.key, s.name, s.share, s.color]), [['food', 'Food', 80, 'var(--acc)'], ['other', 'Other sales', 20, 'var(--t3)']]);
  assert.equal(two.words, 'Food 80%  Other sales 20%');
});

// 8 Oct 2026 (review finding 1): the bar's points and the Sales mix card's points for one block
// are the same numbers. A group that sold in the comparison and nothing now (Misc here) leaves the
// bar, but its comparison money stays in the denominator, so Food reads +10 pts on the card and
// "was 50% · +10 pts" on the detail card, never -3 against +10.
test('the card bar and the Sales mix card never disagree on the points for one block', () => {
  const now = mixOf([line('c-food', 60, 'pie'), line('c-drinks', 40, 'tea')]);
  const then = mixOf([line('c-food', 50, 'pie'), line('c-drinks', 30, 'tea'), line('c-misc', 20, 'odd')]);
  const block = mixView(now, then, resolver);
  const bar = cardBar(block);
  const rows = detailRows(block);
  assert.deepEqual(bar.segments.map((s) => [s.name, s.share, s.ptsText]), [['Food', 60, '+10 pts'], ['Drinks', 40, '+10 pts']]);
  assert.deepEqual(rows.rows.map((r) => [r.name, r.wasText]), [['Food', 'was 50% · +10 pts'], ['Drinks', 'was 30% · +10 pts'], ['Other sales', 'was 20% · -20 pts']]);
  for (const s of bar.segments) assert.equal(s.pts, rows.rows.find((r) => r.key === s.key).pts, `${s.key}`);
  // The same with a named group (Retail) dropping to nothing.
  const then2 = mixOf([line('c-food', 50, 'pie'), line('c-drinks', 30, 'tea'), line('c-retail', 20, 'beans')]);
  const block2 = mixView(now, then2, resolver);
  assert.deepEqual(cardBar(block2).segments.map((s) => [s.key, s.pts]), [['food', 10], ['drinks', 10]]);
  assert.deepEqual(detailRows(block2).rows.map((r) => [r.key, r.pts]), [['food', 10], ['drinks', 10], ['retail', -20]]);
});

test('nothing set up: one grey Other sales segment, no points noise, and the hint only when asked', () => {
  const bar = cardBar(ALL_OTHER);
  assert.equal(bar.allOther, true);
  assert.deepEqual(bar.segments, [{ key: 'other', name: 'Other sales', share: 100, pts: null, ptsText: '', color: 'var(--t3)' }]);
  assert.equal(bar.words, 'Other sales 100%');
  assert.equal(bar.hint, null);
  assert.equal(cardBar(ALL_OTHER, { hint: true }).hint, ALL_OTHER_HINT);
  assert.equal(ALL_OTHER_HINT, 'No sales groups set yet. Set them in Back Office, Reports, Sales mix.');
  // quiet hides an all Other block (a venue card in a currency with nothing set up), never a mixed one.
  assert.equal(cardBar(ALL_OTHER, { quiet: true }), null);
  assert.notEqual(cardBar(BLOCK, { quiet: true }), null);
});

test('colours are by group key, not by rank, so Food keeps its colour when Drinks is bigger', () => {
  const drinksFirst = mixView(mixOf([line('c-drinks', 70, 'tea'), line('c-food', 30, 'pie')]), null, resolver);
  const byKey = Object.fromEntries(cardBar(drinksFirst).segments.map((s) => [s.key, s.color]));
  assert.deepEqual(byKey, { drinks: 'var(--blu)', food: 'var(--acc)' });
  // Two venues of one currency added up: the same colours on the group card.
  const roll = mixRollup([BLOCK, drinksFirst]);
  const rolled = Object.fromEntries(cardBar(roll).segments.map((s) => [s.key, s.color]));
  assert.equal(rolled.food, 'var(--acc)');
  assert.equal(rolled.drinks, 'var(--blu)');
  assert.equal(toneVar('orn'), 'var(--orn)');
  assert.equal(toneVar(undefined), 'var(--t3)');
});

test('per currency: whether every venue is still Other sales', () => {
  const groups = [{ currency: 'GBP', rollup: { mix: ALL_OTHER } }, { currency: 'USD', rollup: { mix: BLOCK } }, { currency: 'EUR', rollup: {} }];
  assert.deepEqual(allOtherByCurrency(groups), { GBP: true, USD: false, EUR: false });
  assert.deepEqual(allOtherByCurrency([]), {});
  assert.deepEqual(allOtherByCurrency(null), {});
});

test('the Sales mix card rows: bars against the biggest group, Other sales last, the was words and the footer', () => {
  const v = detailRows(BLOCK);
  assert.equal(v.empty, false);
  assert.equal(v.allOther, false);
  assert.deepEqual(v.rows.map((r) => [r.key, r.name, r.money, r.share, r.w, r.color, r.wasText]), [
    ['food', 'Food', 62, 62, 1, 'var(--acc)', 'was 59% · +3 pts'],
    ['drinks', 'Drinks', 31, 31, 0.5, 'var(--blu)', 'was 34% · -3 pts'],
    ['retail', 'Retail', 4, 4, 4 / 62, 'var(--orn)', 'was 4% · 0 pts'],
    ['other', 'Other sales', 3, 3, 3 / 62, 'var(--t3)', 'was 3% · 0 pts'],
  ]);
  assert.deepEqual(v.rows[0].categories, [{ id: 'c-food', label: 'Food', money: 50 }, { id: 'c-cakes', label: 'Cakes', money: 12 }]);
  assert.deepEqual(v.rows[3].categories, [{ id: 'c-misc', label: 'Misc', money: 3 }]);
  assert.equal(v.footer, '3% of item sales are in categories with no group yet.');
  // No comparison: no was words.
  assert.ok(detailRows(NO_CMP).rows.every((r) => r.wasText === '' && r.cmp_share === null && r.pts === null));
  // Everything grouped: no footer. Everything Other: no footer either, the card says so instead.
  assert.equal(detailRows(mixView(mixOf([line('c-food', 10, 'pie')]), null, resolver)).footer, null);
  const all = detailRows(ALL_OTHER);
  assert.deepEqual([all.empty, all.allOther, all.footer], [false, true, null]);
  assert.deepEqual(all.rows.map((r) => [r.key, r.share, r.wasText]), [['other', 100, 'was 100% · 0 pts']]);
  // Nothing sold: empty, and the card says so.
  assert.deepEqual(detailRows(EMPTY), { empty: true, allOther: false, rows: [], footer: null });
  assert.deepEqual(detailRows(null), { empty: true, allOther: false, rows: [], footer: null });
});

test('the card note names the period and, with a comparison, what was means', () => {
  assert.equal(noteFor('today', false), 'Item sales today, before check discounts and refunds.');
  assert.equal(noteFor('week', true), "Item sales this week, before check discounts and refunds. 'Was' is the share in the comparison period.");
  assert.equal(noteFor('month', false), 'Item sales this month, before check discounts and refunds.');
  assert.equal(noteFor('nonsense', true), "Item sales today, before check discounts and refunds. 'Was' is the share in the comparison period.");
});

// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('the screens: no percent worked out on them, no long dashes, nothing imported but React and our own files', () => {
  const files = {
    'ownerMix.js': read('./ownerMix.js'),
    'MixBar.jsx': read('../surfaces/owner/MixBar.jsx'),
    'OwnerReports.jsx': read('../surfaces/owner/OwnerReports.jsx'),
    'OwnerSurface.jsx': read('../surfaces/OwnerSurface.jsx'),
  };
  for (const [name, src] of Object.entries(files)) {
    assert.doesNotMatch(src, LONG_DASHES, `${name} has no long dashes`);
    assert.doesNotMatch(src, /vsPct\(|\/ *100\)/, `${name} works out no percent`);
  }
  for (const m of files['MixBar.jsx'].matchAll(/from '([^']+)'/g)) assert.equal(m[1], 'react', `MixBar imports ${m[1]}`);
  // The bar is sized from the function's whole percents (flex grow), and it is a labelled image.
  assert.ok(files['MixBar.jsx'].includes('flex: `${s.share} 0 0`'));
  assert.ok(files['MixBar.jsx'].includes('aria-label={`Sales mix: ${bar.words}`}'));
  assert.ok(files['MixBar.jsx'].includes('if (!bar) return null;'));
  // The words shown are the ones the function and the shared maths agreed on.
  for (const w of [ALL_OTHER_HINT, noteFor('today', true), 'Show categories', 'Hide categories', 'No item sales in this period.']) {
    assert.doesNotMatch(w, LONG_DASHES, w);
  }
  assert.ok(files['OwnerReports.jsx'].includes("open ? 'Hide categories' : 'Show categories'"));
  assert.ok(files['OwnerReports.jsx'].includes('No sales groups set yet. Set them in Back Office, Reports, Sales mix. Until then every item is in Other sales.'));
});
