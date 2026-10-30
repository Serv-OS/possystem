// src/lib/saasStarterPlan.test.js (27 Oct 2026): Starter at 99 GBP replaced Free for new venues.
// Peter: "its only the free plan thats changed". The venues already on Free keep 0 GBP as an old
// plan until each one is moved by hand, so the catalog must keep Free, never recommend it, never
// nag a Free venue towards Starter (same band), and only offer it to a venue already on it.
// Reads the real files, like the other wiring tests: the catalog lives only in payments-admin.
//
// 27 Oct 2026, US prices: the catalog is per currency (GBP and USD), picked by the venue's Ops
// locations.currency. US plans Starter $149, Growth $299, Full $399 (same keys starter / growth /
// scale); Free stays an old plan at 0 in both. Extra devices keep 39 for USD, marked price to
// confirm; HubRise is UK only (the server refuses it for a USD venue). Revenue never adds dollars
// to pounds. The later tests run the real payments-admin handler against a stand in database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PLANS, planForGtv } from './billingPlans.js';
import { STARTER_MONTHLY, newVenueSubscription, saasPlanName } from './saasNewVenue.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const fn = read('supabase/functions/payments-admin/index.ts');

// The catalog block of payments-admin, run as plain JavaScript: SAAS_CATALOGS and its helpers.
function loadCatalog() {
  const block = fn.slice(fn.indexOf('type SaasCurrency'), fn.indexOf('// Plain words on the screen (10 Sep 2026)'));
  assert.ok(block.length > 500, 'catalog block found');
  const js = stripTypeScriptTypes(block, { mode: 'strip' });
  return new Function(`${js}\nreturn { SAAS_CATALOGS, saasCurrency, saasCatalogFor, saasPlanForVolume, sameBand, saasMonthlyFee };`)();
}
const C = loadCatalog();

