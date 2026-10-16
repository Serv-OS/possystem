// supabase/functions/_shared/payLink.js
//
// PAY LINK FROM THE HOST STAND (16 Oct 2026, v5.11.70 host track).
// A phone booking that owes a deposit, a prepay or a card hold gets an SMS
// link: https://<venue>.<root>/book?pay=<booking id>&t=<token>. The token is an
// HMAC of the booking id under a server secret, so it needs no database column
// (the link works before the migration) and nobody can guess another
// booking's link. booking-host makes it, booking-widget checks it.
//
// Pure apart from Web Crypto (Deno and node 20 both have it). Tested in
// src/lib/bookings/bookingHost.test.js.

const enc = new TextEncoder();

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(text)));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 40 hex characters: plenty against guessing, short enough for an SMS.
export async function payLinkToken(secret, bookingId) {
  if (!secret || !bookingId) return null;
  return (await hmacHex(secret, `bkpaylink:${bookingId}`)).slice(0, 40);
}

// Constant time compare, so the check itself leaks nothing.
export async function payLinkTokenOk(secret, bookingId, token) {
  const want = await payLinkToken(secret, bookingId);
  const got = String(token || '');
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export function payLinkUrl(base, bookingId, token) {
  if (!base || !bookingId || !token) return null;
  return `${String(base).replace(/\/+$/, '')}/book?pay=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(token)}`;
}
