// node --test: a venue's loyalty code text service is made, checked and repaired by the code that
// ships (22 Oct 2026, v5.11.94). _shared/otpService.ts and loyalty-otp/index.ts are loaded as they
// deploy (types stripped by node, the Supabase client import a stand in that answers from plain rows,
// `fetch` a stand in for verify.twilio.com), so the decisions, the rows written, the feed alerts,
// the nightly summary, who may run it, and the send's refusal are proven, not read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHARED = 'VA00000000000000000000000000000000';
const ENV = {
  SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  PLATFORM_SUPABASE_URL: 'https://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key',
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token', TWILIO_VERIFY_SERVICE_SID: SHARED,
};

// ── a stand in for supabase-js: enough of the query builder for these functions ──
function makeDb({ tables = {}, users = {}, rpc = {} } = {}) {
  const log = [];
  let seq = 0;
  const T = (name) => (tables[name] ||= []);
  function from(table) {
    const st = { op: 'select', filters: [], payload: null, range: null, limit: null, single: null, onConflict: null };
    const match = (r) => st.filters.every(([op, k, v]) => {
      const x = r[k];
      if (op === 'eq') return x === v;
      if (op === 'neq') return x !== v;
      if (op === 'in') return v.includes(x);
      if (op === 'is') return v === null ? x == null : x === v;
      if (op === 'notis') return v === null ? x != null : x !== v;
      if (op === 'gte') return x >= v;
      if (op === 'gt') return x > v;
      if (op === 'lt') return x < v;
      if (op === 'notin') return !v.includes(x);
      if (op === 'like') return String(x ?? '').startsWith(String(v).replace(/%$/, ''));
      if (op === 'or') return v.some(([c, val]) => String(r[c]) === val);
      return true;
    });
    const run = () => {
      log.push({ table, op: st.op, filters: st.filters.slice(), payload: st.payload });
      if (st.op === 'insert' || st.op === 'upsert') {
        // id and created_at default as the real tables do
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: p.id || `${table}-${++seq}`, created_at: p.created_at || new Date().toISOString(), ...p }));
        if (st.op === 'insert' && table === 'message_templates') {
          // (company_id, message_type, channel) is unique, as on the Platform
          for (const p of list) {
            if (T(table).some((r) => r.company_id === p.company_id && r.message_type === p.message_type && r.channel === p.channel)) {
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
          }
        }
        if (st.op === 'upsert') {
          const keys = String(st.onConflict || 'id').split(',').map((s) => s.trim());
          for (const p of list) {
            const hit = T(table).find((r) => keys.every((k) => r[k] === p[k]));
            if (hit) Object.assign(hit, p); else T(table).push(p);
          }
          return { data: list, error: null };
        }
        T(table).push(...list);
        return { data: st.single || !Array.isArray(st.payload) ? list[0] : list, error: null };
      }
      let rows = T(table).filter(match);
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null }; }
      if (st.op === 'delete') { tables[table] = T(table).filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) rows = rows.slice(0, st.limit);
      if (st.single === 'maybe') return { data: rows[0] || null, error: null };
      if (st.single === 'one') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: rows, error: null };
    };
    const q = {
      select(cols) { if (st.op === 'select') st.cols = cols; return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; },
      upsert(p, opts) { st.op = 'upsert'; st.payload = p; st.onConflict = opts?.onConflict || null; return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      delete() { st.op = 'delete'; return q; },
      eq(k, v) { st.filters.push(['eq', k, v]); return q; },
      neq(k, v) { st.filters.push(['neq', k, v]); return q; },
      in(k, v) { st.filters.push(['in', k, v]); return q; },
      is(k, v) { st.filters.push(['is', k, v]); return q; },
      not(k, op, v) {
        if (op === 'is') st.filters.push(['notis', k, v]);
        if (op === 'in') st.filters.push(['notin', k, String(v).replace(/^\(|\)$/g, '').split(',')]);
        return q;
      },
      gte(k, v) { st.filters.push(['gte', k, v]); return q; },
      gt(k, v) { st.filters.push(['gt', k, v]); return q; },
      lt(k, v) { st.filters.push(['lt', k, v]); return q; },
      like(k, v) { st.filters.push(['like', k, v]); return q; },
      or(expr) {
        const parts = String(expr).split(',').map((p) => { const [c, op, ...rest] = p.split('.'); return op === 'eq' ? [c, rest.join('.')] : null; }).filter(Boolean);
        st.filters.push(['or', null, parts]); return q;
      },
      order() { return q; },
      limit(n) { st.limit = n; return q; },
      range(a, b) { st.range = [a, b]; return q; },
      maybeSingle() { st.single = 'maybe'; return Promise.resolve(run()); },
      single() { st.single = 'one'; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }
  return {
    log, tables, users,
    auth: { getUser: async (token) => ({ data: { user: users[token] || null }, error: users[token] ? null : { message: 'invalid JWT' } }) },
    from,
    rpc: async (name, args) => {
      log.push({ rpc: name, args });
      const f = rpc[name];
      return f ? f(args) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    },
  };
}

// ── a stand in for verify.twilio.com ──
// services: { [sid]: { friendly_name } }. refuseCreate: every POST /Services answers 429.
// down: every request fails like a network outage.
function makeTwilio({ services = {}, refuseCreate = false, down = false } = {}) {
  const requests = [];
  let n = 0;
  const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? String(init.body) : '';
    requests.push({ url: u, method, body });
    if (down) throw new TypeError('fetch failed');
    const m = /^https:\/\/verify\.twilio\.com\/v2\/Services(?:\/([^/]+))?(\/Verifications|\/VerificationCheck)?$/.exec(u);
    if (!m) return j({ message: 'unknown url' }, 404);
    const [, sid, tail] = m;
    if (!sid) {
      if (refuseCreate) return j({ code: 20429, message: 'Too many Verify services on this account' }, 429);
      const name = new URLSearchParams(body).get('FriendlyName');
      const newSid = 'VA' + String(++n).padStart(32, '0');
      services[newSid] = { friendly_name: name };
      return j({ sid: newSid, friendly_name: name }, 201);
    }
    if (!services[sid]) return j({ code: 20404, message: 'The requested resource was not found' }, 404);
    if (tail === '/Verifications') return j({ sid: 'VE1', status: 'pending' }, 201);
    if (tail === '/VerificationCheck') return j({ status: 'approved' });
    if (method === 'POST') { services[sid].friendly_name = new URLSearchParams(body).get('FriendlyName'); return j({ sid, friendly_name: services[sid].friendly_name }); }
    return j({ sid, friendly_name: services[sid].friendly_name });
  };
  return { fetch, requests, services, touched: (s) => requests.filter((r) => r.url.includes(`/Services/${s}`)) };
}

