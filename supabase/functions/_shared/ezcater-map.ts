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
 * Pull the lifecycle value off an order, tolerating the three shapes the field
 * could plausibly take, because the docs show it in prose rather than SDL.
 */
export function ezLifecycle(order: any): string {
  const raw = order?.lifecycle?.value ?? order?.lifecycleValue ?? order?.lifecycle ?? order?.status ?? '';
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Time
// ────────────────────────────────────────────────────────────────────────────

/**
 * Split an ezCater event timestamp into the venue local calendar date and clock
 * time the kitchen actually needs to see.
 *
 * Three cases, in order of trust:
 *   1. the ISO string carries an explicit non Z offset, so the wall clock part
 *      IS already local. Read it verbatim, same trick as HubRise's hrTimeLabel.
 *   2. no offset but an IANA identifier is supplied, so format in that zone.
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

  if (!hasOffset && tz) {
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
 * Resolve a line's money. ezCater's documented field is totalInSubunits, which
 * is the LINE total for the whole quantity, so the per unit price is derived.
 * An explicit unit price field is preferred if one turns out to exist, because
 * dividing a line total by the quantity loses a penny on 3 for 10.00.
 */
function lineMoney(node: any, qty: number): { unit: number; total: number; subunits: number } {
  const unitNode = node?.priceInSubunits ?? node?.unitPriceInSubunits ?? null;
  if (unitNode != null) {
    const unitSub = subunitsToNumber(unitNode);
    return { unit: +(unitSub / 100).toFixed(2), total: +((unitSub * qty) / 100).toFixed(2), subunits: unitSub * qty };
  }
  const totalSub = subunitsToNumber(node?.totalInSubunits ?? node?.total ?? node?.price ?? null);
  return { unit: +(totalSub / qty / 100).toFixed(2), total: +(totalSub / 100).toFixed(2), subunits: totalSub };
}

/**
 * catererCart.orderItems[] to the ServOS line item shape, same keys the POS,
 * KDS and print routing already read on a HubRise order.
 *
 * posItemId is ezCater's field for OUR menu item id, set when the menu was
 * created through the Menus API or typed into the Partner Portal. It lands on
 * itemId, which is what KDS station routing and 86 both key on. It is very
 * often null, because a Partner Portal menu built by hand has nothing to link
 * to, so nothing downstream may assume it is present.
 */
export function orderItemsToLines(orderItems: any): any[] {
  return (Array.isArray(orderItems) ? orderItems : []).map((oi: any) => {
    const qty = asQty(oi?.quantity);
    const money = lineMoney(oi, qty);
    return {
      itemId: oi?.posItemId ? String(oi.posItemId) : null,
      ezItemId: oi?.uuid ? String(oi.uuid) : null,
      name: String(oi?.name || 'Item'),
      qty,
      price: money.unit,
      lineTotal: money.total,
      mods: (Array.isArray(oi?.customizations) ? oi.customizations : []).map((c: any) => {
        const cQty = asQty(c?.quantity);
        const cMoney = lineMoney(c, cQty);
        return {
          label: String(c?.name || 'Option'),
          groupLabel: c?.customizationTypeName ? String(c.customizationTypeName) : null,
          itemId: c?.posItemId ? String(c.posItemId) : null,
          ezItemId: c?.uuid ? String(c.uuid) : null,
          qty: cQty,
          price: cMoney.unit,
        };
      }),
      notes: String(oi?.specialInstructions || ''),
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Order to order_queue row
// ────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

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
  const totals = cart?.totals || {};

  const orderType = str(ev?.orderType).toUpperCase();
  const type = EZ_ORDER_TYPE_TO_QUEUE[orderType] || 'collection';
  const thirdParty = orderType === 'THIRD_PARTY_DELIVERY';

  const lifecycle = ezLifecycle(order);
  const terminal = EZ_TERMINAL.has(lifecycle);
  const status = ezStatusToQueueStatus(lifecycle);

  const items = orderItemsToLines(cart?.orderItems);

  // ── Money. Every component is kept, nothing is inferred. ──────────────────
  const subtotal = moneyToAmount(totals?.subtotal);
  const salesTax = moneyToAmount(totals?.salesTax);
  const salesTaxRemittance = moneyToAmount(totals?.salesTaxRemittance);
  const tip = moneyToAmount(totals?.tip);
  const deliveryFee = moneyToAmount(totals?.deliveryFee ?? totals?.catererDeliveryFee);
  const posIntegrationFee = moneyToAmount(totals?.pointOfSaleIntegrationFee);
  // catererTotalDue is a float in DOLLARS, not a subunits object. See dollarsToNumber.
  const catererTotalDue = dollarsToNumber(totals?.catererTotalDue);
  const currency = moneyCurrency(totals?.subtotal ?? totals?.salesTax, 'USD');

  // order_queue.total on a PREPAID channel order is the number the venue banks,
  // and catererTotalDue is ezCater's own statement of exactly that, net of
  // commission. Fall back to subtotal plus tax only when it is missing, so a
  // ticket never shows 0.00 for a real order. Every component stays in
  // customer.totals so phase 4 reporting can rebuild whichever view it needs.
  const total = catererTotalDue > 0 ? catererTotalDue : +(subtotal + salesTax).toFixed(2);

  // ── Tax, verbatim. See the banner at the top of this file. ────────────────
  const taxableAddress = totals?.taxableAddress || null;
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
    currency,
  };

  // ── Timing ────────────────────────────────────────────────────────────────
  const when = eventTimeParts(ev?.timestamp, ev?.timeZoneIdentifier);

  // ── Contact and address ───────────────────────────────────────────────────
  const contact = ev?.contact || {};
  const addr = ev?.address || {};
  const lat = addr?.latitude ?? null;
  const lng = addr?.longitude ?? null;
  const name = str(contact?.name) || str(order?.orderCustomer?.name) || 'ezCater customer';

  const customer: any = {
    name,
    phone: str(contact?.phone) || str(order?.orderCustomer?.phone) || '',
    phoneExtension: str(contact?.phoneExtension) || null,
    email: str(contact?.email) || str(order?.orderCustomer?.email) || '',
    address: type === 'delivery'
      ? {
          line1: str(addr?.street),
          line2: str(addr?.street2),
          city: str(addr?.city),
          state: str(addr?.state),
          postcode: str(addr?.zip),
          country: 'US',
          name: str(addr?.name),
          instructions: str(addr?.deliveryInstructions),
          ...(lat != null && lng != null ? { gps: { lat: Number(lat), lng: Number(lng) } } : {}),
        }
      : null,
    notes: str(ev?.orderNotes),

    // Catering specifics the kitchen needs on the ticket.
    headcount: Number.isFinite(Number(ev?.headcount)) ? Number(ev.headcount) : null,
    event_date: when ? when.date : null,
    event_time: when ? when.time : null,
    eventTimeZone: str(ev?.timeZoneIdentifier) || null,
    // false means we could not resolve the venue local wall clock and are
    // showing the raw timestamp. Worth surfacing rather than quietly trusting.
    eventTimeIsLocal: when ? when.local : null,

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
      catererTotalDue, currency,
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
    created_at: str(order?.createdAt) || null,
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
