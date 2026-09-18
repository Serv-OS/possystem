/**
 * ezcaterMap.test.js - the pure ezCater mapper.
 * Run: `npm test` (Node's built-in runner).
 *
 * The mapper is the piece that has to be right before a token exists, because
 * ezCater publishes no sandbox: there is no test environment to catch a bad
 * mapping, so these fixtures ARE the test environment.
 *
 * FIXTURES ARE THE DOCUMENTED PAYLOADS, NOT OUR GUESSES.
 * The shapes below are copied from ezCater's own published samples:
 *   "Viewing Order Details"  https://api.ezcater.io/order-details
 *   "Order Schema Reference" https://api.ezcater.io/order-schema-reference
 * An earlier version of this file invented field names (lifecycle.value,
 * totals.subtotal, totals.deliveryFee, customization.totalInSubunits,
 * address.latitude), the tests passed against the invention, and the live query
 * would have returned NOTHING because GraphQL fails the whole document on one
 * unknown field. A fixture that is not quoted from a doc page proves nothing.
 *
 * What is pinned here:
 *   1. a DELIVERY order
 *   2. a TAKEOUT order
 *   3. customizations on a line, which carry NO money of their own
 *   4. TAX PASS THROUGH, the one that would cost the operator real money
 *   5. money parsed from subunitsV2, including past the int32 ceiling
 *   6. the THIRD_PARTY_DELIVERY tip and fee trap
 *   7. lifecycle to queue status, including the documented quirks
 *   8. a modification, which arrives as a SECOND accepted
 *   9. the exact ezCater sample order, field for field
 *  10. no operation asks for a field that is not in the schema reference
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  orderToQueueRow, orderItemsToLines, ezStatusToQueueStatus, ezLifecycle,
  eventTimeParts, queuePayload, feeRows, feeTotal, EZ_ORDER_TYPE_TO_QUEUE,
  lineSubunitsOf, ticketSubunits, ticketTotal,
} from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  subunitsToNumber, moneyToAmount, dollarsToNumber, moneyCurrency,
  verifyEzcaterSignature, ORDER_QUERY, ACCEPT_ORDER_MUTATION, REJECT_ORDER_MUTATION,
  CATERERS_QUERY, CREATE_SUBSCRIBER_MUTATION, CREATE_SUBSCRIPTION_MUTATION,
  UPDATE_SUBSCRIBER_MUTATION, deleteSubscriptionsMutation, SUBSCRIBERS_QUERY,
  EZ_EVENTS, EZ_FEE_TYPES, EZ_PERMANENT_STATUSES, firstStatusCode,
  EzcaterError, isSchemaError, isPermanent, allMessages,
} from '../../supabase/functions/_shared/ezcater.ts';

// A caterer id is an RFC 4122 UUID, which is what deleteSubscriptions inlines.
const CATERER_UUID = '3593ce70-7227-4fd4-8a78-9591083d0674';

const LOC = 'loc-cabin-boston';

// ezCater money: the same figure twice, an int32 and a string.
const money = (subunits, currency = 'USD') => ({
  subunits: Number(subunits),
  subunitsV2: String(subunits),
  currency,
});

// ── fixtures ────────────────────────────────────────────────────────────────

// Massachusetts. ezCater remits NOTHING there, the operator remits all of it.
//
// Shape quoted from "Viewing Order Details". Note where the money lives:
// Order.totals holds subTotal / salesTax / salesTaxRemittance / tip /
// pointOfSaleIntegrationFee, catererCart.totals holds catererTotalDue ALONE,
// the delivery fee is a feesAndDiscounts line, and taxableAddress is on Order.
const DELIVERY_ORDER = {
  uuid: 'ord-1111',
  orderNumber: 'EZ-9001',
  orderSourceType: 'MARKETPLACE',
  deliveryId: '3593ce70-7227-4fd4-8a78-9591083d0674',
  isTaxExempt: false,
  lifecycle: { orderIsCurrently: 'accepted' },
  caterer: { uuid: 'cat-abc', name: 'The Cabin', storeNumber: '00001', live: true },
  event: {
    orderType: 'DELIVERY',
    timestamp: '2026-09-04T11:30:00-04:00',
    catererHandoffFoodTime: '2026-09-04T11:15:00-04:00',
    timeZoneIdentifier: 'America/New_York',
    timeZoneOffset: '-04:00',
    headcount: 25,
    customerProvidedName: 'Team building event',
    address: {
      name: 'Acme HQ', street: '500 Boylston St', street2: 'Floor 4', street3: null,
      city: 'Boston', state: 'MA', stateName: 'Massachusetts', zip: '02116',
      deliveryInstructions: 'Loading dock at the rear, ask for Dana',
    },
    // EventContact is name and phone ONLY.
    contact: { name: 'Dana Whitfield', phone: '6175550142' },
  },
  // OrderCustomer is firstName, lastName, fullName ONLY.
  orderCustomer: { firstName: 'Priya', lastName: 'Raman', fullName: 'Priya Raman' },
  taxableAddress: {
    street: '500 Boylston St', street2: null, street3: null,
    city: 'Boston', state: 'MA', stateName: 'Massachusetts', zip: '02116',
  },
  totals: {
    customerTotalDue: money(45000),
    subTotal: money(38000),                // capital T
    salesTax: money(2660),
    salesTaxRemittance: money(0),          // MA, ezCater remits nothing
    tip: money(3800),
    pointOfSaleIntegrationFee: money(500),
  },
  catererCart: {
    totals: { catererTotalDue: 412.75 },   // a FLOAT IN DOLLARS, not subunits
    deliveryFees: [{ name: 'Delivery Fee', cost: money(2500) }],
    feesAndDiscounts: [
      { name: 'Delivery Fee', cost: money(2500) },
      { name: 'Preferred Caterer Program', cost: money(-1199) },
    ],
    tableware: {
      specialInstructions: 'Please label the vegetarian trays',
      tablewareChoices: [
        { choiceUuid: 'tw-1', isIncluded: true, itemCount: 25, name: 'Napkins' },
        { choiceUuid: 'tw-2', isIncluded: false, itemCount: 0, name: 'Cups' },
      ],
    },
    orderItems: [
      {
        uuid: 'oi-1',
        name: 'Roasted Vegetable Platter',
        quantity: 2,
        menuItemSizeId: 'ez-size-veg-platter',
        menuItemSizeName: 'Large platter',
        posItemId: 'm-veg-platter',
        labelFor: null,
        noteToCaterer: 'Serves 12 to 15',
        specialInstructions: 'No peppers please',
        // INCLUDES the two customizations below. They have no money of their own.
        totalInSubunits: money(9000),
        customizations: [
          {
            customizationId: 'ez-choice-hummus', customizationTypeId: 'ez-type-dips',
            customizationTypeName: 'Dips', name: 'Hummus',
            posCustomizationId: 'm-hummus', quantity: 2,
          },
          {
            customizationId: 'ez-choice-pita', customizationTypeId: 'ez-type-sides',
            customizationTypeName: 'Sides', name: 'Extra pita',
            posCustomizationId: null, quantity: 1,
          },
        ],
      },
      {
        uuid: 'oi-2',
        name: 'Chicken Caesar Boxed Lunch',
        quantity: 20,
        menuItemSizeId: 'ez-size-boxed-lunch',
        menuItemSizeName: 'Boxed lunch',
        posItemId: null,                    // a Partner Portal menu has nothing to link to
        labelFor: null,
        noteToCaterer: null,
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
  orderSourceType: 'EZ_ORDERING',
  isTaxExempt: false,
  lifecycle: { orderIsCurrently: 'submitted' },
  caterer: { uuid: 'cat-abc', name: 'The Cabin', storeNumber: '00001', live: true },
  event: {
    orderType: 'TAKEOUT',
    timestamp: '2026-08-28T12:00:00-05:00',
    catererHandoffFoodTime: '2026-08-28T12:00:00-05:00',
    timeZoneIdentifier: 'America/Chicago',
    timeZoneOffset: '-05:00',
    headcount: 8,
    customerProvidedName: null,
    contact: { name: 'Marcus Reed', phone: '3125550188' },
  },
  orderCustomer: { firstName: 'Marcus', lastName: 'Reed', fullName: 'Marcus Reed' },
  taxableAddress: {
    street: '12 Kitchen Way', street2: null, street3: null,
    city: 'Chicago', state: 'IL', stateName: 'Illinois', zip: '60601',
  },
  totals: {
    customerTotalDue: money(12500),
    subTotal: money(11000),
    salesTax: money(1500),
    salesTaxRemittance: money(1500),       // IL, ezCater remits all of it
    tip: money(0),
    pointOfSaleIntegrationFee: money(0),
  },
  catererCart: {
    totals: { catererTotalDue: 121.5 },
    deliveryFees: [],
    feesAndDiscounts: [],
    tableware: { specialInstructions: null, tablewareChoices: [] },
    orderItems: [
      {
        uuid: 'oi-3', name: 'Sandwich Tray', quantity: 1,
        menuItemSizeId: 'ez-size-sandwich-tray', menuItemSizeName: 'Tray of 12',
        posItemId: 'm-sandwich-tray', labelFor: null, noteToCaterer: null,
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
  // accepted lands HELD, exactly as a ServOS catering order does (CateringCheckout writes
  // 'received'); the catering release moves it on at its kitchen fire time.
  assert.equal(row.status, 'received');
  assert.equal(row.paid, true);              // ezCater always takes the payment
  assert.equal(row.is_asap, false);          // a catering order is never ASAP
  assert.equal(row.total, 412.75);           // catererTotalDue, the number the venue banks

  // The timestamp carries its own offset, so the wall clock IS venue local.
  assert.equal(row.event_date, '2026-09-04');
  assert.equal(row.collection_time, '11:30');
  assert.equal(row.customer.eventTimeIsLocal, true);

  // The on-site contact is who the driver meets, so that name leads. The buyer
  // is a different person and is kept alongside, never merged.
  assert.equal(row.customer.name, 'Dana Whitfield');
  assert.equal(row.customer.phone, '6175550142');
  assert.equal(row.customer.buyerName, 'Priya Raman');
  assert.equal(row.customer.eventName, 'Team building event');
  assert.equal(row.customer.headcount, 25);
  assert.equal(row.customer.channel, 'ezCater');
  assert.equal(row.customer.source_label, 'MARKETPLACE');
  assert.equal(row.customer.ezcater_order_id, 'ord-1111');
  assert.equal(row.customer.ezcater_order_number, 'EZ-9001');
  assert.equal(row.customer.ezcater_caterer_id, 'cat-abc');
  assert.equal(row.customer.ezcater_store_number, '00001');
  assert.equal(row.customer.ezcater_delivery_id, '3593ce70-7227-4fd4-8a78-9591083d0674');

  // An ezCater order has NO order level note field. The nearest real customer
  // instruction is the tableware one, and it is labelled rather than dropped.
  assert.equal(row.customer.notes, 'Tableware: Please label the vegetarian trays');
  // Only what ezCater actually promised the customer. isIncluded false is out.
  assert.deepEqual(row.customer.tableware, [{ name: 'Napkins', count: 25 }]);

  // The kitchen's real deadline on a delivery is the handoff, not the event.
  assert.equal(row.customer.handoff_time, '11:15');
  assert.equal(row.customer.handoffAt, '2026-09-04T11:15:00-04:00');

  // Address has street3 and stateName. It has NO latitude and NO longitude.
  assert.deepEqual(row.customer.address, {
    line1: '500 Boylston St',
    line2: 'Floor 4',
    line3: '',
    city: 'Boston',
    state: 'MA',
    stateName: 'Massachusetts',
    postcode: '02116',
    country: 'US',
    name: 'Acme HQ',
    instructions: 'Loading dock at the rear, ask for Dana',
  });
  assert.equal('gps' in row.customer.address, false);

  assert.equal(link.ez_order_id, 'ord-1111');
  assert.equal(link.location_id, LOC);
  assert.equal(link.order_type, 'DELIVERY');
  assert.equal(link.ez_lifecycle, 'accepted');
  assert.equal(link.accepted_count, 1);
  // fire_at is the KITCHEN fire instant: the handoff (food must be ready) minus the venue's
  // catering prep time, which is 0 when no venue settings are given.
  assert.equal(link.fire_at, '2026-09-04T15:15:00.000Z');
  assert.equal(row.fire_at, '2026-09-04T15:15:00.000Z');
  assert.equal(row.customer.readySource, 'catererHandoffFoodTime');
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
  assert.equal(platter.ezSizeId, 'ez-size-veg-platter');
  assert.equal(platter.sizeName, 'Large platter');
  assert.equal(platter.notes, 'No peppers please');
  assert.equal(platter.kitchenNote, 'Serves 12 to 15');
  // totalInSubunits is the LINE total and it ALREADY includes the options, so
  // the unit price is the line divided by the quantity and nothing is added on top.
  assert.equal(platter.lineTotal, 90);
  assert.equal(platter.lineSubunits, 9000);
  assert.equal(platter.price, 45);
  assert.equal(platter.priceIncludesOptions, true);

  assert.equal(platter.mods.length, 2);
  // A customization has NO money field at all. Its price is null, meaning not
  // priced separately. A 0 would read as free, and a derived figure would be
  // the option counted twice: once in the line total and once here.
  assert.deepEqual(platter.mods[0], {
    label: 'Hummus', groupLabel: 'Dips', itemId: 'm-hummus',
    ezItemId: 'ez-choice-hummus', ezGroupId: 'ez-type-dips', qty: 2, price: null,
  });
  assert.deepEqual(platter.mods[1], {
    label: 'Extra pita', groupLabel: 'Sides', itemId: null,
    ezItemId: 'ez-choice-pita', ezGroupId: 'ez-type-sides', qty: 1, price: null,
  });

  // What OrdersHub actually prints: base price plus mod prices, times quantity.
  // It must come to the line total exactly, not to the total plus the options.
  const shown = ((platter.price || 0) + platter.mods.reduce((m, x) => m + (Number(x.price) || 0), 0)) * platter.qty;
  assert.equal(+shown.toFixed(2), 90);

  // A hand built Partner Portal menu has no posItemId to give us. Nothing
  // downstream may assume one is present.
  assert.equal(lunch.itemId, null);
  assert.equal(lunch.qty, 20);
  assert.equal(lunch.price, 14.5);
  assert.deepEqual(lunch.mods, []);
});

test('a customization id is posCustomizationId, and posItemId is still read', () => {
  // OrderItemCustomization has exactly six fields and posItemId is NOT one of
  // them: the id on a customization is posCustomizationId, "POS ID
  // corresponding with a specific customization in the caterer's menu". Both
  // spellings are read, so the code rule works whichever one a query brings
  // back, and neither means null, exactly as before.
  const [line] = orderItemsToLines([{
    uuid: 'oi-9', name: 'Pizza', quantity: 1, totalInSubunits: money(1000),
    customizations: [
      { customizationId: 'ez-c-1', name: 'Parmigiano', customizationTypeName: 'Cheese', quantity: 1, posCustomizationId: 'CHEESE1' },
      { customizationId: 'ez-c-2', name: 'Old Shape', customizationTypeName: 'Cheese', quantity: 1, posItemId: 'OLD1' },
      { customizationId: 'ez-c-3', name: 'Nothing', customizationTypeName: 'Cheese', quantity: 1 },
    ],
  }]);
  assert.equal(line.mods[0].itemId, 'CHEESE1');
  assert.equal(line.mods[1].itemId, 'OLD1');
  assert.equal(line.mods[2].itemId, null, 'no id is the ordinary case and must stay null');
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

  // taxableAddress is kept WHOLE, and it is read from the ORDER, not from
  // totals. Destination sourcing means the address is the evidence for the
  // rate, not a decoration.
  assert.deepEqual(tax.taxableAddress, {
    street: '500 Boylston St', street2: null, street3: null,
    city: 'Boston', state: 'MA', stateName: 'Massachusetts', zip: '02116',
  });
  assert.equal(tax.taxExempt, false);

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
    totals: {
      ...DELIVERY_ORDER.totals,
      // A rate no ServOS profile could ever produce. It must survive verbatim.
      salesTax: money(1),
      salesTaxRemittance: money(1),
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
    customerTotalDue: 450,
    catererTotalDue: 412.75,
    currency: 'USD',
    // The sum of the LINE TOTALS, exact. Recorded so nothing downstream ever
    // reaches for price * qty, which loses a cent on an uneven quantity.
    itemsTotal: 380,
    itemsSubunits: 38000,
    feesAndDiscounts: [
      { name: 'Delivery Fee', amount: 25, subunits: 2500 },
      { name: 'Preferred Caterer Program', amount: -11.99, subunits: -1199 },
    ],
  });
});

test('MONEY: the delivery fee is a fee LINE, not a field', () => {
  // There is no totals.deliveryFee. Reading one gave every ezCater order a
  // 0.00 delivery fee, and asking for it killed the whole query.
  // Sample from "Viewing Order Details": feesAndDiscounts is
  //   [{cost:{subunits:2999},name:"Delivery Fee"},
  //    {cost:{subunits:-1199},name:"Preferred Caterer Program"},
  //    {cost:{subunits:-1199},name:"Rewards Promo"}]
  const docSample = [
    { name: 'Delivery Fee', cost: money(2999) },
    { name: 'Preferred Caterer Program', cost: money(-1199) },
    { name: 'Rewards Promo', cost: money(-1199) },
  ];
  assert.deepEqual(feeRows(docSample), [
    { name: 'Delivery Fee', amount: 29.99, subunits: 2999 },
    { name: 'Preferred Caterer Program', amount: -11.99, subunits: -1199 },
    { name: 'Rewards Promo', amount: -11.99, subunits: -1199 },
  ]);
  // Discounts are negative and stay negative. Nothing is flipped or dropped.
  assert.equal(feeTotal(docSample), 6.01);
  assert.deepEqual(feeRows(null), []);
  assert.equal(feeTotal(undefined), 0);

  // The query asks for DELIVERY_FEE under its own alias, because the response
  // carries only a name and a cost, never the type it was filtered by.
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.equal(row.customer.totals.deliveryFee, 25);
});

test('MONEY: total falls back to subtotal plus tax when catererTotalDue is missing', () => {
  const noDue = {
    ...TAKEOUT_ORDER,
    catererCart: { ...TAKEOUT_ORDER.catererCart, totals: { catererTotalDue: null } },
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
  // A rejected is NOT a cancel (review round 3): held until ezCater's own cancelled arrives.
  assert.equal(ezStatusToQueueStatus('rejected'), 'received');
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
  const cancelled = { ...DELIVERY_ORDER, lifecycle: { orderIsCurrently: 'cancelled' } };
  const { row, link } = orderToQueueRow(cancelled, LOC);
  assert.equal(row.status, 'cancelled');
  assert.equal(link.ez_lifecycle, 'cancelled');
});

test('lifecycle is read from orderIsCurrently, the field that actually exists', () => {
  // OrderLifecycle has exactly one field, orderIsCurrently. Sample from
  // "Order Schema Reference": { "orderIsCurrently": "accepted" }
  assert.equal(ezLifecycle({ lifecycle: { orderIsCurrently: 'accepted' } }), 'accepted');
  assert.equal(ezLifecycle({ lifecycle: { orderIsCurrently: 'Cancelled' } }), 'cancelled');
  // Reading lifecycle.value gave '' for every order, so every order looked
  // 'received' and a cancelled one would have gone to the kitchen.
  const { row } = orderToQueueRow({ ...DELIVERY_ORDER, lifecycle: { orderIsCurrently: 'accepted' } }, LOC);
  assert.equal(row.status, 'received');   // accepted, held like any catering order
  assert.equal(row.customer.ezcater_lifecycle, 'accepted');
  // The older shapes remain as a net, never as the reason a bad name looks fine.
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
    { ...DELIVERY_ORDER, lifecycle: { orderIsCurrently: 'cancelled' } }, LOC, { priorAcceptedCount: 2 },
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

test('queuePayload writes only baseline columns and stamps sent_at with the KITCHEN FIRE time', () => {
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  const now = '2026-08-22T08:00:00.000Z';

  const fresh = queuePayload(row, true, now);
  assert.deepEqual(Object.keys(fresh).sort(), [
    'collection_time', 'created_at', 'customer', 'event_date', 'is_asap', 'items',
    'location_id', 'paid', 'ref', 'sent_at', 'source', 'status', 'total', 'type',
  ]);
  assert.equal(fresh.source, 'ezcater');
  assert.equal(fresh.paid, true);
  // An ezCater order sits for days. sent_at is the kitchen fire instant (handoff minus prep),
  // the same meaning as on a ServOS catering order, never now and never the delivery time.
  assert.equal(fresh.sent_at, '2026-09-04T15:15:00.000Z');
  // An ezCater Order has NO createdAt, so the row's own arrival time is the
  // only honest answer. Inventing one made every ticket claim a false age.
  assert.equal(fresh.created_at, now);

  // An update must not restamp created_at or sent_at, nor move the date and time the kitchen
  // was given, unless the webhook asks it to reschedule an order that has not fired yet.
  const update = queuePayload(row, false, now);
  assert.equal('created_at' in update, false);
  assert.equal('sent_at' in update, false);
  assert.equal('event_date' in update, false);
  assert.equal('collection_time' in update, false);
  const moved = queuePayload(row, false, now, { reschedule: true });
  assert.equal(moved.sent_at, '2026-09-04T15:15:00.000Z');
  assert.equal(moved.event_date, row.event_date);
  assert.equal(moved.collection_time, row.collection_time);
  assert.equal('created_at' in moved, false);
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
  // A tamper byte that cannot equal the original: one digest in sixteen
  // already ends in '0', which made this pass one time in sixteen.
  assert.equal(await verifyEzcaterSignature(rawBody, `${ts}.${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`, secret), false);
});

// ── GraphQL operation shapes ────────────────────────────────────────────────

test('every ezCater operation is NAMED and balanced', () => {
  const ops = {
    ORDER_QUERY, ACCEPT_ORDER_MUTATION, REJECT_ORDER_MUTATION, CATERERS_QUERY,
    CREATE_SUBSCRIBER_MUTATION, CREATE_SUBSCRIPTION_MUTATION, UPDATE_SUBSCRIBER_MUTATION,
    DELETE_SUBSCRIPTIONS_MUTATION: deleteSubscriptionsMutation(CATERER_UUID),
    SUBSCRIBERS_QUERY,
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

// ── 9. THE FIELDS THE QUERY ASKS FOR ────────────────────────────────────────
// GraphQL fails the WHOLE document on one unknown field, so every one of these
// is the difference between an order reaching the till and nothing at all.

test('the order query asks for NO field outside the Order Schema Reference', () => {
  // Each of these was in the query and is NOT in ezCater's schema. Every one of
  // them on its own would have returned zero orders on the first live call.
  const invented = [
    'isModified',            // not on Order
    'createdAt',             // not on Order
    'orderNotes',            // not on Event
    'latitude', 'longitude', // not on Address
    'phoneExtension',        // EventContact is name and phone only
    'brandName',             // not on Caterer
    'deliveryFee',           // a feesAndDiscounts LINE, not a field
    'catererDeliveryFee',
    'signingSecret',         // it is webhookSecret
    'deletedCount',
  ];
  for (const bad of invented) {
    assert.equal(new RegExp(`\\b${bad}\\b`).test(ORDER_QUERY), false, `ORDER_QUERY still asks for ${bad}`);
  }
  // lifecycle { value } does not exist. The field is orderIsCurrently.
  assert.match(ORDER_QUERY, /lifecycle \{ orderIsCurrently \}/);
  assert.equal(/lifecycle \{ value \}/.test(ORDER_QUERY), false);

  // subTotal has a capital T, and it hangs off Order.totals, not the caterer cart.
  assert.match(ORDER_QUERY, /subTotal/);
  assert.equal(/\bsubtotal\b/.test(ORDER_QUERY), false);

  // Every field the mapper reads has to be asked for, or it is silently null.
  for (const wanted of [
    'orderNumber', 'orderSourceType', 'deliveryId', 'isTaxExempt', 'taxableAddress',
    'catererHandoffFoodTime', 'timeZoneIdentifier', 'timeZoneOffset', 'customerProvidedName',
    'headcount', 'thirdPartyDeliveryPartner', 'storeNumber', 'stateName', 'street3',
    'salesTaxRemittance', 'pointOfSaleIntegrationFee', 'customerTotalDue', 'catererTotalDue',
    'feesAndDiscounts', 'tableware', 'menuItemSizeId', 'menuItemSizeName', 'noteToCaterer',
    'labelFor', 'posCustomizationId', 'customizationTypeId', 'customizationId', 'fullName',
  ]) {
    assert.match(ORDER_QUERY, new RegExp(`\\b${wanted}\\b`), `ORDER_QUERY must ask for ${wanted}`);
  }

  // The delivery fee is read from its own filtered alias, never by display name.
  assert.match(ORDER_QUERY, /deliveryFees: feesAndDiscounts\(types: \[DELIVERY_FEE\]\)/);
  assert.deepEqual(EZ_FEE_TYPES, ['ADJUSTMENT', 'DELIVERY_FEE', 'DISCOUNT', 'MISC_FEE']);
});

test('the mutations match their documented argument shapes', () => {
  // AcceptOrderPayload and RejectOrderPayload each have ONE field, order. An
  // errors field was invented, and inventing it fails the whole mutation.
  assert.equal(/errors \{ message \}/.test(ACCEPT_ORDER_MUTATION), false);
  assert.equal(/errors \{ message \}/.test(REJECT_ORDER_MUTATION), false);
  assert.match(ACCEPT_ORDER_MUTATION, /acceptOrder\(orderId: \$orderId, acceptModification: \$acceptModification\)/);

  // rejectOrder takes ONE input object, not two loose arguments.
  assert.match(REJECT_ORDER_MUTATION, /\$rejectOrderInput: RejectOrderInput!/);
  assert.match(REJECT_ORDER_MUTATION, /rejectOrder\(orderId: \$orderId, rejectOrderInput: \$rejectOrderInput\)/);

  // Subscriber and subscription mutations both take a single Fields input.
  assert.match(CREATE_SUBSCRIBER_MUTATION, /\$subscriberParams: CreateSubscriberFields!/);
  assert.match(CREATE_SUBSCRIBER_MUTATION, /webhookSecret/);
  assert.match(CREATE_SUBSCRIPTION_MUTATION, /\$subscriptionParams: CreateSubscriptionFields!/);

  // updateSubscriber takes the id and a separate Fields input, and its payload
  // is a Subscriber, which has NO webhookSecret. See the dedicated test below.
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /\$subscriberId: ID!/);
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /\$subscriberParams: UpdateSubscriberFields!/);
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /updateSubscriber\(subscriberId: \$subscriberId, subscriberParams: \$subscriberParams\)/);

  // Deletion is scoped to the CATERER, and returns success. The id is INLINE
  // because ezCater never publishes the type of subscriptionsParams. See below.
  const del = deleteSubscriptionsMutation(CATERER_UUID);
  assert.match(del, /parentEntity: Caterer, parentId: "3593ce70-7227-4fd4-8a78-9591083d0674"/);
  assert.match(del, /success/);

  // Caterer has no brandName.
  assert.equal(/brandName/.test(CATERERS_QUERY), false);
  assert.match(CATERERS_QUERY, /storeNumber/);
});

// ── 10. the unknown field alarm ─────────────────────────────────────────────

test('a GraphQL errors answer is named as a schema mismatch, not as silence', () => {
  // This is what ezCater sends back for a field we invented. It arrives as an
  // HTTP 200, which is exactly why it reads as "no orders" unless something
  // shouts. The raw notification stays in ezcater_events either way.
  const validation = new EzcaterError(200, 'GRAPHQL_VALIDATION_FAILED',
    "Field 'deliveryFee' doesn't exist on type 'CatererTotals' at order.catererCart.totals");
  assert.equal(isSchemaError(validation), true);
  assert.equal(isPermanent(validation), true);   // retrying the same bad query never helps

  // Recognised from the message alone when there is no code on it.
  assert.equal(isSchemaError(new EzcaterError(200, null, "Cannot query field 'latitude' on type 'Address'")), true);
  assert.equal(isSchemaError(new EzcaterError(200, null, "Unknown argument 'reason' on field 'rejectOrder'")), true);

  // A real business failure must NOT be mistaken for a schema bug.
  assert.equal(isSchemaError(new EzcaterError(200, 'feature_not_enabled', 'Accept is not enabled for this brand')), false);
  assert.equal(isSchemaError(new Error('network down')), false);
});

test('EVERY GraphQL error is reported, not just the first', () => {
  // A validation failure lists one entry per bad field. Reporting only the
  // first turns a five field mistake into five deploys.
  const errors = [
    { message: "Field 'isModified' doesn't exist on type 'Order'", path: ['order', 'isModified'] },
    { message: "Field 'orderNotes' doesn't exist on type 'Event'", path: ['order', 'event', 'orderNotes'] },
  ];
  const text = allMessages(errors);
  assert.match(text, /isModified/);
  assert.match(text, /orderNotes/);
  assert.match(text, /order\.event\.orderNotes/);   // the path, so the field can be found
  assert.equal(allMessages([]), 'unknown error');
  assert.equal(allMessages('plain text failure'), 'plain text failure');
});

// ── the ezCater sample order, field for field ───────────────────────────────

test('ezCater own sample order maps end to end', () => {
  // Quoted verbatim from the success response on "Viewing Order Details",
  // https://api.ezcater.io/order-details. If this fixture ever needs editing to
  // make the mapper pass, the mapper is wrong, not the fixture.
  const DOC_ORDER = {
    deliveryId: '3593ce70-7227-4fd4-8a78-9591083d0674',
    uuid: 'your-ezcater-order-id',
    caterer: {
      address: {
        city: 'Boston', deliveryInstructions: 'Ask for Jane at front desk', name: '',
        state: 'MA', stateName: 'Massachusetts', street: '12345 Restaurant Avenue',
        street2: null, street3: null, zip: '54321',
      },
      live: true, name: 'My Caterer Name', storeNumber: '00001', uuid: 'ezcater-caterer-id',
    },
    catererCart: {
      feesAndDiscounts: [
        { cost: money(2999), name: 'Delivery Fee' },
        { cost: money(-1199), name: 'Preferred Caterer Program' },
        { cost: money(-1199), name: 'Rewards Promo' },
      ],
      deliveryFees: [{ cost: money(2999), name: 'Delivery Fee' }],
      orderItems: [
        {
          customizations: [{
            customizationId: 'ezcater-menu-version-customization-parmigiano-reggiano-choice-12-inch-selection-id',
            customizationTypeId: 'ezcater-menu-version-customization-type-cheese-addon-options-id',
            customizationTypeName: 'Cheese Addon',
            name: 'Parmigiano Reggiano',
            posCustomizationId: 'parmigiano-reggiano-choice-12-inch-selection-id',
            quantity: 10,
          }],
          labelFor: null,
          menuItemSizeId: 'ezcater-menu-version-size-12-inch-pizza-item-selection-id',
          menuItemSizeName: '12" Pizza',
          name: 'Margherita Pizza',
          noteToCaterer: '12" thin crust Margherita Pizza',
          posItemId: '12-inch-pizza-item-selection-id',
          quantity: 10,
          specialInstructions: 'Please be careful not to burn crust',
          totalInSubunits: money(16750),
          uuid: '83ec5c82-fa68-437c-90d7-ad861a2c151b',
        },
        {
          customizations: [{
            customizationId: 'ezcater-menu-version-customization-brand-name-soda-choice-id',
            customizationTypeId: 'ezcater-menu-version-customization-type-soda-option-id',
            customizationTypeName: 'Soda', name: 'Select Soda',
            posCustomizationId: 'brand-name-soda-choice-id', quantity: 10,
          }],
          labelFor: null,
          menuItemSizeId: 'ezcater-menu-version-size-assorted-sodas-item-selection-id',
          menuItemSizeName: '2ltr Soda',
          name: 'Assorted Sodas',
          noteToCaterer: '2ltr brand name sodas from fridge',
          posItemId: 'assorted-sodas-item-selection-id',
          quantity: 10,
          specialInstructions: 'Please bring cold soda if possible',
          totalInSubunits: money(2750),
          uuid: 'c00e766f-e733-476a-939c-9aba59b4e93c',
        },
      ],
      tableware: {
        specialInstructions: null,
        tablewareChoices: [
          { choiceUuid: '7acc72ed-2240-4b9f-a903-f7873b94ba60', isIncluded: true, itemCount: 10, name: 'Napkins' },
          { choiceUuid: 'e8cb95f8-c2de-412d-a0de-d01e1879db83', isIncluded: true, itemCount: 10, name: 'Plates' },
          { choiceUuid: 'b73832f4-f8d8-4317-b93e-5788e926ab2c', isIncluded: true, itemCount: 10, name: 'Cups' },
        ],
      },
      totals: { catererTotalDue: 171.02 },
    },
    event: {
      address: {
        city: 'Boston', deliveryInstructions: 'Ask for Jane at front desk', name: 'My Office',
        state: 'MA', stateName: 'Massachusetts', street: '2345 Business Boulevard',
        street2: null, street3: null, zip: '23456',
      },
      catererHandoffFoodTime: '2025-03-27T16:15:00Z',
      contact: { name: 'Jane Doe', phone: '5555555555' },
      customerProvidedName: 'Team building event',
      headcount: 10,
      orderType: 'DELIVERY',
      thirdPartyDeliveryPartner: null,
      timeZoneIdentifier: 'America/New_York',
      timeZoneOffset: '-04:00',
      timestamp: '2025-03-27T16:30:00Z',
    },
    isTaxExempt: false,
    lifecycle: { orderIsCurrently: 'accepted' },
    orderCustomer: { firstName: 'Jane', fullName: 'Jane Doe', lastName: 'Doe' },
    orderNumber: 'O1O1O1',
    orderSourceType: 'MARKETPLACE',
    taxableAddress: {
      city: 'Boston', deliveryInstructions: 'Ask for Jane at front desk', name: '',
      state: 'MA', stateName: 'Massachusetts', street: '2345 Business Boulevard',
      street2: null, street3: null, zip: '23456',
    },
    totals: {
      customerTotalDue: money(23864),
      pointOfSaleIntegrationFee: money(0),
      salesTax: money(1365),
      salesTaxRemittance: money(0),
      subTotal: money(19500),
      tip: money(0),
    },
  };

  const { row, link } = orderToQueueRow(DOC_ORDER, LOC, { eventAt: '2025-03-20T10:00:00Z' });

  assert.equal(row.ref, 'EZ-your-ezcater-order-id');
  assert.equal(row.type, 'delivery');
  assert.equal(row.status, 'received');        // accepted, held like any catering order
  assert.equal(row.total, 171.02);             // catererTotalDue, what the venue banks

  // The timestamp is UTC with no offset, so the IANA zone is what makes it local.
  assert.equal(row.event_date, '2025-03-27');
  assert.equal(row.collection_time, '12:30');  // 16:30Z in America/New_York
  assert.equal(row.customer.handoff_time, '12:15');
  assert.equal(row.customer.eventTimeIsLocal, true);

  assert.equal(row.customer.name, 'Jane Doe');
  assert.equal(row.customer.phone, '5555555555');
  assert.equal(row.customer.buyerName, 'Jane Doe');
  assert.equal(row.customer.eventName, 'Team building event');
  assert.equal(row.customer.headcount, 10);
  assert.equal(row.customer.address.line1, '2345 Business Boulevard');
  assert.equal(row.customer.address.stateName, 'Massachusetts');
  assert.deepEqual(row.customer.tableware, [
    { name: 'Napkins', count: 10 }, { name: 'Plates', count: 10 }, { name: 'Cups', count: 10 },
  ]);

  // Money, split across the three places ezCater keeps it.
  assert.equal(row.customer.totals.subtotal, 195);
  assert.equal(row.customer.totals.salesTax, 13.65);
  assert.equal(row.customer.totals.salesTaxRemittance, 0);
  assert.equal(row.customer.totals.deliveryFee, 29.99);
  assert.equal(row.customer.totals.customerTotalDue, 238.64);
  assert.equal(row.customer.totals.catererTotalDue, 171.02);
  assert.equal(row.customer.tax.operatorRemits, 13.65);   // MA, the operator owes all of it
  assert.equal(row.customer.tax.taxableState, 'MA');
  assert.equal(link.sales_tax, 13.65);

  // Lines. Both totals include their customization, which carries no money.
  const [pizza, sodas] = row.items;
  assert.equal(pizza.name, 'Margherita Pizza');
  assert.equal(pizza.qty, 10);
  assert.equal(pizza.itemId, '12-inch-pizza-item-selection-id');
  assert.equal(pizza.sizeName, '12" Pizza');
  assert.equal(pizza.lineTotal, 167.5);
  assert.equal(pizza.price, 16.75);
  assert.equal(pizza.kitchenNote, '12" thin crust Margherita Pizza');
  assert.equal(pizza.mods[0].label, 'Parmigiano Reggiano');
  assert.equal(pizza.mods[0].groupLabel, 'Cheese Addon');
  assert.equal(pizza.mods[0].itemId, 'parmigiano-reggiano-choice-12-inch-selection-id');
  assert.equal(pizza.mods[0].price, null);
  assert.equal(sodas.lineTotal, 27.5);
  // The two food lines add up to the subtotal ezCater states. Nothing invented.
  assert.equal(+(pizza.lineTotal + sodas.lineTotal).toFixed(2), row.customer.totals.subtotal);
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

// ════════════════════════════════════════════════════════════════════════════
//  THE SIX LIVE SCHEMA REVIEW FINDINGS
//
//  Each of these fails against the code as it was before the fix. They are the
//  reason the fix exists, so they are quoted against the doc page that settles
//  the question rather than against what the code happens to do.
// ════════════════════════════════════════════════════════════════════════════

// ── 1. a reused subscriber keeps its OLD webhook URL ────────────────────────
//
// ezCater allows ONE subscriber per API user. On a reconnect createSubscriber
// fails, we fall back to the existing subscriber, and if that subscriber was
// created against another project or an older deploy it is still pointing at
// that webhook. Back Office then says connected and not one order arrives.
//
// "Updating Subscribers" publishes the way out:
//   updateSubscriber(subscriberId: ID!, subscriberParams: UpdateSubscriberFields!)
//   UpdateSubscriberFields is { name: String, webhookUrl: String }

test('SUBSCRIBER: updateSubscriber is the documented repoint, and it cannot move the secret', () => {
  assert.match(UPDATE_SUBSCRIBER_MUTATION.trim(), /^mutation ServOsEzUpdateSubscriber/);
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /\$subscriberId: ID!/);
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /\$subscriberParams: UpdateSubscriberFields!/);
  assert.match(UPDATE_SUBSCRIBER_MUTATION, /subscriber \{[^}]*webhookUrl/);

  // THE SECRET. UpdateSubscriberPayload returns a Subscriber, and Subscriber is
  // id, name, subscriptions and webhookUrl. webhookSecret is on NewSubscriber
  // and only createSubscriber ever returns one, and the docs say webhook
  // secrets cannot be changed at present. Asking for it here would be an
  // unknown field and would fail the whole mutation, taking the repoint with it.
  assert.equal(/webhookSecret/.test(UPDATE_SUBSCRIBER_MUTATION), false);
});

test('SUBSCRIBER: a reused subscriber pointing elsewhere is repointed, not accepted', () => {
  // ezcater-connect is a Deno edge function (Deno.serve, service role client),
  // so the connect path is guarded at the source the way kioskCardPathGuard
  // guards the kiosk card path. What matters is that all four things happen.
  const src = fs.readFileSync(
    new URL('../../supabase/functions/ezcater-connect/index.ts', import.meta.url), 'utf8',
  );

  // it imports the repoint
  assert.match(src, /\bupdateSubscriber\b[^\n]*from '\.\.\/_shared\/ezcater\.ts'|updateSubscriber,/);
  // it COMPARES the subscriber's own URL with ours, and only on the reused path
  assert.match(src, /reused && subscriberId && webhookUrl !== WEBHOOK_URL/);
  // it CALLS the repoint with our URL
  assert.match(src, /await updateSubscriber\(token, subscriberId, WEBHOOK_URL/);
  // it records the URL ezCater ACTUALLY has, never WEBHOOK_URL regardless.
  // Writing our own URL unconditionally into the post-subscribe patch is what
  // made a misdirected subscriber look healthy in Back Office. (The insert on
  // connect_token may still state our intended URL: subscribe() corrects it.)
  const patch = src.slice(src.indexOf('const patch: any = {'), src.indexOf('return { subscriberId'));
  assert.ok(patch.length > 0 && patch.length < 1200, 'the subscribe patch block moved');
  assert.equal(/webhook_url: WEBHOOK_URL,/.test(patch), false);
  assert.match(patch, /webhook_url: webhookUrl \|\| WEBHOOK_URL/);
  // a FAILED repoint is not a connection. It must land as an error, because
  // every notification is still going somewhere else.
  assert.match(src, /if \(repointError\) \{[\s\S]*?status = 'error'/);
  assert.match(src, /webhook_repoint_error: sub\.repointError/);
});

// ── 2. extensions.statusCode, the 403 and 404 hiding inside a 200 ───────────
//
// Quoted from ezCater's own failure samples (Courier Assign, Courier Event
// Create, Subscriber Update). The HTTP answer is 200 and the code is the
// catch-all DOWNSTREAM_SERVICE_ERROR, so the ONLY thing that says this will
// never succeed is extensions.statusCode. Without reading it the webhook 503s
// on a deleted order for as long as ezCater keeps retrying.

const downstream = (statusCode, message = 'Delivery not found') => ([{
  message,
  path: ['courierAssign'],
  extensions: {
    type: 'request',
    ...(statusCode == null ? {} : { statusCode }),
    serviceName: 'delivery-public',
    code: 'DOWNSTREAM_SERVICE_ERROR',
  },
}]);

const asThrown = (errors) => new EzcaterError(
  200, errors[0]?.extensions?.code ?? null, allMessages(errors), { errors }, firstStatusCode(errors),
);

test('ERRORS: extensions.statusCode is read, so a real 403 or 404 stops the retry loop', () => {
  assert.equal(firstStatusCode(downstream(404)), 404);
  assert.equal(firstStatusCode(downstream(403)), 403);
  assert.equal(firstStatusCode(downstream(null)), null);
  assert.equal(firstStatusCode('not an array'), null);
  assert.equal(firstStatusCode([]), null);

  // The four that no retry can turn into a success.
  for (const code of [400, 401, 403, 404]) {
    const e = asThrown(downstream(code));
    assert.equal(e.gqlStatus, code);
    assert.equal(e.code, 'DOWNSTREAM_SERVICE_ERROR');
    assert.equal(e.status, 200, 'ezCater answers these as an HTTP 200');
    assert.equal(isPermanent(e), true, `statusCode ${code} must be permanent`);
  }
});

test('ERRORS: a genuine 5xx and a bare DOWNSTREAM_SERVICE_ERROR both stay retryable', () => {
  // The whole point of reading the status code is to keep the retry for the
  // failures a retry actually fixes.
  for (const code of [500, 502, 503, 504]) {
    assert.equal(isPermanent(asThrown(downstream(code))), false, `statusCode ${code} must stay retryable`);
  }
  // No statusCode at all. That is the Subscriber Update failure sample, and it
  // says nothing about whether coming back later would work, so we come back.
  assert.equal(isPermanent(asThrown(downstream(null, 'Subscriber could not be updated.'))), false);
  // A network failure is not an EzcaterError at all.
  assert.equal(isPermanent(new Error('connection reset')), false);
  // The set is exactly the four, so nobody widens it to 5xx by accident.
  assert.deepEqual([...EZ_PERMANENT_STATUSES].sort((a, b) => a - b), [400, 401, 403, 404]);
});

test('ERRORS: the status code reaches the message, so a live log names it', () => {
  assert.match(asThrown(downstream(404)).message, /statusCode 404/);
});

// ── 3. event.timestamp is UTC, so the IANA zone always wins ─────────────────
//
// Event.timestamp and Event.catererHandoffFoodTime are both UTCTimestamp in the
// Order Schema Reference: "The UTC timestamp indicating when the customer
// expects to receive food". The wall clock in the string is therefore NOT the
// venue's, and timeZoneIdentifier is the only thing that says what the kitchen
// should read.

test('TIME: the IANA zone wins even when the string carries an explicit offset', () => {
  // 16:30Z in New York is 12:30, and it must not be read as 16:30 simply
  // because the string were written with an offset instead of a Z.
  assert.deepEqual(
    eventTimeParts('2026-09-04T16:30:00+00:00', 'America/New_York'),
    { date: '2026-09-04', time: '12:30', local: true },
  );
  // The same instant, three ways of writing it, one answer.
  const z = eventTimeParts('2026-09-04T16:30:00Z', 'America/New_York');
  assert.deepEqual(eventTimeParts('2026-09-04T16:30:00+00:00', 'America/New_York'), z);
  assert.deepEqual(eventTimeParts('2026-09-04T12:30:00-04:00', 'America/New_York'), z);

  // An offset from somewhere that is NOT the venue. Reading the wall clock
  // verbatim would have put this catering order on the wrong DAY.
  assert.deepEqual(
    eventTimeParts('2026-09-05T02:30:00+09:00', 'America/Los_Angeles'),
    { date: '2026-09-04', time: '10:30', local: true },
  );
});

test('TIME: with no zone the old behaviour is untouched', () => {
  // An explicit offset and nothing to convert into: read the wall clock and
  // call it local, exactly as before.
  assert.deepEqual(
    eventTimeParts('2026-09-04T11:30:00-04:00', null),
    { date: '2026-09-04', time: '11:30', local: true },
  );
  // Neither: the literal wall clock, flagged as not proven local.
  assert.deepEqual(
    eventTimeParts('2026-09-04T15:30:00Z', ''),
    { date: '2026-09-04', time: '15:30', local: false },
  );
  // A zone no runtime knows must not throw, it falls through to the literal.
  assert.deepEqual(
    eventTimeParts('2026-09-04T15:30:00-04:00', 'Mars/Olympus_Mons'),
    { date: '2026-09-04', time: '15:30', local: true },
  );
});

test('TIME: the order row and the handoff both go through the venue zone', () => {
  // The whole reason this matters: an order stamped in UTC with a zone beside
  // it has to reach the kitchen as the kitchen's own clock.
  const utcOrder = {
    ...TAKEOUT_ORDER,
    event: {
      ...TAKEOUT_ORDER.event,
      timestamp: '2026-09-04T16:30:00Z',
      catererHandoffFoodTime: '2026-09-04T16:15:00Z',
      timeZoneIdentifier: 'America/New_York',
      timeZoneOffset: '-04:00',
    },
  };
  const { row } = orderToQueueRow(utcOrder, LOC);
  assert.equal(row.collection_time, '12:30');
  assert.equal(row.event_date, '2026-09-04');
  assert.equal(row.customer.handoff_time, '12:15');
  assert.equal(row.customer.eventTimeIsLocal, true);
});

// ── 4. 'rejected' has to be subscribed or the till ticket never dies ────────

test('EVENTS: rejected is subscribed, and holds (never cancels) the ticket: only cancelled does', () => {
  // Documented EventKey: "An Order entity event indicating an order has been
  // rejected by a caterer or on behalf of a caterer through a partner
  // integration". A modification on an API-accepted order can ONLY be rejected
  // in the Partner Portal, so this is the common case, not the rare one.
  assert.ok(EZ_EVENTS.includes('rejected'), 'rejected must be subscribed');

  // Review round 3 (18 Sep 2026): ezCater's documented flows send a CANCELLED after a rejected
  // new order, and nothing after a rejected MODIFICATION (the accepted order stands). So a
  // rejected never cancels: a never accepted order is held, an accepted one stays accepted.
  assert.equal(ezStatusToQueueStatus('rejected'), 'received');
  const rejected = { ...TAKEOUT_ORDER, lifecycle: { orderIsCurrently: 'rejected' } };
  const fresh = orderToQueueRow(rejected, LOC).row;
  assert.equal(fresh.status, 'received');
  assert.equal(fresh.customer.ezcater_lifecycle, 'rejected', 'never accepted: held, not committed');
  const modRejected = orderToQueueRow(rejected, LOC, { priorAcceptedCount: 1 }).row;
  assert.equal(modRejected.status, 'received');
  assert.equal(modRejected.customer.ezcater_lifecycle, 'accepted', 'a rejected modification leaves it accepted');
  assert.equal(modRejected.customer.modificationRejected, true);
  assert.equal(modRejected.customer.ezcaterSays, 'rejected');

  // Every key we send is one ezCater publishes for the Order entity.
  const documented = ['submitted', 'accepted', 'rejected', 'cancelled', 'uncancelled', 'relish_finalized'];
  for (const k of EZ_EVENTS) assert.ok(documented.includes(k), `${k} is not a documented Order EventKey`);
  // uncancelled is still out: subscribable, never fires.
  assert.equal(EZ_EVENTS.includes('uncancelled'), false);
});

// ── 5. deleteSubscriptions: the id goes inline, because the type is unpublished

test('DELETE: the caterer id is inline exactly as the docs show, with no invented type', () => {
  const doc = deleteSubscriptionsMutation(CATERER_UUID);

  // The documented form. Everything inside subscriptionsParams is literal.
  assert.match(doc, /deleteSubscriptions\(subscriptionsParams: \{ parentEntity: Caterer, parentId: "3593ce70-7227-4fd4-8a78-9591083d0674" \}\)/);
  assert.match(doc, /success/);

  // NO variable declaration, and in particular no $parentId: UUID! against an
  // input object ezCater never publishes. Their Subscription API lists exactly
  // three input objects (CreateSubscriberFields, CreateSubscriptionFields,
  // UpdateSubscriberFields) and no delete input among them. A wrong variable
  // type fails the whole document, which would make every deleteSubscriptions
  // call a no-op that still looked like it worked.
  assert.equal(/\$parentId/.test(doc), false, 'the id must not travel as an undeclarable variable');
  assert.equal(/UUID!/.test(doc), false, 'the type of subscriptionsParams is not published, so it must not be guessed');
  assert.equal(/\(\$/.test(doc), false, 'the operation takes no variables at all');

  // Still a NAMED operation. ezCater rejects anonymous ones outright.
  assert.match(doc.trim(), /^mutation ServOsEzDeleteSubscriptions \{/);

  // The introspection query that would settle the type is named in the source,
  // so the next person does not have to guess either.
  const shared = fs.readFileSync(
    new URL('../../supabase/functions/_shared/ezcater.ts', import.meta.url), 'utf8',
  );
  assert.match(shared, /__type\(name: "Mutation"\)/);
});

test('DELETE: an id that is not a caterer UUID never reaches the document', () => {
  // The id is part of the document text, so it is checked rather than trusted.
  for (const bad of ['', '   ', null, undefined, 'not-a-uuid', '3593ce70-7227-4fd4-8a78', 42,
    '3593ce70-7227-4fd4-8a78-9591083d0674" } ) { success } } mutation x { deleteSubscriptions(subscriptionsParams: { parentEntity: Caterer, parentId: "']) {
    assert.throws(() => deleteSubscriptionsMutation(bad), /caterer UUID/, `${String(bad)} must be refused`);
  }
  // Case does not matter, RFC 4122 hex is hex.
  assert.match(deleteSubscriptionsMutation(CATERER_UUID.toUpperCase()), /parentId: "3593CE70-7227-4FD4-8A78-9591083D0674"/);
});

// ── 6. the line total is the authority, never price * qty ───────────────────
//
// An ezCater order item has NO unit price. totalInSubunits is "Total cost of
// item, including customizations, in currency sub-units", so the unit price is
// a DIVISION we do, and on a quantity that does not divide evenly it does not
// come back out. price is for display; every sum reads lineSubunits.

test('MONEY: a qty 3 line does not drift, because the ticket sums lineSubunits', () => {
  // 1000 subunits over 3. The unit price rounds to 3.33 and 3.33 * 3 is 9.99,
  // a cent under the 10.00 ezCater charged.
  const order = {
    ...TAKEOUT_ORDER,
    catererCart: {
      ...TAKEOUT_ORDER.catererCart,
      totals: { catererTotalDue: null },
      orderItems: [
        { uuid: 'oi-3', name: 'Sandwich platter', quantity: 3, totalInSubunits: money(1000), customizations: [] },
        // A second awkward one, so the drift would compound rather than cancel.
        { uuid: 'oi-7', name: 'Cookie box', quantity: 7, totalInSubunits: money(2000), customizations: [] },
      ],
    },
  };
  const { row } = orderToQueueRow(order, LOC);
  const [platter, cookies] = row.items;

  // The line totals are exact, straight from subunits.
  assert.equal(platter.lineSubunits, 1000);
  assert.equal(platter.lineTotal, 10);
  assert.equal(cookies.lineSubunits, 2000);
  assert.equal(cookies.lineTotal, 20);

  // The unit price is the rounded display figure, and it DOES drift. Pinned so
  // nobody mistakes it for money.
  assert.equal(platter.price, 3.33);
  assert.equal(+(platter.price * platter.qty).toFixed(2), 9.99);
  assert.equal(cookies.price, 2.86);
  assert.equal(+(cookies.price * cookies.qty).toFixed(2), 20.02);

  // THE TICKET IS EXACT. Summing price * qty would give 30.01, a penny over.
  assert.equal(ticketSubunits(row.items), 3000);
  assert.equal(ticketTotal(row.items), 30);
  assert.equal(row.customer.totals.itemsSubunits, 3000);
  assert.equal(row.customer.totals.itemsTotal, 30);
  const byUnitPrice = +row.items.reduce((s, l) => s + l.price * l.qty, 0).toFixed(2);
  assert.notEqual(byUnitPrice, 30);
  assert.equal(byUnitPrice, 30.01);

  // Every line carries the exact pennies, so nothing downstream has to divide.
  for (const l of row.items) assert.equal(typeof l.lineSubunits, 'number');
});

test('MONEY: a ticket with no caterer total and no subtotal falls back to the LINE SUM', () => {
  // The last resort, and it is the line total sum in exact subunits, never
  // price * qty. Without Order.totals a real order would otherwise show 0.00.
  const order = {
    uuid: 'ord-lines-only',
    event: { orderType: 'TAKEOUT' },
    catererCart: {
      orderItems: [
        { uuid: 'a', name: 'Tray', quantity: 3, totalInSubunits: money(1000) },
        { uuid: 'b', name: 'Tray', quantity: 3, totalInSubunits: money(1000) },
        { uuid: 'c', name: 'Tray', quantity: 3, totalInSubunits: money(1000) },
      ],
    },
  };
  const { row } = orderToQueueRow(order, LOC);
  assert.equal(row.total, 30);              // not 29.97
  assert.equal(row.customer.totals.itemsTotal, 30);
});

test('MONEY: the real ezCater totals still win over the line sum', () => {
  // The fallback must never quietly replace a figure ezCater actually stated.
  const { row } = orderToQueueRow(DELIVERY_ORDER, LOC);
  assert.equal(row.total, row.customer.totals.catererTotalDue);
  assert.ok(row.customer.totals.itemsTotal > 0);
  assert.notEqual(row.total, row.customer.totals.itemsTotal);
});

test('MONEY: lineSubunitsOf prefers the exact pennies and degrades in order', () => {
  assert.equal(lineSubunitsOf({ lineSubunits: 1000, lineTotal: 9.99, price: 3.33, qty: 3 }), 1000);
  // No subunits: the rounded line total, which is still the line and not a product.
  assert.equal(lineSubunitsOf({ lineTotal: 10, price: 3.33, qty: 3 }), 1000);
  // Neither: price * qty, the only one that drifts, and the last resort.
  assert.equal(lineSubunitsOf({ price: 3.33, qty: 3 }), 999);
  assert.equal(lineSubunitsOf({}), 0);
  assert.equal(lineSubunitsOf(null), 0);
  assert.equal(ticketSubunits(null), 0);
  assert.equal(ticketTotal([]), 0);
});
