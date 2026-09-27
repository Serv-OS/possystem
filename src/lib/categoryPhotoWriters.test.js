// Category photos: static source checks on every menu_categories writer and loader.
// Pins the vanishing categories lesson: every writer sends the photo ONLY through
// categoryImageField (never an unconditional image key), and only saveCategoryImage
// can clear it. No database needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withTimeout } from './withTimeout.js';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const store = read('src/store/index.js');
const db = read('src/lib/db.js');
// 27 Sep 2026: the category writers build their row in ONE place (lib/menuItemWrite.js
// categoryRow) and write through lib/menuWriters.js (only the changed columns, compare and set;
// a creation is an insert that never overwrites). The store's _sbUpsertCategoryNow and db.js
// upsertMenuCategory (Push to POS's writer) are gone: Peter, "I archived choc babychino but its
// still on the menu board".
const rowLib = read('src/lib/menuItemWrite.js');
const writersLib = read('src/lib/menuWriters.js');

// Text from the start marker to the first end marker after it.
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `found ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `found the end of ${startMarker}`);
  return src.slice(start, end);
}

const writers = {
  'categoryRow (every store category write)': slice(rowLib, 'export function categoryRow(', '\n}\n'),
  'setMenuCategoryScope baseRow (db)': slice(slice(db, 'export const setMenuCategoryScope = async', 'for (const peerLocId of otherLocationIds)'), 'const baseRow = {', '};'),
};

test('every category writer sends the photo only through categoryImageField', () => {
  for (const [name, body] of Object.entries(writers)) {
    assert.ok(/\.\.\.categoryImageField\((cat|liveCat \?\? cat)\)/.test(body), `${name} spreads categoryImageField`);
    assert.ok(!/\bimage\s*:/.test(body), `${name} has no unconditional image key`);
  }
});

test('the queued store writer reads the photo from the LIVE store row, not the queued copy', () => {
  const body = writers['categoryRow (every store category write)'];
  assert.ok(body.includes('...categoryImageField(liveCat ?? cat)'));
  assert.ok(!body.includes('...categoryImageField(cat)'), 'never builds the photo from the copy captured at enqueue time');
  // A creation builds its row when the write RUNS, from the live store row.
  const create = slice(store, 'const sbCreateCategory = (cat) =>', '{ label: cat.label, locationId: rowVenue(cat) });');
  assert.ok(create.includes('() => categoryRow(cat, useStore.getState().menuCategories'), 'looks up the live row when the write runs');
  // An edit writes the photo only when the edit itself carries it (never a plain save).
  const patchFn = slice(rowLib, 'export function columnsForCategoryPatch(', '\n}\n');
  assert.ok(patchFn.includes('spec.keys.some((k) => has(patch, k))'), 'only the columns the edit touched');
  // The photo save shares the same serialised chain.
  assert.ok(store.includes('export const runInMenuWriteQueue'));
  const field = read('src/backoffice/components/CategoryPhotoField.jsx');
  assert.ok(field.includes('runInMenuWriteQueue('));
  const job = slice(field, 'runInMenuWriteQueue(async () => {', '});');
  assert.ok(job.includes('saveCategoryImage('), 'the save runs inside the queue');
  assert.ok(job.includes('if (!r.error) setStoreImage(cat.id, nextUrl)'), 'the store row changes only after the save succeeds');
  assert.equal((field.match(/setStoreImage\(/g) || []).length, 1, 'the store row is only ever set inside the queue job');
});

test('store and push writers retry without the photo when the image column is missing', () => {
  const retry = slice(writersLib, 'export const categoryImageRetry = (error, cols) => {', '\n};');
  assert.ok(retry.includes('isMissingImageColumn('), 'checks for a missing column');
  assert.ok(retry.includes('delete retry.image'), 'retries without image');
  // Edits and creations of categories both use it; Push to POS's insert of a category the
  // database never received also keeps the category over a missing menu (v5.9.22).
  assert.match(writersLib, /retryWithout: categoryImageRetry,/);
  // 27 Sep 2026: and over a parent category that is not in the database (saved at the top level).
  assert.match(writersLib, /export const categoryInsertRetry = \(error, cols\) => categoryImageRetry\(error, cols\) \|\| categoryMenuLinkRetry\(error, cols\) \|\| categoryParentRetry\(error, cols\);/);
});

test('sharing again never overwrites a peer venue\'s own photo', () => {
  const scope = slice(db, 'export const setMenuCategoryScope = async', '// v4.7.4');
  const loop = slice(scope, 'for (const peerLocId of otherLocationIds)', 'createdCount++');
  // 23 Sep 2026: the same read now also carries menu_id, parent_id and sort_order so a
  // re-send keeps the peer's own menu, parent and order as well as its photo.
  assert.ok(loop.includes("select('id,image,menu_id,parent_id,sort_order').eq('id', peerId)"));
  assert.ok(loop.includes('categoryPhotoUrl(existingPeer)'));
  assert.ok(loop.includes('delete peerRow.image'));
  assert.ok(loop.indexOf('delete peerRow.image') < loop.indexOf('.upsert(peerRow)'));
});

test('saveCategoryImage is scoped to the venue and detects 0 row updates', () => {
  const body = slice(db, 'export const saveCategoryImage = async', 'export const categoryPhotosReady');
  assert.ok(body.includes(".eq('location_id'"));
  assert.ok(body.includes(".select('id')"));
  assert.ok(body.includes('!data?.length'));
  assert.ok(body.includes('peerPhotoTargets('));
  assert.ok(body.includes('peersFailed = true'), 'a failed peer update is reported to the caller');
  assert.ok(!body.includes('.remove('), 'never deletes a stored file');
});

test('readiness only says not ready for a missing column', () => {
  const body = slice(db, 'export const categoryPhotosReady = async', '};');
  assert.ok(body.includes('isMissingImageColumn(error)'));
  assert.ok(!body.includes('_categoryPhotosReady = !error'));
});

test('uploadCategoryPhoto writes a new file name every time and never deletes', () => {
  const body = slice(db, 'export const uploadCategoryPhoto = async', 'export const saveCategoryImage');
  assert.ok(/upsert:\s*false/.test(body));
  assert.ok(body.includes('categoryPhotoPath('));
  assert.ok(body.includes('checkPhotoFile('));
  assert.ok(!body.includes('.remove('));
});

test('loaders and the push carry the photo', () => {
  // 27 Sep 2026: every category loader maps through lib/rowMapping.js mapCategoryRow.
  const mapper = slice(read('src/lib/rowMapping.js'), 'export const mapCategoryRow = (c) => {', '\n};');
  assert.ok(mapper.includes('image:           c.image ?? null'));
  assert.ok(read('src/lib/venueMenuRead.js').includes('cats.rows.map(mapCategoryRow)'), 'the Back Office load and Push to POS');
  assert.ok(read('src/sync/SyncBridge.jsx').includes('catsRes.data.map(mapCategoryRow)'));
  const apply = slice(store, 'menuCategories: snap.menuCategories.map(', '})) } : {})');
  assert.ok(apply.includes('image: c.image ?? null'));
});

test('kiosk settings only write the switch when touched and the column exists', () => {
  const src = read('src/backoffice/sections/KioskSettings.jsx');
  assert.ok(src.includes("touchedRef.current.has('kiosk_category_photos')"));
  assert.ok(src.includes("hasOwnProperty.call(profile, 'kiosk_category_photos')"));
  assert.ok(src.includes('delete patch.kiosk_category_photos'));
});

test('the kiosk reads the switch as on by default and uses one rail mode', () => {
  const src = read('src/surfaces/KioskApp.jsx');
  assert.ok(src.includes('kiosk_category_photos !== false'));
  assert.ok(src.includes('railTileMode('));
  assert.ok(src.includes('<KioskCategoryTile'));
  assert.ok(src.includes('railTileMode(categoryPhotos, railCategories || categories, categoryPhotoOrigin)'), 'mode from every venue category, own host only');
  assert.ok(src.includes('photoOrigin={categoryPhotoOrigin}'));
});

test('the category photo is findable from the menu screen', () => {
  const src = read('src/backoffice/sections/MenuManager.jsx');
  assert.ok(!src.includes('title="Rename category"') && !src.includes('title="Rename"'));
  assert.ok((src.match(/title=\{CATEGORY_PHOTO_COPY\.editCategory\}/g) || []).length >= 3);
  assert.ok(src.includes('CATEGORY_PHOTO_COPY.addPhoto'));
});

test('the category modal form never carries the photo', () => {
  const src = read('src/backoffice/sections/MenuManager.jsx');
  const modal = slice(src, 'function CatModal(', 'function MoveCatModal(');
  assert.ok(modal.includes('<CategoryPhotoField cat={cat}/>'));
  // 27 Sep 2026: the form is built by lib/categoryForm.js, and Save sends only what changed in it.
  assert.ok(modal.includes('useState(() => categoryFormOf(cat))'), 'the form comes from categoryFormOf');
  const form = slice(read('src/lib/categoryForm.js'), 'export function categoryFormOf(', '\n}\n');
  assert.ok(!/\bimage\b/.test(form), 'the Save form state has no image field');
});

// 27 Sep 2026: the photo save runs in the menu write chain, which every later category and menu
// save and every Push to POS waits on. With no time limit, one that never answered held them all.
test('the category photo save in the menu write chain has a time limit, and running out is a failed save', async () => {
  const field = read('src/backoffice/components/CategoryPhotoField.jsx');
  assert.match(field, /import \{ useStore, runInMenuWriteQueue, MENU_WAIT_MS \} from '\.\.\/\.\.\/store';/);
  assert.match(field, /import \{ withTimeout \} from '\.\.\/\.\.\/lib\/withTimeout';/);
  const job = slice(field, 'runInMenuWriteQueue(async () => {', '});');
  const timed = "const r = await withTimeout(saveCategoryImage(live, locId, nextUrl, prev), MENU_WAIT_MS, 'category photo save')\n          .catch((error) => ({ error, needsMigration: false, peersFailed: false }));";
  assert.ok(job.includes(timed), 'the save itself is timed, inside the chain job');
  assert.ok(job.indexOf(timed) < job.indexOf('if (!r.error) setStoreImage(cat.id, nextUrl)'), 'out of time never shows the new photo as saved');
  // The same expression over a save that never answers: an { error } the field reports as failed.
  const hung = new Promise(() => {});
  const r = await withTimeout(hung, 5, 'category photo save').catch((error) => ({ error, needsMigration: false, peersFailed: false }));
  assert.equal(r.error?.name, 'TimeoutError');
  assert.match(r.error.message, /category photo save timed out/);
  assert.equal(r.needsMigration, false, 'reported as a failed save, not a missing migration');
});
