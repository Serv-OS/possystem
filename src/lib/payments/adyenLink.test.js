/**
 * adyenLink.test.js: the contract for BOTH copies of the pull by reference
 * helpers, src/lib/payments/adyenLink.js (this one) and
 * supabase/functions/_shared/adyenLink.ts (the Deno copy, which cannot
 * import from src/). When a test here changes, the Deno copy changes with it.
 *
 * Run: `npm test` (Node's built-in runner, no third party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LINK_ID_FIELDS, VERIFICATION_ORDER,
  referenceKey, storeRows, matchStoreByReference, storeSummary, storeCandidates,
  worstVerificationStatus, summariseCapabilities, legalEntityName, legalEntitySummary,
  accountHolderSummary, balanceAccountSummary, pickBalanceAccount, resolveLinkEnvironment,
  buildLinkPatch, linkDiff, planLink, replacementClear, lookupSummary,
} from './adyenLink.js';

// ── fixtures: the shapes Adyen answers with (docs.adyen.com, 8 Sep 2026) ────

const PROVO = {
  id: 'ST3224Z223226M5KMQ5RLXV2W', reference: 'SV-1007', merchantId: 'FranPOS_QSR_UK', status: 'active',
  description: 'Provo', shopperStatement: 'PROVO', phoneNumber: '+441onelong',
  address: { line1: '12 Market Street', city: 'Leeds', postalCode: 'LS1 6DG', country: 'GB' },
  businessLineIds: ['SBL3224Z223226M5KMQ5PLINE1'],
  splitConfiguration: { balanceAccountId: 'BA3224Z223226M5KMQ5RBAL01', splitConfigurationId: 'SC3224Z223226M5KMQ5SPLIT1' },
};
const OTHER = { id: 'ST3224Z223226M5KMQ5OTHER1', reference: 'SV-1008', merchantId: 'FranPOS_QSR_UK', status: 'active', description: 'Other venue' };
const CLOSED = { id: 'ST3224Z223226M5KMQ5CLOSED', reference: 'OLD-1', merchantId: 'FranPOS_QSR_UK', status: 'closed', description: 'Closed one, mentions SV-1007 in its name' };

const CAPS = {
  receivePayments: { enabled: true, allowed: true, requested: true, verificationStatus: 'valid' },
  receiveFromPlatformPayments: { enabled: true, allowed: true, requested: true, verificationStatus: 'valid' },
  sendToTransferInstrument: {
    enabled: false, allowed: false, requested: true, verificationStatus: 'pending',
    problems: [{ entity: { id: 'LE1', type: 'LegalEntity' }, verificationErrors: [{ code: '1_30', message: 'Bank account not verified', type: 'dataMissing' }] }],
  },
  issueCard: { enabled: false, allowed: false, requested: false, verificationStatus: 'rejected' },
};

const HOLDER = {
  id: 'AH32BZP22322CJ5PXF2BD5FTR', reference: 'SV-1007', description: 'Provo', status: 'active',
  legalEntityId: 'LE32BZP22322CJ5PXF2BDLEG1', primaryBalanceAccount: 'BA3224Z223226M5KMQ5RBAL01', balancePlatform: 'FranPOSPlatform',
  capabilities: CAPS,
};
const BALANCE = { id: 'BA3224Z223226M5KMQ5RBAL01', accountHolderId: 'AH32BZP22322CJ5PXF2BD5FTR', reference: 'SV-1007 GBP', status: 'active', defaultCurrencyCode: 'GBP', balances: [] };
const LEGAL = {
  id: 'LE32BZP22322CJ5PXF2BDLEG1', type: 'organization', reference: 'provo-ltd',
  organization: { legalName: 'Provo Coffee Ltd', registeredAddress: { country: 'GB' } },
  capabilities: { receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' }, sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'pending' } },
  transferInstruments: [{ id: 'SI32BZP22322CJ5PXF2BDBANK1', accountIdentifier: '****1234' }, { id: 'SI32BZP22322CJ5PXF2BDBANK2' }],
  problems: [{ entity: { id: 'LE32BZP22322CJ5PXF2BDLEG1', type: 'LegalEntity' }, verificationErrors: [{ code: '2_8046', message: 'Registration document missing' }] }],
};

// ── constants ────────────────────────────────────────────────────────────────

test('LINK_ID_FIELDS names the eight id columns a link writes, frozen', () => {
  assert.deepEqual([...LINK_ID_FIELDS], ['merchant_account', 'store_id', 'split_profile_id', 'balance_account_id', 'account_holder_id', 'legal_entity_id', 'business_line_id', 'transfer_instrument_id']);
  assert.ok(Object.isFrozen(LINK_ID_FIELDS));
  assert.deepEqual([...VERIFICATION_ORDER], ['valid', 'pending', 'invalid', 'rejected']);
});

// ── reference matching ───────────────────────────────────────────────────────

test('referenceKey: trimmed and upper cased, empty for nothing', () => {
  assert.equal(referenceKey(' sv-1007 '), 'SV-1007');
  assert.equal(referenceKey('SV-1007'), 'SV-1007');
  assert.equal(referenceKey(null), '');
  assert.equal(referenceKey(undefined), '');
  assert.equal(referenceKey(1007), '1007');
});

test('storeRows: rows under data, a bare array, junk dropped', () => {
  assert.deepEqual(storeRows({ data: [PROVO, null, 'x', OTHER] }), [PROVO, OTHER]);
  assert.deepEqual(storeRows([PROVO]), [PROVO]);
  assert.deepEqual(storeRows({ itemsTotal: 0 }), []);
  assert.deepEqual(storeRows(null), []);
  assert.deepEqual(storeRows('nope'), []);
});

test('matchStoreByReference: exact, case insensitive, never partial', () => {
  const list = { data: [OTHER, PROVO, CLOSED] };
  assert.equal(matchStoreByReference(list, 'SV-1007').store, PROVO);
  assert.equal(matchStoreByReference(list, 'sv-1007').store, PROVO);
  assert.equal(matchStoreByReference(list, ' SV-1007 ').store, PROVO);
  assert.equal(matchStoreByReference(list, 'SV-100').store, null);      // prefix is not a match
  assert.equal(matchStoreByReference(list, 'SV-10070').store, null);
  assert.deepEqual(matchStoreByReference(list, 'SV-100').matches, []);
  assert.deepEqual(matchStoreByReference(list, '').matches, []);
  assert.equal(matchStoreByReference(list, null).store, null);
});

test('matchStoreByReference: a repeated page collapses, two distinct stores are ambiguous', () => {
  const repeated = matchStoreByReference([PROVO, { ...PROVO }], 'SV-1007');
  assert.equal(repeated.store, PROVO);
  assert.equal(repeated.ambiguous, false);
  assert.equal(repeated.matches.length, 1);
  const twoMerchants = matchStoreByReference([PROVO, { ...PROVO, id: 'ST_US_COPY', merchantId: 'FranPOS_QSR_US' }], 'SV-1007');
  assert.equal(twoMerchants.store, null);
  assert.equal(twoMerchants.ambiguous, true);
  assert.equal(twoMerchants.matches.length, 2);
});

test('storeSummary: ids, lower cased status, address, split configuration and business lines', () => {
  const s = storeSummary({ ...PROVO, status: 'Active' });
  assert.equal(s.id, PROVO.id);
  assert.equal(s.reference, 'SV-1007');
  assert.equal(s.status, 'active');
  assert.equal(s.merchantId, 'FranPOS_QSR_UK');
  assert.equal(s.description, 'Provo');
  assert.deepEqual(s.address, { line1: '12 Market Street', city: 'Leeds', postalCode: 'LS1 6DG', country: 'GB' });
  assert.deepEqual(s.businessLineIds, ['SBL3224Z223226M5KMQ5PLINE1']);
  assert.equal(s.splitConfigurationId, 'SC3224Z223226M5KMQ5SPLIT1');
  assert.equal(s.balanceAccountId, 'BA3224Z223226M5KMQ5RBAL01');
});

test('storeSummary: a bare store has null pieces, never throws', () => {
  const s = storeSummary({ id: 'ST1', reference: 'X' });
  assert.equal(s.status, null);
  assert.equal(s.address, null);
  assert.deepEqual(s.businessLineIds, []);
  assert.equal(s.splitConfigurationId, null);
  assert.equal(s.balanceAccountId, null);
  assert.equal(storeSummary(null), null);
  assert.equal(storeSummary('ST1'), null);
});

test('storeCandidates: mentions of the reference first, then the rest in order, deduped, capped', () => {
  const list = { data: [OTHER, CLOSED, PROVO, { ...OTHER }] };
  const c = storeCandidates(list, 'SV-1007');
  assert.deepEqual(c.map((x) => x.id), [PROVO.id, CLOSED.id, OTHER.id]);
  assert.deepEqual(c[2], { id: OTHER.id, reference: 'SV-1008', description: 'Other venue', status: 'active', merchantId: 'FranPOS_QSR_UK' });
  assert.equal(storeCandidates(list, 'SV-1007', 2).length, 2);
  assert.deepEqual(storeCandidates(list, '').map((x) => x.id), [OTHER.id, CLOSED.id, PROVO.id]);
  assert.deepEqual(storeCandidates(null, 'SV-1007'), []);
});

test('storeCandidates: description falls back to the shopper statement', () => {
  const [c] = storeCandidates([{ id: 'ST9', shopperStatement: 'CAFE NINE', status: 'inactive' }], 'x');
  assert.deepEqual(c, { id: 'ST9', reference: null, description: 'CAFE NINE', status: 'inactive', merchantId: null });
});

// ── capabilities ─────────────────────────────────────────────────────────────

test('worstVerificationStatus: rejected beats invalid beats pending beats valid, unknown ignored', () => {
  assert.equal(worstVerificationStatus(['valid', 'pending']), 'pending');
  assert.equal(worstVerificationStatus(['pending', 'invalid', 'valid']), 'invalid');
  assert.equal(worstVerificationStatus(['valid', 'REJECTED']), 'rejected');
  assert.equal(worstVerificationStatus(['valid']), 'valid');
  assert.equal(worstVerificationStatus(['weird', null, undefined]), null);
  assert.equal(worstVerificationStatus([]), null);
  assert.equal(worstVerificationStatus(null), null);
});

test('summariseCapabilities: flags, worst requested status, problem lines, snapshot shape', () => {
  const s = summariseCapabilities(CAPS);
  assert.equal(s.receiveOk, true);
  assert.equal(s.payoutsOk, false);
  assert.equal(s.verificationStatus, 'pending');            // issueCard is not requested, so its rejected does not count
  assert.deepEqual(s.problems, ['sendToTransferInstrument: Bank account not verified']);
  assert.deepEqual(s.byName.receivePayments, { enabled: true, allowed: true, requested: true, verificationStatus: 'valid', problems: undefined });
  assert.equal(s.byName.sendToTransferInstrument.problems.length, 1);
  assert.equal(s.byName.issueCard.verificationStatus, 'rejected');
});

test('summariseCapabilities: receiveFromPlatformPayments alone grants receiveOk; payouts only from sendToTransferInstrument', () => {
  const s = summariseCapabilities({ receiveFromPlatformPayments: { allowed: true }, sendToTransferInstrument: { allowed: true, verificationStatus: 'valid' } });
  assert.equal(s.receiveOk, true);
  assert.equal(s.payoutsOk, true);
  assert.equal(s.verificationStatus, 'valid');
  const none = summariseCapabilities(null);
  assert.deepEqual(none, { receiveOk: false, payoutsOk: false, verificationStatus: null, problems: [], byName: {} });
  assert.equal(summariseCapabilities({ receivePayments: 'yes' }).receiveOk, false);
});

test('summariseCapabilities: a problem with only a code, or a flat message, still reads', () => {
  const s = summariseCapabilities({
    receivePayments: { requested: true, problems: [{ verificationErrors: [{ code: '1_50' }] }, { message: 'flat message' }, { nothing: true }] },
  });
  assert.deepEqual(s.problems, ['receivePayments: 1_50', 'receivePayments: flat message']);
});

// ── legal entity, account holder, balance account ────────────────────────────

test('legalEntityName: organisation, individual, sole proprietorship, trust, reference', () => {
  assert.equal(legalEntityName(LEGAL), 'Provo Coffee Ltd');
  assert.equal(legalEntityName({ type: 'individual', individual: { name: { firstName: 'Jane', lastName: 'Doe' } } }), 'Jane Doe');
  assert.equal(legalEntityName({ type: 'soleProprietorship', soleProprietorship: { name: 'Jane Trading' } }), 'Jane Trading');
  assert.equal(legalEntityName({ type: 'trust', trust: { name: 'The Trust' } }), 'The Trust');
  assert.equal(legalEntityName({ reference: 'ref-only' }), 'ref-only');
  assert.equal(legalEntityName({}), null);
  assert.equal(legalEntityName(null), null);
});

test('legalEntitySummary: name, type, worst status, bank accounts and every problem line', () => {
  const s = legalEntitySummary(LEGAL);
  assert.equal(s.id, LEGAL.id);
  assert.equal(s.name, 'Provo Coffee Ltd');
  assert.equal(s.type, 'organization');
  assert.equal(s.reference, 'provo-ltd');
  assert.equal(s.status, 'pending');
  assert.equal(s.transferInstrumentId, 'SI32BZP22322CJ5PXF2BDBANK1');
  assert.deepEqual(s.transferInstruments, ['SI32BZP22322CJ5PXF2BDBANK1', 'SI32BZP22322CJ5PXF2BDBANK2']);
  assert.deepEqual(s.problems, ['legalEntity: Registration document missing']);
  assert.equal(s.capabilities.receivePayments.verificationStatus, 'valid');
  assert.equal(legalEntitySummary(null), null);
  assert.equal(legalEntitySummary({ id: 'LE0' }).transferInstrumentId, null);
});

test('accountHolderSummary and balanceAccountSummary: the fields the admin sees', () => {
  const h = accountHolderSummary(HOLDER);
  assert.equal(h.id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(h.reference, 'SV-1007');
  assert.equal(h.status, 'active');
  assert.equal(h.legalEntityId, 'LE32BZP22322CJ5PXF2BDLEG1');
  assert.equal(h.primaryBalanceAccount, 'BA3224Z223226M5KMQ5RBAL01');
  assert.equal(h.balancePlatform, 'FranPOSPlatform');
  assert.equal(h.capabilities.receiveOk, true);
  assert.equal(h.capabilities.payoutsOk, false);
  assert.equal(accountHolderSummary(null), null);
  const b = balanceAccountSummary(BALANCE);
  assert.deepEqual(b, { id: 'BA3224Z223226M5KMQ5RBAL01', reference: 'SV-1007 GBP', description: null, status: 'active', accountHolderId: 'AH32BZP22322CJ5PXF2BD5FTR', currency: 'GBP', source: 'store' });
  assert.equal(balanceAccountSummary(BALANCE, 'account_holder').source, 'account_holder');
  assert.equal(balanceAccountSummary(undefined), null);
});

test('pickBalanceAccount: primary, then the one open account in the currency, then the only one', () => {
  const gbp = { id: 'BA_GBP', status: 'active', defaultCurrencyCode: 'GBP' };
  const usd = { id: 'BA_USD', status: 'active', defaultCurrencyCode: 'USD' };
  const closedGbp = { id: 'BA_OLD', status: 'closed', defaultCurrencyCode: 'GBP' };
  assert.equal(pickBalanceAccount({ balanceAccounts: [usd, gbp] }, { primaryId: 'BA_USD' }), usd);
  assert.equal(pickBalanceAccount({ balanceAccounts: [usd, gbp] }, { currency: 'gbp' }), gbp);
  assert.equal(pickBalanceAccount([usd, gbp, closedGbp], { currency: 'GBP' }), gbp);          // closed ones do not count
  assert.equal(pickBalanceAccount([gbp, { ...gbp, id: 'BA_GBP2' }], { currency: 'GBP' }), null);   // two open GBP: the admin picks
  assert.equal(pickBalanceAccount([usd], { currency: 'GBP' }), usd);                           // the only account there is
  assert.equal(pickBalanceAccount([closedGbp], { currency: 'GBP' }), closedGbp);              // only a closed one: still the only one
  assert.equal(pickBalanceAccount([usd, gbp], {}), null);
  assert.equal(pickBalanceAccount({ balanceAccounts: [] }, { currency: 'GBP' }), null);
  assert.equal(pickBalanceAccount(null, { currency: 'GBP' }), null);
});

// ── environment ──────────────────────────────────────────────────────────────

test('resolveLinkEnvironment: live by default, test only when the venue is on test and asks for it', () => {
  assert.equal(resolveLinkEnvironment('test', undefined), 'live');
  assert.equal(resolveLinkEnvironment('test', 'live'), 'live');
  assert.equal(resolveLinkEnvironment('test', 'test'), 'test');
  assert.equal(resolveLinkEnvironment('test', ' TEST '), 'test');
  assert.equal(resolveLinkEnvironment('live', 'test'), 'live');
  assert.equal(resolveLinkEnvironment('live', undefined), 'live');
  assert.equal(resolveLinkEnvironment(undefined, 'test'), 'test');    // no row reads as test
});

// ── the row patch ────────────────────────────────────────────────────────────

const LOOKUP = {
  found: true, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK',
  store: storeSummary(PROVO), balanceAccount: balanceAccountSummary(BALANCE), accountHolder: accountHolderSummary(HOLDER), legalEntity: legalEntitySummary(LEGAL),
  splitConfigurationId: 'SC3224Z223226M5KMQ5SPLIT1', businessLineIds: ['SBL3224Z223226M5KMQ5PLINE1'], candidates: [], errors: [],
};

test('buildLinkPatch: the full chain becomes the eight ids, the flags and the snapshot', () => {
  const p = buildLinkPatch(LOOKUP, { merchantAccount: 'FranPOS_QSR_UK', region: 'UK', environment: 'live', at: '2026-09-08T10:00:00.000Z' });
  assert.equal(p.merchant_account, 'FranPOS_QSR_UK');
  assert.equal(p.store_id, PROVO.id);
  assert.equal(p.split_profile_id, 'SC3224Z223226M5KMQ5SPLIT1');
  assert.equal(p.balance_account_id, 'BA3224Z223226M5KMQ5RBAL01');
  assert.equal(p.account_holder_id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(p.legal_entity_id, 'LE32BZP22322CJ5PXF2BDLEG1');
  assert.equal(p.business_line_id, 'SBL3224Z223226M5KMQ5PLINE1');
  assert.equal(p.transfer_instrument_id, 'SI32BZP22322CJ5PXF2BDBANK1');
  assert.equal(p.receive_payments_ok, true);
  assert.equal(p.payouts_ok, false);
  assert.equal(p.region, 'UK');
  assert.equal(p.environment, 'live');
  assert.equal(p.verification_status.source, 'adyen_link');
  assert.equal(p.verification_status.at, '2026-09-08T10:00:00.000Z');
  assert.equal(p.verification_status.reference, 'SV-1007');
  assert.equal(p.verification_status.accountHolderStatus, 'active');
  assert.equal(p.verification_status.verificationStatus, 'pending');
  assert.equal(p.verification_status.capabilities.receivePayments.allowed, true);
  assert.deepEqual(p.verification_status.legalEntity, { id: 'LE32BZP22322CJ5PXF2BDLEG1', name: 'Provo Coffee Ltd', status: 'pending' });
});

test('buildLinkPatch: only what was found rides, an inactive store is not receive ok', () => {
  const p = buildLinkPatch({ reference: 'SV-1007', store: storeSummary({ ...OTHER, status: 'inactive' }) }, { merchantAccount: 'FranPOS_QSR_UK', region: 'UK', environment: 'live' });
  assert.deepEqual(Object.keys(p).sort(), ['environment', 'merchant_account', 'receive_payments_ok', 'region', 'store_id'].sort());
  assert.equal(p.receive_payments_ok, false);
  assert.equal('balance_account_id' in p, false);
  assert.equal('payouts_ok' in p, false);
  assert.equal('verification_status' in p, false);
});

test('buildLinkPatch: ids fall through from the store and the holder when the deeper reads failed', () => {
  const p = buildLinkPatch({ store: storeSummary(PROVO), accountHolder: accountHolderSummary({ ...HOLDER, capabilities: null }) }, { environment: 'LIVE' });
  assert.equal(p.merchant_account, 'FranPOS_QSR_UK');            // from the store's merchantId
  assert.equal(p.balance_account_id, 'BA3224Z223226M5KMQ5RBAL01');   // from the store's split configuration
  assert.equal(p.split_profile_id, 'SC3224Z223226M5KMQ5SPLIT1');
  assert.equal(p.account_holder_id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(p.legal_entity_id, 'LE32BZP22322CJ5PXF2BDLEG1');     // from the holder's legalEntityId
  assert.equal(p.business_line_id, 'SBL3224Z223226M5KMQ5PLINE1');
  assert.equal(p.environment, 'live');
  assert.equal(p.payouts_ok, false);                                  // the holder was read, its capabilities were empty
  assert.equal(p.verification_status.verificationStatus, null);
  assert.equal(buildLinkPatch(null).store_id, undefined);
  assert.deepEqual(buildLinkPatch(null), {});
});

test('linkDiff: unchanged, blanks filled, conflicts, merchant name case insensitive', () => {
  const row = { merchant_account: 'franpos_qsr_uk', store_id: PROVO.id, balance_account_id: 'BA_OLD', legal_entity_id: null };
  const same = linkDiff(row, { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id });
  assert.deepEqual(same, { changed: [], conflicts: [], same: ['merchant_account', 'store_id'], unchanged: true });
  const fill = linkDiff(row, { legal_entity_id: 'LE1', account_holder_id: 'AH1' });
  assert.deepEqual(fill.changed, ['account_holder_id', 'legal_entity_id']);
  assert.deepEqual(fill.conflicts, []);
  assert.equal(fill.unchanged, false);
  const conflict = linkDiff(row, { balance_account_id: 'BA_NEW', store_id: PROVO.id });
  assert.deepEqual(conflict.conflicts, [{ field: 'balance_account_id', current: 'BA_OLD', next: 'BA_NEW' }]);
  assert.deepEqual(conflict.same, ['store_id']);
  assert.equal(linkDiff(null, { store_id: 'ST1' }).unchanged, false);
  assert.equal(linkDiff({ store_id: 'ST1' }, { receive_payments_ok: true }).unchanged, true);   // flags are not ids
  assert.equal(linkDiff({ store_id: 'st1' }, { store_id: 'ST1' }).unchanged, false);            // Adyen ids compare exactly
});

// ── the plan ─────────────────────────────────────────────────────────────────

test('planLink: same ids on the same environment is a no op', () => {
  const row = { environment: 'live', merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, balance_account_id: 'BA1' };
  const plan = planLink({ row, currentEnv: 'live', targetEnv: 'live', patch: { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, balance_account_id: 'BA1' }, provisioned: ['store_id', 'balance_account_id'], readers: 3 });
  assert.equal(plan.kind, 'noop');
  assert.match(plan.reason, /already linked/);
});

test('planLink: different ids on live are refused until relink is true', () => {
  const row = { store_id: 'ST_OLD', balance_account_id: 'BA_OLD' };
  const patch = { store_id: PROVO.id, balance_account_id: 'BA_OLD' };
  const refused = planLink({ row, currentEnv: 'live', targetEnv: 'live', patch });
  assert.equal(refused.kind, 'refuse');
  assert.match(refused.reason, /already linked on live to different Adyen ids \(store_id ST_OLD to ST3224Z223226M5KMQ5RLXV2W\)/);
  assert.match(refused.reason, /Confirm to replace them\./);          // plain words: the admin reads this line as it is
  assert.doesNotMatch(refused.reason, /relink: true/);
  const allowed = planLink({ row, currentEnv: 'live', targetEnv: 'live', patch, relink: true });
  assert.equal(allowed.kind, 'update');
  assert.equal(allowed.reason, null);
});

test('planLink: filling blanks on the same environment needs no confirmation', () => {
  const plan = planLink({ row: { store_id: PROVO.id }, currentEnv: 'live', targetEnv: 'live', patch: { store_id: PROVO.id, balance_account_id: 'BA1' } });
  assert.equal(plan.kind, 'update');
  assert.deepEqual(plan.diff.changed, ['balance_account_id']);
});

test('planLink: a fresh test venue flips to live with no confirmation; one with test setup needs relink', () => {
  const patch = { store_id: PROVO.id };
  assert.equal(planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch }).kind, 'flip');
  const withStore = planLink({ row: { store_id: 'ST_TEST' }, currentEnv: 'test', targetEnv: 'live', patch, provisioned: ['store_id'] });
  assert.equal(withStore.kind, 'refuse');
  assert.match(withStore.reason, /payments store was set up on the test system/);
  const withReaders = planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch, readers: 2 });
  assert.equal(withReaders.kind, 'refuse');
  assert.match(withReaders.reason, /2 card readers were set up on the test system/);
  const both = planLink({ row: { store_id: 'ST_TEST' }, currentEnv: 'test', targetEnv: 'live', patch, provisioned: ['store_id'], readers: 1 });
  assert.match(both.reason, /payments store and 1 card reader were set up/);
  assert.equal(planLink({ row: { store_id: 'ST_TEST' }, currentEnv: 'test', targetEnv: 'live', patch, provisioned: ['store_id'], readers: 1, relink: true }).kind, 'flip');
  assert.match(withStore.reason, /Confirm to go ahead\./);
  assert.doesNotMatch(withStore.reason, /relink: true/);
});

test('planLink: a LIVE link onto a store that is not active is refused until relink is true', () => {
  const patch = { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, receive_payments_ok: false };
  // Provo's case: test venue, live lookup finds an inactive store: no flip
  const flip = planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch, storeStatus: 'inactive' });
  assert.equal(flip.kind, 'refuse');
  assert.match(flip.reason, new RegExp(`The store ${PROVO.id} is inactive at Adyen`));
  assert.match(flip.reason, /confirm to link it anyway/);
  assert.doesNotMatch(flip.reason, /relink: true/);
  // the store beats the setup reason: it is the thing the admin must see
  assert.match(planLink({ row: { store_id: 'ST_TEST' }, currentEnv: 'test', targetEnv: 'live', patch, provisioned: ['store_id'], readers: 2, storeStatus: 'closed' }).reason, /is closed at Adyen/);
  // no status given still refuses, in plain words
  assert.match(planLink({ row: { store_id: 'ST_X' }, currentEnv: 'live', targetEnv: 'live', patch: { store_id: PROVO.id, receive_payments_ok: false } }).reason, /is not active at Adyen/);
  // the admin's explicit yes goes ahead
  assert.equal(planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch, storeStatus: 'closed', relink: true }).kind, 'flip');
  assert.equal(planLink({ row: { store_id: 'ST_X' }, currentEnv: 'live', targetEnv: 'live', patch, relink: true }).kind, 'update');
  // on TEST an inactive store is only a note (nothing real is at stake)
  assert.equal(planLink({ row: null, currentEnv: 'test', targetEnv: 'test', patch: { store_id: 'ST_T', receive_payments_ok: false } }).kind, 'update');
  // a live noop stays a noop: nothing is written either way
  assert.equal(planLink({ row: { store_id: PROVO.id }, currentEnv: 'live', targetEnv: 'live', patch: { store_id: PROVO.id, receive_payments_ok: false } }).kind, 'noop');
  // an active store (receive ok) is not touched by the rule
  assert.equal(planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch: { store_id: PROVO.id, receive_payments_ok: true } }).kind, 'flip');
});

test('replacementClear: a relink with a partial chain clears the ids the chain did not reach', () => {
  // The new legal entity has no bank account yet, the store no split
  // configuration: transfer_instrument_id, split_profile_id and
  // business_line_id are absent from the patch and must NOT survive from
  // the old account holder on a confirmed replacement.
  const patch = { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, balance_account_id: 'BA_NEW', account_holder_id: 'AH_NEW', legal_entity_id: 'LE_NEW', receive_payments_ok: true };
  assert.deepEqual(replacementClear(patch), {
    split_profile_id: null, business_line_id: null, transfer_instrument_id: null,
    payouts_ok: false, verification_status: null, onboarding_link_url: null, onboarding_link_expires_at: null,
  });
  const row = { store_id: 'ST_OLD', balance_account_id: 'BA_OLD', account_holder_id: 'AH_OLD', legal_entity_id: 'LE_OLD', transfer_instrument_id: 'SI_OLD', payouts_ok: true, verification_status: { verificationStatus: 'valid' } };
  const plan = planLink({ row, currentEnv: 'live', targetEnv: 'live', patch, relink: true });
  assert.equal(plan.kind, 'update');
  assert.deepEqual(plan.diff.conflicts.map((c) => c.field), ['store_id', 'balance_account_id', 'account_holder_id', 'legal_entity_id']);
  const write = { ...replacementClear(patch), ...patch };
  assert.equal(write.balance_account_id, 'BA_NEW');
  assert.equal(write.transfer_instrument_id, null);     // SI_OLD belonged to LE_OLD
  assert.equal(write.payouts_ok, false);
  assert.equal(write.verification_status, null);
  assert.equal(write.receive_payments_ok, true);        // the patch's own flag wins
  // a full chain clears nothing but the old onboarding link
  const full = buildLinkPatch(LOOKUP, { merchantAccount: 'FranPOS_QSR_UK', region: 'UK', environment: 'live' });
  assert.deepEqual(replacementClear(full), { onboarding_link_url: null, onboarding_link_expires_at: null });
  // an empty patch clears every id and flag
  const empty = replacementClear(null);
  for (const k of LINK_ID_FIELDS) assert.equal(empty[k], null, k);
  assert.equal(empty.receive_payments_ok, false);
});

test('planLink: a test venue linking test ids stays an update, undefined env reads as test', () => {
  assert.equal(planLink({ row: null, currentEnv: undefined, targetEnv: 'test', patch: { store_id: 'ST_T' } }).kind, 'update');
  assert.equal(planLink({ row: { store_id: 'ST_T' }, currentEnv: 'test', targetEnv: 'test', patch: { store_id: 'ST_T' } }).kind, 'noop');
});

// ── the admin line ───────────────────────────────────────────────────────────

test('lookupSummary: found and not found, with the pieces that are missing named', () => {
  assert.equal(lookupSummary(LOOKUP), `Found SV-1007: store ${PROVO.id} (active), balance account BA3224Z223226M5KMQ5RBAL01, account holder AH32BZP22322CJ5PXF2BD5FTR, legal entity Provo Coffee Ltd.`);
  assert.equal(lookupSummary({ found: true, reference: 'SV-1007', store: { id: 'ST1' } }), 'Found SV-1007: store ST1, no balance account, no account holder, no legal entity.');
  assert.equal(lookupSummary({ found: false, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK', candidates: [{ id: 'a' }, { id: 'b' }] }), 'No store with reference SV-1007 on FranPOS_QSR_UK (2 stores listed to pick from).');
  assert.equal(lookupSummary({ found: false, candidates: [{ id: 'a' }] }), 'No store with reference no reference on the merchant account (1 store listed to pick from).');
  assert.equal(lookupSummary(null), 'No store with reference no reference on the merchant account.');
});
