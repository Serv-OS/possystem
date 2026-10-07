import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickConsentedOrg, organisationChoices, mappingForNewOrganisation, autoDailyAfterOrganisationChange, allowedOrganisations, previousOrganisation, postedElsewhere, setupMadeForAnother } from '../../../supabase/functions/_shared/xeroOrg.js';
import { xeroAuthEventIdFromToken, xeroUserIdFromToken, tokenFamily, pickTokenDonor } from '../../../supabase/functions/_shared/xeroTokens.js';
import { invoiceReadiness, validateInvoiceMapping, mappingHash } from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { moveWords } from './xeroMoveWords.js';

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

test('auto posting after the move: kept only on the daily sales invoice with a first invoice day safely in the past; off everywhere else', () => {
  const today = '2026-10-07';
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, '2026-10-05', today), true, 'Barnsley: first invoice day two days back');
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, '2026-09-27', today), true);
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, '2026-10-06', today), false, 'yesterday could still post as bank transactions somewhere: off');
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, '2026-10-20', today), false, 'a first invoice day still to come: days before it post on defaults with no Ready check');
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, null, today), false);
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', true, '2026-10-01'), false, 'no clock given: off');
  assert.equal(autoDailyAfterOrganisationChange('sales_invoice', false, '2026-09-27', today), false, 'it was off: it stays off');
  assert.equal(autoDailyAfterOrganisationChange('invoice', true, '2026-09-27', today), false, 'bank transactions: no Ready check at all');
  assert.equal(autoDailyAfterOrganisationChange(null, true, '2026-09-27', today), false);
});

test('the list offers only organisations the same company already uses (plus its own); ServOS staff see all', () => {
  const all = [{ tenantId: 'b2d3', tenantName: 'Coffeeboy Retail LTD', current: true }, { tenantId: 'td01', tenantName: 'TDNZ', current: false }, { tenantId: 'zz', tenantName: 'Another Company Ltd', current: false }];
  assert.deepEqual(allowedOrganisations(all, ['b2d3'], 'b2d3').map((o) => o.tenantId), ['b2d3'], 'TDNZ is used by no site of the company yet: sign in at Xero for the first one');
  assert.deepEqual(allowedOrganisations(all, ['b2d3', 'td01'], 'b2d3').map((o) => o.tenantId), ['b2d3', 'td01'], 'once one site is on TDNZ the others can pick it');
  assert.deepEqual(allowedOrganisations(all, [], 'td01').map((o) => o.tenantId), ['td01'], 'its own organisation is always shown');
  assert.deepEqual(allowedOrganisations(all, ['b2d3'], 'b2d3', true).map((o) => o.tenantId), ['b2d3', 'td01', 'zz']);
  assert.deepEqual(allowedOrganisations(null, null, null), []);
});

test('which organisation a setup was made for: the connection row, then the organisation record, then the cached setup itself', () => {
  const row = { tenant_id: 'b2d3', tenant_name: 'Coffeeboy Retail LTD' };
  const record = { tenant_id: 'td01', tenant_name: 'TDNZ', via: 'picker' };
  const detail = { site: { tenantId: 'old1', orgName: 'Old Co' } };
  assert.deepEqual(previousOrganisation({ row, record, detail }), { id: 'b2d3', name: 'Coffeeboy Retail LTD' });
  assert.deepEqual(previousOrganisation({ record, detail }), { id: 'td01', name: 'TDNZ' });
  // Disconnected before this release (no row, no record): the cached setup still names the organisation.
  assert.deepEqual(previousOrganisation({ detail }), { id: 'old1', name: 'Old Co' });
  assert.equal(previousOrganisation({ detail: {} }), null, 'a site that never connected');
  assert.equal(previousOrganisation(), null);
});

test('a setup made for one organisation is never posted into another; an empty setup (after a real move) never trips', () => {
  assert.equal(setupMadeForAnother({ site: { tenantId: 'b2d3' } }, 'td01'), true);
  assert.equal(setupMadeForAnother({ site: { tenantId: 'td01' } }, 'td01'), false);
  assert.equal(setupMadeForAnother({}, 'td01'), false);
  assert.equal(setupMadeForAnother(null, 'td01'), false);
  assert.equal(setupMadeForAnother({ site: { tenantId: 'b2d3' } }, null), false);
});

test('a day posted before the move is in the old organisation: by its own stamp when it has one, else by when it was posted', () => {
  const move = { at: '2026-10-07T15:00:00.000Z', tenant_id: 'td01', from: 'Coffeeboy Retail LTD', via: 'picker' };
  assert.equal(postedElsewhere({ prior: { detail: { tenant_id: 'b2d3' }, updated_at: '2026-10-08T10:10:00Z' }, currentTenantId: 'td01', move }), true, 'the stamp decides');
  assert.equal(postedElsewhere({ prior: { detail: { tenant_id: 'td01' }, updated_at: '2026-10-06T10:10:00Z' }, currentTenantId: 'td01', move }), false);
  assert.equal(postedElsewhere({ prior: { detail: {}, updated_at: '2026-10-06T10:10:02Z' }, currentTenantId: 'td01', move }), true, '5 and 6 Oct, posted before the move, no stamp');
  assert.equal(postedElsewhere({ prior: { detail: {}, updated_at: '2026-10-08T10:10:02Z' }, currentTenantId: 'td01', move }), false);
  assert.equal(postedElsewhere({ prior: { detail: {}, updated_at: '2026-10-06T10:10:02Z' }, currentTenantId: 'td01', move: null }), false, 'a site that never moved');
  assert.equal(postedElsewhere({ prior: { detail: {}, updated_at: '2026-10-06T10:10:02Z' }, currentTenantId: 'b2d3', move }), false, 'the record is for another organisation than the site is on now: say nothing');
});

