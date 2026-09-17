// supabase/functions/_shared/ezcater.ts
//
// ezCater GraphQL client + webhook signature verification + money helpers,
// shared by all ezcater-* edge functions. Mirrors _shared/hubrise.ts.
//
// Plan: EZCATER_INTEGRATION_PLAN.md. Docs: https://api.ezcater.io
//
// Three things about this API that shape everything below.
//
//  1. ONE endpoint, https://api.ezcater.com/graphql. A static token, no OAuth,
//     no refresh. The token is issued once in the Partner Portal and ezCater
//     CANNOT recover it if it is lost.
//  2. Every operation must be NAMED. An anonymous `query { ... }` is rejected,
//     so every string in this file starts `query Name` or `mutation Name`.
//  3. Orders arrive as a POINTER. The webhook body carries "payload": null, so
//     the caller has to come back here with getOrder() to see anything at all.
//
// SCHEMA CONFIDENCE. Every field, argument and input object in this file is now
// copied from ezCater's own published schema reference and sample queries:
//
//   Order Schema Reference        https://api.ezcater.io/order-schema-reference
//   Viewing Order Details         https://api.ezcater.io/order-details
//   Caterer Schema Reference      https://api.ezcater.io/caterer-schema-reference
//   Viewing Caterers              https://api.ezcater.io/viewing-caterers
//   Subscription Schema Reference https://api.ezcater.io/subscription-schema-reference
//   Accepting Orders              https://api.ezcater.io/accepting-orders
//   Rejecting Orders              https://api.ezcater.io/rejecting-orders
//   Creating Subscribers          https://api.ezcater.io/creating-subscribers
//   Creating Subscriptions        https://api.ezcater.io/creating-subscriptions
//   Deleting Subscriptions        https://api.ezcater.io/deleting-subscriptions
//   Using GraphQL                 https://api.ezcater.io/building-a-request
//
// The previous version of this file guessed at field names, and the guesses were
// wrong. GraphQL fails the WHOLE query on ONE unknown field, so a guess does not
// degrade, it returns nothing at all. If a field ever has to be added back on a
// hunch, put it behind its own small query, never inside the order query.
//
// The Using GraphQL page documents __schema and __type introspection against the
// live token, which is the way to settle any future question in one call:
//   query fullschema { __schema { types { name kind fields { name } } } }
//   query { __type(name: "Order") { name fields { name } } }

export const EZCATER_API = 'https://api.ezcater.com/graphql';

// Sent on every request. ezCater asks integrators to identify themselves with
// the Apollo client headers so they can attribute traffic and contact us about
// a bad deploy. Keep the name stable, bump the version when the query shapes change.
export const EZCATER_CLIENT_NAME = 'servos-pos';
// 2.0.0: every selection set rebuilt from the published schema reference. The
// 1.x shapes asked for fields ezCater does not have and fetched nothing.
export const EZCATER_CLIENT_VERSION = '2.0.0';

export class EzcaterError extends Error {
  status: number;
  code: string | null;
  errors: unknown;
  body: unknown;
  constructor(status: number, code: string | null, errors: unknown, body?: unknown) {
    super(`ezCater ${status}${code ? ` ${code}` : ''}: ${typeof errors === 'string' ? errors : JSON.stringify(errors)}`);
    this.name = 'EzcaterError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.body = body;
  }
}

/** Errors we are told to handle by name. Anything else is treated as transient. */
export const EZ_PERMANENT_CODES = new Set([
  'feature_not_enabled',      // accept / reject is gated per brand and cannot be unlocked by us
  'invalid_state_transition', // e.g. accepting a modification without acceptModification: true
  'not_found',
  'forbidden',
  'unauthorized',
  // We asked for something their schema does not have. Retrying the same query
  // forever cannot fix that, only a code change can. See isSchemaError.
  'GRAPHQL_VALIDATION_FAILED',
]);

/** True when retrying will never help, so the caller should surface it to the operator. */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof EzcaterError)) return false;
  if (e.code && EZ_PERMANENT_CODES.has(e.code)) return true;
  if (isSchemaError(e)) return true;
  return e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404;
}

/**
 * THE UNKNOWN FIELD ALARM.
 *
 * GraphQL rejects the whole document when one field, argument or type name is
 * wrong, and answers 200 with an errors array rather than a 4xx. That failure
 * looks exactly like "no orders today" unless something names it, which is how
 * a whole integration can be dead and quiet at the same time.
 *
 * Every caller that can reach a kitchen ticket checks this and logs the full
 * error text, so the first bad live call says WHICH field we invented.
 */
