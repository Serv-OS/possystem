import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KIOSK_READY_ONLY, shortRef, kioskNotifyPlan, kioskReadySms } from './kioskNotify.js';

test('a new design kiosk skips the confirmed text and sends the ready text', () => {
  assert.deepEqual(kioskNotifyPlan({ event: 'confirmed', source: 'kiosk', kioskNewDesign: true }), { skip: KIOSK_READY_ONLY, shortNumber: false });
  assert.deepEqual(kioskNotifyPlan({ event: 'ready', source: 'kiosk', kioskNewDesign: true }), { skip: null, shortNumber: true });
});

test('old design kiosks, online and QR are unchanged', () => {
  for (const source of ['kiosk', 'online', 'qr', 'pos']) {
    for (const event of ['confirmed', 'ready']) {
      const plan = kioskNotifyPlan({ event, source, kioskNewDesign: source === 'kiosk' ? false : true });
      assert.deepEqual(plan, { skip: null, shortNumber: false }, `${source} ${event}`);
    }
  }
  assert.deepEqual(kioskNotifyPlan({ event: 'confirmed', source: 'kiosk' }), { skip: null, shortNumber: false });
});

test('shortRef mirrors db.js shortOrderRef', () => {
  assert.equal(shortRef('R1247'), '47');
  assert.equal(shortRef('R7'), '7');
  assert.equal(shortRef('R42'), '42');
  assert.equal(shortRef('OL-9'), 'OL-9');
  assert.equal(shortRef(12), 12);
});

test('ready text wording', () => {
  assert.equal(kioskReadySms('47', 'Oven and Tap'), 'Your order 47 is ready to collect at Oven and Tap.');
});

test('order-notify carries the same skip text and ready wording', () => {
  const src = fs.readFileSync(new URL('../../supabase/functions/order-notify/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes(`'${KIOSK_READY_ONLY}'`), 'skip text');
  assert.ok(src.includes('is ready to collect at ${venueName}.'), 'ready wording');
  assert.ok(src.includes("if (event === 'confirmed' && kioskV2) return json({ ok: true, skipped: KIOSK_READY_ONLY });"), 'skip before the ledger');
  // The skip sits before the replay ledger, so nothing is claimed for a skipped event. Since
  // v5.8.67 the ledger is location scoped (_shared/orderNotifyScope.js): the claim is chosen by
  // ledgerClaimFor, the legacy (ref, event) ledger is read through LEGACY_LEDGER_TABLE, the claim
  // row is upserted into claim.table, and the order_queue stamp comes last.
  const skipAt = src.indexOf('skipped: KIOSK_READY_ONLY');
  for (const marker of [
    'let claim = ledgerClaimFor(target);',
    '.from(LEGACY_LEDGER_TABLE)',
    '.from(claim.table)',
    '.update({ [claimCol]: new Date().toISOString() })',
  ]) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `order-notify ledger marker missing: ${marker}`);
    assert.ok(skipAt > 0 && skipAt < at, `the new design skip must come before ${marker}`);
  }
  // The design lookup finds the kiosk through the order's own venue, like the v5.8.67 scoping.
  assert.ok(src.includes(".eq('location_id', String(order.location_id || ''))"), 'closed_checks lookup scoped to the order venue');
});
