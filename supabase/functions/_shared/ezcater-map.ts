// supabase/functions/_shared/ezcater-map.ts
//
// PURE mappers between an ezCater order and the ServOS data model. No supabase
// client, no fetch, no Deno globals, no clock reads that change the output.
// Everything here is a function of its arguments, which is what makes it unit
// testable from src/lib/ezcaterMap.test.js without a token or a database.
//
// Mirrors _shared/hubrise-map.ts section for section:
//   1. order  ->  an order_queue row (source='ezcater') + an ezcater_order_links row
//   2. lifecycle  ->  ServOS queue status
//
// Plan: EZCATER_INTEGRATION_PLAN.md.

import { subunitsToNumber, moneyToAmount, moneyCurrency, dollarsToNumber } from './ezcater.ts';

// ════════════════════════════════════════════════════════════════════════════
//  TAX. READ THIS BEFORE CHANGING ANYTHING BELOW.
// ════════════════════════════════════════════════════════════════════════════
//
// ezCater calculates, charges and in most states REMITS the sales tax itself.
// This file records what ezCater says and recomputes NOTHING.
//
// That is the deliberate OPPOSITE of the rule in src/lib/channelMoney.js, which
// distrusts a channel's tax and recomputes from our own tax_profiles. That rule
// is correct for HubRise, where the venue is the seller of record under UK VAT
// and the channel is only a courier. It is wrong for ezCater, for three reasons
// our tax engine has no way to model:
//
//   1. Menu items carry an Avalara taxCategory. ezCater looks up the rate from
//      that classification, not from our tax_profiles.
//   2. Orders carry taxableAddress, which is "either the origin (store) address
//      or the destination (event) address". That is DESTINATION SOURCING. Our
//      cascade has no concept of it and would silently use the venue address.
//   3. ezCater remits directly in 33 states plus DC as a marketplace
//      facilitator, and in the other 16 it remits nothing and hands the whole
//      collected amount to the operator to remit. totals.salesTaxRemittance is
//      literally "the sales tax remitted by ezCater".
//
// Recomputing would make the operator's US filings wrong in BOTH directions:
// over declaring in facilitator states, under declaring elsewhere. So:
//
//   * NEVER call computeOrderTaxUnified or buildChannelCloseFields on an
//     ezCater order.
//   * salesTax and salesTaxRemittance are copied verbatim, subunits kept
//     alongside the major unit figure so nothing is lost to rounding.
//   * the state from taxableAddress is recorded so reporting can split "tax we
//     owe" from "tax ezCater already remitted".
//   * operatorRemits is a SUBTRACTION of two recorded figures, not a
//     calculation of tax. It is the operator's own liability and is the number
//     phase 4 reconciles against the weekly statement.
//
// The facilitator state list changes. It is not hardcoded here on purpose,
// because a stale list in code is worse than reading the two figures ezCater
// already gives us on every single order.
// ════════════════════════════════════════════════════════════════════════════

/** ezCater event.orderType to a ServOS order_queue type. */
export const EZ_ORDER_TYPE_TO_QUEUE: Record<string, string> = {
  TAKEOUT: 'collection',
  DELIVERY: 'delivery',
  // ezCater dispatches a third party courier. Still a delivery to the kitchen,
  // but see thirdPartyDelivery below: the venue is NOT paid the tip or the
  // delivery fee on these even though both appear in the response.
  THIRD_PARTY_DELIVERY: 'delivery',
};

/**
 * ezCater lifecycle value to a ServOS queue status.
 *
 * Two quirks are baked in here rather than at the call site:
 *
 *   relish_finalized is the ONLY event a Meal Program (Club Soda) order ever
 *   sends. There is no submitted and no accepted, and it arrives about 90
 *   minutes before the event. It maps to 'received' so it lands as a live,
 *   actionable ticket rather than something already in preparation.
 *
 *   uncancelled is subscribable but never actually fires. It is mapped anyway
 *   so that if ezCater ever turns it on we do not drop the order, but nothing
 *   should be built on the assumption that it will arrive.
 */