const dbs = {};
globalThis.__edgeTest = { createClient: (url) => new Proxy({}, { get: (_t, prop) => (dbs[url] || dbs[ENV.SUPABASE_URL])[prop] }) };
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: () => {} };

async function loadEdge(fn) {
  const file = path.join(ROOT, 'supabase/functions', fn, 'index.ts');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = (...a) => globalThis.__edgeTest.createClient(...a);');
  src = src.replace("import { secondStepRefusal } from '../_shared/second-step.ts';", 'const secondStepRefusal = async () => null;');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(file), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/, `${fn}: an import the test cannot stand in for`);
  const out = path.join(os.tmpdir(), `edge-${fn}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  let handler = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  assert.equal(typeof handler, 'function', `${fn}: Deno.serve was not called`);
  return handler;
}

const post = (handler, body, { token = null, headers = {} } = {}) => handler(new Request('https://ops.test/functions/v1/loyalty-otp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
}));
const answer = async (res) => ({ status: res.status, body: await res.json() });

// ── the world (synthetic ids and neutral words only: the repo is public) ──
const CO = 'c0000000-0000-4000-8000-00000000000c';      // loyalty on
const CO_OFF = 'c0000000-0000-4000-8000-00000000000f';  // loyalty off
const V = (n) => `10000000-0000-4000-8000-00000000000${n}`;   // Ops ids
const P = (n) => `a0000000-0000-4000-8000-00000000000${n}`;   // Platform ids
const READY = V(1), DRIFT = V(2), NONE = V(3), REFUSED = V(4), GONE = V(5), AT_SHARED = V(6), OFF = V(7);
const SID_READY = 'VA11111111111111111111111111111111';
const SID_DRIFT = 'VA22222222222222222222222222222222';
const SID_GONE = 'VA55555555555555555555555555555555';
const srow = (loc, sid) => ({ company_id: CO, message_type: `loyalty_otp_service:${loc}`, channel: 'sms', body_text: sid, enabled: true });

function world() {
  const ops = makeDb({
    tables: {
      locations: [
        { id: READY, org_id: CO, name: 'Cafe One', currency: 'GBP' }, { id: DRIFT, org_id: CO, name: 'Cafe  Two', currency: 'GBP' },
        { id: NONE, org_id: CO, name: 'Cafe Three', currency: 'GBP' }, { id: REFUSED, org_id: CO, name: 'Cafe Four', currency: 'GBP' },
        { id: GONE, org_id: CO, name: 'Cafe Five', currency: 'GBP' }, { id: AT_SHARED, org_id: CO, name: 'Cafe Six', currency: 'GBP' },
        { id: OFF, org_id: CO_OFF, name: 'Quiet Cafe', currency: 'GBP' },
      ],
      user_profiles: [{ id: 'u-linked', role: 'manager', org_id: CO }, { id: 'u-other', role: 'manager', org_id: CO_OFF }],
      user_locations: [{ user_id: 'u-linked', location_id: READY }, { user_id: 'u-other', location_id: OFF }],
      activity_events: [],
      loyalty_otp_service_audit: [],
    },
    users: { 'tok-linked': { id: 'u-linked' }, 'tok-other': { id: 'u-other' }, 'tok-anon': { id: 'u-anon', is_anonymous: true } },
    rpc: { loyalty_otp_cron_ok: ({ p_key }) => ({ data: p_key === 'k'.repeat(64), error: null }) },
  });
  const platform = makeDb({
    tables: {
      companies: [{ id: CO, name: 'Cafe Company' }, { id: CO_OFF, name: 'Quiet Company' }],
      loyalty_config: [{ company_id: CO, enabled: true }, { company_id: CO_OFF, enabled: false }],
      locations: [
        { id: P(1), ops_location_id: READY, company_id: CO, name: 'Cafe One' }, { id: P(2), ops_location_id: DRIFT, company_id: CO, name: 'Cafe Two' },
        { id: P(3), ops_location_id: NONE, company_id: CO, name: 'Cafe Three' }, { id: P(4), ops_location_id: REFUSED, company_id: CO, name: 'Cafe Four' },
        { id: P(5), ops_location_id: GONE, company_id: CO, name: 'Cafe Five' }, { id: P(6), ops_location_id: AT_SHARED, company_id: CO, name: 'Cafe Six' },
        { id: P(7), ops_location_id: OFF, company_id: CO_OFF, name: 'Quiet Cafe' },
      ],
      message_templates: [
        srow(READY, SID_READY), srow(DRIFT, SID_DRIFT), srow(GONE, SID_GONE), srow(AT_SHARED, SHARED),
        { company_id: CO, message_type: 'loyalty_otp', channel: 'sms', body_text: 'Legacy Name', enabled: true },      // legacy company wide override
        { company_id: CO, message_type: 'loyalty_otp_service:b0000000-0000-4000-8000-00000000000b', channel: 'sms', body_text: 'VA99999999999999999999999999999999', enabled: true },  // a venue that is gone
      ],
      user_company_roles: [],
    },
  });
  const twilio = makeTwilio({ services: { [SHARED]: { friendly_name: 'Demo Venue' }, [SID_READY]: { friendly_name: 'Cafe One' }, [SID_DRIFT]: { friendly_name: 'Old Cafe Two' } } });
  return { ops, platform, twilio };
}

let svc;
let otpFn;
const fetch0 = globalThis.fetch;
test('the shared module and loyalty-otp load as they ship', async () => {
  svc = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/_shared/otpService.ts')).href);
  assert.equal(typeof svc.ensureVenueService, 'function');
  assert.equal(typeof svc.auditVenues, 'function');
  const w = world();
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  otpFn = await loadEdge('loyalty-otp');
});

test('audit: seven venues (one at a company with loyalty off), every decision, the rows written, the alerts, the summary; the shared service is never touched', async (t) => {
  const w = world();
  // the fourth venue has no service and Twilio refuses to make one: a per venue refusal, so the
  // stand in refuses only while that venue is being made (its name is in the create body)
  const fetch1 = w.twilio.fetch;
  w.twilio.fetch = async (url, init) => {
    if (String(url).endsWith('/v2/Services') && String(init?.body || '').includes('Cafe+Four')) {
      w.twilio.requests.push({ url: String(url), method: 'POST', body: String(init.body) });
      return new Response(JSON.stringify({ code: 20429, message: 'Too many Verify services on this account' }), { status: 429 });
    }
    return fetch1(url, init);
  };
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  const now = () => new Date('2026-10-22T04:10:00Z');
  const s = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: true, by: 'cron_key', now });

  const by = Object.fromEntries(s.results.map((r) => [r.location_id, r]));
  assert.deepEqual([by[READY].state, by[READY].action_taken], ['ready', 'none']);
  assert.deepEqual([by[DRIFT].state, by[DRIFT].action_taken, by[DRIFT].name], ['ready', 'renamed', 'Cafe Two'], 'the double space in the Ops name is made one');
  assert.equal(w.twilio.services[SID_DRIFT].friendly_name, 'Cafe Two');
  assert.deepEqual([by[NONE].state, by[NONE].action_taken], ['ready', 'created']);
  assert.deepEqual([by[REFUSED].state, by[REFUSED].ok], ['no_service', false]);
  assert.match(by[REFUSED].twilio_error, /Too many Verify services/, 'the provider\'s words are kept');
  assert.equal(w.twilio.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/v2/Services') && r.body.includes('Cafe+Four')).length, 2, 'two tries');
  assert.deepEqual([by[GONE].state, by[GONE].action_taken], ['ready', 'recreated']);
  assert.notEqual(by[GONE].service_sid, SID_GONE);
  assert.deepEqual([by[AT_SHARED].state, by[AT_SHARED].action_taken], ['ready', 'created'], 'a venue pointing at the shared service gets its own');
  assert.notEqual(by[AT_SHARED].service_sid, SHARED);
  // 22 Oct 2026 review: a company with loyalty off is audited too (its kiosk, online and QR sign in
  // still ask for code texts), so its venue gets its own service like any other
  assert.deepEqual([by[OFF].state, by[OFF].action_taken, by[OFF].company_id], ['ready', 'created', CO_OFF]);

  // the Platform rows now name the new services
  const rows = w.platform.tables.message_templates;
  assert.equal(rows.find((r) => r.message_type === `loyalty_otp_service:${NONE}`).body_text, by[NONE].service_sid);
  assert.equal(rows.find((r) => r.message_type === `loyalty_otp_service:${GONE}`).body_text, by[GONE].service_sid);
  assert.equal(rows.find((r) => r.message_type === `loyalty_otp_service:${AT_SHARED}`).body_text, by[AT_SHARED].service_sid);
  assert.equal(rows.filter((r) => r.message_type === `loyalty_otp_service:${REFUSED}`).length, 0, 'nothing stored for the refused venue');
  for (const sid of [by[NONE].service_sid, by[GONE].service_sid, by[AT_SHARED].service_sid]) assert.equal(w.twilio.services[sid].friendly_name, by[sid === by[NONE].service_sid ? NONE : sid === by[GONE].service_sid ? GONE : AT_SHARED].desired_name);

  // no request ever touches the shared service
  assert.equal(w.twilio.touched(SHARED).length, 0, 'the shared service is never read, renamed or recreated by the audit');

  // the audit table and the one alert
  const audit = w.ops.tables.loyalty_otp_service_audit;
  assert.equal(audit.length, 7);
  assert.equal(audit.find((r) => r.location_id === REFUSED).ok, false);
  assert.equal(audit.find((r) => r.location_id === REFUSED).run_by, 'cron_key');
  assert.match(audit.find((r) => r.location_id === REFUSED).twilio_error, /Too many/);
  assert.equal(s.audit_table, 'written');
  const alerts = w.ops.tables.activity_events;
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].location_id, alerts[0].kind, alerts[0].severity, alerts[0].ref_type, alerts[0].ref_id], [REFUSED, 'system', 'action', 'loyalty_otp_service', REFUSED]);
  assert.match(alerts[0].body, /press Fix/);

  // the summary
  assert.equal(s.ok, false);
  assert.equal(s.checked, 7);
  assert.equal(s.ready, 6);
  assert.deepEqual(s.not_ready.map((n) => n.location_id), [REFUSED]);
  assert.deepEqual(s.legacy_rows, [{ company_id: CO, message_type: 'loyalty_otp' }]);
  assert.deepEqual(s.orphan_rows.map((o) => o.message_type), ['loyalty_otp_service:b0000000-0000-4000-8000-00000000000b']);
  assert.deepEqual(s.alerted, [REFUSED]);

  // the run row the watchdog reads: a full run (no company), not ok because a venue is not ready
  const runs = w.ops.tables.loyalty_otp_audit_runs;
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].company_id, runs[0].fix, runs[0].ok, runs[0].checked, runs[0].ready, runs[0].not_ready, runs[0].skipped, runs[0].run_by],
    [null, true, false, 7, 6, 1, 0, 'cron_key']);
  assert.deepEqual(runs[0].errors, []);
  assert.equal(s.run_row, 'written');

  // the next night: nothing to do, and the open alert is not repeated
  const s2 = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: true, by: 'cron_key', now: () => new Date('2026-10-23T04:10:00Z') });
  assert.equal(s2.ready, 6);
  assert.equal(s2.results.filter((r) => r.action_taken !== 'none').length, 0, 'idempotent');
  assert.equal(w.ops.tables.activity_events.length, 1, 'one open alert per venue per week');
  // acknowledged: said again
  w.ops.tables.activity_events[0].acked_at = '2026-10-23T09:00:00Z';
  await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: true, by: 'cron_key', now: () => new Date('2026-10-24T04:10:00Z') });
  assert.equal(w.ops.tables.activity_events.length, 2);
});

test('audit without fix changes nothing and alerts nobody; a database without the audit table is said, not failed', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  delete w.ops.tables.loyalty_otp_service_audit;
  const from0 = w.ops.from;
  w.ops.from = (table) => {
    if (table !== 'loyalty_otp_service_audit') return from0(table);
    return { upsert: () => Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.loyalty_otp_service_audit' in the schema cache" } }) };
  };
  const s = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: false, by: 'staff' });
  assert.equal(s.ready, 1, 'only the ready venue is ready; nothing was changed');
  assert.deepEqual(s.by_state, { ready: 1, name_drift: 1, no_service: 3, missing_on_twilio: 1, points_at_shared: 1 });
  assert.equal(w.twilio.requests.filter((r) => r.method === 'POST').length, 0, 'no create, no rename');
  assert.equal(w.ops.tables.activity_events.length, 0, 'a read only check never alerts');
  assert.match(s.audit_table, /^missing/);
  assert.equal(s.errors.length, 0);
});

test('ensureVenueService: no name is never a service; the shared sid is never renamed; a lost race keeps the winner', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  // no name anywhere
  w.ops.tables.locations.find((l) => l.id === NONE).name = '';
  w.platform.tables.locations.find((l) => l.ops_location_id === NONE).name = '';
  w.platform.tables.companies.find((c) => c.id === CO).name = '';
  const noName = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: NONE, fix: true });
  assert.deepEqual([noName.state, noName.ok], ['no_name', false]);
  assert.equal(w.twilio.requests.length, 0, 'Twilio was not asked');
  // the override wins and is cut to 30
  w.platform.tables.message_templates.push({ company_id: CO, message_type: `loyalty_otp:${READY}`, channel: 'sms', body_text: 'Cafe One  Station Road North End Side', enabled: true });
  const ov = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: READY, fix: true });
  assert.deepEqual([ov.state, ov.action_taken, ov.name], ['ready', 'renamed', 'Cafe One Station Road North En']);
  // loyalty off is no reason to go without: the venue gets its own service (review, 22 Oct 2026)
  const offMade = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: OFF, fix: true });
  assert.deepEqual([offMade.state, offMade.action_taken], ['ready', 'created']);
  // a venue not in the Platform, even with a real company named: nothing asked of Twilio, no row
  const before = w.twilio.requests.length;
  const rowsBefore = w.platform.tables.message_templates.length;
  const nowhere = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: 'd0000000-0000-4000-8000-00000000000d', companyId: CO, fix: true });
  assert.deepEqual([nowhere.state, nowhere.ok, nowhere.company_id], ['not_provisioned', false, null]);
  // a company that is not the venue's: nothing asked of Twilio, no row, the company never taken from the caller
  const wrong = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: NONE, companyId: CO_OFF, fix: true });
  assert.deepEqual([wrong.state, wrong.ok, wrong.service_sid], ['wrong_company', false, null]);
  assert.match(wrong.words, /different company/);
  assert.equal(w.twilio.requests.length, before, 'Twilio was not asked for either');
  assert.equal(w.platform.tables.message_templates.length, rowsBefore, 'no row written for either');
  // the venue's own company named: fine
  const right = await svc.ensureVenueService({ ops: w.ops, platform: w.platform, opsLocationId: READY, companyId: CO, fix: false });
  assert.equal(right.state, 'ready');
  // a lost race: the insert fails because another call stored a row a moment ago
  const w2 = world();
  globalThis.fetch = w2.twilio.fetch;
  const from0 = w2.platform.from;
  let raced = false;
  w2.platform.from = (table) => {
    const q = from0(table);
    if (table !== 'message_templates') return q;
    const insert0 = q.insert;
    q.insert = (p) => {
      if (!raced && String(p.message_type).endsWith(NONE)) { raced = true; w2.platform.tables.message_templates.push(srow(NONE, SID_READY)); }
      return insert0(p);
    };
    return q;
  };
  const race = await svc.ensureVenueService({ ops: w2.ops, platform: w2.platform, opsLocationId: NONE, fix: true });
  assert.equal(race.service_sid, SID_READY, 'the winner\'s service is kept');
  assert.equal(w2.platform.tables.message_templates.filter((r) => r.message_type === `loyalty_otp_service:${NONE}`).length, 1);
  // Twilio unreadable: the row is kept, nothing is made or renamed
  const w3 = world();
  globalThis.fetch = makeTwilio({ down: true }).fetch;
  const unread = await svc.ensureVenueService({ ops: w3.ops, platform: w3.platform, opsLocationId: DRIFT, fix: true });
  assert.deepEqual([unread.state, unread.service_sid, unread.action_taken], ['twilio_unreadable', SID_DRIFT, 'none']);
  assert.match(unread.words, /^Could not check/);
});

test('loyalty-otp audit: the cron key (when the database says true), the service role, and staff for their own company; everyone else refused', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  let r = await answer(await post(otpFn, { action: 'audit' }, { headers: { 'x-cron-key': 'k'.repeat(64) } }));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.by, 'cron_key');
  assert.equal(r.body.checked, 7);
  r = await answer(await post(otpFn, { action: 'audit', fix: false }, { token: ENV.SUPABASE_SERVICE_ROLE_KEY }));
  assert.deepEqual([r.status, r.body.by], [200, 'service_role']);
  r = await answer(await post(otpFn, { action: 'audit' }, { headers: { 'x-cron-key': 'wrong' } }));
  assert.deepEqual([r.status, r.body.reason], [401, 'wrong_cron_key']);
  r = await answer(await post(otpFn, { action: 'audit' }, { token: 'tok-anon' }));
  assert.deepEqual([r.status, r.body.reason], [403, 'not_allowed'], 'an anonymous session (the kiosk) is not the cron');
  r = await answer(await post(otpFn, { action: 'audit' }));
  assert.deepEqual([r.status, r.body.reason], [403, 'not_allowed']);
  // staff: their own company only
  r = await answer(await post(otpFn, { action: 'audit', company_id: CO }, { token: 'tok-linked' }));
  assert.deepEqual([r.status, r.body.by, r.body.companies], [200, 'staff', 1]);
  r = await answer(await post(otpFn, { action: 'audit', company_id: CO }, { token: 'tok-other' }));
  assert.equal(r.status, 403, 'staff of another company');
  r = await answer(await post(otpFn, { action: 'audit' }, { token: 'tok-linked' }));
  assert.equal(r.status, 403, 'staff with no company named');
  // before 20261022b the cron route refuses, it never opens
  const noCheck = world();
  noCheck.ops.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.loyalty_otp_cron_ok' } });
  dbs[ENV.SUPABASE_URL] = noCheck.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = noCheck.platform;
  r = await answer(await post(otpFn, { action: 'audit' }, { headers: { 'x-cron-key': 'k'.repeat(64) } }));
  assert.deepEqual([r.status, r.body.reason], [503, 'needs_database_update']);
});

test('loyalty-otp ensure_service: staff of the venue get it made and answered; a stranger is refused; the company is never read from the body', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  let r = await answer(await post(otpFn, { action: 'ensure_service', location_id: READY }, { token: 'tok-linked' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.state, r.body.by, r.body.company_id], [true, 'ready', 'staff', CO]);
  assert.equal(r.body.words, 'Text service: ready as "Cafe One"');
  r = await answer(await post(otpFn, { action: 'ensure_service', location_id: NONE, company_id: CO_OFF }, { token: ENV.SUPABASE_SERVICE_ROLE_KEY }));
  assert.deepEqual([r.status, r.body.state, r.body.action_taken, r.body.company_id], [200, 'ready', 'created', CO], 'the company comes from the Platform row');
  r = await answer(await post(otpFn, { action: 'ensure_service', location_id: READY }, { token: 'tok-anon' }));
  assert.equal(r.status, 403);
  r = await answer(await post(otpFn, { action: 'ensure_service', location_id: READY }, { token: 'tok-other' }));
  assert.equal(r.status, 403, 'staff of another venue');
  r = await answer(await post(otpFn, { action: 'ensure_service', location_id: 'nope' }, { token: ENV.SUPABASE_SERVICE_ROLE_KEY }));
  assert.equal(r.status, 400);
});

test('loyalty-otp send: a venue with no service while Twilio is down is refused with a 503 and no code is sent; a ready venue sends from its own service', async (t) => {
  const w = world();
  const down = makeTwilio({ down: true });
  globalThis.fetch = down.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const send = (loc) => post(otpFn, { action: 'send', phone: '+447700900123', company_id: CO, location_id: loc }, { token: 'tok-anon' });
  let r = await answer(await send(NONE));
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.detail, /no text service of its own/);
  assert.equal(down.requests.filter((x) => x.url.includes('/Verifications')).length, 0, 'no code was sent');
  assert.equal(down.requests.filter((x) => x.method === 'POST' && x.url.endsWith('/v2/Services')).length, 2, 'two tries to make the service');
  assert.equal(down.requests.filter((x) => x.method === 'POST' && x.url.includes(`/Services/${SHARED}`)).length, 0, 'the shared service is never renamed');
  // Twilio back: the same venue gets its service and the code goes out from it
  globalThis.fetch = w.twilio.fetch;
  r = await answer(await send(NONE));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, true);
  const made = w.platform.tables.message_templates.find((x) => x.message_type === `loyalty_otp_service:${NONE}`).body_text;
  assert.ok(w.twilio.requests.some((x) => x.url === `https://verify.twilio.com/v2/Services/${made}/Verifications`), 'sent from the venue\'s own new service');
  assert.equal(w.twilio.services[made].friendly_name, 'Cafe Three');
  // a drifted name is put right before the send
  r = await answer(await send(DRIFT));
  assert.equal(r.status, 200);
  assert.equal(w.twilio.services[SID_DRIFT].friendly_name, 'Cafe Two');
  const idx = w.twilio.requests.findIndex((x) => x.url === `https://verify.twilio.com/v2/Services/${SID_DRIFT}` && x.method === 'POST');
  const sendIdx = w.twilio.requests.findIndex((x) => x.url === `https://verify.twilio.com/v2/Services/${SID_DRIFT}/Verifications`);
  assert.ok(idx >= 0 && sendIdx > idx, 'renamed before the code went out');
  assert.equal(w.twilio.touched(SHARED).filter((x) => x.method === 'POST').length, 0);
});

