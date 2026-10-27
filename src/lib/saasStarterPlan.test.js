// src/lib/saasStarterPlan.test.js (27 Oct 2026): Starter at 99 GBP replaced Free for new venues.
// Peter: "its only the free plan thats changed". The venues already on Free keep 0 GBP as an old
// plan until each one is moved by hand, so the catalog must keep Free, never recommend it, never
// nag a Free venue towards Starter (same band), and only offer it to a venue already on it.
// Reads the real files, like the other wiring tests: the catalog lives only in payments-admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANS, planForGtv } from './billingPlans.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const fn = read('supabase/functions/payments-admin/index.ts');

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

test('a new venue starts on Starter at 99, from Admin and from Back Office', () => {
  assert.ok(read('src/admin/CompanyAdminApp.jsx').includes("plan:'starter', monthly_fee:99,"));
  assert.ok(read('src/backoffice/sections/CompanyAdmin.jsx').includes("plan: 'starter', monthly_fee: 99,"));
});

test('Revenue names every plan, the old one included', () => {
  const rev = read('src/admin/sections/AdminRevenue.jsx');
  assert.ok(rev.includes("{ starter: 'Starter', growth: 'Growth', scale: 'Scale', free: 'Free (old plan)' }"));
});

test('the pure ladder mirror agrees: up to 8,000 GBP is Starter at 99', () => {
  assert.deepEqual(PLANS.map((p) => [p.code, p.priceMinor]), [['starter', 9900], ['growth', 14900], ['scale', 29900]]);
  assert.equal(planForGtv(0).code, 'starter');
  assert.equal(planForGtv(800000).code, 'starter');
  assert.equal(planForGtv(800001).code, 'growth');
});
