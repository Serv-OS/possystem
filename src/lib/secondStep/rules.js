// src/lib/secondStep/rules.js
//
// THE BACK OFFICE SECOND SIGN IN STEP: pure rules (docs/SECOND_STEP.md).
// No React, no network, no browser globals: every decision here is unit tested
// (src/lib/secondStep/rules.test.js). The screens (components/secondStep/*) and the
// auth calls (./client.js) only follow what these functions answer.
//
// WORDS: "aal1" = the login has only typed a password. "aal2" = it also did Face ID,
// fingerprint or an authenticator app code. Anonymous sessions (tills, kiosks, KDS, TVs,
// customer pages) are never asked for anything.

/** Peter sets the same minimum in Supabase (runbook step 1). Every password form uses this. */
export const MIN_PASSWORD_LENGTH = 12;

/** The code an edge function or the database answers with when a password only login is refused. */
export const SECOND_STEP_CODE = 'second_step_required';

/** Shown as the account name inside the authenticator app. */
export const TOTP_ISSUER = 'ServOS';

/**
 * Face ID and fingerprint (WebAuthn) are bound to ONE domain per Supabase project. Dev and live
 * share the Ops project, so the domain is serv-os.app and these are the origins Peter lists in
 * Supabase (runbook step 1). Anywhere else (possystem-liard.vercel.app, venue subdomains, the Sunmi
 * till app) offers the authenticator app code only. Change this list and the Supabase setting together.
 */
export const WEBAUTHN_RP_ID = 'serv-os.app';
export const WEBAUTHN_HOSTS = ['app.serv-os.app', 'dev.serv-os.app', 'stage.serv-os.app'];

/**
 * Our own apps wrap the web app in a WebView. Face ID there needs native changes that are not
 * built yet (iOS Associated Domains, Android androidx.webkit): until then they use the code.
 *   RposIOS/        the eight iOS apps (ios/ServOSPOS/WebView.swift)
 *   RposAndroid/    the eight Android webshell apps (android/webshell ShellActivity.java)
 *   RestaurantOS/   the Sunmi till app and the old iOS wrapper
 *   RPOS-iOS/       the old iOS wrapper
 *   ServOS-MPOS/, ServOS-MenuBoard/   the older single purpose Android apps
 */
const IN_APP_UA = /RposIOS\/|RposAndroid\/|RestaurantOS\/|RPOS-iOS\/|ServOS-MPOS\/|ServOS-MenuBoard\/|\bSunmi\b/i;

export function isInAppShell(userAgent) {
  return IN_APP_UA.test(String(userAgent || ''));
}

/** The claims inside a JWT, without checking the signature (the server checks it). */
export function decodeJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A person who signed in with a password (not a till, kiosk or customer session). */
export function isRealLogin(session) {
  const user = session?.user;
  if (!user || user.is_anonymous) return false;
  const claims = decodeJwtClaims(session?.access_token);
  return !(claims && (claims.is_anonymous === true || claims.is_anonymous === 'true'));
}

/** 'aal2', 'aal1', or null when there is no session. Read from the access token. */
export function sessionAal(session) {
  if (!session?.access_token) return null;
  const claims = decodeJwtClaims(session.access_token);
  return claims?.aal === 'aal2' ? 'aal2' : 'aal1';
}

/**
 * PASSKEYS (20 Sep 2026). A passkey sign in is a FIRST factor, so the session is aal1, however
 * strong it is. What proves it is the token's own 'amr' claim: the list of methods this session
 * was authenticated with. The database rule reads the same thing
 * (public.second_step_session_passkey, 20260920p), so the screens and the fence agree.
 * The names match public.second_step_settings.passkey_methods; keep the two lists together.
 */
export const PASSKEY_AMR_METHODS = Object.freeze(['webauthn', 'passkey', 'webauthn_credential']);

/** Did THIS session sign in with a passkey? */
export function sessionUsedPasskey(session, methods = PASSKEY_AMR_METHODS) {
  const claims = decodeJwtClaims(session?.access_token);
  const amr = claims?.amr;
  if (!Array.isArray(amr)) return false;
  const want = new Set((methods || []).map((m) => String(m).toLowerCase()));
  return amr.some((e) => want.has(String(typeof e === 'string' ? e : e?.method || '').toLowerCase()));
}

/**
 * Has this session done a second step at all? Either an MFA factor was verified (aal2) or it
 * signed in with a passkey. Anything that used to ask "is this aal2" asks this instead, or a
 * passkey sign in would be sent round the second step loop for ever.
 */
export function sessionProvesSecondStep(session) {
  return sessionAal(session) === 'aal2' || sessionUsedPasskey(session);
}

export function verifiedFactors(factors) {
  return (Array.isArray(factors) ? factors : []).filter((f) => f && f.status === 'verified');
}

export function hasVerified(factors, type) {
  return verifiedFactors(factors).some((f) => f.factor_type === type);
}

