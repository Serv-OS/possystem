/**
 * adyenAdminRows.test.js: the admin Processing list's row chips, search and
 * the Link to Adyen display lines. Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kycState, adyenVenueStatus, stripeVenueStatus, matchesVenueSearch,
  lookupRows, planLine, linkResultLines, candidateLabel,
} from './adyenAdminRows.js';

test('kycState: top level verificationStatus wins, worst capability otherwise', () => {
  assert.equal(kycState({ verification_status: { verificationStatus: 'valid' } }).state, 'ok');
  assert.equal(kycState({ verification_status: { verificationStatus: 'pending' } }).tone, 'missing');
  assert.equal(kycState({ verification_status: { verificationStatus: 'rejected' } }).tone, 'bad');
  const snap = { verification_status: { capabilities: { receivePayments: { verificationStatus: 'valid' }, sendToTransferInstrument: { verificationStatus: 'pending' } } } };
  assert.equal(kycState(snap).label, 'KYC pending');
});

test('kycState: no snapshot falls back to receive_payments_ok, then the holder', () => {
  assert.deepEqual(kycState({ receive_payments_ok: true }), { state: 'ok', tone: 'ok', label: 'Payments ok' });
  assert.equal(kycState({ account_holder_id: 'AH1' }).label, 'KYC unknown');
  assert.equal(kycState(null).label, 'No KYC');
});

test('adyenVenueStatus: a full live UK row is green everywhere', () => {
  const row = {
    region: 'UK', environment: 'live', store_id: 'ST1', account_holder_id: 'AH1', balance_account_id: 'BA1',
    receive_payments_ok: true, payouts_ok: true, verification_status: { verificationStatus: 'valid' },
  };
  const s = adyenVenueStatus(row, { currency: 'GBP' });
  assert.equal(s.region, 'UK');
  assert.equal(s.live, true);
  assert.equal(s.chips.environment.tone, 'live');
  assert.equal(s.chips.linked.tone, 'ok');
  assert.match(s.chips.linked.title, /Store ST1 on live/);
  assert.equal(s.chips.holder.tone, 'ok');
  assert.equal(s.chips.kyc.label, 'KYC ok');
  assert.equal(s.chips.payouts.tone, 'ok');
  assert.deepEqual(s.ids, { store_id: 'ST1', balance_account_id: 'BA1', account_holder_id: 'AH1' });
});

test('adyenVenueStatus: no row is test, amber everywhere, region by currency', () => {
  const s = adyenVenueStatus(null, { currency: 'USD' });
  assert.equal(s.hasRow, false);
  assert.equal(s.region, 'US');
  assert.equal(s.chips.environment.label, 'Test cards');
  assert.equal(s.chips.environment.tone, 'test');
  for (const k of ['linked', 'holder', 'kyc', 'payouts']) assert.equal(s.chips[k].tone, 'missing', k);
});

test('adyenVenueStatus: Linked means the store is mapped; a plain merchant venue has no holder', () => {
  // A store without a split configuration (FranPOS created it with no
  // Balance Platform): the link wrote the store and flipped the venue live.
  const s = adyenVenueStatus({ environment: 'live', region: 'UK', merchant_account: 'FranPOS_QSR_UK', store_id: 'ST1', receive_payments_ok: true }, { currency: 'GBP' });
  assert.equal(s.linked, true);
  assert.equal(s.holder, false);
  assert.equal(s.chips.linked.label, 'Linked');
  assert.equal(s.chips.holder.label, 'No holder');
  assert.equal(s.chips.holder.tone, 'missing');
  assert.equal(s.chips.kyc.label, 'Payments ok');
  // the reverse: a holder known but no store is NOT linked
  const h = adyenVenueStatus({ environment: 'live', account_holder_id: 'AH1' }, { currency: 'GBP' });
  assert.equal(h.linked, false);
  assert.equal(h.holder, true);
  assert.equal(h.chips.linked.label, 'Not linked');
});

test('adyenVenueStatus: a legacy EU row reads as UK', () => {
  assert.equal(adyenVenueStatus({ region: 'EU' }, { currency: 'GBP' }).region, 'UK');
});

test('stripeVenueStatus: three states', () => {
  assert.equal(stripeVenueStatus(null).status.label, 'Not linked');
  assert.equal(stripeVenueStatus({ charges_enabled: false }).status.tone, 'missing');
  assert.equal(stripeVenueStatus({ charges_enabled: true, stripe_account_id: 'acct_1' }).status.tone, 'ok');
});

test('matchesVenueSearch: name, code, slug and company, every token', () => {
  const v = { name: 'Provo Huddersfield', venue_code: 'SV-1007', online_slug: 'provo', company: 'Provo Restaurants Ltd' };
  assert.equal(matchesVenueSearch(v, ''), true);
  assert.equal(matchesVenueSearch(v, 'sv-1007'), true);
  assert.equal(matchesVenueSearch(v, '1007'), true);
  assert.equal(matchesVenueSearch(v, 'PROVO hudd'), true);
  assert.equal(matchesVenueSearch(v, 'provo leeds'), false);
  assert.equal(matchesVenueSearch(v, 'restaurants'), true);
  assert.equal(matchesVenueSearch(null, 'x'), false);
});

const FOUND = {
  found: true, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK',
  store: { id: 'ST1', reference: 'SV-1007', status: 'active', description: 'Provo', address: { line1: '9a New Street', city: 'Huddersfield', postalCode: 'HD3 4LN' }, splitConfigurationId: 'SP1' },
  balanceAccount: { id: 'BA1', status: 'active', currency: 'GBP', source: 'store' },
  accountHolder: { id: 'AH1', status: 'active', capabilities: { receiveOk: true, payoutsOk: false, verificationStatus: 'pending', problems: ['sendToTransferInstrument: bank statement missing'] } },
  legalEntity: { id: 'LE1', name: 'Provo Restaurants Ltd', type: 'organization', status: 'pending', transferInstrumentId: null },
};

test('lookupRows: one row per object found, tones follow status', () => {
  const rows = lookupRows(FOUND);
  assert.deepEqual(rows.map((r) => r.key), ['store', 'split', 'balance', 'holder', 'legal', 'capabilities']);
  const store = rows.find((r) => r.key === 'store');
  assert.equal(store.value, 'ST1');
  assert.match(store.detail, /reference SV-1007/);
  assert.match(store.detail, /Huddersfield/);
  assert.equal(store.tone, 'ok');
  assert.equal(rows.find((r) => r.key === 'legal').tone, 'missing');
  const caps = rows.find((r) => r.key === 'capabilities');
  assert.match(caps.value, /payouts not allowed/);
  assert.match(caps.detail, /bank statement/);
  assert.equal(caps.tone, 'missing');
});

test('lookupRows: nothing found is an empty list', () => {
  assert.deepEqual(lookupRows({ found: false, candidates: [{ id: 'ST9' }] }), []);
  assert.deepEqual(lookupRows(null), []);
});

test('planLine: noop, refuse, update and flip', () => {
  assert.equal(planLine({ plan: { kind: 'noop', reason: 'Already linked.' } }).tone, 'ok');
  assert.equal(planLine({ plan: { kind: 'refuse', reason: 'needs relink' } }).text, 'needs relink');
  const upd = planLine({ environment: 'live', previous: 'live', plan: { kind: 'update', diff: { changed: ['store_id', 'balance_account_id'] } } });
  assert.match(upd.text, /Will write store, balance account\./);
  assert.match(upd.text, /stays on live/);
  const flip = planLine({ environment: 'live', previous: 'test', plan: { kind: 'flip', diff: { changed: ['account_holder_id'] } } });
  assert.equal(flip.tone, 'live');
  assert.match(flip.text, /from test to live \(real money\)/);
  assert.equal(planLine({}), null);
});

test('linkResultLines: ids, the environment change, cleared setup, registrations and warnings', () => {
  const lines = linkResultLines({
    reference: 'SV-1007', previous: 'test', environment: 'live', region: 'UK', reprovisioned: true,
    patch: { merchant_account: 'FranPOS_QSR_UK', store_id: 'ST1', account_holder_id: 'AH1', verification_status: { x: 1 } },
    web_origins: { ok: true, added: ['https://app.serv-os.app'], existing: [] },
    apple_pay_domains: { ok: false, error: 'Apple Pay is not requested on this merchant' },
    warnings: ['Linked with gaps, this piece could not be read: legal entity LE1: refused (401)'],
  }, 'Provo');
  assert.equal(lines[0].tone, 'ok');
  assert.match(lines[0].text, /^Linked SV-1007: merchant account FranPOS_QSR_UK, store ST1, account holder AH1\.$/);
  assert.equal(lines[1].tone, 'live');
  assert.match(lines[1].text, /Provo now takes LIVE payments on the UK account/);
  assert.match(lines[2].text, /cleared/);
  const origins = lines.find((l) => l.text === 'Web origins');
  assert.equal(origins.items[0].text, 'Added: https://app.serv-os.app');
  const apple = lines.find((l) => l.text === 'Apple Pay domains');
  assert.equal(apple.items[0].tone, 'err');
  assert.equal(lines[lines.length - 1].tone, 'missing');
});

test('linkResultLines: a no op says so and adds nothing else', () => {
  const lines = linkResultLines({ unchanged: true, message: 'Already linked.' });
  assert.deepEqual(lines, [{ tone: 'ok', text: 'Already linked.' }]);
});

test('candidateLabel: reference, description, status and id', () => {
  assert.equal(candidateLabel({ id: 'ST9', reference: 'SV-1008', description: 'Leeds', status: 'inactive' }), 'SV-1008 · "Leeds" · (inactive) · ST9');
  assert.equal(candidateLabel({ id: 'ST9', status: 'active' }), '(no reference) · ST9');
});
