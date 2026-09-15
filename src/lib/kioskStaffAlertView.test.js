import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIOSK_ALERT_REF_TYPE, KIOSK_ALERT_RESTORE_MS, KIOSK_ALERT_QUEUE_MAX,
  kioskAlertEvent, isKioskStaffAlert, parseKioskAlertBody, explainKioskAlertDetail,
  normaliseKioskAlertCause, kioskAlertAge, kioskStaffAlertView, kioskAlertQueueAdd, kioskAlertQueueRemove,
  kioskAlertDetailProvesNotCharged,
} from './kioskStaffAlertView.js';
import { kioskStaffAlert } from './kioskPay.js';

// The row the owner's live test wrote on Ops (14 Sep 2026), exactly.
const REAL_BODY = 'Kiosk · £16.00 · Ref KTLDV48 · unreachable: No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office → Card readers.';
const REAL_ROW = {
  id: '7d3f0a52-0000-4000-8000-000000000001',
  location_id: 'b1c2d3e4-0000-4000-8000-000000000009',
  kind: 'ops', severity: 'urgent', title: 'Kiosk payment needs staff',
  body: REAL_BODY, ref_type: 'kiosk_payment', ref_id: 'KTLDV48',
  actor_name: null, acked_at: null, acked_by: null, created_at: '2026-09-14T12:00:00.000Z',
};
const T0 = Date.parse('2026-09-14T12:00:00.000Z');
const DASHES = /[–—]/;

const row = (over = {}) => ({ ...REAL_ROW, ...over });

test('the real row: parsed parts', () => {
  assert.deepEqual(parseKioskAlertBody(REAL_BODY), {
    deviceName: 'Kiosk', amountText: '£16.00', reference: 'KTLDV48', cause: 'unreachable',
    raw: 'No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office → Card readers.',
    truncated: false,
  });
});

test('the real row: the alert the till shows', () => {
  const v = kioskStaffAlertView(REAL_ROW, { now: T0 + 2 * 60 * 1000 });
  assert.equal(v.id, REAL_ROW.id);
  assert.equal(v.key, REAL_ROW.id);
  assert.equal(v.cause, 'unreachable');
  assert.equal(v.headline, "Kiosk can't take cards");
  assert.deepEqual(v.lines, [
    'No card reader set up for this kiosk. Set one up in Back Office, Card readers.',
    // A setup refusal from the payment server, made before any reader was asked: certain.
    'The card was not charged and the order was not placed. Put it through on a till.',
  ]);
  assert.equal(v.amountText, '£16.00');
  assert.equal(v.reference, 'KTLDV48');
  assert.equal(v.deviceName, '', 'the default name Kiosk is not repeated under the headline');
  assert.equal(v.detail, 'No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office, Card readers.');
  assert.equal(v.age, '2 min ago');
  assert.equal(v.summary, "Kiosk can't take cards. No card reader set up for this kiosk. Set one up in Back Office, Card readers. The card was not charged and the order was not placed. Put it through on a till. Order £16.00, ref KTLDV48.");
});

test('the real row also reads from the lib/activity.js event shape', () => {
  const ev = {
    id: REAL_ROW.id, kind: 'ops', severity: 'urgent', title: REAL_ROW.title, body: REAL_BODY,
    refType: 'kiosk_payment', refId: 'KTLDV48', actorName: null, ackedAt: null, ackedBy: null, createdAt: REAL_ROW.created_at,
  };
  assert.equal(isKioskStaffAlert(ev), true);
  const a = kioskStaffAlertView(ev, { now: T0 });
  const b = kioskStaffAlertView(REAL_ROW, { now: T0 });
  assert.deepEqual(a, b);
});

test('every body the kiosk writer makes parses back to what went in', () => {
  const cases = [
    { deviceName: 'Front kiosk', amountText: '£12.50', reference: 'K3F9A2C', cause: 'unconfirmed', raw: 'Timed out - customer did not complete payment within 5 minutes' },
    { deviceName: 'Bar · kiosk 2', amountText: '$1,234.00', reference: 'K000001', cause: 'notSaved', raw: 'Order submission failed. Please ask staff for help.' },
    { deviceName: 'Kiosk', amountText: '€0.30', reference: 'KABCDEF', cause: 'unreachable', raw: 'TypeError: Failed to fetch' },
    { deviceName: 'Door', amountText: '£9.99', reference: 'KZZ', cause: 'unreachable', raw: 'Reader rejected processPaymentIntent: x · y · Ref K9 · z' },
  ];
  for (const c of cases) {
    const body = kioskStaffAlert(c).body;
    assert.deepEqual(parseKioskAlertBody(body), { ...c, truncated: false }, body);
  }
});

