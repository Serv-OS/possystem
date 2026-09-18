/**
 * ezcaterIngestMatch.test.js
 *
 * The ezCater matcher WIRED INTO INGEST:
 *   supabase/functions/_shared/ezcater-match-ingest.ts   read, decide, save
 *   supabase/functions/_shared/ezcater-map.ts            the ezMatch stamp
 *   supabase/functions/ezcater-webhook/index.ts          the caller
 *
 * ezCater publishes no sandbox, so there is no test environment to catch a bad
 * ingest. These fixtures are the test environment.
 *
 * The single most important thing pinned here is the NEGATIVE one: no read
 * failure, no missing table and no thrown error may change the order that
 * reaches the kitchen. The migration is run by hand, so the window where
 * ezcater_item_links does not exist is real, and it is tested.
 *
 * Run: `npm test`, or `node --test src/lib/ezcaterIngestMatch.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  menuItemsForMatch, modifierGroupsForMatch, linkSeenCounts, planLineMatches,
  readMatchInputs, saveLinkWrites, matchQueueRow,
  MAX_LINK_WRITES, MENU_PAGE_SIZE, MENU_MAX_PAGES, MATCH_BUDGET_MS,
} from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
// The Back Office screen's own view model, so the rows the webhook writes are
// checked against the shape the screen actually reads them back in.
import { toRow, countRows } from './ezcaterItemRows.js';
import {
  ezMatchSummary, withMatchedItems, orderItemsToLines, orderToQueueRow, queuePayload,
  EZ_MATCH_MAX_NAMES,
} from '../../supabase/functions/_shared/ezcater-map.ts';

const NOW = '2026-09-17T12:00:00.000Z';

// ── our menu, as the two tables actually hold it ────────────────────────────

const MENU_ROWS = [
  { id: 'm-caesar', name: 'Caesar Salad', menu_name: null, pricing: { base: 38 }, archived: false },
  { id: 'm-brownie', name: 'Brownie Tray', menu_name: null, pricing: { base: 24 }, archived: false },
  { id: 'm-cola', name: 'Cola', menu_name: null, pricing: { base: 2 }, archived: false },
  // archived is nullable. A row written before the column had a default has no
  // value at all and MUST still be matchable.
  { id: 'm-fruit', name: 'Fruit Platter', pricing: { base: 30 } },
  { id: 'm-retired', name: 'Retired Wrap', pricing: { base: 9 }, archived: true },
  { id: '', name: 'No Id At All', pricing: { base: 1 } },
];

const GROUP_ROWS = [
  {
    id: 'g-drinks',
    name: 'Drink Choice',
    options: [
      { id: 'o-cola', name: 'Cola', itemId: 'm-cola', price: 2 },
      { id: 'o-water', name: 'Still Water', price: 2 },
      { name: 'Ghost With No Id', price: 0 },
      { id: 'o-snake', name: 'Lemonade', item_id: 'm-lemonade' },
    ],
  },
  { id: 'g-empty', name: 'Nothing In Here', options: [] },
];

const OUR_ITEMS = menuItemsForMatch(MENU_ROWS);
const OUR_GROUPS = modifierGroupsForMatch(GROUP_ROWS);

const line = (over) => ({ itemId: null, ezItemId: null, name: 'Caesar Salad', qty: 1, price: 38, lineTotal: 38, mods: [], notes: '', ...over });
const mod = (over) => ({ label: 'Cola', groupLabel: 'Drink Choice', itemId: null, ezItemId: null, qty: 1, price: 2, ...over });

const plan = (lines, over = {}) => planLineMatches({
  lines, ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS, links: [], locationId: 'loc-1', nowIso: NOW, ...over,
});

// ════════════════════════════════════════════════════════════════════════════
//  1. Reading our two tables into the shape the matcher wants
// ════════════════════════════════════════════════════════════════════════════

test('menuItemsForMatch: archived out, archived-null IN, ids required', () => {
  const ids = OUR_ITEMS.map((i) => i.id);
  assert.ok(ids.includes('m-caesar'));
  assert.ok(ids.includes('m-fruit'), 'archived null must not be treated as archived');
  assert.ok(!ids.includes('m-retired'), 'archived true must be dropped');
  assert.equal(ids.filter((i) => !i).length, 0, 'a row with no id cannot be linked to');
});

test('menuItemsForMatch: menu_name to menuName, pricing.base to price, item_code to itemCode', () => {
  const rows = menuItemsForMatch([
    { id: 'x', name: 'Raw', menu_name: 'On The Menu', pricing: { base: 12.5 } },
    { id: 'y', name: 'No Price', pricing: null },
    { id: 'z', name: 'Legacy', pricing: { price: 7 } },
    { id: 'c', name: 'Coded', pricing: { base: 3 }, item_code: 'FLATWHITE' },
  ]);
  assert.deepEqual(rows[0], { id: 'x', name: 'Raw', menuName: 'On The Menu', price: 12.5, itemCode: null });
  assert.equal(rows[1].price, null, 'a missing price is a missing bonus, never an error');
  assert.equal(rows[2].price, 7);
  assert.equal(rows[0].itemCode, null, 'no code is the ordinary state, before and after the migration');
  assert.equal(rows[3].itemCode, 'FLATWHITE');
});

test('modifierGroupsForMatch: options need an id, groups need an option', () => {
  assert.equal(OUR_GROUPS.length, 1, 'a group with no usable option is not a group');
  const g = OUR_GROUPS[0];
  assert.equal(g.id, 'g-drinks');
  assert.deepEqual(g.options.map((o) => o.id), ['o-cola', 'o-water', 'o-snake']);
  assert.equal(g.options[0].itemId, 'm-cola');
  assert.equal(g.options[1].itemId, null);
  assert.equal(g.options[2].itemId, 'm-lemonade', 'item_id is read as well as itemId');
});

test('menuItemsForMatch and modifierGroupsForMatch survive junk', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, [null, undefined, 0, '']]) {
    assert.deepEqual(menuItemsForMatch(junk), []);
    assert.deepEqual(modifierGroupsForMatch(junk), []);
  }
});

test('linkSeenCounts reads snake rows, camel rows and a keyed object', () => {
  assert.equal(linkSeenCounts([{ kind: 'item', ez_key: 'caesar salad', seen_count: 4 }]).get('item:caesar salad'), 4);
  assert.equal(linkSeenCounts([{ kind: 'item', ezKey: 'caesar salad', seenCount: 9 }]).get('item:caesar salad'), 9);
  assert.equal(linkSeenCounts({ 'caesar salad': { kind: 'item', seen_count: 2 } }).get('item:caesar salad'), 2);
  // A null, a negative and a nonsense count all read as zero rather than
  // poisoning the arithmetic of the bump.
  assert.equal(linkSeenCounts([{ kind: 'item', ez_key: 'k', seen_count: null }]).get('item:k'), 0);
  assert.equal(linkSeenCounts([{ kind: 'item', ez_key: 'k', seen_count: -3 }]).get('item:k'), 0);
  assert.equal(linkSeenCounts([{ kind: 'item', ez_key: 'k', seen_count: 'lots' }]).get('item:k'), 0);
});

// ════════════════════════════════════════════════════════════════════════════
//  2. planLineMatches: the decision, with no database anywhere near it
// ════════════════════════════════════════════════════════════════════════════

test('one of our items has exactly that name: linked, and a link is SAVED', () => {
  const p = plan([line({ name: 'Caesar Salad (Serves 10)' })]);
  assert.equal(p.lines[0].itemId, 'm-caesar');
  assert.equal(p.lines[0].match.source, 'auto');
  assert.equal(p.writes.length, 1);
  assert.deepEqual(p.writes[0], {
    location_id: 'loc-1',
    kind: 'item',
    ez_key: 'caesar salad',
    ez_name: 'Caesar Salad (Serves 10)',   // the venue's own spelling, verbatim
    ez_group: null,
    menu_item_id: 'm-caesar',
    option_id: null,
    source: 'auto',
    matched_by: 'name',
    last_seen_at: NOW,
    updated_at: NOW,
    seen_count: 1,
  });
  assert.deepEqual(p.bumps, []);
});

test('two of our items normalise to that name: NEVER guesses, and the row has no target', () => {
  const ours = menuItemsForMatch([
    { id: 'm-c-small', name: 'Caesar Salad Small', pricing: { base: 22 } },
    { id: 'm-c-large', name: 'Caesar Salad Large', pricing: { base: 38 } },
  ]);
  const p = plan([line({ name: 'Caesar Salad' })], { ourItems: ours });
  assert.equal(p.lines[0].itemId, null, 'wrong food to the wrong station is worse than no station');
  assert.equal(p.lines[0].match.matched, false);
  // It IS written down, with nothing on our side of it, because that is the row
  // the Back Office screen lists so a person can answer it.
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0].ez_key, 'caesar salad');
  assert.equal(p.writes[0].menu_item_id, null);
  assert.equal(p.writes[0].option_id, null);
  assert.equal(p.writes[0].matched_by, null, 'null is "seen, nobody has decided yet"');
});

test('a saved link wins and is BUMPED, never rewritten', () => {
  const links = [{
    kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad',
    menu_item_id: 'm-brownie', option_id: null, source: 'manual', seen_count: 6,
  }];
  const p = plan([line({ name: 'Caesar Salad' })], { links });
  assert.equal(p.lines[0].itemId, 'm-brownie', 'a person said brownie, so it is brownie');
  assert.equal(p.lines[0].match.source, 'manual');
  assert.deepEqual(p.writes, [], 'ingest never overwrites a row somebody made');
  assert.deepEqual(p.bumps, [{ kind: 'item', ezKey: 'caesar salad', times: 1, seenCount: 7 }]);
});

test('a saved link beats a posItemId, so a correction is not undone next order', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', menu_item_id: 'm-brownie', source: 'manual', seen_count: 1 }];
  const p = plan([line({ name: 'Caesar Salad', itemId: 'm-caesar' })], { links });
  assert.equal(p.lines[0].itemId, 'm-brownie');
  assert.equal(p.lines[0].match.source, 'manual');
});

test('a posItemId that names a real item of ours is used, and saves NOTHING', () => {
  const p = plan([line({ name: 'Something Only ezCater Knows', itemId: 'm-brownie' })]);
  assert.equal(p.lines[0].itemId, 'm-brownie');
  assert.equal(p.lines[0].match.source, 'posItemId');
  // The migration header is explicit: an id ezCater already carries names our
  // item already, so a row would add nothing and only go stale.
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, []);
});

test('a posItemId that names nothing of ours is dropped WHEN we hold the menu', () => {
  const l = line({ name: 'Mystery Box', itemId: 'ez-junk-id' });
  const withMenu = plan([l]);
  assert.equal(withMenu.lines[0].itemId, null, 'a phantom id in product reports helps nobody');

  // ...and kept when we do not, because that is exactly today's behaviour and
  // today's behaviour is a working ticket.
  const noMenu = plan([l], { ourItems: [], ourGroups: [] });
  assert.equal(noMenu.lines[0].itemId, 'ez-junk-id');
  assert.deepEqual(noMenu.writes, []);
  assert.deepEqual(noMenu.bumps, []);
});

// ── item codes (v5.8.100) ──────────────────────────────────────────────────
// The venue types one of our codes into ezCater's POS id field, and ezCater
// sends it straight back on posItemId. Peter asked for exactly two things: the
// code should work, and a MISSING code must change nothing at all.

const CODED_ROWS = MENU_ROWS.map((r) => {
  if (r.id === 'm-caesar') return { ...r, item_code: 'CAESARSAL' };
  if (r.id === 'm-cola') return { ...r, item_code: 'COLA1' };
  return r;
});
const CODED_ITEMS = menuItemsForMatch(CODED_ROWS);
const codedPlan = (lines, over = {}) => plan(lines, { ourItems: CODED_ITEMS, ...over });

test('their posItemId is one of our item codes: certain, and NOTHING is saved', () => {
  const p = codedPlan([line({ name: 'Whatever They Call It', itemId: 'CAESARSAL' })]);
  assert.equal(p.lines[0].itemId, 'm-caesar');
  assert.equal(p.lines[0].match.source, 'itemCode');
  // The code already names our item, so a link row would add nothing and would
  // only go stale. Same rule the plain posItemId has always had.
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, []);
});

test('an item code is case insensitive and trimmed, and nothing else', () => {
  for (const sent of ['caesarsal', '  CaesarSal  ', 'CAESARSAL']) {
    const p = codedPlan([line({ name: 'Whatever', itemId: sent })]);
    assert.equal(p.lines[0].itemId, 'm-caesar', 'sent as: ' + JSON.stringify(sent));
  }
  // Punctuation is NOT forgiven: "CAESAR-SAL" is a different string, and
  // guessing there would let their "M-123" become our "M123".
  const p = codedPlan([line({ name: 'Whatever', itemId: 'CAESAR-SAL' })]);
  assert.equal(p.lines[0].itemId, null);
});

test('an item code OUTRANKS a saved link, because it is the venue saying so', () => {
  const links = [{
    kind: 'item', ez_key: 'whatever', ez_name: 'Whatever', menu_item_id: 'm-brownie',
    source: 'manual', seen_count: 4,
  }];
  const p = codedPlan([line({ name: 'Whatever', itemId: 'CAESARSAL' })], { links });
  assert.equal(p.lines[0].itemId, 'm-caesar', 'the code they typed today beats a link from a name');
  assert.equal(p.lines[0].match.source, 'itemCode');
});

test('AN UNKNOWN CODE BLOCKS NOTHING: the order arrives and the name rules run', () => {
  // The whole point of Peter's request. A code we have never seen is not an
  // error, not a refusal and not a delay: it is simply not a match.
  const p = codedPlan([line({ name: 'Caesar Salad', itemId: 'SOMETHINGELSE' })]);
  assert.equal(p.lines[0].itemId, 'm-caesar', 'matched by name, exactly as if no code had been sent');
  assert.equal(p.lines[0].match.source, 'auto');
  assert.equal(p.writes.length, 1, 'and the link is written as usual');
  assert.equal(p.writes[0].menu_item_id, 'm-caesar');

  // An unknown code on a name we do not sell either is still just a sighting.
  const q = codedPlan([line({ name: 'Lobster Thermidor', itemId: 'NOSUCHCODE' })]);
  assert.equal(q.lines[0].itemId, null);
  assert.equal(q.writes.length, 1);
  assert.equal(q.writes[0].menu_item_id, null);
  assert.equal(q.writes[0].matched_by, null);
});

test('no codes anywhere behaves exactly as it did before codes existed', () => {
  const withCodes = codedPlan([line({ name: 'Caesar Salad' })]);
  const without = plan([line({ name: 'Caesar Salad' })]);
  assert.deepEqual(withCodes.lines, without.lines);
  assert.deepEqual(withCodes.writes, without.writes);
});

test('a code on a customization names our product, and our option that points at it', () => {
  const p = codedPlan([line({ name: 'Caesar Salad', mods: [mod({ label: 'Their Own Word', itemId: 'cola1' })] })]);
  const m = p.lines[0].mods[0];
  assert.equal(m.itemId, 'm-cola', 'stock and 86 key on the product behind the option');
  assert.equal(m.optionId, 'o-cola', 'and our option points at that product');
  assert.equal(m.match.source, 'itemCode');
  assert.deepEqual(p.writes.filter((w) => w.kind === 'option'), [], 'a code needs no link row');
});

test('two of our products with the same code: no code match, the ordinary rules decide', () => {
  // The database cannot hold this (unique index), so if it ever happens
  // something is wrong, and "certain" is what such a code is not.
  const ours = menuItemsForMatch([
    { id: 'm-a', name: 'Alpha', pricing: { base: 1 }, item_code: 'DUPE' },
    { id: 'm-b', name: 'Beta', pricing: { base: 2 }, item_code: 'dupe' },
  ]);
  const p = plan([line({ name: 'Alpha', itemId: 'DUPE' })], { ourItems: ours });
  assert.equal(p.lines[0].itemId, 'm-a', 'matched by its name, not by the ambiguous code');
  assert.equal(p.lines[0].match.source, 'auto');
});

test('a stale link (its item is gone or archived today) is left completely alone', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', menu_item_id: 'm-deleted', source: 'manual', seen_count: 3 }];
  const p = plan([line({ name: 'Caesar Salad' })], { links });
  assert.equal(p.lines[0].itemId, 'm-caesar', 'this order still routes, by name');
  assert.deepEqual(p.writes, [], 'an item archived for a week must not eat a manual match');
  assert.deepEqual(p.bumps, []);
});

test('modifiers match our options, and the link key carries the group', () => {
  const p = plan([line({ name: 'Caesar Salad', mods: [mod({ label: 'Still Water', groupLabel: 'Drinks' })] })]);
  const m = p.lines[0].mods[0];
  assert.equal(m.optionId, 'o-water');
  assert.equal(m.match.matched, true);
  const w = p.writes.find((r) => r.kind === 'option');
  assert.equal(w.ez_key, 'drinks|still water', 'Large under Size and Large under Drink are two things');
  assert.equal(w.ez_name, 'Still Water');
  assert.equal(w.ez_group, 'Drinks', "the venue's own group name, verbatim");
  assert.equal(w.option_id, 'o-water');
  assert.equal(w.menu_item_id, null);
});

test('an option that points at one of our items carries that item id too', () => {
  const p = plan([line({ name: 'Caesar Salad', mods: [mod({ label: 'Cola' })] })]);
  const m = p.lines[0].mods[0];
  assert.equal(m.optionId, 'o-cola');
  assert.equal(m.itemId, 'm-cola', '86 and stock key on the item behind the option');
  const w = p.writes.find((r) => r.kind === 'option');
  assert.equal(w.menu_item_id, 'm-cola');
  assert.equal(w.option_id, 'o-cola');
});

test('an option we cannot match keeps whatever the line already carried', () => {
  // ezCater's customization shape has no posItemId field, so the option arm of
  // autoLinkDecision has no rule for one. An id that somehow arrives anyway must
  // not be thrown away by a failed name match.
  const p = plan([line({ name: 'Caesar Salad', mods: [mod({ label: 'Something We Do Not Sell', itemId: 'ez-mod-id' })] })]);
  const m = p.lines[0].mods[0];
  assert.equal(m.itemId, 'ez-mod-id');
  assert.equal(m.match.source, 'posItemId');
  // Nothing of ours matched it by name, so the row goes down with no target and
  // the screen asks. The id on the line is kept either way.
  const w = p.writes.filter((r) => r.kind === 'option');
  assert.equal(w.length, 1);
  assert.equal(w[0].ez_name, 'Something We Do Not Sell');
  assert.equal(w[0].option_id, null);
  assert.equal(w[0].menu_item_id, null);
});

test('the same name twice in one order is ONE row with seen_count 2', () => {
  const p = plan([line({ name: 'Caesar Salad' }), line({ name: 'CAESAR SALAD, tray' })]);
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0].seen_count, 2);
});

test('THEIR TWO SIZES ARE TWO ROWS, so one match cannot route both', () => {
  // The venue sells a half tray and a full tray of the same salad. Both are our
  // one Caesar Salad today, but they are two products: two rows, two keys, and
  // a person can send the full tray somewhere else tomorrow.
  const p = plan([
    line({ name: 'Caesar Salad Half Tray' }),
    line({ name: 'Caesar Salad Full Tray' }),
  ]);
  assert.equal(p.writes.length, 2, 'one row for both would be one stock count for both');
  assert.deepEqual(p.writes.map((w) => w.ez_key).sort(), ['caesar salad full', 'caesar salad half']);
  assert.deepEqual(p.writes.map((w) => w.ez_name).sort(), ['Caesar Salad Full Tray', 'Caesar Salad Half Tray']);
  // Both still route to the salad we do have.
  assert.equal(p.lines[0].itemId, 'm-caesar');
  assert.equal(p.lines[1].itemId, 'm-caesar');
});

test('a link saved under the older key still routes and is bumped under ITS key', () => {
  const links = [{
    kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad Half Tray',
    menu_item_id: 'm-brownie', option_id: null, source: 'manual', seen_count: 2,
  }];
  const p = plan([line({ name: 'Caesar Salad Half Tray' })], { links });
  assert.equal(p.lines[0].itemId, 'm-brownie', "the venue's earlier work still routes");
  assert.deepEqual(p.writes, [], 'and no second row is written beside it');
  assert.deepEqual(p.bumps, [{ kind: 'item', ezKey: 'caesar salad', times: 1, seenCount: 3 }]);
});

test('the same saved link twice in one order is ONE bump of two', () => {
  const links = [{ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', menu_item_id: 'm-caesar', source: 'auto', seen_count: 10 }];
  const p = plan([line({ name: 'Caesar Salad' }), line({ name: 'Caesar Salad (Serves 10)' })], { links });
  assert.deepEqual(p.bumps, [{ kind: 'item', ezKey: 'caesar salad', times: 2, seenCount: 12 }]);
});

test('a name that cannot be normalised is never written', () => {
  // The primary key is (location_id, kind, ez_key). An empty key would collapse
  // every unnamed line onto one row and point them all at one product.
  for (const name of ['', '!!!', '   ', null, undefined]) {
    const p = plan([line({ name })]);
    assert.deepEqual(p.writes, [], 'wrote a row for name ' + JSON.stringify(name));
    assert.equal(p.lines[0].itemId, null);
  }
});

test('every written row satisfies the migration check constraints', () => {
  const p = plan([
    line({ name: 'Caesar Salad', mods: [mod({ label: 'Cola' }), mod({ label: 'Still Water', groupLabel: 'Drinks' })] }),
    line({ name: 'Brownie Tray' }),
    line({ name: 'Something We Have Never Heard Of' }),   // a sighting, no target
  ]);
  assert.ok(p.writes.length >= 4);
  for (const w of p.writes) {
    assert.ok(['item', 'option'].includes(w.kind));
    assert.ok(['auto', 'manual'].includes(w.source));
    assert.ok(w.ez_key.trim().length > 0 && w.ez_name.trim().length > 0);
    // The WIDENED target check: no target at all is allowed and is how a seen
    // but unmatched item is stored. A row that DOES name one of ours has to
    // name the right kind of thing.
    if (!w.menu_item_id && !w.option_id) {
      assert.equal(w.matched_by, null, 'a row with no target must not claim it was matched');
      continue;
    }
    if (w.kind === 'item') {
      assert.ok(w.menu_item_id, 'kind item needs menu_item_id');
      assert.equal(w.option_id, null, 'kind item must not carry option_id');
    } else {
      assert.ok(w.option_id || w.menu_item_id, 'kind option needs one of the two');
    }
  }
});

test('planLineMatches does not mutate the lines it is given', () => {
  const lines = [line({ name: 'Caesar Salad', mods: [mod({ label: 'Cola' })] })];
  const before = JSON.parse(JSON.stringify(lines));
  const p = plan(lines);
  assert.deepEqual(lines, before);
  assert.notEqual(p.lines[0], lines[0]);
});

test('planLineMatches is deterministic and takes its clock as an argument', () => {
  const lines = [line({ name: 'Brownie Tray' })];
  assert.deepEqual(plan(lines), plan(lines));
  assert.equal(plan(lines).writes[0].last_seen_at, NOW);
});

test('one pathological order cannot write an unbounded number of rows', () => {
  const ours = [];
  const lines = [];
  for (let i = 0; i < MAX_LINK_WRITES + 40; i++) {
    ours.push({ id: 'm-' + i, name: 'Dish Number ' + i, price: i });
    lines.push(line({ name: 'Dish Number ' + i }));
  }
  const p = plan(lines, { ourItems: ours });
  assert.equal(p.writes.length, MAX_LINK_WRITES);
  assert.equal(p.lines.length, lines.length, 'every line is still decided and still routes');
  assert.equal(p.lines[p.lines.length - 1].itemId, 'm-' + (lines.length - 1));
});

test('no menu and no links is exactly applyLinks, which is exactly today', () => {
  const lines = [line({ name: 'Caesar Salad', itemId: 'ez-supplied' })];
  const p = planLineMatches({ lines, ourItems: [], ourGroups: [], links: [], locationId: 'loc-1', nowIso: NOW });
  assert.equal(p.lines[0].itemId, 'ez-supplied');
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, []);
});

test('no locationId means nothing is ever written against a wrong venue', () => {
  const p = plan([line({ name: 'Caesar Salad' })], { locationId: '' });
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, []);
});

// ════════════════════════════════════════════════════════════════════════════
//  2b. SEEN BUT UNMATCHED. The rows the Back Office screen is built to list.
// ════════════════════════════════════════════════════════════════════════════

test('EVERY name on an order is written down, matched or not', () => {
  const p = plan([
    line({ name: 'Caesar Salad' }),                                   // ours
    line({ name: 'Veggie Platter' }),                                 // not ours
    line({ name: 'Mystery Box', mods: [mod({ label: 'Pickles', groupLabel: 'Extras' })] }),
  ]);
  const keys = p.writes.map((w) => w.kind + ':' + w.ez_key).sort();
  assert.deepEqual(keys, ['item:caesar salad', 'item:mystery box', 'item:veggie platter', 'option:extras|pickles']);

  const seen = p.writes.find((w) => w.ez_key === 'veggie platter');
  assert.equal(seen.ez_name, 'Veggie Platter', "their own spelling, for the screen to show");
  assert.equal(seen.menu_item_id, null);
  assert.equal(seen.option_id, null);
  assert.equal(seen.matched_by, null);
  assert.equal(seen.source, 'auto');
  assert.equal(seen.seen_count, 1);
  assert.equal(seen.last_seen_at, NOW);

  const opt = p.writes.find((w) => w.kind === 'option');
  assert.equal(opt.ez_group, 'Extras', 'the group they typed, so two Larges are told apart');
});

test('a seen row carries every column toRow() reads, so the screen can list it', () => {
  // The screen derives its three states from these columns and nothing else.
  const p = plan([line({ name: 'Veggie Platter' })]);
  const w = p.writes[0];
  for (const col of ['location_id', 'kind', 'ez_key', 'ez_name', 'ez_group', 'menu_item_id', 'option_id', 'source', 'matched_by', 'seen_count', 'last_seen_at', 'updated_at']) {
    assert.ok(col in w, 'missing column ' + col);
  }
  const shown = toRow(w);
  assert.equal(shown.state, 'unmatched', 'this is the row the screen lists as outstanding');
  assert.equal(shown.ezName, 'Veggie Platter');
  assert.equal(shown.seenCount, 1);
  assert.equal(countRows([shown]).outstanding, 1);
});

test('a name seen again bumps its row instead of writing a second one', () => {
  const links = [{
    kind: 'item', ez_key: 'veggie platter', ez_name: 'Veggie Platter',
    menu_item_id: null, option_id: null, source: 'auto', seen_count: 4,
  }];
  const p = plan([line({ name: 'Veggie Platter' }), line({ name: 'Veggie Platter (Serves 10)' })], { links });
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, [{ kind: 'item', ezKey: 'veggie platter', times: 2, seenCount: 6 }]);
  assert.deepEqual(p.upgrades, [], 'nothing of ours matches it, so there is nothing to fill in');
});

test('a bare sighting is filled in once our menu has the item, and never otherwise', () => {
  // Order 1 saw "Brownie Tray" before the venue added it. Now we have it.
  // 'tray' is a container word, so the key of "Brownie Tray" is 'brownie'.
  const bare = { kind: 'item', ez_key: 'brownie', ez_name: 'Brownie Tray', menu_item_id: null, option_id: null, source: 'auto', seen_count: 3 };
  const p = plan([line({ name: 'Brownie Tray' })], { links: [bare] });
  assert.deepEqual(p.upgrades, [{ kind: 'item', ezKey: 'brownie', menuItemId: 'm-brownie', optionId: null }]);
  assert.deepEqual(p.writes, [], 'the row exists, so it is updated in place, never duplicated');

  // A person who said "Not on our menu" is never overruled.
  const ignored = { ...bare, source: 'manual', matched_by: 'ignored' };
  assert.deepEqual(plan([line({ name: 'Brownie Tray' })], { links: [ignored] }).upgrades, []);

  // Nor is a person's own match.
  const theirs = { ...bare, source: 'manual', menu_item_id: 'm-cola' };
  assert.deepEqual(plan([line({ name: 'Brownie Tray' })], { links: [theirs] }).upgrades, []);
});

// ════════════════════════════════════════════════════════════════════════════
//  2c. A PARTLY READ MENU IS NOT A MENU
// ════════════════════════════════════════════════════════════════════════════

test('menuOk false: saved links only, and NOT ONE new row', () => {
  // Half the menu came back. "We do not sell a Brownie Tray" is a claim about
  // the half we never saw, and an auto link written from it would be wrong on
  // every later order, silently.
  const links = [{ kind: 'item', ez_key: 'cola', ez_name: 'Cola', menu_item_id: 'm-cola', source: 'manual', seen_count: 1 }];
  const p = plan([line({ name: 'Brownie Tray' }), line({ name: 'Cola' })], { menuOk: false, links });
  assert.equal(p.lines[0].itemId, null, 'no guessing from a piece of the menu');
  assert.equal(p.lines[1].itemId, 'm-cola', 'the saved link still does its job');
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.bumps, []);
  assert.deepEqual(p.upgrades, []);

  // With the whole menu it links and writes, which is the difference.
  const whole = plan([line({ name: 'Brownie Tray' })], { links });
  assert.equal(whole.lines[0].itemId, 'm-brownie');
  assert.equal(whole.writes.length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
//  3. The ezMatch stamp on the order row
// ════════════════════════════════════════════════════════════════════════════

test('ezMatchSummary is lines, matched and the unmatched names', () => {
  const p = plan([
    line({ name: 'Caesar Salad' }),
    line({ name: 'Veggie Platter' }),
    line({ name: 'Brownie Tray' }),
  ]);
  assert.deepEqual(ezMatchSummary(p.lines), { lines: 3, matched: 2, unmatched: ['Veggie Platter'] });
});

test('ezMatchSummary dedupes a repeated name and caps the list, never the count', () => {
  const many = [];
  for (let i = 0; i < EZ_MATCH_MAX_NAMES + 10; i++) many.push({ name: 'Unknown ' + i, match: { matched: false } });
  many.push({ name: 'Unknown 0', match: { matched: false } });          // a repeat
  const s = ezMatchSummary(many);
  assert.equal(s.unmatched.length, EZ_MATCH_MAX_NAMES);
  assert.equal(s.lines - s.matched, many.length, 'the true number is always lines minus matched');
  assert.equal(new Set(s.unmatched).size, s.unmatched.length);
});

test('ezMatchSummary counts a line matched however its itemId arrived', () => {
  assert.equal(ezMatchSummary([{ name: 'A', itemId: 'm-1' }]).matched, 1);
  assert.equal(ezMatchSummary([{ name: 'A', match: { matched: true, source: 'posItemId' } }]).matched, 1);
  assert.deepEqual(ezMatchSummary([]), { lines: 0, matched: 0, unmatched: [] });
  assert.deepEqual(ezMatchSummary(null), { lines: 0, matched: 0, unmatched: [] });
  assert.deepEqual(ezMatchSummary([{ match: { matched: false } }]).unmatched, ['Item']);
});

test('withMatchedItems stamps customer.ezMatch and keeps everything else', () => {
  const row = { ref: 'EZ-1', items: [], customer: { name: 'Acme', paid: true, totals: { subtotal: 10 } } };
  const p = plan([line({ name: 'Caesar Salad' }), line({ name: 'Veggie Platter' })]);
  const next = withMatchedItems(row, p.lines);
  assert.deepEqual(next.customer.ezMatch, { lines: 2, matched: 1, unmatched: ['Veggie Platter'] });
  assert.equal(next.customer.name, 'Acme');
  assert.equal(next.customer.paid, true);
  assert.deepEqual(next.customer.totals, { subtotal: 10 });
  assert.equal(next.ref, 'EZ-1');
  // The caller keeps the original as its fallback, so it must not be touched.
  assert.equal(row.customer.ezMatch, undefined);
  assert.deepEqual(row.items, []);
});

test('the stamp survives queuePayload, which is what actually reaches order_queue', () => {
  const p = plan([line({ name: 'Caesar Salad' })]);
  const row = withMatchedItems({ ref: 'EZ-1', location_id: 'loc-1', type: 'collection', customer: { paid: true }, items: [], total: 38, status: 'received', is_asap: false, collection_time: null, event_date: null }, p.lines);
  const payload = queuePayload(row, true, NOW);
  assert.deepEqual(payload.customer.ezMatch, { lines: 1, matched: 1, unmatched: [] });
  assert.equal(payload.items[0].itemId, 'm-caesar');
});

// ════════════════════════════════════════════════════════════════════════════
//  4. End to end on a REAL mapped order, through the live mapper
// ════════════════════════════════════════════════════════════════════════════

const PORTAL_ORDER = {
  uuid: 'ez-order-1',
  orderNumber: 'ABC-123',
  caterer: { uuid: 'cat-1', name: 'Test Caterer' },
  event: { orderType: 'TAKEOUT', timestamp: '2026-09-20T17:00:00-04:00', timeZoneIdentifier: 'America/New_York', headcount: 20 },
  catererCart: {
    orderItems: [
      // A Partner Portal menu: posItemId is null on every line.
      {
        uuid: 'ez-line-1', name: 'Caesar Salad (Serves 10)', quantity: 1, posItemId: null,
        totalInSubunits: { subunits: 3800, currency: 'USD' },
        customizations: [{ name: 'Cola', customizationTypeName: 'Drink Choice', quantity: 1 }],
        specialInstructions: 'no croutons',
      },
      { uuid: 'ez-line-2', name: 'Veggie Platter feeds 8 people', quantity: 2, posItemId: null, totalInSubunits: { subunits: 5000, currency: 'USD' }, customizations: [] },
    ],
    totals: { subtotal: { subunits: 8800, currency: 'USD' } },
  },
};

test('a real Partner Portal order: the mapper leaves itemId null, the plan fills it', () => {
  const { row } = orderToQueueRow(PORTAL_ORDER, 'loc-1', {});
  assert.equal(row.items[0].itemId, null, 'this is the bug the whole feature exists for');
  assert.equal(row.items[1].itemId, null);

  const p = plan(row.items);
  assert.equal(p.lines[0].itemId, 'm-caesar');
  assert.equal(p.lines[0].mods[0].optionId, 'o-cola');
  assert.equal(p.lines[0].mods[0].itemId, 'm-cola');
  assert.equal(p.lines[1].itemId, null, 'we do not sell a veggie platter, so nobody pretends we do');

  const next = withMatchedItems(row, p.lines);
  assert.deepEqual(next.customer.ezMatch, { lines: 2, matched: 1, unmatched: ['Veggie Platter feeds 8 people'] });
  // Everything the mapper put on the row is still there.
  assert.equal(next.customer.headcount, 20);
  assert.equal(next.items[0].notes, 'no croutons');
  assert.equal(next.items[0].qty, 1);
  assert.equal(next.items[1].qty, 2);
});

test('orderItemsToLines output feeds the planner unchanged', () => {
  const lines = orderItemsToLines(PORTAL_ORDER.catererCart.orderItems);
  const p = plan(lines);
  assert.equal(p.lines.length, lines.length);
  // One row per line: the Caesar matched, the veggie platter seen and waiting.
  const items = p.writes.filter((w) => w.kind === 'item');
  assert.equal(items.length, 2);
  assert.equal(items.filter((w) => w.menu_item_id).length, 1);
  assert.equal(p.writes.filter((w) => w.kind === 'option').length, 1);
});

// ════════════════════════════════════════════════════════════════════════════
//  5. The database side, against a fake client. NOTHING here may throw.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The smallest Supabase client that answers the calls this module makes:
 * select/eq/is/order/range, upsert with ignoreDuplicates, update/eq/is.
 * `fail` maps a table name, or 'table:op', to the error it should return.
 * `boom` makes .from() itself throw, which is the network dying mid call.
 * `hang` makes every call never resolve, which is the read that never comes back.
 */