// ── review fixes, 22 Oct 2026 ──

test('loyalty-otp send: a made up venue, or a company that is not the venue\'s, makes no Twilio service and no row, and the code is refused', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const rows0 = w.platform.tables.message_templates.length;
  const send = (company_id, location_id) => post(otpFn, { action: 'send', phone: '+447700900123', company_id, location_id }, { token: 'tok-anon' });
  // the attack in the review: a real company and a fresh random venue id, again and again
  for (const n of [1, 2, 3]) {
    const r = await answer(await send(CO, `e0000000-0000-4000-8000-00000000000${n}`));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.detail, /not in the platform database/);
  }
  // a real venue named with another company
  const r = await answer(await send(CO_OFF, NONE));
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.detail, /different company/);
  assert.equal(w.twilio.requests.filter((x) => x.method === 'POST' && x.url.endsWith('/v2/Services')).length, 0, 'no Twilio service was made');
  assert.equal(w.twilio.requests.filter((x) => x.url.includes('/Verifications')).length, 0, 'no code was sent');
  assert.equal(w.platform.tables.message_templates.length, rows0, 'no row was written');
  assert.equal(w.ops.tables.loyalty_otp_service_audit.length, 0, 'a request that did not check out is not a venue\'s state');
});

test('loyalty-otp send: a refused code is in the audit table at once (the watchdog hears of it); the repair that follows clears it', async (t) => {
  const w = world();
  const down = makeTwilio({ down: true });
  globalThis.fetch = down.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const send = () => post(otpFn, { action: 'send', phone: '+447700900123', company_id: CO, location_id: NONE }, { token: 'tok-anon' });
  assert.equal((await send()).status, 503);
  let row = w.ops.tables.loyalty_otp_service_audit.find((x) => x.location_id === NONE);
  assert.deepEqual([row?.ok, row?.state, row?.run_by, row?.company_id], [false, 'no_service', 'send', CO]);
  globalThis.fetch = w.twilio.fetch;
  assert.equal((await send()).status, 200);
  row = w.ops.tables.loyalty_otp_service_audit.find((x) => x.location_id === NONE);
  assert.deepEqual([row.ok, row.state, row.action_taken], [true, 'ready', 'created']);
  // a ready venue's plain send writes nothing (no noise)
  const n = w.ops.log.filter((x) => x.table === 'loyalty_otp_service_audit').length;
  assert.equal((await answer(await post(otpFn, { action: 'send', phone: '+447700900123', company_id: CO, location_id: READY }, { token: 'tok-anon' }))).status, 200);
  assert.equal(w.ops.log.filter((x) => x.table === 'loyalty_otp_service_audit').length, n);
});

