// node --test: US basics batch 7 (5.12.57), stock units and purchasing at a US site.
//   1. the US volume units convert as US units; a UK site's units are the 13 it always had
//   2. the import reads 'gallon' as the US gallon at a US site, the UK one at a UK site
//   3. the invoice reader is told a US site's country, currency and month first dates
//   4. a US site's purchase tax stays in the cost (no rate comes off, no sales rate offered)
//   5. the supplier email in each country's words
//   6. the guard: no 'VAT' in the batch 7 files' words without the site's tax word or a UK gate

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UNITS, US_UNITS, ALL_UNITS, globalFactor, isKnownUnit, unitDimension } from './units.js';
import { convert } from './conversion.js';
import { unitPickList, dbHasUsUnits, stockTaxWords, purchaseRateDec, purchaseTaxHint, stockPlaceholders, isUsSite, US_UNITS_PENDING } from './stockRegion.js';
import { unitOf, packOf, stageFile, mapFile, missingWords, fieldWordsFor, FIELD_WORDS } from './importMappers.js';
import { invoiceScanSystem, invoiceScanAsk } from './invoiceScanPrompt.js';
import { purchaseTaxChoices, vatChoices, sameCountrySiteIds, itemFieldWords } from './itemPageRules.js';
import { usualSixFor, USUAL_SIX } from './areaRules.js';
import { lineUnitOptions, recipeFieldWords } from './recipeRules.js';
import { unlistedLineCheck } from './poItemList.js';
import { HEADERS_MULTI_OF } from './purchasingWords.js';
import { exportPriceRows } from './supplierListRules.js';
import { purchaseNet } from '../tax.js';
import { poEmailHtml, poCsvRows, poEmailWords, usDay, CSV_HEADER } from '../../../supabase/functions/_shared/poSend.ts';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const ALL_US = Object.keys(US_UNITS);
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// ── 1. units ────────────────────────────────────────────────────────────────────────────────────

test('US units convert as US units: gallon 3785.41 ml, fl oz 29.5735, quart 946.353, cup 236.588, pint 473.176', () => {
  assert.equal(round(globalFactor('gal_us', 'ml'), 2), 3785.41);
  assert.equal(round(globalFactor('floz_us', 'ml'), 4), 29.5735);
  assert.equal(round(globalFactor('qt_us', 'ml'), 3), 946.353);
  assert.equal(round(globalFactor('cup_us', 'ml'), 3), 236.588);
  assert.equal(round(globalFactor('pt_us', 'ml'), 3), 473.176);
  assert.equal(round(globalFactor('gal_us', 'qt_us'), 9), 4, 'four quarts to the gallon');
  assert.equal(round(globalFactor('gal_us', 'floz_us'), 9), 128, '128 fl oz to the gallon');
  assert.equal(round(convert(2, 'gal_us', 'l'), 5), 7.57082, 'the conversion engine knows them');
  for (const c of ALL_US) { assert.ok(isKnownUnit(c), c); assert.equal(unitDimension(c), 'VOLUME'); }
  // and the UK ones never moved
  assert.equal(globalFactor('gal', 'ml'), 4546.09);
  assert.equal(globalFactor('pt', 'ml'), 568.26125);
  assert.equal(globalFactor('floz', 'ml'), 28.4130625);
});

test('UNITS is still the UK 13, exactly; ALL_UNITS adds the five US ones', () => {
  assert.deepEqual(Object.keys(UNITS), ['each', 'dozen', 'mg', 'g', 'kg', 'oz', 'lb', 'ml', 'cl', 'l', 'floz', 'pt', 'gal']);
  assert.deepEqual(UNITS.gal, { dimension: 'VOLUME', toCanonical: 4546.09, label: 'gallon (UK)' });
  assert.deepEqual(Object.keys(ALL_UNITS), [...Object.keys(UNITS), 'floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us']);
});

