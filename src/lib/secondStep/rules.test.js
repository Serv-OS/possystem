// src/lib/secondStep/rules.test.js
// The Back Office second sign in step, app side (docs/SECOND_STEP.md). Pure rules only:
// who must do a second step, what the screen asks for, where Face ID can work, removal rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  MIN_PASSWORD_LENGTH, WEBAUTHN_RP_ID, WEBAUTHN_HOSTS,
  decodeJwtClaims, isRealLogin, sessionAal, verifiedFactors, hasVerified, gateStep, passesWithoutNetwork,
  rpIdFor, faceIdLabel, faceIdSupport, isInAppShell, challengePlan, normaliseCode, isCodeComplete,
  formatSecret, friendlyName, factorLabel, removalCheck, leftoverFactorIds, isSecondStepRefusal,
  passwordProblem, explainError,
} from './rules.js';

// A token the way the auth server shapes it (the signature is not checked client side).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.sig`;
const session = ({ aal = 'aal1', anonymous = false, factors = [], noUser = false } = {}) => ({
  access_token: jwt({ sub: 'u1', role: 'authenticated', aal, is_anonymous: anonymous }),
  user: noUser ? null : { id: 'u1', email: anonymous ? null : 'owner@example.com', is_anonymous: anonymous, factors },
});
const totp = (id = 't1', status = 'verified', created_at = '2026-09-18T10:00:00Z') => ({ id, factor_type: 'totp', status, created_at, friendly_name: `Authenticator app ${id}` });
const face = (id = 'w1', status = 'verified', created_at = '2026-09-18T11:00:00Z') => ({ id, factor_type: 'webauthn', status, created_at, friendly_name: `Face ID ${id}` });

test('decodeJwtClaims reads base64url claims and refuses anything that is not a JWT', () => {
  const c = decodeJwtClaims(jwt({ sub: 'x', aal: 'aal2', name: 'Zoë ☕' }));
  assert.equal(c.sub, 'x');
  assert.equal(c.aal, 'aal2');
  assert.equal(c.name, 'Zoë ☕');
  assert.equal(decodeJwtClaims(''), null);
  assert.equal(decodeJwtClaims('abc'), null);
  assert.equal(decodeJwtClaims('a.b'), null);
  assert.equal(decodeJwtClaims('a.!!!.c'), null);
  assert.equal(decodeJwtClaims(`x.${b64u([1, 2])}.y`), null, 'an array is not a claims object');
});

test('only a real password login is a login: anonymous till, kiosk and customer sessions never are', () => {
  assert.equal(isRealLogin(session()), true);
  assert.equal(isRealLogin(session({ anonymous: true })), false);
  assert.equal(isRealLogin(null), false);
  assert.equal(isRealLogin(session({ noUser: true })), false);
  // the token says anonymous even if the stored user object does not
  const s = session();
  s.access_token = jwt({ sub: 'u1', is_anonymous: true, aal: 'aal1' });
  assert.equal(isRealLogin(s), false);
});

test('sessionAal comes from the access token', () => {
  assert.equal(sessionAal(null), null);
  assert.equal(sessionAal(session({ aal: 'aal1' })), 'aal1');
  assert.equal(sessionAal(session({ aal: 'aal2' })), 'aal2');
  assert.equal(sessionAal({ access_token: jwt({ sub: 'u1' }) }), 'aal1', 'no aal claim counts as password only');
});

test('gateStep: who must do a second step, and which one', () => {
  // no login, or a till: nothing is ever asked
  assert.equal(gateStep({ session: null }), 'none');
  assert.equal(gateStep({ session: session({ anonymous: true }), factors: [] }), 'none');
  assert.equal(gateStep({ session: session({ anonymous: true, aal: 'aal1' }), factors: [totp()] }), 'none');
  // password only, nothing set up: set up (cannot be skipped)
  assert.equal(gateStep({ session: session(), factors: [] }), 'setup');
  // an unverified leftover does not count as set up
  assert.equal(gateStep({ session: session(), factors: [totp('t1', 'unverified')] }), 'setup');
  // password only with a second step: challenge
  assert.equal(gateStep({ session: session(), factors: [totp()] }), 'challenge');
  assert.equal(gateStep({ session: session(), factors: [face()] }), 'challenge');
  // passed, with the authenticator app backup: in
  assert.equal(gateStep({ session: session({ aal: 'aal2' }), factors: [totp(), face()] }), 'ok');
  // passed with Face ID only: must add the authenticator app backup first
  assert.equal(gateStep({ session: session({ aal: 'aal2' }), factors: [face()] }), 'backup');
  // Peter's break glass lets everyone in
  assert.equal(gateStep({ session: session(), factors: [], appGate: false }), 'ok');
  assert.equal(gateStep({ session: session(), factors: [totp()], appGate: false }), 'ok');
  // but never turns a till into a login
  assert.equal(gateStep({ session: session({ anonymous: true }), factors: [], appGate: false }), 'none');
});

