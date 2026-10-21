// src/lib/stock/supplierListRules.test.js: the words and small rules of the company Suppliers
// screens (multi site stock Drop 1, contract 3.4 and 4.3). Synthetic names and amounts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moneyText, spendText, dayMonth, nextPriceText, spreadText, vatText, unitPriceAt,
  countText, canOrderText, pricesText, ORDER_METHODS, howOrdersText, supplierSubText, SUPPLIER_TABS, tabOrDefault, listSites,
  SITE_FIELD_NEED, canEditSiteField, sitesTabNote, siteRows, followValue, siteValueText, ccText, parseCc, parseMoneyInput, siteCommitValue,
  DETAILS_FIELDS, detailsDraft, detailsPayload, companyValues, detailsValueText, onTopPlan,
  SUPPLIER_FIELD_WORDS, changeWhat, changeValueText, exportPriceRows, fileName, savedWords,
} from './supplierListRules.js';

const NAMES = { a: 'North Street', b: 'Harbour Road', c: 'Mill Lane', d: 'Canal Side', e: 'Old Market', f: 'Park View', g: 'Station Yard' };
const siteName = (id) => NAMES[id] || id;
const ALL = Object.keys(NAMES);

test('money words: £1.38, whole pounds for spend, another currency by its own symbol', () => {
  assert.equal(moneyText(1.375), '£1.38');
  assert.equal(moneyText(8, 'EUR'), '€8.00');
  assert.equal(moneyText('12.5', 'USD'), '$12.50');
  assert.equal(moneyText(3, 'CHF'), 'CHF 3.00');
  assert.equal(moneyText(null), '');
  assert.equal(moneyText(''), '');
  assert.equal(spendText([{ currency: 'GBP', amount: 4210.4 }]), '£4,210');
  assert.equal(spendText([{ currency: 'GBP', amount: 12345.6 }, { currency: 'EUR', amount: 300 }]), '£12,346 + €300');
  assert.equal(spendText([]), '£0');
  assert.equal(spendText(null, 'EUR'), '€0');
});

test('days and next prices: 3 Nov, read as the day named (never shifted by a clock)', () => {
  assert.equal(dayMonth('2026-11-03'), '3 Nov');
  assert.equal(dayMonth('2026-01-31T00:00:00Z'), '31 Jan');
  assert.equal(dayMonth('2026-13-01'), '');
  assert.equal(dayMonth(null), '');
  assert.equal(nextPriceText({ price: 8.61, from_day: '2026-11-01' }), '£8.61 from 1 Nov');
  assert.equal(nextPriceText(null), 'None');
  assert.equal(nextPriceText({ price: null, from_day: '2026-11-01' }), 'None');
});

test('price spread, VAT by its rate, and the price of one count pack at a site price', () => {
  assert.equal(spreadText({ low: 8.28, high: 8.7 }), '£8.28 to £8.70');
  assert.equal(spreadText({ low: 8.28, high: 8.28 }), '£8.28');
  assert.equal(spreadText(null), '');
  assert.equal(vatText(0.2), '20%');
  assert.equal(vatText('0.125'), '12.5%');
  assert.equal(vatText(0), '0%');
  assert.equal(vatText(null), '');
  // £14.40 a case at £1.20 a bottle; £15.00 at a site is £1.25 a bottle
  assert.equal(unitPriceAt({ unit_price: 1.2, company_price: 14.4 }, 15), 1.25);
  assert.equal(unitPriceAt({ unit_price: 1.2, company_price: 14.4 }, null), null);
  assert.equal(unitPriceAt({ unit_price: null, company_price: 14.4 }, 15), null);
  assert.equal(unitPriceAt({ unit_price: 1.2, company_price: 0 }, 15), null, 'no scale from a price of 0');
});

