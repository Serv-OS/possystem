// customerDisplayIdle.test.js: the customer display stays on an open order (v5.9.79).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { displayHoldMs, TERMINAL_HOLD_MS, OPEN_ORDER_SAFETY_MS } from './customerDisplayIdle.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('an open order holds for 20 minutes, a thank you for 6.5 s, idle not at all', () => {
  // Peter, 26 Sep: the display timed out mid order while a customer was typing their number.
  assert.equal(displayHoldMs('active'), OPEN_ORDER_SAFETY_MS);
  assert.equal(displayHoldMs('paying'), OPEN_ORDER_SAFETY_MS);
  assert.equal(OPEN_ORDER_SAFETY_MS, 20 * 60 * 1000);
  assert.equal(displayHoldMs('approved'), TERMINAL_HOLD_MS);
  assert.equal(displayHoldMs('declined'), 6500);
  assert.equal(displayHoldMs('idle'), 0);
  assert.equal(displayHoldMs(undefined), 0);
});

test('pins: the display uses the rule, and the till still sends idle itself when the basket empties', () => {
  const disp = read('../surfaces/CustomerDisplaySurface.jsx');
  assert.match(disp, /import \{ displayHoldMs \} from '\.\.\/lib\/customerDisplayIdle'/);
  assert.match(disp, /const ms = displayHoldMs\(st\);\n\s+if \(ms > 0\) idleTimer\.current = setTimeout/, 'no 45 s timer on an open order');
  assert.doesNotMatch(disp, /IDLE_AFTER_MS/);
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /publishDisplay\(\{ items: \[\], total: 0, state: 'idle'/, 'the till clears the display when the order goes');
});

test('pins: a customer can be taken off an order (till chip: Remove)', () => {
  // Peter, 26 Sep: "there is no way to remove a customer from an order in case it's the wrong one".
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /const removeCustomer = \(\) => \{/);
  assert.match(pos, /if \(orderType === 'dine-in' && activeTableId\) setSessionCustomer\(activeTableId, null\);/, 'a table order forgets the guest too');
  assert.match(pos, /if \(Array\.isArray\(customer\?\.allergens\) && customer\.allergens\.length\) setAllergens\(\[\]\);/, 'the allergen filter that came with the profile goes with it');
  assert.match(pos, /clearCustomer\(\);\n\s+showToast\?\.\('Customer removed from this order'/);
  assert.match(pos, /aria-label="Remove customer from this order"/);
});