test('gateStep recovery: a reset link must pass the second step first when there is one', () => {
  assert.equal(gateStep({ session: session(), factors: [totp()], mode: 'recovery' }), 'challenge');
  assert.equal(gateStep({ session: session(), factors: [], mode: 'recovery' }), 'ok', 'nothing to pass yet; set up happens at the next sign in');
  assert.equal(gateStep({ session: session({ aal: 'aal2' }), factors: [face()], mode: 'recovery' }), 'ok', 'no backup nagging mid reset');
});

test('passesWithoutNetwork: only an aal2 login whose stored session shows an authenticator app', () => {
  assert.equal(passesWithoutNetwork(session({ aal: 'aal2', factors: [totp()] })), true);
  assert.equal(passesWithoutNetwork(session({ aal: 'aal2', factors: [face()] })), false);
  assert.equal(passesWithoutNetwork(session({ aal: 'aal1', factors: [totp()] })), false);
  assert.equal(passesWithoutNetwork(session({ anonymous: true, aal: 'aal2', factors: [totp()] })), false);
  assert.equal(passesWithoutNetwork(null), false);
});

test('Face ID works only on the serv-os.app addresses Peter lists in Supabase', () => {
  assert.equal(WEBAUTHN_RP_ID, 'serv-os.app');
  assert.deepEqual(WEBAUTHN_HOSTS, ['app.serv-os.app', 'dev.serv-os.app', 'stage.serv-os.app']);
  for (const h of WEBAUTHN_HOSTS) assert.equal(rpIdFor(h), 'serv-os.app');
  assert.equal(rpIdFor('APP.SERV-OS.APP'), 'serv-os.app');
  assert.equal(rpIdFor('possystem-liard.vercel.app'), null, 'the Sunmi till app origin can never use serv-os.app');
  assert.equal(rpIdFor('peters-cafe.serv-os.app'), null, 'venue subdomains are not listed origins');
  assert.equal(rpIdFor('serv-os.app.evil.com'), null);
  assert.equal(rpIdFor('localhost'), null, 'localhost only in the local proof');
  assert.equal(rpIdFor('localhost', { allowLocalhost: true }), 'localhost');
});

test('our own apps and the Sunmi tills are recognised (native Face ID is not built yet)', () => {
  const inApp = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 RposIOS/1.0.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36 RposAndroid/1.0 ServOS-owner',
    'Mozilla/5.0 (Linux; Android 11; Sunmi) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 RestaurantOS/1.0 Sunmi/1.0',
    'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ServOS-MPOS/1.0',
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 RestaurantOS/1.0 RPOS-iOS/1.0',
  ];
  for (const ua of inApp) assert.equal(isInAppShell(ua), true, ua);
  const browsers = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0',
  ];
  for (const ua of browsers) assert.equal(isInAppShell(ua), false, ua);
});

test('faceIdSupport says yes only where every piece is there, with a plain reason otherwise', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1';
  const ok = faceIdSupport({ hostname: 'app.serv-os.app', userAgent: iphone, hasWebAuthn: true, platformAuthenticator: true });
  assert.deepEqual(ok, { usable: true, reason: 'ok', label: 'Face ID or Touch ID' });
  assert.equal(faceIdSupport({ hostname: 'possystem-liard.vercel.app', userAgent: iphone, hasWebAuthn: true, platformAuthenticator: true }).reason, 'host');
  assert.equal(faceIdSupport({ hostname: 'app.serv-os.app', userAgent: `${iphone} RposIOS/1.0`, hasWebAuthn: true, platformAuthenticator: true }).reason, 'app');
  assert.equal(faceIdSupport({ hostname: 'app.serv-os.app', userAgent: iphone, hasWebAuthn: false, platformAuthenticator: false }).reason, 'browser');
  assert.equal(faceIdSupport({ hostname: 'app.serv-os.app', userAgent: iphone, hasWebAuthn: true, platformAuthenticator: false }).reason, 'device');
  assert.equal(faceIdLabel('Windows NT 10.0'), 'Windows Hello');
  assert.equal(faceIdLabel('Linux; Android 14'), 'fingerprint');
  assert.equal(faceIdLabel('X11; Linux'), 'Face ID or fingerprint');
});

test('challengePlan: Face ID first ONLY on the device it was set up on (fix round, 20 Sep 2026)', () => {
  const both = [totp('t1', 'verified', '2026-09-01T00:00:00Z'), face('w1', 'verified', '2026-09-02T00:00:00Z'), face('w2', 'verified', '2026-09-03T00:00:00Z')];
  // A Face ID credential belongs to ONE device. An owner who added it on their iPhone and then
  // signs in on a Windows PC used to be shown "Use Windows Hello" as the big button, a prompt
  // that cannot work. This device remembered the factor it added, so only that one comes first.
  assert.deepEqual(challengePlan({ factors: both, faceIdUsable: true }),
    { faceIdFactorId: 'w2', codeFactorIds: ['t1'], primary: 'code' }, 'another device: the code comes first');
  assert.deepEqual(challengePlan({ factors: both, faceIdUsable: true, preferredFaceIdFactorId: 'w1' }),
    { faceIdFactorId: 'w1', codeFactorIds: ['t1'], primary: 'faceid' }, 'the device that set it up: Face ID first');
  assert.equal(challengePlan({ factors: [face('w1', 'verified')], faceIdUsable: true }).primary, 'faceid_elsewhere',
    'Face ID only, and not this device: say so instead of a dead prompt');
  assert.deepEqual(challengePlan({ factors: both, faceIdUsable: false }), { faceIdFactorId: null, codeFactorIds: ['t1'], primary: 'code' });
  assert.equal(challengePlan({ factors: [face()], faceIdUsable: false }).primary, 'faceid_elsewhere');
  const twoPhones = [totp('old', 'verified', '2026-01-01T00:00:00Z'), totp('new', 'verified', '2026-09-01T00:00:00Z'), totp('x', 'unverified')];
  assert.deepEqual(challengePlan({ factors: twoPhones }).codeFactorIds, ['new', 'old'], 'newest phone first, leftovers ignored');
});