function fakeSb(tables, { fail = {}, boom = false, hang = false, noItemCodeColumn = false } = {}) {
  const calls = [];
  const store = JSON.parse(JSON.stringify(tables));
  const from = (name) => {
    if (boom) throw new Error('socket hang up');
    const state = { op: 'select', cols: '*', filters: {}, nulls: {}, range: null, rows: null, patch: null, opts: null };
    // `.is(col, null)` is a real filter here, because the sighting fill leans on
    // it: the update must not touch a row a person has answered.
    const matches = (r) => Object.entries(state.filters).every(([k, v]) => String(r[k] ?? '') === String(v))
      && Object.entries(state.nulls).every(([k, v]) => (v === null ? (r[k] ?? null) === null : (r[k] ?? null) === v));
    const run = () => {
      // Postgres fails the WHOLE select when one named column does not exist.
      // This is the window before 20260917_OPS_menu_item_code.sql is run.
      if (noItemCodeColumn && state.op === 'select' && /item_code/.test(String(state.cols || ''))) {
        return { data: null, error: { code: '42703', message: 'column menu_items.item_code does not exist' } };
      }
      const err = fail[name + ':' + state.op] || fail[name];
      if (err) return { data: null, error: err };
      if (state.op === 'select') {
        let rows = (store[name] || []).filter(matches);
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        return { data: rows, error: null };
      }
      if (state.op === 'upsert') {
        const rows = Array.isArray(state.rows) ? state.rows : [state.rows];
        calls.push({ op: 'upsert', table: name, rows, opts: state.opts });
        store[name] = store[name] || [];
        for (const r of rows) {
          const clash = store[name].some((e) => e.location_id === r.location_id && e.kind === r.kind && e.ez_key === r.ez_key);
          if (clash && state.opts?.ignoreDuplicates) continue;   // on conflict do nothing
          if (!clash) store[name].push({ ...r });
        }
        return { data: null, error: null };
      }
      calls.push({ op: 'update', table: name, patch: state.patch, filters: { ...state.filters }, nulls: { ...state.nulls } });
      for (const r of store[name] || []) if (matches(r)) Object.assign(r, state.patch);
      return { data: null, error: null };
    };
    const b = {
      select(cols) { state.op = 'select'; state.cols = cols || '*'; return b; },
      eq(col, val) { state.filters[col] = val; return b; },
      is(col, val) { state.nulls[col] = val; return b; },
      order() { return b; },
      range(a, z) { state.range = [a, z]; return b; },
      upsert(rows, opts) { state.op = 'upsert'; state.rows = rows; state.opts = opts; return b; },
      update(patch) { state.op = 'update'; state.patch = patch; return b; },
      maybeSingle() { return b; },
      then(ok, no) {
        if (hang) return new Promise(() => {});      // never settles, ever
        return Promise.resolve().then(run).then(ok, no);
      },
    };
    return b;
  };
  return { from, calls, store };
}

