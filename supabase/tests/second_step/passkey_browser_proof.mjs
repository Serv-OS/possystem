// supabase/tests/second_step/passkey_browser_proof.mjs
//
// THE PASSKEY PROOF, in a real browser (docs/SECOND_STEP.md).
//
// node:test proves the rules. It cannot prove the thing Peter actually asked for on 20 Sep 2026:
// "this is what toast does I want this", a real fingerprint ceremony in a real browser. So this
// script drives headless Chromium with a VIRTUAL AUTHENTICATOR (the Chrome DevTools WebAuthn
// domain: the same thing Chrome's own passkey tests use, a fake Touch ID sensor) against a fake
// GoTrue that speaks the passkey endpoints Supabase speaks.
//
// The app code under test is the REAL one, unchanged and unbundled:
//   src/lib/secondStep/passkey.js        the ceremony and the calls
//   src/lib/secondStep/passkeyRules.js   the rules the screens obey
//
// What it proves, in order:
//   1. register    a passkey is made on this device and the server is told
//   2. sign in     that passkey signs in with NO password, and hands over a session
//   3. two devices a second device adds its own passkey; the list shows both
//   4. removal     one can go; the LAST one cannot (nobody is ever locked out)
//   5. unknown     a passkey the server does not know is refused, in plain words
//   6. no sensor   a device with no fingerprint reader falls back to the code route
//   7. wrong host  a passkey CANNOT be made off serv-os.app: the browser itself refuses
//
// Run: node supabase/tests/second_step/passkey_browser_proof.mjs
// It needs nothing running: no Supabase, no dev server, no network.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../src/lib/secondStep');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// ── the fake GoTrue ─────────────────────────────────────────────────────────────────────────
// Only the passkey endpoints, and only as strictly as the real one: it checks the browser sent
// back the challenge it was given, for the origin it was given, of the right ceremony type.
function makeServer() {
  const passkeys = new Map();          // credential id -> { friendly_name, created_at }
  const challenges = new Map();        // challenge_id -> { challenge, kind }
  let signedIn = 0;

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const checkClientData = (credential, want, origins) => {
    const data = JSON.parse(unb64url(credential?.response?.clientDataJSON ?? '').toString('utf8'));
    if (data.type !== want) throw new Error(`wrong ceremony type: ${data.type}`);
    if (!origins.includes(data.origin)) throw new Error(`wrong origin: ${data.origin}`);
    return data;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;
    // /wrong/... is the same server pretending to be app.serv-os.app, for proof 7.
    const wrongHost = pathname.startsWith('/wrong');
    if (wrongHost) pathname = pathname.slice('/wrong'.length);
    const rpId = wrongHost ? 'serv-os.app' : 'localhost';

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (pathname.startsWith('/mod/')) {
      const name = path.basename(pathname);
      if (!['passkey.js', 'passkeyRules.js'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(fs.readFileSync(path.join(SRC, name), 'utf8'));
      return;
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    }
    const port = server.address().port;
    const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

    try {
      if (pathname === '/auth/v1/passkeys/registration/options' && req.method === 'POST') {
        const challenge = rand(32);
        const challenge_id = rand(8);
        challenges.set(challenge_id, { challenge, kind: 'webauthn.create' });
        return send(res, 200, {
          challenge_id,
          options: {
            challenge,
            rp: { id: rpId, name: 'ServOS' },
            user: { id: b64url(Buffer.from('user-peter')), name: 'peter@posup.co.uk', displayName: 'Peter' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            timeout: 60000,
            attestation: 'none',
            authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
            excludeCredentials: [...passkeys.keys()].map((id) => ({ type: 'public-key', id, transports: ['internal'] })),
          },
        });
      }

      if (pathname === '/auth/v1/passkeys/registration/verify' && req.method === 'POST') {
        const asked = challenges.get(body?.challenge_id);
        if (!asked) return send(res, 400, { msg: 'unknown challenge' });
        const data = checkClientData(body?.credential, 'webauthn.create', origins);
        if (data.challenge !== asked.challenge) return send(res, 400, { msg: 'challenge does not match' });
        if (!body?.credential?.response?.attestationObject) return send(res, 400, { msg: 'no attestation' });
        challenges.delete(body.challenge_id);
        const id = String(body.credential.id);
        passkeys.set(id, { friendly_name: body?.friendly_name || 'Passkey', created_at: new Date().toISOString() });
        return send(res, 200, { id, friendly_name: passkeys.get(id).friendly_name });
      }

      if (pathname === '/auth/v1/passkeys/authentication/options' && req.method === 'POST') {
        const challenge = rand(32);
        const challenge_id = rand(8);
        challenges.set(challenge_id, { challenge, kind: 'webauthn.get' });
        return send(res, 200, { challenge_id, options: { challenge, rpId, userVerification: 'required', timeout: 60000 } });
      }

      if (pathname === '/auth/v1/passkeys/authentication/verify' && req.method === 'POST') {
        const asked = challenges.get(body?.challenge_id);
        if (!asked) return send(res, 400, { msg: 'unknown challenge' });
        const data = checkClientData(body?.credential, 'webauthn.get', origins);
        if (data.challenge !== asked.challenge) return send(res, 400, { msg: 'challenge does not match' });
        challenges.delete(body.challenge_id);
        const id = String(body?.credential?.id ?? '');
        if (!passkeys.has(id)) return send(res, 404, { msg: 'passkey_not_found', error_code: 'passkey_not_found' });
        if (!body?.credential?.response?.signature) return send(res, 400, { msg: 'no signature' });
        signedIn += 1;
        return send(res, 200, {
          session: { access_token: `at-${signedIn}`, refresh_token: `rt-${signedIn}`, token_type: 'bearer' },
          user: { id: 'user-peter', email: 'peter@posup.co.uk' },
        });
      }

      if (pathname === '/auth/v1/passkeys' && req.method === 'GET') {
        return send(res, 200, [...passkeys.entries()].map(([id, v]) => ({ id, friendly_name: v.friendly_name, created_at: v.created_at, last_used_at: null })));
      }
      if (pathname.startsWith('/auth/v1/passkeys/') && req.method === 'DELETE') {
        passkeys.delete(decodeURIComponent(pathname.split('/').pop()));
        return send(res, 200, {});
      }
      if (pathname.startsWith('/auth/v1/passkeys/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.split('/').pop());
        if (passkeys.has(id)) passkeys.get(id).friendly_name = body?.friendly_name || '';
        return send(res, 200, {});
      }
    } catch (e) {
      return send(res, 400, { msg: String(e?.message || e) });
    }
    res.writeHead(404); res.end();
  });
  return { server, passkeys };
}

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>Passkey proof</title>
<body style="font:15px system-ui;padding:24px">Passkey proof harness</body>
<script type="module">
  import * as pk from '/mod/passkey.js';
  import * as rules from '/mod/passkeyRules.js';
  window.pk = pk;
  window.rules = rules;
  window.session = null;
  window.client = (prefix = '') => pk.createPasskeyClient({
    url: location.origin + prefix,
    anonKey: 'anon',
    getToken: async () => 'signed-in-token',
    setSession: async (s) => { window.session = s; },
  });
  window.ready = true;
</script>`;

// ── the proof ───────────────────────────────────────────────────────────────────────────────
const checks = [];
const ok = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

async function addSensor(cdp) {
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',              // a built in sensor: Touch ID, Windows Hello
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,               // the finger is on the sensor
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

const run = async () => {
  const { server } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');

  try {
    await page.goto(base);
    await page.waitForFunction('window.ready === true');

    // 1. REGISTER: a real ceremony on a real (virtual) fingerprint sensor.
    const sensorA = await addSensor(cdp);
    const made = await page.evaluate(async () => {
      const c = window.client();
      const r = await c.register({ friendlyName: 'Mac' });
      return { id: r.credentialId, name: r.friendlyName };
    });
    ok('1. a passkey is made on this device', !!made.id && made.name === 'Mac', `${String(made.id).slice(0, 12)}...`);
    const storedA = await cdp.send('WebAuthn.getCredentials', { authenticatorId: sensorA });
    ok('1b. the key really lives on the device, and it is discoverable', storedA.credentials.length === 1 && storedA.credentials[0].isResidentCredential === true);

    // 2. SIGN IN: no password anywhere in this.
    const signedIn = await page.evaluate(async () => {
      window.session = null;
      const c = window.client();
      const r = await c.signIn();
      return { email: r.user?.email, token: window.session?.access_token, refresh: window.session?.refresh_token };
    });
    ok('2. that passkey signs in with no password', signedIn.email === 'peter@posup.co.uk' && !!signedIn.token, signedIn.email || '');
    ok('2b. the session is handed to the app, so the whole app is signed in', signedIn.token === 'at-1' && signedIn.refresh === 'rt-1');

    // 3. A SECOND DEVICE: Peter's phone as well as his laptop. Chrome allows one built in
    // sensor at a time, which is exactly right: the laptop is put away, the phone comes out.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: sensorA });
    const sensorB = await addSensor(cdp);
    const second = await page.evaluate(async () => {
      const c = window.client();
      const r = await c.register({ friendlyName: 'iPhone' });
      const list = await c.list();
      return { id: r.credentialId, names: list.map((k) => k.friendlyName).sort() };
    });
    ok('3. a second device adds its own passkey', !!second.id && second.id !== made.id);
    ok('3b. Back Office lists both', JSON.stringify(second.names) === JSON.stringify(['Mac', 'iPhone'].sort()), second.names.join(', '));

    // 4. REMOVAL: one can go, the LAST one cannot.
    const removal = await page.evaluate(async (firstId) => {
      const c = window.client();
      const two = await c.list();
      const canFirst = window.rules.canRemovePasskey({ passkeys: two, factors: [], id: firstId });
      await c.remove(firstId);
      const one = await c.list();
      const canLast = window.rules.canRemovePasskey({ passkeys: one, factors: [], id: one[0].id });
      const withCode = window.rules.canRemovePasskey({ passkeys: one, factors: [{ factor_type: 'totp', status: 'verified' }], id: one[0].id });
      return { canFirst: canFirst.ok, left: one.length, canLast: canLast.ok, lastWhy: canLast.message, withCode: withCode.ok };
    }, made.id);
    ok('4. one of two passkeys can be removed', removal.canFirst === true && removal.left === 1);
    ok('4b. the LAST way in is refused, nobody is locked out', removal.canLast === false, removal.lastWhy);
    ok('4c. unless a code is kept, which makes it safe', removal.withCode === true);

    // 5. A PASSKEY THE SERVER DOES NOT KNOW: plain words, and the password route offered.
    const stale = await page.evaluate(async () => {
      const c = window.client();
      const list = await c.list();
      await c.remove(list[0].id);                       // the server forgets it; the device keeps it
      try { await c.signIn(); return { threw: false, message: '' }; }
      catch (e) { return { threw: true, message: window.rules.explainPasskeyError(e) }; }
    });
    ok('5. a passkey the server has forgotten is refused', stale.threw === true);
    ok('5b. and the person is told what to do instead', /password/i.test(stale.message), stale.message);

    // 6. NO SENSOR: a shared PC with no fingerprint reader still has a way in.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: sensorB });
    const noSensor = await page.evaluate(async () => {
      const support = await window.pk.passkeySupport();
      const plan = window.rules.secondStepPlan({ passkeys: [], factors: [], canUsePasskey: support.usable, needsEmail: true, emailProved: false });
      const proving = window.rules.secondStepPlan({ passkeys: [], factors: [], canUsePasskey: true, needsEmail: true, emailProved: false });
      const after = window.rules.secondStepPlan({ passkeys: [], factors: [], canUsePasskey: true, needsEmail: true, emailProved: true });
      return { support, plan, proving, after };
    });
    ok('6. a device with no fingerprint sensor says so', noSensor.support.usable === false, noSensor.support.reason);
    ok('6b. and is sent to the authenticator app instead of a dead end', noSensor.plan === 'app_code');
    ok('6c. a FIRST passkey still needs the emailed code first', noSensor.proving === 'prove_email' && noSensor.after === 'register_passkey');

    // 7. WRONG HOST: the browser itself refuses a passkey for a domain we are not on.
    const sensorC = await addSensor(cdp);
    const wrong = await page.evaluate(async () => {
      const c = window.client('/wrong');            // the server claims rp id serv-os.app
      try { await c.register({ friendlyName: 'Nope' }); return { threw: false, name: '', message: '' }; }
      catch (e) { return { threw: true, name: e?.name || '', message: window.rules.explainPasskeyError(e) }; }
    });
    ok('7. a passkey cannot be made for a domain this page is not on', wrong.threw === true, wrong.name);
    ok('7b. and the person is sent to app.serv-os.app', /app\.serv-os\.app/.test(wrong.message), `${wrong.message.slice(0, 60)}...`);
    const afterWrong = await cdp.send('WebAuthn.getCredentials', { authenticatorId: sensorC });
    ok('7c. nothing was stored on the device', afterWrong.credentials.length === 0);
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
