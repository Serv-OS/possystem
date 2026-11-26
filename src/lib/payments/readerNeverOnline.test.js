/**
 * readerNeverOnline.test.js: a card reader payment is never labelled online (5.12.106, 26 Nov 2026).
 *
 * What happened: the owner of Coffee Boy Castleford asked why "a lot of online payments failed".
 * None had. Twelve DECLINED card reader payments showed as "Online debit" in Back Office, Card
 * payments. Peter, the same day: "you cant just update those few payments it needs to be a
 * proper fix".
 *
 * The cause: the ledger classifier (channelTier in _shared/adyen.ts) never read Adyen's own word
 * for a reader payment (shopperInteraction POS) and called a payment online whenever the event
 * carried isCardCommercial. That key says what KIND of card it is, and about three in four
 * reader events carry it. The rule engine's later answer hid the mistake, so it only showed
 * where the engine fell back to the classifier.
 *
 * Under test: the classifier itself, the rule engine's facts, and the webhook's two steps
 * together, for every kind of venue, so no fallback can bring the label back.
 *
 * Run: `node --test src/lib/payments/readerNeverOnline.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesFromRateCard, annotateRules, paymentFacts, stampForPayment } from './adyenRules.js';

const SHARED_ADYEN = '../../../supabase/functions/_shared/adyen.ts';
// CI runs node 24, which strips types; this must never skip there (a skipped guard guards nothing).
const ts = await import(SHARED_ADYEN);

const ONLINE = (label) => String(label ?? '').startsWith('card_not_present');

// A declined reader payment exactly as Adyen sent it for Castleford (the keys of the live event,
// values made up): shopperInteraction POS, isCardCommercial present, no posEntryMode, no variant.
const declinedReader = (extra = {}) => ({
  amount: { value: 2755, currency: 'GBP' }, eventCode: 'AUTHORISATION', success: 'false', reason: 'Not enough balance',
  merchantReference: 'tj-64e07167-0000-4000-8000-000000000001', paymentMethod: 'mc',
  additionalData: {
    store: 'SV-0000', cardBin: '000000', expiryDate: '01/2030', bookingDate: '2026-11-20T10:50:18Z', cardSummary: '0000',
    fundingSource: 'DEBIT', hmacSignature: 'x', refusalReason: 'Not enough balance', cardHolderName: 'TEST', cardIssuingBank: 'TEST BANK',
    isCardCommercial: 'false', cardPaymentMethod: 'mc', refusalReasonCode: '51', cardIssuingCountry: 'GB', shopperInteraction: 'POS', ...extra,
  },
});
const without = (item, ...keys) => { const ad = { ...item.additionalData }; for (const k of keys) delete ad[k]; return { ...item, additionalData: ad }; };

test('the classifier: a reader payment is in person, with or without Adyen\'s word, whatever card kind key it carries', () => {
  assert.equal(ts.classifyRateCategory(declinedReader(), 'pos'), 'card_present_debit', 'the Castleford shape, which read card_not_present_debit');
  assert.equal(ts.classifyBaseRateCategory(declinedReader(), 'pos'), 'card_present');
  assert.equal(ts.classifyRateCategory(declinedReader({ fundingSource: 'CREDIT' }), 'pos'), 'card_present');
  assert.equal(ts.classifyRateCategory(declinedReader({ fundingSource: 'PREPAID' }), 'pos'), 'card_present_debit');
  // Adyen's word alone is enough, with no channel (a replay of a row whose channel was never set)
  assert.equal(ts.classifyRateCategory(declinedReader(), null), 'card_present_debit');
  // the channel alone is enough, with no word from Adyen
  assert.equal(ts.classifyRateCategory(without(declinedReader(), 'shopperInteraction'), 'pos'), 'card_present_debit');
  // a paid reader payment of the same shape
  assert.equal(ts.classifyRateCategory({ ...declinedReader(), success: 'true' }, 'pos'), 'card_present_debit');
});

test('the classifier: what was right before stays as it was', () => {
  const ad = (additionalData, more = {}) => ({ paymentMethod: 'visa', ...more, additionalData });
  // online by channel, by Adyen's word, by the keys only a checkout sends
  assert.equal(ts.classifyRateCategory(ad({ isCardCommercial: 'false' }), 'online'), 'card_not_present');
  assert.equal(ts.classifyRateCategory(ad({ shopperInteraction: 'Ecommerce', isCardCommercial: 'false' }), 'pos'), 'card_not_present', 'Adyen\'s word wins over the channel');
  assert.equal(ts.classifyRateCategory(ad({ scaExemptionRequested: 'lowValue' }), 'pos'), 'card_not_present');
  assert.equal(ts.classifyRateCategory(ad({ 'threeds2.cardEnrolled': 'true' }), 'pos'), 'card_not_present');
  assert.equal(ts.classifyRateCategory(ad({ 'checkout.cardAddedBrand': 'visa' }), null), 'card_not_present');
  // an older QR payment: no channel, no word, only the card kind key. Still online, as before.
  assert.equal(ts.classifyRateCategory(ad({ isCardCommercial: 'false' }, { merchantReference: 'QR-ABC12' }), null), 'card_not_present');
  // a tab hold shares the reader channel but is paid on the guest's phone: as before
  assert.equal(ts.classifyRateCategory(ad({ isCardCommercial: 'false' }, { merchantReference: 'tabhold-1' }), 'pos'), 'card_not_present');
  assert.equal(ts.classifyRateCategory(ad({}, { merchantReference: 'tabhold-1' }), 'pos'), 'card_present');
  // the card families are decided first, as before
  assert.equal(ts.classifyRateCategory(ad({ isCardCommercial: 'true', shopperInteraction: 'POS' }), 'pos'), 'amex');
  assert.equal(ts.classifyRateCategory(ad({ shopperInteraction: 'Moto' }), 'pos'), 'keyed');
  assert.equal(ts.classifyRateCategory(ad({ posEntryMode: 'KEYED', shopperInteraction: 'POS' }), 'pos'), 'keyed');
});

test('the rule engine\'s facts: the same rule, so both halves always agree', () => {
  assert.equal(paymentFacts(declinedReader(), 'pos').shopperInteraction, 'POS');
  assert.equal(paymentFacts(without(declinedReader(), 'shopperInteraction'), 'pos').shopperInteraction, 'POS', 'read Ecommerce until 5.12.106');
  assert.equal(paymentFacts(without(declinedReader(), 'shopperInteraction'), null).shopperInteraction, 'Ecommerce', 'no channel and no word: the card kind key decides, as before');
  assert.equal(paymentFacts({ merchantReference: 'tabhold-1', additionalData: { isCardCommercial: 'false' } }, 'pos').shopperInteraction, 'Ecommerce', 'a tab hold, as before');
  assert.equal(paymentFacts({ additionalData: { scaExemptionRequested: 'lowValue' } }, 'pos').shopperInteraction, 'Ecommerce');
  assert.equal(paymentFacts({ additionalData: { isCardCommercial: 'false' } }, 'online').shopperInteraction, 'Ecommerce');
});

// The webhook's two steps, as adyen-webhook runs them: the classifier first, then the engine,
// which hands the classifier's answer back whenever it has nothing better.
const UK = {
  card_present: { percent: 0.9 }, card_present_debit: { percent: 0.85 }, card_not_present: { percent: 1.1, fixedPence: 10 },
  card_not_present_debit: { percent: 1.1, fixedPence: 10 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.2, fixedPence: 10 },
};
const TIERS = Object.fromEntries(Object.entries(UK).map(([k, v]) => [k, { percent: v.percent, fixed_pence: v.fixedPence ?? null }]));
const built = rulesFromRateCard(UK, { currency: 'GBP' });
const LIVE_AT = '2026-10-15T20:00:00.000Z';
const live = { rates_live_at: LIVE_AT, legacy_charge: { percent_bp: 85, fixed_minor: 0, refund: 'none' }, adyen_rules: [{ from: LIVE_AT, profile_id: 'SC', refund_policy: 'none', rules: annotateRules(built.rules, built) }] };
const VENUES = [
  ['the venue row could not be read', null, TIERS],
  ['no recorded cutover, with a rate card', { rates_live_at: null, legacy_charge: null, adyen_rules: null }, TIERS],
  ['no recorded cutover, no rate card at all', { rates_live_at: null, legacy_charge: null, adyen_rules: null }, null],
  ['cut over, rules on file', live, TIERS],
  ['cut over, no legacy charge on the row', { ...live, legacy_charge: null }, TIERS],
  ['cut over, the rules list is empty', { ...live, adyen_rules: [] }, TIERS],
  ['cut over, rules for another currency only', { ...live, adyen_rules: [{ ...live.adyen_rules[0], rules: annotateRules(rulesFromRateCard(UK, { currency: 'USD' }).rules, rulesFromRateCard(UK, { currency: 'USD' })) }] }, TIERS],
];
const TIMES = ['2026-10-01T12:00:00Z', '2026-11-20T10:50:18Z', null];   // before the cutover, after it, and no time at all
function webhookLabel(item, channel, venue, tiers, authorisedAt, ok) {
  const rateCategory = ts.classifyRateCategory(item, channel);
  const commission = ok && tiers ? ts.commissionForAmount(item.amount.value, tiers[rateCategory]) : null;
  return stampForPayment({ amountMinor: item.amount.value, authorisedAt, ok, facts: paymentFacts(item, channel) }, venue, { rate_category: rateCategory, commission_minor: commission, tiers }).rate_category;
}

test('the whole webhook path: no venue, no time and no fallback labels a reader payment online', () => {
  const READER = [
    ['declined, as Castleford\'s', declinedReader()],
    ['no word from Adyen', without(declinedReader(), 'shopperInteraction')],
    ['no funding source', without(declinedReader(), 'fundingSource')],
    ['credit', declinedReader({ fundingSource: 'CREDIT' })],
    ['prepaid', declinedReader({ fundingSource: 'PREPAID' })],
    ['no card kind key', without(declinedReader(), 'isCardCommercial')],
    ['nothing but the reference', { amount: { value: 500, currency: 'GBP' }, merchantReference: 'tj-1', additionalData: {} }],
  ];
  let checked = 0;
  for (const [vName, venue, tiers] of VENUES) for (const at of TIMES) for (const ok of [true, false]) for (const [eName, item] of READER) {
    const label = webhookLabel(item, 'pos', venue, tiers, at, ok);
    assert.ok(!ONLINE(label), `${eName} / ${vName} / ${at} / ${ok ? 'paid' : 'declined'} gave ${label}`);
    checked++;
  }
  assert.equal(checked, VENUES.length * TIMES.length * 2 * READER.length);
});

test('and an online payment is still online on every one of those paths', () => {
  const onlineOrder = { amount: { value: 940, currency: 'GBP' }, merchantReference: 'OL-ABCDE', paymentMethod: 'visa', additionalData: { fundingSource: 'CREDIT', isCardCommercial: 'false', shopperInteraction: 'Ecommerce', 'checkout.cardAddedBrand': 'visa' } };
  for (const [vName, venue, tiers] of VENUES) for (const at of TIMES) {
    assert.ok(ONLINE(webhookLabel(onlineOrder, 'online', venue, tiers, at, true)), `${vName} / ${at}`);
  }
});

test('the old rule is gone from all three copies', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
  for (const p of ['supabase/functions/_shared/adyen.ts', 'supabase/functions/_shared/adyenRules.js', 'src/lib/payments/adyenRules.js']) {
    assert.ok(!/cardEnrolled' in ad \|\| 'isCardCommercial' in ad/.test(read(p)), `${p} still reads isCardCommercial as a checkout key`);
  }
});
