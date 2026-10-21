/**
 * discountKinds.test.js: what a discount preset is for (v5.11.90, the drainer release, 20261023a).
 *
 * A Back Office preset can be Staff, Comp or Loyalty (discounts.kind, null = ordinary). The till,
 * the bar tab and MPOS copy the preset's id and kind onto the check discount (presetId, kind), so
 * the database's sales day totals count staff food, comps and loyalty rewards on their own line.
 * Nothing else in the discount changes, so totals and net of VAT never move. Before the database
 * update the Discounts screen still saves (the kind is left out and the screen says so).
 * These tests pin the pure rule, the save fallback, and every surface that makes a discount.
 * Run: npm test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DISCOUNT_KINDS, DISCOUNT_KIND_LABELS, DISCOUNT_KIND_HELP, DISCOUNT_KIND_NOT_SAVED,
  cleanDiscountKind, discountKindLabel, isMissingKindColumn,
} from './discountKinds.js';
import { venueDiscountList } from './venueDiscounts.js';
import { scrubDiscount } from './discountApprover.js';
import { stampDiscountAmounts, lineAfterItemDiscount } from './taxBasis.js';
import { closedCheckRow } from './closedCheckRow.js';
import { checkSalesParts } from '../../supabase/functions/_shared/tradingSales.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `found ${b} after ${a}`);
  return src.slice(i, j);
};

// ── The pure rule (contract 3.2) ─────────────────────────────────────────────────────────────────

test('the three kinds, their plain words, the help line and the not saved toast are exactly the agreed words', () => {
  assert.deepEqual(DISCOUNT_KINDS, ['staff', 'comp', 'loyalty']);
  assert.deepEqual(DISCOUNT_KIND_LABELS, { '': 'Ordinary discount', staff: 'Staff food and drink', comp: 'Comp (on the house)', loyalty: 'Loyalty reward' });
  assert.equal(DISCOUNT_KIND_HELP, 'Stock reports show staff food, comps and loyalty rewards on their own line. The price does not change.');
  assert.equal(DISCOUNT_KIND_NOT_SAVED, 'Saved. The kind needs a database update first, so it was not kept.');
  for (const t of [DISCOUNT_KIND_HELP, DISCOUNT_KIND_NOT_SAVED, ...Object.values(DISCOUNT_KIND_LABELS)]) {
    assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes as punctuation');
  }
});

test('cleanDiscountKind keeps the three kinds (the database CHECK) and turns everything else into null', () => {
  for (const k of DISCOUNT_KINDS) assert.equal(cleanDiscountKind(k), k);
  assert.equal(cleanDiscountKind(' Staff '), 'staff');
  assert.equal(cleanDiscountKind('LOYALTY'), 'loyalty');
  for (const v of ['', ' ', 'vip', 'staff meal', 'promo', null, undefined, 0, 1, true, {}, ['staff']]) {
    assert.equal(cleanDiscountKind(v), null, `${JSON.stringify(v)} is an ordinary discount`);
  }
  assert.equal(discountKindLabel('comp'), 'Comp (on the house)');
  assert.equal(discountKindLabel(null), 'Ordinary discount');
  assert.equal(discountKindLabel('vip'), 'Ordinary discount');
});

test('isMissingKindColumn: only "the kind column is not there yet", never any other refusal', () => {
  assert.equal(isMissingKindColumn({ code: 'PGRST204', message: "Could not find the 'kind' column of 'discounts' in the schema cache" }), true);
  assert.equal(isMissingKindColumn({ code: '42703', message: 'column "kind" of relation "discounts" does not exist' }), true);
  assert.equal(isMissingKindColumn({ code: 'PGRST204', message: "Could not find the 'sort_order' column of 'discounts' in the schema cache" }), false, 'another missing column is a real error');
  assert.equal(isMissingKindColumn({ code: '23514', message: 'new row for relation "discounts" violates check constraint "discounts_kind_known"' }), false, 'a bad kind is a real error');
  assert.equal(isMissingKindColumn({ code: '42501', message: 'new row violates row-level security policy for table "discounts"' }), false);
  assert.equal(isMissingKindColumn(null), false);
  assert.equal(isMissingKindColumn(undefined), false);
  assert.equal(isMissingKindColumn(new Error('fetch failed')), false);
});

// ── Back Office > Discounts ──────────────────────────────────────────────────────────────────────

test('DiscountManager: a Kind select after the Scope row, with the help line, saved as discounts.kind', () => {
  const src = read('../backoffice/sections/DiscountManager.jsx');
  assert.match(src, /^import \{ DISCOUNT_KIND_LABELS, DISCOUNT_KIND_HELP, DISCOUNT_KIND_NOT_SAVED, cleanDiscountKind \} from '\.\.\/\.\.\/lib\/discountKinds';$/m);
  assert.match(between(src, 'const EMPTY_DISCOUNT = {', '};'), /kind:null,/, 'a new discount starts ordinary');
  const form = between(src, 'function DiscountForm(', '/* ── Auto-Discount Rule Form');
  const scope = form.indexOf('<label style={S.label}>Scope</label>');
  const kind = form.indexOf('<label style={S.label}>Kind</label>');
  const pin = form.indexOf('Requires manager PIN');
  assert.ok(scope > 0 && kind > scope && kind < pin, 'the Kind select comes after the Scope row and before the manager PIN');
  assert.match(form, /<select style=\{S\.select\} value=\{form\.kind \|\| ''\} onChange=\{e => f\('kind', cleanDiscountKind\(e\.target\.value\)\)\}>/, "value '' is an ordinary discount (null)");
  assert.match(form, /\{Object\.entries\(DISCOUNT_KIND_LABELS\)\.map\(\(\[k, label\]\) => <option key=\{k \|\| 'none'\} value=\{k\}>\{label\}<\/option>\)\}/);
  assert.match(form, /<div style=\{\{[^}]*\}\}>\{DISCOUNT_KIND_HELP\}<\/div>/, 'the help line sits under the select');
  // the form saves the whole form (kind included)
  assert.match(form, /await onSave\(\{ \.\.\.form, value: parseFloat\(form\.value\) \|\| 0 \}\);/);
});

test('DiscountManager: both reads carry the kind (a toggle never wipes it), the list shows it, the not saved toast', () => {
  const src = read('../backoffice/sections/DiscountManager.jsx');
  assert.equal((src.match(/kind: cleanDiscountKind\(d\.kind\),/g) || []).length, 2, 'the load and the read back after a save');
  // the venue pins stay (taxVenueWiring): four mappings keep location_id
  assert.equal((src.match(/locationId: [dr]\.location_id \?\? null/g) || []).length, 4);
  // a toggle saves the mapped row, so the kind it read goes back with it
  assert.match(src, /const toggleDiscount = async \(disc\) => \{\n\s+await saveDiscount\(\{ \.\.\.disc, active: !disc\.active \}\);/);
  // the list row shows the kind's plain words when it has one
  assert.match(src, /\{cleanDiscountKind\(disc\.kind\) && \(\s*<span[^>]*>\s*\{DISCOUNT_KIND_LABELS\[cleanDiscountKind\(disc\.kind\)\]\}\s*<\/span>\s*\)\}/);
  // before 20261023a: everything else saved, the kind was not kept, and the screen says so
  const save = between(src, 'const saveDiscount = async (form) => {', '// ── Delete discount ──');
  assert.match(save, /const \{ error, kindNotSaved \} = await upsertDiscount\(form, locationId\);/);
  assert.match(save, /if \(kindNotSaved && cleanDiscountKind\(form\.kind\)\) \{ showToast\?\.\(DISCOUNT_KIND_NOT_SAVED, 'warning'\); return; \}\n\s+showToast\?\.\(`"\$\{form\.name\}" saved`, 'success'\);/);
  assert.ok(save.indexOf('if (error) {') < save.indexOf('kindNotSaved &&'), 'a refused save is still said first');
});

// ── The save: kind sent, a database without the column still saves ─────────────────────────────

// db.js pulls the browser supabase client, so the function is lifted from the source and run
// against a fake client: the shipped text is the one under test.
function liftUpsertDiscount() {
  const src = read('./db.js');
  assert.match(src, /^import \{ cleanDiscountKind, isMissingKindColumn \} from '\.\/discountKinds\.js';$/m);
  const start = src.indexOf('export const upsertDiscount = async (discount, locationId = null) => {');
  assert.ok(start > 0);
  const end = src.indexOf('\n};\n', start);
  const body = src.slice(start, end + 3).replace('export const upsertDiscount =', 'return');
  return (supabase) => new Function('supabase', 'isMock', 'getLocationId', 'cleanDiscountKind', 'isMissingKindColumn', body)(
    supabase, false, async () => 'loc-1', cleanDiscountKind, isMissingKindColumn);
}
function fakeClient(answers) {
  const sent = [];
  return {
    sent,
    from(table) {
      assert.equal(table, 'discounts');
      return { upsert: async (row, opts) => { sent.push({ row, opts }); return answers[sent.length - 1] || { data: null, error: null }; } };
    },
  };
}
const FORM = { id: 'd-1', name: 'Staff meal', type: 'percent', value: 50, scope: 'global', categoryIds: [], requiresManager: true, active: true, sortOrder: 2, kind: 'staff' };
const MISSING = { error: { code: 'PGRST204', message: "Could not find the 'kind' column of 'discounts' in the schema cache" }, data: null };

test('upsertDiscount sends the cleaned kind with the row (one write when the column is there)', async () => {
  const make = liftUpsertDiscount();
  const sb = fakeClient([]);
  const r = await make(sb)(FORM, 'loc-1');
  assert.equal(r.error, null);
  assert.equal(r.kindNotSaved, undefined);
  assert.equal(sb.sent.length, 1);
  const row = sb.sent[0].row;
  assert.equal(row.kind, 'staff');
  assert.deepEqual(sb.sent[0].opts, { onConflict: 'id' });
  assert.equal(row.location_id, 'loc-1');
  assert.equal(row.name, 'Staff meal');
  assert.equal(row.requires_manager, true);
  const sb2 = fakeClient([]);
  await make(sb2)({ ...FORM, kind: 'vip' }, 'loc-1');
  assert.equal(sb2.sent[0].row.kind, null, 'an unknown kind goes as an ordinary discount, never a CHECK refusal');
  const sb3 = fakeClient([]);
  await make(sb3)({ ...FORM, kind: undefined }, 'loc-1');
  assert.ok('kind' in sb3.sent[0].row && sb3.sent[0].row.kind === null, 'a discount with no kind clears it');
});

test('upsertDiscount: no kind column yet, so it saves once more without it and says kindNotSaved', async () => {
  const make = liftUpsertDiscount();
  const sb = fakeClient([MISSING, { data: null, error: null }]);
  const r = await make(sb)(FORM, 'loc-1');
  assert.equal(sb.sent.length, 2, 'exactly one retry');
  assert.equal(r.error, null);
  assert.equal(r.kindNotSaved, true);
  const [first, second] = sb.sent.map((x) => x.row);
  assert.equal('kind' in second, false, 'the retry leaves the column out');
  const { kind: _k, ...firstWithout } = first;
  assert.deepEqual(second, firstWithout, 'everything else is the same row');
  // 42703 is the same answer from Postgres itself
  const sb2 = fakeClient([{ error: { code: '42703', message: 'column "kind" of relation "discounts" does not exist' } }]);
  assert.equal((await make(sb2)(FORM, 'loc-1')).kindNotSaved, true);
  // the retry refused too: the error comes back (the screen says NOT saved), never swallowed
  const refused = { code: '42501', message: 'permission denied' };
  const sb3 = fakeClient([MISSING, { data: null, error: refused }]);
  const r3 = await make(sb3)(FORM, 'loc-1');
  assert.equal(r3.error, refused);
  assert.equal(sb3.sent.length, 2, 'never a third write');
});

test('upsertDiscount: any other refusal is not retried', async () => {
  const make = liftUpsertDiscount();
  for (const error of [{ code: '23514', message: 'violates check constraint "discounts_kind_known"' }, { code: '42501', message: 'row-level security' }, { code: 'PGRST204', message: "Could not find the 'scope' column" }]) {
    const sb = fakeClient([{ data: null, error }]);
    const r = await make(sb)(FORM, 'loc-1');
    assert.equal(sb.sent.length, 1);
    assert.equal(r.error, error);
    assert.equal(r.kindNotSaved, undefined);
  }
});

// ── Every surface that makes a discount carries presetId and kind (contract 3.1) ────────────────

test('SyncBridge and venueDiscountList carry the kind to the tills', () => {
  const sb = read('../sync/SyncBridge.jsx');
  assert.match(sb, /^import \{ cleanDiscountKind \} from '\.\.\/lib\/discountKinds';$/m);
  const presets = between(sb, 'patch.discountPresets = discRes.data.map(d => ({', '}));');
  assert.match(presets, /id: d\.id, name: d\.name, label: d\.name, locationId,/, 'the venue pin stays');
  assert.match(presets, /kind: cleanDiscountKind\(d\.kind\),/);
  const list = venueDiscountList([{ id: 'p1', name: 'Staff meal', type: 'percent', value: 50, kind: 'staff' }, { id: 'p2', name: 'NHS', type: 'percent', value: 10 }]);
  assert.deepEqual(list.map((d) => d.kind), ['staff', null]);
});

test('DiscountModal: a preset discount carries presetId and kind; a custom one carries null for both', () => {
  const src = read('../components/DiscountModal.jsx');
  const emit = between(src, 'onConfirm({', '});');
  assert.match(emit, /id:`disc-\$\{Date\.now\(\)\}`, label, type, value, scope: scopeVal,/, 'the old keys are unchanged');
  assert.match(emit, /itemUids: scopeVal==='items' \? activeItems\.map\(i=>i\.uid\) : null,/);
  assert.match(emit, /amount, manager: approverStamp\(mgr\),/);
  assert.match(emit, /presetId: selected==='custom' \? null : \(preset\?\.id \?\? null\),/);
  assert.match(emit, /kind: selected==='custom' \? null : \(preset\?\.kind \?\? null\),/);
  // the preset is the venue's own list, which carries the kind
  assert.match(src, /const PRESETS = venueDiscountList\(discountPresets\);/);
  assert.match(src, /const preset {2}= PRESETS\.find\(p=>p\.id===selected\);/);
});

test('the till item path, both MPOS paths and the bar tab carry presetId and kind', () => {
  const pos = read('../surfaces/POSSurface.jsx');
  assert.ok(pos.includes("if (item) addItemDiscount(activeTableId, uid, { id:`disc-${uid}`, label:disc.label, type:disc.type, value:disc.value, presetId:disc.presetId ?? null, kind:disc.kind ?? null });"));
  // a check level discount from the modal goes to the store whole
  assert.match(pos, /if \(activeTableId\) addCheckDiscount\(activeTableId, disc\);\n\s+else addWalkInDiscount\(disc\);/);
  const mItem = read('../surfaces/mpos/MItemActions.jsx');
  assert.ok(mItem.includes('addItemDiscount(activeTableId || null, item.uid, { id:d.id, label:d.label, type:d.type, value:d.value, presetId:d.id, kind:d.kind ?? null });'));
  assert.match(mItem, /const ladder = venueDiscountList\(venuePresets\);/);
  const mOrder = read('../surfaces/mpos/MOrderActions.jsx');
  assert.match(mOrder, /label: d\.label, type: d\.type, value: d\.value, scope: 'check',\n(?:\s+\/\/[^\n]*\n)?\s+presetId: d\.id, kind: d\.kind \?\? null,/, 'after the pinned parity text');
  assert.match(mOrder, /const ladder = venueDiscountList\(venuePresets\);/);
  // the bar tab passes the whole emitted object (presetId and kind ride along) to addTabDiscount
  const bar = read('../surfaces/BarSurface.jsx');
  const conf = between(bar, 'onConfirm={(disc) => {', 'setShowTabDiscount(false);');
  assert.match(conf, /\? \{ \.\.\.disc, scope: 'check', type: 'amount', value: Number\(disc\.amount\) \|\| 0, itemUids: null \}\n\s+: disc;/);
  assert.match(conf, /useStore\.getState\(\)\.addTabDiscount\(activeTab\.id, d\);/);
});

// ── Totals and net of VAT never move ─────────────────────────────────────────────────────────────

test('presetId and kind survive the store, the close and the row, and change no total or net of VAT', () => {
  const mgr = { id: 's1', name: 'Manager A', role: 'Manager' };
  const plainCheck = { id: 'disc-1', label: 'Staff meal', type: 'percent', value: 50, scope: 'check', itemUids: null, amount: 4, manager: mgr };
  const plainItem = { id: 'disc-u2', label: 'Comp', type: 'percent', value: 100 };
  const withKinds = (d, presetId, kind) => ({ ...d, presetId, kind });
  const items = (itemDisc) => [
    { uid: 'u1', itemId: 'burger', price: 6, qty: 1 },
    { uid: 'u2', itemId: 'chips', price: 2, qty: 1, discount: itemDisc },
  ];
  // the store's scrub and the close's stamp keep the keys
  const scrubbed = scrubDiscount(withKinds({ ...plainCheck, manager: { ...mgr, pin: '1234' } }, 'p-staff', 'staff'));
  assert.equal(scrubbed.presetId, 'p-staff');
  assert.equal(scrubbed.kind, 'staff');
  assert.deepEqual(scrubbed.manager, mgr);
  const stamped = stampDiscountAmounts(items(plainItem), [withKinds(plainCheck, 'p-staff', 'staff')]);
  assert.equal(stamped[0].presetId, 'p-staff');
  assert.equal(stamped[0].kind, 'staff');
  assert.equal(lineAfterItemDiscount(items(withKinds(plainItem, 'p-comp', 'comp'))[1]), lineAfterItemDiscount(items(plainItem)[1]));
  // the same check closed with and without the new keys: the rows differ only by those keys
  const close = (checkDisc, itemDisc) => ({
    id: 'chk-9', ref: 'R1', orderType: 'dine-in', items: items(itemDisc), discounts: [checkDisc],
    subtotal: 8, service: 0, tip: 0, taxAmount: 0.5, total: 3, method: 'cash', closedAt: Date.parse('2026-10-22T12:00:00Z'),
    tenders: [{ method: 'cash', amount: 3 }],
  });
  const before = closedCheckRow(close(plainCheck, plainItem), 'loc-1');
  const after = closedCheckRow(close(withKinds(plainCheck, 'p-staff', 'staff'), withKinds(plainItem, 'p-comp', 'comp')), 'loc-1');
  assert.equal(after.discounts[0].presetId, 'p-staff');
  assert.equal(after.discounts[0].kind, 'staff');
  assert.equal(after.items[1].discount.kind, 'comp');
  const without = (d) => { const out = { ...d }; delete out.presetId; delete out.kind; return out; };
  const strip = (row) => ({
    ...row,
    discounts: row.discounts.map(without),
    items: row.items.map((i) => (i.discount ? { ...i, discount: without(i.discount) } : i)),
    closed_at: null,
  });
  assert.deepEqual(strip(after), strip(before), 'nothing else in the row changes');
  // net of VAT, VAT and gross are identical (the one sales rule the day totals use): chips comped,
  // half off the burger, 3.00 cash with 0.50 VAT in it
  assert.deepEqual(checkSalesParts(before), { net: 2.5, vat: 0.5, gross: 3 });
  assert.deepEqual(checkSalesParts(after), checkSalesParts(before));
  assert.equal(after.discounts[0].amount, 3, 'the stamped amount is the same 50% of the burger');
  // a custom discount carries null for both and is still the same money
  const custom = closedCheckRow(close(withKinds(plainCheck, null, null), plainItem), 'loc-1');
  assert.deepEqual(checkSalesParts(custom), checkSalesParts(before));
});