// The tables as the real ones are: every row carries its location_id, because
// every read in this module is fenced on it.
const at = (rows) => rows.map((r) => ({ ...r, location_id: 'loc-1' }));
const TABLES = () => ({ menu_items: at(MENU_ROWS), modifier_groups: at(GROUP_ROWS), ezcater_item_links: [] });
const MISSING_TABLE = { code: '42P01', message: 'relation "public.ezcater_item_links" does not exist' };

const orderRow = (lines) => ({
  ref: 'EZ-order-1', location_id: 'loc-1', type: 'collection', status: 'received',
  items: lines, total: 88, customer: { name: 'Acme', paid: true },
});

test('matchQueueRow: the happy path fills itemId, saves a link and stamps the summary', async () => {
  const sb = fakeSb(TABLES());
  const row = orderRow([line({ name: 'Caesar Salad (Serves 10)', mods: [mod({ label: 'Cola' })] }), line({ name: 'Veggie Platter' })]);
  const out = await matchQueueRow(sb, 'loc-1', row, { nowIso: NOW });

  assert.equal(out.ran, true);
  assert.equal(out.row.items[0].itemId, 'm-caesar');
  assert.equal(out.row.items[0].mods[0].optionId, 'o-cola');
  assert.deepEqual(out.row.customer.ezMatch, { lines: 2, matched: 1, unmatched: ['Veggie Platter'] });
  assert.equal(out.matched, 1);

  const written = sb.store.ezcater_item_links;
  assert.equal(written.length, 3, 'the matched item, its option, and the one we could not match');
  assert.ok(written.every((r) => r.source === 'auto' && r.location_id === 'loc-1'));
  assert.ok(written.every((r) => r.last_seen_at === NOW));

  // The unmatched one is a real row with no target, which is what the Back
  // Office screen lists. Without it that screen ships empty.
  const seen = written.find((r) => r.ez_name === 'Veggie Platter');
  assert.ok(seen, 'their unmatched item was never written down');
  assert.equal(seen.menu_item_id, null);
  assert.equal(seen.matched_by, null);
  assert.equal(toRow(seen).state, 'unmatched');
});