/**
 * What the sign in screen must do next.
 *   'none'      no real login (signed out, or an anonymous till session): nothing to ask
 *   'ok'        let them in
 *   'challenge' they have a second step: ask for it (Face ID first where it works, else the code)
 *   'setup'     they have none yet: set up the authenticator app (cannot skip), then offer Face ID
 *   'backup'    they passed, but have no authenticator app: add one before going in (the backup
 *               that works everywhere, including our apps and the Sunmi tills)
 * mode 'recovery' (the password reset link): only a login that HAS a second step must pass it
 * before choosing a new password (the auth server insists too); nothing is set up mid reset.
 * appGate false is Peter's break glass (second_step_settings.app_gate): let everyone in.
 */
export function gateStep({ session, factors, appGate = true, mode = 'login' } = {}) {
  if (!isRealLogin(session)) return 'none';
  if (appGate === false) return 'ok';
  const aal = sessionAal(session);
  const verified = verifiedFactors(factors);
  // A PASSKEY SIGN IN IS DONE (20 Sep 2026). It is aal1 by design, and asking such a person for
  // an authenticator code as well would be asking twice and would strand anyone without one.
  const passkey = sessionUsedPasskey(session);
  if (mode === 'recovery') {
    if (aal === 'aal2' || passkey || verified.length === 0) return 'ok';
    return 'challenge';
  }
  if (passkey) return 'ok';
  if (aal === 'aal2') return hasVerified(verified, 'totp') ? 'ok' : 'backup';
  return verified.length ? 'challenge' : 'setup';
}

/**
 * The fast path at page load: a login already at aal2 whose stored session shows an
 * authenticator app goes straight in, with no network call. Anything else asks the server.
 */
export function passesWithoutNetwork(session) {
  if (!isRealLogin(session)) return false;
  // A passkey session carries its own proof in the token, so it never waits on a call.
  if (sessionUsedPasskey(session)) return true;
  return sessionAal(session) === 'aal2' && hasVerified(session?.user?.factors, 'totp');
}

/** The domain Face ID is bound to for this page, or null when Face ID cannot work here. */
export function rpIdFor(hostname, { allowLocalhost = false } = {}) {
  const h = String(hostname || '').toLowerCase();
  if (WEBAUTHN_HOSTS.includes(h)) return WEBAUTHN_RP_ID;
  if (allowLocalhost && h === 'localhost') return 'localhost';
  return null;
}

/** Plain words for the platform's biometric. */
export function faceIdLabel(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(ua)) return 'Face ID or Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  if (/Android/i.test(ua)) return 'fingerprint';
  return 'Face ID or fingerprint';
}

/**
 * Can this page offer Face ID or fingerprint?
 *   reason 'host'    this web address is not one Face ID is set up for (use the code)
 *   reason 'app'     inside our own app (native changes still to come; use the code)
 *   reason 'browser' this browser has no Face ID support
 *   reason 'device'  this device has no Face ID, Touch ID, Windows Hello or fingerprint set up
 */
export function faceIdSupport({ hostname, userAgent, hasWebAuthn, platformAuthenticator, allowLocalhost = false } = {}) {
  const label = faceIdLabel(userAgent);
  if (!rpIdFor(hostname, { allowLocalhost })) return { usable: false, reason: 'host', label };
  if (isInAppShell(userAgent)) return { usable: false, reason: 'app', label };
  if (!hasWebAuthn) return { usable: false, reason: 'browser', label };
  if (!platformAuthenticator) return { usable: false, reason: 'device', label };
  return { usable: true, reason: 'ok', label };
}

const newestFirst = (a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));

/**
 * How to ask for the second step.
 *   faceIdFactorId  the Face ID factor to challenge (any one works: the server offers ALL of the
 *                   login's Face ID credentials); null when Face ID cannot be used here
 *   codeFactorIds   authenticator app factors, newest first (a code is tried against each)
 *   primary         'faceid' | 'code' | 'faceid_elsewhere' (only Face ID, which this place cannot use)
 */
export function challengePlan({ factors, faceIdUsable = false, preferredFaceIdFactorId = null } = {}) {
  const verified = verifiedFactors(factors);
  const face = verified.filter((f) => f.factor_type === 'webauthn').sort(newestFirst);
  const codes = verified.filter((f) => f.factor_type === 'totp').sort(newestFirst);
  // FACE ID FIRST ONLY ON THE DEVICE IT WAS SET UP ON (fix round, 20 Sep 2026). A Face ID
  // credential belongs to ONE device. An owner who added it on their iPhone and then signs in on
  // a Windows PC used to get "Use Windows Hello" as the big button, a prompt that cannot work,
  // and had to find the small "use a code" link. This device is the one that remembered the
  // factor id when it was added (rememberedFaceIdFactor), so only THAT one comes first; any
  // other Face ID stays available as a link, in case the browser can still reach it.
  const remembered = face.find((f) => f.id === preferredFaceIdFactorId) || null;
  const anyFace = remembered || face[0] || null;
  const faceIdFactorId = faceIdUsable && anyFace ? anyFace.id : null;
  let primary = 'code';
  if (faceIdUsable && remembered) primary = 'faceid';
  else if (!codes.length && face.length) primary = 'faceid_elsewhere';
  return { faceIdFactorId, codeFactorIds: codes.map((f) => f.id), primary };
}

