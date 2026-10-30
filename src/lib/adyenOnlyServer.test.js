// src/lib/adyenOnlyServer.test.js
//
// Drop D (29 Oct 2026): ServOS works with Adyen only. Every live venue is on Adyen; no venue uses
// Ryft; the Stripe rows are dead venues. These static checks pin the SERVER side of that: the
// Stripe and Ryft edge functions, the shared Ryft helper, the Vercel Stripe routes and the Android
// paxpay module are gone, nothing left imports them, and the mixed functions answer Adyen only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROOF_PROCESSORS } from '../../supabase/functions/_shared/paymentProofRules.js';
import { purchaseProcessor } from '../../supabase/functions/_shared/giftPurchaseProof.ts';
import { shouldServerKick } from '../../supabase/functions/_shared/terminalKick.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const at = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(at(rel), 'utf8');
const FN_DIR = at('supabase/functions');

// Source without // line comments and /* */ blocks (history notes may still name the old processors).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const functionDirs = () => fs.readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared').map((d) => d.name);

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?[jt]sx?)$/.test(e.name)) out.push(p);
  }
  return out;
};

test('no stripe-* or ryft-* function, no payments-onboard, no terminal-job-charge', () => {
  const dirs = functionDirs();
  assert.ok(dirs.length > 50, 'the function tree is still there');
  const gone = dirs.filter((d) => /^(stripe-|ryft-)/.test(d) || d === 'payments-onboard' || d === 'terminal-job-charge');
  assert.deepEqual(gone, [], `deleted functions still present: ${gone.join(', ')}`);
  for (const must of ['adyen-checkout', 'adyen-webhook', 'adyen-terminal-charge', 'payments-admin', 'payments-processor',
    'payment-proof', 'gift-checkout-session', 'gift-fulfill', 'gift-purchase-status', 'terminal-job-create', 'terminal-job-cancel']) {
    assert.ok(dirs.includes(must), `${must} must stay`);
  }
});

