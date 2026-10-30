// supabase/functions/_shared/signupGate.js
//
// 5.11.123 (30 Oct 2026): sign ups are CLOSED. Peter, 27 Oct: "fully closed no signups, this comes
// later when we have a self sign up option we havent even built yet."
//
// WHY A HOOK AND NOT THE SWITCH: the dashboard switch "Allow new users to sign up" also blocks
// signInAnonymously(), which every kiosk, online, QR, gift and catering page needs (20 Sep 2026
// incident). So the Ops project gets a Supabase "Before User Created" auth hook pointing at the
// auth-before-user-created function, and this module is its whole decision:
//   * an anonymous user (is_anonymous true, or provider 'anonymous'): ALLOWED, always;
//   * anything else (email sign up, magic link to a new address, invite, OAuth): REFUSED with a
//     plain message. Nothing is created.
// Supabase Auth runs the hook for POST /auth/v1/signup (email and anonymous), magic links and OTP
// to a NEW address, invites and OAuth (its anonymous.go, signup.go, mail.go, invite.go, external.go).
// It does NOT run it for auth.admin.createUser, which is how every ServOS account is made
// (create-user, staff-portal accept_invite, the dashboard's Create new user, Peter by hand), nor for
// a magic link to an EXISTING user (staff-portal uses one). So nothing we do today is blocked.
//
// SIGNATURE: Supabase signs the request (Standard Webhooks: webhook-id, webhook-timestamp,
// webhook-signature; secret "v1,whsec_<base64>", several separated by "|"). We verify when the
// secret is set. A bad or missing signature is logged, and the request is STILL answered from its
// payload: the answer only ever reaches Supabase Auth, so a forger gains nothing from it, while a
// wrong secret must never take every kiosk and online page down (customer facing never fails).

export const CLOSED_MESSAGE = 'Sign ups are closed. ServOS accounts are set up for you by your company owner.';
const TOLERANCE_S = 5 * 60;

const isAnonymous = (user) => !!user && (user.is_anonymous === true
  || user?.app_metadata?.provider === 'anonymous'
  || (Array.isArray(user?.app_metadata?.providers) && user.app_metadata.providers.length === 1 && user.app_metadata.providers[0] === 'anonymous'));

/** The decision for one hook payload: { allow, status, body, reason, who }. who is a masked email for the log. */
export function decideUserCreation(payload) {
  const user = payload && typeof payload === 'object' ? payload.user : null;
  const who = maskEmail(user?.email);
  if (isAnonymous(user)) return { allow: true, status: 200, body: {}, reason: 'anonymous', who };
  // The auth server only accepts 200/202/204 from an HTTP hook (anything else = "Unexpected status
  // code returned from hook", a 500 for the caller). The refusal travels in the body: error.http_code
  // becomes the status the person signing up sees. Proven 30 Oct: a real 403 came back as a 500.
  return {
    allow: false, status: 200, reason: 'closed', who,
    body: { error: { message: CLOSED_MESSAGE, http_code: 403 } },
  };
}

/** p***@d***.com: enough to see a pattern in the logs, never the address. */
export function maskEmail(email) {
  const e = String(email || '').trim();
  if (!e) return '';
  const at = e.indexOf('@');
  if (at <= 0) return `${e.slice(0, 1)}***`;
  const dom = e.slice(at + 1);
  const dot = dom.lastIndexOf('.');
  const tail = dot > 0 ? dom.slice(dot) : '';
  return `${e.slice(0, 1)}***@${dom.slice(0, 1)}***${tail}`;
}

const b64 = {
  decode: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  encode: (u8) => btoa(String.fromCharCode(...u8)),
};

/** The secrets Supabase shows: "v1,whsec_AAAA" or "v1,whsec_AAAA|v1,whsec_BBBB". Returns the raw key bytes. */
export function parseHookSecrets(value) {
  return String(value || '').split('|').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(?:v1,)?(?:whsec_)?(.+)$/.exec(s);
    try { return b64.decode(m ? m[1] : s); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Standard Webhooks check. headers: a Headers-like with get(). rawBody: the exact request text.
 * Returns { ok, why }. nowS is injectable for the tests.
 */
export async function verifyStandardWebhook({ headers, rawBody, secrets, nowS = Math.floor(Date.now() / 1000), subtle = globalThis.crypto?.subtle }) {
  const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sig = headers.get('webhook-signature');
  if (!secrets || !secrets.length) return { ok: false, why: 'no_secret' };
  if (!id || !ts || !sig) return { ok: false, why: 'missing_headers' };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return { ok: false, why: 'timestamp' };
  const enc = new TextEncoder();
  const content = enc.encode(`${id}.${ts}.${rawBody}`);
  const given = sig.split(/\s+/).map((p) => p.split(',')).filter((p) => p.length === 2 && p[0] === 'v1').map((p) => p[1]);
  if (!given.length) return { ok: false, why: 'no_v1_signature' };
  for (const key of secrets) {
    const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = b64.encode(new Uint8Array(await subtle.sign('HMAC', k, content)));
    if (given.some((g) => timingSafeEqual(g, mac))) return { ok: true, why: 'ok' };
  }
  return { ok: false, why: 'bad_signature' };
}

/** Sign as Supabase would (for the tests and the proof script). */
export async function signStandardWebhook({ id, ts, rawBody, secret, subtle = globalThis.crypto?.subtle }) {
  const key = parseHookSecrets(secret)[0];
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = b64.encode(new Uint8Array(await subtle.sign('HMAC', k, new TextEncoder().encode(`${id}.${ts}.${rawBody}`))));
  return `v1,${mac}`;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