test('the catalog: Starter 99, Growth 149, Scale 299, and Free kept as an old plan at 0', () => {
  assert.match(fn, /starter:\s*\{ label: 'Starter',\s*monthly: 99,\s*devices: 2,\s*volume_min: 0,\s*volume_max: 800000 \}/);
  assert.match(fn, /growth:\s*\{ label: 'Growth',\s*monthly: 149,/);
  assert.match(fn, /scale:\s*\{ label: 'Scale',\s*monthly: 299,/);
  assert.match(fn, /free:\s*\{ label: 'Free \(old plan\)', monthly: 0,\s*devices: 2,\s*volume_min: 0,\s*volume_max: 800000, legacy: true \}/);
});

test('the volume check never recommends the old plan, and never nags a Free venue to Starter', () => {
  const pick = fn.slice(fn.indexOf('function saasPlanForVolume'), fn.indexOf('function sameBand'));
  assert.ok(pick.includes('if (p.legacy) continue;'));
  // Both places that set recommended_plan skip a plan in the same band.
  assert.equal((fn.match(/recommended_plan: recommended !== [\w.]+ && !sameBand\(/g) || []).length, 2);
  assert.ok(fn.includes("{ starter: 0, free: 0, growth: 1, scale: 2 }"));
});

test('the Admin plan list offers Free only to a venue already on it', () => {
  const ui = read('src/admin/sections/AdminBillingManager.jsx');
  assert.ok(ui.includes('.filter(([key, p]) => !p.legacy || key === venue.plan)'));
});

test('a new venue starts on Starter in its own currency, from Admin and from Back Office', () => {
  assert.ok(read('src/admin/CompanyAdminApp.jsx').includes('...newVenueSubscription(loc.currency || form.locCurrency), gmv_this_month:0,'));
  assert.ok(read('src/backoffice/sections/CompanyAdmin.jsx').includes('...newVenueSubscription(loc.currency || form.locCurrency), gmv_this_month: 0,'));
  assert.deepEqual(newVenueSubscription('GBP'), { plan: 'starter', monthly_fee: 99 });
  assert.deepEqual(newVenueSubscription('USD'), { plan: 'starter', monthly_fee: 149 });
  assert.deepEqual(newVenueSubscription('usd'), { plan: 'starter', monthly_fee: 149 });
  assert.deepEqual(newVenueSubscription(undefined), { plan: 'starter', monthly_fee: 99 });
  // The defaults are the catalog's Starter price in each currency, never a second price list.
  for (const cur of ['GBP', 'USD']) assert.equal(STARTER_MONTHLY[cur], C.SAAS_CATALOGS[cur].plans.starter.monthly, cur);
});

test('Revenue names every plan, the old one included, per currency', () => {
  const rev = read('src/admin/sections/AdminRevenue.jsx');
  assert.ok(rev.includes("saas.catalogs?.[c]?.plans?.[p]?.label ?? saasPlanName(p, c)"));
  assert.deepEqual(['starter', 'growth', 'scale', 'free'].map((k) => saasPlanName(k, 'GBP')), ['Starter', 'Growth', 'Scale', 'Free (old plan)']);
  assert.deepEqual(['starter', 'growth', 'scale', 'free'].map((k) => saasPlanName(k, 'USD')), ['Starter', 'Growth', 'Full', 'Free (old plan)']);
  // The fallback names agree with the server catalog labels.
  for (const cur of ['GBP', 'USD']) {
    for (const [k, p] of Object.entries(C.SAAS_CATALOGS[cur].plans)) assert.equal(saasPlanName(k, cur), p.label, `${cur} ${k}`);
  }
});

test('the pure ladder mirror agrees: up to 8,000 GBP is Starter at 99', () => {
  assert.deepEqual(PLANS.map((p) => [p.code, p.priceMinor]), [['starter', 9900], ['growth', 14900], ['scale', 29900]]);
  assert.equal(planForGtv(0).code, 'starter');
  assert.equal(planForGtv(800000).code, 'starter');
  assert.equal(planForGtv(800001).code, 'growth');
});

// ── US prices (27 Oct 2026) ─────────────────────────────────────────────────

test('the USD catalog: Starter $149, Growth $299, Full $399, Free kept as an old plan at $0', () => {
  const usd = C.SAAS_CATALOGS.USD;
  assert.equal(usd.currency, 'USD');
  assert.deepEqual(Object.keys(usd.plans), ['starter', 'growth', 'scale', 'free']);
  assert.deepEqual(Object.entries(usd.plans).map(([k, p]) => [k, p.label, p.monthly]),
    [['starter', 'Starter', 149], ['growth', 'Growth', 299], ['scale', 'Full', 399], ['free', 'Free (old plan)', 0]]);
  assert.equal(usd.plans.free.legacy, true);
  // Same plan keys and the same numeric bands (minor units) as the UK, advisory only.
  for (const k of Object.keys(usd.plans)) {
    assert.equal(usd.plans[k].volume_min, C.SAAS_CATALOGS.GBP.plans[k].volume_min, k);
    assert.equal(usd.plans[k].volume_max, C.SAAS_CATALOGS.GBP.plans[k].volume_max, k);
    assert.equal(usd.plans[k].devices, C.SAAS_CATALOGS.GBP.plans[k].devices, k);
  }
  // Extra devices: no US price yet, the number stays 39 and is marked price to confirm.
  assert.equal(usd.extra_device_monthly, 39);
  assert.equal(usd.extra_device_price_to_confirm, true);
  assert.equal(C.SAAS_CATALOGS.GBP.extra_device_price_to_confirm, false);
  // HubRise is UK only.
  assert.equal(usd.hubrise_monthly, null);
  assert.equal(C.SAAS_CATALOGS.GBP.hubrise_monthly, 45);
});

test('the UK catalog is unchanged: Starter £99, Growth £149, Scale £299, Free £0', () => {
  assert.deepEqual(Object.entries(C.SAAS_CATALOGS.GBP.plans).map(([k, p]) => [k, p.label, p.monthly]),
    [['starter', 'Starter', 99], ['growth', 'Growth', 149], ['scale', 'Scale', 299], ['free', 'Free (old plan)', 0]]);
});

test('each venue is priced from its own currency: fees, bands and the currency rule', () => {
  assert.equal(C.saasCurrency('USD'), 'USD');
  assert.equal(C.saasCurrency(' usd '), 'USD');
  assert.equal(C.saasCurrency('GBP'), 'GBP');
  assert.equal(C.saasCurrency(null), 'GBP');
  assert.equal(C.saasMonthlyFee('starter', 0, false, 'GBP'), 99);
  assert.equal(C.saasMonthlyFee('starter', 0, false, 'USD'), 149);
  assert.equal(C.saasMonthlyFee('growth', 0, false, 'USD'), 299);
  assert.equal(C.saasMonthlyFee('scale', 2, false, 'USD'), 399 + 78);
  assert.equal(C.saasMonthlyFee('free', 0, false, 'USD'), 0);
  assert.equal(C.saasMonthlyFee('scale', 1, true, 'GBP'), 299 + 39 + 45);
  // Even if asked, HubRise adds nothing in a currency that does not offer it.
  assert.equal(C.saasMonthlyFee('starter', 0, true, 'USD'), 149);
  for (const cur of ['GBP', 'USD']) {
    assert.equal(C.saasPlanForVolume(0, cur), 'starter');
    assert.equal(C.saasPlanForVolume(800000, cur), 'starter');
    assert.equal(C.saasPlanForVolume(800001, cur), 'growth');
    assert.equal(C.saasPlanForVolume(1500001, cur), 'scale');
    assert.equal(C.sameBand('free', 'starter', cur), true);
  }
});

test('the Admin plan row shows each venue in its own currency and hides HubRise where not offered', () => {
  const ui = read('src/admin/sections/AdminBillingManager.jsx');
  const row = ui.slice(ui.indexOf('function SaasVenueRow'), ui.indexOf('// ─── Compact venue row'));
  assert.doesNotMatch(row, /\bGBP\b(?!'\))/, 'no hard coded GBP in the plan row');
  assert.doesNotMatch(row, /£/);
  assert.ok(row.includes('`${p.label} ${planPrice(p.monthly, cur)}`'));
  assert.ok(row.includes('const hubriseOffered = catalog?.hubrise_monthly != null;'));
  assert.ok(row.includes('{hubriseOffered && ('));
  assert.ok(row.includes('hubrise: hubOn'));
  assert.ok(row.includes('(price to confirm)'));
  assert.ok(ui.includes('catalog={data.catalogs?.[venue.currency] ?? data.catalog}'));
});

test('Revenue keeps SaaS apart per currency on screen (no pound only formatter left)', () => {
  const rev = read('src/admin/sections/AdminRevenue.jsx');
  assert.doesNotMatch(rev, /const pounds =/);
  assert.ok(rev.includes('totals.saas_fee_minor_by_currency'));
  assert.ok(rev.includes('saas.plans_by_currency'));
});

// ── the real handler, against a stand in database ───────────────────────────

const ENV = {
  SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'ops-key',
  PLATFORM_SUPABASE_URL: 'https://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key',
};

function makeDb(tables) {
  const writes = [];
  const T = (name) => (tables[name] ||= []);
  const from = (table) => {
    const st = { op: 'select', filters: [], payload: null, range: null, single: null };
    const match = (r) => st.filters.every(([op, k, v]) => {
      if (op === 'eq') return r[k] === v;
      if (op === 'in') return v.includes(r[k]);
      if (op === 'gte') return String(r[k]) >= String(v);
      if (op === 'lt') return String(r[k]) < String(v);
      return true;
    });
    const run = () => {
      if (st.op === 'insert') { writes.push({ table, op: 'insert', payload: st.payload }); T(table).push({ ...st.payload }); return { data: [st.payload], error: null }; }
      let rows = T(table).filter(match);
      if (st.op === 'update') { writes.push({ table, op: 'update', payload: st.payload, filters: st.filters }); rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows.map((r) => ({ id: r.id })), error: null }; }
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.single === 'maybe') return { data: rows[0] ?? null, error: null };
      if (st.single === 'one') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: rows, error: null };
    };
    const q = {
      select() { return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      eq(k, v) { st.filters.push(['eq', k, v]); return q; },
      in(k, v) { st.filters.push(['in', k, v]); return q; },
      gte(k, v) { st.filters.push(['gte', k, v]); return q; },
      lt(k, v) { st.filters.push(['lt', k, v]); return q; },
      order() { return q; },
      range(a, b) { st.range = [a, b]; return q; },
      maybeSingle() { st.single = 'maybe'; return q; },
      single() { st.single = 'one'; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  return { from, writes, auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) } };
}

let dbs = {};
async function loadHandler() {
  const file = fileURLToPath(new URL('../../supabase/functions/payments-admin/index.ts', import.meta.url));
  let src = fn;
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = (url) => new Proxy({}, { get: (_t, prop) => globalThis.__saasTest.dbs[url][prop] });');
  src = src.replace("import { secondStepRefusal } from '../_shared/second-step.ts';", 'const secondStepRefusal = async () => null;');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(file), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/);
  const out = path.join(os.tmpdir(), `edge-payments-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  let handler = null;
  globalThis.__saasTest = { get dbs() { return dbs; } };
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  assert.equal(typeof handler, 'function');
  return handler;
}
const handlerP = loadHandler();
const call = async (body) => {
  const h = await handlerP;
  const res = await h(new Request('https://ops.test/functions/v1/payments-admin', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer t' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};

// One UK venue and one US venue (Ops ids), each mirrored on the Platform.
function world({ ukSub = { plan: 'starter', monthly_fee: '99.00' }, usSub = { plan: 'free', monthly_fee: '0.00' }, payments = [] } = {}) {
  const ops = makeDb({
    user_profiles: [{ id: 'admin-1', role: 'super_admin' }],
    locations: [
      { id: 'ops-uk', name: 'Leeds', org_id: 'org-1', currency: 'GBP' },
      { id: 'ops-us', name: 'Provo', org_id: 'org-2', currency: 'USD' },
    ],
    subscriptions: [
      { id: 's-uk', location_id: 'ops-uk', org_id: 'org-1', extra_devices: 0, hubrise: false, ...ukSub },
      { id: 's-us', location_id: 'ops-us', org_id: 'org-2', extra_devices: 0, hubrise: false, ...usSub },
    ],
    devices: [], hubrise_connections: [],
  });
  const platform = makeDb({
    locations: [
      { id: 'p-uk', name: 'Leeds', company_id: 'c1', ops_location_id: 'ops-uk' },
      { id: 'p-us', name: 'Provo', company_id: 'c2', ops_location_id: 'ops-us' },
    ],
    adyen_payments: payments,
  });
  dbs = { [ENV.SUPABASE_URL]: ops, [ENV.PLATFORM_SUPABASE_URL]: platform };
  return { ops, platform };
}

test('saas_pricing set: a USD venue on Starter is stored at 149.00 (dollars)', async () => {
  const { ops } = world();
  const r = await call({ action: 'saas_pricing', set: true, location_id: 'ops-us', plan: 'starter', extra_devices: 0, hubrise: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.monthly_fee, 149);
  assert.equal(r.body.currency, 'USD');
  const w = ops.writes.find((x) => x.table === 'subscriptions');
  assert.equal(w.payload.monthly_fee, '149.00');
  assert.equal(w.payload.plan, 'starter');
});

test('saas_pricing set: Full for a USD venue with 1 extra device is 399 + 39 (price to confirm)', async () => {
  const { ops } = world();
  const r = await call({ action: 'saas_pricing', set: true, location_id: 'ops-us', plan: 'scale', extra_devices: 1, hubrise: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ops.writes.find((x) => x.table === 'subscriptions').payload.monthly_fee, '438.00');
});

test('saas_pricing set: HubRise is refused for a USD venue and nothing is written', async () => {
  const { ops } = world();
  const r = await call({ action: 'saas_pricing', set: true, location_id: 'ops-us', plan: 'starter', extra_devices: 0, hubrise: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /HubRise add-on is not offered for USD venues/);
  assert.equal(ops.writes.length, 0);
});

test('saas_pricing set: a GBP venue keeps pounds and HubRise (99 + 45)', async () => {
  const { ops } = world();
  const r = await call({ action: 'saas_pricing', set: true, location_id: 'ops-uk', plan: 'starter', extra_devices: 0, hubrise: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.currency, 'GBP');
  assert.equal(ops.writes.find((x) => x.table === 'subscriptions').payload.monthly_fee, '144.00');
});

test('saas_pricing get: each venue names its currency and both catalogs are sent', async () => {
  world();
  const r = await call({ action: 'saas_pricing' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = Object.fromEntries(r.body.venues.map((v) => [v.location_id, v]));
  assert.equal(byId['ops-uk'].currency, 'GBP');
  assert.equal(byId['ops-us'].currency, 'USD');
  // The USD venue on Free keeps $0 and is not nagged towards Starter (same band).
  assert.equal(byId['ops-us'].plan, 'free');
  assert.equal(byId['ops-us'].monthly_fee, 0);
  assert.equal(byId['ops-us'].recommended_plan, null);
  assert.equal(r.body.catalogs.USD.plans.scale.label, 'Full');
  assert.equal(r.body.catalogs.GBP.plans.scale.label, 'Scale');
  assert.equal(r.body.catalog.currency, 'GBP', 'the old single catalog field stays GBP for an older screen');
});

test('revenue: SaaS totals and venues by plan are per currency, never dollars added to pounds', async () => {
  world({ usSub: { plan: 'scale', monthly_fee: '399.00' } });
  const r = await call({ action: 'revenue', month: '2026-09' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.totals.saas_fee_minor_by_currency, { GBP: 9900, USD: 39900 });
  assert.equal(r.body.currency, 'GBP');
  assert.equal(r.body.totals.saas_fee_minor, 9900, 'the report currency share only');
  assert.equal(r.body.totals.revenue_minor, 9900);
  assert.deepEqual(r.body.saas.plans_by_currency, { GBP: { starter: 1 }, USD: { scale: 1 } });
  const us = r.body.rows.find((x) => x.location_id === 'p-us');
  assert.equal(us.currency, 'USD');
  assert.equal(us.saas_currency, 'USD');
  assert.equal(us.saas.plan_label, 'Full');
  assert.equal(us.saas.plan_fee, 399);
  assert.equal(us.saas.stale, false);
});

test('revenue: commission is unchanged, and a venue whose card money is in another currency keeps its plan fee out of its revenue', async () => {
  const pay = (loc, cur, amount, commission) => ({
    location_id: loc, live: true, amount_minor: amount, amount_refunded_minor: 0, success: true, last_event_code: 'AUTHORISATION',
    currency: cur, applied_mods: null, rate_category: 'card_present', commission_minor: commission, fee_minor: null, created_at: '2026-09-10T12:00:00Z',
  });
  world({ payments: [pay('p-uk', 'GBP', 10000, 150), pay('p-us', 'GBP', 5000, 80)] });
  const r = await call({ action: 'revenue', month: '2026-09' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.totals.commission_minor, 230);
  const uk = r.body.rows.find((x) => x.location_id === 'p-uk');
  assert.equal(uk.revenue_minor, 150 + 9900);
  // The US venue's card money says GBP while its plan is USD: its revenue is commission only.
  const us = r.body.rows.find((x) => x.location_id === 'p-us');
  assert.equal(us.revenue_minor, 80);
  assert.equal(r.body.totals.revenue_minor, 230 + 9900);
});