export function isSchemaError(e: unknown): boolean {
  if (!(e instanceof EzcaterError)) return false;
  if (e.code === 'GRAPHQL_VALIDATION_FAILED') return true;
  const text = typeof e.errors === 'string' ? e.errors : JSON.stringify(e.errors ?? '');
  return /cannot query field|unknown argument|unknown type|doesn'?t exist|is not defined|did you mean|field .* is required|expected type/i.test(text);
}

// Pull a machine readable code out of the GraphQL errors array. ezCater puts it
// in extensions.code on the documented failures (feature_not_enabled and friends).
function firstCode(errors: any): string | null {
  if (!Array.isArray(errors)) return null;
  for (const e of errors) {
    const c = e?.extensions?.code ?? e?.code ?? null;
    if (c) return String(c);
  }
  return null;
}

/**
 * EVERY error message, not just the first. A validation failure lists one entry
 * per bad field, and reporting only the first turns a five field mistake into
 * five deploys. The path is included because "Cannot query field 'deliveryFee'"
 * is only useful once you know which selection set it was in.
 */
export function allMessages(errors: any): string {
  if (typeof errors === 'string') return errors;
  if (!Array.isArray(errors) || !errors.length) return 'unknown error';
  return errors.map((e: any) => {
    const msg = String(e?.message ?? JSON.stringify(e));
    const path = Array.isArray(e?.path) ? ` at ${e.path.join('.')}` : '';
    return `${msg}${path}`;
  }).join(' | ');
}

/**
 * One named GraphQL operation against ezCater. Throws EzcaterError on a non 2xx
 * OR on a 200 that carries a GraphQL errors array, because GraphQL reports
 * application failures inside a 200 and swallowing that would look like success.
 *
 * The Authorization header is the RAW token with no Bearer prefix. That is what
 * every example in the ezCater docs shows and there is no counter example, but
 * it is unusual enough to be worth confirming with integrations@ezcater.com
 * before go live. If it turns out to need "Bearer ", this is the only line to change.
 */
export async function ez<T = any>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(EZCATER_API, {
    method: 'POST',
    headers: {
      'Authorization': token, // RAW token, no Bearer prefix. CONFIRM with ezCater.
      'apollographql-client-name': EZCATER_CLIENT_NAME,
      'apollographql-client-version': EZCATER_CLIENT_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ operationName, query, variables }),
  });

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    throw new EzcaterError(res.status, firstCode(body?.errors), allMessages(body?.errors ?? text), body);
  }
  if (body?.errors?.length) {
    throw new EzcaterError(200, firstCode(body.errors), allMessages(body.errors), body);
  }
  return body?.data as T;
}

// ────────────────────────────────────────────────────────────────────────────
// Selection sets
// ────────────────────────────────────────────────────────────────────────────

// Money is an object, not a scalar. subunits is an int32 and subunitsV2 is the
// same value as a string, which is the one to read (see subunitsToNumber).
const MONEY = '{ subunits subunitsV2 currency }';

// An address, everywhere one appears. Address has NO latitude and NO longitude:
// asking for them was killing the whole order query.
const ADDRESS = `{ name street street2 street3 city state stateName zip deliveryInstructions }`;

/**
 * The order selection set, field for field from ezCater's "Viewing Order
 * Details" sample query. Nothing here is inferred.
 *
 * WHERE THE MONEY ACTUALLY LIVES, because it is split across three places and
 * getting it wrong silently zeroes a venue's tax figures:
 *
 *   Order.totals (OrderTotals)  subTotal (capital T), salesTax,
 *                               salesTaxRemittance, tip, customerTotalDue,
 *                               pointOfSaleIntegrationFee. All Money objects.
 *   catererCart.totals          catererTotalDue ONLY, and it is a FLOAT IN
 *                               DOLLARS, not a Money object.
 *   catererCart.feesAndDiscounts  the delivery fee and every promo, as
 *                               [{ name, cost }]. There is no deliveryFee field.
 *
 * The delivery fee is asked for twice on purpose. `deliveryFees` is the same
 * resolver filtered to DELIVERY_FEE, so the fee can be read without guessing
 * from a display name, and the unfiltered list keeps every fee and discount
 * verbatim for the weekly statement.
 *
 * taxableAddress is on Order, NOT on totals.
 */
