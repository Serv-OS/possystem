// src/lib/adyenOnly.test.js (29 Oct 2026, v5.11.116, Drop A of the payments audit).
// Peter: ServOS works with Adyen only. These pin (1) Adyen as the answer wherever the processor is
// unknown, (2) catering pay now on Adyen, (3) the handheld's simulated approval gated to mock and
// training, (4) Orders Hub capturing an Adyen tab, (5) the kiosk aborting an Adyen prompt on the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closedCheckRow } from './closedCheckRow.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('a bill closed without a processor is an Adyen bill, never Stripe', () => {
  const row = closedCheckRow({ id: 'c1', ref: '#1', items: [], subtotal: 5, total: 5, method: 'cash' }, 'loc');
  assert.equal(row.processor, 'adyen');
  assert.equal(closedCheckRow({ id: 'c2', items: [], processor: 'adyen', method: 'card' }, 'loc').processor, 'adyen');
});

test('every "unknown processor" default in the app answers Adyen', () => {
  const files = [
    'src/lib/payments/processor.js', 'src/lib/closedCheckRow.js', 'src/lib/closedCheckRefundFields.js',
    'src/lib/payments/refundMath.js', 'src/lib/orderPayment.js', 'src/store/index.js',
    'src/surfaces/CheckoutModal.jsx', 'src/components/SplitModal.jsx', 'src/surfaces/MPOSSurface.jsx',
    'src/surfaces/BarSurface.jsx', 'src/surfaces/OrdersHub.jsx', 'src/surfaces/qr/QrCheckout.jsx',
    'src/surfaces/online/OnlineCheckout.jsx', 'src/surfaces/online/OnlineSurface.jsx',
    'src/surfaces/catering/CateringCheckout.jsx', 'src/surfaces/qr/TabResumeScreen.jsx',
    'src/backoffice/sections/CardPayments.jsx',
  ];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/\|\|\s*'stripe'/.test(src), `${f} still falls back to 'stripe'`);
    assert.ok(!/useState\('stripe'\)/.test(src), `${f} still starts as 'stripe'`);
    assert.ok(!/\?\s*'ryft'\s*:\s*'stripe'/.test(src), `${f} still has a ryft or stripe ternary`);
    assert.ok(!/catch\(\(\) => 'stripe'\)/.test(src), `${f} still catches to 'stripe'`);
  }
  const proc = read('src/lib/payments/processor.js');
  assert.equal((proc.match(/processor: 'adyen', definitive: false/g) || []).length, 3, 'the three fail safe answers are Adyen');
  const fn = read('supabase/functions/payments-processor/index.ts');
  assert.ok(fn.includes("? loc.payment_processor : 'adyen';"), 'the server answers Adyen for a row with no processor');
  for (const f of ['supabase/functions/adyen-onboard/index.ts', 'supabase/functions/adyen-terminal-admin/index.ts']) {
    assert.ok(!read(f).includes("payment_processor || 'stripe'"), f);
  }
  assert.ok(read('supabase/functions/gift-checkout-session/index.ts').includes("let processor = 'adyen';"));
});

test('the database defaults follow: two migrations, one per project, with rollbacks', () => {
  const plat = read('supabase/migrations/20261107a_PLATFORM_processor_defaults_adyen.sql');
  for (const t of ['locations', 'gift_card_purchases', 'payment_devices']) assert.ok(plat.includes(`public.${t} `) && plat.includes("set default 'adyen'"), t);
  const ops = read('supabase/migrations/20261107a_OPS_processor_defaults_adyen.sql');
  for (const t of ['closed_checks', 'terminal_jobs']) assert.ok(ops.includes(`public.${t} `), t);
  assert.ok(read('supabase/migrations/20261107a_PLATFORM_processor_defaults_adyen_ROLLBACK.sql').includes("set default 'stripe'"));
  assert.ok(read('supabase/migrations/20261107a_OPS_processor_defaults_adyen_ROLLBACK.sql').includes("set default 'ryft'"));
});

test('catering pay now has an Adyen branch that pays in page', () => {
  const src = read('src/surfaces/catering/CateringCheckout.jsx');
  assert.ok(src.includes("import AdyenPaymentForm from '../../components/AdyenPaymentForm';"));
  assert.ok(src.includes("if (processor === 'ryft' || processor === 'adyen') { setStep('pay'); return; }"), 'Adyen never reaches createPaymentIntent (Stripe)');
  const form = src.slice(src.indexOf('<AdyenPaymentForm'), src.indexOf('/>', src.indexOf('<AdyenPaymentForm')));
  assert.ok(form.includes('reference={ref}') && form.includes('amountMinor={totalMinor}') && form.includes('onSuccess={finalizeNow}'));
});

test('the handheld simulated approval is reachable only in the mock build or training mode', () => {
  const src = read('src/surfaces/mpos/MCardFlow.jsx');
  assert.ok(src.includes('const simAllowed = isMock || isTrainingMode();'));
  assert.equal((src.match(/setPhase\('sim'\)/g) || []).length, 1, "only enterSim may open the 'sim' screen");
  assert.ok(src.includes("if (simAllowed) { setPhase('sim'); return; }") && src.includes("setPhase('error');"), 'in production it is the error screen');
  assert.ok(src.includes("const simulateApprove = () => {\n    if (!simAllowed) return;"), 'the approve button is inert in production');
  assert.equal((src.match(/enterSim\(/g) || []).length, 3, 'three call sites');
});

test('Orders Hub captures an Adyen tab by its psp reference', () => {
  const src = read('src/surfaces/OrdersHub.jsx');
  assert.ok(src.includes("const isAdyen = tab.processor === 'adyen';"));
  assert.ok(src.includes("if (isRyft ? !ryftSession : isAdyen ? !tab.payment_intent_id : (!tab.payment_intent_id || !tab.stripe_account)) {"));
});

test('the kiosk aborts a live Adyen card prompt on the reader', () => {
  const src = read('src/surfaces/KioskApp.jsx');
  assert.ok(src.includes('abortTerminalJob'), 'imported');
  assert.ok(src.includes("const r = proc === 'adyen' ? await abortTerminalJob(ryftJobId) : await cancelTerminalJob(ryftJobId);"));
});
