// src/lib/threeWayMerge.test.js
//
// 27 Sep 2026 (Peter: "I archived choc babychino but its still on the menu board"): settings that
// are saved WHOLE (a modifier group's options, the print routing, the venue's pos_settings, the
// Quick Screen list) are now read again at save time and only what THIS window changed is laid
// over the database's copy. A window left open no longer puts back what another saved since.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeKeys, mergeById, decideWholeSave, mergeInstructionGroups } from './threeWayMerge.js';
import { mergeModifierGroup, saveModifierGroupChecked, createLatestQueue } from './modifierGroupWrite.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

test('pos_settings: this window\'s change lands, keys saved elsewhere since are kept', () => {
  const base = { takeaway_customer_details: 'full', tip_on_receipt: false };
  const mine = { ...base, takeaway_customer_details: 'name' };
  const fresh = { takeaway_customer_details: 'full', tip_on_receipt: true, default_receipt_printer_id: 'p-2', order_screen_keep_paid: true };
  assert.deepEqual(mergeKeys(base, mine, fresh), {
    takeaway_customer_details: 'name', tip_on_receipt: true, default_receipt_printer_id: 'p-2', order_screen_keep_paid: true,
  });
  // A key this window removed is removed; one it never had stays.
  assert.deepEqual(mergeKeys({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3 }), { a: 1, c: 3 });
});

test('lists by id (modifier options, print centres): changes on both sides survive', () => {
  const base = [{ id: 'oat', name: 'Oat', price: 0.4 }, { id: 'soy', name: 'Soy', price: 0.4 }, { id: 'rice', name: 'Rice', price: 0.4 }];
  const mine = [{ id: 'oat', name: 'Oat', price: 0.5 }, { id: 'soy', name: 'Soy', price: 0.4 }, { id: 'coco', name: 'Coconut', price: 0.6 }];
  const fresh = [{ id: 'oat', name: 'Oat', price: 0.4 }, { id: 'soy', name: 'Soya', price: 0.45 }, { id: 'rice', name: 'Rice', price: 0.4 }, { id: 'almond', name: 'Almond', price: 0.5 }];
  const out = mergeById(base, mine, fresh);
  assert.deepEqual(out.map((o) => `${o.id}:${o.name}:${o.price}`), [
    'oat:Oat:0.5',          // changed here
    'soy:Soya:0.45',        // changed there, untouched here
    'almond:Almond:0.5',    // added there
    'coco:Coconut:0.6',     // added here
  ]);                        // rice: removed here
});

test('a whole list (the Quick Screen grid) is compare and set by value', () => {
  assert.equal(decideWholeSave(['a', 'b'], ['b', 'a'], ['a', 'b']), 'write');
  assert.equal(decideWholeSave(['a', 'b'], ['b', 'a'], ['b', 'a']), 'noop');
  assert.equal(decideWholeSave(['a', 'b'], ['b', 'a'], ['a', 'b', 'c']), 'conflict', 'changed in another window: refused');
});

