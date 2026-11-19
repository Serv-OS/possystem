// src/lib/secondStep/secondStepServer.test.js
// The second sign in step, server side (docs/SECOND_STEP.md): the shared edge function
// helper supabase/functions/_shared/second-step.ts, its enforcement switch and cache, the aal
// checks, and parity with public.second_step_decide in 20260919s_OPS_second_step.sql.
// The promise tested hardest: anonymous devices and the service role are NEVER refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import {
  SECOND_STEP_CODE, SECOND_STEP_CHECK_FAILED, FLAG_TTL_MS, FLAG_RETRY_MS,
  bearerToken, decodeJwtClaims, classifyCaller, mustRefuse, createFlagReader, fetchFlagFromDb,
  secondStepRefusal, passesSecondStep, requireAal2, refusalResponse, amrHasPasskey, PASSKEY_METHODS,
  createDemoReader, fetchDemoOnlyFromDb,
} from '../../../supabase/functions/_shared/second-step.ts';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const SERVICE_KEY = 'service-role-key-for-tests';
const T = {
  till: jwt({ sub: 'd1', role: 'authenticated', is_anonymous: true, aal: 'aal1' }),
  aal1: jwt({ sub: 'u1', role: 'authenticated', is_anonymous: false, aal: 'aal1' }),
  aal2: jwt({ sub: 'u1', role: 'authenticated', is_anonymous: false, aal: 'aal2' }),
  noAal: jwt({ sub: 'u2', role: 'authenticated', is_anonymous: false }),
  anonKey: jwt({ role: 'anon', iss: 'supabase' }),
  serviceJwt: jwt({ role: 'service_role', iss: 'supabase' }),
};
const req = (token) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) } });
const reader = (state) => ({ read: async () => state, calls: 0 });
const ON = reader({ enforced: true, source: 'db' });
const OFF = reader({ enforced: false, source: 'db' });
const BROKEN = reader({ enforced: true, source: 'error' });
const THROWS = { read: async () => { throw new Error('boom'); } };
const opts = (r) => ({ reader: r, serviceKeys: [SERVICE_KEY] });

test('bearerToken reads a Request, a raw header value or a bare token', () => {
  assert.equal(bearerToken(req('abc')), 'abc');
  assert.equal(bearerToken('Bearer xyz'), 'xyz');
  assert.equal(bearerToken('bearer  xyz '), 'xyz');
  assert.equal(bearerToken('plain'), 'plain');
  assert.equal(bearerToken(null), '');
  assert.equal(bearerToken(req(null)), '');
});

test('classifyCaller: who is calling, as far as the second step is concerned', () => {
  assert.equal(classifyCaller('', [SERVICE_KEY]), 'none');
  assert.equal(classifyCaller(SERVICE_KEY, [SERVICE_KEY]), 'service');
  assert.equal(classifyCaller(T.serviceJwt, [SERVICE_KEY]), 'service');
  assert.equal(classifyCaller('sb_secret_not_a_jwt', [SERVICE_KEY]), 'unreadable');
  assert.equal(classifyCaller(T.anonKey, [SERVICE_KEY]), 'no_user');
  assert.equal(classifyCaller(T.till, [SERVICE_KEY]), 'anonymous');
  assert.equal(classifyCaller(T.aal2, [SERVICE_KEY]), 'aal2');
  assert.equal(classifyCaller(T.aal1, [SERVICE_KEY]), 'aal1');
  assert.equal(classifyCaller(T.noAal, [SERVICE_KEY]), 'aal1', 'no aal claim counts as password only');
  assert.equal(classifyCaller(jwt({ sub: 'x', is_anonymous: 'true' }), []), 'anonymous');
  assert.equal(classifyCaller(T.aal1, ['']), 'aal1', 'an empty service key never matches');
  assert.equal(decodeJwtClaims('x.y'), null);
});

test('mustRefuse: only a password only real login, and only while the switch is on', () => {
  for (const kind of ['none', 'service', 'unreadable', 'no_user', 'anonymous', 'aal2']) {
    assert.equal(mustRefuse(kind, true), false, kind);
    assert.equal(mustRefuse(kind, false), false, kind);
  }
  assert.equal(mustRefuse('aal1', true), true);
  assert.equal(mustRefuse('aal1', false), false);
});