test('matchQueueRow: the second order uses the saved link and bumps seen_count', async () => {
  const sb = fakeSb({
    ...TABLES(),
    ezcater_item_links: [{
      location_id: 'loc-1', kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad',
      menu_item_id: 'm-brownie', option_id: null, source: 'manual', seen_count: 6,
    }],
  });
  const out = await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Caesar Salad' })]), { nowIso: NOW });

  assert.equal(out.row.items[0].itemId, 'm-brownie', "the person's choice, not ours");
  assert.equal(out.bumped, 1);
  const saved = sb.store.ezcater_item_links[0];
  assert.equal(saved.seen_count, 7);
  assert.equal(saved.last_seen_at, NOW);
  assert.equal(saved.source, 'manual', 'a bump touches counters only');
  assert.equal(saved.menu_item_id, 'm-brownie');
  assert.equal(sb.calls.filter((c) => c.op === 'upsert').length, 0, 'nothing to insert');
});

test('THE MIGRATION IS NOT RUN YET: no table, no crash, the order still goes through', async () => {
  const sb = fakeSb(TABLES(), { fail: { ezcater_item_links: MISSING_TABLE } });
  const row = orderRow([line({ name: 'Caesar Salad' })]);
  const out = await matchQueueRow(sb, 'loc-1', row, { nowIso: NOW });

  assert.equal(out.ran, true);
  assert.equal(out.row.items[0].itemId, 'm-caesar', 'a name match still routes this order');
  assert.equal(out.inserted, 0, 'and nothing is written into a table that does not exist');
  assert.equal(out.bumped, 0);
  assert.equal(sb.calls.filter((c) => c.op !== 'select').length, 0);
  assert.deepEqual(out.row.customer.ezMatch, { lines: 1, matched: 1, unmatched: [] });
});