test('audit for one company (staff, loyalty switched on) never lists another company\'s rows; the nightly run lists all', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  w.platform.tables.message_templates.push(
    { company_id: CO_OFF, message_type: 'loyalty_otp_service', channel: 'sms', body_text: 'VA88888888888888888888888888888888', enabled: true },
    { company_id: CO_OFF, message_type: 'loyalty_otp_service:f0000000-0000-4000-8000-00000000000f', channel: 'sms', body_text: 'VA77777777777777777777777777777777', enabled: true },
    // a row under CO naming CO_OFF's venue (what the old send path could write): an orphan of CO
    { company_id: CO, message_type: `loyalty_otp_service:${OFF}`, channel: 'sms', body_text: 'VA66666666666666666666666666666666', enabled: true },
  );
  const mine = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: false, companyId: CO, by: 'staff' });
  const companiesSeen = new Set([...mine.legacy_rows, ...mine.orphan_rows, ...mine.not_ready, ...mine.results].map((x) => x.company_id));
  assert.deepEqual([...companiesSeen], [CO], 'only the asked company');
  assert.deepEqual(mine.orphan_rows.map((o) => o.message_type).sort(), [`loyalty_otp_service:${OFF}`, 'loyalty_otp_service:b0000000-0000-4000-8000-00000000000b'].sort());
  assert.equal(mine.venues, 6);
  assert.equal(w.ops.tables.loyalty_otp_audit_runs[0].company_id, CO, 'a one company run says so (the watchdog reads only full runs)');
  // over the loyalty-otp route too
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const r = await answer(await post(otpFn, { action: 'audit', company_id: CO, fix: false }, { token: 'tok-linked' }));
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes(CO_OFF), 'no id of the other company anywhere in the answer');
  const all = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: false, by: 'cron_key' });
  assert.deepEqual(all.legacy_rows.map((x) => x.company_id).sort(), [CO, CO_OFF].sort());
  assert.equal(all.orphan_rows.length, 3);
});

