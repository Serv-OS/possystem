/**
 * bookingRemindersFn.test.js: the booking-reminders edge function driven end to end in node
 * (16 Oct 2026). It sends real texts and emails to guests, so the ledger rules are proven here:
 * a reminder goes once, a failed send is tried at most 3 times, a number that can never work is
 * not retried, a change or cancel is told once, and before migration 20261016c nothing new runs.
 *
 * The Deno file is imported directly (node strips the types). Its npm: and esm.sh imports are
 * mapped to small stubs, Deno.serve hands over the handler, fetch is stubbed, and the clock is
 * mocked so the day before and 2 hours before windows are exact.
 */

import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('npm:@supabase/supabase-js') || spec.startsWith('https://esm.sh/@supabase/supabase-js')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__mkClient(...a);', shortCircuit: true };
    }
    if (spec.startsWith('https://esm.sh/hash-wasm')) {
      return { url: 'data:text/javascript,export const argon2id = () => null; export const argon2Verify = () => false;', shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const ENV = {
  SUPABASE_URL: 'http://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service',
  PLATFORM_SUPABASE_URL: 'http://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'p',
  RECEIPT_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'rk', CUSTOMER_ROOT: 'serv-os.app',
};

// ── a small fake PostgREST ────────────────────────────────────────────────────
const state = { ops: null, platform: null, v1: false, sms: [], emails: [], smsReply: () => ({ status: 200, body: { ok: true } }) };
function fakeDb(tables, { name }) {
  const uniques = { booking_reminders: ['booking_id', 'kind', 'channel'] };
  return {
    tables,
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'no function' } }),
    from(table) {
      const st = { op: 'select', cols: '', filters: [], patch: null, rows: null, single: false, limitN: null, range: null, conflict: null, wantRows: false };
      const run = () => {
        const list = tables[table] || (tables[table] = []);
        if (name === 'ops' && table === 'booking_reminders' && state.v1) {
          const cols = `${st.cols} ${JSON.stringify(st.rows || st.patch || {})}`;
          if (/status|attempts|detail|next_try_at|last_error/.test(cols)) return { data: null, error: { code: '42703', message: 'column booking_reminders.status does not exist' } };
        }
        if (st.op === 'insert' || st.op === 'upsert') {
          const out = [];
          for (const r of st.rows) {
            const keys = uniques[table];
            const clash = keys && list.find((x) => keys.every((k) => String(x[k]) === String(r[k])));
            if (clash && st.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            if (clash) { Object.assign(clash, r); out.push({ ...clash }); continue; }
            const row = { id: `${table}-${list.length + 1}`, sent_at: new Date().toISOString(), status: 'sent', attempts: 1, ...r };
            list.push(row); out.push({ ...row });
          }
          return st.single ? { data: out[0] || null, error: null } : { data: out, error: null };
        }
        let hits = list.filter((row) => st.filters.every((f) => f(row)));
        if (st.op === 'update') hits.forEach((row) => Object.assign(row, st.patch));
        if (st.op === 'delete') { tables[table] = list.filter((row) => !hits.includes(row)); }
        if (st.range) hits = hits.slice(st.range[0], st.range[1] + 1);
        if (st.limitN != null) hits = hits.slice(0, st.limitN);
        if (st.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      const cmp = (c, fn) => { st.filters.push((row) => fn(row[c])); return b; };
      const b = {
        select(cols = '') { st.cols = cols; st.wantRows = true; return b; },
        update(p) { st.op = 'update'; st.patch = p; return b; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return b; },
        upsert(r, o) { st.op = 'upsert'; st.rows = Array.isArray(r) ? r : [r]; st.conflict = o; return b; },
        delete() { st.op = 'delete'; return b; },
        eq: (c, v) => cmp(c, (x) => String(x) === String(v)),
        neq: (c, v) => cmp(c, (x) => String(x) !== String(v)),
        in: (c, vs) => cmp(c, (x) => (vs || []).map(String).includes(String(x))),
        not: (c, op, v) => cmp(c, (x) => (op === 'is' && v === null ? x !== null && x !== undefined : true)),
        gte: (c, v) => cmp(c, (x) => String(x) >= String(v)),
        lte: (c, v) => cmp(c, (x) => x != null && String(x) <= String(v)),
        lt: (c, v) => cmp(c, (x) => Number(x) < Number(v)),
        order() { return b; },
        limit(n) { st.limitN = n; return b; },
        range(a, z) { st.range = [a, z]; return b; },
        maybeSingle() { st.single = true; return b; },
        single() { st.single = true; return b; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return b;
    },
  };
}

let handler;
before(async () => {
  globalThis.__mkClient = (url) => (String(url).includes('platform') ? fakeDb(state.platform, { name: 'platform' }) : fakeDb(state.ops, { name: 'ops' }));
  // The clients are made at import: point them at live objects the tests refill.
  state.ops = {}; state.platform = {};
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init?.body || '{}');
    if (u.includes('/functions/v1/send-sms')) {
      state.sms.push(body);
      const r = state.smsReply(body);
      return { ok: r.status < 300, status: r.status, json: async () => r.body };
    }
    if (u.includes('api.resend.com')) { state.emails.push(body); return { ok: true, status: 200, json: async () => ({}) }; }
    throw new Error(`unexpected fetch ${u}`);
  };
  await import('../../../supabase/functions/booking-reminders/index.ts');
});

const fill = (target, src) => { for (const k of Object.keys(target)) delete target[k]; Object.assign(target, src); };
function seed({ bookings = [], reminders = [], rules = {}, v1 = false } = {}) {
  state.v1 = v1; state.sms = []; state.emails = []; state.smsReply = () => ({ status: 200, body: { ok: true } });
  fill(state.ops, {
    bookings: bookings.map((b) => ({ ...b })),
    booking_reminders: reminders.map((r, i) => ({ id: `seed-${i}`, location_id: LOC, status: 'sent', attempts: 1, ...r })),
    booking_rules: [{ location_id: LOC, cancellation_window_hours: 24, guest_phone: '01484 000000', ...rules }],
    locations: [{ id: LOC, name: 'Provo', timezone: 'Europe/London', currency: 'GBP', address: '9 New Street, Huddersfield', receipt_branding: null }],
    booking_payments: [], packages: [], booking_preorders: [],
  });
  fill(state.platform, {
    locations: [{ id: 'plat-1', ops_location_id: LOC, online_slug: 'provo', company_id: 'co-1' }],
    message_templates: [],
  });
}
const call = async (body) => {
  const res = await handler(new Request('http://fn.test', { method: 'POST', body: JSON.stringify(body) }));
  return res.json();
};
const bk = (over = {}) => ({
  id: 'bk-1', location_id: LOC, booking_date: '2026-10-17', start_time: '19:00:00', turn_minutes: 90, covers: 2,
  status: 'confirmed', source: 'widget', created_at: '2026-10-01T10:00:00Z', package_id: null, preorder_token: null,
  manage_token: 'f'.repeat(64), customer: { name: 'Sam Jones', phone: '+447700900001' }, ...over,
});
const ledger = () => state.ops.booking_reminders;

beforeEach(() => { mock.timers.reset(); });
const at = (iso) => { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: new Date(iso) }); };

