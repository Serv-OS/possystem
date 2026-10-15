/**
 * webhookStamp.test.js: what adyen-webhook writes on a payment row from
 * 15 Oct 2026 (stampForPayment and restampForAmount in adyenRules.js).
 *
 *   before rates_live_at   the flat legacy charge Adyen actually took, fee_rule
 *                          'legacy_flat', policy 'none': the SAME answer the
 *                          restatement SQL writes, so a ?backfill=1 replay
 *                          agrees with it instead of undoing it
 *   at or after it         the rules entry governing the instant, fee_rule
 *                          'adyen_rules:<profile id>', the entry's policy
 *   no rates_live_at       today's answer, unchanged, fee_rule null: nothing
 *                          moves until the rates are written
 *   a CAPTURE that moves the amount restamps with the SAME rule; a legacy row
 *                          captured at or after the cutover follows the new profile, as Adyen does
 *   a replay never demotes a row already stamped under the new scheme (keepExistingStamp)
 * The pre cutover LABEL (rate_category) stays today's classifier's: the chip on
 * a business card charged 0.85% still says Amex and business cards, because that
 * is what happened. Run: `node --test src/lib/payments/webhookStamp.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rulesFromRateCard, annotateRules, paymentFacts, stampForPayment, restampForAmount, keepExistingStamp, LEGACY_FEE_RULE, RULES_FEE_RULE_PREFIX } from './adyenRules.js';

const UK = {
  card_present: { percent: 0.9 }, card_present_debit: { percent: 0.85 }, card_not_present: { percent: 1.1, fixedPence: 10 },
  card_not_present_debit: { percent: 1.1, fixedPence: 10 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.2, fixedPence: 10 },
};
const built = rulesFromRateCard(UK, { currency: 'GBP' });
const LIVE_AT = '2026-10-15T20:00:00.000Z';
const venue = {
  rates_live_at: LIVE_AT,
  legacy_charge: { percent_bp: 85, fixed_minor: 0, refund: 'none' },
  adyen_rules: [{ from: LIVE_AT, profile_id: 'SC_NEW', refund_policy: 'none', rules: annotateRules(built.rules, built) }],
};
const item = (variant, extra = {}) => ({ amount: { value: 1000, currency: 'GBP' }, eventDate: '2026-10-16T10:00:00+02:00', merchantReference: 'tj-1', additionalData: { paymentMethod: variant.startsWith('visa') ? 'visa' : 'mc', paymentMethodVariant: variant, ...extra } });
const today = { rate_category: 'card_present', commission_minor: 9 };   // 0.9% on 10.00, the old stamp

test('before the cutover: the legacy charge, legacy_flat, policy none; the label stays', () => {
  const p = { amountMinor: 1000, authorisedAt: '2026-10-01T12:00:00Z', ok: true, facts: paymentFacts(item('mccommercialdebit'), 'pos') };
  assert.deepEqual(stampForPayment(p, venue, { rate_category: 'amex', commission_minor: 35 }), { rate_category: 'amex', commission_minor: 9, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  // 85bp half up on sample amounts
  for (const [amount, fee] of [[100, 1], [250, 2], [955, 8], [1600, 14], [1000, 9], [7339, 62]]) {
    assert.equal(stampForPayment({ ...p, amountMinor: amount }, venue, today).commission_minor, fee, String(amount));
  }
  // one second before the cutover is legacy; the cutover instant itself is the rules
  assert.equal(stampForPayment({ ...p, authorisedAt: '2026-10-15T19:59:59Z' }, venue, today).fee_rule, LEGACY_FEE_RULE);
  assert.equal(stampForPayment({ ...p, authorisedAt: LIVE_AT }, venue, today).fee_rule, `${RULES_FEE_RULE_PREFIX}SC_NEW`);
  // a failed authorisation carries no fee, but is still marked
  assert.deepEqual(stampForPayment({ ...p, ok: false }, venue, today), { rate_category: 'card_present', commission_minor: null, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  // the legacy charge with a fixed pence (the demo venue's 0.8% plus 5p)
  const demo = { ...venue, legacy_charge: { percent_bp: 80, fixed_minor: 5, refund: 'none' } };
  assert.equal(stampForPayment(p, demo, today).commission_minor, 13);
  // no legacy charge on the row yet: today's answer, nothing marked
  assert.deepEqual(stampForPayment(p, { ...venue, legacy_charge: null }, today), { ...today, fee_rule: null, fee_refund_policy: null });
});

test('after the cutover: the rule Adyen picks, its tier as the label, adyen_rules:<id>, the entry\'s policy', () => {
  const at = '2026-10-16T08:00:00Z';
  const stamp = (variant, channel = 'pos', extra = {}) => stampForPayment({ amountMinor: 1000, authorisedAt: at, ok: true, facts: paymentFacts(item(variant, extra), channel) }, venue, today);
  assert.deepEqual(stamp('mcstandarddebit'), { rate_category: 'card_present_debit', commission_minor: 9, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  assert.deepEqual(stamp('visastandardcredit'), { rate_category: 'card_present', commission_minor: 9, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  assert.deepEqual(stamp('mccommercialdebit'), { rate_category: 'amex', commission_minor: 35, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  assert.deepEqual(stamp('visastandarddebit', 'online'), { rate_category: 'card_not_present', commission_minor: 21, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  assert.deepEqual(stamp('visastandarddebit', 'pos', { posEntryMode: 'KEYED' }), { rate_category: 'keyed', commission_minor: 32, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  assert.equal(stamp('mcstandarddebit', 'pos', {}).commission_minor, 9);
  // 2.50 on a debit card: 2.125 is 2
  assert.equal(stampForPayment({ amountMinor: 250, authorisedAt: at, ok: true, facts: paymentFacts(item('mcstandarddebit'), 'pos') }, venue, today).commission_minor, 2);
  // a failed authorisation: the tier, no fee
  assert.deepEqual(stampForPayment({ amountMinor: 1000, authorisedAt: at, ok: false, facts: paymentFacts(item('mcstandarddebit'), 'pos') }, venue, today).commission_minor, null);
  // a USD payment on a GBP venue matches no rule: unrated and SAID, never guessed
  const usd = stampForPayment({ amountMinor: 1000, authorisedAt: at, ok: true, facts: { ...paymentFacts(item('mcstandarddebit'), 'pos'), currency: 'USD' } }, venue, today);
  assert.deepEqual(usd, { rate_category: 'card_present', commission_minor: null, fee_rule: 'adyen_rules:SC_NEW:unmatched', fee_refund_policy: 'none' });
  // a rule Adyen returned that we did not send (no tier beside it) is refused the same way
  const foreign = { ...venue, adyen_rules: [{ from: LIVE_AT, profile_id: 'SC_X', refund_policy: 'ratio', rules: [{ currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { commission: { variablePercentage: 90 } } }] }] };
  assert.deepEqual(stamp.call(null, 'visa') && stampForPayment({ amountMinor: 1000, authorisedAt: at, ok: true, facts: paymentFacts(item('visa'), 'pos') }, foreign, today), { rate_category: 'card_present', commission_minor: null, fee_rule: 'adyen_rules:SC_X:unmatched', fee_refund_policy: 'ratio' });
  // a second write later: the entry governing the instant
  const later = { ...venue, adyen_rules: [...venue.adyen_rules, { from: '2026-11-01T00:00:00Z', profile_id: 'SC_2', refund_policy: 'none', rules: annotateRules(rulesFromRateCard({ ...UK, card_present: { percent: 1.0 } }).rules, rulesFromRateCard({ ...UK, card_present: { percent: 1.0 } })) }] };
  assert.deepEqual(stampForPayment({ amountMinor: 1000, authorisedAt: '2026-10-20T00:00:00Z', ok: true, facts: paymentFacts(item('visa'), 'pos') }, later, today).commission_minor, 9);
  assert.deepEqual(stampForPayment({ amountMinor: 1000, authorisedAt: '2026-11-02T00:00:00Z', ok: true, facts: paymentFacts(item('visa'), 'pos') }, later, today), { rate_category: 'card_present', commission_minor: 10, fee_rule: 'adyen_rules:SC_2', fee_refund_policy: 'none' });
});

test('a venue never cut over, or an unreadable instant: today\'s answer, unchanged, nothing marked', () => {
  const p = { amountMinor: 1000, authorisedAt: '2026-10-16T08:00:00Z', ok: true, facts: paymentFacts(item('mcstandarddebit'), 'pos') };
  const untouched = { ...today, fee_rule: null, fee_refund_policy: null };
  assert.deepEqual(stampForPayment(p, { rates_live_at: null, adyen_rules: null, legacy_charge: null }, today), untouched);
  assert.deepEqual(stampForPayment(p, null, today), untouched);
  assert.deepEqual(stampForPayment(p, {}, today), untouched);
  assert.deepEqual(stampForPayment({ ...p, authorisedAt: null }, venue, today), untouched);
  // rates_live_at set but no rules entry yet (the write half landed): today's answer
  assert.deepEqual(stampForPayment(p, { ...venue, adyen_rules: [] }, today), untouched);
  // today's answer can itself be unrated
  assert.deepEqual(stampForPayment(p, null, { rate_category: 'card_present', commission_minor: null }), { rate_category: 'card_present', commission_minor: null, fee_rule: null, fee_refund_policy: null });
});

test('a CAPTURE that moves the amount restamps at the SAME rule the row carries', () => {
  const auth = item('mcstandarddebit');
  // a row stamped from the rules: a tip landing takes the amount to 12.00
  const rulesRow = { fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none', channel: 'pos', raw: { authorisation: auth } };
  assert.deepEqual(restampForAmount(rulesRow, 1200, '2026-10-16T09:00:00Z', venue, 11), { commission_minor: 10, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none', rate_category: 'card_present_debit' });
  // a legacy row captured BEFORE the cutover: the legacy charge on the new amount
  const legacyRow = { fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none', channel: 'pos', raw: { authorisation: auth } };
  assert.deepEqual(restampForAmount(legacyRow, 1200, '2026-10-15T09:00:00Z', venue, 11), { commission_minor: 10, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  assert.deepEqual(restampForAmount(legacyRow, 1200, '2026-10-15T09:00:00Z', { ...venue, legacy_charge: null }, 11).commission_minor, null, 'no legacy charge to apply: unrated, said');
  // a legacy row (a hold restated, or stamped legacy by a replay) captured AT OR AFTER the cutover:
  // Adyen charges the capture under the new profile, so the row moves to the rules (review 15 Oct 2026)
  assert.deepEqual(restampForAmount(legacyRow, 1200, '2026-10-16T09:00:00Z', venue, 11), { commission_minor: 10, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none', rate_category: 'card_present_debit' });
  assert.deepEqual(restampForAmount(legacyRow, 1200, LIVE_AT, venue, 11).fee_rule, 'adyen_rules:SC_NEW');
  // ...but with no rules entry governing the capture instant it stays legacy
  assert.deepEqual(restampForAmount(legacyRow, 1200, '2026-10-16T09:00:00Z', { ...venue, adyen_rules: [] }, 11), { commission_minor: 10, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  // a row with no fee_rule on a venue never cut over: today's commission, nothing marked
  const plainRow = { fee_rule: null, channel: 'pos', raw: { authorisation: auth } };
  assert.deepEqual(restampForAmount(plainRow, 1200, '2026-10-16T09:00:00Z', { rates_live_at: null }, 11), { commission_minor: 11, fee_rule: null, fee_refund_policy: null });
  // a HOLD authorised before the cutover and captured after it: Adyen charges the new profile on the capture, so do we
  assert.deepEqual(restampForAmount(plainRow, 1200, '2026-10-16T09:00:00Z', venue, 11), { commission_minor: 10, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none', rate_category: 'card_present_debit' });
  // ...and captured before it: today's commission
  assert.deepEqual(restampForAmount(plainRow, 1200, '2026-10-15T09:00:00Z', venue, 11), { commission_minor: 11, fee_rule: null, fee_refund_policy: null });
  // the rules entry the row names is gone from the list: the entry governing the capture instant stands in
  assert.equal(restampForAmount({ ...rulesRow, fee_rule: 'adyen_rules:SC_GONE' }, 1200, '2026-10-16T09:00:00Z', venue, 11).fee_rule, 'adyen_rules:SC_NEW');
  // an unmatched capture is unrated and said
  assert.deepEqual(restampForAmount({ ...rulesRow, raw: { authorisation: { ...auth, amount: { value: 1000, currency: 'USD' } } } }, 1200, '2026-10-16T09:00:00Z', venue, 11), { commission_minor: null, fee_rule: 'adyen_rules:SC_NEW:unmatched', fee_refund_policy: 'none' });
  assert.deepEqual(restampForAmount(null, 1200, null, null, 11), { commission_minor: 11, fee_rule: null, fee_refund_policy: null });
});

test('a replay never demotes a row already stamped under the new scheme', () => {
  const at = '2026-10-01T12:00:00Z';
  const p = { amountMinor: 1000, authorisedAt: at, ok: true, facts: paymentFacts(item('mccommercialdebit'), 'pos') };
  const todayAnswer = { rate_category: 'amex', commission_minor: 35 };
  // the restated row, replayed while the venue row cannot be read (stamp answers today's figure, unmarked): KEPT
  const restated = { fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none', commission_minor: 9, rate_category: 'amex', captured_at: null };
  const unmarked = stampForPayment(p, null, todayAnswer);
  assert.deepEqual(unmarked, { rate_category: 'amex', commission_minor: 35, fee_rule: null, fee_refund_policy: null });
  assert.deepEqual(keepExistingStamp(restated, unmarked, null), { rate_category: 'amex', commission_minor: 9, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  // the same row replayed with the venue row readable: the engine answers legacy_flat itself, and that stands
  const marked = stampForPayment(p, venue, todayAnswer);
  assert.deepEqual(keepExistingStamp(restated, marked, venue), marked);
  assert.equal(marked.fee_rule, LEGACY_FEE_RULE);
  // a row stamped from the rules, replayed with the venue row unreadable: KEPT
  const ruled = { fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none', commission_minor: 35, rate_category: 'amex', captured_at: null };
  assert.deepEqual(keepExistingStamp(ruled, unmarked, null), { rate_category: 'amex', commission_minor: 35, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  // a hold authorised before the cutover, CAPTURED after it, stamped from the rules by the CAPTURE path: the
  // AUTHORISATION replay answers legacy_flat, and the row keeps the rules stamp Adyen charged
  const hold = { ...ruled, captured_at: '2026-10-16T09:00:00Z' };
  assert.deepEqual(keepExistingStamp(hold, marked, venue), { rate_category: 'amex', commission_minor: 35, fee_rule: 'adyen_rules:SC_NEW', fee_refund_policy: 'none' });
  // the same hold captured BEFORE the cutover: the legacy answer stands (Adyen charged the old profile)
  assert.deepEqual(keepExistingStamp({ ...ruled, captured_at: '2026-10-10T09:00:00Z' }, marked, venue), marked);
  // a row never stamped under the new scheme takes whatever the engine says
  assert.deepEqual(keepExistingStamp({ fee_rule: null, commission_minor: 35 }, unmarked, null), unmarked);
  assert.deepEqual(keepExistingStamp(null, marked, venue), marked);
  assert.deepEqual(keepExistingStamp({ fee_rule: null }, marked, venue), marked);
  // a later rules entry replaces an earlier rules stamp as the engine says (a rate change is a real move)
  const second = { rate_category: 'amex', commission_minor: 36, fee_rule: 'adyen_rules:SC_2', fee_refund_policy: 'none' };
  assert.deepEqual(keepExistingStamp(ruled, second, venue), second);
});
