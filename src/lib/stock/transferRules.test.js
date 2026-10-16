/** transferRules.test.js: stock transfers (16 Oct 2026, builder B). The pure rules and the pins on the wiring. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  TRANSFER_STATUS_WORDS, TRANSFER_FILTERS, uomCtxOf, transferUnitsFor, defaultTokenOf, fmtQtyOf,
  transferDirection, transferHeadline, transferMatchesFilter, validateTransferDraft, buildTransferLines,
  lineWarnings, transferValue, receivePlan, matchCandidates, receiveLineUpdates, linesText, cancelText, movedText, transferNote,
} from './transferRules.js';
import { transferPlan, matchTransferLines, canReceive } from './areaRules.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const sqlCode = (src) => src.split('\n').filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/\s--.*$/, '')).join('\n');
const noDashes = (text, what) => assert.doesNotMatch(text, /[–—]/, `${what}: no long dashes`);

const HOME = 'venue-a', OTHER = 'venue-b';
const CELLAR = 'a-cellar', FRIDGE = 'a-fridge';
const areas = [{ id: CELLAR, name: 'Cellar', isReceiving: true }, { id: FRIDGE, name: 'Walk in fridge' }];
const areaName = (id) => areas.find((a) => a.id === id)?.name || '';
const venueName = (id) => ({ [HOME]: 'Coffee Boy Leeds', [OTHER]: 'Coffee Boy Barnsley' }[id] || '');

const milk = { id: 'i-milk', name: 'Whole milk', sku: 'MILK-2L', baseUnit: 'l', currentCost: 0.9, onHand: 20,
  packaging: [{ id: 'f-case', name: 'Case', qtyInBase: 12, isCountDefault: true }, { id: 'f-bottle', name: 'Bottle', qtyInBase: 2 }], conversions: [] };
const beans = { id: 'i-beans', name: 'Espresso beans', sku: 'BEAN-1K', baseUnit: 'kg', currentCost: 14, onHand: 6, packaging: [], conversions: [] };
const gone = { id: 'i-gone', name: 'Old syrup', sku: 'SYR-1', baseUnit: 'l', archivedAt: '2026-10-01', packaging: [], conversions: [] };
const itemsById = { [milk.id]: milk, [beans.id]: beans };

// ── units ─────────────────────────────────────────────────────────────────────

test('transferUnitsFor: packs largest first then the base unit; the default is the count pack', () => {
  assert.deepEqual(transferUnitsFor(milk).map((u) => u.label), ['Case', 'Bottle', 'l']);
  assert.deepEqual(transferUnitsFor(beans).map((u) => u.label), ['kg']);
  assert.equal(defaultTokenOf(milk), '@f-case');
  assert.equal(defaultTokenOf(beans), 'kg');
  assert.equal(fmtQtyOf(24, milk), '2 Case');
  assert.equal(fmtQtyOf(1.5, beans), '1.5 kg');
  assert.deepEqual(uomCtxOf(beans), { baseUnit: 'kg', formats: [], itemConversions: [] });
});

// ── direction, headline, filters ──────────────────────────────────────────────

test('transferDirection and transferHeadline: within, outgoing, incoming', () => {
  const within = { locationId: HOME, toLocationId: null, fromAreaId: CELLAR, toAreaId: FRIDGE };
  const out = { locationId: HOME, toLocationId: OTHER, fromAreaId: CELLAR };
  assert.equal(transferDirection(within, HOME), 'within');
  assert.equal(transferDirection({ ...within, toLocationId: HOME }, HOME), 'within');
  assert.equal(transferDirection(out, HOME), 'outgoing');
  assert.equal(transferDirection(out, OTHER), 'incoming');
  assert.equal(transferHeadline(within, { homeId: HOME, areaName, venueName }), 'Cellar to Walk in fridge');
  assert.equal(transferHeadline({ ...within, fromAreaId: null }, { homeId: HOME, areaName, venueName }), 'No area to Walk in fridge');
  assert.equal(transferHeadline(out, { homeId: HOME, areaName, venueName }), 'Sent to Coffee Boy Barnsley');
  assert.equal(transferHeadline(out, { homeId: OTHER, areaName, venueName }), 'Incoming from Coffee Boy Leeds');
  assert.equal(transferHeadline({ locationId: 'x', toLocationId: OTHER }, { homeId: OTHER, venueName }), 'Incoming from another venue');
});

test('transferMatchesFilter: open is sent or draft, done is done or received, cancelled is cancelled', () => {
  const by = (status) => TRANSFER_FILTERS.filter((f) => transferMatchesFilter({ status }, f.id)).map((f) => f.id);
  assert.deepEqual(by('SENT'), ['all', 'open']);
  assert.deepEqual(by('DRAFT'), ['all', 'open']);
  assert.deepEqual(by('DONE'), ['all', 'done']);
  assert.deepEqual(by('RECEIVED'), ['all', 'done']);
  assert.deepEqual(by('CANCELLED'), ['all', 'cancelled']);
  assert.deepEqual(Object.keys(TRANSFER_STATUS_WORDS).sort(), ['CANCELLED', 'DONE', 'DRAFT', 'RECEIVED', 'SENT']);
});

// ── the draft ─────────────────────────────────────────────────────────────────

test('validateTransferDraft: lines, two different areas within a venue, a venue when sending', () => {
  const lines = [{ inventoryItemId: milk.id, qtyBase: 12 }];
  assert.equal(validateTransferDraft({ mode: 'within', fromAreaId: CELLAR, toAreaId: FRIDGE, lines: [] }, { homeId: HOME }), 'Add at least one line with a quantity');
  assert.equal(validateTransferDraft({ mode: 'within', fromAreaId: CELLAR, toAreaId: CELLAR, lines }, { homeId: HOME }), 'Pick two different areas');
  assert.equal(validateTransferDraft({ mode: 'within', fromAreaId: CELLAR, toAreaId: '', lines }, { homeId: HOME }), 'Pick the area it leaves and the area it goes to');
  assert.equal(validateTransferDraft({ mode: 'within', fromAreaId: null, toAreaId: null, lines }, { homeId: HOME, hasAreas: false }), 'This venue has no stock areas yet: set them up on Stock areas first');
  assert.equal(validateTransferDraft({ mode: 'within', fromAreaId: CELLAR, toAreaId: FRIDGE, lines }, { homeId: HOME }), null);
  assert.equal(validateTransferDraft({ mode: 'venue', toLocationId: '', fromAreaId: CELLAR, lines }, { homeId: HOME }), 'Pick the venue to send to');
  assert.equal(validateTransferDraft({ mode: 'venue', toLocationId: HOME, fromAreaId: CELLAR, lines }, { homeId: HOME }), 'That is this venue: pick another, or move stock within this venue');
  assert.equal(validateTransferDraft({ mode: 'venue', toLocationId: OTHER, fromAreaId: '', lines }, { homeId: HOME, hasAreas: true }), 'Pick the area the stock leaves from');
  // a venue with no areas can still send to another venue
  assert.equal(validateTransferDraft({ mode: 'venue', toLocationId: OTHER, fromAreaId: null, lines }, { homeId: HOME, hasAreas: false }), null);
});

test('buildTransferLines: typed quantities become base units in the chosen unit; blanks are left out; a bad unit is an error', () => {
  const { lines, errors } = buildTransferLines({
    [milk.id]: { qty: '2', token: '@f-case' },        // 2 cases = 24 l
    [beans.id]: { qty: '1,5', token: 'kg' },           // a comma is a decimal point
    'i-missing': { qty: '1', token: 'each' },
  }, itemsById);
  assert.deepEqual(lines.map((l) => [l.inventoryItemId, l.qtyBase, l.nameSnapshot, l.skuSnapshot, l.baseUnit, l.sortOrder]),
    [[milk.id, 24, 'Whole milk', 'MILK-2L', 'l', 0], [beans.id, 1.5, 'Espresso beans', 'BEAN-1K', 'kg', 1]]);
  assert.deepEqual(errors, [{ itemId: 'i-missing', message: 'This item is not at this venue any more' }]);
  const blank = buildTransferLines({ [milk.id]: { qty: '', token: '@f-case' }, [beans.id]: { qty: '0', token: 'kg' } }, itemsById);
  assert.deepEqual(blank, { lines: [], errors: [] });
  const bad = buildTransferLines({ [beans.id]: { qty: '1', token: '@f-nope' } }, itemsById);
  assert.equal(bad.lines.length, 0);
  assert.equal(bad.errors[0].message, 'Espresso beans: that unit cannot be converted to kg');
  const notNumber = buildTransferLines({ [beans.id]: { qty: 'abc', token: 'kg' } }, itemsById);
  assert.equal(notNumber.errors[0].message, 'Espresso beans: the quantity must be a number');
  // a bottle is 2 l: the default unit is used when none is named
  assert.equal(buildTransferLines({ [milk.id]: { qty: '3', token: '@f-bottle' } }, itemsById).lines[0].qtyBase, 6);
  assert.equal(buildTransferLines({ [milk.id]: { qty: '1' } }, itemsById).lines[0].qtyBase, 12);
});

test('lineWarnings: a line that takes the from area below zero is named in count units; enough stock says nothing', () => {
  const holdings = { [milk.id]: { [CELLAR]: 12 }, [beans.id]: { [CELLAR]: 6 } };
  const lines = [{ inventoryItemId: milk.id, qtyBase: 24 }, { inventoryItemId: beans.id, qtyBase: 6 }];
  const w = lineWarnings(lines, CELLAR, { holdings, itemsById, areaName: 'Cellar', fmt: fmtQtyOf });
  assert.deepEqual(w, [{ itemId: milk.id, text: 'Cellar has 1 Case, you are moving 2 Case' }]);
  assert.deepEqual(lineWarnings(lines, null, { holdings, itemsById }), []);
  assert.deepEqual(lineWarnings([{ inventoryItemId: beans.id, qtyBase: 1 }], FRIDGE, { holdings, itemsById, areaName: 'Walk in fridge', fmt: fmtQtyOf }),
    [{ itemId: beans.id, text: 'Walk in fridge has 0 kg, you are moving 1 kg' }]);
});

test('transferValue: qty x cost, the line cost when it carries one, floored at zero per line', () => {
  const costById = { [milk.id]: 0.9, [beans.id]: 14 };
  assert.equal(Math.round(transferValue([{ inventoryItemId: milk.id, qtyBase: 24 }, { inventoryItemId: beans.id, qtyBase: 1.5 }], costById) * 100) / 100, 42.6);
  assert.equal(transferValue([{ inventoryItemId: milk.id, qtyBase: 10, unitCost: 1 }], costById), 10);
  assert.equal(transferValue([{ inventoryItemId: milk.id, qtyBase: 10, qtyReceivedBase: 8, unitCost: 1 }], costById), 8);
  assert.equal(transferValue([{ inventoryItemId: milk.id, qtyBase: -3, unitCost: 1 }], costById), 0);
});

// ── the receiving venue ───────────────────────────────────────────────────────

test('receivePlan: SKU first, then name, never archived; received defaults to sent; canReceive only when every line is matched or dropped', () => {
  const receiver = [
    { id: 'r-milk', name: 'Milk whole', sku: 'milk-2l' },           // SKU match (case and spacing aside)
    { id: 'r-beans', name: 'Espresso Beans', sku: 'OTHER' },        // name match
    gone,
  ];
  const sent = [
    { id: 'l1', nameSnapshot: 'Whole milk', skuSnapshot: 'MILK-2L', qtyBase: 24 },
    { id: 'l2', nameSnapshot: 'espresso beans', skuSnapshot: 'BEAN-1K', qtyBase: 1.5 },
    { id: 'l3', nameSnapshot: 'Old syrup', skuSnapshot: 'SYR-1', qtyBase: 2 },
    { id: 'l4', nameSnapshot: 'Nothing like it', skuSnapshot: null, qtyBase: 1, qtyReceivedBase: 0.5 },
  ];
  const plan = receivePlan(sent, receiver);
  assert.deepEqual(plan.lines.map((l) => [l.id, l.toInventoryItemId, l.matchedBy, l.qtyReceivedBase]),
    [['l1', 'r-milk', 'sku', 24], ['l2', 'r-beans', 'name', 1.5], ['l3', null, null, 2], ['l4', null, null, 0.5]]);
  assert.deepEqual(plan.unmatched, ['l3', 'l4']);
  assert.equal(plan.canReceive, false);
  const fixed = plan.lines.map((l) => (l.id === 'l3' ? { ...l, dropped: true } : l.id === 'l4' ? { ...l, toInventoryItemId: 'r-beans' } : l));
  assert.equal(canReceive(fixed), true);
  // the same rule as areaRules.matchTransferLines, which the SQL function then enforces
  assert.deepEqual(matchTransferLines(sent, receiver).unmatched, ['l3', 'l4']);
});

test('matchCandidates: this venue live items whose name, SKU or supplier code holds every word, a few at a time', () => {
  const list = [milk, beans, gone, { id: 'r-x', name: 'Oat milk', sku: 'OAT', supplierProducts: [{ supplierSku: 'BEAN-99' }] }];
  assert.deepEqual(matchCandidates('milk', list).map((i) => i.id), ['i-milk', 'r-x']);
  assert.deepEqual(matchCandidates('bean-99', list).map((i) => i.id), ['r-x']);
  assert.deepEqual(matchCandidates('oat milk', list).map((i) => i.id), ['r-x']);
  assert.deepEqual(matchCandidates('syrup', list), []);
  assert.equal(matchCandidates('', list, 2).length, 2);
});

test('receiveLineUpdates: the rows the receive step writes; a dropped line has no item and no quantity', () => {
  const rows = receiveLineUpdates([
    { id: 'l1', toInventoryItemId: 'r-milk', qtyBase: 24, qtyReceivedBase: 22.12346 },
    { id: 'l2', toInventoryItemId: 'r-beans', qtyBase: 1.5 },
    { id: 'l3', toInventoryItemId: 'r-x', qtyBase: 2, dropped: true },
  ]);
  assert.deepEqual(rows, [
    { id: 'l1', to_inventory_item_id: 'r-milk', qty_received_base: 22.1235, dropped: false },
    { id: 'l2', to_inventory_item_id: 'r-beans', qty_received_base: 1.5, dropped: false },
    { id: 'l3', to_inventory_item_id: null, qty_received_base: null, dropped: true },
  ]);
});

// ── words ─────────────────────────────────────────────────────────────────────

test('linesText, cancelText, movedText, transferNote: plain English, no long dashes', () => {
  assert.equal(linesText([{}, {}, { dropped: true }]), '3 lines, 1 dropped');
  assert.equal(linesText([{}]), '1 line');
  assert.equal(cancelText({ status: 'SENT', reference: 'TR-ABC123' }, 3, 'Cellar'), 'Cancel TR-ABC123? Its 3 lines go back into Cellar and the other venue will not receive it.');
  assert.equal(cancelText({ status: 'DRAFT', reference: 'TR-ABC123' }), 'Cancel TR-ABC123? Nothing has moved.');
  assert.equal(movedText([{ inventoryItemId: milk.id, qtyBase: 24 }], 'Cellar', 'Walk in fridge', itemsById), '2 Case of Whole milk moved from Cellar to Walk in fridge');
  assert.equal(movedText([{ inventoryItemId: milk.id, qtyBase: 24 }, { inventoryItemId: beans.id, qtyBase: 1 }], 'Cellar', 'Bar', itemsById), '2 lines moved from Cellar to Bar');
  assert.equal(transferNote('TR-ABC123'), 'Transfer TR-ABC123');
  for (const t of [linesText([{}]), cancelText({ status: 'SENT' }, 1, 'Cellar'), movedText([], 'a', 'b')]) noDashes(t, 'words');
});

// ── the pair a transfer posts (areaRules.transferPlan) ────────────────────────

test('transferPlan: OUT then IN per line, opposite signs, same cost, one key family, the item total unchanged', () => {
  const { movements, netByItem } = transferPlan([{ id: 'l1', itemId: milk.id, qtyBase: 24 }], CELLAR, FRIDGE, { [milk.id]: 0.9 }, 'T1');
  assert.deepEqual(movements.map((m) => [m.movementType, m.areaId, m.qtyBase, m.unitCost, m.idempotencyKey]),
    [['TRANSFER_OUT', CELLAR, -24, 0.9, 'transfer:T1:l1:out'], ['TRANSFER_IN', FRIDGE, 24, 0.9, 'transfer:T1:l1:in']]);
  assert.deepEqual(netByItem, { [milk.id]: 0 });
});

// ── pins on the wiring ────────────────────────────────────────────────────────

test('pin: transfers.js writes the head and lines first, then ONE call per leg to post_stock_transfer_leg', () => {
  const src = code(read('./transfers.js'));
  assert.match(src, /supabase\.rpc\('post_stock_transfer_leg', \{ p_transfer_id: transferId, p_leg: leg, p_by_name: byName \|\| null \}\)/);
  assert.match(src, /postTransferLeg\(made\.data\.id, 'both', draft\.byName\)/, 'within a venue: both legs in one transaction');
  assert.match(src, /postTransferLeg\(made\.data\.id, 'out', draft\.byName\)/, 'to another venue: the out leg at send');
  assert.match(src, /postTransferLeg\(transferId, 'in', byName\)/, 'receive: the in leg');
  assert.match(src, /postTransferLeg\(transferId, 'cancel', byName\)/, 'cancel: the sender takes it back');
  assert.match(src, /chunkArray\(lines, INSERT_CHUNK\)/, 'lines go in chunks of 200');
  assert.match(src, /data\?\.length === rows\.length \? null : new Error/, 'every chunk is checked for every row');
  assert.match(src, /\.eq\('transfer_id', transferId\)\.eq\('id', u\.id\)\.select\('id'\)/, 'every receive match write is checked');
  assert.match(src, /to_location_id: toLocationId,\s+inventory_item_id/, 'lines carry to_location_id so the receiver reads them through its own column');
  noDashes(read('./transfers.js'), 'transfers.js');
  noDashes(read('./transferRules.js'), 'transferRules.js');
});

test('pin: deliveries land in the chosen area, else the receiving area (purchasing.js); null before the migration', () => {
  const src = code(read('./purchasing.js'));
  assert.match(src, /import \{ fetchReceivingArea \} from '\.\/areas\.js';/);
  assert.match(src, /async function landingArea\(locationId, chosen\) \{\s+if \(chosen\) return chosen;\s+const \{ data \} = await fetchReceivingArea\(locationId\);\s+return data \|\| null;/);
  assert.match(src, /export const receivePurchaseOrder = async \(poId, locationId = null, receipts = null, \{ areaId = null \} = \{\}\)/);
  assert.match(src, /export const postInvoice = async \(header, lines, locationId = null, \{ areaId = null \} = \{\}\)/);
  assert.match(src, /sourceType, sourceId, idempotencyKey: idemKey, areaId: areaId \|\| null,/, 'applyReceipt passes the area to postStockMovement');
  assert.equal((src.match(/, landIn\);/g) || []).length, 2, 'both receive paths (order and invoice) pass the landing area');
  const areasSrc = code(read('./areas.js'));
  assert.match(areasSrc, /export const fetchReceivingArea = async[\s\S]*?const ok = await areasReady\(locationId\);\s+if \(!ok\) return \{ data: null, error: null \};/, 'no area before the migration, so nothing changes');
  const dataSrc = code(read('./data.js'));
  assert.match(dataSrc, /if \(m\.areaId && areasReadySync\(\) === true\) args\.p_area_id = m\.areaId;/, 'p_area_id is only ever sent once the migration is known to have run');
});

test('pin: the Ops tablet accept path and the Back Office panels go through receivePurchaseOrder / postInvoice with the landing area', () => {
  const ops = code(read('../ops/data.js'));
  assert.match(ops, /receivePurchaseOrder\(poId, locationId\)/, 'the tablet passes no area: receivePurchaseOrder resolves the receiving area itself');
  const po = read('../../backoffice/sections/PurchaseOrders.jsx');
  assert.match(po, /receivePurchaseOrder\(draft\.id, locId, receipts, \{ areaId: landArea \|\| null \}\)/);
  assert.match(po, /setLandArea\(areas\.find\(a => a\.isReceiving\)\?\.id \|\| ''\)/, 'the Lands in dropdown defaults to the receiving area');
  const inv = read('../../backoffice/sections/Invoices.jsx');
  assert.match(inv, /locId, \{ areaId: landArea \|\| null \}\)/);
  // the two older screens carry dashes from before; only the lines this change added are checked
  for (const f of [po, inv]) for (const line of f.split('\n')) if (/landArea|Lands in/.test(line)) noDashes(line, 'Lands in');
  noDashes(read('../../backoffice/sections/StockTransfers.jsx'), 'StockTransfers.jsx');
});

test('pin: the SQL function has the cancel leg and the two cancel columns, idempotent', () => {
  const mig = sqlCode(read('../../../supabase/migrations/20261016_OPS_stock_areas.sql'));
  assert.match(mig, /alter table public\.stock_transfers add column if not exists cancelled_by_name text;/);
  assert.match(mig, /alter table public\.stock_transfers add column if not exists cancelled_at timestamptz;/);
  assert.match(mig, /if p_leg not in \('out', 'in', 'both', 'cancel'\) then/);
  assert.match(mig, /or \(p_leg = 'cancel' and v_t\.status = 'CANCELLED'\) then\s+return jsonb_build_object\('ok', true, 'duplicate', true/, 'a second cancel is a duplicate, nothing moves twice');
  assert.match(mig, /if p_leg = 'cancel' and v_t\.status not in \('DRAFT', 'SENT'\) then/, 'never after received or done');
  assert.match(mig, /'transfer:' \|\| v_t\.id::text \|\| ':' \|\| v_l\.id::text \|\| ':cancel'/, 'the stock back key family');
  assert.match(mig, /'TRANSFER_IN',\s+coalesce\(v_l\.unit_cost, \(select current_cost from inventory_items where id = v_l\.inventory_item_id\), 0\),[\s\S]*?v_t\.from_area_id\);/, 'back into the area it left, at the cost it left with');
  assert.match(mig, /set status = 'CANCELLED', cancelled_by_name = p_by_name, cancelled_at = now\(\)/);
  // the areas.js mapper reads them
  assert.match(code(read('./areas.js')), /cancelledByName: r\.cancelled_by_name \|\| null, cancelledAt: r\.cancelled_at \|\| null,/);
});
