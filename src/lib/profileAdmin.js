// src/lib/profileAdmin.js
//
// The browser side of the profile-admin edge function (18 Sep 2026, lockdown step 1).
//
// A login's venue (user_profiles.location_id), company (org_id) and Back Office access
// (bo_access) are no longer written from the browser: migration 20260918c takes those columns
// away from it, because any login could point any profile at any venue and become staff there.
// The Back Office screens that change them call profile-admin, which decides on the server.
//
// Two rules:
//   * Only the Back Office user's OWN signed in session is sent. This never calls
//     ensureAuthToken() or signs anybody in: the Back Office must never get an anonymous session
//     (the 6 Aug "shifts RLS" incident), so no session, or an anonymous one, is a clear error.
//   * While profile-admin is not deployed yet (the platform answers 404 without our fn marker),
//     `legacy` runs the old direct table write, which still works until the migration runs. A
//     refusal FROM profile-admin is never retried the old way.

/**
 * The venue the Staff screen works on: the login's opening venue, else the venue Back Office is
 * on. It used to WRITE the first venue of the org onto the profile when none was set; the
 * browser can no longer write that column, and it never needed to.
 */
export function staffScreenLocation(profile, activeLocationId) {
  const fromProfile = profile?.location_id || null;
  if (fromProfile) return String(fromProfile);
  if (activeLocationId && activeLocationId !== 'loc-demo') return String(activeLocationId);
  return null;
}

/** Is this reply "the function does not exist yet" (not a refusal from profile-admin)? */
export function profileAdminMissing(status, body) {
  return status === 404 && !(body && body.fn === 'profile-admin');
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

/**
 * Call profile-admin. `deps` = { functionsUrl, getSession, fetchImpl }. `legacy` (optional) runs
 * the old direct write when the function is not deployed yet. Resolves to the reply body, or
 * throws with the server's plain words.
 */
export async function callProfileAdmin(action, body, deps, legacy) {
  const { functionsUrl, getSession, fetchImpl = fetch } = deps || {};
  const token = await backOfficeToken(getSession);
  let res; let j = null;
  try {
    res = await fetchImpl(`${functionsUrl}/profile-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...(body || {}) }),
    });
    j = await res.json().catch(() => null);
  } catch (e) {
    throw new Error(`Could not reach the server: ${e?.message || e}`);
  }
  if (profileAdminMissing(res.status, j)) {
    if (typeof legacy === 'function') return legacy();
    throw new Error('This needs the latest server update (profile-admin). Try again shortly.');
  }
  if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);
  return j;
}