test('menu_items.item_code DOES NOT EXIST YET: the menu is read again without it', async () => {
  // Naming a column that does not exist fails the WHOLE select, so without the
  // second read there would be no menu at all and every line would arrive
  // unmatched. This is the window before Peter runs the item code migration.
  const sb = fakeSb(TABLES(), { noItemCodeColumn: true });
  const out = await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Caesar Salad' })]), { nowIso: NOW });

  assert.equal(out.ran, true);
  assert.equal(out.row.items[0].itemId, 'm-caesar', 'the name rules still match the whole menu');
  assert.equal(out.row.items[0].match.source, 'auto');
  assert.deepEqual(out.row.customer.ezMatch, { lines: 1, matched: 1, unmatched: [] });
});

test('with the column there, a code the venue typed matches end to end', async () => {
  const sb = fakeSb({ ...TABLES(), menu_items: at(CODED_ROWS) });
  const lines = [line({ name: 'Their Name For It', itemId: 'caesarsal ' })];
  const out = await matchQueueRow(sb, 'loc-1', orderRow(lines), { nowIso: NOW });

  assert.equal(out.row.items[0].itemId, 'm-caesar');
  assert.equal(out.row.items[0].match.source, 'itemCode');
  assert.deepEqual(out.row.customer.ezMatch, { lines: 1, matched: 1, unmatched: [] });
  assert.deepEqual(sb.store.ezcater_item_links, [], 'a code needs no link row');
});

