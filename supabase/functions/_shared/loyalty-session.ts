// supabase/functions/_shared/loyalty-session.ts
//
// The loyalty member's session token, minted by loyalty-otp after a correct one time code and
// sent back by the portal, online checkout and loyalty-redeem.
//
// Format: base64("<customerId>:<companyId>:<issuedAtMs>:<provenPhone>") + "." + hex HMAC-SHA256
// of the raw payload. The fourth field (18 Sep 2026) is the phone number the member proved with
// the code. Gift cards are matched on THAT phone and nothing else (see giftCardMatch.ts), so it
// has to travel with the session rather than be re-read from a profile the member can edit.
// Tokens minted before this change have three fields; they still verify (phone comes back null)
// and simply expire within 24 hours.
//
// PURE apart from Web Crypto (global in Deno and in Node), so node tests import it directly. The
// secret is passed in: callers read OTP_HMAC_SECRET themselves.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function createSessionToken(
  customerId: string,
  companyId: string,
  phone: string | null,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const safePhone = typeof phone === 'string' && /^\+?\d{6,16}$/.test(phone) ? phone : '';
  const payload = `${customerId}:${companyId}:${now}:${safePhone}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return btoa(payload) + '.' + hex;
}

export async function verifySessionToken(
  token: unknown,
  secret: string,
  now: number = Date.now(),
): Promise<{ customerId: string; companyId: string; phone: string | null } | null> {
  try {
    if (typeof token !== 'string') return null;
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig || !/^[0-9a-f]+$/i.test(sig) || sig.length % 2) return null;
    const payload = atob(payloadB64);
    const [customerId, companyId, timestampStr, phone] = payload.split(':');
    if (!customerId || !companyId || !timestampStr) return null;
    const age = now - Number(timestampStr);
    if (!Number.isFinite(age) || age > SESSION_TTL_MS) return null;
    const sigBytes = new Uint8Array(sig.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sigBytes, enc.encode(payload));
    if (!valid) return null;
    return { customerId, companyId, phone: phone || null };
  } catch {
    return null;
  }
}
