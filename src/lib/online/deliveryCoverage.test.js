/**
 * deliveryCoverage.test.js: the delivery address sheet's words and state, the basket bar's
 * minimum order line, the address edits, the one quote call with its timeout, and the source
 * pins (OnlineCheckout goes through the shared helper and has no quote call of its own).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EMPTY_DELIVERY, NOT_COVERED_REASONS, deliveryAddressLine, canCheckAddress, deliveryDropoff,
  typeAddress, typePostcode, pickAddress, withQuote, coverageState, minimumOrderShortfall,
  basketMinimumWords, coverageWords, deliveryBlockWords, tryVenueButton, collectInsteadLabel,
  postcodeLabel, addressCountry, quoteDeliveryAddress,
} from './deliveryCoverage.js';

const gbp = (m) => `£${(m / 100).toFixed(2)}`;
const covered = { available: true, customerFeeMinor: 344, minOrderMinor: 1500, freeDelivery: false, currency: 'GBP' };
const at = (quote, address1 = '12 High Street', postcode = 'HD1 2AB') => ({ address1, postcode, geo: null, quote });

test('the address line joins the typed parts and is never null', () => {
  assert.equal(deliveryAddressLine('12 High Street', 'HD1 2AB'), '12 High Street, HD1 2AB');
  assert.equal(deliveryAddressLine(' 12 High Street ', ''), '12 High Street');
  assert.equal(deliveryAddressLine(null, undefined), '');
});

test('the check may run only with both parts typed', () => {
  assert.equal(canCheckAddress(EMPTY_DELIVERY), false);
  assert.equal(canCheckAddress({ address1: '12 High Street', postcode: ' ' }), false);
  assert.equal(canCheckAddress({ address1: '12 High Street', postcode: 'hd1 2ab' }), true);
});

test('the dropoff trims line 1, upper cases the postcode and carries the picked coordinates only', () => {
  assert.deepEqual(deliveryDropoff({ address1: ' 12 High Street ', postcode: ' hd1 2ab ', geo: null }), { line1: '12 High Street', postcode: 'HD1 2AB' });
  assert.deepEqual(deliveryDropoff({ address1: '12 High Street', postcode: 'HD1 2AB', geo: { lat: '53.64', lng: -1.78 } }), { line1: '12 High Street', postcode: 'HD1 2AB', lat: 53.64, lng: -1.78 });
  assert.deepEqual(deliveryDropoff({ address1: 'x', postcode: 'y', geo: { lat: 'north', lng: null } }), { line1: 'x', postcode: 'Y' });
});

test('typing a new address drops the coordinates and the quote; the suggestion pick keeps its coordinates', () => {
  const picked = pickAddress(at(covered), { line1: '9 New Street', postcode: 'HD3 4LN', lat: 53.6458, lng: -1.785 });
  assert.deepEqual(picked, { address1: '9 New Street', postcode: 'HD3 4LN', geo: { lat: 53.6458, lng: -1.785 }, quote: null });
  // the autocomplete then reports the same text through onChangeText: nothing changes
  assert.equal(typeAddress(picked, '9 New Street'), picked);
  // a different text is a new address
  assert.deepEqual(typeAddress(picked, '9 New Stree'), { address1: '9 New Stree', postcode: 'HD3 4LN', geo: null, quote: null });
  assert.deepEqual(typePostcode(picked, 'HD1 1AA'), { address1: '9 New Street', postcode: 'HD1 1AA', geo: null, quote: null });
  // a pick with no postcode keeps the one typed; a pick with no coordinates has none
  assert.deepEqual(pickAddress(at(null, '', 'HD1 2AB'), { label: 'Somewhere' }), { address1: 'Somewhere', postcode: 'HD1 2AB', geo: null, quote: null });
  assert.deepEqual(typeAddress(null, 'a'), { address1: 'a', postcode: '', geo: null, quote: null });
});

test('a quote lands only on the address it was asked for', () => {
  const asked = { address1: '12 High Street', postcode: 'HD1 2AB' };
  assert.deepEqual(withQuote(at(null), asked, covered), at(covered));
  const moved = at(null, '13 High Street');
  assert.equal(withQuote(moved, asked, covered), moved);
});

test('coverage state: empty, unchecked, checking, covered, not covered, error', () => {
  assert.equal(coverageState(EMPTY_DELIVERY), 'empty');
  assert.equal(coverageState(at(null)), 'unchecked');
  assert.equal(coverageState(at(null), { checking: true }), 'checking');
  assert.equal(coverageState(at(covered)), 'covered');
  assert.equal(coverageState(at({ ...covered, belowMinimum: true })), 'covered', 'the minimum order is not a coverage matter');
  for (const reason of NOT_COVERED_REASONS) assert.equal(coverageState(at({ available: false, reason })), 'not_covered', reason);
  for (const reason of ['transport_error', 'timeout', 'stuart_auth_failed', 'quote_failed', 'no_quote', 'error', 'offline', 'disabled', undefined]) {
    assert.equal(coverageState(at({ available: false, reason })), 'error', String(reason));
  }
});

test('the minimum order shortfall follows the live basket, not the quote moment', () => {
  assert.equal(minimumOrderShortfall(covered, 0), 1500);
  assert.equal(minimumOrderShortfall(covered, 1050), 450);
  assert.equal(minimumOrderShortfall(covered, 1500), 0);
  assert.equal(minimumOrderShortfall(covered, 2000), 0);
  assert.equal(minimumOrderShortfall({ ...covered, minOrderMinor: null }, 0), 0);
  assert.equal(minimumOrderShortfall({ ...covered, minOrderMinor: 0 }, 0), 0);
  assert.equal(minimumOrderShortfall({ available: false, reason: 'out_of_radius', minOrderMinor: 1500 }, 0), 0);
  assert.equal(minimumOrderShortfall(null, 0), 0);
  assert.equal(minimumOrderShortfall(covered, -5), 1500);
});

test('the basket bar says how much more to add, in the venue currency, and nothing once it is met', () => {
  assert.equal(basketMinimumWords(covered, 1050, gbp), 'Add £4.50 more for delivery');
  assert.equal(basketMinimumWords(covered, 1500, gbp), '');
  assert.equal(basketMinimumWords(null, 0, gbp), '');
  assert.equal(basketMinimumWords(covered, 0, (m) => `$${(m / 100).toFixed(2)}`), 'Add $15.00 more for delivery');
});

test('the sheet words: covered names the address, the fee and the minimum', () => {
  const w = coverageWords(at(covered), { fmt: gbp });
  assert.equal(w.state, 'covered');
  assert.equal(w.title, 'We deliver to 12 High Street, HD1 2AB');
  assert.equal(w.detail, 'Delivery fee £3.44. Minimum order £15.00.');
  assert.equal(coverageWords(at({ ...covered, customerFeeMinor: 0 }), { fmt: gbp }).detail, 'Delivery is free. Minimum order £15.00.');
  assert.equal(coverageWords(at({ ...covered, freeDelivery: true }), { fmt: gbp }).detail, 'Delivery is free. Minimum order £15.00.');
  assert.equal(coverageWords(at({ ...covered, minOrderMinor: null }), { fmt: gbp }).detail, 'Delivery fee £3.44.');
});

test('the sheet words: not covered says so and points at collection or another venue', () => {
  const w = coverageWords(at({ available: false, reason: 'out_of_radius' }), { fmt: gbp });
  assert.equal(w.state, 'not_covered');
  assert.equal(w.title, 'We do not deliver there yet');
  assert.equal(w.detail, '12 High Street, HD1 2AB is outside our delivery area. Choose collection instead.');
  const w2 = coverageWords(at({ available: false, reason: 'out_of_coverage' }), { fmt: gbp, siblings: 1 });
  assert.equal(w2.detail, '12 High Street, HD1 2AB is outside our delivery area. Choose collection instead, or try another of our venues.');
  const us = coverageWords(at({ available: false, reason: 'out_of_radius' }), { fmt: gbp, location: { currency: 'USD' } });
  assert.equal(us.detail, '12 High Street, HD1 2AB is outside our delivery area. Choose pickup instead.');
});

test('the sheet words: a check that did not run says so and never reads as not covered', () => {
  const w = coverageWords(at({ available: false, reason: 'timeout' }), { fmt: gbp });
  assert.equal(w.state, 'error');
  assert.equal(w.title, 'We could not check that address');
  assert.equal(w.detail, 'The delivery check did not run. Try again, or choose collection instead.');
  assert.deepEqual(coverageWords(at(null), { checking: true }), { state: 'checking', title: 'Checking your address', detail: 'One moment.' });
  assert.deepEqual(coverageWords(EMPTY_DELIVERY), { state: 'empty', title: '', detail: '' });
  assert.deepEqual(coverageWords(at(null)), { state: 'unchecked', title: '', detail: '' });
});

test('the checkout block words: one wording for the details step and the payment gate', () => {
  assert.equal(deliveryBlockWords(null, { fmt: gbp }), null, 'the details step never fails on a quote still running');
  assert.equal(deliveryBlockWords(null, { fmt: gbp, whileChecking: true }), 'Checking delivery for your address. One moment, then try again.');
  assert.equal(deliveryBlockWords({ available: false, reason: 'out_of_radius' }, { fmt: gbp }), 'Sorry, your address is outside our delivery area. Please choose collection.');
  assert.equal(deliveryBlockWords({ available: false, reason: 'out_of_coverage' }, { fmt: gbp }), 'Sorry, your address is outside our delivery area. Please choose collection.');
  assert.equal(deliveryBlockWords({ available: false, reason: 'quote_failed' }, { fmt: gbp }), 'Delivery is not available for this address right now. Please choose collection.');
  assert.equal(deliveryBlockWords({ ...covered, belowMinimum: true }, { fmt: gbp }), 'Minimum order for delivery is £15.00. Add more to your basket or choose collection.');
  assert.equal(deliveryBlockWords({ ...covered, belowMinimum: true }, { fmt: gbp, location: { currency: 'USD' } }), 'Minimum order for delivery is £15.00. Add more to your basket or choose pickup.');
  assert.equal(deliveryBlockWords(covered, { fmt: gbp }), null);
});

test('the Try venue button, the collect label, the postcode label and the Mapbox country', () => {
  assert.equal(tryVenueButton([]), null);
  assert.equal(tryVenueButton(null), null);
  assert.deepEqual(tryVenueButton([{ id: 'a', name: 'Location 2' }]), { label: 'Try Location 2' });
  assert.deepEqual(tryVenueButton([{ id: 'a', name: 'Location 2' }, { id: 'b', name: 'Leeds' }]), { label: 'Try another location' });
  assert.equal(collectInsteadLabel({ currency: 'GBP' }), 'Collection instead');
  assert.equal(collectInsteadLabel({ currency: 'USD' }), 'Pickup instead');
  assert.equal(postcodeLabel({ currency: 'GBP' }), 'Postcode');
  assert.equal(postcodeLabel({ currency: 'USD' }), 'ZIP code');
  assert.equal(postcodeLabel(null), 'Postcode');
  assert.equal(addressCountry({ currency: 'USD' }), 'us');
  assert.equal(addressCountry({ currency: 'EUR' }), 'gb');
});

test('quoteDeliveryAddress makes the one quote call with the dropoff and the basket', async () => {
  const calls = [];
  const q = await quoteDeliveryAddress(
    { opsLocationId: 'loc-1', delivery: { address1: ' 12 High Street ', postcode: 'hd1 2ab', geo: { lat: 53.6, lng: -1.8 } }, orderSubtotalMinor: 1234.4 },
    { getDeliveryQuote: async (args) => { calls.push(args); return covered; } },
  );
  assert.equal(q, covered);
  assert.deepEqual(calls, [{ opsLocationId: 'loc-1', dropoff: { line1: '12 High Street', postcode: 'HD1 2AB', lat: 53.6, lng: -1.8 }, orderSubtotalMinor: 1234 }]);
});

test('quoteDeliveryAddress never throws: a thrown call and a slow call both come back as a check that did not run', async () => {
  const thrown = await quoteDeliveryAddress({ opsLocationId: 'loc-1', delivery: at(null) }, { getDeliveryQuote: async () => { throw new Error('boom'); } });
  assert.equal(thrown.available, false);
  assert.equal(thrown.reason, 'transport_error');
  assert.equal(coverageState(at(thrown)), 'error');
  const slow = await quoteDeliveryAddress({ opsLocationId: 'loc-1', delivery: at(null) }, { getDeliveryQuote: () => new Promise(() => {}), timeoutMs: 20 });
  assert.deepEqual(slow, { available: false, reason: 'timeout' });
  assert.equal(coverageState(at(slow)), 'error');
  const empty = await quoteDeliveryAddress({ opsLocationId: 'loc-1', delivery: at(null) }, { getDeliveryQuote: async () => null });
  assert.deepEqual(empty, { available: false, reason: 'error' });
});

// Source pins: one quote call, one set of words, the page owns the address, the sheet is online only.
const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

test('OnlineCheckout goes through the shared helper and has no quote call or reason wording of its own', () => {
  const checkout = read('src/surfaces/online/OnlineCheckout.jsx');
  assert.match(checkout, /import \{[^}]*quoteDeliveryAddress[^}]*\} from '\.\.\/\.\.\/lib\/online\/deliveryCoverage'/);
  assert.match(checkout, /import \{ recordDeliverySurcharge \} from '\.\.\/\.\.\/lib\/delivery\/quoteService'/);
  assert.doesNotMatch(checkout, /getDeliveryQuote/, 'the checkout makes no quote call of its own');
  assert.doesNotMatch(checkout, /out_of_radius|out_of_coverage|outside our delivery area/, 'the reason wording lives in lib/online/deliveryCoverage.js');
  assert.match(checkout, /delivery: deliveryProp = null, onDeliveryChange = null/);
  assert.match(checkout, /const delivery = deliveryProp \|\| ownDelivery;/);
  assert.match(checkout, /quoteDeliveryAddress\(\{ opsLocationId, delivery: asked, orderSubtotalMinor: discountedSubtotalMinor \}\)/);
  assert.match(checkout, /deliveryBlockWords\(deliveryQuote, \{ fmt: fmtMinor, whileChecking: true, location \}\)/, 'the payment gate');
  assert.match(checkout, /deliveryBlockWords\(deliveryQuote, \{ fmt: fmtMinor, location \}\)/, 'the details step');
  assert.doesNotMatch(checkout, /useState\(''\);\s*\/\/ address|const \[address1, setAddress1\] = useState/, 'no second copy of the address state');
});

test('the page owns the delivery address, opens the sheet on Delivery and hands the address to the checkout', () => {
  const surface = read('src/surfaces/online/OnlineSurface.jsx');
  assert.match(surface, /const \[delivery, setDelivery\] = useState\(EMPTY_DELIVERY\)/);
  assert.match(surface, /delivery=\{delivery\} onDeliveryChange=\{setDelivery\}/);
  assert.match(surface, /if \(t === 'delivery'\) \{ setSheet\('address'\); return; \}/, 'Delivery opens the address sheet; the type changes on Continue');
  assert.match(surface, /sheet === 'address' && !isQr/);
  assert.match(surface, /basketMinimumWords\(delivery\.quote, Math\.round\(cartTotal \* 100\), fmtMinor\)/);
  assert.doesNotMatch(surface, /getDeliveryQuote|out_of_radius|out_of_coverage/, 'no second copy of the coverage logic');
  const sheet = read('src/surfaces/online/DeliveryAddressSheet.jsx');
  assert.match(sheet, /import \{[^}]*coverageWords[^}]*\} from '\.\.\/\.\.\/lib\/online\/deliveryCoverage'/);
  assert.doesNotMatch(sheet, /getDeliveryQuote|out_of_radius|out_of_coverage|#[0-9a-fA-F]{3,6}\b/, 'the sheet reads words from the helper and paints with theme tokens only');
});

test('no em or en dashes in the new files', () => {
  for (const f of ['src/lib/online/deliveryCoverage.js', 'src/lib/online/deliveryCoverage.test.js', 'src/surfaces/online/DeliveryAddressSheet.jsx']) {
    assert.doesNotMatch(read(f), new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`), f);
  }
});
