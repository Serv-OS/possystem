// node --test: the AI routes ask who is asking (api/_userAuth.js requireUser, api/ai.js and
// api/ai/menu-import.js, v5.11.104). Until now anyone who found either address could spend the
// Anthropic key. The scan route's own check (requireVenueUser) is pinned in stock/invoiceScanAuth.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requireUser, requireVenueUser } from '../../api/_userAuth.js';
import { buildAiRequest } from './aiRequestBuild.js';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ENV = { SUPABASE_URL: 'https://ops.test/', VITE_SUPABASE_ANON_KEY: 'public-key' };
const LOC = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

// A stand in for fetch: Auth knows some tokens; the database answers the reach and device questions.
function fakeFetch({ users = {}, reach = {}, devices = {}, posKeys = {}, reachMissing = false, fallback = {} } = {}) {
  const calls = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const f = async (url, init) => {
    const token = String(init.headers.authorization || '').replace('Bearer ', '');
    calls.push({ url, token, apikey: init.headers.apikey, body: init.body });
    if (url === 'https://ops.test/auth/v1/user') return users[token] ? res(200, users[token]) : res(401, { msg: 'invalid JWT' });
    if (url.endsWith('/rpc/stock_reach_locations')) return reachMissing ? res(404, { code: 'PGRST202', message: 'Could not find the function public.stock_reach_locations without parameters in the schema cache' }) : res(200, reach[token] || []);
    if (url.endsWith('/rpc/user_accessible_locations')) return res(200, fallback[token] || []);
    if (url.endsWith('/rpc/pos_accessible_location_keys')) return res(200, posKeys[token] || []);
    if (url.endsWith('/rpc/ops_can_write')) return res(200, (devices[token] || []).includes(JSON.parse(init.body).p_location_id));
    return res(404, {});
  };
  return { f, calls };
}

const USERS = {
  'tok-mgr': { id: 'u1', is_anonymous: false },
  'tok-till': { id: 'd1', is_anonymous: true },
  'tok-kiosk': { id: 'k1', is_anonymous: true },
  'tok-customer': { id: 'c1', is_anonymous: true },
  'tok-signup': { id: 's1', is_anonymous: false, email: 'nobody@example.test' },
  'tok-nofield': { id: 'n1' },
};
const AI = { venueRequired: false, device: 'pos', signInMessage: 'Sign in to use the AI assistant.', env: ENV };
const BOH = { ...AI, device: 'none' };

test('no token, or a token Auth refuses: 401 with the feature\'s own words, before anything is spent', async () => {
  const { f, calls } = fakeFetch({ users: USERS });
  let r = await requireUser(req(null), { ...AI, locationId: LOC, fetchImpl: f });
  assert.deepEqual([r.ok, r.status, r.error], [false, 401, 'Sign in to use the AI assistant.']);
  assert.equal(calls.length, 0, 'not even Auth is asked without a token');
  r = await requireUser(req('tok-bad'), { ...AI, locationId: LOC, fetchImpl: f });
  assert.deepEqual([r.ok, r.status], [false, 401]);
  r = await requireUser(req('tok-mgr'), { ...AI, locationId: LOC, env: {}, fetchImpl: f });
  assert.equal(r.status, 500, 'no address or public key: refuse, never wave through');
});

test('a signed in person passes on their sign in alone when no venue is named, and must reach a venue they name', async () => {
  const { f, calls } = fakeFetch({ users: USERS, reach: { 'tok-mgr': [LOC] } });
  const alone = await requireUser(req('tok-mgr'), { ...BOH, locationId: null, fetchImpl: f });
  assert.deepEqual([alone.ok, alone.via, alone.user.id], [true, 'user', 'u1']);
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/stock_reach_locations')), 'the reach is asked even when no venue is named');
  const mine = await requireUser(req('tok-mgr'), { ...BOH, locationId: LOC, fetchImpl: f });
  assert.deepEqual([mine.ok, mine.via], [true, 'reach']);
  const theirs = await requireUser(req('tok-mgr'), { ...BOH, locationId: OTHER, fetchImpl: f });
  assert.deepEqual([theirs.ok, theirs.status], [false, 403]);
  assert.match(theirs.error, /^Not allowed: /);
  const junk = await requireUser(req('tok-mgr'), { ...BOH, locationId: 'not-a-venue', fetchImpl: f });
  assert.equal(junk.status, 400);
  assert.ok(calls.every((c) => c.token === 'tok-mgr' && c.apikey === 'public-key'), 'only the caller\'s token and the public key, never a service key');
});

test('an anonymous session: 401 for boh, rota and the menu import, whatever venue it names', async () => {
  const { f, calls } = fakeFetch({ users: USERS, posKeys: { 'tok-till': [LOC] } });
  const till = await requireUser(req('tok-till'), { ...BOH, locationId: LOC, fetchImpl: f });
  assert.deepEqual([till.ok, till.status, till.error], [false, 401, 'Sign in to use the AI assistant.']);
  assert.ok(!calls.some((c) => c.url.includes('/rpc/')), 'the database is never asked about a device when none may pass');
  const none = await requireUser(req('tok-till'), { ...BOH, locationId: null, fetchImpl: f });
  assert.deepEqual([none.ok, none.status], [false, 401]);
});

