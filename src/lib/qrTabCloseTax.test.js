// qrTabCloseTax.test.js: a QR tab the guest closes on their own phone books its VAT.
// Run: `npm test`, or `node --test src/lib/qrTabCloseTax.test.js`.
//
// 27 Sep 2026: TabResumeScreen wrote tax_amount: null, and since the fence (20 Sep) the check is
// written by settle_qr_tab on the server, which never set it either. The phone now works the VAT
// out from the rows the page already loaded (buildLocalTaxCtx, menu, rates) with qrCloseTax, books
// it on its fallback write, and hands it to settle_qr_tab (migration 20260927c books it, clamped).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qrTabCloseFields, qrTabSettleVat } from './headlessTax.js';
import { buildLocalTaxCtx, taxCtxHasConfig } from './taxCompute.js';
import { toStoreRate } from './venueTaxRates.js';
import { settleQrTabWithFallback } from './publicOrder.js';

const std = toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'leeds' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const salesTax = toStoreRate({ id: 'us', name: 'Sales Tax', code: 'US', rate: 0.1, type: 'exclusive', is_default: true, active: true, location_id: 'provo' });

const menuItems = [
  { id: 'burger', name: 'Burger', price: 10, taxRateId: 'std', taxOverrides: {} },
  { id: 'cake', name: 'Cake', price: 6, taxRateId: 'zero', taxOverrides: {} },
];
// The page's own context, built the way OnlineSurface builds it from the rows it fetched.
const pageCtx = (taxRates, items = menuItems) => {
  const taxCtx = buildLocalTaxCtx({ taxProfiles: [], menuItems: items, menuCategories: [], venueDefaultProfileId: null, taxRates });
  return { menuItems: items, taxRates, taxCtx, hasTaxConfig: taxCtxHasConfig(taxCtx) };
};

// Two rounds as order_queue keeps them: base price, mods apart, no tax fields; each round's tip
// on its customer, and runningTotal = the round totals, tips included.
const rounds = () => ([
  { ref: 'QR-1', location_id: 'leeds', total: 13, customer: { tip: 1 },
    items: [{ itemId: 'burger', name: 'Burger', price: 10, qty: 1, mods: [{ name: 'Cheese', price: 1 }, { name: 'Bacon', price: 0.5, qty: 2 }] }] },
  { ref: 'QR-2', location_id: 'leeds', total: 6, customer: {},
    items: [{ itemId: 'cake', name: 'Cake', price: 6, qty: 1, mods: [] }] },
]);

test('a UK tab books its VAT: modifiers folded in, each product at its own rate', () => {
  const f = qrTabCloseFields(rounds(), 19, pageCtx([std, zero]));
  assert.equal(f.tip, 1);
  assert.equal(f.subtotal, 18, '£19 charged less the £1 tip, exactly as the check booked before');
  assert.equal(f.taxAmount, 2, '£12 burger (with its modifiers) at 20% = £2.00; the zero rated cake adds nothing');
  // 8 Oct 2026: the record goes with it for a UK whole tab too (the split by rate for Xero).
  assert.equal(f.taxBreakdown.totalTax, 2);
  assert.equal(f.taxBreakdown.breakdown[0].rate.id, 'std');
  assert.equal(f.exclusiveTax, 0);
});

test('without the page rows (or no tax set up): null, exactly the old record', () => {
  const none = qrTabCloseFields(rounds(), 19, {});
  assert.equal(none.taxAmount, null);
  assert.equal(none.subtotal, 18);
  assert.equal(none.tip, 1);
  assert.equal(qrTabCloseFields(rounds(), 19, pageCtx([])).taxAmount, null);
  assert.equal(qrTabCloseFields(null, 0, pageCtx([std])).taxAmount, null);
});

test('added-on (US) tax: the round totals include it, so it comes out of the subtotal', () => {
  const us = [{ ref: 'QR-9', total: 22, customer: {}, items: [{ itemId: 'x', name: 'Steak', price: 20, qty: 1, mods: [] }] }];
  const f = qrTabCloseFields(us, 22, pageCtx([salesTax], []));
  assert.equal(f.exclusiveTax, 2);
  assert.equal(f.taxAmount, 2);
  assert.equal(f.subtotal, 20);
  assert.equal(f.taxBreakdown.hasExclusiveTax, true);
});

