/**
 * cateringRules.test.js: an ezCater order follows the SAME rules as a ServOS catering order.
 * Run: `npm test`.
 *
 * Peter, 18 Sep 2026, after a live ezCater test order (HKX77V) landed as a live 'prep' order
 * with sent_at = the delivery time, on the caterer's clock, and got OUR confirmation email:
 * "we need to ensure they follow the same rules as the rest of our catering system where they
 * hit the POS at the right times and parameters set to fire into the kitchen as our own
 * catering orders".
 *
 * Pinned here:
 *   1. one rule for "is this catering" (catering and ezcater), channel names kept
 *   2. HKX77V's shape: held, venue date and time on Europe/London, fire time from the catering
 *      settings by the very function CateringCheckout uses
 *   3. a due soon order fires now; one past the stale floor stays visible for manual release
 *   4. modified and cancelled orders (before and after firing)
 *   5. the release, the advance list, QueueSync, the Orders Hub, the cron all include ezCater
 *   6. no ServOS message to an ezCater customer, no ServOS courier for an ezCater delivery
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CATERING_SOURCES, isCateringSource, isEzcaterOrder, cateringSourceLabel,
  liveQueueOrFilter, isFutureCatering, wallTimeToInstantMs, venueWallClock,
  cateringPrepMinutes, cateringFireMs, cateringHoldReason, cateringMayFire,
  cateringReleaseWindow, cateringReleaseDecision, inAdvanceList, advanceListStatus,
  mayBookOurCourier, mayMessageCustomer, changedAfterFireText,
} from './cateringRules.js';
import { orderToQueueRow, queuePayload, ezCateringTiming } from '../../supabase/functions/_shared/ezcater-map.ts';
import { ezcaterWritePlan } from '../../supabase/functions/_shared/ezcaterCatering.js';
import { cateringChangeAlert } from './cateringAlerts.js';
import { dispatchDelivery } from './delivery/dispatch.js';
import { STALE_ORDER_FLOOR_MS } from '../sync/staleness.js';

const MIN = 60000;
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// Provo, as in the live data: Ops location id, Platform timezone Europe/London.
const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LONDON = { timeZone: 'Europe/London', prepMinutes: 90 };

// HKX77V, the live test order: a DELIVERY at 2026-09-23T18:30:00Z from a caterer whose own zone
// is US Eastern (which is why the old row said 14:30).
const money = (subunits) => ({ subunitsV2: String(subunits), currency: 'USD' });
const HKX77V = {
  uuid: 'eff5588f-1013-40f7-ae24-77febe448deb',
  orderNumber: 'HKX77V',
  orderSourceType: 'MARKETPLACE',
  lifecycle: { orderIsCurrently: 'accepted' },
  caterer: { uuid: 'cat-pos-testing', name: 'POS Testing', storeNumber: null },
  event: {
    timestamp: '2026-09-23T18:30:00Z',
    catererHandoffFoodTime: null,
    timeZoneIdentifier: 'America/New_York',
    timeZoneOffset: '-04:00',
    orderType: 'DELIVERY',
    headcount: 4,
    contact: { name: 'Peter Test', phone: '5555550100' },
    address: { street: '1 Test St', city: 'Boston', state: 'MA', zip: '02116' },
  },
  orderCustomer: { fullName: 'Peter Test' },
  catererCart: {
    totals: { catererTotalDue: 41.31 },
    orderItems: [{ uuid: 'oi-1', name: 'Sandwich Tray', quantity: 1, totalInSubunits: money(3600), customizations: [] }],
    feesAndDiscounts: [], deliveryFees: [],
  },
  totals: { subTotal: money(3600), salesTax: money(0), salesTaxRemittance: money(0), tip: money(0) },
};

// ── 1. one rule ─────────────────────────────────────────────────────────────

test('an ezCater order IS a catering order, and keeps its channel name', () => {
  assert.deepEqual([...CATERING_SOURCES], ['catering', 'ezcater']);
  assert.equal(isCateringSource('catering'), true);
  assert.equal(isCateringSource('ezcater'), true);
  assert.equal(isCateringSource('EZCATER'), true);
  for (const s of ['online', 'kiosk', 'qr', 'hubrise', 'pos', null, undefined, '']) assert.equal(isCateringSource(s), false, String(s));
  assert.equal(cateringSourceLabel('ezcater'), 'ezCater');
  assert.equal(cateringSourceLabel('catering'), 'Catering');
  assert.equal(cateringSourceLabel('online'), null);
  // A row that lost its source is still recognised by its ezCater id.
  assert.equal(isEzcaterOrder({ source: null, customer: { ezcater_order_id: 'x' } }), true);
  assert.equal(isEzcaterOrder({ source: 'catering', customer: {} }), false);
});

test('the live queue read keeps every held catering order out, ezCater included', () => {
  const f = liveQueueOrFilter('2026-09-18T10:00:00.000Z');
  assert.equal(f, 'source.is.null,source.not.in.(catering,ezcater),and(sent_at.lte.2026-09-18T10:00:00.000Z,or(status.neq.cancelled,kitchen_routed_at.not.is.null))');
  const now = Date.parse('2026-09-18T10:00:00Z');
  assert.equal(isFutureCatering({ source: 'ezcater', sent_at: '2026-09-23T17:00:00Z', status: 'received' }, now), true);
  assert.equal(isFutureCatering({ source: 'catering', sent_at: '2026-09-23T17:00:00Z', status: 'received' }, now), true);
  assert.equal(isFutureCatering({ source: 'online', sent_at: '2026-09-23T17:00:00Z', status: 'prep' }, now), false);
  assert.equal(isFutureCatering({ source: 'ezcater', sent_at: '2026-09-18T09:00:00Z', status: 'received' }, now), false);
});

// ── 2. HKX77V ───────────────────────────────────────────────────────────────

test('HKX77V is written as a HELD catering order on the venue clock, fired by the catering settings', () => {
  const { row, link } = orderToQueueRow(HKX77V, PROVO, { venue: LONDON });

  // The same initial status CateringCheckout writes.
  assert.equal(row.status, 'received');
  assert.equal(row.source, 'ezcater');
  assert.equal(row.type, 'delivery');
  assert.equal(row.is_asap, false);
  assert.equal(row.paid, true);

  // 18:30Z is 19:30 in London (BST) on the 23rd. The old row said 14:30, the caterer's clock.
  assert.equal(row.event_date, '2026-09-23');
  assert.equal(row.collection_time, '19:30');
  assert.notEqual(row.collection_time, '14:30');
  assert.equal(row.customer.event_time, '19:30');
  assert.equal(row.customer.venueTimeZone, 'Europe/London');

  // No handoff time on this order, so the delivery time is the ready time, and it says so.
  assert.equal(row.customer.readySource, 'event.timestamp');
  // The kitchen fire time: ready minus the venue's catering prep time (90 min), NOT the delivery time.
  assert.equal(row.fire_at, '2026-09-23T17:00:00.000Z');
  assert.equal(link.fire_at, '2026-09-23T17:00:00.000Z');
  assert.equal(row.customer.fire_time, '18:00');
  assert.equal(row.customer.prepMinutes, 90);

  // The SAME function and the SAME settings a ServOS catering order is fired by: a ServOS
  // catering order for 23 Sep at 19:30 at this venue fires at exactly the same instant.
  const ours = cateringFireMs(wallTimeToInstantMs('2026-09-23', '19:30', 'Europe/London'), cateringPrepMinutes({ prep_time_minutes: 90 }));
  assert.equal(new Date(ours).toISOString(), row.fire_at);

  // Written as a new order: sent_at is the fire time, kitchen_routed_at is never set here
  // (the release claims it, once, at every device).
  const p = queuePayload(row, true, '2026-09-18T10:00:00.000Z');
  assert.equal(p.sent_at, '2026-09-23T17:00:00.000Z');
  assert.equal(p.status, 'received');
  assert.equal(p.event_date, '2026-09-23');
  assert.equal(p.collection_time, '19:30');
  assert.equal('kitchen_routed_at' in p, false);

  // It stays out of the live queue until then, and the release will fire it on the day.
  assert.equal(isFutureCatering(p, Date.parse('2026-09-18T10:00:00Z')), true);
  assert.equal(cateringReleaseDecision(p, Date.parse('2026-09-23T17:00:30Z'), STALE_ORDER_FLOOR_MS), 'fire');
});

test('a delivery with a handoff time fires from the handoff: the moment the food must leave', () => {
  const order = { ...HKX77V, event: { ...HKX77V.event, catererHandoffFoodTime: '2026-09-23T18:00:00Z' } };
  const t = ezCateringTiming(order, LONDON);
  assert.equal(t.readySource, 'catererHandoffFoodTime');
  assert.equal(t.readyAt, '2026-09-23T18:00:00.000Z');
  assert.equal(t.fireAt, '2026-09-23T16:30:00.000Z');
  assert.equal(t.event_time, '19:30');
  assert.equal(t.ready_time, '19:00');
  const { row } = orderToQueueRow(order, PROVO, { venue: LONDON });
  assert.equal(row.customer.handoff_time, '19:00');   // venue clock, not the caterer's 14:00
});

test('no catering settings means a prep time of 0, exactly as CateringCheckout reads a blank one', () => {
  assert.equal(cateringPrepMinutes(null), 0);
  assert.equal(cateringPrepMinutes({ prep_time_minutes: '' }), 0);
  assert.equal(cateringPrepMinutes({ prep_time_minutes: 45 }), 45);
  const t = ezCateringTiming(HKX77V, { timeZone: 'Europe/London', prepMinutes: 0 });
  assert.equal(t.fireAt, '2026-09-23T18:30:00.000Z');
});

test('venue clock helpers: London in summer and winter, and a bad zone falls back to London', () => {
  assert.deepEqual(venueWallClock(Date.parse('2026-09-23T18:30:00Z'), 'Europe/London'), { date: '2026-09-23', time: '19:30', timeZone: 'Europe/London' });
  assert.deepEqual(venueWallClock(Date.parse('2026-12-01T18:30:00Z'), 'Europe/London'), { date: '2026-12-01', time: '18:30', timeZone: 'Europe/London' });
  assert.equal(venueWallClock(Date.parse('2026-09-23T23:30:00Z'), 'Europe/London').date, '2026-09-24');
  assert.equal(venueWallClock(Date.parse('2026-09-23T18:30:00Z'), 'Mars/Base').timeZone, 'Europe/London');
  assert.equal(wallTimeToInstantMs('2026-09-23', '19:30', 'Europe/London'), Date.parse('2026-09-23T18:30:00Z'));
});

// ── 3. due soon, and past the stale floor ──────────────────────────────────

test('an accepted ezCater order due in 40 minutes with 60 minutes prep fires NOW', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const order = { ...HKX77V, event: { ...HKX77V.event, timestamp: new Date(now + 40 * MIN).toISOString() } };
  const { row } = orderToQueueRow(order, PROVO, { venue: { timeZone: 'Europe/London', prepMinutes: 60 } });
  const p = queuePayload(row, true, new Date(now).toISOString());
  assert.equal(p.sent_at, new Date(now - 20 * MIN).toISOString());
  // In the live queue at once, and the release's next tick (60 s) routes it to the kitchen.
  assert.equal(isFutureCatering(p, now), false);
  assert.equal(cateringReleaseDecision(p, now, STALE_ORDER_FLOOR_MS), 'fire');
  const w = cateringReleaseWindow(now, STALE_ORDER_FLOOR_MS);
  assert.ok(p.sent_at <= w.toIso && p.sent_at >= w.fromIso, 'inside the query window the release reads');
});

test('an order whose fire moment is past the stale floor stays VISIBLE for manual release, never silently sits', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const order = { ...HKX77V, event: { ...HKX77V.event, timestamp: new Date(now + 30 * MIN).toISOString() } };
  const { row } = orderToQueueRow(order, PROVO, { venue: { timeZone: 'Europe/London', prepMinutes: 180 } });
  const p = queuePayload(row, true, new Date(now).toISOString());
  assert.equal(p.sent_at, new Date(now - 150 * MIN).toISOString());
  // Not auto fired by a till (outside the release window)...
  assert.equal(cateringReleaseDecision(p, now, STALE_ORDER_FLOOR_MS), 'stale');
  const w = cateringReleaseWindow(now, STALE_ORDER_FLOOR_MS);
  assert.ok(p.sent_at < w.fromIso);
  // ...but it is not future, so it IS in every till's live queue and the Orders Hub, and staff
  // may send it ("Send to kitchen" forces past the staleness guard).
  assert.equal(isFutureCatering(p, now), false);
  assert.equal(cateringMayFire(p), true);
  assert.equal(inAdvanceList(p), true);
});

test('an ezCater order not yet accepted in ezCater is held, visible, and says why', () => {
  const submitted = orderToQueueRow({ ...HKX77V, lifecycle: { orderIsCurrently: 'submitted' } }, PROVO, { venue: LONDON }).row;
  assert.equal(submitted.status, 'received');
  assert.equal(cateringHoldReason(submitted), 'awaiting_ezcater_acceptance');
  assert.equal(cateringMayFire(submitted), false);
  assert.equal(advanceListStatus(submitted), 'Awaiting ezCater acceptance');
  // Meal Program orders only ever send relish_finalized: committed.
  const relish = orderToQueueRow({ ...HKX77V, lifecycle: { orderIsCurrently: 'relish_finalized' } }, PROVO, { venue: LONDON }).row;
  assert.equal(cateringMayFire(relish), true);
  // A ServOS catering order has no ezCater lifecycle and is never held for one.
  assert.equal(cateringMayFire({ source: 'catering', status: 'received', customer: {} }), true);
});

// ── 4. modified and cancelled ───────────────────────────────────────────────

const NOW_ISO = '2026-09-20T09:00:00.000Z';
const heldRow = () => ({ ref: 'EZ-x', status: 'received', sent_at: '2026-09-23T17:00:00Z', kitchen_routed_at: null,
  event_date: '2026-09-23', collection_time: '19:30', customer: { ezcater_order_id: 'x', modificationCount: 0 } });

test('a changed time on an order that has NOT fired moves the fire time, date and time', () => {
  const moved = orderToQueueRow({ ...HKX77V, event: { ...HKX77V.event, timestamp: '2026-09-24T12:00:00Z' } }, PROVO, { venue: LONDON, priorAcceptedCount: 1 }).row;
  const plan = ezcaterWritePlan({ row: moved, existing: heldRow(), terminal: false, nowIso: NOW_ISO });
  assert.equal(plan.reschedule, true);
  assert.equal(plan.changedAfterFire, null);
  const p = queuePayload(plan.row, false, NOW_ISO, { reschedule: plan.reschedule });
  assert.equal(p.sent_at, '2026-09-24T10:30:00.000Z');
  assert.equal(p.event_date, '2026-09-24');
  assert.equal(p.collection_time, '13:00');
  assert.equal(p.status, 'received');   // the existing status is kept
});

test('a cancel BEFORE firing takes it off the advance list and the release never fires it', () => {
  const cancelled = orderToQueueRow({ ...HKX77V, lifecycle: { orderIsCurrently: 'cancelled' } }, PROVO, { venue: LONDON }).row;
  const plan = ezcaterWritePlan({ row: cancelled, existing: heldRow(), terminal: true, nowIso: NOW_ISO });
  assert.equal(plan.row.status, 'cancelled');
  assert.equal(plan.reschedule, false);
  assert.equal(plan.changedAfterFire, null);
  assert.equal(inAdvanceList({ ...heldRow(), status: 'cancelled' }), false);
  assert.equal(cateringMayFire(plan.row), false);
  assert.equal(cateringReleaseDecision({ ...heldRow(), status: 'cancelled' }, Date.parse('2026-09-23T17:01:00Z'), STALE_ORDER_FLOOR_MS), 'cancelled');
});

test('a change AFTER firing never moves the ticket, and is shown to staff plainly', () => {
  // The fired row carries the ezCater times it was last written with (customer.readyAt, eventAt):
  // a time change is judged against those, never against sent_at.
  const firstSeen = orderToQueueRow(HKX77V, PROVO, { venue: LONDON }).row;
  const fired = { ...heldRow(), status: 'received', kitchen_routed_at: '2026-09-23T17:00:10Z', customer: { ...firstSeen.customer, modificationCount: 0 } };
  // More items: a second accepted (ezCater has no modified event).
  const modified = orderToQueueRow(HKX77V, PROVO, { venue: LONDON, priorAcceptedCount: 1 }).row;
  const a = ezcaterWritePlan({ row: modified, existing: fired, terminal: false, nowIso: NOW_ISO });
  assert.equal(a.reschedule, false);
  assert.deepEqual(a.changedAfterFire.kinds, ['items']);
  const pa = queuePayload(a.row, false, NOW_ISO, { reschedule: a.reschedule });
  assert.equal('sent_at' in pa, false);
  assert.equal('event_date' in pa, false);
  assert.match(changedAfterFireText(a.changedAfterFire), /after it went to the kitchen: items/);
  assert.equal(advanceListStatus({ ...fired, customer: a.row.customer }), 'Changed after kitchen');

  // A new time.
  const later = orderToQueueRow({ ...HKX77V, event: { ...HKX77V.event, timestamp: '2026-09-23T19:30:00Z' } }, PROVO, { venue: LONDON }).row;
  const b = ezcaterWritePlan({ row: later, existing: fired, terminal: false, nowIso: NOW_ISO });
  assert.deepEqual(b.changedAfterFire.kinds, ['time']);
  assert.match(changedAfterFireText(b.changedAfterFire), /was 2026-09-23 19:30, now 2026-09-23 20:30/);

  // A cancel.
  const c = ezcaterWritePlan({ row: { ...later, status: 'cancelled' }, existing: fired, terminal: true, nowIso: NOW_ISO });
  assert.equal(c.row.status, 'cancelled');
  assert.deepEqual(c.changedAfterFire.kinds, ['cancelled']);
  assert.equal(inAdvanceList({ ...fired, status: 'cancelled' }), true, 'cancelled after firing stays so the kitchen can stop');

  // The till raises it once per change.
  const alert = cateringChangeAlert({ ...fired, source: 'ezcater', customer: a.row.customer }, fired);
  assert.equal(alert.alert.kind, 'changed');
  assert.equal(alert.key, `EZ-x:${NOW_ISO}`);
  assert.equal(cateringChangeAlert({ ...fired, source: 'ezcater', customer: a.row.customer }, { ...fired, customer: a.row.customer }), null);
  assert.equal(cateringChangeAlert({ ...fired, source: 'ezcater', customer: c.row.customer, status: 'cancelled' }, fired).alert.kind, 'cancel');

  // A later notification with no new change keeps the earlier change visible.
  const again = ezcaterWritePlan({ row: modified, existing: { ...fired, customer: a.row.customer }, terminal: false, nowIso: '2026-09-23T18:00:00.000Z' });
  assert.equal(again.row.customer.changedAfterFire.at, NOW_ISO);
});

test('a first sight order is written whole, and existing progress is never moved backwards', () => {
  const { row } = orderToQueueRow(HKX77V, PROVO, { venue: LONDON });
  assert.deepEqual(ezcaterWritePlan({ row, existing: null, terminal: false, nowIso: NOW_ISO }).row, row);
  const prepping = ezcaterWritePlan({ row, existing: { ...heldRow(), status: 'ready' }, terminal: false, nowIso: NOW_ISO });
  assert.equal(prepping.row.status, 'ready');
  // A venue without kitchen_routed_at cannot prove the order is unfired: nothing is moved.
  const unknown = ezcaterWritePlan({ row, existing: { ...heldRow(), kitchen_routed_at: 'unknown' }, terminal: false, nowIso: NOW_ISO });
  assert.equal(unknown.reschedule, false);
});

// ── 5. every place that treats catering specially includes ezCater ─────────

test('the till release reads every catering source, never fires a held or cancelled one, and books no ezCater courier', () => {
  const s = read('../store/index.js');
  const start = s.indexOf('releaseDueCateringOrders: async');
  const body = s.slice(start, s.indexOf('fireCourse: (courseNum)', start));
  assert.ok(body.includes(".in('source', [...CATERING_SOURCES, 'online'])"));
  assert.ok(body.includes(".not('status', 'in', '(collected,cancelled)')"));
  assert.ok(body.includes('if (!cateringMayFire(row)) continue;'));
  assert.ok(body.includes('cateringReleaseWindow(Date.now(), STALE_ORDER_FLOOR_MS)'));
  assert.ok(body.includes("row.source === 'catering' && mayBookOurCourier(row)"));
  assert.ok(!body.includes("['catering', 'online']"), 'no hand written source list left');
  // Kitchen tickets say ezCater and carry ezCater's order number.
  assert.ok(s.includes('cateringSourceLabel(order.source) || SRC_LABEL[order.source]'));
  assert.ok(s.includes('order.customer?.ezcater_order_number'));
});

test('the Back Office advance list includes ezCater and drops a cancel before firing', () => {
  const s = read('../backoffice/sections/CateringOrders.jsx');
  assert.ok(s.includes(".in('source', [...CATERING_SOURCES, 'online'])"));
  assert.ok(s.includes('.filter(inAdvanceList)'));
  assert.ok(s.includes('cateringSourceLabel(o.source)'));
});

test('QueueSync holds every future catering order out of the live queue', () => {
  const s = read('../sync/QueueSync.js');
  assert.ok(s.includes('const _isFutureCatering = (row) => keptOutOfLiveQueue(row, Date.now());'));
  assert.ok(s.includes('.or(liveQueueOrFilter(new Date().toISOString()))'));
  assert.ok(!s.includes('source.neq.catering'));
});

test('the Orders Hub treats ezCater as catering and shows the channel', () => {
  const s = read('../surfaces/OrdersHub.jsx');
  assert.ok(s.includes("const PREPAID_CHANNELS = ['online', 'kiosk', 'ezcater'];"));
  // Review round 3 (E): through the store's releaseCateringOrderNow, the release's own checks.
  assert.ok(s.includes('releaseCateringOrderNow?.(o)'));
  assert.ok(s.includes('cateringSourceLabel(viewOrder.source)'));
  assert.ok(s.includes('cateringSourceLabel(order.source).toUpperCase()'));
  assert.ok(s.includes('mayBookOurCourier({ ...viewOrder'));
  assert.ok(!/source === 'catering'/.test(s), 'no catering only test left in the hub');
});

test('the catering-release cron fires ezCater too, never a held one, and never our courier for it', () => {
  const s = read('../../supabase/functions/catering-release/index.ts');
  assert.ok(s.includes(".in('source', CATERING_SOURCES)"));
  assert.ok(s.includes(".not('status', 'in', '(collected,cancelled)')"));
  assert.ok(s.includes('if (!cateringMayFire(r)) { held++; return false; }'));
  assert.ok(s.includes('if (mayBookOurCourier(row)) {'));
  assert.ok(!s.includes(".eq('source', 'catering')"));
});

test('the webhook times the order from the venue settings and plans the write with the catering rules', () => {
  const s = read('../../supabase/functions/ezcater-webhook/index.ts');
  // The venue read and the write live in _shared/ezcaterIngest.ts, shared with the pre fire check
  // and staff re-sync, so every path writes an ezCater order the same way.
  const ing = read('../../supabase/functions/_shared/ezcaterIngest.ts');
  assert.ok(s.includes('const venue = await readCateringVenue(sb, platform, locationId);'));
  assert.ok(s.includes('await writeEzcaterOrder(sb, {'));
  assert.ok(ing.includes("from('catering_site_settings').select('prep_time_minutes')"));
  assert.ok(ing.includes("platform.from('locations').select('timezone').eq('ops_location_id', opsLocationId)"));
  assert.ok(ing.includes('venue: { timeZone: venue.timeZone, prepMinutes: venue.prepMinutes, prepFallback: !!venue.prepFallback }'));
  assert.ok(ing.includes('ezcaterWritePlan({ row: planned, existing, terminal, nowIso })'));
  assert.ok(ing.includes('{ reschedule: plan.reschedule }'));
  // It never writes kitchen_routed_at: only the release claims it. The one mention as a key is
  // the in-memory marker for a venue without the column, which is read, never written.
  assert.equal(s.split('\n').filter((l) => /kitchen_routed_at\s*:/.test(l)).length, 0);
  const keyed = ing.split('\n').filter((l) => /kitchen_routed_at\s*:/.test(l));
  assert.deepEqual(keyed.map((l) => l.trim()), [
    "return bare.data ? { ...bare.data, kitchen_routed_at: 'unknown' } : null;",
    // The pre fire result handed back to the caller: still unfired, never a write.
    'const row = { ...existing, ...w.plan.row, sent_at: w.payload.sent_at ?? existing.sent_at, kitchen_routed_at: null };',
    // The scheduled re-ask's view of the row after its write: still unfired, never a write.
    'const now = { ...existing, ...w.plan.row, sent_at: w.payload.sent_at ?? existing.sent_at, kitchen_routed_at: null };',
  ]);
  assert.equal((read('../../supabase/functions/_shared/ezcater-map.ts').match(/kitchen_routed_at\s*:/g) || []).length, 0);
});

test('capacity on our own catering site counts ezCater orders on the same day', () => {
  const s = read('../surfaces/catering/CateringSurface.jsx');
  assert.equal((s.match(/\.in\('source', CATERING_SOURCES\)/g) || []).length, 2);
});

test('CateringCheckout fires by the same shared function it always used', () => {
  const s = read('../surfaces/catering/CateringCheckout.jsx');
  assert.ok(s.includes("import { wallTimeToInstantMs, cateringFireMs, cateringPrepMinutes } from '../../lib/cateringRules';"));
  assert.ok(s.includes('const fireMs = cateringFireMs(eventMs, cateringPrepMinutes(cfg));'));
  assert.ok(!s.includes('function wallTimeToInstantMs'), 'one copy of the venue clock rule, not two');
});

test('no other catering only source test is left in the app or the edge functions', () => {
  // The two that remain are deliberate: our OWN courier on our own catering order, and
  // order-notify's "catering sends its own confirmation" (ezCater is skipped for every event
  // before that line).
  const allowed = [
    "if (row.source === 'catering' && mayBookOurCourier(row) && !isTrainingMode()) {",
    "if (event === 'confirmed' && source === 'catering') return json({ ok: true, skipped: 'catering has its own confirmation' });",
  ];
  const files = [
    '../store/index.js', '../sync/QueueSync.js', '../surfaces/OrdersHub.jsx', '../lib/realtime.js',
    '../backoffice/sections/CateringOrders.jsx', '../backoffice/sections/reports/Servers.jsx',
    '../../supabase/functions/order-notify/index.ts', '../../supabase/functions/catering-release/index.ts',
    '../../supabase/functions/ezcater-webhook/index.ts', '../../supabase/functions/_shared/ezcater-map.ts',
  ];
  for (const f of files) {
    for (const line of read(f).split('\n')) {
      if (/source\s*===\s*'catering'|\.eq\('source',\s*'catering'\)|source\.neq\.catering/.test(line)) {
        assert.ok(allowed.includes(line.trim()), `${f}: ${line.trim()}`);
      }
    }
  }
});

// ── 6. never message an ezCater customer, never book our courier ───────────

test('order-notify skips an ezCater order for every event, before anything is claimed', () => {
  assert.equal(mayMessageCustomer({ source: 'ezcater' }), false);
  assert.equal(mayMessageCustomer({ source: 'catering', customer: { ezcater_order_id: 'x' } }), false);
  assert.equal(mayMessageCustomer({ source: 'catering' }), true);
  assert.equal(mayMessageCustomer({ source: 'online' }), true);
  const s = read('../../supabase/functions/order-notify/index.ts');
  const skip = s.indexOf("if (!mayMessageCustomer(order)) return json({ ok: true, skipped: 'ezcater owns the customer' });");
  assert.ok(skip > 0);
  assert.ok(skip < s.indexOf('let claim = ledgerClaimFor(target);'), 'skipped before the ledger claim');
  assert.ok(skip < s.indexOf("if (event === 'confirmed' && source === 'catering')"));
});

test('no ServOS courier is ever booked for an ezCater delivery', async () => {
  const ez = { source: 'ezcater', type: 'delivery', customer: { delivery_mode: 'uber', ezcater_order_id: 'x' } };
  assert.equal(mayBookOurCourier(ez), false);
  assert.equal(mayBookOurCourier({ ...ez, source: 'catering' }), false, 'the ezCater id alone is enough');
  assert.equal(mayBookOurCourier({ source: 'catering', type: 'delivery', customer: { delivery_mode: 'uber' } }), true);
  assert.equal(mayBookOurCourier({ source: 'catering', type: 'collection', customer: { delivery_mode: 'uber' } }), false);
  // The client dispatcher refuses without ever calling the edge function.
  let called = 0;
  const r = await dispatchDelivery({ opsLocationId: PROVO, order: { ref: 'EZ-x', customer: ez.customer }, quote: {} }, { invoke: async () => { called++; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ezcater_order');
  assert.equal(called, 0);
  // The one server door every dispatch goes through refuses too.
  const d = read('../../supabase/functions/_shared/delivery-dispatch.ts');
  const i = d.indexOf('export async function dispatchCourier(');
  assert.ok(d.indexOf("if (isEzcaterOrder(order)) return { ok: false, reason: 'ezcater_order'", i) > i);
  assert.ok(d.indexOf("if (isEzcaterOrder(order))", i) < d.indexOf("from('courier_deliveries')", i), 'refused before anything is reserved');
});
