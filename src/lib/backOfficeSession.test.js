// src/lib/backOfficeSession.test.js
//
// LIVE, 21 Sep 2026. Peter: "the back office is logging out every time you click off the
// page, we should have it so if there is not activity for a while it logs out."
//
// It was never logging out. BackOfficeApp's auth listener re-opened the second step screen
// whenever the session's token was a password one:
//
//   if (session && isRealLogin(session) && !sessionProvesSecondStep(session)) setSecondStepOk(false);
//
// supabase-js raises an auth event when a tab comes back to the front, and again on every
// token refresh, and a password sign in keeps a password token for its whole life. So the
// test was true every single time. Nobody saw it until app_gate went on that afternoon,
// because before that the gate stepped aside instantly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shouldRegate, sessionIdOf, idleTooLong, idleSignOutMessage, IDLE_LOGOUT_MS, ACTIVITY_EVENTS } from './backOfficeSession.js';

const BO = readFileSync(new URL('../backoffice/BackOfficeApp.jsx', import.meta.url), 'utf8');

/** A session whose access token carries these claims. */
const sess = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return {
    access_token: `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`,
    // isRealLogin reads the user as well as the token, exactly as supabase-js hands it over
    user: { id: claims.sub, email: claims.email ?? null, is_anonymous: claims.is_anonymous === true },
  };
};
const password = (sid) => sess({ sub: 'u1', role: 'authenticated', email: 'a@b.c', aal: 'aal1', session_id: sid });
const withApp = (sid) => sess({ sub: 'u1', role: 'authenticated', email: 'a@b.c', aal: 'aal2', session_id: sid });

test('clicking back onto the tab does not ask again', () => {
  const s = password('sid-1');
  // before the gate has passed, the screen is right to open
  assert.equal(shouldRegate({ session: s, passedId: null }), true);
  // after it passed, the SAME sign in refreshing its token is not a step backwards
  assert.equal(shouldRegate({ session: s, passedId: 'sid-1' }), false, 'this is the bug Peter hit');
  assert.equal(sessionIdOf(s), 'sid-1');
});

test('a different sign in still has to prove itself', () => {
  assert.equal(shouldRegate({ session: password('sid-2'), passedId: 'sid-1' }), true,
    'somebody else signing in on this tab is not covered by the first one');
});

test('a passkey or an authenticator code is carried by the token, so it never re-asks', () => {
  assert.equal(shouldRegate({ session: withApp('sid-9'), passedId: null }), false);
  assert.equal(shouldRegate({ session: sess({ sub: 'u1', role: 'authenticated', email: 'a@b.c', aal: 'aal1', amr: [{ method: 'passkey' }], session_id: 's' }), passedId: null }), false);
});

test('nothing to gate is never gated', () => {
  assert.equal(shouldRegate({}), false);
  assert.equal(shouldRegate({ session: null, passedId: 'x' }), false);
  // an anonymous till session is not a Back Office sign in
  assert.equal(shouldRegate({ session: sess({ sub: 'a', role: 'authenticated', is_anonymous: true, session_id: 's' }) }), false);
  assert.equal(sessionIdOf(null), null);
  assert.equal(sessionIdOf({ access_token: 'not-a-jwt' }), null);
});

test('thirty minutes alone signs it out, and says why', () => {
  const now = Date.parse('2026-09-21T20:00:00Z');
  assert.equal(IDLE_LOGOUT_MS, 30 * 60_000);
  assert.equal(idleTooLong(now - 29 * 60_000, now), false, 'still in the room');
  assert.equal(idleTooLong(now - 30 * 60_000, now), true);
  assert.equal(idleTooLong(undefined, now), false, 'no reading is not a reason to sign anybody out');
  assert.match(idleSignOutMessage(), /30 minutes/);
  assert.match(idleSignOutMessage(), /Sign in again/);
  // a tab in the BACKGROUND is not activity: that is the whole point
  assert.ok(!ACTIVITY_EVENTS.includes('visibilitychange'));
  assert.deepEqual([...ACTIVITY_EVENTS], ['pointerdown', 'keydown', 'wheel', 'touchstart']);
});

test('the Back Office uses both rules, and remembers which sign in passed', () => {
  assert.match(BO, /if \(shouldRegate\(\{ session, passedId: passedSessionId\.current \}\)\) setSecondStepOk\(false\);/);
  assert.doesNotMatch(BO, /if \(session && isRealLogin\(session\) && !sessionProvesSecondStep\(session\)\) setSecondStepOk\(false\);/,
    'the old always-true test is gone');
  assert.match(BO, /passedSessionId\.current = sessionIdOf\(data\?\.session\);/);
  // the idle watch signs out for real, and clears the venue with it
  const idle = BO.slice(BO.indexOf('SIGNED OUT AFTER 30 MINUTES'), BO.indexOf('Load org/location context'));
  assert.match(idle, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(idle, /localStorage\.removeItem\('rpos-bo-location'\)/);
  assert.match(idle, /setInterval\(check, 60_000\)/, 'checked every minute, so a slept laptop is caught on waking');
  assert.match(idle, /for \(const ev of ACTIVITY_EVENTS\) window\.removeEventListener\(ev, touch\)/, 'listeners are let go');
});
