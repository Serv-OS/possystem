// src/lib/secondStep/passkey.test.js
//
// PASSKEY SIGN IN (docs/SECOND_STEP.md), the rules and the client, with fakes for the browser
// and for GoTrue. Peter, 20 Sep 2026: "I just want it more secure I hate multi factor auth
// apps, this is what toast does I want this", and "we need this for every user across every
// device". So the tests care most about two things:
//   * nobody is ever locked out (the last way in cannot be removed; a device with no
//     fingerprint still has a way through)
//   * a passkey only works on our own domain, never on possystem-liard.vercel.app
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PASSKEY_ORIGINS, PASSKEY_RP_ID, passkeyHostAllowed, wrongHostMessage, signInPlan, secondStepPlan,
  suggestPasskeyName, passkeyPrompt, canRemovePasskey, explainPasskeyError,
} from './passkeyRules.js';
import {
  fromBase64Url, toBase64Url, creationOptionsFromJson, requestOptionsFromJson, credentialToJson,
  passkeySupport, createPasskeyClient,
} from './passkey.js';
import {
  PASSKEY_AMR_METHODS, sessionUsedPasskey, sessionProvesSecondStep, gateStep, passesWithoutNetwork,
} from './rules.js';
import { Buffer } from 'node:buffer';

// ── where a passkey works ──────────────────────────────────────────────────────────────────
test('a passkey belongs to serv-os.app and nowhere else', () => {
  assert.equal(PASSKEY_RP_ID, 'serv-os.app');
  for (const origin of PASSKEY_ORIGINS) assert.equal(passkeyHostAllowed(origin), true, origin);
  assert.equal(passkeyHostAllowed('serv-os.app'), true);
  // The old Vercel address can never be a passkey origin: it is not under our domain.
  assert.equal(passkeyHostAllowed('possystem-liard.vercel.app'), false);
  assert.equal(passkeyHostAllowed('serv-os.app.evil.com'), false);
  assert.equal(passkeyHostAllowed('notserv-os.app'), false);
  assert.equal(passkeyHostAllowed(''), false);
  assert.equal(passkeyHostAllowed(null), false);
  // localhost only while developing.
  assert.equal(passkeyHostAllowed('localhost'), false);
  assert.equal(passkeyHostAllowed('localhost', { allowLocalhost: true }), true);
  assert.equal(passkeyHostAllowed('127.0.0.1', { allowLocalhost: true }), true);
  // Case does not matter: a browser may hand us the host in any case.
  assert.equal(passkeyHostAllowed('APP.Serv-OS.App'), true);
});

test('somebody on the wrong address is told where to go, and can still get in', () => {
  const m = wrongHostMessage('possystem-liard.vercel.app');
  assert.match(m, /app\.serv-os\.app/);
  assert.match(m, /possystem-liard\.vercel\.app/);
  assert.match(m, /password/i, 'never a dead end: the password route is still offered');
  assert.equal(m.includes('—'), false, 'no em dashes');
  assert.equal(m.includes('–'), false, 'no en dashes');
});

// ── what the sign in screen offers ─────────────────────────────────────────────────────────
test('sign in offers a passkey only where one can work', () => {
  assert.deepEqual(signInPlan({ hostname: 'app.serv-os.app', supported: true }), { primary: 'passkey', canUsePasskey: true });
  assert.deepEqual(signInPlan({ hostname: 'app.serv-os.app', supported: false }), { primary: 'password', canUsePasskey: false });
  assert.deepEqual(signInPlan({ hostname: 'possystem-liard.vercel.app', supported: true }), { primary: 'wrong_host', canUsePasskey: false });
  assert.deepEqual(signInPlan({ hostname: 'localhost', supported: true, allowLocalhost: true }), { primary: 'passkey', canUsePasskey: true });
});

