// The till gate (8 Oct 2026, VAT audit, Fix 3): a tender never starts on a till that cannot book
// the VAT, and the till keeps re reading its rates until it can. Plus the wiring pins: every card
// start asks the gate first, BEFORE anything is charged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tillVatGate, TILL_VAT_WORDS, taxRatesRetryMs, TAX_RATES_RETRY_MS, afterTaxRatesRead, noRatesAlertDue, NO_RATES_ALERT_KEY } from './tillVatGate.js';

const STD = { id: 'r20', name: 'Standard Rate', rate: 0.2, type: 'inclusive', isDefault: true, active: true, locationId: 'L1' };
const menuWithRates = [{ id: 'a', name: 'Latte', taxRateId: 'r20' }, { id: 'b', name: 'Tea', taxRateId: null }];
const menuWithOverride = [{ id: 'a', name: 'Donut', tax_rate_id: null, tax_overrides: { takeaway: 'r0' } }];
const menuNoRates = [{ id: 'a', name: 'Latte', taxRateId: null, taxOverrides: {} }];

test('shut: the menu names rates and the till holds no tax set up', () => {
  const g = tillVatGate({ taxCtx: { taxRates: [] }, menuItems: menuWithRates });
  assert.deepEqual(g, { code: 'missing', message: TILL_VAT_WORDS.missing });
  assert.deepEqual(tillVatGate({ taxCtx: null, menuItems: menuWithOverride }), { code: 'missing', message: TILL_VAT_WORDS.missing });
  assert.deepEqual(tillVatGate({ taxRates: [], menuItems: menuWithRates }), { code: 'missing', message: TILL_VAT_WORDS.missing });
});

test('open: the till holds rates (or a profiles context), or the menu names no rate at all', () => {
  assert.equal(tillVatGate({ taxCtx: { taxRates: [STD] }, menuItems: menuWithRates }), null);
  assert.equal(tillVatGate({ taxRates: [STD], menuItems: menuWithRates }), null);
  assert.equal(tillVatGate({ taxCtx: { taxRates: [] }, menuItems: menuNoRates }), null);
  assert.equal(tillVatGate({ taxCtx: null, menuItems: [] }), null);
  assert.equal(tillVatGate(), null);
  // an inactive rate is not a rate the till can charge with
  assert.equal(tillVatGate({ taxCtx: { taxRates: [{ ...STD, active: false }] }, menuItems: menuWithRates })?.code, undefined);
});

test('the words are plain and carry no dashes', () => {
  for (const w of Object.values(TILL_VAT_WORDS)) {
    assert.ok(!/[–—]/.test(w), w);
    assert.ok(w.length < 260);
  }
  assert.match(TILL_VAT_WORDS.missing, /Nothing has been charged/);
  assert.match(TILL_VAT_WORDS.missing, /Try again/);
});

test('the retry schedule: quick first, then patient, then every five minutes for ever', () => {
  assert.deepEqual([0, 1, 2, 3].map(taxRatesRetryMs), [...TAX_RATES_RETRY_MS]);
  assert.equal(taxRatesRetryMs(4), 300000);
  assert.equal(taxRatesRetryMs(99), 300000);
  assert.equal(taxRatesRetryMs(-1), TAX_RATES_RETRY_MS[0]);
  assert.equal(taxRatesRetryMs('x'), TAX_RATES_RETRY_MS[0]);
});

test('after a read: retry while the gate is shut; alert only on a trusted EMPTY answer at a venue that names rates', () => {
  // the till can book VAT: nothing to do
  assert.deepEqual(afterTaxRatesRead({ res: { data: [STD], error: null }, trusted: true, expectsRates: true, hasTaxConfig: true }), { retry: false, alert: false });
  // the menu names no rate: nothing to do, whatever the read said
  assert.deepEqual(afterTaxRatesRead({ res: { data: null, error: new Error('x') }, trusted: true, expectsRates: false, hasTaxConfig: false }), { retry: false, alert: false });
  // a failed read: retry, no alert (the venue may well have rates)
  assert.deepEqual(afterTaxRatesRead({ res: { data: null, error: new Error('x') }, trusted: true, expectsRates: true, hasTaxConfig: false }), { retry: true, alert: false });
  assert.deepEqual(afterTaxRatesRead({ res: null, trusted: false, expectsRates: true, hasTaxConfig: false }), { retry: true, alert: false });
  // an empty answer from a session the database answers truthfully: the venue has none, alert the owner
  assert.deepEqual(afterTaxRatesRead({ res: { data: [], error: null }, trusted: true, expectsRates: true, hasTaxConfig: false }), { retry: true, alert: true });
  // an empty answer with no trusted session proves nothing: retry, no alert
  assert.deepEqual(afterTaxRatesRead({ res: { data: [], error: null }, trusted: false, expectsRates: true, hasTaxConfig: false }), { retry: true, alert: false });
});