test('anonymous devices and the service role are NEVER refused, whatever the switch or its health', async () => {
  for (const r of [ON, OFF, BROKEN, THROWS]) {
    for (const token of [T.till, T.aal2, T.anonKey, T.serviceJwt, SERVICE_KEY, 'garbage', '']) {
      assert.equal(await secondStepRefusal(req(token), opts(r)), null, `${token.slice(0, 12)} with ${JSON.stringify(r)}`);
    }
  }
});

test('a password only login is refused with the second step code once enforcement is on', async () => {
  assert.equal(await secondStepRefusal(req(T.aal1), opts(OFF)), null, 'off: allowed while people enrol');
  const res = await secondStepRefusal(req(T.aal1), opts(ON));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, SECOND_STEP_CODE);
  assert.equal(body.second_step, true);
  assert.match(body.error, /second step/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'the browser can read the refusal');
  assert.equal(await passesSecondStep(req(T.aal1), opts(ON)), false);
  assert.equal(await passesSecondStep(req(T.aal1), opts(OFF)), true);
  assert.equal(await passesSecondStep('Bearer ' + T.aal1, opts(ON)), false, 'raw header form, as authenticateCaller passes it');
});

test('fail closed: when the switch cannot be read at all, a password only login gets a retry message', async () => {
  const res = await secondStepRefusal(req(T.aal1), opts(BROKEN));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, SECOND_STEP_CHECK_FAILED);
  const thrown = await secondStepRefusal(req(T.aal1), opts(THROWS));
  assert.equal(thrown.status, 503);
});

test('requireAal2 (the reset function): the caller must have done the second step, switch or no switch', async () => {
  assert.equal(requireAal2(req(T.aal2), [SERVICE_KEY]), null);
  const a1 = requireAal2(req(T.aal1), [SERVICE_KEY]);
  assert.equal(a1.status, 403);
  assert.equal((await a1.json()).code, SECOND_STEP_CODE);
  for (const token of [T.till, T.anonKey, SERVICE_KEY, T.serviceJwt, '', 'garbage']) {
    const r = requireAal2(req(token), [SERVICE_KEY]);
    assert.ok(r && r.status === 401, `refused: ${token.slice(0, 10)}`);
  }
});

test('the switch cache: 30 second reads, stale value on errors, fail closed only when never read', async () => {
  assert.equal(FLAG_TTL_MS, 30000);
  assert.equal(FLAG_RETRY_MS, 5000);
  let now = 1_000_000;
  let calls = 0;
  let next = { enforce: false };
  const r = createFlagReader({ now: () => now, fetchFlag: async () => { calls++; if (next instanceof Error) throw next; return next; } });
  assert.deepEqual(await r.read(), { enforced: false, source: 'db' });
  assert.deepEqual(await r.read(), { enforced: false, source: 'cache' });
  assert.equal(calls, 1);
  next = { enforce: true };
  now += 29_999;
  assert.equal((await r.read()).enforced, false, 'still cached');
  now += 2;
  assert.deepEqual(await r.read(), { enforced: true, source: 'db' }, 'switched on within 30 seconds, no deploy');
  // the database hiccups: keep the last good answer, retry after 5 seconds
  next = new Error('network');
  now += FLAG_TTL_MS + 1;
  assert.deepEqual(await r.read(), { enforced: true, source: 'stale' });
  const before = calls;
  now += 1000;
  assert.deepEqual(await r.read(), { enforced: true, source: 'stale' });
  assert.equal(calls, before, 'no hammering inside the retry window');
  now += FLAG_RETRY_MS;
  next = { enforce: false };
  assert.deepEqual(await r.read(), { enforced: false, source: 'db' }, 'break glass seen on the next good read');
});