test('a device name containing " · " stays whole', () => {
  const p = parseKioskAlertBody('Front · left · kiosk · £3.00 · Ref K1 · unconfirmed: Payment error');
  assert.equal(p.deviceName, 'Front · left · kiosk');
  assert.equal(p.amountText, '£3.00');
  assert.equal(p.reference, 'K1');
  assert.equal(p.cause, 'unconfirmed');
  assert.equal(p.raw, 'Payment error');
  assert.equal(kioskStaffAlertView(row({ body: 'Front · left · kiosk · £3.00 · Ref K1 · unconfirmed: Payment error' })).deviceName, 'Front · left · kiosk');
});

test('the 500 character slice: detail cut short is marked, the rest still parses', () => {
  const long = 'Stripe rejected PaymentIntent: ' + 'card_error '.repeat(80);
  const body = kioskStaffAlert({ deviceName: 'Front kiosk', amountText: '£16.00', reference: 'KTLDV48', cause: 'unconfirmed', raw: long }).body;
  assert.equal(body.length, 500);
  const p = parseKioskAlertBody(body);
  assert.equal(p.truncated, true);
  assert.equal(p.reference, 'KTLDV48');
  assert.equal(p.cause, 'unconfirmed');
  const v = kioskStaffAlertView(row({ body }));
  assert.equal(v.headline, 'Kiosk payment not confirmed');
  assert.ok(v.detail.endsWith('…'));
  assert.ok(v.detail.startsWith('Stripe rejected PaymentIntent: card_error'));
});

test('the 500 character slice: a huge device name cut before the reference', () => {
  const body = kioskStaffAlert({ deviceName: 'K'.repeat(520), amountText: '£16.00', reference: 'KTLDV48', cause: 'notSaved', raw: 'x' }).body;
  const p = parseKioskAlertBody(body);
  assert.equal(p.reference, '');
  assert.equal(p.amountText, '');
  const v = kioskStaffAlertView(row({ body, ref_id: 'KTLDV48' }));
  assert.equal(v.reference, 'KTLDV48', 'ref_id is the reference when the body lost it');
  assert.equal(v.cause, 'unknown');
  assert.equal(v.headline, 'Kiosk payment needs staff');
  assert.ok(v.deviceName.length <= 60 && v.deviceName.endsWith('…'));
});

test('missing parts come back empty, never undefined', () => {
  assert.deepEqual(parseKioskAlertBody(''), { deviceName: '', amountText: '', reference: '', cause: '', raw: '', truncated: false });
  assert.deepEqual(parseKioskAlertBody(null), { deviceName: '', amountText: '', reference: '', cause: '', raw: '', truncated: false });
  // amountText '' and raw '' as the writer makes them
  const p = parseKioskAlertBody(kioskStaffAlert({ amountText: '', reference: 'K1', cause: 'unreachable' }).body);
  assert.deepEqual(p, { deviceName: 'Kiosk', amountText: '', reference: 'K1', cause: 'unreachable', raw: 'no details', truncated: false });
  const v = kioskStaffAlertView(row({ body: kioskStaffAlert({ amountText: '', reference: 'K1', cause: 'unreachable' }).body, ref_id: null }));
  assert.equal(v.detail, '', '"no details" is not shown');
  assert.equal(v.amountText, '');
  assert.equal(v.reference, 'K1');
  // No detail: nothing proves the reader was never asked, so staff check before charging again.
  assert.deepEqual(v.lines, ["It couldn't reach the card reader.", 'The order was not placed. Check the card reader or the payments list before you take payment again.']);
  assert.equal(v.summary, "Kiosk can't take cards. It couldn't reach the card reader. The order was not placed. Check the card reader or the payments list before you take payment again. Ref K1.");
  // empty cause
  assert.equal(parseKioskAlertBody('Kiosk · £1.00 · Ref K1 · : oops').cause, '');
  assert.equal(parseKioskAlertBody('Kiosk · £1.00 · Ref K1 · : oops').raw, 'oops');
  // no amount part at all
  const q = parseKioskAlertBody('Front kiosk · Ref K2 · unconfirmed: e');
  assert.equal(q.deviceName, 'Front kiosk');
  assert.equal(q.amountText, '');
  // no reference part at all
  const r = parseKioskAlertBody('Front kiosk · £4.00 · notSaved: e');
  assert.deepEqual([r.deviceName, r.amountText, r.reference, r.cause, r.raw], ['Front kiosk', '£4.00', '', 'notSaved', 'e']);
  // only a cause and detail
  const s = parseKioskAlertBody('unconfirmed: The payment could not be confirmed.');
  assert.deepEqual([s.deviceName, s.cause, s.raw], ['', 'unconfirmed', 'The payment could not be confirmed.']);
  // plain text with no structure
  const t = parseKioskAlertBody('Something went wrong');
  assert.deepEqual([t.deviceName, t.cause, t.raw], ['Something went wrong', '', '']);
  // a raw message's own "Word:" is not a cause
  assert.equal(parseKioskAlertBody('Kiosk · £1.00 · Ref K1 · TypeError: Failed to fetch').cause, '');
  assert.equal(parseKioskAlertBody('Kiosk · £1.00 · Ref K1 · TypeError: Failed to fetch').raw, 'TypeError: Failed to fetch');
});