export const ORDER_QUERY = `
query ServOsEzOrder($id: ID!, $types: [FeeOrDiscountType!]) {
  order(id: $id) {
    uuid
    orderNumber
    orderSourceType
    deliveryId
    isTaxExempt
    lifecycle { orderIsCurrently }
    caterer { uuid name storeNumber live }
    event {
      orderType
      timestamp
      catererHandoffFoodTime
      timeZoneIdentifier
      timeZoneOffset
      headcount
      customerProvidedName
      thirdPartyDeliveryPartner
      address ${ADDRESS}
      contact { name phone }
    }
    orderCustomer { firstName lastName fullName }
    taxableAddress ${ADDRESS}
    totals {
      customerTotalDue ${MONEY}
      subTotal ${MONEY}
      salesTax ${MONEY}
      salesTaxRemittance ${MONEY}
      tip ${MONEY}
      pointOfSaleIntegrationFee ${MONEY}
    }
    catererCart {
      totals { catererTotalDue }
      deliveryFees: feesAndDiscounts(types: [DELIVERY_FEE]) { name cost ${MONEY} }
      feesAndDiscounts(types: $types) { name cost ${MONEY} }
      tableware {
        specialInstructions
        tablewareChoices { choiceUuid isIncluded itemCount name }
      }
      orderItems {
        uuid
        name
        quantity
        menuItemSizeId
        menuItemSizeName
        posItemId
        labelFor
        noteToCaterer
        specialInstructions
        totalInSubunits ${MONEY}
        customizations {
          customizationId
          customizationTypeId
          customizationTypeName
          name
          posCustomizationId
          quantity
        }
      }
    }
  }
}`;

/** Every fee and discount type ezCater defines. Sent on every order fetch. */
export const EZ_FEE_TYPES = ['ADJUSTMENT', 'DELIVERY_FEE', 'DISCOUNT', 'MISC_FEE'];

// acceptOrder(orderId: ID!, acceptModification: Boolean = false).
// Accepting a MODIFICATION without acceptModification: true returns
// invalid_state_transition, which is why the flag is always sent explicitly.
// AcceptOrderPayload has ONE field, order. There is no errors field on it.
export const ACCEPT_ORDER_MUTATION = `
mutation ServOsEzAcceptOrder($orderId: ID!, $acceptModification: Boolean) {
  acceptOrder(orderId: $orderId, acceptModification: $acceptModification) {
    order { uuid lifecycle { orderIsCurrently } }
  }
}`;

// rejectOrder takes ONE input object, rejectOrderInput: RejectOrderInput!,
// holding reason (a RejectionReasonEnum, e.g. AT_DAILY_CAPACITY) and a free text
// explanation. It is NOT two loose arguments, and RejectOrderPayload has no
// errors field either.
export const REJECT_ORDER_MUTATION = `
mutation ServOsEzRejectOrder($orderId: ID!, $rejectOrderInput: RejectOrderInput!) {
  rejectOrder(orderId: $orderId, rejectOrderInput: $rejectOrderInput) {
    order { uuid lifecycle { orderIsCurrently } }
  }
}`;

// Caterer has uuid, name, storeNumber, live and address. There is no brandName.
export const CATERERS_QUERY = `
query ServOsEzCaterers {
  caterers {
    uuid
    name
    storeNumber
    live
    address ${ADDRESS}
  }
}`;

// ezCater allows ONE subscriber per API user, covering many caterers, which is
// why the webhook URL cannot carry a location the way HubRise's ?loc= does.
//
// webhookSecret is returned ONLY by createSubscriber, never again, so a failure
// to store it here means tearing the subscriber down and starting over.
export const CREATE_SUBSCRIBER_MUTATION = `
mutation ServOsEzCreateSubscriber($subscriberParams: CreateSubscriberFields!) {
  createSubscriber(subscriberParams: $subscriberParams) {
    subscriber { id name webhookUrl webhookSecret }
  }
}`;

// Listing exists so we can tell "already has a subscriber" from "token is bad".
// Subscriber (unlike NewSubscriber) does NOT expose webhookSecret.
export const SUBSCRIBERS_QUERY = `
query ServOsEzSubscribers {
  subscribers {
    id
    name
    webhookUrl
    subscriptions { eventEntity eventKey parentEntity parentId subscriberId }
  }
}`;

// A subscription is PER CATERER PER EVENT. parentId is the caterer uuid, and
// without it ezCater has no idea which location's orders to send.
export const CREATE_SUBSCRIPTION_MUTATION = `
mutation ServOsEzCreateSubscription($subscriptionParams: CreateSubscriptionFields!) {
  createSubscription(subscriptionParams: $subscriptionParams) {
    subscription { eventEntity eventKey parentEntity parentId subscriberId }
  }
}`;