test('a UK site keeps the UK units first and identical; a US site gets the US set first once the database has it', () => {
  const uk = unitPickList('GBP');
  assert.equal(uk.usPending, false);
  assert.deepEqual(uk.list.map((u) => ({ ...u })), Object.entries(UNITS).map(([code, u]) => ({ code, ...u })), 'the same list the pickers built from UNITS');
  assert.deepEqual(unitPickList('GBP', ALL_US).list, uk.list, 'a UK site never sees the US units');
  assert.deepEqual(unitPickList('EUR', ALL_US).list, uk.list, 'nor an Irish one');
  const pending = unitPickList('USD', ['each', 'g', 'ml']);
  assert.equal(pending.usPending, true, 'the SQL has not run: the UK set, and the words');
  assert.deepEqual(pending.list, uk.list);
  assert.equal(US_UNITS_PENDING, 'US units need a database update');
  assert.equal(unitPickList('USD', null).usPending, true, 'not read yet');
  const us = unitPickList('USD', new Set([...Object.keys(UNITS), ...ALL_US]));
  assert.equal(us.usPending, false);
  const vol = us.list.filter((u) => u.dimension === 'VOLUME').map((u) => u.code);
  assert.deepEqual(vol, ['floz_us', 'cup_us', 'pt_us', 'qt_us', 'gal_us', 'ml', 'cl', 'l', 'floz', 'pt', 'gal']);
  assert.ok(us.list.filter((u) => ['floz', 'pt', 'gal'].includes(u.code)).every((u) => / \(UK\)$/.test(u.label)), 'the UK ones say (UK)');
  assert.equal(dbHasUsUnits(['floz_us', 'cup_us', 'pt_us', 'qt_us']), false, 'all five or none');
});

