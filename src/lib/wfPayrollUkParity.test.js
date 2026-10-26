// src/lib/wfPayrollUkParity.test.js
//
// v5.11.101 PROOF: a UK venue's payroll is byte for byte what 5.11.100 gave, run through the REAL code
// of both versions, never hand written expected figures.
//
//   * The 5.11.100 code is kept verbatim in src/lib/fixtures/main_5_11_100/ (WfPayroll.jsx and
//     workforce-compute/index.ts as main had them at af734b80). The first test pins each file to its git
//     blob id, so the fixtures cannot drift from what main shipped.
//   * workforce-compute: both handlers are loaded (TypeScript compiled by rolldown, the Supabase client
//     and Deno replaced by an in memory database) and asked for payroll.period at a GBP venue with no
//     premiums. The staff lines and totals must be identical (5.11.101 adds only a region note).
//   * WfPayroll: both components render on the server (a crash at first render, like reading `run`
//     before its useState, fails here), and with the same run each one's Export CSV (BACS) is called:
//     the two files must be identical, character for character.
//
// Needs rolldown (vite's compiler, installed with the app); without it the tests say so and skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const REPO = new URL('../../', import.meta.url);
const at = (p) => new URL(p, REPO);
const FIX = at('src/lib/fixtures/main_5_11_100/');
const MAIN_PAYROLL = new URL('WfPayroll.jsx.txt', FIX);
const MAIN_COMPUTE = new URL('workforce-compute.index.ts.txt', FIX);
// Where the fixtures pretend to live, so their relative imports resolve as they did on main.
const V_PAYROLL = at('src/backoffice/sections/workforce/__main_WfPayroll.jsx').href;
const V_COMPUTE = at('supabase/functions/workforce-compute/__main_index.ts').href;
const NEW_PAYROLL = at('src/backoffice/sections/workforce/WfPayroll.jsx').href;
const NEW_COMPUTE = at('supabase/functions/workforce-compute/index.ts').href;

const blobId = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

test('the 5.11.100 fixtures are main\'s files verbatim (git blob ids at af734b80)', () => {
  assert.equal(blobId(fs.readFileSync(MAIN_PAYROLL)), 'd05662d5bfbabfdf540c01804be8867a872f4bb7');
  assert.equal(blobId(fs.readFileSync(MAIN_COMPUTE)), 'e1b0007c397986c2e0b20898f16d0e5f1fb7e877');
});

// ── the loader ────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }
const SKIP = transformSync ? false : 'rolldown is not installed here, so the JSX and TypeScript cannot be compiled';