export function ezStatusToQueueStatus(lifecycleValue: unknown): string {
  const v = String(lifecycleValue ?? '').trim().toLowerCase();
  switch (v) {
    case 'draft':
    case 'submitted':
    case 'relish_finalized':
    case 'uncancelled':
      return 'received';
    case 'accepted':
      return 'prep';
    case 'ready':
    case 'ready_for_pickup':
      return 'ready';
    case 'completed':
    case 'fulfilled':
    case 'delivered':
      return 'collected';
    case 'rejected':
    case 'cancelled':
    case 'canceled':
    case 'cancelled_for_replacement':
      return 'cancelled';
    default:
      return 'received';
  }
}

/** Lifecycle values that mean the order is dead and must not be prepared. */
export const EZ_TERMINAL = new Set(['rejected', 'cancelled', 'canceled', 'cancelled_for_replacement']);

/**
 * Pull the lifecycle value off an order.
 *
 * The real field is lifecycle { orderIsCurrently }. It is read FIRST because an
 * earlier version of this file read lifecycle.value, which does not exist: the
 * order query failed outright, and had it not, every order would have mapped to
 * 'received' and a cancelled order would have gone to the kitchen.
 *
 * The other shapes stay as a safety net only. They must never be the reason a
 * wrong field name looks like it is working.
 */
export function ezLifecycle(order: any): string {
  const raw = order?.lifecycle?.orderIsCurrently
    ?? order?.lifecycle?.value ?? order?.lifecycleValue ?? order?.lifecycle ?? order?.status ?? '';
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Time
// ────────────────────────────────────────────────────────────────────────────

/**
 * Split an ezCater event timestamp into the venue local calendar date and clock
 * time the kitchen actually needs to see.
 *
 * THE IANA ZONE WINS WHENEVER THERE IS ONE. Event.timestamp and
 * Event.catererHandoffFoodTime are both typed UTCTimestamp in ezCater's schema:
 * "The UTC timestamp indicating when the customer expects to receive food", and
 * every sample is a Z string next to a separate timeZoneIdentifier. So the wall
 * clock inside the string is NOT the venue's wall clock, whatever suffix it
 * carries, and timeZoneIdentifier is the only thing that says what the kitchen
 * should see. An earlier version preferred an explicit offset over the zone,
 * which is right for HubRise (where the offset IS the venue's) and wrong here:
 * the day ezCater sends +00:00 instead of Z, or an offset from anywhere but the
 * venue, every catering ticket would have shown the wrong time on the wrong day.
 *
 * Cases, in order:
 *   1. an IANA identifier is supplied, so format the instant in that zone.
 *      Offset or Z in the string makes no difference, both parse to the same
 *      instant and the zone decides the rest.
 *   2. no usable zone but the string carries an explicit offset, so read the
 *      wall clock verbatim and call it local. Same trick as HubRise's hrTimeLabel.
 *   3. neither, so read the literal wall clock out of the string and flag it.
 *
 * Deliberately NOT a device clock read. The venue clock invariant says business
 * time comes from the venue timezone and never from wherever this code happens
 * to run, and an edge function runs in UTC in a datacentre nowhere near the
 * kitchen. Returns null when there is nothing parseable at all.
 */
export function eventTimeParts(iso: unknown, timeZone?: unknown): { date: string; time: string; local: boolean } | null {
  const s = String(iso ?? '').trim();
  if (!s) return null;

  const hasOffset = /[+-]\d{2}:?\d{2}$/.test(s);
  const tz = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : null;

  if (tz) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(t);
        const get = (k: string) => parts.find((p) => p.type === k)?.value || '';
        const date = `${get('year')}-${get('month')}-${get('day')}`;
        // en-CA renders midnight as 24 in some runtimes. Normalise it.
        const hour = get('hour') === '24' ? '00' : get('hour');
        if (get('year') && get('hour')) return { date, time: `${hour}:${get('minute')}`, local: true };
      } catch {
        // invalid IANA identifier, fall through to the literal read
      }
    }
  }

  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = s.match(/T(\d{2}):(\d{2})/);
  if (!d || !t) return null;
  return { date: `${d[1]}-${d[2]}-${d[3]}`, time: `${t[1]}:${t[2]}`, local: hasOffset };
}