// ── what the second step asks for ──────────────────────────────────────────────────────────
test('the second step is a passkey, and the emailed code comes before the FIRST one', () => {
  // Normal: nothing set up, this device can make one, the email is already proved.
  assert.equal(secondStepPlan({ canUsePasskey: true, needsEmail: true, emailProved: true }), 'register_passkey');
  // A stolen password must not be able to register the thief's own passkey.
  assert.equal(secondStepPlan({ canUsePasskey: true, needsEmail: true, emailProved: false }), 'prove_email');
  // The server can waive the email (an invited login that already proved itself).
  assert.equal(secondStepPlan({ canUsePasskey: true, needsEmail: false, emailProved: false }), 'register_passkey');
  // A device with no fingerprint or face still has a way through: the authenticator app.
  assert.equal(secondStepPlan({ canUsePasskey: false }), 'app_code');
  // Already done, either way round.
  assert.equal(secondStepPlan({ passkeys: [{ id: 'k1' }], canUsePasskey: true, needsEmail: true }), 'ok');
  assert.equal(secondStepPlan({ factors: [{ factor_type: 'totp', status: 'verified' }], canUsePasskey: true }), 'ok');
  // An app that is started but not finished is not a second step.
  assert.equal(secondStepPlan({ factors: [{ factor_type: 'totp', status: 'unverified' }], canUsePasskey: false }), 'app_code');
  assert.equal(secondStepPlan(), 'app_code', 'no arguments: never claim somebody is set up');
});

// ── never lock anybody out ─────────────────────────────────────────────────────────────────
test('the last way in can never be removed', () => {
  const one = [{ id: 'k1', friendlyName: 'Mac' }];
  const two = [...one, { id: 'k2', friendlyName: 'iPhone' }];
  const app = [{ factor_type: 'totp', status: 'verified' }];

  assert.equal(canRemovePasskey({ passkeys: one, factors: [], id: 'k1' }).ok, false);
  assert.equal(canRemovePasskey({ passkeys: one, factors: [], id: 'k1' }).reason, 'last');
  assert.match(canRemovePasskey({ passkeys: one, factors: [], id: 'k1' }).message, /another device/i);
  // A second passkey, or a kept code, makes it safe.
  assert.equal(canRemovePasskey({ passkeys: two, factors: [], id: 'k1' }).ok, true);
  assert.equal(canRemovePasskey({ passkeys: one, factors: app, id: 'k1' }).ok, true);
  // An unfinished authenticator app is NOT a kept code.
  assert.equal(canRemovePasskey({ passkeys: one, factors: [{ factor_type: 'totp', status: 'unverified' }], id: 'k1' }).ok, false);
  // Unknown ids are refused, never silently treated as a removal.
  assert.equal(canRemovePasskey({ passkeys: two, factors: [], id: 'nope' }).ok, false);
  assert.equal(canRemovePasskey({ passkeys: two, factors: [], id: 'nope' }).reason, 'unknown');
  assert.equal(canRemovePasskey({ passkeys: two, factors: [] }).ok, false);
  assert.equal(canRemovePasskey().ok, false);
});

