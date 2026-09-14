// Category photos: static source checks on every menu_categories writer and loader.
// Pins the vanishing categories lesson: every writer sends the photo ONLY through
// categoryImageField (never an unconditional image key), and only saveCategoryImage
// can clear it. No database needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const store = read('src/store/index.js');
const db = read('src/lib/db.js');

// Text from the start marker to the first end marker after it.
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `found ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `found the end of ${startMarker}`);
  return src.slice(start, end);
}

const writers = {
  '_sbUpsertCategoryNow (store)': slice(store, 'const _sbUpsertCategoryNow = async', "reportSave('category', error)"),
  'upsertMenuCategory (db)': slice(db, 'export const upsertMenuCategory = async', "reportSave('category', result.error)"),
  'setMenuCategoryScope baseRow (db)': slice(slice(db, 'export const setMenuCategoryScope = async', 'for (const peerLocId of otherLocationIds)'), 'const baseRow = {', '};'),
};

test('every category writer sends the photo only through categoryImageField', () => {
  for (const [name, body] of Object.entries(writers)) {
    assert.ok(/\.\.\.categoryImageField\((cat|liveCat \?\? cat)\)/.test(body), `${name} spreads categoryImageField`);
    assert.ok(!/\bimage\s*:/.test(body), `${name} has no unconditional image key`);
  }
});

test('the queued store writer reads the photo from the LIVE store row, not the queued copy', () => {
  const body = writers['_sbUpsertCategoryNow (store)'];
  assert.ok(body.includes('useStore.getState().menuCategories'), 'looks up the live row when the write runs');
  assert.ok(body.includes('...categoryImageField(liveCat ?? cat)'));
  assert.ok(!body.includes('...categoryImageField(cat)'), 'never builds the photo from the copy captured at enqueue time');
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
  for (const name of ['_sbUpsertCategoryNow (store)', 'upsertMenuCategory (db)']) {
    const body = writers[name];
    assert.ok(body.includes('isMissingImageColumn('), `${name} checks for a missing column`);
    assert.ok(body.includes('delete row.image'), `${name} retries without image`);
  }
});

test('sharing again never overwrites a peer venue\'s own photo', () => {
  const scope = slice(db, 'export const setMenuCategoryScope = async', '// v4.7.4');
  const loop = slice(scope, 'for (const peerLocId of otherLocationIds)', 'createdCount++');
  assert.ok(loop.includes("select('id,image').eq('id', peerId)"));
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
  assert.ok(read('src/backoffice/BackOfficeApp.jsx').includes('image: c.image ?? null'));
  assert.ok(read('src/sync/SyncBridge.jsx').includes('image: cat.image ?? null'));
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
  const form = slice(modal, 'useState({', '});');
  assert.ok(!/\bimage\b/.test(form), 'the Save form state has no image field');
});
