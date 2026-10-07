import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickConsentedOrg, organisationChoices, mappingForNewOrganisation, autoDailyAfterOrganisationChange } from '../../../supabase/functions/_shared/xeroOrg.js';
import { xeroAuthEventIdFromToken, xeroUserIdFromToken, tokenFamily, pickTokenDonor } from '../../../supabase/functions/_shared/xeroTokens.js';
import { invoiceReadiness, validateInvoiceMapping, mappingHash } from '../../../supabase/functions/_shared/xeroInvoicePlan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const jwt = (claims) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

const retail = { id: 'c1', authEventId: 'ev-sep', tenantId: 'b2d3', tenantType: 'ORGANISATION', tenantName: 'Coffeeboy Retail LTD', createdDateUtc: '2026-09-28T15:12:00Z', updatedDateUtc: '2026-10-02T11:13:00Z' };
const tdnz = { id: 'c2', authEventId: 'ev-oct', tenantId: 'td01', tenantType: 'ORGANISATION', tenantName: 'TDNZ', createdDateUtc: '2026-10-01T09:00:00Z', updatedDateUtc: '2026-10-01T09:00:00Z' };

test('the organisation of THIS sign in event is stored, wherever it sits in the list and whatever the stamps say (Coffee Boy, 7 Oct 2026)', () => {
  assert.equal(xeroAuthEventIdFromToken(jwt({ authentication_event_id: 'ev-oct', xero_userid: 'u' })), 'ev-oct');
  assert.equal(xeroAuthEventIdFromToken('not a token'), null);
  // Retail is first AND has the newer stamp: the old first-in-list rule and a stamp rule both
  // say Retail. The sign in event says TDNZ, and it wins.
  assert.equal(pickConsentedOrg([retail, tdnz], 'ev-oct').tenantId, 'td01');
  assert.equal(pickConsentedOrg([tdnz, retail], 'ev-oct').tenantId, 'td01');
  assert.equal(pickConsentedOrg([retail, tdnz], 'EV-SEP').tenantId, 'b2d3', 'ids compare without case');
});

test('with no sign in event to go on: the newest stamp, then the first organisation; practices never win; empty = null', () => {
  assert.equal(pickConsentedOrg([retail, tdnz]).tenantId, 'b2d3', 'no event: newest stamp');
  assert.equal(pickConsentedOrg([retail, tdnz], 'ev-unknown').tenantId, 'b2d3', 'an event no connection carries: newest stamp');
  const a = { tenantId: 'a', tenantType: 'ORGANISATION', tenantName: 'A' };
  const b = { tenantId: 'b', tenantType: 'ORGANISATION', tenantName: 'B' };
  assert.equal(pickConsentedOrg([a, b]).tenantId, 'a', 'no stamps: the first');
  const practice = { tenantId: 'p', tenantType: 'PRACTICE', tenantName: 'P', authEventId: 'ev-oct', updatedDateUtc: '2027-01-01T00:00:00Z' };
  assert.equal(pickConsentedOrg([practice, a], 'ev-oct').tenantId, 'a');
  assert.equal(pickConsentedOrg([practice], 'ev-oct').tenantId, 'p', 'only a practice: still something to store');
  assert.equal(pickConsentedOrg([]), null);
  assert.equal(pickConsentedOrg(null, 'ev'), null);
});

test('organisationChoices: organisations only, no duplicates, current first then by name', () => {
  const out = organisationChoices([tdnz, retail, { ...retail, id: 'dup' }, { tenantId: 'p', tenantType: 'PRACTICE', tenantName: 'P' }], 'b2d3');
  assert.deepEqual(out, [
    { tenantId: 'b2d3', tenantName: 'Coffeeboy Retail LTD', current: true },
    { tenantId: 'td01', tenantName: 'TDNZ', current: false },
  ]);
  assert.deepEqual(organisationChoices(undefined, 'x'), []);
});

