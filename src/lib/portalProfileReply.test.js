// src/lib/portalProfileReply.test.js
//
// The loyalty portal takes the joined account the moment update_profile joins it (27 Sep 2026).
// Peter: "I don't want a merge tool, I want it so when someone signs up it auto merges their
// records ... it knows the record exists and just adds them together." The server answers a join
// with a fresh session in verify's shape; the portal must switch to it at once (or the member
// keeps looking at the empty profile their phone made), and must never show an email as saved
// when the server kept it off the account. Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readProfileReply, customerAfterSave, isSignInAgain } from './portalProfileReply.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const joinedReply = {
  updated: true, joined: true, email_saved: true, verified: true,
  message: 'We found your stamps and points under that email and added them to this account.',
  token: 'tok.abc',
  customer: { id: 'ela', name: 'Ela Stettner', email: 'elastettner@hotmail.com', phone: '+447415748167' },
  loyalty: { member_code: 'SRV-Q43HGG', points_balance: 45 },
  gift_cards: [],
  stamp_cards: [{ id: 'p', stamps_collected: 2 }],
};

test('a joined reply hands the portal the joined account\'s session', () => {
  const r = readProfileReply(joinedReply);
  assert.equal(r.joined, true);
  assert.equal(r.session.token, 'tok.abc');
  assert.equal(r.session.customer.id, 'ela');
  assert.equal(r.session.loyalty.points_balance, 45);
  assert.deepEqual(r.session.stampCards, [{ id: 'p', stamps_collected: 2 }]);
  assert.deepEqual(r.session.giftCards, []);
  assert.equal(r.emailSaved, true);
  assert.match(r.notice, /stamps and points/);
});

test('a join without a token or a customer is not taken (the member keeps the session they have)', () => {
  assert.equal(readProfileReply({ ...joinedReply, token: '' }).joined, false);
  assert.equal(readProfileReply({ ...joinedReply, customer: null }).joined, false);
  assert.equal(readProfileReply({ ...joinedReply, joined: 'yes' }).joined, false);
  assert.equal(readProfileReply(null).joined, false);
});

test('an email kept off the account is never shown as saved, and the reason is shown', () => {
  const refused = { updated: true, email_saved: false, code: 'email_in_use', message: 'That email is already on another loyalty account with a different phone number, so it was not added here.' };
  const r = readProfileReply(refused);
  assert.deepEqual([r.joined, r.session, r.emailSaved], [false, null, false]);
  assert.match(r.notice, /different phone number/);
  const prev = { id: 'blank', name: '', email: null, phone: '+447415748167' };
  assert.deepEqual(customerAfterSave(prev, { name: 'Jo S', email: 'jo_smith@example.com' }, r), { ...prev, name: 'Jo S', email: null });
});

test('a plain save (and an older server with no email_saved) shows the typed details', () => {
  const prev = { id: 'blank', name: '', email: 'old@example.com' };
  const r = readProfileReply({ updated: true, email_saved: true });
  assert.deepEqual(customerAfterSave(prev, { name: 'Ela', email: 'new@example.com' }, r), { id: 'blank', name: 'Ela', email: 'new@example.com' });
  assert.equal(readProfileReply({ updated: true }).emailSaved, true, 'before this change the reply had no email_saved');
  assert.deepEqual(customerAfterSave(prev, { name: 'Ela', email: null }, r), { id: 'blank', name: 'Ela', email: 'old@example.com' }, 'an empty box keeps the one shown');
});

test('sign in again is told apart from every other error', () => {
  const e = new Error('Please sign in again with your phone number.');
  e.code = 'sign_in_again';
  assert.equal(isSignInAgain(e), true);
  assert.equal(isSignInAgain(new Error('Invalid or expired session')), false);
  assert.equal(isSignInAgain(null), false);
});

test('the portal wires it: every save sends its venue, takes the joined session, keys the form on the profile', () => {
  const src = read('../surfaces/customer/CustomerPortal.jsx');
  assert.ok(src.includes("import { readProfileReply, customerAfterSave, isSignInAgain } from '../../lib/portalProfileReply';"));
  // All three update_profile calls (sign up after the code, the name screen, the Profile tab).
  const saves = src.split("action: 'update_profile',").length - 1;
  assert.equal(saves, 3);
  assert.equal(src.split('location_id: location.ops_location_id || location.id,').length - 1, 3 + 2, 'the 3 saves and the 2 code sends name the venue');
  // The joined session is stored like a fresh sign in.
  const apply = src.slice(src.indexOf('const applyProfileReply = '), src.indexOf('// ── Verify OTP'));
  assert.ok(apply.includes('setToken(reply.session.token);'));
  assert.ok(apply.includes('storeSession(reply.session.token, location.company_id);'));
  assert.ok(apply.includes('setCustomer(reply.session.customer);'));
  assert.ok(apply.includes('setStampCards(reply.session.stampCards);'));
  // The register flow no longer claims an email the server kept off.
  assert.ok(!src.includes('email: regData.email || c?.email,'));
  assert.ok(src.includes('setCustomer(c => customerAfterSave(c, { name: regData.name, email: regData.email }, reply));'));
  // After a join the Profile form starts again from the joined account.
  assert.ok(src.includes("<ProfileTab key={customer?.id || 'me'}"));
  // The error code reaches the screens.
  assert.ok(src.includes('err.code = data?.code || null;'));
});
