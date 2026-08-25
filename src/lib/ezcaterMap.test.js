/**
 * ezcaterMap.test.js - the pure ezCater mapper.
 * Run: `npm test` (Node's built-in runner).
 *
 * The mapper is the piece that has to be right before a token exists, because
 * ezCater publishes no sandbox: there is no test environment to catch a bad
 * mapping, so these fixtures ARE the test environment.
 *
 * Fixtures are built from the field names in EZCATER_INTEGRATION_PLAN.md.
 * Where the plan names a field (uuid, event.orderType, catererCart.orderItems,
 * customizations, posItemId, specialInstructions, totals.salesTax,
 * totals.salesTaxRemittance, taxableAddress, catererTotalDue, subunits,
 * subunitsV2) the fixture uses it verbatim. Everything else is inferred and is
 * marked as such in _shared/ezcater.ts.
 *
 * What is pinned here:
 *   1. a DELIVERY order
 *   2. a TAKEOUT order
 *   3. customizations on a line
 *   4. TAX PASS THROUGH, the one that would cost the operator real money
 *   5. money parsed from subunitsV2, including past the int32 ceiling
 *   6. the THIRD_PARTY_DELIVERY tip and fee trap
 *   7. lifecycle to queue status, including the documented quirks
 *   8. a modification, which arrives as a SECOND accepted
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderToQueueRow, orderItemsToLines, ezStatusToQueueStatus, ezLifecycle,
  eventTimeParts, queuePayload, EZ_ORDER_TYPE_TO_QUEUE,
} from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  subunitsToNumber, moneyToAmount, dollarsToNumber, moneyCurrency,
  verifyEzcaterSignature, ORDER_QUERY, ACCEPT_ORDER_MUTATION, REJECT_ORDER_MUTATION,
  CATERERS_QUERY, CREATE_SUBSCRIBER_MUTATION, CREATE_SUBSCRIPTION_MUTATION,
  DELETE_SUBSCRIPTIONS_MUTATION, EZ_EVENTS,
} from '../../supabase/functions/_shared/ezcater.ts';

const LOC = 'loc-cabin-boston';

// ezCater money: the same figure twice, an int32 and a string.
const money = (subunits, currency = 'USD') => ({
  subunits: Number(subunits),
  subunitsV2: String(subunits),
  currency,
});

// ── fixtures ────────────────────────────────────────────────────────────────

// Massachusetts. ezCater remits NOTHING there, the operator remits all of it.
const DELIVERY_ORDER = {
  uuid: 'ord-1111',
  orderNumber: 'EZ-9001',
  orderSourceType: 'MARKETPLACE',
  lifecycle: { value: 'accepted' },
  createdAt: '2026-08-20T14:02:00Z',
  caterer: { uuid: 'cat-abc', name: 'The Cabin' },
  event: {
    orderType: 'DELIVERY',
    timestamp: '2026-09-04T11:30:00-04:00',
    timeZoneIdentifier: 'America/New_York',
    headcount: 25,
    address: {
      name: 'Acme HQ', street: '500 Boylston St', street2: 'Floor 4',
      city: 'Boston', state: 'MA', zip: '02116',
      latitude: 42.3499, longitude: -71.0786,
      deliveryInstructions: 'Loading dock at the rear, ask for Dana',
    },
    contact: { name: 'Dana Whitfield', phone: '6175550142', phoneExtension: '204' },
    orderNotes: 'Please label the vegetarian trays',
  },
  catererCart: {
    totals: {
      catererTotalDue: 412.75,             // a FLOAT IN DOLLARS, not subunits
      subtotal: money(38000),
      salesTax: money(2660),
      salesTaxRemittance: money(0),        // MA, ezCater remits nothing
      tip: money(3800),
      deliveryFee: money(2500),
      pointOfSaleIntegrationFee: money(500),
      taxableAddress: { street: '500 Boylston St', city: 'Boston', state: 'MA', zip: '02116' },
    },
    orderItems: [
      {
        uuid: 'oi-1',
        name: 'Roasted Vegetable Platter',
        quantity: 2,
        posItemId: 'm-veg-platter',
        specialInstructions: 'No peppers please',
        totalInSubunits: money(9000),
        customizations: [
          {
            uuid: 'c-1', name: 'Hummus', quantity: 2, posItemId: 'm-hummus',
            customizationTypeName: 'Dips', totalInSubunits: money(600),
          },
          {
            uuid: 'c-2', name: 'Extra pita', quantity: 1, posItemId: null,
            customizationTypeName: 'Sides', totalInSubunits: money(350),
          },
        ],
      },
      {
        uuid: 'oi-2',
        name: 'Chicken Caesar Boxed Lunch',
        quantity: 20,
        posItemId: null,                    // a Partner Portal menu has nothing to link to
        specialInstructions: '',
        totalInSubunits: money(29000),
        customizations: [],
      },
    ],
  },
};

// Illinois. A facilitator state, so ezCater remits the whole sales tax.
const TAKEOUT_ORDER = {
  uuid: 'ord-2222',
  orderNumber: 'EZ-9002',
  orderSourceType: 'EZORDERING',
  lifecycle: { value: 'submitted' },
  createdAt: '2026-08-21T09:15:00Z',
  caterer: { uuid: 'cat-abc', name: 'The Cabin' },
  event: {
    orderType: 'TAKEOUT',
    timestamp: '2026-08-28T12:00:00-05:00',
    timeZoneIdentifier: 'America/Chicago',
    headcount: 8,
    contact: { name: 'Marcus Reed', phone: '3125550188' },
    orderNotes: '',
  },
  catererCart: {
    totals: {
      catererTotalDue: 121.5,
      subtotal: money(11000),
      salesTax: money(1500),
      salesTaxRemittance: money(1500),     // IL, ezCater remits all of it
      tip: money(0),
      deliveryFee: money(0),
      pointOfSaleIntegrationFee: money(0),
      taxableAddress: { street: '12 Kitchen Way', city: 'Chicago', state: 'IL', zip: '60601' },
    },
    orderItems: [
      {
        uuid: 'oi-3', name: 'Sandwich Tray', quantity: 1, posItemId: 'm-sandwich-tray',
        specialInstructions: 'Cut in halves', totalInSubunits: money(11000), customizations: [],
      },
    ],
  },
};

// ezCater dispatches a third party courier. It pays the restaurant NEITHER the
// tip NOR the delivery fee, even though both are right there in the response.
const THIRD_PARTY_ORDER = {
  ...DELIVERY_ORDER,
  uuid: 'ord-3333',
  event: { ...DELIVERY_ORDER.event, orderType: 'THIRD_PARTY_DELIVERY', thirdPartyDeliveryPartner: 'Relay' },
};

// ── 1. delivery ─────────────────────────────────────────────────────────────

test('delivery order maps to an order_queue row', () => {
  const { row, link } = orderToQueueRow(DELIVERY_ORDER, LOC);

  assert.equal(row.ref, 'EZ-ord-1111');
  assert.equal(row.source, 'ezcater');
  assert.equal(row.location_id, LOC);
  assert.equal(row.type, 'delivery');
  assert.equal(row.status, 'prep');          // accepted
  assert.equal(row.paid, true);              // ezCater always takes the payment
  assert.equal(row.is_asap, false);          // a catering order is never ASAP
  assert.equal(row.total, 412.75);           // catererTotalDue, the number the venue banks

  // The timestamp carries its own offset, so the wall clock IS venue local.
  assert.equal(row.event_date, '2026-09-04');
  assert.equal(row.collection_time, '11:30');
  assert.equal(row.customer.eventTimeIsLocal, true);

  assert.equal(row.customer.name, 'Dana Whitfield');
  assert.equal(row.customer.phone, '6175550142');
  assert.equal(row.customer.phoneExtension, '204');
  assert.equal(row.customer.headcount, 25);
  assert.equal(row.customer.channel, 'ezCater');
  assert.equal(row.customer.source_label, 'MARKETPLACE');
  assert.equal(row.customer.ezcater_order_id, 'ord-1111');
  assert.equal(row.customer.ezcater_order_number, 'EZ-9001');
  assert.equal(row.customer.ezcater_caterer_id, 'cat-abc');
  assert.equal(row.customer.notes, 'Please label the vegetarian trays');

  assert.deepEqual(row.customer.address, {
    line1: '500 Boylston St',
    line2: 'Floor 4',
    city: 'Boston',
    state: 'MA',
    postcode: '02116',
    country: 'US',
    name: 'Acme HQ',
    instructions: 'Loading dock at the rear, ask for Dana',
    gps: { lat: 42.3499, lng: -71.0786 },
  });

  assert.equal(link.ez_order_id, 'ord-1111');
  assert.equal(link.location_id, LOC);
  assert.equal(link.order_type, 'DELIVERY');
  assert.equal(link.ez_lifecycle, 'accepted');
  assert.equal(link.accepted_count, 1);
  assert.equal(link.fire_at, '2026-09-04T11:30:00-04:00');
});

// ── 2. takeout ──────────────────────────────────────────────────────────────

test('takeout order maps to collection with no address', () => {
  const { row } = orderToQueueRow(TAKEOUT_ORDER, LOC);

  assert.equal(row.type, 'collection');
  assert.equal(row.status, 'received');      // submitted
  assert.equal(row.customer.address, null);  // a collection has nowhere to deliver to
  assert.equal(row.customer.serviceType, 'TAKEOUT');
  assert.equal(row.event_date, '2026-08-28');
  assert.equal(row.collection_time, '12:00');
  assert.equal(row.total, 121.5);
  assert.equal(row.items.length, 1);
  assert.equal(row.items[0].itemId, 'm-sandwich-tray');
});

test('order type mapping covers all three ezCater values', () => {
  assert.equal(EZ_ORDER_TYPE_TO_QUEUE.TAKEOUT, 'collection');
  assert.equal(EZ_ORDER_TYPE_TO_QUEUE.DELIVERY, 'delivery');
  assert.equal(EZ_ORDER_TYPE_TO_QUEUE.THIRD_PARTY_DELIVERY, 'delivery');
  // An unknown order type must not become a delivery nobody drives.
  const { row } = orderToQueueRow(
    { ...TAKEOUT_ORDER, event: { ...TAKEOUT_ORDER.event, orderType: 'SOMETHING_NEW' } }, LOC,
  );
  assert.equal(row.type, 'collection');
});

// ── 3. customizations ───────────────────────────────────────────────────────

test('line items carry customizations, posItemId, quantities and instructions', () => {
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  const [platter, lunch] = row.items;

  assert.equal(platter.name, 'Roasted Vegetable Platter');
  assert.equal(platter.qty, 2);
  assert.equal(platter.itemId, 'm-veg-platter');       // ezCater's posItemId is OUR menu item id
  assert.equal(platter.ezItemId, 'oi-1');
  assert.equal(platter.notes, 'No peppers please');
  // totalInSubunits is the LINE total, so the unit price is derived from it.
  assert.equal(platter.lineTotal, 90);
  assert.equal(platter.price, 45);

  assert.equal(platter.mods.length, 2);
  assert.deepEqual(platter.mods[0], {
    label: 'Hummus', groupLabel: 'Dips', itemId: 'm-hummus', ezItemId: 'c-1', qty: 2, price: 3,
  });
  assert.deepEqual(platter.mods[1], {
    label: 'Extra pita', groupLabel: 'Sides', itemId: null, ezItemId: 'c-2', qty: 1, price: 3.5,
  });

  // A hand built Partner Portal menu has no posItemId to give us. Nothing
  // downstream may assume one is present.
  assert.equal(lunch.itemId, null);
  assert.equal(lunch.qty, 20);
  assert.equal(lunch.price, 14.5);
  assert.deepEqual(lunch.mods, []);
});

test('orderItemsToLines survives a missing or empty cart', () => {
  assert.deepEqual(orderItemsToLines(undefined), []);
  assert.deepEqual(orderItemsToLines(null), []);
  assert.deepEqual(orderItemsToLines([]), []);
  // A quantity of 0 or nonsense must never divide by zero into Infinity.
  const [line] = orderItemsToLines([{ name: 'Odd', quantity: 0, totalInSubunits: money(500) }]);
  assert.equal(line.qty, 1);
  assert.equal(line.price, 5);
  assert.ok(Number.isFinite(line.price));
});

// ── 4. TAX PASS THROUGH ─────────────────────────────────────────────────────
// The whole point of the ezCater integration being different from HubRise.

test('TAX: ezCater figures pass through untouched, non facilitator state', () => {
  const { row, link } = orderToQueueRow(DELIVERY_ORDER, LOC);
  const tax = row.customer.tax;

  assert.equal(tax.engine, 'ezcater');            // NEVER our tax_profiles cascade
  assert.equal(tax.salesTax, 26.6);               // exactly what ezCater charged
  assert.equal(tax.salesTaxRemittance, 0);        // MA, ezCater remits nothing
  assert.equal(tax.operatorRemits, 26.6);         // so the operator owes all of it
  assert.equal(tax.taxableState, 'MA');
  assert.equal(tax.currency, 'USD');

  // Subunits kept alongside, so nothing is lost to rounding on the way to a filing.
  assert.equal(tax.salesTaxSubunits, 2660);
  assert.equal(tax.salesTaxRemittanceSubunits, 0);

  // taxableAddress is kept WHOLE. Destination sourcing means the address is the
  // evidence for the rate, not a decoration.
  assert.deepEqual(tax.taxableAddress, {
    street: '500 Boylston St', city: 'Boston', state: 'MA', zip: '02116',
  });

  // Written to the link row too, so reporting never has to reopen the jsonb.
  assert.equal(link.sales_tax, 26.6);
  assert.equal(link.sales_tax_remitted, 0);
  assert.equal(link.taxable_state, 'MA');
});

test('TAX: facilitator state, ezCater remits the whole amount', () => {
  const { row, link } = orderToQueueRow(TAKEOUT_ORDER, LOC);
  const tax = row.customer.tax;

  assert.equal(tax.salesTax, 15);
  assert.equal(tax.salesTaxRemittance, 15);
  assert.equal(tax.operatorRemits, 0);            // nothing left for the operator to remit
  assert.equal(tax.taxableState, 'IL');
  assert.equal(link.taxable_state, 'IL');
});

test('TAX: the mapper never derives a rate of its own', () => {
  // 2660 on 38000 is 7.0%. If anything in the mapper ever recomputed from a
  // ServOS tax profile it would land on a different figure, and the operator's
  // US filing would be wrong in one direction or the other. Pin the arithmetic
  // that must NOT happen: tax is read, never calculated from the subtotal.
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.equal(row.customer.totals.subtotal, 380);
  assert.equal(row.customer.tax.salesTax, 26.6);

  const odd = {
    ...DELIVERY_ORDER,
    catererCart: {
      ...DELIVERY_ORDER.catererCart,
      totals: {
        ...DELIVERY_ORDER.catererCart.totals,
        // A rate no ServOS profile could ever produce. It must survive verbatim.
        salesTax: money(1),
        salesTaxRemittance: money(1),
      },
    },
  };
  const mapped = orderToQueueRow(odd, LOC);
  assert.equal(mapped.row.customer.tax.salesTax, 0.01);
  assert.equal(mapped.row.customer.tax.operatorRemits, 0);
});

// ── 5. money ────────────────────────────────────────────────────────────────

test('MONEY: subunitsV2 is the field that is read, not subunits', () => {
  // The exact reason subunitsV2 exists. A large catering order overflows the
  // int32, and the wrapped negative is what a naive reader would bank.
  const overflowed = { subunits: -2147483648, subunitsV2: '2147483648', currency: 'USD' };
  assert.equal(subunitsToNumber(overflowed), 2147483648);
  assert.equal(moneyToAmount(overflowed), 21474836.48);

  assert.equal(subunitsToNumber(money(2660)), 2660);
  assert.equal(moneyToAmount(money(2660)), 26.6);
  assert.equal(moneyCurrency(money(2660)), 'USD');
});

test('MONEY: parsing is safe, never NaN', () => {
  assert.equal(subunitsToNumber(null), 0);
  assert.equal(subunitsToNumber(undefined), 0);
  assert.equal(subunitsToNumber({}), 0);
  // subunitsV2 unusable, fall back to the int32 rather than returning nothing.
  assert.equal(subunitsToNumber({ subunitsV2: 'not a number', subunits: 250 }), 250);
  assert.equal(subunitsToNumber({ subunitsV2: '', subunits: 250 }), 250);
  // Neither usable. A visible zero beats NaN propagating into an order total.
  assert.equal(subunitsToNumber({ subunitsV2: 'x', subunits: 'y' }), 0);
  assert.ok(!Number.isNaN(subunitsToNumber({ subunitsV2: 'x' })));
  assert.equal(subunitsToNumber('1234'), 1234);
  assert.equal(subunitsToNumber(-500), -500);
  assert.equal(moneyToAmount(null), 0);
});

test('MONEY: catererTotalDue is dollars, not subunits', () => {
  // Running catererTotalDue through subunitsToNumber would bill 100 times too
  // little. This is the guard for that.
  assert.equal(dollarsToNumber(412.75), 412.75);
  assert.equal(dollarsToNumber('412.75'), 412.75);
  assert.equal(dollarsToNumber('$1,204.50'), 1204.5);
  assert.equal(dollarsToNumber(null), 0);
  assert.equal(dollarsToNumber('nonsense'), 0);

  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.equal(row.customer.totals.catererTotalDue, 412.75);
  assert.notEqual(row.total, 4.13);
});

test('MONEY: every total component survives into the row', () => {
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.deepEqual(row.customer.totals, {
    subtotal: 380,
    salesTax: 26.6,
    salesTaxRemittance: 0,
    tip: 38,
    deliveryFee: 25,
    pointOfSaleIntegrationFee: 5,
    catererTotalDue: 412.75,
    currency: 'USD',
  });
});

test('MONEY: total falls back to subtotal plus tax when catererTotalDue is missing', () => {
  const noDue = {
    ...TAKEOUT_ORDER,
    catererCart: {
      ...TAKEOUT_ORDER.catererCart,
      totals: { ...TAKEOUT_ORDER.catererCart.totals, catererTotalDue: null },
    },
  };
  const { row } = orderToQueueRow(noDue, LOC);
  assert.equal(row.total, 125);   // a ticket must never show 0.00 for a real order
});

// ── 6. the third party delivery trap ────────────────────────────────────────

test('THIRD_PARTY_DELIVERY is flagged, and the tip and fee are kept but marked unpaid', () => {
  const { row } = orderToQueueRow(THIRD_PARTY_ORDER, LOC);
  assert.equal(row.type, 'delivery');
  assert.equal(row.customer.thirdPartyDelivery, true);
  assert.equal(row.customer.thirdPartyPartner, 'Relay');
  assert.equal(row.customer.catererReceivesTip, false);
  assert.equal(row.customer.catererReceivesDeliveryFee, false);
  // The figures stay verbatim. They are flagged, never zeroed, so reporting can
  // decide and nothing is quietly rewritten.
  assert.equal(row.customer.totals.tip, 38);
  assert.equal(row.customer.totals.deliveryFee, 25);

  const plain = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.equal(plain.row.customer.thirdPartyDelivery, false);
  assert.equal(plain.row.customer.catererReceivesTip, true);
  assert.equal(plain.row.customer.thirdPartyPartner, null);
});

// ── 7. lifecycle ────────────────────────────────────────────────────────────

test('lifecycle maps to queue status, quirks included', () => {
  assert.equal(ezStatusToQueueStatus('submitted'), 'received');
  assert.equal(ezStatusToQueueStatus('accepted'), 'prep');
  assert.equal(ezStatusToQueueStatus('completed'), 'collected');
  assert.equal(ezStatusToQueueStatus('rejected'), 'cancelled');
  assert.equal(ezStatusToQueueStatus('cancelled'), 'cancelled');
  assert.equal(ezStatusToQueueStatus('cancelled_for_replacement'), 'cancelled');

  // A Meal Program (Club Soda) order sends ONLY this, about 90 minutes before
  // the event. It has to land as a live actionable ticket, not as in progress.
  assert.equal(ezStatusToQueueStatus('relish_finalized'), 'received');

  // Subscribable but never actually fires. Mapped so that if ezCater ever turns
  // it on the order is not dropped.
  assert.equal(ezStatusToQueueStatus('uncancelled'), 'received');

  // Anything new from ezCater lands as a visible ticket rather than vanishing.
  assert.equal(ezStatusToQueueStatus('something_they_added_later'), 'received');
  assert.equal(ezStatusToQueueStatus(null), 'received');
  assert.equal(ezStatusToQueueStatus('ACCEPTED'), 'prep');
});

test('a cancelled order maps to a cancelled row whatever else it says', () => {
  const cancelled = { ...DELIVERY_ORDER, lifecycle: { value: 'cancelled' } };
  const { row, link } = orderToQueueRow(cancelled, LOC);
  assert.equal(row.status, 'cancelled');
  assert.equal(link.ez_lifecycle, 'cancelled');
});

test('lifecycle is read from any of the shapes it might arrive in', () => {
  assert.equal(ezLifecycle({ lifecycle: { value: 'Accepted' } }), 'accepted');
  assert.equal(ezLifecycle({ lifecycleValue: 'SUBMITTED' }), 'submitted');
  assert.equal(ezLifecycle({ lifecycle: 'cancelled' }), 'cancelled');
  assert.equal(ezLifecycle({}), '');
});

// ── 8. modification, the second accepted ────────────────────────────────────

test('a SECOND accepted is a modification, because ezCater has no modified event', () => {
  const firstTime = orderToQueueRow(DELIVERY_ORDER, LOC, { priorAcceptedCount: 0 });
  assert.equal(firstTime.link.accepted_count, 1);
  assert.equal(firstTime.row.customer.modified, undefined);

  const secondTime = orderToQueueRow(DELIVERY_ORDER, LOC, {
    priorAcceptedCount: 1, eventAt: '2026-08-22T10:00:00Z',
  });
  assert.equal(secondTime.link.accepted_count, 2);
  assert.equal(secondTime.row.customer.modified, true);
  assert.equal(secondTime.row.customer.modificationCount, 1);
  assert.equal(secondTime.link.modification_seen_at, '2026-08-22T10:00:00Z');

  // A non accepted event must not inflate the count.
  const cancelledAfter = orderToQueueRow(
    { ...DELIVERY_ORDER, lifecycle: { value: 'cancelled' } }, LOC, { priorAcceptedCount: 2 },
  );
  assert.equal(cancelledAfter.link.accepted_count, 2);
  assert.equal(cancelledAfter.row.customer.modified, undefined);
});

// ── time ────────────────────────────────────────────────────────────────────

test('event time is venue local, never a device clock read', () => {
  // An explicit offset means the wall clock in the string IS local.
  assert.deepEqual(
    eventTimeParts('2026-09-04T11:30:00-04:00', 'America/New_York'),
    { date: '2026-09-04', time: '11:30', local: true },
  );
  // No offset, but an IANA zone to convert into.
  assert.deepEqual(
    eventTimeParts('2026-09-04T15:30:00Z', 'America/New_York'),
    { date: '2026-09-04', time: '11:30', local: true },
  );
  // Neither. Read the literal wall clock and flag it as not proven local.
  assert.deepEqual(
    eventTimeParts('2026-09-04T15:30:00Z', null),
    { date: '2026-09-04', time: '15:30', local: false },
  );
  // A zone identifier that no runtime knows must not throw.
  assert.deepEqual(
    eventTimeParts('2026-09-04T15:30:00Z', 'Mars/Olympus_Mons'),
    { date: '2026-09-04', time: '15:30', local: false },
  );
  assert.equal(eventTimeParts(null), null);
  assert.equal(eventTimeParts(''), null);
  assert.equal(eventTimeParts('not a date'), null);
});

test('a midnight event does not render as hour 24', () => {
  const parts = eventTimeParts('2026-09-04T04:00:00Z', 'America/New_York');
  assert.equal(parts.time, '00:00');
  assert.equal(parts.date, '2026-09-04');
});

// ── the write payload ───────────────────────────────────────────────────────

test('queuePayload writes only baseline columns and stamps sent_at with the event time', () => {
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  const now = '2026-08-22T08:00:00.000Z';

  const fresh = queuePayload(row, true, now);
  assert.deepEqual(Object.keys(fresh).sort(), [
    'collection_time', 'created_at', 'customer', 'event_date', 'is_asap', 'items',
    'location_id', 'paid', 'ref', 'sent_at', 'source', 'status', 'total', 'type',
  ]);
  assert.equal(fresh.source, 'ezcater');
  assert.equal(fresh.paid, true);
  // An ezCater order sits for days. sent_at is the EVENT instant, not now.
  assert.equal(fresh.sent_at, '2026-09-04T11:30:00-04:00');
  assert.equal(fresh.created_at, '2026-08-20T14:02:00Z');

  // An update must not restamp created_at or sent_at.
  const update = queuePayload(row, false, now);
  assert.equal('created_at' in update, false);
  assert.equal('sent_at' in update, false);
});

// ── webhook signature ───────────────────────────────────────────────────────
// Not the mapper, but it is the gate in front of it, and it is the one thing
// that has to be right on the very first live notification.

const hmacHex = async (secret, payload) => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

test('SIGNATURE: the signed payload is `timestamp.rawBody`, not the body alone', async () => {
  const secret = 'whsec-ezcater-test';
  const rawBody = '{"id":"ntf-1","entity_id":"ord-1111","parent_id":"cat-abc","payload":null}';
  const ts = String(Math.floor(Date.now() / 1000));

  const good = `${ts}.${await hmacHex(secret, `${ts}.${rawBody}`)}`;
  assert.equal(await verifyEzcaterSignature(rawBody, good, secret), true);

  // Signing the body WITHOUT the timestamp prefix is the obvious mistake to
  // make, having ported this from HubRise's verifyHmac. It must fail.
  const bodyOnly = `${ts}.${await hmacHex(secret, rawBody)}`;
  assert.equal(await verifyEzcaterSignature(rawBody, bodyOnly, secret), false);
});

test('SIGNATURE: rejects a wrong secret, a tampered body, junk and a stale timestamp', async () => {
  const secret = 'whsec-ezcater-test';
  const rawBody = '{"id":"ntf-1"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = await hmacHex(secret, `${ts}.${rawBody}`);

  assert.equal(await verifyEzcaterSignature(rawBody, `${ts}.${digest}`, 'wrong-secret'), false);
  assert.equal(await verifyEzcaterSignature('{"id":"ntf-2"}', `${ts}.${digest}`, secret), false);
  assert.equal(await verifyEzcaterSignature(rawBody, null, secret), false);
  assert.equal(await verifyEzcaterSignature(rawBody, `${ts}.${digest}`, ''), false);
  assert.equal(await verifyEzcaterSignature(rawBody, digest, secret), false);          // no timestamp part
  assert.equal(await verifyEzcaterSignature(rawBody, `.${digest}`, secret), false);
  assert.equal(await verifyEzcaterSignature(rawBody, `notanumber.${digest}`, secret), false);

  // Replay guard. An old timestamp fails even with a valid digest for it.
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = `${oldTs}.${await hmacHex(secret, `${oldTs}.${rawBody}`)}`;
  assert.equal(await verifyEzcaterSignature(rawBody, oldSig, secret), false);
  // Unless the caller is deliberately replaying a stored notification.
  assert.equal(await verifyEzcaterSignature(rawBody, oldSig, secret, 0), true);
});

test('SIGNATURE: the digest is compared case insensitively but exactly', async () => {
  const secret = 's';
  const rawBody = 'x';
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = await hmacHex(secret, `${ts}.${rawBody}`);
  assert.equal(await verifyEzcaterSignature(rawBody, `${ts}.${digest.toUpperCase()}`, secret), true);
  assert.equal(await verifyEzcaterSignature(rawBody, `${ts}.${digest.slice(0, -1)}0`, secret), false);
});

// ── GraphQL operation shapes ────────────────────────────────────────────────

test('every ezCater operation is NAMED and balanced', () => {
  const ops = {
    ORDER_QUERY, ACCEPT_ORDER_MUTATION, REJECT_ORDER_MUTATION, CATERERS_QUERY,
    CREATE_SUBSCRIBER_MUTATION, CREATE_SUBSCRIPTION_MUTATION, DELETE_SUBSCRIPTIONS_MUTATION,
  };
  for (const [label, doc] of Object.entries(ops)) {
    // ezCater rejects anonymous operations outright.
    assert.match(doc.trim(), /^(query|mutation)\s+ServOsEz\w+/, `${label} must be a named operation`);
    // A truncated selection set is a 400 at ezCater and a silent nothing here.
    const opens = (doc.match(/\{/g) || []).length;
    const closes = (doc.match(/\}/g) || []).length;
    assert.equal(opens, closes, `${label} braces unbalanced`);
    assert.equal((doc.match(/\(/g) || []).length, (doc.match(/\)/g) || []).length, `${label} parens unbalanced`);
  }
});

test('uncancelled is not subscribed, because it never fires', () => {
  assert.ok(EZ_EVENTS.includes('accepted'));
  assert.ok(EZ_EVENTS.includes('cancelled'));
  // The ONLY event a Meal Program (Club Soda) order ever sends. Dropping it
  // silently loses every Meal Program order.
  assert.ok(EZ_EVENTS.includes('relish_finalized'));
  assert.equal(EZ_EVENTS.includes('uncancelled'), false);
});

test('an order with nothing on it still produces a writable row', () => {
  // Defence for the day ezCater prunes a field from the response. A partial
  // order must degrade, never throw, because the notification is a pointer and
  // we may not get to fetch it again.
  const { row, link } = orderToQueueRow({ uuid: 'ord-bare' }, LOC);
  assert.equal(row.ref, 'EZ-ord-bare');
  assert.equal(row.type, 'collection');
  assert.equal(row.source, 'ezcater');
  assert.equal(row.total, 0);
  assert.deepEqual(row.items, []);
  assert.equal(row.status, 'received');
  assert.equal(row.customer.name, 'ezCater customer');
  assert.equal(row.customer.tax.engine, 'ezcater');
  assert.equal(row.customer.tax.operatorRemits, 0);
  assert.equal(link.ez_order_id, 'ord-bare');
});