test('an unknown cause gets the safe wording: check before taking payment again', () => {
  const v = kioskStaffAlertView(row({ body: 'Kiosk · £5.00 · Ref K9 · somethingNew: boom' }));
  assert.equal(v.cause, 'unknown');
  assert.equal(v.headline, 'Kiosk payment needs staff');
  assert.deepEqual(v.lines, ['A customer at the kiosk needs help to pay.', 'Check the card reader or the payments list before you take payment again.']);
  assert.equal(v.detail, 'boom');
  assert.equal(normaliseKioskAlertCause('NOTSAVED'), 'notSaved');
  assert.equal(normaliseKioskAlertCause(undefined), 'unknown');
});

test('unconfirmed: may or may not have been charged, check before charging again (agrees with k2.card.unconfirmed)', () => {
  const body = kioskStaffAlert({ deviceName: 'Front kiosk', amountText: '£12.50', reference: 'K3F9A2C', cause: 'unconfirmed', raw: 'The payment could not be confirmed. Please ask a member of staff before trying again.' }).body;
  const v = kioskStaffAlertView(row({ body, ref_id: 'K3F9A2C' }));
  assert.equal(v.headline, 'Kiosk payment not confirmed');
  assert.deepEqual(v.lines, ['The card may or may not have been charged.', 'Check the card reader or the payments list before you take payment again.']);
  assert.equal(v.deviceName, 'Front kiosk');
  // a known reader message never replaces the money rule for unconfirmed
  const t = kioskStaffAlertView(row({ body: 'Kiosk · £1.00 · Ref K1 · unconfirmed: Timed out - customer did not complete payment within 5 minutes' }));
  assert.equal(t.lines[0], 'The card may or may not have been charged.');
  assert.equal(t.detail, 'Timed out, customer did not complete payment within 5 minutes');
});

test('notSaved: card paid, order not saved, do not charge again (agrees with k2.card.notSaved)', () => {
  const body = kioskStaffAlert({ deviceName: 'Front kiosk', amountText: '£22.40', reference: 'KA1B2C3', cause: 'notSaved', raw: 'Order submission failed. Please ask staff for help.' }).body;
  const v = kioskStaffAlertView(row({ body, ref_id: 'KA1B2C3' }));
  assert.equal(v.headline, 'Kiosk order not saved');
  assert.deepEqual(v.lines, ['The card was paid but the order did not save.', 'Put the order through on a till. Do not charge the card again.']);
  assert.equal(v.summary, 'Kiosk order not saved. The card was paid but the order did not save. Put the order through on a till. Do not charge the card again. Order £22.40, ref KA1B2C3.');
});

