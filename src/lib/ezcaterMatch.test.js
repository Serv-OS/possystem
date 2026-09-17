/**
 * ezcaterMatch.test.js - the pure ezCater item matching rules.
 * Run: `npm test`, or `node --test src/lib/ezcaterMatch.test.js`.
 *
 * We have the ezCater Orders API but NOT the Menus API, so the venue types its
 * ezCater menu by hand and their order lines carry posItemId = null. These
 * fixtures are the venue typing: the same food, spelled their way.
 *
 * What is pinned here:
 *   1. normaliseItemName, every rule it applies and the one it refuses to
 *      (it never strips a name away to nothing)
 *   2. scoreMatch: exact, containment, token overlap, size, price
 *   3. suggestMatches: ranked, capped, stable when scores tie
 *   4. autoLinkDecision: the four rules IN ORDER, and the refusal to guess
 *      between two items that match equally well
 *   5. matchOptions against our modifier groups
 *   6. buildLinkKey and applyLinks, including that they fix the mapper's
 *      null itemId, which is the whole point of the feature
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseItemName, normaliseKeyName, nameTokens, sizeWordOf,
  scoreMatch, suggestMatches, autoLinkDecision, matchOptions,
  buildLinkKey, legacyLinkKey, linkKeyCandidates, findLink,
  indexLinks, applyLinks, countMatches, displayNameOf,
  itemCodeKey, indexItemCodes, findItemCodeMatch,
  SIZE_WORDS, CONTAINER_WORDS, TRAILING_DROP, WEIGHTS,
  DEFAULT_MIN_SCORE, DEFAULT_LIMIT,
} from './ezcaterMatch.js';

import { orderItemsToLines } from '../../supabase/functions/_shared/ezcater-map.ts';

// ── our menu, the way the store holds it ────────────────────────────────────

const OUR_ITEMS = [
  { id: 'm-caesar', name: 'Caesar Salad', price: 38 },
  { id: 'm-cookies', name: 'Chocolate Chip Cookies', price: 24 },
  { id: 'm-sandwich', name: 'Sandwich Platter', menuName: 'Classic Sandwich Platter', price: 95 },
  { id: 'm-mac', name: 'Mac and Cheese', price: 42 },
];

const OUR_GROUPS = [
  {
    id: 'g-bread',
    name: 'Bread Choice',
    options: [
      { id: 'o-white', name: 'White', price: 0 },
      { id: 'o-brown', name: 'Wholemeal', price: 0 },
    ],
  },
  {
    id: 'g-drinks',
    name: 'Drinks',
    options: [
      { id: 'o-cola', name: 'Cola', price: 2, itemId: 'm-cola' },
      { id: 'o-water', name: 'Still Water', price: 1.5, itemId: 'm-water' },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 1. normaliseItemName
// ────────────────────────────────────────────────────────────────────────────

test('normaliseItemName: case, spacing and punctuation all collapse', () => {
  assert.equal(normaliseItemName('  Caesar   SALAD  '), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad.'), 'caesar salad');
  assert.equal(normaliseItemName('Soup & Sandwich'), 'soup and sandwich');
  assert.equal(normaliseItemName("Chef's Special"), 'chefs special');
  assert.equal(normaliseItemName('Creme Brulee'), normaliseItemName('Crème Brûlée'));
});

test('normaliseItemName: bracketed suffixes come off, in any bracket', () => {
  assert.equal(normaliseItemName('Caesar Salad (Serves 10)'), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad [NEW]'), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad {v2}'), 'caesar salad');
});

test('normaliseItemName: catering noise words go', () => {
  assert.equal(normaliseItemName('BBQ Chicken per person'), 'bbq chicken');
  assert.equal(normaliseItemName('BBQ Chicken per head'), 'bbq chicken');
  assert.equal(normaliseItemName('Veggie Tray serves 10'), 'veggie');
  assert.equal(normaliseItemName('Veggie Platter serves 10 to 12'), 'veggie platter');
  assert.equal(normaliseItemName('Veggie Platter serves 10-12'), 'veggie platter');
  assert.equal(normaliseItemName('Veggie Platter feeds 8 people'), 'veggie platter');
  assert.equal(normaliseItemName('Sandwich Platter 20 guests'), 'sandwich platter');
});

test('normaliseItemName: a size word goes only when it TRAILS', () => {
  assert.equal(normaliseItemName('Caesar Salad Large'), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad, Half Pan'), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad Full Tray'), 'caesar salad');
  // Leading or middle size words are part of the product name and stay.
  assert.equal(normaliseItemName('Full English Breakfast'), 'full english breakfast');
  assert.equal(normaliseItemName('Small Plates Selection'), 'small plates selection');
});

test('normaliseItemName: NEVER strips a name away to nothing', () => {
  // On a modifier option the single size word IS the product.
  assert.equal(normaliseItemName('Large'), 'large');
  assert.equal(normaliseItemName('Half Pan'), 'half');
  assert.equal(normaliseItemName('Tray'), 'tray');
  assert.equal(normaliseItemName(''), '');
  assert.equal(normaliseItemName(null), '');
  assert.equal(normaliseItemName(undefined), '');
  assert.equal(normaliseItemName('!!!'), '');
});

test('normaliseItemName: deterministic, and numbers survive', () => {
  const a = normaliseItemName('12 Inch Sub Platter');
  assert.equal(a, '12 inch sub platter');
  for (let i = 0; i < 5; i++) assert.equal(normaliseItemName('12 Inch Sub Platter'), a);
});

test('nameTokens dedupes and keeps first seen order', () => {
  assert.deepEqual(nameTokens('Cheese Cheese Board'), ['cheese', 'board']);
  assert.deepEqual(nameTokens(''), []);
});

test('sizeWordOf reads the LAST size word, canonicalised', () => {
  assert.equal(sizeWordOf('Caesar Salad Large'), 'large');
  assert.equal(sizeWordOf('Caesar Salad LG'), 'large');
  assert.equal(sizeWordOf('Caesar Salad Half Pan'), 'half');
  assert.equal(sizeWordOf('Caesar Salad'), null);
  assert.equal(sizeWordOf('Small Plates Large Tray'), 'large');
});

// ────────────────────────────────────────────────────────────────────────────
// 2. scoreMatch
// ────────────────────────────────────────────────────────────────────────────

test('scoreMatch: an exact normalised name is 1', () => {
  const r = scoreMatch('Caesar Salad (Serves 10)', { id: 'm-caesar', name: 'Caesar Salad' });
  assert.equal(r.score, 1);
  assert.equal(r.why, 'same name');
});

test('scoreMatch: our name inside theirs scores high, and says which way round', () => {
  const r = scoreMatch('Caesar Salad Platter', { id: 'm-caesar', name: 'Caesar Salad' });
  assert.equal(r.score, 0.85);
  assert.equal(r.why, 'our name is in theirs');

  const back = scoreMatch('Caesar', { id: 'm-caesar', name: 'Caesar Salad' });
  assert.equal(back.why, 'their name is in ours');
  assert.ok(back.score > 0.7 && back.score < 0.85);
});

test('scoreMatch: containment is whole word, ham never matches hamburger', () => {
  const r = scoreMatch('Ham', { id: 'm-burger', name: 'Hamburger' });
  assert.equal(r.score, 0);
  assert.equal(r.why, 'no words match');
});

test('scoreMatch: partial word overlap falls back to a counted score', () => {
  const r = scoreMatch('Grilled Chicken Caesar', { id: 'm-caesar', name: 'Caesar Salad' });
  assert.equal(r.why, '1 of 3 words match');
  assert.equal(r.score, 0.28);
  // Deliberately below the bar: this is noise, not a suggestion.
  assert.ok(r.score < DEFAULT_MIN_SCORE);
});

test('scoreMatch: a matching size lifts, a clashing size drops', () => {
  const big = scoreMatch('Caesar Salad Large', { id: 'm-l', name: 'Caesar Salad Large' });
  assert.equal(big.score, 1);
  assert.equal(big.why, 'same name, same size');

  const small = scoreMatch('Caesar Salad Large', { id: 'm-s', name: 'Caesar Salad Small' });
  assert.equal(small.score, 0.9);
  assert.equal(small.why, 'same name, different size');
  assert.ok(big.score > small.score);
});

test('scoreMatch: price agreeing is a bonus, price disagreeing is NOT a penalty', () => {
  const agree = scoreMatch({ name: 'Cookie Box', price: 24 }, { id: 'x', name: 'Cookie Tray', price: 24 });
  const disagree = scoreMatch({ name: 'Cookie Box', price: 99 }, { id: 'x', name: 'Cookie Tray', price: 24 });
  const silent = scoreMatch({ name: 'Cookie Box' }, { id: 'x', name: 'Cookie Tray', price: 24 });
  assert.ok(agree.score > disagree.score);
  assert.equal(disagree.score, silent.score);
  assert.ok(agree.why.includes('same price'));
  assert.ok(!disagree.why.includes('price'));
});

test('scoreMatch: menuName is matched too, not just name', () => {
  const r = scoreMatch('Classic Sandwich Platter', OUR_ITEMS[2]);
  assert.equal(r.score, 1);
  assert.equal(r.why, 'same name');
  assert.equal(displayNameOf(OUR_ITEMS[2]), 'Sandwich Platter');
});

test('scoreMatch: nothing on either side is 0, never a throw', () => {
  assert.equal(scoreMatch('', { id: 'x', name: 'Caesar Salad' }).score, 0);
  assert.equal(scoreMatch('Caesar Salad', {}).score, 0);
  assert.equal(scoreMatch(null, null).score, 0);
});

test('scoreMatch never randomises', () => {
  const first = scoreMatch('Caesar Salad Platter', OUR_ITEMS[0]);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(scoreMatch('Caesar Salad Platter', OUR_ITEMS[0]), first);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. suggestMatches
// ────────────────────────────────────────────────────────────────────────────

test('suggestMatches: ranked best first and capped at the limit', () => {
  const out = suggestMatches({ name: 'Caesar Salad Tray' }, OUR_ITEMS, { limit: 2 });
  assert.equal(out.length <= 2, true);
  assert.equal(out[0].itemId, 'm-caesar');
  assert.equal(out[0].score, 1);
  assert.equal(out[0].name, 'Caesar Salad');
  assert.ok(out[0].why);
});

test('suggestMatches: the default limit is honoured', () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ id: 'i' + i, name: 'Caesar Salad ' + i });
  const out = suggestMatches('Caesar Salad', many);
  assert.equal(out.length, DEFAULT_LIMIT);
});

test('suggestMatches: nothing under minScore is offered', () => {
  const out = suggestMatches('Grilled Chicken Caesar', OUR_ITEMS);
  assert.deepEqual(out, []);
  const loose = suggestMatches('Grilled Chicken Caesar', OUR_ITEMS, { minScore: 0.1 });
  assert.equal(loose[0].itemId, 'm-caesar');
});

test('suggestMatches: a tie is broken by name so the list never shuffles', () => {
  const items = [
    { id: 'b', name: 'Caesar Salad' },
    { id: 'a', name: 'Caesar Salad' },
    { id: 'c', name: 'Caesar Salad' },
  ];
  const first = suggestMatches('Caesar Salad', items);
  assert.deepEqual(first.map((r) => r.itemId), ['a', 'b', 'c']);
  // Same list whatever order they arrive in.
  const shuffled = suggestMatches('Caesar Salad', [items[2], items[0], items[1]]);
  assert.deepEqual(shuffled, first);
});

test('suggestMatches: items with no id are skipped, not crashed on', () => {
  const out = suggestMatches('Caesar Salad', [{ name: 'Caesar Salad' }, null, OUR_ITEMS[0]]);
  assert.deepEqual(out.map((r) => r.itemId), ['m-caesar']);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. autoLinkDecision, the four rules in order
// ────────────────────────────────────────────────────────────────────────────

test('autoLink rule 1: an existing link beats everything, even an exact name', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-cookies', source: 'manual' }];
  const d = autoLinkDecision({ name: 'Caesar Salad' }, OUR_ITEMS, links);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-cookies');
  assert.equal(d.reason, 'already matched');
  assert.equal(d.source, 'manual');
});

test('autoLink rule 2: posItemId that names a real item of ours beats the name', () => {
  const d = autoLinkDecision({ name: 'Caesar Salad', itemId: 'm-cookies' }, OUR_ITEMS, []);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-cookies');
  assert.equal(d.reason, 'their menu has our id');
  assert.equal(d.source, 'posItemId');
});

test('autoLink rule 2: a posItemId naming nothing of ours is ignored, never trusted', () => {
  const d = autoLinkDecision({ name: 'Caesar Salad', itemId: 'ghost-id' }, OUR_ITEMS, []);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.reason, 'same name');
});

test('autoLink rule 3: one exact name and nothing else exact links itself', () => {
  const d = autoLinkDecision({ name: 'Caesar Salad (Serves 10)' }, OUR_ITEMS, []);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.reason, 'same name');
  assert.equal(d.source, 'auto');
});

test('autoLink NEVER links across a size clash: their Large is not our Small', () => {
  // The names normalise equal because the scorer drops the size on purpose, so
  // this was one exact name, nothing else exact, linked. Their Large tray of
  // salad would have routed as our Small and taken the wrong stock.
  const ours = [{ id: 'm-small', name: 'Caesar Salad Small', price: 22 }];
  const d = autoLinkDecision({ name: 'Caesar Salad Large' }, ours, []);
  assert.equal(d.action, 'suggest', 'the wrong size is the wrong food');
  assert.equal(d.reason, 'different size, check it');
  assert.equal(d.itemId, undefined);
  // The scorer already docks it, so it is still offered to a person.
  assert.ok(scoreMatch('Caesar Salad Large', ours[0]).why.includes('different size'));
  assert.equal(suggestMatches({ name: 'Caesar Salad Large' }, ours)[0].itemId, 'm-small');

  // Same size still links, and one side with no size at all is not a clash.
  assert.equal(autoLinkDecision({ name: 'Caesar Salad Small' }, ours, []).action, 'linked');
  assert.equal(autoLinkDecision({ name: 'Caesar Salad Large' }, OUR_ITEMS, []).itemId, 'm-caesar');

  // Half against Full is the catering version of the same clash.
  const trays = [{ id: 'm-half', name: 'Lasagne Half Tray' }];
  assert.equal(autoLinkDecision({ name: 'Lasagne Full Tray' }, trays, []).action, 'suggest');
});

test('autoLink options never link across a size clash either', () => {
  // Their "Fries Large" against our "Fries Small": the scorer drops the
  // trailing size, so both are "fries" and this used to link itself.
  const groups = [{ id: 'g-fries', name: 'Sides', options: [{ id: 'o-small', name: 'Fries Small' }] }];
  const d = autoLinkDecision({ label: 'Fries Large', groupLabel: 'Sides' }, groups, [], { kind: 'option' });
  assert.equal(d.action, 'suggest');
  assert.equal(d.reason, 'different size, check it');
  assert.equal(d.optionId, undefined);
  assert.equal(
    autoLinkDecision({ label: 'Fries Small', groupLabel: 'Sides' }, groups, [], { kind: 'option' }).optionId,
    'o-small',
  );
});

test('a saved link still wins over a size clash, because a person decided it', () => {
  const ours = [{ id: 'm-small', name: 'Caesar Salad Small' }];
  const links = [{ kind: 'item', ez_key: 'caesar salad large', ez_name: 'Caesar Salad Large', menu_item_id: 'm-small', source: 'manual' }];
  const d = autoLinkDecision({ name: 'Caesar Salad Large' }, ours, links);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-small');
  assert.equal(d.source, 'manual');
});

test('autoLink rule 4: it NEVER guesses between two items that match equally', () => {
  const items = [
    { id: 'm-small', name: 'Caesar Salad Small' },
    { id: 'm-large', name: 'Caesar Salad Large' },
  ];
  const d = autoLinkDecision({ name: 'Caesar Salad Large' }, items, []);
  assert.equal(d.action, 'suggest');
  assert.equal(d.reason, 'more than one item with that name');
  assert.equal(d.itemId, undefined);
  // The picker still puts the right one on top.
  const s = suggestMatches({ name: 'Caesar Salad Large' }, items);
  assert.equal(s[0].itemId, 'm-large');
});

test('autoLink: a near miss suggests, a miss returns none', () => {
  const near = autoLinkDecision({ name: 'Caesar Salad Platter Deluxe' }, OUR_ITEMS, []);
  assert.equal(near.action, 'suggest');
  assert.equal(near.reason, 'close names to check');

  const miss = autoLinkDecision({ name: 'Lobster Thermidor' }, OUR_ITEMS, []);
  assert.equal(miss.action, 'none');
  assert.equal(miss.reason, 'no match');
});

test('autoLink: a link pointing at a deleted item is not reused silently', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-deleted', source: 'manual' }];
  const d = autoLinkDecision({ name: 'Caesar Salad' }, OUR_ITEMS, links);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.stale, true);
});

test('autoLink: with no menu loaded an existing link is still honoured', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-deleted', source: 'manual' }];
  const d = autoLinkDecision({ name: 'Caesar Salad' }, [], links);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-deleted');
  assert.equal(d.stale, undefined);
});

test('autoLink: camelCase link rows and a keyed object both index', () => {
  const rows = [{ kind: 'item', ezKey: 'caesar salad', menuItemId: 'm-cookies', source: 'auto' }];
  assert.equal(autoLinkDecision({ name: 'Caesar Salad' }, OUR_ITEMS, rows).itemId, 'm-cookies');

  const map = { 'caesar salad': { kind: 'item', menu_item_id: 'm-cookies', source: 'auto' } };
  assert.equal(autoLinkDecision({ name: 'Caesar Salad' }, OUR_ITEMS, map).itemId, 'm-cookies');
});

// ────────────────────────────────────────────────────────────────────────────
// 5. matchOptions
// ────────────────────────────────────────────────────────────────────────────

test('matchOptions: same option name and same group is the top answer', () => {
  const out = matchOptions({ label: 'Cola', groupLabel: 'Drinks' }, OUR_GROUPS);
  assert.equal(out[0].optionId, 'o-cola');
  assert.equal(out[0].groupId, 'g-drinks');
  assert.equal(out[0].itemId, 'm-cola');
  assert.equal(out[0].score, 1);
  assert.equal(out[0].why, 'same name, same group');
});

test('matchOptions: a clearly different group knocks the score down but never hides it', () => {
  const out = matchOptions({ label: 'Cola', groupLabel: 'Bread Choice' }, OUR_GROUPS);
  assert.equal(out[0].optionId, 'o-cola');
  assert.equal(out[0].score, 0.8);
  assert.ok(out[0].why.includes('different group'));
});

test('matchOptions: ezCater customizationTypeName is read as the group', () => {
  const out = matchOptions({ name: 'Still Water', customizationTypeName: 'Drinks' }, OUR_GROUPS);
  assert.equal(out[0].optionId, 'o-water');
  assert.equal(out[0].groupLabel, 'Drinks');
});

test('matchOptions: no group named at all still matches on the option name', () => {
  const out = matchOptions({ label: 'Wholemeal' }, OUR_GROUPS);
  assert.equal(out[0].optionId, 'o-brown');
  assert.equal(out[0].why, 'same name');
});

test('autoLink kind option: one exact option name links it, with the menu item behind it', () => {
  const d = autoLinkDecision({ label: 'Cola', groupLabel: 'Drinks' }, OUR_GROUPS, [], { kind: 'option' });
  assert.equal(d.action, 'linked');
  assert.equal(d.optionId, 'o-cola');
  assert.equal(d.groupId, 'g-drinks');
  assert.equal(d.itemId, 'm-cola');
  assert.equal(d.reason, 'same name');
});

test('autoLink kind option: the same option name in two groups is never guessed', () => {
  const groups = [
    { id: 'g1', name: 'Size', options: [{ id: 'o1', name: 'Large' }] },
    { id: 'g2', name: 'Drink Size', options: [{ id: 'o2', name: 'Large' }] },
  ];
  const d = autoLinkDecision({ label: 'Large', groupLabel: 'Size' }, groups, [], { kind: 'option' });
  assert.equal(d.action, 'suggest');
  assert.equal(d.reason, 'more than one option with that name');
});

test('autoLink kind option: an existing option link wins', () => {
  const links = [{ kind: 'option', ez_key: 'drinks|cola', option_id: 'o-water', menu_item_id: 'm-water', source: 'manual' }];
  const d = autoLinkDecision({ label: 'Cola', groupLabel: 'Drinks' }, OUR_GROUPS, links, { kind: 'option' });
  assert.equal(d.action, 'linked');
  assert.equal(d.optionId, 'o-water');
  assert.equal(d.itemId, 'm-water');
  assert.equal(d.reason, 'already matched');
});

// ────────────────────────────────────────────────────────────────────────────
// 6. buildLinkKey, indexLinks, applyLinks
// ────────────────────────────────────────────────────────────────────────────

test('buildLinkKey: an item keys on the name with the container word dropped', () => {
  assert.equal(buildLinkKey({ name: 'Caesar Salad (Serves 10)' }), 'caesar salad');
  assert.equal(buildLinkKey({ name: 'CAESAR SALAD, tray' }), 'caesar salad');
  // Which is the point: two spellings of one product are ONE link.
  assert.equal(
    buildLinkKey({ name: 'Caesar Salad (Serves 10)' }),
    buildLinkKey({ name: 'CAESAR SALAD, tray' }),
  );
});

test('THE SIZE STAYS IN THE KEY: Half Tray and Full Tray are two rows', () => {
  // A venue sells both. They are two products to a kitchen: different stock,
  // different money. One key for both means one manual match routes both, and
  // the screen cannot even show them apart.
  const half = buildLinkKey({ name: 'Caesar Salad Half Tray' });
  const full = buildLinkKey({ name: 'Caesar Salad Full Tray' });
  assert.equal(half, 'caesar salad half');
  assert.equal(full, 'caesar salad full');
  assert.notEqual(half, full);

  // The container word is still noise, so their own two spellings of the SAME
  // half tray are still one row.
  assert.equal(buildLinkKey({ name: 'Caesar Salad, half pan' }), half);

  // And the SCORER still ignores the size, so both still find our one salad.
  assert.equal(normaliseItemName('Caesar Salad Half Tray'), 'caesar salad');
  assert.equal(normaliseItemName('Caesar Salad Full Tray'), 'caesar salad');
  assert.equal(scoreMatch('Caesar Salad Half Tray', { id: 'm-caesar', name: 'Caesar Salad' }).score, 1);
});

test('normaliseKeyName keeps a size and drops a container, and never empties a name', () => {
  assert.equal(normaliseKeyName('Caesar Salad Large'), 'caesar salad large');
  assert.equal(normaliseKeyName('Caesar Salad Large Tray'), 'caesar salad large');
  assert.equal(normaliseKeyName('Large'), 'large');
  assert.equal(normaliseKeyName('Tray'), 'tray');
  assert.equal(normaliseKeyName('!!!'), '');
});

test('a key saved under the OLD rule still resolves, so saved work keeps routing', () => {
  // Rows written before the size stayed in the key are under the short key.
  // Nothing new is ever written there, but every lookup falls back to it.
  const line = { name: 'Caesar Salad Half Tray' };
  assert.equal(legacyLinkKey(line), 'caesar salad');
  assert.deepEqual(linkKeyCandidates(line), ['caesar salad half', 'caesar salad']);

  const oldRows = [{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad Half Tray', menu_item_id: 'm-cookies', source: 'manual' }];
  const hit = findLink(indexLinks(oldRows), line, 'item');
  assert.equal(hit.key, 'caesar salad', 'bumped under the key it is really stored with');
  assert.equal(hit.link.menuItemId, 'm-cookies');

  // Both the reader and the decision use the fallback.
  assert.equal(applyLinks([line], oldRows)[0].itemId, 'm-cookies');
  assert.equal(autoLinkDecision(line, OUR_ITEMS, oldRows).itemId, 'm-cookies');

  // Today's key wins when both exist.
  const both = oldRows.concat([{ kind: 'item', ez_key: 'caesar salad half', ez_name: 'Caesar Salad Half Tray', menu_item_id: 'm-mac', source: 'manual' }]);
  assert.equal(findLink(indexLinks(both), line, 'item').key, 'caesar salad half');
  assert.equal(applyLinks([line], both)[0].itemId, 'm-mac');
});

test('an option key keeps the size too, and still falls back to the old one', () => {
  const small = buildLinkKey({ label: 'Small Fries', groupLabel: 'Sides' }, 'option');
  const large = buildLinkKey({ label: 'Large Fries', groupLabel: 'Sides' }, 'option');
  assert.equal(small, 'sides|small fries');
  assert.notEqual(small, large);
  assert.deepEqual(
    linkKeyCandidates({ label: 'Fries Large', groupLabel: 'Sides' }, 'option'),
    ['sides|fries large', 'sides|fries'],
  );
});

test('buildLinkKey: an option carries its group, so Large under two groups differs', () => {
  const a = buildLinkKey({ label: 'Large', groupLabel: 'Cheese Choice' }, 'option');
  const b = buildLinkKey({ label: 'Large', groupLabel: 'Drink Choice' }, 'option');
  assert.equal(a, 'cheese choice|large');
  assert.notEqual(a, b);
  assert.equal(buildLinkKey({ label: 'Large' }, 'option'), '|large');
});

test('buildLinkKey: no usable name gives an empty key, which must never be written', () => {
  assert.equal(buildLinkKey({ name: '' }), '');
  assert.equal(buildLinkKey({ name: '!!!' }), '');
  assert.equal(buildLinkKey({ label: '', groupLabel: 'Drinks' }, 'option'), '');
});

test('indexLinks keeps kind separate, so an item and an option can share a key', () => {
  const idx = indexLinks([
    { kind: 'item', ez_key: 'cola', menu_item_id: 'm-cola' },
    { kind: 'option', ez_key: 'cola', option_id: 'o-cola' },
  ]);
  assert.equal(idx.size, 2);
  assert.equal(idx.get('item:cola').menuItemId, 'm-cola');
  assert.equal(idx.get('option:cola').optionId, 'o-cola');
});

test('applyLinks FIXES the null itemId the mapper leaves on a Partner Portal order', () => {
  // This is the old behaviour, straight out of the live mapper: ezCater sends
  // no posItemId, so the ticket has no product on it at all.
  const lines = orderItemsToLines([{
    uuid: 'line-1',
    name: 'Caesar Salad (Serves 10)',
    quantity: 2,
    posItemId: null,
    totalInSubunits: { subunits: 7600, subunitsV2: '7600', currency: 'USD' },
    customizations: [{ name: 'Cola', customizationTypeName: 'Drinks', quantity: 1 }],
  }]);
  assert.equal(lines[0].itemId, null);

  const linked = applyLinks(lines, [
    { kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-caesar', source: 'manual' },
    { kind: 'option', ez_key: 'drinks|cola', option_id: 'o-cola', menu_item_id: 'm-cola', source: 'auto' },
  ]);

  assert.equal(linked[0].itemId, 'm-caesar');
  assert.deepEqual(linked[0].match, { matched: true, source: 'manual' });
  assert.equal(linked[0].mods[0].itemId, 'm-cola');
  assert.equal(linked[0].mods[0].optionId, 'o-cola');
  assert.deepEqual(linked[0].mods[0].match, { matched: true, source: 'auto' });
  // Everything else on the line is untouched.
  assert.equal(linked[0].name, 'Caesar Salad (Serves 10)');
  assert.equal(linked[0].qty, 2);
  assert.equal(linked[0].lineTotal, 76);
});

test('applyLinks: no link leaves itemId null and says so', () => {
  const out = applyLinks([{ name: 'Lobster Thermidor', qty: 1, mods: [] }], []);
  assert.equal(out[0].itemId, null);
  assert.deepEqual(out[0].match, { matched: false, source: null });
});

test('applyLinks: a posItemId already on the line counts as matched', () => {
  const out = applyLinks([{ name: 'Caesar Salad', itemId: 'm-caesar', mods: [] }], []);
  assert.equal(out[0].itemId, 'm-caesar');
  assert.deepEqual(out[0].match, { matched: true, source: 'posItemId' });
});

test('applyLinks: a saved link BEATS posItemId, because a person corrected it', () => {
  const out = applyLinks(
    [{ name: 'Caesar Salad', itemId: 'm-wrong', mods: [] }],
    [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-caesar', source: 'manual' }],
  );
  assert.equal(out[0].itemId, 'm-caesar');
  assert.equal(out[0].match.source, 'manual');
});

// ── item codes (v5.8.100) ──────────────────────────────────────────────────

const CODED_ITEMS = OUR_ITEMS.map((i) => (
  i.id === 'm-caesar' ? { ...i, itemCode: 'CAESARSAL' } : i
)).concat([{ id: 'm-cola', name: 'Cola', price: 2, item_code: 'COLA1' }]);

test('itemCodeKey forgives case and stray spaces, and NOTHING else', () => {
  assert.equal(itemCodeKey(' flatwhite '), 'FLATWHITE');
  assert.equal(itemCodeKey('FlatWhite'), 'FLATWHITE');
  // Punctuation is kept, so their "M-123" can never become our "M123".
  assert.equal(itemCodeKey('M-123'), 'M-123');
  for (const junk of [null, undefined, '']) assert.equal(itemCodeKey(junk), '');
});

test('indexItemCodes reads either spelling and drops a code that names two items', () => {
  const idx = indexItemCodes(CODED_ITEMS);
  assert.deepEqual(idx.get('CAESARSAL'), { itemId: 'm-caesar', code: 'CAESARSAL' });
  assert.deepEqual(idx.get('COLA1'), { itemId: 'm-cola', code: 'COLA1' });
  assert.equal(idx.size, 2, 'items with no code are not in the index at all');

  // The database's unique index makes this impossible. If it happens anyway,
  // the code is exactly what it is not: certain.
  const dupes = indexItemCodes([
    { id: 'a', name: 'A', itemCode: 'DUPE' },
    { id: 'b', name: 'B', itemCode: 'dupe' },
  ]);
  assert.equal(dupes.get('DUPE'), undefined);
});

test('findItemCodeMatch: an unknown or empty code is null, never a guess', () => {
  const idx = indexItemCodes(CODED_ITEMS);
  assert.deepEqual(findItemCodeMatch(idx, 'caesarsal'), { itemId: 'm-caesar', code: 'CAESARSAL' });
  assert.equal(findItemCodeMatch(idx, 'NEVERSEEN'), null);
  assert.equal(findItemCodeMatch(idx, ''), null);
  assert.equal(findItemCodeMatch(idx, null), null);
  assert.equal(findItemCodeMatch(null, 'CAESARSAL'), null, 'no index at all is simply no match');
});

test('autoLinkDecision: an item code is CERTAIN and outranks a saved link', () => {
  const links = [{ kind: 'item', ez_key: 'their own words', menu_item_id: 'm-cookies', source: 'manual' }];
  const d = autoLinkDecision({ name: 'Their Own Words', itemId: 'CAESARSAL' }, CODED_ITEMS, links);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.source, 'itemCode');
});

test('autoLinkDecision: an UNKNOWN code changes nothing, the name rules still run', () => {
  const d = autoLinkDecision({ name: 'Caesar Salad', itemId: 'NOSUCHCODE' }, CODED_ITEMS, []);
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.source, 'auto', 'matched by name, exactly as if no code had been sent');

  const none = autoLinkDecision({ name: 'Lobster Thermidor', itemId: 'NOSUCHCODE' }, CODED_ITEMS, []);
  assert.equal(none.action, 'none', 'and an unknown code never invents a match either');
});

test('autoLinkDecision: our raw menu item id on their line still works', () => {
  const d = autoLinkDecision({ name: 'Mystery', itemId: 'm-cookies' }, CODED_ITEMS, []);
  assert.equal(d.itemId, 'm-cookies');
  assert.equal(d.source, 'posItemId', 'the id path is untouched by the code path');
});

test('autoLink kind option: a code names our product, and our option that points at it', () => {
  const d = autoLinkDecision(
    { label: 'Their Word', groupLabel: 'Drinks', itemId: ' cola1 ' },
    OUR_GROUPS, [], { kind: 'option', itemCodes: CODED_ITEMS },
  );
  assert.equal(d.action, 'linked');
  assert.equal(d.itemId, 'm-cola');
  assert.equal(d.optionId, 'o-cola');
  assert.equal(d.source, 'itemCode');
});

test('autoLink kind option: a code with no option of ours behind it still names the product', () => {
  const d = autoLinkDecision(
    { label: 'Their Word', itemId: 'CAESARSAL' },
    OUR_GROUPS, [], { kind: 'option', itemCodes: CODED_ITEMS },
  );
  assert.equal(d.itemId, 'm-caesar');
  assert.equal(d.optionId, null, 'no option of ours points at it, so there is no option to claim');
});

test('applyLinks: an item code beats a saved link AND a posItemId', () => {
  const out = applyLinks(
    [{ name: 'Their Own Words', itemId: 'caesarsal', mods: [] }],
    [{ kind: 'item', ez_key: 'their own words', menu_item_id: 'm-cookies', source: 'manual' }],
    CODED_ITEMS,
  );
  assert.equal(out[0].itemId, 'm-caesar');
  assert.equal(out[0].match.source, 'itemCode');
});

test('applyLinks: with no codes passed it behaves exactly as it always did', () => {
  const lines = [{ name: 'Caesar Salad', itemId: 'm-wrong', mods: [] }];
  const links = [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-caesar', source: 'manual' }];
  assert.deepEqual(applyLinks(lines, links), applyLinks(lines, links, []));
  assert.deepEqual(applyLinks(lines, links), applyLinks(lines, links, null));
});

test('applyLinks: an unknown code on a line leaves the line exactly as it was', () => {
  const lines = [{ name: 'Caesar Salad', itemId: 'GHOSTCODE', mods: [] }];
  const plain = applyLinks(lines, []);
  const coded = applyLinks(lines, [], CODED_ITEMS);
  assert.deepEqual(coded, plain);
  assert.equal(coded[0].itemId, 'GHOSTCODE', 'kept, the same as any other id we cannot check here');
});

test('applyLinks does not mutate what it is given', () => {
  const lines = [{ name: 'Caesar Salad', itemId: null, mods: [{ label: 'Cola', groupLabel: 'Drinks' }] }];
  const before = JSON.stringify(lines);
  applyLinks(lines, [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-caesar', source: 'auto' }]);
  assert.equal(JSON.stringify(lines), before);
});

test('countMatches counts lines and mods separately', () => {
  const lines = applyLinks(
    [
      { name: 'Caesar Salad', mods: [{ label: 'Cola', groupLabel: 'Drinks' }] },
      { name: 'Lobster Thermidor', mods: [] },
    ],
    [{ kind: 'item', ez_key: 'caesar salad', menu_item_id: 'm-caesar', source: 'auto' }],
  );
  const c = countMatches(lines);
  assert.equal(c.total, 2);
  assert.equal(c.matched, 1);
  assert.equal(c.unmatched, 1);
  assert.deepEqual(c.mods, { total: 1, matched: 0, unmatched: 1 });
  assert.equal(c.allMatched, false);
});

test('countMatches on an empty order is not "all matched"', () => {
  assert.equal(countMatches([]).allMatched, false);
  assert.equal(countMatches(null).total, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// The rule tables are frozen, so nothing can quietly change the rules at runtime
// ────────────────────────────────────────────────────────────────────────────

test('the rule tables are frozen', () => {
  assert.ok(Object.isFrozen(SIZE_WORDS));
  assert.ok(Object.isFrozen(CONTAINER_WORDS));
  assert.ok(Object.isFrozen(TRAILING_DROP));
  assert.ok(Object.isFrozen(WEIGHTS));
  assert.ok(TRAILING_DROP.includes('tray') && TRAILING_DROP.includes('pan'));
  assert.ok(TRAILING_DROP.includes('large') && TRAILING_DROP.includes('half'));
});
