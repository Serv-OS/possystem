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
  plainFailure, goLiveConfirmText, relinkConfirmText,
} from './adyenAdminRows.js';
import { buildGoliveSteps, capabilityList } from './adyenLink.js';

const FIVE = [
  { id: 'find_venue', state: 'done', detail: 'Adyen holds SV-1007 as a business account.' },
  { id: 'business_account', state: 'done', detail: 'POINT OF SALE UNIFIED PARTNERS LIMITED is set up.' },
  { id: 'payments_location', state: 'todo', detail: 'No store yet, so card payments have nowhere to go.', action: 'create_store' },
  { id: 'go_live', state: 'todo', detail: 'Finish the steps above first.' },
  { id: 'readers', state: 'todo', detail: 'No card readers on this venue yet.', action: 'add_reader' },
];

test('goliveFlowView: five numbered rows, the owner’s titles, the first not done is open', () => {
  const v = goliveFlowView({ steps: FIVE });
  assert.deepEqual(v.steps.map((x) => x.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(v.steps.map((x) => x.title), [
    'Find the venue on Adyen',
    'The venue’s Adyen business account',
    'The venue’s payments location',
    'Turn on live payments',
    'Card readers',
  ]);
  assert.equal(v.openId, 'payments_location');
  assert.equal(v.steps.filter((x) => x.open).length, 1);
  assert.equal(v.progressLabel, 'Step 3 of 5');
  assert.equal(v.doneCount, 2);
  assert.equal(v.progressPct, 40);
  assert.deepEqual(v.steps.map((x) => x.chip.label), ['Done', 'Done', 'To do', 'To do', 'To do']);
  assert.deepEqual(v.steps.map((x) => x.chip.tone), ['ok', 'ok', 'idle', 'idle', 'idle']);
});

test('goliveFlowView: the four states each get their own chip, and a bad answer still draws five rows', () => {
  const v = goliveFlowView({ steps: [
    { id: 'find_venue', state: 'blocked' },
    { id: 'business_account', state: 'attention' },
    { id: 'payments_location', state: 'nonsense' },
  ] });
  assert.deepEqual(v.steps.map((x) => x.chip.label), ['Blocked', 'Needs attention', 'To do', 'To do', 'To do']);
  assert.deepEqual(v.steps.map((x) => x.chip.tone), ['bad', 'warn', 'idle', 'idle', 'idle']);
  assert.equal(v.openId, 'find_venue');
  assert.equal(goliveFlowView(null).steps.length, 5);
  assert.equal(goliveFlowView(null).openId, 'find_venue');
});

test('goliveFlowView: everything done closes every row and says so', () => {
  const done = FIVE.map((s) => ({ ...s, state: 'done' }));
  const v = goliveFlowView({ steps: done });
  assert.equal(v.allDone, true);
  assert.equal(v.openId, null);
  assert.equal(v.progressLabel, 'All 5 steps done');
  assert.equal(v.progressPct, 100);
  assert.equal(v.steps.filter((x) => x.open).length, 0);
});

test('goliveFlowView: opening a done row keeps exactly one open', () => {
  const v = goliveFlowView({ steps: FIVE }, 'find_venue');
  assert.equal(v.openId, 'find_venue');
  assert.equal(v.steps.filter((x) => x.open).length, 1);
  assert.equal(v.progressLabel, 'Step 1 of 5');
  // a row id nobody answered falls back to the first that is not done
  assert.equal(goliveFlowView({ steps: FIVE }, 'not_a_step').openId, 'payments_location');
});

test('goliveFlowView: the server’s own steps drive it, ids and order match', () => {
  const v = goliveFlowView({ steps: buildGoliveSteps({ venue: { code: 'SV-1007', environment: 'test' }, keys: { configured: true, missing: [] } }) });
  assert.deepEqual(v.steps.map((x) => x.id), ['find_venue', 'business_account', 'payments_location', 'go_live', 'readers']);
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

test('relinkConfirmText: the fn’s own reason, and the kept setup', () => {
  const t = relinkConfirmText({ error: 'the venue already holds different ids', keepsSetup: true, previous: 'test', environment: 'live' }, 'Provo');
  assert.match(t, /already holds different ids/);
  assert.match(t, /test setup is kept/);
  assert.match(t, /link Provo again\?$/);
});

test('the flow’s wording never uses a dash as punctuation', () => {
  const words = [
    ...Object.values(GOLIVE_STEP_TITLES),
    ...goliveFlowView({ steps: FIVE }).steps.map((s) => s.chip.label),
    ...capabilityNotices(capabilityList({ sendToTransferInstrument: { allowed: false, requested: true, verificationStatus: 'rejected' } })).map((n) => n.text),
    mismatchView({ found: 'A', configured: 'B' }).text,
    plainFailure({ status: 403 }).text,
    plainFailure(new Error('nope'), 'It did not work').text,
    goLiveConfirmText({ environment: 'live', previous: 'test', region: 'UK', lookup: { store: { id: 'ST1', status: 'active' } }, plan: { kind: 'flip', diff: { conflicts: [] } }, provisioned: ['store_id'], readers: 1, keepsSetup: true }, 'Provo'),
    relinkConfirmText({ error: 'no' }, 'Provo'),
  ];
  for (const w of words) assert.doesNotMatch(String(w), /[–—]/, `dash in: ${w}`);
});
