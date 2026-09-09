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
  buildLinkPatch, linkDiff, planLink, replacementClear, relinkClear, conflictsMoveMoney, MONEY_CONFLICT_FIELDS, lookupSummary,
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

test('relinkClear: a store swap with the holder read refused keeps the holder, legal entity and bank account', () => {
  // 9 Sep 2026: the row names an old store AND an account holder, the store
  // at Adyen is now another one, and the Balance Platform refused the key so
  // the patch carries no holder side at all. A failed READ is not a new
  // holder: nothing is cleared.
  const patch = { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, receive_payments_ok: true };
  const row = { store_id: 'ST_OLD', merchant_account: 'FranPOS_QSR_UK', account_holder_id: 'AH_OLD', legal_entity_id: 'LE_OLD', transfer_instrument_id: 'SI_OLD', payouts_ok: true };
  const plan = planLink({ row, currentEnv: 'live', targetEnv: 'live', patch, relink: true });
  assert.equal(plan.kind, 'update');
  assert.deepEqual(plan.diff.conflicts.map((c) => c.field), ['store_id']);
  assert.deepEqual(relinkClear(plan.diff, patch), {});
  const write = { ...relinkClear(plan.diff, patch), ...patch };
  for (const k of ['account_holder_id', 'legal_entity_id', 'transfer_instrument_id', 'payouts_ok', 'verification_status', 'onboarding_link_url']) assert.equal(k in write, false, k);
  // the money side MOVING is the case the clear exists for: the old bank account never survives
  const moved = { ...patch, balance_account_id: 'BA_NEW' };
  const plan2 = planLink({ row: { ...row, balance_account_id: 'BA_OLD' }, currentEnv: 'live', targetEnv: 'live', patch: moved, relink: true });
  assert.deepEqual([...plan2.diff.conflicts.map((c) => c.field)].sort(), ['balance_account_id', 'store_id']);
  assert.deepEqual(relinkClear(plan2.diff, moved), replacementClear(moved));
  assert.equal(relinkClear(plan2.diff, moved).transfer_instrument_id, null);
  assert.equal(relinkClear(plan2.diff, moved).account_holder_id, null);
  // a new account holder alone moves it too; a merchant account swap does not
  assert.equal(conflictsMoveMoney([{ field: 'account_holder_id', current: 'AH_OLD', next: 'AH_NEW' }]), true);
  assert.equal(conflictsMoveMoney([{ field: 'merchant_account', current: 'A', next: 'B' }, { field: 'store_id', current: 'S', next: 'T' }]), false);
  assert.equal(conflictsMoveMoney(null), false);
  // blanks filled on a first link never clear, and junk never throws
  assert.deepEqual(relinkClear({ conflicts: [] }, patch), {});
  assert.deepEqual(relinkClear(null, patch), {});
  assert.deepEqual([...MONEY_CONFLICT_FIELDS], ['balance_account_id', 'account_holder_id']);
});

test('planLink: a test venue linking test ids stays an update, undefined env reads as test', () => {
  assert.equal(planLink({ row: null, currentEnv: undefined, targetEnv: 'test', patch: { store_id: 'ST_T' } }).kind, 'update');
  assert.equal(planLink({ row: { store_id: 'ST_T' }, currentEnv: 'test', targetEnv: 'test', patch: { store_id: 'ST_T' } }).kind, 'noop');
});

// ── the admin line ───────────────────────────────────────────────────────────