test('xero-connect: the setup is reset BEFORE the organisation changes, the copy is written before anything is cleared, and the new tokens reach every row of the Xero user', () => {
  const src = read('supabase/functions/xero-connect/index.ts');
  // set_organisation: reset, then the tenant update.
  const set = src.slice(src.indexOf("if (action === 'set_organisation')"), src.indexOf("if (action === 'disconnect')"));
  assert.ok(set.indexOf('resetForNewOrganisation(') > 0 && set.indexOf('resetForNewOrganisation(') < set.indexOf(".update({ tenant_id: org.tenantId"), 'reset first, organisation second');
  assert.match(set, /catch \(e\) \{\s*return json\(\{ error:/, 'a failed refresh or Xero read answers JSON, never a bare 500');
  assert.match(set, /allowedOrganisations\(organisationChoices\(conns, c\.tenant_id\), company\.tenantIds, c\.tenant_id, acc\.isSuper\)/, 'the server enforces the same list the screen shows');
  // resetForNewOrganisation: the copy (logOrganisation) before the clear (update).
  const reset = src.slice(src.indexOf('async function resetForNewOrganisation'), src.indexOf('function redirect('));
  assert.ok(reset.indexOf('await logOrganisation(') > 0 && reset.indexOf('await logOrganisation(') < reset.indexOf("sb.from('xero_config').update("), 'copy first');
  assert.match(reset, /mapping: mappingForNewOrganisation\(cfg\.mapping\), detail: \{\}, auto_daily: autoAfter/);
  // callback: the sign in event picks the organisation; tokens to the user's rows on any organisation, before the reset can fail.
  const cb = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  assert.match(cb, /pickConsentedOrg\(conns, xeroAuthEventIdFromToken\(t\.access_token\)\)/);
  assert.ok(cb.indexOf(".update(tokenSet).in('location_id', same)") < cb.indexOf('await getConnections(t.access_token)'), 'the new token set is stored before Xero is asked anything else');
  assert.match(cb, /previousOrganisation\(\{ row: existing, record, detail: cached \}\)/);
  assert.match(cb, /\.update\(tokenSet\)\.in\('location_id', same\);/);
  assert.doesNotMatch(cb, /eq\('tenant_id', org\.tenantId\)/, 'no organisation fence on the token copy');
  assert.ok(cb.indexOf(".update(tokenSet).in('location_id', same)") < cb.indexOf('resetForNewOrganisation('), 'tokens stored before the reset');
  assert.ok(cb.indexOf('resetForNewOrganisation(') < cb.indexOf("sb.from('xero_connections').upsert("), 'reset before the site is stored on the new organisation');
});

test('every posted day records its organisation, and neither model posts a setup made for another one', () => {
  const src = read('supabase/functions/xero-sales/index.ts');
  assert.equal((src.match(/if \(setupMadeForAnother\(/g) || []).length, 2, 'the sales invoice path and the bank transactions path');
  assert.ok(src.indexOf('if (setupMadeForAnother(cfgRow?.detail, tenantId))') < src.indexOf('const detail = await refreshSiteDetail(sb, accessToken, tenantId, locationId, cfgRow?.detail'), 'checked before the cached setup is refreshed for the new organisation');
  assert.match(src, /detail: \{ model: 'sales_invoice', tenant_id: tenantId,/);
  assert.match(src, /detail: \{ sample, tenant_id: tenantId, lines,/);
});

test('the organisation box: the words say what is cleared, where to choose it again, and what does not post by itself', () => {
  const src = read('src/backoffice/sections/xero/OrganisationPicker.jsx');
  assert.match(src, /lookupError/, 'a list Xero could not give is told apart from a list of one');
  assert.doesNotMatch(src, /the only organisation/, 'never claims to know there is only one');
  const fn = moveWords;
  const inv = fn({ site: 'Coffee Boy Headingley', from: 'Coffeeboy Retail LTD', to: 'TDNZ', invoice: true, setupTab: 'VAT and accounts' });
  for (const w of ['Coffee Boy Headingley', 'TDNZ instead of Coffeeboy Retail LTD', 'purchases account', 'NOT posted by themselves', 'stay in Coffeeboy Retail LTD']) assert.ok(inv.includes(w), w);
  const bank = fn({ site: 'A', from: 'X', to: 'Y', invoice: false, setupTab: 'Setup' });
  assert.ok(bank.includes('Auto posting is turned off') && bank.includes('under Posting (Account mapping)'));
  assert.ok(!bank.includes("check a day's figures"), 'a bank transactions site has no figures check');
  // The screen keeps its venue for the whole visit, and the box refreshes without a Loading screen.
  const screen = read('src/backoffice/sections/XeroIntegration.jsx');
  assert.match(screen, /const id = venueRef\.current \|\| getActiveLocationSync\(\); venueRef\.current = id;/);
  assert.match(screen, /onChanged=\{refreshAfterMove\}/);
});