test('an unknown code never delays an order: same work, same writes, same row', async () => {
  const sb = fakeSb({ ...TABLES(), menu_items: at(CODED_ROWS) });
  const out = await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Veggie Platter', itemId: 'GHOSTCODE' })]), { nowIso: NOW });

  assert.equal(out.ran, true, 'nothing about an unknown code stops the job running');
  assert.equal(out.row.items[0].itemId, null, 'we do not sell it, so it is a plain text ticket');
  assert.deepEqual(out.row.customer.ezMatch, { lines: 1, matched: 0, unmatched: ['Veggie Platter'] });
  assert.equal(sb.store.ezcater_item_links.length, 1, 'and it is written down for a person to answer');
  assert.equal(sb.store.ezcater_item_links[0].menu_item_id, null);
});

test('the menu read failing leaves the order exactly as the mapper built it', async () => {
  const sb = fakeSb(TABLES(), { fail: { menu_items: { message: 'timeout' }, modifier_groups: { message: 'timeout' } } });
  const lines = [line({ name: 'Caesar Salad', itemId: 'ez-supplied' })];
  const out = await matchQueueRow(sb, 'loc-1', orderRow(lines), { nowIso: NOW });
  assert.equal(out.row.items[0].itemId, 'ez-supplied', 'no menu means no opinion, so nothing changes');
  assert.deepEqual(out.row.customer.ezMatch, { lines: 1, matched: 1, unmatched: [] });
});

