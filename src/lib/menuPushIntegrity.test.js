// src/lib/menuPushIntegrity.test.js
//
// Push to POS must leave the DATABASE holding the same menu the tills hold.
//
// LIVE, found 21 Sep 2026: Huddersfield had 32 menu items, 4 categories on its
// tills and ZERO category rows in the database. Its menu board builder was
// empty, and so were online ordering and the kiosk, which read that table
// directly. Cause: the push wrote items and categories but never the MENUS
// they belong to, and menu_categories.menu_id references menus(id), so every
// category upsert since April had died on
//   23503 ... violates foreign key constraint "menu_categories_menu_id_fkey"
// The tills never noticed because they run from the push snapshot, which
// carries the categories inside it.
//
// These tests pin the two halves of the fix: the menus are written, first; and
// a category is never lost over a link to a menu that is not there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DB = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
const BO = readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');

test('the push has a writer for menus, and it reports what it did', () => {
  const fn = DB.slice(DB.indexOf('export const upsertMenu = async'), DB.indexOf('const isMissingMenuRow'));
  assert.ok(fn.length > 0, 'db.js exports upsertMenu');
  assert.match(fn, /supabase\.from\('menus'\)\.upsert\(/);
  assert.match(fn, /reportSave\('menu', result\.error\)/, 'a failed menu write raises the red bar');
  // the same no-location discipline as every other writer here
  assert.match(fn, /locationId === 'loc-demo'/);
  assert.match(fn, /if \(!m\?\.id\) return/, 'a menu with no id is skipped, not written as null');
  // the row is built from the shared normaliser, so both spellings are read
  assert.match(fn, /normaliseMenuRow\(menu\)/);
  assert.match(fn, /is_default: m\.isDefault \|\| false/, 'the default menu flag is not clobbered');
});

test('Push to POS writes the menus BEFORE the categories that name them', () => {
  const push = BO.slice(BO.indexOf("import('../lib/db.js').then"), BO.indexOf('broadcastConfigPush(snapshot)'));
  const menusAt = push.indexOf('upsertMenu(m, locationId)');
  const catsAt = push.indexOf('upsertMenuCategory(');
  assert.ok(menusAt > 0, 'the menus are written at all');
  assert.ok(catsAt > menusAt, 'menus first: a category whose menu is missing is refused outright');
  assert.match(push, /await Promise\.allSettled\(menus\.map\(m => upsertMenu\(m, locationId\)\)\)/,
    'AWAITED, so the parent rows are there before the categories go');
  assert.match(push, /\{ insertConfigPush, upsertMenuItem, upsertMenuCategory, upsertMenu \}/);
});

test('a category is never lost over a menu link that cannot be satisfied', () => {
  const guard = DB.slice(DB.indexOf('const isMissingMenuRow'), DB.indexOf('export const upsertMenuCategory'));
  assert.match(guard, /'23503'/, "Postgres's foreign key violation");
  assert.match(guard, /menu_id\|menu_categories_menu_id_fkey/, 'and only THIS foreign key');

  const fn = DB.slice(DB.indexOf('export const upsertMenuCategory'), DB.indexOf('export const fetchMenuItems'));
  assert.match(fn, /if \(result\.error && row\.menu_id && isMissingMenuRow\(result\.error\)\)/);
  assert.match(fn, /upsert\(\{ \.\.\.row, menu_id: null \}\)/, 'keep the category, drop only the link');
  assert.match(fn, /console\.warn/, 'and say so, because the menus row still needs saving');
  // the retry must come AFTER the image fallback and BEFORE the outcome is reported,
  // or a category saved on the second attempt would still raise the red bar
  const heal = fn.indexOf('isMissingMenuRow(result.error)');
  const report = fn.indexOf("reportSave('category', result.error)");
  assert.ok(heal > 0 && report > heal, 'the outcome is reported after the last attempt');
});
