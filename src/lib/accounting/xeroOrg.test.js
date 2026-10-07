import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickConsentedOrg, organisationForSignIn, signInGrantFresh, shouldAskWhichOrganisation, autoPostHeld, signInHolds, SIGN_IN_GRANT_MINUTES, organisationChoices, mappingForNewOrganisation, autoDailyAfterOrganisationChange, allowedOrganisations, previousOrganisation, postedElsewhere, setupMadeForAnother } from '../../../supabase/functions/_shared/xeroOrg.js';
import { xeroAuthEventIdFromToken, xeroUserIdFromToken, tokenFamily, pickTokenDonor } from '../../../supabase/functions/_shared/xeroTokens.js';
import { invoiceReadiness, validateInvoiceMapping, mappingHash } from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { moveWords } from './xeroMoveWords.js';
import { offerForAnswer } from '../../../supabase/functions/_shared/xeroReplacePlan.js';

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

test('which organisation holds a posted day: its own stamp when it has one, else the organisation the site left in its first move after the day', () => {
  const m1 = { at: '2026-10-07T15:00:00.000Z', via: 'picker', tenant_id: 'td01', tenant_name: 'TDNZ', from: 'Coffeeboy Retail LTD', from_tenant_id: 'b2d3' };
  const day = (updated_at, tenant_id) => ({ detail: tenant_id ? { tenant_id } : {}, updated_at });
  // 5 and 6 Oct at a site moved on 7 Oct: posted before the move, no stamp.
  assert.deepEqual(postedElsewhere({ prior: day('2026-10-06T10:10:02Z'), currentTenantId: 'td01', moves: [m1] }), { id: 'b2d3', name: 'Coffeeboy Retail LTD' });
  assert.equal(postedElsewhere({ prior: day('2026-10-08T10:10:02Z'), currentTenantId: 'td01', moves: [m1] }), null, 'posted after the move: where the site is');
  assert.equal(postedElsewhere({ prior: day('2026-10-06T10:10:02Z'), currentTenantId: 'b2d3', moves: [] }), null, 'a site that never moved');
  // The stamp decides when there is one, and the name comes from the records.
  assert.deepEqual(postedElsewhere({ prior: day('2026-10-09T10:10:00Z', 'b2d3'), currentTenantId: 'td01', moves: [m1] }), { id: 'b2d3', name: 'Coffeeboy Retail LTD' });
  assert.equal(postedElsewhere({ prior: day('2026-10-06T10:10:00Z', 'td01'), currentTenantId: 'td01', moves: [m1] }), null);
  // Moved there and back: an old day is again where the site is, and a day posted in between is in TDNZ.
  const m2 = { at: '2026-10-09T09:00:00.000Z', via: 'connect', tenant_id: 'b2d3', tenant_name: 'Coffeeboy Retail LTD', from: 'TDNZ', from_tenant_id: 'td01' };
  assert.equal(postedElsewhere({ prior: day('2026-10-06T10:10:02Z'), currentTenantId: 'b2d3', moves: [m2, m1] }), null, 'posted to Retail, the site is back on Retail');
  assert.deepEqual(postedElsewhere({ prior: day('2026-10-08T10:10:02Z'), currentTenantId: 'b2d3', moves: [m2, m1] }), { id: 'td01', name: 'TDNZ' });
  // A disconnect note is not a move; no clock on the day = say nothing.
  assert.equal(postedElsewhere({ prior: day('2026-10-06T10:10:02Z'), currentTenantId: 'b2d3', moves: [{ at: '2026-10-07T12:00:00Z', via: 'disconnect', tenant_id: 'b2d3' }] }), null);
  assert.equal(postedElsewhere({ prior: { detail: {} }, currentTenantId: 'td01', moves: [m1] }), null);
  assert.equal(postedElsewhere(), null);
});