// ── plain words ────────────────────────────────────────────────────────────────────────────
test('the device is named the way the person would name it', () => {
  assert.equal(suggestPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(suggestPasskeyName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'iPad');
  assert.equal(suggestPasskeyName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac');
  assert.equal(suggestPasskeyName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows PC');
  assert.equal(suggestPasskeyName('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'Android phone');
  assert.equal(suggestPasskeyName('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)'), 'Chromebook');
  assert.equal(suggestPasskeyName(''), 'This device');
});

test('the person is asked for what their own device actually calls it', () => {
  assert.match(passkeyPrompt('Mozilla/5.0 (iPhone)'), /Face ID/);
  assert.match(passkeyPrompt('Mozilla/5.0 (Macintosh)'), /Touch ID/);
  assert.match(passkeyPrompt('Mozilla/5.0 (Windows NT 10.0)'), /Windows Hello/);
  assert.match(passkeyPrompt('Mozilla/5.0 (Linux; Android 14)'), /fingerprint/);
  assert.match(passkeyPrompt(''), /fingerprint, face or device PIN/);
});

test('a failed ceremony is explained, never dumped raw, and never a dead end', () => {
  const cancelled = explainPasskeyError({ name: 'NotAllowedError', message: 'The operation either timed out or was not allowed' });
  assert.match(cancelled, /cancelled or timed out/i);
  assert.match(explainPasskeyError({ name: 'InvalidStateError' }), /already has a passkey/i);
  assert.match(explainPasskeyError({ name: 'NotSupportedError' }), /password/i, 'a device that cannot: tell them the other way in');
  assert.match(explainPasskeyError({ message: 'passkey_not_found' }), /Sign in with your password/i);
  assert.match(explainPasskeyError({ message: 'over_request_rate_limit' }), /Wait a minute/i);
  assert.match(explainPasskeyError({ message: 'passkeys are not enabled for this project' }), /not switched on/i);
  assert.match(explainPasskeyError(new Error('x'.repeat(400))), /Try again, or use your password/);
  for (const e of [{ name: 'NotAllowedError' }, { name: 'InvalidStateError' }, { name: 'NotSupportedError' }]) {
    const m = explainPasskeyError(e);
    assert.equal(m.includes('—') || m.includes('–'), false, 'no em or en dashes');
  }
});

// ── the WebAuthn plumbing ──────────────────────────────────────────────────────────────────
test('base64url survives a round trip, both ways', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  assert.equal(toBase64Url(bytes).includes('+'), false);
  assert.equal(toBase64Url(bytes).includes('/'), false);
  assert.equal(toBase64Url(bytes).includes('='), false);
  assert.deepEqual(fromBase64Url(''), new Uint8Array(0));
  // The URL safe alphabet is decoded, not just the standard one.
  assert.deepEqual(fromBase64Url('-_8'), new Uint8Array([251, 255]));
});

test('server options become browser options, with or without a Level 3 browser', () => {
  const options = {
    challenge: toBase64Url(new Uint8Array([1, 2, 3])),
    rp: { id: 'serv-os.app', name: 'ServOS' },
    user: { id: toBase64Url(new Uint8Array([9, 9])), name: 'peter@posup.co.uk', displayName: 'Peter' },
    excludeCredentials: [{ id: toBase64Url(new Uint8Array([7])), type: 'public-key' }],
  };
  const byHand = creationOptionsFromJson(options, { PublicKeyCredential: {} });
  assert.deepEqual(byHand.challenge, new Uint8Array([1, 2, 3]));
  assert.deepEqual(byHand.user.id, new Uint8Array([9, 9]));
  assert.deepEqual(byHand.excludeCredentials[0].id, new Uint8Array([7]));
  assert.equal(byHand.rp.id, 'serv-os.app', 'the relying party is left exactly as the server sent it');

  // A Level 3 browser does it for us, and we must use ITS answer.
  const level3 = { parseCreationOptionsFromJSON: (o) => ({ parsed: true, from: o }) };
  assert.deepEqual(creationOptionsFromJson(options, { PublicKeyCredential: level3 }), { parsed: true, from: options });

  const ask = { challenge: toBase64Url(new Uint8Array([4])), allowCredentials: [{ id: toBase64Url(new Uint8Array([5])), type: 'public-key' }] };
  assert.deepEqual(requestOptionsFromJson(ask, { PublicKeyCredential: {} }).allowCredentials[0].id, new Uint8Array([5]));
  const level3b = { parseRequestOptionsFromJSON: () => ({ parsed: true }) };
  assert.deepEqual(requestOptionsFromJson(ask, { PublicKeyCredential: level3b }), { parsed: true });
});

test('a credential becomes JSON the server understands, registering and signing in', () => {
  // Registering.
  const made = {
    id: 'cred-1', rawId: new Uint8Array([1]), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: new Uint8Array([2]), attestationObject: new Uint8Array([3]), getTransports: () => ['internal', 'hybrid'] },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  };
  const j = credentialToJson(made);
  assert.equal(j.id, 'cred-1');
  assert.equal(j.rawId, toBase64Url(new Uint8Array([1])));
  assert.equal(j.response.attestationObject, toBase64Url(new Uint8Array([3])));
  assert.deepEqual(j.response.transports, ['internal', 'hybrid']);
  assert.deepEqual(j.clientExtensionResults, { credProps: { rk: true } });
  assert.equal(j.authenticatorAttachment, 'platform');

  // Signing in: a signature, and no attestation.
  const used = {
    id: 'cred-1', rawId: new Uint8Array([1]), type: 'public-key',
    response: { clientDataJSON: new Uint8Array([2]), authenticatorData: new Uint8Array([4]), signature: new Uint8Array([5]), userHandle: new Uint8Array([6]) },
  };
  const s = credentialToJson(used);
  assert.equal(s.response.signature, toBase64Url(new Uint8Array([5])));
  assert.equal(s.response.userHandle, toBase64Url(new Uint8Array([6])));
  assert.equal('attestationObject' in s.response, false);

  // A Level 3 browser hands us the JSON itself.
  assert.deepEqual(credentialToJson({ toJSON: () => ({ done: true }) }), { done: true });
  assert.equal(credentialToJson(null), null);
});

test('a device with no passkey maker says so instead of throwing', async () => {
  assert.deepEqual(await passkeySupport({ PublicKeyCredential: null, navigatorRef: {} }), { usable: false, reason: 'browser' });
  assert.deepEqual(
    await passkeySupport({ PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false }, navigatorRef: { credentials: {} } }),
    { usable: false, reason: 'device' },
  );
  assert.deepEqual(
    await passkeySupport({ PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => { throw new Error('nope'); } }, navigatorRef: { credentials: {} } }),
    { usable: false, reason: 'device' },
  );
  assert.deepEqual(
    await passkeySupport({ PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }, navigatorRef: { credentials: {} } }),
    { usable: true, reason: 'ok' },
  );
});

