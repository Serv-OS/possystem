// supabase/functions/_shared/second-step.ts
//
// THE SECOND SIGN IN STEP, SERVER SIDE (docs/SECOND_STEP.md).
//
// A Back Office login that has only typed a password is "aal1". After Face ID,
// fingerprint or an authenticator app code it is "aal2". Every edge function that
// lets a real login do something calls secondStepRefusal(req) straight after its
// CORS preflight line:
//
//   const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock;
//
// RULES (mirrored by public.second_step_decide in 20260919s_OPS_second_step.sql;
// change both together):
//   * It only ever REFUSES. It never lets anyone in. Each function still proves who
//     the caller is (getUser) and what they may touch, exactly as before.
//   * Anonymous sessions (tills, kiosks, KDS, TVs, customer pages), the service role,
//     the bare public key and calls with no token at all ALWAYS pass, whatever the
//     switch says. A token we cannot read passes too: the function's own getUser
//     refuses it anyway.
//   * A real login at aal2 always passes.
//   * A real login at aal1 is refused only while the switch
//     public.second_step_settings.enforce is true. Peter flips it with one line of
//     SQL; no deploy. Default OFF, so this code can go live before anyone has set up.
//   * The switch is read with the service role and cached for 30 seconds. If it
//     cannot be read and we have never read it, the answer is OFF, i.e. FAIL
//     OPEN (see failClosed / neverRead below, and the reasoning at the top of
//     readEnforced). A missing table means the SQL has not run yet: also OFF.
//
//     THIS PARAGRAPH USED TO SAY "FAIL CLOSED", and it was wrong from the
//     20 Sep 2026 fix onwards: the code changed and the header did not. On
//     22 Sep, mid outage, that stale sentence sent an investigation looking for
//     a sign in lockout that could not happen, while the real fault was a
//     starving database. A comment that contradicts its own code costs an hour
//     in the exact hour you do not have one.
//
// Plain TypeScript with no Deno and no URL imports, so node:test can import it
// (src/lib/secondStep/secondStepServer.test.js).

export const SECOND_STEP_CODE = 'second_step_required';
export const SECOND_STEP_CHECK_FAILED = 'second_step_check_failed';
export const FLAG_TTL_MS = 30_000;
export const FLAG_RETRY_MS = 5_000;

export const SECOND_STEP_MESSAGE =
  'Your sign in needs its second step. Sign out, then sign in again with your passkey, or your authenticator app code.';
/**
 * PASSKEYS (20 Sep 2026). Supabase treats a passkey as a FIRST factor, so a passkey sign in is
 * aal1 however strong it is. Without this list every person who moved to a passkey would be
 * refused by every edge function the moment the switch went on. The same names live in
 * public.second_step_settings.passkey_methods and in src/lib/secondStep/rules.js.
 */
export const PASSKEY_METHODS = ['webauthn', 'passkey', 'webauthn_credential'];
export const SECOND_STEP_CHECK_FAILED_MESSAGE =
  'We could not check your sign in security just now. Please try again in a moment.';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

/** Deno.env when running as an edge function; empty in node tests. Never throws. */
export function envValue(name: string): string {
  try {
    const d = (globalThis as any).Deno;
    return String(d?.env?.get?.(name) ?? '');
  } catch {
    return '';
  }
}

type HeaderSource = { headers?: { get?: (name: string) => string | null } } | string | null | undefined;

/** The bearer token from a Request, a raw Authorization header value or a bare token. */
export function bearerToken(input: HeaderSource): string {
  if (!input) return '';
  let raw = '';
  if (typeof input === 'string') raw = input;
  else {
    try { raw = input.headers?.get?.('authorization') ?? input.headers?.get?.('Authorization') ?? ''; }
    catch { raw = ''; }
  }
  return String(raw || '').replace(/^Bearer\s+/i, '').trim();
}

/** The claims inside a JWT, WITHOUT checking the signature. Null when it is not a JWT. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Who is calling, as far as the second step is concerned.
 *   none        no token at all
 *   service     the service role (by key, or a service_role claim)
 *   unreadable  not a JWT we can read (the function's own getUser decides)
 *   no_user     a JWT with no user in it (the public anon key)
 *   anonymous   an anonymous session (till, kiosk, KDS, TV, customer page)
 *   aal2        a real login that finished its second step
 *   aal1        a real login that has only typed a password
 */
