// src/lib/menuPushIntegrity.test.js
//
// Push to POS must send the tills what the DATABASE holds, and must never write a menu row as a
// side effect of pushing.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". Coffee Boy
// Leeds had two Back Office windows open. The one loaded at 13:52 pressed Push to POS at 13:59;
// the push wrote every product, category and menu it held in memory back over the database:
// archived=false for the Choc Babyccino the other window archived at 13:56, and no tax rate on
// 430 products the other window had just given one. At 14:05 a push made half a second after
// coming back to a tab built the snapshot from the menu held BEFORE the reload (a render time
// copy), with another venue's tax rate ids, and wrote those 435 rows too.
//
// The older lesson still stands (21 Sep 2026, Huddersfield): the menus row must exist before a
// category that names it, or the category is refused on menu_categories_menu_id_fkey. Now that
// the push writes nothing, that rule lives where rows are CREATED (menus first in the serial
// chain; a category the push saves for the person keeps itself over a missing menu link).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DB = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
const BO = readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');
const STORE = readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
const WRITERS = readFileSync(new URL('./menuWriters.js', import.meta.url), 'utf8');

const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `found the end of ${a}`);
  return src.slice(i, j);
};
const PUSH = between(BO, 'function PushToPOSButton(', '// ── Overview snapshot helpers');
const HANDLE = between(PUSH, 'const handlePush = async () => {', '\n  };\n');

test('handlePush writes no menu row: no whole row writers, no upserts at all', () => {
  for (const banned of ['upsertMenuItem', 'upsertMenuCategory', 'upsertMenu(', '.upsert(', "from('menu_items')", "from('menu_categories')", "from('menus')"]) {
    assert.ok(!HANDLE.includes(banned), `handlePush must not contain ${banned}`);
  }
  // The only menu rows it can cause to be written are ones the database does not have, listed
  // for the person first, and saved insert only.
  assert.match(HANDLE, /if \(!window\.confirm\(unsavedWords\(unsaved\)\)\)/);
  assert.match(HANDLE, /saved = await waitFor\(saveUnsavedMenuRows\(unsaved\), 'saving new rows'\)/);
});

test('handlePush holds no render time menu data (the old closure)', () => {
  const destructure = PUSH.match(/const \{([^}]*)\} = useStore\(\);/);
  assert.ok(destructure, 'the component reads the store once');
  for (const k of ['menuItems', 'menuCategories', 'menus', 'taxRates', 'modifierGroupDefs']) {
    assert.ok(!new RegExp(`\\b${k}\\b`).test(destructure[1]), `${k} must not come from the render`);
  }
  assert.ok(!/useStore\.getState\(\)\.(menuItems|menuCategories|taxRates|modifierGroupDefs)\b/.test(between(HANDLE, 'const snapshot = {', '\n    };\n')),
    'the snapshot never takes the menu from memory');
  assert.match(HANDLE, /const menuPart = menuRead \? menuSnapshotFromRead\(menuRead\)/, 'the menu part is the fresh read');
  assert.match(HANDLE, /\.\.\.menuPart,/);
});

