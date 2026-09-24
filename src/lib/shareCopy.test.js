// shareCopy.test.js — a shared product must be the whole product, everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  VERBATIM_FIELDS, REMAPPED_FIELDS, NEVER_FIELDS, RESEND_ONLY_FIELDS, SHARED_OVERRIDABLE, LIVE_MENU_ITEM_COLUMNS,
  propagatedFields, resendFields, isMasterRow, carryVerbatim, carryResendOnly, nameColumnsFor, remapPricingMenus,
  remapForPeer, remapGroupOptions, peerSuffixOf, fieldOf,
} from './shareCopy.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('every live column is classified exactly once', () => {
  const all = [...VERBATIM_FIELDS, ...REMAPPED_FIELDS, ...RESEND_ONLY_FIELDS, ...NEVER_FIELDS].sort();
  assert.deepEqual(all, [...LIVE_MENU_ITEM_COLUMNS].sort(), 'a new column must be added to one of the three lists');
  assert.equal(new Set(all).size, all.length, 'no column in two lists');
});

test('the fields the old copy dropped are now carried', () => {
  for (const f of ['visibility', 'tags', 'item_code', 'assigned_instruction_groups']) assert.ok(VERBATIM_FIELDS.includes(f), f);
  for (const f of ['tax_rate_id', 'tax_profile_id', 'centre_id', 'option_group_order', 'tax_overrides']) assert.ok(REMAPPED_FIELDS.includes(f), f);
  // Review, 23 Sep: archived and sort_order are a venue's own once copied; they are written on a
  // deliberate re-send and never follow an edit.
  assert.deepEqual([...RESEND_ONLY_FIELDS].sort(), ['archived', 'sort_order']);
});

test('carryVerbatim reads store (camel) or db (snake) rows and skips what is absent', () => {
  const fromStore = carryVerbatim({ menuName: 'Latte', itemCode: 'LATTE', tags: ['v'] });
  assert.deepEqual(fromStore, { menu_name: 'Latte', tags: ['v'], item_code: 'LATTE' });
  assert.equal(fieldOf({ kitchen_name: 'K' }, 'kitchen_name'), 'K');
  assert.equal(fieldOf({ kitchenName: 'K' }, 'kitchen_name'), 'K');
});

test('camel wins over snake when both are present: the edited value, never the loaded one', () => {
  // A Back Office store item spreads the raw db row and then edits camelCase keys.
  // Reading snake first pushed pre-edit values to every venue (review, 23 Sep).
  assert.equal(fieldOf({ tax_rate_id: 'old', taxRateId: 'new' }, 'tax_rate_id'), 'new');
  assert.equal(fieldOf({ menu_name: 'Old name', menuName: 'New name' }, 'menu_name'), 'New name');
  assert.equal(fieldOf({ name: 'plain' }, 'name'), 'plain');
  assert.deepEqual(carryResendOnly({ archived: 0, sortOrder: 4, sort_order: 9 }), { archived: false, sort_order: 4 });
  // RESTORE ONLY: a retired source writes nothing, so no re-send can ever archive a venue's product.
  assert.deepEqual(carryResendOnly({ archived: true, sort_order: 2 }), { sort_order: 2 });
});

test('the four name columns are derived exactly as the owner\'s own save derives them', () => {
  // The editor patches menuName only; `name` on a loaded store row is the value at load time.
  assert.deepEqual(nameColumnsFor({ name: 'Old', menuName: 'New', receiptName: '', kitchen_name: 'KDS' }),
    { name: 'New', menu_name: 'New', receipt_name: 'New', kitchen_name: 'KDS' });
});

test('per-menu tier prices are keyed by the peer\'s menu ids, or dropped and named', () => {
  const menuIdFor = (id) => ({ 'menu-lunch': 'menu-lunch_peer' }[id] || null);
  const { pricing, unmapped } = remapPricingMenus({ base: 3, menus: { 'menu-lunch': { base: 2.5 }, 'menu-gone': { base: 1 } } }, menuIdFor);
  assert.deepEqual(pricing, { base: 3, menus: { 'menu-lunch_peer': { base: 2.5 } } });
  assert.deepEqual(unmapped, ['pricing.menus:menu-gone']);
  assert.deepEqual(remapPricingMenus({ base: 3 }, menuIdFor), { pricing: { base: 3 }, unmapped: [] });
});

