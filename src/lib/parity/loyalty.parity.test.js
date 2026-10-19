// loyalty.parity.test.js: rewards, promo codes and stamps follow the till's rules on every channel (v5.11.78).
// Run: node --test src/lib/parity/loyalty.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, between } from './src.js';

// ── A bar tab commits the promo code it gave (confirmed major) ───────────────────────────────────
test('bar tab: the checkout\'s promo code (and any staged reward) is committed against the check, as at the counter', () => {
  const store = readRepo('src/store/index.js');
  const fn = between(store, 'recordWalkInClosedCheck: (record, paymentInfo = {}) => {', 'recordWalkInClosed: (walkInOrder');
  assert.ok(fn, 'recordWalkInClosedCheck takes the checkout\'s paymentInfo');
  assert.match(fn, /if \(pay\.promoRedemption\) get\(\)\.redeemPromoCode\?\.\(pay\.promoRedemption, fullRecord, fullRecord\.customer\);/);
  assert.match(fn, /if \(pay\.loyaltyRedemption\?\.pending_commit\) get\(\)\.redeemLoyaltyAtCommit\?\.\(pay\.loyaltyRedemption, fullRecord, fullRecord\.customer\);/);
  assert.match(fn, /discounts: \[\.\.\.\(record\.discounts \|\| \[\]\), \.\.\.promoDiscountEntry\(pay\.promoRedemption\)\]/, 'the promo line, as the counter books it');
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /\}, payInfo \|\| \{\}\);\n\s+closeTab\(tab\.id\);/);
});

// ── A reader sale another till books keeps the reward and the code (confirmed major) ─────────────
test('reader close: a check another till books carries the reward and promo tenders and commits them once', async () => {
  const { closerCreditsMinor, closerGrandMinor, closerCardIntents } = await import('../payments/terminalJobCloser.js');
  assert.equal(typeof closerCreditsMinor, 'function');
  // 8.20 of goods, a 3.60 stamp reward, 4.60 on the card (the live 1 Oct case).
  const credits = closerCreditsMinor({ loyaltyRedemption: { discount_value: 360, pending_commit: true }, promoRedemption: null });
  assert.deepEqual(credits, { loyaltyMinor: 360, promoMinor: 0, creditMinor: 360 });
  assert.equal(closerGrandMinor({ chargeMinor: 460, creditMinor: credits.creditMinor }), 820, 'booked gross, as the till books it');
  assert.deepEqual(closerCardIntents({ transactionId: 'psp1', chargeMinor: 460, creditMinor: 360 }), [{ id: 'psp1', amountMinor: 460 }], 'the card leg names only what the card took');
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.match(co, /loyaltyRedemption: loyaltyApplied \|\| null,\n\s+promoRedemption: promoApplied \|\| null,/);
  const store = readRepo('src/store/index.js');
  const close = between(store, 'closeApprovedTerminalJob: async (job) => {', '_reverseTerminalJobGift: async (');
  assert.match(close, /tender\('loyalty', credits\.loyaltyMinor \/ 100, 0, \{ rewards: rewardsRecord\(d\.loyaltyRedemption\) \}\),\n\s+tender\('promo', credits\.promoMinor \/ 100\),/);
  assert.match(close, /if \(d\.promoRedemption\) get\(\)\.redeemPromoCode\?\.\(d\.promoRedemption, record, null\);/);
  assert.match(close, /if \(d\.loyaltyRedemption\?\.pending_commit\) get\(\)\.redeemLoyaltyAtCommit\?\.\(d\.loyaltyRedemption, record, null\);/);
});

// ── A customer page's guest earns like a till customer (confirmed majors: QR, online, catering) ───
test('order key earn: the till\'s rule (the phone on a paid order earns), proven by the order\'s own key', async () => {
  const { decideOrderProofEarn, usableOrderKey } = await import('../../../supabase/functions/_shared/earnFromCheck.ts');
  const check = { id: 'chk-1', ref: 'QR-ABCDE', source: 'qr', status: 'paid', customer: { phone: '07700 900123' } };
  const base = { channel: 'qr', orderKey: 'tok_0123456789abcdef', check, keyOk: true, customer: { orgId: 'o1', phone: '+447700900123' }, venueOrgId: 'o1' };
  assert.deepEqual(decideOrderProofEarn(base), { ok: true });
  assert.equal(decideOrderProofEarn({ ...base, orderKey: '0123' }).ok, false, 'a phone\'s last 4 never proves an order');
  assert.equal(usableOrderKey('0123'), false);
  assert.equal(decideOrderProofEarn({ ...base, keyOk: false }).ok, false, 'the key must prove THIS order');
  assert.equal(decideOrderProofEarn({ ...base, customer: { orgId: 'o1', phone: '+447700900999' } }).ok, false, 'only the phone on the check earns');
  assert.equal(decideOrderProofEarn({ ...base, customer: { orgId: 'o2', phone: '+447700900123' } }).ok, false, 'never another organisation\'s customer');
  assert.equal(decideOrderProofEarn({ ...base, check: { ...check, source: null } }).ok, false, 'a till check earns through the till');
  assert.equal(decideOrderProofEarn({ ...base, check: { ...check, status: 'refunded' } }).ok, false);
  assert.equal(decideOrderProofEarn({ ...base, channel: 'pos' }).ok, false);
  for (const ch of ['online', 'catering']) assert.deepEqual(decideOrderProofEarn({ ...base, channel: ch, check: { ...check, source: ch } }), { ok: true }, ch);
});

