// walkInCheckId.test.js: ONE closed check id per counter basket (v5.11.81).
// Run: node --test src/lib/walkInCheckId.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mintCheckId, usableCheckId, walkInCloseId, bookedCheck } from './walkInCheckId.js';

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