test('_shared/ryft.ts is gone and nothing imports it; no function loads the Stripe SDK', () => {
  assert.ok(!fs.existsSync(at('supabase/functions/_shared/ryft.ts')));
  for (const file of walk(FN_DIR)) {
    const src = code(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(root, file);
    assert.ok(!/_shared\/ryft(\.ts)?['"]/.test(src), `${rel} still imports _shared/ryft.ts`);
    assert.ok(!/esm\.sh\/stripe|npm:stripe|from ['"]stripe['"]/.test(src), `${rel} still loads the Stripe SDK`);
    assert.ok(!/functions\/v1\/(stripe-|ryft-)/.test(src), `${rel} still calls a deleted function`);
    assert.ok(!/STRIPE_SECRET_KEY|RYFT_SECRET_KEY|RYFT_API_BASE/.test(src), `${rel} still reads a Stripe or Ryft secret`);
  }
});

test('the Vercel Stripe routes and the Android paxpay module are gone', () => {
  assert.ok(!fs.existsSync(at('api/stripe-capture.js')));
  assert.ok(!fs.existsSync(at('api/stripe-charge-overage.js')));
  assert.ok(!fs.existsSync(at('android/paxpay')));
  assert.ok(!fs.existsSync(at('.github/workflows/build-paxpay.yml')));
  assert.ok(!read('android/settings.gradle').includes(':paxpay'));
});

test('payment-proof proves Adyen, gift and loyalty only', () => {
  assert.deepEqual(PROOF_PROCESSORS, ['adyen', 'gift', 'loyalty']);
  const src = code(read('supabase/functions/payment-proof/index.ts'));
  assert.ok(src.includes("if (processor === 'adyen') {"));
  assert.ok(!src.includes("processor === 'stripe'") && !src.includes("processor === 'ryft'"));
  const rules = code(read('supabase/functions/_shared/paymentProofRules.js'));
  assert.ok(!rules.includes('stripeProof') && !rules.includes('ryftProof'));
});

test('payments-processor answers adyen for a known location and 404 for an unknown one', () => {
  const src = code(read('supabase/functions/payments-processor/index.ts'));
  assert.ok(src.includes("return json({ processor: 'adyen' });"));
  assert.ok(src.includes("return json({ error: 'location not found' }, 404);"));
  assert.ok(!src.includes("'stripe'") && !src.includes("'ryft'"));
});

test('payments-admin: set_processor accepts adyen only; the Stripe and Ryft actions are gone', () => {
  const src = code(read('supabase/functions/payments-admin/index.ts'));
  assert.ok(src.includes("if (processor !== 'adyen') return json({ error: \"processor must be 'adyen'\" }, 400);"));
  for (const action of ['ryft_status', 'ryft_pricing', 'ryft_fees', 'ryft_unlink', 'ryft_create', 'ryft_link', 'ryft_inspect',
    'ryft_sync', 'ryft_onboarding_link', 'stripe_pricing', 'stripe_unlink']) {
    assert.ok(!src.includes(`action === '${action}'`), `${action} still handled`);
  }
  assert.ok(!src.includes('ryftErr') && !src.includes('upsertRyftAccount'));
  assert.ok(!src.includes('merchant_ryft_accounts') && !src.includes('merchant_stripe_accounts'));
});

test('terminal-job-create never writes a ryft job; a terminal without an Adyen id is refused', () => {
  const src = code(read('supabase/functions/terminal-job-create/index.ts'));
  assert.ok(!src.includes("'ryft'"), "no 'ryft' literal in the code");
  assert.ok(src.includes("processor: isDemoTerminal ? 'demo' : 'adyen',"), 'an Adyen job, or the simulated demo reader');
  assert.ok(src.includes("if (!term.adyen_terminal_id && !isDemoTerminal) {"), 'the refusal gate');
  assert.ok(src.includes("terminal is not linked to an Adyen reader"));
  // the server kick stays an Adyen only decision; a demo job is never kicked
  assert.equal(shouldServerKick({ processor: 'demo', status: 'pending', simulated: true }).kick, false);
  assert.equal(shouldServerKick({ processor: 'adyen', status: 'charging_unsent', charge_minor: 1200 }).kick, true);
});

test('terminal-job-cancel keeps the pre charge RPC path and answers 409 for a live job', () => {
  const src = code(read('supabase/functions/terminal-job-cancel/index.ts'));
  assert.ok(src.includes("await caller.rpc('terminal_job_cancel', { p_job_id: jobId })"));
  assert.ok(src.includes("error: 'a live card prompt is cancelled on the reader'") && src.includes('}, 409);'));
  assert.ok(!src.includes('cancelTerminalAction') && !src.includes('getPaymentSession'));
  assert.ok(!src.includes("'ryft'"));
});

test('gift purchases: Adyen is the only provable processor; the Stripe session lookup is gone', () => {
  assert.equal(purchaseProcessor({ processor: 'adyen' }), 'adyen');
  assert.equal(purchaseProcessor({ processor: 'stripe' }), null);
  assert.equal(purchaseProcessor({ processor: 'ryft' }), null);
  const ful = code(read('supabase/functions/gift-fulfill/index.ts'));
  assert.ok(ful.includes("if (processor === 'adyen') {") && !ful.includes("processor === 'stripe'") && !ful.includes("processor === 'ryft'"));
  const status = code(read('supabase/functions/gift-purchase-status/index.ts'));
  assert.ok(!status.includes('stripe_session_id'));
  assert.ok(status.includes(".eq('id', purchaseId)"));
  assert.ok(status.includes("if (!purchaseId) return json({ error: 'Purchase not found', status: 'not_found' }, 404);"), 'a session_id alone answers 404');
  const plan = code(read('supabase/functions/_shared/giftFulfilPlan.ts'));
  assert.ok(!plan.includes('ryft_') && !plan.includes('Stripe'));
});

test('the shared helpers default to adyen, never ryft', () => {
  const kick = code(read('supabase/functions/_shared/terminalKick.js'));
  assert.ok(!kick.includes("'ryft'"));
  const charge = code(read('supabase/functions/adyen-terminal-charge/index.ts'));
  assert.ok(!charge.includes("?? 'ryft'"));
  const rec = code(read('supabase/functions/terminal-job-reconcile/index.ts'));
  assert.ok(rec.includes('processor_lookup_available: { adyen: true }'));
});

test('the SQL for Peter exists with its rollbacks and archives before it drops', () => {
  const plat = read('supabase/migrations/20261109a_PLATFORM_adyen_only.sql');
  assert.ok(plat.indexOf('create table if not exists public.archive_merchant_stripe_accounts') < plat.indexOf('drop table if exists public.merchant_stripe_accounts'));
  assert.ok(plat.indexOf('create table if not exists public.archive_merchant_ryft_accounts') < plat.indexOf('drop table if exists public.merchant_ryft_accounts'));
  for (const col of ['default_ryft_markup_percent', 'ryft_cost_percent', 'stripe_configuration_id', 'stripe_terminal_location_id', 'stripe_reader_id', 'ryft_terminal_id']) {
    assert.ok(plat.includes(`drop column if exists ${col}`), col);
  }
  for (const kept of ['drop table if exists public.ryft_payments', 'drop table if exists public.merchant_ryft_disputes', 'drop column if exists stripe_payment_intent_id', 'drop column if exists stripe_session_id']) {
    assert.ok(!plat.includes(kept), `${kept} must never happen`);
  }
  const ops = read('supabase/migrations/20261109a_OPS_adyen_only.sql');
  assert.ok(ops.includes('alter table public.terminal_devices drop column if exists ryft_terminal_id;'));
  assert.ok(ops.includes('grant execute on function public.terminal_targets_for_pos(uuid) to anon, authenticated;'), 'the re grant after the return type change');
  assert.ok(fs.existsSync(at('supabase/migrations/20261109a_PLATFORM_adyen_only_ROLLBACK.sql')));
  assert.ok(fs.existsSync(at('supabase/migrations/20261109a_OPS_adyen_only_ROLLBACK.sql')));
});