// Deletion is scoped to the CATERER, not to the subscriber, and returns success.
// parentEntity is an enum literal, so it is written inline exactly as the docs
// show it; only the caterer id travels as a variable.
export const DELETE_SUBSCRIPTIONS_MUTATION = `
mutation ServOsEzDeleteSubscriptions($parentId: UUID!) {
  deleteSubscriptions(subscriptionsParams: { parentEntity: Caterer, parentId: $parentId }) {
    success
  }
}`;

// The lifecycle events worth subscribing to.
//
// 'uncancelled' is subscribable but NEVER ACTUALLY FIRES, per ezCater's own
// docs. It is listed here so nobody adds it back thinking it was an oversight,
// and it is commented out rather than sent so we do not pay for a dead subscription.
//
// Meal Program (Club Soda) orders never send submitted or accepted at all, only
// relish_finalized, roughly 90 minutes before the event. Dropping that event
// means silently losing every Meal Program order.
export const EZ_EVENTS = [
  'accepted',           // also arrives a SECOND time for a modification, there is no modified event
  'submitted',
  'cancelled',
  'relish_finalized',   // Meal Program orders arrive ONLY through this
  // 'uncancelled',     // subscribable, never fires. Do not enable.
];

// ────────────────────────────────────────────────────────────────────────────
// Typed wrappers
// ────────────────────────────────────────────────────────────────────────────

/** Fetch one order. The webhook gives us a pointer, this is the second leg. */
export async function getOrder(token: string, orderId: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzOrder', ORDER_QUERY, { id: orderId, types: EZ_FEE_TYPES });
  return data?.order ?? null;
}

/**
 * Accept an order. acceptModification MUST be true when the order has already
 * been accepted once and this is the second accepted event, otherwise ezCater
 * answers invalid_state_transition.
 *
 * UX cliff worth repeating where an operator can see it: if we accept through
 * the API and the customer then edits, the modification CANNOT be accepted
 * through the API at all. The operator is pushed back into the Partner Portal.
 */
export async function acceptOrder(token: string, orderId: string, acceptModification = false): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzAcceptOrder', ACCEPT_ORDER_MUTATION, { orderId, acceptModification });
  return data?.acceptOrder ?? null;
}

/** Reject an order with one of ezCater's RejectionReasonEnum values plus free text. */
export async function rejectOrder(token: string, orderId: string, reason: string, explanation?: string | null): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzRejectOrder', REJECT_ORDER_MUTATION, {
    orderId,
    rejectOrderInput: { reason, explanation: explanation || null },
  });
  return data?.rejectOrder ?? null;
}

/** Every caterer this API user can see. Drives the Back Office mapping screen. */
export async function caterers(token: string): Promise<any[]> {
  const data = await ez<any>(token, 'ServOsEzCaterers', CATERERS_QUERY, {});
  return Array.isArray(data?.caterers) ? data.caterers : [];
}

/**
 * Create the single subscriber for this API user. Returns { id, webhookSecret }.
 * name follows ezCater's documented convention, <provider>-<brand>.
 */
export async function createSubscriber(token: string, url: string, name: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzCreateSubscriber', CREATE_SUBSCRIBER_MUTATION, {
    subscriberParams: { name, webhookUrl: url },
  });
  return data?.createSubscriber?.subscriber ?? null;
}

/** The subscriber this API user already has, if any. Only one is ever allowed. */
export async function subscribers(token: string): Promise<any[]> {
  const data = await ez<any>(token, 'ServOsEzSubscribers', SUBSCRIBERS_QUERY, {});
  return Array.isArray(data?.subscribers) ? data.subscribers : [];
}

/**
 * Subscribe to one event for ONE caterer. There is no account wide subscription:
 * parentId is the caterer uuid, so a venue with no subscription rows of its own
 * receives nothing, however healthy the subscriber looks.
 */
export async function createSubscription(
  token: string, subscriberId: string, catererUuid: string, eventKey: string,
): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzCreateSubscription', CREATE_SUBSCRIPTION_MUTATION, {
    subscriptionParams: {
      eventEntity: 'Order',
      eventKey,
      parentEntity: 'Caterer',
      parentId: catererUuid,
      subscriberId,
    },
  });
  return data?.createSubscription?.subscription ?? null;
}