/** Digits only, at most 6 (people paste "123 456" or "123-456"). */
export function normaliseCode(input) {
  return String(input || '').replace(/\D/g, '').slice(0, 6);
}

export function isCodeComplete(code) {
  return /^\d{6}$/.test(String(code || ''));
}

/** The authenticator secret in groups of four, for typing by hand. */
export function formatSecret(secret) {
  return String(secret || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** A friendly name the auth server has not seen for this login (it refuses duplicates). */
export function friendlyName(kind, existingNames = [], now = new Date()) {
  const base = kind === 'webauthn' ? 'Face ID or fingerprint' : 'Authenticator app';
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const taken = new Set((existingNames || []).map((n) => String(n || '').toLowerCase()));
  let name = `${base} (${day})`;
  for (let i = 2; taken.has(name.toLowerCase()) && i < 100; i++) name = `${base} (${day}, ${i})`;
  return name;
}

/** What the settings page shows for a factor. */
export function factorLabel(f) {
  if (!f) return '';
  const kind = f.factor_type === 'webauthn' ? 'Face ID or fingerprint' : f.factor_type === 'totp' ? 'Authenticator app' : 'Second step';
  const added = f.created_at ? new Date(f.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return added ? `${kind}, added ${added}` : kind;
}

/**
 * May this factor be removed from the settings page?
 * The auth server needs aal2 to remove a verified factor. We also keep at least one
 * authenticator app: it is the backup that works everywhere, and without it a lost phone
 * means asking an owner or ServOS for a reset.
 */
export function removalCheck({ factors, factorId, aal } = {}) {
  const verified = verifiedFactors(factors);
  const f = verified.find((x) => x.id === factorId);
  if (!f) return { ok: false, reason: 'That second step was not found. Refresh the page.' };
  if (aal !== 'aal2') return { ok: false, reason: 'Confirm it is you first: sign out and sign in again.' };
  if (f.factor_type === 'totp' && verified.filter((x) => x.factor_type === 'totp').length <= 1) {
    return { ok: false, reason: 'This is your only authenticator app. Add another one first, so you can always sign in.' };
  }
  return { ok: true, reason: '' };
}

/** Unverified factors left behind by an abandoned set up (safe to remove at aal1). */
export function leftoverFactorIds(factors, type) {
  return (Array.isArray(factors) ? factors : [])
    .filter((f) => f && f.status !== 'verified' && (!type || f.factor_type === type))
    .map((f) => f.id);
}

/** Is this error or response body a second step refusal from our server? */
export function isSecondStepRefusal(errOrBody) {
  if (!errOrBody) return false;
  const code = errOrBody.code || errOrBody?.context?.code || '';
  const msg = String(errOrBody.message || errOrBody.error || '');
  return code === SECOND_STEP_CODE || errOrBody.second_step === true || /second_step_required/.test(msg);
}

/** Password check shared by every Back Office password form. Null when fine. */
export function passwordProblem(password, confirm) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters. A short sentence is easy to remember.`;
  if (confirm !== undefined && p !== confirm) return 'The two passwords do not match.';
  return null;
}

/** Plain words for anything the auth server or the browser throws at us. */
export function explainError(err) {
  if (!err) return '';
  const code = String(err.code || err.error_code || '');
  const name = String(err.name || '');
  const msg = String(err.message || err.error_description || err.error || err || '');
  const all = `${code} ${name} ${msg}`;
  if (/mfa_verification_failed|invalid totp|invalid code|code is invalid/i.test(all)) {
    return 'That code did not work. Use the newest code in your app. If it keeps failing, check your phone sets its time automatically.';
  }
  if (/challenge_expired|expired/i.test(all)) return 'That took too long. Please try again.';
  // Whole words and the real codes only: /rate/ also matched "failed to generate challenge"
  // and told people to wait a minute for an error that had nothing to do with rate limits.
  if (/over_request_rate_limit|over_email_send_rate_limit|\b429\b|\brate limit\b|\btoo many\b/i.test(all)) {
    return 'Too many tries. Wait a minute, then try again.';
  }
  if (/insufficient_aal|aal2 required|AAL2/i.test(all)) return 'Confirm it is you first: sign out, then sign in again.';
  if (/web_?authn.*(disabled|not.*enabled)|enroll_not_enabled|verify_not_enabled/i.test(all)) {
    return 'Face ID is not switched on for ServOS yet. Use your authenticator app for now.';
  }
  if (/NotAllowedError|ERROR_CEREMONY_ABORTED|cancel|timed out|not allowed/i.test(all)) {
    return 'Face ID or fingerprint was cancelled or timed out. Try again, or use a code instead.';
  }
  if (/InvalidStateError|already registered|ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED/i.test(all)) {
    return 'This device is already set up for your login.';
  }
  if (/SecurityError|origin|rp id|rpid|relying party/i.test(all)) {
    return 'Face ID cannot be used on this web address. Use your authenticator app code.';
  }
  if (/Failed to fetch|NetworkError|network/i.test(all)) return 'No connection. Check the internet and try again.';
  if (/weak|pwned|leaked|characters/i.test(all)) return msg;
  return msg || 'Something went wrong. Please try again.';
}
