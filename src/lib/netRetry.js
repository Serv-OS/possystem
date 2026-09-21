// src/lib/netRetry.js
//
// One retry for a request that never completed.
//
// LIVE, 20 Sep 2026: a member of staff building a menu in Back Office kept
// getting the red "YOUR CHANGES ARE NOT SAVING" bar, reading
// "TypeError: NetworkError when attempting to fetch resource" (Firefox's
// wording for a request that never completed; Chrome says "Failed to fetch",
// Safari "Load failed"). The Ops API logged ONE 4xx write in the whole of that
// day, so those saves never reached us: it was the connection, not the
// database. Nothing retried, so a two-second blip cost the operator the edit
// she had just made and put a bar on her screen that she could not clear.
//
// WHAT MAY BE SENT AGAIN. A fetch that rejects tells us nothing about whether
// the server acted: usually the request never left, but the reply can also be
// lost on the way back. So a request is only replayed when doing it twice is
// the same as doing it once:
//
//   GET / HEAD / OPTIONS   always
//   PATCH / PUT / DELETE   PostgREST applies these to the rows a filter picks
//                          out, so the second one lands on the same rows
//   POST                   ONLY an upsert (Prefer: resolution=merge-duplicates
//                          or ignore-duplicates), which is keyed and therefore
//                          idempotent. That is every menu save.
//
// and never at all for:
//   /auth/v1/  writes      a refresh token is single use; replaying a grant
//                          can invalidate the session it was meant to renew
//   /rest/v1/rpc/          a database function may count, mint or charge
//   /functions/v1/ writes  an edge function may take a payment
//
// An AbortError is OUR timeout or unmount, never a network fault, and is
// never retried.

/** Waits between attempts. Two retries, so ~1.6s in the worst case. */
export const RETRY_DELAYS_MS = Object.freeze([400, 1200]);

/**
 * Did this fetch fail to complete at all? `fetch` rejects with a TypeError for
 * every transport fault (DNS, connection refused, TLS, the network dropping),
 * and resolves normally for any HTTP status, so a rejection here is exactly
 * "we never learned what the server did".
 */
export function isTransportFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 20) return false;   // we asked for it
  const msg = String(err.message || err);
  if (/abort/i.test(msg)) return false;
  return err instanceof TypeError
    || /failed to fetch|networkerror|load failed|network request failed|connection|fetch failed/i.test(msg);
}

/** The Prefer header, whether the caller used Headers, an array or an object. */
function headerValue(init, name) {
  const h = init && init.headers;
  if (!h) return '';
  const want = name.toLowerCase();
  try {
    if (typeof h.get === 'function') return String(h.get(name) ?? '');
    if (Array.isArray(h)) {
      const hit = h.find((pair) => String(pair?.[0] ?? '').toLowerCase() === want);
      return String(hit?.[1] ?? '');
    }
    const key = Object.keys(h).find((k) => k.toLowerCase() === want);
    return key ? String(h[key] ?? '') : '';
  } catch {
    return '';
  }
}

function methodOf(input, init) {
  const m = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
  return String(m).toUpperCase();
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return String(input.url || '');
  return String(input ?? '');
}

/** Would sending this request a second time do the same thing as sending it once? */
export function isReplaySafe(input, init) {
  const url = urlOf(input);
  const method = methodOf(input, init);
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

  if (/\/auth\/v1\//.test(url)) return read;          // never replay a token grant
  if (/\/functions\/v1\//.test(url)) return read;     // an edge function may take money
  if (/\/rest\/v1\/rpc\//.test(url)) return read;     // a database function may count or mint

  if (read) return true;
  if (method === 'PATCH' || method === 'PUT' || method === 'DELETE') return true;
  // The header can be on the init OR on a Request object the caller built.
  if (method === 'POST') {
    const prefer = headerValue(init, 'Prefer') || headerValue(input, 'Prefer');
    return /resolution=(merge|ignore)-duplicates/i.test(prefer);
  }
  return false;
}

/**
 * Wrap a fetch so a request that never completed is sent again.
 *
 * The base fetch is CALLED, not passed around detached: `window.fetch` invoked
 * without its receiver throws "Illegal invocation" in a browser (v5.8.56 broke
 * every TV pairing exactly that way).
 */
export function makeRetryingFetch(baseFetch, { delays = RETRY_DELAYS_MS, sleep, onRetry } = {}) {
  const call = baseFetch
    ? (input, init) => baseFetch(input, init)
    : (input, init) => globalThis.fetch(input, init);
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  return async function retryingFetch(input, init) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(input, init);
      } catch (err) {
        const last = attempt >= delays.length;
        if (last || !isTransportFailure(err) || !isReplaySafe(input, init)) throw err;
        if (onRetry) { try { onRetry({ attempt: attempt + 1, url: urlOf(input), error: err }); } catch { /* never the caller's problem */ } }
        await wait(delays[attempt]);
      }
    }
  };
}
