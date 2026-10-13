// The status page must name the processor a reader is really linked to.
// 13 Oct 2026, Coffee Boy Huddersfield: the till status page said "Not connected, cannot take card"
// in red under a reader that took about 80 payments that day. It tested the Ryft id only, and an
// Adyen reader has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { terminalProcessor } from './terminalProcessor.js';

const read = (p) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

test('an Adyen reader is linked to Adyen', () => {
  assert.equal(terminalProcessor({ adyen_terminal_id: 'AMS1-000168254390527', ryft_terminal_id: null }), 'Adyen');
});
test('a Ryft reader is linked to Ryft', () => {
  assert.equal(terminalProcessor({ ryft_terminal_id: 'tml_123' }), 'Ryft');
});
test('a reader with both ids is an Adyen reader', () => {
  assert.equal(terminalProcessor({ adyen_terminal_id: 'AMS1-1', ryft_terminal_id: 'tml_1' }), 'Adyen');
});
test('a reader linked to nothing cannot take a card', () => {
  assert.equal(terminalProcessor({ ryft_terminal_id: '', adyen_terminal_id: null }), null);
  assert.equal(terminalProcessor(null), null);
  assert.equal(terminalProcessor(undefined), null);
});
test('the till status page asks the one rule and never tests the Ryft id alone', () => {
  const src = read('src/components/StatusDrawerCardReaders.jsx');
  assert.match(src, /terminalProcessor\(paxTerminal\)/);
  assert.doesNotMatch(src, /paxRyftLinked/);
  assert.match(src, /Connected to \$\{paxProcessor\}/);
  assert.match(src, /paxTerminal\.last_seen_at && <span>Last seen/, 'no blank "Last seen" for a reader that does not report in');
});
test('Back Office kiosk settings asks the same rule', () => {
  const src = read('src/backoffice/sections/KioskSettings.jsx');
  assert.match(src, /const linked = !!terminalProcessor\(t\)/);
});