// ── the client against a fake GoTrue ───────────────────────────────────────────────────────
const CH = toBase64Url(new Uint8Array([1, 2, 3]));

function fakeServer(overrides = {}) {
  const calls = [];
  const fetchImpl = async (u, init) => {
    const path = String(u).replace(/^.*\/auth\/v1/, '');
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method, body, headers: init?.headers });
    const hit = overrides[`${init?.method} ${path}`];
    if (hit) return hit(body);
    if (path === '/passkeys/registration/options') {
      return { ok: true, json: async () => ({ challenge_id: 'c1', options: { challenge: CH, rp: { id: 'serv-os.app' }, user: { id: CH, name: 'p' } } }) };
    }
    if (path === '/passkeys/registration/verify') {
      return { ok: true, json: async () => ({ id: 'cred-1', friendly_name: body?.friendly_name || '' }) };
    }
    if (path === '/passkeys/authentication/options') {
      return { ok: true, json: async () => ({ challenge_id: 'c2', options: { challenge: CH } }) };
    }
    if (path === '/passkeys/authentication/verify') {
      return { ok: true, json: async () => ({ session: { access_token: 'at', refresh_token: 'rt' }, user: { id: 'u1', email: 'peter@posup.co.uk' } }) };
    }
    if (path === '/passkeys' && (!init?.method || init.method === 'GET')) {
      return { ok: true, json: async () => ([{ id: 'k1', friendly_name: 'Mac', created_at: '2026-09-20T09:00:00Z', last_used_at: null }]) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const fakeCreds = (made) => ({ create: async (o) => ({ ...made, asked: o }), get: async (o) => ({ ...made, asked: o }) });

const REG_CRED = {
  id: 'cred-1', rawId: new Uint8Array([1]), type: 'public-key',
  response: { clientDataJSON: new Uint8Array([2]), attestationObject: new Uint8Array([3]) },
};
const AUTH_CRED = {
  id: 'cred-1', rawId: new Uint8Array([1]), type: 'public-key',
  response: { clientDataJSON: new Uint8Array([2]), authenticatorData: new Uint8Array([4]), signature: new Uint8Array([5]) },
};

test('registering: options, the browser ceremony, then verify, with the token every time', async () => {
  const { fetchImpl, calls } = fakeServer();
  const client = createPasskeyClient({
    url: 'https://p.supabase.co/', anonKey: 'anon', getToken: async () => 'tok',
    fetchImpl, credentials: fakeCreds(REG_CRED), PublicKeyCredential: {},
  });
  const made = await client.register({ friendlyName: 'Mac' });
  assert.equal(made.credentialId, 'cred-1');
  assert.equal(made.friendlyName, 'Mac');
  assert.deepEqual(calls.map((c) => c.path), ['/passkeys/registration/options', '/passkeys/registration/verify']);
  // The signed in token, not the anon key: registration belongs to a login.
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].body.challenge_id, 'c1', 'the same challenge is sent back');
  assert.equal(calls[1].body.credential.response.attestationObject, toBase64Url(new Uint8Array([3])));
  // The trailing slash on the project url must not double up.
  assert.equal(String(calls[0].path).startsWith('/passkeys'), true);
});

