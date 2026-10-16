// guestMessageWords.test.js: what the Inspector says about each guest message (16 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNudge, failureWords, messageLine, hasGuestContact, hasCrmRecord, confirmResultWords } from './guestMessageWords.js';

const hhmm = (d) => d.toISOString().slice(11, 16);

test('shouldNudge: a live booking with a phone or an email, never a walk in', () => {
  assert.equal(shouldNudge({ id: 'b', source: 'host', status: 'confirmed', customer: { phone: '+447700900001' } }), true);
  assert.equal(shouldNudge({ id: 'b', source: 'pos', customer: { email: 'a@b.co' } }), true);
  assert.equal(shouldNudge({ id: 'b', source: 'walk_in', customer: { phone: '+447700900001' } }), false);
  assert.equal(shouldNudge({ id: 'b', source: 'host', customer: {} }), false);
  assert.equal(shouldNudge({ id: 'b', source: 'widget', status: 'pending_payment', customer: { phone: '1' } }), false);
  assert.equal(shouldNudge(null), false);
});

test('failureWords: provider codes in words a host can act on', () => {
  assert.equal(failureWords('send-sms_http_502: The To number is not a valid phone number. (21211)'), 'the number is not a valid mobile');
  assert.equal(failureWords('send-sms_http_502: (21610) unsubscribed'), 'the guest replied STOP');
  assert.equal(failureWords('email_provider_not_configured_(log)'), 'email sending is not set up');
  assert.equal(failureWords('send-sms_http_503'), 'the message service did not answer');
  assert.equal(failureWords(''), 'unknown reason');
});

test('messageLine: sent, retrying, given up, and rows from before the migration', () => {
  assert.deepEqual(messageLine({ kind: 'confirmation', channel: 'sms', status: 'sent', sent_at: '2026-10-16T14:02:00Z' }, hhmm),
    { title: 'Confirmation by text', tone: 'ok', text: 'Sent 14:02' });
  assert.deepEqual(messageLine({ kind: 'reminder_day', channel: 'email', sent_at: '2026-10-16T10:00:00Z' }, hhmm).text, 'Sent 10:00');
  const retry = messageLine({ kind: 'reminder_2h', channel: 'sms', status: 'failed', attempts: 1, last_error: 'send-sms_http_503', next_try_at: '2026-10-16T14:20:00Z' }, hhmm);
  assert.equal(retry.tone, 'wait');
  assert.equal(retry.text, 'Not sent (the message service did not answer). Trying again at 14:20');
  const gaveUp = messageLine({ kind: 'cancelled', channel: 'sms', status: 'failed', attempts: 3, last_error: '(21211)' }, hhmm);
  assert.deepEqual(gaveUp, { title: 'Cancellation by text', tone: 'bad', text: 'Not sent: the number is not a valid mobile (tried 3 times)' });
  for (const k of ['confirmation', 'reminder_day', 'reminder_2h', 'changed', 'cancelled', 'preorder']) {
    assert.doesNotMatch(messageLine({ kind: k, channel: 'sms', status: 'failed', attempts: 2, last_error: 'x' }, hhmm).text + messageLine({ kind: k }).title, /[\u2013\u2014]/);
  }
});

// 17 Oct 2026 (v5.11.73, PR 295 follow up): Send confirmation when only the CRM record has the contact.
const CRM = '3f2b8c1e-9a4d-4c2e-8f1a-5b6c7d8e9f01';

test('a guest record counts as a way to reach the guest: the booking with no phone or email is still sent', () => {
  const b = { id: 'b', source: 'host', status: 'confirmed', customer: { name: 'Sam' }, customerId: CRM };
  assert.equal(hasCrmRecord(b), true);
  assert.equal(hasGuestContact(b), true);
  assert.equal(shouldNudge(b), true, 'the stand button and the booking nudge both call booking-reminders');
  assert.equal(shouldNudge({ ...b, customerId: null, customer_id: CRM }), true, 'snake case row too');
  // No record and nothing on the booking: still nothing to send.
  assert.equal(shouldNudge({ ...b, customerId: null }), false);
  // A made up id is not a guest record.
  assert.equal(hasCrmRecord({ customerId: 'cus-1' }), false);
  // A walk in or a booking waiting for payment still never is.
  assert.equal(shouldNudge({ ...b, source: 'walk_in' }), false);
  assert.equal(shouldNudge({ ...b, status: 'pending_payment' }), false);
});

test('confirmResultWords: says what really went, by text and by email', () => {
  assert.deepEqual(confirmResultWords({ ok: true, sent: ['sms', 'email'], results: { sms: { sent: true }, email: { sent: true } } }),
    { tone: 'success', text: 'Confirmation sent by text and email.' });
  // The phone came from the guest record, the email is missing everywhere.
  assert.deepEqual(confirmResultWords({ ok: true, sent: ['sms'], results: { sms: { sent: true }, email: { sent: false, reason: 'no_email_on_booking' } } }),
    { tone: 'success', text: 'Confirmation sent by text.' });
  assert.deepEqual(confirmResultWords({ ok: true, sent: [], results: { sms: { sent: false, reason: 'already_sent_(ledger)' }, email: { sent: false, reason: 'no_email_on_booking' } } }),
    { tone: 'info', text: 'Already sent by text, not sent twice.' });
  assert.deepEqual(confirmResultWords({ ok: true, sent: [], results: { sms: { sent: false, reason: 'no_phone_on_booking' }, email: { sent: false, reason: 'no_email_on_booking' } } }),
    { tone: 'info', text: 'Not sent: no phone or email on the booking or the guest record.' });
  const bad = confirmResultWords({ ok: true, sent: [], results: { sms: { sent: false, reason: 'send-sms_http_502: (21211)' } } });
  assert.deepEqual(bad, { tone: 'error', text: 'The text did not go: the number is not a valid mobile.' });
  const mixed = confirmResultWords({ ok: true, sent: ['email'], results: { email: { sent: true }, sms: { sent: false, reason: 'turned_off_in_message_templates' } } });
  assert.equal(mixed.tone, 'success');
  assert.equal(mixed.text, 'Confirmation sent by email. The text did not go: this message is switched off in Message templates.');
  assert.equal(confirmResultWords({ ok: false, error: 'pending_payment_not_confirmable' }).tone, 'info');
  assert.match(confirmResultWords({ ok: false, error: 'walk_in' }).text, /walk in/);
  assert.match(confirmResultWords({ ok: false, error: 'unknown_or_closed' }).text, /closed/);
  assert.deepEqual(confirmResultWords({ ok: false, error: 'the server could not be reached' }),
    { tone: 'error', text: 'Confirmation NOT sent (the server could not be reached). Try again.' });
  assert.equal(confirmResultWords(null).tone, 'error');
  for (const r of [{ ok: true, sent: ['sms'] }, { ok: false, error: 'x' }, null]) assert.doesNotMatch(confirmResultWords(r).text, /[\u2013\u2014]/);
});

test('the Inspector button waits for the answer and uses the one contact rule', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../surfaces/bookings/GuestMessages.jsx', import.meta.url), 'utf8');
  assert.match(src, /await sendConfirmation\(/);
  assert.match(src, /confirmResultWords\(res\)/);
  assert.match(src, /const hasContact = hasGuestContact\(b\)/);
  assert.doesNotMatch(src, /Asked to send the confirmation/);
});