test('codes: digits only, six of them; secrets in groups of four', () => {
  assert.equal(normaliseCode(' 123-456 '), '123456');
  assert.equal(normaliseCode('12 34 56 78'), '123456');
  assert.equal(isCodeComplete('123456'), true);
  assert.equal(isCodeComplete('12345'), false);
  assert.equal(isCodeComplete('12345a'), false);
  assert.equal(formatSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
});

test('friendly names never collide (the auth server refuses a duplicate name)', () => {
  const now = new Date('2026-09-19T09:00:00Z');
  const first = friendlyName('totp', [], now);
  const day = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  assert.equal(first, `Authenticator app (${day})`);
  const second = friendlyName('totp', [first], now);
  assert.notEqual(second, first);
  assert.match(second, /, 2\)$/);
  assert.match(friendlyName('webauthn', [], now), /^Face ID or fingerprint \(/);
  assert.match(factorLabel(face()), /^Face ID or fingerprint, added /);
  assert.match(factorLabel(totp()), /^Authenticator app, added /);
});

test('removalCheck: needs aal2, and the last authenticator app always stays', () => {
  const f = [totp('t1'), face('w1')];
  assert.equal(removalCheck({ factors: f, factorId: 'w1', aal: 'aal2' }).ok, true);
  assert.equal(removalCheck({ factors: f, factorId: 't1', aal: 'aal2' }).ok, false, 'only authenticator app');
  assert.equal(removalCheck({ factors: [...f, totp('t2')], factorId: 't1', aal: 'aal2' }).ok, true);
  assert.equal(removalCheck({ factors: f, factorId: 'w1', aal: 'aal1' }).ok, false, 'the auth server needs aal2');
  assert.equal(removalCheck({ factors: f, factorId: 'nope', aal: 'aal2' }).ok, false);
});

test('leftoverFactorIds finds only unverified factors (never a verified one)', () => {
  const all = [totp('t1'), totp('t2', 'unverified'), face('w1', 'unverified'), face('w2')];
  assert.deepEqual(leftoverFactorIds(all, 'totp'), ['t2']);
  assert.deepEqual(leftoverFactorIds(all, 'webauthn'), ['w1']);
  assert.deepEqual(leftoverFactorIds(all).sort(), ['t2', 'w1']);
});

test('isSecondStepRefusal spots the server and database refusals', () => {
  assert.equal(isSecondStepRefusal({ code: 'second_step_required' }), true);
  assert.equal(isSecondStepRefusal({ second_step: true, error: 'x' }), true);
  assert.equal(isSecondStepRefusal({ code: '42501', message: 'second_step_required' }), true);
  assert.equal(isSecondStepRefusal({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(isSecondStepRefusal(null), false);
});

test('passwords: at least 12 characters, and the two must match', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.match(passwordProblem('short'), /12 characters/);
  assert.equal(passwordProblem('correct horse battery'), null);
  assert.match(passwordProblem('correct horse battery', 'correct horse batterx'), /do not match/);
  assert.equal(passwordProblem('correct horse battery', 'correct horse battery'), null);
});

test('explainError turns auth and browser errors into plain words', () => {
  assert.match(explainError({ code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' }), /code did not work/);
  assert.match(explainError({ name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' }), /cancelled or timed out/);
  assert.match(explainError({ code: 'over_request_rate_limit', message: 'rate limit' }), /Too many tries/);
  assert.match(explainError({ code: 'insufficient_aal', message: 'AAL2 required to enroll a new factor' }), /Confirm it is you/);
  assert.match(explainError({ code: 'mfa_webauthn_enroll_not_enabled', message: 'WebAuthn enroll is disabled' }), /not switched on/);
  assert.match(explainError(new TypeError('Failed to fetch')), /No connection/);
  assert.equal(explainError(null), '');
});

test('verifiedFactors and hasVerified ignore unverified and junk rows', () => {
  const all = [null, totp('t1', 'unverified'), face('w1'), { id: 'z' }];
  assert.deepEqual(verifiedFactors(all).map((f) => f.id), ['w1']);
  assert.equal(hasVerified(all, 'webauthn'), true);
  assert.equal(hasVerified(all, 'totp'), false);
  assert.deepEqual(verifiedFactors(undefined), []);
});