test('the day before reminder goes once, with the manage link, the phone and no long dashes', async () => {
  at('2026-10-16T11:00:00Z');   // 12:00 in London, the day before
  seed({ bookings: [bk()] });
  const r = await call({ action: 'send_due' });
  assert.equal(r.ledger, 'v2');
  assert.equal(state.sms.length, 1);
  const text = state.sms[0].message;
  assert.match(text, /^Provo: see you tomorrow at 19:00, table for 2\./);
  assert.match(text, /Change or cancel: https:\/\/provo\.serv-os\.app\/book\?manage=f{64}/);
  assert.match(text, /Call us on 01484 000000\./);
  assert.doesNotMatch(text, /[\u2013\u2014]|\{\{/);
  assert.equal(state.sms[0].reference_id, 'bk-1');
  assert.equal(state.sms[0].type, 'booking_reminder');
  const row = ledger().find((x) => x.kind === 'reminder_day');
  assert.equal(row.status, 'sent');
  assert.deepEqual(row.detail, { date: '2026-10-17', time: '19:00', covers: 2 });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1, 'never twice');
});

test('a failed text is tried 3 times, 10 then 30 minutes apart, then left with its reason', async () => {
  at('2026-10-16T11:00:00Z');
  seed({ bookings: [bk()] });
  state.smsReply = () => ({ status: 502, body: { error: 'SMS send failed: Twilio is down' } });
  await call({ action: 'send_due' });
  let row = ledger().find((x) => x.kind === 'reminder_day');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /Twilio is down/);
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1, 'not before 10 minutes');
  at('2026-10-16T11:11:00Z');
  await call({ action: 'send_due' });
  row = ledger().find((x) => x.kind === 'reminder_day');
  assert.equal(state.sms.length, 2);
  assert.equal(row.attempts, 2);
  at('2026-10-16T11:42:00Z');
  await call({ action: 'send_due' });
  row = ledger().find((x) => x.kind === 'reminder_day');
  assert.equal(state.sms.length, 3);
  assert.equal(row.attempts, 3);
  assert.equal(row.next_try_at, null);
  at('2026-10-16T14:00:00Z');
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 3, 'stops after 3');
});

test('a number that can never work is not retried', async () => {
  at('2026-10-16T11:00:00Z');
  seed({ bookings: [bk()] });
  state.smsReply = () => ({ status: 502, body: { error: 'The To number is not a valid phone number. (21211)' } });
  await call({ action: 'send_due' });
  at('2026-10-16T13:00:00Z');
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  assert.equal(ledger().find((x) => x.kind === 'reminder_day').attempts, 3);
});