test('the switch: a missing table or row is OFF; a read that never worked does not refuse (fix round)', async () => {
  const missing = createFlagReader({ fetchFlag: async () => 'missing_table' });
  assert.deepEqual(await missing.read(), { enforced: false, source: 'missing_table' });
  const noRow = createFlagReader({ fetchFlag: async () => null });
  assert.deepEqual(await noRow.read(), { enforced: false, source: 'no_row' });
  // FAIL OPEN UNTIL THE SWITCH HAS BEEN READ ONCE (fix round, 20 Sep 2026). The rollout spends
  // its whole life at enforce = false with everyone at aal1: a cold instance whose first read
  // blipped used to refuse every Back Office save and every card payment on a till still on a
  // person's session, for five seconds at a time, while the switch was OFF. The database fence
  // is what refuses; it cannot be blipped past.
  const neverRead = createFlagReader({ fetchFlag: async () => { throw new Error('down'); } });
  assert.deepEqual(await neverRead.read(), { enforced: false, source: 'error' });
  const strict = createFlagReader({ fetchFlag: async () => { throw new Error('down'); }, failClosed: true });
  assert.deepEqual(await strict.read(), { enforced: true, source: 'error' }, 'the old behaviour is still one flag away');
  // and once a GOOD read says "on", a later failure keeps refusing
  let answer = { enforce: true };
  const wasOn = createFlagReader({ fetchFlag: async () => { const a = answer; if (!a) throw new Error('down'); return a; }, ttlMs: 0, retryMs: 0 });
  assert.equal((await wasOn.read()).enforced, true);
  answer = null;
  assert.deepEqual(await wasOn.read(), { enforced: true, source: 'stale' });
  const junk = createFlagReader({ fetchFlag: async () => ({ enforce: 'yes' }) });
  assert.equal((await junk.read()).enforced, false, 'only a real true switches it on');
});

test('the switch: concurrent reads share one database call', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = createFlagReader({ fetchFlag: async () => { calls++; await gate; return { enforce: true }; } });
  const all = Promise.all([r.read(), r.read(), r.read()]);
  release();
  const out = await all;
  assert.equal(calls, 1);
  assert.ok(out.every((x) => x.enforced === true));
});

