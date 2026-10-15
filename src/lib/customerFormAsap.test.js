// src/lib/customerFormAsap.test.js
//
// The customer form opens on ASAP unless the customer really chose a later time (28 Sep 2026).
// Coffee Boy Leeds R9001 and R8674: customers from the display's phone join had no isASAP field,
// the form opened on "Later", and Confirm saved a pre-order for the first slot ("11:00").
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formStartsAsap } from './customerFormAsap.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('a customer with no isASAP field (display join, Link to existing member) starts on ASAP', () => {
  assert.equal(formStartsAsap({ name: '', phone: '07700900123', stampSummary: [], blankProfile: true }), true);
  assert.equal(formStartsAsap({ name: 'Sam', phone: '07700900123', memberLinked: true }), true);
  // the old rule, !!existing.isASAP, opened both of these on Later
  assert.equal(!!({ name: '', phone: '07700900123' }).isASAP, false);
});

test('no customer yet starts on ASAP; an ASAP customer stays ASAP', () => {
  assert.equal(formStartsAsap(null), true);
  assert.equal(formStartsAsap(undefined), true);
  assert.equal(formStartsAsap({ name: 'Sam', isASAP: true, collectionTime: '11:00' }), true);
});

test('Later only when the customer really chose a later time: isASAP false AND a collection time', () => {
  assert.equal(formStartsAsap({ name: 'Sam', isASAP: false, collectionTime: '11:00', collectionISO: '2026-09-28T10:00:00.000Z' }), false);
  assert.equal(formStartsAsap({ name: 'Sam', isASAP: false }), true, 'false with no time to keep is not a choice');
  assert.equal(formStartsAsap({ name: 'Sam', isASAP: false, collectionTime: '' }), true);
  assert.equal(formStartsAsap({ name: 'Sam', collectionTime: '11:00' }), true, 'a time without an explicit false is not Later');
});

test('pin: CustomerModal starts isASAP from formStartsAsap, never from !!existing.isASAP', () => {
  const src = code(read('../components/CustomerModal.jsx'));
  assert.match(src, /import \{ formStartsAsap \} from '\.\.\/lib\/customerFormAsap';/);
  assert.match(src, /const \[isASAP, setIsASAP\]\s*= useState\(\(\) => formStartsAsap\(existing\)\);/);
  assert.doesNotMatch(src, /!!existing\.isASAP/);
});
