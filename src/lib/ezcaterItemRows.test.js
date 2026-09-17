/**
 * ezcaterItemRows.test.js - the view model behind the Back Office ezCater
 * "Item matching" screen. Run: `npm test`, or
 * `node --test src/lib/ezcaterItemRows.test.js`.
 *
 * The screen itself is a shell. Everything that can be wrong lives here:
 *
 *   1. "not switched on yet" vs a real error, which must never be confused
 *   2. the three row states, DERIVED from the columns, not stored
 *   3. the order of the list: unmatched first, newest first, and stable
 *   4. the counts and the exact words above them
 *   5. the picker: suggestions from the matcher, then plain substring search
 *   6. saveBody, which builds the key the row will be looked up by
 *   7. applySaved, the optimistic update
 *   8. the whole point: a Partner Portal order line with posItemId = null goes
 *      from unmatched, through this screen, to a line the POS can route
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ABSENT_CODES, isMatchingOff,
  toRow, rowsFrom, sortRows, ofKind, countRows,
  outstandingLine, seenLine,
  ourItemsFrom, ourGroupsFrom, suggestionsFor, searchOurItems, matchedLabel,
  saveBody, applySaved,
} from './ezcaterItemRows.js';

import { applyLinks, buildLinkKey } from './ezcaterMatch.js';
import { orderItemsToLines } from '../../supabase/functions/_shared/ezcater-map.ts';

// ── our menu, the way Back Office reads it off the tables ───────────────────

const RAW_ITEMS = [
  { id: 'm-caesar', name: 'Caesar Salad', menu_name: null, price: 38, archived: false },
  { id: 'm-cookies', name: 'Chocolate Chip Cookies', menu_name: null, price: 24, archived: false },
  { id: 'm-mac', name: 'Mac & Cheese', menu_name: null, price: 42, archived: false },
  { id: 'm-old', name: 'Retired Wrap', menu_name: null, price: 10, archived: true },
  { id: 'm-cola', name: 'Cola', menu_name: null, price: 2, archived: false },
];

const RAW_GROUPS = [
  { id: 'g-bread', name: 'Bread Choice', options: [{ id: 'o-white', name: 'White' }, { id: 'o-brown', name: 'Wholemeal' }] },
  { id: 'g-drinks', name: 'Drinks', options: [{ id: 'o-cola', name: 'Cola', itemId: 'm-cola' }] },
  { id: 'g-empty', name: 'Nothing', options: [] },
];

const OUR_ITEMS = ourItemsFrom(RAW_ITEMS);
const OUR_GROUPS = ourGroupsFrom(RAW_GROUPS);

const row = (over) => toRow({
  kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad (Serves 10)',
  ez_group: null, menu_item_id: null, option_id: null,
  source: 'auto', matched_by: null, seen_count: 3, last_seen_at: '2026-09-16T10:00:00Z',
  ...over,
});

// ────────────────────────────────────────────────────────────────────────────
// 1. "not switched on yet" vs a real error
// ────────────────────────────────────────────────────────────────────────────

test('isMatchingOff catches every way the table or the function can be absent', () => {
  for (const code of ABSENT_CODES) assert.equal(isMatchingOff({ code }), true, code);
  assert.equal(isMatchingOff({ message: 'relation "public.ezcater_item_links" does not exist' }), true);
  assert.equal(isMatchingOff({ message: 'Could not find the table in the schema cache' }), true);
  // The edge function not being deployed. Edge functions do NOT deploy with the
  // web app, so this is the state the screen will really be in on day one.
  assert.equal(isMatchingOff({ message: 'Failed to send a request to the Edge Function' }), true);
  assert.equal(isMatchingOff({ message: 'Function not found (404)' }), true);
});

test('isMatchingOff does NOT swallow a real error', () => {
  // This is the dangerous direction. A venue told "not switched on yet" while
  // saves were really failing would leave every order routing nowhere.
  assert.equal(isMatchingOff(null), false);
  assert.equal(isMatchingOff({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);
  assert.equal(isMatchingOff({ message: 'No access to this location' }), false);
  assert.equal(isMatchingOff({ code: '500', message: 'that item is not on this menu' }), false);
  assert.equal(isMatchingOff({ message: 'network timeout' }), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. the three states, derived
// ────────────────────────────────────────────────────────────────────────────

test('a row with no target and nobody deciding is unmatched', () => {
  assert.equal(row().state, 'unmatched');
});

test('a row pointing at one of our items is matched', () => {
  assert.equal(row({ menu_item_id: 'm-caesar', source: 'manual' }).state, 'matched');
});

test('an option row pointing at one of our options is matched', () => {
  const r = row({ kind: 'option', ez_key: 'drinks|cola', ez_name: 'Cola', ez_group: 'Drinks', option_id: 'o-cola' });
  assert.equal(r.state, 'matched');
  assert.equal(r.kind, 'option');
});

test('"Not on our menu" is a row with no target and matched_by ignored', () => {
  assert.equal(row({ matched_by: 'ignored' }).state, 'ignored');
  // And a target always wins over the marker, so a row can never be both.
  assert.equal(row({ matched_by: 'ignored', menu_item_id: 'm-caesar' }).state, 'matched');
});

test('toRow takes the row in snake_case or camelCase, the same as indexLinks', () => {
  const camel = toRow({ kind: 'item', ezKey: 'k', ezName: 'N', menuItemId: 'm-caesar', seenCount: 2, lastSeenAt: '2026-09-16T10:00:00Z' });
  assert.equal(camel.state, 'matched');
  assert.equal(camel.menuItemId, 'm-caesar');
  assert.equal(camel.seenCount, 2);
});

test('toRow drops a row that cannot be shown or saved', () => {
  assert.equal(toRow(null), null);
  assert.equal(toRow({ kind: 'item', ez_key: '', ez_name: 'X' }), null);   // no key
  assert.equal(toRow({ kind: 'item', ez_key: 'k', ez_name: '' }), null);   // nothing to label it
  // rowsFrom drops them quietly rather than rendering a blank clickable line.
  assert.equal(rowsFrom([{ ez_key: '', ez_name: '' }, { kind: 'item', ez_key: 'k', ez_name: 'N' }]).length, 1);
});

test('seen_count is never negative and never NaN, whatever the column holds', () => {
  assert.equal(row({ seen_count: null }).seenCount, 0);
  assert.equal(row({ seen_count: -4 }).seenCount, 0);
  assert.equal(row({ seen_count: 'x' }).seenCount, 0);
  assert.equal(row({ seen_count: 7.9 }).seenCount, 7);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. ordering
// ────────────────────────────────────────────────────────────────────────────

test('unmatched first, then matched, then silenced', () => {
  const rows = sortRows([
    row({ ez_key: 'b', ez_name: 'B', matched_by: 'ignored' }),
    row({ ez_key: 'c', ez_name: 'C', menu_item_id: 'm-caesar' }),
    row({ ez_key: 'a', ez_name: 'A' }),
  ]);
  assert.deepEqual(rows.map((r) => r.ezName), ['A', 'C', 'B']);
});

test('newest seen first, because that is the order sitting on the pass right now', () => {
  const rows = sortRows([
    row({ ez_key: 'old', ez_name: 'Old', last_seen_at: '2026-09-01T10:00:00Z' }),
    row({ ez_key: 'new', ez_name: 'New', last_seen_at: '2026-09-17T10:00:00Z' }),
    row({ ez_key: 'mid', ez_name: 'Mid', last_seen_at: '2026-09-10T10:00:00Z' }),
  ]);
  assert.deepEqual(rows.map((r) => r.ezName), ['New', 'Mid', 'Old']);
});

test('a row never seen on an order sorts last, not first', () => {
  const rows = sortRows([
    row({ ez_key: 'never', ez_name: 'Never', last_seen_at: null }),
    row({ ez_key: 'seen', ez_name: 'Seen', last_seen_at: '2026-09-01T10:00:00Z' }),
  ]);
  assert.deepEqual(rows.map((r) => r.ezName), ['Seen', 'Never']);
});

test('the list is the same list every time, so it does not shuffle under the cursor', () => {
  const same = { last_seen_at: '2026-09-16T10:00:00Z', seen_count: 1 };
  const a = [row({ ...same, ez_key: 'x', ez_name: 'Zebra' }), row({ ...same, ez_key: 'y', ez_name: 'Apple' })];
  const b = [a[1], a[0]];
  assert.deepEqual(sortRows(a).map((r) => r.ezName), sortRows(b).map((r) => r.ezName));
  assert.deepEqual(sortRows(a).map((r) => r.ezName), ['Apple', 'Zebra']);
});

test('ofKind splits the Items tab from the Options tab', () => {
  const rows = rowsFrom([
    { kind: 'item', ez_key: 'a', ez_name: 'A' },
    { kind: 'option', ez_key: 'g|b', ez_name: 'B', ez_group: 'G' },
  ]);
  assert.equal(ofKind(rows, 'item').length, 1);
  assert.equal(ofKind(rows, 'option').length, 1);
  assert.equal(ofKind(rows, 'option')[0].ezGroup, 'G');
});

// ────────────────────────────────────────────────────────────────────────────
// 4. counts and copy
// ────────────────────────────────────────────────────────────────────────────

test('countRows counts the three states and reports the outstanding one', () => {
  const rows = [row({ ez_key: 'a' }), row({ ez_key: 'b' }), row({ ez_key: 'c', menu_item_id: 'm-caesar' }), row({ ez_key: 'd', matched_by: 'ignored' })];
  assert.deepEqual(countRows(rows), { total: 4, matched: 1, ignored: 1, unmatched: 2, outstanding: 2 });
});

test('the line at the top says the number, in plain words, with the right singular', () => {
  assert.equal(outstandingLine({ total: 5, outstanding: 4 }, 'item'), '4 of their items are not matched yet.');
  assert.equal(outstandingLine({ total: 5, outstanding: 1 }, 'item'), '1 of their items is not matched yet.');
  assert.equal(outstandingLine({ total: 5, outstanding: 0 }, 'item'), 'All their items are matched.');
  assert.equal(outstandingLine({ total: 3, outstanding: 2 }, 'option'), '2 of their options are not matched yet.');
  // Nothing at all is a different sentence from nothing outstanding: one says
  // the work is done, the other says the work has not arrived.
  assert.match(outstandingLine({ total: 0, outstanding: 0 }, 'item'), /^Nothing from ezCater yet/);
});

test('the grey line under a row says how many orders it has been on', () => {
  assert.equal(seenLine({ seenCount: 0 }), 'Not on an order yet');
  assert.equal(seenLine({ seenCount: 1 }), 'On 1 order');
  assert.equal(seenLine({ seenCount: 12 }), 'On 12 orders');
});

// ────────────────────────────────────────────────────────────────────────────
// 5. the picker
// ────────────────────────────────────────────────────────────────────────────

test('archived items are never offered as a match', () => {
  assert.ok(!OUR_ITEMS.some((i) => i.id === 'm-old'));
  assert.ok(OUR_ITEMS.some((i) => i.id === 'm-caesar'));
});

test('a modifier group with no options is not offered', () => {
  assert.ok(!OUR_GROUPS.some((g) => g.id === 'g-empty'));
});

test('the top suggestion for their spelling is our product', () => {
  const s = suggestionsFor(row(), OUR_ITEMS, OUR_GROUPS, { limit: 4 });
  assert.equal(s[0].id, 'm-caesar');
  assert.equal(s[0].menuItemId, 'm-caesar');
  assert.equal(s[0].optionId, null);
  assert.equal(s[0].why, 'same name');   // "(Serves 10)" is catering noise, stripped
});

test('an option suggestion carries the group it came from, so two "Large" are told apart', () => {
  const r = row({ kind: 'option', ez_key: 'drinks|cola', ez_name: 'COLA', ez_group: 'Drinks', seen_count: 1 });
  const s = suggestionsFor(r, OUR_ITEMS, OUR_GROUPS, { limit: 4 });
  const cola = s.find((x) => x.optionId === 'o-cola');
  assert.ok(cola, 'our Cola option should be offered for their "COLA"');
  assert.equal(cola.note, 'Drinks');
  // The option also carries the menu item behind it, which is what 86 and stock
  // key on when a paid modifier is really a product of ours.
  assert.equal(cola.menuItemId, 'm-cola');
});

test('the matcher is not offered a guess when their word is simply a different word', () => {
  // "Coke" and "Cola" share no token and neither contains the other, so there
  // is nothing to suggest. The venue types it into the search box instead. This
  // is the right answer: guessing here would pour the wrong drink.
  const r = row({ kind: 'option', ez_key: 'drinks|coke', ez_name: 'Coke', ez_group: 'Drinks' });
  assert.equal(suggestionsFor(r, OUR_ITEMS, OUR_GROUPS).length, 0);
  assert.deepEqual(searchOurItems('cola', OUR_ITEMS, OUR_GROUPS, 'option').map((h) => h.id), ['o-cola']);
});

test('suggestionsFor is empty when there is no name to work from', () => {
  assert.deepEqual(suggestionsFor({ kind: 'item', ezName: '' }, OUR_ITEMS, OUR_GROUPS), []);
  assert.deepEqual(suggestionsFor(null, OUR_ITEMS, OUR_GROUPS), []);
});

test('search is plain substring, because a three letter fragment scores zero on the matcher', () => {
  const hits = searchOurItems('cae', OUR_ITEMS, OUR_GROUPS, 'item');
  assert.deepEqual(hits.map((h) => h.id), ['m-caesar']);
  // The matcher would find nothing for "cae": it is not a whole token.
  assert.equal(suggestionsFor({ kind: 'item', ezName: 'cae' }, OUR_ITEMS, OUR_GROUPS).length, 0);
});

test('search matches the normalised name too, so "mac and cheese" finds "Mac & Cheese"', () => {
  assert.deepEqual(searchOurItems('mac and cheese', OUR_ITEMS, OUR_GROUPS, 'item').map((h) => h.id), ['m-mac']);
});

test('a name that STARTS with what was typed comes first', () => {
  const items = ourItemsFrom([
    { id: 'a', name: 'Diet Cola Float' },
    { id: 'b', name: 'Cola' },
  ]);
  assert.deepEqual(searchOurItems('cola', items, [], 'item').map((h) => h.id), ['b', 'a']);
});

test('an empty search box returns nothing, so the suggestions stay on screen', () => {
  assert.deepEqual(searchOurItems('', OUR_ITEMS, OUR_GROUPS, 'item'), []);
  assert.deepEqual(searchOurItems('   ', OUR_ITEMS, OUR_GROUPS, 'item'), []);
});

test('option search looks in our option names and our group names', () => {
  assert.deepEqual(searchOurItems('whole', OUR_ITEMS, OUR_GROUPS, 'option').map((h) => h.id), ['o-brown']);
  const byGroup = searchOurItems('bread', OUR_ITEMS, OUR_GROUPS, 'option').map((h) => h.id);
  assert.deepEqual(byGroup.sort(), ['o-brown', 'o-white']);
});

test('search is capped and never repeats an id', () => {
  const many = ourItemsFrom(Array.from({ length: 60 }, (_, i) => ({ id: 'i' + i, name: 'Thing ' + i })));
  const hits = searchOurItems('thing', many, [], 'item', { limit: 25 });
  assert.equal(hits.length, 25);
  assert.equal(new Set(hits.map((h) => h.id)).size, 25);
});

test('matchedLabel names what a matched row points at', () => {
  assert.equal(matchedLabel(row({ menu_item_id: 'm-caesar' }), OUR_ITEMS, OUR_GROUPS), 'Caesar Salad');
  const opt = row({ kind: 'option', ez_key: 'drinks|cola', ez_name: 'Coke', option_id: 'o-cola' });
  assert.equal(matchedLabel(opt, OUR_ITEMS, OUR_GROUPS), 'Cola (Drinks)');
  assert.equal(matchedLabel(row(), OUR_ITEMS, OUR_GROUPS), '');   // unmatched has no label
});

test('a match pointing at a deleted product says so, instead of showing a blank', () => {
  // This is the one case a venue has to act on: the routing behind it is dead.
  assert.equal(matchedLabel(row({ menu_item_id: 'm-gone' }), OUR_ITEMS, OUR_GROUPS), 'Deleted from our menu');
});

// ────────────────────────────────────────────────────────────────────────────
// 6. saving
// ────────────────────────────────────────────────────────────────────────────

test('saveBody builds the key from the NAME, with the matcher rules', () => {
  const { body } = saveBody(row(), { menuItemId: 'm-caesar' });
  assert.equal(body.ez_key, buildLinkKey({ name: 'Caesar Salad (Serves 10)' }, 'item'));
  assert.equal(body.ez_key, 'caesar salad');
  assert.equal(body.ez_name, 'Caesar Salad (Serves 10)');   // their spelling, verbatim
  assert.equal(body.menu_item_id, 'm-caesar');
  assert.equal(body.ignored, false);
});

test('an option key carries its group, so "Large" under two groups is two rows', () => {
  const a = saveBody(row({ kind: 'option', ez_name: 'Large', ez_group: 'Size' }), { optionId: 'o-white' }).body;
  const b = saveBody(row({ kind: 'option', ez_name: 'Large', ez_group: 'Drink Size' }), { optionId: 'o-brown' }).body;
  assert.notEqual(a.ez_key, b.ez_key);
  assert.equal(a.ez_group, 'Size');
});

test('"Not on our menu" saves no target at all', () => {
  const { body } = saveBody(row(), { ignored: true });
  assert.equal(body.ignored, true);
  assert.equal(body.menu_item_id, null);
  assert.equal(body.option_id, null);
});

test('"Not on our menu" wins over a stray id, so a silenced row can never route food', () => {
  const { body } = saveBody(row(), { ignored: true, menuItemId: 'm-caesar', optionId: 'o-cola' });
  assert.equal(body.menu_item_id, null);
  assert.equal(body.option_id, null);
});

test('Change and Undo both clear the row back to unmatched', () => {
  const { body } = saveBody(row({ menu_item_id: 'm-caesar' }), {});
  assert.equal(body.menu_item_id, null);
  assert.equal(body.option_id, null);
  assert.equal(body.ignored, false);
});

test('saveBody refuses what the table would refuse', () => {
  // The key check on the table rejects an empty key; this refuses it earlier,
  // with words instead of a constraint violation.
  assert.ok(saveBody(row({ ez_name: '!!!' }), { menuItemId: 'm-caesar' }).error);
  assert.ok(saveBody(null, {}).error);
  // And the target check: an item row can never hold an option id.
  assert.ok(saveBody(row(), { optionId: 'o-cola' }).error);
  assert.ok(saveBody(row({ kind: 'option', ez_name: 'Cola', ez_group: 'Drinks' }), { menuItemId: 'm-cola' }).error);
});

test('an item row never writes ez_group, an option row does', () => {
  assert.equal(saveBody(row(), { menuItemId: 'm-caesar' }).body.ez_group, null);
  assert.equal(saveBody(row({ kind: 'option', ez_name: 'Cola', ez_group: 'Drinks' }), { optionId: 'o-cola' }).body.ez_group, 'Drinks');
});

// ────────────────────────────────────────────────────────────────────────────
// 7. the optimistic update
// ────────────────────────────────────────────────────────────────────────────

test('applySaved moves the row to its new state and re-sorts', () => {
  const rows = rowsFrom([
    { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', seen_count: 2, last_seen_at: '2026-09-17T10:00:00Z' },
    { kind: 'item', ez_key: 'cookies', ez_name: 'Cookies', seen_count: 1, last_seen_at: '2026-09-16T10:00:00Z' },
  ]);
  assert.deepEqual(rows.map((r) => r.ezName), ['Caesar Salad', 'Cookies']);

  const { body } = saveBody(rows[0], { menuItemId: 'm-caesar' });
  const after = applySaved(rows, body);
  // Matched, marked as a person's decision, and it drops below the one still
  // outstanding so the operator's next job is at the top.
  assert.deepEqual(after.map((r) => r.ezName), ['Cookies', 'Caesar Salad']);
  const moved = after.find((r) => r.ezKey === 'caesar salad');
  assert.equal(moved.state, 'matched');
  assert.equal(moved.menuItemId, 'm-caesar');
  assert.equal(moved.source, 'manual');
});

test('applySaved keeps the counts a person has earned', () => {
  const rows = rowsFrom([{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', seen_count: 9, last_seen_at: '2026-09-17T10:00:00Z' }]);
  const after = applySaved(rows, saveBody(rows[0], { menuItemId: 'm-caesar' }).body);
  assert.equal(after[0].seenCount, 9);
  assert.equal(after[0].lastSeenAt, '2026-09-17T10:00:00Z');
});

test('applySaved silences a row without giving it a target', () => {
  const rows = rowsFrom([{ kind: 'item', ez_key: 'delivery fee', ez_name: 'Delivery Fee', seen_count: 4 }]);
  const after = applySaved(rows, saveBody(rows[0], { ignored: true }).body);
  assert.equal(after[0].state, 'ignored');
  assert.equal(after[0].menuItemId, null);
  assert.equal(after[0].matchedBy, 'ignored');
});

test('applySaved does not mutate the list it was given', () => {
  const rows = rowsFrom([{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad' }]);
  const before = JSON.stringify(rows);
  applySaved(rows, saveBody(rows[0], { menuItemId: 'm-caesar' }).body);
  assert.equal(JSON.stringify(rows), before);
});

test('applySaved adds a row the list did not have yet', () => {
  const after = applySaved([], saveBody(row(), { menuItemId: 'm-caesar' }).body);
  assert.equal(after.length, 1);
  assert.equal(after[0].state, 'matched');
  assert.equal(after[0].seenCount, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// 8. end to end: the reason the screen exists
// ────────────────────────────────────────────────────────────────────────────

test('a Partner Portal line lands unmatched, and this screen is what fixes it', () => {
  // Exactly what ezCater sends when nobody ever pushed a menu: posItemId null.
  const theirOrder = [{
    uuid: 'line-1',
    name: 'Caesar Salad (Serves 10)',
    quantity: 1,
    posItemId: null,
    totalInSubunits: { subunits: 3800, currency: 'USD' },
    customizations: [],
  }];
  const lines = orderItemsToLines(theirOrder);
  assert.equal(lines[0].itemId, null, 'the mapper cannot know what this is: that is the bug');

  // The webhook records the sighting. No target, so the screen lists it.
  const rows = rowsFrom([{
    kind: 'item',
    ez_key: buildLinkKey({ name: lines[0].name }, 'item'),
    ez_name: lines[0].name,
    seen_count: 1,
    last_seen_at: '2026-09-17T10:00:00Z',
  }]);
  assert.equal(rows[0].state, 'unmatched');
  assert.equal(countRows(rows).outstanding, 1);
  assert.equal(outstandingLine(countRows(rows), 'item'), '1 of their items is not matched yet.');

  // A person takes the top suggestion.
  const top = suggestionsFor(rows[0], OUR_ITEMS, OUR_GROUPS)[0];
  assert.equal(top.id, 'm-caesar');
  const { body } = saveBody(rows[0], { menuItemId: top.menuItemId });

  // That saved row is what the order path reads back, and now the line routes.
  const fixed = applyLinks(lines, [{ ...body, location_id: 'loc-1', source: 'manual' }]);
  assert.equal(fixed[0].itemId, 'm-caesar');
  assert.equal(fixed[0].match.matched, true);
  assert.equal(fixed[0].match.source, 'manual');

  // And the screen agrees with itself: the row is matched and off the list.
  const after = applySaved(rows, body);
  assert.equal(after[0].state, 'matched');
  assert.equal(countRows(after).outstanding, 0);
});

test('a silenced row never gives a line an itemId', () => {
  const lines = orderItemsToLines([{
    uuid: 'l', name: 'Delivery Fee', quantity: 1, posItemId: null,
    totalInSubunits: { subunits: 500, currency: 'USD' }, customizations: [],
  }]);
  const { body } = saveBody(toRow({ kind: 'item', ez_key: 'delivery fee', ez_name: 'Delivery Fee' }), { ignored: true });
  const out = applyLinks(lines, [{ ...body, location_id: 'loc-1', source: 'manual' }]);
  assert.equal(out[0].itemId, null);
  assert.equal(out[0].match.matched, false);
});