test('a copy never shares or propagates; the master does', () => {
  assert.equal(isMasterRow({ id: 'm-1' }), true);
  assert.equal(isMasterRow({ id: 'm-1', master_id: 'm-1' }), true);
  assert.equal(isMasterRow({ id: 'm-1_0823595c', master_id: 'm-1' }), false);
  assert.equal(isMasterRow({ id: 'm-1_0823595c', masterId: 'm-1' }), false);
});

test('a re-send onto an EXISTING Shared copy keeps that venue\'s overrides; Global and new rows take everything', () => {
  const kept = resendFields('shared', { exists: true });
  for (const f of SHARED_OVERRIDABLE) assert.ok(!kept.includes(f), f + ' stays the peer\'s own');
  assert.ok(!kept.includes('sort_order'), 'and its category order');
  assert.ok(kept.includes('archived'), 'a re-send restores an archived copy when the source is live');
  assert.ok(resendFields('shared', { exists: true, lockPricing: true }).includes('pricing'), 'unless pricing is locked');
  assert.ok(resendFields('shared', { exists: false }).includes('pricing'), 'a new row gets the price');
  assert.ok(resendFields('global', { exists: true }).includes('pricing'), 'Global has no overrides');
});

test('lock pricing makes the price follow on a Shared product', () => {
  assert.ok(!propagatedFields('shared').includes('pricing'));
  assert.ok(propagatedFields('shared', { lockPricing: true }).includes('pricing'));
  assert.ok(!propagatedFields('global').includes('sort_order'), 'a venue\'s order never follows an edit');
  assert.ok(propagatedFields('global').includes('archived'), 'Global has no local decisions: retired at the owner is retired everywhere');
  assert.ok(!propagatedFields('shared').includes('archived'), 'a Shared venue keeps its own archive');
});

test('global propagates everything; shared leaves the peer its price, category and image', () => {
  const g = propagatedFields('global'); const s = propagatedFields('shared');
  for (const f of SHARED_OVERRIDABLE) { assert.ok(g.includes(f)); assert.ok(!s.includes(f)); }
  assert.ok(s.includes('assigned_modifier_groups'), 'modifiers are never a per-venue override');
  assert.ok(s.includes('tax_rate_id'));
  assert.deepEqual(propagatedFields('local'), []);
  for (const f of NEVER_FIELDS) assert.ok(!g.includes(f), f + ' is never propagated');
});

const ctx = {
  catIdFor: (id) => ({ 'cat-1': 'cat-1_peer0001' }[id] || null),
  groupIdFor: (id) => ({ 'g-1': 'g-1_peer0001', 'g-2': 'g-2_peer0001' }[id] || null),
  parentIdFor: (id) => (id === 'p-1' ? 'p-1_peer0001' : null),
  taxRateIdFor: (id) => (id === 'tr-uk20' ? 'tr-peer-20' : null),
  taxProfileIdFor: (id) => (id === 'tp-std' ? 'tp-peer-std' : null),
  subItemIdFor: (id) => (id === 'sub-1' ? 'sub-1_peer0001' : null),
  centreIdFor: () => null,
};

test('per-venue ids are translated, and a missing equivalent is named, never guessed', () => {
  const { fields, unmapped } = remapForPeer({
    cat: 'cat-1', cats: ['cat-1', 'cat-9'], assigned_modifier_groups: ['g-1', { groupId: 'g-2', required: true }, 'g-lost'],
    option_group_order: ['g-2', 'igd-instr-1', 'g-stale', 'g-1'], assigned_instruction_groups: ['igd-instr-1'],
    tax_rate_id: 'tr-uk20', tax_profile_id: 'tp-std', centre_id: 'c-kitchen', parent_id: null,
    tax_overrides: { takeaway: 'tr-uk20', delivery: 'tr-uk0', collection: null },
  }, ctx);
  assert.equal(fields.cat, 'cat-1_peer0001');
  assert.deepEqual(fields.cats, ['cat-1_peer0001'], 'an unknown category is dropped, not carried as a foreign id');
  assert.deepEqual(fields.assigned_modifier_groups, ['g-1_peer0001', { groupId: 'g-2_peer0001', required: true }], 'per-item rules on a group survive');
  assert.deepEqual(fields.option_group_order, ['g-2_peer0001', 'igd-instr-1', 'g-1_peer0001'], 'an instruction group on the product passes through; a stale id is dropped');
  assert.deepEqual(fields.tax_overrides, { takeaway: 'tr-peer-20', collection: null }, 'an override whose rate the venue lacks is DROPPED, never a foreign id');
  assert.equal(fields.tax_rate_id, 'tr-peer-20');
  assert.equal(fields.tax_profile_id, 'tp-peer-std');
  assert.equal(fields.centre_id, null);
  assert.equal(fields.parent_id, null);
  assert.deepEqual(unmapped, ['assigned_modifier_groups:g-lost', 'centre_id:c-kitchen', 'tax_overrides.delivery:tr-uk0']);
});

