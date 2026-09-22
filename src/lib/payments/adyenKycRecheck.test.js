// adyenKycRecheck.test.js — reading a KYC snapshot back in plain words.
//
// Peter, 22 Sep 2026, on Coffee Boy Preston: "KYC imvalid I ahve fixed and it
// ahsnt rechecked".
//
// He was right twice. His fix was real, and NOTHING rechecks: the admin portal
// stopped calling the status action on 10 Sep (no onboarding buttons, owner
// rule 0), and Adyen's balance platform webhook has never delivered for any of
// the six new Coffee Boy accounts — last_webhook_at is null on every one. The
// screen was showing a snapshot frozen at the moment the onboarding link was
// opened, and would have shown it for ever.
//
// The snapshot itself was twenty lines of JSON hiding one actionable sentence,
// which is what these helpers pull out.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { kycProblems, kycRecheckLine, kycState } from './adyenAdminRows.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Preston's real snapshot, 22 Sep 2026 18:39, trimmed to what matters.
const PRESTON = {
  at: '2026-09-22T18:39:40.093Z',
  source: 'adyen_link',
  reference: 'SV-1011',
  legalEntity: { id: 'LE32B6W22322885Q2D7GX734L', name: 'MAIH LIMITED', status: 'invalid' },
  capabilities: {
    receivePayments: {
      allowed: true, enabled: true, requested: true, verificationStatus: 'invalid',
      problems: [{
        entity: { id: 'LE32B6W22322885Q2D7GX734L', type: 'LegalEntity' },
        verificationErrors: [{
          code: '2_901', type: 'invalidInput', message: 'PCI forms are not signed.',
          remediatingActions: [{ code: '2_901', message: 'Sign PCI' }],
        }],
      }],
    },
    sendToBalanceAccount: { allowed: true, enabled: true, verificationStatus: 'valid' },
    sendToTransferInstrument: { allowed: true, enabled: true, verificationStatus: 'valid' },
  },
  verificationStatus: 'invalid',
  accountHolderStatus: 'active',
};

test('Preston: the one sentence that matters is pulled out of the JSON', () => {
  const problems = kycProblems(PRESTON);
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0], {
    code: '2_901',
    message: 'PCI forms are not signed.',
    action: 'Sign PCI',
    capability: 'receivePayments',
  });
});

test('and it reads as a sentence, not a status code', () => {
  const line = kycRecheckLine({ verification_status: PRESTON });
  assert.match(line, /INVALID/);
  assert.match(line, /1 thing outstanding/);
  assert.match(line, /PCI forms are not signed/);
  assert.match(line, /Sign PCI/);
});

test('a venue that is finished says so and says nothing else', () => {
  const ok = { verificationStatus: 'valid', capabilities: { receivePayments: { verificationStatus: 'valid' } } };
  assert.deepEqual(kycProblems(ok), []);
  assert.match(kycRecheckLine({ verification_status: ok }), /VALID/);
  assert.match(kycRecheckLine({ verification_status: ok }), /Nothing outstanding/);
});

test('invalid with nothing listed is said honestly, not dressed up', () => {
  const vague = { verificationStatus: 'invalid', capabilities: { receivePayments: { verificationStatus: 'invalid' } } };
  assert.match(kycRecheckLine({ verification_status: vague }), /INVALID/);
  assert.match(kycRecheckLine({ verification_status: vague }), /nothing listed as outstanding/);
});

test('the same fault on two capabilities is said once', () => {
  const twice = {
    verificationStatus: 'invalid',
    capabilities: {
      receivePayments: { problems: [{ verificationErrors: [{ code: '2_901', message: 'PCI forms are not signed.' }] }] },
      sendToTransferInstrument: { problems: [{ verificationErrors: [{ code: '2_901', message: 'PCI forms are not signed.' }] }] },
    },
  };
  assert.equal(kycProblems(twice).length, 1);
});

test('a failure to reach Adyen never looks like a KYC verdict', () => {
  assert.match(kycRecheckLine({ error: 'awaiting_enablement' }), /Could not reach Adyen/);
  assert.match(kycRecheckLine({}), /nothing about verification/);
  assert.match(kycRecheckLine(null), /nothing about verification/);
});

test('rubbish in the snapshot is survived, never thrown', () => {
  assert.deepEqual(kycProblems(null), []);
  assert.deepEqual(kycProblems({ capabilities: 'not an object' }), []);
  assert.deepEqual(kycProblems({ capabilities: { x: { problems: [null, 3] } } }), []);
});

test('the chip and the recheck line agree about Preston', () => {
  // The row chip has said "KYC invalid" all along; what was missing was why.
  const chip = kycState({ verification_status: PRESTON, receive_payments_ok: true });
  assert.equal(chip.state, 'bad');
  assert.match(chip.label, /invalid/);
});

// ── the button exists and is honest about what it does ─────────────────────

test('the admin panel has a recheck button, and it only READS', () => {
  const src = read('../../admin/sections/AdminBillingManager.jsx');
  assert.match(src, /Recheck KYC with Adyen/);
  assert.match(src, /callAdyenOnboard\('status', \{ location_id: location\.id \}\)/,
    'the status action, which reads Adyen and re-stamps our copy');
  assert.match(src, /It changes nothing at Adyen/, 'and it says so on screen');
  // owner rule 0: no onboarding MUTATIONS get buttons here
  for (const mutation of ["'start'", "'configure_splits'", "'setup_sweep'", "'refresh_link'"]) {
    assert.ok(!src.includes(`callAdyenOnboard(${mutation}`), 'no button calls ' + mutation);
  }
});

test('the chip and the panel refresh after a recheck', () => {
  const src = read('../../admin/sections/AdminBillingManager.jsx');
  const at = src.indexOf('const recheckKyc');
  const body = src.slice(at, at + 900);
  assert.match(body, /onRowChanged\?\.\(\)/, 'the row chip re-reads');
  assert.match(body, /setEnvRev/, 'and so does the open panel');
});