// ────────────────────────────────────────────────────────────────────────────
// Line items
// ────────────────────────────────────────────────────────────────────────────

const asQty = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * Resolve a line's money.
 *
 * AN ORDER ITEM HAS NO UNIT PRICE. totalInSubunits is the only money on a line
 * and ezCater's own words for it are "Total cost of item, INCLUDING
 * customizations, in currency sub-units". So:
 *
 *   lineTotal is the truth, straight from subunits.
 *   price is lineTotal / qty, and it is the price of one unit WITH its options
 *   on it, not the price of the bare product. That is flagged on the line as
 *   priceIncludesOptions so nothing downstream adds an option price on top.
 *
 * The old code guessed at priceInSubunits / unitPriceInSubunits. Neither field
 * exists, so it always fell through to the division, and because it also
 * divided each CUSTOMIZATION's own total the same way, a paid option was
 * counted twice: once folded into the line and once as a mod price. Every
 * ezCater ticket with a paid option would have been over the real figure.
 *
 * THE LINE TOTAL IS THE AUTHORITY, NEVER price * qty. The division does not
 * come back out evenly: 1000 subunits over a qty of 3 rounds to a unit price of
 * 3.33, and 3.33 * 3 is 9.99, a cent under the 10.00 ezCater charged. On a
 * catering order with a dozen such lines that is a ticket that does not match
 * the remittance, so price exists for display only and every sum runs off
 * lineSubunits. See lineSubunitsOf and ticketSubunits below.
 *
 * lineSubunits is kept on EVERY line so reporting can rebuild the exact pennies
 * without touching the rounded pounds.
 */
function lineMoney(node: any, qty: number): { unit: number; total: number; subunits: number } {
  const totalSub = subunitsToNumber(node?.totalInSubunits);
  return { unit: +(totalSub / qty / 100).toFixed(2), total: +(totalSub / 100).toFixed(2), subunits: totalSub };
}

/**
 * The exact pennies on one mapped line.
 *
 * lineSubunits first, because it is the figure ezCater actually sent. lineTotal
 * is the same number rounded and is only a fallback for a line that came from
 * somewhere else. price * qty is the LAST resort and is the very thing that
 * drifts, so it is reached only when a line carries no total at all.
 */
export function lineSubunitsOf(line: any): number {
  const sub = line?.lineSubunits;
  if (typeof sub === 'number' && Number.isFinite(sub)) return Math.round(sub);
  const total = Number(line?.lineTotal);
  if (Number.isFinite(total)) return Math.round(total * 100);
  const price = Number(line?.price);
  const qty = Number(line?.qty);
  if (Number.isFinite(price) && Number.isFinite(qty)) return Math.round(price * qty * 100);
  return 0;
}

/** Exact pennies across a whole ticket. Integers all the way, so nothing drifts. */
export function ticketSubunits(lines: any): number {
  return (Array.isArray(lines) ? lines : []).reduce((s: number, l: any) => s + lineSubunitsOf(l), 0);
}

/** The same figure in major units. The one number anything summing a ticket should read. */
export function ticketTotal(lines: any): number {
  return +(ticketSubunits(lines) / 100).toFixed(2);
}

/**
 * catererCart.orderItems[] to the ServOS line item shape, same keys the POS,
 * KDS and print routing already read on a HubRise order.
 *
 * posItemId is ezCater's field for OUR menu item id, set when the menu was
 * created through the Menus API. It lands on itemId, which is what KDS station
 * routing and 86 both key on. It is very often null, because a Partner Portal
 * menu built by hand has nothing to link to, so nothing downstream may assume
 * it is present.
 *
 * A CUSTOMIZATION HAS NO MONEY AT ALL. OrderItemCustomization is exactly
 * customizationId, customizationTypeId, customizationTypeName, name,
 * posCustomizationId and quantity. Its price is therefore null, meaning "not
 * priced separately", never 0, which would read as "free".
 */
