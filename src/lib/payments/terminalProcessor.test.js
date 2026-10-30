// The status page must say whether a reader is really linked to Adyen.
// 13 Oct 2026, Coffee Boy Huddersfield: the till status page said "Not connected, cannot take card"
// in red under a reader that took about 80 payments that day. It tested the wrong id; the one rule
// is the Adyen terminal id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { terminalProcessor } from './terminalProcessor.js';

const read = (p) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

test('an Adyen reader is linked to Adyen', () => {
  assert.equal(terminalProcessor({ adyen_terminal_id: 'AMS1-000168254390527' }), 'Adyen');
});
test('a reader with no Adyen id cannot take a card', () => {
  assert.equal(terminalProcessor({ adyen_terminal_id: '' }), null);
  assert.equal(terminalProcessor({ adyen_terminal_id: null }), null);
  assert.equal(terminalProcessor({}), null);
  assert.equal(terminalProcessor(null), null);
  assert.equal(terminalProcessor(undefined), null);
});
test('the rule never names another processor', () => {
  const src = read('src/lib/payments/terminalProcessor.js');
  assert.doesNotMatch(src, /ryft|stripe/i);
});
test('the till status page asks the one rule', () => {
  const src = read('src/components/StatusDrawerCardReaders.jsx');
  assert.match(src, /terminalProcessor\(paxTerminal\)/);
  assert.match(src, /Connected to \$\{paxProcessor\}/);
  assert.match(src, /paxTerminal\.last_seen_at && <span>Last seen/, 'no blank "Last seen" for a reader that does not report in');
  assert.doesNotMatch(src, /ryft|stripe/i);
});
test('Back Office kiosk settings asks the same rule', () => {
  const src = read('src/backoffice/sections/KioskSettings.jsx');
  assert.match(src, /const linked = !!terminalProcessor\(t\)/);
});
