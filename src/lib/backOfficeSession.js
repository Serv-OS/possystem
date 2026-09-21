// src/lib/backOfficeSession.js
//
// WHEN THE BACK OFFICE ASKS AGAIN, AND WHEN IT LETS GO.
//
// LIVE, 21 Sep 2026. Peter: "the back office is logging out every time you
// click off the page, we should have it so if there is not activity for a
// while it logs out."
//
// It was not logging out. BackOfficeApp's auth listener held this line:
//
//   if (session && isRealLogin(session) && !sessionProvesSecondStep(session))
//     setSecondStepOk(false);
//
// and supabase-js raises an auth event when a tab comes back to the front, and
// again on every token refresh. A sign in made with a PASSWORD keeps a password
// token for its whole life, so that test is true every single time: click away,
// click back, and the second step screen is in front of you again. Nobody
// noticed until app_gate went on this afternoon, because before that the gate
// stepped aside instantly.
//
// The rule it wanted is "this sign in went BACKWARDS", not "this sign in is a
// password one". A sign in that has already proved itself in this tab has
// proved itself, and the auth server's own session_id says whether it is still
// the same sign in, across every refresh.
//
// AND WHAT PETER ASKED FOR. A Back Office left open on a counter should not
// stay open for ever. Thirty minutes with no mouse, no key and no touch signs
// it out properly, which is the behaviour he was describing when he thought the
// tab switch was doing it.
//
// The gate is UX; the fence is the database (second_step_settings.enforce).
// Nothing here is a security boundary, so none of it is remembered anywhere a
// browser could be told to lie about it: the tab's own memory only, which is
// why a reload asks again.

import { decodeJwtClaims, isRealLogin, sessionProvesSecondStep } from './secondStep/rules.js';

/** How long the Back Office may sit untouched before it signs itself out. */
export const IDLE_LOGOUT_MS = 30 * 60_000;

/** The events that count as somebody being here. */
export const ACTIVITY_EVENTS = Object.freeze(['pointerdown', 'keydown', 'wheel', 'touchstart']);

/** The auth server's id for this sign in. Stable across token refreshes. */
export function sessionIdOf(session) {
  const claims = decodeJwtClaims(session?.access_token);
  const id = claims?.session_id;
  return id ? String(id) : null;
}

/**
 * Must the second step screen open for this auth event?
 *
 * @param {object} p
 * @param {object} p.session          the session the event carried
 * @param {string|null} p.passedId    the session id that already passed in this tab
 */
export function shouldRegate({ session, passedId } = {}) {
  if (!session || !isRealLogin(session)) return false;
  // A passkey or an authenticator code is carried by the token itself: done.
  if (sessionProvesSecondStep(session)) return false;
  const id = sessionIdOf(session);
  // The same sign in that already passed, one token refresh later. Asking again
  // is what made clicking back onto the tab look like being logged out.
  if (id && passedId && id === passedId) return false;
  return true;
}

/** Has the Back Office been left alone long enough to sign itself out? */
export function idleTooLong(lastActivityAt, now = Date.now(), limitMs = IDLE_LOGOUT_MS) {
  const last = Number(lastActivityAt);
  if (!Number.isFinite(last)) return false;
  return now - last >= limitMs;
}

/** "You were signed out after 30 minutes of inactivity." in plain words. */
export function idleSignOutMessage(limitMs = IDLE_LOGOUT_MS) {
  const mins = Math.round(limitMs / 60_000);
  return `Signed out after ${mins} minutes without activity. Sign in again to carry on.`;
}
