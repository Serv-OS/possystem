// node --test: the invoice scan asks who is signing in (api/_userAuth.js and api/stock-invoice-scan.js,
// v5.11.82, multi site stock Drop 0, plan 7.7 and 9.6). Until now anyone could post an image and
// spend the vision key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requireVenueUser, bearerToken, supabaseEnv, idList, isMissingFunction } from '../../../api/_userAuth.js';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const ENV = { SUPABASE_URL: 'https://ops.test/', VITE_SUPABASE_ANON_KEY: 'public-key' };
const LOC = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const req = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, ...extra });

// A stand in for fetch: Auth knows some tokens; the database answers the reach and device questions.
function fakeFetch({ users = {}, reach = {}, devices = {}, reachMissing = false, fallback = {} } = {}) {
  const calls = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const f = async (url, init) => {
    const token = String(init.headers.authorization || '').replace('Bearer ', '');
    calls.push({ url, token, apikey: init.headers.apikey, body: init.body });
    if (url === 'https://ops.test/auth/v1/user') return users[token] ? res(200, users[token]) : res(401, { msg: 'invalid JWT' });
    if (url.endsWith('/rpc/stock_reach_locations')) return reachMissing ? res(404, { code: 'PGRST202', message: 'Could not find the function public.stock_reach_locations without parameters in the schema cache' }) : res(200, reach[token] || []);
    if (url.endsWith('/rpc/user_accessible_locations')) return res(200, fallback[token] || []);
    if (url.endsWith('/rpc/ops_can_write')) return res(200, (devices[token] || []).includes(JSON.parse(init.body).p_location_id));
    return res(404, {});
  };
  return { f, calls };
}

const USERS = {
  'tok-mgr': { id: 'u1', is_anonymous: false },
  'tok-phone': { id: 'd1', is_anonymous: true },
  'tok-kiosk': { id: 'k1', is_anonymous: true },
};