test('audit: a run that could not read the venues leaves a run row that says so (the watchdog then says it did not finish)', async (t) => {
  const w = world();
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  const from0 = w.platform.from;
  w.platform.from = (table) => {
    if (table !== 'locations') return from0(table);
    const q = from0(table);
    q.range = () => Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } });
    return q;
  };
  const s = await svc.auditVenues({ ops: w.ops, platform: w.platform, fix: true, by: 'cron_key' });
  assert.equal(s.ok, false);
  const run = w.ops.tables.loyalty_otp_audit_runs[0];
  assert.deepEqual([run.ok, run.checked, run.company_id], [false, 0, null]);
  assert.match(run.errors[0], /statement timeout/);
});

test('provision-location: an anonymous session is refused; a login that may not write at the venue gets no Twilio call and no service facts', async (t) => {
  const w = world();
  w.ops.tables.organisations = [{ id: CO, name: 'Cafe Company', slug: 'cafe-company' }];
  w.ops.tables.user_profiles.push({ id: 'u-owner', role: 'owner', org_id: CO });
  w.ops.users['tok-owner'] = { id: 'u-owner' };
  globalThis.fetch = w.twilio.fetch;
  t.after(() => { globalThis.fetch = fetch0; });
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const provision = await loadEdge('provision-location');
  const call = async (token) => answer(await provision(new Request('https://ops.test/functions/v1/provision-location', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ops_location_id: NONE }),
  })));
  let r = await call('tok-anon');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  r = await call('tok-other');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.service, null, 'no service facts for a stranger');
  assert.equal(w.twilio.requests.length, 0, 'and no Twilio call');
  r = await call('tok-owner');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.service?.state, r.body.service?.action_taken], ['ready', 'created'], 'an owner inside the company gets the service made');
  r = await call('tok-linked');
  assert.deepEqual([r.status, r.body.service], [200, null], 'a manager linked to a different venue of the company is not a writer here');
});

