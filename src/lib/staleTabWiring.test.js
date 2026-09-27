// src/lib/staleTabWiring.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". The pure
// pieces are tested on their own (menuRowWrite, menuWriters, venueMenuRead, threeWayMerge); unit
// tests do not catch wiring, so these pin that the app actually USES them:
//   * every menu item, category and menu edit goes through the compare and set writers
//   * every loader keeps the row's database updated_at (srvAt) through the one mapper
//   * the archive stays narrow, checks its row count, and refreshes srvAt
//   * the bulk strips are bounded, awaited and summarised, and offer this venue's rates only
//   * realtime never lands over a save of this tab that is on its way

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const STORE = read('../store/index.js');
const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `found the end of ${a}`);
  return src.slice(i, j);
};

test('item, category and menu edits save only the patch, compare and set; creations insert only', () => {
  const upd = between(STORE, 'updateMenuItem: (id, patch, opts = {}) => {', 'addMenuItem: item => {');
  assert.match(upd, /menuWriters\.items\.edit\(w\.id, w\.patch, rowOf\(before, w\.id\), rowOf\(after, w\.id\)/);
  assert.doesNotMatch(upd, /upsertMenuItem|\.upsert\(/, 'no whole row write');
  assert.match(upd, /writes\.push\(\{ id: i\.id, patch: cascadePatch, cascade: true \}\)/, 'a size saves only the cascaded fields');
  assert.match(upd, /_saveModGroup\(group, base\)/, 'the rename cascade saves groups against what this tab had');
  const add = between(STORE, 'addMenuItem: item => {', 'getItemPrice:');
  assert.match(add, /menuWriters\.items\.create\(newItem\.id,/);
  assert.match(between(STORE, 'updateCategory: (id, patch, opts = {}) => {', 'removeCategory:'),
    /menuWriters\.categories\.edit\(id, patch, prev, updated, \{ liveRow: updated, opened: opts\.opened \|\| null \}\)/);
  assert.match(between(STORE, 'updateMenu: (id, patch) => {', 'removeMenu:'), /menuWriters\.menus\.edit\(id, patch, prev, updated\)/);
  assert.match(between(STORE, 'addMenu: menu => {', 'updateMenu:'), /menuWriters\.menus\.create\(/);
  assert.doesNotMatch(STORE, /sbUpsertCategory|_sbUpsertMenuNow|sbUpsertMenu\(/, 'the whole row writers are gone');
});

test('the archive stays narrow, checks it changed a row, runs in the product\'s queue and keeps the new token', () => {
  const arch = between(STORE, 'archiveMenuItem: async id => {', '// ── Editable floor plan');
  assert.match(arch, /await menuWriters\.items\.task\(id, async \(\) => \{/);
  assert.match(arch, /\.update\(patch\)\s*\.eq\('id', id\)\s*\.eq\('location_id', locId\)\s*\.select\('id, updated_at'\)/);
  assert.match(arch, /const patch = \{ archived: true, parent_id: null, updated_at: new Date\(\)\.toISOString\(\) \};/, 'only the archive columns');
  assert.match(arch, /!data\?\.length/, '0 rows is a failure');
  assert.match(arch, /stampSrv\(data\);/);
  assert.match(arch, /menuWriters\.items\.markLanded\(rid\)/);
});

test('menu, category and modifier group deletes check they removed the row', () => {
  assert.match(STORE, /const sbDeleteMenu = \(id\) => \(isMock \? Promise\.resolve\(\{ ok: true, outcome: 'noop' \}\) : menuWriters\.menus\.task\(id, async \(\) => \{/);
  assert.match(STORE, /deleteRowChecked\(\{ client: supabase, table: 'menus', id, locationId \}\)/);
  assert.match(STORE, /deleteRowChecked\(\{ client: supabase, table: 'menu_categories', id, locationId \}\)/);
  assert.match(between(STORE, 'removeMenu: id => {', 'menuCategories:'), /putBackIfRefused\('menus', removed,/);
  assert.match(between(STORE, 'removeCategory: id => {', 'modifierLibrary:'), /putBackIfRefused\('menuCategories', removed,/);
  const db = read('./db.js');
  assert.match(between(db, 'export const deleteModifierGroup = async', '\n};\n'), /deleteRowChecked\(\{ client: supabase, table: 'modifier_groups', id, locationId \}\)/);
});

test('every loader keeps the database time through the one mapper', () => {
  const sync = read('../sync/SyncBridge.jsx');
  assert.match(sync, /itemsRes\.data\.map\(mapMenuItemRow\)/);
  assert.match(sync, /catsRes\.data\.map\(mapCategoryRow\)/);
  assert.match(sync, /modGroupsRes\.data\.map\(mapModifierGroupRow\)/);
  assert.match(sync, /taxData\.map\(mapTaxRateRow\)/);
  assert.match(sync, /insertMenuItem\(\{ \.\.\.item, location_id: locationId \}, locationId\)/, 'local only items are inserted, never upserted');
  const init = read('./useSupabaseInit.js');
  assert.match(init, /items\.map\(mapMenuItemRow\)/);
  assert.match(init, /rates\.map\(mapTaxRateRow\)/);
  assert.match(STORE, /const rows = \(data \|\| \[\]\)\.map\(mapMenuItemRow\);/, 'loadArchivedMenuItems');
  const rt = read('./realtime.js');
  assert.match(rt, /return mapItemRow\(item\);/, 'realtime maps through the same mapper');
  const map = read('./rowMapping.js');
  assert.match(map, /srvAt:\s+item\.updated_at\s+\?\? item\.srvAt\s+\?\? null,/);
  assert.match(map, /srvAt:\s+c\.updated_at \?\? c\.srvAt \?\? null,/);
  const bo = read('../backoffice/BackOfficeApp.jsx');
  assert.match(between(bo, 'const loadLocationData = async (locationId) => {', 'refreshTablePlan('), /await loadVenueMenu\(locationId\);/);
});

test('in Back Office an empty tax read clears the rates; a till keeps its own', () => {
  const sync = read('../sync/SyncBridge.jsx');
  assert.match(sync, /else if \(!taxErr && Array\.isArray\(taxData\) && isBackOfficeMode\(\)\) patch\.taxRates = \[\];/);
  const init = read('./useSupabaseInit.js');
  assert.match(init, /else if \(!ratesErr && Array\.isArray\(rates\) && isBackOfficeMode\(\)\) useStore\.setState\(\{ taxRates: \[\] \}\);/);
  // A push snapshot (the boot fetch of the last push) no longer puts an older menu, or another
  // venue's rates, back over a fresh read in Back Office.
  assert.match(STORE, /const menuSlices = boMenuFromDb \? \{\} : \{/);
  assert.match(sync, /if \(isBackOfficeMode\(\) && useStore\.getState\(\)\.menuReadLocationId === locationId\) \{/);
});

test('the bulk strips are bounded, awaited, summarised, and offer this venue\'s rates only', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.doesNotMatch(mm, /missingTax\.forEach\(/, 'no fire and forget loop');
  assert.doesNotMatch(mm, /targets\.forEach\(i => updateMenuItem/, 'no fire and forget loop');
  assert.match(mm, /const out = await bulkUpdateMenuItems\(/);
  assert.match(mm, /showToast\(bulkSummaryWords\(out, t\.name\|\|'Tax rate'\)/);
  assert.match(mm, /const venueRatesOf = \(rates\) => \(isMock \? \(rates \|\| \[\]\) : venueTaxRates\(rates, getActiveLocationSync\(\)\)\);/);
  assert.match(mm, /const NO_VENUE_RATES = 'This venue has no tax rates yet';/);
  assert.match(between(mm, 'function TaxSection(', 'const noneOption'), /const taxRates = venueRatesOf\(allTaxRates\);/);
  assert.match(STORE, /export async function bulkUpdateMenuItems\(entries, \{ concurrency = 6, onProgress = null \} = \{\}\) \{\s*await whenMenuLoadIdle\(\);/);
  // New products take THIS venue's default rate in Back Office.
  assert.match(between(STORE, 'addMenuItem: item => {', 'getItemPrice:'), /isBackOfficeMode\(\) \? venueTaxRates\(useStore\.getState\(\)\.taxRates, getActiveLocationSync\(\)\)/);
});

test('realtime never lands over a save of this tab on its way, nor over a newer copy', () => {
  const rt = read('./realtime.js');
  const ch = between(rt, 'const menuItemsChannel = supabase', 'channels.push(menuItemsChannel);');
  assert.match(ch, /if \(isMenuRowPending\('items', row\.id\)\) return;/);
  assert.match(ch, /if \(srvNewer\(list\[idx\], mapped\)\) return \{\};/);
  const tax = between(rt, 'const taxChannel = supabase', '.subscribe();');
  // An empty read is the answer in Back Office only; a till keeps its rates (a tightened read
  // policy answers with no rows and no error, and a till must never drop to no tax in service).
  assert.match(tax, /if \(error \|\| !Array\.isArray\(data\)\) return;/);
  assert.match(tax, /if \(data\.length \|\| isBackOfficeMode\(\)\) store\.setState\(\{ taxRates: data\.map\(mapTaxRateRow\) \}\);/);
});

test('settings saved whole are merged at save time: pos_settings, print routing, the Quick Screen', () => {
  const ls = read('../backoffice/sections/LocationSettings.jsx');
  assert.match(ls, /const mergedPos = mergeKeys\(posSettingsRaw \|\| \{\}, mine, curRow\.pos_settings \|\| \{\}\);/);
  assert.doesNotMatch(ls, /pos_settings: \{ \.\.\.\(posSettingsRaw \|\| \{\}\)/, 'never the copy loaded when the screen opened');
  const pr = read('../backoffice/sections/PrintRouting.jsx');
  assert.match(pr, /centres: mergeById\(base\.centres \|\| \[\], data\.centres \|\| \[\], cur\?\.centres \|\| \[\]\),/);
  assert.match(pr, /routing: mergeKeys\(base\.routing \|\| \{\}, data\.routing \|\| \{\}, cur\?\.routing \|\| \{\}\),/);
  const db = read('./db.js');
  assert.match(between(db, 'export const saveQuickScreenIds = async', '\n};\n'), /decideWholeSave\(base, ids, fresh\)/);
  const mm = read('../backoffice/sections/MenuManager.jsx');
  // The Quick Screen's base is the list the DATABASE held when the section opened (or this
  // window last saved), not the store's list, which can be the last push's.
  const qs = between(mm, 'function QuickScreenManager() {', 'const saveSmart = async');
  assert.match(qs, /readQuickScreenIds\(\)\.then\(\(r\) => \{/);
  assert.match(qs, /dbBase\.current = r\.ids;/);
  assert.match(qs, /const base = dbBase\.current != null \? dbBase\.current : prevIds\.filter\(Boolean\);/);
  assert.match(qs, /return await saveQuickScreenIds\(filtered, \{ base \}\);/);
  assert.match(qs, /const run = saveChain\.current\.then\(/, 'this window\'s saves go one at a time');
  // Modifier groups: every edit of an existing group passes the group as this tab had it.
  assert.match(STORE, /if \(group\) useStore\.getState\(\)\._saveModGroupOrWarn\(group, base\);/);
});

// ── Review round 2 (27 Sep 2026) ────────────────────────────────────────────────────────────

test('the category editor saves only the fields changed in it, checked against what it opened with', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  const modal = between(mm, 'function CatModal(', 'function MoveCatModal(');
  assert.match(modal, /const \[opened\] = useState\(\(\) => categoryFormOf\(cat\)\);/);
  assert.match(modal, /onClick=\{\(\)=>onSave\(categoryFormPatch\(opened, f\)\)\}/, 'only the changed fields');
  assert.doesNotMatch(modal, /onSave\(\{\.\.\.f/, 'never the whole form');
  const save = between(mm, '<CatModal cat={editingCat}', 'onDelete=');
  assert.match(save, /if \(!Object\.keys\(p\)\.length\) return;/, 'nothing changed: nothing written');
  assert.match(save, /updateCategory\(opened\.id, p, \{ opened \}\)/, 'checked against the category as the editor opened it');
  const w = read('./menuWriters.js');
  assert.match(w, /const base = pickColumns\(t\.colsOf\(opened \|\| prev\), Object\.keys\(cols\)\);/);
  assert.match(w, /srvAt: job\.srvAt !== undefined \? job\.srvAt : srvAtOf\(getRow\(kind, id\)\),/);
});

test('a Shared or Global edit is copied only once saved, and from the database row', () => {
  const upd = between(STORE, 'updateMenuItem: (id, patch, opts = {}) => {', 'addMenuItem: item => {');
  assert.match(upd, /if \(savedForPropagation\(r\)\) scheduleScopedPropagation\(/);
  assert.doesNotMatch(upd, /if \(w\.main \|\| w\.cascade\) scheduleScopedPropagation\(/, 'never before the save is known');
  const sched = between(STORE, 'function scheduleScopedPropagation(', '\n}\n');
  assert.match(sched, /_scopedPropagator\.schedule\(id, patchKeys, savedRow\);/);
  assert.doesNotMatch(sched, /propagateScopedEdit\(/, 'the copy runs in lib/scopedPropagation.js, from the database');
  const prop = between(STORE, 'const _scopedPropagator = createScopedPropagator({', '\n});\n');
  assert.match(prop, /supabase\.from\('menu_items'\)\.select\('\*'\)\.eq\('id', id\)\.eq\('location_id', loc\)\.maybeSingle\(\)/);
  assert.match(STORE, /_scopedPropagator\.flush\(\(row, keys\) => \{ propagateScopedEdit\(row, keys\)\.catch\(\(\) => \{\}\); \}\);/, 'pagehide: the saved row, never this tab\'s copy');
  assert.doesNotMatch(STORE, /useStore\.getState\(\)\.menuItems\.find\(\(i\) => i\.id === id\); if \(row\) propagateScopedEdit/);
  // A new size re-sends its product once the size's own insert has landed, not after a fixed wait.
  const add = between(STORE, 'addMenuItem: item => {', 'getItemPrice:');
  assert.match(add, /created\.then\(\(c\) => \{\s*if \(!c\?\.ok\) return;/);
  assert.doesNotMatch(add, /setTimeout\(\(\) => setMenuItemScope/);
  // A Global archive: each size is copied only once the sizes' own archive came back.
  const arch = between(STORE, 'archiveMenuItem: async id => {', '// ── Editable floor plan');
  assert.ok(arch.indexOf("scheduleScopedPropagation(getArchRow, cid, ['archived'])") > arch.indexOf('stampSrv(childRows);'));
});

test('sharing reads the product fresh and checks every sharing write it makes', () => {
  const db = read('./db.js');
  const share = between(db, 'export const setMenuItemScope = async', '\n};\n');
  const fresh = share.indexOf(".eq('id', item.id).eq('location_id', sourceLocId).maybeSingle();");
  const base = share.indexOf('const baseRow = {');
  assert.ok(fresh > 0 && base > fresh, 'the product is read from the database before anything is copied');
  assert.match(share, /if \(freshRow\.archived\) return \{ ok: false,/, 'a product archived meanwhile is not shared');
  assert.match(share, /item = freshRow;/);
  assert.doesNotMatch(share, /\.update\(sourcePatch\)\.eq\('id', item\.id\)/, 'no unchecked source update');
  assert.doesNotMatch(share, /\.update\(\{ scope: 'local', org_id: null, master_id: null, updated_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\('id', item\.id\);/, 'no unchecked demote');
  assert.ok((share.match(/updateScopeChecked\(\{ client: supabase, table: 'menu_items'/g) || []).length >= 3, 'demote, source and sizes');
  const cat = between(db, 'export const setMenuCategoryScope = async', '\n};\n');
  assert.doesNotMatch(cat, /\.update\(sourcePatch\)\.eq\('id', cat\.id\)/);
  assert.ok((cat.match(/updateScopeChecked\(\{ client: supabase, table: 'menu_categories'/g) || []).length >= 2, 'demote and source');
});

test('the migration publishes only the two tables the app listens to', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260927_OPS_menu_rows_server_time.sql', import.meta.url), 'utf8');
  assert.match(sql, /foreach t in array array\['menu_items', 'tax_rates'\] loop/);
  assert.doesNotMatch(sql, /array\['menu_items', 'menu_categories'/, 'modifier_groups was pruned from realtime on purpose (20260804b)');
});

test('a menu read and the waits for one have a time limit', () => {
  const load = between(STORE, 'export async function loadVenueMenu(locationId) {', '\n}\n');
  assert.match(load, /await withTimeout\(readVenueMenu\(supabase, locationId\), MENU_WAIT_MS, 'menu read'\)/);
  assert.match(load, /finally \{\s*endMenuLoad\(\);/, 'menuLoading always clears');
  assert.match(STORE, /export const MENU_WAIT_MS = 15000;/);
});

test('instruction groups: a push lays this window\'s changes onto the latest push, never its whole memory', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  const handle = between(bo, 'const handlePush = async () => {', '\n  };\n');
  assert.match(handle, /select\('snapshot->instructionGroupDefs'\)/);
  assert.match(handle, /instructionGroupDefs = mergeInstructionGroups\(instructionGroupsBase\(\), instructionGroupDefs, lastPush\?\.instructionGroupDefs\);/);
  assert.match(between(handle, 'const snapshot = {', '\n      };\n'), /\n\s+instructionGroupDefs,\n/);
  assert.match(handle, /setInstructionGroupsBase\(instructionGroupDefs\);/);
  assert.match(STORE, /if \(snap\.instructionGroupDefs\?\.length\) setInstructionGroupsBase\(snap\.instructionGroupDefs\);/);
});

// ── Review round 3 (27 Sep 2026) ────────────────────────────────────────────────────────────

test('a product\'s sizes and modifier groups follow its save only once it landed', () => {
  const upd = between(STORE, 'updateMenuItem: (id, patch, opts = {}) => {', 'addMenuItem: item => {');
  assert.match(upd, /return runItemEditWrites\(writes, \{/);
  assert.doesNotMatch(upd, /for \(const w of writes\) \{/, 'no write starts before the product\'s own save is known');
  const landed = between(upd, 'onLanded: () => {', 'onSkipped:');
  assert.match(landed, /_saveModGroup\(group, base\)/, 'the rename cascade runs only here');
  assert.equal((upd.match(/_saveModGroup\(/g) || []).length, 1, 'and nowhere else');
  const skipped = between(upd, 'onSkipped: () => {', '\n    });\n');
  assert.match(skipped, /putBackFollowers\(s\.menuItems, followers, before, after\)/);
  assert.match(skipped, /groupSaves\.find\(x => x\.group === g\)\?\.base \|\| g/);
  // Modifier group saves count as saves in flight (Push to POS waits for them).
  assert.match(between(STORE, 'export async function whenMenuWritesIdle() {', '\n}\n'), /\+ modifierGroupSaves\.pendingKeys\(\)\.size;/);
});

test('menu rows made in this tab carry their venue from birth, and their first save goes only there', () => {
  assert.match(STORE, /const venueAtBirth = \(\) => \{\s*const loc = getActiveLocationSync\(\);\s*return loc && loc !== 'loc-demo' \? \{ location_id: loc \} : \{\};/);
  assert.match(between(STORE, 'addMenu: menu => {', 'updateMenu:'), /\.\.\.menu, \.\.\.venueAtBirth\(\) \};[\s\S]*locationId: rowVenue\(newMenu\)/);
  assert.match(between(STORE, 'addCategory: cat => {', 'updateCategory:'), /\.\.\.cat, \.\.\.venueAtBirth\(\) \};/);
  assert.match(STORE, /\{ label: cat\.label, locationId: rowVenue\(cat\) \}\);/);
  const add = between(STORE, 'addMenuItem: item => {', 'getItemPrice:');
  assert.match(add, /\.\.\.venueAtBirth\(\),\n\s+\};/);
  assert.match(add, /\{ label: newItem\.menuName, locationId: rowVenue\(newItem\) \}/);
  assert.match(between(STORE, 'addModifierGroupDef: g => {', 'updateModifierGroupDef:'), /\.\.\.g, \.\.\.venueAtBirth\(\) \};/);
  // A reload drops rows kept for another venue: the venue goes into every merge.
  const vmr = read('./venueMenuRead.js');
  assert.match(vmr, /mergeReadRows\(state\?\.menuItems, read\.menuItems, \{ keep: k\('items'\), keepArchived: true, locationId \}\)/);
  assert.match(vmr, /mergeReadRows\(state\?\.modifierGroupDefs, read\.modifierGroupDefs, \{ keep: k\('groups'\), locationId \}\)/);
  const w = read('./menuWriters.js');
  assert.match(w, /if \(job\.locationId && job\.locationId !== loc\) \{/);
});
