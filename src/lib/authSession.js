// src/lib/authSession.js: v5.8.57
//
// WHY THIS MODULE EXISTS
//
// ensureAuthToken() used to answer "no session" by minting a BRAND NEW anonymous
// user. That is correct for a device that has never had one, and catastrophic for
// a device that already has one, because auth-js reports "no session" in BOTH
// cases.
//
// The proof, from node_modules/@supabase/auth-js (2.103.0):
//
//   lib/fetch.ts:42+191  a network failure, and a 502/503/504, throw
//                        AuthRetryableFetchError.
//   GoTrueClient.ts:4624 _callRefreshToken catches that error and, because
//                        isAuthRetryableFetchError(error) is true, DOES NOT call
//                        _removeSession(). The stored session stays on disk.
//                        It returns { data: null, error }.
//   GoTrueClient.ts:2827 __loadSession sees that error and returns
//                        { data: { session: null }, error }: session NULL even
//                        though the refresh token is still sitting in storage.
//   GoTrueClient.ts:2604 getSession() returns that result verbatim.
//
// So a paired till, kiosk, menu board TV or order screen TV that hits one bad
// refresh (venue wifi drops, or Supabase Auth answers 503) gets session === null,
// signs in anonymously, and lands on a NEW auth.uid(). Every row fenced on the old
// uid: devices.device_uid, menu_board_screens.device_uid: is now invisible to it.
// Silently, permanently, until somebody re-pairs the hardware.
//
// WHAT THIS MODULE DOES
//
//   1. Retry the refresh a couple of times on a short, bounded backoff, so a
//      one-blip outage is simply ridden out and the card payment continues.
//   2. If the retries do not land, fall back to the session already in storage
//      while its access token is genuinely still valid. auth-js refreshes 90
//      seconds BEFORE real expiry (EXPIRY_MARGIN_MS in lib/constants.ts), so an
//      "expired" session usually still holds a token the server accepts. That
//      token is the device's OWN identity, which is the whole point.
//   3. Never, ever sign in anonymously while a refresh token is still in storage.
//      An anonymous session is only ever minted for a browser that genuinely has
//      no identity to lose.
//
// It returns a token or null and does not throw, because 41 call sites depend on
// ensureAuthToken and not all of them catch: see ensureAuthToken in supabase.js.
//
// Pure and injectable on purpose: authSession.test.js drives it with a fake auth
// client, so the retryable error, the revoked refresh token and the no-session
// case are all proven without a network.

/** The auth-js error name for "transient, the token is probably still good". */
export const RETRYABLE_ERROR_NAME = 'AuthRetryableFetchError';

/** Where the POS family keeps its Supabase session. */
export const DEFAULT_STORAGE_KEY = 'rpos-auth';

/**
 * Every answer resolveAuthToken can give. Reported for diagnostics so a support
 * call can tell "the device rode out a blip" apart from "the device has no
 * identity at all".
 */
export const AUTH_OUTCOMES = {
  SESSION: 'session',       // a live session was already there
  REFRESHED: 'refreshed',   // a retry of the refresh worked
  STORED: 'stored',         // refresh still failing, the device's own token is still valid
  HELD: 'held',             // refresh failing and the token has run out: hold the identity, return null
  ANONYMOUS: 'anonymous',   // no identity to lose, so a new anonymous one was minted
  BLOCKED: 'blocked',       // anonymous not allowed here (back office) and nothing else to give
  ANON_FAILED: 'anon_failed', // anonymous sign-in was allowed and itself failed
  NO_CLIENT: 'no_client',   // mock mode / no Supabase
};

/** Two short retries. The whole budget is under a second, in front of a card payment. */
export const DEFAULT_BACKOFF_MS = [250, 750];

/**
 * After a failed retry cycle, do not spend the backoff again for this long. The
 * Stripe reader poll loops call ensureAuthToken every 1.5 seconds; without this a
 * long outage would add the full backoff to every one of those ticks.
 */
export const DEFAULT_COOLDOWN_MS = 5000;

/** Do not hand out a stored token with less than this left on it. */
export const DEFAULT_TOKEN_GUARD_MS = 5000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this the transient error auth-js raises for a network failure or a 5xx?
 * Matched on the NAME, which is what auth-js's own isAuthRetryableFetchError
 * checks (lib/errors.ts:274). Never on message text.
 */
export function isRetryableAuthError(err) {
  if (!err) return false;
  if (err.name === RETRYABLE_ERROR_NAME) return true;
  // Some transports re-wrap the error; the status auth-js stamps still shows.
  return err.__isAuthError === true && err.name === RETRYABLE_ERROR_NAME;
}

/**
 * Read the session auth-js persisted. helpers.ts setItemAsync writes
 * JSON.stringify(session) straight to the storage key, so this is the whole
 * Session object. Tolerates a locked-down or full storage (Safari private mode).
 */
export function readStoredSession(storage, storageKey = DEFAULT_STORAGE_KEY) {
  try {
    const raw = storage?.getItem?.(storageKey);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    // Older auth-js wrapped the session; accept both shapes.
    const session = parsed.currentSession && typeof parsed.currentSession === 'object'
      ? parsed.currentSession
      : parsed;
    return session && typeof session === 'object' ? session : null;
  } catch {
    return null;
  }
}

/** The device still holds its own identity when a refresh token is on disk. */
export function hasStoredRefreshToken(session) {
  return typeof session?.refresh_token === 'string' && session.refresh_token.length > 0;
}