export type CallerKind = 'none' | 'service' | 'unreadable' | 'no_user' | 'anonymous' | 'aal2' | 'passkey' | 'aal1';

/** Did this token's session sign in with a passkey? Read from its own 'amr' claim. */
export function amrHasPasskey(claims: Record<string, unknown> | null, methods: string[] = PASSKEY_METHODS): boolean {
  const amr = (claims as any)?.amr;
  if (!Array.isArray(amr)) return false;
  const want = new Set(methods.map((m) => String(m).toLowerCase()));
  return amr.some((e: unknown) => want.has(String(typeof e === 'string' ? e : (e as any)?.method ?? '').toLowerCase()));
}

export function classifyCaller(token: string, serviceKeys: string[] = []): CallerKind {
  if (!token) return 'none';
  if (serviceKeys.some((k) => !!k && k === token)) return 'service';
  const c = decodeJwtClaims(token);
  if (!c) return 'unreadable';
  if (c.role === 'service_role') return 'service';
  if (typeof c.sub !== 'string' || !c.sub) return 'no_user';
  if (c.is_anonymous === true || c.is_anonymous === 'true') return 'anonymous';
  if (c.aal === 'aal2') return 'aal2';
  if (amrHasPasskey(c)) return 'passkey';   // aal1 by design, and done
  return 'aal1';
}

/** The whole rule in one line: only a password only real login can ever be refused. */
export function mustRefuse(kind: CallerKind, enforced: boolean): boolean {
  return kind === 'aal1' && enforced === true;
}

export type FlagSource = 'db' | 'no_row' | 'missing_table' | 'cache' | 'stale' | 'error';
export type FlagState = { enforced: boolean; source: FlagSource };
export type FlagRow = { enforce?: boolean | null } | null;
export type FlagFetch = () => Promise<FlagRow | 'missing_table'>;

/**
 * The enforcement switch with a short cache.
 *   * a good read is kept for ttlMs
 *   * a failed read keeps using the last good value ("stale") and retries after retryMs
 *   * a missing table or a missing row is OFF (the SQL has not run yet)
 *   * a failed read with no good value EVER: see failClosed below.
 *
 * FAIL OPEN UNTIL THE SWITCH HAS BEEN READ ONCE (fix round, 20 Sep 2026). The rollout spends
 * its whole life at enforce = false with everybody at aal1, so a cold instance whose first read
 * blipped used to refuse every Back Office save and every card payment on a till still running
 * on a person's session, for five seconds at a time, while the switch was OFF. A read that has
 * never once succeeded now means "we do not know", and the database fence is what refuses
 * anyway (it is the thing that cannot be blipped past). Once ANY read has succeeded, a later
 * failure keeps the last good answer, and if that answer was "on" it stays on.
 */
export function createFlagReader(opts: { fetchFlag: FlagFetch; now?: () => number; ttlMs?: number; retryMs?: number; failClosed?: boolean }) {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? FLAG_TTL_MS;
  const retryMs = opts.retryMs ?? FLAG_RETRY_MS;
  const neverRead = opts.failClosed === true;   // tests can ask for the old behaviour
  let good: { enforced: boolean; at: number } | null = null;
  let lastErrorAt = 0;
  let inflight: Promise<FlagState> | null = null;

  async function load(): Promise<FlagState> {
    try {
      const row = await opts.fetchFlag();
      if (row === 'missing_table') {
        good = { enforced: false, at: now() };
        return { enforced: false, source: 'missing_table' };
      }
      if (!row) {
        good = { enforced: false, at: now() };
        return { enforced: false, source: 'no_row' };
      }
      const enforced = row.enforce === true;
      good = { enforced, at: now() };
      lastErrorAt = 0;
      return { enforced, source: 'db' };
    } catch {
      lastErrorAt = now();
      if (good) return { enforced: good.enforced, source: 'stale' };
      return { enforced: neverRead, source: 'error' };
    }
  }

  async function read(): Promise<FlagState> {
    const t = now();
    if (good && t - good.at < ttlMs) return { enforced: good.enforced, source: 'cache' };
    if (lastErrorAt && t - lastErrorAt < retryMs) {
      return good ? { enforced: good.enforced, source: 'stale' } : { enforced: neverRead, source: 'error' };
    }
    if (!inflight) inflight = load().finally(() => { inflight = null; });
    return inflight;
  }

  function reset() { good = null; lastErrorAt = 0; inflight = null; }
  return { read, reset };
}