/** Remove every subscription for ONE caterer. Scoped by caterer, not by subscriber. */
export async function deleteSubscriptions(token: string, catererUuid: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzDeleteSubscriptions', DELETE_SUBSCRIPTIONS_MUTATION, {
    parentId: catererUuid,
  });
  return data?.deleteSubscriptions ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Webhook signature
// ────────────────────────────────────────────────────────────────────────────

async function hmacRaw(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return new Uint8Array(sig);
}
const toHex = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Constant time string compare. Same helper as ceq in _shared/hubrise.ts. */
function ceq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the X-Ezcater-Signature header.
 *
 * The header value is `<timestamp>.<hex>` and the signed payload is
 * `${timestamp}.${rawBody}`, HMAC SHA256 keyed with the subscriber's signing
 * secret. That is HubRise's verifyHmac plus a timestamp prefix.
 *
 * Compute over the EXACT raw bytes. Never re-serialize the JSON first, a single
 * key reorder or whitespace change makes every signature fail.
 *
 * maxSkewSeconds guards replay. Pass 0 to disable the age check, which is what
 * the replay path in the reconciler wants when re-reading a stored notification.
 */
export async function verifyEzcaterSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  maxSkewSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  const dot = header.indexOf('.');
  if (dot <= 0) return false;
  const timestamp = header.slice(0, dot).trim();
  const provided = header.slice(dot + 1).trim().toLowerCase();
  if (!timestamp || !provided) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  if (maxSkewSeconds > 0) {
    // ezCater sends seconds. Tolerate milliseconds in case that ever changes.
    const raw = Number(timestamp);
    const secs = raw > 1e12 ? Math.floor(raw / 1000) : raw;
    const age = Math.abs(Math.floor(Date.now() / 1000) - secs);
    if (!Number.isFinite(age) || age > maxSkewSeconds) return false;
  }

  const digest = await hmacRaw(secret, `${timestamp}.${rawBody}`);
  return ceq(provided, toHex(digest));
}

// ────────────────────────────────────────────────────────────────────────────
// Money
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read an ezCater money object down to a plain number of SUBUNITS (cents).
 *
 * ezCater sends the same value twice: `subunits` as an int32 and `subunitsV2`
 * as a string. Read subunitsV2. The int32 is there for older clients and a
 * large catering order can genuinely approach the int32 ceiling, which is the
 * whole reason the string variant exists.
 *
 * Parsed safely: a string of digits only, no parseInt on arbitrary text, and
 * anything that does not parse returns 0 rather than NaN. NaN propagating into
 * an order total is worse than a visible zero.
 */
export function subunitsToNumber(money: unknown): number {
  if (money == null) return 0;
  if (typeof money === 'number') return Number.isFinite(money) ? Math.round(money) : 0;

  const m = money as Record<string, unknown>;
  const v2 = typeof money === 'string' ? money : m.subunitsV2;
  if (typeof v2 === 'string') {
    const s = v2.trim();
    if (/^-?\d+$/.test(s)) {
      const n = Number(s);
      if (Number.isSafeInteger(n)) return n;
    }
  }
  if (typeof v2 === 'number' && Number.isFinite(v2)) return Math.round(v2);

  // Fall back to the int32 only when subunitsV2 is absent or unparseable.
  const v1 = m.subunits;
  if (typeof v1 === 'number' && Number.isFinite(v1)) return Math.round(v1);
  if (typeof v1 === 'string' && /^-?\d+$/.test(v1.trim())) {
    const n = Number(v1.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return 0;
}

/**
 * Subunits to major units, e.g. 1250 cents to 12.5.
 *
 * ezCater is USD only today, so the exponent is fixed at 2. If they ever open
 * up a currency with a different exponent this is the one place to widen, using
 * the currency field that every money object already carries.
 */
export function moneyToAmount(money: unknown): number {
  return +(subunitsToNumber(money) / 100).toFixed(2);
}

/** The currency stamped on a money object, defaulting to USD. */
export function moneyCurrency(money: unknown, fallback = 'USD'): string {
  const c = (money as any)?.currency;
  return typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : fallback;
}

/**
 * catererTotalDue is the one money field ezCater sends as a FLOAT IN DOLLARS
 * rather than a subunits object. Parsed separately so nobody accidentally runs
 * it through subunitsToNumber and gets a bill 100 times too small.
 */
export function dollarsToNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? +v.toFixed(2) : 0;
  if (typeof v === 'string') {
    const s = v.trim().replace(/[$,]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(s)) return +Number(s).toFixed(2);
  }
  return 0;
}
