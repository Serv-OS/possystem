// src/lib/staffInvite.test.js
//
// The staff app invite must be sendable more than once, and from the screen where
// somebody is actually onboarding a person.
//
// LIVE, 21 Sep 2026. Peter onboarded two people and neither got an email. The records
// say exactly why: the invite fired ONCE, inside "Start onboarding", and only when the
// record already carried an email.
//
//   Tom Davies   email already on the record   -> invited 19:22:24, expires 28 Sep
//   neil test 1  email added 19:15:51, after   -> never invited
//   Alex Carter  email added 19:16:36, after   -> never invited
//
// Adding the email a minute later is what anybody does when they are setting a person
// up, and there was then no way to send the invite at all: no button, no retry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { inviteState, inviteLive } from './staffInvite.js';

const NOW = Date.parse('2026-09-21T19:30:00Z');
const SCREEN = readFileSync(new URL('../backoffice/sections/workforce/WfOnboarding.jsx', import.meta.url), 'utf8');
const DATA = readFileSync(new URL('../staff/wfData.js', import.meta.url), 'utf8');

test('the three people from that evening each get the right offer', () => {
  // Tom: invited, and the invite is still good
  const tom = { email: 'peter+tom@serv-os.app', portalInviteExpires: '2026-09-28T19:22:24Z' };
  assert.equal(inviteState(tom, NOW).kind, 'sent');
  assert.equal(inviteState(tom, NOW).can, true, 'and it can still be sent again');
  assert.match(inviteState(tom, NOW).hint, /28 Sept?/);

  // Neil and Alex: an email, no invite ever. This is the case that had no way out.
  const neil = { email: 'neil@serv-os.app' };
  assert.equal(inviteState(neil, NOW).kind, 'ready');
  assert.equal(inviteState(neil, NOW).can, true);
  assert.equal(inviteState(neil, NOW).label, 'Send app invite');
});

test('no email is a clear instruction, not a dead button', () => {
  const s = inviteState({ name: 'Lucy' }, NOW);
  assert.equal(s.kind, 'no_email');
  assert.equal(s.can, false);
  assert.match(s.hint, /add one in Staff/i);
  assert.equal(inviteState({ email: '   ' }, NOW).kind, 'no_email', 'whitespace is not an email');
});

test('somebody who already has the app is not offered an invite', () => {
  const s = inviteState({ email: 'a@b.c', portalUserId: 'u1', portalInviteExpires: '2026-09-28T00:00:00Z' }, NOW);
  assert.equal(s.kind, 'has_app');
  assert.equal(s.can, false, 'sending again would only confuse them');
});

test('an expired invite can be sent again, and says so', () => {
  const s = inviteState({ email: 'a@b.c', portalInviteExpires: '2026-09-14T00:00:00Z' }, NOW);
  assert.equal(s.kind, 'expired');
  assert.equal(s.can, true);
  assert.match(s.hint, /run out/);
  assert.equal(inviteLive({ portalInviteExpires: '2026-09-14T00:00:00Z' }, NOW), false);
  assert.equal(inviteLive({ portalInviteExpires: '2026-09-28T00:00:00Z' }, NOW), true);
  assert.equal(inviteLive({}, NOW), false, 'never invited is not a live invite');
});

test('the button is on the onboarding card, and the screen can see the invite state', () => {
  assert.match(SCREEN, /<StaffAppInvite member=\{member\} showToast=\{showToast\} onSent=\{onStaffChanged\} \/>/);
  const cmp = SCREEN.slice(SCREEN.indexOf('function StaffAppInvite'), SCREEN.indexOf('function OfferAction'));
  assert.match(cmp, /await wf\.sendPortalInvite\(member\.id\)/);
  assert.match(cmp, /disabled=\{busy \|\| !state\.can\}/, 'no email means no press');
  assert.match(cmp, /onSent\?\.\(\)/, 'and the card refreshes so it shows as sent');
  // the state has to reach the screen at all: these two columns were not loaded before
  assert.match(DATA, /portalUserId: r\.portal_user_id \|\| null,/);
  assert.match(DATA, /portalInviteExpires: r\.portal_invite_expires \|\| null,/);
  assert.match(DATA, /portal_user_id,portal_invite_expires,created_at/);
  // and the token hash is NOT one of them
  assert.doesNotMatch(DATA, /portal_invite_hash/, 'the secret never leaves the server');
});