test('known technical messages in plain words', () => {
  assert.equal(explainKioskAlertDetail('No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office → Card readers.'), 'No card reader set up for this kiosk. Set one up in Back Office, Card readers.');
  assert.equal(explainKioskAlertDetail('No card terminal is available. Assign one to this kiosk in Back Office → Kiosks → Settings → Card terminal.'), 'No card reader set up for this kiosk. Set one up in Back Office, Kiosks, Settings.');
  assert.equal(explainKioskAlertDetail('2 card readers at this venue and none is set to this till. In Back Office, Card readers, choose which till each reader takes payments from.'), 'No card reader is set to this kiosk. Choose one in Back Office, Card readers.');
  assert.equal(explainKioskAlertDetail('Reader rejected processPaymentIntent: offline. Confirm the reader is online and connected to power.'), 'The card reader did not answer. Check it is switched on and online.');
  assert.equal(explainKioskAlertDetail('Merchant account cannot accept charges yet'), 'Card payments are not set up for this venue yet.');
  assert.equal(explainKioskAlertDetail('Kiosk device ID missing — re-pair this kiosk.'), 'This kiosk needs to be paired again.');
  assert.equal(explainKioskAlertDetail('TypeError: Failed to fetch'), 'The kiosk could not connect to the internet.');
  assert.equal(explainKioskAlertDetail('Load failed'), 'The kiosk could not connect to the internet.');
  assert.equal(explainKioskAlertDetail('Could not obtain auth token'), 'The kiosk could not sign in to take card payments.');
  assert.equal(explainKioskAlertDetail('Payment error'), '');
  assert.equal(explainKioskAlertDetail(''), '');
  assert.equal(explainKioskAlertDetail(undefined), '');
});

test('the details line never shows a dash or arrow as punctuation', () => {
  const v = kioskStaffAlertView(row({ body: 'Kiosk · £1.00 · Ref K1 · unreachable: Kiosk device ID missing — re-pair this kiosk. See Back office → Kiosks – Settings' }));
  assert.equal(v.detail, 'Kiosk device ID missing, re-pair this kiosk. See Back office, Kiosks, Settings');
  assert.equal(v.lines[0], 'This kiosk needs to be paired again.');
});

test('none of the staff words use a dash as punctuation', () => {
  const bodies = ['unreachable', 'unconfirmed', 'notSaved', 'other'].map(c => `Kiosk · £1.00 · Ref K1 · ${c}: No network reader is assigned`);
  for (const body of bodies) {
    const v = kioskStaffAlertView(row({ body }));
    for (const s of [v.headline, ...v.lines, v.summary, v.age]) assert.ok(!DASHES.test(s) && !/\s-\s/.test(s), s);
  }
  for (const raw of ['No card terminal is available', 'none is set to this till', 'reader rejected', 'no adyen account', 'device id missing', 'invalid token', 'failed to fetch', 'timed out']) {
    const s = explainKioskAlertDetail(raw);
    assert.ok(s && !DASHES.test(s) && !/\s-\s/.test(s), s);
  }
});

test('nothing throws, whatever it is given', () => {
  const weird = [undefined, null, 0, 42, 'text', [], {}, { body: 123 }, { body: {} }, { ref_type: 'kiosk_payment', body: '·'.repeat(600) },
    { ref_type: 'kiosk_payment', body: ' · Ref  ·  · Ref ' }, { ref_type: 'kiosk_payment', created_at: 'not a date' },
    Object.create(null), { get body() { throw new Error('boom'); } }];
  for (const w of weird) {
    assert.doesNotThrow(() => kioskStaffAlertView(w));
    assert.doesNotThrow(() => parseKioskAlertBody(w));
    assert.doesNotThrow(() => kioskAlertQueueAdd([], w));
    const v = kioskStaffAlertView(w);
    assert.equal(typeof v.headline, 'string');
    assert.ok(Array.isArray(v.lines) && v.lines.length === 2);
  }
  for (const b of [' · Ref ', 'Ref ', ' · ', ':', ' · Ref K1 · ', '£', '· Ref · · :', '\u00a0', 'Ref K1']) assert.doesNotThrow(() => parseKioskAlertBody(b));
  assert.equal(kioskAlertEvent('x'), null);
  assert.equal(kioskAlertEvent({ get id() { throw new Error('boom'); } }), null);
});

test('only ref_type kiosk_payment is a kiosk alert (temperature, loyalty and bookings stay toasts)', () => {
  assert.equal(KIOSK_ALERT_REF_TYPE, 'kiosk_payment');
  assert.equal(isKioskStaffAlert(REAL_ROW), true);
  assert.equal(isKioskStaffAlert(row({ ref_type: 'temperature', title: 'Temperature breach' })), false);
  assert.equal(isKioskStaffAlert(row({ ref_type: null })), false);
  assert.equal(isKioskStaffAlert({ severity: 'urgent', title: 'Kiosk payment needs staff' }), false);
  assert.equal(isKioskStaffAlert(null), false);
});

