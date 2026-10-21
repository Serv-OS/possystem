/**
 * stockDepleteFn.test.js: the stock-deplete edge function, RETIRED in the drainer release
 * (migration 20261023a, multi site stock map 8.1 step 6, drainer contract 3.4 and 4.2), driven end
 * to end in node.
 *
 * The database takes stock off every channel itself, so the function answers every POST with
 * 200 { "retired": true }: whoever asks (no token, the bare public key, a till, a Back Office login,
 * the service role, a stranger) and whatever they send (a sale, a reverse, a bad body, no body).
 * Proven here: no database client is made, no key or setting is read, no header and no body is
 * read, no network call goes out, nothing is read or posted. OPTIONS still answers the CORS
 * preflight and any other method is still refused, as before.
 *
 * The Deno file is imported directly (node strips the types). Every door it could use is a spy:
 * the esm.sh client import (mapped to a stub that counts createClient calls, should the import
 * ever come back), Deno.env.get, globalThis.fetch, and each request's headers and body readers.
 * Against the code on main before the drainer release (v5.11.84) the load, POST and source tests
 * here fail (it read its keys, built a client, asked who the caller was, read the recipe tables and
 * posted movements); the OPTIONS and 405 tests pass on both, because those answers did not change.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('https://esm.sh/@supabase/supabase-js')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__mkClient(...a);', shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FN = path.join(ROOT, 'supabase/functions/stock-deplete/index.ts');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const ENV = { SUPABASE_URL: 'http://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' };
const TOKENS = { till: 'tok-till', bo: 'tok-bo', stranger: 'tok-stranger', customer: 'tok-customer' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type' };

// -- the spies -------------------------------------------------------------------------
const state = { clients: 0, envReads: [], fetches: [], headerReads: 0, bodyReads: 0 };
let handler;
let atLoad;   // what the import itself did, with every spy on
function reset() {
  state.clients = 0; state.envReads = []; state.fetches = []; state.headerReads = 0; state.bodyReads = 0;
}

before(async () => {
  globalThis.__mkClient = () => { state.clients += 1; throw new Error('a retired function makes no database client'); };
  globalThis.Deno = {
    env: { get: (k) => { state.envReads.push(k); return ENV[k]; } },
    serve: (h) => { handler = h; },
  };
  globalThis.fetch = async (url) => { state.fetches.push(String(url)); throw new Error('a retired function makes no network call'); };
  await import('../../../supabase/functions/stock-deplete/index.ts');
  atLoad = { clients: state.clients, envReads: [...state.envReads], fetches: [...state.fetches] };
});

beforeEach(reset);

// A Request whose header and body readers count every read.
function spiedRequest(method, { token = null, apikey = 'anon-key', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (apikey) headers.apikey = apikey;
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const req = new Request('http://fn.test/stock-deplete', init);
  const get = req.headers.get.bind(req.headers);
  const has = req.headers.has.bind(req.headers);
  req.headers.get = (...a) => { state.headerReads += 1; return get(...a); };
  req.headers.has = (...a) => { state.headerReads += 1; return has(...a); };
  for (const reader of ['json', 'text', 'arrayBuffer', 'formData', 'blob']) {
    const own = req[reader].bind(req);
    req[reader] = (...a) => { state.bodyReads += 1; return own(...a); };
  }
  return req;
}

async function call(method, opts = {}) {
  const res = await handler(spiedRequest(method, opts));
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* the preflight answers plain text */ }
  return { status: res.status, body, headers: Object.fromEntries(res.headers.entries()) };
}

function nothingTouched(what) {
  assert.equal(state.clients, 0, `${what}: no database client is made`);
  assert.deepEqual(state.envReads, [], `${what}: no key or setting is read`);
  assert.deepEqual(state.fetches, [], `${what}: no network call goes out`);
  assert.equal(state.headerReads, 0, `${what}: no header (no token, no key) is read`);
  assert.equal(state.bodyReads, 0, `${what}: the body is not read`);
}

const SALE = { location_id: LOC, check_id: 'chk-1', items: [{ itemId: 'latte', qty: 2, mods: [{ itemId: 'oat-shot', qty: 1 }] }], order_type: 'takeaway' };