test('the Can order and Sites cells: All 7, 3 of 7, a name, Local to, None here', () => {
  const row = (onIds, extra = {}) => ({ sites: ALL.map((id) => ({ location_id: id, can_order: onIds.includes(id) })), ...extra });
  assert.equal(canOrderText(row(ALL), ALL, siteName), 'All 7');
  assert.equal(canOrderText(row(['a', 'b', 'c']), ALL, siteName), '3 of 7');
  assert.equal(canOrderText(row(['b']), ALL, siteName), 'Harbour Road');
  assert.equal(canOrderText(row([]), ALL, siteName), 'None here');
  assert.equal(canOrderText(row(['b'], { local_location_id: 'b' }), ALL, siteName), 'Local to Harbour Road');
  // one site in view (the picker on one site): its name, or None here
  assert.equal(canOrderText(row(['a', 'b']), ['b'], siteName), 'Harbour Road');
  assert.equal(canOrderText(row(['a']), ['b'], siteName), 'None here');
  // a group in view counts only that group
  assert.equal(canOrderText(row(['a', 'b', 'c']), ['a', 'b'], siteName), 'All 2');
  assert.equal(countText(['a', 'z'], ['a', 'b'], siteName), 'North Street', 'a site outside the view is not counted');
  assert.equal(countText(['a'], [], siteName), 'None here');
  assert.equal(canOrderText(null, ALL, siteName), 'None here');
});

test('prices, how orders reach them, the page sub line', () => {
  assert.deepEqual(pricesText({ accepts_price_changes: true }), { words: 'Accepts price changes', pill: false });
  assert.deepEqual(pricesText({ accepts_price_changes: false }), { words: 'Agreed prices', pill: true });
  assert.deepEqual(pricesText({}), { words: 'Accepts price changes', pill: false }, 'the default accepts changes');
  assert.equal(howOrdersText({ order_method: 'email' }), 'Email');
  assert.equal(howOrdersText({ order_method: 'held' }), 'They hold a standing order');
  assert.equal(howOrdersText({}), 'Email');
  assert.deepEqual(ORDER_METHODS.map((m) => m.label), ['Email, with a CSV attached', 'They hold a standing order (no email sent)']);
  assert.equal(supplierSubText({ accepts_price_changes: true }), 'Accepts price changes.');
  assert.equal(supplierSubText({ accepts_price_changes: false }), 'Agreed prices.');
});

test('tabs: Details, Sites, Order rules, Items, Changes; the start tab falls back to Sites', () => {
  assert.deepEqual(SUPPLIER_TABS.map((t) => t.label), ['Details', 'Sites', 'Order rules', 'Items', 'Changes']);
  assert.equal(tabOrDefault('details'), 'details');
  assert.equal(tabOrDefault('orderrules'), 'rules');
  assert.equal(tabOrDefault('Order rules'), 'rules');
  assert.equal(tabOrDefault('nope'), 'sites');
  assert.equal(tabOrDefault(null), 'sites');
});