test('age in plain words', () => {
  assert.equal(kioskAlertAge(REAL_ROW.created_at, T0 + 5000), 'just now');
  assert.equal(kioskAlertAge(REAL_ROW.created_at, T0 - 60000), 'just now', 'a till clock behind the server');
  assert.equal(kioskAlertAge(REAL_ROW.created_at, T0 + 14 * 60000), '14 min ago');
  assert.equal(kioskAlertAge(REAL_ROW.created_at, T0 + 3 * 3600000), '3 hr ago');
  assert.equal(kioskAlertAge(REAL_ROW.created_at, T0 + 26 * 3600000), '1 day ago');
  assert.equal(kioskAlertAge(null, T0), '');
  assert.equal(kioskAlertAge('garbage', T0), '');
});

test('queue: a new alert joins, the same alert again changes nothing', () => {
  const q1 = kioskAlertQueueAdd([], REAL_ROW, { now: T0 });
  assert.equal(q1.length, 1);
  assert.equal(q1[0].key, REAL_ROW.id);
  assert.equal(kioskAlertQueueAdd(q1, REAL_ROW, { now: T0 }), q1, 'same array back');
  assert.equal(kioskAlertQueueAdd(q1, row({ ref_type: 'temperature', id: 'other' }), { now: T0 }), q1);
});

test('queue: oldest first, newest never lost, capped by dropping the oldest', () => {
  let q = [];
  q = kioskAlertQueueAdd(q, row({ id: 'b', created_at: '2026-09-14T12:02:00Z' }), { now: T0 + 180000 });
  q = kioskAlertQueueAdd(q, row({ id: 'a', created_at: '2026-09-14T12:01:00Z' }), { now: T0 + 180000 });
  q = kioskAlertQueueAdd(q, row({ id: 'c', created_at: '2026-09-14T12:03:00Z' }), { now: T0 + 180000 });
  assert.deepEqual(q.map(x => x.id), ['a', 'b', 'c']);
  let big = [];
  for (let i = 0; i < KIOSK_ALERT_QUEUE_MAX + 5; i++) {
    big = kioskAlertQueueAdd(big, row({ id: `id${i}`, created_at: new Date(T0 + i * 1000).toISOString() }), { now: T0 + 60000 });
  }
  assert.equal(big.length, KIOSK_ALERT_QUEUE_MAX);
  assert.equal(big[big.length - 1].id, `id${KIOSK_ALERT_QUEUE_MAX + 4}`);
  assert.equal(big[0].id, 'id5');
  // a row with no created_at still shows (after the dated ones)
  const nd = kioskAlertQueueAdd(q, row({ id: 'nodate', created_at: null }), { now: T0 });
  assert.deepEqual(nd.map(x => x.id), ['a', 'b', 'c', 'nodate']);
});

test('queue: an acknowledgement anywhere removes it; a dismissed alert never comes back here', () => {
  const q = kioskAlertQueueAdd([], REAL_ROW, { now: T0 });
  const acked = row({ acked_at: '2026-09-14T12:05:00Z', acked_by: 'Jane' });
  assert.deepEqual(kioskAlertQueueAdd(q, acked, { now: T0 }), []);
  assert.deepEqual(kioskAlertQueueAdd([], acked, { now: T0 }), [], 'an acknowledged row never joins');
  const dismissed = new Set([REAL_ROW.id]);
  assert.deepEqual(kioskAlertQueueAdd([], REAL_ROW, { now: T0, dismissed }), []);
  assert.deepEqual(kioskAlertQueueRemove(q, REAL_ROW.id), []);
  assert.equal(kioskAlertQueueRemove(q, 'nope'), q);
  assert.equal(kioskAlertQueueRemove(q, null), q);
});

test('queue: an update to a waiting alert replaces it in place', () => {
  let q = kioskAlertQueueAdd([], row({ id: 'a', created_at: '2026-09-14T12:01:00Z' }), { now: T0 });
  q = kioskAlertQueueAdd(q, row({ id: 'b', created_at: '2026-09-14T12:02:00Z' }), { now: T0 });
  const q2 = kioskAlertQueueAdd(q, row({ id: 'a', created_at: '2026-09-14T12:01:00Z', body: 'Kiosk · £1.00 · Ref K2 · notSaved: x' }), { now: T0 });
  assert.deepEqual(q2.map(x => x.id), ['a', 'b']);
  assert.equal(q2[0].body, 'Kiosk · £1.00 · Ref K2 · notSaved: x');
});

