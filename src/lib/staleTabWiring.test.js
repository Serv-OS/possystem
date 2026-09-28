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
  assert.match(sync, /taxRes\.data\.map\(mapTaxRateRow\)/);
  assert.match(sync, /insertMenuItem\(\{ \.\.\.item, location_id: locationId \}, locationId\)/, 'local only items are inserted, never upserted');
  const init = read('./useSupabaseInit.js');
  assert.match(init, /items\.map\(mapMenuItemRow\)/);
  assert.match(init, /taxRes\.data\.map\(mapTaxRateRow\)/);
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
  // 27 Sep 2026 (the tax root cause port): both through lib/venueTaxRates.js ratesAfterRead, which
  // never keeps another venue's rates; "trusted" (an empty answer is the truth) only in Back Office.
  const sync = read('../sync/SyncBridge.jsx');
  assert.match(sync, /useStore\.setState\(s => \(\{ taxRates: ratesAfterRead\(taxRows, locationId, s\.taxRates, \{ trusted: isBackOfficeMode\(\) \}\) \}\)\);/);
  const init = read('./useSupabaseInit.js');
  assert.match(init, /useStore\.setState\(s => \(\{ taxRates: ratesAfterRead\(taxRows, locId, s\.taxRates, \{ trusted: isBackOfficeMode\(\) \}\) \}\)\);/);
  // A push snapshot (the boot fetch of the last push) no longer puts an older menu, or another
  // venue's rates, back over a fresh read in Back Office.
  // 27 Sep 2026 (review round 4): only the product fields with no column are taken from it.
  assert.match(STORE, /const menuSlices = boMenuFromDb \? \(boExtras && boExtras !== useStore\.getState\(\)\.menuItems \? \{ menuItems: boExtras \} : \{\}\) : \{/);
  assert.match(sync, /if \(isBackOfficeMode\(\) && useStore\.getState\(\)\.menuReadLocationId === locationId\) \{/);
});

