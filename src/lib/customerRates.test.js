// customerRates.test.js: a customer page waits for its session, retries an empty rates answer, and
// refuses to open payment while the venue's rates are not loaded.
// Run: `npm test`, or `node --test src/lib/customerRates.test.js`.
//
// 8 Oct 2026 (VAT audit): Preston QR-4OGI7 (4.85) booked NO VAT because OnlineSurface read
// tax_rates before the anonymous sign in finished; the policy answered an empty list, not an
// error, and the page sent tax_amount null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCustomerRates, ratesGate, venueExpectsRates, activeRates, CUSTOMER_RATES_WORDS } from './customerRates.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const STD = { id: 'std', name: 'Standard Rate', rate: 0.2, type: 'inclusive', active: true, is_default: true };
const OLD = { id: 'old', name: 'Old Rate', rate: 0.175, type: 'inclusive', active: false, is_default: false };
const noSleep = async () => {};

// A read whose answers are scripted: each call takes the next answer.
const scripted = (answers) => {
  const calls = [];
  const fn = async () => { calls.push(Date.now()); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  fn.calls = calls;
  return fn;
};

test('the session is awaited BEFORE the first read (the fault: the read went out first)', async () => {
  const order = [];
  const waitForSession = async () => { order.push('session'); return 'token'; };
  const readRates = async () => { order.push('read'); return { data: [STD], error: null }; };
  const r = await loadCustomerRates({ waitForSession, readRates, sleep: noSleep });
  assert.deepEqual(order, ['session', 'read']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rates, [STD]);
  assert.equal(r.tries, 1);
});

test('rows come back: ok, inactive rates dropped (an inactive rate charges nothing)', async () => {
  const r = await loadCustomerRates({ readRates: scripted([{ data: [STD, OLD], error: null }]), sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rates.map((x) => x.id), ['std']);
  assert.deepEqual(activeRates([STD, OLD, null]), [STD]);
});

test('an empty answer is read again before it is believed; rows on the second try are ok', async () => {
  const readRates = scripted([{ data: [], error: null }, { data: [STD], error: null }]);
  const r = await loadCustomerRates({ waitForSession: async () => 'token', readRates, sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.tries, 2);
});

test('two empty answers with a session in hand: empty (the venue may really have no rates)', async () => {
  const readRates = scripted([{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }]);
  const r = await loadCustomerRates({ waitForSession: async () => 'token', readRates, sleep: noSleep });
  assert.equal(r.status, 'empty');
  assert.deepEqual(r.rates, []);
  assert.equal(r.tries, 2, 'believed after the second empty answer, not after every retry');
});

test('with NO session an empty list proves nothing: every try is used, and the answer is error', async () => {
  const readRates = scripted([{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }]);
  const r = await loadCustomerRates({ waitForSession: async () => null, readRates, sleep: noSleep });
  assert.equal(r.status, 'error');
  assert.equal(r.tries, 4);
  assert.match(String(r.error?.message), /no session/);
});

test('a sign in that throws is not fatal: the read still runs (the policy may let it through), rows win', async () => {
  const readRates = scripted([{ data: [STD], error: null }]);
  const r = await loadCustomerRates({ waitForSession: async () => { throw new Error('auth down'); }, readRates, sleep: noSleep });
  assert.equal(r.status, 'ok');
});

test('errors are retried with the pauses given, then reported', async () => {
  const slept = [];
  const readRates = scripted([{ data: null, error: new Error('net') }, new Error('thrown'), { data: null, error: new Error('net 2') }]);
  const r = await loadCustomerRates({ readRates, delays: [10, 20], sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.status, 'error');
  assert.equal(r.tries, 3);
  assert.deepEqual(slept, [10, 20]);
  assert.equal(r.error.message, 'net 2');
});

test('an error then rows: ok', async () => {
  const readRates = scripted([{ data: null, error: new Error('net') }, { data: [STD], error: null }]);
  const r = await loadCustomerRates({ readRates, sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.tries, 2);
});

test('never throws, even with no reader', async () => {
  const r = await loadCustomerRates({ sleep: noSleep });
  assert.equal(r.status, 'error');
});

test('venueExpectsRates: a menu that names a rate or an override expects rates', () => {
  assert.equal(venueExpectsRates([{ id: 'a', tax_rate_id: 'std' }]), true);
  assert.equal(venueExpectsRates([{ id: 'a', taxRateId: 'std' }]), true, 'camel too');
  assert.equal(venueExpectsRates([{ id: 'a', tax_rate_id: null, tax_overrides: { takeaway: 'zero' } }]), true);
  assert.equal(venueExpectsRates([{ id: 'a', tax_rate_id: null, tax_overrides: {} }]), false);
  assert.equal(venueExpectsRates([{ id: 'a', tax_rate_id: null, tax_overrides: { takeaway: null } }]), false, 'an explicit "Use default" names no rate');
  assert.equal(venueExpectsRates([]), false);
  assert.equal(venueExpectsRates(null), false);
});

test('ratesGate: payment waits while loading, is refused on a failed load, opens when rates are in', () => {
  assert.deepEqual(ratesGate({ ratesState: 'loading', expectsRates: true }), { code: 'loading', message: CUSTOMER_RATES_WORDS.loading });
  assert.deepEqual(ratesGate({ ratesState: undefined }), { code: 'loading', message: CUSTOMER_RATES_WORDS.loading });
  assert.deepEqual(ratesGate({ ratesState: 'error', expectsRates: false }), { code: 'failed', message: CUSTOMER_RATES_WORDS.failed });
  assert.equal(ratesGate({ ratesState: 'ok', expectsRates: true, hasTaxConfig: true }), null);
});

test('ratesGate: an empty list is refused when the menu names rates, believed when it names none', () => {
  // QR-4OGI7: the menu row carried tax_rate_id 229a7558 (Preston Standard Rate), the page had no rates.
  assert.deepEqual(ratesGate({ ratesState: 'empty', expectsRates: true, hasTaxConfig: false }), { code: 'failed', message: CUSTOMER_RATES_WORDS.failed });
  // A venue whose menu names no rate and has no profiles: no tax set up, the server books "not recorded" as before.
  assert.equal(ratesGate({ ratesState: 'empty', expectsRates: false, hasTaxConfig: false }), null);
  // A US venue set up as tax profiles: its rates list may be empty, its context has config.
  assert.equal(ratesGate({ ratesState: 'empty', expectsRates: false, hasTaxConfig: true }), null);
  // Belt and braces: rates "ok" but the page's context ended with none while the menu names rates.
  assert.deepEqual(ratesGate({ ratesState: 'ok', expectsRates: true, hasTaxConfig: false }), { code: 'failed', message: CUSTOMER_RATES_WORDS.failed });
});

test('the words are short and plain, with no dashes', () => {
  for (const w of Object.values(CUSTOMER_RATES_WORDS)) {
    assert.ok(w.length <= 45, w);
    assert.doesNotMatch(w, /[–—]/, 'no em or en dash');
  }
});

// ── wiring: the one surface (online AND qr) loads its rates this way ────────────────────────────
test('wiring: OnlineSurface waits for the session before the menu reads and loads rates through loadCustomerRates', () => {
  const src = read('../surfaces/online/OnlineSurface.jsx');
  assert.match(src, /import \{ loadCustomerRates, ratesGate, venueExpectsRates \} from '\.\.\/\.\.\/lib\/customerRates';/);
  // The session first, as CateringSurface has always done, then the reads.
  const load = src.indexOf('await ensureCustomerSession();   // 8 Oct 2026');
  const reads = src.indexOf('await Promise.allSettled([');
  assert.ok(load > 0 && reads > load, 'the session is awaited before Promise.allSettled');
  // The rates no longer ride the menu read: they have their own loader with retries.
  assert.doesNotMatch(src.slice(reads, src.indexOf('menusRes', reads)), /from\('tax_rates'\)/, 'tax_rates is not read inside the menu Promise.allSettled any more');
  assert.match(src, /loadCustomerRates\(\{\s*waitForSession: ensureCustomerSession,/);
  assert.match(src, /setRatesState\(r\.status\)/);
  assert.match(src, /const vatGate = useMemo\(\(\) => ratesGate\(\{ ratesState, expectsRates: venueExpectsRates\(items\), hasTaxConfig: taxCtxHasConfig\(taxCtx\) \}\)/);
  // Every checkout gets the gate and a way to try again.
  for (const tag of ['<OnlineCheckout', '<QrCheckout', '<TabResumeScreen']) {
    const mount = src.slice(src.indexOf(tag), src.indexOf('/>', src.indexOf(tag)));
    assert.match(mount, /vatGate=\{vatGate\}/, `${tag} takes vatGate`);
    assert.match(mount, /onRetryRates=\{retryRates\}/, `${tag} can try again`);
  }
});

test('wiring: the three checkouts refuse to open payment (or charge the card) while the gate is shut', () => {
  const qr = read('../surfaces/qr/QrCheckout.jsx');
  const qrContinue = qr.slice(qr.indexOf('const continueToPayment = async () => {'), qr.indexOf("if (processor === 'ryft')", qr.indexOf('const continueToPayment = async () => {')));
  assert.match(qrContinue, /if \(vatGate\) \{ setError\(vatGate\.message\); return; \}/, 'QR pay now and open tab: before any processor path');
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  const start = online.slice(online.indexOf('const startPayment = async () => {'), online.indexOf("if (processor === 'ryft')", online.indexOf('const startPayment = async () => {')));
  assert.match(start, /if \(vatGate\) \{ setError\(vatGate\.message\); setStep\('details'\); return; \}/, 'online card payment');
  const giftOnly = online.slice(online.indexOf('const onGiftOnlyPayment = async () => {'), online.indexOf('const giftCommit = await commitGift'));
  assert.match(giftOnly, /if \(vatGate\) \{ setError\(vatGate\.message\); setStep\('details'\); return; \}/, 'online paid by gift card or reward: it books a check too');
  const tab = read('../surfaces/qr/TabResumeScreen.jsx');
  const close = tab.slice(tab.indexOf('const handleClose = async () => {'), tab.indexOf('setClosing(true); setError(\'\');'));
  assert.match(close, /if \(vatGate\) \{ setError\(vatGate\.message\); return; \}/, 'the tab close: BEFORE the capture charges the card');
  assert.ok(close.indexOf('if (vatGate)') < close.indexOf('if (!confirm('), 'and before the guest is asked to confirm');
});
