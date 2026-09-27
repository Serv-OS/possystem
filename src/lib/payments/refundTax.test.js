/**
 * refundTax.test.js: the VAT a refund gives back (refunds[].taxAmount).
 * Run: `npm test`, or `node --test src/lib/payments/refundTax.test.js`.
 *
 * 27 Sep 2026 (review of the Leeds VAT fix): refundCheck pro rated the check's VAT against
 * `total`. A reader close stores the CARD part only as total, so on a £10 sale paid £8 gift
 * card plus £2 card, a part refund gave back all £1.67 of the VAT. The basis is now the money
 * that settled the whole bill: tenders less tip, or total when that is larger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refundBreakdown, refundTaxAmount, refundTaxBasis } from './refundMath.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VAT10 = 10 - 10 / 1.2;   // £1.666.. of VAT inside £10 at 20%

// A reader close (headless record): £10 of goods, £8 gift card taken before the job, £2 on the card.
const readerGiftSplit = () => ({
  id: 'chk-1',
  items: [
    { uid: 'a', name: 'Burger', price: 7, qty: 1 },
    { uid: 'b', name: 'Fries', price: 3, qty: 1 },
  ],
  subtotal: 10, service: 0, tip: 0,
  total: 2,
  taxAmount: Math.round(VAT10 * 100) / 100,   // 1.67
  tenders: [
    { method: 'gift_card', amount: 8, tip: 0 },
    { method: 'card', amount: 2, tip: 0 },
  ],
  refunds: [],
});

test('reader close paid partly by gift card: the basis is the whole bill, not the card part', () => {
  assert.equal(refundTaxBasis(readerGiftSplit()), 10);
});

test('a part refund inside what the card took gives back its own share of the VAT', () => {
  const chk = readerGiftSplit();
  chk.items.push({ uid: 'c', name: 'Dip', price: 1.5, qty: 1 });   // not in the goods sum; priced for the refund only
  const bd = { amount: 1.5, tax: 0 };
  assert.equal(refundTaxAmount(chk, bd), 0.25);   // 1.67 x 1.5 / 10 (was 1.67 x 1.5 / 2 = 1.25)
});

test('refunding the £3 item: the card gives back at most £2, and the VAT on £2 of £10', () => {
  const chk = readerGiftSplit();
  const bd = refundBreakdown(chk, { items: [{ ...chk.items[1], refundQty: 1 }] });
  assert.equal(bd.amount, 2);                    // clamped to what the card took
  assert.equal(refundTaxAmount(chk, bd), 0.33);  // was 1.67, every penny of the VAT
});

test('a full refund of the card part gives back only the card part of the VAT', () => {
  const chk = readerGiftSplit();
  const bd = refundBreakdown(chk, { isFullRefund: true });
  assert.equal(bd.amount, 2);
  assert.equal(refundTaxAmount(chk, bd), 0.33);
});

test('a tip on the reader leg stays out of the basis', () => {
  const chk = { ...readerGiftSplit(), tip: 1, total: 3, tenders: [{ method: 'gift_card', amount: 8, tip: 0 }, { method: 'card', amount: 2, tip: 1 }] };
  assert.equal(refundTaxBasis(chk), 10);
});

test('a till check (total is the gross plus tip) is unchanged: total stays the basis', () => {
  const chk = {
    items: [{ uid: 'a', price: 10, qty: 1 }], subtotal: 10, service: 0, tip: 1, total: 11, taxAmount: 1.67,
    tenders: [{ method: 'gift_card', amount: 8, tip: 0 }, { method: 'card', amount: 2, tip: 1 }], refunds: [],
  };
  assert.equal(refundTaxBasis(chk), 11);
  assert.equal(refundTaxAmount(chk, { amount: 5.5, tax: 0 }), Math.round(1.67 * (5.5 / 11) * 100) / 100);   // the old formula, byte for byte
});

test('a check with no tenders (older rows) keeps the old rule exactly', () => {
  const chk = { total: 12, taxAmount: 2, refunds: [] };
  assert.equal(refundTaxBasis(chk), 12);
  assert.equal(refundTaxAmount(chk, { amount: 6, tax: 0 }), 1);
  assert.equal(refundTaxAmount({ total: 12, taxAmount: null }, { amount: 6 }), null);
  assert.equal(refundTaxAmount({ total: 0, taxAmount: 0, tenders: [] }, { amount: 0 }), null);
});

test('a check whose tax is all added on (US) still returns the breakdown figure', () => {
  const chk = {
    total: 10.89, tip: 0, taxAmount: 0.89,
    taxBreakdown: { hasExclusiveTax: true, exclusiveTax: 0.89 },
    tenders: [{ method: 'card', amount: 10.89, tip: 0 }],
  };
  assert.equal(refundTaxAmount(chk, { amount: 5.44, tax: 0.44 }), 0.44);
});

test('refundCheck uses refundTaxAmount; the History loaders carry tenders', () => {
  const store = fs.readFileSync(path.join(here, '../../store/index.js'), 'utf8');
  assert.match(store, /const taxRefunded = refundTaxAmount\(chkBefore, bd\);/);
  assert.match(store, /toMinor as toMinorAmt, refundTaxAmount,\n\} from '\.\.\/lib\/payments\/refundMath';/);
  assert.doesNotMatch(store, /amount \/ Number\(chkBefore\.total\)/);
  // 28 Sep 2026: both loaders map tenders through the shared row map (closedCheckRefundFields).
  const db = fs.readFileSync(path.join(here, '../db.js'), 'utf8');
  assert.equal((db.match(/\.\.\.closedCheckRefundFields\(c\),/g) || []).length, 2);
  const map = fs.readFileSync(path.join(here, '../closedCheckRefundFields.js'), 'utf8');
  assert.match(map, /tenders: Array\.isArray\(row\?\.tenders\) \? row\.tenders : null,/);
});
