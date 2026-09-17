/**
 * ezcaterMatchParity.test.js
 *
 * The matching rules exist TWICE:
 *   src/lib/ezcaterMatch.js                    the browser app
 *   supabase/functions/_shared/ezcaterMatch.ts the ingest edge function
 *
 * They have to live twice because an edge function is deployed on its own, and
 * sometimes by pasting the files under supabase/functions into the Supabase
 * dashboard editor, so it cannot import out of src/. The danger is obvious: the
 * Back Office screen offers a match, the webhook applies a different one, and
 * nobody finds out until a ticket goes to the wrong station.
 *
 * So this file is the join. It runs ONE case table through BOTH modules and
 * compares every output, and it compares the rule tables field by field. Edit
 * one file without the other and this goes red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as js from './ezcaterMatch.js';
import * as ts from '../../supabase/functions/_shared/ezcaterMatch.ts';

// ── the shared case table ───────────────────────────────────────────────────

const NAMES = [
  'Caesar Salad',
  'Caesar Salad (Serves 10)',
  'CAESAR SALAD, half pan',
  'Caesar Salad Large',
  'Caesar Salad Full Tray',
  'BBQ Chicken per person',
  'Veggie Platter feeds 8 people',
  'Veggie Platter serves 10 to 12',
  'Sandwich Platter 20 guests',
  'Mac & Cheese',
  "Chef's Special",
  'Crème Brûlée',
  'Full English Breakfast',
  'Small Plates Selection',
  '12 Inch Sub Platter',
  'Large',
  'Half Pan',
  'Tray',
  '',
  '!!!',
  null,
  undefined,
  'Grilled Chicken Caesar',
  'Ham',
  'Hamburger',
  'Cola',
  'Still Water',
  'Wholemeal',
];

const OUR_ITEMS = [
  { id: 'm-caesar', name: 'Caesar Salad', price: 38 },
  { id: 'm-caesar-s', name: 'Caesar Salad Small', price: 22 },
  { id: 'm-caesar-l', name: 'Caesar Salad Large', price: 38 },
  { id: 'm-cookies', name: 'Chocolate Chip Cookies', price: 24 },
  { id: 'm-sandwich', name: 'Sandwich Platter', menuName: 'Classic Sandwich Platter', price: 95 },
  { id: 'm-mac', name: 'Mac and Cheese', price: 42 },
  { id: 'm-burger', name: 'Hamburger', price: 12 },
  { name: 'No Id At All' },
  null,
];

const OUR_GROUPS = [
  {
    id: 'g-bread',
    name: 'Bread Choice',
    options: [
      { id: 'o-white', name: 'White', price: 0 },
      { id: 'o-brown', name: 'Wholemeal', price: 0 },
      { id: 'o-large', name: 'Large', price: 1 },
    ],
  },
  {
    id: 'g-drinks',
    name: 'Drinks',
    options: [
      { id: 'o-cola', name: 'Cola', price: 2, itemId: 'm-cola' },
      { id: 'o-water', name: 'Still Water', price: 1.5, itemId: 'm-water' },
      { id: 'o-large2', name: 'Large', price: 1 },
    ],
  },
  null,
];

const THEIR_LINES = [
  'Caesar Salad',
  { name: 'Caesar Salad (Serves 10)', price: 38, mods: [] },
  { name: 'Caesar Salad Large', price: 38 },
  { name: 'Caesar Salad', itemId: 'm-cookies' },
  { name: 'Caesar Salad', itemId: 'ghost-id' },
  { name: 'Lobster Thermidor', price: 99 },
  { name: 'Sandwich Platter Deluxe' },
  { name: 'Classic Sandwich Platter' },
  { name: '' },
  {},
  null,
];

const THEIR_MODS = [
  { label: 'Cola', groupLabel: 'Drinks', price: 2 },
  { label: 'Cola', groupLabel: 'Bread Choice' },
  { name: 'Still Water', customizationTypeName: 'Drinks' },
  { label: 'Wholemeal' },
  { label: 'Large', groupLabel: 'Drinks' },
  { label: '', groupLabel: 'Drinks' },
  null,
];

const LINK_SETS = [
  [],
  [{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', menu_item_id: 'm-cookies', source: 'manual' }],
  [{ kind: 'item', ezKey: 'caesar salad', menuItemId: 'm-deleted', source: 'auto' }],
  [{ kind: 'option', ez_key: 'drinks|cola', option_id: 'o-water', menu_item_id: 'm-water', source: 'manual' }],
  { 'caesar salad': { kind: 'item', menu_item_id: 'm-mac', source: 'auto' } },
];

// ── the exports themselves ──────────────────────────────────────────────────

test('both modules export exactly the same names', () => {
  // Interfaces and type aliases leave nothing behind at runtime, so the two
  // runtime export lists must be identical.
  assert.deepEqual(Object.keys(ts).sort(), Object.keys(js).sort());
});

test('the rule tables are identical', () => {
  assert.deepEqual({ ...ts.SIZE_WORDS }, { ...js.SIZE_WORDS });
  assert.deepEqual([...ts.CONTAINER_WORDS], [...js.CONTAINER_WORDS]);
  assert.deepEqual([...ts.TRAILING_DROP], [...js.TRAILING_DROP]);
  assert.deepEqual({ ...ts.WEIGHTS }, { ...js.WEIGHTS });
  assert.equal(ts.DEFAULT_MIN_SCORE, js.DEFAULT_MIN_SCORE);
  assert.equal(ts.DEFAULT_LIMIT, js.DEFAULT_LIMIT);
});

// ── behaviour, function by function ─────────────────────────────────────────

test('normaliseItemName, nameTokens and sizeWordOf agree on every name', () => {
  for (const n of NAMES) {
    assert.equal(ts.normaliseItemName(n), js.normaliseItemName(n), 'normaliseItemName: ' + n);
    assert.deepEqual(ts.nameTokens(n), js.nameTokens(n), 'nameTokens: ' + n);
    assert.equal(ts.sizeWordOf(n), js.sizeWordOf(n), 'sizeWordOf: ' + n);
  }
});

test('scoreMatch agrees on every name against every item', () => {
  let compared = 0;
  for (const n of NAMES) {
    for (const item of OUR_ITEMS) {
      assert.deepEqual(ts.scoreMatch(n, item), js.scoreMatch(n, item), 'scoreMatch: ' + n);
      compared++;
    }
  }
  assert.ok(compared >= 200, 'the case table should be big enough to mean something');
});

test('scoreMatch agrees on mapped lines, where the price counts', () => {
  for (const line of THEIR_LINES) {
    for (const item of OUR_ITEMS) {
      assert.deepEqual(ts.scoreMatch(line, item), js.scoreMatch(line, item));
    }
  }
});

test('suggestMatches returns the identical list, in the identical order', () => {
  for (const line of THEIR_LINES) {
    assert.deepEqual(ts.suggestMatches(line, OUR_ITEMS), js.suggestMatches(line, OUR_ITEMS));
    assert.deepEqual(
      ts.suggestMatches(line, OUR_ITEMS, { limit: 2, minScore: 0.1 }),
      js.suggestMatches(line, OUR_ITEMS, { limit: 2, minScore: 0.1 }),
    );
  }
});

test('buildLinkKey agrees for items and for options', () => {
  for (const line of THEIR_LINES) {
    assert.equal(ts.buildLinkKey(line), js.buildLinkKey(line));
    assert.equal(ts.buildLinkKey(line, 'option'), js.buildLinkKey(line, 'option'));
  }
  for (const mod of THEIR_MODS) {
    assert.equal(ts.buildLinkKey(mod, 'option'), js.buildLinkKey(mod, 'option'));
  }
});

test('autoLinkDecision agrees for every line against every link set', () => {
  for (const line of THEIR_LINES) {
    for (const links of LINK_SETS) {
      assert.deepEqual(
        ts.autoLinkDecision(line, OUR_ITEMS, links),
        js.autoLinkDecision(line, OUR_ITEMS, links),
      );
      // and with no menu loaded, where a link cannot be proved stale
      assert.deepEqual(
        ts.autoLinkDecision(line, [], links),
        js.autoLinkDecision(line, [], links),
      );
    }
  }
});

test('matchOptions and the option arm of autoLinkDecision agree', () => {
  for (const mod of THEIR_MODS) {
    assert.deepEqual(ts.matchOptions(mod, OUR_GROUPS), js.matchOptions(mod, OUR_GROUPS));
    for (const links of LINK_SETS) {
      assert.deepEqual(
        ts.autoLinkDecision(mod, OUR_GROUPS, links, { kind: 'option' }),
        js.autoLinkDecision(mod, OUR_GROUPS, links, { kind: 'option' }),
      );
    }
  }
});

test('applyLinks and countMatches agree, links and counts alike', () => {
  const lines = [
    { name: 'Caesar Salad (Serves 10)', qty: 2, price: 38, mods: [{ label: 'Cola', groupLabel: 'Drinks' }] },
    { name: 'Lobster Thermidor', qty: 1, price: 99, mods: [] },
    { name: 'Caesar Salad', itemId: 'm-wrong', qty: 1, mods: [] },
  ];
  for (const links of LINK_SETS) {
    const a = ts.applyLinks(lines, links);
    const b = js.applyLinks(lines, links);
    assert.deepEqual(a, b);
    assert.deepEqual(ts.countMatches(a), js.countMatches(b));
  }
});

test('indexLinks builds the same index from every link shape', () => {
  for (const links of LINK_SETS) {
    const a = ts.indexLinks(links);
    const b = js.indexLinks(links);
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    for (const k of a.keys()) assert.deepEqual(a.get(k), b.get(k));
  }
});

test('displayNameOf agrees', () => {
  for (const item of OUR_ITEMS) assert.equal(ts.displayNameOf(item), js.displayNameOf(item));
  for (const n of NAMES) assert.equal(ts.displayNameOf(n), js.displayNameOf(n));
});