test('registering without a session never reaches the server', async () => {
  const { fetchImpl, calls } = fakeServer();
  const client = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => null, fetchImpl, credentials: fakeCreds(REG_CRED), PublicKeyCredential: {} });
  await assert.rejects(() => client.register({}), /Sign in first/);
  assert.equal(calls.length, 0);
});

test('a cancelled registration is an error, not a half made passkey', async () => {
  const { fetchImpl, calls } = fakeServer();
  const client = createPasskeyClient({
    url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetchImpl,
    credentials: { create: async () => null }, PublicKeyCredential: {},
  });
  await assert.rejects(() => client.register({}), /cancelled/i);
  assert.deepEqual(calls.map((c) => c.path), ['/passkeys/registration/options'], 'verify is never called');
});

test('signing in with a passkey hands the new session to the app', async () => {
  const { fetchImpl, calls } = fakeServer();
  const handed = [];
  const client = createPasskeyClient({
    url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => null,
    setSession: async (s) => { handed.push(s); },
    fetchImpl, credentials: fakeCreds(AUTH_CRED), PublicKeyCredential: {},
  });
  const out = await client.signIn();
  assert.equal(out.user.email, 'peter@posup.co.uk');
  assert.deepEqual(handed, [{ access_token: 'at', refresh_token: 'rt' }]);
  // No session is needed to START: the anon key carries the request.
  assert.equal(calls[0].headers.Authorization, 'Bearer anon');
  assert.deepEqual(calls.map((c) => c.path), ['/passkeys/authentication/options', '/passkeys/authentication/verify']);
});

test('a verify with no session in it is refused, and the app is not signed in', async () => {
  const { fetchImpl } = fakeServer({
    'POST /passkeys/authentication/verify': async () => ({ ok: true, json: async () => ({ user: { id: 'u1' } }) }),
  });
  const handed = [];
  const client = createPasskeyClient({
    url: 'https://p.supabase.co', anonKey: 'anon', setSession: async (s) => { handed.push(s); },
    fetchImpl, credentials: fakeCreds(AUTH_CRED), PublicKeyCredential: {},
  });
  await assert.rejects(() => client.signIn(), /did not sign you in/i);
  assert.deepEqual(handed, []);
});