test('2 hours before: the on the day reminder', async () => {
  at('2026-10-17T16:15:00Z');   // 17:15 London, booking 19:00
  seed({ bookings: [bk()], reminders: [{ booking_id: 'bk-1', kind: 'reminder_day', channel: 'sms' }] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  assert.match(state.sms[0].message, /see you today at 19:00/);
});

test('a change made by the team is told once; a change back says nothing', async () => {
  at('2026-10-14T11:00:00Z');
  const told = { booking_id: 'bk-1', kind: 'confirmation', channel: 'sms', detail: { date: '2026-10-17', time: '19:00', covers: 2 }, sent_at: '2026-10-01T10:00:00Z' };
  seed({ bookings: [bk({ start_time: '19:30:00' })], reminders: [told] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  assert.match(state.sms[0].message, /your booking is now Saturday 17 October at 19:30, table for 2/);
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  // Edited back to what the guest was first told: nothing more.
  seed({ bookings: [bk()], reminders: [told] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
});

test('a cancel by the team is told, but never a duplicate clean up or a guest never told', async () => {
  at('2026-10-14T11:00:00Z');
  const conf = { booking_id: 'bk-1', kind: 'confirmation', channel: 'sms', detail: { date: '2026-10-17', time: '19:00', covers: 2 } };
  seed({ bookings: [bk({ status: 'cancelled', cancelled_at: '2026-10-14T10:30:00Z', cancel_reason: 'Guest phoned' })], reminders: [conf] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  assert.match(state.sms[0].message, /is cancelled/);
  assert.doesNotMatch(state.sms[0].message, /manage=/);
  seed({ bookings: [bk({ status: 'cancelled', cancelled_at: '2026-10-14T10:30:00Z', cancel_reason: 'Duplicate' })], reminders: [conf] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
  seed({ bookings: [bk({ status: 'cancelled', cancelled_at: '2026-10-14T10:30:00Z' })] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
});

test('the confirmation backstop: a till booking made 20 minutes ago that never had one', async () => {
  at('2026-10-14T11:00:00Z');
  seed({ bookings: [bk({ source: 'pos', created_at: '2026-10-14T10:40:00Z', customer: { name: 'Sam', phone: '+447700900001', email: 'sam@example.com' } })] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
  assert.match(state.sms[0].message, /table for 2 booked on Saturday 17 October at 19:00/);
  assert.equal(state.emails.length, 1);
  assert.match(state.emails[0].html, /<a href="https:\/\/provo\.serv-os\.app\/book\?manage=/);
  assert.match(state.emails[0].html, /calendar\.google\.com/);
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 1);
});

test('the venue switch and walk ins: nothing sent', async () => {
  at('2026-10-16T11:00:00Z');
  seed({ bookings: [bk()], rules: { guest_messages_enabled: false } });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
  seed({ bookings: [bk({ source: 'walk_in' })] });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
  const r = await call({ action: 'confirm', booking_id: 'bk-1' });
  assert.equal(r.error, 'walk_in');
});

test('before migration 20261016c: no reminders, confirmations still once', async () => {
  at('2026-10-16T11:00:00Z');
  seed({ bookings: [bk()], v1: true });
  const r = await call({ action: 'send_due' });
  assert.equal(r.ledger, 'v1_before_migration_20261016c');
  assert.equal(state.sms.length, 0);
  const c = await call({ action: 'confirm', booking_id: 'bk-1' });
  assert.equal(c.results.sms.sent, true);
  const again = await call({ action: 'confirm', booking_id: 'bk-1' });
  assert.equal(again.results.sms.reason, 'already_sent_(ledger)');
  assert.equal(state.sms.length, 1);
  const n = await call({ action: 'notify', booking_id: 'bk-1', kind: 'changed' });
  assert.equal(n.error, 'needs_migration_20261016c');
});

test('notify: the guest\'s own change is told once, the money line comes from the ledger', async () => {
  at('2026-10-14T11:00:00Z');
  const conf = { booking_id: 'bk-1', kind: 'confirmation', channel: 'sms', detail: { date: '2026-10-17', time: '19:00', covers: 2 } };
  seed({ bookings: [bk({ start_time: '20:00:00' })], reminders: [conf] });
  const a = await call({ action: 'notify', booking_id: 'bk-1', kind: 'changed' });
  assert.equal(a.results.sms.sent, true);
  const b = await call({ action: 'notify', booking_id: 'bk-1', kind: 'changed' });
  assert.equal(b.results.sms.reason, 'nothing_changed');
  assert.equal(state.sms.length, 1);

  seed({ bookings: [bk({ status: 'cancelled', cancelled_at: '2026-10-14T10:59:00Z' })], reminders: [conf] });
  state.ops.booking_payments.push({ booking_id: 'bk-1', kind: 'prepay', amount: 120, currency: 'gbp', status: 'needs_refund' });
  await call({ action: 'notify', booking_id: 'bk-1', kind: 'cancelled' });
  assert.match(state.sms[0].message, /The £120 you paid will be refunded by the venue\./);
  await call({ action: 'notify', booking_id: 'bk-1', kind: 'cancelled' });
  assert.equal(state.sms.length, 1);
});

test('a template switched off in Message templates is not sent', async () => {
  at('2026-10-16T11:00:00Z');
  seed({ bookings: [bk()] });
  state.platform.message_templates.push({ company_id: 'co-1', message_type: 'booking_reminder', channel: 'sms', enabled: false, body_text: 'x' });
  await call({ action: 'send_due' });
  assert.equal(state.sms.length, 0);
});
