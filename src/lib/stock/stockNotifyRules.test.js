// node --test: what each stock alert says and where it goes (supabase/functions/_shared/stockNotifyRules.js,
// multi site stock Drop 3, contract 3.5, map 4.23). Synthetic names, numbers and addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_KINDS, isNotifyKind, channelsOf, audienceOf, severityOf, dayShort, moneyWords, wordsOf, refIdOf, bellRow,
  toE164, smsText, emailOf, planSend, sendable, outcomeOf, cronAccess, sendJobStep, SEND_JOB_MAX_ATTEMPTS,
} from '../../../supabase/functions/_shared/stockNotifyRules.js';

const DASH = /[\u2013\u2014]/;

test('the twelve kinds are the ledger CHECK list (contract 1.2 stock_notify_sent)', () => {
  assert.deepEqual([...NOTIFY_KINDS], ['order_by', 'approval_wait', 'approval_60', 'approval_30', 'sent_unapproved', 'price_rise', 'invoice_unplaced', 'count_due', 'count_missed', 'count_second_approval', 'transfer_waiting', 'delivery_overdue']);
  assert.equal(isNotifyKind('order_by'), true);
  assert.equal(isNotifyKind('weekly'), false);
  assert.equal(isNotifyKind(null), false);
});

test('channels follow the map 4.23 table: bell always, SMS only at 30 minutes, email for five kinds', () => {
  const sms = NOTIFY_KINDS.filter((k) => channelsOf(k).sms);
  const email = NOTIFY_KINDS.filter((k) => channelsOf(k).email);
  const needNow = NOTIFY_KINDS.filter((k) => channelsOf(k).needNow);
  assert.deepEqual(sms, ['approval_30']);
  assert.deepEqual(email, ['order_by', 'sent_unapproved', 'price_rise', 'invoice_unplaced', 'count_missed']);
  assert.deepEqual(needNow, ['order_by', 'approval_wait', 'approval_60', 'approval_30', 'count_due', 'count_missed', 'transfer_waiting', 'delivery_overdue']);
  assert.ok(NOTIFY_KINDS.every((k) => channelsOf(k).bell));
  assert.deepEqual(channelsOf('nope'), { bell: false, sms: false, email: false, needNow: false });
  assert.equal(audienceOf('approval_wait'), 'approvers');
  assert.equal(audienceOf('count_second_approval'), 'company_editors');
  assert.equal(audienceOf('x'), null);
  assert.equal(severityOf('approval_30'), 'warn');
  assert.equal(severityOf('count_due'), 'info');
  assert.equal(severityOf('x'), 'info');
});

test('days and money in words', () => {
  assert.equal(dayShort('2026-10-22'), 'Thu 22 Oct');
  assert.equal(dayShort('2026-10-22T10:00:00Z'), 'Thu 22 Oct');
  assert.equal(dayShort(''), '');
  assert.equal(moneyWords(800), '£800');
  assert.equal(moneyWords(1234.5), '£1,234.50');
  assert.equal(moneyWords(12, '$'), '$12');
  assert.equal(moneyWords(null), '');
  assert.equal(moneyWords('x'), '');
});

test('every kind has plain words with no dash, and a staged title wins', () => {
  const p = { site_name: 'North', supplier_name: 'Bakers', amount: 950, limit: 800, raised_by_name: 'Sam', order_by_hm: '14:00', delivery_day: '2026-10-22', item_name: 'Milk', pct: 7.25, plan_name: 'Full count', due_by: '10:00:00', reference: 'TR-1', from_name: 'Kitchen', from_email: 'bills@example.test' };
  for (const k of NOTIFY_KINDS) {
    const w = wordsOf(k, p);
    assert.ok(w.title.length > 3, k);
    assert.doesNotMatch(`${w.title} ${w.body}`, DASH, k);
  }
  assert.deepEqual(wordsOf('order_by', p), { title: 'Order by in 1 hour: Bakers', body: 'North: nothing is ordered for Thu 22 Oct yet. Order by 14:00.' });
  assert.deepEqual(wordsOf('approval_wait', p), { title: 'Order waiting for approval', body: 'North: Bakers £950, raised by Sam. The limit here is £800.' });
  assert.equal(wordsOf('price_rise', p).title, 'Milk rose 7.3% at North');
  assert.equal(wordsOf('count_due', p).body, 'Full count at North by 10:00.');
  assert.equal(wordsOf('sent_unapproved', { ...p, failed: true }).title, 'Could not email Bakers. Phone them.');
  assert.equal(wordsOf('sent_unapproved', { site_name: 'North', failed: true }).body, 'North: the order did not reach the supplier by email.');
  assert.equal(wordsOf('transfer_waiting', { ...p, dispute: true, note: 'two short' }).title, 'Transfer disputed');
  assert.equal(wordsOf('transfer_waiting', { ...p, requested: true }).body, 'Kitchen asks North for stock (TR-1).');
  assert.deepEqual(wordsOf('count_due', { title: 'Own words', body: 'Here' }), { title: 'Own words', body: 'Here' });
  assert.deepEqual(wordsOf('mystery', {}), { title: 'Stock alert', body: '' });
});