test('the migration file: Ops only, a lock timeout, idempotent, a visible check, ASCII, no exclamation mark, the same figures', () => {
  const sql = read('../../../supabase/migrations/20261120c_OPS_stock_us_units.sql');
  const back = read('../../../supabase/migrations/20261120c_OPS_stock_us_units_ROLLBACK.sql');
  for (const t of [sql, back]) {
    assert.match(t, /to_regclass\('public\.billing_state'\) is not null then\s+raise exception/);
    assert.match(t, /set local lock_timeout = '3s';/);
    assert.match(t, /-- VISIBLE CHECK/);
    assert.ok([...t].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only');
    assert.doesNotMatch(t, /!/, 'no exclamation mark');
  }
  assert.match(sql, /on conflict \(code\) do nothing;/);
  for (const [code, u] of Object.entries(US_UNITS)) {
    assert.match(sql, new RegExp(`\\('${code}',\\s+'VOLUME', ${String(u.toCanonical).replace('.', '\\.')},\\s+'${u.label.replace(/[()]/g, '\\$&')}'\\)`), code);
  }
});

test('recipe lines of an item counted in a US unit offer the US units and metric, never the UK imperial ones', () => {
  assert.deepEqual(lineUnitOptions({ base_unit: 'gal_us' }).map((o) => o.token), ['gal_us', 'ml', 'cl', 'l', 'floz_us', 'cup_us', 'pt_us', 'qt_us']);
  assert.deepEqual(lineUnitOptions({ base_unit: 'ml' }).map((o) => o.token), ['ml', 'cl', 'l', 'floz', 'pt', 'gal'], 'a UK item as before');
});

// ── 2. import ───────────────────────────────────────────────────────────────────────────────────

test('import reads "gallon" as the US gallon at a US site and the UK one at a UK site', () => {
  assert.equal(unitOf('gallon', 'USD'), 'gal_us');
  assert.equal(unitOf('Gallons', 'USD'), 'gal_us');
  assert.equal(unitOf('pint', 'USD'), 'pt_us');
  assert.equal(unitOf('fl oz', 'USD'), 'floz_us');
  assert.equal(unitOf('qt', 'USD'), 'qt_us');
  assert.equal(unitOf('quart', 'USD'), 'qt_us');
  assert.equal(unitOf('cup', 'USD'), 'cup_us');
  assert.equal(unitOf('#', 'USD'), 'lb', '# is pounds');
  assert.equal(unitOf('UK gallon', 'USD'), 'gal', 'the UK one stays readable by name');
  // a UK site: exactly as before
  assert.equal(unitOf('gallon'), 'gal');
  assert.equal(unitOf('gallon', 'GBP'), 'gal');
  assert.equal(unitOf('pint', 'GBP'), 'pt');
  assert.equal(unitOf('fl oz', 'GBP'), 'floz');
  assert.equal(unitOf('qt', 'GBP'), undefined);
  assert.equal(unitOf('#', 'GBP'), undefined);
});

test('import packs at a US site: 4/1 gal, cs of 12, cs 12, 50#; a UK site reads as before', () => {
  assert.deepEqual(packOf('4/1 gal', 'USD'), { pack_qty: 4, inner_qty: 1, inner_unit: 'gal_us' });
  assert.deepEqual(packOf('6 x 1 gallon', 'USD'), { pack_qty: 6, inner_qty: 1, inner_unit: 'gal_us' });
  assert.deepEqual(packOf('cs of 12', 'USD'), { pack_qty: 12, inner_qty: 1, inner_unit: null });
  assert.deepEqual(packOf('cs 12', 'USD'), { pack_qty: 12, inner_qty: 1, inner_unit: null });
  assert.deepEqual(packOf('50#', 'USD'), { pack_qty: 1, inner_qty: 50, inner_unit: 'lb' });
  assert.deepEqual(packOf('6 x 1 gallon', 'GBP'), { pack_qty: 6, inner_qty: 1, inner_unit: 'gal' });
  assert.equal(packOf('4/1 gal'), undefined, 'a UK site never read that and still does not');
  assert.equal(packOf('cs of 12'), undefined);
  assert.equal(packOf(''), null);
  assert.equal(packOf(undefined, 'USD'), null);
});

test('a whole file: the same rows stage US units at a US site and UK units at a UK site; the words follow', () => {
  const table = [['Name', 'Base unit', 'Purchase VAT'], ['Whole milk', 'gallon', 'zzz']];
  const mapped = mapFile(table, { source: 'csv', kinds: ['items'] });
  const us = stageFile(mapped, { currency: 'USD' });
  const uk = stageFile(mapped, { currency: 'GBP' });
  const none = stageFile(mapped);
  assert.equal(us.rows[0].data.base_unit, 'gal_us');
  assert.equal(uk.rows[0].data.base_unit, 'gal');
  assert.deepEqual(none, uk, 'no currency is the UK reading, exactly as before');
  assert.match(us.problems[0].words, /is not a tax rate/);
  assert.match(uk.problems[0].words, /is not a VAT rate/);
  assert.equal(missingWords(['purchase_vat', 'till_product']), 'These columns are missing: Purchase VAT, Till product.');
  assert.equal(missingWords(['purchase_vat', 'till_product'], 'USD'), 'These columns are missing: Purchase tax, POS item.');
  assert.equal(fieldWordsFor('GBP'), FIELD_WORDS);
});

// ── 3. the invoice reader ───────────────────────────────────────────────────────────────────────

test('the invoice prompt carries the country, currency and month first dates for a US site', () => {
  const us = invoiceScanSystem('USD');
  assert.match(us, /restaurant in the United States/);
  assert.match(us, /USD \(US dollars\)/);
  assert.match(us, /month first \(MM\/DD\/YYYY\): 03\/11\/2026 is 11 March 2026, so invoice_date is "2026-03-11"/);
  assert.match(us, /"currency": "USD"\|string\|null/);
  assert.match(us, /before sales tax/);
  assert.doesNotMatch(us, /VAT|UK/);
  assert.match(invoiceScanAsk('USD'), /month first/);
  // the UK text is word for word what the reader was told before
  const uk = invoiceScanSystem('GBP');
  assert.equal(invoiceScanSystem(null), uk);
  assert.match(uk, /^You extract structured data from a supplier invoice or delivery note for a UK hospitality business\./);
  assert.match(uk, /"currency": "GBP"\|string\|null/);
  assert.match(uk, /\(ex-VAT if shown separately\)/);
  assert.equal(invoiceScanAsk('GBP'), 'Extract this invoice as JSON per the schema.');
  assert.match(invoiceScanSystem('EUR'), /Ireland[\s\S]*EUR[\s\S]*day first/);
});

test('the scan route and the screens send the site currency; the review says when the invoice reads in another one', () => {
  const api = read('../../../api/stock-invoice-scan.js');
  assert.match(api, /system: invoiceScanSystem\(siteCurrency\)/);
  assert.match(api, /text: invoiceScanAsk\(siteCurrency\)/);
  assert.doesNotMatch(api, /for a UK hospitality business/, 'the words live in invoiceScanPrompt.js now');
  const pur = read('./purchasing.js');
  assert.match(pur, /export const scanInvoice = async \(imageBase64, mediaType, locationId = null, \{ currency = null \} = \{\}\)/);
  assert.match(pur, /\.\.\.\(cur \? \{ currency: cur \} : \{\}\)/);
  const inv = read('../../backoffice/sections/purchasing/InvoicesSite.jsx');
  assert.match(inv, /scanInvoice\(b64, f\.type, locId, \{ currency: cur \}\)/);
  assert.match(inv, /This invoice reads in \{read\}, but this site is in \{cur\}\./);
  assert.match(read('../../backoffice/sections/purchasing/CreditNoteModal.jsx'), /request\.location_id, \{ currency: code \}\)/);
});