test('listSites: null on All sites (the server scope), the ids of a group or one site', () => {
  assert.equal(listSites({ isAll: true, scopeSites: [{ id: 'a' }] }), null);
  assert.deepEqual(listSites({ isAll: false, scopeSites: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(listSites({ isAll: false, scopeSites: ['c'] }), ['c'], 'ids work as well as sites');
  assert.equal(listSites({ isAll: false, scopeSites: [] }), null);
});

test('who may change each Sites tab value (contract 1.5): facts at any reached site, prices at full control, approval for the company', () => {
  assert.deepEqual(SITE_FIELD_NEED, {
    can_order: 'site_price', account_number: 'site_facts', email: 'site_facts', cc_emails: 'site_facts',
    min_order_value: 'site_price', delivery_fee: 'site_price', approval_limit: 'company',
  });
  // a plain site manager at a: facts only, only at a
  const sitesLevel = { company: false, site: (id, what) => id === 'a' && what === 'site_facts' };
  assert.equal(canEditSiteField('account_number', 'a', sitesLevel), true);
  assert.equal(canEditSiteField('cc_emails', 'a', sitesLevel), true);
  assert.equal(canEditSiteField('account_number', 'b', sitesLevel), false);
  assert.equal(canEditSiteField('min_order_value', 'a', sitesLevel), false);
  assert.equal(canEditSiteField('can_order', 'a', sitesLevel), false);
  assert.equal(canEditSiteField('approval_limit', 'a', sitesLevel), false, 'a manager never raises their own limit');
  // Their sites, full control at a
  const full = { company: false, site: (id) => id === 'a' };
  assert.equal(canEditSiteField('can_order', 'a', full), true);
  assert.equal(canEditSiteField('delivery_fee', 'a', full), true);
  assert.equal(canEditSiteField('approval_limit', 'a', full), false);
  assert.equal(canEditSiteField('delivery_fee', 'b', full), false);
  // a company editor
  const editor = { company: true, site: () => false };
  for (const f of Object.keys(SITE_FIELD_NEED)) assert.equal(canEditSiteField(f, 'z', editor), true, f);
  assert.equal(canEditSiteField('unknown', 'a', editor), false);
  assert.equal(canEditSiteField('email', 'a', null), false);
});

test('the Sites tab line says what a site login can change, and where', () => {
  assert.equal(sitesTabNote({ company: true, level: 'all', siteNames: ['North Street'] }), null);
  assert.equal(sitesTabNote({ company: false, level: 'sites', siteNames: ['Harbour Road'] }),
    'You can change the account number, order email and CC emails for Harbour Road. Who can order, the minimum order, the delivery fee and the approval limit come from head office.');
  assert.equal(sitesTabNote({ company: false, level: 'sites_full', siteNames: ['North Street', 'Harbour Road', 'Mill Lane'] }),
    'You can change who can order, the account number, order email, CC emails, minimum order and delivery fee for North Street, Harbour Road and Mill Lane. The approval limit comes from head office.');
  assert.equal(sitesTabNote({ company: false, level: 'sites', siteNames: [] }), null);
});

test('siteRows: every site in the login\'s list, linked or not; can order off reads as off', () => {
  const list = [{ id: 'a', name: 'North Street' }, { id: 'b', name: 'Harbour Road' }, { id: 'c', name: 'Mill Lane' }];
  const rows = siteRows(list, [{ location_id: 'a', can_order: true }, { location_id: 'c', can_order: false }, { location_id: 'x', can_order: true }]);
  assert.deepEqual(rows.map((r) => [r.site.id, r.on, !!r.link]), [['a', true, true], ['b', false, false], ['c', false, true]]);
  assert.deepEqual(siteRows(null, null), []);
});

test('followValue and siteValueText: (company) when a site follows, (none) for no approval limit', () => {
  assert.deepEqual(followValue(null, 'orders@example.com'), { value: 'orders@example.com', follow: true });
  assert.deepEqual(followValue('Orders@Example.com ', 'orders@example.com'), { value: 'orders@example.com', follow: true }, 'the same email in other letters follows');
  assert.deepEqual(followValue('site@example.com', 'orders@example.com'), { value: 'site@example.com', follow: false });
  assert.deepEqual(followValue('site@example.com', null), { value: 'site@example.com', follow: false });
  assert.deepEqual(followValue(null, null), { value: null, follow: false });
  assert.deepEqual(followValue(100, '100.00', 'money'), { value: '100.00', follow: true });
  assert.deepEqual(followValue(120, 100, 'money'), { value: 120, follow: false });
  assert.equal(siteValueText('email', null, 'orders@example.com'), '(company)');
  assert.equal(siteValueText('email', 'site@example.com', 'orders@example.com'), 'site@example.com');
  assert.equal(siteValueText('min_order_value', 150, 100), '£150.00');
  assert.equal(siteValueText('min_order_value', 100, 100), '(company)');
  assert.equal(siteValueText('delivery_fee', 5, null, 'EUR'), '€5.00');
  assert.equal(siteValueText('approval_limit', null), '(none)');
  assert.equal(siteValueText('approval_limit', 800), '£800.00');
  assert.equal(siteValueText('account_number', 'AC-1', 'AC-1'), 'AC-1', 'an account number is always the site\'s own');
  assert.equal(siteValueText('cc_emails', ['a@example.com', 'b@example.com']), 'a@example.com, b@example.com');
  assert.equal(siteValueText('email', null, null), '');
});

test('CC emails and money boxes are read with plain words on a mistake', () => {
  assert.equal(ccText(['a@example.com', null, 'b@example.com']), 'a@example.com, b@example.com');
  assert.equal(ccText(null), '');
  assert.deepEqual(parseCc('a@example.com; b@example.com,  a@example.com'), { ok: true, value: ['a@example.com', 'b@example.com'] });
  assert.deepEqual(parseCc('  '), { ok: true, value: null });
  assert.deepEqual(parseCc('chef'), { ok: false, error: '"chef" is not an email. Write it like chef@example.com.' });
  assert.deepEqual(parseMoneyInput('£1,250.50'), { ok: true, value: 1250.5 });
  assert.deepEqual(parseMoneyInput(12.345), { ok: true, value: 12.35 });
  assert.deepEqual(parseMoneyInput(''), { ok: true, value: null });
  assert.deepEqual(parseMoneyInput('-3', 'Min order'), { ok: false, error: 'Min order must be an amount such as 150.' });
  assert.deepEqual(parseMoneyInput('lots', 'Delivery fee'), { ok: false, error: 'Delivery fee must be an amount such as 150.' });
});

test('siteCommitValue: an emptied order email, minimum or fee goes back to the company value', () => {
  assert.deepEqual(siteCommitValue('email', '', 'orders@example.com'), { ok: true, value: 'orders@example.com' });
  assert.deepEqual(siteCommitValue('email', ' site@example.com ', 'orders@example.com'), { ok: true, value: 'site@example.com' });
  assert.equal(siteCommitValue('email', 'nope', null).ok, false);
  assert.deepEqual(siteCommitValue('email', '', null), { ok: true, value: null });
  assert.deepEqual(siteCommitValue('min_order_value', '', 100), { ok: true, value: 100 });
  assert.deepEqual(siteCommitValue('min_order_value', '75', 100), { ok: true, value: 75 });
  assert.deepEqual(siteCommitValue('delivery_fee', null, null), { ok: true, value: null });
  assert.deepEqual(siteCommitValue('approval_limit', '', 500), { ok: true, value: null }, 'no approval limit is (none), never the company');
  assert.deepEqual(siteCommitValue('approval_limit', '600', null), { ok: true, value: 600 });
  assert.deepEqual(siteCommitValue('account_number', ' FW-10234 '), { ok: true, value: 'FW-10234' });
  assert.deepEqual(siteCommitValue('account_number', ''), { ok: true, value: null });
  assert.deepEqual(siteCommitValue('cc_emails', 'a@example.com b@example.com'), { ok: true, value: ['a@example.com', 'b@example.com'] });
  assert.equal(siteCommitValue('can_order', true).ok, false, 'Can order is a tick, saved another way');
});

test('Details: the words in order, the draft and the company keys it saves', () => {
  assert.deepEqual(DETAILS_FIELDS.map((f) => f.label), ['Name', 'Order email', 'Phone', 'Contact', 'Payment terms (days)', 'Comments',
    'Minimum order', 'Maximum order', 'Delivery fee', 'How orders reach them', 'Accept price changes']);
  const row = { name: 'Dairy Co', email: 'orders@example.com', phone: '0100 000000', contact_name: 'Order desk', payment_terms_days: 30, notes: null,
    min_order_value: 100, max_order_value: null, delivery_fee: '5.00', order_method: 'held', accepts_price_changes: false };
  const draft = detailsDraft(row);
  assert.equal(draft.payment_terms_days, '30');
  assert.equal(draft.notes, '');
  assert.equal(draft.order_method, 'held');
  assert.equal(draft.accepts_price_changes, false);
  assert.equal(detailsDraft(null).accepts_price_changes, true);
  const p = detailsPayload({ ...draft, name: '  Dairy Co  ', notes: ' Back door ' });
  assert.deepEqual(p, { ok: true, supplier: {
    name: 'Dairy Co', email: 'orders@example.com', phone: '0100 000000', contact_name: 'Order desk', payment_terms_days: 30, notes: 'Back door',
    min_order_value: 100, max_order_value: null, delivery_fee: 5, order_method: 'held', accepts_price_changes: false,
  } });
  for (const key of ['delivery_days', 'cutoff_time', 'account_number', 'site', 'location_id']) assert.ok(!(key in p.supplier), `never ${key}`);
  assert.equal(detailsPayload({ ...draft, name: ' ' }).error, 'Give the supplier a name.');
  assert.equal(detailsPayload({ ...draft, email: 'orders' }).error, 'The order email needs an @, for example orders@example.com.');
  assert.equal(detailsPayload({ ...draft, payment_terms_days: '7.5' }).error, 'Payment terms must be a whole number of days, such as 30.');
  assert.equal(detailsPayload({ ...draft, delivery_fee: 'free' }).error, 'Delivery fee must be an amount such as 150.');
  assert.equal(detailsPayload({ ...draft, min_order_value: '200', max_order_value: '150' }).error, 'The maximum order must be more than the minimum order.');
  assert.deepEqual(companyValues(row).delivery_fee, 5);
  assert.equal(detailsValueText('accepts_price_changes', false), 'No');
  assert.equal(detailsValueText('order_method', 'held'), 'They hold a standing order (no email sent)');
  assert.equal(detailsValueText('min_order_value', 100), '£100.00');
});

test('Someone saved first: the table is each field they changed that this screen says otherwise', () => {
  const loaded = { name: 'Dairy Co', email: 'orders@example.com', phone: '0100', min_order_value: 100, accepts_price_changes: true, order_method: 'email' };
  // they changed the phone and the minimum; I changed the email and the minimum
  const theirs = { ...loaded, phone: '0200', min_order_value: 120 };
  const mine = detailsPayload({ ...detailsDraft(loaded), email: 'buying@example.com', min_order_value: '90' }).supplier;
  const plan = onTopPlan(loaded, mine, theirs);
  assert.equal(plan.theirsChanged, true);
  assert.deepEqual(plan.rows, [
    { label: 'Phone', theirs: '0200', mine: '0100' },
    { label: 'Minimum order', theirs: '£120.00', mine: '£90.00' },
  ], 'their two changes, never my own email change as if it were theirs');
  assert.equal(plan.patch.email, 'buying@example.com', 'my own change is saved');
  assert.equal(plan.patch.phone, '0100', 'Save mine on top is this screen, as the table shows');
  assert.equal(plan.patch.min_order_value, 90);
  // one change of theirs: "Tom changed Phone from 0100 to 0200."
  const one = onTopPlan(loaded, detailsPayload({ ...detailsDraft(loaded), email: 'buying@example.com' }).supplier, { ...loaded, phone: '0200' });
  assert.deepEqual(one.rows, [{ label: 'Phone', theirs: '0200', mine: '0100' }]);
  // I typed what they saved: nothing clashes, so the screen saves again with no question
  const same = onTopPlan(loaded, detailsPayload({ ...detailsDraft(loaded), phone: '0200', min_order_value: '120' }).supplier, theirs);
  assert.deepEqual(same.rows, []);
  assert.equal(same.theirsChanged, true);
  // they changed nothing this form shows (only the version moved): save again, no modal
  const bumped = onTopPlan(loaded, mine, { ...loaded, row_version: 9 });
  assert.equal(bumped.theirsChanged, false);
  assert.deepEqual(bumped.rows, []);
  assert.equal(bumped.patch.email, 'buying@example.com', 'and my change is still what is saved');
  assert.equal(detailsValueText('email', null), '', 'an empty value reads (none) in the modal');
});

test('Changes: plain field words, the site named, old and new values as words', () => {
  assert.equal(SUPPLIER_FIELD_WORDS.approval_limit, 'Approval over');
  assert.equal(changeWhat({ field: 'account_number', location_id: 'b' }, siteName), 'Account number at Harbour Road');
  assert.equal(changeWhat({ field: 'name' }, siteName), 'Name');
  assert.equal(changeWhat({ field: 'some_new_field' }, siteName), 'Some new field');
  assert.equal(changeWhat({}, siteName), 'A change');
  assert.equal(changeValueText(true, 'accepts_price_changes'), 'Yes');
  assert.equal(changeValueText(true, 'off_here'), 'No', 'off here true means it is not on');
  assert.equal(changeValueText('held', 'order_method'), 'They hold a standing order');
  assert.equal(changeValueText(['a@example.com', 'b@example.com'], 'cc_emails'), 'a@example.com, b@example.com');
  assert.equal(changeValueText([{ delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00:00' }, { delivery_dow: 4, order_by_dow: null, order_by_time: null }], 'order_rules'),
    'Mon (order by Sun 14:00), Thu');
  assert.equal(changeValueText(null, 'name'), '');
  assert.equal(changeValueText(12.5, 'min_order_value'), '12.5');
  assert.equal(changeValueText({ x: 1 }, 'other'), '{"x":1}');
});

test('the Items tab export: one row per supplier item, a Price at column for one site', () => {
  const rows = [{ item_name: 'Whole milk 2L', supplier_product_name: 'Semi 2L Btl', sku: 'FW-2201', pack_description: '6 x 2 L', company_price: 8.28,
    currency: 'GBP', next_price: { price: 8.61, from_day: '2026-11-01' }, purchase_vat_rate: 0, sites_on: 7, spread: { low: 8.28, high: 8.7 }, paused: false, site_price: 8.5 }];
  const company = exportPriceRows(rows);
  assert.deepEqual(company.headers.map((h) => h.label), ['Item', 'Their name', 'SKU', 'Pack', 'Company price', 'Currency', 'Next price', 'Next price from', 'VAT', 'Sites on', 'Lowest price', 'Highest price', 'Paused']);
  assert.deepEqual(company.rows[0], { item: 'Whole milk 2L', their_name: 'Semi 2L Btl', sku: 'FW-2201', pack: '6 x 2 L', company_price: '8.28', site_price: '',
    currency: 'GBP', next_price: '8.61', next_from: '2026-11-01', vat: '0%', sites_on: '7', low: '8.28', high: '8.70', paused: 'No' });
  const one = exportPriceRows([{ ...rows[0], site_price: null }], { priceFor: 'b', siteName });
  assert.ok(one.headers.some((h) => h.label === 'Price at Harbour Road'));
  assert.equal(one.rows[0].site_price, '', 'off there is empty');
  assert.deepEqual(exportPriceRows(null).rows, []);
  assert.equal(fileName('Fresh & Co / Ltd'), 'Fresh Co Ltd prices.csv');
  assert.equal(fileName(''), 'Supplier prices.csv');
});

test('savedWords: Saved., then how many sites catch up (one site catches up)', () => {
  assert.equal(savedWords([]), 'Saved.');
  assert.equal(savedWords(null), 'Saved.');
  assert.equal(savedWords([{ location_id: 'a', job_id: 1 }]), 'Saved. 1 site catches up within a minute.');
  assert.equal(savedWords([{ location_id: 'a', job_id: 1 }, { location_id: 'b', job_id: 2 }, { location_id: 'c', job_id: 3 }]), 'Saved. 3 sites catch up within a minute.');
  assert.equal(savedWords([{ location_id: 'a', job_id: 1 }, { location_id: 'a', job_id: 2 }]), 'Saved. 1 site catches up within a minute.', 'counted by site');
  assert.equal(savedWords([], 'North can now order from Fresh.'), 'North can now order from Fresh.');
  assert.equal(savedWords([{ location_id: 'b' }, { location_id: 'c' }], 'North can now order from Fresh.'), 'North can now order from Fresh. 2 sites catch up within a minute.');
});

test('no em or en dash in any word these rules make', () => {
  const all = [
    ...ORDER_METHODS.flatMap((m) => [m.short, m.label]), ...SUPPLIER_TABS.map((t) => t.label), ...DETAILS_FIELDS.map((f) => f.label),
    ...Object.values(SUPPLIER_FIELD_WORDS), detailsPayload({}).error, parseCc('x').error, siteCommitValue('email', 'x').error,
    savedWords([{ location_id: 'a' }]), sitesTabNote({ company: false, level: 'sites', siteNames: ['A', 'B'] }),
    sitesTabNote({ company: false, level: 'sites_full', siteNames: ['A'] }),
  ];
  for (const w of all) assert.ok(!/[\u2013\u2014]/.test(w), w);
});
