/** purchasingRules.test.js — Order pad and Orders screen pure rules. Run: `npm test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDay, normDeliveryDays, coverDaysFromSchedule, nextDeliveryYmd, packContent,
  suggestPacks, cleanFnError, createOrdersToast,
} from './purchasingRules.js';

test('normDay: day names, ISO numbers and JS numbers all read as the same day', () => {
  assert.equal(normDay('tue'), 'tue');
  assert.equal(normDay('Thursday'), 'thu');
  assert.equal(normDay(1), 'mon');          // ISO Monday
  assert.equal(normDay('6'), 'sat');
  assert.equal(normDay(7), 'sun');          // ISO Sunday
  assert.equal(normDay(0), 'sun');          // JS Sunday
  assert.equal(normDay(9), null);
  assert.equal(normDay('yesterday'), null);
  assert.equal(normDay(null), null);
  // the demo seed wrote [1,2,3,4,5,6]: six working days, no Sunday
  assert.deepEqual(normDeliveryDays([1, 2, 3, 4, 5, 6]), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.deepEqual(normDeliveryDays(['tue', 'thu', 'sat']), ['tue', 'thu', 'sat']);
  assert.deepEqual(normDeliveryDays('tue'), []);
});

test('coverDaysFromSchedule: covers to the SECOND upcoming delivery, numbers behave like names', () => {
  // today Thursday (4); deliveries Tue/Thu → next Tue is +5, the Thu after is +7
  assert.equal(coverDaysFromSchedule(['tue', 'thu'], 4), 7);
  assert.equal(coverDaysFromSchedule([2, 4], 4), 7);           // same schedule as integers
  // daily Mon..Sat on a Thursday: Fri +1, Sat +2
  assert.equal(coverDaysFromSchedule([1, 2, 3, 4, 5, 6], 4), 2);
  // one delivery a week → the single hit
  assert.equal(coverDaysFromSchedule(['mon'], 4), 11);
  assert.equal(coverDaysFromSchedule([], 4), null);
  assert.equal(coverDaysFromSchedule(null, 4), null);
  assert.equal(coverDaysFromSchedule(['noday'], 4), null);
});

test('nextDeliveryYmd: first delivery day from tomorrow; no schedule means tomorrow', () => {
  // 2026-10-15 is a Thursday
  assert.equal(nextDeliveryYmd(['tue', 'thu'], '2026-10-15'), '2026-10-20');
  assert.equal(nextDeliveryYmd([2, 4], '2026-10-15'), '2026-10-20');
  assert.equal(nextDeliveryYmd([1, 2, 3, 4, 5, 6], '2026-10-15'), '2026-10-16');
  assert.equal(nextDeliveryYmd(['thu'], '2026-10-15'), '2026-10-22');  // today does not count
  assert.equal(nextDeliveryYmd([], '2026-10-15'), '2026-10-16');
  assert.equal(nextDeliveryYmd(null, '2026-10-31'), '2026-11-01');      // month roll
  assert.equal(nextDeliveryYmd(['mon'], 'not-a-date'), null);
});

test('packContent: a case of 6 x 2 l is 12 l, a bag of 48 is 48', () => {
  assert.equal(packContent({ packQty: 6, innerQty: 2 }), 12);
  assert.equal(packContent({ packQty: 1, innerQty: 48 }), 48);
  assert.equal(packContent({ innerQty: 5 }), 5);            // missing packQty reads as 1
  assert.equal(packContent({ packQty: 6, innerQty: 0 }), null);
  assert.equal(packContent(null), null);
});

test('suggestPacks: usage over cover minus on hand minus on order, rounded up to packs', () => {
  // flat average: 23.25 buns a day, 8 day cover, 30 on hand, nothing on order, packs of 48
  const a = suggestPacks({ onHand: 30, onOrder: 0, avgDaily: 23.25, coverDays: 7, safetyDays: 1, perPack: 48 });
  assert.equal(a.effCover, 8);
  assert.equal(a.needBase, 186 - 30);
  assert.equal(a.suggestedPacks, 4);          // 156 / 48 = 3.25 → 4
  assert.equal(a.covered, false);
  // the same item once those 4 packs are on order: nothing more to buy, and the rule says why
  const b = suggestPacks({ onHand: 30, onOrder: 192, avgDaily: 23.25, coverDays: 7, safetyDays: 1, perPack: 48 });
  assert.equal(b.suggestedPacks, 0);
  assert.equal(b.covered, true);
  // case items: 6 x 2 l milk, need 60 l → 5 cases, not 30
  const c = suggestPacks({ onHand: 44, onOrder: 0, avgDaily: 13, coverDays: 7, safetyDays: 1, perPack: packContent({ packQty: 6, innerQty: 2 }) });
  assert.equal(c.needBase, 104 - 44);
  assert.equal(c.suggestedPacks, 5);
  // weekday profile walks the real days starting tomorrow (today Thu = 4)
  const prof = [0, 10, 0, 0, 0, 50, 50];      // Sun..Sat: busy Fri and Sat, a little Monday
  const d = suggestPacks({ onHand: 0, avgDaily: 0, profile: prof, todayDow: 4, coverDays: 3, safetyDays: 0, perPack: 10 });
  assert.equal(d.expectedBase, 100);          // Fri 50 + Sat 50 + Sun 0
  assert.equal(d.suggestedPacks, 10);
  // no history: top up to par
  const e = suggestPacks({ onHand: 3, onOrder: 0, avgDaily: 0, par: 10, perPack: 1 });
  assert.equal(e.suggestedPacks, 7);
  // no history and no par: nothing to say
  const f = suggestPacks({ onHand: 3, avgDaily: 0, perPack: 1 });
  assert.equal(f.suggestedPacks, 0);
  assert.equal(f.covered, false);
  // no pack on file: never suggests
  assert.equal(suggestPacks({ onHand: 0, avgDaily: 5, perPack: null }).suggestedPacks, 0);
});

test('cleanFnError: peels po-send and the mail provider down to one plain sentence', () => {
  const resend = 'email failed: {"error":"send failed: Invalid `to` field. Please use our testing email address instead of domains like `example.com`."}';
  assert.equal(cleanFnError(resend), 'Invalid to field. Please use our testing email address instead of domains like example.com.');
  assert.equal(cleanFnError({ error: 'supplier_has_no_email' }), 'supplier_has_no_email');
  assert.equal(cleanFnError('Edge Function returned a non-2xx status code'), 'send failed');
  assert.equal(cleanFnError('Edge Function returned a non-2xx status code', 'could not send'), 'could not send');
  assert.equal(cleanFnError(null), 'send failed');
  assert.equal(cleanFnError(''), 'send failed');
  assert.equal(cleanFnError('{"error":"PO has no lines"}'), 'PO has no lines');
  assert.equal(cleanFnError('not authorized for location x'), 'not authorized for location x');
});

test('createOrdersToast: says what happened in plain words', () => {
  assert.equal(createOrdersToast({ created: 2, emailed: 2, failed: [] }), '2 orders created and emailed to the suppliers. See Orders for delivery.');
  assert.equal(createOrdersToast({ created: 1, emailed: 1, failed: [] }), '1 order created and emailed to the supplier. See Orders for delivery.');
  const t = createOrdersToast({ created: 3, emailed: 2, failed: [{ supplier: 'Bakehouse', reason: 'email failed: {"error":"send failed: Invalid `to` field."}' }] });
  assert.equal(t, '3 orders created. Email to Bakehouse did not send: Invalid to field. The order is saved; open it in Orders and press Resend to supplier.');
  assert.match(createOrdersToast({ created: 1, emailed: 0, failed: [{ supplier: null, reason: null }] }), /Email to 1 supplier did not send: send failed/);
});