/**
 * Is the stored access token still genuinely usable? auth-js decides to refresh
 * 90 seconds before real expiry (EXPIRY_MARGIN_MS), so the token it just failed
 * to replace is very often still accepted by the server. Missing expiry counts
 * as unusable: a card call is not the place to send a token of unknown age.
 */
export function storedTokenUsable(session, { now = Date.now, guardMs = DEFAULT_TOKEN_GUARD_MS } = {}) {
  if (!session?.access_token) return false;
  const expiresAt = Number(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt * 1000 - now() > guardMs;
}

/** Shared cool-down state. Injectable so tests drive it explicitly. */
export function createRetryState() {
  return { nextRetryAt: 0, lastOutcome: null, anonymousHeldCount: 0 };
}

const moduleState = createRetryState();

async function getSessionSafe(auth) {
  try {
    const res = await auth.getSession();
    return { session: res?.data?.session || null, error: res?.error || null, threw: false };
  } catch (e) {
    // A throw out of getSession (a stalled lock, a client blow-up) is not proof
    // the refresh token is dead, so it is treated the same as a transient error.
    return { session: null, error: e, threw: true };
  }
}

async function refreshSafe(auth, refreshToken) {
  try {
    const res = await auth.refreshSession({ refresh_token: refreshToken });
    return { session: res?.data?.session || null, error: res?.error || null, threw: false };
  } catch (e) {
    return { session: null, error: e, threw: true };
  }
}

/**
 * Resolve an access token without ever swapping the device's identity.
 *
 * @param {object}   o.auth            supabase.auth (getSession, refreshSession, signInAnonymously)
 * @param {object}   o.storage         localStorage, or anything with getItem
 * @param {string}   o.storageKey      the client's storageKey
 * @param {boolean}  o.allowAnonymous  false in back office / admin
 * @returns {Promise<{token: string|null, outcome: string, error: Error|null, attempts: number}>}
 */
export async function resolveAuthToken({
  auth,
  storage,
  storageKey = DEFAULT_STORAGE_KEY,
  allowAnonymous = true,
  backoffMs = DEFAULT_BACKOFF_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  tokenGuardMs = DEFAULT_TOKEN_GUARD_MS,
  state = moduleState,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const done = (token, outcome, error = null, attempts = 0) => {
    state.lastOutcome = outcome;
    return { token: token || null, outcome, error: error || null, attempts };
  };

  if (!auth) return done(null, AUTH_OUTCOMES.NO_CLIENT);

  // 1. The ordinary path, unchanged: a live session answers immediately.
  const first = await getSessionSafe(auth);
  if (first.session?.access_token) {
    state.nextRetryAt = 0;
    return done(first.session.access_token, AUTH_OUTCOMES.SESSION);
  }

  // 2. Does this browser still hold an identity? This is the whole fence.
  let stored = readStoredSession(storage, storageKey);
  let attempts = 0;

  // 3. Ride out a short outage. Only when the device has something to protect
  //    AND the failure looks transient: a revoked token must not be retried.
  const transient = isRetryableAuthError(first.error) || first.threw;
  if (hasStoredRefreshToken(stored) && transient && now() >= (state.nextRetryAt || 0)) {
    for (const delay of backoffMs) {
      await sleep(delay);
      attempts += 1;
      const again = await refreshSafe(auth, stored.refresh_token);
      if (again.session?.access_token) {
        state.nextRetryAt = 0;
        return done(again.session.access_token, AUTH_OUTCOMES.REFRESHED, null, attempts);
      }
      // A definite refusal (revoked, reused, user deleted) will not get better.
      // auth-js has already removed the session by now (GoTrueClient.ts:4624).
      if (again.error && !isRetryableAuthError(again.error) && !again.threw) break;
    }
    state.nextRetryAt = now() + cooldownMs;
    // The retries may have cleared storage; re-read before judging identity.
    stored = readStoredSession(storage, storageKey);
  }

  // 4. Still holding a refresh token means this device still owns rows fenced on
  //    its auth.uid(). Hand back its OWN token while that token is still live,
  //    and otherwise hand back nothing. Minting a new identity here is the bug.
  if (hasStoredRefreshToken(stored)) {
    if (storedTokenUsable(stored, { now, guardMs: tokenGuardMs })) {
      return done(stored.access_token, AUTH_OUTCOMES.STORED, first.error, attempts);
    }
    state.anonymousHeldCount += 1;
    return done(null, AUTH_OUTCOMES.HELD, first.error, attempts);
  }

  // 5. No refresh token in storage: either a brand new device, or one whose
  //    token auth-js proved dead and removed. Nothing to lose, so the original
  //    anonymous sign-in behaviour stands.
  if (!allowAnonymous) return done(null, AUTH_OUTCOMES.BLOCKED, first.error, attempts);

  const anon = await auth.signInAnonymously();
  if (anon?.error) return done(null, AUTH_OUTCOMES.ANON_FAILED, anon.error, attempts);
  return done(anon?.data?.session?.access_token || null, AUTH_OUTCOMES.ANONYMOUS, null, attempts);
}

/** Last outcome, for on-device diagnostics. */
export function lastAuthOutcome() {
  return moduleState.lastOutcome;
}

/** Reset the shared cool-down. Used by tests and by a deliberate re-pair. */
export function resetAuthRetryState() {
  moduleState.nextRetryAt = 0;
  moduleState.lastOutcome = null;
  moduleState.anonymousHeldCount = 0;
}
