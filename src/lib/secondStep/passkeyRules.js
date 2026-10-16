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
 *               app builds without the native passkey entitlement, the Sunmi tills): password
 *               first, and the emailed code after it
 *   'wrong_host' possystem-liard.vercel.app and anything else off our domain
 */
export function signInPlan({ hostname, supported, reason = '', allowLocalhost = false } = {}) {
  if (!passkeyHostAllowed(hostname, { allowLocalhost })) return { primary: 'wrong_host', canUsePasskey: false };
  // 16 Oct 2026 (Peter's iPhone, Owner app): the device test (isUserVerifyingPlatformAuthenticator
  // Available) said no while passkeys worked everywhere else on the phone, so the button never
  // showed. Signing in with a passkey you already have does not need that test: the phone's own
  // sheet offers it, or says there is none. So when the only objection is the device test, the
  // button is offered; registering a NEW passkey still uses the stricter test (secondStepPlan).
  if (!supported && reason === 'device') return { primary: 'passkey', canUsePasskey: true };
  if (!supported) return { primary: 'password', canUsePasskey: false };
  return { primary: 'passkey', canUsePasskey: true };
}

/**
 * What the second step asks for after a password sign in.
 *   'register_passkey'  the normal path: make one on this device
 *   'prove_email'       a FIRST passkey, and the server wants the emailed code first
 *   'app_code'          this place cannot make a passkey (no biometric, or an app build of ours
 *                       without the passkey entitlement), and the login has none: an authenticator
 *                       app is the only way through, so it stays as the way in on a device with
 *                       no biometric
 *   'ok'                nothing to do
 */
export function secondStepPlan({
  passkeys = [], factors = [], canUsePasskey = false, emailProved = false, needsEmail = false,
} = {}) {
  const hasPasskey = (passkeys || []).length > 0;
  const hasApp = (factors || []).some((f) => f?.factor_type === 'totp' && f?.status === 'verified');
  // OWNING A PASSKEY IS NOT PROVING ONE (21 Sep 2026, live). This said 'ok' the
  // moment the account had a passkey, and 'ok' means "let them in". So Peter
  // signed in to peter+coffeeboy with nothing but the password, was asked for
  // neither a code nor his fingerprint, and walked straight into Back Office:
  // the account had a passkey, and the gate took that as the second step being
  // done. The session had signed in with a password and proved nothing.
  // A person who has a passkey is asked to USE it, here, now.
  if (hasPasskey && canUsePasskey) return 'use_passkey';
  if (hasApp) return 'ok';
  if (!canUsePasskey) return 'app_code';
  if (needsEmail && !emailProved) return 'prove_email';
  return 'register_passkey';
}

/**
 * Inside one of our iOS apps (the user agent carries RposIOS/), on something other than an iPhone.
 * WKWebView on an iPad asks for desktop pages, so its user agent says Macintosh, not iPad; the iOS
 * apps never run on a Mac (SUPPORTS_MACCATALYST is off), so that is an iPad. (15 Oct 2026.)
 */
function isIPadInOurApp(ua) {
  return /RposIOS\//.test(ua) && !/iPhone/i.test(ua);
}

/** A name a person recognises, from the device they are on. Never a fingerprint of them. */
export function suggestPasskeyName(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || isIPadInOurApp(ua)) return 'iPad';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  return 'This device';
}

/** What the person is asked for, in their own words, by device. */
export function passkeyPrompt(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad/i.test(ua) || isIPadInOurApp(ua)) return 'Face ID or your passcode';
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

/**
 * Why this device offers no passkey, in words that say what to do. (15 Oct 2026: Peter's iPad
 * showed no passkey button at all because AutoFill Passwords and Passkeys was switched off, and
 * nothing on the page said so.) `reason` is the one canUsePasskey() gives; 'host' and 'ok' have
 * their own words elsewhere, so they return ''.
 */
export function noPasskeyNote(reason, userAgent) {
  const ua = String(userAgent || '');
  const apple = /iPhone|iPad|Macintosh|Mac OS X/i.test(ua);
  switch (String(reason || '')) {
    case 'device':
      return apple
        ? 'Passkeys are switched off on this device. In Settings, General, AutoFill & Passwords, turn on AutoFill Passwords and Passkeys, then reload this page.'
        : 'This device has no screen lock, fingerprint or face set up for passkeys. Set one up in its settings, then reload this page.';
    case 'browser':
      return 'This browser cannot use passkeys. Open this page in Safari, Chrome or Edge.';
    case 'app':
      return 'This version of the app cannot use passkeys yet. Update the app, or sign in with your password and the code we email you.';
    default:
      return '';
  }
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
