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

test('adyenVenueStatus: Payouts means allowed AND paid out once the sweep column is there', () => {
  // the column present (migration 20260909b ran): allowed with no sweep is NOT paid out
  const allowedOnly = adyenVenueStatus({ environment: 'live', account_holder_id: 'AH1', payouts_ok: true, payout_sweep_id: null }, { currency: 'GBP' });
  assert.equal(allowedOnly.payouts, false);
  assert.equal(allowedOnly.chips.payouts.label, 'No payouts');
  assert.match(allowedOnly.chips.payouts.title, /daily payout is not switched on/);
  // allowed and the sweep exists: paid out
  const paid = adyenVenueStatus({ environment: 'live', account_holder_id: 'AH1', payouts_ok: true, payout_sweep_id: 'SWPC1' }, { currency: 'GBP' });
  assert.equal(paid.payouts, true);
  assert.equal(paid.chips.payouts.tone, 'ok');
  assert.match(paid.chips.payouts.title, /SWPC1/);
  // a sweep with the capability gone is not paid out
  assert.equal(adyenVenueStatus({ environment: 'live', payouts_ok: false, payout_sweep_id: 'SWPC1' }, { currency: 'GBP' }).payouts, false);
  // the column absent (a row read before the migration): the capability alone, as it always was
  const old = adyenVenueStatus({ environment: 'live', account_holder_id: 'AH1', payouts_ok: true }, { currency: 'GBP' });
  assert.equal(old.payouts, true);
  assert.equal(old.chips.payouts.title, 'Adyen allows payouts to the venue bank');
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

// ── the kept setup (env_stash, 8 Sep 2026) ───────────────────────────────────

import { stashLine, restoredLine } from './adyenAdminRows.js';

test('stashLine: store, readers and the kept date, with or without the environment prefix', () => {
  assert.equal(stashLine('test', { store_id: 'ST_TEST_1', ids: 6, readers: 2, stashed_at: '2026-09-08T12:00:00.000Z' }), 'test: store ST_TEST_1, 2 card readers (kept 2026-09-08)');
  assert.equal(stashLine('', { store_id: null, ids: 3, readers: 1, stashed_at: null }), '3 account ids, 1 card reader');
  assert.equal(stashLine('live', null), 'live: nothing');
});

test('restoredLine: what came back, empty when nothing did', () => {
  assert.equal(restoredLine({ store_id: 'ST_TEST_1', ids: ['store_id', 'split_profile_id'], readers: { platform: 2, ops: 1 } }), 'store ST_TEST_1, 2 card readers');
  assert.equal(restoredLine({ store_id: null, ids: ['payouts_ok'], readers: { platform: 0, ops: 0 } }), '1 account field');
  assert.equal(restoredLine({ store_id: null, ids: [], readers: { platform: 0, ops: 0 } }), '');
  assert.equal(restoredLine(null), '');
});

test('linkResultLines: a kept setup says so instead of "register again", and a restore is reported', () => {
  const lines = linkResultLines({
    reference: 'SV-1007', environment: 'live', previous: 'test', region: 'UK', reprovisioned: true,
    patch: { store_id: 'ST_LIVE_1' },
    stash_saved: { store_id: 'ST_TEST_1', ids: 6, readers: 2, stashed_at: '2026-09-08T12:00:00.000Z' },
    restored: { environment: 'live', store_id: null, ids: ['split_profile_id'], readers: { platform: 1, ops: 1 }, skipped: [] },
    warnings: [],
  }, 'Provo');
  const texts = lines.map((l) => l.text);
  assert.ok(texts.some((t) => /set aside and kept \(store ST_TEST_1, 2 card readers \(kept 2026-09-08\)\)/.test(t)), texts.join(' | '));
  assert.ok(!texts.some((t) => /Register the card readers again/.test(t)));
  assert.ok(texts.some((t) => t === 'The live setup kept earlier came back: 1 account field, 1 card reader.'), texts.join(' | '));
  // Without a stash (older fn build, or the column missing) the old line stays.
  const old = linkResultLines({ environment: 'live', previous: 'test', reprovisioned: true, patch: {} }).map((l) => l.text);
  assert.ok(old.some((t) => /was cleared\. Register the card readers again\./.test(t)));
});

// ── the three blocks (8 Sep 2026): however Adyen holds the venue ─────────────

import { capabilityRows, lookupBlocks, merchantPicker } from './adyenAdminRows.js';

const CAPS_SUMMARY = {
  receiveOk: true,
  payoutsOk: false,
  verificationStatus: 'pending',
  problems: ['sendToTransferInstrument: Bank account not verified'],
  byName: {
    receivePayments: { enabled: true, allowed: true, requested: true, verificationStatus: 'valid' },
    sendToTransferInstrument: { enabled: false, allowed: false, requested: true, verificationStatus: 'pending', problems: [{}] },
    receiveFromPlatformPayments: { enabled: false, allowed: false, requested: true, verificationStatus: 'invalid' },
    issueCard: { enabled: false, allowed: false, requested: false, verificationStatus: null },
  },
};

test('capabilityRows: a blocked capability is red, pending amber, unrequested grey, blockers first', () => {
  const rows = capabilityRows(CAPS_SUMMARY);
  assert.deepEqual(rows.map((r) => [r.name, r.tone]), [
    ['receiveFromPlatformPayments', 'bad'],       // requested, not allowed, invalid
    ['sendToTransferInstrument', 'missing'],      // requested, not allowed, still pending
    ['receivePayments', 'ok'],
    ['issueCard', 'muted'],                       // never requested
  ]);
  assert.equal(rows[0].label, 'receive platform payments');
  assert.match(rows[0].text, /NOT ALLOWED/);
  assert.match(rows[1].text, /pay out to a bank account/);
  assert.equal(rows[2].allowed, true);
  // a bare byName map works too, and an unknown name reads as words
  const bare = capabilityRows({ somethingNew: { allowed: false, requested: true, verificationStatus: 'rejected' } });
  assert.equal(bare[0].label, 'something new');
  assert.deepEqual(capabilityRows(null), []);
});

const HOLDER_ONLY = {
  found: true, reference: 'SV-1007', merchantAccount: 'FranPOS_QSR_UK', store: null,
  balanceAccount: { id: 'BA1', status: 'active', currency: 'GBP', accountHolderId: 'AH1', source: 'account_holder' },
  accountHolder: { id: 'AH1', reference: 'SV-1007', status: 'active', legalEntityId: 'LE1', balancePlatform: 'FranPOSPlatform', capabilities: CAPS_SUMMARY },
  legalEntity: { id: 'LE1', name: 'Point Of Sale Unified Partners Limited', type: 'organization', status: 'pending', transferInstrumentId: null, transferInstruments: [], problems: [] },
};

test('lookupBlocks: the live shape (account holder, no store) says what is missing and what to do', () => {
  const [holder, store, legal] = lookupBlocks(HOLDER_ONLY);
  assert.deepEqual([holder.key, store.key, legal.key], ['holder', 'store', 'legal']);
  assert.equal(holder.found, true);
  assert.equal(holder.tone, 'bad');                                   // a capability is blocked
  assert.deepEqual(holder.rows[0], { label: 'Account holder', value: 'AH1' });
  assert.ok(holder.rows.some((r) => r.label === 'Balance account' && r.value === 'BA1'));
  assert.equal(holder.capabilities.length, 4);
  assert.ok(holder.lines.some((l) => l.tone === 'bad' && /BLOCKS/.test(l.text)));
  assert.equal(store.found, false);
  assert.ok(store.lines.some((l) => /A STORE IS STILL NEEDED/.test(l.text)), JSON.stringify(store.lines));
  assert.equal(legal.found, true);
  assert.equal(legal.tone, 'missing');                                // verification pending
  assert.ok(legal.lines.some((l) => /no bank account yet/.test(l.text)));
});

test('lookupBlocks: a store on another merchant shows the mismatch line in the store block', () => {
  const [, store] = lookupBlocks({
    ...HOLDER_ONLY,
    merchantMismatch: { configured: 'FranPOS_QSR_UK', found: 'FranPOS_UK', secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', message: 'Store ST9 sits on merchant account FranPOS_UK, but ADYEN_LIVE_UK_MERCHANT_ACCOUNT names FranPOS_QSR_UK.' },
  });
  assert.ok(store.lines.some((l) => l.tone === 'bad' && /FranPOS_UK/.test(l.text)));
});

test('lookupBlocks: a full store venue is green, and nothing found says so plainly', () => {
  const [holder, store] = lookupBlocks({
    found: true, reference: 'SV-1007',
    store: { id: 'ST1', reference: 'SV-1007', status: 'active', merchantId: 'FranPOS_QSR_UK', splitConfigurationId: 'SC1', balanceAccountId: 'BA1', businessLineIds: ['SBL1'] },
    balanceAccount: { id: 'BA1', status: 'active', currency: 'GBP', source: 'store' },
    accountHolder: { id: 'AH1', status: 'active', capabilities: { byName: { receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' } } } },
    legalEntity: { id: 'LE1', name: 'Provo Coffee Ltd', status: 'valid', transferInstrumentId: 'SI1', problems: [] },
  });
  assert.equal(store.tone, 'ok');
  assert.equal(holder.tone, 'ok');
  assert.deepEqual(store.lines, []);
  const [h2, s2, l2] = lookupBlocks({ found: false, reference: 'SV-1099', store: null, accountHolder: null, legalEntity: null });
  assert.equal(h2.found, false);
  assert.match(h2.lines[0].text, /no account holder for SV-1099/);
  assert.match(s2.lines[0].text, /No store carries the reference SV-1099/);
  assert.match(l2.lines[0].text, /account holder is needed first/);
  assert.deepEqual(lookupBlocks(null).map((b) => b.found), [false, false, false]);
});

test('merchantPicker: the accounts the credential sees, the secret’s one marked', () => {
  const answer = {
    live: {
      configured: true, secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', merchantAccount: 'FranPOS_QSR_UK',
      merchants: [
        { id: 'FranPOS_QSR_UK', name: 'FranPOS QSR UK Ltd', status: 'Active', storeCount: 0 },
        { id: 'FranPOS_UK', name: 'FranPOS UK Ltd', status: 'Active', storeCount: 12 },
      ],
    },
    test: { configured: true, secret: 'ADYEN_MERCHANT_ACCOUNT', merchantAccount: 'FranPOS_ServOS_TEST', merchants: [], error: 'refused (403)' },
  };
  const live = merchantPicker(answer, 'live');
  assert.equal(live.configured, 'FranPOS_QSR_UK');
  assert.equal(live.secret, 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT');
  assert.equal(live.options.length, 2);
  assert.match(live.options[0].label, /FranPOS_QSR_UK · FranPOS QSR UK Ltd · Active · 0 stores/);
  assert.equal(live.options[0].configured, true);
  assert.match(live.options[1].label, /12 stores/);
  assert.equal(live.options[1].configured, false);
  const t = merchantPicker(answer, 'test');
  assert.equal(t.error, 'refused (403)');
  assert.deepEqual(t.options, []);
  assert.deepEqual(merchantPicker(null).options, []);
});

// ── THE GUIDED FLOW (8 Sep 2026, OWNER FEEDBACK) ─────────────────────────────
import {
  GOLIVE_STEP_TITLES, goliveFlowView, capabilityNotices, mismatchView,
  plainFailure, goLiveConfirmText, relinkConfirmText, goLiveConfirmLines, relinkConfirmLines, relinkStoreConfirmView,
} from './adyenAdminRows.js';
import { buildGoliveSteps, capabilityList } from './adyenLink.js';

const PAYOUT_PARTS = [
  { id: 'split', state: 'todo', detail: 'Make the payments location first.' },
  { id: 'payout', state: 'todo', detail: 'The venue has not added its bank account yet.', action: 'send_bank_link', hint: 'One click makes a link for the venue owner.' },
];
const FIVE = [
  { id: 'find_venue', state: 'done', detail: 'Adyen holds SV-1007 as a business account.' },
  { id: 'business_account', state: 'done', detail: 'POINT OF SALE UNIFIED PARTNERS LIMITED is set up.' },
  { id: 'payments_location', state: 'todo', detail: 'No store yet, so card payments have nowhere to go.', action: 'create_store' },
  { id: 'go_live', state: 'todo', detail: 'Finish the steps above first.' },
  { id: 'payouts', state: 'todo', detail: 'Make the payments location first.', action: 'send_bank_link', parts: PAYOUT_PARTS },
  { id: 'readers', state: 'todo', detail: 'No card readers on this venue yet.', action: 'add_reader' },
];

test('goliveFlowView: six numbered rows, the owner’s titles, the first not done is open', () => {
  const v = goliveFlowView({ steps: FIVE });
  assert.deepEqual(v.steps.map((x) => x.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(v.steps.map((x) => x.title), [
    'Find the venue on Adyen',
    'The venue’s Adyen business account',
    'The venue’s payments location',
    'Turn on live payments',
    'Card rates and payouts',
    'Card readers',
  ]);
  assert.equal(v.openId, 'payments_location');
  assert.equal(v.steps.filter((x) => x.open).length, 1);
  assert.equal(v.progressLabel, 'Step 3 of 6');
  assert.equal(v.doneCount, 2);
  assert.equal(v.progressPct, 33);
  assert.deepEqual(v.steps.map((x) => x.chip.label), ['Done', 'Done', 'To do', 'To do', 'To do', 'To do']);
  assert.deepEqual(v.steps.map((x) => x.chip.tone), ['ok', 'ok', 'idle', 'idle', 'idle', 'idle']);
  // the payouts step's two parts ride through with their own titles and chips
  const payouts = v.steps[4];
  assert.deepEqual(payouts.parts.map((p) => p.title), ['Card rates', 'Payouts to the venue']);
  assert.deepEqual(payouts.parts.map((p) => p.chip.label), ['To do', 'To do']);
  assert.equal(payouts.parts[1].action, 'send_bank_link');
  assert.equal(payouts.parts[1].hint, 'One click makes a link for the venue owner.');
  // every other step has no parts, and a missing parts list is an empty one
  for (const s of v.steps) if (s.id !== 'payouts') assert.deepEqual(s.parts, []);
});

test('goliveFlowView: the four states each get their own chip, and a bad answer still draws six rows', () => {
  const v = goliveFlowView({ steps: [
    { id: 'find_venue', state: 'blocked' },
    { id: 'business_account', state: 'attention' },
    { id: 'payments_location', state: 'nonsense' },
  ] });
  assert.deepEqual(v.steps.map((x) => x.chip.label), ['Blocked', 'Needs attention', 'To do', 'To do', 'To do', 'To do']);
  assert.deepEqual(v.steps.map((x) => x.chip.tone), ['bad', 'warn', 'idle', 'idle', 'idle', 'idle']);
  assert.equal(v.openId, 'find_venue');
  assert.equal(goliveFlowView(null).steps.length, 6);
  assert.equal(goliveFlowView(null).openId, 'find_venue');
});

test('goliveFlowView: everything done closes every row and says so', () => {
  const done = FIVE.map((s) => ({ ...s, state: 'done' }));
  const v = goliveFlowView({ steps: done });
  assert.equal(v.allDone, true);
  assert.equal(v.openId, null);
  assert.equal(v.progressLabel, 'All 6 steps done');
  assert.equal(v.progressPct, 100);
  assert.equal(v.steps.filter((x) => x.open).length, 0);
});

test('goliveFlowView: opening a done row keeps exactly one open', () => {
  const v = goliveFlowView({ steps: FIVE }, 'find_venue');
  assert.equal(v.openId, 'find_venue');
  assert.equal(v.steps.filter((x) => x.open).length, 1);
  assert.equal(v.progressLabel, 'Step 1 of 6');
  // a row id nobody answered falls back to the first that is not done
  assert.equal(goliveFlowView({ steps: FIVE }, 'not_a_step').openId, 'payments_location');
});

test('goliveFlowView: a blocked step always opens, a note only step never parks the owner', () => {
  // "Cards work. Payouts wait for Adyen." is amber with nothing to press, so
  // the flow opens the next step that actually has work on it (8 Sep 2026: a
  // blocked payout held the flow at step 2 forever).
  const payout = goliveFlowView({ steps: [
    { id: 'find_venue', state: 'done', detail: 'x' },
    { id: 'business_account', state: 'attention', detail: 'Cards work. Payouts wait for Adyen.' },
    { id: 'payments_location', state: 'todo', detail: 'y', action: 'create_store' },
    { id: 'go_live', state: 'todo', detail: 'Finish the steps above first.' },
    { id: 'readers', state: 'todo', detail: 'z', action: 'add_reader' },
  ] });
  assert.equal(payout.openId, 'payments_location');
  assert.equal(payout.steps[1].chip.label, 'Needs attention');

  // Blocked always wins, wherever it sits and whether or not it has a button.
  const blocked = goliveFlowView({ steps: [
    { id: 'find_venue', state: 'todo', detail: 'x', action: 'find_venue' },
    { id: 'business_account', state: 'blocked', detail: 'Adyen blocks receivePayments.' },
    { id: 'payments_location', state: 'todo', detail: 'y', action: 'create_store' },
  ] });
  assert.equal(blocked.openId, 'business_account');

  // An attention step WITH work on it still opens.
  const inactive = goliveFlowView({ steps: [
    { id: 'find_venue', state: 'done', detail: 'x' },
    { id: 'business_account', state: 'done', detail: 'y' },
    { id: 'payments_location', state: 'attention', detail: 'The store is inactive at Adyen.', action: 'open_adyen' },
  ] });
  assert.equal(inactive.openId, 'payments_location');
});

test('goliveFlowView: the live shape reaches step 3, blocked payout and all', () => {
  const steps = buildGoliveSteps({
    venue: { name: 'Provo', code: 'SV-1007', region: 'UK', environment: 'test' },
    keys: { configured: true, missing: [] },
    liveKeys: { configured: true, missing: [] },
    holder: { id: 'AH32BZP22322CJ5PXF2BD5FTR', status: 'active' },
    balanceAccount: { id: 'BA3224Z223226M5KMQ5RBAL01', currency: 'GBP' },
    legalEntity: { id: 'LE32BZP22322CJ5PXF2BDLEG1', name: 'POINT OF SALE UNIFIED PARTNERS LIMITED', transferInstrumentId: 'SE123' },
    capabilities: capabilityList({
      receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' },
      sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'rejected' },
    }),
    store: null,
    // the venue's own row (step 5 offers nothing at all without one, 9 Sep 2026)
    row: { store_id: null, account_holder_id: 'AH32BZP22322CJ5PXF2BD5FTR', balance_account_id: 'BA3224Z223226M5KMQ5RBAL01', legal_entity_id: 'LE32BZP22322CJ5PXF2BDLEG1', transfer_instrument_id: 'SE123' },
  });
  const v = goliveFlowView({ steps });
  // since 9 Sep 2026 the refused pay out sits on step 5, so step 2 is done
  assert.equal(v.steps[1].state, 'done');
  assert.match(v.steps[1].detail, /is set up/);
  assert.equal(v.openId, 'payments_location');
  assert.equal(v.steps[2].action, 'create_store');
  assert.equal(v.steps[4].parts[1].detail, 'Adyen will not pay this venue out yet.');
  assert.equal(v.steps[4].action, null, 'a wait on Adyen never parks the flow');
});

test('goliveFlowView: a step blocked on a server secret never hides the one click the owner can make', () => {
  // The live screen, 9 Sep 2026: step 2 blocked on the Balance Platform key
  // (only ServOS can add it, action add_bp_key) and step 3 offering to save
  // the found store. The flow opens step 3, where the button is, so the list
  // chip can turn from Not linked to Linked.
  const live = [
    { id: 'find_venue', state: 'done', detail: 'Adyen holds SV-1007 as a store.' },
    { id: 'business_account', state: 'blocked', detail: 'Our payments key cannot see the business account side.', action: 'add_bp_key' },
    { id: 'payments_location', state: 'attention', detail: 'Adyen holds the payments location, it is not saved on the venue yet.', action: 'link_store' },
    { id: 'go_live', state: 'attention', detail: 'Real cards are on, but the payments location is not saved on the venue.' },
    { id: 'readers', state: 'todo', detail: 'No card readers on this venue yet.', action: 'add_reader' },
  ];
  const v = goliveFlowView({ steps: live });
  assert.equal(v.openId, 'payments_location');
  assert.equal(v.progressLabel, 'Step 3 of 6');
  assert.equal(v.steps[1].chip.label, 'Blocked', 'step 2 still reads Blocked');
  assert.equal(v.steps.filter((x) => x.open).length, 1);
  // after the save: step 3 and 4 done, step 5 blocked on the same key (a
  // wait), the next click is on step 6, step 2 still not parking the flow
  const after = goliveFlowView({ steps: [
    live[0],
    live[1],
    { id: 'payments_location', state: 'done', detail: 'Card payments go to SV-1007.' },
    { id: 'go_live', state: 'done', detail: 'Provo takes real cards.' },
    { id: 'payouts', state: 'blocked', detail: 'Our payments key cannot see the business account side.', action: 'add_bp_key' },
    live[4],
  ] });
  assert.equal(after.openId, 'readers');
  assert.equal(after.progressLabel, 'Step 6 of 6');
  // nothing else left to press: the server secret step opens after all, so its reason is on screen
  const only = goliveFlowView({ steps: [
    live[0], live[1],
    { id: 'payments_location', state: 'done', detail: 'z' },
    { id: 'go_live', state: 'done', detail: 'w' },
    { id: 'payouts', state: 'done', detail: 'u' },
    { id: 'readers', state: 'done', detail: 'v' },
  ] });
  assert.equal(only.openId, 'business_account');
  assert.equal(only.allDone, false);
  // a step ADYEN blocked (open_adyen, not a server secret) still wins over everything
  const adyen = goliveFlowView({ steps: [
    live[0],
    { id: 'business_account', state: 'blocked', detail: 'Adyen blocks receivePayments.', action: 'open_adyen' },
    live[2],
  ] });
  assert.equal(adyen.openId, 'business_account');
  // the reader can still open step 2 by hand
  assert.equal(goliveFlowView({ steps: live }, 'business_account').openId, 'business_account');
});

test('goliveFlowView: the server’s own steps drive it, ids and order match', () => {
  const v = goliveFlowView({ steps: buildGoliveSteps({ venue: { code: 'SV-1007', environment: 'test' }, keys: { configured: true, missing: [] } }) });
  assert.deepEqual(v.steps.map((x) => x.id), ['find_venue', 'business_account', 'payments_location', 'go_live', 'payouts', 'readers']);
  assert.equal(v.openId, 'find_venue');
  assert.equal(v.steps[0].action, 'find_venue');
});

test('capabilityNotices: never the word Blocked on its own', () => {
  const caps = capabilityList({
    receivePayments: { allowed: true, requested: true, verificationStatus: 'valid' },
    sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'rejected' },
    receiveFromPlatformPayments: { allowed: false, requested: true, verificationStatus: 'pending' },
    issueCard: { allowed: false, requested: false },
  });
  const notices = capabilityNotices(caps);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].text, 'Adyen has not approved this yet');
  assert.equal(notices[0].name, 'sendToTransferInstrument');
  assert.equal(notices[0].label, 'pay out to a bank account');
  assert.equal(notices[0].tone, 'bad');
  assert.equal(notices[1].text, 'Adyen is still checking this');
  assert.equal(notices[1].tone, 'missing');
  for (const n of notices) assert.doesNotMatch(n.text, /blocked/i);
  assert.deepEqual(capabilityNotices(null), []);
});

test('mismatchView: one plain sentence and the two account names apart from it', () => {
  const m = mismatchView({ found: 'FranPOS_UK', configured: 'FranPOS_QSR_UK', secret: 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT', message: 'store ST1 sits on merchant account FranPOS_UK...' });
  assert.equal(m.text, 'This venue is on a different Adyen account than the one we are set to use.');
  assert.equal(m.theirs, 'FranPOS_UK');
  assert.equal(m.ours, 'FranPOS_QSR_UK');
  assert.equal(m.secret, 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT');
  assert.match(m.detail, /FranPOS_UK/);
  assert.equal(mismatchView(null), null);
  assert.equal(mismatchView({}), null);
});

test('plainFailure: one plain sentence, the raw answer kept for Show detail', () => {
  const admin = plainFailure({ status: 403, data: { error: 'ServOS admin only' } }, 'The venue could not be read');
  assert.match(admin.text, /^Only a ServOS super admin/);
  assert.equal(admin.detail, 'ServOS admin only');

  const scope = plainFailure({ data: { error: 'scope_missing', detail: 'the key lacks Management Stores read' } }, 'The payments location could not be made');
  assert.match(scope.text, /missing a permission/);
  assert.match(scope.text, /then try again/);
  assert.equal(scope.detail, 'the key lacks Management Stores read');

  const keys = plainFailure(new Error('The UK live Adyen set is not configured on the server'), 'x');
  assert.match(keys.text, /not on the server yet/);

  const net = plainFailure(new TypeError('Failed to fetch'), 'x');
  assert.match(net.text, /could not be reached/);

  const other = plainFailure(new Error('store create failed (422)'), 'The payments location could not be made');
  assert.equal(other.text, 'The payments location could not be made. Try again, and open Show detail to see what Adyen said.');
  assert.equal(other.detail, 'store create failed (422)');
  assert.equal(plainFailure(null).detail, null);
});

test('goLiveConfirmText: real money, what is set aside and what comes back', () => {
  const text = goLiveConfirmText({
    environment: 'live', previous: 'test', region: 'UK',
    lookup: { store: { id: 'ST123456789012345', status: 'active' } },
    plan: { kind: 'flip', diff: { conflicts: [] } },
    provisioned: ['store_id'], readers: 2, keepsSetup: true,
    stashes: { live: { store_id: 'ST_LIVE_1', ids: 4, readers: 1, stashed_at: '2026-09-01T10:00:00.000Z' } },
  }, 'Provo');
  assert.match(text, /Turn on live payments for Provo/);
  assert.match(text, /Real cards are charged/);
  assert.match(text, /sets aside the venue’s test setup \(the Adyen ids and 2 card machines\)/);
  assert.match(text, /comes back if you switch back/);
  assert.match(text, /The live setup kept earlier comes back too/);
  assert.match(text, /Continue\?$/);
});

test('goLiveConfirmText: no payments location says so, and a replacement names the ids', () => {
  const storeless = goLiveConfirmText({
    environment: 'live', previous: 'test', region: 'UK',
    lookup: { accountHolder: { id: 'AH1' } }, plan: { kind: 'flip', diff: { conflicts: [] } },
  }, 'Provo');
  assert.match(storeless, /Adyen holds no payments location for this venue yet/);

  const replace = goLiveConfirmText({
    environment: 'live', previous: 'live', region: 'UK',
    lookup: { store: { id: 'ST2', status: 'inactive' } },
    plan: { kind: 'update', diff: { conflicts: [{ field: 'store_id', current: 'ST1', next: 'ST2' }] } },
  }, 'Provo');
  assert.match(replace, /REPLACES stored ids: store ST1 to ST2/);
  assert.match(replace, /is INACTIVE at Adyen/);
});

test('goLiveConfirmLines: one line per consequence, so the in page panel can lay them out', () => {
  const answer = {
    environment: 'live', previous: 'test', region: 'UK',
    lookup: { accountHolder: { id: 'AH1' } }, plan: { kind: 'flip', diff: { conflicts: [] } },
    provisioned: ['store_id'], readers: 2, keepsSetup: true,
  };
  const lines = goLiveConfirmLines(answer, 'Provo');
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /^Turn on live payments for Provo/);
  assert.match(lines[1], /no payments location/);
  for (const l of lines) assert.doesNotMatch(l, /\n/, 'every line stands on its own');
  // the joined string is the same content, so anything still wanting one works
  assert.equal(goLiveConfirmText(answer, 'Provo'), `${lines.join('\n\n')}\n\nContinue?`);

  const relink = relinkConfirmLines({ error: 'the venue already holds different ids', keepsSetup: true, previous: 'test', environment: 'live' });
  assert.deepEqual(relink.length, 2);
  assert.match(relink[0], /already holds different ids/);
  assert.match(relink[1], /test setup is kept/);
});

test('relinkConfirmText: the fn’s own reason, and the kept setup', () => {
  const t = relinkConfirmText({ error: 'the venue already holds different ids', keepsSetup: true, previous: 'test', environment: 'live' }, 'Provo');
  assert.match(t, /already holds different ids/);
  assert.match(t, /test setup is kept/);
  assert.match(t, /link Provo again\?$/);
});

test('relinkStoreConfirmView: plain lines under 120 characters, the ids as their own rows, never in a sentence', () => {
  // link_store answered 409 needs_relink: the fn's reason carries two ids and
  // a column name in one 151 character sentence. The panel never shows it.
  const data = {
    needs_relink: true,
    error: 'This venue is already linked on live to different Adyen ids (store_id ST3224Z223226M5KMQ5RLXV2W to ST32DDL22322BQ5PXJVN95JSM). Confirm to replace them.',
    plan: { kind: 'refuse', diff: { conflicts: [{ field: 'store_id', current: 'ST3224Z223226M5KMQ5RLXV2W', next: 'ST32DDL22322BQ5PXJVN95JSM' }] } },
  };
  const v = relinkStoreConfirmView(data);
  assert.deepEqual(v.lines, ['The venue already names a different payments location.', 'Replacing it changes where card payments go.']);
  assert.deepEqual(v.ids, [
    { label: 'Payments location now', value: 'ST3224Z223226M5KMQ5RLXV2W' },
    { label: 'Payments location after', value: 'ST32DDL22322BQ5PXJVN95JSM' },
  ]);
  // the money side moving is the one case the server clears the unreached ids, so only then is it said
  const money = relinkStoreConfirmView({ plan: { diff: { conflicts: [
    { field: 'store_id', current: 'ST_OLD', next: 'ST_NEW' },
    { field: 'balance_account_id', current: 'BA3224Z223226M5KMQ5RBAL01', next: 'BA32DDL22322BQ5PXJVN95BAL' },
  ] } } });
  assert.equal(money.lines.length, 3);
  assert.equal(money.lines[2], 'Ids on the venue that this read did not reach are cleared.');
  assert.deepEqual(money.ids.map((x) => x.label), ['Payments location now', 'Payments location after', 'Where the money lands now', 'Where the money lands after']);
  // a merchant account conflict names the account, not the location
  const merchant = relinkStoreConfirmView({ plan: { diff: { conflicts: [{ field: 'merchant_account', current: 'FranPOS_UK', next: 'FranPOS_QSR_UK' }] } } });
  assert.equal(merchant.lines[0], 'The venue already names a different Adyen account.');
  assert.deepEqual(merchant.ids.map((x) => x.label), ['Adyen account now', 'Adyen account after']);
  for (const l of [...v.lines, ...money.lines, ...merchant.lines]) {
    assert.ok(l.length < 120, l);
    assert.doesNotMatch(l, /\b(ST|BA|AH)[0-9A-Z]{6,}/, l);
    assert.doesNotMatch(l, /store_id|balance_account_id|merchant_account|[\u2013\u2014]/, l);
  }
  // nothing known: the store line, no rows, never a throw
  assert.deepEqual(relinkStoreConfirmView(null), { lines: ['The venue already names a different payments location.', 'Replacing it changes where card payments go.'], ids: [] });
  assert.deepEqual(relinkStoreConfirmView({ error: 'x', plan: { diff: {} } }).ids, []);
});

test('the flow’s wording never uses a dash as punctuation', () => {
  const words = [
    ...Object.values(GOLIVE_STEP_TITLES),
    ...goliveFlowView({ steps: FIVE }).steps.map((s) => s.chip.label),
    ...goliveFlowView({ steps: FIVE }).steps[4].parts.map((p) => p.title),
    ...rateCardRows({ tiers: {} }).map((r) => `${r.label} ${r.rate}`),
    ...capabilityNotices(capabilityList({ sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'rejected' } })).map((n) => n.text),
    mismatchView({ found: 'A', configured: 'B' }).text,
    plainFailure({ status: 403 }).text,
    plainFailure(new Error('nope'), 'It did not work').text,
    goLiveConfirmText({ environment: 'live', previous: 'test', region: 'UK', lookup: { store: { id: 'ST1', status: 'active' } }, plan: { kind: 'flip', diff: { conflicts: [] } }, provisioned: ['store_id'], readers: 1, keepsSetup: true }, 'Provo'),
    relinkConfirmText({ error: 'no' }, 'Provo'),
  ];
  for (const w of words) assert.doesNotMatch(String(w), /[–—]/, `dash in: ${w}`);
});

// ── FINDING A VENUE BY ITS REFERENCE, NOTHING PASTED (8 and 10 Sep 2026) ─────
import { referenceSearchView, PLATFORM_ID_LINE, RATES_LEDE, rateCardRows } from './adyenAdminRows.js';

test('referenceSearchView: when the business account search needed the platform name, ONE input asks for it once per region', () => {
  const v = referenceSearchView({ reference: 'SV-1007', balancePlatformKnown: false, needsBalancePlatform: true });
  assert.equal(v.known, false);
  assert.equal(v.needsPlatformId, true);
  assert.equal(v.platformLine, PLATFORM_ID_LINE);
  assert.equal(v.platformLine, 'The Adyen platform name is needed once for each region. After that every venue is found by its code.');
  assert.ok(v.platformLine.length < 120);
  assert.equal(v.foundLine, null);
  // the step state's own flag says the same
  assert.equal(referenceSearchView({ balancePlatformKnown: false, holderRead: { needsPlatform: true } }).needsPlatformId, true);
  // NOT KNOWN IS NOT NEEDED (10 Sep 2026): keys missing, no merchant account
  // or a refused read never ran the search, so no box on a blocked step
  const keysMissing = referenceSearchView({ reference: 'SV-1007', balancePlatformKnown: false, needsBalancePlatform: false, keys: { configured: false, missing: ['ADYEN_API_KEY'] } });
  assert.equal(keysMissing.needsPlatformId, false);
  assert.equal(keysMissing.platformLine, null);
  assert.equal(referenceSearchView(null).needsPlatformId, false);
  assert.equal(referenceSearchView({ balancePlatformKnown: false }).needsPlatformId, false);
  // the old paste first flags are gone: nothing on the screen reads them
  assert.equal('pastePrimary' in v, false);
  assert.equal('firstVenueLine' in v, false);
});

test('referenceSearchView: once the id is known there is no box at all, Find on Adyen is the one primary', () => {
  const v = referenceSearchView({ reference: 'SV-1008', balancePlatformKnown: true });
  assert.equal(v.known, true);
  assert.equal(v.needsPlatformId, false);
  assert.equal(v.platformLine, null);
});

test('rateCardRows: four big rows, Payment type, Rate, Per payment, one grey source word', () => {
  const rates = {
    currency: 'GBP',
    tiers: {
      card_present: { percent: 1.4, fixedPence: 5, source: 'venue' },
      card_not_present: { percent: 1.9, fixedPence: 10, source: 'platform default' },
      amex: { percent: 0, fixedPence: 0, source: 'venue' },
      keyed: { percent: null, fixedPence: null, source: null },
    },
  };
  assert.deepEqual(rateCardRows(rates), [
    { id: 'card_present', label: 'In person', rate: '1.4%', perPayment: '5p', source: 'venue', unpriced: false },
    { id: 'card_not_present', label: 'Online', rate: '1.9%', perPayment: '10p', source: 'platform default', unpriced: false },
    { id: 'amex', label: 'Amex and business cards', rate: '0%', perPayment: '0p', source: 'venue', unpriced: false },
    { id: 'keyed', label: 'Keyed in', rate: 'not set', perPayment: '', source: null, unpriced: true },
  ]);
  // US venues read cents; a percent with no pence reads 0c
  const us = rateCardRows({ currency: 'USD', tiers: { amex: { percent: 2.5 } } });
  assert.equal(us[2].perPayment, '0c');
  assert.equal(us[2].rate, '2.5%');
  // the rate card's own spelling is read too, and nothing at all is four unpriced rows
  assert.equal(rateCardRows({ tiers: { keyed: { percent: 2.9, fixed_pence: 15 } } })[3].perPayment, '15p');
  assert.deepEqual(rateCardRows(null).map((r) => r.unpriced), [true, true, true, true]);
  // a negative number is no price, as the step builder reads it
  assert.equal(rateCardRows({ tiers: { amex: { percent: -1, fixedPence: -5 } } })[2].unpriced, true);
  // the two sentences above the table: plain, short, no dashes, never the word commission
  assert.equal(RATES_LEDE.length, 2);
  for (const l of RATES_LEDE) {
    assert.ok(l.length < 120, l);
    assert.doesNotMatch(l, /[–—]/, l);
    assert.doesNotMatch(l, /commission/i, l);
  }
  assert.equal(RATES_LEDE[0], 'The venue pays these rates on every card payment.');
  assert.equal(RATES_LEDE[1], 'Adyen and FranPOS take their costs out of them and the rest is ServOS margin.');
});

test('referenceSearchView: a venue found by its reference says so in one line', () => {
  const v = referenceSearchView({ reference: 'SV-1008', balancePlatformKnown: true, holderFoundBy: 'reference' });
  assert.equal(v.foundLine, 'SV-1008 was found on Adyen by its reference. Nothing was pasted.');
  // a pasted id, or the store's own balance account, is NOT the automatic route
  assert.equal(referenceSearchView({ reference: 'SV-1008', balancePlatformKnown: true, holderFoundBy: 'pasted' }).foundLine, null);
  assert.equal(referenceSearchView({ reference: 'SV-1008', balancePlatformKnown: true, holderFoundBy: 'store' }).foundLine, null);
  // no reference to name: the line still reads
  assert.equal(referenceSearchView({ balancePlatformKnown: true, holderFoundBy: 'reference' }).foundLine, 'This venue was found on Adyen by its reference. Nothing was pasted.');
  // the venue code is the fallback when the answer carries no reference
  assert.match(referenceSearchView({ venue: { code: 'SV-1009' }, holderFoundBy: 'reference' }).foundLine, /^SV-1009 was found/);
});

test('referenceSearchView: its wording never uses a dash as punctuation', () => {
  const words = [
    referenceSearchView({ needsBalancePlatform: true }).platformLine,
    referenceSearchView({ reference: 'SV-1007', balancePlatformKnown: true, holderFoundBy: 'reference' }).foundLine,
  ];
  for (const w of words) assert.doesNotMatch(String(w), /[–—]/, `dash in: ${w}`);
});

// ── THE PROBLEM BOX AND THE TOP LINE (9 Sep 2026, OWNER FEEDBACK) ───────────
// "just errors all over the place". golive_state answers `problems` (one plain
// line each, raw answer in rawDetail); the screen draws at most three of them
// in one box, and never the two that have their own place on the screen.
import { goliveProblemBox, PROBLEM_BOX_MAX_LINES, PROBLEM_BOX_TEXT, PROBLEM_BOX_SKIP, PLATFORM_SETTINGS_WAITING_LINE } from './adyenAdminRows.js';
import { goliveProblems, BP_KEY_BLOCKED_DETAIL } from './adyenLink.js';

test('goliveProblemBox: nothing to say is no box at all, and the Balance Platform refusal is never in it', () => {
  assert.equal(goliveProblemBox(null), null);
  assert.equal(goliveProblemBox([]), null);
  const onlyBp = goliveProblems([
    'account holder AH1: refused (401): the credential behind ADYEN_LIVE_UK_BP_KEY (the set\'s API key when that is unset) needs the Balance Platform BCL role',
    'balance account BA1: refused (401): the credential behind ADYEN_LIVE_UK_BP_KEY (the set\'s API key when that is unset) needs the Balance Platform BCL role',
  ]).problems;
  assert.equal(onlyBp.length, 1);
  assert.equal(onlyBp[0].text, BP_KEY_BLOCKED_DETAIL);
  assert.equal(goliveProblemBox(onlyBp), null, 'step 2 says it, the box does not');
  // the mismatch has its own block on the screen
  assert.equal(goliveProblemBox([{ kind: 'mismatch', text: 'This venue is on a different Adyen account than the one we are set to use.', rawDetail: 'x' }]), null);
  // no venue code: step 1 says it word for word (set_venue_code), and Adyen
  // was never asked, so "Adyen did not answer everything" would be untrue
  const noCode = goliveProblems(['This venue has no venue code, so there is no store reference to look up. Set one in the Back Office (Venue settings) or pass reference.']).problems;
  assert.equal(noCode[0].kind, 'no_code');
  assert.equal(goliveProblemBox(noCode), null, 'step 1 says it, the box does not');
  assert.deepEqual([...PROBLEM_BOX_SKIP], ['bp_refused', 'mismatch', 'no_code', 'foreign_balance_account']);
  // the store sending the rest to another business account is step 5a's line, not the box's
  assert.equal(goliveProblemBox([{ kind: 'foreign_balance_account', text: 'The payments location sends the rest of each sale to another business account.', rawDetail: 'x' }]), null);
});

test('goliveProblemBox: at most three plain lines, every raw answer behind Show detail', () => {
  const problems = [
    { kind: 'bp_refused', text: BP_KEY_BLOCKED_DETAIL, rawDetail: 'raw bp' },
    { kind: 'timeout', text: 'Adyen took too long to answer. Try again in a moment.', rawDetail: 'raw 1' },
    { kind: 'readers', text: 'The card reader list could not be read, so step 5 may be wrong.', rawDetail: 'raw 2' },
    { kind: 'readers', text: 'The card reader list could not be read, so step 5 may be wrong.', rawDetail: 'raw 2 again' },
    { kind: 'read_failed', text: 'Adyen would not answer about the registered company.', rawDetail: 'raw 3' },
    { kind: 'other', text: 'Adyen said something we did not expect.', rawDetail: 'raw 4' },
  ];
  const box = goliveProblemBox(problems);
  assert.equal(box.text, PROBLEM_BOX_TEXT);
  assert.equal(box.text, 'Adyen did not answer everything, so what is on screen may not be the whole picture.');
  assert.equal(PROBLEM_BOX_MAX_LINES, 3);
  assert.equal(box.lines.length, 3);
  assert.deepEqual(box.lines.map((l) => l.kind), ['timeout', 'readers', 'read_failed']);
  assert.equal(box.more, 1, 'the fourth is counted, not dropped');
  assert.equal(box.detail, 'raw 1\n\nraw 2\n\nraw 3\n\nraw 4', 'every raw answer, past the third line too');
  for (const l of box.lines) {
    assert.ok(l.text.length < 120);
    assert.doesNotMatch(l.text, /[\u2013\u2014]/);
  }
  // junk rows are skipped, a missing rawDetail is null
  const thin = goliveProblemBox([null, 7, { kind: 'other', text: 'Adyen said something we did not expect.' }]);
  assert.equal(thin.lines.length, 1);
  assert.equal(thin.lines[0].rawDetail, null);
  assert.equal(thin.detail, null);
  assert.equal(thin.more, 0);
});

test('PLATFORM_SETTINGS_WAITING_LINE: one short plain line, no table names, no dashes', () => {
  assert.equal(PLATFORM_SETTINGS_WAITING_LINE, 'One database step is waiting on ServOS. Until then venues cannot be found by their code.');
  assert.ok(PLATFORM_SETTINGS_WAITING_LINE.length < 120);
  assert.doesNotMatch(PLATFORM_SETTINGS_WAITING_LINE, /adyen_platform_settings|\.sql|[\u2013\u2014]|paste/i);
});