export function orderItemsToLines(orderItems: any): any[] {
  return (Array.isArray(orderItems) ? orderItems : []).map((oi: any) => {
    const qty = asQty(oi?.quantity);
    const money = lineMoney(oi, qty);
    return {
      itemId: oi?.posItemId ? String(oi.posItemId) : null,
      ezItemId: oi?.uuid ? String(oi.uuid) : null,
      // ezCater's own menu ids. Menu side, not line side, so they are the ones
      // that survive a customer editing the order.
      ezSizeId: oi?.menuItemSizeId ? String(oi.menuItemSizeId) : null,
      sizeName: oi?.menuItemSizeName ? String(oi.menuItemSizeName) : null,
      name: String(oi?.name || 'Item'),
      qty,
      price: money.unit,
      lineTotal: money.total,
      lineSubunits: money.subunits,
      priceIncludesOptions: true,
      mods: (Array.isArray(oi?.customizations) ? oi.customizations : []).map((c: any) => ({
        label: String(c?.name || 'Option'),
        groupLabel: c?.customizationTypeName ? String(c.customizationTypeName) : null,
        // posCustomizationId is the documented field. posItemId is read too, so the code rule
        // works whichever spelling a query brings back; neither means null, as before.
        itemId: c?.posCustomizationId ? String(c.posCustomizationId) : (c?.posItemId ? String(c.posItemId) : null),
        ezItemId: c?.customizationId ? String(c.customizationId) : null,
        ezGroupId: c?.customizationTypeId ? String(c.customizationTypeId) : null,
        qty: asQty(c?.quantity),
        // Already inside the parent line's total. Never priced again here.
        price: null,
      })),
      notes: String(oi?.specialInstructions || ''),
      // The caterer only note, e.g. "12 inch thin crust". Kitchen wants it.
      kitchenNote: String(oi?.noteToCaterer || ''),
      // Who the tray is for, on an order split between named people.
      labelFor: oi?.labelFor ? String(oi.labelFor) : null,
    };
  });
}

/**
 * catererCart.feesAndDiscounts[] to plain rows. There is no deliveryFee field:
 * a fee is a LineItem of { name, cost }, and the TYPE is not echoed back in the
 * response, which is why the query asks for the DELIVERY_FEE ones under their
 * own alias rather than matching on the display name.
 */
export function feeRows(list: any): Array<{ name: string; amount: number; subunits: number }> {
  return (Array.isArray(list) ? list : []).map((f: any) => ({
    name: String(f?.name || 'Fee'),
    amount: moneyToAmount(f?.cost),
    subunits: subunitsToNumber(f?.cost),
  }));
}

/** Total of a fee list, in major units. Discounts are negative and stay negative. */
export function feeTotal(list: any): number {
  return +(feeRows(list).reduce((s, f) => s + f.subunits, 0) / 100).toFixed(2);
}

// ────────────────────────────────────────────────────────────────────────────
// Order to order_queue row
// ────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

// ────────────────────────────────────────────────────────────────────────────
// The ezMatch stamp
// ────────────────────────────────────────────────────────────────────────────

/**
 * How many unmatched names ride on the order row. A 300 line catering order
 * with an unmatched menu would otherwise put 300 strings in a jsonb column that
 * every Orders Hub poll then reads. The count is never truncated: lines minus
 * matched is always the true number, whatever the list shows.
 */
export const EZ_MATCH_MAX_NAMES = 25;

