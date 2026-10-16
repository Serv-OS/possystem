// src/lib/giftCodeShape.test.js
//
// 16 Oct 2026. The till and the Back Office lookup only send a typed code to gift-lookup when it
// is 16 characters long. They used to insist on the issuing alphabet (A to Z without I and O,
// 2 to 9), so a card whose code holds a 0, 1, I or O (an imported card, or the demo seed's hex
// codes) was never looked up and the screen said the code was not found while Back Office listed
// the card. The gate is now letters and digits; the server still decides whether the card exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the till sends any 16 letter or digit code to gift-lookup, not only the issuing alphabet', () => {
  const till = read('../surfaces/CheckoutModal.jsx');
  assert.match(till, /if \(\/\^\[A-Z0-9\]\{16\}\$\/\.test\(giftStripped\)\) \{/);
  assert.doesNotMatch(till, /\[A-Z2-9\]\{16\}/);
  const office = read('../backoffice/sections/GiftCards.jsx');
  assert.match(office, /if \(\/\^\[A-Z0-9\]\{16\}\$\/\.test\(cleaned\)\) \{/);
  assert.doesNotMatch(office, /\[A-Z2-9\]\{16\}/);
});

test('the gate accepts an issued code, an imported code with 0 and 1, and refuses a promo code', () => {
  const gate = /^[A-Z0-9]{16}$/;
  assert.ok(gate.test('ABCDEFGHJKLMNPQR'), 'issued alphabet');
  assert.ok(gate.test('C24689C27769AA08'), 'hex with 0 and 1 (imported or seeded)');
  assert.ok(gate.test('ABCD1234EFGH0IOL'), '0, 1, I and O');
  assert.equal(gate.test('SUMMER10'), false, 'a promo code is not gift shaped');
  assert.equal(gate.test('ABCD EFGH JKLM NPQR'), false, 'spaces are stripped before the gate, never inside it');
});
