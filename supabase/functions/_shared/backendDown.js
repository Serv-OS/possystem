// supabase/functions/_shared/backendDown.js
//
// "THE BACKEND DID NOT ANSWER" IS NOT "YOU ARE NOT ALLOWED IN".
//
// 22 Sep 2026, 01:35 to 02:35 UTC. The Ops database ran out of CPU on a Micro
// instance. Postgres never crashed; it simply stopped answering in time. What
// the staff saw was not an outage. It was this:
//
//   * 291 x HTTP 401 "unauthorized" from terminal-job-status, because
//     `auth.getUser()` returns { data: { user: null }, error } on a 504 rather
//     than throwing, and the code read the null and threw the error away.
//   * 70 x HTTP 403 "no access to this location", because three PostgREST reads
//     all came back null while PostgREST was answering 503, and the code read
//     "no rows" as "no permission".
//
// So a starving database told a venue's staff that their login was invalid and
// that they had no access to their own venue. Peter spent the outage chasing a
// sign in problem that did not exist, and so did I.
//
// THE RULE, everywhere: when a read fails, look at the ERROR before you decide
// what it means. An error that says the service could not answer is a 503 with
// Retry-After, which the client retries. Only an answer that arrived and said
// "no" is a 401 or a 403.
//
// The strings below are not invented. They are the ones this system actually
// logged that night, and they are in the test file.

/** How long a client should wait before trying again. Short: outages here are seconds to minutes. */
export const RETRY_AFTER_SECONDS = 5;

/** Postgres and PostgREST codes that mean "the database could not serve this", never "no". */
const DOWN_CODES = new Set([
  'PGRST002',  // could not query the database for the schema cache (PostgREST wedged)
  'PGRST000',  // could not connect to the database
  'PGRST001',  // could not get the schema cache
  '57014',     // statement timeout
  '53300',     // too many connections
  '53200',     // out of memory
  '08000', '08003', '08006', '08001', '08004',  // connection exception family
  '57P01', '57P02', '57P03',  // admin shutdown, crash shutdown, cannot connect now
  'XX000',     // internal error, seen from GoTrue when it cannot reach Postgres
]);

/** Phrases seen in real failures where the service did not answer. Lowercased compare. */
const DOWN_PHRASES = [
  'context deadline exceeded',
  'failed to connect',
  'connection refused',
  'connection terminated',
  'connection timeout',
  'timeout',
  'timed out',
  'schema cache',
  'fetch failed',
  'network error',
  'networkerror',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'upstream connect error',
  'unhandled server error',
  'database system is',      // starting up / shutting down / in recovery
  'too many clients',
  'server closed the connection',
];

/** HTTP statuses that mean the service, not the caller, is the problem. */
const DOWN_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Did this failure mean "the backend could not answer" (as opposed to a real no)?
 *
 * Deliberately generous: a false positive costs a retry, a false negative tells a
 * member of staff they are not allowed into their own venue.
 *
 * @param {unknown} error a supabase-js error, a fetch error, or anything thrown
 * @returns {boolean}
 */
export function looksLikeBackendDown(error) {
  if (!error) return false;
  const e = /** @type {any} */ (error);

  // supabase-js AuthRetryableFetchError is explicitly "try again"
  const name = String(e.name ?? '');
  if (/retryable/i.test(name)) return true;

  const code = String(e.code ?? '').trim();
  if (code && DOWN_CODES.has(code)) return true;

  const status = Number(e.status ?? e.statusCode ?? e.httpStatus ?? NaN);
  if (Number.isFinite(status) && DOWN_STATUSES.has(status)) return true;

  const text = [e.message, e.details, e.hint, e.error_description, typeof e === 'string' ? e : '']
    .filter(Boolean).join(' ').toLowerCase();
  if (!text) return false;
  return DOWN_PHRASES.some((p) => text.includes(p));
}

/**
 * The answer a caller should get when the backend did not answer us.
 * `what` names the part that failed, in words a person could read.
 */
export function backendDownBody(what) {
  return {
    error: 'service_unavailable',
    // The wording matters. Staff read this. It must not sound like their fault.
    detail: 'The system is not answering right now. This is not a problem with your login or your access. Try again in a moment.',
    part: String(what || 'backend'),
    retry_after: RETRY_AFTER_SECONDS,
  };
}

/** Headers to send with a 503 so a well behaved client backs off rather than hammering. */
export function backendDownHeaders(extra = {}) {
  return { ...extra, 'Retry-After': String(RETRY_AFTER_SECONDS) };
}

/**
 * The three-way answer a permission check should give, instead of a boolean.
 * A boolean cannot tell "no" apart from "we could not find out", which is the
 * whole bug.
 */
export const ACCESS = Object.freeze({ YES: 'yes', NO: 'no', UNKNOWN: 'unknown' });

/**
 * Fold several read results into one access verdict.
 * @param {Array<{ data?: unknown, error?: unknown }>} results
 * @param {(results: Array<any>) => boolean} decide called ONLY when every read answered
 * @returns {'yes'|'no'|'unknown'}
 */
export function accessFrom(results, decide) {
  const list = Array.isArray(results) ? results : [];
  for (const r of list) {
    if (r && r.error && looksLikeBackendDown(r.error)) return ACCESS.UNKNOWN;
  }
  try {
    return decide(list) ? ACCESS.YES : ACCESS.NO;
  } catch {
    return ACCESS.UNKNOWN;
  }
}