/**
 * The small summary the Orders Hub and the matching screen read off the order,
 * so neither has to walk the lines or make a second query:
 *
 *   ezMatch { lines: 5, matched: 3, unmatched: ['Veggie Platter', 'Brownies'] }
 *
 * Names are the venue's own ezCater spelling, deduped (the same product on two
 * lines is one thing to fix, not two) and capped.
 *
 * A line counts as matched when it has an itemId from ANY source: a saved link,
 * an auto link, or a posItemId ezCater already carried. itemId is what routing
 * and stock key on, so that is the only question worth answering here.
 */
export function ezMatchSummary(lines: any, maxNames: number = EZ_MATCH_MAX_NAMES): { lines: number; matched: number; unmatched: string[] } {
  const list = Array.isArray(lines) ? lines : [];
  const cap = Number.isFinite(maxNames) && maxNames > 0 ? Math.floor(maxNames) : EZ_MATCH_MAX_NAMES;
  let matched = 0;
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const line of list) {
    const ok = !!(line && line.match ? line.match.matched : (line && line.itemId));
    if (ok) { matched++; continue; }
    const name = str(line?.name) || 'Item';
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (unmatched.length < cap) unmatched.push(name);
  }
  return { lines: list.length, matched, unmatched };
}

/**
 * Put the matched lines back on an order_queue row and stamp the summary into
 * the customer jsonb, which is where everything ezCater sends that order_queue
 * has no column for already lives.
 *
 * Returns a NEW row. Does not mutate the one it was given, because the caller
 * keeps the original as its fallback if anything downstream goes wrong.
 */
export function withMatchedItems(row: any, lines: any): any {
  if (!row) return row;
  const items = Array.isArray(lines) ? lines : [];
  return {
    ...row,
    items,
    customer: { ...(row.customer || {}), ezMatch: ezMatchSummary(items) },
  };
}

/**
 * Map one ezCater order onto an order_queue row plus an ezcater_order_links row.
 *
 *   ref     'EZ-' + order.uuid
 *   source  'ezcater'
 *   type    from event.orderType
 *   paid    always true, ezCater takes the payment and remits weekly
 *
 * Everything ezCater sends that order_queue has no column for rides in the
 * customer jsonb, the same trick HubRise orders and QR tabs use. Nothing is
 * dropped, because the second leg of ingest is a network call we may not get to
 * make again.
 *
 * opts.priorAcceptedCount lets the caller mark a MODIFICATION. ezCater has no
 * modified event: a modification arrives as a SECOND accepted notification for
 * the same order id, so the only way to know is to count. The mapper stays pure
 * by taking the previous count as an argument rather than reading it itself.
 */
