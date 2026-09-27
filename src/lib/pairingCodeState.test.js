// pairingCodeState.test.js — an expired pairing code must never be a dead end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replaceCodeWarning, pairingCodeState, canIssueNewCode } from './pairingCodeState.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-09-23T10:00:00Z');

test('an expired code says so, instead of "valid for 60 minutes" for ever', () => {
  const r = pairingCodeState({ code: 'ABCD', expiresAt: '2026-09-22T01:26:46Z', now: NOW });
  assert.equal(r.state, 'expired');
  assert.match(r.label, /expired/i);
});

test('a live code says how long it has left', () => {
  const r = pairingCodeState({ code: 'ABCD', expiresAt: new Date(NOW + 25 * 60_000).toISOString(), now: NOW });
  assert.equal(r.state, 'live');
  assert.match(r.label, /25 more minutes/);
  assert.match(pairingCodeState({ code: 'X', expiresAt: NOW + 60_000, now: NOW }).label, /1 more minute, works once$/);
  assert.match(pairingCodeState({ code: 'X', expiresAt: NOW + 365 * 864e5, now: NOW }).label, /valid until/);
});

test('no code is no code; a legacy code with no clock is treated as live', () => {
  assert.equal(pairingCodeState({ code: null }).state, 'none');
  assert.equal(pairingCodeState({ code: 'X', expiresAt: null }).state, 'live');
});

test('an unpaired terminal can always be given a new code', () => {
  assert.equal(canIssueNewCode({ status: 'unpaired' }), true);
  assert.equal(canIssueNewCode({ status: 'paired' }), false);
});

test('the Back Office screen offers a new code whenever the terminal is unpaired', () => {
  const src = read('../backoffice/sections/DeviceRegistry.jsx');
  assert.match(src, /import \{ pairingCodeState, canIssueNewCode, replaceCodeWarning \} from '\.\.\/\.\.\/lib\/pairingCodeState'/);
  assert.match(src, /\{canIssueNewCode\(d\) && \(/, 'the button no longer hides behind "no code yet"');
  assert.doesNotMatch(src, /d\.status==='unpaired' && !\(issued\[d\.id\]\?\.code \|\| d\.pairing_code\) && \(/, 'the old dead-end condition is gone');
  assert.match(src, /codeState\.state === 'expired'/, 'an expired code is drawn as expired');
});

test('a year long code shows its YEAR and says it works once (v5.9.83)', () => {
  // Peter, 27 Sep 2026: the label read "valid until 27 Sept, 09:32" for a code good until 2027.
  const NOW2 = Date.UTC(2026, 8, 27, 8, 32, 55);
  const r = pairingCodeState({ code: 'D4CX9SD2ABQA', expiresAt: '2027-09-27T08:32:55Z', now: NOW2 });
  assert.equal(r.state, 'live');
  assert.match(r.label, /^valid until 27 Sept? 2027, \d{2}:\d{2}, works once$/);
  assert.match(pairingCodeState({ code: 'X', expiresAt: NOW2 + 25 * 60_000, now: NOW2 }).label, /25 more minutes, works once$/);
});

test('replacing a code that still works asks first; an expired or missing one does not', () => {
  const NOW2 = Date.UTC(2026, 8, 27, 8, 32, 55);
  assert.match(replaceCodeWarning({ code: 'X', expiresAt: NOW2 + 864e5, now: NOW2 }), /App Review/);
  assert.equal(replaceCodeWarning({ code: 'X', expiresAt: NOW2 - 1, now: NOW2 }), null);
  assert.equal(replaceCodeWarning({ code: null, expiresAt: null, now: NOW2 }), null);
});