test('watchdog-status: venues whose codes are refused, a check that did not run, did not finish, or is not installed; never a 503 for it', async (t) => {
  const w = world();
  t.after(() => { globalThis.fetch = fetch0; });
  ENV.WATCHDOG_TOKEN = 't'.repeat(40);
  t.after(() => { delete ENV.WATCHDOG_TOKEN; });
  for (const tb of ['terminal_jobs', 'print_jobs', 'order_queue']) w.ops.tables[tb] = [];
  w.ops.tables.locations.find((l) => l.id === GONE).is_demo = true;
  dbs[ENV.SUPABASE_URL] = w.ops; dbs[ENV.PLATFORM_SUPABASE_URL] = w.platform;
  const status = await loadEdge('watchdog-status');
  const ask = async () => answer(await status(new Request('https://ops.test/functions/v1/watchdog-status', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-watchdog-token': ENV.WATCHDOG_TOKEN }, body: JSON.stringify({ windows: { otp_audit_stale: { olderThan: 26 * 60 } } }),
  })));
  // no run yet
  let r = await ask();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.otpAuditStale, /never run/);
  // a fresh full run, two venues not ready (one of them a demo venue, left out)
  const nowIso = new Date().toISOString();
  w.ops.tables.loyalty_otp_audit_runs = [{ ran_at: nowIso, ok: false, errors: [], skipped: 0, company_id: null, fix: true }];
  w.ops.tables.loyalty_otp_service_audit = [
    { location_id: REFUSED, ok: false, state: 'no_service' }, { location_id: GONE, ok: false, state: 'missing_on_twilio' }, { location_id: READY, ok: true, state: 'ready' },
  ];
  r = await ask();
  assert.deepEqual([r.body.otpAuditStale, r.body.otpAuditIncomplete], [null, null]);
  assert.deepEqual(r.body.otpNotReady, [{ venue: 'Cafe Four', count: 1, detail: 'no_service' }]);
  // a run that met errors
  w.ops.tables.loyalty_otp_audit_runs.unshift({ ran_at: new Date(Date.now() + 1000).toISOString(), ok: false, errors: ['audit table: permission denied'], skipped: 0, company_id: null, fix: true });
  w.ops.tables.loyalty_otp_audit_runs.sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1));
  r = await ask();
  assert.match(r.body.otpAuditIncomplete, /permission denied/);
  // a one company run does not count as the nightly run
  w.ops.tables.loyalty_otp_audit_runs = [{ ran_at: new Date(Date.now() - 30 * 3600000).toISOString(), ok: true, errors: [], skipped: 0, company_id: null, fix: true }];
  w.ops.tables.loyalty_otp_audit_runs.unshift({ ran_at: nowIso, ok: true, errors: [], skipped: 0, company_id: CO, fix: true });
  r = await ask();
  assert.match(r.body.otpAuditStale, /last ran 30 hours ago/);
  // not installed (before 20261022b): said, for the morning, never a 503
  const from0 = w.ops.from;
  w.ops.from = (table) => {
    if (!String(table).startsWith('loyalty_otp_')) return from0(table);
    const miss = { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
    const q = new Proxy({}, { get: (_t, k) => (k === 'then' ? (res, rej) => Promise.resolve(miss).then(res, rej) : () => q) });
    return q;
  };
  r = await ask();
  assert.equal(r.status, 200);
  assert.match(r.body.otpAuditStale, /not installed: database update 20261022b/);
  // any other failure of these two reads: still 200, said as "could not be read"
  w.ops.from = (table) => {
    if (!String(table).startsWith('loyalty_otp_')) return from0(table);
    const bad = { data: null, error: { code: '42501', message: 'permission denied for table' } };
    const q = new Proxy({}, { get: (_t, k) => (k === 'then' ? (res, rej) => Promise.resolve(bad).then(res, rej) : () => q) });
    return q;
  };
  r = await ask();
  assert.equal(r.status, 200);
  assert.match(r.body.otpAuditStale, /could not be read: permission denied/);
});
