// src/lib/stock/stockNotifyWeekly.test.js
//
// 5.11.100 (multi site stock Drop 4b, contract 5): the weekly email kind of stock-notify. The pure rules
// (weeklyEmail, planSend, outcomeOf) and the sender as it ships, with a stand in database.
// Run: node --test src/lib/stock/stockNotifyWeekly.test.js (npm test runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { weeklyEmail, planSend, outcomeOf, wordsOf, channelsOf, bellRow } from '../../../supabase/functions/_shared/stockNotifyRules.js';

const DASH = /[\u2013\u2014]/;
const LEAGUE = {
  rows: [
    { location_id: 'A', site: 'North', currency: 'GBP', sales_net: 1840.5, gp_pct_theo: 74.12, gp_pct_actual: 72.8, gap_pct: 1.3, waste_pct: 1.9, purchases: 488, budget: 510, budget_spent: 480, stock_value_now: 3210, last_full_count_words: 'Mon 13 Oct, on time' },
    { location_id: 'B', site: 'South <Bar>', currency: 'GBP', sales_net: 910, gp_pct_theo: 73, gp_pct_actual: null, gap_pct: 3.1, waste_pct: 2.8, purchases: 264, budget: null, stock_value_now: 2050, last_full_count_words: 'Missed' },
  ],
  totals: [
    { location_id: 'A', site: 'North', sales_net: 1840.5 }, { location_id: 'B', site: 'South <Bar>', sales_net: 910 },
    { location_id: null, site: 'Company', currency: 'GBP', sales_net: 2750.5, purchases: 752, stock_value_now: 5260 },
  ],
};
const PAYLOAD = { kind: 'weekly', week_start: '2026-10-12', week_end: '2026-10-18', org_id: 'o1', site_ids: ['A', 'B'], count_in: { A: true, B: false }, currency_symbol: '£', title: 'Weekly stock: week of Mon 12 Oct' };

test('weekly: email only, plain words with no dash', () => {
  assert.deepEqual(channelsOf('weekly'), { bell: false, sms: false, email: true, needNow: false });
  const w = wordsOf('weekly', { week_start: '2026-10-12' });
  assert.equal(w.title, 'Weekly stock: week of Mon 12 Oct');
  assert.doesNotMatch(`${w.title} ${w.body}`, DASH);
  assert.equal(wordsOf('weekly', { week_start: '2026-10-12', site_name: 'North' }).body, "North: last week's stock and GP.");
});

test('weeklyEmail, company row: every site, the company line, Count not in, values escaped', () => {
  const m = weeklyEmail({ payload: PAYLOAD, league: LEAGUE, origin: 'https://app.example.test' });
  assert.equal(m.subject, 'ServOS stock: Weekly stock: week of Mon 12 Oct');
  assert.match(m.html, />North</);
  assert.match(m.html, /South &lt;Bar&gt;/);
  assert.doesNotMatch(m.html, /<Bar>/);
  assert.match(m.html, /Company \(GBP\)/);
  assert.match(m.html, /£1,840\.50/);
  assert.match(m.html, /74\.1%/);
  assert.match(m.html, /£480 of £510/);
  assert.match(m.html, /No budget/);
  assert.match(m.html, /Count not in at South &lt;Bar&gt;\./);
  assert.match(m.html, /Mon 13 Oct, on time/);
  assert.match(m.html, /Mon 12 Oct to Sun 18 Oct/);
  assert.match(m.html, /go=stock-gp/);
  assert.doesNotMatch(m.html, DASH);
  assert.doesNotMatch(`${m.subject}${m.html}`, /!/);
});

test('weeklyEmail, site row: that site only, no company line', () => {
  const m = weeklyEmail({ payload: { ...PAYLOAD, location_id: 'B', site_name: 'South <Bar>' }, league: LEAGUE });
  assert.doesNotMatch(m.html, />North</);
  assert.doesNotMatch(m.html, /Company \(GBP\)/);
  assert.match(m.html, /Count not in/);
  const none = weeklyEmail({ payload: PAYLOAD, league: null });
  assert.match(none.html, /No stock figures for this week\./);
  const usd = weeklyEmail({ payload: { ...PAYLOAD, currency_symbol: '$' }, league: LEAGUE });
  assert.match(usd.html, /\$1,840\.50/);
});

