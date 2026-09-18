/**
 * ezcaterMenuPaste.test.js
 *
 * Load the caterer's whole ezCater menu BEFORE any order (Peter, 18 Sep 2026:
 * "we cant have it that we match products after an order has been placed").
 *
 *   src/lib/ezcaterMenuPaste.js                      parse, entries, preview
 *   supabase/functions/_shared/ezcater-match-ingest.ts planPastedMenu (the save)
 *   src/lib/ezcaterMenuExport.js                     "Copy our menu for ezCater"
 *   ezLineName / ourSizeName in both ezcaterMatch mirrors
 *
 * What is pinned, in Peter's order:
 *   1. a realistic pasted menu (items, sizes, options) parses correctly
 *   2. exact names auto link, a size clash does not, an ambiguous name suggests
 *   3. pasting the same menu twice writes nothing the second time
 *   4. a later REAL order lands on the pasted row and makes no second one
 *   5. the export lists our items, sizes and prices
 *
 * Run: `npm test`, or `node --test src/lib/ezcaterMenuPaste.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEzcaterMenu, parsedCounts, pasteEntries, pasteBody, previewPaste, previewLine,
  takePrice, takeServes, splitRow, PASTE_MAX_ENTRIES,
} from './ezcaterMenuPaste.js';
import { ezLineName, ourSizeName, buildLinkKey, legacyLinkKey } from './ezcaterMatch.js';
import * as tsMatch from '../../supabase/functions/_shared/ezcaterMatch.ts';
import { ourItemsFrom, ourGroupsFrom, toRow, rowsFrom } from './ezcaterItemRows.js';
import { ourMenuRows, ourOptionRows, ourMenuText, MENU_EXPORT_HEADER } from './ezcaterMenuExport.js';
import {
  planPastedMenu, planLineMatches, menuItemsForMatch, modifierGroupsForMatch, MAX_PASTE_ENTRIES,
} from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
import { orderItemsToLines } from '../../supabase/functions/_shared/ezcater-map.ts';

const NOW = '2026-09-18T10:00:00.000Z';
const LOC = 'loc-ez-1';

// ── A menu as a caterer copies it off their ezCater menu page ───────────────
// Select all, copy: the page chrome, categories, items with descriptions,
// sizes with "Serves" and a price, option groups flagged Required/Optional,
// "+$" on the choices that cost extra, "Add to Cart" buttons.
const PASTED = `Peninsula Kitchen
4.8 (212)
Menu

Salads

Caesar Salad
Crisp romaine, shaved parmesan, garlic croutons and our house caesar dressing.
Half Tray (Serves 8-10)
$65.00
Full Tray (Serves 18-20)
$120.00
Choose a Protein (Optional)
Grilled Chicken
+$15.00
Salmon
+$25.00
No Protein
Dressing on the Side (Required)
Yes
No

Greek Salad
Tomato, cucumber, red onion, kalamata olives and feta.
$55.00
Serves 10
Add to Cart

Sandwiches

Boxed Lunch
Individually packaged sandwich, chips and a cookie.
$14.95 /person
Choose Your Sandwich (Choose 1)
Turkey Club
Ham and Swiss
Veggie Wrap
Choose a Side
Kettle Chips
Fruit Cup
+$1.50

Margherita Pizza
12" Pizza  $16.75
16" Pizza  $24.75

Desserts

Chocolate Chip Cookies
$24.00
Brownie Tray
$30.00
`;

// ── Our own menu, as the tables hold it ─────────────────────────────────────
// Caesar Salad has SIZES on our side: two rows under it named just "Half Tray"
// and "Full Tray". Pizza is ONE product of ours (no sizes). "Chocolate Chip
// Cookies" exists twice (a Cookies and a Catering menu copy), so it is ambiguous.
const OUR_ITEM_ROWS = [
  { id: 'm-caesar', name: 'Caesar Salad', type: 'variants', pricing: { base: 0 }, cat: 'c-salads', item_code: 'CAESAR' },
  { id: 'm-caesar-half', name: 'Half Tray', parent_id: 'm-caesar', pricing: { base: 65 }, sort_order: 0, cat: 'c-salads', item_code: 'CAESARHALF' },
  { id: 'm-caesar-full', name: 'Full Tray', parent_id: 'm-caesar', pricing: { base: 120 }, sort_order: 1, cat: 'c-salads', item_code: null },
  { id: 'm-greek', name: 'Greek Salad', pricing: { base: 55 }, cat: 'c-salads' },
  { id: 'm-boxed', name: 'Boxed Lunch', pricing: { base: 14.95 }, cat: 'c-sand' },
  { id: 'm-pizza', name: 'Margherita Pizza', pricing: { base: 18 }, cat: 'c-sand' },
  { id: 'm-cookie-a', name: 'Chocolate Chip Cookies', pricing: { base: 24 }, cat: 'c-dess' },
  { id: 'm-cookie-b', name: 'Chocolate Chip Cookies', pricing: { base: 26 }, cat: 'c-dess' },
  { id: 'm-large-lemonade', name: 'Lemonade Large', pricing: { base: 5 } },
  { id: 'm-gone', name: 'Old Wrap', pricing: { base: 9 }, archived: true },
  { id: 'm-optonly', name: 'Extra Croutons', type: 'subitem', sold_alone: false, pricing: { base: 1 } },
];
const OUR_GROUP_ROWS = [
  {
    id: 'g-protein', name: 'Add a Protein',
    options: [
      { id: 'o-chicken', name: 'Grilled Chicken', price: 15 },
      { id: 'o-salmon', name: 'Salmon', price: 25 },
    ],
  },
  {
    id: 'g-sides', name: 'Side',
    options: [
      { id: 'o-chips', name: 'Kettle Chips', price: 0 },
      { id: 'o-fruit', name: 'Fruit Cup', price: 1.5 },
    ],
  },
];
const OUR_CATS = [
  { id: 'c-salads', label: 'Salads' },
  { id: 'c-sand', label: 'Sandwiches' },
  { id: 'c-dess', label: 'Desserts' },
];

const ourItems = ourItemsFrom(OUR_ITEM_ROWS);
const ourGroups = ourGroupsFrom(OUR_GROUP_ROWS);

const itemsOf = (parsed) => Object.fromEntries(parsed.items.map((it) => [it.name, it]));

// ── 1. parsing ──────────────────────────────────────────────────────────────

test('a pasted ezCater menu page: categories, items, sizes, prices, serves', () => {
  const parsed = parseEzcaterMenu(PASTED);
  assert.equal(parsed.format, 'text');
  const by = itemsOf(parsed);
  assert.deepEqual(Object.keys(by).sort(), [
    'Boxed Lunch', 'Brownie Tray', 'Caesar Salad', 'Chocolate Chip Cookies', 'Greek Salad', 'Margherita Pizza',
  ]);

  const caesar = by['Caesar Salad'];
  assert.equal(caesar.category, 'Salads');
  assert.match(caesar.description, /^Crisp romaine/);
  assert.deepEqual(caesar.sizes, [
    { name: 'Half Tray', price: 65, serves: '8-10' },
    { name: 'Full Tray', price: 120, serves: '18-20' },
  ]);

  assert.equal(by['Greek Salad'].category, 'Salads');
  assert.equal(by['Greek Salad'].price, 55);
  assert.equal(by['Greek Salad'].serves, '10');
  assert.equal(by['Greek Salad'].sizes.length, 0);

  assert.equal(by['Boxed Lunch'].category, 'Sandwiches');
  assert.equal(by['Boxed Lunch'].price, 14.95);
  assert.deepEqual(by['Margherita Pizza'].sizes.map((s) => [s.name, s.price]), [['12" Pizza', 16.75], ['16" Pizza', 24.75]]);
  assert.equal(by['Chocolate Chip Cookies'].category, 'Desserts');
  assert.equal(by['Brownie Tray'].price, 30);

  // The page chrome is never an item.
  for (const junk of ['Peninsula Kitchen', 'Menu', 'Add to Cart', '4.8 (212)']) assert.equal(by[junk], undefined, junk);
  assert.deepEqual(parsedCounts(parsed), { items: 6, sizes: 4, options: 10 });
});

test('a pasted menu: option groups, required, choose N, and extra cost choices', () => {
  const by = itemsOf(parseEzcaterMenu(PASTED));
  const [protein, dressing] = by['Caesar Salad'].groups;
  assert.equal(protein.name, 'Choose a Protein');
  assert.equal(protein.required, false);
  assert.deepEqual(protein.choices, [
    { name: 'Grilled Chicken', price: 15 },
    { name: 'Salmon', price: 25 },
    { name: 'No Protein', price: null },
  ]);
  assert.equal(dressing.name, 'Dressing on the Side');
  assert.equal(dressing.required, true);
  assert.deepEqual(dressing.choices.map((c) => c.name), ['Yes', 'No']);

  const [sandwich, side] = by['Boxed Lunch'].groups;
  assert.equal(sandwich.name, 'Choose Your Sandwich');
  assert.deepEqual([sandwich.required, sandwich.min, sandwich.max], [true, 1, 1]);
  assert.deepEqual(sandwich.choices.map((c) => c.name), ['Turkey Club', 'Ham and Swiss', 'Veggie Wrap']);
  assert.deepEqual(side.choices, [{ name: 'Kettle Chips', price: null }, { name: 'Fruit Cup', price: 1.5 }]);

  // An item with no groups has none, and a category heading is never a choice.
  assert.equal(by['Greek Salad'].groups.length, 0);
  for (const g of by['Caesar Salad'].groups) assert.ok(!g.choices.some((c) => c.name === 'Greek Salad'));
});

test('a short description line under an item name is not a second item', () => {
  const by = itemsOf(parseEzcaterMenu('Cookies\n\nBrownie Bites\nFudgy and rich\n$18.00\nLemon Bars\n$20.00\n'));
  assert.deepEqual(Object.keys(by).sort(), ['Brownie Bites', 'Lemon Bars']);
  assert.equal(by['Brownie Bites'].description, 'Fudgy and rich');
  assert.equal(by['Brownie Bites'].price, 18);
});

test('one line per item with the price on it, the way cells paste without a header', () => {
  const by = itemsOf(parseEzcaterMenu('Coffee Box\t$28.00\nAssorted Pastries\t36.00\n'));
  assert.equal(by['Coffee Box'].price, 28);
  assert.equal(by['Assorted Pastries'].price, 36);
});

test('a spreadsheet or CSV with a header row: sizes, prices and options by column', () => {
  const csv = [
    'Category,Item Name,Size,Price,Option Group,Option Name',
    'Salads,Caesar Salad,Half Tray,65.00,,',
    'Salads,Caesar Salad,Full Tray,"$1,120.00",,',
    'Salads,Caesar Salad,,,Choose a Protein,Grilled Chicken',
    ',,,,Choose a Protein,Salmon',
    'Sandwiches,"Boxed Lunch, Classic",,14.95,,',
  ].join('\r\n');
  const parsed = parseEzcaterMenu('\ufeff' + csv);
  assert.equal(parsed.format, 'table');
  const by = itemsOf(parsed);
  assert.deepEqual(by['Caesar Salad'].sizes.map((s) => [s.name, s.price]), [['Half Tray', 65], ['Full Tray', 1120]]);
  assert.deepEqual(by['Caesar Salad'].groups[0].choices.map((c) => c.name), ['Grilled Chicken', 'Salmon']);
  assert.equal(by['Boxed Lunch, Classic'].price, 14.95);
  assert.equal(by['Boxed Lunch, Classic'].category, 'Sandwiches');

  // Tab separated, as cells copied out of a spreadsheet.
  const tsv = parseEzcaterMenu('Item\tSize\tPrice\nGreek Salad\t\t55\nMargherita Pizza\t12" Pizza\t16.75\n');
  assert.equal(tsv.format, 'table');
  assert.equal(itemsOf(tsv)['Greek Salad'].price, 55);
  assert.deepEqual(itemsOf(tsv)['Margherita Pizza'].sizes.map((s) => s.name), ['12" Pizza']);
});

test('the small readers: prices, serves, quoted cells', () => {
  assert.deepEqual(takePrice('Half Tray $65.00'), { price: 65, plus: false, rest: 'Half Tray' });
  assert.deepEqual(takePrice('+$1.50'), { price: 1.5, plus: true, rest: '' });
  assert.equal(takePrice('$14.95 /person').rest, '');
  assert.equal(takePrice('\u00a312.50').price, 12.5);
  assert.equal(takePrice('12" Pizza'), null);
  assert.deepEqual(takeServes('Full Tray (Serves 18-20)'), { serves: '18-20', rest: 'Full Tray' });
  assert.deepEqual(takeServes('Serves 10'), { serves: '10', rest: '' });
  assert.deepEqual(splitRow('a,"b, c","say ""hi"""', ','), ['a', 'b, c', 'say "hi"']);
});

// ── entries: the names an order would carry ─────────────────────────────────

test('entries are one per SIZE and one per option, keyed exactly as an order line would be', () => {
  const entries = pasteEntries(parseEzcaterMenu(PASTED));
  const items = entries.filter((e) => e.kind === 'item').map((e) => e.ez_name);
  assert.deepEqual(items, [
    'Caesar Salad, Half Tray', 'Caesar Salad, Full Tray', 'Greek Salad', 'Boxed Lunch',
    'Margherita Pizza, 12" Pizza', 'Margherita Pizza, 16" Pizza', 'Chocolate Chip Cookies', 'Brownie Tray',
  ]);
  const half = entries.find((e) => e.ez_name === 'Caesar Salad, Half Tray');
  assert.equal(half.ez_key, 'caesar salad half');
  const salmon = entries.find((e) => e.kind === 'option' && e.ez_name === 'Salmon');
  assert.equal(salmon.ez_group, 'Choose a Protein');
  assert.equal(salmon.ez_key, 'choose a protein|salmon');
  // Nothing twice, even when the same name is pasted twice in one go.
  const twice = pasteEntries(parseEzcaterMenu(PASTED + '\n' + PASTED));
  assert.equal(twice.length, entries.length);
  // The body is names only, capped.
  const body = pasteBody(entries);
  assert.deepEqual(Object.keys(body.entries[0]).sort(), ['ez_group', 'ez_name', 'kind']);
  assert.equal(MAX_PASTE_ENTRIES, PASTE_MAX_ENTRIES);
});

test('ezLineName joins a size that says something, and only then', () => {
  assert.equal(ezLineName('Caesar Salad', 'Half Tray'), 'Caesar Salad, Half Tray');
  assert.equal(ezLineName('Caesar Salad', ''), 'Caesar Salad');
  assert.equal(ezLineName('Caesar Salad', null), 'Caesar Salad');
  assert.equal(ezLineName('Chocolate Cake', '1'), 'Chocolate Cake');            // ezCater's own placeholder
  assert.equal(ezLineName('Cookie', 'Each'), 'Cookie');
  assert.equal(ezLineName('Veggie Platter', 'Serves 10'), 'Veggie Platter');   // noise only
  assert.equal(ezLineName('Chicken Caesar Boxed Lunch', 'Boxed lunch'), 'Chicken Caesar Boxed Lunch');
  assert.equal(ourSizeName('Caesar Salad', 'Large'), 'Caesar Salad, Large');
  assert.equal(ourSizeName('Caesar Salad', 'Caesar Salad Large'), 'Caesar Salad Large');
  // Both mirrors, every case.
  for (const [a, b] of [['Caesar Salad', 'Half Tray'], ['Cake', '1'], ['X', ''], ['Pizza', '12" Pizza'], ['', 'Large']]) {
    assert.equal(tsMatch.ezLineName(a, b), ezLineName(a, b));
    assert.equal(tsMatch.ourSizeName(a, b), ourSizeName(a, b));
  }
});

test('an earlier match saved under the name alone is still found for a sized line', () => {
  // Before 18 Sep an order line's size was not part of its key.
  const line = { name: 'Caesar Salad', sizeName: 'Half Tray' };
  assert.equal(buildLinkKey(line, 'item'), 'caesar salad half');
  assert.equal(legacyLinkKey(line, 'item'), 'caesar salad');
});

// ── 2. auto match: exact links, size clash does not, ambiguous suggests ─────

test('our sizes are matched as "product, size", so their sizes find ours', () => {
  const half = ourItems.find((i) => i.id === 'm-caesar-half');
  assert.equal(half.name, 'Caesar Salad, Half Tray');
  // Archived and option only products never come back as something to match to.
  assert.equal(ourItems.find((i) => i.id === 'm-gone'), undefined);
  // The webhook reads our menu the same way.
  const server = menuItemsForMatch(OUR_ITEM_ROWS);
  assert.equal(server.find((i) => i.id === 'm-caesar-half').name, 'Caesar Salad, Half Tray');
});

test('the preview: exact names link, a size clash does not, ambiguous names suggest', () => {
  const entries = pasteEntries(parseEzcaterMenu(PASTED + '\nDrinks\n\nLemonade\nSmall\n$3.00\n'));
  const { rows, counts } = previewPaste(entries, ourItems, ourGroups, []);
  const st = Object.fromEntries(rows.map((r) => [r.kind + ':' + r.ezName, r]));

  // One exact name of ours.
  assert.equal(st['item:Greek Salad'].status, 'matched');
  assert.equal(st['item:Greek Salad'].target, 'Greek Salad');
  assert.equal(st['item:Boxed Lunch'].status, 'matched');
  assert.equal(st['option:Salmon'].status, 'matched');
  assert.equal(st['option:Kettle Chips'].status, 'matched');

  // Their "Caesar Salad, Half Tray" is three exact names on our side (the
  // product and both sizes), so a person picks. The right one is on top of the
  // suggestions; the rules never guess.
  assert.equal(st['item:Caesar Salad, Half Tray'].status, 'decide');

  // Their Small against our only Lemonade, which is Large: a size clash, never linked.
  assert.equal(st['item:Lemonade, Small'].status, 'decide');

  // Two of ours with the same name.
  assert.equal(st['item:Chocolate Chip Cookies'].status, 'decide');

  // Nothing like it on our menu.
  assert.equal(st['item:Brownie Tray'].status, 'none');
  assert.equal(st['option:Veggie Wrap'].status, 'none');

  assert.equal(counts.total, rows.length);
  assert.equal(counts.matched + counts.decide + counts.none + counts.ignored, counts.total);
  assert.match(previewLine(counts), /matched, .* need a decision, .* not on our menu\./);
});

test('the save plan links exactly what the preview promised, and writes new rows as never ordered', () => {
  const entries = pasteEntries(parseEzcaterMenu(PASTED));
  const plan = planPastedMenu({
    entries: pasteBody(entries).entries,
    ourItems: menuItemsForMatch(OUR_ITEM_ROWS),
    ourGroups: modifierGroupsForMatch(OUR_GROUP_ROWS),
    links: [], locationId: LOC, nowIso: NOW,
  });
  const preview = previewPaste(entries, ourItems, ourGroups, []);
  assert.equal(plan.counts.matched, preview.counts.matched);
  assert.equal(plan.counts.decide, preview.counts.decide);
  assert.equal(plan.counts.none, preview.counts.none);
  assert.equal(plan.writes.length, entries.length);
  assert.equal(plan.upgrades.length, 0);

  const greek = plan.writes.find((w) => w.ez_key === 'greek salad');
  assert.deepEqual(
    [greek.menu_item_id, greek.source, greek.matched_by, greek.seen_count, greek.last_seen_at],
    ['m-greek', 'auto', 'pasted', 0, null],
  );
  const half = plan.writes.find((w) => w.ez_key === 'caesar salad half');
  assert.deepEqual([half.menu_item_id, half.matched_by, half.ez_name], [null, null, 'Caesar Salad, Half Tray']);
  const salmon = plan.writes.find((w) => w.kind === 'option' && w.ez_key === 'choose a protein|salmon');
  assert.deepEqual([salmon.option_id, salmon.ez_group], ['o-salmon', 'Choose a Protein']);

  // Every row satisfies the table's checks exactly as 20260917 wrote them.
  for (const w of plan.writes) {
    assert.ok(w.ez_key.trim() && w.ez_name.trim());
    assert.ok(['auto', 'manual'].includes(w.source));
    if (w.kind === 'item') assert.equal(w.option_id, null);
    assert.equal(w.location_id, LOC);
  }
  // And the screen reads them back as "not on an order yet".
  const rows = rowsFrom(plan.writes);
  assert.ok(rows.every((r) => r.seenCount === 0));
  assert.equal(toRow(greek).state, 'matched');
  assert.equal(toRow(half).state, 'unmatched');
});

test('a partly read menu writes the names but links nothing', () => {
  const plan = planPastedMenu({
    entries: pasteBody(pasteEntries(parseEzcaterMenu(PASTED))).entries,
    ourItems: menuItemsForMatch(OUR_ITEM_ROWS), ourGroups: modifierGroupsForMatch(OUR_GROUP_ROWS),
    links: [], locationId: LOC, nowIso: NOW, menuOk: false,
  });
  assert.ok(plan.writes.length > 0);
  assert.ok(plan.writes.every((w) => !w.menu_item_id && !w.option_id && w.matched_by === null));
});

// ── 3. pasting twice ────────────────────────────────────────────────────────

test('pasting the same menu twice adds nothing and changes no decision', () => {
  const body = pasteBody(pasteEntries(parseEzcaterMenu(PASTED))).entries;
  const menu = { ourItems: menuItemsForMatch(OUR_ITEM_ROWS), ourGroups: modifierGroupsForMatch(OUR_GROUP_ROWS) };
  const first = planPastedMenu({ entries: body, ...menu, links: [], locationId: LOC, nowIso: NOW });

  // A person then matches the Half Tray by hand, and says Brownie Tray is not ours.
  const table = first.writes.map((w) => ({ ...w }));
  const half = table.find((w) => w.ez_key === 'caesar salad half');
  Object.assign(half, { menu_item_id: 'm-caesar-half', source: 'manual', matched_by: 'user-1' });
  const brownie = table.find((w) => w.ez_key === 'brownie');
  Object.assign(brownie, { source: 'manual', matched_by: 'ignored' });

  const second = planPastedMenu({ entries: body, ...menu, links: table, locationId: LOC, nowIso: NOW });
  assert.equal(second.writes.length, 0);
  assert.equal(second.upgrades.length, 0);
  assert.equal(second.counts.fresh, 0);
  assert.equal(second.counts.already, first.counts.total);

  // The screen's preview says the same thing before anyone presses Save.
  const again = previewPaste(pasteEntries(parseEzcaterMenu(PASTED)), ourItems, ourGroups, rowsFrom(table));
  assert.equal(again.counts.fresh, 0);
  assert.equal(again.counts.already, again.counts.total);
  const byKey = Object.fromEntries(again.rows.map((r) => [r.ezKey, r]));
  assert.equal(byKey['caesar salad half'].status, 'matched');
  assert.equal(byKey['caesar salad half'].target, 'Caesar Salad, Half Tray');
  assert.equal(byKey['brownie'].status, 'ignored');
});

test('a second paste fills in a bare row once our menu can answer it, and nothing else', () => {
  const body = pasteBody(pasteEntries(parseEzcaterMenu(PASTED))).entries;
  // First paste with no Brownie Tray on our menu.
  const first = planPastedMenu({ entries: body, ourItems: menuItemsForMatch(OUR_ITEM_ROWS), ourGroups: [], links: [], locationId: LOC, nowIso: NOW });
  assert.equal(first.writes.find((w) => w.ez_key === 'brownie').menu_item_id, null);
  // The venue adds it, and pastes again.
  const withBrownie = OUR_ITEM_ROWS.concat([{ id: 'm-brownie', name: 'Brownie Tray', pricing: { base: 30 } }]);
  const second = planPastedMenu({ entries: body, ourItems: menuItemsForMatch(withBrownie), ourGroups: [], links: first.writes, locationId: LOC, nowIso: NOW });
  assert.equal(second.writes.length, 0);
  assert.deepEqual(second.upgrades.filter((u) => u.kind === 'item'), [
    { kind: 'item', ezKey: 'brownie', menuItemId: 'm-brownie', optionId: null },
  ]);
});

// ── 4. a later real order lands on the pasted row ───────────────────────────

test('a real ezCater order lands on the pasted rows: no second row, the size kept apart', () => {
  const menu = { ourItems: menuItemsForMatch(OUR_ITEM_ROWS), ourGroups: modifierGroupsForMatch(OUR_GROUP_ROWS) };
  const pasted = planPastedMenu({
    entries: pasteBody(pasteEntries(parseEzcaterMenu(PASTED))).entries, ...menu, links: [], locationId: LOC, nowIso: NOW,
  });
  // A person matched both Caesar sizes after pasting.
  const table = pasted.writes.map((w) => ({ ...w }));
  Object.assign(table.find((w) => w.ez_key === 'caesar salad half'), { menu_item_id: 'm-caesar-half', source: 'manual', matched_by: 'user-1' });
  Object.assign(table.find((w) => w.ez_key === 'caesar salad full'), { menu_item_id: 'm-caesar-full', source: 'manual', matched_by: 'user-1' });

  const money = (n) => ({ subunits: n, subunitsV2: String(n), currency: 'USD' });
  const lines = orderItemsToLines([
    {
      uuid: 'oi-1', name: 'Caesar Salad', quantity: 1, menuItemSizeId: 'ez-v7-half', menuItemSizeName: 'Half Tray',
      posItemId: null, totalInSubunits: money(8000),
      customizations: [{ customizationId: 'c1', customizationTypeId: 't1', customizationTypeName: 'Choose a Protein', name: 'Grilled Chicken', posCustomizationId: null, quantity: 1 }],
    },
    { uuid: 'oi-2', name: 'Caesar Salad', quantity: 1, menuItemSizeId: 'ez-v7-full', menuItemSizeName: 'Full Tray', posItemId: null, totalInSubunits: money(12000), customizations: [] },
    { uuid: 'oi-3', name: 'Greek Salad', quantity: 2, menuItemSizeId: 'ez-v7-greek', menuItemSizeName: null, posItemId: null, totalInSubunits: money(11000), customizations: [] },
  ]);

  const plan = planLineMatches({ lines, ...menu, links: table, locationId: LOC, nowIso: NOW });
  // Nothing new: every name on the order was already on the list.
  assert.equal(plan.writes.length, 0);
  // The Half and the Full Tray went to their OWN products, not one of them to both.
  assert.deepEqual(plan.lines.map((l) => l.itemId), ['m-caesar-half', 'm-caesar-full', 'm-greek']);
  // The option matched off the pasted row too.
  assert.equal(plan.lines[0].mods[0].optionId, 'o-chicken');
  // And the pasted rows are the ones counted as seen on an order.
  const bumped = Object.fromEntries(plan.bumps.map((b) => [b.kind + ':' + b.ezKey, b.seenCount]));
  assert.deepEqual(bumped, {
    'item:caesar salad half': 1,
    'item:caesar salad full': 1,
    'item:greek salad': 1,
    'option:choose a protein|grilled chicken': 1,
  });
});

test('an order for a pasted name nobody matched yet lands on that row and can fill it in', () => {
  // Pasted before the venue had a Brownie Tray: a bare row, seen_count 0.
  const pasted = planPastedMenu({
    entries: [{ kind: 'item', ez_name: 'Brownie Tray', ez_group: null }],
    ourItems: menuItemsForMatch(OUR_ITEM_ROWS), ourGroups: [], links: [], locationId: LOC, nowIso: NOW,
  });
  assert.equal(pasted.writes[0].menu_item_id, null);
  const withBrownie = menuItemsForMatch(OUR_ITEM_ROWS.concat([{ id: 'm-brownie', name: 'Brownie Tray', pricing: { base: 30 } }]));
  const lines = [{ name: 'Brownie Tray', sizeName: null, qty: 1, mods: [] }];
  const plan = planLineMatches({ lines, ourItems: withBrownie, ourGroups: [], links: pasted.writes, locationId: LOC, nowIso: NOW });
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.bumps, [{ kind: 'item', ezKey: 'brownie', times: 1, seenCount: 1 }]);
  assert.deepEqual(plan.upgrades, [{ kind: 'item', ezKey: 'brownie', menuItemId: 'm-brownie', optionId: null }]);
  assert.equal(plan.lines[0].itemId, 'm-brownie');
});

// ── 5. the other direction: our menu for ezCater ────────────────────────────

test('Copy our menu for ezCater lists our items, sizes, prices and codes, then options', () => {
  const rows = ourMenuRows(OUR_ITEM_ROWS, OUR_CATS);
  assert.deepEqual(rows, [
    { category: 'Desserts', item: 'Chocolate Chip Cookies', size: '', price: 24, code: '' },
    { category: 'Desserts', item: 'Chocolate Chip Cookies', size: '', price: 26, code: '' },
    { category: 'Salads', item: 'Caesar Salad', size: 'Half Tray', price: 65, code: 'CAESARHALF' },
    { category: 'Salads', item: 'Caesar Salad', size: 'Full Tray', price: 120, code: '' },
    { category: 'Salads', item: 'Greek Salad', size: '', price: 55, code: '' },
    { category: 'Sandwiches', item: 'Boxed Lunch', size: '', price: 14.95, code: '' },
    { category: 'Sandwiches', item: 'Margherita Pizza', size: '', price: 18, code: '' },
    { category: '', item: 'Lemonade Large', size: '', price: 5, code: '' },
  ]);
  // Archived and option only products are not offered to ezCater.
  assert.ok(!rows.some((r) => r.item === 'Old Wrap' || r.item === 'Extra Croutons'));
  assert.deepEqual(ourOptionRows(OUR_GROUP_ROWS)[0], { group: 'Add a Protein', option: 'Grilled Chicken', price: 15 });

  const text = ourMenuText(OUR_ITEM_ROWS, OUR_CATS, OUR_GROUP_ROWS);
  const lines = text.split('\n');
  assert.equal(lines[0], MENU_EXPORT_HEADER.join('\t'));
  assert.equal(lines[3], 'Salads\tCaesar Salad\tHalf Tray\t65.00\tCAESARHALF');
  assert.ok(lines.includes(''));
  assert.ok(lines.includes('Option group\tOption name\tPrice'));
  assert.ok(lines.includes('Side\tKettle Chips\t'));
  assert.equal(ourMenuText([], [], []), '');

  // Pasted straight back into the matching box it reads as the same menu, and
  // every item on it matches itself: the round trip a caterer's menu team
  // would make when they use our names.
  const back = previewPaste(pasteEntries(parseEzcaterMenu(text)), ourItems, ourGroups, []);
  const caesarHalf = back.rows.find((r) => r.ezName === 'Caesar Salad, Half Tray');
  assert.ok(caesarHalf, 'the size came back as a size');
  assert.equal(back.rows.find((r) => r.ezName === 'Greek Salad').status, 'matched');
});
