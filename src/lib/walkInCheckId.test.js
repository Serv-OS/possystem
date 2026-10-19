// walkInCheckId.test.js: ONE closed check id per counter basket (v5.11.81).
// Run: node --test src/lib/walkInCheckId.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mintCheckId, usableCheckId, walkInCloseId, bookedCheck, checkoutKeyLeg, mintKeyNonce, rotateOnRepeatOverride, secondCardOnBooked } from './walkInCheckId.js';
import { findPossibleRepeat } from '../../supabase/functions/_shared/repeatCharge.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a minted id has the till format and is new each time', () => {
  assert.match(mintCheckId(1789942866149, () => 0.123456789), /^chk-1789942866149-[0-9a-f]{6}$/);
  assert.notEqual(mintCheckId(), mintCheckId());
  assert.equal(usableCheckId(''), false);
  assert.equal(usableCheckId(null), false);
  assert.equal(usableCheckId('chk-1'), true);
});

test('a close books under the checkout\'s id, else the basket\'s, else none', () => {
  assert.equal(walkInCloseId({ checkId: 'chk-basket' }, { closedCheckId: 'chk-job' }), 'chk-job');
  assert.equal(walkInCloseId({ checkId: 'chk-basket' }, {}), 'chk-basket');
  assert.equal(walkInCloseId({}, {}), null);
  assert.equal(walkInCloseId(null, null), null);
});

test('Provo R40: the same basket paid twice is booked once (the second close finds the first)', () => {
  const basket = { ref: 'R40', checkId: 'chk-1789942866149-b0733e', items: [{ uid: 'a', price: 85.82, qty: 1 }] };
  const closed = [];
  const close = (paymentInfo) => {
    const id = walkInCloseId(basket, paymentInfo);
    const already = bookedCheck(closed, id);
    if (already) return already;
    const rec = { id: id || `chk-${Date.now()}`, ref: basket.ref, total: 85.82 };
    closed.unshift(rec);
    return rec;
  };
  // Before v5.11.81 each checkout minted its own id: chk-...66149-b0733e, then chk-...84501-6ca7bd.
  const first = close({ method: 'cash' });
  const second = close({ method: 'cash' });
  assert.equal(closed.length, 1, 'one sale');
  assert.equal(second, first, 'the second close hands back the first record');
  assert.equal(bookedCheck(closed, 'chk-other'), null);
});