test('what the phone hands settle_qr_tab: two numbers, or nothing', () => {
  assert.deepEqual(qrTabSettleVat({ taxAmount: 2, exclusiveTax: 0 }), { tax_amount: 2, exclusive_tax: 0 });
  assert.deepEqual(qrTabSettleVat({ taxAmount: 1.204, exclusiveTax: 1.204 }), { tax_amount: 1.2, exclusive_tax: 1.2 });
  assert.deepEqual(qrTabSettleVat({ taxAmount: null, exclusiveTax: 0 }), {});
  assert.deepEqual(qrTabSettleVat(null), {});
  assert.deepEqual(qrTabSettleVat({ taxAmount: NaN }), {});
});

test('the VAT reaches settle_qr_tab in p_check', async () => {
  const calls = [];
  const rpc = async (name, args) => { calls.push({ name, args }); return { data: { ok: true, closed: 2, check_id: 'chk-qr-1' }, error: null }; };
  const vat = qrTabCloseFields(rounds(), 19, pageCtx([std, zero]));
  await settleQrTabWithFallback({
    rpc, locationId: 'leeds', paymentIntentId: 'pi_1', proofIds: [],
    check: { table_label: 'Table 4', ...qrTabSettleVat(vat) }, legacySettle: async () => ({ ok: true }),
  });
  const call = calls.find((c) => c.name === 'settle_qr_tab');
  assert.ok(call, 'settle_qr_tab was called');
  const sent = Object.values(call.args).find((v) => v && typeof v === 'object' && !Array.isArray(v) && 'table_label' in v);
  assert.deepEqual(sent, { table_label: 'Table 4', tax_amount: 2, exclusive_tax: 0 });
});

test('wiring: the phone close books the VAT on its own write and hands it to the server', () => {
  const src = fs.readFileSync(new URL('../surfaces/qr/TabResumeScreen.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /tax_amount: null/);
  assert.match(src, /import \{ qrTabCloseFields, qrTabSettleVat \} from '\.\.\/\.\.\/lib\/headlessTax';/);
  assert.match(src, /const vat = qrTabCloseFields\(rounds, runningTotal, \{ menuItems, taxRates, taxCtx, hasTaxConfig: taxCtxHasConfig\(taxCtx\) \}\);/);
  assert.match(src, /subtotal: vat\.subtotal,/);
  assert.match(src, /tax_amount: vat\.taxAmount,/);
  assert.match(src, /\.\.\.\(vat\.taxBreakdown \? \{ tax_breakdown: vat\.taxBreakdown \} : \{\}\),/);
  assert.match(src, /check: \{ table_label: tableLabelForCheck, \.\.\.qrTabSettleVat\(vat\) \}/);
  assert.match(src, /taxCtx = null, menuItems = \[\], taxRates = \[\],/);
  // The page hands it the rows it already loaded (its own buildLocalTaxCtx, every live menu row, the rates).
  const page = fs.readFileSync(new URL('../surfaces/online/OnlineSurface.jsx', import.meta.url), 'utf8');
  const mount = page.slice(page.indexOf('<TabResumeScreen'), page.indexOf('/>', page.indexOf('<TabResumeScreen')));
  assert.match(mount, /taxCtx=\{taxCtx\}/);
  assert.match(mount, /menuItems=\{items\}/);
  assert.match(mount, /taxRates=\{taxRates\}/);
  assert.match(page, /const taxCtx = useMemo\(\(\) => buildLocalTaxCtx\(\{/);
});

test('the server file books it: 20260927c reads the two numbers from p_check', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20260927c_OPS_settle_qr_tab_vat.sql', import.meta.url), 'utf8');
  assert.match(sql, /jsonb_typeof\(p_check -> 'tax_amount'\) = 'number'/);
  assert.match(sql, /jsonb_typeof\(p_check -> 'exclusive_tax'\) = 'number'/);
  assert.match(sql, /'tax_amount', v_tax,/);
  assert.match(sql, /'subtotal', greatest\(0, v_booked - v_tip - v_added\),/);
});