test('a link write failing costs the next order a rematch and nothing else', async () => {
  const sb = fakeSb(TABLES(), { fail: { 'ezcater_item_links:upsert': { message: 'permission denied' } } });
  const out = await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Caesar Salad' })]), { nowIso: NOW });
  assert.equal(out.row.items[0].itemId, 'm-caesar');
  assert.equal(out.inserted, 0);
  assert.equal(out.ran, true);
});

test('the client dying mid call returns the ORIGINAL row, untouched', async () => {
  const row = orderRow([line({ name: 'Caesar Salad' })]);
  // Both ways it can die: from() throwing, and every read erroring.
  const dead = [
    fakeSb(TABLES(), { boom: true }),
    fakeSb(TABLES(), { fail: { ezcater_item_links: MISSING_TABLE, menu_items: { message: 'down' }, modifier_groups: { message: 'down' } } }),
  ];
  for (const sb of dead) {
    const out = await matchQueueRow(sb, 'loc-1', row, { nowIso: NOW });
    assert.equal(out.ran, false);
    assert.equal(out.row, row, 'the very same object the mapper produced');
    // "we could not check" must never be stamped as "we checked and found none".
    assert.equal(out.row.customer.ezMatch, undefined);
    assert.equal(out.row.items[0].itemId, null);
  }
});

test('matchQueueRow refuses to do anything silly with nothing', async () => {
  const row = orderRow([]);
  for (const args of [[null, 'loc-1', row], [fakeSb(TABLES()), '', row], [fakeSb(TABLES()), 'loc-1', row], [fakeSb(TABLES()), 'loc-1', null]]) {
    const out = await matchQueueRow(args[0], args[1], args[2], { nowIso: NOW });
    assert.equal(out.ran, false);
    assert.equal(out.row, args[2]);
  }
});

test('readMatchInputs and saveLinkWrites never throw, whatever they are handed', async () => {
  for (const sb of [null, undefined, {}, fakeSb(TABLES(), { boom: true }), fakeSb(TABLES(), { fail: { menu_items: { message: 'x' }, modifier_groups: { message: 'x' }, ezcater_item_links: MISSING_TABLE } })]) {
    const inputs = await readMatchInputs(sb, 'loc-1');
    assert.ok(Array.isArray(inputs.links) && Array.isArray(inputs.ourItems) && Array.isArray(inputs.ourGroups));
    const saved = await saveLinkWrites(sb, 'loc-1', [{ location_id: 'loc-1', kind: 'item', ez_key: 'k', ez_name: 'K', menu_item_id: 'm-1', source: 'auto' }], [{ kind: 'item', ezKey: 'k', seenCount: 2 }], NOW);
    assert.equal(typeof saved.inserted, 'number');
    assert.equal(typeof saved.bumped, 'number');
  }
});

test('saveLinkWrites drops a row with no key or no name before it reaches Postgres', async () => {
  const sb = fakeSb(TABLES());
  const out = await saveLinkWrites(sb, 'loc-1', [
    { location_id: 'loc-1', kind: 'item', ez_key: '', ez_name: 'Nameless', menu_item_id: 'm-1', source: 'auto' },
    { location_id: 'loc-1', kind: 'item', ez_key: 'k', ez_name: '', menu_item_id: 'm-1', source: 'auto' },
  ], [], NOW);
  assert.equal(out.inserted, 0);
  assert.equal(sb.calls.length, 0);
});

test('a menu bigger than one PostgREST page is read whole', async () => {
  const big = [];
  for (let i = 0; i < MENU_PAGE_SIZE + 5; i++) big.push({ id: 'm-' + i, name: 'Dish Number ' + i, pricing: { base: 1 }, location_id: 'loc-1' });
  const sb = fakeSb({ menu_items: big, modifier_groups: [], ezcater_item_links: [] });
  const inputs = await readMatchInputs(sb, 'loc-1');
  assert.equal(inputs.ourItems.length, MENU_PAGE_SIZE + 5);
  assert.equal(inputs.menuOk, true, 'read whole means whole');
});

test('A PARTLY READ MENU IS NOT A MENU: menuOk goes false, and nothing is written', async () => {
  // Cut short at MENU_MAX_PAGES with a full page still in hand. What we hold is
  // a piece of the menu, and "nothing of ours has that name" is a claim about
  // the piece we never saw.
  const huge = [];
  for (let i = 0; i < MENU_PAGE_SIZE * MENU_MAX_PAGES + 1; i++) {
    huge.push({ id: 'm-' + i, name: 'Dish Number ' + i, pricing: { base: 1 }, location_id: 'loc-1' });
  }
  const cut = await readMatchInputs(fakeSb({ menu_items: huge, modifier_groups: [], ezcater_item_links: [] }), 'loc-1');
  assert.equal(cut.menuOk, false, 'a truncated read must not read as the whole menu');

  // The modifier groups failing counts too: options are half the matching.
  const groupsDown = await readMatchInputs(
    fakeSb(TABLES(), { fail: { modifier_groups: { message: 'timeout' } } }), 'loc-1',
  );
  assert.equal(groupsDown.menuOk, false);
  assert.ok(groupsDown.ourItems.length > 0, 'the items we did read are still returned');

  // End to end: a half read menu writes NO link at all, and the order still goes.
  const sb = fakeSb(TABLES(), { fail: { modifier_groups: { message: 'timeout' } } });
  const out = await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Caesar Salad' })]), { nowIso: NOW });
  assert.equal(out.ran, true);
  assert.equal(out.inserted, 0, 'a wrong auto link outlives the order that wrote it');
  assert.deepEqual(sb.store.ezcater_item_links, []);
  assert.equal(out.row.items[0].itemId, null, 'saved links only, and there are none');
});

