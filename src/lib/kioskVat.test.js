// The kiosk books VAT like the till, or it does not sell (8 Oct 2026, VAT audit, Fix 2).
//   no rates refuses payment; the record is always stored; an offer scales UK VAT as the till does;
//   a size is taxed at its own rate (Leeds Babyccino Milk 1.55 at 5% books 0.07, not 0.26);
//   and the wiring pins on KioskApp (the rates loader, the gate around ScreenPay, the write).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kioskVatGate, kioskRatesRetryMs, kioskChargedTax, kioskVenueTax, KIOSK_VAT_WORDS } from './kioskVat.js';
import { kioskVariant, kioskLineTaxRefs, kioskOrderItem } from './kioskLine.js';
import { buildLocalTaxCtx } from './taxCompute.js';
import { assertSaleVat } from './saleVatGuard.js';
import { roundVat } from './taxRule.js';

// Leeds, as the kiosk loads them (raw rows)
const STD = { id: 'r20', name: 'Standard Rate', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'L1' };
const RED = { id: 'r5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', is_default: false, active: true, location_id: 'L1' };
const ZERO = { id: 'r0', name: 'Zero Rate', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'L1' };
const RATES = [STD, RED, ZERO];
const BABYCCINO = { id: 'm-bab', name: 'Babyccino', cat: 'coffee', tax_rate_id: 'r20', tax_overrides: {} };
const MILK = { id: 'm-bab-milk', name: 'Milk', parent_id: 'm-bab', cat: 'coffee', tax_rate_id: 'r5', tax_overrides: {} };
const CHOC = { id: 'm-bab-choc', name: 'Choc', parent_id: 'm-bab', cat: 'coffee', tax_rate_id: null, tax_overrides: {} };
const DONUT = { id: 'm-donut', name: 'Bueno Filled Donut', cat: 'bakery', tax_rate_id: 'r20', tax_overrides: { takeaway: 'r0' } };
const LATTE = { id: 'm-latte', name: 'Latte', cat: 'coffee', tax_rate_id: 'r20', tax_overrides: {} };
const items = [BABYCCINO, MILK, CHOC, DONUT, LATTE];
const ctx = buildLocalTaxCtx({ taxRates: RATES, menuItems: items, menuCategories: [] });

// KioskApp's cart line, and its kioskTaxLines mapping (the totals block)
const cartLine = (item, child, linePrice, qty = 1) => ({ key: `${child?.id || item.id}:{}`, item, variant: kioskVariant(item, child), name: item.name, qty, modsArray: [], linePrice, lineTotal: qty * linePrice });
const taxLine = (l, i) => ({ uid: l.key || `l${i}`, price: l.linePrice, qty: l.qty || 1, itemId: l.variant?.id ?? l.item?.id ?? null, cat: l.item?.cat ?? null, cats: null, ...kioskLineTaxRefs(l) });

test('the gate: loading and failed block; empty blocks when the menu names rates; a venue with no rates is not blocked', () => {
  assert.deepEqual(kioskVatGate({ ratesState: 'loading', items, taxCtx: buildLocalTaxCtx({ taxRates: [], menuItems: items }) }), { code: 'loading', message: KIOSK_VAT_WORDS.loading });
  assert.deepEqual(kioskVatGate({ ratesState: 'error', items, taxCtx: buildLocalTaxCtx({ taxRates: [], menuItems: items }) }), { code: 'failed', message: KIOSK_VAT_WORDS.failed });
  assert.deepEqual(kioskVatGate({ ratesState: 'empty', items, taxCtx: buildLocalTaxCtx({ taxRates: [], menuItems: items }) }), { code: 'failed', message: KIOSK_VAT_WORDS.failed });
  assert.equal(kioskVatGate({ ratesState: 'ok', items, taxCtx: ctx }), null);
  const noRateMenu = [{ id: 'x', name: 'Tea', tax_rate_id: null, tax_overrides: {} }];
  assert.equal(kioskVatGate({ ratesState: 'empty', items: noRateMenu, taxCtx: buildLocalTaxCtx({ taxRates: [], menuItems: noRateMenu }) }), null);
  for (const w of Object.values(KIOSK_VAT_WORDS)) assert.ok(!/[–—]/.test(w), w);
});

test('background retries: 30 s, 60 s, then every 2 minutes', () => {
  assert.deepEqual([0, 1, 2, 7].map(kioskRatesRetryMs), [30000, 60000, 120000, 120000]);
});

