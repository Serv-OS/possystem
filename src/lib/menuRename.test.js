// src/lib/menuRename.test.js
//
// 5.12.121. Peter, 27 Nov 2026 (building the Mozz menus): "how do i rename a menu?". A site's own
// menu had no rename anywhere in the site Back Office. These pin the Menu name box of the "Edit
// menu settings" panel: a rename saves (only the name, through the store's own save), a blank name
// is refused, and a name another menu at the site has is refused.
// What a rename does NOT do to the Multi site menu is pinned in msm/msmSiteMenuRename.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { menuNameProblem, renameMenu, cleanMenuName, menuNameKey, MENU_NAME_MAX } from './menuRename.js';
import { createMenuWriters } from './menuWriters.js';
import { columnsForMenuPatch } from './menuItemWrite.js';
import { readVenueMenu, menuPatchFromRead } from './venueMenuRead.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LOC = '5a0d0000-0000-4000-8000-00000000a001';             // a Mozz site
const T0 = '2026-11-27T10:00:00.000+00:00';
const MENUS = [
  { id: 'menu-main', name: 'In store', isDefault: true, isActive: true },
  { id: 'menu-cater', name: 'Catering', isActive: true },
  { id: 'menu-old', name: 'Summer 2025', isActive: false },
];

// The store, reduced to what a rename touches: its list, updateMenu as store/index.js has it,
// and the count of markBOChange calls (the Push to POS banner).
function site(db) {
  const state = { menus: [], menuCategories: [], menuItems: [] };
  const toasts = [];
  let marked = 0;
  const writers = createMenuWriters({
    getClient: () => db,
    resolveLocation: async () => LOC,
    getRow: (kind, id) => (kind === 'menus' ? state.menus.find((r) => r.id === id) : null),
    updateRow: (kind, id, fn) => { if (kind === 'menus') state.menus = state.menus.map((r) => (r.id === id ? fn(r) : r)); },
    reportSave: () => {},
    toast: (msg, type) => toasts.push({ msg, type }),
    wait: async () => {},
  });
  const updateMenu = (id, patch) => {
    const prev = state.menus.find((m) => m.id === id);
    state.menus = state.menus.map((m) => (m.id === id ? { ...m, ...patch } : m));
    const updated = state.menus.find((m) => m.id === id);
    return writers.menus.edit(id, patch, prev, updated);
  };
  return {
    state, toasts, updateMenu,
    markBOChange: () => { marked += 1; },
    marked: () => marked,
    async load() {
      const r = await readVenueMenu(db, LOC);
      assert.ok(r.ok, `read failed: ${r.failed}`);
      Object.assign(state, menuPatchFromRead(state, r, { locationId: LOC }));
    },
  };
}
const seed = () => ({
  menus: [
    { id: 'menu-main', location_id: LOC, name: 'In store', description: 'All day', is_default: true, is_active: true, sort_order: 0, schedule: null, priority: 0, scope: 'local', org_id: null, updated_at: T0 },
    { id: 'menu-cater', location_id: LOC, name: 'Catering', description: '', is_default: false, is_active: true, sort_order: 1, schedule: { days: [1, 2, 3, 4, 5], from: '09:00', to: '15:00' }, priority: 3, scope: 'local', org_id: null, updated_at: T0 },
  ],
  menu_categories: [], menu_items: [], modifier_groups: [], tax_rates: [], tax_profiles: [], tax_profile_lines: [],
  locations: [{ id: LOC, default_tax_profile_id: null }],
});

test('a blank name is refused, in words', () => {
  for (const blank of ['', '   ', '\t', null, undefined]) {
    assert.match(menuNameProblem(MENUS, 'menu-cater', blank), /cannot have a blank name/, JSON.stringify(blank));
  }
  let saves = 0;
  const out = renameMenu(MENUS, 'menu-cater', '   ', { updateMenu: () => { saves += 1; }, markBOChange: () => { saves += 1; } });
  assert.equal(out.ok, false);
  assert.match(out.words, /Give the menu a name/);
  assert.equal(saves, 0, 'nothing is saved and nothing is marked for the POS');
});

