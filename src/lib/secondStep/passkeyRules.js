// src/lib/secondStep/passkeyRules.js
//
// The pure rules of passkey sign in (docs/SECOND_STEP.md). No browser, no network, no Supabase,
// so node:test drives every branch.
//
// PETER, 20 Sep 2026: "I just want it more secure I hate multi factor auth apps, this is what
// toast does I want this", and "we need this for every user across every device". A passkey is
// the fingerprint on his laptop, the face on his phone, Windows Hello on Windows.

/** The web addresses a passkey can be made and used on. Supabase holds the same list. */
export const PASSKEY_ORIGINS = Object.freeze(['app.serv-os.app', 'dev.serv-os.app', 'stage.serv-os.app']);
/** The relying party: the bare domain. Every origin above is it or under it. */
export const PASSKEY_RP_ID = 'serv-os.app';

/**
 * Can a passkey be made or used on THIS web address? A passkey belongs to a domain: one made on
 * app.serv-os.app cannot be used on possystem-liard.vercel.app, and the browser refuses to make
 * one there at all, because vercel.app is not under our relying party.
 * localhost is allowed in development only (the browser treats it as secure).
 */
export function passkeyHostAllowed(hostname, { allowLocalhost = false } = {}) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (allowLocalhost && (h === 'localhost' || h === '127.0.0.1')) return true;
  return h === PASSKEY_RP_ID || h.endsWith(`.${PASSKEY_RP_ID}`);
}

/** Plain words for a person on the wrong address. */
export function wrongHostMessage(hostname) {
  return `Passkeys only work on app.serv-os.app. This page is ${hostname || 'somewhere else'}. `
    + 'Open Back Office at app.serv-os.app and sign in there, or use your password and an emailed code here.';
}

/**
 * What the sign in screen offers.
 *   'passkey'   this place can use one: the big button
 *   'password'  no passkey maker here (an old browser, a shared PC with none set up, our own
 *               apps and the Sunmi tills): password first, and the emailed code after it
 *   'wrong_host' possystem-liard.vercel.app and anything else off our domain
 */
export function signInPlan({ hostname, supported, allowLocalhost = false } = {}) {
  if (!passkeyHostAllowed(hostname, { allowLocalhost })) return { primary: 'wrong_host', canUsePasskey: false };
  if (!supported) return { primary: 'password', canUsePasskey: false };
  return { primary: 'passkey', canUsePasskey: true };
}

/**
 * What the second step asks for after a password sign in.
 *   'register_passkey'  the normal path: make one on this device
 *   'prove_email'       a FIRST passkey, and the server wants the emailed code first
 *   'app_code'          this place cannot make a passkey (no biometric, or our own apps), and
 *                       the login has none: an authenticator app is the only way through, so it
 *                       stays as the way in on a device with no biometric
 *   'ok'                nothing to do
 */
export function secondStepPlan({
  passkeys = [], factors = [], canUsePasskey = false, emailProved = false, needsEmail = false,
} = {}) {
  const hasPasskey = (passkeys || []).length > 0;
  const hasApp = (factors || []).some((f) => f?.factor_type === 'totp' && f?.status === 'verified');
  if (hasPasskey || hasApp) return 'ok';
  if (!canUsePasskey) return 'app_code';
  if (needsEmail && !emailProved) return 'prove_email';
  return 'register_passkey';
}

/** A name a person recognises, from the device they are on. Never a fingerprint of them. */
export function suggestPasskeyName(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  return 'This device';
}

/** What the person is asked for, in their own words, by device. */
export function passkeyPrompt(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad/i.test(ua)) return 'Face ID or your passcode';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Touch ID or your password';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  if (/Android/i.test(ua)) return 'your fingerprint or face';
  return 'your fingerprint, face or device PIN';
}

/**
 * May this passkey be removed? Never the last way in: a person with one passkey and no
 * authenticator app would be locked out of Back Office with no way back except a reset.
 */
export function canRemovePasskey({ passkeys = [], factors = [], id } = {}) {
  const mine = (passkeys || []).filter((p) => p && p.id);
  if (!id || !mine.some((p) => p.id === id)) return { ok: false, reason: 'unknown', message: 'That passkey is not on your account.' };
  const others = mine.filter((p) => p.id !== id).length;
  const hasApp = (factors || []).some((f) => f?.factor_type === 'totp' && f?.status === 'verified');
  if (others > 0 || hasApp) return { ok: true, reason: 'ok', message: '' };
  return {
    ok: false,
    reason: 'last',
    message: 'This is your only way in. Add a passkey on another device first, then remove this one.',
  };
}

/** Plain words for what went wrong in a passkey ceremony. Never the raw browser error. */
export function explainPasskeyError(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || err || '');
  const all = `${name} ${msg}`;
  if (/NotAllowedError|cancel|timed out|aborted/i.test(all)) {
    return 'That was cancelled or timed out. Try again when you are ready.';
  }
  if (/InvalidStateError|already registered|excluded/i.test(all)) {
    return 'This device already has a passkey for your account. Sign in with it instead.';
  }
  if (/SecurityError|rp id|rpid|relying party|origin/i.test(all)) {
    return wrongHostMessage(typeof location !== 'undefined' ? location.hostname : '');
  }
  if (/NotSupportedError|not supported|no available authenticator/i.test(all)) {
    return 'This device cannot make a passkey. Use your password and the code we email you, then set a passkey up on your phone or laptop.';
  }
  if (/passkey_not_found|no passkey|credential not found|unknown credential/i.test(all)) {
    return 'We do not know that passkey. Sign in with your password, then add one in Settings, Sign in security.';
  }
  if (/over_request_rate_limit|\b429\b|\brate limit\b/i.test(all)) return 'Too many tries. Wait a minute, then try again.';
  if (/passkey.*(disabled|not enabled)|feature.*not enabled/i.test(all)) {
    return 'Passkeys are not switched on yet. Use your password for now.';
  }
  return msg && msg.length < 140 ? msg : 'That did not work. Try again, or use your password.';
}
