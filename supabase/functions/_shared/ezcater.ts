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
// SCHEMA CONFIDENCE. The plan is doc verified on the endpoint, the headers, the
// signature scheme, the money shape and the field names quoted in the selection
// sets below. It is NOT verified on argument shapes for the mutations, because
// the public docs show prose signatures rather than SDL. Anything marked
// UNVERIFIED needs one introspection call against a real token to confirm, and
// is deliberately kept as a single editable constant so confirming it is a one
// line change rather than a rewrite. See the final report for the list.

export const EZCATER_API = 'https://api.ezcater.com/graphql';

// Sent on every request. ezCater asks integrators to identify themselves with
// the Apollo client headers so they can attribute traffic and contact us about
// a bad deploy. Keep the name stable, bump the version when the query shapes change.
export const EZCATER_CLIENT_NAME = 'servos-pos';
export const EZCATER_CLIENT_VERSION = '1.0.0';

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
]);

/** True when retrying will never help, so the caller should surface it to the operator. */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof EzcaterError)) return false;
  if (e.code && EZ_PERMANENT_CODES.has(e.code)) return true;
  return e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404;
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
function firstMessage(errors: any): string {
  if (!Array.isArray(errors) || !errors.length) return 'unknown error';
  return String(errors[0]?.message ?? errors[0]);
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
    throw new EzcaterError(res.status, firstCode(body?.errors), body?.errors ?? text, body);
  }
  if (body?.errors?.length) {
    throw new EzcaterError(200, firstCode(body.errors), firstMessage(body.errors), body);
  }
  return body?.data as T;
}

// ────────────────────────────────────────────────────────────────────────────
// Selection sets
// ────────────────────────────────────────────────────────────────────────────

// Money is an object, not a scalar. subunits is an int32 and subunitsV2 is the
// same value as a string, which is the one to read (see subunitsToNumber).
const MONEY = '{ subunits subunitsV2 currency }';

// The order selection set. Field names quoted in EZCATER_INTEGRATION_PLAN.md are
// doc verified: uuid, event.orderType, catererCart.orderItems, customizations,
// posItemId, specialInstructions, totals.salesTax, totals.salesTaxRemittance,
// totals.catererTotalDue, totals.pointOfSaleIntegrationFee, taxableAddress.
//
// UNVERIFIED and flagged inline: orderNumber, event.timestamp, event.headcount,
// event.address, event.contact, orderCustomer, lifecycle. GraphQL fails the
// WHOLE query on one unknown field, so if the first live call 400s, prune from
// here downward rather than hunting through the mapper.
export const ORDER_QUERY = `
query ServOsEzOrder($id: ID!) {
  order(id: $id) {
    uuid
    orderNumber                       # UNVERIFIED
    orderSourceType                   # UNVERIFIED, distinguishes MARKETPLACE / EZORDERING / DIRECT_ENTRY
    isModified                        # UNVERIFIED, the only non inferential modification signal if it exists
    lifecycle { value }               # UNVERIFIED shape, may be a plain enum field
    event {
      orderType
      timestamp                       # UNVERIFIED, the instant the food is needed
      timeZoneIdentifier              # UNVERIFIED, IANA tz for the delivery / pickup address
      headcount                       # UNVERIFIED
      thirdPartyDeliveryPartner       # UNVERIFIED
      address {                       # UNVERIFIED
        name street street2 city state zip
        latitude longitude
        deliveryInstructions
      }
      contact { name phone phoneExtension }   # UNVERIFIED
      orderNotes                      # UNVERIFIED
    }
    caterer { uuid name }             # UNVERIFIED
    catererCart {
      totals {
        catererTotalDue               # a float in DOLLARS, not subunits. ezCater is inconsistent here.
        subtotal ${MONEY}
        salesTax ${MONEY}
        salesTaxRemittance ${MONEY}
        tip ${MONEY}
        deliveryFee ${MONEY}
        pointOfSaleIntegrationFee ${MONEY}
        taxableAddress { street city state zip }
      }
      orderItems {
        uuid
        name
        quantity
        posItemId
        specialInstructions
        totalInSubunits ${MONEY}
        customizations {
          uuid
          name
          quantity
          posItemId
          customizationTypeName       # UNVERIFIED, the modifier group label
          totalInSubunits ${MONEY}
        }
      }
    }
  }
}`;