// ── 4. purchase tax at a US site ────────────────────────────────────────────────────────────────

test('US purchase tax stays in the cost: no rate comes off a price, the sales rates are never offered', () => {
  assert.equal(purchaseRateDec('USD', 0.0725), 0);
  assert.equal(purchaseRateDec('GBP', 0.2), 0.2);
  assert.equal(purchaseNet(10.73, true, purchaseRateDec('USD', 0.0725)), 10.73, 'the price paid, tax in, is the cost');
  assert.equal(round(purchaseNet(12, true, purchaseRateDec('GBP', 0.2)), 6), 10, 'a UK site strips the VAT, as before');
  const rows = [{ rate: 0.0725 }, { rate: 0.2 }];
  assert.deepEqual(purchaseTaxChoices(rows, null, 'USD'), [{ value: null, label: 'None set' }], 'no sales rate offered');
  assert.deepEqual(purchaseTaxChoices(rows, 0.0725, 'USD'), [{ value: null, label: 'None set' }, { value: 0.0725, label: '7.25%' }], 'one already set can be cleared');
  assert.deepEqual(purchaseTaxChoices(rows, null, 'GBP'), vatChoices(rows, null), 'a UK site as before');
  assert.deepEqual(sameCountrySiteIds([{ id: 'uk1', currency: 'GBP' }, { id: 'us1', currency: 'USD' }, { id: 'uk2' }], 'GBP'), ['uk1', 'uk2'], 'never mix countries');
  assert.deepEqual(sameCountrySiteIds([{ id: 'uk1', currency: 'GBP' }, { id: 'us1', currency: 'USD' }], 'USD'), ['us1']);
  assert.equal(itemFieldWords('USD').purchase_vat_rate, 'Sales tax paid');
  assert.equal(itemFieldWords('GBP').purchase_vat_rate, 'Purchase VAT');
  assert.match(purchaseTaxHint('USD'), /stays in the cost/);
  assert.equal(purchaseTaxHint('GBP'), 'The VAT you pay when you buy it. Cost and GP always use the price without VAT.');
  assert.equal(purchaseTaxHint('GBP', { long: true }), 'The VAT you pay on this item when you buy it (e.g. 20% on alcohol). Cost & GP always use the ex-VAT price; this drives VAT on POs/invoices and your input-VAT reclaim.');
});

test('the engine: a US venue has no purchase rate map; an invoice line keeps its tax in the cost', () => {
  const data = read('./data.js');
  assert.match(data, /if \(isUsSite\(currency\)\) return out;/, 'fetchTaxRateMap answers no rates at a US venue');
  const inv = read('../../backoffice/sections/purchasing/InvoicesSite.jsx');
  assert.match(inv, /const costLineOf = \(l\) => netLineOf\(l\) \* \(1 \+ usPctOf\(l\)\);/);
  assert.match(inv, /const total = costLineOf\(l\);/);
  assert.match(inv, /tw\.keptInCost \? \{ \.\.\.l, lineTotal: Math\.round\(costLineOf\(l\) \* 100\) \/ 100, purchaseTaxRateId: null, priceIncludesTax: false \} : l/);
  // the maths the screen does for a US line: 100 before tax at 7.25% is a cost of 107.25
  const usPct = 7.25 / 100;
  assert.equal(round(purchaseNet(100, false, purchaseRateDec('USD', 0.2)) * (1 + usPct), 2), 107.25);
});

// ── 5. words and the supplier email ─────────────────────────────────────────────────────────────