test('the bulk strips are bounded, awaited, summarised, and offer this venue\'s rates only', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.doesNotMatch(mm, /missingTax\.forEach\(/, 'no fire and forget loop');
  assert.doesNotMatch(mm, /targets\.forEach\(i => updateMenuItem/, 'no fire and forget loop');
  assert.match(mm, /const out = await bulkUpdateMenuItems\(/);
  // 27 Sep 2026 (the tax root cause port): the rate strip runs through store applyBulkTaxRates
  // (lib/bulkTax.js, pinned in taxVenueWiring.test.js); the profile strip keeps its summary.
  assert.match(mm, /showToast\(`\$\{bulkSummaryWords\(out, pName\)\} \(\$\{label\}\)`/);
  assert.match(mm, /const venueRatesOf = \(rates\) => \(isMock \? \(rates \|\| \[\]\) : venueTaxRates\(rates, tabVenue\(\)\)\);/);
  assert.match(mm, /const NO_VENUE_RATES = 'This venue has no tax rates yet';/);
  assert.match(between(mm, 'function TaxSection(', 'const noneOption'), /const taxRates = liveVenueRatesOf\(allTaxRates\);/);
  assert.match(STORE, /export async function bulkUpdateMenuItems\(entries, \{ concurrency = 6, onProgress = null \} = \{\}\) \{\s*await whenMenuLoadIdle\(\);/);
  // New products take THIS venue's default rate in Back Office.
  assert.match(between(STORE, 'addMenuItem: item => {', 'getItemPrice:'), /isBackOfficeMode\(\) \? venueTaxRates\(useStore\.getState\(\)\.taxRates, tabVenue\(\)\)/);
});

test('realtime never lands over a save of this tab on its way, nor over a newer copy', () => {
  const rt = read('./realtime.js');
  const ch = between(rt, 'const menuItemsChannel = supabase', 'channels.push(menuItemsChannel);');
  assert.match(ch, /if \(isMenuRowPending\('items', row\.id\)\) return;/);
  assert.match(ch, /if \(srvNewer\(list\[idx\], mapped\)\) return \{\};/);
  const tax = between(rt, 'const taxChannel = supabase', '.subscribe();');
  // 27 Sep 2026 (review round 4): Back Office only, so an empty read (the venue has no rates) is
  // the answer there; a till never takes a rate from this channel (only from Push to POS).
  assert.match(tax, /if \(error \|\| !Array\.isArray\(data\)\) return;/);
  assert.match(tax, /store\.setState\(\{ taxRates: data\.map\(mapTaxRateRow\) \}\);/);
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
  assert.match(qs, /return await withTimeout\(saveQuickScreenIds\(filtered, \{ base \}\), MENU_WAIT_MS, 'Quick Screen save'\);/);
  // 27 Sep 2026 (review round 4): one at a time IN the menu write chain, so Push to POS waits.
  assert.match(qs, /const run = runInMenuWriteQueue\(async \(\) => \{/, 'this window\'s saves go one at a time');
  assert.doesNotMatch(qs, /saveChain/, 'no chain of its own that Push to POS cannot see');
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
  // 27 Sep 2026 (review round 4): the database clock on INSERT too (a new row used to keep the
  // device clock), and the undo drops each trigger by name.
  for (const t of ['menu_items', 'menu_categories', 'menus', 'modifier_groups']) {
    assert.match(sql, new RegExp(`create trigger ${t}_stamp_updated_at\\n  before insert or update on public\\.${t}\\n`), t);
    assert.match(sql, new RegExp(`--   drop trigger if exists ${t}_stamp_updated_at on public\\.${t};`), `${t} undo`);
  }
  assert.doesNotMatch(sql, /^\s*before update on/m, 'no trigger on update only');
});

test('a menu read and the waits for one have a time limit', () => {
  const load = between(STORE, 'export async function loadVenueMenu(locationId) {', '\n}\n');
  assert.match(load, /await withTimeout\(readVenueMenu\(supabase, locationId\), MENU_WAIT_MS, 'menu read'\)/);
  assert.match(load, /finally \{\s*endMenuLoad\(\);/, 'menuLoading always clears');
  // 27 Sep 2026 (review round 4): one value, where the writers use it; the store re exports it.
  assert.match(read('./menuRowWrite.js'), /export const MENU_WAIT_MS = 15000;/);
  assert.match(STORE, /import \{ deleteRowChecked, writeWithin, MENU_WAIT_MS \} from '\.\.\/lib\/menuRowWrite';/);
  assert.match(STORE, /\nexport \{ MENU_WAIT_MS \};\n/);
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
  assert.match(STORE, /const venueAtBirth = \(\) => \{\s*const loc = tabVenue\(\);\s*return loc && loc !== 'loc-demo' \? \{ location_id: loc \} : \{\};/);
  assert.match(between(STORE, 'addMenu: menu => {', 'updateMenu:'), /\.\.\.menu, \.\.\.venueAtBirth\(\) \};[\s\S]*locationId: rowVenue\(newMenu\)/);
  assert.match(between(STORE, 'addCategory: cat => {', 'updateCategory:'), /\.\.\.cat, \.\.\.venueAtBirth\(\) \};/);
  assert.match(STORE, /\{ label: cat\.label, locationId: rowVenue\(cat\) \}\);/);
  const add = between(STORE, 'addMenuItem: item => {', 'getItemPrice:');
  assert.match(add, /\.\.\.venueAtBirth\(\),\n\s+\};/);
  assert.match(add, /\{ label: newItem\.menuName, locationId: rowVenue\(newItem\) \}/);
  assert.match(between(STORE, 'addModifierGroupDef: g => {', 'updateModifierGroupDef:'), /\.\.\.g, \.\.\.venueAtBirth\(\) \};/);
  // A reload drops rows kept for another venue: the venue goes into every merge.
  const vmr = read('./venueMenuRead.js');
  assert.match(vmr, /mergeReadRows\(state\?\.menuItems, read\.menuItems, \{ keep: k\('items'\), keepArchived: true, locationId, extras: ITEM_EXTRA_KEYS \}\)/);
  assert.match(vmr, /mergeReadRows\(state\?\.modifierGroupDefs, read\.modifierGroupDefs, \{ keep: k\('groups'\), locationId \}\)/);
  const w = read('./menuWriters.js');
  assert.match(w, /if \(job\.locationId && job\.locationId !== loc\) \{/);
});

// ── Review round 4 (27 Sep 2026) ────────────────────────────────────────────────────────────

test('the tills take the menu and tax rates from Push to POS only; Back Office windows hear each other', () => {
  const rt = read('./realtime.js');
  const items = between(rt, 'const menuItemsChannel = supabase', 'channels.push(menuItemsChannel);');
  const handler = between(items, '}, ({ eventType, new: row, old }) => {', "if (eventType === 'DELETE') {");
  assert.match(handler, /=> \{\s*if \(!isBackOfficeMode\(\)\) return;\s*$/, 'the first line of the handler');
  const tax = between(rt, 'const taxChannel = supabase', '.subscribe();');
  assert.ok(tax.indexOf('if (!isBackOfficeMode()) return;') > 0, 'the tax channel too');
  assert.ok(tax.indexOf('if (!isBackOfficeMode()) return;') < tax.indexOf(".from('tax_rates')"), 'before it reads anything');
  const sql = readFileSync(new URL('../../supabase/migrations/20260927_OPS_menu_rows_server_time.sql', import.meta.url), 'utf8');
  assert.match(sql, /It reaches the TILLS on Push to POS/);
  assert.doesNotMatch(sql, /reaches the tills live/);
});

test('Push to POS offers back only rows whose first save failed here, and a reload keeps them', () => {
  const w = read('./menuWriters.js');
  assert.match(w, /if \(job\.kind === 'create'\) \{\s*if \(o === 'created' \|\| o === 'exists'\) failedCreates\.delete\(id\);\s*else if \(o === 'error'\) failedCreates\.add\(id\);/);
  assert.match(STORE, /export const failedCreateIds = \(\) => \(\{\s*menus: menuWriters\.menus\.failedCreateIds\(\),\s*categories: menuWriters\.categories\.failedCreateIds\(\),\s*items: menuWriters\.items\.failedCreateIds\(\),\s*groups: new Set\(_groupCreateFailed\),/);
  const apply = between(STORE, 'export function applyVenueMenuRead(', '\n}\n');
  assert.match(apply, /for \(const id of menuWriters\[kind\]\.failedCreateIds\(\)\) keep\.add\(id\);/, 'kept through a reload');
  assert.match(apply, /for \(const kind of \['items', 'categories', 'menus'\]\) settleFailed\(kind\);/);
  assert.match(apply, /\.\.\._groupCreates\.keys\(\), \.\.\._groupCreateFailed\]\);/, 'groups too');
  // A delete here forgets it.
  assert.match(between(STORE, 'removeMenu: id => {', 'menuCategories:'), /menuWriters\.menus\.forgetCreate\(id\);/);
  assert.match(between(STORE, 'removeCategory: id => {', 'modifierLibrary:'), /menuWriters\.categories\.forgetCreate\(id\);/);
  assert.match(between(STORE, 'const sbDeleteMenu = ', '\n}));'), /menuWriters\.menus\.forgetCreate\(id\);/);
  assert.match(between(STORE, 'const sbDeleteCategory = ', '\n}));'), /menuWriters\.categories\.forgetCreate\(id\);/);
});

test('the product fields with no column ride Push to POS and survive a reload and a push applied in Back Office', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  const handle = between(bo, 'const handlePush = async () => {', '\n  };\n');
  assert.match(handle, /const menuPart = menuRead \? menuSnapshotFromRead\(menuRead, \{ extrasFrom: useStore\.getState\(\)\.menuItems \}\)/);
  const vmr = read('./venueMenuRead.js');
  assert.match(vmr, /mergeReadRows\(state\?\.menuItems, read\.menuItems, \{ keep: k\('items'\), keepArchived: true, locationId, extras: ITEM_EXTRA_KEYS \}\)/);
  const cfg = between(STORE, 'applyConfigUpdate: () => {', '\n  },\n');
  assert.match(cfg, /const boExtras = boMenuFromDb && snap\.menuItems\?\.length \? withItemExtras\(useStore\.getState\(\)\.menuItems, snap\.menuItems\) : null;/);
  // A boot read of the products (every device) keeps them from the rows it replaces.
  assert.match(read('./useSupabaseInit.js'), /useStore\.setState\(\(s\) => \(\{ menuItems: withItemExtras\(items\.map\(mapMenuItemRow\), s\.menuItems\) \}\)\);/);
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.doesNotMatch(mm, /Not saved yet: this label stays on this screen only/, 'the label reaches the tills again');
});

test('every menu write has a time limit, and every save Push to POS must wait for is in the chain it waits on', () => {
  const w = read('./menuWriters.js');
  assert.match(w, /return writeWithin\(insertRowOnce\(\{ client, table: t\.table,/);
  assert.match(w, /const once = \(\) => writeWithin\(writeRowChecked\(\{/);
  assert.doesNotMatch(w, /return insertRowOnce\(|= \(\) => writeRowChecked\(/, 'no call without a limit');
  assert.match(read('./modifierGroupWrite.js'), /return writeWithin\(insertRowOnce\(\{\s*client, table: 'modifier_groups',/);
  assert.match(read('./menuRowWrite.js'), /return withTimeout\(promise, ms, label\)\.catch\(\(error\) => \(\{ ok: false, outcome: 'error', error \}\)\);/);
  assert.match(STORE, /const r = await writeWithin\(saveModifierGroupChecked\(\{ client: supabase, locationId: loc, base, mine \}\), `saving modifier group \$\{id\}`\);/);
  assert.match(STORE, /const write = withTimeout\(upsertModifierGroup\(group\), MENU_WAIT_MS,/);
  assert.match(STORE, /writeWithin\(deleteRowChecked\(\{ client: supabase, table: 'menus', id, locationId \}\)/);
  assert.match(STORE, /writeWithin\(deleteRowChecked\(\{ client: supabase, table: 'menu_categories', id, locationId \}\)/);
  assert.match(between(STORE, 'archiveMenuItem: async id => {', '// ── Editable floor plan'), /return await withTimeout\(supabase\.from\('menu_items'\)/);
  // A modifier group delete runs in the menu write chain, so whenMenuWritesIdle covers it.
  const del = between(STORE, 'removeModifierGroupDef: id => {', 'reorderModifierGroupDefs:');
  assert.match(del, /runInMenuWriteQueue\(\(\) => withTimeout\(deleteModifierGroup\(id\), MENU_WAIT_MS, `deleting modifier group \$\{id\}`\)\)/);
  assert.match(between(STORE, 'export async function whenMenuWritesIdle() {', '\n}\n'), /runInMenuWriteQueue\(\(\) => null\)/);
});

// ── 27 Sep 2026: the venue is THIS tab's ────────────────────────────────────────────────────
// rpos-bo-location (getActiveLocationSync) is shared by every tab of the browser: a venue switch
// in another Back Office tab sent this tab's new products to that venue and had its edits
// refused. The behaviour is proved in menuWriters.test.js with the real functions; these pin
// that every Back Office menu, category, modifier group, tax and discount write uses them.
test('Back Office menu, tax and discount writes take the venue THIS tab resolved, never the shared key', () => {
  const SUPA = read('./supabase.js');
  assert.match(SUPA, /^let _resolvedLocationId = null;$/m, 'a module variable: one per tab (page load)');
  assert.match(SUPA, /export const getResolvedLocationIdSync = \(\) => _resolvedLocationId;/);
  assert.match(STORE, /export const tabVenue = \(\) => \(isBackOfficeMode\(\) && getResolvedLocationIdSync\(\)\) \|\| getActiveLocationSync\(\);/);
  assert.match(STORE, /resolveLocation: async \(\) => tabVenue\(\) \|\| await getLocationId\(\),/, 'every item, category and menu writer');
  assert.match(between(STORE, 'const modifierGroupSaves = createLatestQueue(', 'export const isMenuRowPending'), /try \{ loc = tabVenue\(\) \|\| await getLocationId\(\); \} catch \{ loc = null; \}/);
  assert.match(between(STORE, 'async function saveGroupFirstTime(group) {', '\n}\n'), /try \{ loc = tabVenue\(\) \|\| await getLocationId\(\); \} catch \{ loc = null; \}/);
  assert.match(between(STORE, 'const sbDeleteMenu = (id) =>', '}));'), /const locationId = tabVenue\(\) \|\| await getLocationId\(\)/);
  assert.match(between(STORE, 'const sbDeleteCategory = (id) =>', '}));'), /const locationId = tabVenue\(\) \|\| await getLocationId\(\)/);
  assert.match(between(STORE, 'const _scopedPropagator = createScopedPropagator({', 'const loc = tabVenue()'), /readRow: async \(id\) => \{/);
  assert.match(between(STORE, 'archiveMenuItem: async id => {', 'updateTableLayout: (id, patch) => {'), /const locId = tabVenue\(\) \|\| await getLocationId\(\)/);
  assert.match(between(STORE, 'applyConfigUpdate: () => {', 'const snapTaxRates'), /const pushVenue = tabVenue\(\) \|\| snap\.locationId \|\| null;/);
  // Nothing else in the store's menu writers reads the shared key (the session tag is a till's).
  const menuPart = between(STORE, 'const MENU_TOAST_MS = 9000;', 'export const useStore = create(')
    .replace(/export const tabVenue = [^\n]*\n/, '')
    .replace(/const venueTag = [^\n]*\n/, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(menuPart, /getActiveLocationSync\(\)/);
  // db.js: the Back Office writers that fall back to a venue of their own.
  const DB = read('./db.js');
  assert.match(DB, /const tabVenue = \(\) => \(isBackOfficeMode\(\) && getResolvedLocationIdSync\(\)\) \|\| getActiveLocationSync\(\);/);
  for (const fn of ['export const fetchArchivedMenuItems = async', 'export const upsertModifierGroup = async', 'export const deleteModifierGroup = async',
    'export const propagateModifierGroupEdit = async', 'export const deleteDiscount = async', 'export const deleteDiscountRule = async']) {
    const body = between(DB, fn, '\n};\n');
    assert.match(body, /tabVenue\(\)/, fn);
    assert.doesNotMatch(body, /getActiveLocationSync/, fn);
  }
  // The Menu Manager: this tab's venue everywhere (rates offered, Apply to all, archives, pulls).
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.doesNotMatch(mm, /getActiveLocationSync/);
  assert.match(mm, /import \{[^}]*\btabVenue \} from '\.\.\/\.\.\/store';/);
  assert.match(between(mm, 'async function archiveVariantRow(id) {', '\n}\n'), /const locId = tabVenue\(\) \|\| await getLocationId\(\)/);
});

// 27 Sep 2026: the Quick Screen MODE save used to run outside the menu write chain, so Push to
// POS, which reads quick_screen_mode once the chain is idle, could read the mode from before it.
test('the Quick Screen mode save runs in the menu write chain, with the list save\'s time limit', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  const smart = between(mm, 'const saveSmart = async (mode, auto) => {', 'const recompute = async');
  assert.match(smart, /err = await runInMenuWriteQueue\(\(\) => withTimeout\(\(async \(\) => \{/);
  assert.match(smart, /\}\)\(\), MENU_WAIT_MS, 'Quick Screen mode save'\)\);/);
  const job = between(smart, 'runInMenuWriteQueue(', "'Quick Screen mode save'");
  assert.match(job, /const locId = await getLocationId\(\);/);
  assert.match(job, /await supabase\.from\('locations'\)\.update\(patch\)\.eq\('id', locId\)\.select\('id'\);/);
  assert.equal((smart.match(/supabase\.from\(/g) || []).length, 1, 'no write outside the chain');
  // The list save keeps the same limit, and Push reads the mode only after the chain is idle.
  assert.match(mm, /return await withTimeout\(saveQuickScreenIds\(filtered, \{ base \}\), MENU_WAIT_MS, 'Quick Screen save'\);/);
  const bo = read('../backoffice/BackOfficeApp.jsx');
  const push = between(bo, 'const handlePush = async () => {', 'if (justPushed)');
  const idle = push.indexOf("await waitFor(whenMenuWritesIdle(), 'menu saves');");
  const readMode = push.indexOf("select('pos_settings, quick_screen_mode, quick_screen_ids')");
  assert.ok(idle > 0 && readMode > idle, 'the mode is read after every menu save landed');
});