test('propagation can be restricted to the fields a scope allows', () => {
  const { fields } = remapForPeer({ cat: 'cat-1', tax_rate_id: 'tr-uk20' }, ctx, ['tax_rate_id']);
  assert.deepEqual(fields, { tax_rate_id: 'tr-peer-20' });
});

test('group options keep every rule and repoint nested groups and sub-items', () => {
  const { options, unmapped } = remapGroupOptions([
    { id: 'o1', name: 'Oat', price: 0.4, allergens: [], subGroupId: 'g-2', maxQty: 2 },
    { id: 'o2', name: 'Extra shot', price: 0.6, itemId: 'sub-1' },
    { id: 'o3', name: 'Lost', itemId: 'sub-9' },
  ], ctx);
  assert.deepEqual(options[0], { id: 'o1', name: 'Oat', price: 0.4, allergens: [], subGroupId: 'g-2_peer0001', maxQty: 2 });
  assert.equal(options[1].itemId, 'sub-1_peer0001');
  assert.equal(options[2].itemId, 'sub-9', 'left as it was and reported');
  assert.deepEqual(unmapped, ['itemId:sub-9']);
});

test('the peer suffix is the last 8 characters of the venue id, as every existing copy uses', () => {
  assert.equal(peerSuffixOf('7218c716-eeb4-4f96-b284-f3500823595c'), '0823595c');
});

test('db.js and the store use these rules, and global edits actually propagate now', () => {
  const db = read('./db.js');
  assert.match(db, /from '\.\/shareCopy'/);
  assert.match(db, /export const propagateScopedEdit = async/);
  assert.match(db, /export const propagateModifierGroupEdit = async/);
  assert.doesNotMatch(db, /^export const propagateGlobalEdit = async/m, 'the never-called original is gone');
  assert.match(db, /if \(!isMasterRow\(fullItem\)\) return/, 'propagation runs from the owner only');
  assert.match(db, /!isMasterRow\(item\) && _depth < 4/, 'sharing from a copy redirects to the master');
  const store = read('../store/index.js');
  assert.match(store, /scheduleScopedPropagation\(\(iid\) => useStore\.getState\(\)\.menuItems\.find/, 'every item edit is offered to its siblings');
  assert.match(store, /propagateScopedEdit\(latest, keys\.size \? \[\.\.\.keys\] : null\)/, 'always with the LATEST row, and only the keys that changed');
  assert.match(store, /if \(!isMasterRow\(row\)\) return;/, 'a copy never propagates; a master whose master_id is its own id DOES (round-2 blocker)');
  assert.match(store, /pagehide/, 'leaving the page inside the debounce still sends the edit');
  assert.match(db, /peerCatIdAt = \(catMasterId, catMasterLocId, peerLocId\)/, 'the owning venue holds the bare master category id');
  assert.match(db, /if \(masterRow\?\.archived\) return \{ ok: false/, 'sharing from a copy of a retired product is refused');
  assert.match(db, /if \(failed\) throw new Error\(`could not read the venue's tax/, 'a failed venue lookup is never memoised as empty');
  assert.match(db, /\.update\(patch\)\.eq\('id', sib\.id\)\.select\('id'\)[\s\S]{0,900}if \(error \|\| !wrote\?\.length\)/, 'a refused peer update (no rows) counts as a failure');
  assert.match(store, /patchKeys\.some\(\(k\) => follows\.has/, 'and only when a field that follows changed');
  assert.match(store, /scheduleGroupPropagation\(group\)/, 'every group edit reaches its peer copies, coalesced');
});