test('the bell row: kind stock_<kind>, ref_type stock, ref_id the route and focus', () => {
  assert.equal(refIdOf('invoice_unplaced', {}), 'invoices:inbox');
  assert.equal(refIdOf('approval_wait', { po_id: 'po1' }), 'purchase-orders:po1');
  assert.equal(refIdOf('count_due', {}), 'stock-counts');
  assert.equal(refIdOf('x', {}), null);
  const b = bellRow('delivery_overdue', { supplier_name: 'Bakers', site_name: 'North', expected_date: '2026-10-21' }, 'L1');
  assert.deepEqual(b, { location_id: 'L1', kind: 'stock_delivery_overdue', severity: 'warn', title: 'Delivery overdue', body: 'Bakers at North was due Wed 21 Oct.', ref_type: 'stock', ref_id: 'stock-deliveries', actor_name: 'ServOS stock' });
});

test('numbers, texts and emails', () => {
  assert.equal(toE164('07700 900123'), '+447700900123');
  assert.equal(toE164('447700900123'), '+447700900123');
  assert.equal(toE164('+1 555 0100'), '+15550100');
  assert.equal(toE164(''), '');
  assert.equal(smsText({ title: 'Count due today', body: 'Full count at North.' }), 'ServOS stock: Count due today. Full count at North.');
  assert.ok(smsText({ title: 'x'.repeat(400) }).length <= 320);
  const e = emailOf({ title: 'A <b> rise', body: 'Milk & eggs' });
  assert.equal(e.subject, 'ServOS stock: A <b> rise');
  assert.match(e.html, /A &lt;b&gt; rise/);
  assert.match(e.html, /Milk &amp; eggs/);
});

test('planSend: one text and one email per person, flags respected, bad contacts left out, bell sites deduped', () => {
  const targets = {
    bell: [{ location_id: 'L1' }, { location_id: 'L1' }, { location_id: 'L2' }],
    people: [
      { user_id: 'u1', mobile: '07700 900123', email: 'A@Example.test', sms: true, email_on: true },
      { user_id: 'u2', mobile: '+447700900123', email: 'a@example.test', sms: true, email_on: true },
      { user_id: 'u3', mobile: '12', email: 'not an email', sms: true, email_on: true },
      { user_id: 'u4', mobile: '07700 900999', email: 'c@example.test', sms: false, email_on: false },
    ],
  };
  const thirty = planSend({ kind: 'approval_30', location_id: 'L1', payload: { site_name: 'North', supplier_name: 'Bakers' } }, targets);
  assert.deepEqual(thirty.bell, ['L1', 'L2']);
  assert.deepEqual(thirty.sms.map((s) => s.to), ['+447700900123']);
  assert.equal(thirty.email.length, 0, 'no email at 30 minutes');
  const missed = planSend({ kind: 'count_missed', location_id: 'L1', payload: {} }, targets);
  assert.equal(missed.sms.length, 0);
  assert.deepEqual(missed.email.map((m) => m.to), ['a@example.test']);
  // no bell sites from the database: the row's own site
  assert.deepEqual(planSend({ kind: 'count_due', location_id: 'L9', payload: {} }, { people: [] }).bell, ['L9']);
  assert.deepEqual(planSend({ kind: 'nope', location_id: 'L9' }, targets), { bell: [], sms: [], email: [], words: { title: 'Stock alert', body: '' } });
});

test('never twice: only a waiting row of a known kind is sent; the bell decides sent', () => {
  assert.equal(sendable({ status: 'waiting', kind: 'count_due' }), true);
  assert.equal(sendable({ status: 'sent', kind: 'count_due' }), false);
  assert.equal(sendable({ status: 'waiting', kind: 'weekly' }), false);
  assert.equal(sendable(null), false);
  assert.deepEqual(outcomeOf({ bellIds: ['e1'], smsSent: 1, smsTried: 1 }), { status: 'sent', error: null });
  assert.deepEqual(outcomeOf({ bellIds: ['e1'], emailSent: 1, emailTried: 2 }), { status: 'sent', error: '1 of 2 emails failed' });
  assert.deepEqual(outcomeOf({ bellIds: [] }), { status: 'failed', error: 'the bell did not save' });
});

