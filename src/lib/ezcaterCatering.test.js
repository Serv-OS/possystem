/**
 * ezcaterCatering.test.js - ezCater orders filed as ServOS catering orders (18 Sep 2026).
 * Run: `npm test`.
 *
 * Peter: ezCater orders must "follow the same rules as the rest of our catering system where they
 * hit the POS at the right times and parameters set to fire into the kitchen as our own catering
 * orders". He chose the simpler version: the webhook writes the row our own catering checkout
 * writes, and nothing else in the catering system changes. Pinned here:
 *   1. the fire time is the checkout's own rule, moved out verbatim (cateringRules.js)
 *   2. the HKX77V shape: a held catering row, venue clock, fire time from the catering settings
 *   3. lifecycle: submitted is held, a rejected modification is not a cancel, cancelled is terminal
 *   4. cancels and changes, before and after firing
 *   5. every exclusion: messages, courier, review ask, money (take and refund)
 *   6. every catering path still reads the row with no change of its own
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  wallTimeToInstantMs, venueWallClock, cateringPrepMinutes, cateringFireMs,
} from './cateringRules.js';
import {
  isEzcaterOrder, mayMessageCustomer, mayBookOurCourier, mayTakeOrRefundMoney, isPrepaidByChannel,
  cateringChannelLabel, ezcaterOrderNumber, cateringOrderNumber, ezcaterBadge, ezcaterFlagText,
  isAwaitingEzcaterAcceptance, RELEASABLE_OR_FILTER, NOT_RELEASABLE_STATUSES_PG, cateringMayRelease,
  advanceStatusLabel, ezLifecycleState, ezcaterPrep, ezcaterCateringRow, ezcaterWritePlan,
  ezcaterPriorLink, EZ_QUEUE_WRITTEN_MARKER, ezcaterQueueWrittenBefore, ezcaterEventError,
  kitchenFingerprint, EZ_PREP_FALLBACK_MINUTES, FLAG_CHANGED_AFTER_FIRE, FLAG_CANCELLED_AFTER_FIRE,
  AWAITING_LABEL, channelCancelAlert, ezcaterHoldAlertDue, ezcaterHoldAlertText,
} from './ezcaterCatering.js';
import { orderToQueueRow } from '../../supabase/functions/_shared/ezcater-map.ts';
import { dispatchDelivery } from './delivery/dispatch.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const NOW = Date.parse('2026-09-18T12:00:00Z');   // the day Peter asked
const money = (subunits, currency = 'GBP') => ({ subunits: Number(subunits), subunitsV2: String(subunits), currency });

// ── The HKX77V shape ─────────────────────────────────────────────────────────
// Peter's live test order: ref EZ-eff5588f-1013-40f7-ae24-77febe448deb, a delivery at
// 2026-09-23T18:30Z, venue on Europe/London, catering prep 60 minutes. The caterer's own zone is
// deliberately NOT the venue's here, to prove the venue clock wins.
const HKX77V = (over = {}) => ({
  uuid: 'eff5588f-1013-40f7-ae24-77febe448deb',
  orderNumber: 'HKX77V',
  orderSourceType: 'MARKETPLACE',
  lifecycle: { orderIsCurrently: 'accepted' },
  caterer: { uuid: 'cat-1', name: 'Test Kitchen', storeNumber: '1' },
  event: {
    orderType: 'DELIVERY',
    timestamp: '2026-09-23T18:30:00Z',
    timeZoneIdentifier: 'America/New_York',
    headcount: 12,
    contact: { name: 'Peter Test', phone: '07700900123' },
    address: { street: '1 High St', city: 'London', zip: 'SW1A 1AA' },
  },
  orderCustomer: { fullName: 'Peter Test' },
  totals: { subTotal: money(12000), salesTax: money(0), salesTaxRemittance: money(0), tip: money(0) },
  catererCart: {
    totals: { catererTotalDue: 108.0 },
    orderItems: [
      { uuid: 'oi-1', name: 'Sandwich Platter', quantity: 2, totalInSubunits: money(8000), customizations: [] },
      { uuid: 'oi-2', name: 'Cookies', quantity: 1, totalInSubunits: money(4000), customizations: [] },
    ],
  },
  ...over,
});
const lifecycleOf = (o) => o.lifecycle.orderIsCurrently;
const build = (order, opts = {}) => {
  const { row } = orderToQueueRow(order, LOC, { priorAcceptedCount: opts.priorAccepted || 0 });
  return ezcaterCateringRow(row, {
    venueTz: 'Europe/London', prepMinutes: 60, prepFallback: false, nowMs: NOW,
    lifecycle: lifecycleOf(order), ...opts,
  });
};

// ── 1. The fire time is the checkout's own rule ──────────────────────────────

// The checkout's function as it was before it moved, copied here so the move is proven verbatim.
function oldWallTimeToInstantMs(dateStr, timeStr, tz) {
  if (!dateStr) return NaN;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '12:00').split(':').map(Number);
  const guess = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0);
  if (!tz) return guess;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; dtf.formatToParts(new Date(guess)).forEach(x => { if (x.type !== 'literal') p[x.type] = +x.value; });
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return guess - (seen - guess);
  } catch { return guess; }
}

test('cateringRules: wallTimeToInstantMs is the checkout function, unchanged', () => {
  const cases = [
    ['2026-09-23', '19:30', 'Europe/London'], ['2026-12-01', '12:00', 'Europe/London'],
    ['2026-03-29', '01:30', 'Europe/London'], ['2026-10-25', '01:30', 'Europe/London'],
    ['2026-07-04', '11:30', 'America/New_York'], ['2026-09-23', '', 'Europe/London'],
    ['2026-09-23', '19:30', ''], ['2026-09-23', '19:30', 'Not/AZone'], ['', '19:30', 'Europe/London'],
  ];
  for (const [d, t, z] of cases) {
    const a = wallTimeToInstantMs(d, t, z); const b = oldWallTimeToInstantMs(d, t, z);
    assert.ok(Object.is(a, b), `${d} ${t} ${z}: ${a} vs ${b}`);
  }
});

test('cateringRules: fire time = the checkout two lines, for every prep value', () => {
  const eventMs = wallTimeToInstantMs('2026-09-23', '19:30', 'Europe/London');
  for (const prep of [undefined, null, '', '30', 45, 45.5, -5, 'abc', 0, '90']) {
    const cfg = { prep_time_minutes: prep };
    const oldPrep = Math.max(0, Number(cfg?.prep_time_minutes) || 0);
    const oldFire = isNaN(eventMs) ? NaN : eventMs - oldPrep * 60000;
    assert.equal(cateringFireMs(eventMs, cateringPrepMinutes(cfg)), oldFire, `prep ${prep}`);
  }
  assert.ok(Number.isNaN(cateringFireMs(NaN, 60)));
  assert.equal(cateringPrepMinutes(null), 0);
});

test('cateringRules: venueWallClock reads the instant on the venue clock', () => {
  assert.deepEqual(venueWallClock(Date.parse('2026-09-23T18:30:00Z'), 'Europe/London'),
    { date: '2026-09-23', time: '19:30', timeZone: 'Europe/London' });
  assert.deepEqual(venueWallClock(Date.parse('2026-12-23T23:30:00Z'), 'Europe/London').date, '2026-12-23');
  assert.equal(venueWallClock(Date.parse('2026-09-23T18:30:00Z'), 'Bad/Zone').time, '19:30');   // default zone, never the machine's
  assert.equal(venueWallClock(NaN, 'Europe/London'), null);
});

test('CateringCheckout uses the shared rule and no longer carries its own copy', () => {
  const src = read('../surfaces/catering/CateringCheckout.jsx');
  assert.match(src, /import \{ wallTimeToInstantMs, cateringPrepMinutes, cateringFireMs \} from '\.\.\/\.\.\/lib\/cateringRules'/);
  assert.match(src, /const fireMs = cateringFireMs\(eventMs, cateringPrepMinutes\(cfg\)\);/);
  assert.doesNotMatch(src, /function wallTimeToInstantMs/);
});

// ── 2. The HKX77V shape ──────────────────────────────────────────────────────

test('HKX77V: written as a held ServOS catering row, venue clock, fire time from the catering settings', () => {
  const row = build(HKX77V());
  assert.equal(row.ref, 'EZ-eff5588f-1013-40f7-ae24-77febe448deb');
  assert.equal(row.location_id, LOC);
  assert.equal(row.source, 'catering');
  assert.equal(row.status, 'received');
  assert.equal(row.type, 'delivery');
  assert.equal(row.event_date, '2026-09-23');
  assert.equal(row.collection_time, '19:30');          // 18:30Z on the London clock, not New York
  assert.equal(row.sent_at, '2026-09-23T17:30:00.000Z');   // 60 minutes of catering prep
  assert.equal(row.kitchen_routed_at, null);
  assert.equal(row.is_asap, false);
  assert.equal(row.paid, true);
  assert.equal(row.total, 108);
  assert.equal(row.customer.channel, 'ezcater');
  assert.equal(row.customer.ezcater_order_id, 'eff5588f-1013-40f7-ae24-77febe448deb');
  assert.equal(row.customer.ezcater_order_number, 'HKX77V');
  assert.equal(row.customer.fulfilment, 'delivery');
  assert.equal(row.customer.event_date, '2026-09-23');
  assert.equal(row.customer.event_time, '19:30');
  assert.equal(row.customer.ezcater_awaiting_acceptance, false);
  assert.equal(row.customer.paid, true);
  assert.equal(row.customer.prep_minutes, 60);
  for (const l of row.items) {
    assert.equal(l.status, 'received'); assert.equal(l.fired, false); assert.equal(l.course, 1);
  }
  // HELD: exactly the test QueueSync uses to keep future catering out of every till.
  const isFutureCatering = (r) => r?.source === 'catering' && r?.sent_at && new Date(r.sent_at).getTime() > NOW && r?.status !== 'collected';
  assert.equal(isFutureCatering(row), true);
  assert.equal(cateringMayRelease(row), true);   // and the release fires it at its fire time
});

test('HKX77V: the row has the keys CateringCheckout writes, plus kitchen_routed_at null', () => {
  const src = read('../surfaces/catering/CateringCheckout.jsx');
  const block = src.slice(src.indexOf('const queueRow = (paid, pay) =>'), src.indexOf('const placedSnapshot'));
  for (const k of ['ref', 'location_id', 'type', 'status', 'source', 'event_date', 'collection_time', 'is_asap', 'paid', 'items', 'customer', 'total', 'sent_at', 'payment_method']) {
    assert.ok(block.includes(k), `checkout writes ${k}`);
  }
  assert.match(block, /status: 'received', source: 'catering'/);
  const row = build(HKX77V());
  assert.deepEqual(Object.keys(row).sort(), ['collection_time', 'customer', 'event_date', 'is_asap', 'items', 'kitchen_routed_at',
    'location_id', 'paid', 'payment_method', 'ref', 'sent_at', 'source', 'status', 'total', 'type']);
});

test('fire time: the venue catering prep time, its handoff time, and the flagged fallback', () => {
  assert.deepEqual(ezcaterPrep({ prep_time_minutes: 90 }), { prepMinutes: 90, prepFallback: false });
  assert.deepEqual(ezcaterPrep({ prep_time_minutes: 0 }), { prepMinutes: 0, prepFallback: false });
  assert.deepEqual(ezcaterPrep(null), { prepMinutes: EZ_PREP_FALLBACK_MINUTES, prepFallback: true });
  assert.deepEqual(ezcaterPrep({ prep_time_minutes: null }), { prepMinutes: 60, prepFallback: true });
  const p90 = build(HKX77V(), { prepMinutes: 90 });
  assert.equal(p90.sent_at, '2026-09-23T17:00:00.000Z');
  const fb = build(HKX77V(), { ...ezcaterPrep(null) });
  assert.equal(fb.customer.prep_fallback, true);
  assert.equal(fb.sent_at, '2026-09-23T17:30:00.000Z');
  // ezCater's handoff time is the kitchen's deadline when it sends one (the food leaves first).
  const o = HKX77V(); o.event = { ...o.event, catererHandoffFoodTime: '2026-09-23T18:00:00Z' };
  const h = build(o);
  assert.equal(h.sent_at, '2026-09-23T17:00:00.000Z');
  assert.equal(h.collection_time, '19:30');          // what the customer expects stays the event time
  assert.equal(h.customer.ready_time, '19:00');
  // A collection order is typed as ours is.
  const t = HKX77V(); t.event = { ...t.event, orderType: 'TAKEOUT' };
  const tr = build(t);
  assert.equal(tr.type, 'collection');
  assert.equal(tr.customer.serviceType, 'collection');
  assert.equal(tr.customer.ezcater_service_type, 'TAKEOUT');
});

// ── 3. Lifecycle ─────────────────────────────────────────────────────────────

test('lifecycle: submitted is held and shows as awaiting ezCater acceptance', () => {
  const row = build(HKX77V({ lifecycle: { orderIsCurrently: 'submitted' } }));
  assert.equal(row.customer.ezcater_awaiting_acceptance, true);
  assert.equal(isAwaitingEzcaterAcceptance(row), true);
  assert.equal(cateringMayRelease(row), false);
  assert.equal(advanceStatusLabel(row), AWAITING_LABEL);
  assert.equal(AWAITING_LABEL, 'Awaiting ezCater acceptance');
  assert.equal(row.source, 'catering');           // still in the advance list, still a catering order
});

test('lifecycle: a rejected MODIFICATION is not a cancel, a rejected new order is held, only cancelled ends it', () => {
  assert.deepEqual(ezLifecycleState('rejected', { priorAccepted: 1 }),
    { lifecycle: 'accepted', dead: false, awaiting: false, committed: true, modificationRejected: true });
  assert.equal(ezLifecycleState('rejected', { prevLifecycle: 'accepted' }).committed, true);
  const fresh = ezLifecycleState('rejected');
  assert.equal(fresh.dead, false); assert.equal(fresh.awaiting, true);
  assert.equal(ezLifecycleState('cancelled').dead, true);
  assert.equal(ezLifecycleState('cancelled_for_replacement').dead, true);
  assert.equal(ezLifecycleState('relish_finalized').committed, true);
  assert.equal(ezLifecycleState('').awaiting, true);   // unknown is held, never fired blind
  const rej = build(HKX77V({ lifecycle: { orderIsCurrently: 'rejected' } }), { priorAccepted: 1 });
  assert.equal(rej.customer.ezcater_awaiting_acceptance, false);
  assert.equal(rej.customer.ezcater_modification_rejected, true);
  assert.equal(ezcaterWritePlan({ next: rej, existing: { ...rej, kitchen_routed_at: null }, nowIso: 'x' }).kind, 'unfired');
});

// ── 4. Cancels and changes ───────────────────────────────────────────────────

const stored = (row, over = {}) => ({ ...row, kitchen_routed_at: null, ...over });

test('write plan: first sight inserts; a first sight cancel writes nothing', () => {
  const row = build(HKX77V());
  assert.deepEqual(ezcaterWritePlan({ next: row, existing: null, nowIso: 'n' }), { kind: 'insert', row });
  const dead = build(HKX77V({ lifecycle: { orderIsCurrently: 'cancelled' } }));
  assert.equal(ezcaterWritePlan({ next: dead, existing: null, nowIso: 'n' }).kind, 'skip');
});

test('write plan: HKX77V as it is live today (source ezcater, status prep) is left exactly as it is', () => {
  const row = build(HKX77V());
  const legacy = { ref: row.ref, source: 'ezcater', status: 'prep', kitchen_routed_at: null, customer: { channel: 'ezCater' } };
  for (const life of ['accepted', 'cancelled', 'submitted']) {
    const next = build(HKX77V({ lifecycle: { orderIsCurrently: life } }));
    assert.equal(ezcaterWritePlan({ next, existing: legacy, nowIso: 'n' }).kind, 'skip');
  }
  assert.equal(isEzcaterOrder(legacy), true);   // and it is still excluded from our messages
});

test('write plan: a change BEFORE firing replaces items, times and totals in place, fire time recomputed', () => {
  const before = stored(build(HKX77V()), { status: 'received' });
  const o = HKX77V();
  o.event = { ...o.event, timestamp: '2026-09-23T20:00:00Z' };
  o.catererCart = { ...o.catererCart, totals: { catererTotalDue: 150 }, orderItems: [...o.catererCart.orderItems, { uuid: 'oi-3', name: 'Fruit', quantity: 1, totalInSubunits: money(4200) }] };
  const next = build(o);
  const plan = ezcaterWritePlan({ next, existing: before, nowIso: 'n' });
  assert.equal(plan.kind, 'unfired');
  assert.equal(plan.patch.sent_at, '2026-09-23T19:00:00.000Z');
  assert.equal(plan.patch.collection_time, '21:00');
  assert.equal(plan.patch.total, 150);
  assert.equal(plan.patch.items.length, 3);
  for (const k of ['ref', 'location_id', 'status', 'kitchen_routed_at']) assert.equal(k in plan.patch, false, `never writes ${k}`);
  // A held order that ezCater now accepts is released the same way.
  const held = stored(build(HKX77V({ lifecycle: { orderIsCurrently: 'submitted' } })));
  const acc = ezcaterWritePlan({ next: build(HKX77V()), existing: held, nowIso: 'n' });
  assert.equal(acc.kind, 'unfired');
  assert.equal(acc.patch.customer.ezcater_awaiting_acceptance, false);
});

test('write plan: a change AFTER firing leaves the order alone and flags staff plainly', () => {
  const fired = stored(build(HKX77V()), { status: 'prep', kitchen_routed_at: '2026-09-23T17:30:05Z' });
  const o = HKX77V();
  o.catererCart = { ...o.catererCart, orderItems: [{ uuid: 'oi-1', name: 'Sandwich Platter', quantity: 5, totalInSubunits: money(20000) }] };
  const plan = ezcaterWritePlan({ next: build(o), existing: fired, nowIso: '2026-09-23T17:40:00Z' });
  assert.equal(plan.kind, 'fired');
  assert.deepEqual(Object.keys(plan.patch), ['customer']);   // items, times, totals untouched
  assert.equal(plan.flag.text, FLAG_CHANGED_AFTER_FIRE);
  assert.equal(FLAG_CHANGED_AFTER_FIRE, 'Changed on ezCater after it went to the kitchen: see ezCater');
  assert.equal(ezcaterFlagText({ customer: plan.patch.customer }), FLAG_CHANGED_AFTER_FIRE);
  assert.equal(advanceStatusLabel({ ...fired, customer: plan.patch.customer }), 'Changed after kitchen');
  // The same order again after firing (a repeat or a lifecycle step) is not a change.
  assert.equal(ezcaterWritePlan({ next: build(HKX77V()), existing: fired, nowIso: 'n' }).kind, 'skip');
  // A later item link (itemId) is not a change for the kitchen.
  const linked = { ...fired, items: fired.items.map((l) => ({ ...l, itemId: 'm-1' })) };
  assert.equal(kitchenFingerprint(linked), kitchenFingerprint(fired));
});

test('write plan: cancelled sets our catering cancelled state, before or after firing; after firing staff are told to stop', () => {
  const dead = build(HKX77V({ lifecycle: { orderIsCurrently: 'cancelled' } }));
  const pre = ezcaterWritePlan({ next: dead, existing: stored(build(HKX77V())), nowIso: 'n' });
  assert.equal(pre.kind, 'unfired');
  assert.equal(pre.patch.status, 'cancelled');
  assert.equal(pre.patch.customer.ezcater_flag, undefined);
  assert.equal(cateringMayRelease({ ...stored(build(HKX77V())), ...pre.patch }), false);
  assert.equal(advanceStatusLabel({ ...stored(build(HKX77V())), ...pre.patch }), 'Cancelled');
  const post = ezcaterWritePlan({ next: dead, existing: stored(build(HKX77V()), { kitchen_routed_at: 'x', status: 'prep' }), nowIso: 'n' });
  assert.equal(post.kind, 'fired');
  assert.equal(post.patch.status, 'cancelled');
  assert.equal(post.flag.text, FLAG_CANCELLED_AFTER_FIRE);
  assert.equal(advanceStatusLabel({ status: 'cancelled', kitchen_routed_at: 'x', customer: post.patch.customer }), 'Cancelled after kitchen');
  // Cancelled is terminal: nothing afterwards revives it.
  const again = ezcaterWritePlan({ next: build(HKX77V()), existing: stored(build(HKX77V()), { status: 'cancelled' }), nowIso: 'n' });
  assert.equal(again.kind, 'skip');
});

test('webhook: writes through the plan, conditional on kitchen_routed_at, and keeps idempotency and matching', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /ezcaterCateringRow\(queueRow/);
  assert.match(src, /ezcaterWritePlan\(/);
  assert.match(src, /\.is\('kitchen_routed_at', null\)\.not\('status', 'in', NOT_RELEASABLE_STATUSES_PG\)/);
  assert.match(src, /catering_site_settings'\)\.select\('prep_time_minutes'\)/);
  assert.match(src, /from\('locations'\)\.select\('timezone'\)/);
  assert.match(src, /onConflict: 'notification_id', ignoreDuplicates: true/);   // notification idempotency kept
  assert.match(src, /prior\?\.status === 'processed'/);
  assert.match(src, /matchQueueRow\(sb, locationId, row/);                       // item matching kept
  assert.doesNotMatch(src, /queuePayload\(/);                                     // the old source 'ezcater' write is gone
  assert.doesNotMatch(src, /source: 'ezcater'/);
});

// ── 5. Exclusions ────────────────────────────────────────────────────────────

const ez = () => build(HKX77V());
const ours = { ref: 'CA-ABCDE', source: 'catering', type: 'delivery', customer: { name: 'Sam', phone: '07700900000', delivery_mode: 'uber' } };

test('who is ezCater: keyed on customer.channel, any case; ours are not', () => {
  assert.equal(isEzcaterOrder(ez()), true);
  assert.equal(isEzcaterOrder({ source: 'catering', customer: { channel: 'ezCater' } }), true);
  assert.equal(isEzcaterOrder(ours), false);
  assert.equal(isEzcaterOrder({ source: 'hubrise', customer: { channel: 'Deliveroo' } }), false);
  assert.equal(isEzcaterOrder(null), false);
});

test('exclusion: order-notify sends nothing for an ezCater order, confirmation or ready', () => {
  assert.equal(mayMessageCustomer(ez()), false);
  assert.equal(mayMessageCustomer(ours), true);
  const src = read('../../supabase/functions/order-notify/index.ts');
  assert.match(src, /import \{ mayMessageCustomer \} from '\.\.\/_shared\/ezcaterCatering\.js'/);
  const guard = src.indexOf("if (!mayMessageCustomer(order)) return json({ ok: true, skipped: 'ezCater owns this customer' });");
  assert.ok(guard > 0);
  assert.ok(guard < src.indexOf("if (event === 'confirmed' && source === 'catering')"), 'before either event is handled');
  assert.ok(guard < src.indexOf('ledgerClaimFor(target)'), 'before anything is claimed or sent');
});

test('exclusion: review-request never texts an ezCater customer', () => {
  assert.equal(mayMessageCustomer({ source: 'catering', customer: { channel: 'ezcater', phone: '1' } }), false);
  assert.equal(mayMessageCustomer({ source: 'ezcater', customer: { phone: '1' } }), false);
  const src = read('../../supabase/functions/review-request/index.ts');
  assert.match(src, /select\('id, source, customer, customer_phone, total, closed_at'\)/);
  const guard = src.indexOf('if (!mayMessageCustomer(c)) continue;');
  assert.ok(guard > 0 && guard < src.indexOf('sendSms(phone, buildMsg'));
});

test('exclusion: no ServOS courier, client dispatcher refuses before calling the edge function', async () => {
  assert.equal(mayBookOurCourier(ez()), false);
  assert.equal(mayBookOurCourier(ours), true);
  let called = 0;
  const invoke = async () => { called++; return { ok: true }; };
  const r = await dispatchDelivery({ opsLocationId: LOC, order: { ...ez(), customer: { ...ez().customer, delivery_mode: 'uber' } }, quote: {} }, { invoke });
  assert.deepEqual(r, { ok: false, reason: 'ezcater_delivers' });
  assert.equal(called, 0);
  const ok = await dispatchDelivery({ opsLocationId: LOC, order: ours, quote: {} }, { invoke });
  assert.equal(ok.ok, true); assert.equal(called, 1);
});

test('exclusion: no ServOS courier, server dispatcher refuses before reserving anything', async () => {
  // The module reads its env at load. A stub Deno with no env is enough: nothing is sent.
  const hadDeno = 'Deno' in globalThis;
  if (!hadDeno) globalThis.Deno = { env: { get: () => undefined } };
  let dispatchCourier;
  try {
    ({ dispatchCourier } = await import('../../supabase/functions/_shared/delivery-dispatch.ts'));
  } finally { if (!hadDeno) delete globalThis.Deno; }
  let touched = 0;
  const sb = { from: () => { touched++; throw new Error('must not be reached'); } };
  const r = await dispatchCourier(sb, { loc: LOC, cfg: { enabled: true }, order: ez(), quote: {} });
  assert.deepEqual(r, { ok: false, reason: 'ezcater_delivers' });
  assert.equal(touched, 0);
});

test('exclusion: both catering releases never book a courier for ezCater', () => {
  const store = read('../store/index.js');
  assert.match(store, /row\.customer\?\.delivery_mode === 'uber' && mayBookOurCourier\(row\) && !isTrainingMode\(\)/);
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.match(cron, /row\.customer\?\.delivery_mode === 'uber' && mayBookOurCourier\(row\)/);
});

test('exclusion: money, never unpaid and never refunded through our processors', () => {
  assert.equal(isPrepaidByChannel(ez()), true);
  assert.equal(isPrepaidByChannel({ ...ez(), paid: false, customer: { channel: 'ezcater' } }), true);
  assert.equal(isPrepaidByChannel(ours), false);
  assert.equal(mayTakeOrRefundMoney(ez()), false);
  assert.equal(mayTakeOrRefundMoney({ id: 'chk-1', source: 'ezcater' }), false);
  assert.equal(mayTakeOrRefundMoney(ours), true);
  const row = ez();
  assert.equal(row.paid, true); assert.equal(row.customer.paid, true); assert.equal(row.customer.due, 0);
  assert.equal(row.customer.pay_later, undefined);
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.match(hub, /const isOrderPaid = \(o\) => !!\(o\?\.paid \|\| o\?\.customer\?\.paid \|\| PREPAID_CHANNELS\.includes\(o\?\.source\) \|\| isPrepaidByChannel\(o\)\);/);
  assert.match(hub, /\['online', 'kiosk'\]\.includes\(o\.source\) \|\| isPrepaidByChannel\(o\)\) \{ setViewOrder\(o\); \}/);
  const store = read('../store/index.js');
  const refund = store.slice(store.indexOf('refundCheck: async (checkId'), store.indexOf('const bd = refundBreakdown(chkBefore'));
  assert.match(refund, /if \(!mayTakeOrRefundMoney\(chkBefore\)\)/);
  const bo = read('../backoffice/sections/CateringOrders.jsx');
  assert.match(bo, /isPrepaidByChannel\(o\) \? \{ \.\.\.o, paid: true \} : o/);
});

// ── 6. Every catering path handles it with no change of its own ──────────────

test('the release filters: held and cancelled ezCater rows are never read; ours read as before', () => {
  assert.equal(RELEASABLE_OR_FILTER, 'customer->>ezcater_awaiting_acceptance.is.null,customer->>ezcater_awaiting_acceptance.neq.true');
  assert.equal(NOT_RELEASABLE_STATUSES_PG, '(collected,cancelled)');
  const store = read('../store/index.js');
  const rel = store.slice(store.indexOf('releaseDueCateringOrders'), store.indexOf('fireCourse: (courseNum)'));
  assert.match(rel, /\.in\('source', \['catering', 'online'\]\)/);
  assert.match(rel, /\.not\('status', 'in', NOT_RELEASABLE_STATUSES_PG\)\s*\n\s*\.or\(RELEASABLE_OR_FILTER\)/);
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.match(cron, /\.eq\('source', 'catering'\)\.is\('kitchen_routed_at', null\)/);
  assert.match(cron, /\.not\('status', 'in', NOT_RELEASABLE_STATUSES_PG\)\s*\n\s*\.or\(RELEASABLE_OR_FILTER\)/);
  // A cancel landing between the read and the claim never reaches the kitchen.
  assert.match(cron, /\.is\('kitchen_routed_at', null\)\s*\n\s*\/\/[^\n]*\n\s*\.neq\('status', 'cancelled'\)/);
  assert.match(store, /\.is\('kitchen_routed_at', null\)\n(\s*\/\/[^\n]*\n)+\s*\.or\('status\.is\.null,status\.neq\.cancelled'\)/);
  // In memory mirror: ours are always releasable when due.
  assert.equal(cateringMayRelease({ source: 'catering', status: 'received', customer: { name: 'Sam' } }), true);
});

test('QueueSync, the advance list and capacity key on source catering, which the row carries', () => {
  const qs = read('../sync/QueueSync.js');
  assert.match(qs, /const _isFutureCatering = \(row\) => row\?\.source === 'catering' && row\?\.sent_at/);
  assert.match(qs, /source\.neq\.catering,sent_at\.lte\./);
  const bo = read('../backoffice/sections/CateringOrders.jsx');
  assert.match(bo, /\.in\('source', \['catering', 'online'\]\)/);
  const cs = read('../surfaces/catering/CateringSurface.jsx');
  assert.match(cs, /\.eq\('source', 'catering'\)\.eq\('event_date', eventDate\)/);
  assert.equal(ez().source, 'catering');
  assert.equal(ez().event_date, '2026-09-23');
});

test('the advance list status words for our own orders are exactly as before', () => {
  const old = (o) => o.status === 'cancelled' ? 'Cancelled' : o.status === 'prep' || o.kitchen_routed_at ? 'In kitchen' : o.status === 'done' ? 'Completed' : 'Scheduled';
  for (const status of ['received', 'prep', 'done', 'cancelled', 'collected', 'ready', null]) {
    for (const kitchen_routed_at of [null, '2026-09-23T10:00:00Z']) {
      const o = { source: 'catering', status, kitchen_routed_at, customer: { name: 'Sam', pay_later: true } };
      assert.equal(advanceStatusLabel(o), old(o), `${status} ${kitchen_routed_at}`);
    }
  }
});

test('ezCater and its order number wherever a catering channel or number is shown', () => {
  const row = ez();
  assert.equal(cateringChannelLabel(row), 'ezCater');
  assert.equal(cateringChannelLabel(ours), 'Catering');
  assert.equal(ezcaterOrderNumber(row), 'HKX77V');
  assert.equal(cateringOrderNumber(row), 'HKX77V');
  assert.equal(cateringOrderNumber(ours), 'CA-ABCDE');
  assert.equal(ezcaterBadge(row), 'ezCater HKX77V');
  assert.equal(ezcaterBadge(ours), null);
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.match(hub, /ezcaterBadge\(order\) && <span/);                                   // Orders Hub card
  assert.match(hub, /\{viewOrder\.ref\} · \{ezcaterBadge\(viewOrder\) \|\| cateringChannelLabel\(viewOrder\)/);   // detail
  assert.match(hub, /isAwaitingEzcaterAcceptance\(order\) &&/);
  assert.match(hub, /ezcaterFlagText\(order\) &&/);
  const bo = read('../backoffice/sections/CateringOrders.jsx');
  assert.match(bo, /\{ezcaterBadge\(o\) \|\| o\.ref\}/);                                 // Back Office catering list
  assert.match(bo, /const statusLabel = advanceStatusLabel;/);
  const store = read('../store/index.js');
  assert.match(store, /\(isEzcaterOrder\(order\) \? ezcaterOrderNumber\(order\) : null\)/);  // KDS number
  assert.match(store, /\(isEzcaterOrder\(order\) \? 'ezCater' : srcLabel\)/);                  // KDS source
  assert.match(store, /channel: isEzcaterOrder\(order\) \? 'ezCater'/);                        // paper ticket
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.match(cron, /orderNo: ezNo \|\| row\.ref, source: ez \? 'ezCater' : 'Catering'/);
});

test('DECISIONS.md records what was deliberately left out of v1', () => {
  const d = read('../../DECISIONS.md');
  assert.match(d, /ADR-023: ezCater orders are filed as ServOS catering orders/);
  assert.match(d, /scheduled re-asks/);
  assert.match(d, /re-check of the order just before it fires/);
  assert.match(d, /cancelled for replacement/);
});

test('no em or en dashes in the files this change wrote', () => {
  for (const p of ['../../supabase/functions/_shared/ezcaterCatering.js', '../../supabase/functions/_shared/cateringRules.js', './ezcaterCatering.js', './cateringRules.js']) {
    assert.doesNotMatch(read(p), /[–—]/, p);
  }
});

// ── Review fixes (18 Sep 2026, round 2) ──────────────────────────────────────

test('A. never bring a finished order back: a known order with no queue row writes nothing', () => {
  // Staff collected it, removeFromQueue deleted the row, then ezCater sends a later notification.
  const row = build(HKX77V());
  const plan = ezcaterWritePlan({ next: row, existing: null, nowIso: 'n', linkKnown: true });
  assert.equal(plan.kind, 'skip');
  assert.match(plan.reason, /not brought back/);
  // Whatever the lifecycle says: a repeat, a status step, a held one.
  for (const life of ['accepted', 'submitted', 'ready', 'completed', 'cancelled']) {
    const next = build(HKX77V({ lifecycle: { orderIsCurrently: life } }));
    assert.equal(ezcaterWritePlan({ next, existing: null, nowIso: 'n', linkKnown: true }).kind, 'skip', life);
  }
});

test('A. a genuinely new order (no link yet) still inserts, and the default is "not known"', () => {
  const row = build(HKX77V());
  assert.deepEqual(ezcaterWritePlan({ next: row, existing: null, nowIso: 'n', linkKnown: false }), { kind: 'insert', row });
  assert.deepEqual(ezcaterWritePlan({ next: row, existing: null, nowIso: 'n' }), { kind: 'insert', row });
  // A known order that IS still in the queue is handled exactly as before.
  assert.equal(ezcaterWritePlan({ next: build(HKX77V()), existing: stored(row), nowIso: 'n', linkKnown: true }).kind, 'unfired');
});

test('A. webhook: the link is read BEFORE the write and written AFTER it, so a first notification is never blocked by its own link', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  const readAt = src.indexOf(".from('ezcater_order_links')\n      .select(");
  const planAt = src.indexOf('ezcaterWritePlan({ next, existing,');
  const upsertAt = src.indexOf(".from('ezcater_order_links')\n      .upsert(");
  assert.ok(readAt > 0 && planAt > readAt && upsertAt > planAt, 'read link, plan, then write link');
  assert.match(src, /linkKnown: !!priorLink/);
  // The queue insert flag went with the duplicate activity entry. It had re-declared the name of
  // the ezcater_events upsert result in the same block, which Deno refuses to load at all.
  assert.equal((src.match(/let inserted\b/g) || []).length, 0);
  assert.equal((src.match(/data: inserted/g) || []).length, 1);
});

test('B. an ezCater catering order cancelled AFTER it went to the kitchen raises the HubRise cancel alert', () => {
  const fired = { ...build(HKX77V()), kitchen_routed_at: '2026-09-23T17:30:05Z', status: 'prep' };
  const a = channelCancelAlert({ eventType: 'UPDATE', old: fired, new: { ...fired, status: 'cancelled' } });
  assert.deepEqual(a, {
    source: 'catering', kind: 'cancel', who: 'ezCater HKX77V',
    ref: fired.ref, total: 0, orderType: 'delivery', status: 'cancelled',
  });
});

test('B. no alert when it was cancelled before the kitchen had it, when it was already cancelled, or for our own catering', () => {
  const unfired = { ...build(HKX77V()), kitchen_routed_at: null, status: 'received' };
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: unfired, new: { ...unfired, status: 'cancelled' } }), null);
  const fired = { ...unfired, kitchen_routed_at: 'x', status: 'cancelled' };
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: fired, new: fired }), null);
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: { ...fired, status: 'prep' }, new: { ...fired, status: 'ready' } }), null);
  assert.equal(channelCancelAlert({ eventType: 'INSERT', new: fired }), null);
  assert.equal(channelCancelAlert({ eventType: 'DELETE', old: fired }), null);
  const own = { ref: 'CA-ABCDE', source: 'catering', status: 'prep', kitchen_routed_at: 'x', customer: { name: 'Sam' } };
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: own, new: { ...own, status: 'cancelled' } }), null);
  assert.equal(channelCancelAlert(null), null);
});

test('B. HubRise cancels raise exactly the alert they always did', () => {
  const h = { ref: 'HR-1', source: 'hubrise', type: 'delivery', status: 'prep', customer: { channel: 'Deliveroo' } };
  assert.deepEqual(channelCancelAlert({ eventType: 'UPDATE', old: h, new: { ...h, status: 'cancelled' } }), {
    source: 'hubrise', kind: 'cancel', who: 'Deliveroo', ref: 'HR-1', total: 0, orderType: 'delivery', status: 'cancelled',
  });
  // Routed or not (the old rule never looked), and with no old image at all.
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: {}, new: { ...h, status: 'cancelled', customer: null } }).who, 'HubRise');
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', new: { ...h, status: 'cancelled' } }).kind, 'cancel');
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: { ...h, status: 'cancelled' }, new: { ...h, status: 'cancelled' } }), null);
});

test('B. realtime raises it through channelCancelAlert with the same chime and popup, no new UI', () => {
  const rt = read('./realtime.js');
  assert.match(rt, /import \{ channelCancelAlert \} from '\.\/ezcaterCatering'/);
  assert.match(rt, /const cancelAlert = channelCancelAlert\(payload\);\n\s+if \(cancelAlert\) \{\n\s+if \(orderNotificationsEnabled\(\)\) \{\n\s+playOrderChime\(\);\n\s+store\.getState\(\)\.showOrderAlert\?\.\(cancelAlert\);/);
  assert.doesNotMatch(rt, /payload\.new\?\.source === 'hubrise'\n\s+&& payload\.new\?\.status === 'cancelled'/);
});

test('C. held past its fire time: the selection rule', () => {
  const held = { ...build(HKX77V({ lifecycle: { orderIsCurrently: 'submitted' } })), kitchen_routed_at: null };
  const due = Date.parse(held.sent_at);
  assert.equal(ezcaterHoldAlertDue(held, due - 1), false, 'not before its fire time');
  assert.equal(ezcaterHoldAlertDue(held, due), true, 'at its fire time');
  assert.equal(ezcaterHoldAlertDue(held, due + 3600_000), true);
  // Once only.
  assert.equal(ezcaterHoldAlertDue({ ...held, customer: { ...held.customer, ezcater_hold_alerted_at: 'x' } }, due + 1), false);
  // Accepted, routed, finished, cancelled, ours, or no fire time: never.
  assert.equal(ezcaterHoldAlertDue(build(HKX77V()), due + 1), false);
  assert.equal(ezcaterHoldAlertDue({ ...held, kitchen_routed_at: 'x' }, due + 1), false);
  assert.equal(ezcaterHoldAlertDue({ ...held, status: 'cancelled' }, due + 1), false);
  assert.equal(ezcaterHoldAlertDue({ ...held, status: 'collected' }, due + 1), false);
  assert.equal(ezcaterHoldAlertDue({ ...ours, sent_at: held.sent_at, customer: { ...ours.customer, ezcater_awaiting_acceptance: true } }, due + 1), false);
  assert.equal(ezcaterHoldAlertDue({ ...held, sent_at: null }, due + 1), false);
  assert.equal(ezcaterHoldAlertDue(null, due), false);
});

test('C. held past its fire time: plain words, and the stamp survives a change before firing', () => {
  const held = { ...build(HKX77V({ lifecycle: { orderIsCurrently: 'submitted' } })), kitchen_routed_at: null };
  assert.equal(ezcaterHoldAlertText(held), 'ezCater HKX77V is due in the kitchen but has not been accepted on ezCater. Accept it on ezCater and it will fire.');
  assert.match(ezcaterHoldAlertText({ customer: { channel: 'ezcater' } }), /^An ezCater order is due in the kitchen/);
  const alerted = { ...held, customer: { ...held.customer, ezcater_hold_alerted_at: '2026-09-23T17:30:00Z' } };
  const plan = ezcaterWritePlan({ next: build(HKX77V({ lifecycle: { orderIsCurrently: 'submitted' } })), existing: alerted, nowIso: 'n' });
  assert.equal(plan.kind, 'unfired');
  assert.equal(plan.patch.customer.ezcater_hold_alerted_at, '2026-09-23T17:30:00Z');
  assert.equal(ezcaterHoldAlertDue({ ...alerted, ...plan.patch }, Date.parse('2026-09-24T00:00:00Z')), false);
  // Never added to an order that was not alerted.
  const fresh = ezcaterWritePlan({ next: build(HKX77V()), existing: held, nowIso: 'n' });
  assert.equal('ezcater_hold_alerted_at' in fresh.patch.customer, false);
});

test('C. catering-release: reads held rows, claims with a conditional stamp, writes one urgent entry', () => {
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.match(cron, /\.eq\('customer->>ezcater_awaiting_acceptance', 'true'\)\n\s+\.is\('customer->>ezcater_hold_alerted_at', null\)\n\s+\.lte\('sent_at', nowIso\)/);
  assert.match(cron, /if \(!ezcaterHoldAlertDue\(row, nowMs\)\) continue;/);
  assert.match(cron, /ezcater_hold_alerted_at: nowIso \} \}\)\n\s+\.eq\('ref', row\.ref\)\.eq\('location_id', row\.location_id\)\n\s+\.is\('kitchen_routed_at', null\)/);
  assert.match(cron, /severity: 'urgent',\n\s+title: ezcaterHoldAlertText\(row\)/);
  // The release itself is unchanged: held rows are still never fired.
  assert.match(cron, /\.or\(RELEASABLE_OR_FILTER\)/);
});

test('D. one activity entry per new order: the trigger logs it, the webhook only logs flags', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.doesNotMatch(src, /catering order`/);
  assert.match(src, /if \(flagged\) \{/);
  assert.match(src, /severity: 'urgent',\n\s+title: `\$\{badge\}: \$\{flagged\.text\}`/);
  // The trigger titles every insert by source, so an ezCater order reads "Catering order".
  const trig = read('../../supabase/migrations/20260629d_order_activity_trigger.sql');
  assert.match(trig, /after insert on order_queue/);
  assert.match(trig, /initcap\(coalesce\(nullif\(new\.source, ''\)/);
});

test('E. ADR-023 says the claim refuses cancelled rows for every source, and the release note exists', () => {
  const d = read('../../DECISIONS.md');
  assert.doesNotMatch(d, /no queue code change/);
  assert.match(d, /refuses a cancelled row for every source/);
  const store = read('../store/index.js');
  assert.match(store, /\.or\('status\.is\.null,status\.neq\.cancelled'\)/);
  const note = read('../../docs/EZCATER_V1_RELEASE.md');
  for (const fn of ['catering-release', 'order-notify', 'review-request', 'uber-direct', 'ezcater-connect', 'ezcater-webhook']) {
    assert.match(note, new RegExp('`' + fn + '`'), fn);
  }
  assert.ok(note.indexOf('`ezcater-webhook`') > note.indexOf('`uber-direct`'), 'the webhook goes last');
  assert.ok(note.indexOf('**Last:** `ezcater-webhook`') > note.indexOf('  - `ezcater-connect`'), 'the webhook after connect');
  assert.match(note, /closed_checks/);
  assert.match(note, /HKX77V/);
  assert.doesNotMatch(note, /[\u2013\u2014]/);
});

test('E2. release note steps in Peter\'s order: merge, prep time, tills on the new version, functions, HKX77V, fresh order, menu sync', () => {
  const note = read('../../docs/EZCATER_V1_RELEASE.md');
  const steps = [...note.matchAll(/^## (\d)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7]);
  const at = (re) => { const i = note.search(re); assert.ok(i >= 0, String(re)); return i; };
  const order = [
    at(/Merge to main/), at(/## 2\. Set the catering prep time/), at(/NEW version number/),
    at(/## 4\. Deploy the edge functions/), at(/## 5\. The old test order HKX77V/),
    at(/## 6\. Place a fresh test order/), at(/## 7\. Menu sync/),
  ];
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `step ${i + 1} after step ${i}`);
  // Step 3: the master till and every Sunmi, where Peter sees it, why, and a stop.
  assert.match(note, /master till AND every Sunmi till/);
  assert.match(note, /next to "What's new"/);
  assert.match(note, /Terminal status button: the Version row/);
  // The exact version the merge ships, and how a Sunmi till really gets it (a reload keeps old code).
  assert.match(note, /The merge ships as v5\.9\.9\./);
  assert.match(note, /It must read exactly v5\.9\.9\./);
  assert.doesNotMatch(note, /v5\.8\.100/);
  assert.match(note, /A reload is not enough/);
  assert.match(note, /Force stop the app:\*\* swipe it away, or Settings, Apps, the app, Force stop\./);
  assert.match(note, /Then reopen it\*\* and read the version again/);
  assert.match(note, /releases held orders and cancelled orders/);
  assert.match(note, /Do not go further until every till shows it/);
  // Step 4: from the merged commit, the CLI, the webhook last, then the deploy check.
  assert.match(note, /From the merged commit/);
  assert.match(note, /Fetch first\./);
  assert.match(note, /`git rev-parse HEAD` must equal the merge commit shown on GitHub/);
  assert.match(note, /Supabase CLI/);
  assert.ok(note.indexOf('node scripts/check-deploys.mjs') > note.indexOf('`ezcater-webhook`'), 'check after the webhook');
  assert.match(note, /Claude runs the deploys, and Claude checks them/);
  assert.match(note, /every `_shared` file it imports/);
  // The live proof: a line only the new code has, and it really is in the shared code.
  assert.match(note, /npx supabase functions download <name>/);
  const marker = note.match(/must contain `([^`]+)`\. Only the new code has that text\./);
  assert.ok(marker, 'marker line');
  assert.ok(read('../../supabase/functions/_shared/ezcaterCatering.js').includes(marker[1]), 'marker is in the shared code');
  assert.ok(read('../../supabase/functions/ezcater-webhook/index.ts').includes("retry('event read failed')"));
  assert.match(note, /`ezcater-webhook` must also contain `event read failed`/);
  // Step 7: running the migration is itself outside service, then Sync.
  const step7 = note.slice(note.indexOf('## 7. Menu sync'), note.indexOf('## Known gap'));
  assert.ok(step7.indexOf('Outside service only') < step7.indexOf('20260919m'), 'outside service covers the migration');
  assert.ok(step7.indexOf('Then press Sync') > step7.indexOf('20260919m'));
  assert.match(step7, /switches sized line matching on, and it schedules the hourly sync/);
  assert.match(step7, /So running it is itself outside service/);
  assert.match(note, /Outside service, or when no ezCater order is due to fire/);
  assert.match(note, /Only exact matches link automatically/);
  // No dashes used as punctuation (list bullets are fine).
  assert.doesNotMatch(note, /\S - \S/);
});

// \u2500\u2500 Review fixes (18 Sep 2026, round 3) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('R3a. a failed link read is retried, never read as "no link"; any row means known', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /const \{ data: linkRows, error: linkReadErr \} = await sb\.from\('ezcater_order_links'\)\n\s+\.select\('accepted_count, event_at, ez_lifecycle'\)\.eq\('ez_order_id', order\.uuid\)\.limit\(10\);/);
  assert.match(src, /if \(linkReadErr\) \{\n\s+await failEvent\(`link read failed: \$\{linkReadErr\.message\}`, 'error'\);\n\s+return retry\('link read failed'\);/);
  assert.match(src, /const priorLink: any = ezcaterPriorLink\(linkRows\);/);
  // The read and its error check come before the stale guard and the plan.
  assert.ok(src.indexOf("retry('link read failed')") < src.indexOf('priorLink?.event_at && eventAt'));
  assert.doesNotMatch(src, /ez_order_id', order\.uuid\)\.maybeSingle\(\)/);

  assert.equal(ezcaterPriorLink(null), null);
  assert.equal(ezcaterPriorLink([]), null);
  assert.equal(ezcaterPriorLink(undefined), null);
  assert.deepEqual(ezcaterPriorLink({ accepted_count: 1, event_at: 'a', ez_lifecycle: 'accepted' }), { accepted_count: 1, event_at: 'a', ez_lifecycle: 'accepted' });
  // Two rows: known, the highest count, the latest event and its lifecycle.
  const two = ezcaterPriorLink([
    { accepted_count: 2, event_at: '2026-09-18T10:00:00Z', ez_lifecycle: 'accepted' },
    { accepted_count: 1, event_at: '2026-09-18T11:00:00Z', ez_lifecycle: 'cancelled' },
  ]);
  assert.deepEqual(two, { accepted_count: 2, event_at: '2026-09-18T11:00:00Z', ez_lifecycle: 'cancelled' });
  // A row with nothing in it still means known.
  assert.ok(ezcaterPriorLink([{}]));
  assert.equal(ezcaterPriorLink([{}]).accepted_count, 0);
  // Known means a finished order with no queue row is not filed again.
  assert.equal(ezcaterWritePlan({ next: build(HKX77V()), existing: null, nowIso: 'n', linkKnown: !!ezcaterPriorLink([{}, {}]) }).kind, 'skip');
});

test('R3b. a failed link write marks the event error and retries, before the event counts as processed', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  const upsertAt = src.indexOf(".from('ezcater_order_links')\n      .upsert(");
  const retryAt = src.indexOf("return retry('link write failed')");
  const alertAt = src.indexOf('if (flagged) {');
  const processedAt = src.indexOf("status: 'processed', location_id: locationId, error: null");
  assert.ok(upsertAt > 0 && retryAt > upsertAt, 'retry on a failed link write');
  assert.ok(alertAt > retryAt, 'the staff alert only after the link is written, so a retry raises it once');
  assert.ok(processedAt > alertAt, 'processed only after the link');
  assert.match(src, /await failEvent\(rowOnFile \? `\$\{EZ_QUEUE_WRITTEN_MARKER\}; \$\{msg\}` : msg, 'error'\);/);
  assert.doesNotMatch(src, /console\.warn\('\[ezcater-webhook\] link upsert failed:'/);
  // The retry still cannot insert twice: notification dedupe, insert only on no row, 23505 re-plans.
  assert.match(src, /onConflict: 'notification_id', ignoreDuplicates: true/);
  assert.match(src, /prior\?\.status === 'processed'\) return ok\(\)/);
  assert.match(src, /select\('status, attempts, error'\)/);
  assert.match(src, /queueWrittenBefore = ezcaterQueueWrittenBefore\(prior\);/);
  assert.match(src, /linkKnown: !!priorLink \|\| queueWrittenBefore/);
  assert.match(src, /23505\|duplicate key/);
  // Every error written for this notification keeps the marker.
  assert.match(src, /error: ezcaterEventError\(msg, queueWrittenBefore\) \}\)\n\s+\.eq\('notification_id', notificationId\);\n\s+\};/);
  assert.match(src, /status: 'error', error: ezcaterEventError\(msg, queueWrittenBefore\)/);
});

test('R3b. the retry after a failed link write: same row, never a second insert', () => {
  const row = build(HKX77V());
  // First attempt inserted, then the link write failed. The event row now carries the marker.
  const priorEvent = { status: 'error', error: `${EZ_QUEUE_WRITTEN_MARKER}; link write failed: timeout` };
  assert.equal(ezcaterQueueWrittenBefore(priorEvent), true);
  assert.equal(ezcaterQueueWrittenBefore({ status: 'error', error: 'order fetch failed: 500' }), false);
  assert.equal(ezcaterQueueWrittenBefore(null), false);
  // Retry, row still there (the usual case): replaced in place or left alone, never inserted.
  assert.equal(ezcaterWritePlan({ next: row, existing: stored(row), nowIso: 'n', linkKnown: true }).kind, 'unfired');
  const fired = stored(row, { status: 'prep', kitchen_routed_at: 'x' });
  assert.equal(ezcaterWritePlan({ next: row, existing: fired, nowIso: 'n', linkKnown: true }).kind, 'skip');
  // Retry after staff finished and removed the row: no link yet, but the marker makes it known.
  assert.equal(ezcaterWritePlan({ next: row, existing: null, nowIso: 'n', linkKnown: ezcaterQueueWrittenBefore(priorEvent) }).kind, 'skip');
  // A later failure on the same notification keeps the marker, so a third attempt is still safe.
  const again = ezcaterEventError('order fetch failed: 500', true);
  assert.ok(again.startsWith(EZ_QUEUE_WRITTEN_MARKER));
  assert.equal(ezcaterQueueWrittenBefore({ error: again }), true);
  assert.equal(ezcaterEventError(priorEvent.error, true), priorEvent.error, 'never doubled');
  assert.equal(ezcaterEventError('plain', false), 'plain');
  assert.equal(ezcaterEventError('x'.repeat(3000), true).length, 2000);
  assert.ok(ezcaterEventError('x'.repeat(3000), true).startsWith(EZ_QUEUE_WRITTEN_MARKER));
});

test('R3c. a collected order is finished: a later cancel or change writes nothing and raises no alert', () => {
  const row = build(HKX77V());
  const dead = build(HKX77V({ lifecycle: { orderIsCurrently: 'cancelled' } }));
  const o = HKX77V();
  o.catererCart = { ...o.catererCart, orderItems: [{ uuid: 'oi-1', name: 'Sandwich Platter', quantity: 9, totalInSubunits: money(30000) }] };
  const changed = build(o);
  for (const routed of ['2026-09-23T17:30:05Z', null]) {
    const collected = stored(row, { status: 'collected', kitchen_routed_at: routed });
    for (const [label, next] of [['cancel', dead], ['change', changed], ['repeat', row]]) {
      const plan = ezcaterWritePlan({ next, existing: collected, nowIso: 'n', linkKnown: true });
      assert.equal(plan.kind, 'skip', `${label}, routed ${routed}`);
      assert.match(plan.reason, /collected/);
      assert.equal(plan.flag, undefined);
      assert.equal(plan.patch, undefined);
    }
  }
  // No status write means no realtime cancel alert either.
  const collected = stored(row, { status: 'collected', kitchen_routed_at: 'x' });
  assert.equal(channelCancelAlert({ eventType: 'UPDATE', old: collected, new: collected }), null);
  // Any case.
  assert.equal(ezcaterWritePlan({ next: dead, existing: stored(row, { status: 'Collected', kitchen_routed_at: 'x' }), nowIso: 'n' }).kind, 'skip');
  // The webhook logs every skip with its reason.
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /console\.log\('\[ezcater-webhook\]', row\.ref, 'queue row not written:', plan\.reason\);/);
  // Prep and ready still take a cancel after firing, as before.
  const ready = ezcaterWritePlan({ next: dead, existing: stored(row, { status: 'ready', kitchen_routed_at: 'x' }), nowIso: 'n' });
  assert.equal(ready.kind, 'fired');
  assert.equal(ready.flag.text, FLAG_CANCELLED_AFTER_FIRE);
});

// ── Review fixes (18 Sep 2026, round 4) ─────────────────────────────────────

test('R4a. the unfired write refuses a collected row as well as a cancelled one', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /\.update\(plan\.patch\)\n\s+\.eq\('location_id', locationId\)\.eq\('ref', row\.ref\)\n\s+\.is\('kitchen_routed_at', null\)\.not\('status', 'in', NOT_RELEASABLE_STATUSES_PG\)/);
  assert.doesNotMatch(src, /\.neq\('status', 'cancelled'\)/);
  assert.match(src, /NOT_RELEASABLE_STATUSES_PG,\n\} from '\.\.\/_shared\/ezcaterCatering\.js';/);
  assert.equal(NOT_RELEASABLE_STATUSES_PG, '(collected,cancelled)');
  // Staff collected it (unrouted) between the read and the write: the update matches no row, the
  // webhook reads again and the plan skips it.
  const collected = stored(build(HKX77V()), { status: 'collected', kitchen_routed_at: null });
  assert.equal(ezcaterWritePlan({ next: build(HKX77V()), existing: collected, nowIso: 'n', linkKnown: true }).kind, 'skip');
});

test('R4b. a failed read of the notification row is retried, never read as "no prior event"', () => {
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /const \{ data: prior, error: priorErr \} = await sb\.from\('ezcater_events'\)\n\s+\.select\('status, attempts, error'\)\.eq\('notification_id', notificationId\)\.maybeSingle\(\);\n\s+if \(priorErr\) \{\n\s+console\.error\([^\n]+\n\s+return retry\('event read failed'\);\n\s+\}/);
  // Before the duplicate check, the marker read and the attempts write.
  const at = src.indexOf("return retry('event read failed')");
  assert.ok(at > 0);
  assert.ok(at < src.indexOf("prior?.status === 'processed'"));
  assert.ok(at < src.indexOf('queueWrittenBefore = ezcaterQueueWrittenBefore(prior)'));
  assert.ok(at < src.indexOf('attempts: (Number(prior?.attempts) || 0) + 1'));
});

test('R4c. a cancel after firing whose link write failed raises the bell on the retry', () => {
  const row = build(HKX77V());
  const dead = build(HKX77V({ lifecycle: { orderIsCurrently: 'cancelled' } }));
  const fired = stored(row, { status: 'prep', kitchen_routed_at: '2026-09-23T17:30:05Z' });
  // First attempt: cancelled after firing, flagged. Then the link write failed.
  const first = ezcaterWritePlan({ next: dead, existing: fired, nowIso: '2026-09-23T18:00:00Z', linkKnown: true });
  assert.equal(first.kind, 'fired');
  assert.equal(first.flag.kind, 'cancelled_after_fire');
  const afterFirst = { ...fired, ...first.patch };
  // The retry: marker present, row already cancelled with the flag, link still says accepted.
  const retryPlan = ezcaterWritePlan({ next: dead, existing: afterFirst, nowIso: '2026-09-23T18:01:00Z', linkKnown: true, queueWrittenBefore: true, linkLifecycle: 'accepted' });
  assert.equal(retryPlan.kind, 'skip');
  assert.equal(retryPlan.patch, undefined, 'nothing written again');
  assert.deepEqual(retryPlan.flag, first.flag, 'the same flag, raised now');
  assert.equal(retryPlan.flag.text, FLAG_CANCELLED_AFTER_FIRE);
  // Not owed: no marker (a repeat cancel), a link that already says cancelled (an earlier cancel
  // finished and rang), no flag on the row (cancelled before firing), or not a cancel.
  assert.equal(ezcaterWritePlan({ next: dead, existing: afterFirst, nowIso: 'n', linkKnown: true }).flag, undefined);
  assert.equal(ezcaterWritePlan({ next: dead, existing: afterFirst, nowIso: 'n', linkKnown: true, queueWrittenBefore: true, linkLifecycle: 'cancelled' }).flag, undefined);
  const cancelledEarly = stored(row, { status: 'cancelled', customer: { ...row.customer, ezcater_lifecycle: 'cancelled' } });
  assert.equal(ezcaterWritePlan({ next: dead, existing: cancelledEarly, nowIso: 'n', linkKnown: true, queueWrittenBefore: true, linkLifecycle: 'accepted' }).flag, undefined);
  assert.equal(ezcaterWritePlan({ next: row, existing: afterFirst, nowIso: 'n', linkKnown: true, queueWrittenBefore: true, linkLifecycle: 'accepted' }).flag, undefined);
  const changedFlag = { ...afterFirst, customer: { ...afterFirst.customer, ezcater_flag: { kind: 'changed_after_fire', text: FLAG_CHANGED_AFTER_FIRE, at: 'x' } } };
  assert.equal(ezcaterWritePlan({ next: dead, existing: changedFlag, nowIso: 'n', linkKnown: true, queueWrittenBefore: true, linkLifecycle: 'accepted' }).flag, undefined);
  // The webhook passes the marker and the link lifecycle, and a skip with a flag rings the bell.
  const src = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.match(src, /queueWrittenBefore, linkLifecycle: priorLink\?\.ez_lifecycle \?\? null,/);
  assert.match(src, /queue row not written:', plan\.reason\);\n\s+written = true;\n\s+\/\/[^\n]*\n\s+if \(plan\.flag\) flagged = plan\.flag;/);
  // The bell is still after the link write, so a second failure retries and rings once.
  assert.ok(src.indexOf('if (flagged) {') > src.indexOf("return retry('link write failed')"));
});