test('the site tax words: UK words as before, US words at a US site', () => {
  assert.deepEqual([stockTaxWords('GBP').tax, stockTaxWords('GBP').exTax, stockTaxWords('GBP').incTax, stockTaxWords('GBP').noTax, stockTaxWords('GBP').Tax], ['VAT', 'ex VAT', 'inc VAT', 'No VAT', 'VAT']);
  assert.deepEqual([stockTaxWords('USD').tax, stockTaxWords('USD').exTax, stockTaxWords('USD').incTax, stockTaxWords('USD').noTax, stockTaxWords('USD').Tax], ['tax', 'before tax', 'with tax', 'No tax', 'Tax']);
  assert.equal(stockTaxWords('EUR').tax, 'VAT');
  assert.equal(HEADERS_MULTI_OF(1, '$', stockTaxWords('USD').exTax).at(-1), 'Line $ (before tax)');
  assert.equal(HEADERS_MULTI_OF(1, '£').at(-1), 'Line £ (ex VAT)');
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 1, innerUnit: 'each', unitPrice: 0 }, { exTax: 'before tax' }).reason, /one pack, before tax\./);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 1, innerUnit: 'each', unitPrice: 0 }).reason, /one pack, ex VAT\./);
  assert.equal(exportPriceRows([], { taxLabel: 'Tax' }).headers.find((h) => h.key === 'vat').label, 'Tax');
  assert.equal(exportPriceRows([]).headers.find((h) => h.key === 'vat').label, 'VAT');
  assert.equal(recipeFieldWords('USD').menu_item_id, 'POS item');
  assert.equal(recipeFieldWords('GBP').menu_item_id, 'Till product');
});

test('the US placeholders and starter areas; a UK site as before', () => {
  assert.deepEqual(stockPlaceholders('GBP'), { supplierEmail: 'orders@supplier.co.uk', glass: '175ml glass', bigEvent: 'Football on the big screen', dryStore: 'Dry store', tillProduct: 'Till product' });
  assert.deepEqual(stockPlaceholders('USD'), { supplierEmail: 'orders@supplier.com', glass: '6 fl oz glass', bigEvent: 'Big game on TV', dryStore: 'Dry storage', tillProduct: 'POS item' });
  assert.equal(usualSixFor('GBP'), USUAL_SIX);
  assert.deepEqual(usualSixFor('USD').map((a) => a.name), ['Beer cooler', 'Walk-in', 'Freezer', 'Dry storage', 'Bar', 'Kitchen']);
  assert.deepEqual(usualSixFor('USD').map((a) => a.kind), USUAL_SIX.map((a) => a.kind));
  assert.ok(isUsSite('usd') && !isUsSite('GBP') && !isUsSite(null));
});

test('the supplier email words per country: a US venue reads $, before tax and Tue, Nov 3, 2026', () => {
  const base = {
    venue: 'Provo', ref: 'PO-7', po: { subtotal: 1234.5, expected_date: '2026-11-03' }, supplier: {}, locRow: null,
    lines: [{ description: 'Milk', qty_packs: 2, pack_qty: 4, inner_qty: 1, inner_unit: 'gal_us', unit_price: 617.25 }], skuBySp: {}, anyCode: false,
  };
  const us = poEmailHtml({ ...base, currency: 'USD' });
  assert.match(us, /Order total \(before tax\): \$1,234\.50/);
  assert.match(us, /requested delivery Tue, Nov 3, 2026/);
  assert.match(us, />\$617\.25</);
  assert.doesNotMatch(us, /VAT/);
  const uk = poEmailHtml({ ...base, currency: 'GBP' });
  assert.match(uk, /Order total \(ex VAT\): 1234\.50/);
  assert.match(uk, /requested delivery Tue 3 Nov 2026/);
  assert.equal(poEmailHtml(base), uk, 'no currency read: the UK email, byte for byte');
  assert.match(poEmailHtml({ ...base, currency: 'USD', fee: 12.5 }), /Delivery fee: \$12\.50/);
  assert.match(poEmailHtml({ ...base, currency: 'GBP', fee: 12.5 }), /Delivery fee: 12\.50/);
  assert.deepEqual(poCsvRows(base.lines, { currency: 'USD' })[0], ['SKU', 'Item', 'Pack', 'Quantity', 'Unit price (USD)', 'Line total (USD)']);
  assert.deepEqual(poCsvRows(base.lines, { currency: 'GBP' })[0], CSV_HEADER);
  assert.equal(usDay('2026-11-03'), 'Tue, Nov 3, 2026');
  assert.equal(usDay('2026-03-11', { weekday: false }), 'Mar 11, 2026');
  assert.equal(poEmailWords('USD').money(1234.5), '$1,234.50');
  assert.equal(poEmailWords('GBP').money(1234.5), '1234.50');
  const fn = read('../../../supabase/functions/po-send/index.ts');
  assert.match(fn, /Credit asked for \(\$\{w\.exTax\}\): \$\{amt\(cr\.amount\)\}/);
  assert.match(fn, /select\('currency'\)\.eq\('id', cr\.location_id\)/);
});

