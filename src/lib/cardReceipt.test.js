// node --test — card-scheme receipt block normaliser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardReceiptOf, cardReceiptLines, cardReceiptSummary } from './cardReceipt.js';

// The snake_case block adyen-terminal-charge stores on the job and the closed check's payment leg.
const adyenCard = {
  brand: 'visa', last4: '4242', read_method: 'contactless',
  auth_code: '123456', aid: 'A0000000031010', application_name: 'Visa Credit', cvm: 'none',
};

test('normalises the Adyen card block from the in-memory record', () => {
  const c = cardReceiptOf({ cardReceipt: adyenCard });
  assert.equal(c.brand, 'Visa');
  assert.equal(c.last4, '4242');
  assert.equal(c.authCode, '123456');
  assert.equal(c.readMethod, 'Contactless');
  assert.equal(c.cvm, 'No CVM required');
});

test('finds the card on a closed_checks DB row (payment_intents jsonb, snake_case)', () => {
  const row = { payment_intents: [{ id: 'PSP_1', amountMinor: 1234, card: { brand: 'MASTERCARD', last4: '9876', auth_code: '00777A' } }] };
  const c = cardReceiptOf(row);
  assert.equal(c.brand, 'Mastercard');
  assert.equal(c.last4, '9876');
  assert.equal(c.authCode, '00777A');
});

test('PCI: never prints more than the last 4 digits', () => {
  const c = cardReceiptOf({ cardReceipt: { brand: 'visa', last4: '4000004242' } });
  assert.equal(c.last4, '4242');
});

test('null for cash / legacy checks — renderers skip the block', () => {
  assert.equal(cardReceiptOf({ method: 'cash' }), null);
  assert.equal(cardReceiptOf({ paymentIntents: [{ id: 'PSP_1', amountMinor: 500 }] }), null);
  assert.equal(cardReceiptOf(null), null);
  assert.deepEqual(cardReceiptLines({ method: 'cash' }), []);
});

test('lines render label/value pairs in receipt order', () => {
  const lines = cardReceiptLines({ cardReceipt: adyenCard });
  assert.deepEqual(lines.map(([l]) => l), ['Card', 'Entry', 'Verification', 'Auth code', 'AID', 'App']);
  assert.deepEqual(lines[0], ['Card', 'Visa **** 4242']);
});

test('summary one-liner', () => {
  assert.equal(cardReceiptSummary({ cardReceipt: adyenCard }), 'Visa **** 4242 · Contactless · Auth 123456');
});

test('brand "unknown" is suppressed (BRAND_LABEL null mapping), last4 still prints', () => {
  const c = cardReceiptOf({ cardReceipt: { brand: 'unknown', last4: '1234' } });
  assert.equal(c.brand, null);
  assert.equal(c.last4, '1234');
  assert.deepEqual(cardReceiptLines({ cardReceipt: { brand: 'unknown', last4: '1234' } })[0], ['Card', '**** 1234']);
});

test('unknown enum values fall back to readable title case, not raw codes', () => {
  const c = cardReceiptOf({ cardReceipt: { brand: 'visa', last4: '1111', read_method: 'some_new_method', cvm: 'offline_pin' } });
  assert.equal(c.readMethod, 'Some New Method');
  assert.equal(c.cvm, 'PIN verified');
});
