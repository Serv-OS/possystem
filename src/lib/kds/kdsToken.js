// src/lib/kds/kdsToken.js
//
// 12 Oct 2026, Coffee Boy Barnsley (K8): the hourly sign in renewal could not reach the server for
// 3.5 minutes. Inside the Supabase client every request first asks for the session under one lock,
// and while the renewal holds that lock every other request waits behind it with no time limit
// (auth-js 2.103.0 GoTrueClient _acquireLock, pendingInLock). Bump 33 was tapped at 14:53:19 and
// reached the database at 14:56:56, in the very next transaction after the renewal. The device's
// token was still valid for the first two of those minutes.
//
// The kitchen screen's own ticket reads and writes therefore take their token straight from where
// the client keeps it (the same key, the same token: the device's OWN identity) while it is still
// valid, and only ask the client, and so wait, once it has truly run out. Nothing else changes:
// same token, same row level security, same fallback when there is no session.
//
// Pure: storage and the client are handed in.

import { readStoredSession, storedTokenUsable } from '../authSession.js';

/** Never hand out a stored token with less than this left: a request can wait a little before it leaves. */
export const KITCHEN_TOKEN_GUARD_MS = 10000;

/**
 * The token source for the kitchen screen client (lib/supabase.js kitchenClient, the supabase-js
 * `accessToken` option).
 *   storage, storageKey  where auth-js keeps this device's session (localStorage, AUTH_STORAGE_KEY)
 *   sessionToken()       asks the main client: resolves its access token or null (this may wait behind a renewal)
 * Resolves the token, or null (the client then sends the public key, exactly as the main client
 * does today when it holds no session).
 */
export function kitchenTokenSource({ storage, storageKey, sessionToken, now = Date.now, guardMs = KITCHEN_TOKEN_GUARD_MS } = {}) {
  return async () => {
    const stored = readStoredSession(storage, storageKey);
    if (storedTokenUsable(stored, { now, guardMs })) return stored.access_token;
    try { return (await sessionToken()) || null; } catch { return null; }
  };
}