// ── 6. the guard ────────────────────────────────────────────────────────────────────────────────

// The files batch 7 put the site's words into. A line whose words say VAT must also carry the site's
// tax word (tw. / stockTaxWords / taxWord / purchaseTaxHint) or sit behind a UK gate (keptInCost,
// tw.us, isUsSite), or be one of the UK only branches listed here (the US branch beside it says tax).
const GUARDED = [
  'backoffice/sections/purchasing/InvoicesSite.jsx', 'backoffice/sections/purchasing/PurchaseOrdersSite.jsx',
  'backoffice/sections/purchasing/InvoiceSplit.jsx', 'backoffice/sections/purchasing/CreditNoteModal.jsx',
  'backoffice/sections/purchasing/OrderDetailPane.jsx', 'backoffice/sections/purchasing/ReceivePanel.jsx',
  'backoffice/sections/OrderPad.jsx', 'backoffice/sections/StockReports.jsx', 'backoffice/sections/reports/StockPurchases.jsx',
  'backoffice/sections/stock/items/StockItemsSplit.jsx', 'backoffice/sections/stock/items/ItemDetailsTab.jsx',
  'backoffice/sections/stock/items/ItemSuppliersTab.jsx', 'backoffice/sections/stock/items/AddItemModal.jsx',
  'backoffice/sections/stock/suppliers/SupplierItemsTab.jsx',
];
const GATES = /tw\.|stockTaxWords|taxWord|purchaseTaxHint|keptInCost|isUsSite/;
const UK_BRANCHES = [
  // InvoicesSite: the UK rate picker; a US line gets a plain percent box instead (tw.keptInCost ? ... : <>)
  ['InvoicesSite.jsx', '<option value="">No VAT</option>'],
  ['InvoicesSite.jsx', 'title="Tick if the line total above already includes VAT"'],
  // PurchaseOrdersSite: the COLS constant, swapped for the site's words where it is drawn
  ['PurchaseOrdersSite.jsx', "['Line (ex VAT)', 'right'],"],
  // StockItemsSplit: rateDecFor is 0 at a US venue, so these show only at a UK one
  ['StockItemsSplit.jsx', 'This price <b>includes {formatRateLabel'],
  ['StockItemsSplit.jsx', "inc VAT → ${money(netPackOf(row))} net`"],
  ['StockItemsSplit.jsx', "VAT`}"],
  ['StockItemsSplit.jsx', 'No purchase VAT set for this item'],   // the UK side of tw.keptInCost ? ... : ...
  // OrderPad: the default of headersOne; the screen always passes tw.exTax
  ['OrderPad.jsx', "const headersOne = (symbol, exTax = 'ex VAT') =>"],
  // ItemSuppliersTab: the UK checkbox, hidden at a US site ({!tw.us && ...})
  ['ItemSuppliersTab.jsx', '/> The price includes VAT'],
  // StockPurchases: the UK segment words, swapped for tw.withTax at an all US report
  ['StockPurchases.jsx', "const VAT = [{ value: 'net', label: 'Net' }, { value: 'gross', label: 'With VAT' }];"],
  ['StockPurchases.jsx', "col('tax', 'VAT', 'money')"],
];

/** The code of a file with its comments taken out (line by line, so line numbers stay). */
function codeLines(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1').replace(/\{\s*\/\*.*?\*\/\s*\}/g, ''));
}

test('guard: no VAT in the batch 7 files\' words without the site\'s tax word or a UK gate', () => {
  const bad = [];
  for (const rel of GUARDED) {
    const name = rel.split('/').pop();
    codeLines(read(`../../${rel}`)).forEach((line, i) => {
      if (!/VAT/.test(line)) return;
      if (GATES.test(line)) return;
      if (UK_BRANCHES.some(([f, part]) => f === name && line.includes(part))) return;
      bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(bad, [], `a VAT word with no site tax word or UK gate:\n${bad.join('\n')}`);
});

test('guard: every batch 7 file is plain words, no long dash in what it added', () => {
  for (const rel of ['./stockRegion.js', './invoiceScanPrompt.js', '../../backoffice/sections/stock/UnitOptions.jsx', '../../backoffice/sections/stock/useSiteRegion.js', '../fixtures/usStockEdits.js']) {
    const t = read(rel);
    assert.doesNotMatch(t, /[\u2013\u2014]/, rel);
  }
});