test('the cron key: service role, the right key, and fail closed', () => {
  assert.equal(cronAccess({ service: true }).ok, true);
  assert.deepEqual(cronAccess({ key: '' }), { ok: false, status: 401, reason: 'no_cron_key' });
  assert.deepEqual(cronAccess({ key: 'k', check: { data: true } }), { ok: true, status: 200, reason: null });
  assert.deepEqual(cronAccess({ key: 'k', check: { data: false } }), { ok: false, status: 401, reason: 'wrong_cron_key' });
  assert.equal(cronAccess({ key: 'k', check: { error: { code: 'PGRST202', message: 'Could not find the function' } } }).status, 503);
  assert.equal(cronAccess({ key: 'k', check: { error: { code: '500', message: 'boom' } } }).reason, 'cron_key_check_failed');
});

test('a send job: sent, tried again, failed after three with the alert staged', () => {
  const now = '2026-10-22T13:00:00Z';
  assert.deepEqual(sendJobStep({ attempts: 0 }, { ok: true }, now), { patch: { status: 'sent', attempts: 1, sent_at: now, last_error: null }, alert: false });
  assert.deepEqual(sendJobStep({ attempts: 0 }, { ok: false, error: 'boom' }, now), { patch: { attempts: 1, last_error: 'boom' }, alert: false });
  assert.deepEqual(sendJobStep({ attempts: SEND_JOB_MAX_ATTEMPTS - 1 }, { ok: false, error: 'boom' }, now), { patch: { status: 'failed', attempts: 3, last_error: 'boom' }, alert: true });
  assert.equal(sendJobStep({ attempts: 0 }, { ok: false, error: 'no email', final: true }, now).patch.status, 'failed');
});

// -- the two senders as they ship (stock-notify, po-cutoff-run), with a stand in database ---------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENV = { SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' };

function fakeDb(tables, rpcs = {}) {
  const log = [];
  let n = 0;
  const from = (table) => {
    const st = { filters: [], op: 'select', payload: null, limit: null };
    const match = (r) => st.filters.every(([k, v, op]) => (op === 'lte' ? r[k] == null || String(r[k]) <= String(v) : r[k] === v));
    const run = (single) => {
      const rows = tables[table] || (tables[table] = []);
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: p.id || `${table}-${++n}`, ...p }));
        rows.push(...list);
        log.push({ table, insert: st.payload });
        return { data: single ? list[0] : list, error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, st.payload);
        log.push({ table, update: st.payload, n: hit.length });
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const got = rows.filter(match).slice(0, st.limit ?? 1000);
      return { data: single ? got[0] || null : got, error: null };
    };
    const q = {
      select: () => q, order: () => q, limit: (k) => { st.limit = k; return q; },
      eq: (k, v) => { st.filters.push([k, v]); return q; },
      lte: (k, v) => { st.filters.push([k, v, 'lte']); return q; },
      insert: (p) => { st.op = 'insert'; st.payload = p; return q; },
      update: (p) => { st.op = 'update'; st.payload = p; return q; },
      maybeSingle: async () => run(true), single: async () => run(true),
      then: (res, rej) => Promise.resolve(run(false)).then(res, rej),
    };
    return q;
  };
  return { log, tables, from, rpc: async (name, args) => { log.push({ rpc: name, args }); return rpcs[name] ? rpcs[name](args) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }; } };
}