test('xero-connect: the setup is reset BEFORE the organisation changes, the copy is written before anything is cleared, and the new tokens reach every row of the Xero user', () => {
  const src = read('supabase/functions/xero-connect/index.ts');
  // set_organisation: reset, then the tenant update.
  const set = src.slice(src.indexOf("if (action === 'set_organisation')"), src.indexOf("if (action === 'disconnect')"));
  assert.ok(set.indexOf('resetForNewOrganisation(') > 0 && set.indexOf('resetForNewOrganisation(') < set.indexOf(".update({ tenant_id: org.tenantId"), 'reset first, organisation second');
  assert.match(set, /catch \(e\) \{\s*return json\(\{ error:/, 'a failed refresh or Xero read answers JSON, never a bare 500');
  assert.match(set, /const seeAll = acc\.isSuper \|\| signInGrantFresh\(await lastSignIn\(locationId\), acc\.userId\);/);
  assert.match(set, /allowedOrganisations\(organisationChoices\(conns, c\.tenant_id\), company\.tenantIds, c\.tenant_id, seeAll\)/, 'the server enforces the same list the screen shows');
  // resetForNewOrganisation: the copy (logOrganisation) before the clear (update).
  const reset = src.slice(src.indexOf('async function resetForNewOrganisation'), src.indexOf('function redirect('));
  assert.ok(reset.indexOf('await logOrganisation(') > 0 && reset.indexOf('await logOrganisation(') < reset.indexOf("sb.from('xero_config').update("), 'copy first');
  assert.match(reset, /mapping: mappingForNewOrganisation\(cfg\.mapping\), detail: \{\}, auto_daily: autoAfter/);
  // callback: the sign in event picks the organisation; tokens to the user's rows on any organisation, before the reset can fail.
  const cb = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  assert.match(cb, /organisationForSignIn\(\{ conns, authEventId: xeroAuthEventIdFromToken\(t\.access_token\), previous: prev, connected: !!existing \}\)/, 'the sign in event, else the site stays put: never a guess');
  assert.doesNotMatch(cb, /pickConsentedOrg\(/);
  assert.ok(cb.indexOf('previousOrganisation(') < cb.indexOf('organisationForSignIn('), 'what the site is on is read before the organisation is decided');
  assert.match(cb, /if \(!noteFirst && \(by \|\| hold\)\) await noteSignIn\(payload\.loc, by, picked\.matched, count, hold\);/, 'the person who signed in is noted (a site with no connection writes its hold note earlier)');
  assert.ok(cb.indexOf("sb.from('xero_connections').upsert(") < cb.indexOf('if (!noteFirst && (by || hold)) await noteSignIn('), 'the wider list is granted only after the tokens it is read with are stored');
  assert.ok(cb.indexOf(".update(tokenSet).in('location_id', same)") < cb.indexOf('await getConnections(t.access_token)'), 'the new token set is stored before Xero is asked anything else');
  assert.match(cb, /previousOrganisation\(\{ row: existing, record, detail: cached \}\)/);
  assert.match(cb, /\.update\(tokenSet\)\.in\('location_id', same\);/);
  assert.doesNotMatch(cb, /eq\('tenant_id', org\.tenantId\)/, 'no organisation fence on the token copy');
  assert.ok(cb.indexOf(".update(tokenSet).in('location_id', same)") < cb.indexOf('resetForNewOrganisation('), 'tokens stored before the reset');
  assert.ok(cb.indexOf('resetForNewOrganisation(') < cb.indexOf("sb.from('xero_connections').upsert("), 'reset before the site is stored on the new organisation');
});

test('every posted day records its organisation, and neither model posts a setup made for another one', () => {
  const src = read('supabase/functions/xero-sales/index.ts');
  assert.equal((src.match(/if \(setupMadeForAnother\((cfgRow|cfg)\?\.detail, tenantId\)\) throw/g) || []).length, 3, 'a push as a sales invoice, a push as bank transactions, and a replace');
  // The refusal can clear: a stored setup that still names the other organisation is emptied and its figures tick dropped.
  const refuse = src.slice(src.indexOf('async function refuseSetupMadeForAnother'), src.indexOf('async function elsewhereWarning'));
  assert.match(refuse, /setupMadeForAnother\(cur\.detail, tenantId\)/, 'only when the STORED setup says so, not just this run\'s copy');
  assert.match(refuse, /delete mapping\.figuresChecked;/);
  assert.match(refuse, /\.update\(\{ detail: \{\}, mapping,/);
  // A day held by another organisation offers no replace, and the screen shows no replace note for it.
  assert.match(src, /out\.replace = replaceAnswer\(\{ replaceable: false, reason: 'other_organisation', message: '' \}\)/);
  assert.deepEqual(offerForAnswer({ model: 'bank_tx', date: '2026-10-02', replace: { replaceable: false, reason: 'other_organisation', message: '' } }, { postMode: 'sales_invoice', startDate: '2026-10-01' }).show, offerForAnswer(null).show);
  assert.ok(src.indexOf('if (setupMadeForAnother(cfgRow?.detail, tenantId))') < src.indexOf('const detail = await refreshSiteDetail(sb, accessToken, tenantId, locationId, cfgRow?.detail'), 'checked before the cached setup is refreshed for the new organisation');
  assert.match(src, /detail: \{ model: 'sales_invoice', tenant_id: tenantId,/);
  assert.match(src, /detail: \{ sample, tenant_id: tenantId, lines,/);
});

test('the organisation box: the words say what is cleared, where to choose it again, and what does not post by itself', () => {
  const src = read('src/backoffice/sections/xero/OrganisationPicker.jsx');
  assert.match(src, /lookupError/, 'a list Xero could not give is told apart from a list of one');
  assert.doesNotMatch(src, /the only organisation/, 'never claims to know there is only one');
  const fn = moveWords;
  const inv = fn({ site: 'Coffee Boy Headingley', from: 'Coffeeboy Retail LTD', to: 'TDNZ', invoice: true, autoKept: true, setupTab: 'VAT and accounts' });
  assert.ok(inv.includes('From then on each day posts by itself.'));
  const off = fn({ site: 'Coffee Boy Headingley', from: 'Coffeeboy Retail LTD', to: 'TDNZ', invoice: true, autoKept: false, setupTab: 'VAT and accounts' });
  assert.ok(!off.includes('posts by itself.') && off.includes('Auto posting is off for Coffee Boy Headingley'), 'never promises auto posting the server will not keep');
  for (const w of ['Coffee Boy Headingley', 'TDNZ instead of Coffeeboy Retail LTD', 'purchases account', 'NOT posted by themselves', 'stay in Coffeeboy Retail LTD']) assert.ok(inv.includes(w), w);
  const bank = fn({ site: 'A', from: 'X', to: 'Y', invoice: false, setupTab: 'Setup' });
  assert.ok(bank.includes('Auto posting is turned off') && bank.includes('under Posting (Account mapping)'));
  assert.ok(!bank.includes("check a day's figures"), 'a bank transactions site has no figures check');
  // The screen keeps its venue for the whole visit, and the box refreshes without a Loading screen.
  const screen = read('src/backoffice/sections/XeroIntegration.jsx');
  assert.match(screen, /const id = venueRef\.current \|\| tabVenue\(\); venueRef\.current = id;/, 'this tab\'s own venue, once per visit');
  assert.doesNotMatch(screen, /getActiveLocationSync/, 'never the key every tab shares');
  assert.match(screen, /setSiblings\(m\.siblings \|\| \[\]\); setAutoDaily\(!!m\.autoDaily\);\n\s+setTenantName\(m\.tenantName \|\| ''\);/, 'the organisation named beside the sibling sites is refreshed with them');
  assert.match(screen, /onChanged=\{refreshAfterMove\}/);
});

test('three organisations already connected: Xero does not say which, so the site stays where it was set up and Back Office asks (Coffee Boy Preston, 7 Oct 2026)', () => {
  const retail = { tenantId: 'b2d3', tenantType: 'ORGANISATION', tenantName: 'Coffeeboy Retail LTD', authEventId: 'ev-1', updatedDateUtc: '2026-09-28T15:12:00Z' };
  const tdnz = { tenantId: 'td01', tenantType: 'ORGANISATION', tenantName: 'TDNZ Coffee', authEventId: 'ev-2', updatedDateUtc: '2026-10-07T17:14:00Z' };
  const maih = { tenantId: 'ma01', tenantType: 'ORGANISATION', tenantName: 'MAIH', authEventId: 'ev-3', updatedDateUtc: '2026-10-07T18:00:00Z' };
  const conns = [tdnz, retail, maih];
  // "3 organisations connected, Continue": this sign in event is on none of them.
  const stay = organisationForSignIn({ conns, authEventId: 'ev-now', previous: { id: 'b2d3', name: 'Coffeeboy Retail LTD' } });
  assert.equal(stay.org.tenantId, 'b2d3', 'never the first in the list, never the newest: where its setup was made');
  assert.equal(stay.matched, false, 'so Back Office asks which one');
  // Xero did name one (a newly connected organisation): that one, and nothing to ask.
  const named = organisationForSignIn({ conns: [tdnz, retail, { ...maih, authEventId: 'ev-now' }], authEventId: 'ev-now', previous: { id: 'b2d3' } });
  assert.deepEqual([named.org.tenantId, named.matched], ['ma01', true]);
  // A site with nothing to stay on: a placeholder (the newest), and Back Office still asks.
  const fresh = organisationForSignIn({ conns, authEventId: 'ev-now', previous: null });
  assert.deepEqual([fresh.org.tenantId, fresh.matched], ['ma01', false]);
  // The organisation it was on is no longer connected: a placeholder again, and it asks.
  assert.equal(organisationForSignIn({ conns: [tdnz, maih], authEventId: 'ev-now', previous: { id: 'b2d3' } }).matched, false);
  // One organisation only: nothing to ask.
  assert.deepEqual([organisationForSignIn({ conns: [retail], authEventId: 'ev-now' }).org.tenantId, organisationForSignIn({ conns: [retail], authEventId: 'ev-now' }).matched], ['b2d3', true]);
  // Several authorised in one sign in: the site's own if it is among them, and it asks.
  const both = organisationForSignIn({ conns: [{ ...tdnz, authEventId: 'ev-now' }, { ...maih, authEventId: 'ev-now' }, retail], authEventId: 'ev-now', previous: { id: 'td01' } });
  assert.deepEqual([both.org.tenantId, both.matched], ['td01', false]);
  assert.deepEqual(organisationForSignIn({ conns: [] }), { org: null, matched: false, named: false, otherLogin: false });
});

test('the person who just signed in to Xero may pick any organisation the sign in covers, for half an hour, and nobody else', () => {
  const now = Date.parse('2026-10-07T19:00:00Z');
  const grant = { by: 'user-1', at: '2026-10-07T18:45:00Z', matched: false };
  assert.equal(SIGN_IN_GRANT_MINUTES, 30);
  assert.equal(signInGrantFresh(grant, 'user-1', now), true);
  assert.equal(signInGrantFresh(grant, 'user-2', now), false, 'another Back Office user of the same site');
  assert.equal(signInGrantFresh({ ...grant, at: '2026-10-07T18:29:00Z' }, 'user-1', now), false, 'older than half an hour');
  assert.equal(signInGrantFresh({ ...grant, at: '2026-10-07T19:05:00Z' }, 'user-1', now), false, 'a note from the future is not a grant');
  assert.equal(signInGrantFresh(null, 'user-1', now), false);
  assert.equal(signInGrantFresh(grant, null, now), false);
  const all = [{ tenantId: 'b2d3' }, { tenantId: 'td01' }, { tenantId: 'ma01' }];
  assert.deepEqual(allowedOrganisations(all, ['b2d3', 'td01'], 'b2d3', false).map((o) => o.tenantId), ['b2d3', 'td01'], 'an owner who has not signed in: MAIH is not offered');
  assert.deepEqual(allowedOrganisations(all, ['b2d3', 'td01'], 'b2d3', true).map((o) => o.tenantId), ['b2d3', 'td01', 'ma01'], 'just signed in: all three');
  const src = read('supabase/functions/xero-connect/index.ts');
  const orgs = src.slice(src.indexOf("if (action === 'organisations')"), src.indexOf("if (action === 'set_organisation')"));
  assert.match(orgs, /ask: shouldAskWhichOrganisation\(\{ signIn, userId: acc\.userId, lastRecord, organisationCount: all\.length \}\)/, 'the screen is told to ask only when Xero did not say (the rule itself is tested below)');
  assert.match(src, /const SIGN_IN_KIND = 'organisation_sign_in';/, 'a kind of its own: never read as an organisation change');
  const picker = read('src/backoffice/sections/xero/OrganisationPicker.jsx');
  assert.match(picker, /Which organisation are \{site\}&rsquo;s books in\?/);
});

// ── 7 Oct 2026, review of v5.11.36: three follow ups ─────────────────────────
// Coffee Boy: three organisations, all connected by the owner's Xero login.
const cbRetail = { tenantId: 'b2d3', tenantType: 'ORGANISATION', tenantName: 'Coffeeboy Retail LTD', authEventId: 'ev-1', updatedDateUtc: '2026-09-28T15:12:00Z' };
const cbTdnz = { tenantId: 'td01', tenantType: 'ORGANISATION', tenantName: 'TDNZ Coffee', authEventId: 'ev-2', updatedDateUtc: '2026-10-07T17:14:00Z' };
const cbMaih = { tenantId: 'ma01', tenantType: 'ORGANISATION', tenantName: 'MAIH', authEventId: 'ev-3', updatedDateUtc: '2026-10-07T18:00:00Z' };
const ownerSees = [cbTdnz, cbRetail, cbMaih];
const OWNER = 'user-owner';
const at = (hhmm) => `2026-10-07T${hhmm}:00.000Z`;
const ms = (hhmm) => Date.parse(at(hhmm));

test('follow up 1: the question is put to whoever just signed in, ServOS staff included, and stops once they have picked', () => {
  const note = { by: OWNER, at: at('18:45'), matched: false, organisations: 3 };
  const ask = (over = {}) => shouldAskWhichOrganisation({ signIn: note, userId: OWNER, lastRecord: null, organisationCount: 3, nowMs: ms('18:50'), ...over });
  assert.equal(ask(), true, 'the owner login, three organisations, Xero did not ask');
  // The rule has no "staff" switch at all: a super admin who signed in is asked like anyone.
  assert.equal(ask({ signIn: { ...note, by: 'user-servos-staff' }, userId: 'user-servos-staff' }), true);
  assert.equal(ask({ userId: 'user-manager' }), false, 'someone else looking at the same site is not asked');
  assert.equal(ask({ signIn: { ...note, matched: true } }), false, 'Xero named the organisation: nothing to ask');
  assert.equal(ask({ signIn: { by: OWNER, at: at('18:45') } }), false, 'a note that does not say: never ask on a guess');
  assert.equal(ask({ organisationCount: 1 }), false, 'one organisation: nothing to choose');
  assert.equal(ask({ nowMs: ms('19:16') }), false, 'the half hour is over');
  assert.equal(ask({ signIn: null }), false);
  assert.equal(shouldAskWhichOrganisation(), false);
  // Picked in the box, or signed in again and Xero named one: the question stops.
  assert.equal(ask({ lastRecord: { via: 'picker', at: at('18:47'), tenant_id: 'td01' } }), false);
  assert.equal(ask({ lastRecord: { via: 'connect', at: at('18:48'), tenant_id: 'ma01' } }), false);
  // A record from BEFORE this sign in is not an answer to it (yesterday's move, or the reset this very sign in made).
  assert.equal(ask({ lastRecord: { via: 'picker', at: at('18:44'), tenant_id: 'td01' } }), true);
  assert.equal(ask({ lastRecord: { via: 'connect', at: at('18:45'), tenant_id: 'td01' } }), true, 'the same instant is not after');
  // A disconnect note is not a pick, and a record with no clock proves nothing.
  assert.equal(ask({ lastRecord: { via: 'disconnect', at: at('18:49'), tenant_id: 'b2d3' } }), true);
  assert.equal(ask({ lastRecord: { via: 'picker', tenant_id: 'td01' } }), true);
  // The server: the note is read for everyone, staff only widens the list.
  const src = read('supabase/functions/xero-connect/index.ts');
  const orgs = src.slice(src.indexOf("if (action === 'organisations')"), src.indexOf("if (action === 'set_organisation')"));
  assert.match(orgs, /const signIn = await lastSignIn\(locationId\);/);
  assert.doesNotMatch(orgs, /acc\.isSuper \? null/, 'the note is never skipped for a super admin');
  assert.match(orgs, /const seeAll = acc\.isSuper \|\| justSignedIn;/);
  assert.match(orgs, /allowedOrganisations\(all, company\.tenantIds, c\.tenant_id, seeAll\)/);
  assert.match(orgs, /const lastRecord = signIn \? await lastOrganisationRecord\(locationId\)\.catch\(\(\) => null\) : null;/, 'a record that cannot be read is "not answered"');
});

test('follow up 2: a connected site only moves when Xero names exactly one organisation; another Xero login changes nothing', () => {
  const onRetail = { id: 'b2d3', name: 'Coffeeboy Retail LTD' };
  const decide = (conns, authEventId, previous = onRetail, connected = true) => {
    const r = organisationForSignIn({ conns, authEventId, previous, connected });
    return [r.org?.tenantId ?? null, r.matched, r.named, r.otherLogin];
  };
  // The owner login, "3 organisations connected, Continue": stays, and Back Office asks.
  assert.deepEqual(decide(ownerSees, 'ev-now'), ['b2d3', false, false, false]);
  // The owner connects a new organisation at Xero's own chooser: Xero names it, the site moves.
  assert.deepEqual(decide([cbTdnz, cbRetail, { ...cbMaih, authEventId: 'ev-now' }], 'ev-now'), ['ma01', true, true, false]);
  // Xero names the one the site is already on: nothing to ask, nothing moves.
  assert.deepEqual(decide([cbTdnz, { ...cbRetail, authEventId: 'ev-now' }, cbMaih], 'ev-now'), ['b2d3', true, true, false]);
  // THE BUG: the browser is signed in to Xero as another login that sees ONE organisation, not
  // this site's. "Only one in the list" used to count as Xero naming it, and the site was moved.
  const bookkeeper = { tenantId: 'zz99', tenantType: 'ORGANISATION', tenantName: 'Another Company Ltd', authEventId: 'ev-old', updatedDateUtc: '2026-10-07T19:00:00Z' };
  assert.deepEqual(decide([bookkeeper], 'ev-now'), [null, false, false, true]);
  // The same with several: it used to fall to the newest connection.
  assert.deepEqual(decide([bookkeeper, { ...cbMaih, tenantId: 'yy88' }], 'ev-now'), [null, false, false, true]);
  assert.deepEqual(decide([bookkeeper, cbMaih], null), [null, false, false, true], 'a token with no sign in event names nothing');
  // That other login CHOOSES an organisation at Xero's chooser: Xero named exactly one, so it is a real choice.
  assert.deepEqual(decide([{ ...bookkeeper, authEventId: 'ev-now' }], 'ev-now'), ['zz99', true, true, false]);
  // One organisation, the site's own, already connected: nothing to ask, and Xero named nothing.
  assert.deepEqual(decide([cbRetail], 'ev-now'), ['b2d3', true, false, false]);
  // Several authorised in one go (a set, not one): a connected site stays on its own when the
  // sign in can see it at all, and is never moved to one of the set.
  const set = [{ ...cbTdnz, authEventId: 'ev-now' }, { ...cbMaih, authEventId: 'ev-now' }];
  assert.deepEqual(decide([...set, cbRetail], 'ev-now'), ['b2d3', false, false, false]);
  assert.deepEqual(decide(set, 'ev-now'), [null, false, false, true]);

  // A site with NO connection keeps the rule it had: its setup's organisation while that is in
  // the list, else a placeholder, and Back Office asks. It is never "another login".
  assert.deepEqual(decide(ownerSees, 'ev-now', onRetail, false), ['b2d3', false, false, false]);
  assert.deepEqual(decide([cbTdnz, cbMaih], 'ev-now', onRetail, false), ['ma01', false, false, false]);
  assert.deepEqual(decide(ownerSees, 'ev-now', null, false), ['ma01', false, false, false]);
  assert.deepEqual(decide([bookkeeper], 'ev-now', onRetail, false), ['zz99', true, false, false], 'a new connection with one organisation: stored, and its setup is reset');
  assert.deepEqual(decide([...set, cbRetail], 'ev-now', onRetail, false), ['ma01', false, false, false], 'a set that leaves its own out: the newest of the set, as before, and it asks');
  assert.equal(organisationForSignIn({ conns: [bookkeeper], authEventId: 'ev-now', previous: onRetail }).otherLogin, false, 'connected is false unless the callback says so');

  // The callback: other_login leaves before anything is written for this site.
  const src = read('supabase/functions/xero-connect/index.ts');
  const cb = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  const out = cb.indexOf("if (picked.otherLogin) return redirect(withParam(ret, 'xero', 'other_login'));");
  assert.ok(out > 0, 'the callback answers other_login');
  assert.ok(out > cb.indexOf('organisationForSignIn('));
  for (const w of ['resetForNewOrganisation(', "sb.from('xero_connections').upsert(", 'await noteSignIn(']) assert.ok(out < cb.indexOf(w), `other_login returns before ${w}`);
  // The only write before it is the token copy, and that is fenced by Xero user: another login never reaches this row.
  const before = cb.slice(0, out);
  assert.equal((before.match(/\.(update|upsert|insert|delete)\(/g) || []).length, 1, 'one write before other_login');
  assert.match(before, /const same = \(all \|\| \[\]\)\.filter\(\(r: any\) => xeroUserIdFromToken\(r\.access_token\) === uid\)\.map\(\(r: any\) => r\.location_id\);/);
  assert.match(before, /\.update\(tokenSet\)\.in\('location_id', same\);/);
  const sameUser = [{ location_id: 'this-site', access_token: jwt({ xero_userid: 'u-owner' }) }, { location_id: 'other', access_token: jwt({ xero_userid: 'u-bookkeeper' }) }];
  assert.deepEqual(sameUser.filter((r) => xeroUserIdFromToken(r.access_token) === xeroUserIdFromToken(jwt({ xero_userid: 'u-bookkeeper' }))).map((r) => r.location_id), ['other'], 'the bookkeeper\'s new tokens go to the bookkeeper\'s rows only');

  // The screen says it plainly, as its own banner, and the general one no longer covers it.
  const screen = read('src/backoffice/sections/XeroIntegration.jsx');
  assert.match(screen, /\{flash === 'other_login' && \(/);
  assert.match(screen, /Nothing was changed\. The Xero login you used cannot see the organisation this site posts to/);
  assert.match(screen, /Sign in to Xero with the login that connected this site\./);
  assert.match(screen, /\{flash && flash !== 'connected' && flash !== 'other_login' && <div style=\{S\.banner\(false\)\}>/);
  assert.match(screen, /\{flash === 'connected' && <div style=\{S\.banner\(true\)\}>/, 'the other banners are as they were');
  const banner = screen.slice(screen.indexOf("{flash === 'other_login' && ("), screen.indexOf("{flash && flash !== 'connected'"));
  assert.doesNotMatch(banner, /[\u2013\u2014]/, 'no dashes in words on screen');
  // The box's own promise before a sign in is now true: nothing changes without a pick.
  const picker = read('src/backoffice/sections/xero/OrganisationPicker.jsx');
  assert.match(picker, /Nothing changes for \$\{site\} until you pick a different organisation from \$\{here\}\./);
});

test('follow up 3: a disconnected site that signs in when Xero does not ask: auto posting waits for the pick, half an hour at most (Coffee Boy)', () => {
  // The site was disconnected: no connection row, its last organisation record says Retail.
  const previous = previousOrganisation({ row: null, record: { via: 'disconnect', at: at('18:30'), tenant_id: 'b2d3', tenant_name: 'Coffeeboy Retail LTD' }, detail: { site: { tenantId: 'b2d3' } } });
  const picked = organisationForSignIn({ conns: ownerSees, authEventId: 'ev-now', previous, connected: false });
  assert.deepEqual([picked.org.tenantId, picked.matched], ['b2d3', false], 'stored back on Retail, still Ready, still on auto posting, and nobody has said it is right');
  // What the callback writes for it (hold = no connection row and Xero did not say which).
  const note = { by: OWNER, at: at('18:45'), matched: picked.matched, organisations: 3, hold: true };
  const disconnect = { via: 'disconnect', at: at('18:30'), tenant_id: 'b2d3' };
  const held = (over = {}) => autoPostHeld({ signIn: note, lastRecord: disconnect, nowMs: ms('19:10'), ...over });
  assert.equal(held(), true, 'the 19:10 hourly run posts nothing');
  assert.equal(shouldAskWhichOrganisation({ signIn: note, userId: OWNER, lastRecord: disconnect, organisationCount: 3, nowMs: ms('19:10') }), true, 'and the owner is being asked');
  // The owner picks TDNZ at 18:50: the hold ends at once (the move itself resets the setup).
  const pick = { via: 'picker', at: at('18:50'), tenant_id: 'td01', from_tenant_id: 'b2d3' };
  assert.equal(held({ lastRecord: pick }), false);
  assert.equal(shouldAskWhichOrganisation({ signIn: note, userId: OWNER, lastRecord: pick, organisationCount: 3, nowMs: ms('19:10') }), false);
  // Nobody picks: it ends by itself after the same half hour, with nothing to switch back on.
  assert.equal(held({ nowMs: ms('19:15') }), true, 'the last minute of the half hour');
  assert.equal(held({ nowMs: ms('19:16') }), false);
  assert.equal(held({ nowMs: ms('20:10') }), false, 'the next hourly run posts as usual');
  // No record at all (a read that found none), a disconnect after the note, a record with no clock: still held.
  assert.equal(held({ lastRecord: null }), true);
  assert.equal(held({ lastRecord: { via: 'disconnect', at: at('18:55') } }), true);
  assert.equal(held({ lastRecord: { via: 'picker' } }), true);
  // The reset this very sign in made (a placeholder organisation) is older than the note: not a pick.
  assert.equal(held({ lastRecord: { via: 'connect', at: at('18:44'), tenant_id: 'ma01' } }), true);
  // Only a note that says hold: a connected site that stays put is asked but never held, nor is one Xero named.
  assert.equal(held({ signIn: { ...note, hold: false } }), false);
  assert.equal(held({ signIn: { by: OWNER, at: at('18:45'), matched: false } }), false, 'a note from before this release');
  assert.equal(held({ signIn: { ...note, hold: 'true' } }), false);
  assert.equal(held({ signIn: null }), false);
  assert.equal(held({ signIn: { ...note, at: 'not a time' } }), false);
  assert.equal(autoPostHeld(), false);
  // The hold is about the site, not the person: a note with nobody named still holds, and asks nobody.
  assert.equal(held({ signIn: { ...note, by: null } }), true);
  assert.equal(shouldAskWhichOrganisation({ signIn: { ...note, by: null }, userId: OWNER, organisationCount: 3, nowMs: ms('19:10') }), false);
  // Two servers, two clocks: a note a few seconds ahead still holds; one far ahead is not believed.
  assert.equal(held({ nowMs: Date.parse(note.at) - 5000 }), true);
  assert.equal(held({ nowMs: ms('18:40') }), false);

  // xero-connect: hold only for a site with no connection row when Xero did not say; written
  // after the reset (whose own record must stay older than the note) and before the site is stored.
  const connect = read('supabase/functions/xero-connect/index.ts');
  const cb = connect.slice(connect.indexOf("if (req.method === 'GET')"), connect.indexOf("if (req.method !== 'POST')"));
  assert.equal(signInHolds({ connected: false, matched: false }), true, 'no connection row and Xero did not say');
  assert.equal(signInHolds({ connected: false, matched: true }), false, 'Xero named it, or there is only one');
  assert.equal(signInHolds({ connected: true, matched: false }), false, 'a connected site that stays put was posting there already');
  // The box offers "Sign in to Xero" again. A second sign in while the hold stands must not end it.
  assert.equal(signInHolds({ connected: true, matched: false, standing: true }), true);
  assert.equal(signInHolds({ connected: true, matched: true, standing: true }), false, 'this time Xero said which one: that is the answer');
  assert.equal(signInHolds(), true);
  const second = { ...note, at: at('18:55'), hold: signInHolds({ connected: true, matched: false, standing: held({ nowMs: ms('18:55') }) }) };
  assert.equal(held({ signIn: second, nowMs: ms('19:10') }), true, 'the newest note carries the hold on');
  assert.equal(held({ signIn: second, nowMs: ms('19:26') }), false, 'and it still ends by itself, half an hour after the last sign in');
  assert.match(cb, /if \(existing && !picked\.matched\) \{\s+standing = autoPostHeld\(\{ signIn: await lastSignIn\(payload\.loc\), lastRecord: await lastOrganisationRecord\(payload\.loc\)\.catch\(\(\) => null\) \}\);/);
  assert.match(cb, /const hold = signInHolds\(\{ connected: !!existing, matched: picked\.matched, standing \}\);/);
  assert.match(cb, /const noteFirst = hold && !existing;/);
  const holdNote = cb.indexOf('if (noteFirst) await noteSignIn(payload.loc, by, picked.matched, count, true);');
  assert.ok(holdNote > cb.indexOf('resetForNewOrganisation(') && holdNote < cb.indexOf("sb.from('xero_connections').upsert("), 'after the reset, before the connection exists');
  assert.match(connect, /detail: \{ by, at, matched, organisations: count, hold \}/);
  const orgs = connect.slice(connect.indexOf("if (action === 'organisations')"), connect.indexOf("if (action === 'set_organisation')"));
  assert.match(orgs, /held: autoPostHeld\(\{ signIn, lastRecord \}\)/, 'the box is told with the same rule the hourly job uses');

  // xero-sales: auto runs only, before the day is read, claimed or posted, and nothing is written.
  const sales = read('supabase/functions/xero-sales/index.ts');
  const serve = sales.slice(sales.indexOf('Deno.serve('));
  const gate = serve.indexOf('if (auto && !dryRun && await autoHeldAfterSignIn(locationId)) {');
  assert.ok(gate > 0, 'only the hourly job (auto), never a push by a person');
  for (const w of ['const key = {', 'readSyncRow(', 'claimSyncRun(', 'replaceDay(', 'invoiceDay(', 'getValidAccessToken(']) assert.ok(gate < serve.indexOf(w), `held before ${w}`);
  assert.match(serve.slice(gate, serve.indexOf('const key = {')), /return json\(\{ ok: true, held: true, \.\.\.base, reason: '/);
  const fn = sales.slice(sales.indexOf('async function autoHeldAfterSignIn'), sales.indexOf('async function elsewhereWarning'));
  assert.doesNotMatch(fn, /\.(insert|update|upsert|delete)\(/, 'the hold writes no row, so the next hourly run tries again');
  assert.match(fn, /await last\('organisation_sign_in'\)/);
  assert.match(fn, /autoPostHeld\(\{ signIn, lastRecord: await last\('organisation'\) \}\)/);
  assert.match(fn, /catch \(e\) \{[^}]*return false; \}/, 'a read that fails means not held');
  assert.match(connect, /const ORG_KIND = 'organisation';/, 'the two functions read and write the same kinds');

  // The box tells the person, only while auto posting is on for the site.
  const picker = read('src/backoffice/sections/xero/OrganisationPicker.jsx');
  assert.match(picker, /setHeld\(!!r\?\.held\);/);
  assert.match(picker, /\{held && autoDaily && <> Nothing is posted by itself for \{site\} in the half hour after your sign in, so there is time to pick\.<\/>\}/);
  assert.doesNotMatch(picker.slice(picker.indexOf('{ask ? ('), picker.indexOf(') : (', picker.indexOf('{ask ? ('))), /[\u2013\u2014]/, 'no dashes in words on screen');
});