test('order key earn: loyalty-earn asks for it ONLY after its fence refused, and every page sends its key, check and channel', () => {
  const fn = readRepo('supabase/functions/loyalty-earn/index.ts');
  assert.match(fn, /if \(!fenceGate\.allow && \(body as any\)\.order_key\) \{/);
  assert.match(fn, /const gate = viaOrder \? \{ \.\.\.fenceGate, allow: true \} : fenceGate;\n\s+if \(!gate\.allow\) return gate\.response!;/);
  const lookup = readRepo('src/lib/customerLookup.js');
  assert.match(lookup, /channel: orderRecord\.channel \|\| 'online',/);
  assert.match(lookup, /\.\.\.\(orderKeyUsable\(orderKey\) \? \{ order_key: String\(orderKey\)\.trim\(\) \} : \{\}\),/);
  const qr = readRepo('src/surfaces/qr/QrCheckout.jsx');
  assert.match(qr, /orderRecord: \{ ref, checkId: closedCheckRow\?\.id \|\| null, total, items, type: 'dine-in', channel: 'qr' \},/);
  assert.match(qr, /memberToken: loyalty\?\.token \|\| null,/);
  const cat = readRepo('src/surfaces/catering/CateringCheckout.jsx');
  const now = between(cat, 'const finalizeNow = async (paymentIntent) => {', '// ── Confirmation');
  assert.match(now, /attributeOnlineOrder\(\{/);
  assert.match(now, /orderRecord: \{ ref, checkId, total: Math\.max\(0, subtotal - discount\), items: buildItems\(\), type: fulfilment, channel: 'catering' \},/);
  const later = between(cat, 'const placeLater = async () => {', 'const startPayNow = async () => {');
  assert.doesNotMatch(later, /attributeOnlineOrder/, 'a pay later order is attributed by the till when it is paid there (never twice)');
});

// ── A full refund puts stamps back as they were (confirmed major) ────────────────────────────────
test('refund: a full refund takes back the stamps the sale earned, never a reward already used', async () => {
  const { planStampClawback } = await import('../../../supabase/functions/_shared/stampAdjust.js');
  assert.equal(typeof planStampClawback, 'function');
  // 7 stamps + 5 earned on a 10 stamp card rolled to 1 completed card and 2 stamps.
  assert.deepEqual(planStampClawback({ stamps_collected: 2, completed_count: 1 }, 0, { stamps: 5, stampsRequired: 10 }), { stamps_collected: 7, completed_count: 0, clawed: 5 });
  // The completed card's reward was already used: only the 2 loose stamps come back.
  assert.deepEqual(planStampClawback({ stamps_collected: 2, completed_count: 1 }, 1, { stamps: 5, stampsRequired: 10 }), { stamps_collected: 0, completed_count: 1, clawed: 2 });
  const refund = readRepo('supabase/functions/loyalty-refund/index.ts');
  assert.match(refund, /let customer_id: string \| null = bodyCustomerId \? String\(bodyCustomerId\) : null;/);
  assert.match(refund, /idempotency_key: claimKey,/);
  assert.match(refund, /\.eq\('id', card\.id\)\.eq\('stamps_collected', card\.stamps_collected\)\.eq\('completed_count', card\.completed_count\)/, 'the card moves only from the state it was read in');
  const store = readRepo('src/store/index.js');
  assert.match(store, /if \(nextStatus === 'refunded' && \(check\?\.customer\?\.phone \|\| check\?\.customer_id \|\| check\?\.loyalty \|\| check\?\.loyaltyRedemption\)\) \{/);
  assert.match(store, /\.\.\.\(customerId \? \{ customer_id: customerId \} : \{\}\),/);
  assert.doesNotMatch(store, /loyalty reversal skipped — no customer_id on check/);
});
