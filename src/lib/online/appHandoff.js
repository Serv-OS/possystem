// src/lib/online/appHandoff.js
//
// The customer app opens this venue's ordering page as the signed in member (19 Nov 2026,
// Peter: the page asked name, email, phone and a code every time it was opened from the app).
// The app puts a two minute code in the URL FRAGMENT (#app=<code>): a fragment never reaches a
// server or a log. The page swaps it for a member token at the gateway (customer-app
// handoff_claim), then reads the member's summary the way a code sign in does (loyalty-otp
// refresh). Pure: the screen passes fetch and the two URLs in.

const CODE_RE = /^[A-Za-z0-9+/=]+\.[0-9a-f]+$/i;

/** The handoff code in a location hash ("#app=abc.123" or "#x=1&app=abc.123"), or null. */
export function handoffCodeFrom(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);   // a code ends in "=" padding: split on the FIRST "=" only
    if (k === 'app' && v) {
      let code = v;
      try { code = decodeURIComponent(v); } catch { return null; }
      return CODE_RE.test(code) && code.length <= 400 ? code : null;
    }
  }
  return null;
}

/** The same hash without the app code (the page clears it once used, so a reload is clean). */
export function hashWithoutHandoff(hash) {
  const h = String(hash || '').replace(/^#/, '');
  const kept = h.split('&').filter((p) => p && !p.startsWith('app='));
  return kept.length ? `#${kept.join('&')}` : '';
}

/**
 * Claim the code and build the member state the page keeps ({ phone, verified, customer,
 * loyalty, giftCards, stampCards, token }). Returns null when the code is refused (expired, used
 * on the wrong site): the page then shows its normal sign in, never an error. A refresh that
 * fails still signs the member in with what the claim returned.
 */
export async function claimHandoff({ fetchFn, gatewayUrl, otpUrl, anonKey, code, locationId = null }) {
  if (!code || typeof fetchFn !== 'function') return null;
  const headers = { 'Content-Type': 'application/json', ...(anonKey ? { apikey: anonKey, Authorization: `Bearer ${anonKey}` } : {}) };
  let claim;
  try {
    const res = await fetchFn(gatewayUrl, { method: 'POST', headers, body: JSON.stringify({ action: 'handoff_claim', code }) });
    claim = await res.json().catch(() => null);
    if (!res.ok || !claim?.token) return null;
  } catch {
    return null;
  }
  const base = {
    phone: claim.customer?.phone || '',
    verified: true,
    customer: claim.customer || null,
    loyalty: null,
    giftCards: [],
    stampCards: [],
    token: claim.token,
  };
  try {
    const res = await fetchFn(otpUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'refresh', token: claim.token, ...(locationId ? { location_id: locationId } : {}) }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.verified) return base;
    return {
      phone: j.customer?.phone || base.phone,
      verified: true,
      customer: j.customer || base.customer,
      loyalty: j.loyalty ?? null,
      giftCards: j.gift_cards ?? [],
      stampCards: j.stamp_cards ?? [],
      token: j.token || claim.token,
    };
  } catch {
    return base;
  }
}