test('fetchFlagFromDb: PostgREST answers, missing table codes, and real errors', async () => {
  const seen = [];
  const fake = (status, body) => async (url, init) => {
    seen.push({ url, init });
    return { ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  assert.deepEqual(await fetchFlagFromDb('https://x.supabase.co/', 'k', fake(200, [{ enforce: true }])), { enforce: true });
  assert.equal(seen[0].url, 'https://x.supabase.co/rest/v1/second_step_settings?select=enforce&id=eq.true&limit=1');
  assert.equal(seen[0].init.headers.apikey, 'k');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer k');
  assert.equal(await fetchFlagFromDb('https://x', 'k', fake(200, [])), null);
  assert.equal(await fetchFlagFromDb('https://x', 'k', fake(404, { code: 'PGRST205', message: "Could not find the table 'public.second_step_settings'" })), 'missing_table');
  assert.equal(await fetchFlagFromDb('https://x', 'k', fake(400, { code: '42P01' })), 'missing_table');
  await assert.rejects(fetchFlagFromDb('https://x', 'k', fake(500, 'upstream')));
  await assert.rejects(fetchFlagFromDb('https://x', 'k', fake(404, 'not found')), 'a bare 404 is an error, not OFF');
  await assert.rejects(fetchFlagFromDb('', 'k', fake(200, [])));
});

test('refusalResponse carries JSON and CORS', async () => {
  const r = refusalResponse();
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Content-Type'), 'application/json');
  assert.equal((await r.json()).code, SECOND_STEP_CODE);
});

test('PARITY: the SQL rule (second_step_decide) and the edge rule agree on every self test row', () => {
  const sql = fs.readFileSync(new URL('../../../supabase/migrations/20260919s_OPS_second_step.sql', import.meta.url), 'utf8');
  // rows like: ('label', '{...}'::jsonb | null::jsonb, true|false|null, true|false)
  const rows = [...sql.matchAll(/\('([^']+)',\s+(null::jsonb|'(\{[^']*\})'::jsonb),\s+(true|false|null),\s+(true|false)\)/g)];
  assert.ok(rows.length >= 9, `found ${rows.length} self test rows`);
  for (const m of rows) {
    const [, label, , claimsJson, enforceRaw, expectedRaw] = m;
    const claims = claimsJson ? JSON.parse(claimsJson) : null;
    const token = claims ? jwt(claims) : '';
    const kind = classifyCaller(token, [SERVICE_KEY]);
    const enforced = enforceRaw === 'true';
    const allowed = !mustRefuse(kind, enforced);
    assert.equal(allowed, expectedRaw === 'true', `row "${label}": edge says ${allowed}, SQL expects ${expectedRaw}`);
  }
});


// ── PASSKEYS (20 Sep 2026) ─────────────────────────────────────────────────────────────────
// Supabase calls a passkey a FIRST factor, so a passkey sign in is aal1 forever. Without this,
// every edge function would refuse every person who did exactly what we asked them to do.
const passkeyJwt = (amr) => jwt({ sub: 'u9', role: 'authenticated', is_anonymous: false, aal: 'aal1', amr });

test('a passkey sign in is its own kind of caller, not a password only one', () => {
  assert.deepEqual(PASSKEY_METHODS, ['webauthn', 'passkey', 'webauthn_credential']);
  assert.equal(classifyCaller(passkeyJwt([{ method: 'webauthn' }]), [SERVICE_KEY]), 'passkey');
  assert.equal(classifyCaller(passkeyJwt(['passkey']), [SERVICE_KEY]), 'passkey');
  assert.equal(classifyCaller(passkeyJwt([{ method: 'WEBAUTHN_CREDENTIAL' }]), [SERVICE_KEY]), 'passkey');
  assert.equal(classifyCaller(passkeyJwt([{ method: 'password' }]), [SERVICE_KEY]), 'aal1');
  assert.equal(classifyCaller(passkeyJwt([]), [SERVICE_KEY]), 'aal1');
  // The reader itself, on claims.
  assert.equal(amrHasPasskey({ amr: [{ method: 'password' }, { method: 'webauthn' }] }), true);
  assert.equal(amrHasPasskey({ amr: [{ method: 'otp' }] }), false);
  assert.equal(amrHasPasskey({}), false);
  assert.equal(amrHasPasskey(null), false);
});

test('a passkey session is never refused, switch on or off, and may do a reset', async () => {
  const on = { read: async () => ({ enforced: true, source: 'db' }) };
  assert.equal(mustRefuse('passkey', true), false, 'the whole rule in one line');
  assert.equal(
    await secondStepRefusal({ headers: { get: () => `Bearer ${passkeyJwt([{ method: 'webauthn' }])}` } }, { reader: on, serviceKeys: [SERVICE_KEY] }),
    null,
  );
  // requireAal2 is the always on check (the lost phone reset). A passkey counts.
  assert.equal(requireAal2({ headers: { get: () => `Bearer ${passkeyJwt([{ method: 'webauthn' }])}` } }, [SERVICE_KEY]), null);
  // And a password only login still does not.
  const refused = requireAal2({ headers: { get: () => `Bearer ${T.aal1}` } }, [SERVICE_KEY]);
  assert.equal(refused?.status, 403);
});

test('the database rule and this file still agree, now including the passkey branch', () => {
  const sql = fs.readFileSync(new URL('../../../supabase/migrations/20260920p_OPS_passkey_second_step.sql', import.meta.url), 'utf8');
  assert.match(sql, /when coalesce\(p_passkey, false\)\s+then true/, 'the SQL has the same branch');
  assert.match(sql, /passkey_methods/, 'and the same list of method names, as a setting');
  const ts = fs.readFileSync(new URL('../../../supabase/functions/_shared/second-step.ts', import.meta.url), 'utf8');
  assert.match(ts, /if \(amrHasPasskey\(c\)\) return 'passkey';/);
});

// ── THE DEMO LOGIN ALLOWANCE (App Review, 13 Nov 2026) ───────────────────────────────
// Apple signed in to the Owner app with the demo account and then saw the second step
// message where the figures should be: the sign in screen and the row rules honoured
// public.second_step_demo_only, and this file did not. What must stay true:
//   * only a login the switch has ALREADY decided to refuse is ever asked about;
//   * a clear yes from the database lets it carry on, and nothing else does;
//   * a failed or slow check refuses, exactly as before the allowance existed;
//   * the answer is cached per login, and a failure is never cached.

const demoReaderOf = (answer) => ({ read: async (uid) => (typeof answer === 'function' ? answer(uid) : answer) });

test('a demo only login carries on; everyone else is still refused', async () => {
  const yes = { ...opts(ON), demoReader: demoReaderOf(true) };
  assert.equal(await secondStepRefusal(req(T.aal1), yes), null, 'the demo login is let through');

  const no = { ...opts(ON), demoReader: demoReaderOf(false) };
  const refused = await secondStepRefusal(req(T.aal1), no);
  assert.equal(refused?.status, 403, 'an ordinary password only login is still refused');

  // The allowance is never even reached while the switch is off: nobody is refused then.
  assert.equal(await secondStepRefusal(req(T.aal1), { ...opts(OFF), demoReader: demoReaderOf(false) }), null);
});

test('only a clear yes opens it, and a broken check refuses', async () => {
  for (const answer of [undefined, null, 0, '', 'true', 1, {}, []]) {
    const res = await secondStepRefusal(req(T.aal1), { ...opts(ON), demoReader: demoReaderOf(answer) });
    assert.equal(res?.status, 403, `demo answer ${JSON.stringify(answer)} must not open it`);
  }
  const throws = { ...opts(ON), demoReader: { read: async () => { throw new Error('postgrest down'); } } };
  assert.equal((await secondStepRefusal(req(T.aal1), throws))?.status, 403, 'a failed check refuses');
});

test('the rule is asked about the login in the token, nobody else', async () => {
  let asked = null;
  const seen = { ...opts(ON), demoReader: demoReaderOf((uid) => { asked = uid; return false; }) };
  await secondStepRefusal(req(T.aal1), seen);
  assert.equal(asked, decodeJwtClaims(T.aal1).sub, 'the sub from the bearer token');
});

test('createDemoReader caches a yes and a no per login, and never caches a failure', async () => {
  let now = 0;
  let calls = 0;
  let mode = 'yes';
  const r = createDemoReader({
    now: () => now,
    ttlMs: 1000,
    fetchDemo: async (uid) => {
      calls++;
      if (mode === 'boom') throw new Error('down');
      return mode === 'yes' && uid === 'demo-user';
    },
  });

  assert.equal(await r.read('demo-user'), true);
  assert.equal(await r.read('demo-user'), true);
  assert.equal(calls, 1, 'the answer is kept');

  assert.equal(await r.read('real-user'), false);
  assert.equal(calls, 2, 'each login is asked about separately');

  now += 1001;
  assert.equal(await r.read('demo-user'), true);
  assert.equal(calls, 3, 'and asked again once it goes stale');

  mode = 'boom';
  now += 1001;
  assert.equal(await r.read('demo-user'), false, 'a failure answers no');
  assert.equal(await r.read('demo-user'), false);
  assert.equal(calls, 5, 'and is asked again every time, never cached');

  assert.equal(await r.read(''), false, 'no login, no allowance');
  assert.equal(calls, 5, 'and nothing is asked');
});

test('createDemoReader does not grow without bound', async () => {
  const r = createDemoReader({ max: 3, fetchDemo: async () => false });
  for (let i = 0; i < 10; i++) await r.read(`u${i}`);
  // Nothing to assert beyond it not throwing and still answering.
  assert.equal(await r.read('u0'), false);
});

test('fetchDemoOnlyFromDb posts the login to the rule with the service role', async () => {
  let got = null;
  const ok = async (url, init) => { got = { url, init }; return { ok: true, json: async () => true }; };
  assert.equal(await fetchDemoOnlyFromDb('https://x.supabase.co/', 'svc', 'u1', ok), true);
  assert.match(got.url, /\/rest\/v1\/rpc\/second_step_demo_only$/);
  assert.equal(got.init.method, 'POST');
  assert.equal(JSON.parse(got.init.body).p_user, 'u1');
  assert.equal(got.init.headers.apikey, 'svc');

  const notTrue = async () => ({ ok: true, json: async () => 'true' });
  assert.equal(await fetchDemoOnlyFromDb('https://x.supabase.co', 'svc', 'u1', notTrue), false,
    'only the boolean true counts');

  const bad = async () => ({ ok: false, status: 500, text: async () => '' });
  await assert.rejects(() => fetchDemoOnlyFromDb('https://x.supabase.co', 'svc', 'u1', bad));
  await assert.rejects(() => fetchDemoOnlyFromDb('', 'svc', 'u1', ok), /SUPABASE_URL/);
  assert.equal(await fetchDemoOnlyFromDb('https://x.supabase.co', 'svc', '', ok), false, 'no login, no call');
});