test('one Xero sign in, two organisations: the sites stay one token family (they split before, and one half lost its sign in)', () => {
  const u1 = jwt({ xero_userid: 'u-1' });
  const self = { location_id: 'headingley', tenant_id: 'td01', access_token: u1, refresh_token: 'r-spent', updated_at: '2026-10-07T10:10:00Z' };
  const rows = [
    self,
    { location_id: 'leeds', tenant_id: 'b2d3', access_token: u1, refresh_token: 'r-new', updated_at: '2026-10-07T14:00:00Z' },
    { location_id: 'preston', tenant_id: 'td01', access_token: u1, refresh_token: 'r-spent', updated_at: '2026-10-07T10:10:00Z' },
    { location_id: 'someone-else', tenant_id: 'td01', access_token: jwt({ xero_userid: 'u-2' }), refresh_token: 'r-z', updated_at: '2026-10-07T15:00:00Z' },
  ];
  assert.equal(xeroUserIdFromToken(u1), 'u-1');
  assert.deepEqual(tokenFamily(rows, self).map((r) => r.location_id), ['leeds', 'preston'], 'the same user on either organisation; never another user, even on the same organisation');
  assert.equal(pickTokenDonor(rows, self).location_id, 'leeds', 'the newer set held by the site on the OTHER organisation');
  assert.equal(pickTokenDonor(rows, { ...self, access_token: 'bad' }), null, 'unknown user: never borrow');
  // xero.ts: neither the compare and set nor the donor search is fenced by organisation.
  const src = read('supabase/functions/_shared/xero.ts');
  assert.match(src, /\}\)\.eq\('refresh_token', c\.refresh_token\)\.select\('location_id'\)/, 'every row holding the refresh token rotates together');
  assert.doesNotMatch(src, /\.eq\('tenant_id', c\.tenant_id\)\.eq\('refresh_token'/);
  assert.doesNotMatch(src, /\.eq\('tenant_id', again\.tenant_id\)/);
  assert.match(src, /tenantId: again\.tenant_id/, 'a borrowed set never changes which organisation the venue posts to');
});

const leedsMapping = {
  site: { name: 'Coffee Boy Headingley', code: 'HEADINGLEY' },
  invoiceStartDate: '2026-10-04',
  tracking: { categoryId: 'cat', categoryName: 'Site', optionId: 'opt', optionName: 'Headingley' },
  groups: { food: { name: 'Food', account: '200' }, drinks: { name: 'Drinks', account: '201' }, odd: { account: '203' } },
  categoryGroups: { 'cat-1': 'food' }, itemGroups: { 'item-1': 'drinks' },
  otherSalesAccount: '260', tipsAccount: '814', serviceAccount: '815', giftLiabilityAccount: '816',
  discounts: { accounts: { staff: '270' }, labels: { 'Staff meal': 'staff' } },
  clearing: { card: 'SOSCARDCLR', cash: 'SOSCASHCLR' }, paymentMap: { Card: 'bank-id' },
  taxRateMap: { 'r20': 'OUTPUT2' }, serviceTax: 'NONE', serviceTaxable: false, taxDefault: 'OUTPUT2', salesNoVat: true,
  revenueAccount: '200', purchasesAccount: '310', purchaseTax: 'INPUT2',
  lightspeed: { contactName: 'Lightspeed' }, figuresChecked: { hash: 'x', date: '2026-10-04' },
  somethingAddedLater: { accountId: 'abc' },
};

test('moving to another organisation keeps what is about ServOS and drops every choice that names something in Xero', () => {
  const kept = mappingForNewOrganisation(leedsMapping);
  assert.deepEqual(kept, {
    site: { name: 'Coffee Boy Headingley', code: 'HEADINGLEY' },
    invoiceStartDate: '2026-10-04',
    categoryGroups: { 'cat-1': 'food' }, itemGroups: { 'item-1': 'drinks' },
    serviceTaxable: false,
    groups: { food: { name: 'Food' }, drinks: { name: 'Drinks' } },
    discounts: { labels: { 'Staff meal': 'staff' } },
  });
  assert.equal(validateInvoiceMapping(kept), null, 'what is left is still a mapping the server accepts');
  assert.deepEqual(mappingForNewOrganisation(null), {});
  assert.deepEqual(mappingForNewOrganisation({ tracking: { optionName: 'x' }, groups: { a: { account: '200' } } }), {});
  // The source mapping is not touched (the copy kept in the log is the original).
  assert.equal(leedsMapping.groups.food.account, '200');
});

