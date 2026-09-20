// src/lib/secondStep/client.js
//
// The Back Office second sign in step: every call to the auth server, in one place
// (docs/SECOND_STEP.md). The rules live in ./rules.js; this file only talks to Supabase
// and the browser. Takes the supabase client as an argument so the Back Office, the admin
// portal and the Owner app all share one implementation (they use the same 'rpos-auth'
// session, so one second step covers all three in a browser).
//
// FACE ID NOTES (auth-js 2.103, WebAuthn MFA is marked experimental there):
//   * We never call auth.mfa.webauthn.register(): when enrol fails it unenrolls the login's
//     EXISTING VERIFIED factor with the same name (webauthn.js _register). We enrol, challenge
//     and verify ourselves and only ever clean up UNVERIFIED leftovers.
//   * auth-js defaults ask for a USB security key (hints security-key, cross-platform). We
//     override to the device's own Face ID, Touch ID, Windows Hello or fingerprint.
//   * The server decides the domain (GOTRUE_WEBAUTHN_RP_ID); what we send is ignored by
//     current servers and matches the setting on older ones.

import QRCode from 'qrcode';
import {
  TOTP_ISSUER, friendlyName, leftoverFactorIds, rpIdFor, faceIdSupport, isInAppShell, normaliseCode,
  isCodeComplete,
} from './rules';
import { createPasskeyClient, passkeySupport } from './passkey';
import { suggestPasskeyName, passkeyHostAllowed } from './passkeyRules';

const FACE_CREATE = {
  authenticatorSelection: {
    authenticatorAttachment: 'platform',
    userVerification: 'required',
    residentKey: 'preferred',
    requireResidentKey: false,
  },
  hints: ['client-device'],
  attestation: 'none',
};
const FACE_REQUEST = { userVerification: 'required', hints: ['client-device'] };

const DEVICE_KEY = 'rpos-second-step-device';

function withTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

function location_() {
  try { return window.location; } catch { return { hostname: '', origin: '' }; }
}

export function rememberFaceIdFactor(factorId) {
  try { if (factorId) localStorage.setItem(DEVICE_KEY, factorId); } catch { /* private mode */ }
}
export function rememberedFaceIdFactor() {
  try { return localStorage.getItem(DEVICE_KEY) || null; } catch { return null; }
}

/** Is Face ID or fingerprint usable on this page, on this device? Never throws. */
export async function detectFaceId({ allowLocalhost = false } = {}) {
  const loc = location_();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let hasWebAuthn = false;
  let platformAuthenticator = false;
  try {
    hasWebAuthn = typeof window !== 'undefined' && !!window.PublicKeyCredential
      && typeof navigator?.credentials?.create === 'function' && typeof navigator?.credentials?.get === 'function';
    if (hasWebAuthn && !isInAppShell(ua) && rpIdFor(loc.hostname, { allowLocalhost })) {
      const fn = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
      platformAuthenticator = typeof fn === 'function' ? !!(await withTimeout(fn.call(window.PublicKeyCredential), 1500, false)) : false;
    }
  } catch { platformAuthenticator = false; }
  return faceIdSupport({ hostname: loc.hostname, userAgent: ua, hasWebAuthn, platformAuthenticator, allowLocalhost });
}