test('a modifier group save keeps option prices another window saved', async () => {
  const LOC = 'loc-1';
  const group = { id: 'mgd-milk', location_id: LOC, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0,
    options: [{ id: 'oat', name: 'Oat', price: 0.4 }, { id: 'soy', name: 'Soy', price: 0.4 }] };
  const db = fakeMenuDb({ modifier_groups: [group] });
  const base = { id: 'mgd-milk', name: 'Milk', min: 0, max: 1, selectionType: 'single', sortOrder: 0, options: group.options };
  // Another window changes the soy price; this one renames oat.
  db.touch('modifier_groups', 'mgd-milk', { options: [{ id: 'oat', name: 'Oat', price: 0.4 }, { id: 'soy', name: 'Soy', price: 0.55 }] });
  const mine = { ...base, options: [{ id: 'oat', name: 'Oat milk', price: 0.4 }, { id: 'soy', name: 'Soy', price: 0.4 }] };
  const r = await saveModifierGroupChecked({ client: db, locationId: LOC, base, mine });
  assert.equal(r.ok, true);
  const saved = db.row('modifier_groups', 'mgd-milk').options;
  assert.deepEqual(saved.map((o) => `${o.name}:${o.price}`), ['Oat milk:0.4', 'Soy:0.55']);
  assert.deepEqual(r.group.options, saved, 'the screen gets what was saved');
  // A group deleted in another window is never brought back by a save.
  const gone = await saveModifierGroupChecked({ client: db, locationId: LOC, base, mine: { ...mine, id: 'mgd-deleted' } });
  assert.equal(gone.outcome, 'gone');
  assert.equal(db.row('modifier_groups', 'mgd-deleted'), undefined);
  // Row level security refusing the write is a failure, never a save.
  db.hooks.refuse = () => true;
  const refused = await saveModifierGroupChecked({ client: db, locationId: LOC, base, mine });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error.message), /0 rows/);

  // Before 20260927_OPS_menu_rows_server_time.sql the table has no updated_at: the save still
  // re-reads and merges, and still checks that a row changed.
  const old = fakeMenuDb({ modifier_groups: [group] });
  const r2 = await saveModifierGroupChecked({ client: old, locationId: LOC, base, mine });
  assert.equal(r2.ok, true);
  assert.equal(old.row('modifier_groups', 'mgd-milk').options[0].name, 'Oat milk');
  assert.equal(old.row('modifier_groups', 'mgd-milk').updated_at, undefined, 'no column is invented');
});

test('a modifier group edit keeps the fields another window changed', () => {
  const base = { id: 'g', name: 'Milk', min: 0, max: 1, options: [] };
  const mine = { ...base, max: 2 };
  const fresh = { ...base, name: 'Milk choice' };
  const out = mergeModifierGroup(base, mine, fresh);
  assert.equal(out.name, 'Milk choice');
  assert.equal(out.max, 2);
});

test('group saves go one at a time, and waiting ones fold into one (oldest base, latest group)', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createLatestQueue(async (key, job) => { seen.push({ base: job.base.v, mine: job.mine.v }); if (seen.length === 1) await gate; return { ok: true }; });
  const a = q.request('g', { base: { v: 0 }, mine: { v: 1 } });
  const b = q.request('g', { base: { v: 1 }, mine: { v: 2 } });
  const c = q.request('g', { base: { v: 2 }, mine: { v: 3 } });
  assert.ok(q.pendingKeys().has('g'));
  release();
  await Promise.all([a, b, c]);
  assert.deepEqual(seen, [{ base: 0, mine: 1 }, { base: 1, mine: 3 }]);
  await q.whenIdle();
  assert.equal(q.pendingKeys().size, 0);
});

test('instruction groups: a push from a window left open keeps the groups another window pushed', () => {
  // Both windows received the same push at boot.
  const base = [
    { id: 'igd-cook-temp', name: 'Cooking preference', options: ['Rare', 'Medium', 'Well done'] },
    { id: 'igd-spice', name: 'Spice level', options: ['Mild', 'Hot'] },
  ];
  // Window 1 added "Milk choice" and pushed; that is now the latest push.
  const fresh = [...base, { id: 'igd-milk', name: 'Milk choice', options: ['Oat', 'Soy'] }];
  // Window 2 (open since boot) renamed an option in Spice level and removed Cooking preference.
  const mine = [{ id: 'igd-spice', name: 'Spice level', options: ['Mild', 'Medium', 'Hot'] }];
  const out = mergeInstructionGroups(base, mine, fresh);
  assert.deepEqual(out.map((g) => g.id), ['igd-spice', 'igd-milk'], 'window 1\'s group survives; window 2\'s removal stands');
  assert.deepEqual(out.find((g) => g.id === 'igd-spice').options, ['Mild', 'Medium', 'Hot'], 'window 2\'s change lands');
  // A window that never received a push removes nothing: the lists are joined.
  assert.deepEqual(mergeInstructionGroups(null, mine, fresh).map((g) => g.id).sort(), ['igd-cook-temp', 'igd-milk', 'igd-spice']);
  // No push yet: this window's list goes as it is.
  assert.deepEqual(mergeInstructionGroups(null, mine, undefined), mine);
});
