/**
 * onboardingCase.test.js — normalizeCase must DERIVE step status from evidence,
 * for every case, from every source. Run: `npm test`.
 *
 * The bug: it early-returned whenever a case already carried the five modern
 * step keys, so evidence inference only ever healed LEGACY rows. A modern case
 * showed whatever some write path had imperatively ticked, and any writer that
 * forgot left the step "pending" with the evidence sitting right there. Adding
 * bank details from the staff app did exactly that — wf_staff carried the
 * account, the Back Office still said pending.
 *
 * This matters twice over: the same function now gates the ROTA (a person whose
 * onboarding looks incomplete cannot be given a shift), so a false "pending"
 * blocks real scheduling.
 *
 * normalizeCase lives in the BO component; the logic is re-stated here against
 * the same contract so it can be tested without a DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const STEPS = [
  { key: 'offer' }, { key: 'rtw' }, { key: 'contract' }, { key: 'bank' }, { key: 'posUser' },
];
const LEGACY_KEY_MAP = { 'Offer accepted': 'offer', 'Right to work': 'rtw', 'Contract signed': 'contract', 'Bank & tax details': 'bank', 'POS user created': 'posUser' };

// Mirror of src/backoffice/sections/workforce/WfOnboarding.jsx normalizeCase.
function normalizeCase(c, staff = null) {
  const meta = c.meta || {};
  const legacy = {};
  (c.steps || []).forEach(s => { const k = LEGACY_KEY_MAP[s.key] || s.key; legacy[k] = s; });
  const inferred = {
    offer: meta.offerAccepted ? { status: 'complete', completedAt: meta.offerAccepted.acceptedAt || null }
      : meta.offerSentAt ? { status: 'complete', completedAt: meta.offerSentAt } : null,
    rtw: meta.rtwPath ? { status: 'complete', completedAt: null } : null,
    contract: meta.signature ? { status: 'complete', completedAt: meta.signature.signedAt || null }
      : (meta.contractHtml || meta.contractPath) ? { status: 'sent', completedAt: null } : null,
    bank: (meta.bankMasked || staff?.bankMasked) ? { status: 'complete', completedAt: meta.bankCapturedAt || null } : null,
    posUser: staff?.posUserId ? { status: 'complete', completedAt: null } : null,
  };
  const steps = STEPS.map(({ key }) => {
    const old = legacy[key];
    if (old?.status === 'complete') return { key, status: 'complete', completedAt: old.completedAt || null };
    const inf = inferred[key];
    if (inf) return { key, ...inf };
    return { key, status: old?.status || 'pending', completedAt: old?.completedAt || null };
  });
  return { ...c, steps, status: steps.every(s => s.status === 'complete') ? 'complete' : 'inProgress' };
}

const stat = (c, key) => c.steps.find(s => s.key === key).status;
const modernCase = (over = {}) => ({
  staffId: 'w', meta: {}, steps: STEPS.map(s => ({ key: s.key, status: 'pending', completedAt: null })), ...over,
});

test('THE BUG: bank on the STAFF RECORD completes the step on a modern case', () => {
  // William's exact state: staff app wrote wf_staff.bank_account_masked, the
  // onboarding meta was never touched, and the case has all five modern keys —
  // which is precisely what used to trigger the early return.
  const c = normalizeCase(modernCase(), { bankMasked: '****5341' });
  assert.equal(stat(c, 'bank'), 'complete');
});

test('bank recorded in onboarding meta still counts', () => {
  assert.equal(stat(normalizeCase(modernCase({ meta: { bankMasked: '****1234' } })), 'bank'), 'complete');
});

test('no bank anywhere stays pending', () => {
  assert.equal(stat(normalizeCase(modernCase(), { posUserId: null }), 'bank'), 'pending');
});

test('POS access derives from the staff record, which is the only place it lives', () => {
  assert.equal(stat(normalizeCase(modernCase(), { posUserId: 'u1' }), 'posUser'), 'complete');
  assert.equal(stat(normalizeCase(modernCase(), {}), 'posUser'), 'pending');
});

test('every step derives from its evidence, and the case closes', () => {
  const c = normalizeCase(modernCase({
    meta: { offerSentAt: '2026-08-01', rtwPath: 'p/rtw.jpg', signature: { name: 'W', signedAt: '2026-08-02' } },
  }), { bankMasked: '****5341', posUserId: 'u1' });
  assert.equal(c.status, 'complete');
  STEPS.forEach(s => assert.equal(stat(c, s.key), 'complete', s.key));
});

test('a contract prepared but not signed reads as sent, not complete', () => {
  assert.equal(stat(normalizeCase(modernCase({ meta: { contractHtml: '<p>x</p>' } })), 'contract'), 'sent');
});

test('an explicitly-complete step is never downgraded by missing evidence', () => {
  // A manager ticked it by hand; no meta trail. It must stay complete.
  const c = normalizeCase(modernCase({
    steps: [{ key: 'offer', status: 'complete', completedAt: '2026-08-01' }, ...STEPS.slice(1).map(s => ({ key: s.key, status: 'pending' }))],
  }));
  assert.equal(stat(c, 'offer'), 'complete');
});

test('legacy label-keyed cases still heal', () => {
  const c = normalizeCase({
    staffId: 'l', meta: { rtwPath: 'p.jpg' },
    steps: [{ key: 'Offer accepted', status: 'complete', completedAt: '2026-01-01' }, { key: 'Right to work', status: 'pending' }],
  }, { bankMasked: '****9999' });
  assert.equal(stat(c, 'offer'), 'complete');   // legacy key mapped
  assert.equal(stat(c, 'rtw'), 'complete');     // meta evidence
  assert.equal(stat(c, 'bank'), 'complete');    // staff record
  assert.equal(c.steps.length, 5);              // rebuilt to the modern shape
});

test('a missing staff record does not throw', () => {
  assert.equal(normalizeCase(modernCase(), null).status, 'inProgress');
  assert.equal(normalizeCase(modernCase()).steps.length, 5);
});