test('the till\'s shift assistant (foh): only a device bound to the venue named; a customer, a stray session or no venue is refused', async () => {
  const { f, calls } = fakeFetch({ users: USERS, posKeys: { 'tok-till': [LOC], 'tok-kiosk': [LOC] } });
  const till = await requireUser(req('tok-till'), { ...AI, locationId: LOC, fetchImpl: f });
  assert.deepEqual([till.ok, till.via, till.user.id], [true, 'device', 'd1']);
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/pos_accessible_location_keys') && c.token === 'tok-till'), 'asked with the device\'s own token');
  assert.ok(!calls.some((c) => c.url.includes('stock_reach_locations') || c.url.includes('ops_can_write')), 'a device is never asked the login reach or the Ops phone question');
  const elsewhere = await requireUser(req('tok-till'), { ...AI, locationId: OTHER, fetchImpl: f });
  assert.deepEqual([elsewhere.ok, elsewhere.status], [false, 401]);
  const customer = await requireUser(req('tok-customer'), { ...AI, locationId: LOC, fetchImpl: f });
  assert.deepEqual([customer.ok, customer.status], [false, 401]);
  const noVenue = await requireUser(req('tok-till'), { ...AI, locationId: null, fetchImpl: f });
  assert.deepEqual([noVenue.ok, noVenue.status], [false, 401], 'a device that names no venue cannot be checked, so it is refused');
});

test('a self registered login (signup is open) that reaches no venue: 403 on every mode and the menu import, with or without a venue named', async () => {
  const { f, calls } = fakeFetch({ users: USERS, reach: { 'tok-mgr': [LOC] }, posKeys: { 'tok-signup': [LOC] } });
  for (const opts of [{ ...AI }, { ...BOH }, { ...BOH, signInMessage: 'Sign in to Back Office to import a menu.' }]) {
    const r = await requireUser(req('tok-signup'), { ...opts, locationId: null, fetchImpl: f });
    assert.deepEqual([r.ok, r.status, r.error], [false, 403, 'Not allowed: this login reaches no venue.']);
    const named = await requireUser(req('tok-signup'), { ...opts, locationId: LOC, fetchImpl: f });
    assert.deepEqual([named.ok, named.status], [false, 403]);
  }
  assert.ok(!calls.some((c) => c.url.endsWith('/rpc/pos_accessible_location_keys')), 'a person is never let through the device arm');
  const real = await requireUser(req('tok-mgr'), { ...BOH, locationId: null, fetchImpl: f });
  assert.deepEqual([real.ok, real.via], [true, 'user'], 'a Back Office user with no selected venue keeps working');
  const { f: old } = fakeFetch({ users: USERS, reachMissing: true, fallback: { 'tok-mgr': [LOC] } });
  const before = await requireUser(req('tok-mgr'), { ...BOH, locationId: null, fetchImpl: old });
  assert.deepEqual([before.ok, before.via], [true, 'user'], 'before 20261021a the reach is user_accessible_locations()');
  const none = await requireUser(req('tok-signup'), { ...BOH, locationId: null, fetchImpl: old });
  assert.equal(none.status, 403);
});