test('a size is taxed at its OWN rate when it has one: Babyccino Milk 1.55 at 5% books 0.07, not 0.26', () => {
  const lines = [cartLine(BABYCCINO, MILK, 1.55)].map(taxLine);
  assert.equal(lines[0].taxRateId, 'r5');
  assert.equal(lines[0].itemId, 'm-bab-milk');
  const t = kioskChargedTax(lines, ctx, 'takeaway', { autoDiscounts: [], goods: 1.55, charged: 1.55 });
  assert.equal(roundVat(t.totalTax), 0.07);
  assert.equal(t.breakdown[0].rate.id, 'r5');
  // a size with no rate of its own takes the parent's (the till's rule)
  const choc = taxLine(cartLine(BABYCCINO, CHOC, 1.55), 0);
  assert.equal(choc.taxRateId, 'r20');
  assert.equal(roundVat(kioskChargedTax([choc], ctx, 'takeaway').totalTax), 0.26);
  // the stored order line carries the size's rate, so reports and the guard read it
  const o = kioskOrderItem(cartLine(BABYCCINO, MILK, 1.55));
  assert.equal(o.taxRateId, 'r5');
  assert.deepEqual(o.taxOverrides, {});
});

test('the till rule for overrides on a size: empty size overrides take the parent overrides; own overrides win and do not borrow the parent rate', () => {
  const DONUT_SIZE = { id: 'm-donut-big', name: 'Big', parent_id: 'm-donut', tax_rate_id: null, tax_overrides: {} };
  const inherit = kioskLineTaxRefs(cartLine(DONUT, DONUT_SIZE, 1));
  assert.deepEqual(inherit, { taxRateId: 'r20', taxOverrides: { takeaway: 'r0' }, taxProfileId: null });
  const OWN_OV = { id: 'm-donut-own', name: 'Own', parent_id: 'm-donut', tax_rate_id: null, tax_overrides: { 'dine-in': 'r5' } };
  assert.deepEqual(kioskLineTaxRefs(cartLine(DONUT, OWN_OV, 1)), { taxRateId: null, taxOverrides: { 'dine-in': 'r5' }, taxProfileId: null });
  // an older basket line (no tax fields on the variant) falls to the parent, exactly as before
  const old = { item: DONUT, variant: { id: 'm-donut-big', lineName: 'Donut — Big' } };
  assert.deepEqual(kioskLineTaxRefs(old), { taxRateId: 'r20', taxOverrides: { takeaway: 'r0' }, taxProfileId: null });
  // a plain line takes its item's
  assert.deepEqual(kioskLineTaxRefs(cartLine(LATTE, null, 3)), { taxRateId: 'r20', taxOverrides: {}, taxProfileId: null });
});

test('the per order type override applies on the kiosk: a takeaway donut books 0, eat in books 20%', () => {
  const l = [taxLine(cartLine(DONUT, null, 0.75), 0)];
  assert.equal(roundVat(kioskChargedTax(l, ctx, 'takeaway').totalTax), 0);
  assert.equal(roundVat(kioskChargedTax(l, ctx, 'dine-in').totalTax), 0.13);
});

test('an automatic offer scales UK VAT to what was charged, as the till does; no offer is the same object', () => {
  const lines = [taxLine(cartLine(LATTE, null, 10), 0)];
  const plain = kioskChargedTax(lines, ctx, 'takeaway', { autoDiscounts: [], goods: 10, charged: 10 });
  assert.equal(roundVat(plain.totalTax), 1.67);
  assert.equal(plain.share, undefined);
  const offer = { type: 'amount', value: 2, label: 'Offer' };
  const scaled = kioskChargedTax(lines, ctx, 'takeaway', { autoDiscounts: [offer], goods: 10, charged: 8 });
  assert.equal(roundVat(scaled.totalTax), 1.33);
  assert.equal(scaled.share, 0.8);
  assert.equal(scaled.breakdown[0].tax.toFixed(4), (10 / 6 * 0.8).toFixed(4));
  // without the goods and charged figures (an older caller) the engine result is returned as is
  assert.equal(roundVat(kioskChargedTax(lines, ctx, 'takeaway', { autoDiscounts: [offer] }).totalTax), 1.67);
  // no tax set up, or nothing to tax: null
  assert.equal(kioskChargedTax(lines, buildLocalTaxCtx({ taxRates: [] }), 'takeaway'), null);
  assert.equal(kioskChargedTax([], ctx, 'takeaway'), null);
});

test('the record the kiosk stores: tax_amount rounded once, tax_breakdown always, and the guard passes it untouched', () => {
  const lines = [taxLine(cartLine(LATTE, null, 10.05), 0)];
  const t = kioskChargedTax(lines, ctx, 'takeaway', { autoDiscounts: [], goods: 10.05, charged: 10.05 });
  const row = { id: 'k1', ref: 'K1', location_id: 'L1', order_type: 'takeaway', items: [kioskOrderItem(cartLine(LATTE, null, 10.05))], discounts: [], subtotal: 10.05, tip: 0, total: 10.05,
    tax: roundVat(t?.totalTax) ?? 0, tax_amount: roundVat(t?.totalTax), tax_breakdown: t || null, status: 'paid', source: 'kiosk' };
  assert.equal(row.tax_amount, 1.68);
  assert.equal(row.tax_breakdown.breakdown.length, 1);
  const vat = kioskVenueTax({ taxRates: RATES, taxCtx: ctx });
  assert.equal(vat.hasTaxConfig, true);
  assert.equal(assertSaleVat(row, vat), row);
  // the same sale from a kiosk whose rates never loaded (tax null, no record) is repaired by the guard
  // with the venue's rates, never saved null
  const bare = { ...row, tax: 0, tax_amount: null, tax_breakdown: null };
  const out = assertSaleVat(bare, vat);
  assert.equal(out.tax_amount, 1.68);
  assert.equal(out.tax_breakdown.source, 'repair');
  // and with no rates known at all (kioskVenueTax null) the guard judges nothing
  assert.equal(kioskVenueTax({ taxRates: [], taxCtx: null }), null);
});

