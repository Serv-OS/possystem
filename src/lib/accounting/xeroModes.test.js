/**
 * xeroModes.test.js: switching a site to the daily sales invoice safely (30 Sep 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroModes.test.js`.
 *
 * Pinned:
 *   1. dayModel: a day is never mixed. What an earlier attempt sent decides (Receive or Spend
 *      Money: the older model; an invoice or payment: the new one); a day posted the old way
 *      stays; with nothing sent, the site's post_mode and start day decide.
 *   2. The Ready checklist: each item passes and fails on its own facts; checking figures lapses
 *      when the choices change.
 *   3. validateInvoiceMapping refuses bad codes, keys, accounts, and the fee bill or cash variance.
 *   4. Site safety in the older posting (phase 0): the site name is in every reference and line,
 *      transaction keys are unchanged, a demo with no site posts exactly as before, and a
 *      transaction found by reference is adopted only when it is this site's own.
 *   5. Shared Xero sign ins: the Xero user is read from the access token, and a venue whose own
 *      refresh failed takes the newest set of a sibling on the same tenant and user only.
 *   6. The edge functions ship the new files, and the pure files import nothing from outside.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dayModel, invoiceReadiness, validateInvoiceMapping, mappingHash, adoptable as adoptableReexport,
} from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { planXeroDay, adoptable } from '../../../supabase/functions/_shared/xeroPostingPlan.js';
import { buildAccountingDay } from '../../../supabase/functions/_shared/accountingDay.js';
import { xeroUserIdFromToken, pickTokenDonor, tokenFamily } from '../../../supabase/functions/_shared/xeroTokens.js';
import { sharedDepsOf } from '../../../scripts/edgeFnDeps.mjs';
import { UK, DAY, UK_TAX, saleRows, refundRows, mapping, DETAIL } from './xeroInvoiceFixtures.js';

const row = (keys, extra = {}) => ({ status: extra.status || 'partial', detail: { postings: Object.fromEntries(keys.map((k) => [k, { status: 'posted' }])), ...(extra.detail || {}) } });

test('dayModel: never mixed; the earlier attempt decides, then post_mode and the start day', () => {
  // Nothing posted yet.
  assert.equal(dayModel(null, 'invoice', null, '2026-10-01'), 'bank_tx', "every live row holds the unused legacy 'invoice'");
  assert.equal(dayModel(null, null, null, '2026-10-01'), 'bank_tx');
  assert.equal(dayModel(null, 'sales_invoice', null, '2026-10-01'), 'bank_tx', 'no start day, no switch');
  assert.equal(dayModel(null, 'sales_invoice', '2026-10-01', '2026-09-30'), 'bank_tx', 'before the start day');
  assert.equal(dayModel(null, 'sales_invoice', '2026-10-01', '2026-10-01'), 'sales_invoice');
  assert.equal(dayModel({ status: 'error', detail: { notReady: [{}] } }, 'sales_invoice', '2026-10-01', '2026-10-02'), 'sales_invoice', 'a blocked attempt sent nothing');
  // Half posted the old way finishes the old way, whatever the setting says now.
  assert.equal(dayModel(row(['RECEIVE:6026f133']), 'sales_invoice', '2026-09-01', '2026-10-02'), 'bank_tx');
  assert.equal(dayModel(row(['SPEND:x']), 'sales_invoice', '2026-09-01', '2026-10-02'), 'bank_tx');
  // Half posted as an invoice finishes as an invoice, even after switching back.
  assert.equal(dayModel(row(['INVOICE']), 'invoice', null, '2026-10-02'), 'sales_invoice');
  assert.equal(dayModel(row(['PAY:CARDCLR']), 'invoice', null, '2026-10-02'), 'sales_invoice');
  assert.equal(dayModel(row(['CREDIT']), 'invoice', null, '2026-10-02'), 'sales_invoice');
  // A day posted before v5.9.11 (UTC, ok with no postings) is the older model.
  assert.equal(dayModel({ status: 'ok', detail: {} }, 'sales_invoice', '2026-09-01', '2026-10-02'), 'bank_tx');
});

const ACCOUNTS = [
  { id: 'a200', code: '200', name: 'Sales', type: 'REVENUE', cls: 'REVENUE' },
  { id: 'a201', code: '201', name: 'Hot drinks', type: 'REVENUE', cls: 'REVENUE' },
  { id: 'a202', code: '202', name: 'Food', type: 'SALES', cls: 'REVENUE' },
  { id: 'a401', code: '401', name: 'Discounts', type: 'REVENUE', cls: 'REVENUE' },
  { id: 'a402', code: '402', name: 'Staff', type: 'REVENUE', cls: 'REVENUE' },
  { id: 'a825', code: '825', name: 'Tips payable', type: 'CURRLIAB', cls: 'LIABILITY' },
  { id: 'a830', code: '830', name: 'Gift card liability', type: 'CURRLIAB', cls: 'LIABILITY', pay: true },
  { id: 'aclr', code: 'CARDCLR', name: 'Card clearing Leeds', type: 'CURRENT', cls: 'ASSET', pay: true },
  { id: 'acash', code: 'CASHTILL', name: 'Cash in till Leeds', type: 'BANK', cls: 'ASSET' },
  { id: 'aexp', code: '310', name: 'Cost of sales', type: 'DIRECTCOSTS', cls: 'EXPENSE' },
];
const TRACKING = [{ id: 'tc-1', name: 'Location', status: 'ACTIVE', options: [{ id: 'to-leeds', name: 'Leeds', status: 'ACTIVE' }, { id: 'to-hud', name: 'Huddersfield', status: 'ACTIVE' }] }];
const SEEN = { groups: ['hot-drinks', 'food', 'other'], discountGroups: ['customer', 'staff'], moneyKeys: ['card:adyen', 'cash'], tips: true, service: false, gift: false };

function readyMapping(extra = {}) {
  const m = mapping({ invoiceStartDate: '2026-10-01', ...extra });
  m.figuresChecked = { date: '2026-09-29', at: 'x', by: 'u', hash: mappingHash(m) };
  return m;
}

test('the Ready checklist passes when every item is set, and names what is missing', () => {
  const ctx = { accounts: ACCOUNTS, tracking: TRACKING, orgCurrency: 'GBP', venueCurrency: 'GBP', siblings: [{ locationId: 'hud', name: 'Coffee Boy Huddersfield', code: 'HUDDERSFIELD', clearing: {} }], seen: SEEN, taxBlocked: [] };
  const ok = invoiceReadiness(readyMapping(), ctx);
  assert.equal(ok.ready, true, JSON.stringify(ok.items.filter((i) => !i.ok)));
  assert.deepEqual(ok.items.map((i) => i.key), ['site', 'currency', 'tracking', 'groups', 'discounts', 'tips', 'clearing', 'vat', 'figures', 'start']);

  const fails = (m, c = ctx) => invoiceReadiness(m, c).items.filter((i) => !i.ok).map((i) => i.key);
  assert.deepEqual(fails(readyMapping({ site: { name: 'Coffee Boy Leeds', code: 'HUDDERSFIELD' } })), ['site'], 'a code another site on this Xero uses');
  assert.deepEqual(fails(readyMapping({ site: { name: 'Coffee Boy Leeds', code: 'le' } })), ['site']);
  assert.deepEqual(fails(readyMapping(), { ...ctx, orgCurrency: 'USD' }), ['currency']);
  assert.deepEqual(fails(readyMapping({ tracking: { none: true } })), ['tracking'], 'no tracking only when alone on the org');
  assert.deepEqual(fails(readyMapping({ tracking: { none: true } }), { ...ctx, siblings: [] }), []);
  assert.deepEqual(fails(readyMapping({ tracking: { categoryId: 'tc-1', categoryName: 'Location', optionId: 'gone', optionName: 'Leeds old' } })), ['tracking']);
  assert.deepEqual(fails(readyMapping({ groups: { 'hot-drinks': { name: 'Hot drinks', account: '201' } } })), ['groups'], 'food sold with no account');
  assert.deepEqual(fails(readyMapping({ otherSalesAccount: '825' })), ['groups'], 'Other sales must be an income account');
  assert.deepEqual(fails(readyMapping({ discounts: { accounts: { customer: '401' } } })), ['discounts']);
  assert.deepEqual(fails(readyMapping({ tipsAccount: '' })), ['tips']);
  assert.deepEqual(fails(readyMapping({ serviceAccount: '' }), { ...ctx, seen: { ...SEEN, service: true } }), ['tips'], 'service taken with no account');
  assert.deepEqual(fails(readyMapping({ serviceAccount: '' })), [], 'no service taken: no service account needed');
  assert.deepEqual(fails(readyMapping({ clearing: { card: 'CARDCLR' } })), ['clearing']);
  assert.deepEqual(fails(readyMapping({ clearing: { card: '310', cash: 'CASHTILL' } })), ['clearing'], 'an expense account cannot take payments');
  assert.deepEqual(fails(readyMapping({ giftLiabilityAccount: '825' }), { ...ctx, seen: { ...SEEN, gift: true } }), ['gift'], 'the gift liability must take payments');
  assert.deepEqual(fails(readyMapping(), { ...ctx, taxBlocked: [{ key: 'rate:r5', name: 'Reduced', pct: 5 }] }), ['vat']);
  assert.deepEqual(fails({ ...readyMapping(), invoiceStartDate: undefined }), ['start']);

  // Figures checked lapse when a choice changes, not when the start day or the tick itself does.
  const m = readyMapping();
  const changed = { ...m, tipsAccount: '826' };
  assert.deepEqual(fails(changed, { ...ctx, accounts: [...ACCOUNTS, { id: 'x', code: '826', name: 'Svc', type: 'CURRLIAB', cls: 'LIABILITY' }] }), ['figures']);
  assert.equal(mappingHash({ ...m, invoiceStartDate: '2027-01-01', figuresChecked: null }), mappingHash(m));

  // At post time only the mapping is known: Xero facts are skipped, never failed.
  const postTime = invoiceReadiness(readyMapping(), { seen: SEEN });
  assert.equal(postTime.ready, true);
  assert.ok(!postTime.items.some((i) => i.key === 'currency' || i.key === 'vat'));

  // Warnings only.
  const w = invoiceReadiness(readyMapping(), { ...ctx, siblings: [{ name: 'Coffee Boy Huddersfield', code: 'HUDDERSFIELD', clearing: { card: 'CARDCLR' } }], seen: { ...SEEN, deposits: true, unresolvedShare: 0.1 }, lightspeedLastDate: '2026-10-05' });
  assert.equal(w.ready, true);
  assert.deepEqual(w.warnings.map((x) => x.code), ['clearing_shared', 'deposits_seen', 'unresolved_categories', 'lightspeed_overlap']);
});

test('validateInvoiceMapping', () => {
  assert.equal(validateInvoiceMapping(null), null);
  assert.equal(validateInvoiceMapping(mapping({ invoiceStartDate: '2026-10-01' })), null);
  assert.match(validateInvoiceMapping([]), /set of choices/);
  assert.match(validateInvoiceMapping({ site: { code: 'leeds' } }), /capital letters/);
  assert.match(validateInvoiceMapping({ site: { code: 'A' } }), /2 to 12/);
  assert.match(validateInvoiceMapping({ groups: { 'Hot Drinks': { name: 'x', account: '200' } } }), /sales group key/);
  assert.match(validateInvoiceMapping({ groups: { hot: { name: 'x'.repeat(81), account: '200' } } }), /80 characters/);
  assert.match(validateInvoiceMapping({ groups: { hot: { name: 'Hot', account: 'bad"code' } } }), /account for the sales group/);
  assert.match(validateInvoiceMapping({ categoryGroups: { c1: 'NOT VALID' } }), /category/);
  assert.match(validateInvoiceMapping({ discounts: { accounts: { vip: '401' } } }), /discount account/);
  assert.match(validateInvoiceMapping({ discounts: { labels: { Gym: 'vip' } } }), /discount label/);
  assert.match(validateInvoiceMapping({ clearing: { cash: '<script>' } }), /payment account/);
  assert.match(validateInvoiceMapping({ tipsAccount: '{}' }), /tips/);
  assert.match(validateInvoiceMapping({ invoiceStartDate: 'soon' }), /start day/);
  assert.match(validateInvoiceMapping({ taxRateMap: { r20: 'INPUT2' } }), /VAT on Income/, 'the VAT checks still apply');
});

test('the older posting names the site in every reference and line; keys unchanged; no site posts as before', () => {
  const summary = buildAccountingDay({ day: DAY, saleRows: saleRows(), refundRows: refundRows(), venue: UK, taxRates: UK_TAX });
  const m = { paymentMap: { card: '6026f133-3895-4787-9b7a-31497b0d8fc9', cash: '7785f1b2-11b4-4352-b2f4-e3dfa4f5e86f' } };
  const before = planXeroDay(summary, { mapping: m, detail: DETAIL });
  const after = planXeroDay(summary, { mapping: m, detail: DETAIL, site: { name: 'Coffee Boy Leeds' } });
  assert.deepEqual(after.transactions.map((t) => t.key), before.transactions.map((t) => t.key), 'half posted days still finish');
  assert.equal(before.transactions[0].reference, 'ServOS takings 2026-09-29 (6026f133)', 'no site: exactly as before');
  assert.equal(before.transactions[0].payload.LineItems[0].Description, 'Sales 2026-09-29 (card) 20%');
  assert.equal(after.transactions[0].reference, 'ServOS takings Coffee Boy Leeds 2026-09-29 (6026f133)');
  for (const t of after.transactions) {
    assert.ok(t.payload.Reference.includes('Coffee Boy Leeds'), t.payload.Reference);
    for (const li of t.payload.LineItems) assert.ok(li.Description.includes('Coffee Boy Leeds'), li.Description);
  }
  assert.deepEqual(after.transactions.map((t) => t.totals), before.transactions.map((t) => t.totals));
  const hud = planXeroDay(summary, { mapping: m, detail: DETAIL, site: { name: 'Coffee Boy Huddersfield' } });
  assert.notEqual(hud.transactions[0].reference, after.transactions[0].reference, 'two sites on one org never share a reference');
});

test('adoptable: only this site, and an older reference only when no other site shares the org', () => {
  assert.equal(adoptableReexport, adoptable);
  const mine = 'ServOS takings Coffee Boy Leeds 2026-09-29 (6026f133)';
  const oldRef = 'ServOS takings 2026-09-28 (6026f133)';
  assert.equal(adoptable({ Reference: mine }, { expectedRef: mine, siteName: 'Coffee Boy Leeds', siblingCount: 1 }), 'adopt');
  assert.equal(adoptable({ Reference: mine }, { expectedRef: 'ServOS takings Coffee Boy Huddersfield 2026-09-29 (6026f133)', siteName: 'Coffee Boy Huddersfield', siblingCount: 1 }), 'none');
  assert.equal(adoptable({ Reference: oldRef }, { expectedRef: oldRef, siteName: 'Coffee Boy Leeds', siblingCount: 1 }), 'ambiguous', 'the 28 Sep references were identical at both sites');
  assert.equal(adoptable({ Reference: oldRef }, { expectedRef: oldRef, siteName: 'Coffee Boy Leeds', siblingCount: 0 }), 'adopt');
  assert.equal(adoptable(null, { expectedRef: mine }), 'none');
});

const jwt = (claims) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

test('shared Xero sign ins: the Xero user from the token, and the newest sibling set on the same tenant and user', () => {
  assert.equal(xeroUserIdFromToken(jwt({ xero_userid: 'u-1', sub: 'x' })), 'u-1');
  assert.equal(xeroUserIdFromToken('not a token'), null);
  assert.equal(xeroUserIdFromToken(jwt({ sub: 'x' })), null);
  const self = { location_id: 'leeds', tenant_id: 'T', access_token: jwt({ xero_userid: 'u-1' }), refresh_token: 'r-old', updated_at: '2026-09-29T10:10:00Z' };
  const rows = [
    self,
    { location_id: 'hud', tenant_id: 'T', access_token: jwt({ xero_userid: 'u-1' }), refresh_token: 'r-new', updated_at: '2026-09-30T01:39:00Z' },
    { location_id: 'hud-older', tenant_id: 'T', access_token: jwt({ xero_userid: 'u-1' }), refresh_token: 'r-mid', updated_at: '2026-09-29T12:00:00Z' },
    { location_id: 'other-user', tenant_id: 'T', access_token: jwt({ xero_userid: 'u-2' }), refresh_token: 'r-x', updated_at: '2026-09-30T05:00:00Z' },
    { location_id: 'other-org', tenant_id: 'T2', access_token: jwt({ xero_userid: 'u-1' }), refresh_token: 'r-y', updated_at: '2026-09-30T06:00:00Z' },
  ];
  assert.deepEqual(tokenFamily(rows, self).map((r) => r.location_id), ['hud', 'hud-older']);
  assert.equal(pickTokenDonor(rows, self).location_id, 'hud');
  assert.equal(pickTokenDonor([self, { ...rows[1], refresh_token: 'r-old' }], self), null, 'already the same set');
  assert.equal(pickTokenDonor(rows, { ...self, access_token: 'bad' }), null, 'unknown user: never borrow');
});

test('the edge functions ship the new files; the pure files import nothing from outside', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const io = {
    read: (p) => fs.readFileSync(path.join(root, p), 'utf8'),
    exists: (p) => { try { return fs.statSync(path.join(root, p)).isFile(); } catch { return false; } },
    list: (d) => { try { return fs.readdirSync(path.join(root, d)); } catch { return []; } },
  };
  const sales = sharedDepsOf('xero-sales', io);
  for (const f of ['accountingGroups.js', 'xeroInvoicePlan.js', 'xeroInvoicePost.ts', 'xeroTokens.js', 'xeroPostingPlan.js']) {
    assert.ok(sales.includes(`supabase/functions/_shared/${f}`), `xero-sales ships ${f}`);
  }
  const config = sharedDepsOf('xero-config', io);
  for (const f of ['accountingGroups.js', 'xeroInvoicePlan.js', 'lightspeedSuggest.js', 'xeroTokens.js']) {
    assert.ok(config.includes(`supabase/functions/_shared/${f}`), `xero-config ships ${f}`);
  }
  assert.ok(sharedDepsOf('xero-connect', io).includes('supabase/functions/_shared/xeroTokens.js'));
  assert.ok(sharedDepsOf('xero-bills', io).includes('supabase/functions/_shared/xeroTokens.js'));
  for (const f of ['accountingGroups.js', 'xeroInvoicePlan.js', 'lightspeedSuggest.js', 'xeroTokens.js']) {
    assert.doesNotMatch(io.read(`supabase/functions/_shared/${f}`), /from\s+['"](?!\.\/)/, `${f} has no outside imports`);
  }
});
