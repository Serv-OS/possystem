/**
 * orderTiming.test.js: the online page's timing state and header words (5.12.34).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leadMinutesFor, advanceDaysFor, initialTiming, settleTiming, prepRangeWords, pickupWord,
  timingRowWords, orderTypePillWords, orderTypeChoices, locationRowWords, locationRowParts,
} from './orderTiming.js';

test('leadMinutesFor: the column as set, 30 when missing, 0 stays 0', () => {
  assert.equal(leadMinutesFor({ online_collection_lead_min: 25 }), 25);
  assert.equal(leadMinutesFor({ online_collection_lead_min: '40' }), 40);
  assert.equal(leadMinutesFor({ online_collection_lead_min: 0 }), 0);
  assert.equal(leadMinutesFor({}), 30);
  assert.equal(leadMinutesFor(null), 30);
  assert.equal(leadMinutesFor({ online_collection_lead_min: 'soon' }), 30);
});

test('advanceDaysFor: blank is 7, 0 is today only, negatives clamp', () => {
  assert.equal(advanceDaysFor({}), 7);
  assert.equal(advanceDaysFor({ online_advance_days: null }), 7);
  assert.equal(advanceDaysFor({ online_advance_days: 0 }), 0);
  assert.equal(advanceDaysFor({ online_advance_days: 3 }), 3);
  assert.equal(advanceDaysFor({ online_advance_days: -2 }), 0);
});

test('initialTiming: ASAP, or Schedule while the venue is closed and taking orders ahead', () => {
  assert.deepEqual(initialTiming(), { mode: 'asap', slot: null });
  assert.deepEqual(initialTiming({ orderAheadOnly: true }), { mode: 'scheduled', slot: null });
});

const slots = [
  { iso: '2026-11-02T18:00:00.000Z', day: 'Today', label: '18:00' },
  { iso: '2026-11-02T18:15:00.000Z', day: 'Today', label: '18:15' },
];

test('settleTiming: ASAP is left alone and returns the same object', () => {
  const t = { mode: 'asap', slot: null };
  assert.equal(settleTiming(t, slots), t);
});

test('settleTiming: scheduled with no slot takes the first; a stale slot moves to the first and says so', () => {
  assert.deepEqual(settleTiming({ mode: 'scheduled', slot: null }, slots), { mode: 'scheduled', slot: slots[0] });
  const kept = { mode: 'scheduled', slot: slots[1] };
  assert.equal(settleTiming(kept, slots), kept);
  const moved = settleTiming({ mode: 'scheduled', slot: { iso: '2026-11-02T17:00:00.000Z', day: 'Today', label: '17:00' } }, slots);
  assert.equal(moved.slot, slots[0]);
  assert.equal(moved.moved, true);
});

test('settleTiming: orderAheadOnly forces Schedule; an empty slot list leaves the slot null', () => {
  const t = settleTiming({ mode: 'asap', slot: null }, slots, { orderAheadOnly: true });
  assert.equal(t.mode, 'scheduled');
  assert.equal(t.slot, slots[0]);
  assert.deepEqual(settleTiming({ mode: 'scheduled', slot: null }, []), { mode: 'scheduled', slot: null });
  assert.deepEqual(settleTiming(null, []), { mode: 'asap', slot: null });
});

test('prepRangeWords: the quoted minutes to five more, never an en dash', () => {
  assert.equal(prepRangeWords(30), '30 to 35 min');
  assert.equal(prepRangeWords(25), '25 to 30 min');
  assert.equal(prepRangeWords(0), '0 to 5 min');
  assert.equal(prepRangeWords('x'), '0 to 5 min');
  assert.ok(!/[–—]/.test(prepRangeWords(30)));
});

test('pickupWord: Collection for a sterling venue, Pickup elsewhere', () => {
  assert.equal(pickupWord({ currency: 'GBP' }), 'Collection');
  assert.equal(pickupWord({}), 'Collection');
  assert.equal(pickupWord({ currency: 'USD' }), 'Pickup');
  assert.equal(pickupWord({ currency: 'eur' }), 'Pickup');
});

test('timingRowWords: ASAP with the range (busy marked), scheduled with the slot, closed order ahead', () => {
  assert.equal(timingRowWords({ mode: 'asap' }, { minutes: 30 }), 'ASAP, ready in 30 to 35 min');
  assert.equal(timingRowWords({ mode: 'asap' }, { minutes: 45, busy: true }), 'ASAP, ready in 45 to 50 min, busy');
  assert.equal(timingRowWords({ mode: 'asap' }, { minutes: 30, delivery: true }), 'ASAP, delivered in 30 to 35 min');
  assert.equal(timingRowWords({ mode: 'scheduled', slot: slots[1] }, {}), 'Scheduled, Today 18:15');
  assert.equal(timingRowWords({ mode: 'scheduled', slot: null }, {}), 'Schedule for later');
  assert.equal(timingRowWords({ mode: 'scheduled', slot: null }, { orderAheadOnly: true }), 'Order ahead, pick a time');
  assert.equal(timingRowWords(null, { minutes: 20 }), 'ASAP, ready in 20 to 25 min');
});

test('orderTypePillWords: "<word> only" with one type, the type with two, the counter keeps its name', () => {
  const one = [{ id: 'collection' }];
  const two = [{ id: 'collection' }, { id: 'delivery' }];
  assert.equal(orderTypePillWords('collection', { types: one, location: { currency: 'USD' } }), 'Pickup only');
  assert.equal(orderTypePillWords('collection', { types: one, location: { currency: 'GBP' } }), 'Collection only');
  assert.equal(orderTypePillWords('collection', { types: two, location: { currency: 'USD' } }), 'Pickup');
  assert.equal(orderTypePillWords('delivery', { types: two }), 'Delivery');
  assert.equal(orderTypePillWords('dine-in', { types: two, counterLabel: 'Collect at the bar' }), 'Collect at the bar');
});

test('orderTypeChoices: the venue words for the in place sheet', () => {
  const c = orderTypeChoices([{ id: 'collection' }, { id: 'delivery' }], { currency: 'USD' });
  assert.deepEqual(c.map((x) => x.label), ['Pickup', 'Delivery']);
  assert.deepEqual(orderTypeChoices(null, {}), []);
});

test('locationRowWords: from the address, to the delivery address once entered, never blank', () => {
  const loc = { currency: 'USD', name: 'Provo' };
  assert.equal(locationRowWords({ orderType: 'collection', address: '145 N University Ave', location: loc }), 'Pickup from 145 N University Ave');
  assert.equal(locationRowWords({ orderType: 'collection', address: '', location: loc }), 'Pickup from Provo');
  assert.equal(locationRowWords({ orderType: 'collection', address: '', location: null }), 'Collection from the venue');
  assert.equal(locationRowWords({ orderType: 'delivery', deliveryAddress: '12 High St, HD1 1AA' }), 'Delivery to 12 High St, HD1 1AA');
  assert.equal(locationRowWords({ orderType: 'delivery' }), 'Delivery to your address');
  assert.deepEqual(locationRowParts({ orderType: 'collection', address: '145 N University Ave', location: loc }), { lead: 'Pickup from ', bold: '145 N University Ave' });
  assert.deepEqual(locationRowParts({ orderType: 'delivery' }), { lead: 'Delivery to ', bold: 'your address' });
});