const SRC = at('src/').href;
const FN = at('supabase/functions/').href;
const VIRTUAL = new Map([[V_PAYROLL, () => fs.readFileSync(MAIN_PAYROLL, 'utf8')], [V_COMPUTE, () => fs.readFileSync(MAIN_COMPUTE, 'utf8')]]);
const STUBS = {
  'stub:supabase-js': 'export const createClient = () => globalThis.__fakeClient;',
  'stub:second-step': 'export const secondStepRefusal = async () => null;',
  'stub:wfData': `export const loadPayrollRuns = async () => [];
export const invokeCompute = async () => ({ ok: true, mock: true });`,
  'stub:supabase': 'export const supabase = null; export const isMock = true; export const staffSupabase = null; export const platformSupabase = null;',
  // React for a component called directly (not rendered): useState hands out the planned values in
  // call order, so the `run` a real Run payroll would set is there, and every closure is real.
  'stub:react-state': `import * as R from 'react';
export const Fragment = R.Fragment;
export const useState = (init) => globalThis.__state(init);
export const useMemo = (f) => f();
export const useEffect = () => {};
export const useCallback = (f) => f;
export const useRef = (v) => ({ current: v });`,
};
const isFile = (u) => { try { return fs.statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
const PAYROLL_FILES = new Set([V_PAYROLL, NEW_PAYROLL]);

if (transformSync) {
  registerHooks({
    resolve(specifier, context, next) {
      const parent = String(context.parentURL || '').split('?')[0];
      const fromCode = parent.startsWith(SRC) || parent.startsWith(FN);
      if (specifier.startsWith('https://esm.sh/@supabase/supabase-js')) return { url: 'stub:supabase-js', shortCircuit: true };
      if (STUBS[specifier] || VIRTUAL.has(specifier.split('?')[0])) return { url: specifier, shortCircuit: true };
      if (specifier === 'react' && PAYROLL_FILES.has(parent) && String(context.parentURL).includes('?state')) return { url: 'stub:react-state', shortCircuit: true };
      if (fromCode && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        const base = new URL(specifier, parent);
        const rel = base.href;
        if (rel.endsWith('/_shared/second-step.ts')) return { url: 'stub:second-step', shortCircuit: true };
        for (const ext of ['', '.js', '.jsx', '/index.js']) {
          const u = rel + ext;
          if (u === `${SRC}staff/wfData.js` || u === `${SRC}staff/wfData`) return { url: 'stub:wfData', shortCircuit: true };
          if (u === `${SRC}lib/supabase.js`) return { url: 'stub:supabase', shortCircuit: true };
          if (isFile(new URL(u))) return { url: u, shortCircuit: true };
        }
      }
      // A stub's own imports (react) resolve from here.
      if (parent.startsWith('stub:')) return next(specifier, { ...context, parentURL: import.meta.url });
      return next(specifier, context);
    },
    load(url, context, next) {
      if (STUBS[url]) return { format: 'module', source: STUBS[url], shortCircuit: true };
      const plain = url.split('?')[0];
      const virt = VIRTUAL.get(plain);
      if (virt || ((plain.startsWith(SRC) || plain.startsWith(FN)) && /\.(jsx?|ts)$/.test(plain))) {
        let text = virt ? virt() : fs.readFileSync(fileURLToPath(plain), 'utf8');
        text = text.replace(/import\.meta\.env/g, '({})');
        if (plain.endsWith('.jsx') || plain.endsWith('.ts')) {
          const out = transformSync(fileURLToPath(plain), text, plain.endsWith('.jsx') ? { jsx: { runtime: 'automatic' } } : { lang: 'ts' });
          if (out.errors?.length) throw new Error(`${plain}: ${out.errors.map((e) => e.message).join('; ')}`);
          text = out.code;
        }
        return { format: 'module', source: text, shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

// ── an in memory database with the query shapes workforce-compute uses ────────
const asTime = (v) => { const s = String(v); return /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`) : null; };
const cmp = (a, b) => { const x = asTime(a), y = asTime(b); if (x != null && y != null) return x - y; return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; };
class Q {
  constructor(db, t) { Object.assign(this, { db, t, f: [], op: 'select', one: null, ord: [], lim: null, payload: null }); }
  select() { return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.f.push((r) => String(r[c]) !== String(v)); return this; }
  in(c, vs) { const s = vs.map(String); this.f.push((r) => s.includes(String(r[c]))); return this; }
  gte(c, v) { this.f.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  gt(c, v) { this.f.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  lte(c, v) { this.f.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  not(c, op, v) {
    if (op === 'is') this.f.push((r) => (r[c] ?? null) !== v);
    if (op === 'in') { const s = String(v).replace(/[()]/g, '').split(','); this.f.push((r) => !s.includes(String(r[c]))); }
    return this;
  }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  single() { this.one = 'one'; return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  run() {
    const rows = (this.db[this.t] ||= []);
    if (this.op === 'insert') {
      const add = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r, i) => ({ id: `${this.t}-${rows.length + i + 1}`, created_at: '2026-10-24T12:00:00Z', ...r }));
      rows.push(...add);
      return { data: this.one ? add[0] : add, error: null };
    }
    let hit = rows.filter((r) => this.f.every((f) => f(r)));
    if (this.op === 'update') { hit.forEach((r) => Object.assign(r, this.payload)); return { data: hit, error: null }; }
    if (this.op === 'delete') { this.db[this.t] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    for (const [c, asc] of [...this.ord].reverse()) hit = [...hit].sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c]));
    if (this.lim != null) hit = hit.slice(0, this.lim);
    hit = hit.map((r) => ({ ...r }));
    if (this.one) return { data: hit[0] ?? null, error: this.one === 'one' && !hit.length ? { message: 'no rows' } : null };
    return { data: hit, error: null };
  }
}
// One client for every loaded handler (they keep the one createClient gave them); it reads the
// database the current call set.
const FAKE_CLIENT = {
  auth: { getUser: async () => ({ data: { user: { id: 'boss', is_anonymous: false } } }) },
  from: (t) => new Q(globalThis.__db, t),
  rpc: async () => ({ data: null, error: null }),
};

const L = 'loc-leeds', ORG = 'org-1';
function ukDb() {
  return {
    locations: [{ id: L, org_id: ORG, currency: 'GBP', timezone: 'Europe/London' }],
    user_locations: [{ user_id: 'boss', location_id: L }],
    user_profiles: [{ id: 'boss', role: 'owner' }],
    wf_venue_settings: [{ location_id: L, settings: { tipMode: 'hybrid', directPct: 40, tipAllocator: 'troncmaster', troncmasterName: 'Jo T' }, premiums: {} }],
    wf_staff: [
      { id: 's1', location_id: L, name: 'Amy Bar', pos_user_id: 'p1', role_key: 'bar' },
      { id: 's2', location_id: L, name: 'Ben Kitchen Cook', pos_user_id: 'p2', role_key: 'chef' },
      { id: 's3', location_id: L, name: 'Cat', pos_user_id: null, role_key: 'bar' },
    ],
    wf_roles: [{ location_id: L, key: 'bar', premium_eligible: true }, { location_id: L, key: 'chef', premium_eligible: true }],
    wf_timesheets: [
      { id: 't1', location_id: L, staff_id: 's1', status: 'approved', clock_in: '2026-10-03T16:00:00+00:00', clock_out: '2026-10-03T23:30:00+00:00', actual_hours: 7.17, effective_rate: 12.21, rate_source: 'base', paid_break_mins: 0, pay_amount: 87.55 },
      { id: 't2', location_id: L, staff_id: 's1', status: 'paid', clock_in: '2026-10-11T09:00:00+00:00', clock_out: '2026-10-11T17:00:00+00:00', actual_hours: 7.5, effective_rate: 12.21, rate_source: 'base', paid_break_mins: 30, pay_amount: 97.68 },
      { id: 't3', location_id: L, staff_id: 's2', status: 'approved', clock_in: '2026-10-18T22:00:00+00:00', clock_out: '2026-10-19T06:00:00+00:00', actual_hours: 7.67, effective_rate: 14.5, rate_source: 'override', paid_break_mins: 0, pay_amount: 111.22 },
      { id: 't4', location_id: L, staff_id: 's3', status: 'approved', clock_in: '2026-10-25T10:00:00+00:00', clock_out: '2026-10-25T14:15:00+00:00', actual_hours: 4.25, effective_rate: 11.44, rate_source: 'base', paid_break_mins: 0, pay_amount: 48.62 },
      { id: 't5', location_id: L, staff_id: 's3', status: 'pending', clock_in: '2026-11-03T10:00:00+00:00', clock_out: '2026-11-03T14:00:00+00:00', actual_hours: 4, effective_rate: 11.44, paid_break_mins: 0 },
    ],
    wf_tronc_runs: [{ id: 'r1', location_id: L, week_start: '2026-10-05', status: 'run', pool: 120, total_paid: 120 }, { id: 'r0', location_id: L, week_start: '2026-10-12', status: 'draft', pool: 50, total_paid: 50 }],
    wf_tronc_lines: [{ run_id: 'r1', staff_id: 's1', payout: 70.33 }, { run_id: 'r1', staff_id: 's2', payout: 49.67 }, { run_id: 'r0', staff_id: 's3', payout: 50 }],
    closed_checks: [
      { location_id: L, tip: 5, staff_id: 'p1', server: 'Amy', status: 'closed', closed_at: '2026-10-04T13:00:00+00:00' },
      { location_id: L, tip: 3.33, staff_id: null, server: 'ben kitchen cook', status: 'closed', closed_at: '2026-10-09T13:00:00+00:00' },
      { location_id: L, tip: 2, staff_id: null, server: 'Nobody', status: 'closed', closed_at: '2026-10-10T13:00:00+00:00' },
      { location_id: L, tip: 9, staff_id: 'p1', server: 'Amy', status: 'voided', closed_at: '2026-10-10T13:00:00+00:00' },
    ],
    wf_time_off: [{ location_id: L, staff_id: 's2', status: 'approved', paid: true, start_date: '2026-10-29', end_date: '2026-11-02', days: 5, deducted_hours: 37.5, pay_rate: 14.5 }],
    wf_payroll_runs: [],
    wf_audit: [],
  };
}

const HANDLERS = new Map();
async function payrollPeriod(handlerUrl, db, body) {
  globalThis.__db = db;
  if (!HANDLERS.has(handlerUrl)) {
    globalThis.__fakeClient = FAKE_CLIENT;
    globalThis.__handler = null;
    globalThis.Deno = { env: { get: () => '' }, serve: (h) => { globalThis.__handler = h; } };
    await import(handlerUrl);
    assert.ok(globalThis.__handler, `${handlerUrl} registered a handler`);
    HANDLERS.set(handlerUrl, globalThis.__handler);
  }
  const handler = HANDLERS.get(handlerUrl);
  const res = await handler(new Request('http://x/', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return res.json();
}

let mainRun = null, newRun = null;
test('workforce-compute payroll.period, UK venue, no premiums: 5.11.101 gives 5.11.100\'s lines and totals exactly', { skip: SKIP }, async () => {
  const body = { action: 'payroll.period', location_id: L, from: '2026-10-01', to: '2026-10-31' };
  mainRun = await payrollPeriod(V_COMPUTE, ukDb(), body);
  newRun = await payrollPeriod(NEW_COMPUTE, ukDb(), body);
  assert.equal(mainRun.ok, true, JSON.stringify(mainRun));
  assert.ok(mainRun.staff.length >= 3, 'the fixture pays three people');
  const { region, ...rest } = newRun;
  assert.deepEqual(region, { country: 'UK', currency: 'GBP', overtimeWeeklyHours: null, payrollExport: 'bacs' });
  assert.deepEqual(rest, mainRun, 'every figure, line and note as 5.11.100');
  assert.equal(JSON.stringify(newRun.staff), JSON.stringify(mainRun.staff), 'the stored lines byte for byte (no new keys on a UK line)');
});

const PROPS = {
  ctx: { locationId: L, orgId: ORG },
  staff: [
    { id: 's1', name: 'Amy Bar', niNumber: 'QQ123456C', bankSortCode: '12-34-56', bankAccount: '12345678', bankAccountName: 'Amy Bar' },
    { id: 's2', name: 'Ben Kitchen Cook', niNumber: '', bankSortCode: '65-43-21', bankMasked: '****9876' },
    { id: 's3', name: '=cmd|evil', bankSortCode: null },
  ],
  roles: { list: [], map: {} },
  sections: [],
  settings: { currency: 'GBP', payPeriodType: 'monthly', payPeriodStartDay: 1, settings: {} },
  week: null,
  showToast: () => {},
};

test('WfPayroll renders on the server for a UK venue, and its first screen is 5.11.100\'s exactly', { skip: SKIP }, async () => {
  try { globalThis.localStorage?.removeItem?.('rpos-active-currency'); } catch { /* none */ }
  const Main = (await import(V_PAYROLL)).default;
  const New = (await import(NEW_PAYROLL)).default;
  const a = renderToStaticMarkup(createElement(Main, PROPS));
  const b = renderToStaticMarkup(createElement(New, PROPS)); // throws on a crash at first render (a value read before it exists)
  assert.match(b, /Run payroll/);
  assert.equal(b, a);
});

function exportFrom(Component, run) {
  // The planned values for useState in call order: period, run, computing, closing, history.
  const plan = [undefined, run, false, false, []];
  let i = 0;
  globalThis.__state = (init) => { const k = i++; const v = plan[k] !== undefined ? plan[k] : (typeof init === 'function' ? init() : init); return [v, () => {}]; };
  const tree = Component(PROPS);
  let onExport = null;
  const text = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children));
  const walk = (n) => {
    if (!n || onExport) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== 'object') return;
    if (n.props?.onClick && /Export CSV/.test(text(n.props.children))) { onExport = n.props.onClick; return; }
    walk(n.props?.children);
  };
  walk(tree);
  assert.ok(onExport, 'the Export CSV button is on the screen');
  let csv = null;
  const saved = { Blob: globalThis.Blob, document: globalThis.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  globalThis.Blob = class { constructor(parts) { csv = parts.join(''); } };
  globalThis.document = { createElement: () => ({ click() {} }) };
  URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
  try { onExport(); } finally {
    globalThis.Blob = saved.Blob; globalThis.document = saved.document; URL.createObjectURL = saved.createObjectURL; URL.revokeObjectURL = saved.revokeObjectURL;
  }
  return csv;
}

test('WfPayroll Export CSV (BACS), UK venue, no premiums: 5.11.101 writes 5.11.100\'s file exactly', { skip: SKIP }, async () => {
  if (!newRun) newRun = await payrollPeriod(NEW_COMPUTE, ukDb(), { action: 'payroll.period', location_id: L, from: '2026-10-01', to: '2026-10-31' });
  const MainS = (await import(`${V_PAYROLL}?state`)).default;
  const NewS = (await import(`${NEW_PAYROLL}?state`)).default;
  const a = exportFrom(MainS, newRun);
  const b = exportFrom(NewS, newRun);
  assert.match(a, /^"First name","Surname","NI number"/);
  assert.match(a, /"Tronc tips \(PAYE, no NIC - independent troncmaster\)"/);
  assert.match(a, /"'=cmd\|evil"/, 'the formula guard is there');
  assert.equal(b, a);
});

test('workforce-compute payroll.period, US venue: venue days, whole work weeks for overtime, the evening shift of the last day', { skip: SKIP }, async () => {
  const U = 'loc-sm';
  const ts = (id, day, hh, hrs) => ({ id, location_id: U, staff_id: 'u1', status: 'approved', clock_in: `2026-10-${day}T${hh}:00:00+00:00`, clock_out: null, actual_hours: hrs, effective_rate: 20, rate_source: 'base', paid_break_mins: 0 });
  const db = () => ({
    locations: [{ id: U, org_id: ORG, currency: 'USD', timezone: 'America/Los_Angeles' }],
    user_locations: [{ user_id: 'boss', location_id: U }], user_profiles: [{ id: 'boss', role: 'owner' }],
    wf_venue_settings: [{ location_id: U, settings: { tipMode: 'pool' }, premiums: {} }],
    wf_staff: [{ id: 'u1', location_id: U, name: 'Sam', role_key: 'bar' }], wf_roles: [],
    // Mon 12 to Thu 15 Oct: 10h a day at 9am San Mateo (16:00 UTC); Fri 16 and Sat 17: 8h. Thu 15 also
    // has an evening shift at 6pm San Mateo, which is 01:00 UTC on the 16th (it is the 15th's).
    wf_timesheets: [ts('a', '12', '16', 10), ts('b', '13', '16', 10), ts('c', '14', '16', 10), ts('d', '15', '16', 6), ts('e', '16', '01', 4), ts('f', '16', '16', 8), ts('g', '17', '16', 8)],
    wf_tronc_runs: [], wf_tronc_lines: [], closed_checks: [], wf_time_off: [], wf_payroll_runs: [], wf_audit: [],
  });
  const first = await payrollPeriod(NEW_COMPUTE, db(), { action: 'payroll.period', location_id: U, from: '2026-10-01', to: '2026-10-15' });
  const second = await payrollPeriod(NEW_COMPUTE, db(), { action: 'payroll.period', location_id: U, from: '2026-10-16', to: '2026-10-31' });
  const a = first.staff.find((x) => x.staff_id === 'u1');
  const b = second.staff.find((x) => x.staff_id === 'u1');
  assert.equal(a.hours, 40, 'the 6pm shift of the 15th is in the 1st to 15th');
  assert.deepEqual([a.regular_hours, a.overtime_hours], [40, 0]);
  assert.equal(b.hours, 16);
  assert.deepEqual([b.regular_hours, b.overtime_hours], [0, 16], 'the week is counted whole: the 16th and 17th are overtime');
  assert.equal(second.region.payrollExport, 'us_payroll');
});

test('premiums: payroll\'s base plus premium is exactly the pay_amount the one rule writes (so reports, which read pay_amount, agree)', { skip: SKIP }, async () => {
  const { sheetPay } = await import('../../supabase/functions/_shared/payPremiums.js');
  const db = ukDb();
  db.wf_venue_settings[0].premiums = { weekend: 10, night: 25, nightFrom: '23:00', nightTo: '06:00' };
  db.closed_checks = []; db.wf_tronc_runs = []; db.wf_tronc_lines = []; db.wf_time_off = [];
  const res = await payrollPeriod(NEW_COMPUTE, db, { action: 'payroll.period', location_id: L, from: '2026-10-01', to: '2026-10-31' });
  for (const line of res.staff) {
    const mine = db.wf_timesheets.filter((t) => t.staff_id === line.staff_id && ['approved', 'paid'].includes(t.status));
    const written = mine.reduce((a, t) => a + sheetPay({ clockIn: t.clock_in, clockOut: t.clock_out, actualHours: t.actual_hours, paidBreakMins: t.paid_break_mins,
      rate: t.effective_rate, rateSource: t.rate_source, premiums: db.wf_venue_settings[0].premiums, tz: 'Europe/London', country: 'UK' }).pay, 0);
    assert.equal(Math.round((line.pay + line.premium_pay) * 100) / 100, Math.round(written * 100) / 100, line.staff_id);
  }
  assert.ok(res.totals.premium_pay > 0, 'the fixture has weekend and night hours');
});