test('wiring: the store mints the basket id once, the counter close refuses an id already booked, the checkout and the handheld use it', () => {
  const store = read('../store/index.js');
  assert.match(store, /ensureWalkInCheckId: \(\) => \{\n\s+const w = get\(\)\.walkInOrder;\n\s+if \(!w\) return null;\n\s+if \(usableCheckId\(w\.checkId\)\) return w\.checkId;/);
  const close = store.slice(store.indexOf('recordWalkInClosed: (walkInOrder'), store.indexOf('refundCheck: async'));
  assert.match(close, /const oneCheckId = walkInCloseId\(walkInOrder, paymentInfo\);\n\s+const alreadyBooked = bookedCheck\(get\(\)\.closedChecks, oneCheckId\);\n\s+if \(alreadyBooked\) \{/);
  assert.match(close, /id: oneCheckId \|\| `chk-\$\{Date\.now\(\)\}`,/);
  // The guard comes before the kitchen send, the drawer, the redeem and the insert.
  const guardAt = close.indexOf('if (alreadyBooked) {');
  for (const later of ["get().sendToKitchen({ fireAll: true, tableId: null });", 'insertClosedCheck(record);', 'get().openCashDrawer({', 'get().redeemPromoCode?.(']) {
    assert.ok(close.lastIndexOf(later) > guardAt, `${later} runs only after the guard`);
  }
  const co = read('../surfaces/CheckoutModal.jsx');
  assert.match(co, /const basketId = \(!tableId && orderType !== 'bar-tab'\) \? useStore\.getState\(\)\.ensureWalkInCheckId\?\.\(\) : null;\n\s+checkIdRef\.current = basketId \|\| mintCheckId\(\);/);
  assert.match(co, /if \(!tableId && orderType !== 'bar-tab'\) useStore\.getState\(\)\.rotateWalkInCheckId\?\.\(\);\n\s+checkIdRef\.current = null;/);
  assert.match(read('../surfaces/MPOSSurface.jsx'), /closedCheckId: \(!tableId && state\.ensureWalkInCheckId\?\.\(\)\) \|\| `chk-\$\{Date\.now\(\)\}`/);
});

// ── v5.11.81 round 1 fix: one closed check id per basket, but one card job key per CHECKOUT ─────────
// With the basket id as the key leg, a checkout reopened on the same basket sent under the same key
// as the first checkout's approved job, and the server's double charge net skipped it as "a retry,
// not a repeat": a second charge could go to the reader. Each checkout now has its own key leg.
const LOC = '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9';
const TILL = 'ff1b5fb8-2406-4854-bdb0-37cc8af45361';
const READER = 'a264a739-adb3-40fe-a5f1-628f906505b1';
const ITEMS = [{ name: 'Latte', qty: 1, price: 3.2, mods: [] }, { name: 'Cake', qty: 1, price: 4.5, mods: [] }];
// terminalJobs.js (not importable under node: it imports the supabase client) builds the key so:
const buildCheckKey = ({ locationId, tableId, sessionId, leg }) => {
  const base = `${locationId}:${tableId ?? 'walkin'}:${sessionId ?? '-'}`;
  return leg ? `${base}:${leg}` : base;
};
const draftOf = (orderRef) => ({ tableId: null, tableLabel: null, sessionId: null, orderType: 'takeaway', covers: 0, staffId: 's1', items: ITEMS, orderRef, source: 'pos_send_to_terminal' });

test('repeat net: a second checkout on the same basket is asked before charging again (own key leg per checkout)', () => {
  const basketId = 'chk-1790768566981-528328';
  const key1 = buildCheckKey({ locationId: LOC, tableId: null, sessionId: null, leg: checkoutKeyLeg(basketId, 'aaaaaa') });
  const key2 = buildCheckKey({ locationId: LOC, tableId: null, sessionId: null, leg: checkoutKeyLeg(basketId, 'bbbbbb') });
  assert.notEqual(key1, key2, 'two checkouts of one basket send under two keys');
  assert.equal(key1, buildCheckKey({ locationId: LOC, tableId: null, sessionId: null, leg: checkoutKeyLeg(basketId, 'aaaaaa') }), 'a retry in the same checkout keeps its key');
  const j1 = {
    id: 'job-1', status: 'approved', check_key: key1, closed_check_id: basketId, pos_device_id: TILL, target_terminal_id: READER, location_id: LOC,
    due_minor: 770, charge_minor: 770, currency: 'GBP', created_at: '2026-10-19T11:42:49.330Z', dispatched_at: '2026-10-19T11:42:50.388Z', settled_at: '2026-10-19T11:43:29.541Z',
    card: { brand: 'visa', last4: '9810' }, check_draft: draftOf('R40'), booked: null,
  };
  const req = (checkKey) => ({ job_id: 'job-2', check_key: checkKey, location_id: LOC, pos_device_id: TILL, target_terminal_id: READER, due_minor: 770, check_draft: draftOf('R40') });
  const now = Date.parse('2026-10-19T11:44:00.000Z');
  assert.ok(findPossibleRepeat(req(key2), [j1], now), 'the net sees the first checkout\'s approved job');
  assert.equal(findPossibleRepeat(req(key1), [j1], now), null, 'with one key per basket it was skipped as a retry');
  assert.match(mintKeyNonce(() => 0.123456789), /^[0-9a-f]{6}$/);
  assert.match(read('./payments/terminalJobs.js'), /const base = `\$\{locationId\}:\$\{tableId \?\? 'walkin'\}:\$\{sessionId \?\? '-'\}`;\n\s+return leg \? `\$\{base\}:\$\{leg\}` : base;/);
  // Wiring: the checkout sends under its own leg; the closed check id stays the basket's.
  const co = read('../surfaces/CheckoutModal.jsx');
  assert.match(co, /leg: tableId \? undefined : checkoutKeyLeg\(checkId, getKeyNonce\(\)\),/);
  assert.match(co, /closedCheckId: checkId,\n\s+checkDraft: \{/);
});

test('repeat override: "different customer" on the same basket books its own row; a second card on a booked basket is loud', () => {
  assert.equal(rotateOnRepeatOverride({ priorClosedCheckId: 'chk-1', checkId: 'chk-1', counter: true, giftDebited: false }), true);
  assert.equal(rotateOnRepeatOverride({ priorClosedCheckId: 'chk-0', checkId: 'chk-1', counter: true, giftDebited: false }), false, 'another basket: nothing shared');
  assert.equal(rotateOnRepeatOverride({ priorClosedCheckId: 'chk-1', checkId: 'chk-1', counter: false, giftDebited: false }), false, 'a table keeps its key');
  assert.equal(rotateOnRepeatOverride({ priorClosedCheckId: 'chk-1', checkId: 'chk-1', counter: true, giftDebited: true }), false, 'a gift debited on this id is never debited again');
  const booked = { id: 'chk-1', ref: 'R40', stripePaymentIntentId: 'psp-A', tenders: [{ method: 'card', psp_ref: 'psp-A' }] };
  assert.equal(secondCardOnBooked(booked, { stripePaymentIntentId: 'psp-A' }), null, 'the same payment again is a plain retry');
  assert.equal(secondCardOnBooked(booked, { stripePaymentIntentId: 'psp-B' }), 'psp-B', 'a different card payment is a second charge');
  assert.equal(secondCardOnBooked(booked, { method: 'cash' }), null);
  const co = read('../surfaces/CheckoutModal.jsx');
  assert.match(co, /if \(rotateOnRepeatOverride\(\{\n\s+priorClosedCheckId: repeatWarn\?\.closed_check_id, checkId: checkIdRef\.current,\n\s+counter: !tableId && !isBarTab, giftDebited: !!paxGiftRef\.current,\n\s+\}\)\) \{\n\s+useStore\.getState\(\)\.rotateWalkInCheckId\?\.\(\);\n\s+checkIdRef\.current = null;/);
  const store = read('../store/index.js');
  assert.match(store, /const secondCard = secondCardOnBooked\(alreadyBooked, paymentInfo\);\n\s+if \(secondCard\) \{/);
});