// ── wiring pins on KioskApp ────────────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('PIN: the kiosk loads its rates on their own, after the session, with retries, and reports a state', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.doesNotMatch(app, /const \[iRes, cRes, mRes, tRes,/, 'the rates no longer ride the menu Promise.all');
  assert.match(app, /const res = await loadCustomerRates\(\{\n\s*waitForSession: \(\) => ensureAuthToken\(\)\.catch\(\(\) => null\),/);
  assert.match(app, /readRates: \(\) => supabase\.from\('tax_rates'\)\.select\('id, name, rate, type, active, is_default, location_id'\)\.eq\('location_id', locationId\),/);
  assert.match(app, /setRatesState\(res\.status\);/);
  assert.match(app, /kioskRatesRetryMs\(ratesTry\)/);
  assert.match(app, /return \{ \.\.\.data, taxRates: rates, ratesState, retryRates, activeMenuId, loading, error \};/);
});

test('PIN: ScreenPay mounts only inside the VAT gate (under the link gate), in both kiosk designs', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.match(app, /const kioskVatGateState = useMemo\(\(\) => kioskVatGate\(\{ ratesState, items, taxCtx: kioskTaxCtx \}\)/);
  assert.match(app, /<KioskVatGateContext\.Provider value=\{kioskVatGateCtx\}>\n\s*<KioskV2Root engine=\{engine\} ScreenPay=\{LinkedScreenPay\} \/>/);
  assert.match(app, /<KioskPayLinkGate brandColor=\{props\.brandColor\} onBack=\{props\.onBack\} onCancel=\{props\.onCancel\}>\n\s*<KioskVatGate brandColor=\{props\.brandColor\} onBack=\{props\.onBack\} onCancel=\{props\.onCancel\}>\n\s*<ScreenPay \{\.\.\.props\} \/>/);
  assert.match(app, /<KioskPayLinkGate brandColor=\{brandColor\} onBack=\{\(\) => \{ setSubmitError\(null\); setScreen\('gift'\); \}\} onCancel=\{resetSession\}><KioskVatGate brandColor=\{brandColor\}[^\n]*<ScreenPay brandColor=\{brandColor\}/);
  assert.match(app, /<\/KioskVatGate><\/KioskPayLinkGate>\}/);
  // the legacy tree is inside the provider too
  assert.equal((app.match(/<KioskVatGateContext\.Provider value=\{kioskVatGateCtx\}>/g) || []).length, 2);
  assert.equal((app.match(/<\/KioskVatGateContext\.Provider>/g) || []).length, 2);
  const gate = read('../surfaces/kiosk/KioskVatGate.jsx');
  assert.match(gate, /if \(!gate\) return children;/);
  assert.match(gate, /data-kiosk-vat-gate=/);
});

test('PIN: the totals and the record follow the till (size rate, offer scaling, rounded, record always, one writer)', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.match(app, /itemId: l\.variant\?\.id \?\? l\.item\?\.id \?\? null,\n\s*cat: l\.item\?\.cat \?\? null,\n\s*cats: Array\.isArray\(l\.item\?\.cats\) \? l\.item\.cats : null,\n\s*\.\.\.kioskLineTaxRefs\(l\),/);
  assert.match(app, /kioskChargedTax\(kioskTaxLines, kioskTaxCtx, kioskTaxType, \{ autoDiscounts, goods: subtotal, charged: discountedSubtotal \}\)/);
  assert.match(app, /tax: roundVat\(chargedTaxBreakdown\?\.totalTax\) \?\? 0,\n\s*tax_amount: roundVat\(chargedTaxBreakdown\?\.totalTax\),/);
  assert.match(app, /tax_breakdown: chargedTaxBreakdown \|\| null,/);
  assert.doesNotMatch(app, /hasExclusiveTax && Number\(chargedTaxBreakdown\.exclusiveTax\) > 0 \? \{ tax_breakdown/);
  assert.match(app, /const e1 = \(await writeClosedCheckRow\(supabase, checkRow, \{ tag: 'kiosk', vat: kioskVenueTaxCtx \}\)\)\.error;\n\s*if \(e1\) throw e1;/);
  assert.doesNotMatch(app, /supabase\.from\('closed_checks'\)\.insert\(/);
});