test('planSend: weekly emails each person once with no bell; outcome by the emails', () => {
  const targets = { bell: [], people: [{ email: 'Boss@Example.test', email_on: true, mobile: '07700 900123', sms: true }, { email: 'boss@harness-mail.co.uk' }, { email: 'off@harness-mail.co.uk', email_on: false }, { email: 'nope' }] };
  const plan = planSend({ kind: 'weekly', location_id: null, payload: PAYLOAD }, targets, { league: LEAGUE, origin: 'https://app.example.test' });
  assert.deepEqual(plan.bell, []);
  assert.deepEqual(plan.sms, []);
  assert.deepEqual(plan.email.map((e) => e.to), ['boss@harness-mail.co.uk']);
  assert.match(plan.email[0].html, /South &lt;Bar&gt;/);
  const site = planSend({ kind: 'weekly', location_id: 'A', payload: { ...PAYLOAD, site_name: 'North' } }, targets, { league: LEAGUE });
  assert.doesNotMatch(site.email[0].html, /South/);
  assert.deepEqual(outcomeOf({ emailOnly: true, emailSent: 1, emailTried: 1 }), { status: 'sent', error: null });
  assert.deepEqual(outcomeOf({ emailOnly: true, emailSent: 1, emailTried: 2 }), { status: 'sent', error: '1 of 2 emails failed' });
  assert.deepEqual(outcomeOf({ emailOnly: true, emailSent: 0, emailTried: 2 }), { status: 'failed', error: '2 of 2 emails failed' });
  assert.deepEqual(outcomeOf({ emailOnly: true }), { status: 'skipped', error: 'nobody to email' });
  // every other kind unchanged: the bell still decides
  assert.deepEqual(outcomeOf({ bellIds: [], emailSent: 1, emailTried: 1 }), { status: 'failed', error: 'the bell did not save' });
  assert.equal(bellRow('weekly', PAYLOAD, 'A').ref_id, 'stock-gp');
});

// -- the sender as it ships ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENV = { SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' };

function fakeDb(tables, rpcs = {}) {
  const log = [];
  let n = 0;
  const from = (table) => {
    const st = { filters: [], op: 'select', payload: null, limit: null };
    const match = (r) => st.filters.every(([k, v]) => r[k] === v);
    const run = (single) => {
      const rows = tables[table] || (tables[table] = []);
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: p.id || `${table}-${++n}`, ...p }));
        rows.push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, st.payload);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const got = rows.filter(match).slice(0, st.limit ?? 1000);
      return { data: single ? got[0] || null : got, error: null };
    };
    const q = {
      select: () => q, order: () => q, limit: (k) => { st.limit = k; return q; },
      eq: (k, v) => { st.filters.push([k, v]); return q; },
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
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = () => globalThis.__weeklyDb;');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(file), rel)).href}'`);
  const out = path.join(os.tmpdir(), `weekly-${fn}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  globalThis.__weeklyDb = db;
  let handler = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  return handler;
}
const call = (h) => h(new Request('https://ops.test/functions/v1/stock-notify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer svc-key' } }));

