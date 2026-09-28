// src/lib/orderCustomerLoyaltyWiring.test.js
//
// WHERE THE ORDER'S CUSTOMER REACHES THE CUSTOMER DISPLAY AND THE CHECKOUT'S LOYALTY LINE
// (28 Sep 2026, Peter at Coffee Boy Leeds). Source pins: they fail if the wiring drifts.
//   1. "If you search for the customer and add them to the order, it doesn't show up on the
//      customer display": the customer form's Confirm now announces the customer.
//   2. "Where the loyalty loads so you can redeem, it's not loading": the checkout's loyalty line
//      shows for every loyalty member, not only when there is something to redeem.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the customer form: Confirm announces the customer to the display (read only lookup)', () => {
  const pos = code(read('surfaces/POSSurface.jsx'));
  assert.match(pos, /import \{ captureLoyaltyByPhone, fetchCustomerByPhone \} from '\.\.\/lib\/customerLookup';/);
  assert.match(pos, /import \{ announceOrderCustomer \} from '\.\.\/lib\/orderCustomerLoyalty';/);
  // the CustomerModal's onConfirm calls it, after the customer is on the order
  const at = pos.indexOf('{showCustomerModal&&<CustomerModal');
  assert.ok(at > 0);
  const confirm = pos.slice(at, pos.indexOf('onCancel=', at));
  assert.ok(confirm.indexOf('setCustomer(c)') > 0 && confirm.indexOf('announceFormCustomer(c)') > confirm.indexOf('setCustomer(c)'),
    'announced after setCustomer(c), so the moved-on check compares with this customer');
  // the runner gets the read only lookup, the store's customer NOW, and the display broadcast
  const fnAt = pos.indexOf('const announceFormCustomer = (c) => announceOrderCustomer({');
  assert.ok(fnAt > 0);
  const fn = pos.slice(fnAt, pos.indexOf('\n  }).catch(', fnAt));
  assert.match(fn, /displayOn: displayUsesScreen\(\),/);
  assert.match(fn, /lookup: fetchCustomerByPhone,/);
  assert.match(fn, /current: \(\) => useStore\.getState\(\)\.customer,/);
  assert.match(fn, /publish: publishLoyalty,/);
  assert.match(fn, /st\.setSessionCustomer\(tblId, next\)/, 'a table keeps the stamps on its guest');
  assert.doesNotMatch(fn, /captureLoyaltyByPhone/, 'the form never creates a profile or texts anyone');
});

test('the runner looks up, checks the order is still this customer, then sets the chip and publishes', () => {
  const lib = code(read('lib/orderCustomerLoyalty.js'));
  assert.doesNotMatch(lib, /^import .*supabase/m, 'pure: no client');
  const fn = lib.slice(lib.indexOf('export async function announceOrderCustomer'));
  const iLookup = fn.indexOf('await lookup(phone)');
  const iGuard = fn.indexOf('stillOrderCustomer(cur, phone)');
  const iApply = fn.indexOf('apply(next)');
  const iPublish = fn.indexOf('publish(loyalty)');
  assert.ok(iLookup > 0 && iGuard > iLookup && iApply > iGuard && iPublish > iApply);
});

test('the display draws the member panel from the loyalty broadcast the form now sends', () => {
  const cd = code(read('lib/customerDisplay.js'));
  assert.match(cd, /if \(_pub\.joined\) _send\('loyalty', result\);/);
  assert.match(cd, /ch\.on\('broadcast', \{ event: 'loyalty' \}/);
  const disp = code(read('surfaces/CustomerDisplaySurface.jsx'));
  assert.match(disp, /if \(loyaltyResult\) left = <LoyaltyResultPanel result=\{loyaltyResult\}/);
});

test('checkout: the loyalty line shows for every member the lookup found', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  assert.match(cm, /import \{ checkoutLoyaltyView \} from '\.\.\/lib\/orderCustomerLoyalty';/);
  assert.match(cm, /const loyaltyView = checkoutLoyaltyView\(loyaltyData\);/);
  assert.match(cm, /\{loyaltyView && \(/);
  assert.match(cm, /\{loyaltyView\.line\}/);
  assert.doesNotMatch(cm, /\(pointsEnabled && loyaltyData\.credit > 0\) \|\| loyaltyData\.rewards\?\.length > 0/, 'the old gate is gone');
  assert.doesNotMatch(cm, /points_enabled/, 'the lookup says pointsEnabled; the view reads both');
  assert.doesNotMatch(cm, /\{loyaltyData\.credit\} points available/, 'no "0 points available" at a stamps venue');
  // Redeem is still offered only when there is a reward and none is applied
  assert.match(cm, /\{loyaltyData\.rewards\?\.length > 0 && !loyaltyApplied && \(/);
  // the lookup itself is unchanged: by the order's phone, whenever it changes
  assert.match(cm, /fetchCustomerByPhone\(customer\.phone\)\.then\(data => \{/);
  assert.match(cm, /\}, \[customer\?\.phone\]\);/);
});

test('checkout: a reward tapped on the display applies with this site\'s categories, like Redeem', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  const at = cm.indexOf('redeemLoyaltyReward(pendingLoyaltyReward, {');
  assert.ok(at > 0);
  const call = cm.slice(at, cm.indexOf('})', at));
  assert.match(call, /menuItems: useStore\.getState\(\)\.menuItems \|\| \[\],/);
  assert.match(call, /categories: useStore\.getState\(\)\.menuCategories \|\| \[\],/);
});