// UNVERIFIED argument shape. The docs describe it in prose as
// acceptOrder(orderId, acceptModification: Boolean = false).
// Accepting a MODIFICATION without acceptModification: true returns
// invalid_state_transition, which is why the flag is always sent explicitly.
export const ACCEPT_ORDER_MUTATION = `
mutation ServOsEzAcceptOrder($orderId: ID!, $acceptModification: Boolean!) {
  acceptOrder(orderId: $orderId, acceptModification: $acceptModification) {
    order { uuid lifecycle { value } }
    errors { message }
  }
}`;

// UNVERIFIED argument shape. Docs: rejectOrder(orderId, {reason, explanation}).
// 23 reason values exist, including AT_DAILY_CAPACITY, STAFF_SHORTAGE and
// LACK_OF_INVENTORY. The reason is an enum so it is interpolated as a variable
// of an unverified enum type name.
export const REJECT_ORDER_MUTATION = `
mutation ServOsEzRejectOrder($orderId: ID!, $reason: String!, $explanation: String) {
  rejectOrder(orderId: $orderId, reason: $reason, explanation: $explanation) {
    order { uuid lifecycle { value } }
    errors { message }
  }
}`;

// UNVERIFIED selection set. Used by ezcater-connect to list what this API user
// can see, so the operator can map each caterer to a ServOS location.
export const CATERERS_QUERY = `
query ServOsEzCaterers {
  caterers {
    uuid
    name
    brandName                         # UNVERIFIED
    address { street city state zip } # UNVERIFIED
  }
}`;

// UNVERIFIED argument shapes for the subscription trio. ezCater allows ONE
// subscriber per API user, covering many caterers, which is why the webhook URL
// cannot carry a location the way HubRise's ?loc= does.
export const CREATE_SUBSCRIBER_MUTATION = `
mutation ServOsEzCreateSubscriber($url: String!) {
  createSubscriber(url: $url) {
    subscriber { uuid url signingSecret }
    errors { message }
  }
}`;

export const CREATE_SUBSCRIPTION_MUTATION = `
mutation ServOsEzCreateSubscription($subscriberId: ID!, $event: String!) {
  createSubscription(subscriberId: $subscriberId, event: $event) {
    subscription { uuid event }
    errors { message }
  }
}`;

export const DELETE_SUBSCRIPTIONS_MUTATION = `
mutation ServOsEzDeleteSubscriptions($subscriberId: ID!) {
  deleteSubscriptions(subscriberId: $subscriberId) {
    deletedCount
    errors { message }
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
  const data = await ez<any>(token, 'ServOsEzOrder', ORDER_QUERY, { id: orderId });
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

/** Reject an order with one of ezCater's 23 reason enums plus free text. */
export async function rejectOrder(token: string, orderId: string, reason: string, explanation?: string | null): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzRejectOrder', REJECT_ORDER_MUTATION, {
    orderId, reason, explanation: explanation || null,
  });
  return data?.rejectOrder ?? null;
}

/** Every caterer this API user can see. Drives the Back Office mapping screen. */
export async function caterers(token: string): Promise<any[]> {
  const data = await ez<any>(token, 'ServOsEzCaterers', CATERERS_QUERY, {});
  return Array.isArray(data?.caterers) ? data.caterers : [];
}

/** Create the single subscriber for this API user. Returns {uuid, signingSecret}. */
export async function createSubscriber(token: string, url: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzCreateSubscriber', CREATE_SUBSCRIBER_MUTATION, { url });
  return data?.createSubscriber?.subscriber ?? null;
}

/** Subscribe that subscriber to one lifecycle event. */
export async function createSubscription(token: string, subscriberId: string, event: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzCreateSubscription', CREATE_SUBSCRIPTION_MUTATION, { subscriberId, event });
  return data?.createSubscription?.subscription ?? null;
}

/** Remove every subscription for a subscriber. Used on disconnect. */
export async function deleteSubscriptions(token: string, subscriberId: string): Promise<any> {
  const data = await ez<any>(token, 'ServOsEzDeleteSubscriptions', DELETE_SUBSCRIPTIONS_MUTATION, { subscriberId });
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
