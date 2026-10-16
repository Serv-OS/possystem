// guestMessageWords.test.js: what the Inspector says about each guest message (16 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNudge, failureWords, messageLine } from './guestMessageWords.js';

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
