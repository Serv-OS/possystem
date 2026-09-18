// src/lib/profileAdmin.js
//
// The browser side of the profile-admin edge function (18 Sep 2026, lockdown step 1).
//
// A login's venue (user_profiles.location_id), company (org_id) and Back Office access
// (bo_access) are no longer written from the browser: migration 20260918d takes those columns
// away from it, because any login could point any profile at any venue and become staff there.
// The Back Office screens that change them call profile-admin, which decides on the server.
//
// Two rules:
//   * Only the Back Office user's OWN signed in session is sent. This never calls
//     ensureAuthToken() or signs anybody in: the Back Office must never get an anonymous session
//     (the 6 Aug "shifts RLS" incident), so no session, or an anonymous one, is a clear error.
//   * There is NO fallback to the old direct table write (review round four, item 7). It could
//     never run when it mattered: a function that is not deployed answers with the gateway's 404,
//     which carries no CORS headers, so the browser sees a network error, not a 404. And after
//     20260918d the old write is refused anyway. The deploy order is therefore: migration,
//     profile-admin (and the other functions), THEN the app. A network error says plainly that
//     the server could not be reached or is not updated yet, and nothing is changed.

/**
 * The venue the Staff screen works on: the venue Back Office is on (the switcher's choice), else
 * the login's opening venue. Never writes anything (the browser cannot write the profile venue).
 */
export function staffScreenLocation(profile, activeLocationId) {
  if (activeLocationId && activeLocationId !== 'loc-demo') return String(activeLocationId);
  const fromProfile = profile?.location_id || null;
  return fromProfile ? String(fromProfile) : null;
}

/** The Back Office user's own access token, or an error. Never mints a session. */
export async function backOfficeToken(getSession) {
  const res = await getSession();
  const session = res?.data?.session || null;
  const u = session?.user || null;
  if (!session?.access_token || !u) throw new Error('Sign in to Back Office first');
  if (u.is_anonymous) throw new Error('This screen needs a Back Office login, not a device session. Sign in again.');
  return session.access_token;
}

export const PROFILE_ADMIN_UNREACHABLE =
  'Could not reach the server (profile-admin). Check the connection and try again; if it keeps happening the server update has not been deployed yet. Nothing was changed.';

/**
 * Call profile-admin. `deps` = { functionsUrl, getSession, fetchImpl }. Resolves to the reply
 * body, or throws with the server's plain words. Never falls back to a table write.
 */
export async function callProfileAdmin(action, body, deps) {
  const { functionsUrl, getSession, fetchImpl = fetch } = deps || {};
  const token = await backOfficeToken(getSession);
  let res; let j = null;
  try {
    res = await fetchImpl(`${functionsUrl}/profile-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...(body || {}) }),
    });
  } catch {
    // A missing function looks exactly like this in a browser (the 404 has no CORS headers).
    throw new Error(PROFILE_ADMIN_UNREACHABLE);
  }
  j = await res.json().catch(() => null);
  if (!(j && j.fn === 'profile-admin')) {
    // Not our reply (a gateway error page, or a 404 seen from a non browser caller).
    throw new Error(res.ok ? PROFILE_ADMIN_UNREACHABLE : `${PROFILE_ADMIN_UNREACHABLE} (HTTP ${res.status})`);
  }
  if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
