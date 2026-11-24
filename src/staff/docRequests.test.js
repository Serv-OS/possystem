// src/staff/docRequests.test.js (5.12.89): which documents a team member is asked to send again,
// and the words for it. Shared by staff-portal and the Back Office.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestReason, docRequestsFor, requestWords, rejectNoteProblem, cleanNote, requestEmail, docFileName } from '../../supabase/functions/_shared/docRequests.js';

const TODAY = '2026-11-23';

test('why a document is asked for again', () => {
  assert.equal(requestReason({ status: 'rejected' }, TODAY), 'rejected');
  assert.equal(requestReason({ status: 'pending', requested_at: '2026-11-20' }, TODAY), null);       // just sent: never nagged
  assert.equal(requestReason({ status: 'valid', expiry: '2026-11-22', file_url: 'a' }, TODAY), 'expired');
  assert.equal(requestReason({ status: 'valid', expiry: '2026-11-23', file_url: 'a' }, TODAY), null); // expires today: still good
  assert.equal(requestReason({ status: 'valid', file_url: 'a', requested_at: '2026-11-20' }, TODAY), 'requested');
  assert.equal(requestReason({ status: 'missing', requested_at: '2026-11-20' }, TODAY), 'missing');
  assert.equal(requestReason({ status: 'valid', file_url: 'a' }, TODAY), null);
  assert.equal(requestReason({ status: 'missing' }, TODAY), null);                                    // never asked
  assert.equal(requestReason(null, TODAY), null);
});

test('the staff app list: refused first, with the reason the manager typed', () => {
  const list = docRequestsFor([
    { id: 'a', type: 'foodHygieneL2', status: 'valid', expiry: '2026-01-01', file_url: 'x' },
    { id: 'b', type: 'RTW', status: 'rejected', review_note: '  The photo is blurred  ' },
    { id: 'c', type: 'SIA', status: 'pending' },
    { id: 'd', type: 'firstAid', status: 'valid', file_url: 'x' },
  ], TODAY);
  assert.deepEqual(list, [
    { id: 'b', type: 'RTW', reason: 'rejected', note: 'The photo is blurred' },
    { id: 'a', type: 'foodHygieneL2', reason: 'expired', note: null },
  ]);
  assert.deepEqual(docRequestsFor(null, TODAY), []);
});

test('a rejection needs a reason', () => {
  assert.ok(rejectNoteProblem(''));
  assert.ok(rejectNoteProblem('no'));
  assert.equal(rejectNoteProblem('The photo is blurred'), null);
  assert.ok(rejectNoteProblem('x'.repeat(501)));
  assert.equal(cleanNote('  two   spaces \n here '), 'two spaces here');
});

test('the words name the document', () => {
  assert.equal(requestWords('rejected', 'Right to Work').title, 'Your Right to Work was not accepted');
  assert.equal(requestWords('expired', 'Form I-9').title, 'Your Form I-9 has expired');
  assert.match(requestWords('requested', 'Right to Work').title, /again/);
  assert.match(requestWords('missing', 'SIA licence').title, /Please upload your SIA licence/);
});

test('the email carries the reason and never raw HTML from a manager', () => {
  const m = requestEmail({ first: 'Sam', label: 'Right to Work', reason: 'rejected', note: 'Use your <b>passport</b> & not a bill', url: 'https://app.example/?mode=staff', venueName: 'H Mall' });
  assert.equal(m.subject, 'Your Right to Work was not accepted');
  assert.ok(m.html.includes('&lt;b&gt;passport&lt;/b&gt; &amp; not a bill'));
  assert.ok(!m.html.includes('<b>passport</b>'));
  assert.ok(m.text.includes('Your manager said: Use your <b>passport</b> & not a bill'));
  assert.ok(m.text.includes('https://app.example/?mode=staff'));
  assert.ok(m.html.includes('at H Mall'));
  // No reason typed (a plain Resend): no empty box.
  assert.ok(!requestEmail({ first: 'Sam', label: 'Right to Work', reason: 'requested', url: 'u' }).html.includes('Your manager said'));
});

test('stored file names keep identity papers private (20261121a reads the name)', () => {
  const identity = /(^|\/)(RTW|rtw|I9|i9|passport|visa|id)-[0-9]+\.[A-Za-z0-9]+$/;
  assert.ok(identity.test(`loc/staff/${docFileName('RTW', 1700000000000, 'JPG')}`));
  assert.ok(identity.test(`loc/staff/${docFileName('I9', 1700000000000, 'pdf')}`));
  assert.ok(!identity.test(`loc/staff/${docFileName('foodHygieneL2', 1700000000000, 'pdf')}`));
  assert.equal(docFileName('../evil', 5, 'p/d.f'), 'evil-5.pdf');
});

import { askedWords } from '../../supabase/functions/_shared/docRequests.js';
test('the Back Office toast says what the person was actually told', () => {
  assert.equal(askedWords({ name: 'Sam Jones', rejected: true, answer: { emailed: true, hasLogin: true, kept: true } }), 'Rejected. Sam has been emailed. It is in their staff app, under Tasks.');
  assert.match(askedWords({ name: 'Sam Jones', answer: { emailed: false, hasLogin: false }, hasEmail: false }), /no email on file, so tell them yourself\. It will show in their staff app once they have a login\./);
  assert.match(askedWords({ name: 'Sam', answer: { emailed: false, hasLogin: true }, hasEmail: true }), /did not send/);
  assert.match(askedWords({ name: 'Sam', answer: { emailed: true, hasLogin: true, kept: false } }), /database update has not been run/);
});
