// 5.12.37: a promo code keeps its hyphen online (it used to be stripped, so every prefixed code failed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { typedPromoCode, giftCodeDigits } from './promoEntry.js';
import { normalisePromoCode } from '../../../supabase/functions/_shared/promoLookup.ts';

test('a prefixed code reaches promo-redeem exactly as issued', () => {
  assert.equal(typedPromoCode(' 5off-7grrtk5p '), '5OFF-7GRRTK5P');
  assert.equal(typedPromoCode('BDAY - 7F3K9'), 'BDAY-7F3K9');
  assert.equal(normalisePromoCode(typedPromoCode('5off-7grrtk5p')), '5OFF-7GRRTK5P', 'the server accepts the shape');
  assert.equal(typedPromoCode(null), '');
  assert.equal(giftCodeDigits('ABCD-EFGH-JKLM-NPQR'), 'ABCDEFGHJKLMNPQR');
});

test('a refused code says why, not "Code not recognised"', async () => {
  const { promoRefusalWords } = await import('./promoEntry.js');
  assert.equal(promoRefusalWords({ reason: 'usage_limit' }), 'You have already used this offer.');
  assert.equal(promoRefusalWords({ reason: 'min_spend', min_spend: 20 }, (n) => `£${n.toFixed(2)}`), 'Spend £20.00 or more to use this code.');
  assert.equal(promoRefusalWords({ reason: 'not_found' }), '');
  assert.equal(promoRefusalWords(null), '');
  const src = fs.readFileSync(new URL('../../surfaces/online/OnlineCheckout.jsx', import.meta.url), 'utf8');
  assert.match(src, /promoRefusalRef\.current = promoRefusalWords\(j, money\);/);
  assert.match(src, /throw new Error\(promoRefusalRef\.current \|\| 'Code not recognised'\);/);
});

test('OnlineCheckout sends the typed code to promo-redeem, never the stripped one', () => {
  const src = fs.readFileSync(new URL('../../surfaces/online/OnlineCheckout.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /tryPromoCode\(clean\.toUpperCase\(\)\)/);
  assert.equal((src.match(/tryPromoCode\(typedPromoCode\(giftCode\)\)/g) || []).length, 2);
});
