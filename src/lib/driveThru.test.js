/**
 * driveThru.test.js: every hard coded order type list in the app carries drive thru.
 * Run: `node --test src/lib/driveThru.test.js`.
 *
 * Drive thru (Peter, 16 Sep 2026) is the fifth order type. There is no single source of
 * truth for the order type list: the till, the kitchen, the TVs, pricing, tax, costing,
 * Back Office and the reports each keep their own copy. These tests read the source files
 * as text so a list one of them forgot cannot ship. The key is 'drive-thru' wherever the
 * kebab keys live, 'driveThru' where the pricing jsonb uses camelCase keys, and 'drivethru'
 * for the KDS board type and the SQL letters only key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// The text of a declaration: from `NAME = [` or `NAME = {` to the first `];` or `};` after it.
function declaration(src, name, file) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*[\\[{]`).exec(src);
  assert.ok(m, `${file}: ${name} is declared as an array or object`);
  const ends = [src.indexOf('];', m.index), src.indexOf('};', m.index)].filter(i => i >= 0);
  assert.ok(ends.length, `${file}: ${name} closes`);
  return src.slice(m.index, Math.min(...ends) + 2);
}

const has = (text, needle, where) => assert.ok(text.includes(needle), `${where} carries ${needle}`);
const hasRe = (text, re, where) => assert.ok(re.test(text), `${where} matches ${re}`);

// ── Foundation (this stage) ──────────────────────────────────────────────────

test('orderScreen/orderScreenStatus.js: ORDER_TYPES, orderTypeKey and the name placeholder pattern', () => {
  const src = read('./orderScreen/orderScreenStatus.js');
  hasRe(declaration(src, 'ORDER_TYPES', 'orderScreenStatus.js'), /key:\s*'drive-thru',\s*label:\s*'Drive thru'/, 'ORDER_TYPES');
  has(src, "case 'drivethru'", 'orderTypeKey');
  has(src, "case 'drivethrough'", 'orderTypeKey');
  has(src, 'drive\\\\s*-?\\\\s*thru|drive\\\\s*-?\\\\s*through', 'NAME_PLACEHOLDER_PATTERN');
});

test('orderScreen/keepPaidOrder.js: a paid drive thru order stays queued', () => {
  has(declaration(read('./orderScreen/keepPaidOrder.js'), 'KEEP_TYPES', 'keepPaidOrder.js'), "'drive-thru'", 'KEEP_TYPES');
});

test('menuPricing.js: CHANNEL_MAP maps every drive thru spelling to driveThru', () => {
  const map = declaration(read('./menuPricing.js'), 'CHANNEL_MAP', 'menuPricing.js');
  hasRe(map, /driveThru:\s*'driveThru'/, 'CHANNEL_MAP');
  hasRe(map, /'drive-thru':\s*'driveThru'/, 'CHANNEL_MAP');
  hasRe(map, /drive_thru:\s*'driveThru'/, 'CHANNEL_MAP');
  hasRe(map, /'drive-through':\s*'driveThru'/, 'CHANNEL_MAP');
});

test('tax.js and taxEngine.js: both engines carry the drive thru fallback to takeaway', () => {
  has(read('./tax.js'), "orderType === 'drive-thru'", 'taxOverrideFor');
  const eng = read('./taxEngine.js');
  has(eng, "orderType === 'drive-thru' && types.includes('takeaway')", 'lineAppliesToOrderType');
  has(eng, "orderType === 'drive-thru'", 'makeCascadeResolver');
});

test('stock/costing.js: RECIPE_ORDER_TYPES, labels and the normaliser', () => {
  const src = read('./stock/costing.js');
  has(declaration(src, 'RECIPE_ORDER_TYPES', 'costing.js'), "'drive-thru'", 'RECIPE_ORDER_TYPES');
  has(declaration(src, 'ORDER_TYPE_LABELS', 'costing.js'), "'drive-thru': 'Drive thru'", 'ORDER_TYPE_LABELS');
  has(src, "drivethru: 'drive-thru'", 'ORDER_TYPE_ALIASES');
  has(src, "drivethrough: 'drive-thru'", 'ORDER_TYPE_ALIASES');
  has(read('./stock/explode.js'), 'lineAppliesToOrderType(line, orderType, mr.lines)', 'explode.js (the till path reads the recipe like costing and the edge fn)');
});

test('supabase/functions/stock-deplete/index.ts mirrors costing.js', () => {
  const ts = read('../../supabase/functions/stock-deplete/index.ts');
  has(ts, "drivethru: 'drive-thru'", 'ORDER_TYPE_ALIASES');
  has(ts, "drivethrough: 'drive-thru'", 'ORDER_TYPE_ALIASES');
  has(ts, "recipeNamesOrderType(recipeLines, 'drive-thru')", 'lineAppliesToOrderType');
  has(ts, 'lineAppliesToOrderType(line, orderType, mr.lines)', 'explode');
});

test('supabase/migrations/20260917_OPS_drive_thru_order_screens.sql maps drivethru for the TVs', () => {
  const sql = read('../../supabase/migrations/20260917_OPS_drive_thru_order_screens.sql');
  has(sql, "when 'drivethru' then 'drive-thru'", '_osd_type_key');
  has(sql, "when 'drivethrough' then 'drive-thru'", '_osd_type_key');
  has(sql, 'drive\\s*-?\\s*thru|drive\\s*-?\\s*through', '_osd_name');
});

// ── Kitchen stage ────────────────────────────────────────────────────────────

test('kds/kdsTicket.js: KDS_TYPES has a drivethru board type and both normalisers know it', () => {
  const src = read('./kds/kdsTicket.js');
  const types = declaration(src, 'KDS_TYPES', 'kdsTicket.js');
  hasRe(types, /key:\s*'drivethru'/, 'KDS_TYPES');
  hasRe(types, /label:\s*'DRIVE THRU'/, 'KDS_TYPES');
  has(src, "case 'drivethru'", 'normaliseOrderType');
  hasRe(src, /case 'drive-thru':\s*return 'drivethru'/, 'kdsTypeKey');
});

test('printDoc.js: the kitchen ticket non table label regexes accept drive-thru (printer.js keeps no list)', () => {
  const src = read('./printDoc.js');
  const groups = src.match(/\^\(takeaway\|[^)]*\)/g) || [];
  assert.ok(groups.length >= 2, 'both non table label regexes are present');
  for (const g of groups) {
    for (const key of ['collection', 'delivery', 'counter', 'drive-thru']) has(g, key, 'printDoc.js non table label regex');
  }
  assert.ok(!read('./printer.js').includes('takeaway'), 'printer.js keeps no order type list of its own');
});

test('printDoc.js: both ESC/POS receipt headers print Drive thru, not the drive-thru key', () => {
  // The customer receipt and the merchant tip slip fall back from tableLabel to the order type.
  // The on screen receipt says "Drive thru", so paper must too; every other key prints as is.
  const headers = read('./printDoc.js').match(/check\?\.tableLabel\s*\|\|\s*\(check\?\.orderType === 'drive-thru' \? 'Drive thru' : check\?\.orderType\)/g) || [];
  assert.equal(headers.length, 2, 'both receipt builders map drive-thru to Drive thru');
});

// ── Till stage ───────────────────────────────────────────────────────────────

test('surfaces/POSSurface.jsx: the till segmented control lists drive thru', () => {
  const list = declaration(read('../surfaces/POSSurface.jsx'), 'ALL_ORDER_TYPES', 'POSSurface.jsx');
  has(list, "'drive-thru'", 'ALL_ORDER_TYPES');
  has(list, 'Drive thru', 'ALL_ORDER_TYPES');
  has(list, '🚗', 'ALL_ORDER_TYPES');
});

test('components/OrderTypeModal.jsx: TYPES lists drive thru', () => {
  hasRe(declaration(read('../components/OrderTypeModal.jsx'), 'TYPES', 'OrderTypeModal.jsx'), /id:\s*'drive-thru'/, 'TYPES');
});

test('surfaces/mpos/MNewOrder.jsx: TYPES lists drive thru', () => {
  hasRe(declaration(read('../surfaces/mpos/MNewOrder.jsx'), 'TYPES', 'MNewOrder.jsx'), /id:\s*'drive-thru'/, 'TYPES');
});

test('surfaces/OrdersHub.jsx: a Drive thru tab and colour', () => {
  const src = read('../surfaces/OrdersHub.jsx');
  hasRe(declaration(src, 'FILTER_TABS', 'OrdersHub.jsx'), /id:\s*'drive-thru'/, 'FILTER_TABS');
  hasRe(declaration(src, 'SECTION_COLORS', 'OrdersHub.jsx'), /'drive-thru':/, 'SECTION_COLORS');
});

// ── Back Office stage ────────────────────────────────────────────────────────

test('backoffice/sections/DeviceProfiles.jsx: the per till switch offers Drive thru', () => {
  const list = declaration(read('../backoffice/sections/DeviceProfiles.jsx'), 'ORDER_TYPES', 'DeviceProfiles.jsx');
  hasRe(list, /id:\s*'drive-thru'/, 'ORDER_TYPES');
  hasRe(list, /label:\s*'Drive thru'/, 'ORDER_TYPES');
  has(list, '🚗', 'ORDER_TYPES');
});

test('backoffice/sections/reports/OrderTypes.jsx: TYPE_STYLE has a drive thru row', () => {
  hasRe(declaration(read('../backoffice/sections/reports/OrderTypes.jsx'), 'TYPE_STYLE', 'OrderTypes.jsx'), /'drive-thru':/, 'TYPE_STYLE');
});

test('backoffice/BackOfficeApp.jsx: the dashboard label map names Drive thru', () => {
  hasRe(declaration(read('../backoffice/BackOfficeApp.jsx'), 'ORDER_TYPE_LABEL', 'BackOfficeApp.jsx'), /'drive-thru':\s*'Drive thru'/, 'ORDER_TYPE_LABEL');
});

test('backoffice/sections/TaxManager.jsx: both order type lists offer drive-thru', () => {
  const src = read('../backoffice/sections/TaxManager.jsx');
  has(declaration(src, 'ORDER_TYPES', 'TaxManager.jsx'), "'drive-thru'", 'ORDER_TYPES');
  has(declaration(src, 'PROFILE_ORDER_TYPES', 'TaxManager.jsx'), "'drive-thru'", 'PROFILE_ORDER_TYPES');
});

test('backoffice/sections/MenuManager.jsx: a Drive thru pricing row and tax override', () => {
  const src = read('../backoffice/sections/MenuManager.jsx');
  has(declaration(src, 'ORDER_TYPES_TAX', 'MenuManager.jsx'), "'drive-thru'", 'ORDER_TYPES_TAX');
  hasRe(src, /k:\s*'driveThru'/, 'pricing rows');
});

test('backoffice/sections/PerMenuPricingTiers.jsx: a driveThru tier field', () => {
  hasRe(declaration(read('../backoffice/sections/PerMenuPricingTiers.jsx'), 'CHANNELS', 'PerMenuPricingTiers.jsx'), /k:\s*'driveThru'/, 'CHANNELS');
});