test('a bare session shape (access_token at the top) still signs in', async () => {
  const { fetchImpl } = fakeServer({
    'POST /passkeys/authentication/verify': async () => ({ ok: true, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', user: { id: 'u2' } }) }),
  });
  const handed = [];
  const client = createPasskeyClient({
    url: 'https://p.supabase.co', anonKey: 'anon', setSession: async (s) => { handed.push(s); },
    fetchImpl, credentials: fakeCreds(AUTH_CRED), PublicKeyCredential: {},
  });
  const out = await client.signIn();
  assert.equal(out.user.id, 'u2');
  assert.deepEqual(handed, [{ access_token: 'at2', refresh_token: 'rt2' }]);
});

test('a server error carries its own words and its status, for explainPasskeyError', async () => {
  const { fetchImpl } = fakeServer({
    'POST /passkeys/authentication/options': async () => ({ ok: false, status: 429, json: async () => ({ msg: 'over_request_rate_limit', error_code: 'over_request_rate_limit' }) }),
  });
  const client = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', fetchImpl, credentials: fakeCreds(AUTH_CRED), PublicKeyCredential: {} });
  await assert.rejects(() => client.signIn(), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.code, 'over_request_rate_limit');
    assert.match(explainPasskeyError(e), /Wait a minute/);
    return true;
  });
});

test('listing: every shape GoTrue might use, and never a throw without a session', async () => {
  const { fetchImpl } = fakeServer();
  const client = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetchImpl, credentials: fakeCreds(REG_CRED), PublicKeyCredential: {} });
  assert.deepEqual(await client.list(), [{ id: 'k1', friendlyName: 'Mac', createdAt: '2026-09-20T09:00:00Z', lastUsedAt: null }]);

  const wrapped = fakeServer({ 'GET /passkeys': async () => ({ ok: true, json: async () => ({ passkeys: [{ credential_id: 'k2', friendlyName: 'iPhone' }] }) }) });
  const c2 = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetchImpl: wrapped.fetchImpl, PublicKeyCredential: {} });
  assert.deepEqual(await c2.list(), [{ id: 'k2', friendlyName: 'iPhone', createdAt: null, lastUsedAt: null }]);

  const none = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => null, fetchImpl, PublicKeyCredential: {} });
  assert.deepEqual(await none.list(), []);
});

test('removing and renaming go to the right place, with the id escaped', async () => {
  const { fetchImpl, calls } = fakeServer();
  const client = createPasskeyClient({ url: 'https://p.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetchImpl, PublicKeyCredential: {} });
  await client.remove('a/b');
  await client.rename('k1', 'Work laptop');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].path, '/passkeys/a%2Fb');
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body, { friendly_name: 'Work laptop' });
});

