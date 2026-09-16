/**
 * printer.golden.test.js: the ESC/POS path is byte identical before and after the
 * dialect refactor (v5.8.84).
 *
 * fixtures/printer.golden.bytes.json was captured from the UNTOUCHED v5.8.83 src/lib/printer.js
 * (its EscPosBuilder and template functions, with the Supabase imports stubbed) for the
 * inputs in fixtures/printer.golden.inputs.json, with the clock frozen at the timestamp
 * below and the zone pinned below. The new path (printDoc.js + printerDialects.js, escpos dialect, 42 columns) must
 * produce exactly those bytes: that is what Provo's Sunmi NT311 and every Epson receive.
 * Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCustomerReceiptDoc, buildMerchantTipSlipDoc, buildKitchenTicketDoc, buildFireCourseTicketDoc,
  buildTransferNoticeTicketDoc, buildTestPageDoc,
} from './printDoc.js';
import { encodeEscPos, cashDrawerBytes, resolvePrinterSpec, EscPosBuilder } from './printerDialects.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The golden bytes carry the receipt's printed date and time, which the builders format in the
// LOCAL zone. They were captured on the Mac (America/Los_Angeles); the CI runner is UTC, where
// the same frozen instant prints a different time. Pin the zone so the comparison is the same
// everywhere (Node applies a TZ change at runtime, and every Date here is made inside a test).
process.env.TZ = 'America/Los_Angeles';
const GOLDEN = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/printer.golden.bytes.json'), 'utf8'));
const INPUTS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/printer.golden.inputs.json'), 'utf8'));

// Same frozen clock as the capture harness: builders call new Date() and Date.now().
const FIXED = new Date('2026-09-16T14:05:09Z').getTime();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED])); }
  static now() { return FIXED; }
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const latin = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
const ESCPOS_80 = resolvePrinterSpec({ model: 'sunmi-nt311', paperWidth: 80 });

function withFrozenClock(fn) {
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

function encode(doc) { return hex(encodeEscPos(doc, ESCPOS_80)); }

test('escpos spec for an 80mm Sunmi is 42 columns, exactly what the old builders used', () => {
  assert.equal(ESCPOS_80.dialect, 'escpos');
  assert.equal(ESCPOS_80.cols, 42);
  assert.equal(resolvePrinterSpec(null).cols, 42);
  assert.equal(resolvePrinterSpec({ model: 'epson-tm-m30' }).cols, 42);
});

test('customer receipts are byte identical (UK VAT, US exclusive tax, delivery channel)', () => {
  withFrozenClock(() => {
    assert.equal(encode(buildCustomerReceiptDoc(INPUTS.receipt_uk, { cols: 42 })), GOLDEN.receipt_uk);
    assert.equal(encode(buildCustomerReceiptDoc(INPUTS.receipt_us, { cols: 42 })), GOLDEN.receipt_us);
    assert.equal(encode(buildCustomerReceiptDoc(INPUTS.receipt_delivery, { cols: 42 })), GOLDEN.receipt_delivery);
  });
});

test('merchant tip slip is byte identical', () => {
  withFrozenClock(() => {
    assert.equal(encode(buildMerchantTipSlipDoc(INPUTS.tip_slip, { cols: 42 })), GOLDEN.tip_slip);
  });
});

test('kitchen tickets are byte identical (courses, delivery block, sticker mode)', () => {
  withFrozenClock(() => {
    assert.equal(encode(buildKitchenTicketDoc(INPUTS.kitchen, { cols: 42 })), GOLDEN.kitchen);
    assert.equal(encode(buildKitchenTicketDoc(INPUTS.kitchen_delivery, { cols: 42 })), GOLDEN.kitchen_delivery);
    assert.equal(encode(buildKitchenTicketDoc(INPUTS.kitchen_sticker, { cols: 42 })), GOLDEN.kitchen_sticker);
  });
});

test('fire course marker and transfer notice are byte identical', () => {
  withFrozenClock(() => {
    assert.equal(encode(buildFireCourseTicketDoc(INPUTS.fire_course, { cols: 42 })), GOLDEN.fire_course);
    assert.equal(encode(buildTransferNoticeTicketDoc(INPUTS.transfer, { cols: 42 })), GOLDEN.transfer);
  });
});

test('the bare test page is byte identical; the described one keeps the same text checks', () => {
  withFrozenClock(() => {
    assert.equal(encode(buildTestPageDoc(null, { cols: 42 })), GOLDEN.test_page);
    const described = latin(encodeEscPos(buildTestPageDoc({
      printer: { name: 'Counter', address: '10.0.0.104', port: 9100, model: 'sunmi-nt311' },
      spec: ESCPOS_80, version: '5.8.84', sentFrom: 'Android till (direct)',
    }, { cols: 42 }), ESCPOS_80));
    for (const s of ['SERV OS', 'Sunmi NT311', 'ESC/POS (escpos)', '10.0.0.104:9100', '80mm, 42 columns', 'Android till (direct)', 'v5.8.84', 'Bold text', 'TOTAL']) {
      assert.ok(described.includes(s), `test page should say ${s}`);
    }
  });
});

test('the ESC/POS cash drawer pulse is unchanged: ESC @ then ESC p 0 25 25', () => {
  assert.equal(hex(cashDrawerBytes(ESCPOS_80)), GOLDEN.cash_drawer);
  assert.equal(GOLDEN.cash_drawer, '1b401b70001919');
  const b = new EscPosBuilder(); b.init().cashDrawer();
  assert.equal(hex(b.toBytes()), GOLDEN.cash_drawer);
});

test('a 58mm ESC/POS printer gets 32 columns without changing anything else', () => {
  const spec58 = resolvePrinterSpec({ model: 'sunmi-nt310', paperWidth: 80 });   // model fixes the paper
  assert.equal(spec58.paper, 58);
  assert.equal(spec58.cols, 32);
  const doc = buildKitchenTicketDoc(INPUTS.kitchen, { cols: 32 });
  const text = latin(encodeEscPos(doc, spec58));
  assert.ok(text.includes('='.repeat(32) + '\n'));
  assert.ok(!text.includes('='.repeat(33)));
});
