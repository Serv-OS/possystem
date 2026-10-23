// src/lib/stock/xeroStockJournal.test.js
//
// 5.11.100 (multi site stock Drop 4b, contract 4): the closing stock journal to Xero. The pure rules
// (_shared/xeroStockJournal.js) and the xero-stock-journal function as it ships, with a stand in database
// and a stand in Xero. The journal is ALWAYS a DRAFT: never POSTED, never AUTHORISED.
// Run: node --test src/lib/stock/xeroStockJournal.test.js (npm test runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import {
  scopesOk, suggestAccounts, accountList, journalBody, journalKey, journalStatus, statusWords, sendRefusal, needsReconnect, journalIdOf,
  JOURNAL_STATUS, STATUS_WORDS,
} from '../../../supabase/functions/_shared/xeroStockJournal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FN = path.join(ROOT, 'supabase/functions/xero-stock-journal/index.ts');
const SHARED = path.join(ROOT, 'supabase/functions/_shared/xeroStockJournal.js');
const DASH = /[\u2013\u2014]/;

const ACCOUNTS = [
  { Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' },
  { Code: '310', Name: 'Cost of Goods Sold', Type: 'DIRECTCOSTS', Status: 'ACTIVE' },
  { Code: '320', Name: 'Closing stock', Type: 'DIRECTCOSTS', Status: 'ARCHIVED' },
  { Code: '330', Name: 'Stock movement', Type: 'DIRECTCOSTS', Status: 'ACTIVE' },
  { Code: '629', Name: 'Old stock', Type: 'INVENTORY', Status: 'ARCHIVED' },
  { Code: '630', Name: 'Inventory', Type: 'INVENTORY', Status: 'ACTIVE' },
  { Name: 'No code', Type: 'INVENTORY', Status: 'ACTIVE' },
];

test('scopes: manual journals must be granted', () => {
  assert.equal(scopesOk('openid profile accounting.invoices accounting.manualjournals offline_access'), true);
  assert.equal(scopesOk('openid accounting.invoices accounting.transactions'), false);
  assert.equal(scopesOk(''), false);
  assert.equal(scopesOk(null), false);
  assert.equal(scopesOk(['accounting.manualjournals']), true);
});

test('suggested accounts: the active inventory account and a stock movement style direct cost', () => {
  assert.deepEqual(suggestAccounts(ACCOUNTS), { stockAccount: '630', movementAccount: '330' });
  assert.deepEqual(suggestAccounts(ACCOUNTS.filter((a) => a.Code !== '330')), { stockAccount: '630', movementAccount: '310' });
  assert.deepEqual(suggestAccounts([{ Code: '1', Name: 'Wages', Type: 'EXPENSE' }]), { stockAccount: null, movementAccount: null });
  assert.deepEqual(suggestAccounts(null), { stockAccount: null, movementAccount: null });
  const list = accountList(ACCOUNTS);
  assert.ok(list.every((a) => a.code));
  assert.ok(!list.some((a) => a.code === '629' || a.code === '320'), 'archived accounts are left out');
});

test('the journal body: one DRAFT, two lines that balance, a rise is a debit on stock', () => {
  const b = journalBody({ amount: 123.456, date: '2026-10-31', narration: 'Closing stock 31 Oct 2026, ServOS (2 sites)', stockAccount: '630', movementAccount: '330' });
  const j = b.ManualJournals[0];
  assert.equal(j.Status, 'DRAFT');
  assert.equal(JOURNAL_STATUS, 'DRAFT');
  assert.equal(j.Date, '2026-10-31');
  assert.equal(j.LineAmountTypes, 'NoTax');
  assert.deepEqual(j.JournalLines.map((l) => [l.AccountCode, l.LineAmount]), [['630', 123.46], ['330', -123.46]]);
  assert.equal(j.JournalLines.reduce((s, l) => s + l.LineAmount, 0), 0);
  const fall = journalBody({ amount: -50, date: '2026-10-31', stockAccount: '630', movementAccount: '330' }).ManualJournals[0];
  assert.deepEqual(fall.JournalLines.map((l) => l.LineAmount), [-50, 50]);
  assert.throws(() => journalBody({ amount: 0, date: '2026-10-31', stockAccount: '630', movementAccount: '330' }), /No change in stock/);
  assert.throws(() => journalBody({ amount: 5, date: '2026-10-31', stockAccount: '630' }), /Pick the stock account/);
  assert.throws(() => journalBody({ amount: 5, date: '2026-10-31', stockAccount: '630', movementAccount: '630' }), /must be different/);
  assert.throws(() => journalBody({ amount: 5, date: 'Oct', stockAccount: '630', movementAccount: '330' }), /last day of the month/);
  assert.equal(journalKey('o1', '2026-10-01', 't1', { stockAccount: '630', movementAccount: '310', amount: 12.345 }), 'sj:t1:2026-10-01:630:310:12.35:o1');
  assert.notEqual(journalKey('o1', '2026-10-01', 't1', { stockAccount: '630', movementAccount: '310', amount: 5 }),
    journalKey('o1', '2026-10-01', 't1', { stockAccount: '631', movementAccount: '310', amount: 5 }), 'a send with other accounts never reuses a failed send\'s key');
  assert.ok(journalKey('8f2b6c1e-0000-4000-8000-000000000000', '2026-10-01', '97f1ee8c-c7a0-471d-93e8-576ab0977faa', { stockAccount: '6300', movementAccount: '3100', amount: 123456.78 }).length <= 128);
  assert.equal(journalIdOf({ ManualJournals: [{ ManualJournalID: 'mj-1' }] }), 'mj-1');
  assert.equal(journalIdOf({}), null);
  assert.equal(needsReconnect({ status: 403 }), true);
  assert.equal(needsReconnect({ status: 401 }), true);
  assert.equal(needsReconnect({ status: 500 }), false);
});

test('status and refusals, in the screen words', () => {
  const ready = { tenant_id: 't1', legal_company: 'North Ltd', connection_location_id: 'L1', scopes_ok: true, locked_all: true, amount: 12.5, already: null };
  assert.deepEqual(journalStatus(ready), { status: 'ready', words: STATUS_WORDS.ready });
  assert.equal(journalStatus({ ...ready, scopes_ok: false }).words, 'Reconnect Xero to allow stock journals.');
  assert.equal(journalStatus({ ...ready, connection_location_id: null }).status, 'not_connected');
  assert.equal(journalStatus({ ...ready, tenant_id: null }).status, 'not_connected');
  assert.equal(journalStatus({ ...ready, locked_all: false }).words, 'Lock the month at every site of North Ltd first.');
  assert.equal(journalStatus({ ...ready, already: { xero_journal_id: 'mj' } }).status, 'sent');
  assert.equal(journalStatus(null).status, 'not_connected');
  assert.equal(sendRefusal(ready, { stockAccount: '630', movementAccount: '330' }), null);
  assert.equal(sendRefusal(ready, { stockAccount: '630' }), STATUS_WORDS.accounts);
  assert.equal(sendRefusal({ ...ready, amount: 0 }, { stockAccount: '630', movementAccount: '330' }), STATUS_WORDS.nothing);
  assert.equal(sendRefusal({ ...ready, already: { xero_journal_id: 'mj' } }, { stockAccount: '630', movementAccount: '330' }), 'This month was already sent to Xero.');
  assert.equal(statusWords('not_locked', 'North Ltd'), 'Lock the month at every site of North Ltd first.');
  for (const w of Object.values(STATUS_WORDS)) { assert.doesNotMatch(w, DASH); assert.doesNotMatch(w, /!/); }
});

test('the function text: DRAFT only, never POSTED or AUTHORISED, the marker, the deploy line, no dash', () => {
  const src = fs.readFileSync(FN, 'utf8');
  const shared = fs.readFileSync(SHARED, 'utf8');
  for (const t of [src, shared]) {
    assert.doesNotMatch(t, /['"]POSTED['"]/);
    assert.doesNotMatch(t, /['"]AUTHORISED['"]/);
    assert.doesNotMatch(t, DASH);
  }
  assert.match(shared, /JOURNAL_STATUS = 'DRAFT'/);
  assert.match(shared, /Status: JOURNAL_STATUS/);
  assert.match(src, /\/\/ MARKER 5\.11\.100 xero-stock-journal draft only/);
  assert.match(src, /npx supabase functions deploy xero-stock-journal --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt/);
  assert.match(src, /secondStepRefusal\(req\)/);
  assert.match(src, /idempotencyKey: journalKey\(/);
  assert.doesNotMatch(src, /cron\.schedule|x-cron-key/, 'a person presses Send: no cron');
});

// -- the function as it ships ---------------------------------------------------------------------
const ENV = { SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', SUPABASE_ANON_KEY: 'anon-key', XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'sec' };

function stand({ legal, user = { id: 'u1', email: 'boss@example.test' }, journals = [] }) {
  const log = [];
  const tables = {
    xero_connections: [{ location_id: 'L1', tenant_id: 't1', tenant_name: 'North Ltd', access_token: 'xat', refresh_token: 'xrt', expires_at: new Date(Date.now() + 3600e3).toISOString(), scopes: 'accounting.manualjournals' }],
    stock_month_end_journals: journals,
  };
  const from = (table) => {
    const st = { filters: [] };
    const run = () => (tables[table] || []).filter((r) => st.filters.every(([k, v]) => r[k] === v));
    const q = {
      select: () => q, order: () => q, limit: () => q, neq: () => q, update: () => q,
      eq: (k, v) => { st.filters.push([k, v]); return q; },
      maybeSingle: async () => ({ data: run()[0] || null, error: null }),
      then: (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return q;
  };
  const make = (key, opts) => ({
    from,
    auth: { getUser: async (t) => ({ data: { user: t === 'user-token' ? user : null } }) },
    rpc: async (name, args) => {
      log.push({ rpc: name, args, as: key === 'anon-key' ? `user:${opts?.global?.headers?.Authorization}` : 'service' });
      if (name === 'stock_month_end_journal') return { data: { legal: [legal] }, error: null };
      if (name === 'stock_month_end_journal_record') return { data: { ok: true }, error: null };
      return { data: null, error: { message: 'no' } };
    },
  });
  return { log, make };
}

async function loadFn(st) {
  let src = fs.readFileSync(FN, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = (u, k, o) => globalThis.__xsj.make(k, o);');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(FN), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/);
  const out = path.join(os.tmpdir(), `xsj-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  globalThis.__xsj = st;
  let handler = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  return handler;
}
const post = (h, body, token = 'user-token') => h(new Request('https://ops.test/functions/v1/xero-stock-journal', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}));
const BODY = { orgId: '11111111-1111-4111-8111-111111111111', from: '2026-10-01', to: '2026-10-31', tenantId: 't1' };
const LEGAL = { tenant_id: 't1', legal_company: 'North Ltd', connection_location_id: 'L1', scopes_ok: true, locked_all: true, amount: 245.1, narration: 'Closing stock 31 Oct 2026, ServOS (2 sites)', already: null };

test('xero-stock-journal: no login refused; preview reads accounts; send puts ONE DRAFT journal and records it', async () => {
  const st = stand({ legal: LEGAL });
  const h = await loadFn(st);
  assert.equal((await post(h, { ...BODY, action: 'preview' }, null)).status, 401);
  assert.equal((await post(h, { ...BODY, action: 'preview' }, 'svc-key')).status, 401, 'the service role is not a person');
  assert.equal((await post(h, { ...BODY, action: 'preview' }, 'stranger')).status, 401);
  const fetch0 = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/Accounts')) return new Response(JSON.stringify({ Accounts: ACCOUNTS }), { status: 200 });
    if (String(url).endsWith('/ManualJournals')) return new Response(JSON.stringify({ ManualJournals: [{ ManualJournalID: 'mj-9', Status: 'DRAFT' }] }), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  try {
    const pv = await (await post(h, { ...BODY, action: 'preview' })).json();
    assert.equal(pv.status, 'ready');
    assert.deepEqual(pv.suggested, { stockAccount: '630', movementAccount: '330' });
    assert.equal(pv.amount, 245.1);
    assert.equal(st.log[0].as, 'user:Bearer user-token', 'the month is asked as the login, so the database decides who may');
    const miss = await (await post(h, { ...BODY, action: 'send', stockAccount: '630' })).json();
    assert.equal(miss.ok, false);
    assert.equal(miss.error, STATUS_WORDS.accounts);
    const s = await (await post(h, { ...BODY, action: 'send', stockAccount: '630', movementAccount: '330' })).json();
    assert.deepEqual(s, { ok: true, status: 'sent', xero_journal_id: 'mj-9' });
  } finally { globalThis.fetch = fetch0; }
  const mj = calls.filter((c) => c.url.endsWith('/ManualJournals'));
  assert.equal(mj.length, 1);
  assert.equal(mj[0].method, 'PUT');
  assert.equal(mj[0].body.ManualJournals[0].Status, 'DRAFT');
  assert.equal(mj[0].headers['xero-tenant-id'], 't1');
  assert.equal(mj[0].headers['Idempotency-Key'], 'sj:t1:2026-10-01:630:330:245.10:11111111');
  const rec = st.log.find((x) => x.rpc === 'stock_month_end_journal_record');
  assert.equal(rec.as, 'service');
  assert.equal(rec.args.p_patch.status, 'sent');
  assert.equal(rec.args.p_patch.xero_journal_id, 'mj-9');
  assert.equal(rec.args.p_patch.stock_account, '630');
});

test('xero-stock-journal: not locked, not connected, missing scope and a Xero 403 never send', async () => {
  const fetch0 = globalThis.fetch;
  let journals = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/ManualJournals')) { journals++; return new Response('{"Message":"forbidden"}', { status: 403 }); }
    if (String(url).endsWith('/Accounts')) return new Response('{"Message":"forbidden"}', { status: 403 });
    return new Response('nope', { status: 404 });
  };
  try {
    const locked = await (await post(await loadFn(stand({ legal: { ...LEGAL, locked_all: false } })), { ...BODY, action: 'send', stockAccount: '630', movementAccount: '330' })).json();
    assert.equal(locked.error, 'Lock the month at every site of North Ltd first.');
    const scope = await (await post(await loadFn(stand({ legal: { ...LEGAL, scopes_ok: false } })), { ...BODY, action: 'preview' })).json();
    assert.equal(scope.status, 'needs_reconnect');
    assert.equal(scope.words, 'Reconnect Xero to allow stock journals.');
    const none = await (await post(await loadFn(stand({ legal: { ...LEGAL, connection_location_id: null } })), { ...BODY, action: 'send', stockAccount: '630', movementAccount: '330' })).json();
    assert.equal(none.error, 'Connect this legal company to Xero first.');
    const pv403 = await (await post(await loadFn(stand({ legal: LEGAL })), { ...BODY, action: 'preview' })).json();
    assert.equal(pv403.status, 'needs_reconnect');
    assert.equal(journals, 0);
    const st = stand({ legal: LEGAL });
    const s403 = await (await post(await loadFn(st), { ...BODY, action: 'send', stockAccount: '630', movementAccount: '330' })).json();
    assert.deepEqual(s403, { ok: false, status: 'needs_reconnect', error: 'Reconnect Xero to allow stock journals.' });
    assert.equal(st.log.find((x) => x.rpc === 'stock_month_end_journal_record').args.p_patch.status, 'failed');
    const sent = await (await post(await loadFn(stand({ legal: { ...LEGAL, already: { xero_journal_id: 'mj-1' } } })), { ...BODY, action: 'send', stockAccount: '630', movementAccount: '330' })).json();
    assert.equal(sent.error, 'This month was already sent to Xero.');
    const bad = await post(await loadFn(stand({ legal: LEGAL })), { ...BODY, action: 'send', from: 'x' });
    assert.equal(bad.status, 400);
  } finally { globalThis.fetch = fetch0; }
});