test('one alert a day', () => {
  assert.equal(noRatesAlertDue(null, '2026-10-08'), true);
  assert.equal(noRatesAlertDue('2026-10-07', '2026-10-08'), true);
  assert.equal(noRatesAlertDue('2026-10-08', '2026-10-08'), false);
  assert.equal(NO_RATES_ALERT_KEY, 'rpos-no-tax-rates-alert-day');
});

// ── wiring pins ────────────────────────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('PIN: the store exposes the gate and the re read, and judges every boot read', () => {
  const store = read('../store/index.js');
  assert.match(store, /vatGate: \(\) => tillVatGate\(\{ taxCtx: get\(\)\.getTaxContext\(\), menuItems: get\(\)\.menuItems \|\| \[\] \}\),/);
  assert.match(store, /refreshTaxRates: async \(\{ attempt = 0 \} = \{\}\) => \{/);
  assert.match(store, /set\(s => \(\{ taxRates: ratesAfterRead\(rows, locationId, s\.taxRates, \{ trusted \}\) \}\)\);/, 'the re read follows the one rule for an empty answer');
  assert.match(store, /afterTaxRatesRead: \(\{ res = null, trusted = false, attempt = 0 \} = \{\}\) => \{/);
  assert.match(store, /taxRatesRetryMs\(attempt\)/);
  assert.match(store, /noTaxRatesAlert\(\{ trusted: true, rateCount: 0/);
  const sync = read('../sync/SyncBridge.jsx');
  assert.match(sync, /useStore\.getState\(\)\.afterTaxRatesRead\?\.\(\{ res: taxRes, trusted: ratesTrusted \}\)/);
});

test('PIN: every card start on the till asks the gate BEFORE anything is charged', () => {
  const modal = read('../surfaces/CheckoutModal.jsx');
  // the checkout is replaced by the panel while shut: no tender of any kind starts
  assert.match(modal, /const \[vatGate, setVatGate\] = useState\(\(\) => useStore\.getState\(\)\.vatGate\?\.\(\) \|\| null\);/);
  assert.match(modal, /if \(vatGate\) \{\n\s*return \(\n\s*<div className="modal-back">/);
  assert.ok(modal.indexOf('if (vatGate) {') < modal.indexOf('{/* ── v5.6.75/76: money already taken on the card reader'), 'the panel comes before the checkout render');
  // the belt in the card job start, after the link gate and before the gift commit and the create
  const start = modal.slice(modal.indexOf('const startTerminalJob = async () => {'));
  const gate = start.indexOf('const vatGateNow = useStore.getState().vatGate?.();');
  assert.ok(gate > 0 && gate > start.indexOf('await confirmLinkBeforeCard()') && gate < start.indexOf('await dispatchTerminalJob({'));
  assert.ok(gate < start.indexOf('commitGift(giftRef.current'), 'before the gift card is debited');
  // the bar tab held card capture
  const bar = read('../surfaces/BarSurface.jsx');
  const cap = bar.slice(bar.indexOf('const captureHeldTab = async (tab) => {'));
  assert.ok(cap.indexOf("const vatGate = useStore.getState().vatGate?.();") < cap.indexOf("setHoldCloseState('capturing')"));
  // Orders Hub: the QR tab force close (and its short close) and the single order force close
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.equal((hub.match(/const vatGate = useStore\.getState\(\)\.vatGate\?\.\(\);/g) || []).length, 2);
  const qr = hub.slice(hub.indexOf('const forceCloseQrTab = async (tab) => {'));
  assert.ok(qr.indexOf('const vatGate = useStore.getState().vatGate?.();') < qr.indexOf('if (shortTab) { await closeShortQrTab(tab, shortTab); return; }'));
  // MPOS: before the tender opens and before the card flow starts
  const mpos = read('../surfaces/MPOSSurface.jsx');
  assert.equal((mpos.match(/const vatGate = useStore\.getState\(\)\.vatGate\?\.\(\);/g) || []).length, 2);
  const take = mpos.slice(mpos.indexOf('onTakePayment={() => {'));
  assert.ok(take.indexOf('const vatGate = useStore.getState().vatGate?.();') < take.indexOf("setFlow({ screen: 'tender', context: flow.context || {} });"), 'before the tender opens');
  const confirm = mpos.slice(mpos.indexOf('onConfirm={(payment) => {'));
  assert.ok(confirm.indexOf('const vatGate = useStore.getState().vatGate?.();') < confirm.indexOf("setFlow(f => ({ screen: 'card'"), 'before the card flow starts');
});