test('no token, a token Auth refuses, or no venue: refused before anything is read or spent', async () => {
  const { f, calls } = fakeFetch({ users: USERS });
  let r = await requireVenueUser(req(null), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([r.ok, r.status], [false, 401]);
  assert.equal(calls.length, 0, 'not even Auth is asked without a token');
  r = await requireVenueUser(req('tok-bad'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([r.ok, r.status], [false, 401]);
  r = await requireVenueUser(req('tok-mgr'), { locationId: null, env: ENV, fetchImpl: f });
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, 'location_id required']);
  r = await requireVenueUser(req('tok-mgr'), { locationId: 'not-a-venue', env: ENV, fetchImpl: f });
  assert.equal(r.status, 400);
  r = await requireVenueUser(req('tok-mgr'), { locationId: LOC, env: {}, fetchImpl: f });
  assert.equal(r.status, 500, 'no address or public key: refuse, never wave through');
});

test('a signed in login: the venue must be in its stock reach, asked with its own token and the public key', async () => {
  const { f, calls } = fakeFetch({ users: USERS, reach: { 'tok-mgr': [LOC] } });
  const ok = await requireVenueUser(req('tok-mgr'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([ok.ok, ok.via, ok.user.id], [true, 'reach', 'u1']);
  assert.ok(calls.every((c) => c.token === 'tok-mgr' && c.apikey === 'public-key'), 'only the caller\'s token and the public key, never a service key');
  const no = await requireVenueUser(req('tok-mgr'), { locationId: OTHER, env: ENV, fetchImpl: f });
  assert.deepEqual([no.ok, no.status], [false, 403]);
  assert.match(no.error, /^Not allowed: /);
});

test('before 20261021a the reach is user_accessible_locations()', async () => {
  const { f, calls } = fakeFetch({ users: USERS, reachMissing: true, fallback: { 'tok-mgr': [{ user_accessible_locations: LOC }] } });
  const ok = await requireVenueUser(req('tok-mgr'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.equal(ok.ok, true);
  assert.ok(calls.some((c) => c.url.endsWith('/rpc/user_accessible_locations')));
  assert.equal(isMissingFunction(404, { code: 'PGRST202' }), true);
  assert.equal(isMissingFunction(500, { code: '57014', message: 'timeout' }), false);
});

test('an anonymous session: only a Manager or Ops phone paired to that venue; a kiosk, till or customer is refused', async () => {
  const { f, calls } = fakeFetch({ users: USERS, devices: { 'tok-phone': [LOC] } });
  const phone = await requireVenueUser(req('tok-phone'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([phone.ok, phone.via], [true, 'device']);
  assert.ok(!calls.some((c) => c.url.includes('stock_reach_locations')), 'a device is never asked the login reach');
  const elsewhere = await requireVenueUser(req('tok-phone'), { locationId: OTHER, env: ENV, fetchImpl: f });
  assert.deepEqual([elsewhere.ok, elsewhere.status], [false, 401]);
  const kiosk = await requireVenueUser(req('tok-kiosk'), { locationId: LOC, env: ENV, fetchImpl: f });
  assert.deepEqual([kiosk.ok, kiosk.status], [false, 401]);
});

test('Auth or the database not answering is a 503, never a pass', async () => {
  const down = async () => { throw new Error('network'); };
  const r = await requireVenueUser(req('tok-mgr'), { locationId: LOC, env: ENV, fetchImpl: down });
  assert.deepEqual([r.ok, r.status], [false, 503]);
  const { f } = fakeFetch({ users: USERS });
  const half = async (url, init) => (url.includes('/rpc/') ? { status: 500, ok: false, json: async () => ({ message: 'boom' }) } : f(url, init));
  const r2 = await requireVenueUser(req('tok-mgr'), { locationId: LOC, env: ENV, fetchImpl: half });
  assert.deepEqual([r2.ok, r2.status], [false, 503]);
});

test('helpers: the bearer token, the environment names the web app is built with, a set of ids', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc ' } }), 'abc');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), '');
  assert.equal(bearerToken({}), '');
  assert.deepEqual(supabaseEnv({ VITE_SUPABASE_URL: 'https://x.test/', VITE_SUPABASE_ANON_KEY: 'k' }), { url: 'https://x.test', anon: 'k' });
  assert.deepEqual(supabaseEnv({ SUPABASE_URL: 'https://a.test', SUPABASE_ANON_KEY: 'a', VITE_SUPABASE_URL: 'https://b.test', VITE_SUPABASE_ANON_KEY: 'b' }), { url: 'https://a.test', anon: 'a' });
  assert.deepEqual(idList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(idList([{ stock_reach_locations: 'a' }]), ['a']);
  assert.deepEqual(idList(null), []);
});

test('the scan route checks first, holds no service key, and the web app sends the token and the venue (source)', () => {
  const src = read('api/stock-invoice-scan.js');
  assert.match(src, /import \{ requireVenueUser \} from '\.\/_userAuth\.js';/);
  const handler = src.slice(src.indexOf('export default async function handler'));
  const check = handler.indexOf('await requireVenueUser(req, { locationId: req.body?.location_id ?? null })');
  assert.ok(check > 0, 'the check is there');
  assert.ok(check < handler.indexOf('process.env.ANTHROPIC_API_KEY'), 'before the key is read');
  assert.ok(check < handler.indexOf("fetch('https://api.anthropic.com"), 'before anything is spent');
  assert.match(handler, /if \(!who\.ok\) return res\.status\(who\.status\)\.json\(\{ error: who\.error \}\);/);
  const helper = read('api/_userAuth.js');
  assert.doesNotMatch(helper, /SERVICE_ROLE|service_role|SERVICE_KEY/i, 'the helper never sees the service key');
  const web = read('src/lib/stock/purchasing.js');
  const scan = web.slice(web.indexOf('export const scanInvoice'));
  assert.match(scan, /headers\.authorization = `Bearer \$\{token\}`/);
  assert.match(scan, /location_id: loc \|\| null/);
});
