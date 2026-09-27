// customerInitials.test.js: a customer with no name never crashes the till (v5.9.88).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { customerInitials, customerLabel, firstNameOf } from './customerInitials.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('initials for any customer, with or without a name', () => {
  assert.equal(customerInitials('Simon Hughes', '+447762955142'), 'SH');
  assert.equal(customerInitials('  ela   stettner ', null), 'ES');
  assert.equal(customerInitials('', '+447762955142'), '#42', 'a new number on the display has no name yet');
  assert.equal(customerInitials(undefined, undefined), '?');
  assert.equal(customerInitials(null, '07762 955142'), '#42');
  assert.equal(customerLabel(''), 'New customer');
  assert.equal(customerLabel(undefined), 'New customer');
  assert.equal(customerLabel('Simon Hughes'), 'Simon Hughes');
  assert.equal(firstNameOf('Simon Hughes'), 'Simon');
  assert.equal(firstNameOf(null), '');
});

test('pins: no till surface splits or replaces a customer name directly', () => {
  // Leeds, 27 Sep: "still having that crash when customers put their phone number in on the display".
  const pos = read('../surfaces/POSSurface.jsx');
  assert.doesNotMatch(pos, /customer\.name\.split\(/);
  assert.match(pos, /\{customerInitials\(customer\.name, customer\.phone\)\}/);
  assert.match(pos, /setCustomer\(\{ \.\.\.cur, phone, name: res\.name \|\| cur\.name \|\| ''(, stampSummary: stamps)? \}\)/, 'never an undefined name (v5.9.89 adds the stamps)');
  const modal = read('../components/CustomerModal.jsx');
  assert.doesNotMatch(modal, /c\.name\.split\(/);
  const portal = read('../surfaces/customer/CustomerPortal.jsx');
  assert.doesNotMatch(portal, /customer\.name\.split\(/);
});