test('the push waits for a reload and for this tab\'s saves, then reads, and stops on a failed read', () => {
  const load = HANDLE.indexOf("await waitFor(whenMenuLoadIdle(), 'menu load', MENU_WAIT_MS + 5000);");
  const writes = HANDLE.indexOf("await waitFor(whenMenuWritesIdle(), 'menu saves');");
  const read = HANDLE.indexOf('menuRead = await readMenu();');
  assert.ok(load > 0 && writes > load && read > writes, 'reload first, then saves, then the read');
  // 27 Sep 2026: every wait and read has a time limit, and running out of it stops the push in
  // plain words (a read that hung used to leave the button disabled forever).
  assert.match(HANDLE, /const waitFor = \(p, label, ms = MENU_WAIT_MS\) => withTimeout\(p, ms, label\);/);
  assert.match(HANDLE, /const readMenu = \(\) => waitFor\(readVenueMenu\(supabase, snapshotLocationId\), 'menu read'\)/);
  assert.ok(HANDLE.includes("stop('Push stopped: the menu is still loading or saving. Nothing was sent. Try again.');"));
  assert.ok(HANDLE.includes("stop('Push stopped: could not read the menu. Nothing was sent. Try again.');"));
  const failed = HANDLE.indexOf('if (!menuRead.ok) {');
  const insert = HANDLE.indexOf('insertConfigPush(');
  assert.ok(failed > 0 && insert > failed, 'a failed read returns before anything is sent');
  // Sent only once, awaited, stamped with a display NAME: config_pushes is readable with the
  // public key, so an email address would be published (lib/pushedBy.js).
  assert.match(HANDLE, /const res = await insertConfigPush\(\{ pushed_by: who, snapshot, change_count: pendingBOChanges \}, snapshotLocationId\);/);
  assert.match(PUSH, /const who = pushedByName\(pushedBy, staff\?\.name\);/);
  assert.match(BO, /<PushToPOSButton pushedBy=\{pushedByName\(authUser\?\.user_metadata\?\.full_name, authUser\?\.user_metadata\?\.name, orgCtx\?\.userName\)\} \/>/);
  assert.doesNotMatch(BO, /pushedBy=\{authUser\?\.email/, 'never the email');
  // And this screen then shows exactly what the tills received.
  assert.ok(HANDLE.indexOf('applyVenueMenuRead(menuRead') > HANDLE.indexOf('broadcastConfigPush(snapshot)'));
});

test('the button waits while the venue is being read again', () => {
  assert.match(PUSH, /const busy = pushing \|\| menuLoading;/);
  assert.match(PUSH, /disabled=\{busy\}/);
  // The Back Office reads the venue again whenever the tab comes back to the front.
  assert.match(BO, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(BO, /const onVisible = \(\) => \{ if \(!document\.hidden\) loadVenueMenu\(activeLocationId\); \};/);
});

test('db.js keeps no whole row menu writer; the item helper is insert only', () => {
  assert.doesNotMatch(DB, /export const upsertMenu = async/);
  assert.doesNotMatch(DB, /export const upsertMenuCategory = async/);
  assert.doesNotMatch(DB, /export const upsertMenuItem = async/);
  // The dead archive helpers with no row check are gone too.
  assert.doesNotMatch(DB, /export const archiveMenuItem = async/);
  assert.doesNotMatch(DB, /export const setMenuItemArchived = async/);
  const ins = between(DB, 'export const insertMenuItem = async', '\n};\n');
  assert.match(ins, /insertRowOnce\(\{/, 'ON CONFLICT DO NOTHING, never an overwrite');
  assert.match(ins, /locationId === 'loc-demo'/);
});

test('menus land before the categories that name them, and a category is kept over a missing menu', () => {
  const save = between(STORE, 'export async function saveUnsavedMenuRows(unsaved) {', '\n}\n');
  const menusAt = save.indexOf('menuWriters.menus.create(');
  const catsAt = save.indexOf('menuWriters.categories.create(');
  const itemsAt = save.indexOf('menuWriters.items.create(');
  assert.ok(menusAt > 0 && catsAt > menusAt && itemsAt > catsAt, 'menus, then categories, then products');
  assert.match(save, /parentsFirst\(unsaved\.menuCategories \|\| \[\]\)/, 'a parent category before its subs');
  assert.match(save, /retryWithout: categoryInsertRetry/);
  // The categories and menus writers share ONE serial chain (v5.5.952/954).
  assert.match(STORE, /chain: \(fn\) => runInMenuWriteQueue\(fn\),/);
  assert.match(WRITERS, /queue = createRowQueue\(\{ run, onResult, chain: kind === 'items' \? null : chain \}\);/);
  const guard = between(WRITERS, 'export const isMissingMenuRow = (error) =>', ';\n');
  assert.match(guard, /'23503'/, "Postgres's foreign key violation");
  assert.match(guard, /menu_id\|menu_categories_menu_id_fkey/, 'and only THIS foreign key');
});