// -- the function, end to end ------------------------------------------------------------
test('loading the module reads nothing: no key, no client, no network; Deno.serve(handler) starts it', () => {
  assert.equal(typeof handler, 'function', 'Deno.serve(handler) is still how it starts');
  assert.deepEqual(atLoad, { clients: 0, envReads: [], fetches: [] });
  const src = read('supabase/functions/stock-deplete/index.ts');
  assert.match(src, /^Deno\.serve\(handler\);$/m);
  assert.doesNotMatch(src, /Deno\.env/, 'no key or setting is read, at load or per call');
});

test('every caller gets 200 { retired: true } and nothing is read or posted', async () => {
  const callers = {
    'no token': { token: null, apikey: null },
    'the bare public key': { token: ENV.SUPABASE_ANON_KEY },
    'a bound till': { token: TOKENS.till },
    'a Back Office login': { token: TOKENS.bo },
    'the service role': { token: ENV.SUPABASE_SERVICE_ROLE_KEY, apikey: ENV.SUPABASE_SERVICE_ROLE_KEY },
    'a stranger': { token: TOKENS.stranger },
    'an online customer': { token: TOKENS.customer },
  };
  for (const [who, opts] of Object.entries(callers)) {
    reset();
    const r = await call('POST', { ...opts, body: SALE });
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.body, { retired: true }, who);
    assert.equal(r.headers['content-type'], 'application/json', who);
    for (const [k, v] of Object.entries(CORS)) assert.equal(r.headers[k], v, `${who}: ${k}`);
    nothingTouched(who);
  }
});

test('whatever is sent: a reverse, a bad venue, no items, bad JSON or no body at all, the same answer', async () => {
  const bodies = {
    'a reverse (put stock back)': { ...SALE, reverse: true },
    'a location that is not a venue id': { ...SALE, location_id: 'loc-demo' },
    'no items': { ...SALE, items: [] },
    'not JSON': '{ this is not json',
    'no body': undefined,
  };
  for (const [what, body] of Object.entries(bodies)) {
    reset();
    const r = await call('POST', { token: TOKENS.till, body });
    assert.equal(r.status, 200, what);
    assert.deepEqual(r.body, { retired: true }, what);
    nothingTouched(what);
  }
});

test('OPTIONS answers the CORS preflight as before', async () => {
  const r = await call('OPTIONS', { token: null, apikey: null });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'ok');
  for (const [k, v] of Object.entries(CORS)) assert.equal(r.headers[k], v, k);
  nothingTouched('the preflight');
});

test('any other method is still refused (405), and nothing is read', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    reset();
    const r = await call(method, { token: TOKENS.till });
    assert.equal(r.status, 405, method);
    assert.deepEqual(r.body, { error: 'method not allowed' }, method);
    nothingTouched(method);
  }
});

// -- the source: nothing left that could take stock off -----------------------------------
test('the source keeps no client, no reads, no posts, no recipe rule and no caller rule', () => {
  const src = read('supabase/functions/stock-deplete/index.ts');
  assert.doesNotMatch(src, /createClient|supabase-js/, 'no database client');
  assert.doesNotMatch(src, /\.rpc\(|\.from\(|post_stock_movement/, 'no read, no post');
  assert.doesNotMatch(src, /\bfetch\(/, 'no network call');
  assert.doesNotMatch(src, /\bimport\b/, 'imports nothing');
  assert.doesNotMatch(src, /buildCtx|inventory_items|recipe_lines|menu_item_recipes|item_packaging_formats|inventory_item_conversions/, 'the unpaged reads are gone');
  assert.doesNotMatch(src, /\bUNITS\b|function (convert|toBase|globalFactor)\b/, 'the unit table copy is gone');
  assert.doesNotMatch(src, /authoriseStockDeplete|stockDepleteCaller|req\.json|req\.headers/, 'no caller rule, no header or body read');
  assert.match(src, /json\(\{ retired: true \}\)/);
  assert.match(src, /--no-verify-jwt/, 'the deploy line keeps the public door (old kiosks call it with the public key)');
  assert.ok(fs.statSync(FN).isFile());
});

test('the caller rule file is deleted and nothing in the edge functions imports it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'supabase/functions/_shared/stockDepleteCaller.js')), false);
  const dir = path.join(ROOT, 'supabase/functions');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(dir).filter((f) => /\.(ts|js|mjs)$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /stockDepleteCaller/, path.relative(ROOT, file));
  }
});