async function loadFn(fn, db) {
  const file = path.join(ROOT, 'supabase/functions', fn, 'index.ts');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = () => globalThis.__notifyDb;');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(file), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/, fn);
  const out = path.join(os.tmpdir(), `notify-${fn}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  globalThis.__notifyDb = db;
  let handler = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  return handler;
}
const call = (h, headers = {}) => h(new Request('https://ops.test/functions/v1/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }));

test('stock-notify: a wrong key is refused; a waiting row rings the bell, texts and emails once, then is sent', async () => {
  const db = fakeDb({
    stock_notify_sent: [{ id: 1, org_id: 'o1', location_id: 'L1', kind: 'approval_30', ref: 'po1', payload: { site_name: 'North', supplier_name: 'Bakers', po_id: 'po1' }, status: 'waiting', attempts: 0 },
      { id: 2, org_id: 'o1', location_id: 'L1', kind: 'count_due', ref: 'p:L1:d', payload: {}, status: 'sent', attempts: 1 }],
    activity_events: [],
  }, {
    stock_notify_cron_ok: ({ p_key }) => ({ data: p_key === 'right', error: null }),
    stock_notify_targets: () => ({ data: { bell: [{ location_id: 'L1' }], people: [{ user_id: 'u1', mobile: '07700 900123', email: 'a@example.test', sms: true, email_on: true }] }, error: null }),
  });
  const handler = await loadFn('stock-notify', db);
  assert.equal((await call(handler, { 'x-cron-key': 'wrong' })).status, 401);
  assert.equal((await call(handler)).status, 401);
  const fetch0 = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const r = await call(handler, { 'x-cron-key': 'right' });
    assert.deepEqual(await r.json(), { ok: true, sent: 1, failed: 0 });
    // again: nothing waits, nothing is sent twice
    assert.deepEqual(await (await call(handler, { 'x-cron-key': 'right' })).json(), { ok: true, sent: 0, failed: 0 });
  } finally { globalThis.fetch = fetch0; }
  assert.equal(db.tables.activity_events.length, 1);
  assert.equal(db.tables.activity_events[0].kind, 'stock_approval_30');
  assert.equal(db.tables.activity_events[0].ref_id, 'purchase-orders:po1');
  assert.deepEqual(sent.map((x) => x.url), ['https://ops.test/functions/v1/send-sms'], 'SMS only at 30 minutes');
  assert.equal(sent[0].body.to, '+447700900123');
  const row = db.tables.stock_notify_sent[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.bell_event_id, db.tables.activity_events[0].id);
  assert.equal(row.attempts, 1);
});

test('po-cutoff-run: sends each waiting job once; three failures leave it failed and stage the phone them alert', async () => {
  const db = fakeDb({
    stock_po_send_jobs: [{ id: 7, po_id: 'po9', location_id: 'L1', why: 'sent_unapproved', status: 'waiting', attempts: 2, created_at: '2026-10-22T13:00:00Z' }],
    purchase_orders: [], po_lines: [], locations: [{ id: 'L1', org_id: 'o1', name: 'North' }], stock_notify_sent: [],
  }, { po_cutoff_cron_ok: ({ p_key }) => ({ data: p_key === 'right', error: null }) });
  const handler = await loadFn('po-cutoff-run', db);
  assert.equal((await call(handler, { 'x-cron-key': 'nope' })).status, 401);
  const r = await call(handler, { 'x-cron-key': 'right' });
  assert.deepEqual(await r.json(), { ok: true, sent: 0, failed: 1 });
  const job = db.tables.stock_po_send_jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 3);
  assert.equal(job.last_error, 'PO not found');
  assert.equal(db.tables.stock_notify_sent.length, 1);
  const alert = db.tables.stock_notify_sent[0];
  assert.equal(alert.kind, 'sent_unapproved');
  assert.equal(alert.ref, 'po9:email_failed');
  assert.match(alert.payload.title, /^Could not email the supplier\. Phone them\.$/);
});

test('po-cutoff-run: an approved order waits two minutes for the screen, then is sent only while still DRAFT', async () => {
  const later = new Date(Date.now() + 120000).toISOString();
  const db = fakeDb({
    stock_po_send_jobs: [
      { id: 8, po_id: 'poA', location_id: 'L1', why: 'approved', status: 'waiting', attempts: 0, created_at: '2026-10-22T13:00:00Z', not_before: later },
      { id: 9, po_id: 'poB', location_id: 'L1', why: 'approved', status: 'waiting', attempts: 0, created_at: '2026-10-22T13:00:01Z', not_before: '2026-10-22T13:02:01Z' },
    ],
    purchase_orders: [{ id: 'poB', location_id: 'L1', supplier_id: 'S1', status: 'SENT', reference: 'PO-B' }],
    po_lines: [{ id: 'l1', po_id: 'poB', location_id: 'L1', qty_packs: 1, unit_price: 2 }], locations: [{ id: 'L1', org_id: 'o1', name: 'North' }], stock_notify_sent: [],
  }, { po_cutoff_cron_ok: ({ p_key }) => ({ data: p_key === 'right', error: null }) });
  const handler = await loadFn('po-cutoff-run', db);
  const r = await call(handler, { 'x-cron-key': 'right' });
  assert.deepEqual(await r.json(), { ok: true, sent: 1, failed: 0 });
  const [a, b] = db.tables.stock_po_send_jobs;
  assert.equal(a.status, 'waiting', 'not before its time');
  assert.equal(a.attempts, 0);
  assert.equal(b.status, 'sent', 'the screen sent it already: done, no second email');
  assert.equal(db.tables.stock_notify_sent.length, 0);
  assert.equal(db.log.some((x) => x.table === 'purchase_orders' && x.update), false, 'the order is not touched');
});

// -- map 8.4 step 13: a price rise alert opens Price changes on that row --------------------------
import { focusText, parseRefId, normFocus, boLink, readBoLink, priceRowFocused, routeOf } from '../../../supabase/functions/_shared/stockNotifyRules.js';
import { readFileSync } from 'node:fs';

const MIG = readFileSync(new URL('../../../supabase/migrations/20261027a_OPS_stock_native_3.sql', import.meta.url), 'utf8');

test('the database writes the focus each screen reads (contract 3.2): price rise and the invoice inbox', () => {
  assert.match(MIG, /'focus', jsonb_build_object\('tab', 'supplier', 'supplierItemId', v_l\.supplier_item_id, 'locationId', p_location_id\)/);
  assert.match(MIG, /'invoices', jsonb_build_object\('tab', 'inbox'\)/);
  assert.match(MIG, /'route', 'invoices', 'focus', jsonb_build_object\('tab', 'inbox'\)/);
  assert.doesNotMatch(MIG, /to_jsonb\('inbox'::text\)/);
});

test('a Needs attention price rise row, followed, focuses that row on Supplier prices', () => {
  // the row as stock_needs_attention answers it (the alert payload's focus copied through)
  const row = { kind: 'price_rise', location_id: 'L2', route: 'price-changes', focus: { tab: 'supplier', supplierItemId: 'SI1', locationId: 'L2' } };
  const open = normFocus(row.route, row.focus);
  assert.deepEqual(open, { tab: 'supplier', supplierItemId: 'SI1', locationId: 'L2' });
  assert.equal(priceRowFocused(open, { supplier_item_id: 'SI1', location_id: 'L2' }), true);
  assert.equal(priceRowFocused(open, { supplier_item_id: 'SI1', location_id: 'L1' }), false, 'the same item at another site');
  assert.equal(priceRowFocused(open, { supplier_item_id: 'SI9', location_id: 'L2' }), false);
  // a focus written in the database's own words still lands on the row
  assert.equal(priceRowFocused({ supplier_item_id: 'SI1', location_id: 'L2' }, { supplier_item_id: 'SI1', location_id: 'L2' }), true);
  assert.equal(priceRowFocused(null, { supplier_item_id: 'SI1' }), false);
  // the inbox: a bare word or the record both open the Inbox tab
  assert.deepEqual(normFocus('invoices', 'inbox'), { tab: 'inbox' });
  assert.deepEqual(normFocus('invoices', { tab: 'inbox' }), { tab: 'inbox' });
});

test('the bell row and the email link carry the route and the focus, and the Back Office reads them back', () => {
  const payload = { focus: { tab: 'supplier', supplierItemId: 'SI1', locationId: 'L2' }, item_name: 'Milk', pct: 7.5 };
  const ref = refIdOf('price_rise', payload);
  assert.equal(ref, `price-changes:${JSON.stringify(payload.focus)}`);
  assert.deepEqual(parseRefId(ref), { route: 'price-changes', focus: payload.focus });
  assert.deepEqual(parseRefId('invoices:inbox'), { route: 'invoices', focus: 'inbox' });
  assert.deepEqual(parseRefId('stock-counts'), { route: 'stock-counts', focus: null });
  assert.equal(parseRefId('not a route'), null);
  const link = boLink('https://app.example.test/', 'price-changes', payload.focus);
  assert.equal(link, `https://app.example.test/?mode=office&go=price-changes&open=${encodeURIComponent(focusText(payload.focus))}`);
  assert.deepEqual(readBoLink(new URL(link).search), { route: 'price-changes', focus: payload.focus });
  assert.equal(readBoLink('?mode=office'), null);
  assert.equal(readBoLink('?go=../x'), null);
  const plan = planSend({ kind: 'price_rise', location_id: 'L2', payload }, { people: [{ email: 'boss@example.test' }] }, { origin: 'https://app.example.test' });
  assert.equal(plan.email.length, 1);
  assert.ok(plan.email[0].html.includes(`href="${link.replace(/&/g, '&amp;')}"`), plan.email[0].html);
  assert.equal(routeOf('price_rise'), 'price-changes');
  const noLink = planSend({ kind: 'price_rise', location_id: 'L2', payload }, { people: [{ email: 'boss@example.test' }] });
  assert.doesNotMatch(noLink.email[0].html, /href=/, 'no origin: no link');
});