test('after the move a site on the daily sales invoice is Not Ready: tracking, accounts, tips and the figures check all fail', () => {
  const before = { ...leedsMapping, figuresChecked: { hash: mappingHash(leedsMapping) } };
  assert.equal(invoiceReadiness(before, {}).ready, true, 'the fixture is a Ready site');
  const r = invoiceReadiness(mappingForNewOrganisation(before), {});
  assert.equal(r.ready, false);
  const failed = r.items.filter((i) => !i.ok).map((i) => i.key);
  for (const k of ['tracking', 'groups', 'tips', 'figures']) assert.ok(failed.includes(k), `${k} must fail`);
  assert.ok(!failed.includes('site'), 'the site name and code are kept');
});

test('auto posting after the move: kept on the daily sales invoice (the Ready check holds it), off on bank transactions', () => {
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true), true);
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', false), false);
  assert.equal(autoDailyAfterOrganisationChange('invoice', true), false);
  assert.equal(autoDailyAfterOrganisationChange(null, true), false);
});

test('xero-connect: the setup is reset BEFORE the organisation changes, the copy is written before anything is cleared, and the new tokens reach every row of the Xero user', () => {
  const src = read('supabase/functions/xero-connect/index.ts');
  // set_organisation: reset, then the tenant update.
  const set = src.slice(src.indexOf("if (action === 'set_organisation')"), src.indexOf("if (action === 'disconnect')"));
  assert.ok(set.indexOf('resetForNewOrganisation(') > 0 && set.indexOf('resetForNewOrganisation(') < set.indexOf(".update({ tenant_id: org.tenantId"), 'reset first, organisation second');
  assert.match(set, /catch \(e\) \{\s*return json\(\{ error:/, 'a failed refresh or Xero read answers JSON, never a bare 500');
  // resetForNewOrganisation: the copy (logOrganisation) before the clear (update).
  const reset = src.slice(src.indexOf('async function resetForNewOrganisation'), src.indexOf('function redirect('));
  assert.ok(reset.indexOf('await logOrganisation(') > 0 && reset.indexOf('await logOrganisation(') < reset.indexOf("sb.from('xero_config').update("), 'copy first');
  assert.match(reset, /mapping: mappingForNewOrganisation\(cfg\.mapping\), detail: \{\}, auto_daily: autoAfter/);
  // callback: the sign in event picks the organisation; tokens to the user's rows on any organisation, before the reset can fail.
  const cb = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  assert.match(cb, /pickConsentedOrg\(conns, xeroAuthEventIdFromToken\(t\.access_token\)\)/);
  assert.match(cb, /\.update\(tokenSet\)\.in\('location_id', same\);/);
  assert.doesNotMatch(cb, /eq\('tenant_id', org\.tenantId\)/, 'no organisation fence on the token copy');
  assert.ok(cb.indexOf(".update(tokenSet).in('location_id', same)") < cb.indexOf('resetForNewOrganisation('), 'tokens stored before the reset');
  assert.ok(cb.indexOf('resetForNewOrganisation(') < cb.indexOf("sb.from('xero_connections').upsert("), 'reset before the site is stored on the new organisation');
});

test('every posted day records its organisation, on both posting models', () => {
  const src = read('supabase/functions/xero-sales/index.ts');
  assert.match(src, /detail: \{ model: 'sales_invoice', tenant_id: tenantId,/);
  assert.match(src, /detail: \{ sample, tenant_id: tenantId, lines,/);
});