/** Read the switch through PostgREST with the service role. Plain fetch, no SDK. */
export async function fetchFlagFromDb(
  url: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FlagRow | 'missing_table'> {
  if (!url || !key) throw new Error('second step: SUPABASE_URL or the service role key is not set');
  // A hung PostgREST must never hold a card payment: two seconds, then the reader's own rules
  // decide (fix round, 20 Sep 2026).
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/second_step_settings?select=enforce&id=eq.true&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
  });
  if (res.ok) {
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? rows[0] as FlagRow : null;
  }
  const body = await res.text().catch(() => '');
  // PGRST205 = PostgREST cannot find the table; 42P01 = Postgres "relation does not exist".
  if (/PGRST205|42P01/.test(body)) return 'missing_table';
  throw new Error(`second step: switch read failed (${res.status})`);
}

let sharedReader: ReturnType<typeof createFlagReader> | null = null;
function defaultReader() {
  if (!sharedReader) {
    sharedReader = createFlagReader({
      fetchFlag: () => fetchFlagFromDb(envValue('SUPABASE_URL'), envValue('SUPABASE_SERVICE_ROLE_KEY')),
    });
  }
  return sharedReader;
}

/** A JSON refusal the app recognises by its code. Carries CORS headers so the browser shows it. */
export function refusalResponse(
  status = 403,
  code: string = SECOND_STEP_CODE,
  message: string = SECOND_STEP_MESSAGE,
): Response {
  return new Response(JSON.stringify({ error: message, code, second_step: true }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export type SecondStepOptions = {
  reader?: { read: () => Promise<FlagState> };
  serviceKeys?: string[];
};

/**
 * Null when the caller may carry on, or the Response to return when a password only
 * login must be refused. Never throws. Never refuses anyone who is not a real login at aal1.
 */
export async function secondStepRefusal(input: HeaderSource, opts: SecondStepOptions = {}): Promise<Response | null> {
  let kind: CallerKind = 'unreadable';
  try {
    kind = classifyCaller(bearerToken(input), opts.serviceKeys ?? [envValue('SUPABASE_SERVICE_ROLE_KEY')]);
  } catch {
    return null;
  }
  if (kind !== 'aal1') return null;
  let flag: FlagState;
  try {
    flag = await (opts.reader ?? defaultReader()).read();
  } catch {
    flag = { enforced: true, source: 'error' };
  }
  if (!mustRefuse(kind, flag.enforced)) return null;
  if (flag.source === 'error') return refusalResponse(503, SECOND_STEP_CHECK_FAILED, SECOND_STEP_CHECK_FAILED_MESSAGE);
  return refusalResponse(403);
}

/** Boolean form for helpers that answer "may this caller act?". */
export async function passesSecondStep(input: HeaderSource, opts: SecondStepOptions = {}): Promise<boolean> {
  return (await secondStepRefusal(input, opts)) === null;
}

/**
 * For actions that need the second step ALWAYS, switch or no switch (the reset function).
 * Null when the caller is a real login that did a second step: aal2, or a passkey sign in.
 */
export function requireAal2(input: HeaderSource, serviceKeys: string[] = [envValue('SUPABASE_SERVICE_ROLE_KEY')]): Response | null {
  const kind = classifyCaller(bearerToken(input), serviceKeys);
  // A passkey sign in counts: it is a second step, it is just not called aal2.
  if (kind === 'aal2' || kind === 'passkey') return null;
  if (kind === 'aal1') return refusalResponse(403);
  return refusalResponse(401, 'sign_in_required', 'Sign in to Back Office first.');
}