test('queue: older than the restore window does not join', () => {
  const old = row({ id: 'old', created_at: new Date(T0 - KIOSK_ALERT_RESTORE_MS - 1000).toISOString() });
  assert.deepEqual(kioskAlertQueueAdd([], old, { now: T0 }), []);
  const edge = row({ id: 'edge', created_at: new Date(T0 - KIOSK_ALERT_RESTORE_MS + 1000).toISOString() });
  assert.equal(kioskAlertQueueAdd([], edge, { now: T0 }).length, 1);
  // but an alert already on screen is still updated (and removed) after the window
  const q = kioskAlertQueueAdd([], edge, { now: T0 });
  assert.deepEqual(kioskAlertQueueAdd(q, { ...edge, acked_at: 'x' }, { now: T0 + KIOSK_ALERT_RESTORE_MS * 3 }), []);
});

test('queue: a row with no id still gets a stable key', () => {
  const r = row({ id: null });
  const q = kioskAlertQueueAdd([], r, { now: T0 });
  assert.equal(q.length, 1);
  assert.equal(q[0].key, 'kiosk:KTLDV48:2026-09-14T12:00:00.000Z');
  assert.equal(kioskAlertQueueAdd(q, r, { now: T0 }), q);
});

test('unreachable says "not charged" ONLY for a setup refusal made before any reader was asked', () => {
  const CHECK = 'The order was not placed. Check the card reader or the payments list before you take payment again.';
  const SAFE = 'The card was not charged and the order was not placed. Put it through on a till.';
  const action = (raw) => kioskStaffAlertView(row({ body: `Kiosk · £5.00 · Ref K1 · unreachable: ${raw}` })).lines[1];
  // Setup refusals the payment server returns before it asks any processor or reader for money.
  for (const raw of [
    'No network reader is assigned to this POS terminal. Ask an admin to assign one in Back office → Card readers.',
    'No card terminal is available. Assign one to this kiosk in Back Office → Kiosks → Settings → Card terminal.',
    '2 card readers at this venue and none is set to this till.',
    'Merchant account cannot accept charges yet',
    'Kiosk device ID missing — re-pair this kiosk.',
  ]) assert.equal(action(raw), SAFE, raw);
  // The start call may have reached the server and armed the reader before these happened.
  for (const raw of [
    'TypeError: Failed to fetch', 'Load failed', 'Request timed out', 'Could not obtain auth token', 'Unauthorized',
    'Reader rejected processPaymentIntent: offline. Confirm the reader is online and connected to power.',
    'Payment error', 'no details', '',
  ]) assert.equal(action(raw), CHECK, raw || '(empty)');
  // A cause that is not unreachable never says it, even with a setup message.
  for (const c of ['unconfirmed', 'other']) {
    assert.notEqual(kioskStaffAlertView(row({ body: `Kiosk · £5.00 · Ref K1 · ${c}: No network reader is assigned` })).lines[1], SAFE);
  }
  assert.equal(kioskAlertDetailProvesNotCharged('No network reader is assigned'), true);
  assert.equal(kioskAlertDetailProvesNotCharged('Failed to fetch'), false);
  assert.equal(kioskAlertDetailProvesNotCharged(undefined), false);
});

test('notSaved with nothing charged on a card (codes covered it) never mentions a card payment', () => {
  const v = kioskStaffAlertView(row({ body: 'Kiosk · £0.00 · Ref K1 · notSaved: Order submission failed.' }));
  assert.deepEqual(v.lines, ['The order did not save. Nothing was charged on a card.', 'Put the order through on a till.']);
  for (const amount of ['$0.00', '€0,00', '0.00']) {
    assert.equal(kioskStaffAlertView(row({ body: `Kiosk · ${amount} · Ref K1 · notSaved: x` })).lines[0], 'The order did not save. Nothing was charged on a card.', amount);
  }
  // Any real amount keeps the card was paid wording; no amount at all too (not proven zero).
  assert.equal(kioskStaffAlertView(row({ body: 'Kiosk · £0.40 · Ref K1 · notSaved: x' })).lines[0], 'The card was paid but the order did not save.');
  assert.equal(kioskStaffAlertView(row({ body: 'Kiosk ·  · Ref K1 · notSaved: x' })).lines[0], 'The card was paid but the order did not save.');
});
