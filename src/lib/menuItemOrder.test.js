// v5.11.111 (28 Oct 2026, Peter: "why is the order of products different on the kiosk to online
// ordering... the default should be the same"). The one rule (lib/menuItemOrder.js) and the wiring:
// every screen that lists a category's products sorts with it, and the two reads that feed the
// till and the kiosk break a tie by id the way online always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareMenuItems, itemPosition, sortMenuItems, UNPLACED } from './menuItemOrder.js';
import { kioskMenuSections } from './kioskMenu.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('position first: a dragged item sits where the venue put it, an unplaced one (999 or none) goes after', () => {
  assert.equal(itemPosition({ sort_order: 2 }), 2);
  assert.equal(itemPosition({ sortOrder: 0 }), 0);
  assert.equal(itemPosition({}), UNPLACED);
  assert.equal(itemPosition({ sort_order: null }), UNPLACED);
  assert.equal(itemPosition({ sort_order: 'x' }), UNPLACED);
  const ids = sortMenuItems([{ id: 'm-3', sort_order: 999 }, { id: 'm-2', sort_order: 1 }, { id: 'm-1' }, { id: 'm-0', sortOrder: 0 }]).map((i) => i.id);
  assert.deepEqual(ids, ['m-0', 'm-2', 'm-1', 'm-3']);
});

test('the Habitum case: 17 iced drinks all at 999 come out in creation order (the id), the same every time', () => {
  const made = Array.from({ length: 17 }, (_, i) => ({ id: `m-17925${String(10 + i).padStart(2, '0')}0000000`, sort_order: 999 }));
  const shuffled = [made[5], made[16], made[0], made[9], made[2], made[1], made[15], made[7], made[3], made[12], made[4], made[14], made[6], made[11], made[8], made[13], made[10]];
  assert.deepEqual(sortMenuItems(shuffled).map((i) => i.id), made.map((i) => i.id));
  assert.deepEqual(sortMenuItems(shuffled.slice().reverse()).map((i) => i.id), made.map((i) => i.id));
  assert.equal(compareMenuItems(made[0], made[0]), 0);
  // The new kiosk design's section builder follows the same rule.
  const items = shuffled.map((i) => ({ ...i, cat: 'iced', cats: null, parent_id: null, visibility: { kiosk: true }, allergens: [] }));
  const [section] = kioskMenuSections({ rootId: 'iced', visibleCategories: [{ id: 'iced', parent_id: null, sort_order: 0, label: 'Iced Drinks' }], items });
  assert.deepEqual(section.items.map((i) => i.id), made.map((i) => i.id));
});

const SURFACES = {
  'kiosk (current design) menu': ['../surfaces/KioskApp.jsx', /\.sort\(compareMenuItems\)/],
  'kiosk (new design) sections': ['./kioskMenu.js', /\.sort\(compareMenuItems\)/],
  'online and QR menu': ['../surfaces/online/OnlineSurface.jsx', /\}\)\.sort\(compareMenuItems\);/],
  'online and QR sheet sizes': ['../surfaces/online/OnlineItemSheet.jsx', /\.sort\(compareMenuItems\)/],
  'till grid and sizes': ['../surfaces/POSSurface.jsx', /\.sort\(compareMenuItems\)/],
  'bar grid': ['../surfaces/BarSurface.jsx', /\.sort\(compareMenuItems\)/],
  'menu builder': ['../backoffice/sections/MenuManager.jsx', /\.sort\(compareMenuItems\)/],
  'menu visualiser': ['../backoffice/sections/MenuVisualizer.jsx', /\.sort\(compareMenuItems\)/],
  'print menu': ['../backoffice/sections/PrintMenu.jsx', /\.sort\(compareMenuItems\)/],
  'menu boards': ['./menuBoardSections.js', /const bySort = compareMenuItems;/],
};

test('every screen that lists products imports and uses the one rule, and no product sort by position alone is left', () => {
  for (const [name, [file, use]] of Object.entries(SURFACES)) {
    const src = read(file);
    assert.match(src, /import \{ compareMenuItems \} from '[./]*(lib\/)?menuItemOrder(\.js)?';/, `${name} imports the rule`);
    assert.match(src, use, `${name} uses the rule`);
    assert.doesNotMatch(src, /sortOrder\s*\?\?\s*999\)\s*-\s*\(b\.sortOrder\s*\?\?\s*999\)/, `${name}: no product sort by position alone`);
  }
});

test('the till and kiosk reads break a tie by id, as the online read always did', () => {
  assert.match(read('./db.js'), /\.from\('menu_items'\)\s*\.select\('\*'\)\s*\.eq\('location_id', locationId\)\s*\.eq\('archived', false\)\s*\.order\('sort_order'\)\.order\('id'\)/);
  assert.match(read('../surfaces/KioskApp.jsx'), /from\('menu_items'\)\.select\('\*'\)\.eq\('location_id', locationId\)\.eq\('archived', false\)\.order\('sort_order'\)\.order\('id'\)/);
  assert.match(read('../surfaces/online/OnlineSurface.jsx'), /\.eq\('archived', false\)\.order\('sort_order'\)\.order\('id'\)/);
});