test('the sighting fill updates in place, and only while nobody has answered it', async () => {
  const bare = {
    location_id: 'loc-1', kind: 'item', ez_key: 'brownie', ez_name: 'Brownie Tray',
    menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 3,
  };
  const sb = fakeSb({ ...TABLES(), ezcater_item_links: [{ ...bare }] });
  await matchQueueRow(sb, 'loc-1', orderRow([line({ name: 'Brownie Tray' })]), { nowIso: NOW });
  const row = sb.store.ezcater_item_links[0];
  assert.equal(sb.store.ezcater_item_links.length, 1, 'updated in place, never duplicated');
  assert.equal(row.menu_item_id, 'm-brownie');
  assert.equal(row.matched_by, 'name');
  assert.equal(row.seen_count, 4, 'and it is still counted as seen');

  // A person answered it a moment ago. The where clause refuses the update.
  const answered = { ...bare, source: 'manual', menu_item_id: 'm-cola', matched_by: 'user-1' };
  const sb2 = fakeSb({ ...TABLES(), ezcater_item_links: [{ ...answered }] });
  await matchQueueRow(sb2, 'loc-1', orderRow([line({ name: 'Brownie Tray' })]), { nowIso: NOW });
  assert.equal(sb2.store.ezcater_item_links[0].menu_item_id, 'm-cola', "a person's answer is never overruled");
  assert.equal(sb2.store.ezcater_item_links[0].matched_by, 'user-1');
});

test('THE ORDER ALWAYS WINS: a read that never comes back cannot delay it', async () => {
  const sb = fakeSb(TABLES(), { hang: true });
  const row = orderRow([line({ name: 'Caesar Salad' })]);
  const began = Date.now();
  const out = await matchQueueRow(sb, 'loc-1', row, { nowIso: NOW, budgetMs: 25 });
  const took = Date.now() - began;
  assert.equal(out.ran, false);
  assert.equal(out.row, row, 'the mapper row goes to the kitchen, unchanged');
  assert.equal(out.row.customer.ezMatch, undefined);
  assert.ok(took < 2000, 'it waited ' + took + 'ms, which an order cannot afford');
  assert.ok(MATCH_BUDGET_MS > 0 && MATCH_BUDGET_MS <= 10000, 'the default budget has to be a real one');
});

// ════════════════════════════════════════════════════════════════════════════
//  6. Source checks. The guards have to still BE there.
// ════════════════════════════════════════════════════════════════════════════

const read = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const WEBHOOK = read('supabase/functions/ezcater-webhook/index.ts');
// 18 Sep 2026: the match and the write moved from the webhook into _shared/ezcaterIngest.ts
// (writeEzcaterOrder), shared by the webhook, the pre fire check and staff re-sync. The rules
// pinned below are the same; they are pinned where the code now lives.
const WRITE = read('supabase/functions/_shared/ezcaterIngest.ts');
const INGEST = read('supabase/functions/_shared/ezcater-match-ingest.ts');

test('the webhook calls the matcher, inside a try, before the order_queue upsert', () => {
  assert.ok(WRITE.includes("from './ezcater-match-ingest.ts'"));
  assert.ok(WEBHOOK.includes('await writeEzcaterOrder(sb, {'));
  const call = WRITE.indexOf('await matchQueueRow(');
  const insert = WRITE.indexOf(".from('order_queue').insert(");
  // Review round 3: every update of an existing row is the guarded update (updated_at and
  // kitchen_routed_at conditions), called from the write loop after matching.
  const update = WRITE.indexOf('await guardedUpdate(sb, locationId, row.ref, existing, payload');
  assert.ok(call > 0, 'the matcher is never called');
  assert.ok(insert > call && update > call, 'matching must happen before the row is written');

  // The call sits inside a try whose catch falls back to the mapper's own row.
  const before = WRITE.slice(0, call);
  const tryAt = before.lastIndexOf('try {');
  assert.ok(tryAt > 0);
  const after = WRITE.slice(call);
  const catchAt = after.indexOf('} catch');
  assert.ok(catchAt > 0);
  assert.ok(/queueRow = row;/.test(after.slice(catchAt, catchAt + 400)), 'the catch must fall back to the unmatched row');
});

test('the upsert writes the matched row, and the status logic is untouched', () => {
  // 18 Sep 2026: the status and timing rules for an existing row moved into the pure
  // _shared/ezcaterCatering.js (ezcaterWritePlan, unit tested in cateringRules.test.js). The
  // matched row still goes in, and the rule a cancellation always wins is unchanged there.
  assert.ok(WRITE.includes("let planned = queueRow;"), 'the matched row is what reaches order_queue');
  assert.ok(WRITE.includes('ezcaterWritePlan({ row: planned, existing, terminal, nowIso })'));
  assert.ok(WRITE.includes('queuePayload(plan.row, !existing, nowIso, { reschedule: plan.reschedule })'));
  const PLAN = fs.readFileSync(new URL('../../supabase/functions/_shared/ezcaterCatering.js', import.meta.url), 'utf8');
  assert.ok(PLAN.includes("if (terminal) status = 'cancelled';"), 'a cancellation still always wins');
  assert.ok(WRITE.includes('let queueRow = row;'), 'the fallback value is the mapper row itself');
});

test('the webhook still answers ezCater the same way it did', () => {
  // 401 for a bad signature only, 503 for transient, 200 for everything else:
  // a 4xx may be read as a permanent rejection and lose the notification.
  assert.equal((WEBHOOK.match(/status: 401/g) || []).length, 1);
  assert.ok(WEBHOOK.includes("const retry = (why: string) => new Response(why, { status: 503, headers: cors });"));
  assert.ok(!/status: 4(0[02-9]|[1-9]\d)/.test(WEBHOOK), 'no new 4xx may appear on this path');
});

test('every impure export in the ingest module is wrapped', () => {
  for (const fn of ['readMatchInputs', 'saveLinkWrites', 'matchQueueRow']) {
    const at = INGEST.indexOf('export async function ' + fn);
    assert.ok(at > 0, fn + ' is missing');
    // To the next export, or the end of the file. A fixed window would go green
    // or red on how long the function happens to be.
    const rest = INGEST.slice(at + 10);
    const next = rest.indexOf('\nexport ');
    const body = next === -1 ? rest : rest.slice(0, next);
    assert.ok(body.includes('try {'), fn + ' has no try');
    assert.ok(body.includes('} catch'), fn + ' has no catch');
  }
  // The fallback is the whole promise of this file, so it is named in the code.
  assert.ok(INGEST.includes('return bailed;'));
  assert.ok(/NO ORDER IS EVER REFUSED/.test(INGEST));
});

test('the webhook puts a clock on matching, and the order is what it protects', () => {
  assert.ok(WRITE.includes('budgetMs: args.match?.budgetMs ?? MATCH_BUDGET_MS'), 'the call has no budget on it');
  assert.ok(INGEST.includes('export const MATCH_BUDGET_MS'));
  // The budget is checked between reads AND raced, because a hung read never
  // resolves and a deadline alone would wait for it forever.
  assert.ok(INGEST.includes('Promise.race('));
  assert.ok(INGEST.includes('clearTimeout('), 'a timer left running holds the isolate open');
});

test('no em dash or en dash anywhere in the files this change owns', () => {
  for (const [name, src] of [['webhook', WEBHOOK], ['ingest', INGEST], ['write', WRITE], ['map', read('supabase/functions/_shared/ezcater-map.ts')]]) {
    assert.equal(/[–—]/.test(src), false, name + ' has a dash');
  }
});

test('no dynamic import anywhere in the files this change owns', () => {
  for (const [name, src] of [['webhook', WEBHOOK], ['ingest', INGEST], ['write', WRITE]]) {
    assert.equal(/\bimport\s*\(/.test(src), false, name + ' has a dynamic import');
  }
});