test('a user record with no is_anonymous field is treated as anonymous, never as a person', async () => {
  const { f } = fakeFetch({ users: USERS, reach: { 'tok-nofield': [LOC] }, posKeys: { 'tok-nofield': [LOC] } });
  const boh = await requireUser(req('tok-nofield'), { ...BOH, locationId: null, fetchImpl: f });
  assert.deepEqual([boh.ok, boh.status], [false, 401]);
  const named = await requireUser(req('tok-nofield'), { ...BOH, locationId: LOC, fetchImpl: f });
  assert.deepEqual([named.ok, named.status], [false, 401]);
  const foh = await requireUser(req('tok-nofield'), { ...AI, locationId: LOC, fetchImpl: f });
  assert.deepEqual([foh.ok, foh.via], [true, 'device'], 'it can only pass the device arm, like any anonymous session');
  const scan = await requireVenueUser(req('tok-nofield'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([scan.ok, scan.status], [false, 401]);
});

test('Auth or the database not answering is a 503, never a pass', async () => {
  const down = async () => { throw new Error('network'); };
  const r = await requireUser(req('tok-mgr'), { ...AI, locationId: LOC, fetchImpl: down });
  assert.deepEqual([r.ok, r.status], [false, 503]);
  const { f } = fakeFetch({ users: USERS });
  const half = async (url, init) => (url.includes('/rpc/') ? (() => { throw new Error('network'); })() : f(url, init));
  const dev = await requireUser(req('tok-till'), { ...AI, locationId: LOC, fetchImpl: half });
  assert.deepEqual([dev.ok, dev.status], [false, 503]);
});

test('the scan route\'s check is unchanged: a venue is required and only an Ops phone passes anonymously', async () => {
  const { f } = fakeFetch({ users: USERS, reach: { 'tok-mgr': [LOC] }, devices: { 'tok-till': [LOC] }, posKeys: { 'tok-kiosk': [LOC] } });
  const noVenue = await requireVenueUser(req('tok-mgr'), { locationId: null, env: ENV, fetchImpl: f });
  assert.deepEqual([noVenue.status, noVenue.error], [400, 'location_id required']);
  const phone = await requireVenueUser(req('tok-till'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([phone.ok, phone.via], [true, 'device']);
  const kiosk = await requireVenueUser(req('tok-kiosk'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([kiosk.ok, kiosk.status, kiosk.error], [false, 401, 'Sign in to Back Office to scan an invoice.']);
});

test('both AI routes check first, before the key is read or anything is spent (source)', () => {
  for (const [file, importLine, device] of [
    ['api/ai.js', "import { requireUser } from './_userAuth.js';", "device: mode === 'foh' ? 'pos' : 'none'"],
    ['api/ai/menu-import.js', "import { requireUser } from '../_userAuth.js';", "device: 'none'"],
  ]) {
    const src = read(file);
    assert.ok(src.includes(importLine), `${file} imports the check`);
    const handler = src.slice(src.indexOf('export default async function handler'));
    const check = handler.indexOf('await requireUser(req, {');
    assert.ok(check > 0, `${file}: the check is there`);
    assert.ok(check < handler.indexOf('process.env.ANTHROPIC_API_KEY'), `${file}: before the key is read`);
    assert.ok(check < handler.indexOf("fetch('https://api.anthropic.com"), `${file}: before anything is spent`);
    assert.ok(handler.includes(device), `${file}: ${device}`);
    assert.ok(handler.includes('venueRequired: false'), `${file}: a signed in person needs no venue`);
    assert.match(handler, /if \(!who\.ok\) return res\.status\(who\.status\)\.json\(\{ error: who\.error \}\);/);
  }
  assert.doesNotMatch(read('api/_userAuth.js'), /SERVICE_ROLE|service_role|SERVICE_KEY/i, 'the helper never sees the service key');
});

test('every caller sends the token and the venue through aiRequestInit (source)', () => {
  const callers = [
    ['src/components/AIChat.jsx', "fetch(API_ENDPOINT, await aiRequestInit({ messages: buildApiMessages(msgs), mode }))"],
    ['src/staff/wfData.js', "fetch('/api/ai', await aiRequestInit({ messages, mode }))"],
    ['src/backoffice/components/MenuImportModal.jsx', "fetch('/api/ai/menu-import', await aiRequestInit({ filename: file.name, mimeType: file.type, base64 }))"],
  ];
  for (const [file, call] of callers) {
    const src = read(file);
    assert.ok(src.includes(call), `${file} sends through aiRequestInit`);
    assert.match(src, /import \{ aiRequestInit \} from '(\.\.\/)+lib\/aiRequest';/);
  }
  // No AI call left that builds its own headers.
  for (const file of ['src/components/AIChat.jsx', 'src/staff/wfData.js', 'src/backoffice/components/MenuImportModal.jsx']) {
    assert.doesNotMatch(read(file), /headers: \{ '[Cc]ontent-[Tt]ype': 'application\/json' \},\n\s*body: JSON\.stringify\(\{ (messages|filename)/, `${file} has no bare AI fetch left`);
  }
});

test('aiRequestInit is wired to this session\'s token and venue (source)', () => {
  const src = read('src/lib/aiRequest.js');
  assert.match(src, /import \{ ensureAuthToken, getLocationId \} from '\.\/supabase';/);
  assert.ok(src.includes('buildAiRequest(body, { token: ensureAuthToken, location: getLocationId })'));
});

test('buildAiRequest: the bearer and the venue ride along; no token means no header, never a throw', async () => {
  const init = await buildAiRequest({ messages: [], mode: 'foh' }, { token: async () => 'tok-till', location: async () => LOC });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer tok-till');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { messages: [], mode: 'foh', location_id: LOC });
  const bare = await buildAiRequest({ mode: 'boh' }, { token: async () => null, location: async () => null });
  assert.equal('authorization' in bare.headers, false);
  assert.deepEqual(JSON.parse(bare.body), { mode: 'boh', location_id: null });
  const broken = await buildAiRequest({ mode: 'boh' }, { token: async () => { throw new Error('x'); }, location: async () => { throw new Error('y'); } });
  assert.equal('authorization' in broken.headers, false);
  const given = await buildAiRequest({ mode: 'boh', location_id: OTHER }, { token: async () => 't', location: async () => LOC });
  assert.equal(JSON.parse(given.body).location_id, OTHER, 'a venue the caller set is kept');
});