test('lookupSummary: found and not found, with the pieces that are missing named', () => {
  assert.equal(lookupSummary(LOOKUP), `Found SV-1007: store ${PROVO.id} (active), balance account BA3224Z223226M5KMQ5RBAL01, account holder AH32BZP22322CJ5PXF2BD5FTR (active), legal entity Provo Coffee Ltd.`);
  assert.equal(lookupSummary({ found: true, reference: 'SV-1007', store: { id: 'ST1' } }), 'Found SV-1007: store ST1, no balance account, no account holder, no legal entity.');
  assert.equal(lookupSummary({ found: false, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK', candidates: [{ id: 'a' }, { id: 'b' }] }), 'No store or account holder with reference SV-1007 on FranPOS_QSR_UK (2 stores listed to pick from).');
  assert.equal(lookupSummary({ found: false, candidates: [{ id: 'a' }] }), 'No store or account holder with reference no reference on the merchant account (1 store listed to pick from).');
  assert.equal(lookupSummary(null), 'No store or account holder with reference no reference on the merchant account.');
});

// The live shape (8 Sep 2026): the venue is an ACCOUNT HOLDER, no store.
test('lookupSummary: an account holder with no store is found, and says the store is missing', () => {
  const holderOnly = {
    found: true, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK', store: null,
    balanceAccount: balanceAccountSummary(BALANCE, 'account_holder'), accountHolder: accountHolderSummary(HOLDER), legalEntity: legalEntitySummary(LEGAL),
  };
  assert.equal(lookupSummary(holderOnly), 'Found SV-1007: NO store yet, balance account BA3224Z223226M5KMQ5RBAL01, account holder AH32BZP22322CJ5PXF2BD5FTR (active), legal entity Provo Coffee Ltd.');
});

// ── environment stash (8 Sep 2026): keep the setup a flip clears, put it back ──

import {
  STASH_ID_FIELDS, stashReaders, buildEnvStashEntry, stashHasSetup, stashSummary, stashRestorePlan,
} from './adyenLink.js';

const TEST_ROW = {
  merchant_account: 'FranPOS_ServOS_TEST', store_id: 'ST_TEST_1', split_profile_id: 'SC_TEST_1', balance_account_id: 'BA_TEST_1',
  account_holder_id: 'AH_TEST_1', legal_entity_id: 'LE_TEST_1', business_line_id: null, transfer_instrument_id: 'SI_TEST_1',
  receive_payments_ok: true, payouts_ok: false, verification_status: { source: 'adyen_link', at: '2026-09-01T10:00:00.000Z' }, region: 'UK',
};
const PD_ROWS = [
  { id: 'pd-1', label: 'Bar reader', adyen_terminal_id: 'AMS1-000168243358252', serial_number: '000168243358252' },
  { id: 'pd-2', label: 'Till 2', adyen_terminal_id: 'S1F2L-000150000000002', serial_number: '000150000000002' },
  { id: 'pd-stripe', label: 'Stripe one', adyen_terminal_id: null, serial_number: 'tmr_1' },
];
const TD_ROWS = [
  { id: 'td-1', label: 'Bar reader', adyen_terminal_id: 'AMS1-000168243358252', serial_number: '000168243358252' },
  { id: 'td-3', label: 'Handheld', adyen_terminal_id: 'S1E2L-000150000000003', serial_number: '000150000000003' },
];

test('stashReaders: platform and ops rows merge on the POIID, one side only readers are kept', () => {
  const readers = stashReaders(PD_ROWS, TD_ROWS);
  assert.deepEqual(readers, [
    { payment_device_id: 'pd-1', label: 'Bar reader', adyen_terminal_id: 'AMS1-000168243358252', terminal_device_id: 'td-1', serial_number: '000168243358252' },
    { payment_device_id: 'pd-2', label: 'Till 2', adyen_terminal_id: 'S1F2L-000150000000002', terminal_device_id: null, serial_number: '000150000000002' },
    { payment_device_id: null, label: 'Handheld', adyen_terminal_id: 'S1E2L-000150000000003', terminal_device_id: 'td-3', serial_number: '000150000000003' },
  ]);
  assert.deepEqual(stashReaders(null, undefined), []);
});

test('buildEnvStashEntry: every id (null when empty), the flags, the snapshot, the readers and a stamp', () => {
  const entry = buildEnvStashEntry(TEST_ROW, stashReaders(PD_ROWS, TD_ROWS), { at: '2026-09-08T12:00:00.000Z', region: 'UK' });
  for (const k of STASH_ID_FIELDS) assert.ok(k in entry, `${k} present`);
  assert.equal(entry.store_id, 'ST_TEST_1');
  assert.equal(entry.business_line_id, null);
  assert.equal(entry.receive_payments_ok, true);
  assert.equal(entry.payouts_ok, false);
  assert.deepEqual(entry.verification_status, TEST_ROW.verification_status);
  assert.equal(entry.merchant_account, 'FranPOS_ServOS_TEST');
  assert.equal(entry.region, 'UK');
  assert.equal(entry.readers.length, 3);
  assert.equal(entry.stashed_at, '2026-09-08T12:00:00.000Z');
  // No row at all still answers a complete, empty entry with a stamp.
  const empty = buildEnvStashEntry(null, null);
  assert.equal(empty.store_id, null);
  assert.equal(empty.receive_payments_ok, false);
  assert.deepEqual(empty.readers, []);
  assert.ok(empty.stashed_at);
});

test('stashHasSetup and stashSummary: an id or a reader counts, nothing else does', () => {
  assert.equal(stashHasSetup(null), false);
  assert.equal(stashHasSetup(buildEnvStashEntry({}, [])), false);
  assert.equal(stashHasSetup({ readers: [{ adyen_terminal_id: 'AMS1-1' }] }), true);
  assert.equal(stashHasSetup({ store_id: 'ST1' }), true);
  assert.equal(stashSummary(buildEnvStashEntry({}, [])), null);
  const s = stashSummary(buildEnvStashEntry(TEST_ROW, stashReaders(PD_ROWS, TD_ROWS), { at: '2026-09-08T12:00:00.000Z' }));
  assert.deepEqual(s, { store_id: 'ST_TEST_1', ids: 6, readers: 3, stashed_at: '2026-09-08T12:00:00.000Z', region: 'UK' });
});

test('stashRestorePlan: a plain flip back puts every kept id, flag, snapshot and reader back', () => {
  const entry = buildEnvStashEntry(TEST_ROW, stashReaders(PD_ROWS, TD_ROWS), { region: 'UK' });
  const plan = stashRestorePlan(entry, { region: 'UK' });
  assert.equal(plan.skipped, null);
  assert.equal(plan.idsSkipped, null);
  assert.deepEqual(plan.ids, {
    store_id: 'ST_TEST_1', split_profile_id: 'SC_TEST_1', legal_entity_id: 'LE_TEST_1', account_holder_id: 'AH_TEST_1',
    balance_account_id: 'BA_TEST_1', transfer_instrument_id: 'SI_TEST_1',
    receive_payments_ok: true, payouts_ok: false, verification_status: TEST_ROW.verification_status, merchant_account: 'FranPOS_ServOS_TEST',
  });
  assert.equal('business_line_id' in plan.ids, false, 'a null id is not written back');
  assert.equal(plan.readers.length, 3);
  // Nothing kept: nothing planned.
  assert.deepEqual(stashRestorePlan(null, { region: 'UK' }), { ids: {}, idsSkipped: null, readers: [], skipped: null });
});

test('stashRestorePlan: pulled ids win field by field on the same store', () => {
  const entry = buildEnvStashEntry(TEST_ROW, [], { region: 'UK' });
  const plan = stashRestorePlan(entry, { region: 'UK', pulled: { store_id: 'ST_TEST_1', balance_account_id: 'BA_NEW', receive_payments_ok: false, merchant_account: 'FranPOS_QSR_UK' } });
  assert.equal(plan.idsSkipped, null);
  assert.equal('store_id' in plan.ids, false);
  assert.equal('balance_account_id' in plan.ids, false);
  assert.equal('receive_payments_ok' in plan.ids, false);
  assert.equal('merchant_account' in plan.ids, false);
  assert.equal(plan.ids.split_profile_id, 'SC_TEST_1');
  assert.equal(plan.ids.legal_entity_id, 'LE_TEST_1');
  assert.equal(plan.ids.payouts_ok, false);
});

test('stashRestorePlan: pulled ids for a DIFFERENT store leave the kept row ids alone, readers still come back', () => {
  const entry = buildEnvStashEntry(TEST_ROW, stashReaders(PD_ROWS, TD_ROWS), { region: 'UK' });
  const plan = stashRestorePlan(entry, { region: 'UK', pulled: { store_id: 'ST_OTHER' } });
  assert.deepEqual(plan.ids, {});
  assert.match(plan.idsSkipped, /ST_OTHER/);
  assert.match(plan.idsSkipped, /ST_TEST_1/);
  assert.equal(plan.readers.length, 3);
  assert.equal(plan.skipped, null);
});

test('stashRestorePlan: a stash made on another region account is left alone entirely', () => {
  const entry = buildEnvStashEntry(TEST_ROW, stashReaders(PD_ROWS, TD_ROWS), { region: 'UK' });
  const plan = stashRestorePlan(entry, { region: 'US' });
  assert.deepEqual(plan.ids, {});
  assert.deepEqual(plan.readers, []);
  assert.match(plan.skipped, /UK account/);
  assert.match(plan.skipped, /US now/);
  // No region on either side: restored as normal (older stash entries).
  assert.equal(stashRestorePlan({ ...entry, region: null }, { region: 'US' }).skipped, null);
});

// ── find the venue however Adyen holds it (8 Sep 2026, live screens) ─────────
// SV-1007 is the ACCOUNT HOLDER reference on the live account, no store
// carries it, and the store that exists sits on FranPOS_UK while
// ADYEN_LIVE_UK_MERCHANT_ACCOUNT names FranPOS_QSR_UK.

import {
  BALANCE_PLATFORM_SECRET_SUFFIX, balancePlatformSecretName, balancePlatformSecretNames,
  merchantRows, accountHolderRows, merchantSummary, matchAccountHolderByReference,
  accountHolderCandidates, pickBusinessLine, merchantMismatch, storeStillNeeded,
} from './adyenLink.js';

const MERCHANTS = {
  data: [
    { id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK Ltd', reference: 'franpos-qsr', status: 'Active', companyId: 'CompanyAccount123', primarySettlementCurrency: 'gbp' },
    { id: 'FranPOS_UK', name: 'FranPOS UK Ltd', status: 'Active', primarySettlementCurrency: 'GBP' },
    'junk',
  ],
  itemsTotal: 2, pagesTotal: 1,
};
const HOLDERS = {
  accountHolders: [
    { id: 'AH32BZP22322CJ5PXF2BD5FTR', reference: 'SV-1007', description: 'Provo', status: 'active', legalEntityId: 'LE32BZP22322CJ5PXF2BDLEG1', balancePlatform: 'FranPOSPlatform' },
    { id: 'AH_OTHER', reference: 'SV-1008', description: 'Other venue', status: 'active', legalEntityId: 'LE_OTHER', balancePlatform: 'FranPOSPlatform' },
    { id: 'AH_MIGRATED', migratedAccountHolderCode: 'SV-2001', status: 'inactive', balancePlatform: 'FranPOSPlatform' },
    null,
  ],
  hasNext: false, hasPrevious: false,
};

test('balancePlatformSecretName(s): the name we would add, region and environment as everywhere else', () => {
  assert.equal(BALANCE_PLATFORM_SECRET_SUFFIX, 'BALANCE_PLATFORM');
  assert.equal(balancePlatformSecretName('live', 'UK'), 'ADYEN_LIVE_UK_BALANCE_PLATFORM');
  assert.equal(balancePlatformSecretName('live', 'US'), 'ADYEN_LIVE_US_BALANCE_PLATFORM');
  assert.equal(balancePlatformSecretName('live', 'EU'), 'ADYEN_LIVE_UK_BALANCE_PLATFORM');   // a legacy row reads as UK
  assert.equal(balancePlatformSecretName('test', 'US'), 'ADYEN_BALANCE_PLATFORM');
  assert.equal(balancePlatformSecretName(undefined, undefined), 'ADYEN_BALANCE_PLATFORM');
  assert.deepEqual(balancePlatformSecretNames('live', 'UK'), ['ADYEN_LIVE_UK_BALANCE_PLATFORM', 'ADYEN_LIVE_BALANCE_PLATFORM']);
  assert.deepEqual(balancePlatformSecretNames('live', 'US'), ['ADYEN_LIVE_US_BALANCE_PLATFORM']);
  assert.deepEqual(balancePlatformSecretNames('test', 'UK'), ['ADYEN_BALANCE_PLATFORM']);
  assert.deepEqual(balancePlatformSecretNames('test', 'US'), ['ADYEN_TEST_US_BALANCE_PLATFORM', 'ADYEN_BALANCE_PLATFORM']);
});

test('merchantRows and merchantSummary: the picker rows, Adyen casing kept on status', () => {
  assert.equal(merchantRows(MERCHANTS).length, 2);
  assert.equal(merchantRows([{ id: 'a' }]).length, 1);
  assert.deepEqual(merchantRows(null), []);
  assert.deepEqual(merchantSummary(MERCHANTS.data[0]), {
    id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK Ltd', reference: 'franpos-qsr', status: 'Active',
    description: null, companyId: 'CompanyAccount123', currency: 'GBP',
  });
  assert.equal(merchantSummary('nope'), null);
});

test('accountHolderRows: rows under accountHolders, a bare array, junk dropped', () => {
  assert.equal(accountHolderRows(HOLDERS).length, 3);
  assert.equal(accountHolderRows([{ id: 'AH1' }, 7]).length, 1);
  assert.deepEqual(accountHolderRows({}), []);
});

test('matchAccountHolderByReference: the venue code as the HOLDER reference, exact and case insensitive', () => {
  assert.equal(matchAccountHolderByReference(HOLDERS, 'SV-1007').holder.id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(matchAccountHolderByReference(HOLDERS, ' sv-1007 ').holder.id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(matchAccountHolderByReference(HOLDERS, 'SV-2001').holder.id, 'AH_MIGRATED');   // the classic code counts
  assert.equal(matchAccountHolderByReference(HOLDERS, 'SV-100').holder, null);                // never partial
  assert.equal(matchAccountHolderByReference(HOLDERS, '').holder, null);
  // a repeated page collapses by id; two distinct holders are ambiguous
  const twice = { accountHolders: [HOLDERS.accountHolders[0], HOLDERS.accountHolders[0]] };
  assert.equal(matchAccountHolderByReference(twice, 'SV-1007').matches.length, 1);
  const two = { accountHolders: [HOLDERS.accountHolders[0], { id: 'AH_DUP', reference: 'SV-1007' }] };
  const amb = matchAccountHolderByReference(two, 'SV-1007');
  assert.equal(amb.holder, null);
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.matches.length, 2);
});

test('accountHolderCandidates: exact first, then mentions, deduped and capped', () => {
  const list = accountHolderCandidates(HOLDERS, 'SV-1007');
  assert.deepEqual(list.map((c) => c.id), ['AH32BZP22322CJ5PXF2BD5FTR', 'AH_OTHER', 'AH_MIGRATED']);
  assert.deepEqual(list[0], {
    id: 'AH32BZP22322CJ5PXF2BD5FTR', reference: 'SV-1007', description: 'Provo', status: 'active',
    legalEntityId: 'LE32BZP22322CJ5PXF2BDLEG1', balancePlatform: 'FranPOSPlatform',
  });
  assert.equal(list[2].reference, 'SV-2001');            // the classic code stands in for a missing reference
  assert.equal(accountHolderCandidates(HOLDERS, 'SV-1007', 1).length, 1);
  assert.deepEqual(accountHolderCandidates(null, 'SV-1007'), []);
});

test('pickBusinessLine: the paymentProcessing line, else the only one', () => {
  const pay = { id: 'SBL_PAY', service: 'paymentProcessing', legalEntityId: 'LE1' };
  const issuing = { id: 'SBL_CARD', service: 'issuing', legalEntityId: 'LE1' };
  assert.equal(pickBusinessLine({ businessLines: [issuing, pay] }), pay);
  assert.equal(pickBusinessLine([issuing]), issuing);                      // the only line there is
  assert.equal(pickBusinessLine([pay, { ...pay, id: 'SBL_PAY2' }]), null);  // two of the same service: the admin picks
  assert.equal(pickBusinessLine({ businessLines: [] }), null);
  assert.equal(pickBusinessLine(null), null);
});

test('merchantMismatch: a store on another merchant is named, never used silently', () => {
  const m = merchantMismatch({ configured: 'FranPOS_QSR_UK', found: 'FranPOS_UK', secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', storeId: 'ST_ELSEWHERE', reference: 'SV-1007' });
  assert.equal(m.configured, 'FranPOS_QSR_UK');
  assert.equal(m.found, 'FranPOS_UK');
  assert.equal(m.secret, 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT');
  assert.match(m.message, /ST_ELSEWHERE/);
  assert.match(m.message, /ADYEN_LIVE_UK_MERCHANT_ACCOUNT names FranPOS_QSR_UK/);
  assert.match(m.message, /choose FranPOS_UK/);
  // the same account (any casing), or an unknown one: no warning
  assert.equal(merchantMismatch({ configured: 'FranPOS_UK', found: 'franpos_uk' }), null);
  assert.equal(merchantMismatch({ configured: 'FranPOS_QSR_UK', found: '' }), null);
  assert.equal(merchantMismatch(), null);
});

test('storeStillNeeded: an account holder with no store says so; a store says nothing', () => {
  const holderOnly = { reference: 'SV-1007', store: null, accountHolder: accountHolderSummary(HOLDER) };
  assert.match(storeStillNeeded(holderOnly), /A STORE IS STILL NEEDED/);
  assert.match(storeStillNeeded(holderOnly), /SV-1007/);
  assert.equal(storeStillNeeded({ ...holderOnly, store: { id: 'ST1' } }), null);
  assert.equal(storeStillNeeded({ reference: 'SV-1007', store: null, accountHolder: null }), null);
  assert.equal(storeStillNeeded(null), null);
});

// ── one answer for the wizard (8 Sep 2026, OWNER FEEDBACK) ───────────────────
// "too many words and too small ... a flow that supports someone doing this":
// the steps are computed HERE, on the server side of the wire, so the screen
// renders five rows and decides nothing.

import { capabilityList, blockedCapabilityNames, buildGoliveSteps } from './adyenLink.js';

// The live shape, 8 Sep 2026: Active account holder, ONE capability blocked.
const LIVE_CAPS = {
  receivePayments: { enabled: true, allowed: true, requested: true, verificationStatus: 'valid' },
  sendToTransferInstrument: { enabled: false, allowed: false, requested: true, verificationStatus: 'invalid', problems: [{ verificationErrors: [{ message: 'Bank account not verified' }] }] },
  receiveFromPlatformPayments: { enabled: false, allowed: false, requested: true, verificationStatus: 'pending' },
  issueCard: { enabled: false, allowed: false, requested: false, verificationStatus: null },
};

const READY = {
  venue: { name: 'Provo', code: 'SV-1007', region: 'UK', environment: 'live' },
  keys: { configured: true, missing: [] },
  holder: accountHolderSummary(HOLDER),
  balanceAccount: balanceAccountSummary(BALANCE),
  legalEntity: legalEntitySummary(LEGAL),
  capabilities: capabilityList(summariseCapabilities({ receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' } })),
  store: storeSummary(PROVO),
  merchantConfigured: 'FranPOS_QSR_UK',
  merchantMismatch: null,
  readers: [{ label: 'Front till', serial: 'S1', poiid: 'AMS1-1', bound: true }],
  origins: { registered: true },
  applePay: { domains: ['provo.serv-os.app'], verification: 'valid' },
};

const ids = (steps) => steps.map((s) => s.id);
const byId = (steps, id) => steps.find((s) => s.id === id);

test('capabilityList: every capability by name, the blocked one first', () => {
  const list = capabilityList(summariseCapabilities(LIVE_CAPS));
  assert.deepEqual(list.map((c) => c.name), ['sendToTransferInstrument', 'receiveFromPlatformPayments', 'receivePayments', 'issueCard']);
  assert.deepEqual(list[0], {
    name: 'sendToTransferInstrument', allowed: false, requested: true, enabled: false,
    verification: 'invalid', blocked: true, problems: 1,
  });
  assert.equal(list[1].blocked, true);          // requested, not allowed, still being checked
  assert.equal(list[1].verification, 'pending');
  assert.equal(list[2].allowed, true);
  assert.equal(list[2].blocked, false);
  assert.equal(list[3].blocked, false);         // never asked for is not blocked
  // a bare { name: entry } map works too, and junk is dropped
  assert.equal(capabilityList({ receivePayments: { allowed: true }, junk: 7 }).length, 1);
  assert.deepEqual(capabilityList(null), []);
});

test('blockedCapabilityNames: only the settled refusals, so a pending one is not shouted about', () => {
  assert.deepEqual(blockedCapabilityNames(capabilityList(summariseCapabilities(LIVE_CAPS))), ['sendToTransferInstrument']);
  assert.deepEqual(blockedCapabilityNames([]), []);
  assert.deepEqual(blockedCapabilityNames(null), []);
});

test('buildGoliveSteps: always the same five steps in the same order', () => {
  assert.deepEqual(ids(buildGoliveSteps(READY)), ['find_venue', 'business_account', 'payments_location', 'go_live', 'readers']);
  assert.deepEqual(ids(buildGoliveSteps({})), ['find_venue', 'business_account', 'payments_location', 'go_live', 'readers']);
  assert.deepEqual(ids(buildGoliveSteps()), ['find_venue', 'business_account', 'payments_location', 'go_live', 'readers']);
  for (const s of buildGoliveSteps(READY)) {
    // The titles live in ONE place, GOLIVE_STEP_TITLES on the screen's side,
    // so the fn answers none and the two can never drift.
    assert.equal('title' in s, false, `${s.id} carries no title`);
    assert.ok(['done', 'todo', 'attention', 'blocked'].includes(s.state));
    assert.equal(typeof s.detail, 'string');
    assert.ok(!/[—–]/.test(`${s.detail} ${s.hint ?? ''}`), 'no dashes as punctuation');
  }
});

test('buildGoliveSteps: no step detail ever carries an Adyen id', () => {
  const every = [
    ...buildGoliveSteps(READY),
    ...buildGoliveSteps({ ...READY, legalEntity: null }),
    ...buildGoliveSteps({ ...READY, legalEntity: legalEntitySummary({ ...LEGAL, name: '', transferInstruments: [] }) }),
    ...buildGoliveSteps({ ...READY, store: null }),
    ...buildGoliveSteps({ ...READY, capabilities: capabilityList(summariseCapabilities(LIVE_CAPS)) }),
  ];
  for (const s of every) assert.doesNotMatch(s.detail, /\b(AH|ST|BA|LE)[0-9A-Z]{10,}\b/, `id in a sentence: ${s.detail}`);
});

test('buildGoliveSteps: a venue that is fully live reads done all the way down', () => {
  const steps = buildGoliveSteps(READY);
  assert.deepEqual(steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  assert.match(byId(steps, 'find_venue').detail, /business account and a store/);
  assert.match(byId(steps, 'payments_location').detail, /SV-1007/);
  assert.match(byId(steps, 'go_live').detail, /Provo takes real cards/);
  assert.equal(byId(steps, 'readers').detail, '1 reader ready.');
  assert.equal(byId(steps, 'go_live').action, null);
});

test('buildGoliveSteps: no keys blocks every step and names the secrets', () => {
  const steps = buildGoliveSteps({ ...READY, keys: { configured: false, missing: ['ADYEN_LIVE_UK_API_KEY', 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT'] } });
  assert.deepEqual(steps.slice(0, 4).map((s) => s.state), ['blocked', 'blocked', 'blocked', 'blocked']);
  assert.match(byId(steps, 'find_venue').hint, /ADYEN_LIVE_UK_MERCHANT_ACCOUNT/);
  assert.match(byId(steps, 'go_live').detail, /live Adyen keys/);
  // the readers step is ours, not Adyen's, so it still reads
  assert.equal(byId(steps, 'readers').state, 'done');
});

test('buildGoliveSteps: the LIVE case, an account holder with NO store', () => {
  const steps = buildGoliveSteps({
    ...READY,
    venue: { ...READY.venue, environment: 'test' },
    store: null,
    capabilities: capabilityList(summariseCapabilities(LIVE_CAPS)),
    readers: [],
    origins: { registered: false },
  });
  assert.equal(byId(steps, 'find_venue').state, 'done');
  assert.match(byId(steps, 'find_venue').detail, /holds SV-1007 as a business account/);
  assert.match(byId(steps, 'find_venue').hint, /no store yet/);
  // The ONE refusal on the live account is sendToTransferInstrument, a PAY
  // OUT. It holds the settlement to the venue's bank, not a card payment, so
  // it must never stop the flow (8 Sep 2026: it parked the owner on step 2).
  assert.equal(byId(steps, 'business_account').state, 'attention');
  assert.equal(byId(steps, 'business_account').detail, 'Cards work. Payouts wait for Adyen.');
  assert.equal(byId(steps, 'business_account').action, null);
  // the store is the next thing someone does
  assert.equal(byId(steps, 'payments_location').state, 'todo');
  assert.equal(byId(steps, 'payments_location').action, 'create_store');
  assert.match(byId(steps, 'payments_location').hint, /SV-1007/);
  assert.equal(byId(steps, 'go_live').state, 'todo');
  assert.equal(byId(steps, 'readers').state, 'todo');
});

test('buildGoliveSteps: a blocked PAY IN stops the flow, a blocked PAY OUT does not', () => {
  const payout = buildGoliveSteps({ ...READY, capabilities: capabilityList(summariseCapabilities(LIVE_CAPS)) });
  assert.equal(byId(payout, 'business_account').state, 'attention');
  assert.equal(byId(payout, 'payments_location').state, 'done');
  assert.equal(byId(payout, 'go_live').state, 'done');

  const payin = buildGoliveSteps({
    ...READY,
    capabilities: capabilityList(summariseCapabilities({
      receivePayments: { allowed: false, requested: true, verificationStatus: 'rejected' },
      sendToTransferInstrument: { allowed: true, requested: true, verificationStatus: 'valid' },
    })),
  });
  assert.equal(byId(payin, 'business_account').state, 'blocked');
  assert.match(byId(payin, 'business_account').detail, /Adyen blocks receivePayments/);
  assert.equal(byId(payin, 'business_account').action, 'open_adyen');
});

test('buildGoliveSteps: readers on the environment the venue is LEAVING are never done', () => {
  const onTest = { ...READY, venue: { ...READY.venue, environment: 'test' } };
  // looking at live while the venue is on test: going live retires them all
  const looking = buildGoliveSteps(onTest, { target: 'live' });
  assert.equal(byId(looking, 'readers').state, 'todo');
  assert.match(byId(looking, 'readers').detail, /on the test account/);
  assert.match(byId(looking, 'readers').hint, /added again after/);
  // the venue's own environment reads as before
  assert.equal(byId(buildGoliveSteps(onTest, { target: 'test' }), 'readers').state, 'done');
  assert.equal(byId(buildGoliveSteps(READY, { target: 'live' }), 'readers').state, 'done');
  // no readers at all still asks for one, whatever the target
  assert.equal(byId(buildGoliveSteps({ ...onTest, readers: [] }, { target: 'live' }), 'readers').detail, 'No card readers on this venue yet.');
});

test('buildGoliveSteps: nothing found at all asks for the id, no code asks for the code', () => {
  const empty = buildGoliveSteps({ venue: { code: 'SV-1007', environment: 'test' }, keys: { configured: true, missing: [] } });
  assert.equal(byId(empty, 'find_venue').state, 'todo');
  assert.equal(byId(empty, 'find_venue').action, 'find_venue');
  assert.match(byId(empty, 'find_venue').hint, /starts with AH/);
  assert.equal(byId(empty, 'business_account').state, 'todo');
  assert.equal(byId(empty, 'payments_location').detail, 'Find the venue first.');
  const noCode = buildGoliveSteps({ venue: { environment: 'test' }, keys: { configured: true, missing: [] } });
  assert.equal(byId(noCode, 'find_venue').action, 'set_venue_code');
});

test('buildGoliveSteps: a store on another merchant account is the loud step', () => {
  const steps = buildGoliveSteps({
    ...READY,
    venue: { ...READY.venue, environment: 'test' },
    store: null,
    merchantMismatch: merchantMismatch({ configured: 'FranPOS_QSR_UK', found: 'FranPOS_UK', secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', storeId: 'ST_ELSEWHERE', reference: 'SV-1007' }),
  });
  const step = byId(steps, 'payments_location');
  assert.equal(step.state, 'attention');
  assert.equal(step.action, 'choose_merchant');
  assert.match(step.detail, /sits on FranPOS_UK, not on FranPOS_QSR_UK/);
  assert.match(step.hint, /ADYEN_LIVE_UK_MERCHANT_ACCOUNT/);
  // a mismatch is never "ready to go live"
  assert.equal(byId(steps, 'go_live').state, 'todo');
});

test('buildGoliveSteps: an inactive store, a pending check and a missing bank account each read differently', () => {
  const inactive = buildGoliveSteps({ ...READY, store: storeSummary({ ...PROVO, status: 'inactive' }) });
  assert.equal(byId(inactive, 'payments_location').state, 'attention');
  assert.match(byId(inactive, 'payments_location').detail, /is inactive at Adyen/);
  assert.equal(byId(inactive, 'go_live').state, 'attention');

  const pending = buildGoliveSteps({ ...READY, capabilities: capabilityList(summariseCapabilities({ receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' }, sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'pending' } })) });
  assert.equal(byId(pending, 'business_account').state, 'attention');
  assert.match(byId(pending, 'business_account').detail, /still checking sendToTransferInstrument/);

  const noBank = buildGoliveSteps({ ...READY, legalEntity: legalEntitySummary({ ...LEGAL, transferInstruments: [] }) });
  assert.equal(byId(noBank, 'business_account').state, 'attention');
  assert.match(byId(noBank, 'business_account').detail, /no bank account yet/);

  const noBalance = buildGoliveSteps({ ...READY, balanceAccount: null });
  assert.equal(byId(noBalance, 'business_account').state, 'attention');
  assert.match(byId(noBalance, 'business_account').detail, /nowhere to land/);

  const inactiveHolder = buildGoliveSteps({ ...READY, holder: accountHolderSummary({ ...HOLDER, status: 'suspended', capabilities: {} }), capabilities: [] });
  assert.equal(byId(inactiveHolder, 'business_account').state, 'attention');
  assert.match(byId(inactiveHolder, 'business_account').detail, /is suspended at Adyen/);
});

test('buildGoliveSteps: live with unregistered web origins is attention, not done', () => {
  const steps = buildGoliveSteps({ ...READY, origins: { registered: false } });
  assert.equal(byId(steps, 'go_live').state, 'attention');
  assert.equal(byId(steps, 'go_live').action, 'register_origins');
  // Apple Pay still being verified is a hint on a done step, never a block
  const pending = buildGoliveSteps({ ...READY, applePay: { domains: [], verification: 'pending' } });
  assert.equal(byId(pending, 'go_live').state, 'done');
  assert.match(byId(pending, 'go_live').hint, /Apple Pay is pending/);
});

test('buildGoliveSteps: readers count what is bound to a till', () => {
  const half = buildGoliveSteps({ ...READY, readers: [{ poiid: 'A', bound: true }, { poiid: 'B', bound: false }] });
  assert.equal(byId(half, 'readers').state, 'attention');
  assert.equal(byId(half, 'readers').detail, '1 of 2 readers are on a till.');
  const none = buildGoliveSteps({ ...READY, readers: [{ poiid: 'A', bound: false }, { poiid: 'B', bound: false }] });
  assert.equal(byId(none, 'readers').state, 'attention');
  assert.match(byId(none, 'readers').detail, /2 readers boarded, none on a till/);
  assert.equal(byId(none, 'readers').action, 'bind_reader');
});

test('buildLinkPatch: a business account with no store is NOT receive ok, and store_id stays out', () => {
  const p = buildLinkPatch(
    { found: true, reference: 'SV-1007', store: null, balanceAccount: balanceAccountSummary(BALANCE, 'account_holder'), accountHolder: accountHolderSummary(HOLDER), legalEntity: legalEntitySummary(LEGAL), businessLineIds: ['SBL_PAY'] },
    { merchantAccount: 'FranPOS_UK', region: 'UK', environment: 'live' },
  );
  assert.equal('store_id' in p, false);
  assert.equal(p.receive_payments_ok, false);
  assert.equal(p.merchant_account, 'FranPOS_UK');
  assert.equal(p.account_holder_id, 'AH32BZP22322CJ5PXF2BD5FTR');
  assert.equal(p.balance_account_id, 'BA3224Z223226M5KMQ5RBAL01');
  assert.equal(p.legal_entity_id, 'LE32BZP22322CJ5PXF2BDLEG1');
  assert.equal(p.business_line_id, 'SBL_PAY');
  // and it LINKS: no store id means no inactive store refusal
  const plan = planLink({ row: null, currentEnv: 'test', targetEnv: 'live', patch: p });
  assert.equal(plan.kind, 'flip');
  assert.equal(plan.reason, null);
  const same = planLink({ row: null, currentEnv: 'live', targetEnv: 'live', patch: p });
  assert.equal(same.kind, 'update');
});

test('buildGoliveSteps: the go live step reads the LIVE keys, not the ones the read used', () => {
  // A venue read on TEST with test keys: the first three steps are fine, but
  // "ready to go live" must not be said on the back of test keys.
  const onTest = {
    ...READY,
    venue: { ...READY.venue, environment: 'test' },
    keys: { configured: true, missing: [] },
    liveKeys: { configured: false, missing: ['ADYEN_LIVE_UK_CLIENT_KEY'] },
  };
  const steps = buildGoliveSteps(onTest);
  assert.equal(byId(steps, 'find_venue').state, 'done');
  assert.equal(byId(steps, 'payments_location').state, 'done');
  assert.equal(byId(steps, 'go_live').state, 'blocked');
  assert.match(byId(steps, 'go_live').hint, /ADYEN_LIVE_UK_CLIENT_KEY/);
  // with the live keys in place the same venue is ready
  const ready = buildGoliveSteps({ ...onTest, liveKeys: { configured: true, missing: [] } });
  assert.equal(byId(ready, 'go_live').state, 'todo');
  assert.equal(byId(ready, 'go_live').action, 'go_live');
  // no liveKeys given at all falls back to keys, as before
  assert.equal(byId(buildGoliveSteps({ ...READY }), 'go_live').state, 'done');
});

// ── OUR OWN ADYEN IDS, KEPT PER ENVIRONMENT AND REGION (8 Sep 2026) ─────────
// The Balance Platform Configuration API has NO filter by reference, so the
// FIRST venue on an Adyen account is linked by pasting its account holder id
// once; the balancePlatform that read answers is kept, and every venue after
// it is found by its reference on its own. These are the pure pieces of that.
import {
  ADYEN_PLATFORM_SETTINGS_TABLE, MERCHANT_ACCOUNTS_KEPT,
  platformSettingsKey, merchantAccountsSeen, mergeMerchantAccounts,
  platformSettingsPatch, learnedBalancePlatform, isUnknownRelationError,
  platformSettingsMissingMessage,
} from './adyenLink.js';

const BP = 'BP32BZP22322CJ5PXF2BDPLAT';

test('platformSettingsKey: the two words the database holds, legacy EU reads as UK', () => {
  assert.deepEqual(platformSettingsKey('live', 'UK'), { environment: 'live', region: 'UK' });
  assert.deepEqual(platformSettingsKey('LIVE', 'us'), { environment: 'live', region: 'US' });
  assert.deepEqual(platformSettingsKey('test', 'EU'), { environment: 'test', region: 'UK' });
  // anything unknown is test and UK, the safe pair
  assert.deepEqual(platformSettingsKey(null, null), { environment: 'test', region: 'UK' });
  assert.deepEqual(platformSettingsKey('sandbox', 'FR'), { environment: 'test', region: 'UK' });
});

test('merchantAccountsSeen: { id, name, status }, deduped the way Adyen compares codes', () => {
  const rows = merchantAccountsSeen([
    { id: 'FranPOS_UK', name: 'FranPOS UK', status: 'Active', storeCount: 12 },
    { id: 'franpos_uk', name: 'a second answer for the same account' },
    { id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK', status: 'Active' },
    { id: '   ' },
    'PlainCode',
    null,
  ]);
  assert.deepEqual(rows, [
    { id: 'FranPOS_UK', name: 'FranPOS UK', status: 'Active' },
    { id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK', status: 'Active' },
    { id: 'PlainCode', name: null, status: null },
  ]);
  assert.deepEqual(merchantAccountsSeen(null), []);
  // the count is decoration on the answer, never kept
  assert.equal('storeCount' in rows[0], false);
});

test('mergeMerchantAccounts: kept ones stay, seen ones refresh, new ones follow', () => {
  const kept = [{ id: 'FranPOS_UK', name: 'old name', status: 'Active' }, { id: 'Gone_UK', name: 'not visible today', status: 'Active' }];
  const merged = mergeMerchantAccounts(kept, [
    { id: 'franpos_uk', name: 'FranPOS UK', status: 'Active' },
    { id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK', status: 'Active' },
  ]);
  // a credential scoped down between reads must NOT lose the account a venue
  // is already charging on, so Gone_UK survives
  assert.deepEqual(merged.map((m) => m.id), ['FranPOS_UK', 'Gone_UK', 'FranPOS_QSR_UK']);
  assert.equal(merged[0].name, 'FranPOS UK');
  const capped = mergeMerchantAccounts([], Array.from({ length: MERCHANT_ACCOUNTS_KEPT + 5 }, (_, i) => ({ id: `M${i}` })));
  assert.equal(capped.length, MERCHANT_ACCOUNTS_KEPT);
});

test('platformSettingsPatch: nothing new writes nothing', () => {
  assert.equal(platformSettingsPatch(null, {}), null);
  assert.equal(platformSettingsPatch(null, { balancePlatformId: '' }), null);
  assert.equal(platformSettingsPatch({ balance_platform_id: BP }, { balancePlatformId: BP }), null);
  const same = { balance_platform_id: BP, merchant_accounts: [{ id: 'FranPOS_UK', name: null, status: null }] };
  assert.equal(platformSettingsPatch(same, { balancePlatformId: BP, merchantAccounts: ['FranPOS_UK'] }), null);
});

test('platformSettingsPatch: the first venue teaches us the balance platform', () => {
  assert.deepEqual(platformSettingsPatch(null, { balancePlatformId: BP }), { balance_platform_id: BP });
  // A DIFFERENT id is a CLASH, never an update: the row is keyed by
  // (environment, region) alone and the reseller model puts more than one
  // Adyen account on one region, so a venue on a second balance platform must
  // NOT re-point the search for every other venue. The kept id survives and
  // savePlatformSettings (the edge function) reports the clash as a warning.
  // The merchant list still merges.
  const p = platformSettingsPatch(
    { balance_platform_id: 'BPOLD', merchant_accounts: [{ id: 'FranPOS_UK' }] },
    { balancePlatformId: BP, merchantAccounts: [{ id: 'FranPOS_QSR_UK', name: 'QSR' }] },
  );
  assert.equal('balance_platform_id' in p, false);
  assert.deepEqual(p.merchant_accounts.map((m) => m.id), ['FranPOS_UK', 'FranPOS_QSR_UK']);
  // nothing else new alongside the clash writes nothing at all
  assert.equal(platformSettingsPatch({ balance_platform_id: 'BPOLD' }, { balancePlatformId: BP }), null);
  // and it never clears: a read that learned nothing leaves the kept id alone
  assert.equal(platformSettingsPatch({ balance_platform_id: BP }, { balancePlatformId: null }), null);
});

test('learnedBalancePlatform: only an account holder Adyen answered with teaches the id', () => {
  // lookup.balancePlatform is the id the listing SEARCHED with. It is set
  // before the listing runs, so it is there whether or not a holder was found,
  // and learning it would write an unverified id (a stale secret, a typed BP)
  // onto the shared row no screen can read back.
  assert.equal(learnedBalancePlatform({ balancePlatform: BP }), null);
  assert.equal(learnedBalancePlatform({ balancePlatform: 'BP_WRONG', accountHolder: null, found: false }), null);
  // a pasted holder, a holder matched by reference and the holder the store's
  // balance account named all arrive as the same summary, which carries the id
  assert.equal(learnedBalancePlatform({ accountHolder: accountHolderSummary({ ...HOLDER, balancePlatform: BP }) }), BP);
  // the searched id never wins over the one the holder confirmed
  assert.equal(learnedBalancePlatform({ balancePlatform: 'BP_WRONG', accountHolder: accountHolderSummary({ ...HOLDER, balancePlatform: BP }) }), BP);
  assert.equal(learnedBalancePlatform({ balancePlatform: null, accountHolder: null }), null);
  assert.equal(learnedBalancePlatform(null), null);
});

test('isUnknownRelationError: the table is not there yet, and nothing else', () => {
  assert.equal(isUnknownRelationError({ code: '42P01', message: 'relation "public.adyen_platform_settings" does not exist' }, ADYEN_PLATFORM_SETTINGS_TABLE), true);
  assert.equal(isUnknownRelationError({ code: 'PGRST205', message: "Could not find the table 'public.adyen_platform_settings' in the schema cache" }, ADYEN_PLATFORM_SETTINGS_TABLE), true);
  // a DIFFERENT missing table must not read as ours
  assert.equal(isUnknownRelationError({ code: '42P01', message: 'relation "public.something_else" does not exist' }, ADYEN_PLATFORM_SETTINGS_TABLE), false);
  // a refusal is not an absence: RLS, a timeout and a plain 500 all keep going
  assert.equal(isUnknownRelationError({ code: '42501', message: 'permission denied for table adyen_platform_settings' }, ADYEN_PLATFORM_SETTINGS_TABLE), false);
  assert.equal(isUnknownRelationError({ message: 'fetch failed' }, ADYEN_PLATFORM_SETTINGS_TABLE), false);
  assert.equal(isUnknownRelationError(null, ADYEN_PLATFORM_SETTINGS_TABLE), false);
});

test('platformSettingsMissingMessage: names the file, and never a dash', () => {
  const m = platformSettingsMissingMessage();
  assert.match(m, /20260908c_PLATFORM_adyen_platform_settings\.sql/);
  assert.match(m, /pasted/);
  assert.doesNotMatch(m, /[–—]/);
});

// ── A FOUND STORE IS NOT A LINKED STORE, and THE ONE PLAIN REASON (9 Sep 2026) ─
// Live screen, venue Provo (SV-1007): golive_state found the store on
// FranPOS_QSR_UK and said step 3 was done, while the venue row still held
// store_id NULL and the list chip read NOT LINKED. The pasted account holder
// was refused (401) by the Balance Platform, twice word for word, and the
// owner saw "a box of four long code lines". These are the contracts for both
// copies (adyenLink.js here, _shared/adyenLink.ts on the function).
import {
  STORE_NOT_SAVED_DETAIL, BP_KEY_BLOCKED_DETAIL, bpKeyBlockedHint, PROBLEM_TEXT_MAX,
  plainAdyenProblem, goliveProblems, isPlatformSettingsMissingWarning,
} from './adyenLink.js';

const BP_REFUSED = (what) => `${what}: refused (401): the credential behind ADYEN_LIVE_UK_BP_KEY (the set's API key when that is unset) needs the Balance Platform BCL role`;

test('buildGoliveSteps: a store Adyen holds that the venue row does not name is attention with link_store', () => {
  // the live shape: found at Adyen, store_id NULL on the row
  const empty = buildGoliveSteps({ ...READY, row: { store_id: null } }, { target: 'live' });
  assert.equal(byId(empty, 'find_venue').state, 'done');
  assert.equal(byId(empty, 'payments_location').state, 'attention');
  assert.equal(byId(empty, 'payments_location').detail, STORE_NOT_SAVED_DETAIL);
  assert.equal(byId(empty, 'payments_location').detail, 'Adyen holds the payments location, it is not saved on the venue yet.');
  assert.equal(byId(empty, 'payments_location').action, 'link_store');
  // live, so real cards are on, but the row does not name the store: never "takes real cards"
  assert.equal(byId(empty, 'go_live').state, 'attention');
  assert.match(byId(empty, 'go_live').detail, /not saved on the venue/);
  assert.equal(byId(empty, 'go_live').action, null);
  // another store on the row is the same thing to the owner: save the one Adyen holds
  const other = buildGoliveSteps({ ...READY, row: { store_id: 'ST_SOMETHING_ELSE' } }, { target: 'live' });
  assert.equal(byId(other, 'payments_location').action, 'link_store');
  // the row names it: done, as before
  const saved = buildGoliveSteps({ ...READY, row: { store_id: PROVO.id } }, { target: 'live' });
  assert.equal(byId(saved, 'payments_location').state, 'done');
  assert.equal(byId(saved, 'go_live').state, 'done');
  // no row in hand (an old caller, or the flow looking at the OTHER environment,
  // where the go live flip writes the ids): the old reading stands
  assert.equal(byId(buildGoliveSteps(READY), 'payments_location').state, 'done');
  assert.equal(byId(buildGoliveSteps({ ...READY, row: null }), 'payments_location').state, 'done');
  const flipping = buildGoliveSteps({ ...READY, venue: { ...READY.venue, environment: 'test' }, row: null }, { target: 'live' });
  assert.equal(byId(flipping, 'payments_location').state, 'done');
  assert.equal(byId(flipping, 'go_live').action, 'go_live');
  // on test, looking at test, with no row at all: the same offer, and go live waits
  const onTest = buildGoliveSteps({ ...READY, venue: { ...READY.venue, environment: 'test' }, row: {} }, { target: 'test' });
  assert.equal(byId(onTest, 'payments_location').action, 'link_store');
  assert.equal(byId(onTest, 'go_live').detail, 'Finish the steps above first.');
  // an inactive store is still the inactive store line: cards are refused either way
  const inactive = buildGoliveSteps({ ...READY, store: storeSummary({ ...PROVO, status: 'inactive' }), row: { store_id: null } }, { target: 'live' });
  assert.equal(byId(inactive, 'payments_location').action, 'open_adyen');
  // a mismatch still wins: the store is on another account, nothing to save
  const mismatched = buildGoliveSteps({
    ...READY, row: { store_id: null },
    merchantMismatch: merchantMismatch({ configured: 'FranPOS_QSR_UK', found: 'FranPOS_UK', secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', storeId: 'ST_ELSEWHERE', reference: 'SV-1007' }),
  }, { target: 'live' });
  assert.equal(byId(mismatched, 'payments_location').action, 'choose_merchant');
});

test('buildGoliveSteps: the Balance Platform refusing our key is ONE blocked step naming the secret', () => {
  const refused = {
    ...READY,
    holder: null, balanceAccount: null, legalEntity: null, capabilities: [],
    row: { store_id: null },
    balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' },
  };
  const steps = buildGoliveSteps(refused, { target: 'live' });
  // the store side still reads: found, and offered for saving
  assert.equal(byId(steps, 'find_venue').state, 'done');
  assert.equal(byId(steps, 'find_venue').detail, 'Adyen holds SV-1007 as a store.');
  assert.equal(byId(steps, 'payments_location').action, 'link_store');
  // the ONE plain reason, at the business account step
  const ba = byId(steps, 'business_account');
  assert.equal(ba.state, 'blocked');
  assert.equal(ba.detail, BP_KEY_BLOCKED_DETAIL);
  assert.equal(ba.detail, 'Our payments key cannot see the business account side.');
  assert.equal(ba.action, 'add_bp_key');
  assert.equal(ba.hint, 'A second key is made in the live Customer Area: Developers, API credentials, Platforms. It goes in the setting below.');
  // no id inside the sentence (rule 5): the secret is its own grey row on the
  // screen, and the hint keeps the 120 character rule of every plain line
  assert.doesNotMatch(ba.hint, /BP_KEY/);
  assert.ok(ba.hint.length < PROBLEM_TEXT_MAX, `${ba.hint.length} chars`);
  // ...and NOWHERE else: no other step names the secret or repeats the reason
  const others = steps.filter((s) => s.id !== 'business_account').map((s) => `${s.detail} ${s.hint ?? ''}`).join('\n');
  assert.doesNotMatch(others, /BP_KEY|business account side|Platforms tab/);
  // the test set names the test Customer Area and the unprefixed secret
  const onTest = buildGoliveSteps({ ...refused, venue: { ...READY.venue, environment: 'test' }, balancePlatformKey: { refused: true, secret: 'ADYEN_BP_KEY' } }, { target: 'test' });
  assert.match(byId(onTest, 'business_account').hint, /test Customer Area/);
  assert.doesNotMatch(byId(onTest, 'business_account').hint, /ADYEN_BP_KEY/);
  assert.equal(bpKeyBlockedHint('ADYEN_LIVE_US_BP_KEY', 'live').includes('ADYEN_LIVE_US_BP_KEY'), false);
  assert.ok(bpKeyBlockedHint('ADYEN_LIVE_US_BP_KEY', 'live').length < PROBLEM_TEXT_MAX);
  assert.ok(bpKeyBlockedHint(null, 'test').length < PROBLEM_TEXT_MAX);
  // no store either: step 1 does not guess "nothing carries the code", it points at step 2
  const nothing = buildGoliveSteps({ ...refused, store: null }, { target: 'live' });
  assert.equal(byId(nothing, 'find_venue').state, 'todo');
  assert.equal(byId(nothing, 'find_venue').detail, 'No payments location carries the code SV-1007 yet.');
  assert.match(byId(nothing, 'find_venue').hint, /See step 2/);
  assert.equal(byId(nothing, 'business_account').state, 'blocked');
  // the refusal beats every other reading of the business account, holder or not
  assert.equal(byId(buildGoliveSteps({ ...READY, balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' } }), 'business_account').state, 'blocked');
  // not refused, nothing known: the old todo
  assert.equal(byId(buildGoliveSteps({ ...refused, balancePlatformKey: { refused: false, secret: 'ADYEN_LIVE_UK_BP_KEY' } }), 'business_account').state, 'todo');
  // missing keys still come first
  assert.equal(byId(buildGoliveSteps({ ...refused, keys: { configured: false, missing: ['ADYEN_LIVE_UK_API_KEY'] } }), 'business_account').detail, 'The Adyen keys are not on the server, so nothing can be read.');
});

test('buildGoliveSteps: a refused or ambiguous store search never reads as "nothing carries the code"', () => {
  // rule 6: a refusal Adyen gave us must never look like nothing found, and
  // step 1 must not contradict the box under the steps.
  const base = { ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {} };
  const two = buildGoliveSteps({ ...base, storeRead: { refused: false, ambiguous: true } }, { target: 'live' });
  assert.equal(byId(two, 'find_venue').state, 'attention');
  assert.equal(byId(two, 'find_venue').detail, 'More than one payments location carries the code SV-1007.');
  assert.equal(byId(two, 'find_venue').action, 'find_venue');
  assert.equal(byId(two, 'find_venue').hint, 'Pick the right one from the list below.');
  const refused = buildGoliveSteps({ ...base, storeRead: { refused: true, ambiguous: false } }, { target: 'live' });
  assert.equal(byId(refused, 'find_venue').state, 'blocked');
  assert.equal(byId(refused, 'find_venue').detail, 'Our payments key was refused, so the search could not run.');
  assert.equal(byId(refused, 'find_venue').action, null);
  assert.equal(byId(refused, 'find_venue').hint, 'The key needs the Stores read role at Adyen.');
  // with the Balance Platform refused as well, the store side still speaks first and step 2 keeps its own reason
  const both = buildGoliveSteps({ ...base, storeRead: { refused: true }, balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' } }, { target: 'live' });
  assert.equal(byId(both, 'find_venue').state, 'blocked');
  assert.equal(byId(both, 'business_account').action, 'add_bp_key');
  // a found store wins over either flag, and no storeRead at all is the old reading
  assert.equal(byId(buildGoliveSteps({ ...READY, row: { store_id: PROVO.id }, storeRead: { ambiguous: true } }, { target: 'live' }), 'find_venue').state, 'done');
  assert.equal(byId(buildGoliveSteps(base, { target: 'live' }), 'find_venue').detail, 'Nothing at Adyen carries the code SV-1007 yet.');
  assert.equal(byId(buildGoliveSteps({ ...base, storeRead: { refused: false, ambiguous: false } }, { target: 'live' }), 'find_venue').detail, 'Nothing at Adyen carries the code SV-1007 yet.');
  // no code still comes first: there is nothing to have searched for
  assert.equal(byId(buildGoliveSteps({ ...base, venue: { ...READY.venue, code: '' }, storeRead: { refused: true } }, { target: 'live' }), 'find_venue').action, 'set_venue_code');
  for (const s of [...two, ...refused]) {
    assert.ok(s.detail.length < PROBLEM_TEXT_MAX, `${s.id} detail`);
    assert.doesNotMatch(`${s.detail} ${s.hint ?? ''}`, /[\u2013\u2014]/, `dash in ${s.id}`);
  }
});

test('goliveProblems: the live screen’s four lines become ONE plain line, deduped by text', () => {
  const errors = [
    BP_REFUSED('account holder AH32BZP22322CJ5PXF2BD5FTR'),
    BP_REFUSED('account holder AH32BZP22322CJ5PXF2BD5FTR'),   // the same line twice, word for word
    BP_REFUSED('balance account BA3224Z223226M5KMQ5RBAL01'),
    'account holders on balance platform BP1234: refused (403): the credential behind ADYEN_LIVE_UK_BP_KEY (the set\'s API key when that is unset) needs the Balance Platform BCL role',
  ];
  const r = goliveProblems(errors);
  assert.equal(r.raw.length, 3, 'exact repeats dropped');
  assert.equal(r.problems.length, 1, 'one plain line');
  assert.equal(r.problems[0].kind, 'bp_refused');
  assert.equal(r.problems[0].text, BP_KEY_BLOCKED_DETAIL);
  assert.equal(r.problems[0].rawDetail.split('\n').length, 3, 'every raw line kept behind it');
  assert.equal(r.bpRefused, true);
  assert.equal(r.platformSettingsMissing, false);
  // nothing in: nothing out
  assert.deepEqual(goliveProblems(null), { raw: [], problems: [], bpRefused: false, platformSettingsMissing: false });
  assert.deepEqual(goliveProblems(['', null, '  ']).problems, []);
});

test('plainAdyenProblem: every kind is plain, under 120 characters, free of ids and dashes', () => {
  const cases = [
    [BP_REFUSED('account holder AH32BZP22322CJ5PXF2BD5FTR'), 'bp_refused'],
    ['legal entity LE32BZP22322CJ5PXF2BDLEG1: refused (403): the credential behind ADYEN_LIVE_UK_LEM_KEY (the set\'s API key when that is unset) needs the roles "Manage LegalEntities via API" and "Balance Platform BCL Legal Entity role"', 'lem_refused'],
    ['store list by reference on FranPOS_QSR_UK: refused (401): the credential behind ADYEN_LIVE_UK_MANAGEMENT_KEY (the set\'s API key when that is unset) needs the Management API role "Stores read"', 'management_refused'],
    ['account holder AH1: refused (401): the credential behind SOMETHING needs a role', 'refused'],
    ['Adyen did not answer GET /merchants/FranPOS_QSR_UK/stores within 20s', 'timeout'],
    ['Store ST_ELSEWHERE with the reference SV-1007 sits on merchant account FranPOS_UK, but ADYEN_LIVE_UK_MERCHANT_ACCOUNT names FranPOS_QSR_UK. Nothing was linked to it.', 'mismatch'],
    ['2 stores carry the reference SV-1007 (ST1 on A, ST2 on B). Pass storeId to pick one.', 'ambiguous_store'],
    ['2 account holders on balance platform BP1 carry the reference SV-1007 (AH1, AH2). They cannot be told apart by reference, so paste the account holder id of the right one.', 'ambiguous_holder'],
    ['balance account BA1 names no account holder.', 'gap'],
    ['account holder AH1 names no legal entity.', 'gap'],
    ['account holder AH1 has 3 balance accounts and none could be chosen for GBP.', 'gap'],
    ['This venue has no venue code, so there is no store reference to look up. Set one in the Back Office (Venue settings) or pass reference.', 'no_code'],
    ['The reader list could not be read: permission denied', 'readers'],
    ['The till links could not be read: fetch failed', 'readers'],
    // our own Postgres timing out is the reader list, never "Adyen took too long"
    ['The reader list could not be read: connection timed out', 'readers'],
    ['The till links could not be read: Adyen did not answer within 20s', 'readers'],
    ['The venue\'s online address could not be read: timed out', 'storefront'],
    ['The venue\'s online address could not be read: boom', 'storefront'],
    ['store ST1: Adyen answered 404: store not found', 'read_failed'],
    ['balance accounts of AH1: Adyen answered 500', 'read_failed'],
    ['business lines of LE1: Adyen answered 500', 'read_failed'],
    ['web origins: Adyen answered 500', 'read_failed'],
    ['Apple Pay: Adyen answered 500', 'read_failed'],
    ['merchant list: Adyen answered 500', 'read_failed'],
    ['something nobody wrote a line for', 'other'],
  ];
  for (const [raw, kind] of cases) {
    const p = plainAdyenProblem(raw);
    assert.equal(p.kind, kind, `kind of: ${raw}`);
    assert.ok(p.text.length < PROBLEM_TEXT_MAX, `${p.text.length} chars: ${p.text}`);
    assert.doesNotMatch(p.text, /\b(AH|ST|BA|LE|BP)[0-9A-Z_]{2,}\b/, `id in a sentence: ${p.text}`);
    assert.doesNotMatch(p.text, /[\u2013\u2014]/, `dash in: ${p.text}`);
    assert.doesNotMatch(p.text, /\(\d{3}\)|refused \(/, `raw status in: ${p.text}`);
    assert.equal(p.rawDetail, raw, 'the raw line rides apart from the plain one');
  }
  assert.equal(plainAdyenProblem(''), null);
  assert.equal(plainAdyenProblem(null), null);
  // the subject words are the screen's plain words, never Adyen's
  assert.equal(plainAdyenProblem('balance account BA1: Adyen answered 500').text, 'Adyen would not answer about where the money lands.');
  assert.equal(plainAdyenProblem('account holder AH1: Adyen answered 500').text, 'Adyen would not answer about the business account.');
  assert.equal(plainAdyenProblem('legal entity LE1: Adyen answered 500').text, 'Adyen would not answer about the registered company.');
});

test('goliveProblems: two different raw lines with the same plain text are one line, others stay apart', () => {
  const r = goliveProblems([
    'The reader list could not be read: permission denied',
    'The till links could not be read: fetch failed',
    'Adyen did not answer GET /merchants within 20s',
    'balance account BA1: Adyen answered 500',
  ]);
  assert.deepEqual(r.problems.map((p) => p.kind), ['readers', 'timeout', 'read_failed']);
  assert.equal(r.problems[0].rawDetail, 'The reader list could not be read: permission denied\nThe till links could not be read: fetch failed');
  assert.equal(r.bpRefused, false);
});

test('goliveProblems and isPlatformSettingsMissingWarning: the migration reminder is a flag, not a line', () => {
  const missing = goliveProblems([], { settingsWarning: platformSettingsMissingMessage() });
  assert.equal(missing.platformSettingsMissing, true);
  assert.deepEqual(missing.problems, [], 'never inside the box');
  assert.equal(isPlatformSettingsMissingWarning(platformSettingsMissingMessage()), true);
  assert.equal(isPlatformSettingsMissingWarning('Our own Adyen ids could not be read (timeout), so this venue needs its Adyen id pasted.'), false);
  assert.equal(isPlatformSettingsMissingWarning(''), false);
  assert.equal(isPlatformSettingsMissingWarning(null), false);
  // a read or write failure on the table is a plain line with the raw text behind it
  const failed = goliveProblems([], { settingsWarning: 'Our own Adyen ids could not be kept (permission denied). Run x.sql on the platform project if the table is missing.' });
  assert.equal(failed.platformSettingsMissing, false);
  assert.equal(failed.problems.length, 1);
  assert.equal(failed.problems[0].kind, 'settings');
  assert.equal(failed.problems[0].text, 'Our own Adyen ids could not be kept this time.');
  // a clash between the venue's balance platform and the kept one says so
  const clash = goliveProblems([], { settingsWarning: 'This venue is on balance platform BP2, but the UK live account we search is BP1. Nothing was changed.' });
  assert.equal(clash.problems[0].text, 'This venue sits on a different Adyen platform than the one we search.');
  for (const p of [...failed.problems, ...clash.problems]) assert.ok(p.text.length < PROBLEM_TEXT_MAX);
});

test('buildGoliveSteps: the new lines never use a dash as punctuation and stay short', () => {
  const steps = [
    ...buildGoliveSteps({ ...READY, row: { store_id: null } }, { target: 'live' }),
    ...buildGoliveSteps({ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {}, balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' } }, { target: 'live' }),
  ];
  for (const s of steps) {
    assert.doesNotMatch(`${s.detail} ${s.hint ?? ''}`, /[\u2013\u2014]/, `dash in ${s.id}`);
    assert.ok(s.detail.length < PROBLEM_TEXT_MAX, `${s.id} detail is ${s.detail.length} chars`);
    if (s.hint) assert.ok(s.hint.length < PROBLEM_TEXT_MAX, `${s.id} hint is ${s.hint.length} chars`);
  }
});

// ── THE TWO COPIES AGREE (9 Sep 2026) ────────────────────────────────────────
// The function (Deno) runs _shared/adyenLink.ts and the screen reads its
// answer, so the step builder and the plain problem lines are checked on THAT
// copy too. Node strips types natively from 23.6; anything older skips this
// one test instead of failing the run.
const TS_MIRROR = '../../../supabase/functions/_shared/adyenLink.ts';
test('TS mirror: buildGoliveSteps, goliveProblems and plainAdyenProblem answer exactly as the JS copy', async (t) => {
  let ts;
  try { ts = await import(TS_MIRROR); }
  catch (e) { t.skip(`this node cannot import the .ts mirror here (${e?.code || e?.message})`); return; }
  const shapes = [
    [{ ...READY, row: { store_id: null } }, { target: 'live' }],
    [{ ...READY, row: { store_id: 'ST_SOMETHING_ELSE' } }, { target: 'live' }],
    [{ ...READY, row: { store_id: PROVO.id } }, { target: 'live' }],
    [{ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], row: { store_id: null }, balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' } }, { target: 'live' }],
    [{ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {}, balancePlatformKey: { refused: true, secret: 'ADYEN_BP_KEY' }, venue: { ...READY.venue, environment: 'test' } }, { target: 'test' }],
    [{ ...READY, venue: { ...READY.venue, environment: 'test' }, row: null }, { target: 'live' }],
    [{ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {}, storeRead: { refused: true, ambiguous: false } }, { target: 'live' }],
    [{ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {}, storeRead: { refused: false, ambiguous: true } }, { target: 'live' }],
    [{ ...READY, holder: null, balanceAccount: null, legalEntity: null, capabilities: [], store: null, row: {}, storeRead: { refused: true }, balancePlatformKey: { refused: true, secret: 'ADYEN_LIVE_UK_BP_KEY' } }, { target: 'live' }],
  ];
  for (const [state, opts] of shapes) assert.deepEqual(ts.buildGoliveSteps(state, opts), buildGoliveSteps(state, opts));
  // the relink clear rule is the same on both sides of the wire
  const swap = { merchant_account: 'FranPOS_QSR_UK', store_id: PROVO.id, receive_payments_ok: true };
  const swapPlan = planLink({ row: { store_id: 'ST_OLD', account_holder_id: 'AH_OLD' }, currentEnv: 'live', targetEnv: 'live', patch: swap, relink: true });
  assert.deepEqual(ts.relinkClear(swapPlan.diff, swap), relinkClear(swapPlan.diff, swap));
  const moved = { ...swap, balance_account_id: 'BA_NEW' };
  const movedPlan = planLink({ row: { store_id: 'ST_OLD', balance_account_id: 'BA_OLD' }, currentEnv: 'live', targetEnv: 'live', patch: moved, relink: true });
  assert.deepEqual(ts.relinkClear(movedPlan.diff, moved), relinkClear(movedPlan.diff, moved));
  const errors = [
    BP_REFUSED('account holder AH32BZP22322CJ5PXF2BD5FTR'),
    BP_REFUSED('account holder AH32BZP22322CJ5PXF2BD5FTR'),
    BP_REFUSED('balance account BA3224Z223226M5KMQ5RBAL01'),
    'The reader list could not be read: permission denied',
    'The reader list could not be read: connection timed out',
    'Adyen did not answer GET /merchants within 20s',
    'balance account BA1: Adyen answered 500',
  ];
  assert.deepEqual(ts.goliveProblems(errors, { settingsWarning: platformSettingsMissingMessage() }), goliveProblems(errors, { settingsWarning: platformSettingsMissingMessage() }));
  for (const raw of errors) assert.deepEqual(ts.plainAdyenProblem(raw), plainAdyenProblem(raw));
  assert.equal(ts.BP_KEY_BLOCKED_DETAIL, BP_KEY_BLOCKED_DETAIL);
  assert.equal(ts.STORE_NOT_SAVED_DETAIL, STORE_NOT_SAVED_DETAIL);
  assert.equal(ts.bpKeyBlockedHint('ADYEN_LIVE_UK_BP_KEY', 'live'), bpKeyBlockedHint('ADYEN_LIVE_UK_BP_KEY', 'live'));
});
