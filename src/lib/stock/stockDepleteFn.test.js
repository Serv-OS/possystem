/**
 * stockDepleteFn.test.js: the stock-deplete edge function driven end to end in node (18 Oct 2026,
 * v5.11.76, stock fences). It posts stock movements with the service role, so who may ask is
 * proven here: a stranger is refused before a single recipe is read; a bound till, a Back Office
 * login and the service role are served. v5.11.77: an online customer is refused even for a check
 * stored as a PAID online order (anyone can write such a check with the public key; probe A4).
 *
 * The Deno file is imported directly (node strips the types). Its esm.sh import is mapped to a
 * stub whose createClient hands back fakes: the service role client (the function's own tables)
 * or, when a caller token rides in the headers, the caller's client, whose only question is the
 * database's reach rule (stock_caller_reaches, or accessible_location_ids before 20261018a).
 * Against the code on main before v5.11.76 the refusal cases here fail: it served everybody.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  authoriseStockDeplete, callerReachesVenue, isVenueId,
} from '../../../supabase/functions/_shared/stockDepleteCaller.js';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('https://esm.sh/@supabase/supabase-js')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__mkClient(...a);', shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const OTHER = '0d2c7a1e-5b7f-4c1e-9a55-2b8f3c1d9e01';
const ENV = { SUPABASE_URL: 'http://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' };
const TOKENS = { till: 'tok-till', bo: 'tok-bo', stranger: 'tok-stranger', kioskElsewhere: 'tok-kiosk-other', customer: 'tok-customer' };

// -- the fakes -------------------------------------------------------------------------
const state = { reads: [], posts: [], reachCalls: [], reach: null, checks: [], logs: [] };

function opsTables() {
  return {
    inventory_items: [{ id: 'inv-milk', base_unit: 'each', location_id: LOC }, { id: 'inv-oat', base_unit: 'each', location_id: LOC }],
    inventory_item_conversions: [],
    item_packaging_formats: [],
    menu_item_recipes: [
      { menu_item_id: 'latte', recipe_id: 'r-latte', portion: 1, location_id: LOC },
      { menu_item_id: 'oat-shot', recipe_id: 'r-oat', portion: 1, location_id: LOC },
    ],
    recipes: [{ id: 'r-latte', wastage_pct: 0, location_id: LOC, archived_at: null }, { id: 'r-oat', wastage_pct: 0, location_id: LOC, archived_at: null }],
    recipe_lines: [
      { recipe_id: 'r-latte', component_item_id: 'inv-milk', qty: 1, unit: 'each', usable_pct: 100, order_types: null, location_id: LOC },
      { recipe_id: 'r-oat', component_item_id: 'inv-oat', qty: 1, unit: 'each', usable_pct: 100, order_types: null, location_id: LOC },
    ],
    closed_checks: state.checks,
  };
}

function opsDb() {
  const tables = opsTables();
  return {
    rpc: async (fn, args) => {
      if (fn === 'post_stock_movement') { state.posts.push(args); return { data: { id: `m${state.posts.length}` }, error: null }; }
      return { data: null, error: { code: 'PGRST202', message: `no function ${fn}` } };
    },
    from(table) {
      state.reads.push(table);
      const filters = [];
      let single = false;
      const run = () => {
        const rows = (table === 'closed_checks' ? state.checks : tables[table] || []).filter((r) => filters.every((f) => f(r)));
        return single ? { data: rows[0] ? { ...rows[0] } : null, error: null } : { data: rows.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select() { return b; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return b; },
        is(c, v) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        maybeSingle() { single = true; return b; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return b;
    },
  };
}

function callerDb(token) {
  return {
    rpc: async (fn, args) => {
      state.reachCalls.push({ token, fn, args });
      return state.reach(token, fn, args);
    },
    from() { throw new Error('the caller client is only ever asked the reach rule'); },
  };
}

// The database after 20261018a: the till and the Back Office login reach LOC, the kiosk reaches OTHER.
const reachAfter = (token, fn, args) => {
  if (fn !== 'stock_caller_reaches') return { data: null, error: { code: 'PGRST202', message: 'no function' } };
  const where = { [TOKENS.till]: [LOC], [TOKENS.bo]: [LOC], [TOKENS.kioskElsewhere]: [OTHER] }[token] || [];
  return { data: where.includes(args.p_location_id), error: null };
};
// The database before 20261018a: no stock_caller_reaches, the set from accessible_location_ids.
const reachBefore = (token, fn) => {
  if (fn === 'stock_caller_reaches') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stock_caller_reaches(p_location_id) in the schema cache' } };
  if (fn === 'accessible_location_ids') {
    const where = { [TOKENS.till]: [LOC], [TOKENS.bo]: [LOC, OTHER] }[token] || [];
    return { data: where.map((id) => ({ accessible_location_ids: id })), error: null };
  }
  return { data: null, error: { code: 'PGRST202', message: 'no function' } };
};

let handler;
before(async () => {
  globalThis.__mkClient = (url, key, opts) => {
    const auth = opts?.global?.headers?.Authorization;
    if (auth) return callerDb(String(auth).replace(/^Bearer\s+/i, ''));
    assert.equal(key, ENV.SUPABASE_SERVICE_ROLE_KEY, 'the only client without a caller token is the service role');
    return opsDb();
  };
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  const warn = console.warn;
  console.warn = (...a) => { if (String(a[0]).startsWith('[stock-deplete]')) state.logs.push(a.join(' ')); else warn(...a); };
  await import('../../../supabase/functions/stock-deplete/index.ts');
});

beforeEach(() => {
  state.reads = []; state.posts = []; state.reachCalls = []; state.reach = reachAfter; state.logs = [];
  state.checks.length = 0;
});

const BODY = { location_id: LOC, check_id: 'chk-1', items: [{ itemId: 'latte', qty: 2, mods: [{ itemId: 'oat-shot', qty: 1 }] }], order_type: 'takeaway' };
async function call(body, { token = null, apikey = 'anon-key' } = {}) {
  const headers = { 'content-type': 'application/json', apikey };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handler(new Request('http://fn.test/stock-deplete', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const recipeReads = () => state.reads.filter((t) => t !== 'closed_checks');
const posted = () => Object.fromEntries(state.posts.map((p) => [p.p_inventory_item_id, p.p_qty_base]));

// -- the function, end to end ------------------------------------------------------------
test('a stranger is refused, and nothing is read or posted', async () => {
  const r = await call(BODY, { token: TOKENS.stranger });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'stock_caller');
  assert.equal(r.body.reason, 'not_this_venue');
  assert.deepEqual(state.posts, []);
  assert.deepEqual(recipeReads(), [], 'no recipe table is read for a refused caller');
  assert.deepEqual(state.reachCalls.map((c) => c.fn), ['stock_caller_reaches']);
  assert.equal(state.logs.length, 1, 'one refusal line in the function log');
  assert.match(state.logs[0], /refused .*not_this_venue/);
});

test('the bare public key (no session) is refused', async () => {
  const r = await call(BODY, { token: 'anon-key' });
  assert.equal(r.status, 403);
  assert.deepEqual(state.posts, []);
});

test('no Authorization header at all is refused', async () => {
  const r = await call(BODY);
  assert.equal(r.status, 403);
  assert.deepEqual(state.reachCalls, [], 'with no token there is nobody to ask about');
  assert.deepEqual(state.posts, []);
});

test('a bound till of the venue is served with the lines it sent', async () => {
  const r = await call(BODY, { token: TOKENS.till });
  assert.equal(r.status, 200);
  assert.equal(r.body.depleted, 2);
  assert.deepEqual(posted(), { 'inv-milk': -2, 'inv-oat': -2 });
  assert.deepEqual(state.reachCalls[0].args, { p_location_id: LOC });
  assert.equal(state.posts[0].p_idempotency_key, 'sale:chk-1:inv-milk', 'the movement key is unchanged');
});

test('a Back Office login of the venue is served, reverse included', async () => {
  const r = await call({ ...BODY, reverse: true }, { token: TOKENS.bo });
  assert.equal(r.status, 200);
  assert.deepEqual(posted(), { 'inv-milk': 2, 'inv-oat': 2 });
  assert.equal(state.posts[0].p_movement_type, 'RETURN');
});

test('a kiosk bound to ANOTHER venue is refused at this one (an old till pairing in its browser)', async () => {
  const r = await call(BODY, { token: TOKENS.kioskElsewhere });
  assert.equal(r.status, 403);
  assert.deepEqual(state.posts, []);
});

test('the service role is served without asking the database who it is', async () => {
  const r = await call(BODY, { token: ENV.SUPABASE_SERVICE_ROLE_KEY });
  assert.equal(r.status, 200);
  assert.deepEqual(state.reachCalls, []);
  assert.deepEqual(posted(), { 'inv-milk': -2, 'inv-oat': -2 });
});

test('v5.11.77: a check stored as a paid online order is no longer a door: the customer is refused, nothing read or posted', async () => {
  // Anyone holding the public key can write this row (closed_checks insert policy with check true).
  for (const chk of [
    { id: 'chk-1', location_id: LOC, source: 'online', status: 'paid', voided: false, order_type: 'collection', items: [{ itemId: 'latte', qty: 100 }] },
    { id: 'chk-1', location_id: LOC, source: 'qr', status: 'paid', voided: false, items: [{ itemId: 'latte', qty: 1 }] },
    { id: 'chk-1', location_id: LOC, source: 'catering', status: 'paid', voided: false, items: [{ itemId: 'latte', qty: 1 }] },
  ]) {
    state.checks.length = 0; state.posts = []; state.reads = [];
    state.checks.push(chk);
    for (const token of [TOKENS.customer, TOKENS.stranger, null]) {
      const r = await call(BODY, { token });
      assert.equal(r.status, 403, `${chk.source} with ${token}`);
      assert.equal(r.body.reason, 'not_this_venue');
    }
    assert.deepEqual(state.posts, [], 'nothing posted');
    assert.deepEqual(state.reads, [], 'not even the stored check is read');
  }
});

test('an online customer cannot reverse', async () => {
  state.checks.push({ id: 'chk-1', location_id: LOC, source: 'online', status: 'paid', voided: false, items: [{ itemId: 'latte', qty: 1 }] });
  const r = await call({ ...BODY, reverse: true }, { token: TOKENS.customer });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'reverse_needs_venue');
  assert.deepEqual(state.posts, []);
});

test('before 20261018a runs: the same answer from accessible_location_ids', async () => {
  state.reach = reachBefore;
  const till = await call(BODY, { token: TOKENS.till });
  assert.equal(till.status, 200);
  assert.deepEqual(state.reachCalls.map((c) => c.fn), ['stock_caller_reaches', 'accessible_location_ids']);
  state.posts = []; state.reachCalls = [];
  const stranger = await call(BODY, { token: TOKENS.stranger });
  assert.equal(stranger.status, 403);
  assert.deepEqual(state.posts, []);
});

test('any other failure of the reach question refuses (fails closed)', async () => {
  state.reach = () => ({ data: null, error: { code: '500', message: 'upstream timeout' } });
  const r = await call(BODY, { token: TOKENS.till });
  assert.equal(r.status, 403);
  assert.deepEqual(state.reachCalls.map((c) => c.fn), ['stock_caller_reaches'], 'no fallback on a real error');
  assert.deepEqual(state.posts, []);
});

test('a location that is not a venue id is a bad request, before anyone is asked', async () => {
  const r = await call({ ...BODY, location_id: 'loc-demo' }, { token: TOKENS.till });
  assert.equal(r.status, 400);
  assert.deepEqual(state.reachCalls, []);
  const empty = await call({ ...BODY, items: [] }, { token: TOKENS.till });
  assert.equal(empty.status, 400);
});

// -- the rule, unit by unit ---------------------------------------------------------------
test('isVenueId: only a uuid', () => {
  assert.equal(isVenueId(LOC), true);
  assert.equal(isVenueId(LOC.toUpperCase()), true);
  for (const v of ['', 'loc-demo', `${LOC},x`, null, undefined, 42]) assert.equal(isVenueId(v), false, String(v));
});

test('callerReachesVenue: any doubt is no', async () => {
  const db = (answer) => ({ rpc: async () => answer });
  assert.equal(await callerReachesVenue(db({ data: true, error: null }), LOC), true);
  assert.equal(await callerReachesVenue(db({ data: false, error: null }), LOC), false);
  assert.equal(await callerReachesVenue(db({ data: 'true', error: null }), LOC), false, 'only a real boolean true');
  assert.equal(await callerReachesVenue(db({ data: null, error: { code: '42501', message: 'permission denied' } }), LOC), false);
  assert.equal(await callerReachesVenue({ rpc: async () => { throw new Error('network'); } }, LOC), false);
  assert.equal(await callerReachesVenue(db({ data: true, error: null }), 'not-a-venue'), false);
  assert.equal(await callerReachesVenue(null, LOC), false);
});

test('authoriseStockDeplete: an empty service key never matches an empty token', async () => {
  const d = await authoriseStockDeplete({ authorization: 'Bearer ', serviceKey: '', makeCallerDb: () => null, ops: opsDb(), body: BODY });
  assert.equal(d.ok, false);
});