export function createSecondStepClient(supabase, { allowLocalhost = false } = {}) {
  const mfa = () => supabase.auth.mfa;
  const rp = () => {
    const loc = location_();
    return { rpId: rpIdFor(loc.hostname, { allowLocalhost }) || loc.hostname, rpOrigins: [loc.origin] };
  };

  async function getSession() {
    const { data } = await supabase.auth.getSession();
    return data?.session || null;
  }

  /** Every factor (verified and not). The auth server is asked, not the stored session. */
  async function listFactors() {
    const { data, error } = await mfa().listFactors();
    if (error) throw error;
    return data?.all || [];
  }

  /** Peter's break glass. Any failure (the SQL not run yet, no connection, refused) = ask as normal. */
  async function appGate() {
    try {
      const res = await withTimeout(supabase.rpc('second_step_status'), 3000, null);
      if (res && !res.error && res.data && res.data.app_gate === false) return false;
    } catch { /* ask as normal */ }
    return true;
  }

  async function status() {
    try {
      const res = await withTimeout(supabase.rpc('second_step_status'), 3000, null);
      return res && !res.error ? res.data : null;
    } catch { return null; }
  }

  /** Remove unverified leftovers of an abandoned set up (allowed without the second step). */
  async function cleanupLeftovers(factors, type) {
    for (const id of leftoverFactorIds(factors, type)) {
      try { await mfa().unenroll({ factorId: id }); } catch { /* the server expires them anyway */ }
    }
  }

  // ── PROOF OF THE EMAIL, BEFORE A FIRST SECOND STEP (fix round, 20 Sep 2026) ─────────
  // A password alone must never be enough to SET one up: a thief with the password of a login
  // nobody uses would otherwise enrol their own app and be that person for good. The auth
  // server refuses the first factor (the MFA verification attempt hook) until the person has
  // typed a code we sent to the address on the account. These three calls are that step.
  // While second-step-invite is not deployed yet, they answer "no code needed", which is
  // exactly what the database says too (the hook is not switched on either).

  /** { needs_email, proved, sent_to } for this login, or a safe default. */
  async function emailProofStatus() {
    try {
      const res = await withTimeout(supabase.functions.invoke('second-step-invite', { body: { action: 'status' } }), 6000, null);
      const data = res && res.data;
      if (!data || data.ok !== true) return { needs_email: false, proved: false, sentTo: '' };
      return { needs_email: data.needs_email === true, proved: data.proved === true, sentTo: data.sent_to || '' };
    } catch { return { needs_email: false, proved: false, sentTo: '' }; }
  }

  /** Send the code to the address on the account. Throws with plain words on a refusal. */
  async function sendEmailCode() {
    const res = await supabase.functions.invoke('second-step-invite', { body: { action: 'start' } });
    const data = res && res.data;
    if (data && data.ok === true) return { sentTo: data.sent_to || '' };
    const message = (data && data.error) || (res && res.error && res.error.message) || 'We could not send the code. Try again.';
    throw new Error(message);
  }

  /** The code they typed. Throws with the server's own plain words when it does not match. */
  async function claimEmailCode(code) {
    const res = await supabase.functions.invoke('second-step-invite', { body: { action: 'claim', code: normaliseCode(code) } });
    const data = res && res.data;
    if (data && data.ok === true) return true;
    const message = (data && data.error) || (res && res.error && res.error.message) || 'That code did not work.';
    throw new Error(message);
  }

  // ── PASSKEYS (20 Sep 2026): the Toast flow. A fingerprint on a laptop, a face on a phone,
  // Windows Hello on Windows. This is the second step from now on; the authenticator app stays
  // only for a device that cannot make one. lib/secondStep/passkey.js says why we talk to the
  // GoTrue endpoints ourselves instead of supabase.auth.signInWithPasskey (auth-js 2.103 has no
  // passkey code, and MFA WebAuthn is refused on this project).
  const passkeys = createPasskeyClient({
    url: supabase?.supabaseUrl || supabase?.rest?.url?.replace(/\/rest\/v1\/?$/, '') || '',
    anonKey: supabase?.supabaseKey || '',
    getToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data?.session?.access_token || null;
    },
    setSession: async ({ access_token, refresh_token }) => {
      await supabase.auth.setSession({ access_token, refresh_token });
    },
  });

  /** Can this place make or use a passkey at all? Host first, then the device itself. */
  async function canUsePasskey() {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    if (!passkeyHostAllowed(host, { allowLocalhost })) return { usable: false, reason: 'host' };
    if (isInAppShell(typeof navigator !== 'undefined' ? navigator.userAgent : '')) return { usable: false, reason: 'app' };
    return passkeySupport();
  }

  /** The passkeys this login holds (never the keys themselves). */
  async function listPasskeys() {
    try { return await passkeys.list(); } catch { return []; }
  }

  /**
   * Make a passkey on THIS device and tell our own server it exists (the switch on count and
   * the Back Office list read that; the fence itself proves a passkey from the session).
   */
  async function addPasskey({ name } = {}) {
    const friendly = name || suggestPasskeyName(typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const made = await passkeys.register({ friendlyName: friendly });
    try {
      await supabase.rpc('second_step_passkey_record', {
        p_credential_id: made.credentialId,
        p_friendly_name: made.friendlyName || friendly,
        p_device_hint: friendly,
      });
    } catch { /* the passkey is made; our own record catches up at the next sign in */ }
    return made;
  }

  /** Sign in with a passkey. No password, no code. */
  async function signInWithPasskey() {
    return passkeys.signIn();
  }

  /** Remove one (the screen checks canRemovePasskey first). */
  async function removePasskey(id) {
    await passkeys.remove(id);
    try { await supabase.rpc('second_step_passkey_forget', { p_credential_id: id }); } catch { /* record only */ }
  }

  /** Start an authenticator app: returns what the screen shows (QR code, secret for typing). */
  async function startAuthenticatorApp() {
    const before = await listFactors();
    await cleanupLeftovers(before, 'totp');
    const names = before.map((f) => f.friendly_name);
    const { data, error } = await mfa().enroll({ factorType: 'totp', friendlyName: friendlyName('totp', names), issuer: TOTP_ISSUER });
    if (error) throw error;
    const uri = data?.totp?.uri || '';
    let qr = '';
    try { qr = uri ? await QRCode.toDataURL(uri, { width: 240, margin: 1, errorCorrectionLevel: 'M' }) : ''; } catch { qr = data?.totp?.qr_code || ''; }
    return { factorId: data.id, secret: data?.totp?.secret || '', uri, qr };
  }

  /** Check one code against one authenticator factor. */
  async function verifyCode(factorId, code) {
    const clean = normaliseCode(code);
    if (!isCodeComplete(clean)) throw new Error('Enter the 6 digit code from your app.');
    const { data: ch, error: chErr } = await mfa().challenge({ factorId });
    if (chErr) throw chErr;
    const { error } = await mfa().verify({ factorId, challengeId: ch.id, code: clean });
    if (error) throw error;
  }

  /** A code at sign in: try each of the login's authenticator apps (a second phone has its own). */
  async function verifyAnyCode(factorIds, code) {
    let lastErr = null;
    for (const id of factorIds || []) {
      try { await verifyCode(id, code); return; } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('You have no authenticator app set up.');
  }

  /** Set up Face ID or fingerprint on THIS device. */
  async function addFaceId({ email } = {}) {
    const before = await listFactors();
    await cleanupLeftovers(before, 'webauthn');
    const names = before.map((f) => f.friendly_name);
    const { data: factor, error: enrollErr } = await mfa().enroll({ factorType: 'webauthn', friendlyName: friendlyName('webauthn', names) });
    if (enrollErr) throw enrollErr;
    const create = email ? { ...FACE_CREATE, user: { name: email, displayName: email } } : FACE_CREATE;
    try {
      const { data: ch, error: chErr } = await mfa().webauthn.challenge(
        { factorId: factor.id, friendlyName: factor.friendly_name, webauthn: rp() },
        { create },
      );
      if (chErr || !ch) throw chErr || new Error('Face ID did not start.');
      const { error: vErr } = await mfa().webauthn.verify({
        factorId: factor.id,
        challengeId: ch.challengeId,
        webauthn: { ...rp(), type: ch.webauthn.type, credential_response: ch.webauthn.credential_response },
      });
      if (vErr) throw vErr;
      rememberFaceIdFactor(factor.id);
      return factor.id;
    } catch (e) {
      // Only ever the factor we just created, and only while it is still unverified.
      try { await mfa().unenroll({ factorId: factor.id }); } catch { /* expires by itself */ }
      throw e;
    }
  }

  /** Face ID or fingerprint at sign in. */
  async function useFaceId(factorId) {
    const { data, error } = await mfa().webauthn.authenticate({ factorId, webauthn: rp() }, FACE_REQUEST);
    if (error) throw error;
    rememberFaceIdFactor(factorId);
    return data;
  }

  async function removeFactor(factorId) {
    const { error } = await mfa().unenroll({ factorId });
    if (error) throw error;
    // The auth server drops this browser's session to "password only" when the factor it used
    // is removed; refresh so the page reads the truth.
    try { await supabase.auth.refreshSession(); } catch { /* next load refreshes */ }
  }

  async function changePassword(password) {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  }

  return {
    getSession, listFactors, appGate, status, startAuthenticatorApp, verifyCode, verifyAnyCode,
    addFaceId, useFaceId, removeFactor, changePassword, cleanupLeftovers,
    emailProofStatus, sendEmailCode, claimEmailCode,
    canUsePasskey, listPasskeys, addPasskey, signInWithPasskey, removePasskey,
  };
}

/** Remember a weak password warning from sign in (Supabase flags it), for the page after the gate. */
export function noteWeakPassword(weak) {
  try {
    if (weak && (weak.reasons?.length || weak.message)) sessionStorage.setItem('rpos-weak-password', '1');
    else sessionStorage.removeItem('rpos-weak-password');
  } catch { /* private mode */ }
}
export function hasWeakPasswordNote() {
  try { return sessionStorage.getItem('rpos-weak-password') === '1'; } catch { return false; }
}
export function clearWeakPasswordNote() {
  try { sessionStorage.removeItem('rpos-weak-password'); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent('rpos-weak-password-cleared')); } catch { /* no window */ }
}

/** The current access token through supabase-js (refreshed when expired). Null when signed out. */
export async function currentAccessToken(supabase) {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch { return null; }
}

/** Call the second-step-reset edge function; returns the JSON body or throws a readable Error. */
export async function callResetFunction(supabase, body) {
  const { data, error } = await supabase.functions.invoke('second-step-reset', { body });
  if (error) {
    let detail = null;
    try { detail = await error.context?.json?.(); } catch { detail = null; }
    const e = new Error(detail?.error || error.message || 'The request did not go through.');
    e.code = detail?.code || null;
    throw e;
  }
  if (data?.error) { const e = new Error(data.error); e.code = data.code || null; throw e; }
  return data;
}