// ── the wiring: the screens really use the rules ───────────────────────────────────────────
test('the screens use the rules, and the fence still decides who gets in', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

  const login = read('../../backoffice/BOLogin.jsx');
  assert.match(login, /signInWithPasskey\(\)/, 'the sign in screen offers a passkey');
  assert.match(login, /wrongHostMessage/, 'and says so on the wrong address');
  assert.match(login, /or use your password/, 'the password is always still there');

  const gate = read('../../components/secondStep/SecondStepGate.jsx');
  assert.match(gate, /secondStepPlan\(/, 'the gate asks the rules what to do next');
  assert.match(gate, /addPasskey\(/);
  assert.match(gate, /phase === 'passkey'/);

  const security = read('../../backoffice/sections/SignInSecurity.jsx');
  assert.match(security, /listPasskeys\(\)/, 'Back Office lists them');
  assert.match(security, /canRemovePasskey\(/, 'and never removes the last way in');
  assert.match(security, /client\.removePasskey\(/);

  // The database is what actually decides, and it proves a passkey from the session itself.
  const sql = read('../../../supabase/migrations/20260920p_OPS_passkey_second_step.sql');
  assert.match(sql, /second_step_session_passkey/);
  assert.match(sql, /auth\.mfa_amr_claims/, 'the proof is the session amr, not anything the app says');
  assert.match(sql, /second_step_passkeys/);
});


// ── a passkey session is aal1, and the app must know that ──────────────────────────────────
// This is the part that would lock everybody out if it were wrong: Supabase calls a passkey a
// FIRST factor, so the session never reaches aal2. The screens read the token's own amr claim,
// exactly as public.second_step_session_passkey does in the database (20260920p).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const sessionWith = (claims, factors = []) => ({
  access_token: jwt({ sub: 'u1', role: 'authenticated', aal: 'aal1', is_anonymous: false, ...claims }),
  user: { id: 'u1', email: 'peter@posup.co.uk', is_anonymous: false, factors },
});
const totp = { id: 't1', factor_type: 'totp', status: 'verified', created_at: '2026-09-18T10:00:00Z' };

test('the app reads a passkey out of the session, in every shape GoTrue writes it', () => {
  assert.equal(sessionUsedPasskey(sessionWith({ amr: [{ method: 'password' }, { method: 'webauthn' }] })), true);
  assert.equal(sessionUsedPasskey(sessionWith({ amr: ['passkey'] })), true);
  assert.equal(sessionUsedPasskey(sessionWith({ amr: [{ method: 'WebAuthn' }] })), true, 'case does not matter');
  assert.equal(sessionUsedPasskey(sessionWith({ amr: [{ method: 'password' }] })), false);
  assert.equal(sessionUsedPasskey(sessionWith({})), false);
  assert.equal(sessionUsedPasskey(null), false);
  assert.deepEqual([...PASSKEY_AMR_METHODS], ['webauthn', 'passkey', 'webauthn_credential'],
    'the same list as second_step_settings.passkey_methods');
  // aal2 or a passkey: either is a second step done.
  assert.equal(sessionProvesSecondStep(sessionWith({ aal: 'aal2' })), true);
  assert.equal(sessionProvesSecondStep(sessionWith({ amr: [{ method: 'webauthn' }] })), true);
  assert.equal(sessionProvesSecondStep(sessionWith({})), false);
});

test('a passkey sign in is never sent round the second step loop again', () => {
  const pass = sessionWith({ amr: [{ method: 'webauthn' }] });
  // Even holding an authenticator app, a passkey sign in is done: asking for a code as well
  // would be asking twice, and would strand anybody whose app is on a lost phone.
  assert.equal(gateStep({ session: pass, factors: [totp] }), 'ok');
  assert.equal(gateStep({ session: pass, factors: [] }), 'ok');
  assert.equal(gateStep({ session: pass, factors: [totp], mode: 'recovery' }), 'ok');
  assert.equal(passesWithoutNetwork(pass), true, 'and it goes straight in with no call');
  // A password sign in is untouched: it still has to do something.
  const pw = sessionWith({});
  assert.equal(gateStep({ session: pw, factors: [totp] }), 'challenge');
  assert.equal(gateStep({ session: pw, factors: [] }), 'setup');
  assert.equal(passesWithoutNetwork(pw), false);
});

test('the surfaces that re-close the gate know a passkey session is aal1 and fine', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const p of ['../../backoffice/BackOfficeApp.jsx', '../../admin/CompanyAdminApp.jsx', '../../surfaces/OwnerSurface.jsx']) {
    const src = read(p);
    assert.match(src, /sessionProvesSecondStep\(/, `${p} must not re-gate a passkey session`);
    assert.doesNotMatch(src, /sessionAal\(\s*\w+\s*\) !== 'aal2'/, `${p} still keys off aal2 alone`);
  }
  // And after registering one, the session is upgraded so the DATABASE agrees with the screen.
  const gate = read('../../components/secondStep/SecondStepGate.jsx');
  assert.match(gate, /if \(!sessionProvesSecondStep\(await client\.getSession\(\)\)\) await client\.signInWithPasskey\(\);/);
});