test('stock-notify: a weekly row asks the league for its week, emails once, rings no bell, is sent; a failing league is tried again', async () => {
  const db = fakeDb({
    stock_notify_sent: [
      { id: 1, org_id: 'o1', location_id: null, kind: 'weekly', ref: 'o1:2026-10-12', payload: PAYLOAD, status: 'waiting', attempts: 0 },
      { id: 2, org_id: 'o1', location_id: 'B', kind: 'weekly', ref: 'B:2026-10-12', payload: { ...PAYLOAD, site_name: 'South' }, status: 'waiting', attempts: 0 },
    ],
    activity_events: [],
  }, {
    stock_notify_targets: ({ p_id }) => ({ data: { bell: [], people: p_id === 1 ? [{ email: 'boss@harness-mail.co.uk', email_on: true }] : [] }, error: null }),
    stock_report_league: (args) => ({ data: LEAGUE, error: null, args }),
  });
  const handler = await loadFn('stock-notify', db);
  const fetch0 = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    assert.deepEqual(await (await call(handler)).json(), { ok: true, sent: 1, failed: 0 });
    assert.deepEqual(await (await call(handler)).json(), { ok: true, sent: 0, failed: 0 }, 'never twice');
  } finally { globalThis.fetch = fetch0; }
  const league = db.log.filter((x) => x.rpc === 'stock_report_league').map((x) => x.args);
  assert.deepEqual(league[0], { p_org: 'o1', p_sites: ['A', 'B'], p_from: '2026-10-12', p_to: '2026-10-18', p_opts: null, p_after: null, p_limit: 1000 });
  assert.deepEqual(league[1].p_sites, ['B'], 'a site row asks for its own site');
  assert.equal(db.tables.activity_events.length, 0, 'no bell for weekly');
  assert.deepEqual(sent.map((x) => x.url), ['https://ops.test/functions/v1/send-receipt']);
  assert.equal(sent[0].body.to, 'boss@harness-mail.co.uk');
  assert.equal(sent[0].body.location_id, 'A', 'the company row sends as its first site');
  assert.match(sent[0].body.html, /Count not in/);
  assert.equal(db.tables.stock_notify_sent[0].status, 'sent');
  assert.equal(db.tables.stock_notify_sent[0].bell_event_id, null);
  assert.equal(db.tables.stock_notify_sent[1].status, 'skipped', 'nobody to email');

  const db2 = fakeDb({ stock_notify_sent: [{ id: 5, org_id: 'o1', location_id: null, kind: 'weekly', ref: 'o1:w', payload: PAYLOAD, status: 'waiting', attempts: 2 }], activity_events: [] }, {
    stock_notify_targets: () => ({ data: { bell: [], people: [{ email: 'boss@harness-mail.co.uk' }] }, error: null }),
    stock_report_league: () => ({ data: null, error: { message: 'timeout' } }),
  });
  const h2 = await loadFn('stock-notify', db2);
  assert.deepEqual(await (await call(h2)).json(), { ok: true, sent: 0, failed: 1 });
  assert.equal(db2.tables.stock_notify_sent[0].status, 'failed');
  assert.match(db2.tables.stock_notify_sent[0].last_error, /the week's figures: timeout/);
});

test('stock-notify carries the 5.11.100 marker and still needs a bell for every other kind', () => {
  const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/stock-notify/index.ts'), 'utf8');
  assert.match(src, /\/\/ MARKER 5\.11\.100 stock-notify weekly/);
  assert.match(src, /if \(!weekly && !plan\.bell\.length\)/);
  assert.doesNotMatch(src, DASH);
});

// 5.11.100 review: never email a login that is not a person (the HubRise integration login), or an address
// that cannot be real. The SQL twin is stock_co__notify_email_ok (20261030a, proven equal in drop4b.mjs 65).
test('notifyEmailOk: people yes; integration, example, test and no reply addresses never', async () => {
  const { notifyEmailOk, planSend } = await import('../../../supabase/functions/_shared/stockNotifyRules.js');
  for (const [e, want] of [['a.person@coffee-shop.co.uk', true], ['Boss@Example.co.uk', true], ['integration@hubrise.com', false], ['x@eu.hubrise.com', false],
    ['bob@example.com', false], ['bob@example.org', false], ['a@b.test', false], ['a@b.invalid', false], ['a@host.local', false], ['noreply@coffee.co.uk', false],
    ['no-reply@coffee.co.uk', false], ['donotreply@coffee.co.uk', false], ['not an address', false], ['', false], [null, false]]) {
    assert.equal(notifyEmailOk(e), want, String(e));
  }
  const row = { kind: 'price_rise', location_id: 'L1', payload: { item_name: 'Milk', pct: 6, site_name: 'Leeds' } };
  const plan = planSend(row, { bell: [{ location_id: 'L1' }], people: [{ email: 'integration@hubrise.com', email_on: true }, { email: 'owner@coffee.co.uk', email_on: true }] });
  assert.deepEqual(plan.email.map((m) => m.to), ['owner@coffee.co.uk'], 'planSend drops the integration login too');
});
