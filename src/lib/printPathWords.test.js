/**
 * printPathWords.test.js: the status drawer says what is actually wrong. Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { printEnvironment, printFailureWords, printPathIndicator, printSentFromWords } from './printPathWords.js';

test('environment: native bridge, old iPad build, or a browser', () => {
  assert.equal(printEnvironment({ RposPrinter: {} }), 'native');
  assert.equal(printEnvironment({ RposPrinter: {}, RposIOS: {} }), 'native');
  assert.equal(printEnvironment({ RposIOS: {} }), 'ios-old');
  assert.equal(printEnvironment({}), 'browser');
  assert.equal(printEnvironment(null), 'browser');
});

test('failure words name the real problem, never a print agent', () => {
  assert.equal(printFailureWords('native'), 'Printer did not answer. Check it is on and on the same Wi-Fi as this device.');
  assert.equal(printFailureWords('ios-old'), 'This app build cannot print. Update ServOS POS in TestFlight (build 5 or later) and reopen it.');
  assert.equal(printFailureWords('browser'), 'No printer connection from a browser. Print from the till app on this device.');
  for (const env of ['native', 'ios-old', 'browser']) {
    assert.ok(!/agent/i.test(printFailureWords(env)), env);
    assert.ok(!/[–—]/.test(printFailureWords(env)), 'no dashes');
  }
});

test('the printers section indicator', () => {
  assert.equal(printPathIndicator('native'), 'Printing: direct from this device');
  assert.equal(printPathIndicator('ios-old'), 'Printing: not available in this app build');
  assert.equal(printPathIndicator('browser'), 'Printing: not available from a browser');
});

test('the test page says where it was sent from', () => {
  assert.equal(printSentFromWords('native', { RposPrinter: {}, RposIOS: {} }), 'iPad app (direct)');
  assert.equal(printSentFromWords('native', { RposPrinter: {} }), 'Android till (direct)');
  assert.equal(printSentFromWords('ios-old', { RposIOS: {} }), 'iPad app, old build (queued)');
  assert.equal(printSentFromWords('browser', {}), 'browser (queued)');
});