test('a name another menu at this site has is refused: trimmed, any letter case, any spacing', () => {
  for (const dup of ['Catering', 'catering', '  CATERING ', 'In  Store', 'in store', 'summer 2025']) {
    const id = menuNameKey(dup) === 'catering' ? 'menu-main' : 'menu-cater';
    assert.match(menuNameProblem(MENUS, id, dup), /This site already has a menu called "/, dup);
  }
  assert.match(menuNameProblem(MENUS, 'menu-main', ' catering'), /called "Catering"\. Pick another name\./, 'it names the menu that has it');
  assert.match(menuNameProblem(MENUS, 'menu-main', 'Summer 2025'), /already has a menu/, 'a switched off menu is still in the list, so its name is taken');
  let saves = 0;
  const out = renameMenu(MENUS, 'menu-main', 'CATERING', { updateMenu: () => { saves += 1; }, markBOChange: () => { saves += 1; } });
  assert.equal(out.ok, false);
  assert.equal(saves, 0);
  // Its own name is never "taken": a change of letter case or spacing is a rename like any other.
  assert.equal(menuNameProblem(MENUS, 'menu-cater', 'CATERING'), '');
  assert.equal(menuNameProblem(MENUS, 'menu-cater', 'Catering'), '');
  assert.equal(menuNameProblem(MENUS, 'menu-cater', 'Events'), '');
  assert.equal(menuNameProblem([], 'menu-cater', 'Events'), '');
});

test('a name is 60 letters at most, the Multi site menu\'s own limit, and is saved trimmed', () => {
  assert.equal(MENU_NAME_MAX, 60);
  assert.equal(menuNameProblem(MENUS, 'menu-cater', 'x'.repeat(60)), '');
  assert.match(menuNameProblem(MENUS, 'menu-cater', 'x'.repeat(61)), /60 letters at most\. This one is 61\./);
  assert.equal(cleanMenuName('  Mozz   Catering '), 'Mozz Catering');
  // The same limit the group menu keeps for its menus, so a site's menu can always be found and added.
  assert.match(read('../../supabase/functions/_shared/msmMenus.js'), /export const EXTRA_MENU_NAME_MAX = 60;/);
});

test('a rename saves through updateMenu(id, { name }) and marks the Back Office change', () => {
  const calls = [];
  let marked = 0;
  const out = renameMenu(MENUS, 'menu-cater', '  Events  ', { updateMenu: (id, patch) => { calls.push([id, patch]); return 'saved'; }, markBOChange: () => { marked += 1; } });
  assert.deepEqual(calls, [['menu-cater', { name: 'Events' }]], 'only the name, trimmed');
  assert.equal(marked, 1);
  assert.deepEqual([out.ok, out.name, out.changed, out.was, out.saved], [true, 'Events', true, 'Catering', 'saved']);
  // The name it already has: nothing is written, nothing is marked.
  calls.length = 0; marked = 0;
  const same = renameMenu(MENUS, 'menu-cater', ' Catering ', { updateMenu: (id, patch) => calls.push([id, patch]), markBOChange: () => { marked += 1; } });
  assert.deepEqual([same.ok, same.changed, calls.length, marked], [true, false, 0, 0]);
  // A menu that is gone (deleted in another window) is said, never saved.
  const gone = renameMenu(MENUS, 'menu-nope', 'Events', { updateMenu: () => calls.push('x') });
  assert.equal(gone.ok, false);
  assert.match(gone.words, /not at this site any more/);
  assert.equal(calls.length, 0);
});

test('in the database a rename writes the name column and nothing else', async () => {
  const db = fakeMenuDb(seed(), { trigger: true });
  const s = site(db);
  await s.load();
  const before = { ...db.row('menus', 'menu-cater') };
  const out = renameMenu(s.state.menus, 'menu-cater', 'Events', s);
  assert.equal(out.ok, true);
  assert.equal(s.state.menus.find((m) => m.id === 'menu-cater').name, 'Events', 'the screen shows it at once');
  assert.equal((await out.saved).outcome, 'applied');
  const after = db.row('menus', 'menu-cater');
  assert.equal(after.name, 'Events');
  assert.equal(after.id, before.id, 'the same row, the same id: everything that holds this menu by id still does');
  for (const col of ['description', 'is_default', 'is_active', 'sort_order', 'schedule', 'priority', 'scope', 'org_id', 'location_id']) {
    assert.deepEqual(after[col], before[col], col);
  }
  assert.equal(db.row('menus', 'menu-main').name, 'In store', 'the other menu is untouched');
  assert.equal(s.marked(), 1);
  assert.deepEqual(s.toasts, [], 'a clean save says nothing more');
  assert.deepEqual(columnsForMenuPatch({ name: 'Events' }, s.state.menus.find((m) => m.id === 'menu-cater')), { name: 'Events' });

  // Refused names never reach the database.
  const writes = db.log.filter((l) => /^menus\.(update|upsert|insert)/.test(l)).length;
  assert.ok(writes >= 1, 'the rename was a write');
  assert.equal(renameMenu(s.state.menus, 'menu-main', ' events ', s).ok, false);
  assert.equal(renameMenu(s.state.menus, 'menu-main', '', s).ok, false);
  await s.load();
  assert.equal(db.log.filter((l) => /^menus\.(update|upsert|insert)/.test(l)).length, writes);
  assert.deepEqual(s.state.menus.map((m) => m.name), ['In store', 'Events']);
  assert.equal(s.marked(), 1);
});

test('the screen: the Menu name box is the first thing in a menu\'s settings panel, and it uses these rules', () => {
  const page = read('../backoffice/sections/MenuManager.jsx');
  assert.match(page, /import MenuNameBox from '\.\/MenuNameBox';/);
  const panel = page.slice(page.indexOf('{isEditing && ('));
  const at = panel.indexOf('<MenuNameBox menu={m} />');
  assert.ok(at > 0 && at < panel.indexOf('>Schedule<'), 'above Schedule, priority and default');
  const box = read('../backoffice/sections/MenuNameBox.jsx');
  assert.match(box, /renameMenu\(menus, menu\.id, typed, \{ updateMenu, markBOChange \}\)/, 'the store\'s own save, and the Push to POS mark');
  assert.match(box, /menuNameProblem\(menus, menu\.id, typed\)/, 'the reason shows while typing');
  assert.match(box, /role="alert"/);
  assert.match(box, /aria-label="Menu name"/);
  assert.ok(!/supabase|from\('menus'\)/.test(box), 'no database call of its own');
  // The store's updateMenu is the checked writer (only the patch's columns, compare and set).
  const store = read('../store/index.js');
  assert.match(store.slice(store.indexOf('updateMenu: (id, patch) => {'), store.indexOf('removeMenu:')), /menuWriters\.menus\.edit\(id, patch, prev, updated\)/);
});
