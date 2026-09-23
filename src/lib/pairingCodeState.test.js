// pairingCodeState.test.js — an expired pairing code must never be a dead end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pairingCodeState, canIssueNewCode } from './pairingCodeState.js';

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
  assert.match(pairingCodeState({ code: 'X', expiresAt: NOW + 60_000, now: NOW }).label, /1 more minute$/);
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
  assert.match(src, /import \{ pairingCodeState, canIssueNewCode \} from '\.\.\/\.\.\/lib\/pairingCodeState'/);
  assert.match(src, /\{canIssueNewCode\(d\) && \(/, 'the button no longer hides behind "no code yet"');
  assert.doesNotMatch(src, /d\.status==='unpaired' && !\(issued\[d\.id\]\?\.code \|\| d\.pairing_code\) && \(/, 'the old dead-end condition is gone');
  assert.match(src, /codeState\.state === 'expired'/, 'an expired code is drawn as expired');
});
