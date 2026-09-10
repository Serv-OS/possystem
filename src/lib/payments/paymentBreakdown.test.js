/**
 * paymentBreakdown.test.js: how one card payment was split, from Adyen's
 * own records. Run: `node --test src/lib/payments/paymentBreakdown.test.js`.
 *
 * The contract for BOTH copies: src/lib/payments/paymentBreakdown.js and
 * supabase/functions/_shared/paymentBreakdown.ts. EVERY input this suite
 * builds is recorded and replayed through the TS copy in the last test, so a
 * change to one copy in any branch the suite reaches fails the parity test.
 * The main fixture is the REAL Provo £1.00 of 10 Sep 2026.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import * as jsModule from './paymentBreakdown.js';
import {
  formatMinor, paymentCardLabel, ruleForTier, ruleRate, venueRateLine,
  BREAKDOWN_LABELS, SOURCE_WORDS, WAITING_SENTENCE, INCOMPLETE_SENTENCE,
} from './paymentBreakdown.js';
import { profileTiers, tieredCommissionRules } from './adyenLink.js';
import { resellerRateFor } from './resellerRate.js';

// Every breakdown input the suite builds, for the TS parity replay.
const RECORDED = [];
const buildPaymentBreakdown = (input) => {
  RECORDED.push(input);
  return jsModule.buildPaymentBreakdown(input);
};

const PSP = 'FSPKMNZ492CWX7Z3';
const VENUE_BA = 'BA32C5F22322CJ5PXF2BD7FKK';
const LIABLE_BA = 'BA32DFM22322CC5PTXKTJ7DBX';

// The split rule Adyen holds for that payment.
const PROVO_RULE = {
  currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY',
  splitLogic: { commission: { variablePercentage: 80, fixedAmount: 5 }, paymentFee: 'deductFromLiableAccount', remainder: 'addToOneBalanceAccount' },
};
// The adyen_payments row.
const PROVO_PAYMENT = {
  psp_reference: PSP, amount_minor: 100, currency: 'GBP', success: true, live: true,
  rate_category: 'card_present', commission_minor: 6, gratuity_minor: null, amount_refunded_minor: 0,
  authorised_at: '2026-09-10T14:29:00Z', card: { brand: 'visa', applicationName: 'VISA DEBIT', last4: '1234' },
};
const tr = (id, ppt, direction, value, ba, reference, extra = {}) => ({
  id, category: 'platformPayment', status: 'captured', direction, type: 'payment',
  amount: { currency: 'GBP', value }, balanceAccount: { id: ba }, reference,
  categoryData: { type: 'platformPayment', platformPaymentType: ppt, pspPaymentReference: PSP },
  ...extra,
});
// The four transfers GET /btl/v4/transfers answered.
const PROVO_TRANSFERS = [
  tr('T1', 'BalanceAccount', 'incoming', 94, VENUE_BA, 'HR2JC7RZMQ6ZCWW3'),
  tr('T2', 'Commission', 'incoming', 5, LIABLE_BA, 'FP2JC7RZMQ6ZCWW3'),
  tr('T3', 'Commission', 'incoming', 1, LIABLE_BA, 'PP2JC7RZMQ6ZCWW3'),
  tr('T4', 'PaymentFee', 'outgoing', 1, LIABLE_BA, 'WQ2JC7RZMQ6ZCWW3'),
];
// FranPOS: 0.10% + 3p in GBP (the owner's number, set after deploy).
const FRANPOS_GBP = resellerRateFor({ history: [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: 3, USD: 5, EUR: 5 }, from_month: '2026-09' }] }, 'GBP', '2026-09');

const provo = (over = {}) => buildPaymentBreakdown({
  payment: PROVO_PAYMENT, transfers: PROVO_TRANSFERS, rule: PROVO_RULE,
  venueBalanceAccountId: VENUE_BA, liableBalanceAccountId: LIABLE_BA, reseller: FRANPOS_GBP, ...over,
});
const line = (b, key) => b.lines.find((l) => l.key === key);
const noDash = (s) => assert.doesNotMatch(String(s), /[–—]| - /, String(s));
// Owner rule: every SENTENCE under 120 characters (a warning may hold two).
const sentencesShort = (s) => {
  for (const sentence of String(s).split(/(?<=\.)\s+/)) assert.ok(sentence.length < 120, sentence);
};
const fee = (id, ppt, value, ba, extra = {}) => tr(id, ppt, 'outgoing', value, ba, id, extra);

test('the Provo £1.00: every number the owner asked for, from Adyen', () => {
  assert.equal(FRANPOS_GBP.fixedMinor, 3);
  const b = provo();
  assert.equal(b.state, 'ok');
  assert.equal(b.message, null);
  assert.equal(b.currency, 'GBP');
  assert.equal(b.amountMinor, 100);
  assert.deepEqual(b.lines.map((l) => [l.key, l.label, l.minor, l.source]), [
    ['customer_paid', 'Customer paid', 100, 'adyen'],
    ['venue_fee', 'Venue fee', 6, 'adyen'],
    ['venue_receives', 'Venue receives', 94, 'adyen'],
    ['adyen_fees', 'Adyen fees', 1, 'adyen'],
    ['left_on_platform', 'Left on the platform account', 5, 'computed'],
    ['franpos_rate', 'FranPOS rate', 3, 'franpos'],
    ['servos_share', 'ServOS share', 2, 'computed'],
  ]);
  assert.equal(line(b, 'venue_fee').detail, '0.8% + 5p');
  assert.equal(line(b, 'franpos_rate').detail, '0.10% + 3p');
  // percent 1 (0.8 rounded half up), fixed 5; FranPOS 0 and 3; ServOS 1 and 2, minus fees 1
  assert.deepEqual(b.parts, {
    percent: { venue: 1, franpos: 0, servos: 1 },
    fixed: { venue: 5, franpos: 3, servos: 2 },
    adyenFees: 1,
    servosTotal: 2,
    from: 'adyen',
  });
  assert.equal(b.parts.percent.servos + b.parts.fixed.servos - b.parts.adyenFees, line(b, 'servos_share').minor);
  assert.deepEqual(b.checks, { addsUp: true, feeMatchesRate: true });
  assert.equal(b.sumLine, '94p + 6p = £1.00');
  assert.deepEqual(b.warnings, []);
  // the commission_minor the ledger stamped is the fee Adyen booked
  assert.equal(line(b, 'venue_fee').minor, PROVO_PAYMENT.commission_minor);
  // no liable id known: the same answer, nothing judged on a guess
  const noLiable = provo({ liableBalanceAccountId: undefined });
  assert.equal(noLiable.state, 'ok');
  assert.deepEqual(noLiable.parts, b.parts);
  // the default read is complete
  assert.equal(provo({ readComplete: true }).state, 'ok');
});

test('the Provo references: each on its own row, plain label, never the word commission', () => {
  const b = provo();
  assert.deepEqual(b.references, [
    { label: 'Payment', term: 'PSP reference', id: PSP },
    { label: 'Venue receives', term: 'BalanceAccount', id: 'HR2JC7RZMQ6ZCWW3' },
    { label: 'Venue fee, fixed part', term: null, id: 'FP2JC7RZMQ6ZCWW3' },
    { label: 'Venue fee, percent part', term: null, id: 'PP2JC7RZMQ6ZCWW3' },
    { label: 'Adyen fee', term: 'PaymentFee', id: 'WQ2JC7RZMQ6ZCWW3' },
    { label: 'Venue account', term: 'balance account', id: VENUE_BA },
    { label: 'Platform account', term: 'liable balance account', id: LIABLE_BA },
  ]);
  for (const r of b.references) {
    assert.doesNotMatch(r.label, /BA32|PSP|Commission|BalanceAccount/);
    assert.doesNotMatch(String(r.term), /commission/i);
  }
  // an AdyenCommission fee and a refund of the venue fee: no term either
  const more = provo({ transfers: [...PROVO_TRANSFERS, fee('AC', 'AdyenCommission', 0, LIABLE_BA), fee('RC', 'Commission', 1, LIABLE_BA, { type: 'refund' })] });
  for (const r of more.references) assert.doesNotMatch(String(r.term), /commission/i);
  assert.deepEqual(more.references.find((r) => r.id === 'RC'), { label: 'Refund', term: null, id: 'RC' });
});

test('the same transfer listed twice (two listings) counts once; other payments are ignored', () => {
  const other = tr('T9', 'BalanceAccount', 'incoming', 500, VENUE_BA, 'OTHER');
  other.categoryData.pspPaymentReference = 'SOMEOTHERPSP';
  const b = provo({ transfers: [...PROVO_TRANSFERS, ...PROVO_TRANSFERS.map((t) => ({ ...t })), other] });
  assert.equal(b.state, 'ok');
  assert.equal(line(b, 'venue_receives').minor, 94);
  assert.equal(line(b, 'venue_fee').minor, 6);
  assert.equal(b.references.length, 7);
});

test('the order of the two venue fee records does not matter; the fixed part is the one equal to fixedAmount', () => {
  const swapped = [PROVO_TRANSFERS[0], PROVO_TRANSFERS[2], PROVO_TRANSFERS[1], PROVO_TRANSFERS[3]];
  assert.deepEqual(provo({ transfers: swapped }).parts, provo().parts);
});

test('a payment Adyen has not booked yet: waiting, one plain sentence', () => {
  for (const transfers of [[], null, undefined]) {
    const b = provo({ transfers });
    assert.equal(b.state, 'waiting');
    assert.equal(b.message, WAITING_SENTENCE);
    assert.equal(b.message, 'Adyen has not booked this payment yet. Check again in a few minutes.');
    assert.equal(b.parts, null);
    assert.deepEqual(b.checks, { addsUp: null, feeMatchesRate: null });
    assert.deepEqual(b.lines, [{ key: 'customer_paid', label: 'Customer paid', minor: 100, source: 'adyen', detail: null }]);
    assert.deepEqual(b.references, [
      { label: 'Payment', term: 'PSP reference', id: PSP },
      { label: 'Venue account', term: 'balance account', id: VENUE_BA },
      { label: 'Platform account', term: 'liable balance account', id: LIABLE_BA },
    ]);
  }
  // refused and failed records are not bookings either
  const refused = PROVO_TRANSFERS.map((t) => ({ ...t, status: 'refused' }));
  assert.equal(provo({ transfers: refused }).state, 'waiting');
});

test('a hold is not money that moved: authorised or pending records give waiting, never Adds up', () => {
  for (const status of ['authorised', 'capturePending', 'bookingPending']) {
    const b = provo({ transfers: PROVO_TRANSFERS.map((t) => ({ ...t, status })) });
    assert.equal(b.state, 'waiting', status);
    assert.equal(b.message, WAITING_SENTENCE);
    assert.equal(b.checks.addsUp, null);
    assert.equal(line(b, 'servos_share'), undefined);
    assert.ok(b.warnings.includes('Adyen holds money for this payment but has not booked it yet.'), status);
  }
  // one record still pending while the rest are booked: not finished yet
  const half = provo({ transfers: [PROVO_TRANSFERS[0], PROVO_TRANSFERS[1], { ...PROVO_TRANSFERS[2], status: 'capturePending' }, PROVO_TRANSFERS[3]] });
  assert.equal(half.state, 'waiting');
  // a pending refund does not hold back a booked payment
  const refundPending = provo({ transfers: [...PROVO_TRANSFERS, fee('R1', 'BalanceAccount', 50, VENUE_BA, { type: 'refund', status: 'authorised' })] });
  assert.equal(refundPending.state, 'ok');
  // 'booked' counts like 'captured'
  assert.equal(provo({ transfers: PROVO_TRANSFERS.map((t) => ({ ...t, status: 'booked' })) }).state, 'ok');
});

test('expired and reversed records are dead: ignored, with no sums and no Adds up', () => {
  for (const status of ['expired', 'captureReversed', 'cancelled', 'returned', 'rejected', 'error']) {
    const b = provo({ transfers: PROVO_TRANSFERS.map((t) => ({ ...t, status })) });
    assert.equal(b.state, 'waiting', status);
    assert.deepEqual(b.warnings, [], status);
  }
  // a state the page does not know is named, not counted
  const odd = provo({ transfers: [...PROVO_TRANSFERS, { ...tr('Z', 'BalanceAccount', 'incoming', 5, VENUE_BA, 'Z'), status: 'mystery' }] });
  assert.equal(odd.state, 'ok');
  assert.deepEqual(odd.warnings, ['Adyen has a record in a state this page does not know, so it is not counted (mystery).']);
});

test('a read that was not complete: incomplete, one sentence, no sums and no gap', () => {
  const b = provo({ readComplete: false });
  assert.equal(b.state, 'incomplete');
  assert.equal(b.message, INCOMPLETE_SENTENCE);
  assert.equal(b.message, 'Some of Adyen\'s records could not be read, so this check is not finished.');
  assert.equal(b.parts, null);
  assert.equal(b.sumLine, null);
  assert.deepEqual(b.checks, { addsUp: null, feeMatchesRate: null });
  assert.deepEqual(b.lines.map((l) => l.key), ['customer_paid']);
  // the review's case: only the venue listing arrived (the platform one failed)
  const venueOnly = provo({ transfers: [PROVO_TRANSFERS[0]], readComplete: false });
  assert.equal(venueOnly.state, 'incomplete');
  assert.doesNotMatch(String(venueOnly.message), /gap/);
  // nothing read at all is not "waiting" either
  assert.equal(provo({ transfers: [], readComplete: false }).state, 'incomplete');
});

test('the fallback never shows a minus part: no venue fee record means the parts are not known', () => {
  const b = provo({ transfers: [PROVO_TRANSFERS[0], PROVO_TRANSFERS[3]] });
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen booked 94p, but the customer paid £1.00. The gap is 6p.');
  assert.deepEqual(b.parts.percent, { venue: null, franpos: 0, servos: null });
  assert.deepEqual(b.parts.fixed, { venue: null, franpos: 3, servos: null });
  assert.equal(b.parts.from, null);
  assert.deepEqual(b.warnings, ['Adyen booked no venue fee record on the platform account. The percent and fixed parts cannot be split.']);
});

test('a sale with no venue fee record to take (a percent too small to reach a penny): parts 0 and 0, no warning', () => {
  const rule = { ...PROVO_RULE, splitLogic: { ...PROVO_RULE.splitLogic, commission: { variablePercentage: 80 } } };
  const payment = { ...PROVO_PAYMENT, amount_minor: 50, commission_minor: 0 };
  const b = provo({ rule, payment, transfers: [tr('A', 'BalanceAccount', 'incoming', 50, VENUE_BA, 'A'), fee('F', 'PaymentFee', 1, LIABLE_BA)] });
  assert.equal(b.state, 'ok');
  assert.equal(b.parts.percent.venue, 0);
  assert.equal(b.parts.fixed.venue, 0);
  assert.equal(b.parts.from, 'adyen');
  assert.deepEqual(b.warnings, []);
  assert.equal(b.checks.feeMatchesRate, true);
  // FranPOS 0p + 3p, Adyen fees 1p: a 4p loss, shown as a loss
  assert.equal(b.parts.servosTotal, -4);
  assert.equal(line(b, 'venue_fee').detail, '0.8%');
});

test('which account: an Adyen fee taken from the VENUE lowers what the venue receives, not the ServOS share', () => {
  const b = provo({ transfers: [PROVO_TRANSFERS[0], PROVO_TRANSFERS[1], PROVO_TRANSFERS[2], fee('F', 'PaymentFee', 1, VENUE_BA)] });
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen took 1p of fees from the venue account, not the platform account.');
  assert.equal(b.checks.addsUp, true);
  assert.equal(line(b, 'venue_receives').minor, 93);
  assert.equal(line(b, 'venue_adyen_fees').minor, 1);
  assert.equal(line(b, 'venue_adyen_fees').label, 'Adyen fees taken from the venue');
  assert.equal(line(b, 'adyen_fees').minor, 0);
  assert.equal(line(b, 'left_on_platform').minor, 6);
  assert.equal(line(b, 'servos_share').minor, 3);
  assert.equal(b.sumLine, '93p + 6p + 1p = £1.00');
});

test('which account: a tip booked to the platform account is not money the venue received', () => {
  const payment = { ...PROVO_PAYMENT, amount_minor: 200, gratuity_minor: 100 };
  const b = provo({ payment, transfers: [PROVO_TRANSFERS[0], tr('TIP', 'Tip', 'incoming', 100, LIABLE_BA, 'TIP'), ...PROVO_TRANSFERS.slice(1)] });
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen paid £1.00 of this payment to an account that is not the venue.');
  assert.equal(b.checks.addsUp, false);
  assert.equal(line(b, 'venue_receives').minor, 94);
  assert.equal(line(b, 'tip'), undefined);
  assert.ok(b.warnings.includes('Adyen paid £1.00 of this payment to an account that is not the venue.'));
});

test('which account: venue fee records booked to the venue account are not the platform\'s money', () => {
  const onVenue = [PROVO_TRANSFERS[0], tr('T2', 'Commission', 'incoming', 5, VENUE_BA, 'FP'), tr('T3', 'Commission', 'incoming', 1, VENUE_BA, 'PP'), PROVO_TRANSFERS[3]];
  const b = provo({ transfers: onVenue });
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen booked 6p of the venue fee on the venue account, not the platform account.');
  assert.equal(line(b, 'venue_fee').minor, 0);
  assert.equal(line(b, 'venue_receives').minor, 100);
  assert.equal(line(b, 'servos_share').minor, -4);
  assert.equal(b.parts.from, null);
  // on a third account: named too
  const third = provo({ transfers: [PROVO_TRANSFERS[0], tr('T2', 'Commission', 'incoming', 5, 'BA_THIRD', 'FP'), tr('T3', 'Commission', 'incoming', 1, 'BA_THIRD', 'PP'), PROVO_TRANSFERS[3]] });
  assert.equal(third.state, 'mismatch');
  assert.equal(third.message, 'Adyen booked 6p of the venue fee on an account that is not the platform account.');
  // an Adyen fee from a third account
  const feeThird = provo({ transfers: [...PROVO_TRANSFERS.slice(0, 3), fee('F', 'PaymentFee', 1, 'BA_THIRD')] });
  assert.equal(feeThird.state, 'mismatch');
  assert.equal(feeThird.message, 'Adyen took 1p of fees from an account that is not the platform account.');
  assert.equal(line(feeThird, 'adyen_fees').minor, 0);
});

test('a tip: paid to the venue in full, the venue fee on the sale, and it still adds up', () => {
  // £11.00 paid, £1.00 of it a tip; 0.8% + 5p on the £10.00 sale is 8p + 5p
  const payment = { ...PROVO_PAYMENT, amount_minor: 1100, gratuity_minor: 100, commission_minor: 13 };
  const transfers = [
    tr('A', 'BalanceAccount', 'incoming', 987, VENUE_BA, 'R1'),
    tr('B', 'Tip', 'incoming', 100, VENUE_BA, 'R2'),
    tr('C', 'Commission', 'incoming', 5, LIABLE_BA, 'R3'),
    tr('D', 'Commission', 'incoming', 8, LIABLE_BA, 'R4'),
    tr('E', 'PaymentFee', 'outgoing', 10, LIABLE_BA, 'R5'),
  ];
  const b = provo({ payment, transfers });
  assert.equal(b.state, 'ok');
  assert.equal(line(b, 'customer_paid').detail, 'Includes a tip of £1.00.');
  assert.equal(line(b, 'tip').minor, 100);
  assert.equal(line(b, 'tip').detail, 'Paid to the venue in full.');
  assert.equal(line(b, 'venue_receives').minor, 1087);
  assert.equal(line(b, 'venue_receives').detail, 'Tip included.');
  assert.equal(line(b, 'venue_fee').minor, 13);
  assert.equal(b.sumLine, '£10.87 + 13p = £11.00');
  assert.deepEqual(b.checks, { addsUp: true, feeMatchesRate: true });
  // FranPOS on the whole £11.00: 1p + 3p. ServOS: 13 minus 10 minus 4 is a 1p loss
  assert.equal(line(b, 'franpos_rate').minor, 4);
  assert.equal(line(b, 'servos_share').minor, -1);
  assert.deepEqual(b.parts.percent, { venue: 8, franpos: 1, servos: 7 });
  assert.deepEqual(b.parts.fixed, { venue: 5, franpos: 3, servos: 2 });
  assert.equal(b.parts.servosTotal, -1);
  assert.equal(formatMinor(b.parts.servosTotal, 'GBP'), 'minus 1p');
});

test('a surcharge is its own line, paid to the venue, and never called a tip', () => {
  const payment = { ...PROVO_PAYMENT, amount_minor: 110 };
  const b = provo({ payment, transfers: [PROVO_TRANSFERS[0], tr('S', 'Surcharge', 'incoming', 10, VENUE_BA, 'S'), ...PROVO_TRANSFERS.slice(1)] });
  assert.equal(b.state, 'ok');
  assert.deepEqual(line(b, 'surcharge'), { key: 'surcharge', label: 'Surcharge', minor: 10, source: 'adyen', detail: 'Paid to the venue in full.' });
  assert.equal(line(b, 'tip'), undefined);
  assert.equal(line(b, 'customer_paid').detail, null);
  assert.equal(line(b, 'venue_receives').minor, 104);
  assert.equal(line(b, 'venue_receives').detail, 'Surcharge included.');
  assert.equal(line(b, 'servos_share').minor, 2);
  for (const l of b.lines) assert.doesNotMatch(String(l.detail), /tip/i);
  // both on one payment
  const both = provo({
    payment: { ...PROVO_PAYMENT, amount_minor: 210, gratuity_minor: 100 },
    transfers: [PROVO_TRANSFERS[0], tr('S', 'Surcharge', 'incoming', 10, VENUE_BA, 'S'), tr('TP', 'Tip', 'incoming', 100, VENUE_BA, 'TP'), ...PROVO_TRANSFERS.slice(1)],
  });
  assert.equal(line(both, 'venue_receives').detail, 'Tip and surcharge included.');
  assert.equal(both.state, 'ok');
});

test('a partial refund: its own line, never mixed into the sums', () => {
  const refundTr = (id, ppt, value, ba) => tr(id, ppt, 'outgoing', value, ba, `REF${id}`, { type: 'refund' });
  const payment = { ...PROVO_PAYMENT, amount_refunded_minor: 50 };
  const transfers = [...PROVO_TRANSFERS, refundTr('X1', 'BalanceAccount', 47, VENUE_BA), refundTr('X2', 'Commission', 3, LIABLE_BA)];
  const b = provo({ payment, transfers });
  assert.equal(b.state, 'ok');
  assert.deepEqual(provo().parts, b.parts);
  for (const key of ['customer_paid', 'venue_fee', 'venue_receives', 'adyen_fees', 'left_on_platform', 'franpos_rate', 'servos_share']) {
    assert.equal(line(b, key).minor, line(provo(), key).minor, key);
  }
  const ref = line(b, 'refunded');
  assert.deepEqual(ref, { key: 'refunded', label: 'Refunded', minor: 50, source: 'adyen', detail: 'Not counted in the sums above.' });
  assert.equal(b.lines[b.lines.length - 1].key, 'refunded');
  assert.deepEqual(b.references.filter((r) => r.label === 'Refund').map((r) => r.id), ['REFX1', 'REFX2']);
  // no refunded amount on the row: the refund records say how much
  const fromTransfers = provo({ transfers });
  assert.equal(line(fromTransfers, 'refunded').minor, 50);
});

test('a refund reversal takes the refund back off; a capture reversal is left out of the sums', () => {
  const refund = tr('RF', 'BalanceAccount', 'outgoing', 94, VENUE_BA, 'RF', { type: 'refund' });
  const reversal = tr('RR', 'BalanceAccount', 'incoming', 94, VENUE_BA, 'RR', { type: 'refundReversal' });
  const net = provo({ transfers: [...PROVO_TRANSFERS, refund, reversal] });
  assert.equal(line(net, 'refunded'), undefined);
  assert.equal(net.state, 'ok');
  assert.equal(line(provo({ transfers: [...PROVO_TRANSFERS, refund] }), 'refunded').minor, 94);
  // no direction on the records: the type decides
  const noDir = provo({ transfers: [...PROVO_TRANSFERS, { ...refund, direction: undefined }, { ...reversal, direction: undefined }] });
  assert.equal(line(noDir, 'refunded'), undefined);
  // a capture reversal would make a false gap if it were counted
  const capRev = provo({ transfers: [...PROVO_TRANSFERS, tr('CR', 'BalanceAccount', 'outgoing', 94, VENUE_BA, 'CR', { type: 'captureReversal' })] });
  assert.equal(capRev.state, 'ok');
  assert.equal(line(capRev, 'venue_receives').minor, 94);
  assert.deepEqual(capRev.warnings, ['Adyen reversed or corrected part of this payment. That is not counted in the sums.']);
});

test('other Adyen fee types are summed as Adyen fees', () => {
  const transfers = [
    PROVO_TRANSFERS[0], PROVO_TRANSFERS[1], PROVO_TRANSFERS[2],
    tr('F1', 'Interchange', 'outgoing', 1, LIABLE_BA, 'I1'),
    tr('F2', 'SchemeFee', 'outgoing', 1, LIABLE_BA, 'S1'),
    tr('F3', 'AdyenCommission', 'outgoing', 1, LIABLE_BA, 'C1'),
    tr('F4', 'AdyenMarkup', 'outgoing', 1, LIABLE_BA, 'M1'),
    tr('F5', 'AcquiringFees', 'outgoing', 1, LIABLE_BA, 'Q1'),
    { ...tr('F6', 'AdyenFees', null, -1, LIABLE_BA, 'Z1'), direction: undefined },
  ];
  const b = provo({ transfers });
  assert.equal(b.state, 'ok');
  assert.equal(line(b, 'adyen_fees').minor, 6);
  assert.equal(line(b, 'left_on_platform').minor, 0);
  assert.equal(line(b, 'servos_share').minor, -3);
  assert.equal(b.parts.adyenFees, 6);
  assert.equal(b.parts.percent.servos + b.parts.fixed.servos - b.parts.adyenFees, b.parts.servosTotal);
  assert.equal(b.references.filter((r) => r.label === 'Adyen fee').length, 6);
  // a fee refund (incoming) is a negative fee
  const back = provo({ transfers: [...PROVO_TRANSFERS, tr('FB', 'PaymentFee', 'incoming', 2, LIABLE_BA, 'FB')] });
  assert.equal(line(back, 'adyen_fees').minor, -1);
});

test('a transfer in another currency is ignored with a warning', () => {
  const usd = tr('U1', 'PaymentFee', 'outgoing', 7, LIABLE_BA, 'USD1');
  usd.amount.currency = 'USD';
  const b = provo({ transfers: [...PROVO_TRANSFERS, usd] });
  assert.equal(b.state, 'ok');
  assert.equal(line(b, 'adyen_fees').minor, 1);
  assert.deepEqual(b.warnings, ['One Adyen record is not in GBP, so it is not counted.']);
  const two = provo({ transfers: [...PROVO_TRANSFERS, usd, { ...usd, id: 'U2' }] });
  assert.deepEqual(two.warnings, ['2 Adyen records are not in GBP, so they are not counted.']);
  // only other currency records: nothing booked in GBP yet
  const only = provo({ transfers: [usd] });
  assert.equal(only.state, 'waiting');
  assert.equal(only.warnings.length, 1);
});

test('the rule is not found: the sums still prove, the parts cannot be split', () => {
  const b = provo({ rule: null });
  assert.equal(b.state, 'ok');
  assert.equal(line(b, 'venue_fee').detail, null);
  assert.equal(line(b, 'servos_share').minor, 2);
  assert.deepEqual(b.checks, { addsUp: true, feeMatchesRate: null });
  assert.deepEqual(b.parts.percent, { venue: null, franpos: 0, servos: null });
  assert.deepEqual(b.parts.fixed, { venue: null, franpos: 3, servos: null });
  assert.equal(b.parts.servosTotal, 2);
  assert.equal(b.parts.from, null);
  assert.deepEqual(b.warnings, ['The rate on Adyen for this payment was not found, so the percent and fixed parts cannot be split.']);
});

test('values that do not add up: mismatch, one plain sentence naming the gap', () => {
  const short = [tr('T1', 'BalanceAccount', 'incoming', 93, VENUE_BA, 'HR'), ...PROVO_TRANSFERS.slice(1)];
  const b = provo({ transfers: short });
  assert.equal(b.state, 'mismatch');
  assert.equal(b.checks.addsUp, false);
  assert.equal(b.message, 'Adyen booked 99p, but the customer paid £1.00. The gap is 1p.');
  assert.equal(b.sumLine, '93p + 6p = 99p');
  // the tables are still there to see
  assert.equal(line(b, 'venue_receives').minor, 93);
  // money paid to an account that is not the venue is named as the reason
  const elsewhere = [tr('T1', 'BalanceAccount', 'incoming', 94, 'BA_SOMEONE_ELSE', 'HR'), ...PROVO_TRANSFERS.slice(1)];
  const e = provo({ transfers: elsewhere });
  assert.equal(e.state, 'mismatch');
  assert.equal(e.checks.addsUp, false);
  assert.equal(e.message, 'Adyen paid 94p of this payment to an account that is not the venue.');
  assert.deepEqual(e.warnings, ['Adyen paid 94p of this payment to an account that is not the venue.']);
  // no venue id known: nothing is judged on a guess
  const unknown = provo({ transfers: elsewhere, venueBalanceAccountId: '' });
  assert.equal(unknown.state, 'ok');
});

test('a venue fee that is not what the rule gives: mismatch, the gap named, the parts from the rate', () => {
  const transfers = [
    tr('T1', 'BalanceAccount', 'incoming', 93, VENUE_BA, 'HR'),
    tr('T2', 'Commission', 'incoming', 5, LIABLE_BA, 'FP'),
    tr('T3', 'Commission', 'incoming', 2, LIABLE_BA, 'PP'),
    PROVO_TRANSFERS[3],
  ];
  const b = provo({ transfers });
  assert.equal(b.checks.addsUp, true);
  assert.equal(b.checks.feeMatchesRate, false);
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen took a venue fee of 7p, but the rate on Adyen gives 6p. The gap is 1p.');
  assert.equal(b.parts.from, 'rate');
});

test('the rate on Adyen changed after the payment: the two records are not labelled From Adyen parts', () => {
  // booked 5p and 1p at 0.8% + 5p; the store now says 0.8% + 1p
  const rule = { ...PROVO_RULE, splitLogic: { ...PROVO_RULE.splitLogic, commission: { variablePercentage: 80, fixedAmount: 1 } } };
  const b = provo({ rule });
  assert.equal(b.parts.from, 'rate');
  assert.equal(b.state, 'mismatch');
  assert.equal(b.message, 'Adyen took a venue fee of 6p, but the rate on Adyen gives 2p. The gap is 4p.');
  assert.deepEqual(b.warnings, ['The venue fee records do not match the rate on Adyen today, which may have changed since this payment. The percent and fixed parts are worked out from the rate on Adyen instead.']);
  assert.ok(!b.references.some((r) => /fixed part|percent part/.test(r.label)));
});

test('the fallback: two equal records, or not two, are split from the rule and it says so', () => {
  // one record of 6: fixed 5 from the rule, the percent is the rest
  const one = provo({ transfers: [PROVO_TRANSFERS[0], tr('C', 'Commission', 'incoming', 6, LIABLE_BA, 'C6'), PROVO_TRANSFERS[3]] });
  assert.equal(one.state, 'ok');
  assert.deepEqual(one.parts.percent, { venue: 1, franpos: 0, servos: 1 });
  assert.deepEqual(one.parts.fixed, { venue: 5, franpos: 3, servos: 2 });
  assert.equal(one.parts.from, 'rate');
  assert.deepEqual(one.warnings, ['Adyen booked the venue fee as one record. The percent and fixed parts are worked out from the rate on Adyen instead.']);
  // two equal records: 1% + 5p on £5.00 is 5p + 5p
  const payment = { ...PROVO_PAYMENT, amount_minor: 500 };
  const rule = { ...PROVO_RULE, splitLogic: { ...PROVO_RULE.splitLogic, commission: { variablePercentage: 100, fixedAmount: 5 } } };
  const eq = provo({ payment, rule, transfers: [tr('A', 'BalanceAccount', 'incoming', 490, VENUE_BA, 'A'), tr('B', 'Commission', 'incoming', 5, LIABLE_BA, 'B'), tr('C', 'Commission', 'incoming', 5, LIABLE_BA, 'C')] });
  assert.equal(eq.state, 'ok');
  assert.deepEqual([eq.parts.percent.venue, eq.parts.fixed.venue], [5, 5]);
  assert.deepEqual(eq.warnings, ['Adyen booked the venue fee as two equal records. The percent and fixed parts are worked out from the rate on Adyen instead.']);
  // three records
  const three = provo({ transfers: [PROVO_TRANSFERS[0], tr('C1', 'Commission', 'incoming', 3, LIABLE_BA, 'X'), tr('C2', 'Commission', 'incoming', 2, LIABLE_BA, 'Y'), tr('C3', 'Commission', 'incoming', 1, LIABLE_BA, 'Z')] });
  assert.equal(three.parts.from, 'rate');
  assert.match(three.warnings[0], /^Adyen booked the venue fee as 3 records\. /);
  // two unequal records, neither the fixed fee
  const neither = provo({ transfers: [PROVO_TRANSFERS[0], tr('C1', 'Commission', 'incoming', 4, LIABLE_BA, 'X'), tr('C2', 'Commission', 'incoming', 2, LIABLE_BA, 'Y'), PROVO_TRANSFERS[3]] });
  assert.equal(neither.parts.from, 'rate');
  assert.match(neither.warnings[0], /^The venue fee records do not match the rate on Adyen today/);
});

test('a rule with one part priced books one record, and that is the part, no fallback', () => {
  const fixedOnly = { ...PROVO_RULE, splitLogic: { ...PROVO_RULE.splitLogic, commission: { fixedAmount: 5 } } };
  const b = provo({ rule: fixedOnly, transfers: [tr('A', 'BalanceAccount', 'incoming', 95, VENUE_BA, 'A'), tr('B', 'Commission', 'incoming', 5, LIABLE_BA, 'B')] });
  assert.equal(b.state, 'ok');
  assert.deepEqual([b.parts.percent.venue, b.parts.fixed.venue, b.parts.from], [0, 5, 'adyen']);
  assert.deepEqual(b.warnings, []);
  assert.equal(line(b, 'venue_fee').detail, '5p');
  // a percent only rule books one record too
  const pctOnly = { ...PROVO_RULE, splitLogic: { ...PROVO_RULE.splitLogic, commission: { variablePercentage: 100 } } };
  const p = provo({ rule: pctOnly, payment: { ...PROVO_PAYMENT, amount_minor: 1000 }, transfers: [tr('A', 'BalanceAccount', 'incoming', 990, VENUE_BA, 'A'), tr('B', 'Commission', 'incoming', 10, LIABLE_BA, 'B')] });
  assert.deepEqual([p.parts.percent.venue, p.parts.fixed.venue, p.parts.from, p.state], [10, 0, 'adyen', 'ok']);
});

test('unknown record types are named and not counted; a chargeback in plain words', () => {
  const b = provo({ transfers: [...PROVO_TRANSFERS, { ...tr('W', 'VAT', 'outgoing', 1, LIABLE_BA, 'V'), type: 'chargeback' }, tr('Q', 'Mystery', 'incoming', 1, LIABLE_BA, 'Q'), { ...tr('N', '', 'incoming', 1, LIABLE_BA, 'N'), categoryData: { pspPaymentReference: PSP } }] });
  assert.equal(b.state, 'ok');
  assert.ok(b.warnings.includes('The customer\'s bank took this payment back (chargeback). That is not counted in the sums.'));
  assert.ok(b.warnings.includes('Adyen booked a record this page does not know, so it is not counted (Mystery, no type).'));
});

test('USD reads in cents and dollars', () => {
  const payment = { ...PROVO_PAYMENT, currency: 'USD', amount_minor: 1234 };
  const rule = { ...PROVO_RULE, currency: 'USD' };
  const t = (id, ppt, dir, v, ba) => { const x = tr(id, ppt, dir, v, ba, id); x.amount.currency = 'USD'; return x; };
  const fp = resellerRateFor({ history: [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: 3, USD: 5 }, from_month: '2026-09' }] }, 'USD', '2026-09');
  const b = buildPaymentBreakdown({
    payment, rule, venueBalanceAccountId: VENUE_BA, reseller: fp,
    transfers: [t('A', 'BalanceAccount', 'incoming', 1219, VENUE_BA), t('B', 'Commission', 'incoming', 5, LIABLE_BA), t('C', 'Commission', 'incoming', 10, LIABLE_BA), t('D', 'PaymentFee', 'outgoing', 9, LIABLE_BA)],
  });
  assert.equal(b.state, 'ok');
  assert.equal(b.sumLine, '$12.19 + 15c = $12.34');
  assert.equal(line(b, 'franpos_rate').detail, '0.10% + 5c');
  assert.equal(line(b, 'venue_fee').detail, '0.8% + 5c');
  assert.equal(line(b, 'servos_share').minor, 15 - 9 - (1 + 5));
  // the trimmed shape the server sends back reads the same
  const trimmed = buildPaymentBreakdown({
    payment, rule, venueBalanceAccountId: VENUE_BA, liableBalanceAccountId: LIABLE_BA, reseller: fp,
    transfers: [['A', 'BalanceAccount', 'incoming', 1219, VENUE_BA], ['B', 'Commission', 'incoming', 5, LIABLE_BA], ['C', 'Commission', 'incoming', 10, LIABLE_BA], ['D', 'PaymentFee', 'outgoing', 9, LIABLE_BA]]
      .map(([id, ppt, direction, amountMinor, balanceAccountId]) => ({ id, status: 'captured', type: 'capture', direction, amountMinor, currency: 'USD', balanceAccountId, reference: id, platformPaymentType: ppt, pspPaymentReference: PSP })),
  });
  assert.equal(trimmed.state, 'ok');
  assert.deepEqual(trimmed.parts, b.parts);
  assert.equal(buildPaymentBreakdown().state, 'waiting');
});

test('formatMinor: pence below £1, pounds from £1, cents for USD and EUR, no dashes', () => {
  assert.equal(formatMinor(6, 'GBP'), '6p');
  assert.equal(formatMinor(0, 'GBP'), '0p');
  assert.equal(formatMinor(99, 'GBP'), '99p');
  assert.equal(formatMinor(100, 'GBP'), '£1.00');
  assert.equal(formatMinor(123456, 'GBP'), '£1,234.56');
  assert.equal(formatMinor(6, 'USD'), '6c');
  assert.equal(formatMinor(250, 'USD'), '$2.50');
  assert.equal(formatMinor(6, 'EUR'), '6c');
  assert.equal(formatMinor(250, 'eur'), '€2.50');
  assert.equal(formatMinor(-3, 'GBP'), 'minus 3p');
  assert.equal(formatMinor(-150, 'GBP'), 'minus £1.50');
  assert.equal(formatMinor(null, 'GBP'), 'Not known');
  assert.equal(formatMinor(500, 'CAD'), '5.00 CAD');
});

test('paymentCardLabel: brand plus the application name, never a raw code', () => {
  assert.equal(paymentCardLabel(PROVO_PAYMENT.card), 'Visa Debit ending 1234');
  assert.equal(paymentCardLabel({ brand: 'mc' }), 'Mastercard');
  assert.equal(paymentCardLabel({ brand: 'amex', last4: '0005' }), 'Amex ending 0005');
  assert.equal(paymentCardLabel({ brand: 'visa', applicationName: 'Barclaycard' }), 'Visa, Barclaycard');
  assert.equal(paymentCardLabel({ applicationName: 'MASTERCARD' }), 'Mastercard');
  assert.equal(paymentCardLabel({ brand: 'klarna_paynow' }), 'Klarna Paynow');
  assert.equal(paymentCardLabel(null), 'Card');
});

test('paymentCardLabel: Apple Pay and Google Pay wallet codes read as words', () => {
  assert.equal(paymentCardLabel({ brand: 'mc_applepay', last4: '4321' }), 'Mastercard on Apple Pay ending 4321');
  assert.equal(paymentCardLabel({ brand: 'visa_googlepay' }), 'Visa on Google Pay');
  assert.equal(paymentCardLabel({ brand: 'amex_applepay' }), 'Amex on Apple Pay');
  assert.equal(paymentCardLabel({ brand: 'maestro_paywithgoogle' }), 'Maestro on Google Pay');
  assert.equal(paymentCardLabel({ brand: 'mc_applepay', applicationName: 'MASTERCARD' }), 'Mastercard on Apple Pay');
  assert.equal(paymentCardLabel({ brand: 'visa_applepay', applicationName: 'VISA DEBIT', last4: '1' }), 'Visa Debit on Apple Pay ending 1');
  assert.equal(paymentCardLabel({ brand: 'applepay' }), 'Apple Pay');
  for (const card of [{ brand: 'mc_applepay' }, { brand: 'visa_googlepay' }]) assert.doesNotMatch(paymentCardLabel(card), /_|applepay|googlepay/);
});

test('ruleForTier: the same mapping profileTiers reads, in the payment currency', () => {
  const tiers = { card_present: { percent: 0.8, fixedPence: 5 }, card_not_present: { percent: 1.5, fixedPence: 20 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.9, fixedPence: 15 } };
  const profile = { rules: tieredCommissionRules('GBP', tiers).rules };
  const read = profileTiers(profile);
  for (const tier of ['card_present', 'card_not_present', 'amex', 'keyed']) {
    const rule = ruleForTier(profile, tier, 'GBP');
    assert.ok(rule, tier);
    assert.deepEqual(ruleRate(rule), { percent: read[tier].percent, fixedMinor: read[tier].fixedPence }, tier);
  }
  // the amex ANY interaction rule is THE amex rule
  assert.equal(ruleForTier(profile, 'amex', 'GBP').shopperInteraction, 'ANY');
  // with no ANY interaction amex rule, the first amex rule is used
  const amexOnly = { rules: [{ currency: 'GBP', paymentMethod: 'amex', shopperInteraction: 'Ecommerce', splitLogic: { commission: { variablePercentage: 250 } } }] };
  assert.equal(ruleForTier(amexOnly, 'amex', 'GBP'), amexOnly.rules[0]);
  // another currency, an unknown tier, no profile: not found
  assert.equal(ruleForTier(profile, 'card_present', 'USD'), null);
  assert.equal(ruleForTier(profile, 'unclassified', 'GBP'), null);
  assert.equal(ruleForTier(null, 'card_present', 'GBP'), null);
  // the Provo profile, one rule
  assert.equal(ruleForTier({ rules: [PROVO_RULE] }, 'card_present', 'gbp'), PROVO_RULE);
  assert.deepEqual(ruleRate(PROVO_RULE), { percent: 0.8, fixedMinor: 5 });
  assert.equal(venueRateLine(ruleRate(PROVO_RULE), 'GBP'), '0.8% + 5p');
  assert.equal(venueRateLine({ percent: 0, fixedMinor: 0 }, 'GBP'), '0%');
});

test('every word on screen: plain, no dashes, sentences under 120 characters, never commission', () => {
  for (const s of [...Object.values(BREAKDOWN_LABELS), ...Object.values(SOURCE_WORDS), WAITING_SENTENCE, INCOMPLETE_SENTENCE]) {
    noDash(s);
    sentencesShort(s);
    assert.doesNotMatch(s, /commission/i);
  }
  assert.deepEqual({ ...SOURCE_WORDS }, { adyen: 'From Adyen', rate: 'Rate on Adyen', franpos: 'FranPOS rate on file', computed: 'Worked out' });
  const shapes = [
    provo(),
    provo({ transfers: [] }),
    provo({ readComplete: false }),
    provo({ rule: null }),
    provo({ reseller: null }),
    provo({ transfers: [tr('T1', 'BalanceAccount', 'incoming', 93, VENUE_BA, 'HR'), ...PROVO_TRANSFERS.slice(1)] }),
    provo({ transfers: [PROVO_TRANSFERS[0], tr('C', 'Commission', 'incoming', 6, LIABLE_BA, 'C6')] }),
    provo({ transfers: [PROVO_TRANSFERS[0], tr('C1', 'Commission', 'incoming', 4, LIABLE_BA, 'X'), tr('C2', 'Commission', 'incoming', 2, LIABLE_BA, 'Y')] }),
    provo({ transfers: [PROVO_TRANSFERS[0], PROVO_TRANSFERS[3]] }),
    provo({ transfers: [...PROVO_TRANSFERS, { ...tr('W', 'VAT', 'outgoing', 1, LIABLE_BA, 'V'), type: 'chargeback' }, tr('Q', 'Mystery', 'incoming', 1, LIABLE_BA, 'Q')] }),
    provo({ transfers: [PROVO_TRANSFERS[0], tr('T2', 'Commission', 'incoming', 5, 'BA_X', 'FP'), tr('T3', 'Commission', 'incoming', 1, VENUE_BA, 'PP'), fee('F', 'PaymentFee', 1, VENUE_BA), fee('G', 'PaymentFee', 1, 'BA_X'), tr('TP', 'Tip', 'incoming', 1, 'BA_X', 'TP')] }),
    provo({ transfers: PROVO_TRANSFERS.map((t) => ({ ...t, status: 'authorised' })) }),
    provo({ transfers: [...PROVO_TRANSFERS, tr('CR', 'BalanceAccount', 'outgoing', 94, VENUE_BA, 'CR', { type: 'captureReversal' }), { ...PROVO_TRANSFERS[0], id: 'odd', status: 'strange' }] }),
  ];
  for (const b of shapes) {
    for (const s of [b.message, ...b.warnings, ...b.lines.map((l) => l.label), ...b.lines.map((l) => l.detail)]) {
      if (s === null) continue;
      noDash(s);
      sentencesShort(s);
      assert.doesNotMatch(s, /commission|BA32|FSPK/i, s);
    }
    for (const r of b.references) {
      noDash(r.label);
      assert.doesNotMatch(r.label, /BA32|FSPK/);
      assert.doesNotMatch(String(r.term), /commission/i);
    }
  }
  // the reseller missing is said, and the share is not guessed
  const noFp = provo({ reseller: null });
  assert.equal(line(noFp, 'servos_share').minor, null);
  assert.ok(noFp.warnings.includes('The FranPOS rate is not on file, so the ServOS share cannot be worked out.'));
});

// ── THE TWO COPIES AGREE ─────────────────────────────────────────────────────
// Keep this test LAST: it replays every input the tests above recorded.
const TS_MIRROR = '../../../supabase/functions/_shared/paymentBreakdown.ts';
test('TS mirror: every export answers exactly as the JS copy, on every input the suite built', async (t) => {
  // Skip ONLY when this node cannot strip types at all. Any other import
  // error (a syntax break in the mirror) fails the test.
  if (!process.features?.typescript) { t.skip('this node cannot strip TypeScript types'); return; }
  const ts = await import(TS_MIRROR);
  const jsNames = Object.keys(jsModule).sort();
  const tsNames = Object.keys(ts).filter((k) => typeof ts[k] !== 'undefined').sort();
  assert.deepEqual(tsNames, jsNames, 'the two copies export the same names');
  for (const k of jsNames) {
    if (typeof jsModule[k] !== 'function') assert.deepEqual(ts[k], jsModule[k], `constant ${k}`);
  }
  assert.ok(RECORDED.length > 60, `the suite recorded ${RECORDED.length} inputs`);
  for (const input of RECORDED) assert.deepEqual(ts.buildPaymentBreakdown(input), jsModule.buildPaymentBreakdown(input));
  assert.deepEqual(ts.buildPaymentBreakdown(), jsModule.buildPaymentBreakdown());
  for (const [m, c] of [[6, 'GBP'], [100, 'GBP'], [-150, 'USD'], [null, 'EUR'], [500, 'CAD'], [123456, 'GBP'], [0, 'eur']]) assert.equal(ts.formatMinor(m, c), formatMinor(m, c));
  const cards = [
    PROVO_PAYMENT.card, { brand: 'mc' }, { brand: 'visa', applicationName: 'Barclaycard' }, null, { applicationName: 'MASTERCARD' },
    { brand: 'klarna_paynow' }, { brand: 'mc_applepay', last4: '4321' }, { brand: 'visa_googlepay' }, { brand: 'visa_applepay', applicationName: 'VISA DEBIT' },
    { brand: 'maestro_paywithgoogle' }, { brand: 'applepay' },
  ];
  for (const card of cards) assert.equal(ts.paymentCardLabel(card), paymentCardLabel(card));
  const profile = { rules: tieredCommissionRules('GBP', { card_present: { percent: 0.8, fixedPence: 5 }, card_not_present: { percent: 1.5, fixedPence: 20 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.9, fixedPence: 15 } }).rules };
  const amexOnly = { rules: [{ currency: 'GBP', paymentMethod: 'amex', shopperInteraction: 'Ecommerce' }] };
  for (const p of [profile, amexOnly, null, { rules: [PROVO_RULE] }]) {
    for (const tier of ['card_present', 'card_not_present', 'amex', 'keyed', 'x']) {
      for (const cur of ['GBP', 'USD']) {
        assert.deepEqual(ts.ruleForTier(p, tier, cur), ruleForTier(p, tier, cur));
        assert.deepEqual(ts.ruleRate(ruleForTier(p, tier, cur)), ruleRate(ruleForTier(p, tier, cur)));
      }
    }
  }
  for (const [rate, cur] of [[{ percent: 0.8, fixedMinor: 5 }, 'USD'], [{ percent: 0, fixedMinor: 0 }, 'GBP'], [{ percent: 0.8 }, 'GBP'], [{ fixedMinor: 5 }, 'EUR'], [null, 'GBP']]) {
    assert.equal(ts.venueRateLine(rate, cur), venueRateLine(rate, cur));
  }
});
