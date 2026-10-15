/**
 * lightspeedSuggest.test.js: "Copy my Lightspeed setup" (30 Sep 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/lightspeedSuggest.test.js`.
 *
 * Pinned: from Lightspeed's own daily invoices in the org (approved invoices with Xero
 * payments, and draft style $0 invoices with payments as negative lines), the helper suggests
 * the site's tracking option (the category Lightspeed used most, the option named like the site
 * without the brand), sales groups and their accounts, tips, discounts, gift card liability,
 * and a clearing account per kind of payment. Only this site's invoices are read when the
 * option is known. Nothing unclear is guessed: with no option naming the site, no payment
 * account is suggested until the person chooses the option and the invoices are read again, and
 * categories go to groups only on an exact name match, each pair listed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestFromLightspeed, suggestTracking, classifyLine, groupNameOf, paymentKindOf, xeroDate,
} from '../../../supabase/functions/_shared/lightspeedSuggest.js';

const ACCOUNTS = [
  { AccountID: 'id-200', Code: '200', Name: 'Sales', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
  { AccountID: 'id-201', Code: '201', Name: 'Coffee sales', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
  { AccountID: 'id-202', Code: '202', Name: 'Food sales', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
  { AccountID: 'id-400', Code: '400', Name: 'Discounts given', Type: 'REVENUE', Class: 'REVENUE', Status: 'ACTIVE' },
  { AccountID: 'id-410', Code: '410', Name: 'Staff food', Type: 'EXPENSE', Class: 'EXPENSE', Status: 'ACTIVE' },
  { AccountID: 'id-825', Code: '825', Name: 'Tips payable', Type: 'CURRLIAB', Class: 'LIABILITY', Status: 'ACTIVE' },
  { AccountID: 'id-830', Code: '830', Name: 'Gift vouchers', Type: 'CURRLIAB', Class: 'LIABILITY', EnablePaymentsToAccount: true, Status: 'ACTIVE' },
  { AccountID: 'id-610', Code: '610', Name: 'Card clearing Leeds', Type: 'CURRENT', Class: 'ASSET', EnablePaymentsToAccount: true, Status: 'ACTIVE' },
  { AccountID: 'id-611', Code: '611', Name: 'Card clearing Huddersfield', Type: 'CURRENT', Class: 'ASSET', EnablePaymentsToAccount: true, Status: 'ACTIVE' },
  { AccountID: 'id-cash', Code: '', Name: 'Cash in till Leeds', Type: 'BANK', Class: 'ASSET', Status: 'ACTIVE' },
];
const TRACKING = [
  { TrackingCategoryID: 'tc-dept', Name: 'Department', Status: 'ACTIVE', Options: [{ TrackingOptionID: 'd1', Name: 'Front', Status: 'ACTIVE' }] },
  { TrackingCategoryID: 'tc-loc', Name: 'Location', Status: 'ACTIVE', Options: [
    { TrackingOptionID: 'o-leeds', Name: 'Leeds', Status: 'ACTIVE' },
    { TrackingOptionID: 'o-hud', Name: 'Huddersfield', Status: 'ACTIVE' },
    { TrackingOptionID: 'o-old', Name: 'Leeds (closed)', Status: 'ARCHIVED' },
  ] },
];
const tr = (opt, id) => [{ TrackingCategoryID: 'tc-loc', Name: 'Location', Option: opt, TrackingOptionID: id }];
const line = (Description, LineAmount, AccountCode, TaxType, opt = 'Leeds', id = 'o-leeds') => ({ Description, LineAmount, UnitAmount: LineAmount, Quantity: 1, AccountCode, TaxType, Tracking: tr(opt, id) });
const contact = { ContactID: 'c-ls', Name: 'Lightspeed Sales' };

// Approved style: sales lines, payments applied as Xero payments.
const approved = (n, date, opt = 'Leeds', id = 'o-leeds', card = '610') => ({
  InvoiceID: `inv-${n}`, InvoiceNumber: `LS-${n}`, Reference: `Lightspeed ${date}`, Status: 'PAID', DateString: `${date}T00:00:00`, Contact: contact,
  LineItems: [
    line('Coffee 20% 28/09/2026', 812.5, '201', 'OUTPUT2', opt, id),
    line('Hot Food 20%', 301.2, '202', 'OUTPUT2', opt, id),
    line('Cold Food 0%', 150, '202', 'ZERORATEDOUTPUT', opt, id),
    line('Discounts', -40.1, '400', 'OUTPUT2', opt, id),
    line('Staff meals', -12, '410', 'OUTPUT2', opt, id),
    line('Tips', 25, '825', 'NONE', opt, id),
    line('Gift voucher sold', 50, '830', 'NONE', opt, id),
  ],
  _card: card,
});
const invoices = [approved(1, '2026-09-20'), approved(2, '2026-09-21'), approved(3, '2026-09-21', 'Huddersfield', 'o-hud', '611')];
const payments = [
  { Invoice: { InvoiceID: 'inv-1' }, Account: { AccountID: 'id-610', Code: '610' }, Amount: 1000, Reference: 'Card payments', Status: 'AUTHORISED' },
  { Invoice: { InvoiceID: 'inv-1' }, Account: { AccountID: 'id-cash' }, Amount: 236.6, Reference: 'Cash', Status: 'AUTHORISED' },
  { Invoice: { InvoiceID: 'inv-2' }, Account: { AccountID: 'id-610', Code: '610' }, Amount: 1100, Reference: 'Visa/Mastercard', Status: 'AUTHORISED' },
  { Invoice: { InvoiceID: 'inv-3' }, Account: { AccountID: 'id-611', Code: '611' }, Amount: 1200, Reference: 'Card payments', Status: 'AUTHORISED' },
];

test('approved invoices: tracking, groups, discounts, tips, gift and clearing from this site only', () => {
  const s = suggestFromLightspeed({
    invoices, payments, accounts: ACCOUNTS, trackingCategories: TRACKING,
    site: { name: 'Coffee Boy Leeds' }, siblings: [{ name: 'Coffee Boy Huddersfield' }],
    categories: [{ id: 'cat-coffee', label: 'Coffee' }, { id: 'cat-hotfood', label: 'Hot food' }, { id: 'cat-cakes', label: 'Cakes' }],
  });
  assert.equal(s.tracking.categoryName, 'Location');
  assert.equal(s.tracking.optionName, 'Leeds');
  assert.equal(s.tracking.optionId, 'o-leeds');
  assert.equal(s.tracking.confidence, 'high');
  assert.deepEqual(s.tracking.options.map((o) => o.name), ['Leeds', 'Huddersfield'], 'archived options are not offered');
  assert.equal(s.source.count, 2, "only this site's invoices");
  assert.deepEqual(s.source.contacts, ['Lightspeed Sales']);
  assert.equal(s.source.from, '2026-09-20');
  assert.equal(s.lastLightspeedDate, '2026-09-21');
  assert.deepEqual(s.groups.map((g) => [g.key, g.name, g.account]), [['coffee', 'Coffee', '201'], ['hot-food', 'Hot Food', '202'], ['cold-food', 'Cold Food', '202']]);
  assert.deepEqual(s.groups[2].taxTypes, ['ZERORATEDOUTPUT']);
  assert.deepEqual(s.discounts.accounts, { customer: '400', staff: '410' });
  assert.equal(s.tipsAccount, '825');
  assert.equal(s.giftLiabilityAccount, '830');
  assert.deepEqual(s.clearing, { card: '610', cash: 'id-cash' }, 'a bank account with no code is named by its id');
  assert.deepEqual(s.categoryGroups, { 'cat-coffee': 'coffee', 'cat-hotfood': 'hot-food' }, 'exact name matches only');
  assert.deepEqual(s.categoryPairs.map((x) => [x.label, x.groupName]), [['Coffee', 'Coffee'], ['Hot food', 'Hot Food']], 'each pair listed for the person to check');
  assert.equal(s.clearingSkipped, false);
});

test("categories never join a group on a shared word (retail beans are not coffee drinks)", () => {
  const s = suggestFromLightspeed({
    invoices, payments, accounts: ACCOUNTS, trackingCategories: TRACKING, site: { name: 'Coffee Boy Leeds' }, siblings: [{ name: 'Coffee Boy Huddersfield' }],
    categories: [{ id: 'cat-beans', label: 'Coffee Beans' }, { id: 'cat-food', label: 'Food' }, { id: 'cat-cold', label: 'Cold food' }],
  });
  assert.deepEqual(s.categoryGroups, { 'cat-cold': 'cold-food' });
});

test('draft style invoices: payments are the negative lines on payment accounts', () => {
  const draft = {
    InvoiceID: 'd-1', InvoiceNumber: 'LS-D1', Status: 'AUTHORISED', Date: '/Date(1790467200000+0000)/', Contact: contact,
    LineItems: [
      line('Coffee', 500, '201', 'OUTPUT2'),
      line('Card', -400, '610', 'NONE'),
      line('Cash', -95, null, 'NONE'),
      line('Rounding', -5, '200', 'NONE'),
    ],
  };
  draft.LineItems[2].AccountID = 'id-cash';
  const s = suggestFromLightspeed({ invoices: [draft], payments: [], accounts: ACCOUNTS, trackingCategories: TRACKING, site: { name: 'Coffee Boy Leeds' }, siblings: [{ name: 'Coffee Boy Huddersfield' }] });
  assert.deepEqual(s.clearing, { card: '610', cash: 'id-cash' });
  assert.deepEqual(s.groups.map((g) => g.key), ['coffee']);
  assert.deepEqual(s.unmatched.map((u) => u.description), ['Rounding'], 'rounding is listed, never mapped');
  assert.equal(s.source.from, xeroDate('/Date(1790467200000+0000)/'));
});

test('no clear site option: no suggestion, the options listed, every invoice read', () => {
  const t = suggestTracking(invoices, TRACKING, 'Coffee Boy Station', [{ name: 'Coffee Boy Leeds' }].map((x) => x.name));
  assert.equal(t.optionName, null);
  assert.equal(t.confidence, 'none');
  assert.equal(t.categoryName, 'Location');
  assert.equal(t.options.length, 2);
  const s = suggestFromLightspeed({ invoices, payments, accounts: ACCOUNTS, trackingCategories: TRACKING, site: { name: 'Coffee Boy Station' }, siblings: [{ name: 'Coffee Boy Leeds' }] });
  assert.equal(s.source.count, 3);
  assert.equal(s.source.siteOnly, false);
  // Every site's invoices: no payment account is suggested (it would be another site's).
  assert.deepEqual(s.clearing, {});
  assert.equal(s.clearingSkipped, true);
  assert.equal(s.giftLiabilityAccount, '830', "the gift card liability is the company's, so it is still suggested");
  assert.equal(suggestFromLightspeed({}).groups.length, 0, 'nothing found, nothing suggested');
});

test("options that do not name the site: nothing site specific until the person picks this site's option", () => {
  // Reviewer's case, 30 Sep: options "LDS City" and "HDF"; Leeds took 150 through 610, Huddersfield
  // 950 through 611. Before, Leeds was offered 611 (the biggest), already ticked.
  const cats = [{ TrackingCategoryID: 'tc-loc', Name: 'Location', Status: 'ACTIVE', Options: [
    { TrackingOptionID: 'o-lds', Name: 'LDS City', Status: 'ACTIVE' }, { TrackingOptionID: 'o-hdf', Name: 'HDF', Status: 'ACTIVE' }] }];
  const inv = [approved(1, '2026-09-20', 'LDS City', 'o-lds', '610'), approved(3, '2026-09-21', 'HDF', 'o-hdf', '611')];
  const pays = [
    { Invoice: { InvoiceID: 'inv-1' }, Account: { AccountID: 'id-610', Code: '610' }, Amount: 150, Reference: 'Card payments', Status: 'AUTHORISED' },
    { Invoice: { InvoiceID: 'inv-3' }, Account: { AccountID: 'id-611', Code: '611' }, Amount: 950, Reference: 'Card payments', Status: 'AUTHORISED' },
  ];
  const args = { invoices: inv, payments: pays, accounts: ACCOUNTS, trackingCategories: cats, site: { name: 'Coffee Boy Leeds' }, siblings: [{ name: 'Coffee Boy Huddersfield' }] };
  const blind = suggestFromLightspeed(args);
  assert.equal(blind.tracking.optionName, null);
  assert.deepEqual(blind.clearing, {}, 'never the other site\'s clearing account');
  assert.equal(blind.clearingSkipped, true);
  // The person picks "LDS City": only those invoices are read, and Leeds' own account is offered.
  const picked = suggestFromLightspeed({ ...args, option: { optionId: 'o-lds' } });
  assert.equal(picked.tracking.optionName, 'LDS City');
  assert.equal(picked.tracking.confidence, 'chosen');
  assert.equal(picked.source.siteOnly, true);
  assert.equal(picked.source.count, 1);
  assert.deepEqual(picked.clearing, { card: '610' });
  assert.equal(picked.clearingSkipped, false);
  // An option that is not in Xero is ignored (the usual match runs).
  assert.equal(suggestFromLightspeed({ ...args, option: { optionName: 'Nowhere' } }).tracking.optionName, null);
});

test('line words: classification, group names, payment kinds, Xero dates', () => {
  const acc = (x) => ACCOUNTS.find((a) => a.Code === x);
  assert.equal(classifyLine({ Description: 'Card', LineAmount: -10 }, acc('610')), 'payment');
  assert.equal(classifyLine({ Description: 'Tips', LineAmount: 5 }, acc('825')), 'tip');
  assert.equal(classifyLine({ Description: 'Gratuities', LineAmount: 5 }, acc('825')), 'tip');
  assert.equal(classifyLine({ Description: 'Service Charge 12.5%', LineAmount: 5 }, acc('200')), 'service');
  assert.equal(classifyLine({ Description: 'Gift card sold', LineAmount: 20 }, acc('830')), 'gift');
  assert.equal(classifyLine({ Description: 'Loyalty reward', LineAmount: 2 }, acc('400')), 'discount');
  assert.equal(classifyLine({ Description: 'Over/short', LineAmount: -1 }, acc('200')), 'unmatched');
  assert.equal(classifyLine({ Description: 'Soft drinks', LineAmount: 30 }, acc('200')), 'sales');
  assert.equal(groupNameOf('Coffee 20% VAT 28/09/2026 Mon'), 'Coffee');
  assert.equal(groupNameOf('Sales - Cold Food (0%)'), 'Cold Food');
  assert.equal(paymentKindOf('Adyen card clearing'), 'card');
  assert.equal(paymentKindOf('Cash in till'), 'cash');
  assert.equal(paymentKindOf('Deliveroo'), 'other:deliveroo');
  assert.equal(paymentKindOf('Uber Eats payouts'), 'other:uber_eats');
  assert.equal(paymentKindOf('Just Eat'), 'other:just_eat');
  assert.equal(paymentKindOf('Something'), null);
  assert.equal(xeroDate('2026-09-29T00:00:00'), '2026-09-29');
  assert.equal(xeroDate(null), null);
});