export function orderToQueueRow(
  order: any,
  locationId: string,
  opts: { priorAcceptedCount?: number; eventAt?: string | null } = {},
): { row: any; link: any } {
  const uuid = str(order?.uuid);
  const ref = `EZ-${uuid}`;
  const ev = order?.event || {};
  const cart = order?.catererCart || {};
  // THREE DIFFERENT TOTALS OBJECTS. Order.totals is the money (OrderTotals),
  // catererCart.totals holds catererTotalDue and nothing else (CatererTotals),
  // and the fees are a list, not a field. Reading the caterer cart for salesTax
  // is what silently zeroed every tax figure before this fix.
  const totals = order?.totals || {};
  const catererTotals = cart?.totals || {};

  const orderType = str(ev?.orderType).toUpperCase();
  const type = EZ_ORDER_TYPE_TO_QUEUE[orderType] || 'collection';
  const thirdParty = orderType === 'THIRD_PARTY_DELIVERY';

  const lifecycle = ezLifecycle(order);
  const terminal = EZ_TERMINAL.has(lifecycle);
  const status = ezStatusToQueueStatus(lifecycle);

  const items = orderItemsToLines(cart?.orderItems);
  // The exact pennies across the lines, summed as integers. Recorded so nothing
  // downstream ever has to reach for price * qty, which loses a cent on any
  // quantity the line total does not divide into evenly.
  const itemsSubunits = ticketSubunits(items);
  const itemsTotal = +(itemsSubunits / 100).toFixed(2);

  // ── Money. Every component is kept, nothing is inferred. ──────────────────
  // subTotal has a capital T. The lower case spelling is accepted only as a
  // belt and braces read, because a silent 0 here becomes a wrong tax filing.
  const subtotalMoney = totals?.subTotal ?? totals?.subtotal;
  const subtotal = moneyToAmount(subtotalMoney);
  const salesTax = moneyToAmount(totals?.salesTax);
  const salesTaxRemittance = moneyToAmount(totals?.salesTaxRemittance);
  const tip = moneyToAmount(totals?.tip);
  const posIntegrationFee = moneyToAmount(totals?.pointOfSaleIntegrationFee);
  const customerTotalDue = moneyToAmount(totals?.customerTotalDue);
  // Fees and discounts are a LIST on the caterer cart. deliveryFees is the same
  // list filtered to DELIVERY_FEE by the query, so no name matching is needed.
  const fees = feeRows(cart?.feesAndDiscounts);
  const deliveryFee = feeTotal(cart?.deliveryFees);
  // catererTotalDue is a float in DOLLARS, not a subunits object. See dollarsToNumber.
  const catererTotalDue = dollarsToNumber(catererTotals?.catererTotalDue);
  const currency = moneyCurrency(subtotalMoney ?? totals?.salesTax, 'USD');

  // order_queue.total on a PREPAID channel order is the number the venue banks,
  // and catererTotalDue is ezCater's own statement of exactly that, net of
  // commission. Fall back to subtotal plus tax only when it is missing, so a
  // ticket never shows 0.00 for a real order. Every component stays in
  // customer.totals so phase 4 reporting can rebuild whichever view it needs.
  //
  // The last resort is the LINE SUM, in exact subunits, for the case where
  // catererTotalDue and Order.totals are both absent but there are real lines on
  // the cart. It is deliberately the line total sum and never price * qty.
  const lineFallback = +((itemsSubunits + subunitsToNumber(totals?.salesTax)) / 100).toFixed(2);
  const total = catererTotalDue > 0
    ? catererTotalDue
    : (subtotal > 0 ? +(subtotal + salesTax).toFixed(2) : lineFallback);

  // ── Tax, verbatim. See the banner at the top of this file. ────────────────
  // taxableAddress hangs off the ORDER, not off totals.
  const taxableAddress = order?.taxableAddress || null;
  const taxableState = str(taxableAddress?.state).toUpperCase() || null;
  const tax = {
    engine: 'ezcater',                 // NEVER our tax_profiles cascade on this source
    salesTax,
    salesTaxSubunits: subunitsToNumber(totals?.salesTax),
    salesTaxRemittance,
    salesTaxRemittanceSubunits: subunitsToNumber(totals?.salesTaxRemittance),
    // What the operator still owes their state. A subtraction of two recorded
    // figures, not a tax calculation.
    operatorRemits: +(salesTax - salesTaxRemittance).toFixed(2),
    taxableState,
    taxableAddress: taxableAddress || null,   // kept whole, destination sourcing means the address IS the evidence
    // ezCater's own flag. A tax exempt buyer (a school, a charity) is why a
    // real order can show a zero tax line and still be right.
    taxExempt: order?.isTaxExempt === true,
    currency,
  };

  // ── Timing ────────────────────────────────────────────────────────────────
  const when = eventTimeParts(ev?.timestamp, ev?.timeZoneIdentifier);
  // When the food must be HANDED OVER, which on a delivery is earlier than the
  // time the customer expects it. This is the kitchen's real deadline.
  const handoff = eventTimeParts(ev?.catererHandoffFoodTime, ev?.timeZoneIdentifier);

  // ── Contact and address ───────────────────────────────────────────────────
  // EventContact is name and phone ONLY, and OrderCustomer is firstName,
  // lastName and fullName ONLY. There is no email and no phone extension
  // anywhere on an ezCater order, so nothing pretends otherwise here.
  const contact = ev?.contact || {};
  const addr = ev?.address || {};
  const buyer = order?.orderCustomer || {};
  const buyerName = str(buyer?.fullName)
    || [str(buyer?.firstName), str(buyer?.lastName)].filter(Boolean).join(' ');
  // The on-site contact is who the driver or the collector actually meets, so
  // that name leads. The buyer is kept separately, they are often different people.
  const name = str(contact?.name) || buyerName || 'ezCater customer';

  const customer: any = {
    name,
    phone: str(contact?.phone),
    email: '',
    address: type === 'delivery'
      ? {
          line1: str(addr?.street),
          line2: str(addr?.street2),
          line3: str(addr?.street3),
          city: str(addr?.city),
          state: str(addr?.state),
          stateName: str(addr?.stateName),
          postcode: str(addr?.zip),
          country: 'US',
          name: str(addr?.name),
          instructions: str(addr?.deliveryInstructions),
        }
      : null,
    // An ezCater order carries no order level note. The nearest thing a customer
    // can type that the kitchen must see is the tableware instruction, so it is
    // labelled rather than dropped. Per line notes live on the line.
    notes: str(cart?.tableware?.specialInstructions)
      ? `Tableware: ${str(cart.tableware.specialInstructions)}`
      : '',

    // Catering specifics the kitchen needs on the ticket.
    headcount: Number.isFinite(Number(ev?.headcount)) ? Number(ev.headcount) : null,
    eventName: str(ev?.customerProvidedName) || null,
    buyerName: buyerName || null,
    event_date: when ? when.date : null,
    event_time: when ? when.time : null,
    eventTimeZone: str(ev?.timeZoneIdentifier) || null,
    eventTimeOffset: str(ev?.timeZoneOffset) || null,
    // false means we could not resolve the venue local wall clock and are
    // showing the raw timestamp. Worth surfacing rather than quietly trusting.
    eventTimeIsLocal: when ? when.local : null,
    handoff_time: handoff ? handoff.time : null,
    handoffAt: str(ev?.catererHandoffFoodTime) || null,

    // Plates, napkins and cups ezCater has promised the customer. The kitchen
    // packs these, so they belong on the ticket.
    tableware: (Array.isArray(cart?.tableware?.tablewareChoices) ? cart.tableware.tablewareChoices : [])
      .filter((t: any) => t?.isIncluded !== false)
      .map((t: any) => ({ name: str(t?.name), count: Number(t?.itemCount) || 0 })),

    channel: 'ezCater',
    source_label: str(order?.orderSourceType) || 'ezCater',
    serviceType: orderType || null,

    // ezCater ALWAYS takes the payment, weekly remittance. There is no unpaid
    // ezCater order, which is why 'ezcater' belongs in OrdersHub's
    // PREPAID_CHANNELS (phase 2, front end).
    paid: true,
    paidAmount: total,
    due: 0,

    totals: {
      subtotal, salesTax, salesTaxRemittance, tip, deliveryFee,
      pointOfSaleIntegrationFee: posIntegrationFee,
      customerTotalDue,
      catererTotalDue, currency,
      // The sum of the LINE TOTALS, exact. Anything that has to total the food
      // on this ticket reads these two and never multiplies the unit price,
      // which is a rounded display figure. See ticketSubunits.
      itemsTotal, itemsSubunits,
      // Every fee and discount ezCater applied, verbatim and named, because the
      // weekly statement has to be reconciled line by line and a discount only
      // ever appears here. Discounts arrive negative and stay negative.
      feesAndDiscounts: fees,
    },
    tax,

    // THE THIRD PARTY DELIVERY TRAP. Both tip and deliveryFee appear in the
    // response on these orders, and ezCater pays the restaurant NEITHER. Flagged
    // rather than zeroed, so the figures stay verbatim and reporting can decide.
    thirdPartyDelivery: thirdParty,
    thirdPartyPartner: thirdParty ? (str(ev?.thirdPartyDeliveryPartner) || null) : null,
    catererReceivesTip: !thirdParty,
    catererReceivesDeliveryFee: !thirdParty,

    ezcater_order_id: uuid,
    ezcater_order_number: str(order?.orderNumber) || null,
    ezcater_caterer_id: str(order?.caterer?.uuid) || null,
    ezcater_caterer_name: str(order?.caterer?.name) || null,
    ezcater_store_number: str(order?.caterer?.storeNumber) || null,
    ezcater_delivery_id: str(order?.deliveryId) || null,
    ezcater_lifecycle: lifecycle || null,
  };

  // A modification is a SECOND accepted for an order we have already seen
  // accepted. Marked on the row so the floor can see the ticket changed, and
  // because acceptOrder then needs acceptModification: true or ezCater answers
  // invalid_state_transition.
  const priorAccepted = Number(opts.priorAcceptedCount) || 0;
  const acceptedCount = lifecycle === 'accepted' ? priorAccepted + 1 : priorAccepted;
  const isModification = lifecycle === 'accepted' && priorAccepted >= 1;
  if (isModification) {
    customer.modified = true;
    customer.modificationCount = acceptedCount - 1;
  }

  const row = {
    ref,
    location_id: locationId,
    type,
    customer,
    items,
    total,
    status: terminal ? 'cancelled' : status,
    source: 'ezcater',
    // Catering orders are booked days ahead. There is no such thing as an ASAP
    // ezCater order, so the queue must never treat one as a live now ticket.
    is_asap: false,
    collection_time: when ? when.time : null,
    event_date: when ? when.date : null,
    paid: true,
    // An ezCater Order has NO createdAt. queuePayload stamps the row's own
    // arrival time instead, which is the only honest answer we have.
    created_at: null,
    // The raw event instant, kept on the row so queuePayload can stamp sent_at
    // with a real point in time rather than a reassembled local string.
    fire_at: str(ev?.timestamp) || null,
  };

  const link = {
    ref,
    location_id: locationId,
    ez_order_id: uuid,
    caterer_uuid: str(order?.caterer?.uuid) || null,
    order_number: str(order?.orderNumber) || null,
    order_type: orderType || null,
    ez_lifecycle: lifecycle || null,
    accepted_count: acceptedCount,
    modification_seen_at: isModification ? (opts.eventAt || null) : null,
    event_at: opts.eventAt || null,
    // The instant the food is needed, in UTC, for the phase 3 pre fire re-query.
    // Only trustworthy when the timestamp carried its own offset or zone.
    fire_at: str(ev?.timestamp) || null,
    sales_tax: salesTax,
    sales_tax_remitted: salesTaxRemittance,
    taxable_state: taxableState,
  };

  return { row, link };
}

/**
 * The subset of the row that is safe to write to order_queue on every venue.
 * Same guarantee as hubrise-ingest's queuePayload: only columns that exist in
 * the ops baseline, so an insert can never fail on a missing column.
 */
export function queuePayload(row: any, isNew: boolean, nowIso: string): any {
  const p: any = {
    ref: row.ref,
    location_id: row.location_id,
    type: row.type,
    customer: row.customer,
    items: row.items,
    total: row.total,
    status: row.status,
    source: 'ezcater',
    is_asap: row.is_asap,
    collection_time: row.collection_time,
    paid: true,
    event_date: row.event_date,
  };
  if (isNew) {
    p.created_at = row.created_at || nowIso;
    // sent_at is what QueueSync's scheduled order test reads. An ezCater order
    // sits for days, so it is stamped with the EVENT instant rather than now,
    // otherwise it lands in the live queue the moment it arrives.
    //
    // NOTE for phase 2: QueueSync's _isFutureCatering currently tests
    // source === 'catering' only, so this stamp alone does NOT keep an ezCater
    // order out of the live queue. That predicate has to be widened front end
    // side, which is deliberately not touched here.
    p.sent_at = row.fire_at || nowIso;
  }
  return p;
}
